/**
 * Hindsight SDK — the stable, programmatic face of this package.
 *
 * WHY this file exists: everything under `core/` is INTERNAL. It moves with the integration's own
 * needs — a new recall parameter, a page-shape fix, a credential-refresh tweak — and every one of
 * those movements is visible to anyone who imported `HindsightClient` directly. Code that merely
 * wants to USE this repo's memory (another plugin, a PTC tool binding, a benchmark harness) was
 * therefore coupled to the integration's innards, which is a contract nobody can keep.
 *
 * So this module is deliberately thin. It owns no HTTP of its own: every call is a delegation to
 * `core/hindsight.ts` (or, for the tool surface, `core/knowledge-tools.ts`), which is where the
 * behavior and its tests already live. What it adds is the three things a caller outside this
 * package actually needs:
 *
 *   1. one `createHindsight({ directory })` entry point that resolves config + bank + credential
 *      with the SAME pipeline the host plugins use (core/config.ts + core/bank.ts), so an SDK call
 *      lands in the bank the agent's hooks write to — a second, subtly different derivation is how
 *      memory ends up in two banks that never see each other;
 *   2. one error type, `HindsightSdkError`, with a small CLOSED set of `kind`s, so a caller can
 *      react to an auth failure or a rate limit without string-matching an HTTP message;
 *   3. a tool list that is pure JSON (JSON Schema string in/out, no zod shape objects, no handler
 *      functions) plus `callTool()` over the same registry the MCP server registers — this is the
 *      surface a host projects into its own wire format.
 *
 * The credential rule is absolute and is the reason there is no `client` accessor: the token is
 * used to sign requests and never leaves this object. `hasToken` is a boolean; that is the only
 * fact about the credential that crosses the boundary. No method, error message, `status()` field
 * or serialization of the SDK exposes the value.
 *
 * Not exposed on purpose: raw page CRUD, bank configuration, seeding and the ingest engine. Those
 * are the integration's own machinery (see core/knowledge-tools.ts's module note); the SDK is a
 * read-and-capture face, matching what an agent is allowed to do.
 */
import { z, type ZodRawShape } from "zod";
import { applyBankConfig, loadConfig, type Config } from "../core/config";
import { bankProjectName, deriveBankIdOrSkip } from "../core/bank";
import {
  HindsightClient,
  KnowledgePagesUnavailableError,
  RateLimitedError,
  ReflectError,
  type RecallResultRow,
} from "../core/hindsight";
import { buildKnowledgeTools, type ToolSpec as InternalToolSpec } from "../core/knowledge-tools";
import { buildPageTrigger } from "../core/missions";
import { buildRetainStamp } from "../core/retain-stamp";

// Re-exported so a consumer can name the types that appear in this module's signatures without
// reaching into `core/` — which is exactly what this module exists to stop them doing.
export type { Config } from "../core/config";
export type { RecallResultRow } from "../core/hindsight";

/** How long `recall()` waits for the server when the caller does not say. Same order as a hook's
 *  retrieval budget: an SDK call that hangs is worse than one that fails and can be retried. */
export const DEFAULT_RECALL_TIMEOUT_MS = 15_000;

/** How long `health()` waits by default. A liveness probe that outlives a caller's patience is a
 *  worse answer than `{ ok: false }`. */
export const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

/**
 * The closed set of failure kinds this SDK reports.
 *
 * Closed on purpose: a caller switching on these can write one handler and be done, so adding a
 * kind is a breaking change and a value is never added for a corner a caller cannot act on.
 *
 *   config      — the SDK is not usable as configured (disabled, no bank resolved, bad arguments)
 *   auth        — the server rejected the credential (or none was sent)
 *   network     — the server could not be reached at all (refused, DNS, TLS)
 *   timeout     — a deadline expired, ours or the server's
 *   rate_limit  — the server said "not now" (HTTP 429); retryable
 *   server      — the server failed (5xx)
 *   unsupported — the server does not offer the capability (e.g. knowledge pages, an unknown tool)
 *   unknown     — anything else, including a 4xx that is not about auth or rate limiting
 */
