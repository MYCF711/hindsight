/**
 * Tests for the public SDK face (src/sdk/index.ts).
 *
 * Everything here runs against a LOCAL `node:http` server. That is not incidental: a test that
 * reaches a real Hindsight instance would read (and, for ingest, write) the developer's actual
 * memory, and its assertions would then depend on whatever that bank happened to contain. The mock
 * answers only with the shapes `core/hindsight.ts` documents, so a test that passes pins the SDK's
 * contract — the paths it calls, the fields it maps, the kind it reports — not a server's behavior.
 *
 * The config is injected (`createHindsight({ config })`) rather than read from disk: HINDSIGHT_CONFIG
 * already points at an absent file (see vitest.config.ts), and injecting pins `apiUrl`/`bankId` so
 * neither a real `~/.hindsight/coding-agent.json` nor a stray HINDSIGHT_* variable can move the
 * bank these assertions are about.
 */
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../core/config";
import { HindsightClient } from "../core/hindsight";
import { buildKnowledgeTools } from "../core/knowledge-tools";
import {
  createHindsight,
  HindsightSdkError,
  type HindsightSdk,
  type HindsightSdkOptions,
} from "./index";

const BANK = "sdk-test-bank";
const BANK_PATH = `/v1/default/banks/${BANK}`;

/** One request the mock server received, in the form the assertions want it. */
interface MockRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: string;
}

type MockHandler = (request: MockRequest, res: ServerResponse) => void;

let server: Server;
let baseUrl = "";
let handler: MockHandler;
const requests: MockRequest[] = [];

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * A dumb stand-in for a Hindsight server: only the endpoints the SDK touches, answering with the
 * documented shapes. Unrouted paths get a 404 with `{"detail":"Not Found"}` — what FastAPI answers,
 * and what core/hindsight.ts reads as "this server has no such endpoint".
 */
const hindsightMock: MockHandler = (request, res) => {
  const { method, path } = request;
  if (method === "GET" && path === "/health") return sendJson(res, 200, { status: "ok" });
  if (method === "POST" && path === `${BANK_PATH}/memories/recall`) {
    return sendJson(res, 200, {
      results: [{ text: "memory one" }, { text: "  memory two  " }, { text: "" }],
    });
  }
  if (method === "POST" && path === `${BANK_PATH}/reflect`) {
    return sendJson(res, 200, { text: " because of the retry allowlist " });
  }
  if (method === "POST" && path === `${BANK_PATH}/memories`) {
    return sendJson(res, 200, { operation_id: "op-1" });
  }
  if (method === "GET" && path === `${BANK_PATH}/memories/m1`) {
    return sendJson(res, 200, { id: "m1", text: "row one", tags: ["trap:A"] });
  }
  if (method === "GET" && path === `${BANK_PATH}/tags`) {
    return sendJson(res, 200, {
      items: [
        { tag: "trap:A", count: 2 },
        { tag: "story:1", count: 1 },
      ],
      total: 2,
    });
  }
  if (method === "GET" && path === `${BANK_PATH}/knowledge-base/tree`) {
    return sendJson(res, 200, {
      roots: [
        {
          id: "folder-1",
          kind: "folder",
          name: "Knowledge",
          children: [
            { id: "kp-1", kind: "page", name: "Architecture", description: "How the pieces fit" },
          ],
        },
      ],
    });
  }
  if (method === "GET" && path === `${BANK_PATH}/knowledge-base/search`) {
    return sendJson(res, 200, {
      results: [
        {
          id: "kp-1",
          name: "Architecture",
          source_query: "How the pieces fit",
          snippet: "the pieces fit by means of…",
          score: 0.031,
        },
      ],
    });
  }
  if (method === "GET" && path === `${BANK_PATH}/knowledge-base/pages/kp-1`) {
    return sendJson(res, 200, {
      id: "kp-1",
      name: "Architecture",
      description: "How the pieces fit",
      body: "# Architecture\n\nThe pieces fit.",
      tags: ["knowledge:architecture"],
      timestamp: "2026-01-01T00:00:00Z",
    });
  }
  return sendJson(res, 404, { detail: "Not Found" });
};

