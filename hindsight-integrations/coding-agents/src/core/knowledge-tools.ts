/**
 * Knowledge-page MCP tool specs — runtime SDK-free so this stays unit-testable without a real MCP
 * host.
 *
 * `src/mcp-server.ts` is the only file with a runtime MCP SDK import; this module uses only its
 * `ToolAnnotations` type. The server wires the specs returned here into an `McpServer`. Each tool
 * wraps one `HindsightClient` knowledge-page/recall method: it never throws — a thrown client error
 * is caught and turned into an `isError:true` text result so the calling LLM sees the failure
 * instead of the process crashing.
 *
 * The agent-facing surface is intentionally curated: grounding + capture only. Raw page CRUD
 * (create/update/delete) is deliberately NOT exposed — agents never author page structure; they
 * capture initiatives (`hindsight_capture_initiative`) and pages are synthesized/maintained by the
 * server. `hindsight_ingest_document` (raw-content retain) also backs the codebase survey
 * (core/survey.ts).
 */
import { z } from "zod";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";
import type { HindsightClient } from "./hindsight";
import { syncStatus } from "./status";
import { applyBankConfig, DEFAULT_REFLECT_TOOL_TIMEOUT_MS, loadConfig } from "./config";
import { diagFilePath } from "./diag";
import { describeError } from "./log";
import type { RetainStamp } from "./retain-stamp";
import type { PageTrigger } from "./missions";

export interface ToolResult {
  // Index signature so this structurally satisfies the MCP SDK's CallToolResult (which carries
  // extra optional fields we don't set) when passed to `McpServer.tool()` in src/mcp-server.ts —
  // the only file that imports the SDK; this file stays SDK-free.
  [x: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

type ToolSafetyAnnotations = Required<
  Pick<ToolAnnotations, "readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint">
>;

const READ_ONLY_ANNOTATIONS: ToolSafetyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const NON_DESTRUCTIVE_WRITE_ANNOTATIONS: ToolSafetyAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

/**
 * Returned alongside every search result set.
 *
 * Phrased as an obligation triggered by the CALL, not by the agent judging that it "used" a page: a
 * model that paraphrases a snippet into its own prose does not register itself as having quoted
 * anything, and silently absorbs the memory instead of crediting it.
 */
const CREDIT_REMINDER =
  "Crediting is mandatory, not a judgement call: if anything these results contribute reaches your " +
  "reply — quoted, paraphrased, or merely confirming what you were going to say — open that part " +
  'with "> 🧠 **From Hindsight memory (<page>)** — <the specific facts you drew on>". Rewriting a ' +
  "snippet in your own words does not make it yours. If none of them bear on the turn, ignore them " +
  "silently — an unhelpful search needs no mention. These are past records: check a claim that " +
  "something was fixed or works against the code before relying on it.";

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  /**
   * Safety metadata published verbatim as the tool's MCP annotations (src/mcp-server.ts).
   *
   * Required, not optional: it is not cosmetic. Dcode gates every MCP tool lacking a coherent
   * read-only annotation behind an approval prompt, so in its headless (`dcode -n`) runtime an
   * unannotated tool is REJECTED outright — "This MCP action requires approval, but the current
   * headless runtime has no approval UI." Codex Auto-review likewise treats an unannotated call as
   * unverified external access. Reads get READ_ONLY_ANNOTATIONS; the two writes get
   * NON_DESTRUCTIVE_WRITE_ANNOTATIONS so clients still gate them, but for the right reason.
   */
  annotations: ToolSafetyAnnotations;
  handler: (args: any) => Promise<ToolResult>;
}

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function err(e: unknown): ToolResult {
  const message = describeError(e);
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

/** Wrap a handler body so a thrown client error always becomes an isError:true result, never a throw. */
function guarded(fn: (args: any) => Promise<unknown>): (args: any) => Promise<ToolResult> {
  return async (args: any) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return err(e);
    }
  };
}