export type HindsightSdkErrorKind =
  | "config"
  | "auth"
  | "network"
  | "timeout"
  | "rate_limit"
  | "server"
  | "unsupported"
  | "unknown";

/**
 * Every failure this SDK reports, once.
 *
 * `cause` carries the original error (the client's, or the DOMException/TypeError beneath it) so
 * the information lost by wrapping is still reachable — a caller debugging a connection problem
 * needs `ECONNREFUSED`, not "request failed". `status` is set when the server answered with an
 * HTTP status.
 */
export class HindsightSdkError extends Error {
  readonly kind: HindsightSdkErrorKind;
  readonly status?: number;

  constructor(
    message: string,
    opts: { kind: HindsightSdkErrorKind; status?: number; cause?: unknown }
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "HindsightSdkError";
    this.kind = opts.kind;
    if (opts.status !== undefined) this.status = opts.status;
  }
}

/**
 * Classify any failure into this SDK's taxonomy.
 *
 * Exported because a host that wraps Hindsight calls (a plugin's own tool handler, say) has its
 * own try/catch and needs the same answer this module gives its methods. The client throws plain
 * `Error`s carrying `"METHOD url -> status body"` for non-2xx responses (core/hindsight.ts), so a
 * status is recovered by reading that shape; it is the only channel the client offers and it is
 * pinned by its own tests, which is why parsing it here is safe enough to be worth it.
 */
export function toHindsightSdkError(error: unknown): HindsightSdkError {
  if (error instanceof HindsightSdkError) return error;
  // Typed client errors first: each already knows what it means, and the generic status parse
  // below would lose the distinction (a RateLimitedError's message has no status code in it).
  if (error instanceof RateLimitedError)
    return new HindsightSdkError(error.message, { kind: "rate_limit", cause: error });
  if (error instanceof KnowledgePagesUnavailableError)
    return new HindsightSdkError(error.message, { kind: "unsupported", cause: error });
  if (error instanceof ReflectError) {
    const kind: HindsightSdkErrorKind = error.timedOut
      ? "timeout"
      : error.status !== undefined
        ? statusKind(error.status)
        : // ReflectError without a status is a transport failure — no other endpoint would answer
          // either, so "network" is the truthful kind.
          "network";
    return new HindsightSdkError(error.message, {
      kind,
      ...(error.status !== undefined ? { status: error.status } : {}),
      cause: error,
    });
  }
  // An aborted fetch (AbortSignal.timeout) rejects with a DOMException, which is NOT reliably an
  // `instanceof Error` across runtimes — check the name before the class.
  const name = (error as { name?: unknown } | null | undefined)?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return new HindsightSdkError(error instanceof Error ? error.message : "request timed out", {
      kind: "timeout",
      cause: error,
    });
  }
  if (error instanceof Error) {
    const status = statusInMessage(error.message);
    if (status !== undefined) {
      return new HindsightSdkError(error.message, {
        kind: statusKind(status),
        status,
        cause: error,
      });
    }
    // `fetch` rejects with a bare `TypeError("fetch failed")`; the real reason lives in `cause`.
    if (error instanceof TypeError)
      return new HindsightSdkError(error.message, { kind: "network", cause: error });
    return new HindsightSdkError(error.message, { kind: "unknown", cause: error });
  }
  return new HindsightSdkError(String(error), { kind: "unknown", cause: error });
}

/** What one available tool looks like to a caller: the JSON projection of a `core` ToolSpec. */
export type JsonSchema = Record<string, unknown>;

/**
 * Safety metadata, published verbatim by the MCP server and mirrored here so a host projecting
 * `tools()` onto its own wire format keeps the same semantics (read-only vs write, gated or not).
 */
