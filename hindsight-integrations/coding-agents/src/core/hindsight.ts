/**
 * Harness-agnostic Hindsight HTTP client (raw fetch, no SDK dep).
 *
 * Every harness adapter and the backfill CLI go through this one client: it configures the bank
 * (missions + git/chat retain strategies), retains memories, reflects, drains async operations, and
 * creates knowledge pages. Nothing here knows about opencode/claude-code/etc.
 */
import {
  type BankOverrides,
  buildPageTrigger,
  codingBankManifest,
  type CustomPagesConfig,
  type CurrentPageTrigger,
  PAGE_MAX_TOKENS,
  pagesFor,
  type PagesConfig,
  pageScopeRule,
  type PageTrigger,
  pageTriggerDrifted,
  pageTriggerFor,
  pageTriggerPatch,
  type RetainExtractionMode,
} from "./missions";
import { pool, semverGte, sleep } from "./util";
import type { RetainStamp } from "./retain-stamp";
import {
  applyRecencyRerank,
  recencyRerankDiagnostic,
  rerankEnabled as RECENCY_ON,
} from "./recency-rerank";

/** ★ LOCAL FORK PATCH 2026-10-06: the provenance fields the injection layer reads off one recall
 *  row. Upstream typed the response inline as `{ results?: { text?: string }[] }`, so every field
 *  the ingest layer writes (asserted_by / scope / ttl / envelope_warnings) and every addressing
 *  field the client returns (id / tags / chunk_id / source ids) was invisible here — not just to
 *  the agent, but to the type system. Kept as a structural type with optional fields: an older
 *  server simply omits them. */
interface RecallMetadata {
  asserted_by?: string;
  scope?: string;
  ttl?: string;
  envelope_warnings?: unknown;
}

export interface RecallResultRow {
  text?: string;
  id?: string;
  /** Alias the server uses for the record date on some rows (`date ?? mentioned_at`). */
  date?: string;
  mentioned_at?: string;
  occurred_start?: string;
  metadata?: RecallMetadata;
  tags?: string[];
  chunk_id?: string;
  source_memory_ids?: string[];
  source_fact_ids?: string[];
  /** ★ LOCAL FORK PATCH 2026-10-07: entity cues the extractor attached to this row.
   *  Read by the opt-in fan-out re-rank (see `applyFanoutPenalty`). Upstream's recall
   *  response already carries this field; the type simply did not declare it because
   *  nothing upstream read it. */
  entities?: string[] | string;
  /** ★ LOCAL FORK PATCH 2026-10-07: the score breakdown recall returns. The fan-out
   *  re-rank needs a base score to penalize; `final` is the fused score and
   *  `reranker` the stage before it. Declared because nothing upstream read them. */
  scores?: { final?: number; reranker?: number; semantic?: number; keyword?: number | null };
}