beforeAll(async () => {
  handler = hindsightMock;
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const request: MockRequest = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body,
      };
      requests.push(request);
      handler(request, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(() => {
  requests.length = 0;
  handler = hindsightMock;
});

afterAll(async () => {
  // A test that deliberately leaves a request unanswered (the timeout case) holds a socket open;
  // close them so the process does not wait on the server to drain.
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * A resolved config pointed at the mock, pinned field by field.
 *
 * `loadConfig()` supplies the defaults (so the test still exercises the real resolution), and every
 * field the SDK reads from is then overridden — a developer machine with a token, an `optInOnly`
 * switch or a `mapPathToBank` entry cannot change what these tests assert.
 */
function sdkConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({ harness: "sdk-test" }),
    apiUrl: baseUrl,
    apiToken: undefined,
    bankId: BANK,
    dynamicBankId: false,
    mapPathToBank: {},
    paths: {},
    banks: {},
    optInOnly: false,
    optInPaths: [],
    disabled: false,
    harness: "sdk-test",
    ...overrides,
  };
}

function makeSdk(
  overrides: Partial<Config> = {},
  extra: Partial<HindsightSdkOptions> = {}
): HindsightSdk {
  return createHindsight({ directory: process.cwd(), config: sdkConfig(overrides), ...extra });
}

/** Requests whose path matches, in arrival order. */
function requestsTo(path: string): MockRequest[] {
  return requests.filter((request) => request.path === path);
}

describe("handle facts", () => {
  it("requires the directory the bank is resolved from", () => {
    expect(() => createHindsight({ directory: "   " })).toThrow(HindsightSdkError);
    try {
      createHindsight({ directory: "" });
    } catch (error) {
      expect((error as HindsightSdkError).kind).toBe("config");
    }
  });

  it("reports the resolved connection and bank, and nothing else", () => {
    const sdk = makeSdk();
    expect(sdk.apiUrl).toBe(baseUrl);
    expect(sdk.bank).toBe(BANK);
    // A static `bankId` is not one repository's, so there is no project to name — the same answer
    // core/bank.ts gives every caller.
    expect(sdk.project).toBeUndefined();
    expect(sdk.hasToken).toBe(false);
    expect(sdk.harness).toBe("sdk-test");
    expect(sdk.directory).toBe(process.cwd());
  });
});

describe("token safety", () => {
  const secret = "sk-sdk-test-secret-value";

  it("never exposes the token value — only that one exists", async () => {
    const sdk = makeSdk({ apiToken: secret });

    expect(sdk.hasToken).toBe(true);
    // No property, no serialization, no diagnostic returns the credential.
    expect(Object.keys(sdk)).not.toContain("apiToken");
    expect(Object.keys(sdk)).not.toContain("token");
    expect(JSON.stringify(sdk)).not.toContain(secret);
    expect(JSON.stringify(await sdk.status())).not.toContain(secret);
    expect(JSON.stringify(sdk.tools())).not.toContain(secret);
    expect(String(sdk)).not.toContain(secret);
  });

  it("still signs requests with it", async () => {
    const sdk = makeSdk({ apiToken: secret });
    await sdk.recall("anything");
    // Proves the boolean above is not the whole story: the client really does send the credential.
    expect(requests[0].headers.authorization).toBe(`Bearer ${secret}`);
  });
});

describe("recall", () => {
  it("returns the ranked texts, trimmed, with no empty rows", async () => {
    const sdk = makeSdk();
    const texts = await sdk.recall("what about retries");

    expect(texts).toEqual(["memory one", "memory two"]);
    const [sent] = requestsTo(`${BANK_PATH}/memories/recall`);
    expect(sent.method).toBe("POST");
    expect(JSON.parse(sent.body)).toMatchObject({ query: "what about retries" });
    // The default body is the client's own (core/hindsight.ts DEFAULT_RECALL_OPTIONS merged over
    // the config) — the SDK must not invent a recall of its own.
    expect(JSON.parse(sent.body).types).toEqual(["observation"]);
  });

  it("honors per-call budget and limit without changing the client's defaults", async () => {
    const sdk = makeSdk();
    await sdk.recall("narrow it down", { budget: "high", limit: 3 });
    const [overridden] = requestsTo(`${BANK_PATH}/memories/recall`);
    expect(JSON.parse(overridden.body)).toMatchObject({ query: "narrow it down", budget: "high", limit: 3 });

    // A second plain recall must go back to the shared defaults: a per-call override that leaked
    // into the client would silently change every later call (and every hook call, for a handle
    // built on the same config).
    await sdk.recall("plain again");
    const [, plain] = requestsTo(`${BANK_PATH}/memories/recall`);
    expect(JSON.parse(plain.body).budget).toBe("low");
    expect(JSON.parse(plain.body)).not.toHaveProperty("limit");
  });

  it("returns no rows when the bank does not exist yet", async () => {
    handler = (_request, res) => sendJson(res, 404, { detail: "Bank not found" });
    await expect(makeSdk().recall("anything")).resolves.toEqual([]);
  });
});

describe("pages", () => {
  it("maps search hits and drops the misleading RRF score", async () => {
    const sdk = makeSdk();
    const hits = await sdk.searchPages("how do pieces fit");

    expect(hits).toEqual([
      {
        id: "kp-1",
        name: "Architecture",
        description: "How the pieces fit",
        snippet: "the pieces fit by means of…",
      },
    ]);
    expect(hits[0]).not.toHaveProperty("score");
  });

  it("lists the pages under their folder", async () => {
    await expect(makeSdk().listPages()).resolves.toEqual([
      { id: "kp-1", name: "Architecture", description: "How the pieces fit", folder: "Knowledge" },
    ]);
  });

  it("reads one page's synthesized content", async () => {
    const page = await makeSdk().readPage("kp-1");
    expect(page).toMatchObject({ id: "kp-1", name: "Architecture", body: "# Architecture\n\nThe pieces fit." });
    expect(requestsTo(`${BANK_PATH}/knowledge-base/pages/kp-1`)).toHaveLength(1);
  });
});

describe("reflect / memory / tags / ingest", () => {
  it("reflects with the config's budget and tool timeout", async () => {
    const sdk = makeSdk();
    await expect(sdk.reflect("why was the allowlist dropped")).resolves.toBe(
      "because of the retry allowlist"
    );
    const [sent] = requestsTo(`${BANK_PATH}/reflect`);
    // The agent-invoked budget, not the hook's: `reflectBudget` defaults to high.
    expect(JSON.parse(sent.body)).toEqual({ query: "why was the allowlist dropped", budget: "high" });
  });

  it("reads one memory in full", async () => {
    await expect(makeSdk().memory("m1")).resolves.toEqual({
      id: "m1",
      text: "row one",
      tags: ["trap:A"],
    });
  });

  it("lists tags, with the client's client-side prefix filter", async () => {
    const sdk = makeSdk();
    await expect(sdk.tags()).resolves.toEqual([
      { tag: "trap:A", count: 2 },
      { tag: "story:1", count: 1 },
    ]);
    await expect(sdk.tags({ prefix: "story:" })).resolves.toEqual([{ tag: "story:1", count: 1 }]);
  });

  it("ingests a document through the same tool the agent calls, doc id included", async () => {
    const result = await makeSdk().ingestDocument({ title: "Design Notes", content: "the why" });
    expect(result).toEqual({ ok: true, docId: "design-notes" });

    const [retained] = requestsTo(`${BANK_PATH}/memories`);
    const [item] = JSON.parse(retained.body).items;
    expect(item).toMatchObject({
      content: "the why",
      document_id: "design-notes",
      strategy: "document",
    });
    // Provenance tags are the tool's, so an SDK ingest is indistinguishable from an MCP one.
    expect(item.tags).toEqual(expect.arrayContaining(["source:upload", "harness:sdk-test"]));
  });
});

describe("health and status", () => {
  it("reports a healthy server", async () => {
    await expect(makeSdk().health()).resolves.toEqual({ ok: true });
  });

  it("never throws when the server is unhealthy", async () => {
    handler = (_request, res) => sendJson(res, 500, { detail: "boom" });
    await expect(makeSdk().health()).resolves.toEqual({ ok: false });
  });

  it("describes connection, bank and capability without probing a missing one", async () => {
    const sdk = makeSdk();
    await expect(sdk.status()).resolves.toEqual({
      apiUrl: baseUrl,
      bank: BANK,
      project: undefined,
      hasToken: false,
      disabled: false,
      serverMode: "cloud",
      healthy: true,
      // Not asked yet — distinct from "this server has no pages".
      knowledgePagesSupported: null,
    });
  });

  it("updates the capability probe once a page endpoint has answered", async () => {
    const sdk = makeSdk();
    await sdk.listPages();
    await expect(sdk.status()).resolves.toMatchObject({ knowledgePagesSupported: true });
  });

  it("is constructible (and inert) when the integration is disabled", async () => {
    const sdk = makeSdk({ disabled: true });
    expect(sdk.tools()).toEqual([]);
    await expect(sdk.status()).resolves.toMatchObject({ disabled: true, bank: "" });
    await expect(sdk.recall("anything")).rejects.toMatchObject({
      name: "HindsightSdkError",
      kind: "config",
    });
    await expect(sdk.callTool("hindsight_list_knowledge_pages")).resolves.toMatchObject({
      ok: false,
      error: { kind: "config" },
    });
  });
});

describe("error kinds", () => {
  const failWith = (status: number): void => {
    handler = (_request, res) => sendJson(res, status, { detail: "nope" });
  };

  it("maps 401 to auth", async () => {
    failWith(401);
    await expect(makeSdk().recall("q")).rejects.toMatchObject({
      name: "HindsightSdkError",
      kind: "auth",
      status: 401,
    });
  });

  it("maps 429 to rate_limit", async () => {
    failWith(429);
    await expect(makeSdk().recall("q")).rejects.toMatchObject({ kind: "rate_limit" });
  });

  it("maps 500 to server", async () => {
    failWith(500);
    await expect(makeSdk().recall("q")).rejects.toMatchObject({ kind: "server", status: 500 });
  });

  it("maps an expired deadline to timeout", async () => {
    // Never answers: the client's AbortSignal deadline is the only way out.
    handler = () => {};
    await expect(makeSdk().recall("q", { timeoutMs: 50 })).rejects.toMatchObject({
      kind: "timeout",
    });
  });

  it("maps a reflect deadline to timeout too", async () => {
    handler = () => {};
    await expect(makeSdk().reflect("q", { timeoutMs: 50 })).rejects.toMatchObject({
      kind: "timeout",
    });
  });

  it("maps an unreachable server to network", async () => {
    // A port nothing listens on: `fetch` rejects, and the client does not wrap transport errors.
    const sdk = createHindsight({
      directory: process.cwd(),
      config: sdkConfig({ apiUrl: "http://127.0.0.1:1" }),
    });
    await expect(sdk.recall("q", { timeoutMs: 5_000 })).rejects.toMatchObject({ kind: "network" });
  });
});

describe("tools()", () => {
  it("publishes exactly the knowledge tools, by name", () => {
    const sdk = makeSdk();
    const expected = buildKnowledgeTools(
      new HindsightClient({ apiUrl: baseUrl, bank: BANK }),
      BANK
    ).map((spec) => spec.name);
    expect(expected.length).toBeGreaterThan(5);
    expect(sdk.tools().map((spec) => spec.name)).toEqual(expected);
  });

  it("is pure JSON: no handlers, no zod instances, round-trips through JSON.stringify", () => {
    const specs = makeSdk().tools();
    expect(JSON.parse(JSON.stringify(specs))).toEqual(specs);
    for (const spec of specs) {
      expect(Object.keys(spec).sort()).toEqual(["annotations", "description", "inputSchema", "name"]);
      expect(spec).not.toHaveProperty("handler");
      expect(spec.inputSchema).toMatchObject({ type: "object" });
    }
  });

  it("carries each tool's real parameters and safety annotations", () => {
    const specs = makeSdk().tools();
    const search = specs.find((spec) => spec.name === "hindsight_search_knowledge_pages");
    expect(search?.inputSchema).toMatchObject({
      properties: { query: { type: "string" } },
      required: ["query"],
    });
    expect(search?.annotations.readOnlyHint).toBe(true);

    const read = specs.find((spec) => spec.name === "hindsight_read_knowledge_page");
    expect(read?.inputSchema).toMatchObject({ properties: { page_id: { type: "string" } } });
  });

  it("returns the same array on every call, so a host can memoize what it registered", () => {
    const sdk = makeSdk();
    expect(sdk.tools()).toBe(sdk.tools());
  });
});

describe("callTool()", () => {
  it("reports an unknown tool instead of throwing", async () => {
    const result = await makeSdk().callTool("hindsight_nope", {});
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("unsupported");
    expect(result.error?.message).toContain("hindsight_nope");
  });

  it("dispatches a read tool over the same registry, with parsed payload", async () => {
    const result = await makeSdk().callTool("hindsight_list_knowledge_pages");
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      items: [{ id: "kp-1", name: "Architecture", description: "How the pieces fit", folder: "Knowledge" }],
    });
    expect(requestsTo(`${BANK_PATH}/knowledge-base/tree`)).toHaveLength(1);
  });

  it("passes arguments through and returns the tool's payload", async () => {
    const result = await makeSdk().callTool("hindsight_search_knowledge_pages", {
      query: "how do pieces fit",
    });
    expect(result.ok).toBe(true);
    const data = result.data as { pages: { page_id: string }[] };
    expect(data.pages[0].page_id).toBe("kp-1");
  });

  it("turns a tool-level failure into { ok: false, error }", async () => {
    const result = await makeSdk().callTool("hindsight_read_memory", { memory_id: "gone" });
    expect(result.ok).toBe(false);
    // The tool caught the client's error and returned it as text; the kind is classified from that
    // text, which is the only channel a never-throwing tool leaves.
    expect(result.error?.message).toContain("memory not found: gone");
    expect(result.error?.kind).toBe("unknown");
  });
});