export interface HindsightToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/**
 * One tool the SDK can dispatch, as pure JSON.
 *
 * This is the JSON-safe projection of `core/knowledge-tools.ts`'s `ToolSpec`: the zod raw shape is
 * converted to JSON Schema and the `handler` function is removed, because the point of `tools()`
 * is to be serializable — a host embeds these in its own tool registration, and a function or a
 * zod instance would either be dropped silently by JSON.stringify or break the host's schema.
 * Dispatch is still available, via `callTool()`.
 */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: HindsightToolAnnotations;
}

/** Arguments for `recall()`. Every field is optional; the config supplies the rest. */
export interface RecallOptions {
  /** The server's synthesis budget for this recall. Defaults to the config's `recallOptions`. */
  budget?: "low" | "mid" | "high";
  /** Override the default request deadline. */
  timeoutMs?: number;
  /** Cap on the number of rows the server returns. Defaults to the server's own cut. */
  limit?: number;
}

/** Arguments for `searchPages()`. */
export interface SearchPagesOptions {
  /** Hits to ask for. Defaults to the client's `pageSearchLimit` (config `pageSearchLimit`). */
  limit?: number;
  timeoutMs?: number;
}

/** Arguments for `reflect()`. */
export interface ReflectOptions {
  /** Synthesis budget. Defaults to the config's `reflectBudget`. */
  budget?: "low" | "mid" | "high";
  /** Override the config's `reflectToolTimeoutMs` (the agent-invoked-tool timeout). */
  timeoutMs?: number;
}

/** Arguments for `tags()`. */
export interface TagsOptions {
  limit?: number;
  offset?: number;
  prefix?: string;
}

/** A document to ingest: the same shape the `hindsight_ingest_document` tool takes. */
export interface IngestDocumentInput {
  title: string;
  content: string;
}

export interface HindsightHealth {
  ok: boolean;
}

/** One knowledge page, as `listPages()` reports it (ids + titles, no synthesized content). */
export interface HindsightPageSummary {
  id: string;
  name: string;
  description?: string;
  folder?: string;
}

/**
 * One page hit from `searchPages()`.
 *
 * No `score` field. The server fuses BM25 and vector search with reciprocal rank fusion, so the
 * number is ~1/(60+rank) summed over two retrievers: a perfect top hit scores about 0.03 and
 * nothing ever approaches 1. Hits arrive in rank order, which is the ranking that means something
 * here — the same reasoning that keeps it out of the agent-facing tool payload.
 */
export interface HindsightPageSearchHit {
  id: string;
  name: string;
  /** The question the page answers (the page's `source_query`) — what it is FOR. */
  description?: string;
  snippet: string;
}

/** One page's synthesized content, as `readPage()` reports it (server-shaped, trace stripped). */
export interface HindsightPage {
  id?: string;
  name?: string;
  description?: string;
  tags?: string[];
  last_updated_at?: string;
  body?: string;
}

export interface HindsightTag {
  tag: string;
  count: number;
}

export interface IngestDocumentResult {
  ok: true;
  /** The document id the retain used — deterministic from the title, so re-ingesting updates it. */
  docId: string;
}

/**
 * Read-only facts about THIS handle: connection, bank, and capability probes. Nothing here is
 * secret, and nothing here changes state — `status()` is safe to log.
 */
export interface HindsightStatus {
  apiUrl: string;
  bank: string;
  project?: string;
  hasToken: boolean;
  /** True when the integration is off for this directory (config `disabled`, `optInOnly`, or an
   *  unidentifiable repository) — every call then fails with kind `config` and `tools()` is empty. */
  disabled: boolean;
  serverMode: "cloud" | "self-hosted" | "daemon";
  /** Live `/health` probe result. */
  healthy: boolean;
  /** Tri-state capability: `null` = this handle has not asked the server yet. */
  knowledgePagesSupported: boolean | null;
}

export interface ToolContentPart {
  type: "text";
  text: string;
}

/** A failed `callTool()`. `kind` is best-effort: the tool layer deliberately never throws, so the
 *  classification comes from the error text it returned. */
export interface ToolCallError {
  kind: HindsightSdkErrorKind;
  message: string;
}