// ★ LOCAL FORK PATCH 2026-10-06 (memory-timestamp): see recallObservations() for the rationale.
// Default ON; HINDSIGHT_INJECT_DATES=0 restores upstream (no dates injected).
const INJECT_DATES = (function (): boolean {
  const v = process.env.HINDSIGHT_INJECT_DATES;
  if (v === undefined || v === "") return true;
  return !(v === "0" || v === "false" || v === "no");
})();
// ★ LOCAL FORK PATCH 2026-10-06: whether to show the ingest-time provenance fields
// (asserted_by / scope / ttl) alongside each memory. See recallObservations().
// ★ LOCAL FORK PATCH 2026-10-06: whether to show each memory's `id` and family tag on the
// injected line. See recallObservations() — the injected instructions tell the agent to
// look up rows "with the ids already shown above", so they must actually be shown.
// ★ LOCAL FORK PATCH 2026-10-06: automatic chain closure. Each recalled row carries the
// chunk_id it was extracted from; fetching its same-chunk siblings restores corrections
// that similarity ranking dropped (measured: 95% of corrections missed, 100% recovered
// by the sibling set, at p50 ~705 tokens). Set HINDSIGHT_CHAIN_CLOSURE=0 to disable.
const INJECT_CHAIN = (function (): boolean {
  const v = process.env.HINDSIGHT_CHAIN_CLOSURE;
  // DEFAULT OFF (2026-10-06). Measured on the real 58k bank across 10 queries: chain closure
  // adds 1.4x rows at 2.4x tokens, and only 5 of 70 added rows (7.1%) both shared an identifier
  // with a recalled row AND negated it. The cause is that a chunk is an INGEST unit, not a topic
  // unit - one chunk's conversation ranges over many subjects, so "same chunk" is a weak proxy
  // for "same chain". Earlier "82% of corrections recovered" was measured on chunks pre-selected
  // for containing a correction, which cannot be extrapolated to ordinary recall.
  // Set HINDSIGHT_CHAIN_CLOSURE=1 to opt in.
  if (v === undefined || v === "") return false;
  return v === "1" || v === "true" || v === "yes";
})();
// Ceiling on rows after siblings merge in: the base recall is small (5 at the
// interactive budget), so this permits a few chains without letting a 39-row chunk
// crowd out the rows the query actually asked for.
const INJECT_CHAIN_MAX_ROWS = (function (): number {
  // `?? ""`: TS types env values as `string | undefined`; parseInt(undefined) and parseInt("")
  // both yield NaN, so the fallback branch below is unchanged.
  const v = parseInt(process.env.HINDSIGHT_CHAIN_MAX_ROWS ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 12;
})();
// Distinct chunks expanded per turn, bounding sequential lookups.
const INJECT_CHAIN_MAX_CHUNKS = (function (): number {
  // `?? ""`: see INJECT_CHAIN_MAX_ROWS above — NaN either way.
  const v = parseInt(process.env.HINDSIGHT_CHAIN_MAX_CHUNKS ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 5;
})();
const INJECT_IDS = (function (): boolean {
  const v = process.env.HINDSIGHT_INJECT_IDS;
  if (v === undefined || v === "") return true;
  return !(v === "0" || v === "false" || v === "no");
})();
const INJECT_META = (function (): boolean {
  const v = process.env.HINDSIGHT_INJECT_META;
  if (v === undefined || v === "") return true;
  return !(v === "0" || v === "false" || v === "no");
})();
// ★ LOCAL FORK PATCH 2026-10-08 (narrow-tag visibility, v449/v450):
//   Visible tag prefixes for the injection block. Was hardcoded ["trap","chain"] —
//   the only inject switch in this file that did NOT read the environment.
//   Now env-configurable; the default adds "story" so a story:<sessionId> tag can
//   actually reach the agent. ORDER MATTERS: the renderer takes the first matching
//   prefix, so trap/chain keep their existing precedence over story.
//   Backwards compatible: HINDSIGHT_NARROW_TAGS=trap,chain restores old behaviour.
const NARROW_TAG_PREFIXES = (function (): string[] {
  const raw = process.env.HINDSIGHT_NARROW_TAGS;
  const fallback = ["trap", "chain", "story"];
  if (raw === undefined || raw === "") return fallback;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : fallback;
})();

// ★ LOCAL FORK PATCH 2026-10-07 (fan-out penalty): re-rank recalled rows by "cue
// distinctiveness" — a cue (entity) that appears in most candidates carries little
// information, so a row supported only by ubiquitous cues should rank below one
// supported by a rare cue.
//
// Basis — two independent sources in the literature review:
//   · ACT-R's "difference penalty" (fan effect): activation falls with ln(fan)
//   · Nairne's cue distinctiveness: a cue shared by many traces discriminates poorly
//   ⇒ score = base − λ·ln(maxFan)
//
// ⚠ MEASURED STATUS — this is OFF by default and SHOULD STAY OFF, on evidence:
//   A pre-registered controlled experiment (fork/D5-端到端对照实验.md) found the
//   effect on TERMINAL ANSWER QUALITY is UNMEASURABLE with the proxies tried:
//     · the primary proxy was falsified by its own control —
//       BASE (production top-5) landed at the 18.1st percentile of a same-pool random
//       draw while BOT5 (the 5 LOWEST-base rows) landed at the 29.1st
//       ⇒ the metric judged the "worst" rows better than production top-5
//     · root cause: Spearman(base score, literal-anchor coverage) = −0.486 —
//       archive is a CONSOLIDATED bank, so high-scoring rows are abstract conclusions
//       without filenames/ports, while literal-token rows are raw dumps
//     · the secondary proxy was infeasible (6 of 8 candidate pools held zero
//       correction rows)
//   What IS established: the mechanism works — 8/8 queries change their top-5
//   (M3 Δ = −2.125), and penalty stdev is 0.17–0.44 (not a constant shift).
//   What is NOT established: that changing the top-5 improves anything.
//   ⇒ With zero measured benefit but a 100%-of-queries change in ranking,
//     enabling it by default is pure risk. Hence opt-in.
//
// The user's 2026-10-06 ruling ("先不接，保持现状") is thus independently confirmed
// by experiment. Kept as a switchable capability so the question can be re-asked
// with a better instrument (an LLM judge, or measuring downstream answer accuracy)
// without re-implementing it.
//
// Set HINDSIGHT_FANOUT_PENALTY=1 to enable. HINDSIGHT_FANOUT_LAMBDA overrides λ.
const FANOUT_PENALTY = (function (): boolean {
  const v = process.env.HINDSIGHT_FANOUT_PENALTY;
  if (v === undefined || v === "") return false;
  return v === "1" || v === "true" || v === "yes";
})();
const FANOUT_LAMBDA = (function (): number {
  const v = parseFloat(process.env.HINDSIGHT_FANOUT_LAMBDA ?? "");
  return Number.isFinite(v) && v >= 0 ? v : 0.5;
})();

/** Entities of a recalled row, minus the `knowledge:` namespace.
 *
 *  ⚠ The exclusion is load-bearing, not cosmetic: `knowledge:decision`,
 *  `knowledge:component` etc. are TYPE LABELS the extractor attaches, not entities.
 *  Counting them as cues penalizes exactly the rows that were classified correctly
 *  — measured on the real bank, `knowledge:decision` appears in 14 of 25 candidates,
 *  so it would act as a near-constant penalty with the wrong sign. */
function fanoutEntities(row: RecallResultRow): string[] {
  const e = row.entities;
  const arr: unknown[] = !e
    ? []
    : Array.isArray(e)
      ? e
      : String(e).split(",");
  return arr
    .map((s) => String(s).trim())
    .filter(Boolean)
    .filter((s) => !s.startsWith("knowledge:"));
}

/** Re-rank rows by distinctiveness. Pure: returns a NEW array, mutates nothing.
 *
 *  maxFan (not mean) is the statistic because ONE ubiquitous cue is enough to make a
 *  row un-locatable; averaging would let four rare cues hide it.
 *  ln() keeps the penalty slowly growing: fan 1 → 0, fan 25 → ~3.2. */
function applyFanoutPenalty(rows: RecallResultRow[]): RecallResultRow[] {
  const fan = new Map<string, number>();
  for (const r of rows) {
    for (const e of new Set(fanoutEntities(r))) {
      fan.set(e, (fan.get(e) ?? 0) + 1);
    }
  }
  const scored = rows.map((r) => {
    const es = [...new Set(fanoutEntities(r))];
    const maxFan = es.length ? Math.max(...es.map((e) => fan.get(e) ?? 1)) : 1;
    const base = r.scores?.final ?? r.scores?.reranker ?? 0;
    return { r, adj: base - FANOUT_LAMBDA * Math.log(Math.max(maxFan, 1)) };
  });
  return scored.sort((a, b) => b.adj - a.adj).map((x) => x.r);
}

/** One node of GET /knowledge-base/tree. Only the fields this client reads. */
export interface KnowledgeNode {
  id: string;
  kind: "folder" | "page";
  name: string;
  /** The page's source query (OKF `description`) — what a re-sync compares against. */
  description?: string;
  /** The page's EFFECTIVE refresh policy, on servers new enough to report it (#3572). Absent
   *  everywhere else, which `seedPages()` reads as "unknown, leave it alone". */
  trigger?: CurrentPageTrigger;
  children?: KnowledgeNode[];
}

/**
 * How consolidation scopes the observations a retained memory feeds (`observation_scopes` on the
 * retain API). The scalar modes are the server's; a `string[][]` declares the scopes explicitly.
 */
export type ObservationScopes =
  | "shared"
  | "combined"
  | "per_tag"
  | "all_combinations"
  | "per_source"
  | string[][];

/**
 * ★ FORK PATCH 2026-10-09 (v485): the server's five tag-matching modes.
 *
 * The distinction that matters here (measured on an isolated bank holding 2 tagged and
 * 2 truly tag-LESS rows, identical on /memories/recall and /memories/list):
 *   · `all` / `any`        — include rows with NO tags at all  ⇒ 4 rows
 *   · `all_strict` / `any_strict` — exclude them               ⇒ 2 rows
 *   · `exact`              — matched neither row set in that probe
 * ⇒ `all` is right for "everything about project X", `all_strict` for "only rows that
 *   really carry this story". The chain tool needs the latter.
 */
export type TagsMatchMode = "any" | "all" | "any_strict" | "all_strict" | "exact";

/**
 * `per_source` is resolved HERE, per document, and never reaches the server: it expands to the
 * global scope plus one named for that document's own `source:` tag.
 *
 * It cannot be expressed as configuration. The server treats an explicit scope list as
 * unconditional — consolidation returns it verbatim without filtering it against the memory's own
 * tags — so a configured `[[], ["source:git"], ["source:chat"]]` writes EVERY document into all
 * three, and the `source:git` scope fills up with beliefs built from chat transcripts. Only a
 * per-document decision separates "what the commits say" from "what was discussed".
 *
 * `per_tag` would split on the right axis but also on every other one: it reinstates the per-agent
 * `harness:` fork that `shared` exists to prevent, and any volatile tag (a session id in
 * `retainTags`) becomes its own scope, which is the fragmentation bug itself. Reading only
 * `source:` is what keeps this safe.
 *
 * A document may carry more than one source tag — the commit-message seed is both `source:git` and
 * `source:git-log`, because the cold-repo check filters on `source:git` — so every distinct one
 * gets a scope. Taking all of them, sorted, is the only rule that needs no arbitrary tie-break and
 * does not silently depend on the order the caller assembled its tags in.
 *
 * The empty scope is always first and always present, so the untagged observations that knowledge
 * pages read (they match with `tags_match: "all"`) keep being written exactly as under `shared`.
 */
export function resolveRetainScopes(
  tags: string[] | undefined,
  configured: ObservationScopes
): ObservationScopes {
  if (configured !== "per_source") return configured;
  const sources = [...new Set((tags ?? []).filter((t) => t.startsWith("source:")))].sort();
  return [[], ...sources.map((s) => [s])];
}

/**
 * One global scope for everything this plugin writes.
 *
 * The server default (`combined`) scopes an observation to the memory's WHOLE tag set, and every
 * document we write carries provenance tags — `source:chat`, `harness:<id>`, `knowledge:<kind>`,
 * anything from `retainTags`. That splits one repository's knowledge into a separate observation
 * set per tag combination: work the same repo with two agents and the harness tag alone gives two
 * parallel sets of beliefs that never merge, each blind to the other, at double the consolidation
 * cost (#3564). Those tags are provenance — they say who wrote a memory, not which project the
 * belief is about — so they belong on the facts (where they still filter recall) and not on the
 * consolidation boundary. `shared` keeps them on the facts and consolidates into ONE untagged
 * scope per bank, which is what a bank already is: one project's memory.
 */
export const DEFAULT_OBSERVATION_SCOPES: ObservationScopes = "shared";

export interface ClientOpts {
  apiUrl: string;
  apiToken?: string;
  bank: string;
  /** Repository this bank is about, named in every seeded page's query (`pageScopeRule`). Only
   *  `seedPages()` reads it. Undefined when no single repository is (a shared static bank, a path
   *  map, a bank several repos are renamed onto) — the query then names the BANK, which is the
   *  only stable subject such a bank has. Must be a property of the bank and never of the calling
   *  session's cwd: see `bankProjectName` (#4146). */
  project?: string;
  log?: (msg: string) => void;
  /** Cap on concurrent retain-related requests (drain op polls, deepen pools). Default 10. */
  maxParallelRetains?: number;
  /** Observation scoping for every retain this client sends. Default `DEFAULT_OBSERVATION_SCOPES`. */
  observationScopes?: ObservationScopes;
  /** Pages one knowledge-page search returns. Default `DEFAULT_PAGE_SEARCH_LIMIT`. Lives on the
   *  client so every caller — the hook's injection and the MCP tool — shares one value. */
  pageSearchLimit?: number;
  /** Recall-body overrides, merged key-by-key over `DEFAULT_RECALL_OPTIONS`. Passed through to
   *  the API as given (`types`, `max_tokens`, `budget`, …); `query` is never overridable. */
  recallOptions?: Record<string, unknown>;
  /** Re-read the bearer token from the LIVE config, for hosts that outlive their credential.
   *  `apiToken` alone is a construction-time snapshot: a long-lived host (dsh, Cline, Kilo, the
   *  MCP server, any persistent plugin) kept signing with it forever, so enabling auth or rotating
   *  the key mid-session 401'd every call until the host restarted (#3600). Consulted only on a
   *  401, so the happy path never touches the filesystem. See `core/host-client.ts`. */
  tokenProvider?: () => string | undefined;
  /** How long one request may spend waiting out rate limits (HTTP 429) before it throws
   *  `RateLimitedError`. Default 0: a hook answers to its host's deadline and must fail fast.
   *  Background work that has nobody waiting on it (deepen) sets this, because a 429 it does not
   *  wait out is an item missing from the bank — deepen used to log "failed to enqueue" and carry
   *  on, dropping about a third of a repo's chats against a rate-limited Hindsight Cloud. */
  rateLimitPatienceMs?: number;
}

export interface RetainOpts {
  timestamp?: string; // when the content occurred (temporal ranking)
  metadata?: Record<string, string>; // source provenance (returned with recalls)
  /** "append" concatenates `content` onto the stored document instead of replacing it — the whole
   *  point of the live write-back cursor (core/retain-cursor.ts). Requires a document_id. */
  updateMode?: "append";
  /** Deterministic operation id: re-submitting the same payload returns the original operation
   *  instead of admitting a second one. Ignored by servers older than 0.8.6. */
  operationId?: string;
}

/** First release whose retain endpoint honours a caller-supplied `operation_id` (#2937, v0.8.6).
 *  Below it the field is silently ignored — unknown request fields are not rejected — so an append
 *  could be applied twice without us ever knowing. Hence: no idempotency, no append. */
export const MIN_IDEMPOTENT_RETAIN_VERSION = "0.8.6";

/**
 * Raised when the API rate-limits a request (HTTP 429), carrying how long it asked us to wait.
 *
 * A plain Error would be indistinguishable from a 500 or a network fault, and those want opposite
 * treatment: a rate limit is a "not now, ask again" that the caller can honour, while a server
 * error is not worth hammering. Callers that have somewhere safe to wait retry; the rest fail as
 * before.
 */
export class RateLimitedError extends Error {
  readonly code = "rate_limited";
  constructor(readonly retryAfterMs: number) {
    super(`rate limited; retry after ${Math.round(retryAfterMs / 1000)}s`);
    this.name = "RateLimitedError";
  }
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into ms; 0 when absent or unusable. */
export function retryAfterMs(header: string | null | undefined): number {
  if (!header) return 0;
  const secs = Number(header.trim());
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? 0 : Math.max(0, at - Date.now());
}

/** Raised when the target server predates the knowledge-pages API surface. */
export class KnowledgePagesUnavailableError extends Error {
  readonly code = "knowledge_pages_unavailable";
  constructor() {
    super("Hindsight server does not support knowledge pages");
    this.name = "KnowledgePagesUnavailableError";
  }
}

/**
 * Does this 404 mean the server has no knowledge-base API, rather than "that bank does not exist yet"?
 *
 * The two are indistinguishable by status, and conflating them latched the knowledge-page capability
 * off for the whole process on the FIRST session in a new bank — the bank is minted by the first
 * retain, so a session-start page read always precedes it (#4607).
 *
 * It matches the ENDPOINT-missing shape (FastAPI answers an unrouted path with exactly
 * `{"detail":"Not Found"}`), deliberately NOT the bank-missing wording. Matching the bank error
 * instead would hang the fix on a message the API is free to rephrase, and the day it did, #4607
 * would come back with no test failing. This way a reworded bank error simply fails to match: the
 * capability stays unknown and the next call retries, which is the safe direction to be wrong in.
 */
async function isEndpointMissing(r: Response): Promise<boolean> {
  try {
    // Consumes the body, which is safe: every 404 caller below returns without reading it.
    const j = (await r.json()) as { detail?: unknown };
    return (
      String(j?.detail ?? "")
        .trim()
        .toLowerCase() === "not found"
    );
  } catch {
    // No JSON body at all (a proxy's HTML 404, a bare gateway response). Our API always answers
    // bank-not-found in JSON, so this is not it — latch, as this code did before the fix.
    return true;
  }
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "error"]);

/** Default cap on concurrent retain-related requests; configurable via `maxParallelRetains`. */
/**
 * A reflect that failed on the SERVER's side of the wire: our deadline expired or the server
 * answered non-2xx. `status` is undefined for a timeout. Transport errors (connection refused,
 * DNS) are NOT wrapped — they mean the server is unreachable, so no other endpoint would answer
 * either.
 */
export class ReflectError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly timedOut: boolean,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ReflectError";
  }

  /** A timeout or a 5xx means reflect's synthesis (the slow LLM path) broke, while the cheap
   *  retrieval endpoints may still answer — worth falling back. A 4xx will fail the same way on
   *  every endpoint (auth, missing bank), so it is not. */
  get fallbackEligible(): boolean {
    return this.timedOut || (this.status !== undefined && this.status >= 500);
  }
}