/** Build the knowledge-page + recall MCP tool specs, bound to one client/bank. */
export function buildKnowledgeTools(
  client: HindsightClient,
  bankId: string,
  opts: {
    repoDir?: string;
    harness?: string;
    stampFor?: () => RetainStamp;
    /** Refresh policy for a page `hindsight_capture_initiative` creates (core/missions.ts). */
    pageTrigger?: PageTrigger;
    /** How long `hindsight_reflect` waits on the server (cfg.reflectToolTimeoutMs). Must be
     *  threaded in by every caller: left unset, the client falls back to a 120s deadline that
     *  aborts high-budget synthesis on a populated bank mid-flight (#3590). */
    reflectTimeoutMs?: number;
    /** Reflect budget for `hindsight_reflect` (cfg.reflectBudget, default "high"). */
    reflectBudget?: "low" | "mid" | "high";
    /** cfg.toolGuideExtra, added after the crediting note so it lands with the results too. */
    toolGuideExtra?: string;
  } = {}
): ToolSpec[] {
  const extra = opts.toolGuideExtra?.trim();
  const crediting = extra ? `${CREDIT_REMINDER} ${extra}` : CREDIT_REMINDER;
  return [
    {
      name: "hindsight_sync_status",
      description:
        "Report whether this repo's memory bank is in sync: gitlog seed present, how much recent " +
        "history has been deepened with full diffs, conversations ingested, knowledge pages " +
        "created, and extractions still running. `synced: true` means the seeded memory is fully " +
        "queryable. Ingestion is automatic and background — if not synced, it is in progress; " +
        "nothing to run.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async () => {
        try {
          return ok(await syncStatus(client, bankId, opts.repoDir ?? process.cwd()));
        } catch (e) {
          return err(e);
        }
      },
    },
    {
      name: "hindsight_diagnose",
      description:
        "Report safe Hindsight runtime diagnostics for this coding-agent session: resolved bank, " +
        "workspace, harness, config location, API endpoint, and non-secret environment overrides. " +
        "Use this when memory, hooks, MCP tools, or configuration appear not to work. Tokens and " +
        "other secret values are never returned.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async (_args: Record<string, never>) => {
        const configPath =
          process.env.HINDSIGHT_CONFIG || join(homedir(), ".hindsight", "coding-agent.json");
        const harness = opts.harness ?? "unknown";
        // Resolve through the SAME pipeline the host used — including the `banks.<id>` section for
        // the bank this client is bound to, which may carry its own apiToken/apiUrl. A bare
        // loadConfig() would report a mismatch for every per-bank credential.
        const cfg = applyBankConfig(
          loadConfig({ harness: opts.harness }),
          bankId,
          opts.repoDir
        ).cfg;
        return ok({
          bank_id: bankId,
          harness,
          workspace: opts.repoDir ?? process.cwd(),
          config: {
            path: configPath,
            exists: existsSync(configPath),
            api_url: cfg.apiUrl,
            api_token_configured: Boolean(cfg.apiToken),
            disabled: cfg.disabled,
          },
          // What the LIVE client is signing with, which is not the same question as what the file
          // says. A long-lived host used to keep a credential the config had already replaced, and
          // this tool reported that state as perfectly healthy (#3600). Booleans only — the token
          // value is never returned.
          credential: {
            api_token_in_use: Boolean(client.apiToken),
            api_token_matches_config: client.apiToken === cfg.apiToken,
          },
          environment: {
            config_override: Boolean(process.env.HINDSIGHT_CONFIG),
            hooks_disabled: Boolean(process.env.HINDSIGHT_DISABLE_HOOKS),
            log_level: process.env.HINDSIGHT_LOG_LEVEL ?? null,
            diagnostics_file: diagFilePath(),
            channel_id_configured: Boolean(process.env.HINDSIGHT_CHANNEL_ID),
            user_id_configured: Boolean(process.env.HINDSIGHT_USER_ID),
          },
        });
      },
    },
    {
      name: "hindsight_search_knowledge_pages",
      description:
        "Search this repository's Hindsight knowledge pages for content relevant to a query — " +
        "hybrid full-text + semantic search, server-side. Call this when the user's question may " +
        "be answered by the project's accumulated knowledge (architecture, conventions, decisions, " +
        "initiatives) rather than by reading code. Returns ranked pages with a relevance snippet; " +
        // Same sentence the payload carries, from the same constant: two copies of a rule this
        // fiddly drift apart, and the description is what a host shows when the tool is listed.
        "read a full page with hindsight_read_knowledge_page. " +
        crediting,
      inputSchema: { query: z.string().describe("what to look for") },
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async (args: { query: string }) => {
        try {
          // Limit comes from the client (`pageSearchLimit`), so the tool and the hook's injection
          // can never drift apart — this used to pass its own literal 3.
          const hits = await client.searchKnowledgePages(args.query);
          // No `score`. The server fuses BM25 and vector search with reciprocal rank fusion, so the
          // number is ~1/(60+rank) summed over two retrievers: a perfect top hit scores about 0.03
          // and nothing ever approaches 1. Handed that, a model reads a strong match as 3% relevant
          // and discounts it. The hits arrive in rank order, which is the ranking that means
          // something here.
          // The reminder rides WITH the hits, not only in the session guide. Measured on real
          // sessions: the agent searched, got ten on-topic pages, wrote an answer built from them
          // and credited nothing — then credited correctly the moment the user asked "where did you
          // see that?". The guide had scrolled far up the context by then; the instruction that
          // lands at the same moment as the results is the one that can still be acted on.
          return ok({
            pages: hits.map((h) => ({
              page: h.name,
              page_id: h.id,
              // The question the page answers — the same `description` the list and read tools
              // carry, so a hit says what the page is FOR, not just how it opens.
              ...(h.source_query ? { description: h.source_query } : {}),
              snippet: h.snippet,
            })),
            crediting,
          });
        } catch (e) {
          return err(e);
        }
      },
    },
    {
      name: "hindsight_list_knowledge_pages",
      description:
        "List this repository's Hindsight knowledge pages — curated, continuously-updated " +
        "summaries of the project's durable knowledge (architecture, components, conventions, key " +
        "decisions, and in-flight initiatives). Returns each page's id, title, and a one-line " +
        "description of what it covers. Call this at the start of any non-trivial task, and again " +
        "periodically in long sessions, to see what the project already knows before you read code " +
        "or ask the user. The list changes as work is captured, so re-check it occasionally.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      handler: guarded(async () => client.listPages()),
    },
    {
      name: "hindsight_read_knowledge_page",
      description:
        "Read the full content of one knowledge page by its id (from " +
        "hindsight_list_knowledge_pages). Call this whenever a listed page is relevant to what " +
        "you're about to do — e.g. read Conventions before writing new code, Component map before " +
        "changing a subsystem, or an initiative's page before continuing that feature. A page may " +
        "contain [[page:<id>]] links to related pages; follow one by calling this tool again with " +
        "that id. Prefer reading a page over re-deriving the same understanding from source.",
      inputSchema: { page_id: z.string() },
      annotations: READ_ONLY_ANNOTATIONS,
      handler: guarded(async ({ page_id }) => client.getPage(page_id)),
    },
    // ★ LOCAL FORK PATCH 2026-10-06 (lazy expansion): three tools that let the agent walk a memory
    // chain instead of trusting the ranked excerpt it was handed. Rationale in the client
    // methods above; the short version is that recall's 5-row cut is a *relevance* cut, and the
    // row that decides an answer can be irrelevant to the question yet part of the same story.
    // The injected block already shows each row's `[date|who|scope]` prefix and its ids; these
    // tools are what those ids are for.
    {
      name: "hindsight_read_memory",
      description:
        "Read one memory in full by its id, including fields recall does not show (entities, " +
        "occurred_start/end, document_id, chunk_id, and the raw metadata written at ingest). Use " +
        "this when the injected memories look incomplete or mutually inconsistent — e.g. two rows " +
        "describe the same decision with different conclusions, or a row's date is much later than " +
        "the events it describes. Typically the first step of tracing a chain: read the row you " +
        "doubt, then follow its chunk_id (hindsight_read_chunk) or its tags " +
        "(hindsight_read_memory_chain).",
      inputSchema: {
        memory_id: z
          .string()
          .describe("the `id` of a memory, as returned by recall or by this tool's siblings"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      handler: guarded(async ({ memory_id }) => client.getMemory(memory_id)),
    },
    {
      name: "hindsight_read_chunk",
      description:
        "Read the ORIGINAL text a memory was extracted from, by its chunk_id (recall returns one " +
        "per row). This is the verbatim layer: the memory you were shown is a summary that has " +
        "already rewritten the wording, so it cannot settle whether it distorted its source — only " +
        "the chunk can. Reach for this when a memory states a rule, decision, number, or " +
        "attribution that you are about to rely on, or when two memories conflict and you need to " +
        "know which one the source actually supports. Note the chunk may contain several messages, " +
        "including ones the summary dropped entirely.",
      inputSchema: {
        chunk_id: z.string().describe("the `chunk_id` of a memory, as returned by recall"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      handler: guarded(async ({ chunk_id }) => client.getChunk(chunk_id)),
    },
    {
      name: "hindsight_read_memory_chain",
      description:
        "Read every memory sharing a tag, instead of only the handful recall ranked highest. " +
        "Recall returns at most `rerank_max_candidates` rows (5 by default), chosen by topical " +
        'similarity — so a row that is part of the same story but worded differently (a later ' +
        'correction, a "this was a test" note, a qualifier recorded in another session) can be ' +
        "excluded no matter how the query is phrased. When a recalled memory carries a tag that " +
        "looks like a family (`trap:...`, `project:...`, `bank:...`, or any `key:value`), call " +
        "this with that tag to see the whole family. Measured: 24 rows retrieved where recall " +
        "returned 5, reaching a decisive row ranked 70th of 106.",
      inputSchema: {
        tag: z
          .string()
          .describe("a single tag, e.g. 'trap:TRAP-A' — taken from a recalled memory's `tags`"),
        // ★ 必须是 string：DSH 的工具投影层（toDshParameters）只支持 string 参数。
        //   给 number 会让它抛 "dsh projection supports string parameters only"，
        //   而那个抛错发生在 registerTools 的 for 循环里 ⇒ 整批工具【一个都注册不上】。
        //   2026-10-07 实测：本字段让 12 个工具全丢（会话里 hindsight_* 全部 unknown tool）。
        //   故此处收 string，在 handler 里转成数字并夹紧范围。
        limit: z
          .string()
          .optional()
          .describe("max rows, as a decimal string (default 50; capped at 200)"),
        // ★ FORK PATCH 2026-10-09 (v485): let the agent pick the tag-matching mode.
        //   Without it this tool could only express `all`, which also returns rows carrying
        //   NO tags — measured on an isolated bank: 2 tagged + 2 tag-less, `all` ⇒ 4 rows,
        //   `all_strict` ⇒ 2. On the real archive 84.9% of rows are untagged, so a story
        //   lookup would be swamped. Default `all_strict` = "only rows that really carry it".
        tags_match: z
          .string()
          .optional()
          .describe(
            "'all_strict' (default — only rows that really carry the tag) | 'all' (also return " +
              "rows with no tags at all) | 'any_strict' | 'any' | 'exact'"
          ),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      handler: guarded(async ({ tag, limit, tags_match }) => {
        const parsed = limit === undefined ? 50 : Number.parseInt(String(limit), 10);
        const safe = Number.isFinite(parsed) ? Math.max(1, Math.min(200, parsed)) : 50;
        // ★ 只接受服务端认得的值；写错则回落到 all_strict（本工具的正确默认）
        const MODES = ["any", "all", "any_strict", "all_strict", "exact"] as const;
        const mode =
          typeof tags_match === "string" && (MODES as readonly string[]).includes(tags_match)
            ? (tags_match as (typeof MODES)[number])
            : "all_strict";
        return {
          tag,
          tags_match: mode,
          memories: (await client.listByTag(tag, safe, mode)).map((m) => ({
            id: m.id,
            date: m.date ?? m.mentioned_at ?? null,
            text: m.text,
          })),
        };
      }),
    },
    {
      name: "hindsight_list_tags",
      description:
        "List the tags that actually exist in this bank, with how many memories carry each. " +
        "Use this to DISCOVER families instead of guessing their names: every sibling tool " +
        "takes a tag as input (hindsight_read_memory_chain expects one 'taken from a recalled " +
        "memory`s tags'), so a family that never surfaced in a recall is otherwise unreachable. " +
        "This matters most for per-session story tags (`story:<sessionId>`), whose names are " +
        "uuids no agent can guess. Measured on the real archive: 21 distinct tags, so the whole " +
        "list is cheap; pass `prefix` (e.g. 'story:') to narrow it. Combine with " +
        "hindsight_read_memory_chain to then read a whole family.",
      inputSchema: {
        // ★ 全部收 string：DSH 的 toDshParameters 只支持 string 参数，给 number 会让整批
        //   工具注册失败（2026-10-07 实测，见 hindsight_read_memory_chain 的同类注释）。
        prefix: z
          .string()
          .optional()
          .describe(
            "only return tags starting with this prefix, e.g. 'story:' (applied client-side; " +
              "the server ignores its own prefix/ tag/ query params)"
          ),
        limit: z
          .string()
          .optional()
          .describe("max rows, as a decimal string (default 200; capped at 1000)"),
        offset: z
          .string()
          .optional()
          .describe("rows to skip, as a decimal string (default 0) — the server pages natively"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      handler: guarded(async ({ prefix, limit, offset }) => {
        const p = limit === undefined ? 200 : Number.parseInt(String(limit), 10);
        const safeLimit = Number.isFinite(p) ? Math.max(1, Math.min(1000, p)) : 200;
        const o = offset === undefined ? 0 : Number.parseInt(String(offset), 10);
        const safeOffset = Number.isFinite(o) && o > 0 ? o : 0;
        const tags = await client.listTags({ limit: safeLimit, offset: safeOffset, prefix });
        return {
          prefix: prefix ?? null,
          count: tags.length,
          tags: tags.map((t) => ({ tag: t.tag, count: t.count })),
        };
      }),
    },
    {
      name: "hindsight_read_source",
      description:
        "Get the ORIGINAL text behind any memory, automatically following the extra hop that " +
        "consolidated observations require. Use this instead of hindsight_read_chunk when you do " +
        "not know whether a row is a raw fact or a merged observation: observations — the layer " +
        "that carries a project's settled conclusions, and the layer most worth checking — have " +
        "no chunk_id of their own and point at their source facts instead. This tool walks that " +
        "hop for you and returns the memory, its source facts, and the first chunk text found. " +
        "Prefer it when you are checking whether a conclusion is faithful to what was actually " +
        "recorded.",
      inputSchema: {
        memory_id: z
          .string()
          .describe("the `id` of a memory, as returned by recall or by hindsight_read_memory_chain"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      handler: guarded(async ({ memory_id }) => client.getSource(memory_id)),
    },
    {
      name: "hindsight_reflect",
      description:
        "Deep memory reasoning: an agentic synthesis over this repository's FULL memory (git " +
        "decisions, past sessions, ingested knowledge) that answers WHY questions — the past " +
        "decision and exact rule/values that explain a behavior, bug, or convention. Slower than " +
        "hindsight_search_knowledge_pages (several seconds): reach for it when pages are too " +
        "shallow and you need the root cause or the decided literals. When the answer informs " +
        'your reply, credit it visibly with a blockquote header: "> 🧠 **From Hindsight memory** — <summary>".',
      inputSchema: { query: z.string().describe("the question to reason over memory about") },
      annotations: READ_ONLY_ANNOTATIONS,
      handler: guarded(async ({ query }: { query: string }) =>
        client.reflect(query, {
          budget: opts.reflectBudget ?? "high",
          timeoutMs: opts.reflectTimeoutMs ?? DEFAULT_REFLECT_TOOL_TIMEOUT_MS,
        })
      ),
    },
    {
      name: "hindsight_capture_initiative",
      description:
        "Record a new feature or initiative as a tracked knowledge page, so future sessions know it " +
        "exists and can build on it — and keep that page tracking the plan as it moves.\n\n" +
        "WHEN TO CALL:\n" +
        "- Starting one: right after the user approves a plan or finishes brainstorming a new feature/" +
        "capability and you are about to start implementing — BEFORE you write any code. Leave " +
        "relates_to_page_id empty.\n" +
        "- Plan changed: call it AGAIN — mid-implementation is fine and expected — whenever the goal, " +
        "scope, or rationale of an initiative you already captured materially changes (an approach is " +
        "dropped, scope grows or shrinks, the why is rewritten). Pass relates_to_page_id = that " +
        "initiative's page id so the change lands on the existing page. Never mint a second page for the " +
        "same initiative.\n\n" +
        "WHEN TO SKIP: bug fixes, small tweaks, refactors, chores, and trivial course-corrections that " +
        "leave the goal intact are not initiatives — skip them.\n\n" +
        "- title: short, specific name (e.g. 'Newsletter refinement chat'). On a recapture, reuse the " +
        "initiative's existing title.\n" +
        "- summary: 2-3 sentences on what you're building and why — the CURRENT intent, not the " +
        "originally approved plan (on a recapture, say what changed and why).\n" +
        "- relates_to_page_id: leave empty for a new initiative. Set it to an existing initiative's page " +
        "id — from hindsight_list_knowledge_pages, or the id this tool returned earlier — to record a " +
        "plan change or an enhancement to it.\n\n" +
        "Returns the page id. The page is generated for you — you never format one yourself.",
      inputSchema: {
        title: z.string(),
        summary: z.string(),
        relates_to_page_id: z.string().optional(),
      },
      annotations: NON_DESTRUCTIVE_WRITE_ANNOTATIONS,
      handler: guarded(async ({ title, summary, relates_to_page_id }) =>
        client.captureInitiative({
          title,
          summary,
          relatesToPageId: relates_to_page_id,
          ...(opts.stampFor ? { stamp: opts.stampFor() } : {}),
          ...(opts.pageTrigger ? { pageTrigger: opts.pageTrigger } : {}),
        })
      ),
    },
    {
      name: "hindsight_ingest_document",
      description:
        "Save an external document or a block of durable notes/findings into this repository's " +
        "memory so it informs future recall and pages. Use for design notes, research, or " +
        "reference material you want remembered — not for the conversation you're already in " +
        "(that's captured automatically at session end). This is ALSO the correction mechanism: " +
        "when you verify that a retrieved memory is wrong or outdated, ingest a document titled " +
        "'Correction: <topic>' stating what memory claimed, what is actually true, and the " +
        "evidence — the newer fact supersedes the stale one in future retrieval.",
      inputSchema: { title: z.string(), content: z.string() },
      annotations: NON_DESTRUCTIVE_WRITE_ANNOTATIONS,
      handler: guarded(async ({ title, content }) => {
        const slug = title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "");
        // ASCII-only slugs erased non-Latin titles (or shared the "doc" fallback),
        // overwriting unrelated documents. Hash the original title, not its content,
        // so re-ingestion still updates it; "--" cannot occur in a legacy slug.
        const docId =
          /[^\x00-\x7f]/.test(title) || !slug
            ? `${slug || "doc"}--${createHash("sha256").update(title).digest("hex")}`
            : slug;
        const stamp = opts.stampFor?.();
        const metadata = {
          ...stamp?.metadata,
          ...(opts.harness ? { harness: opts.harness } : {}),
        };
        await client.retain(
          content,
          "ingested document",
          docId,
          [
            ...new Set([
              ...(stamp?.tags ?? []),
              "source:upload",
              ...(opts.harness ? [`harness:${opts.harness}`] : []),
            ]),
          ],
          "document",
          Object.keys(metadata).length ? { metadata } : {}
        );
        return { ok: true, doc_id: docId };
      }),
    },
  ];
}