export interface ToolCallResult {
  ok: boolean;
  /** The tool's raw content, exactly as the MCP server would return it. */
  content?: ToolContentPart[];
  /** The first content part parsed as JSON when it is JSON (tool payloads are), else left out. */
  data?: unknown;
  error?: ToolCallError;
}

/** Everything the SDK exposes. Methods throw `HindsightSdkError`; `callTool()` does not. */
export interface HindsightSdk {
  /** The effective API base URL (daemon mode is already resolved to 127.0.0.1:<port>). */
  readonly apiUrl: string;
  /** Whether a credential is configured at construction. The VALUE is never exposed. */
  readonly hasToken: boolean;
  /** The bank this handle reads and writes. */
  readonly bank: string;
  /** The repository the bank is about, when the bank is one repo's — used in page scoping. */
  readonly project?: string;
  readonly directory: string;
  readonly harness: string;

  /** Liveness probe. Never throws: an unreachable server is `{ ok: false }`. */
  health(timeoutMs?: number): Promise<HindsightHealth>;
  /** Raw recall of consolidated observations, in rank order (no LLM in the loop). */
  recall(query: string, opts?: RecallOptions): Promise<string[]>;
  /** Hybrid page search. */
  searchPages(query: string, opts?: SearchPagesOptions): Promise<HindsightPageSearchHit[]>;
  /** One page's full synthesized content by knowledge-base id. */
  readPage(pageId: string): Promise<HindsightPage>;
  /** Every knowledge page in the bank, as id + name + description. */
  listPages(): Promise<HindsightPageSummary[]>;
  /** Agentic synthesis over the bank's full memory. Slow by nature; `reflectToolTimeoutMs` applies. */
  reflect(query: string, opts?: ReflectOptions): Promise<string>;
  /** Ingest a document (the same call and the same deterministic doc id as the MCP tool). */
  ingestDocument(doc: IngestDocumentInput): Promise<IngestDocumentResult>;
  /** One memory in full, including the fields recall's text projection drops. */
  memory(memoryId: string): Promise<RecallResultRow>;
  /** The tags that exist in this bank, with how many memories carry each. */
  tags(opts?: TagsOptions): Promise<HindsightTag[]>;
  /** Connection/bank/capability facts. Safe to log; contains no secret. */
  status(): Promise<HindsightStatus>;
  /** The tool registry as pure JSON, for a host to project into its own wire format. */
  tools(): ToolSpec[];
  /** Dispatch one tool by name over the same registry `tools()` describes. */
  callTool(name: string, args?: Record<string, unknown>): Promise<ToolCallResult>;
}

/** Options for `createHindsight()`. */
export interface HindsightSdkOptions {
  /** Working directory the bank is resolved from — the repo whose memory this handle serves. */
  directory: string;
  /** Harness id used for `{harness}` bank placeholders and `harness:` provenance tags. Defaults to
   *  the resolved config's own `harness`, which is what every other entry point uses. */
  harness?: string;
  /** An ALREADY-RESOLVED config, replacing the file lookup (tests, embedders, hosts that own their
   *  configuration). When present the SDK does not re-read the config file, including on a 401 —
   *  the caller owns credential rotation and can rebuild the handle. */
  config?: Config;
  /** Diagnostics sink. Receives human-readable lines; never the token. */
  log?: (message: string) => void;
}

/** The `"METHOD url -> status body"` shape core/hindsight.ts's untyped errors carry. */
const STATUS_IN_MESSAGE = /\s->\s(\d{3})\b/;

function statusInMessage(message: string): number | undefined {
  const match = STATUS_IN_MESSAGE.exec(message);
  return match ? Number(match[1]) : undefined;
}

function statusKind(status: number): HindsightSdkErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  // 408 (request timeout) and 504 (gateway timeout) are deadlines, not server faults: the caller's
  // retry is the right response, which is what `timeout` tells it.
  if (status === 408 || status === 504) return "timeout";
  if (status >= 500) return "server";
  return "unknown";
}

/** Run a delegation, translating any failure into `HindsightSdkError`. */
async function attempt<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toHindsightSdkError(error);
  }
}