export const DEFAULT_MAX_PARALLEL_RETAINS = 10;
/** Knowledge pages returned by one search — the hook's injection and the agent-facing
 *  `hindsight_search_knowledge_pages` tool both get this, so tuning it moves both.
 *
 *  Ten, not three. Three was set when the page roster was injected wholesale and search was a
 *  rarely-used fallback; search is now the way in, and a repo's pages are narrow by design, so the
 *  decision one turn needs is routinely split across two of them ("Pricing decisions" AND
 *  "Conventions") and a three-hit cut drops one. Ten snippets is a few hundred tokens on a call the
 *  agent made deliberately. */
export const DEFAULT_PAGE_SEARCH_LIMIT = 10;
/**
 * The recall body this client sends when `recallOptions` overrides nothing — one object rather
 * than a field per parameter, so a new recall parameter needs no plumbing here.
 *
 * Observations are the consolidated layer, so they are the best answer per token; a bank whose
 * consolidation is off never grows any, and recalling only observations there returns nothing.
 * Such a bank sets `{"types": ["world", "experience"]}`, or `{"types": null}` for every type.
 * The budget stays low and entities are excluded because this runs inside a hook window.
 */
export const DEFAULT_RECALL_OPTIONS: Record<string, unknown> = {
  types: ["observation"],
  budget: "low",
  max_tokens: 2000,
  include: { entities: null },
};

/** How long drain() pauses between poll cycles when the API did not rate-limit (429). */
const POLL_CYCLE_MS = 5000;

/** Minimum backoff after a 429 that carried no (or a shorter) Retry-After. */
const RETRY_AFTER_FLOOR_MS = 10 * 1000;

/**
 * Ceiling on a single backoff, however long `Retry-After` asks for.
 *
 * The header is a server's hint, not a budget we owe it: a large value (an incident, a
 * misconfigured limiter, a proxy inventing one) would otherwise park a drain for as long as it
 * says — up to the whole `maxMs`, with the background seed frozen behind it. Capping keeps the
 * signal without handing over the schedule; if the limit still applies, the next poll simply gets
 * another 429 and backs off again.
 */
const RETRY_AFTER_CEILING_MS = 60 * 1000;

/** First wait when a request is rate-limited and `Retry-After` asks for less (Cloud sends "0"),
 *  doubled per attempt up to RETRY_AFTER_CEILING_MS. Jittered, so a pool of workers that all got
 *  the 429 together does not come back together. */
const RATE_LIMIT_BACKOFF_MS = 1000;

/**
 * What the agent gets back from reading one page.
 *
 * The API returns `body` AND `markdown`, where `markdown` is that same body with YAML frontmatter
 * on top — so passing the response straight through handed the model the entire page twice, on
 * every read. `timestamp` goes out as `last_updated_at`: the value is the page's last refresh, and
 * a bare "timestamp" beside a page tells the model nothing about whether it is looking at something
 * current.
 *
 * Applied inside `getPage`, not by the read tool: it used to live in knowledge-tools, which left
 * `getPage` itself returning both copies to any other caller (#4836).
 */
function shapePage(page: unknown): unknown {
  const p = (page ?? {}) as Record<string, unknown>;
  const body = typeof p.body === "string" && p.body.trim() ? p.body : p.markdown;
  return {
    id: p.id,
    name: p.name,
    ...(p.description ? { description: p.description } : {}),
    ...(Array.isArray(p.tags) && p.tags.length ? { tags: p.tags } : {}),
    ...(p.timestamp ? { last_updated_at: p.timestamp } : {}),
    body,
  };
}

export class HindsightClient {
  readonly apiUrl: string;
  /** The credential the NEXT request will sign with — NOT the one the config file holds. The two
   *  diverge exactly when #3600 bites, which is why `hindsight_diagnose` reports both. */
  private token: string | undefined;
  private readonly tokenProvider?: () => string | undefined;
  readonly bank: string;
  readonly project?: string;
  readonly opIds: string[] = []; // async operation ids collected by retain(), for drain()
  /** Tri-state capability probe: unknown until the first page request, then cached. */
  knowledgePagesSupported: boolean | undefined;
  /** Tri-state capability probe: unknown until the first append-mode retain, then cached. */
  private idempotentRetain: boolean | undefined;
  private readonly log: (msg: string) => void;
  readonly maxParallelRetains: number;
  readonly observationScopes: ObservationScopes;
  readonly pageSearchLimit: number;
  readonly recallOptions: Record<string, unknown>;
  private readonly rateLimitPatienceMs: number;

  constructor(o: ClientOpts) {
    this.apiUrl = o.apiUrl.replace(/\/$/, "");
    this.token = o.apiToken;
    this.tokenProvider = o.tokenProvider;
    this.bank = o.bank;
    this.project = o.project;
    this.log = o.log ?? (() => {});
    this.maxParallelRetains = o.maxParallelRetains || DEFAULT_MAX_PARALLEL_RETAINS;
    this.observationScopes = o.observationScopes ?? DEFAULT_OBSERVATION_SCOPES;
    this.pageSearchLimit = o.pageSearchLimit || DEFAULT_PAGE_SEARCH_LIMIT;
    // Merged once here, not per call, and copied rather than aliased: the default is a
    // module-level object, and handing every client the same reference makes one caller's
    // mutation everyone's.
    this.recallOptions = { ...DEFAULT_RECALL_OPTIONS, ...o.recallOptions };
    this.rateLimitPatienceMs = o.rateLimitPatienceMs ?? 0;
  }

  /** The credential in use, for diagnostics. Never log or report the VALUE — booleans only. */
  get apiToken(): string | undefined {
    return this.token;
  }