/**
 * Turn a zod raw shape into the JSON Schema a caller receives.
 *
 * `z.toJSONSchema` rather than a hand-rolled walker: the shape's `.describe()` text and
 * optionality are exactly the information a host needs to expose the tool, and a walker that
 * re-derives them is one zod upgrade away from being wrong.
 */
function jsonSchemaOf(shape: ZodRawShape): JsonSchema {
  const schema = z.toJSONSchema(z.object(shape)) as unknown as JsonSchema;
  // `$schema` names a dialect — meaningless once this object is embedded as one field of another
  // schema, which is precisely what a tool registration does.
  delete schema.$schema;
  return schema;
}

function toJsonToolSpec(spec: InternalToolSpec): ToolSpec {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: jsonSchemaOf(spec.inputSchema),
    annotations: { ...spec.annotations },
  };
}

/** Parse a tool payload, leaving a non-JSON body as text. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The message inside a failed tool's `{"error": "…"}` payload. */
function errorTextOf(text: string): string {
  const parsed = parseJson(text) as { error?: unknown } | null;
  if (parsed && typeof parsed === "object" && typeof parsed.error === "string") return parsed.error;
  return text.trim() || "Hindsight tool failed";
}

/** Best-effort kind for a failure that only survived as text (see `ToolCallError`). */
function kindFromToolError(message: string): HindsightSdkErrorKind {
  const status = statusInMessage(message);
  if (status !== undefined) return statusKind(status);
  if (/does not support knowledge pages/i.test(message)) return "unsupported";
  return "unknown";
}

/** Config + bank + project for one directory: the binding every host resolves before building a
 *  client (see core/host-client.ts). */
interface Binding {
  cfg: Config;
  bankId: string;
  project?: string;
}

/**
 * The same four steps `resolveHostConfig` in core/host-client.ts runs, minus the `loadConfig()`
 * call.
 *
 * The SDK can be handed an already-resolved `Config` (option `config`), which is precisely the
 * case the shared builder cannot express — it always re-reads the file. So the steps are here,
 * identical in order and in `disabled` handling: a globally disabled config stops before bank
 * derivation (it exists to be a zero-overhead baseline, not merely a silent one), and an
 * unidentifiable repository takes the same exit rather than guessing a bank id (#3950).
 */
function bindConfig(cfg0: Config, harness: string, directory: string): Binding {
  if (cfg0.disabled) return { cfg: cfg0, bankId: "" };
  const derived = deriveBankIdOrSkip(cfg0, directory, harness);
  if (derived === null) return { cfg: { ...cfg0, disabled: true }, bankId: "" };
  const resolved = applyBankConfig(cfg0, derived, directory);
  // The repository the bank is ABOUT, for page scoping — only when the bank really is this repo's
  // (a `banks.<id>.bank` rename or a `mapPathToBank` entry can point several repos at one bank;
  // naming it after whichever session ran last is how page scope sentences used to flip, #4146).
  const project = resolved.bankId === derived ? bankProjectName(resolved.cfg, directory) : undefined;
  return { ...resolved, project };
}

/** Read the `{items:[…]}` page list `HindsightClient.listPages()` returns, keeping it typed. */
function pageSummaries(raw: unknown): HindsightPageSummary[] {
  const items = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const out: HindsightPageSummary[] = [];
  for (const item of items) {
    const row = item as { id?: unknown; name?: unknown; description?: unknown; folder?: unknown };
    if (typeof row?.id !== "string" || typeof row?.name !== "string") continue;
    out.push({
      id: row.id,
      name: row.name,
      ...(typeof row.description === "string" ? { description: row.description } : {}),
      ...(typeof row.folder === "string" ? { folder: row.folder } : {}),
    });
  }
  return out;
}