  private headers(): Record<string, string> {
    // `identity`: the server gzips bodies >= 1 KB, and some hosts (DSH runs plugins on its own
    // fetch) hand back the compressed bytes undecoded, so `.json()` dies on the gzip magic (#4868).
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept-Encoding": "identity",
    };
    if (this.token) h["Authorization"] = `Bearer ${this.token}`;
    return h;
  }

  /** Re-read the credential from the live config. Returns whether it actually CHANGED — a retry is
   *  only worth sending if it did, so a genuinely wrong key still surfaces as one 401 rather than
   *  doubling every failing request. */
  private refreshToken(): boolean {
    if (!this.tokenProvider) return false;
    let next: string | undefined;
    try {
      next = this.tokenProvider();
    } catch {
      return false; // a half-written config file must never drop the last credential that worked
    }
    if (next === this.token) return false;
    this.token = next;
    return true;
  }

  /**
   * The ONE place a request is signed. Every fetch goes through it — the generic `req`, the drain
   * poll and `reflect` — because a 401 recovery wired into only one of them leaves the others
   * failing forever, which is how #3600 read from the outside: hooks worked, in-session tools did
   * not.
   *
   * On a 401 the credential is re-resolved and the request replayed ONCE (its body is already a
   * string, so replay is exact). A 401 means the server did nothing, so replaying is side-effect
   * free even for retain. The retry shares the caller's `signal`, deliberately: one deadline still
   * bounds the whole call.
   */
  private async fetchWithAuth(url: string, init: RequestInit): Promise<Response> {
    const send = () => fetch(url, { ...init, headers: this.headers() });
    const r = await send();
    if (r.status !== 401 || !this.refreshToken()) return r;
    return send();
  }

  /** A 401 with no `Authorization` header is a different failure from a rejected key, and the
   *  server answers identically for both — only the client knows which it sent. */
  private authHint(status: number): string {
    if (status !== 401) return "";
    return this.token
      ? " (the configured apiToken was rejected — check ~/.hindsight/coding-agent.json)"
      : " (no apiToken is configured, so no Authorization header was sent)";
  }

  bankUrl(suffix = ""): string {
    return `${this.apiUrl}/v1/default/banks/${encodeURIComponent(this.bank)}${suffix}`;
  }

  /** `tolerate` adds statuses that are returned to the caller instead of thrown (404 always is). */
  async req(
    method: string,
    url: string,
    body?: unknown,
    tolerate: number[] = [],
    timeoutMs = 15_000
  ): Promise<Response> {
    // Hard cap on EVERY request: a stalled server (pool deadlock, network) must degrade to a
    // memoryless turn — never hang a host that awaits us (opencode blocks its BOOT on plugin init).
    const payload = body ? JSON.stringify(body) : undefined;
    let r: Response;
    for (let attempt = 0, waited = 0; ; attempt++) {
      r = await this.fetchWithAuth(url, {
        method,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.status !== 429 || tolerate.includes(429)) break;
      const asked = retryAfterMs(r.headers.get("retry-after"));
      const backoff = Math.min(RETRY_AFTER_CEILING_MS, RATE_LIMIT_BACKOFF_MS * 2 ** attempt);
      const wait =
        Math.min(RETRY_AFTER_CEILING_MS, Math.max(asked, backoff)) * (1 + Math.random() / 2);
      if (waited + wait > this.rateLimitPatienceMs) throw new RateLimitedError(asked);
      await sleep(wait);
      waited += wait;
    }
    if (!r.ok && r.status !== 404 && !tolerate.includes(r.status))
      throw new Error(
        `${method} ${url} -> ${r.status} ${await r.text()}${this.authHint(r.status)}`
      );
    return r;
  }

  /** Retain one memory. ALWAYS async: enqueue extraction server-side and collect its op-id for
   *  drain(). Nothing in this plugin can afford to block a coding agent's hook on extraction. */
  async retain(
    content: string,
    context: string,
    documentId: string,
    tags: string[],
    strategy: string,
    opts: RetainOpts = {}
  ): Promise<void> {
    const item: Record<string, unknown> = {
      content,
      context,
      document_id: documentId,
      tags,
      strategy,
      // Sent on EVERY retain, including the server default `combined`, so the scoping a bank's
      // observations were built under is a property of the write rather than of whichever server
      // version happened to process it. Servers older than 0.4.15 ignore the field.
      observation_scopes: resolveRetainScopes(tags, this.observationScopes),
    };
    if (opts.timestamp) item.timestamp = opts.timestamp;
    if (opts.metadata) item.metadata = opts.metadata;
    if (opts.updateMode) item.update_mode = opts.updateMode;
    const body: Record<string, unknown> = { items: [item], async: true };
    if (opts.operationId) body.operation_id = opts.operationId;
    const r = await this.req("POST", this.bankUrl("/memories"), body);
    try {
      const j = (await r.json()) as { operation_id?: string };
      if (j.operation_id) this.opIds.push(j.operation_id);
    } catch {
      /* ignore */
    }
  }

  /**
   * Whether this server honours `operation_id` on an async retain, and can therefore be appended to
   * safely (see MIN_IDEMPOTENT_RETAIN_VERSION). Probed once per client via GET /version; anything
   * unreachable, unparseable or older answers "no", which costs efficiency, never correctness.
   */
  async supportsIdempotentRetain(): Promise<boolean> {
    if (this.idempotentRetain === undefined) {
      this.idempotentRetain = await this.probeIdempotentRetain();
      this.log(`server retain idempotency: ${this.idempotentRetain ? "supported" : "unavailable"}`);
    }
    return this.idempotentRetain;
  }

  private async probeIdempotentRetain(): Promise<boolean> {
    try {
      const r = await this.req("GET", `${this.apiUrl}/version`);
      if (!r.ok) return false;
      const j = (await r.json()) as { api_version?: string };
      return semverGte(j.api_version, MIN_IDEMPOTENT_RETAIN_VERSION);
    } catch {
      return false;
    }
  }

  /**
   * Whether a session write-back may use `update_mode="append"`: the server must dedupe by
   * `operation_id` AND the bank must keep document text, or the server rejects the append in the
   * background (#4613). Only an explicit `store_document_text: false` answers "no" — an unreachable
   * or unparseable config assumes the default (stored), so a flaky probe never downgrades appends.
   */
  async supportsAppendRetain(): Promise<boolean> {
    if (!(await this.supportsIdempotentRetain())) return false;
    try {
      const r = await this.req("GET", this.bankUrl("/config"));
      if (!r.ok) return true;
      const j = (await r.json()) as { config?: { store_document_text?: boolean } };
      return j.config?.store_document_text !== false;
    } catch {
      return true;
    }
  }

  /**
   * Every document_id currently in the bank under a strategy tag (e.g. `source:git`), paginated into a
   * Set. Powers the incremental git-sync's "what's already ingested?" check — since git commits are stored
   * with document_id `git:<sha>`, the returned Set lets a caller diff a ref's commits against memory.
   */
  async listDocumentIds(
    tag: string,
    tagsMatch: "all" | "all_strict" = "all"
  ): Promise<Set<string>> {
    const ids = new Set<string>();
    const limit = 500;
    for (let offset = 0; ; offset += limit) {
      const q = `?tags=${encodeURIComponent(tag)}&tags_match=${tagsMatch}&limit=${limit}&offset=${offset}`;
      const r = await this.req("GET", this.bankUrl(`/documents${q}`));
      let items: { id?: string }[] = [];
      let total = 0;
      try {
        const j = (await r.json()) as { items?: { id?: string }[]; total?: number };
        items = j.items || [];
        total = j.total ?? 0;
      } catch {
        break;
      }
      for (const it of items) if (it.id) ids.add(it.id);
      if (items.length < limit || ids.size >= total) break; // last page reached
    }
    return ids;
  }

  /**
   * The tags on one document, or undefined when the bank holds none with that id. Read from the
   * document LISTING narrowed by `q` (a substring match on the id, so the exact id is picked out of
   * the page) rather than GET /documents/{id}, which also sends the document's full text: the
   * caller, the git-log freshness check on SessionStart, reads a ~100k-character document for one tag.
   */
  async documentTags(documentId: string): Promise<string[] | undefined> {
    const limit = 100;
    for (let offset = 0; ; offset += limit) {
      const q = `?q=${encodeURIComponent(documentId)}&limit=${limit}&offset=${offset}`;
      const r = await this.req("GET", this.bankUrl(`/documents${q}`));
      const j = (await r.json()) as { items?: { id?: string; tags?: string[] }[]; total?: number };
      const items = j.items ?? [];
      const hit = items.find((it) => it.id === documentId);
      if (hit) return hit.tags ?? [];
      if (items.length < limit || offset + limit >= (j.total ?? 0)) return undefined;
    }
  }

  /** Configure the bank: POST the coding bank manifest to /import (missions, retain strategies,
   *  entity labels), then seed knowledge pages when the server supports them. Both halves are
   *  idempotent and ADDITIVE — nothing the bank already says is overwritten (#3927), bar the
   *  extraction mode of the plugin's own strategies, which follows its config (#4560) — so
   *  the deepen engine can re-run this every pass. Creates the bank if missing; legacy servers
   *  continue with the template-only path.
   *
   *  `manage: false` skips the config half entirely, for a bank whose owner shapes it themselves.
   *  That bank should then define the strategies this plugin writes under (`git`, `gitlog`,
   *  `conversation`, `document`, `survey`): an unknown strategy name is not an error server-side,
   *  it just falls back to the bank's own config, so the miss is silent. */
  async configureBank(
    opts: {
      reset?: boolean;
      pageTrigger?: PageTrigger;
      /** Which pages to seed and with what query — see RawConfig.pages. */
      pages?: PagesConfig;
      /** Pages of the user's own to seed alongside them — see RawConfig.customPages. */
      customPages?: CustomPagesConfig;
      manage?: boolean;
      /** Extraction mode for the plugin's own strategies — see RawConfig.retainExtractionMode. */
      extractionMode?: RetainExtractionMode;
      /** Bank-config fields to add where the bank is silent — see RawConfig.defaultBankConfig. */
      defaults?: Record<string, unknown>;
    } = {}
  ): Promise<void> {
    if (opts.reset) {
      await this.req("DELETE", this.bankUrl());
      this.log(`[bank] reset ${this.bank}`);
    }
    if (opts.manage === false) {
      this.log(`[bank] manageBankConfig: false — leaving ${this.bank}'s configuration alone`);
    } else {
      // What the bank ALREADY overrides decides what is left to write: the missions are seeded once
      // and then belong to whoever set them (#2492), and every other field is added only where the
      // bank is silent (#3927) — bar the extraction mode of the plugin's own strategies, which is
      // re-synced to `extractionMode` (#4560). A reset just deleted the bank, so there is nothing to read.
      const manifest = codingBankManifest(
        opts.reset ? undefined : await this.readBankOverrides(),
        opts.extractionMode,
        opts.defaults
      );
      if (!manifest) {
        this.log(`[bank] ${this.bank} already carries the coding structure — nothing to apply`);
      } else {
        await this.req("POST", this.bankUrl("/import"), manifest);
        this.log(`[bank] applied to ${this.bank}: ${Object.keys(manifest.bank).sort().join(", ")}`);
      }
    }
    await this.seedPages(opts.pageTrigger, opts.pages, opts.customPages);
  }

  /**
   * This bank's own config OVERRIDES, or undefined when there are none to read.
   *
   * Deliberately the overrides and not the resolved config: an inherited global default is not
   * something this bank's owner chose, so it must not read as "already set". `undefined` means the
   * bank does not exist yet, or the deployment has the bank-config API switched off — in neither
   * case can anything have been customised, so the caller seeds the full template.
   */
  private async readBankOverrides(): Promise<BankOverrides | undefined> {
    try {
      const r = await this.req("GET", this.bankUrl("/config"));
      if (!r.ok) return undefined;
      const j = (await r.json()) as { overrides?: BankOverrides };
      return j.overrides ?? {};
    } catch {
      return undefined;
    }
  }

  /** Explicitly delete one document (and its cascaded memory units/links). Background sync must
   *  never use this as a cleanup primitive: a document id alone does not prove repository ownership. */
  async deleteDocument(documentId: string): Promise<void> {
    await this.req("DELETE", this.bankUrl(`/documents/${encodeURIComponent(documentId)}`));
  }

  /** Count of operations still ACTIVE on this bank — the list includes terminal ops (completed/
   *  failed/cancelled), so filter by status. Powers syncStatus's "extractions drained" check. */
  async activeOperations(): Promise<number> {
    const r = await this.req("GET", this.bankUrl("/operations"));
    try {
      const j = (await r.json()) as {
        operations?: { status?: string }[];
        items?: { status?: string }[];
      };
      const ops = j.operations ?? j.items ?? [];
      return ops.filter((o) => !TERMINAL.has((o?.status || "").toLowerCase())).length;
    } catch {
      return 0;
    }
  }

  /**
   * Poll each enqueued operation by id until terminal. LIST only shows active ops, so per-id GET is reliable.
   *
   * Concurrency is capped at `maxParallelRetains` (the API rate-limits bursts, not single
   * requests — a 200 to a lone GET with 429s under `Promise.all` over every pending op). A 429
   * leaves the op pending and backs the next cycle off by its `Retry-After` (10s floor) instead
   * of hammering the next cycle 5s later.
   */
  async drain(ids: string[], label: string, maxMs = 60 * 60 * 1000): Promise<void> {
    if (!ids.length) return;
    this.log(`[wait] draining ${ids.length} ${label} operations …`);
    const start = Date.now();
    const pending = new Set(ids);
    let failed = 0;
    while (pending.size && Date.now() - start < maxMs) {
      // Cycle backoff: default 5s; any 429 in the cycle raises it to the longest Retry-After seen
      // (floor 10s) so a rate-limited API gets room to recover before the next poll round.
      let backoffMs = POLL_CYCLE_MS;
      await pool([...pending], this.maxParallelRetains, async (id) => {
        try {
          const r = await this.fetchWithAuth(this.bankUrl(`/operations/${id}`), { method: "GET" });
          if (r.status === 429) {
            backoffMs = Math.min(
              RETRY_AFTER_CEILING_MS,
              Math.max(backoffMs, RETRY_AFTER_FLOOR_MS, retryAfterMs(r.headers.get("retry-after")))
            );
            return; // op stays pending — retried after the backoff
          }
          if (!r.ok) return;
          const st = (((await r.json()) as { status?: string }).status || "").toLowerCase();
          if (TERMINAL.has(st)) {
            pending.delete(id);
            if (st !== "completed") failed++;
          }
        } catch {
          /* transient — retry next cycle */
        }
      });
      if (pending.size) {
        this.log(`  … ${pending.size}/${ids.length} ${label} ops pending`);
        await sleep(backoffMs);
      }
    }
    this.log(
      `[wait] ${label} drained — ${ids.length - pending.size} done, ${failed} failed` +
        (pending.size ? `, ${pending.size} still pending at timeout` : "")
    );
  }

  /**
   * Reflect: synthesized, root-cause answer over the bank. Bounded so a slow server never hangs a
   * caller — but `timeoutMs` is REQUIRED, deliberately: the right deadline differs by an order of
   * magnitude between the automatic hook (20s, to fit the host's window) and the agent-invoked
   * tool (minutes, on a populated bank). This used to default to 120s, which silently overrode the
   * tool's configured window and aborted every high-budget synthesis mid-flight (#3590).
   */
  async reflect(query: string, opts: { budget?: string; timeoutMs: number }): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    try {
      const resp = await this.fetchWithAuth(this.bankUrl("/reflect"), {
        method: "POST",
        body: JSON.stringify({ query, budget: opts.budget ?? "high" }),
        signal: ctrl.signal,
      });
      // Keep the server's body: a bare "reflect 500" in the diag trail is undebuggable after the fact.
      if (!resp.ok)
        throw new ReflectError(
          `reflect ${resp.status} ${(await resp.text()).slice(0, 1000)}${this.authHint(resp.status)}`,
          resp.status,
          false
        );
      const data = (await resp.json()) as { text?: string };
      return (data.text || "").trim();
    } catch (e) {
      // Our own deadline surfaces as a generic "This operation was aborted"; name it.
      if (ctrl.signal.aborted)
        throw new ReflectError(`reflect timed out after ${opts.timeoutMs}ms`, undefined, true, {
          cause: e,
        });
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Raw recall with no LLM in the loop, so it still answers when reflect's synthesis times out or
   * 5xxs. The body is `recallOptions` (consolidated observations by default) — a bank that grows
   * no observations widens it rather than getting nothing back. Returns the texts in rank order.
   *
   * The name predates `recallOptions` (the observation type used to be hardcoded here) and is
   * kept deliberately: this is the client's published surface, so renaming it would break
   * importers for a cosmetic gain. The doc above is the contract, not the name.
   */
  async recallObservations(query: string, opts: { timeoutMs: number }): Promise<string[]> {
    const r = await this.req(
      "POST",
      this.bankUrl("/memories/recall"),
      // `query` is applied AFTER the spread: everything else is the caller's to override, but a
      // config that could replace the goal with a fixed string would silently recall for the
      // wrong question on every turn.
      { ...this.recallOptions, query },
      [],
      opts.timeoutMs
    );
    if (r.status === 404) return [];
    const j = (await r.json()) as {
      results?: RecallResultRow[];
      /** ★ LOCAL FORK PATCH 2026-10-06 (automatic chain closure): counters attached to the
       *  response object when the sibling expansion below actually added rows. */
      __chainClosure?: { added: number; siblings: number; corrective: number };
      /** ★ LOCAL FORK PATCH 2026-10-07 (fan-out penalty): set only when the opt-in
       *  re-rank actually ran, so a diagnostic can tell whether it was in play. */
      __fanoutPenalty?: { lambda: number; rows: number };
      /** ★ LOCAL FORK PATCH 2026-10-07 (recency): set only when the opt-in recency
       *  re-rank actually re-ordered rows. It reports movement only — it makes no
       *  claim that the new order is better, because that is not measured. */
      __recencyRerank?: { rows: number; moved: number; maxShift: number; similarRel: number };
    };
    // ★ LOCAL FORK PATCH 2026-10-06 (memory-timestamp): prefix each memory with WHEN it was
    // recorded. Rationale: the API already returns `mentioned_at` per result, but upstream
    // threw it away here, so the agent saw a timeless assertion. That is how "the user was
    // ill" (recorded 2025) reads, a year later, as "the user IS ill" — the agent has no way
    // to notice the age and ask whether it still holds. The date is what makes a memory
    // checkable against the present instead of merely believed.
    //
    // Cost control: date only (YYYY-MM-DD), not a full ISO timestamp — ~11 chars instead of
    // ~30, and the time of day has never been the load-bearing part. Recent memories (within
    // MEMORY_DATE_FRESH_DAYS) are left undated on purpose: "yesterday" needs no warning, and
    // it keeps the common case cheap.
    //
    // Set HINDSIGHT_INJECT_DATES=0 to restore upstream behaviour.
    //
    // ★ LOCAL FORK PATCH 2026-10-06 (metadata envelope): also surface the provenance fields written
    // at ingest time (asserted_by / scope / ttl / evidence_at). The whole point of storing them
    // is lost if injection drops them: an agent cannot discount an inference it cannot see is an
    // inference, and cannot re-check a temporary arrangement it cannot see is temporary. These
    // are STRUCTURAL fields derived from the source (the JSONL `role`, explicit qualifier words)
    // rather than from the summarizer's judgement, so they are the part of a memory that can be
    // trusted more than its prose.
    //
    // Format: a compact `[YYYY-MM-DD|user|temporary]` prefix. Kept terse because it repeats on
    // every line; only fields actually present are shown.
    //
    // ★ LOCAL FORK PATCH 2026-10-06 (addressable ids): also append the row's `id` and, when present,
    // a family tag — because the injected prose says "walk the chain with the ids already shown
    // above", and until now NO id was shown. An agent that followed that instruction literally
    // had nothing to pass to the lookup tools, so a confidently-worded instruction produced three
    // failed calls and a fallback to the misleading rows: the exact failure the instruction was
    // meant to prevent. Measured by an independent tester: it could only proceed by guessing bank
    // names from elsewhere. The ids are already in the API response; not showing them was a
    // formatting loss, not an information gap.
    //
    // Kept to the tail so the provenance prefix stays at a fixed column: the eye (and the model)
    // scans the left edge for `[date|who|scope]`.
    // Set HINDSIGHT_INJECT_IDS=0 to omit the ids (they are also in hindsight_read_memory_chain).
    // ★ LOCAL FORK PATCH 2026-10-06 (automatic chain closure): before formatting, expand the
    // recalled rows with their same-chunk siblings — but only the ones worth the tokens.
    //
    // Why: recall ranks rows by similarity to the QUERY, so it hands back the claims that match
    // the question and drops the corrections that contradict them — measured on the real 58k
    // bank, querying with a claim retrieved its own correction 1 time in 20 (95% missed), while
    // 287 of the chunks carrying a correction also carried the claim (99%). Asking the model to
    // notice this and go looking only works if the model decides to investigate; this makes the
    // pipeline do it instead.
    //
    // Cost, measured rather than assumed (6 real queries, 2026-10-06):
    //   base recall          5 rows   ~250-1000 tokens
    //   every sibling added 25-47 rows  6.8x tokens  <- too blunt, rejected
    //   corrections first    3-14 rows  2.8x tokens  <- adopted
    // Corrections are ~24% of siblings, so ordering them first buys most of the value at under
    // half the cost. Compare the alternative this replaces: raising the candidate pool (budget
    // low->mid) costs 4x latency (2.15s -> 8.38s, each arm pulls 300 -> 900 candidates) and
    // still ranks by similarity alone. This is one indexed SQL lookup per chunk at ~115ms.
    //
    // Set HINDSIGHT_CHAIN_CLOSURE=0 to disable.
    if (INJECT_CHAIN && j.results?.length) {
      const seen = new Set((j.results ?? []).map((m) => m.id));
      const chunks = [
        ...new Set(
          (j.results ?? [])
            .map((m) => m.chunk_id)
            .filter((c): c is string => Boolean(c))
        ),
      ];
      const extra: RecallResultRow[] = [];
      for (const ck of chunks.slice(0, INJECT_CHAIN_MAX_CHUNKS)) {
        try {
          for (const m of await this.listByChunk(ck)) {
            if (m && m.id && !seen.has(m.id)) {
              seen.add(m.id);
              extra.push(m);
            }
          }
        } catch (e) {
          // A chain lookup that fails must not cost the caller its recall: the base rows are
          // already in hand and are strictly better than nothing.
        }
      }
      // Corrections first. The pattern is only a RANKING key, never a filter: a correction that
      // fails to match is still included, just after the ones that do.
      const CORRECTIVE =
        /不是|并非|错误|更正|推翻|作废|查无|无法证实|未做验证|未验证|暂缓|反而|实际上|其实|\bnot\b|\bno longer\b|\bincorrect\b|\bsuperseded\b|\breversed\b|\bfalse\b|\bwrong\b|\brejected\b|\bfailed\b/i;
      extra.sort(
        (a, b) => (CORRECTIVE.test(b.text || "") ? 1 : 0) - (CORRECTIVE.test(a.text || "") ? 1 : 0)
      );
      const room = Math.max(0, INJECT_CHAIN_MAX_ROWS - j.results.length);
      const add = extra.slice(0, room);
      if (add.length) {
        j.results = [...j.results, ...add];
        j.__chainClosure = {
          added: add.length,
          siblings: extra.length,
          corrective: add.filter((m) => CORRECTIVE.test(m.text || "")).length,
        };
      }
    }
    // ★ LOCAL FORK PATCH 2026-10-07 (fan-out penalty): opt-in re-rank. Applied AFTER
    // chain closure so it re-orders the final set the formatter sees. Off by default —
    // see FANOUT_PENALTY for the measurement that argues against enabling it.
    if (FANOUT_PENALTY && j.results?.length) {
      j.results = applyFanoutPenalty(j.results);
      j.__fanoutPenalty = { lambda: FANOUT_LAMBDA, rows: j.results.length };
    }
    // ★ LOCAL FORK PATCH 2026-10-07 (recency): opt-in re-rank that lets a NEWER memory
    // outrank an OLDER one when the two are comparably relevant. Runs last, after the
    // fan-out penalty, so it sees the final ordering. It is NOT a time sort — a pure
    // time ordering was measured to bury relevant-but-old rows at the very bottom;
    // see src/core/recency-rerank.ts for the measurement and the tie-break rule.
    //
    // Off by default (HINDSIGHT_RECENCY_RERANK), which makes this a true no-op: with
    // the flag unset applyRecencyRerank returns its input unchanged, so nothing here
    // alters upstream behaviour. The mechanism is established and the threshold is
    // calibrated; whether the agent then reuses retired approaches less often is not,
    // so the default stays untouched until that is measured.
    if (RECENCY_ON() && j.results?.length) {
      const before = j.results;
      const after = applyRecencyRerank(before);
      if (after !== before) {
        j.results = after;
        j.__recencyRerank = recencyRerankDiagnostic(before, after);
      }
    }
    return (j.results ?? [])
      .map((x) => {
        const text = (x.text ?? "").trim();
        if (!text) return "";
        const parts = [];
        if (INJECT_DATES) {
          const raw = x.mentioned_at || x.occurred_start;
          if (raw) parts.push(String(raw).slice(0, 10));
        }
        if (INJECT_META) {
          const md = x.metadata || {};
          // Only the provenance fields written at ingest; ignore bookkeeping keys
          // (bank/repo/harness) that carry no bearing on how much to trust the line.
          const by = md.asserted_by;
          if (by === "user" || by === "agent" || by === "tool" || by === "document") {
            parts.push(by);
          }
          const sc = md.scope;
          if (sc === "temporary") parts.push(md.ttl ? `temporary until ${md.ttl}` : "temporary");
          else if (sc === "permanent") parts.push("permanent");
          // `unspecified` is deliberately NOT shown: "unspecified" is the default state and
          // printing it on most lines would be noise that trains the reader to skip the prefix.
          //
          // ★ LOCAL FORK PATCH 2026-10-06 (envelope warnings): the server-side envelope
          // validator (lab/_ext/memory_envelope_validator.py) writes `envelope_warnings`
          // at ingest, but nothing ever read it — so the checks were inert: they cost a
          // write and changed no behaviour. Surfacing them here is what makes the pass
          // over every retained item actually pay for itself.
          //
          // Reuses the existing `!` slot in the prefix rather than adding a new field,
          // because the meaning is the same: "this line's qualifiers are suspect". A
          // reader that already knows to distrust `!` needs no new instruction.
          if (typeof md.envelope_warnings === "string" && md.envelope_warnings) {
            parts.push("!");
          }
        }
        const head = parts.length ? `[${parts.join("|")}] ` : "";
        let tail = "";
        if (INJECT_IDS) {
          const bits = [];
          if (x.id) bits.push(`id=${x.id}`);
          // Surface ONE family tag — the `key:value` shape the chain tool takes. Prefer a
          // namespaced tag over the bookkeeping ones every row carries (bank:, harness:, env:),
          // which would point the agent at the whole bank.
          //
          // ★ Narrow tags only. An e2e run against the trap corpus surfaced a SUITE-WIDE tag
          // (`suite:MEM-TRAP-SUITE`) shared by every case, so following it would have pulled
          // several unrelated cases into context and buried the one being traced.
          //
          // And measured on the real archive (2026-10-06): `project:` / `topic:` / `bank:` style
          // tags are not chains at all — `project:主工作区` alone matches 200 rows / ~25,500
          // tokens, which is the entire slot window of the local server. Printing one invites an
          // agent to fetch the whole bank and blow the window, so the injected line offers a tag
          // ONLY when it plausibly identifies a small chain. A row with no such tag gets no tag,
          // which is the honest answer: there is nothing narrow to follow.
          const NARROW_TAGS = NARROW_TAG_PREFIXES;
          const tags = (x.tags ?? []).filter((t) => typeof t === "string");
          const tag = NARROW_TAGS.map((k) => tags.find((t) => t.startsWith(`${k}:`))).find(Boolean);
          if (tag) bits.push(`tag=${tag}`);
          // ★ LOCAL FORK PATCH 2026-10-06 (evidence edges): mark whether this row can be traced
          // back to its source text, and say so in six characters.
          //
          // From the fusion design's two independently-derived rules:
          //   ReMe  — "an agent may rewrite the wording, but it must not lose evidence edges"
          //           (docs/en/memory_as_file.md:278)
          //   Text2Mem — invariant ③: "every observation must carry source_ids, and injection
          //           must present them alongside the original text"
          //
          // Measured on the real bank: the edges are fully intact — world/experience 100% carry a
          // chunk_id, and observations 100% carry source_ids that reach one. But injection showed
          // NEITHER, so `hindsight_read_source` looked unusable and the trail died at the summary.
          // That is the same failure the fusion design warns about: the wording was rewritten (by
          // design, and that is fine) while the edge that lets a reader check the rewriting was
          // dropped (not fine, and invisible).
          //
          // Why a marker and not the id: a chunk_id is ~50 chars (`archive_conversation:session-
          // <uuid>_60`), so printing one per row costs ~625 tokens across a 25-row injection. The
          // lookup only needs the row's own `id`, which is already shown — so all the reader needs
          // to know is WHICH rows are worth the call. Six chars carry that.
          const traceable =
            !!x.chunk_id ||
            (Array.isArray(x.source_memory_ids) && x.source_memory_ids.length > 0) ||
            (Array.isArray(x.source_fact_ids) && x.source_fact_ids.length > 0);
          if (traceable) bits.push("src=Y");
          if (bits.length) tail = `  (${bits.join(" ")})`;
        }
        return `${head}${text}${tail}`;
      })
      .filter(Boolean);
  }

  // ★ LOCAL FORK PATCH 2026-10-06 (lazy expansion / chain closure): list every memory extracted
  // from one source chunk, by its `chunk_id`. See recallObservations() for why the sibling set,
  // not a better ranker, is what recovers a dropped correction.
  /** Every memory extracted from the SAME source chunk — the local exchange a row came from.
   *
   *  ★ Why this is the important one (measured 2026-10-06, on the real 58k bank):
   *  A correction is nearly always recorded in the same chunk as the claim it corrects —
   *  287 of the chunks carrying correction wording also carried the original claim (99%). But
   *  recall ranks by similarity to the QUERY, and a correction is worded unlike the claim, so
   *  querying with the claim retrieved the correction only 1 time in 20 (95% missed). Fetching
   *  the sibling set by chunk recovered 19 of those 19 missed cases.
   *
   *  So this is a structural fix, not a bigger candidate pool: it does not raise `budget`
   *  (measured: budget low->mid costs 4x latency, 2.15s -> 8.38s, because each retrieval arm
   *  pulls 300 -> 900 candidates), does not depend on the model deciding to investigate, and
   *  costs p50 ~705 tokens for the whole sibling set (max ~900; window is 24,576).
   *
   *  Requires the server-side `chunk_id` filter on /memories/list (added 2026-10-06). Against
   *  an older server the parameter is silently ignored and this returns unfiltered rows, so
   *  callers should treat an empty `chunk_id` on results as "filter unsupported". */
  async listByChunk(chunkId: string, limit = 100): Promise<RecallResultRow[]> {
    const q = `?limit=${limit}&chunk_id=${encodeURIComponent(chunkId)}`;
    const r = await this.req("GET", this.bankUrl(`/memories/list${q}`), null, [404], 2e4);
    if (r.status === 404) return [];
    const j = (await r.json()) as { items?: RecallResultRow[]; memories?: RecallResultRow[] };
    const items = j.items ?? j.memories ?? [];
    // Guard against a server predating the filter: it would return unrelated rows. Verifying
    // locally costs nothing and turns a silent wrong answer into an empty one.
    return items.filter((m) => !m.chunk_id || String(m.chunk_id) === String(chunkId));
  }

  // ★ LOCAL FORK PATCH 2026-10-06 (lazy expansion): fetch ONE memory by id.
  //
  // Why this exists: recall returns at most `rerank_max_candidates` rows (5 by default for the
  // interactive budget), chosen by a ranker that scores topical similarity. A memory that is
  // far from the query's topic but decisive for the answer — a later correction, a "this was a
  // test" note, a qualifier recorded in a different session — simply cannot survive that cut.
  // Measured on the trap corpus: the chain's terminal layer ranked 70th of 106 candidates, so
  // no wording change can pull it in. The fix is not a better ranker but giving the agent the
  // means to walk the chain itself: every returned row already carries `id`, so it can ask for
  // a specific neighbour once it suspects the injected set is partial.
  async getMemory(memoryId: string): Promise<RecallResultRow> {
    const r = await this.req("GET", this.bankUrl(`/memories/${encodeURIComponent(memoryId)}`));
    if (r.status === 404) throw new Error(`memory not found: ${memoryId}`);
    return (await r.json()) as RecallResultRow;
  }

  /** The original text a memory was extracted from, by chunk id (recall returns `chunk_id`).
   *  This is the verbatim trace — the only layer that can settle whether a summary distorted
   *  its source, since the summary has already rewritten the wording. */
  async getChunk(chunkId: string): Promise<unknown> {
    // ★ FORK BUGFIX 2026-10-07: this path was missing `${this.apiUrl}`, so `req` received a
    // RELATIVE url and every call died inside fetch with
    //   "Failed to parse URL from /v1/default/chunks/… (ERR_INVALID_URL)"
    // — i.e. `hindsight_read_chunk` had NEVER once succeeded, and because `getSource` calls this
    // method twice, `hindsight_read_source` was dead too (2 of the 4 chain tools).
    //
    // Verified against the live server before fixing:
    //   GET {apiUrl}/v1/default/chunks/<chunk_id>             -> 200   (the correct path)
    //   GET {apiUrl}/v1/default/banks/<bank>/chunks/<id>      -> 404   (NOT under /banks/)
    // The chunk endpoint is deliberately bank-less, so `bankUrl()` is the WRONG helper here —
    // only the apiUrl prefix was missing. Same shape as the `/version` call above.
    const r = await this.req(
      "GET",
      `${this.apiUrl}/v1/default/chunks/${encodeURIComponent(chunkId)}`
    );
    if (r.status === 404) throw new Error(`chunk not found: ${chunkId}`);
    return await r.json();
  }

  /** All memories carrying a tag. Used for chain completion: when a row belongs to a tagged
   *  family (recall already returns its `tags`), this pulls the siblings an agent would
   *  otherwise never see — the later correction, the "this was a test" note, the qualifier
   *  recorded in another session. Measured 2026-10-06: the chain-completion query returns 24
   *  rows where interactive recall returned 5, and it is the only path that reaches a
   *  terminal layer ranked 70th of 106 candidates.
   *
   *  NOTE: the parameter is `tags`, not `tag`. `?tag=` is silently IGNORED by the server —
   *  it returns an unfiltered page rather than an error, which looks like success. */
  async listByTag(
    tag: string,
    limit = 50,
    // ★ FORK PATCH 2026-10-09 (v485): expose `tags_match`.
    //   Measured on an isolated bank holding 2 tagged + 2 truly tag-LESS rows:
    //     no tags_match (= what this method used to send) ⇒ 4 rows, INCLUDING the 2 tag-less
    //     all                                            ⇒ 4 rows (identical)
    //     all_strict                                     ⇒ 2 rows, tag-less = 0
    //   Same on /memories/recall and /memories/list ⇒ server behaviour, not an endpoint quirk.
    //   ⇒ without this parameter the chain tool can only express `all`, so a story lookup drags
    //     in every untagged memory — on the real archive that is 84.9% of rows.
    //   ⚠ Default kept at "all" ON PURPOSE: that is exactly the previous behaviour, so this
    //     change is purely additive and cannot alter any existing caller. The tool asks for
    //     "all_strict" explicitly.
    tagsMatch: TagsMatchMode = "all"
  ): Promise<RecallResultRow[]> {
    // ★ Cap the page size. Measured on the real archive: `project:主工作区` alone matches 200
    // rows / ~25,500 tokens — more than the local server's whole per-slot window. The chain
    // tool exists to fetch a SMALL family, so an over-broad tag must degrade to a truncated
    // answer rather than a blown context. 200 is the server's own page ceiling.
    limit = Math.min(Number(limit) || 50, 200);
    const q =
      `?limit=${limit}&tags=${encodeURIComponent(tag)}` +
      `&tags_match=${encodeURIComponent(tagsMatch)}`;
    const r = await this.req("GET", this.bankUrl(`/memories/list${q}`), null, [404], 2e4);
    if (r.status === 404) return [];
    const j = (await r.json()) as { items?: RecallResultRow[]; memories?: RecallResultRow[] };
    return j.items ?? j.memories ?? [];
  }

  /**
   * ★ LOCAL FORK PATCH 2026-10-08 (tag discovery, v447/v452): enumerate the tags that
   * exist in this bank, with how many memories carry each one.
   *
   * Why this exists: every other tag-aware tool takes a tag as INPUT. `read_memory_chain`
   * says so outright — its tag is "taken from a recalled memory's `tags`" — so with no way
   * to LIST tags, a family that never happened to surface in a recall is unreachable. That
   * is exactly the story-line case: `story:<sessionId>` tags are minted per session and
   * the agent cannot guess a session id.
   *
   * Endpoint contract (probed 2026-10-08 on a 25-story isolated bank):
   *   GET /tags ⇒ 200 {"items":[{"tag":"env:local","count":4282},…],"total":N,"limit":L,"offset":O}
   *   Server-side paging works: `?limit=5` ⇒ 5 items; `?offset=5` ⇒ 23 of 28.
   *   `?prefix=` and `?tag=` are ignored by the server; `?q=` exists but is not a
   *   prefix filter (returned 0 for the string "story"). So filtering happens here.
   */
  async listTags(opts: { limit?: number; offset?: number; prefix?: string } = {}): Promise<
    Array<{ tag: string; count: number }>
  > {
    const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 1000);
    const offset = Math.max(Number(opts.offset) || 0, 0);
    const q = `?limit=${limit}&offset=${offset}`;
    const r = await this.req("GET", this.bankUrl(`/tags${q}`), null, [404], 2e4);
    if (r.status === 404) return [];
    const j = (await r.json()) as { items?: Array<{ tag?: unknown; count?: unknown }> };
    let rows = (j.items ?? [])
      .map((x) => ({ tag: String(x.tag ?? ""), count: Number(x.count) || 0 }))
      .filter((x) => x.tag !== "");
    // `prefix` is applied client-side: the server ignores it (see the contract note above).
    if (opts.prefix) rows = rows.filter((x) => x.tag.startsWith(opts.prefix as string));
    return rows;
  }

  /** Reach the verbatim source of ANY memory, following the fact layer when needed.
   *
   *  Why this exists (measured 2026-10-06): consolidated observations — the layer carrying a
   *  project's settled conclusions, and on the trap corpus EVERY decisive terminal row — have
   *  NO chunk_id. They record provenance in `source_memory_ids` instead, pointing at the facts
   *  they were merged from, and only those facts carry a chunk_id. So a plain "read the chunk"
   *  step dead-ends on exactly the rows most worth checking. This method walks that hop, so the
   *  caller does not need to know the schema.
   *
   *  Returns { memory, source_facts, chunk, hops }. */
  async getSource(memoryId: string): Promise<{
    memory: RecallResultRow;
    source_facts: unknown[];
    chunk: unknown;
    hops: number;
  }> {
    const m = await this.getMemory(memoryId);
    const out: {
      memory: RecallResultRow;
      source_facts: unknown[];
      chunk: unknown;
      hops: number;
    } = { memory: m, source_facts: [], chunk: null, hops: 0 };
    if (m.chunk_id) {
      out.chunk = await this.getChunk(m.chunk_id);
      out.hops = 1;
      return out;
    }
    const ids = m.source_memory_ids || (m as { source_fact_ids?: string[] }).source_fact_ids || [];
    for (const sid of ids.slice(0, 5)) {
      try {
        const sf = await this.getMemory(sid);
        out.source_facts.push(sf);
        if (sf.chunk_id && !out.chunk) {
          out.chunk = await this.getChunk(sf.chunk_id);
          out.hops = 2;
        }
      } catch (e) {
        // A source fact may have been superseded or deleted; keep walking rather than fail the
        // whole lookup over one missing hop.
        out.source_facts.push({ id: sid, error: String(e).slice(0, 200) });
      }
    }
    return out;
  }

  /**
   * Latch `knowledgePagesSupported = false` iff this response really means the endpoint is absent.
   * Returns whether it latched. A bank-not-found 404 is NOT a capability verdict — it is the
   * expected answer before the bank's first retain — so it must never cache a negative (#4607).
   *
   * Only 404 is tested: `req` throws on every other non-ok status it was not told to tolerate, so
   * the 405/501 this used to check for never reach a caller in the first place.
   */
  private async pagesUnsupported(r: Response): Promise<boolean> {
    if (r.status !== 404 || !(await isEndpointMissing(r))) return false;
    this.knowledgePagesSupported = false;
    return true;
  }

  /**
   * The bank's knowledge-base tree (folders + pages, nested). The tree carries names, source
   * queries and staleness but NOT synthesized content, so it is cheap enough to poll.
   */
  async tree(): Promise<KnowledgeNode[]> {
    if (this.knowledgePagesSupported === false) throw new KnowledgePagesUnavailableError();
    const r = await this.req("GET", this.bankUrl("/knowledge-base/tree"));
    if (await this.pagesUnsupported(r)) throw new KnowledgePagesUnavailableError();
    // Bank not created yet: it genuinely has no pages, and the capability stays UNKNOWN so the
    // next call (after the first retain mints the bank) asks again instead of short-circuiting.
    if (r.status === 404) return [];
    this.knowledgePagesSupported = true;
    try {
      return ((await r.json()) as { roots?: KnowledgeNode[] }).roots ?? [];
    } catch {
      return [];
    }
  }

  /**
   * List knowledge pages (ids + names only — no synthesized content), flattened out of the tree
   * and shaped as `{items:[…]}` for `parsePageList`. Folders are dropped: they carry no content
   * to read, and a caller enumerating pages wants leaves, not structure.
   *
   * NOTE the ids are knowledge-base node ids (`kp-…`), NOT the backing mental-model ids. Every
   * page read/update in this client goes through the same knowledge-base ids, so a page id from
   * here, from `searchKnowledgePages`, or from a `[[page:<id>]]` link all resolve identically.
   */
  async listPages(): Promise<unknown> {
    const items: { id: string; name: string; description?: string; folder?: string }[] = [];
    const walk = (nodes: KnowledgeNode[], folder?: string): void => {
      for (const n of nodes) {
        if (!n?.id || !n?.name) continue;
        if (n.kind === "page") {
          items.push({
            id: n.id,
            name: n.name,
            ...(n.description ? { description: n.description } : {}),
            ...(folder ? { folder } : {}),
          });
        }
        if (n.children?.length) walk(n.children, n.kind === "folder" ? n.name : folder);
      }
    };
    walk(await this.tree());
    return { items };
  }

  /**
   * Read one knowledge page's synthesized content by knowledge-base id, shaped by `shapePage` so
   * the body arrives once. The endpoint omits the internal reflect trace that built
   * the page — that is 70-95% of the raw bytes and can blow past an MCP host's per-tool-result
   * token cap.
   */
  async getPage(pageId: string): Promise<unknown> {
    if (this.knowledgePagesSupported === false) throw new KnowledgePagesUnavailableError();
    const r = await this.req(
      "GET",
      this.bankUrl(`/knowledge-base/pages/${encodeURIComponent(pageId)}`)
    );
    if (r.status === 404) throw new Error(`knowledge page not found: ${pageId}`);
    return shapePage(await r.json());
  }

  /** Hybrid (BM25 + vector, RRF-fused) server-side search over the bank's knowledge pages.
   *  Returns page-level hits with a relevance snippet — the real search behind
   *  hindsight_search_knowledge_pages. */
  async searchKnowledgePages(
    query: string,
    opts: { limit?: number; timeoutMs?: number } = {}
  ): Promise<
    { id: string; name: string; source_query?: string; snippet: string; score: number }[]
  > {
    if (this.knowledgePagesSupported === false) throw new KnowledgePagesUnavailableError();
    const q = `?q=${encodeURIComponent(query)}&limit=${opts.limit ?? this.pageSearchLimit}`;
    const r = await this.req(
      "GET",
      this.bankUrl(`/knowledge-base/search${q}`),
      undefined,
      [],
      opts.timeoutMs
    );
    // Routed through the same check as every other page endpoint. Without it a server with no
    // knowledge-base API parsed its own 404 body into zero hits and reported "nothing matched"
    // forever, which reads as an empty bank rather than a missing feature.
    if (await this.pagesUnsupported(r)) throw new KnowledgePagesUnavailableError();
    if (r.status === 404) return []; // bank not created yet — no pages to match
    const j = (await r.json()) as {
      results?: {
        id: string;
        name: string;
        source_query?: string | null;
        snippet?: string;
        score?: number;
      }[];
    };
    return (j.results ?? []).map((x) => ({
      id: x.id,
      name: x.name,
      ...(x.source_query ? { source_query: x.source_query } : {}),
      snippet: x.snippet ?? "",
      score: x.score ?? 0,
    }));
  }

  /**
   * Seed the fixed page taxonomy as knowledge-base pages at the tree root, idempotently.
   *
   * Matched by NAME, not id: `/knowledge-base/pages` mints its own `kp-…` id, so a stable
   * client-chosen id isn't available to match on (unlike the old mental-model path, which keyed
   * off a slug). Names are unique per folder server-side, which makes them a sound key.
   *
   * An existing page is PATCHed rather than recreated so a plugin upgrade that rewords a
   * `source_query` re-syncs onto the live page instead of orphaning its synthesized content —
   * which is how `pageScopeRule`'s repo name reaches banks seeded by an earlier version.
   */
  async seedPages(
    pageTrigger: PageTrigger = buildPageTrigger(),
    pagesConfig: PagesConfig = {},
    customPages: CustomPagesConfig = {}
  ): Promise<void> {
    // The bank id is the fallback subject, not a degraded one: for a bank no single repository
    // owns it is the only name that stays put across sessions, and under the default
    // `coding-agent::{gitProject}` template `project` is always set, so it never applies there.
    const pages = pagesFor(this.project ?? this.bank, pagesConfig, customPages);
    const existing = new Map<string, KnowledgeNode>();
    let roots: KnowledgeNode[];
    try {
      roots = await this.tree();
    } catch (e) {
      if (e instanceof KnowledgePagesUnavailableError) {
        this.log(`[bank] knowledge pages unavailable on ${this.apiUrl}; continuing without pages`);
        return;
      }
      throw e;
    }
    for (const n of roots) {
      if (n.kind === "page" && n.name) existing.set(n.name.toLowerCase(), n);
    }
    let created = 0;
    let updated = 0;
    let vanished = 0; // deleted under us mid-run — neither re-synced nor unchanged
    for (const page of pages) {
      const hit = existing.get(page.name.toLowerCase());
      const body = {
        name: page.name,
        source_query: page.source_query,
        tags: page.tags,
        max_tokens: PAGE_MAX_TOKENS,
        // Resolved HERE, not in `buildPageTrigger`: a hashed cron (`H`) needs the page's identity,
        // and one trigger is built per session for all of them.
        trigger: pageTriggerFor(pageTrigger, this.bank, page.name),
      };
      if (!hit) {
        // 409 = another deepen run seeded this name between our tree read and this POST. That is
        // the outcome we wanted anyway, so tolerate it rather than failing the whole run.
        const r = await this.req("POST", this.bankUrl("/knowledge-base/pages"), body, [409]);
        if (await this.pagesUnsupported(r)) {
          this.log(
            `[bank] knowledge pages unavailable on ${this.apiUrl}; continuing without pages`
          );
          return;
        }
        if (r.status === 404) {
          this.log(`[bank] ${this.bank} does not exist yet; pages seed on the next session`);
          return;
        }
        if (r.status !== 409) created++;
      } else {
        const sourceDrift = hit.description !== page.source_query;
        // Older servers omit trigger from the tree, so an absent value means unknown rather
        // than drift. Those servers also reject a trigger-only PATCH as an empty update.
        const triggerDrift = hit.trigger != null && pageTriggerDrifted(hit.trigger, body.trigger);
        if (!sourceDrift && !triggerDrift) continue;

        // The name IS the match key, so it can't drift; the source query and the trigger can.
        // The trigger is re-sent on ANY difference in the policy this plugin states — the refresh
        // schedule included, not just `tags_match` as before — because that is the only way a
        // changed default reaches a bank that was seeded under the old one (the hourly staggered
        // schedule that replaced auto-refresh would otherwise apply to new repos only). The
        // config is therefore the source of truth for these pages: a trigger edited in the
        // control plane is re-synced back on the next session, and a repo that wants a different
        // policy sets `pageTriggerType`/`pageTriggerCron`. Servers that do not report a page's
        // trigger leave its policy unknown; source-query drift can still be reconciled safely.
        const patch: { trigger?: PageTrigger; source_query?: string; tags?: string[] } = {};
        if (sourceDrift) {
          patch.source_query = page.source_query;
          patch.tags = page.tags;
          // Say so. This replaces a query edited through the API or the control plane, which used
          // to happen silently and read as the edit never having saved (#4460).
          this.log(
            `[bank] re-syncing "${page.name}" to its configured source_query — set ` +
              `pages[${JSON.stringify(page.name)}].source_query to keep your own wording`
          );
        }
        // The page's OWN resolved trigger (a hashed cron differs per page), not the shared one.
        if (triggerDrift) patch.trigger = pageTriggerPatch(body.trigger);
        const r = await this.req(
          "PATCH",
          this.bankUrl(`/knowledge-base/nodes/${encodeURIComponent(hit.id)}`),
          patch
        );
        if (await this.pagesUnsupported(r)) {
          this.log(
            `[bank] knowledge pages unavailable on ${this.apiUrl}; continuing without pages`
          );
          return;
        }
        // The node vanished under us (a concurrent delete). Skip it — the remaining pages are
        // still worth syncing, and the run's summary line is still worth logging.
        if (r.status === 404) {
          vanished++;
          continue;
        }
        updated++;
      }
    }
    const initiatives = await this.resyncInitiativeTriggers(roots, pageTrigger);
    this.log(
      `[bank] knowledge pages seeded on ${this.bank} (scoped to ${this.project ?? this.bank}): ` +
        `${created} created, ${updated} re-synced, ` +
        `${pages.length - created - updated - vanished} unchanged` +
        (vanished ? `, ${vanished} deleted under us` : "") +
        (initiatives ? `, ${initiatives} initiative pages re-synced` : "")
    );
  }

  /**
   * Bring the captured initiative pages onto the same refresh policy as the seeded taxonomy.
   *
   * `captureInitiative` stamps this very trigger when it creates a page, so on a bank seeded under
   * an older default they are the same drift as the taxonomy — and on a real repo they are most of
   * it: five taxonomy pages against one page per initiative, each an LLM synthesis per
   * consolidation under the auto-refresh that used to be the default (#3506).
   *
   * Only the trigger is touched. Their `name` and `source_query` are written once, from the
   * initiative's own title, and re-stating either would rebuild a page whose question never
   * changed. The tree read above is reused rather than re-fetched.
   */
  private async resyncInitiativeTriggers(
    roots: KnowledgeNode[],
    pageTrigger: PageTrigger
  ): Promise<number> {
    const folder = roots.find(
      (n) => n.kind === "folder" && (n.name || "").toLowerCase() === "initiatives"
    );
    let updated = 0;
    for (const page of folder?.children ?? []) {
      // No trigger reported = policy unknown, not divergent (a server older than #3572).
      if (page.kind !== "page" || page.trigger == null) continue;
      const desired = pageTriggerFor(pageTrigger, this.bank, page.name);
      if (!pageTriggerDrifted(page.trigger, desired)) continue;
      const r = await this.req(
        "PATCH",
        this.bankUrl(`/knowledge-base/nodes/${encodeURIComponent(page.id)}`),
        { trigger: pageTriggerPatch(desired) }
      );
      // 404 only: `req` throws on every other non-ok status it was not told to tolerate, so the
      // 405/501 this used to test for never arrive (see `pagesUnsupported`). No latch here — a
      // node that has gone missing says nothing about the server's capabilities, and nothing about
      // the pages after it either, so skip it rather than abandoning the rest of the re-sync (this
      // `break`ed while the status still carried a server-wide meaning). If it is the BANK that
      // went rather than one node, this costs one wasted PATCH per initiative page instead of one
      // total — bounded by the folder's size, and the next session re-syncs from scratch anyway.
      if (r.status === 404) continue;
      updated++;
    }
    return updated;
  }

  /** URL/id-safe slug: lowercase, non-alphanumerics → "-", trim dashes, cap length; fallback "initiative". */
  private slugify(s: string): string {
    return (
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "initiative"
    );
  }

  /**
   * Active-path capture: register a major feature as a per-initiative page + a marker memory.
   * New initiative → creates a page under the Initiatives folder.
   * Update (relatesToPageId) → no new page; only a marker accruing to the existing page, so an
   * enhancement or a mid-work plan change lands on the initiative it belongs to.
   *
   * The marker carries its page id in two places, neither of them a tag (#3641):
   * `metadata.relatedPageId` for provenance (visible on the document, and to a reflect loop that
   * expands one), and a `[[page:<id>]]` link in the retain CONTEXT, which is the only one of the
   * three channels a page synthesis actually reads — reflect's search results keep `context` and
   * `tags` but strip `metadata` (`_UNREAD_RESULT_FIELDS`), and the id has no business in a tag
   * vocabulary that exists to be matched with exact set-ops.
   */
  async captureInitiative(args: {
    title: string;
    summary: string;
    relatesToPageId?: string;
    stamp?: RetainStamp;
    /** Same refresh policy as the seeded pages — an initiative page is one of them, and used to
     *  carry its own hardcoded copy of this trigger. */
    pageTrigger?: PageTrigger;
  }): Promise<{ page_id: string }> {
    // `/knowledge-base/pages` mints its OWN page id (kp-…); we can't set it. So for a new initiative
    // we create the page first and adopt the server-assigned id — that id is what the return value
    // and the marker must use, or `read_knowledge_page(id)` 404s and the `[[page:<id>]]` link
    // points at nothing.
    let pageId = args.relatesToPageId;
    if (!pageId) {
      const folderId = await this.ensureFolder("Initiatives");
      // Same subject scoping and budget as the seeded pages: an initiative page synthesizes from
      // the same bank, which also holds facts about the dependencies this repo merely uses, and
      // "the project's memory" alone never said WHICH project (#3476). `max_tokens` is stated for
      // the same reason `seedPages` states it — leaving it implicit pins these pages to whatever
      // the server's page default happens to be, which is only coincidentally PAGE_MAX_TOKENS.
      const subject = this.project ?? this.bank;
      const r = await this.req("POST", this.bankUrl("/knowledge-base/pages"), {
        name: args.title,
        source_query:
          `Summarize the "${args.title}" initiative: what is being built or changed and why, ` +
          `and its current state — drawn from the project's memory.` +
          pageScopeRule(subject),
        parent_id: folderId,
        tags: ["knowledge:feature-work"],
        max_tokens: PAGE_MAX_TOKENS,
        trigger: pageTriggerFor(args.pageTrigger ?? buildPageTrigger(), this.bank, args.title),
      });
      try {
        const j = (await r.json()) as { page_id?: string; id?: string };
        pageId = j.page_id ?? j.id;
      } catch {
        /* fall through to the slug fallback below */
      }
      pageId ||= `initiative-${this.slugify(args.title)}`; // last resort if the response lacked an id
    }
    // "Update", not "Enhancement": a recapture is just as often a plan change (scope/goal/why
    // rewritten) as an addition, and this string is what the page synthesis reads.
    const verb = args.relatesToPageId ? "Update to an existing initiative" : "New initiative";
    const content = `${verb}: ${args.title}. ${args.summary}`;
    // Unique marker document id (NOT pageId) so repeated captures accrue instead of replacing.
    const markerId = `initiative-marker-${this.slugify(args.title)}-${Date.now()}`;
    const tags = [...new Set([...(args.stamp?.tags ?? []), "knowledge:feature-work"])];
    // The context rides on every fact extracted from this marker, verbatim (ExtractedFact.context),
    // so the Initiatives overview can link an initiative to its own page from what it retrieved.
    const context = `initiative marker for [[page:${pageId}]]`;
    await this.retain(content, context, markerId, tags, "document", {
      metadata: { ...(args.stamp?.metadata ?? {}), relatedPageId: pageId },
    });
    return { page_id: pageId };
  }

  /** Find a root folder by name (case-insensitive) or create it; returns its id. Fail-open to undefined. */
  async ensureFolder(name: string): Promise<string | undefined> {
    try {
      const tree = (await (await this.req("GET", this.bankUrl("/knowledge-base/tree"))).json()) as {
        roots?: { id?: string; kind?: string; name?: string }[];
      };
      const hit = (tree.roots || []).find(
        (n) => n.kind === "folder" && (n.name || "").toLowerCase() === name.toLowerCase()
      );
      if (hit?.id) return hit.id;
    } catch {
      /* fall through to create */
    }
    try {
      const r = await this.req("POST", this.bankUrl("/knowledge-base/folders"), { name });
      return ((await r.json()) as { id?: string }).id;
    } catch {
      return undefined;
    }
  }
}