/**
 * A recall whose per-call overrides are honored.
 *
 * With no `budget`/`limit`, this IS `client.recallObservations()` — the exact request the hooks
 * send. With one, the body has to carry the override, and `recallObservations` sends the client's
 * fixed `recallOptions`. Rather than reaching for the endpoint (core/hindsight.ts is deliberately
 * the ONE module that addresses it — that is how "every memory write goes through the call site
 * that scopes it" stays structurally true) or mutating the live client's options (a concurrent
 * call would then recall under the wrong budget), the override rides a second, throwaway client
 * whose `recallOptions` are merged. Constructing one is pure — nothing is sent until the call.
 */
async function recallTexts(
  client: HindsightClient,
  query: string,
  opts: RecallOptions,
  clientWith: (recallOptions: Record<string, unknown>) => HindsightClient
): Promise<string[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RECALL_TIMEOUT_MS;
  if (opts.budget === undefined && opts.limit === undefined) {
    return await client.recallObservations(query, { timeoutMs });
  }
  return await clientWith({
    ...client.recallOptions,
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
  }).recallObservations(query, { timeoutMs });
}

/**
 * Create a Hindsight handle for one directory.
 *
 * Resolution is the hosts' resolution: `loadConfig()` (env + file + `harnesses.<name>`), bank
 * derivation for `directory`, then the `banks.<id>` section — so the SDK reads and writes exactly
 * the bank the agent's hooks do, including per-repo opt-out and per-bank URL/token overrides.
 *
 * ```ts
 * const memory = createHindsight({ directory: process.cwd() });
 * const hits = await memory.searchPages("how are errors surfaced?");
 * ```
 *
 * A config that disables Hindsight (globally, via `optInOnly`, or because no bank could be
 * resolved) still produces a handle: `tools()` is empty, `status().disabled` is true, and calls
 * fail with kind `config`. Throwing here instead would make a plugin's bootstrap fail on a repo the
 * user deliberately opted out of — the same inert behavior a host gets is the correct one.
 */
export function createHindsight(opts: HindsightSdkOptions): HindsightSdk {
  if (!opts || typeof opts.directory !== "string" || opts.directory.trim() === "") {
    throw new HindsightSdkError(
      "createHindsight({ directory }) — the directory the memory bank is resolved from is required",
      { kind: "config" }
    );
  }
  const directory = opts.directory;
  const injected = opts.config;
  // A harness hint makes `loadConfig` resolve `harnesses.<name>` and acts as the `{harness}`
  // placeholder value. Without one, the config file/env decides (Config.harness always has a
  // value), which is what every non-flag-driven entry point does.
  const cfg0 = injected ?? loadConfig(opts.harness ? { harness: opts.harness } : {});
  const harness = opts.harness ?? cfg0.harness;
  const binding = bindConfig(cfg0, harness, directory);
  const { cfg, bankId, project } = binding;

  const log = opts.log ?? (() => {});
  // Every client this handle builds comes from here — the live one, and the throwaway a per-call
  // recall override rides (see recallTexts). One place, so `observationScopes` and the live
  // credential can never be dropped from one of them (the invariant core/host-client.test.ts
  // enforces over the tree).
  const buildClient = (
    recallOptions: Record<string, unknown> = cfg.recallOptions
  ): HindsightClient =>
    new HindsightClient({
      apiUrl: cfg.apiUrl,
      apiToken: cfg.apiToken,
      bank: bankId,
      project,
      maxParallelRetains: cfg.maxParallelRetains,
      observationScopes: cfg.observationScopes,
      pageSearchLimit: cfg.pageSearchLimit,
      recallOptions,
      log,
      // An injected config is the caller's to rotate: re-reading the file would defeat the point of
      // injecting it. Otherwise follow core/host-client.ts — a long-lived host must pick up a
      // credential enabled or rotated mid-session instead of signing every call with the snapshot
      // it started with (#3600); consulted only on a 401, so the happy path never touches the disk.
      ...(injected
        ? {}
        : {
            tokenProvider: () => {
              const live = bindConfig(loadConfig({ harness }), harness, directory).cfg;
              // The URL stays the one this client was built with: a token re-read after the config
              // moved this directory to another server is THAT server's credential, not this one's.
              return live.apiUrl === cfg.apiUrl ? live.apiToken : cfg.apiToken;
            },
          }),
    });

  const client = buildClient();

  log(
    `hindsight sdk: bank=${bankId || "(unresolved)"} api=${cfg.apiUrl} ` +
      `token=${cfg.apiToken ? "configured" : "none"} harness=${harness}`
  );

  const disabledMessage = () =>
    `Hindsight is disabled for ${directory} — either "disabled" is set in the config, or ` +
    `"optInOnly" is on and this directory is not approved, or the repository could not be ` +
    `identified (no bank exists to call).`;

  function requireUsable(): void {
    if (cfg.disabled) throw new HindsightSdkError(disabledMessage(), { kind: "config" });
  }

  // Built on first use, not at construction: building the specs reads the config and probes
  // nothing, but a handle created only to run `status()` should not pay for it.
  let internalSpecs: InternalToolSpec[] | undefined;
  function specs(): InternalToolSpec[] {
    if (internalSpecs) return internalSpecs;
    internalSpecs = cfg.disabled
      ? []
      : buildKnowledgeTools(client, bankId, {
          repoDir: directory,
          harness,
          // The same wiring src/mcp-server.ts gives its tools, so a tool invoked through
          // `callTool()` behaves exactly like the one an agent calls over MCP: page refresh policy
          // from the config, the agent-invoked reflect window, retain stamps and the guide note.
          pageTrigger: buildPageTrigger(cfg),
          reflectTimeoutMs: cfg.reflectToolTimeoutMs,
          reflectBudget: cfg.reflectBudget,
          toolGuideExtra: cfg.toolGuideExtra,
          stampFor: () => buildRetainStamp(cfg, { directory, harness, bankId }),
        });
    return internalSpecs;
  }

  let jsonSpecs: ToolSpec[] | undefined;

  async function dispatchTool(
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<ToolCallResult> {
    if (cfg.disabled) return { ok: false, error: { kind: "config", message: disabledMessage() } };
    const tool = specs().find((candidate) => candidate.name === name);
    if (!tool) {
      const available = specs().map((candidate) => candidate.name);
      return {
        ok: false,
        error: {
          kind: "unsupported",
          message:
            `unknown Hindsight tool ${JSON.stringify(name)}` +
            (available.length ? ` — available: ${available.join(", ")}` : " — this handle has none"),
        },
      };
    }
    try {
      // The handlers never throw by design (core/knowledge-tools.ts turns a client error into an
      // isError:true result), so a throw here would be a bug — the catch keeps the promise above
      // anyway rather than surprising a caller with an exception from a `{ ok }` API.
      const result = await tool.handler(args);
      const content: ToolContentPart[] = (result.content ?? []).map((part) => ({
        type: part.type,
        text: part.text,
      }));
      const text = content[0]?.text ?? "";
      if (result.isError) {
        const message = errorTextOf(text);
        return { ok: false, content, error: { kind: kindFromToolError(message), message } };
      }
      return { ok: true, content, data: parseJson(text) };
    } catch (error) {
      const failure = toHindsightSdkError(error);
      return { ok: false, error: { kind: failure.kind, message: failure.message } };
    }
  }

  const api: HindsightSdk = {
    apiUrl: cfg.apiUrl,
    // A boolean, and only a boolean: see the module note. The value lives in the client's private
    // field and in nothing this object hands out.
    hasToken: Boolean(cfg.apiToken),
    bank: bankId,
    project,
    directory,
    harness,

    async health(timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS): Promise<HindsightHealth> {
      try {
        const response = await client.req(
          "GET",
          `${client.apiUrl}/health`,
          undefined,
          [],
          Math.max(1, timeoutMs)
        );
        return { ok: response.ok };
      } catch {
        // Unreachable is "not healthy", not an exception — the same contract as
        // core/daemon.ts's isServerHealthy(), so a caller can poll this in a loop.
        return { ok: false };
      }
    },

    recall(query: string, recallOpts: RecallOptions = {}): Promise<string[]> {
      return attempt(async () => {
        requireUsable();
        return await recallTexts(client, query, recallOpts, buildClient);
      });
    },

    searchPages(
      query: string,
      searchOpts: SearchPagesOptions = {}
    ): Promise<HindsightPageSearchHit[]> {
      return attempt(async () => {
        requireUsable();
        const hits = await client.searchKnowledgePages(query, {
          limit: searchOpts.limit,
          timeoutMs: searchOpts.timeoutMs,
        });
        return hits.map((hit) => ({
          id: hit.id,
          name: hit.name,
          ...(hit.source_query ? { description: hit.source_query } : {}),
          snippet: hit.snippet,
        }));
      });
    },

    readPage(pageId: string): Promise<HindsightPage> {
      return attempt(async () => {
        requireUsable();
        return (await client.getPage(pageId)) as HindsightPage;
      });
    },

    listPages(): Promise<HindsightPageSummary[]> {
      return attempt(async () => {
        requireUsable();
        return pageSummaries(await client.listPages());
      });
    },

    reflect(query: string, reflectOpts: ReflectOptions = {}): Promise<string> {
      return attempt(async () => {
        requireUsable();
        // Timeout is REQUIRED by the client, and its default differs by an order of magnitude
        // between a hook (fits the host's window) and an agent-invoked call (minutes). The SDK is
        // the latter: `reflectToolTimeoutMs` is the config field that means "a call someone waits
        // on", so that is the one used.
        return await client.reflect(query, {
          budget: reflectOpts.budget ?? cfg.reflectBudget,
          timeoutMs: reflectOpts.timeoutMs ?? cfg.reflectToolTimeoutMs,
        });
      });
    },

    ingestDocument(doc: IngestDocumentInput): Promise<IngestDocumentResult> {
      return attempt(async () => {
        requireUsable();
        // Through the tool registry, deliberately: the doc-id slugging (and its non-Latin-title
        // hash) lives in that handler, and a second copy here would let SDK-ingested documents and
        // MCP-ingested ones land on different ids for the same title.
        const result = await dispatchTool("hindsight_ingest_document", {
          title: doc.title,
          content: doc.content,
        });
        if (!result.ok) {
          const failure = result.error ?? { kind: "unknown" as const, message: "ingest failed" };
          throw new HindsightSdkError(failure.message, { kind: failure.kind });
        }
        const payload = result.data as { doc_id?: unknown } | undefined;
        if (typeof payload?.doc_id !== "string" || payload.doc_id === "") {
          throw new HindsightSdkError("ingest returned no document id", { kind: "unknown" });
        }
        return { ok: true, docId: payload.doc_id };
      });
    },

    memory(memoryId: string): Promise<RecallResultRow> {
      return attempt(async () => {
        requireUsable();
        return await client.getMemory(memoryId);
      });
    },

    tags(tagsOpts: TagsOptions = {}): Promise<HindsightTag[]> {
      return attempt(async () => {
        requireUsable();
        return await client.listTags({
          limit: tagsOpts.limit,
          offset: tagsOpts.offset,
          prefix: tagsOpts.prefix,
        });
      });
    },

    async status(): Promise<HindsightStatus> {
      // No `requireUsable()`: the whole point of status() is to describe a handle that may be
      // disabled, and a probe here never touches the bank.
      const health = await api.health();
      return {
        apiUrl: cfg.apiUrl,
        bank: bankId,
        project,
        hasToken: Boolean(cfg.apiToken),
        disabled: cfg.disabled,
        serverMode: cfg.serverMode,
        healthy: health.ok,
        // `undefined` on the client means "not asked yet", which is a different fact from "no".
        knowledgePagesSupported: client.knowledgePagesSupported ?? null,
      };
    },

    tools(): ToolSpec[] {
      if (!jsonSpecs) jsonSpecs = specs().map(toJsonToolSpec);
      // The same array on every call: callers compare/cache it, and rebuilding would silently
      // invalidate a host's own memoized registration.
      return jsonSpecs;
    },

    callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
      return dispatchTool(name, args);
    },
  };

  return api;
}
