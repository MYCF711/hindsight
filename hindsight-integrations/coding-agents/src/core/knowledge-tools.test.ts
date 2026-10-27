import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { buildKnowledgeTools } from "./knowledge-tools";
import { DEFAULT_REFLECT_TOOL_TIMEOUT_MS } from "./config";
import type { HindsightClient } from "./hindsight";

/** Minimal stub of the HindsightClient surface the tools call — no SDK, no network. */
function stubClient(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
  return {
    listPages: vi.fn(async () => ({ pages: [] })),
    getPage: vi.fn(async (_id: string) => ({ id: _id })),
    recall: vi.fn(async (_q: string, _o: unknown) => [{ text: "a fact" }]),
    captureInitiative: vi.fn(async (_a: unknown) => ({ page_id: "initiative-x" })),
    retain: vi.fn(async (..._args: unknown[]) => undefined),
    ...overrides,
  } as unknown as HindsightClient;
}

function findTool(tools: ReturnType<typeof buildKnowledgeTools>, name: string) {
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

const EXPECTED_TOOLS = [
  "hindsight_sync_status",
  "hindsight_diagnose",
  "hindsight_search_knowledge_pages",
  "hindsight_list_knowledge_pages",
  "hindsight_read_knowledge_page",
  "hindsight_reflect",
  "hindsight_capture_initiative",
  "hindsight_ingest_document",
  // ★ FORK PATCH（lazy expansion）：三个「走链」工具 + 一个「读原文」工具。
  //   用途：recall 只给排序最高的几行，而决定答案的那条可能因措辞不同被排在很后面
  //   甚至被截掉；这些工具让 agent 自己沿 id/tag 走回去。
  //   ⚠ 2026-10-07 补记：加这 4 个工具时【漏改了本列表】，导致该断言一直是红的。
  //     教训：新增/删除工具必须同步更新此列表，否则这个测试永远失败。
  "hindsight_read_memory",
  "hindsight_read_chunk",
  "hindsight_read_memory_chain",
  "hindsight_read_source",
  // ★ FORK PATCH（tag discovery，v447/v452）：「发现」工具。
  //   上面那些工具都把 tag 当【输入】（read_memory_chain 明确要求 tag「取自被召回记忆的 tags」），
  //   因此从未在召回里露面的族就够不着 —— story:<sessionId> 正是如此（名字是 uuid，猜不出）。
  "hindsight_list_tags",
];

describe("buildKnowledgeTools", () => {
  it("returns exactly the thirteen expected tools (as a set)", () => {
    const client = stubClient();
    const tools = buildKnowledgeTools(client, "repo-a");
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it("hindsight_sync_status is the FIRST tool in the list", () => {
    const client = stubClient();
    const tools = buildKnowledgeTools(client, "repo-a");
    expect(tools[0].name).toBe("hindsight_sync_status");
  });

  it("does not expose the removed raw page-CRUD tools", () => {
    const client = stubClient();
    const names = buildKnowledgeTools(client, "repo-a").map((t) => t.name);
    expect(names).not.toContain("create_page");
    expect(names).not.toContain("update_page");
    expect(names).not.toContain("delete_page");
    expect(names).not.toContain("agent_knowledge_create_page");
    expect(names).not.toContain("agent_knowledge_update_page");
    expect(names).not.toContain("agent_knowledge_delete_page");
  });

  it("hindsight_sync_status returns the syncStatus JSON for the given repoDir", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "hs-status-nogit-"));
    try {
      const repoName = basename(repoDir);
      const client = stubClient({
        listDocumentIds: vi.fn(async (tag: string) =>
          tag === "source:git"
            ? new Set([`gitlog:${repoName}`, "git:sha1", "git:sha2"])
            : new Set(["chat:s1"])
        ),
        listPages: vi.fn(async () => ({ items: [{ id: "p1", name: "Component map" }] })),
        activeOperations: vi.fn(async () => 0),
      });
      const tools = buildKnowledgeTools(client, "repo-a", { repoDir });
      const tool = findTool(tools, "hindsight_sync_status");
      const result = await tool.handler({});
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(result.content[0].text)).toEqual({
        bank: "repo-a",
        gitlogPresent: true,
        gitDiffDocs: 2,
        gitDiffTarget: null, // temp dir is not a git repo
        surveyBaseline: null,
        surveyDocs: 0,
        surveyCommitsBehind: null,
        chatDocs: 1,
        pagesCount: 1,
        activeOps: 0,
        synced: true,
      });
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("hindsight_sync_status returns isError:true when the client's listDocumentIds throws", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "hs-status-nogit-"));
    try {
      const client = stubClient({
        listDocumentIds: vi.fn(async () => {
          throw new Error("server down");
        }),
        listPages: vi.fn(async () => ({ items: [] })),
        activeOperations: vi.fn(async () => 0),
      });
      const tools = buildKnowledgeTools(client, "repo-a", { repoDir });
      const tool = findTool(tools, "hindsight_sync_status");
      const result = await tool.handler({});
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual({ error: "server down" });
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("hindsight_diagnose returns safe runtime configuration without touching the client", async () => {
    const client = stubClient();
    const tools = buildKnowledgeTools(client, "repo-a");
    const tool = findTool(tools, "hindsight_diagnose");
    const result = await tool.handler({});
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      bank_id: "repo-a",
      harness: "unknown",
      config: { api_token_configured: false },
    });
    expect(client.listPages).not.toHaveBeenCalled();
    expect(client.getPage).not.toHaveBeenCalled();
  });

  // #3600: diagnose read the config FILE and called a host healthy while its live client was
  // signing with a credential that no longer existed — misdirecting the one investigation this
  // tool exists to guide.
  it("hindsight_diagnose reports the credential in USE, not only the one on disk", async () => {
    const client = stubClient();
    (client as unknown as { apiToken: string }).apiToken = "credential-the-host-started-with";
    const tool = findTool(buildKnowledgeTools(client, "repo-a"), "hindsight_diagnose");

    const report = JSON.parse((await tool.handler({})).content[0].text);
    expect(report.credential).toEqual({
      api_token_in_use: true,
      api_token_matches_config: false,
    });
    // Booleans only — the value itself must never leave the process.
    expect(JSON.stringify(report)).not.toContain("credential-the-host-started-with");
  });

  it("hindsight_search_knowledge_pages calls the server hybrid search and returns ranked hits", async () => {
    const client = stubClient({
      searchKnowledgePages: vi.fn(async () => [
        {
          id: "p1",
          name: "Uploader guide",
          source_query: "How do uploads recover from failures?",
          snippet: "Uploads retry with backoff…",
          score: 0.031,
        },
        { id: "p2", name: "Auth notes", snippet: "Tokens rotate daily.", score: 0.012 },
      ]),
    });
    const tools = buildKnowledgeTools(client, "repo-a");
    const tool = findTool(tools, "hindsight_search_knowledge_pages");
    const result = await tool.handler({ query: "upload retries" });
    expect(result.isError).toBeFalsy();
    // The tool passes no limit — the client's pageSearchLimit is the single source for it.
    expect(client.searchKnowledgePages).toHaveBeenCalledWith("upload retries");
    // No `score`: the server's RRF number tops out near 0.03, so a model reading it treats its best
    // hit as 3% relevant. Rank order carries the ranking.
    const payload = JSON.parse(result.content[0].text);
    expect(payload.pages).toEqual([
      {
        page: "Uploader guide",
        page_id: "p1",
        description: "How do uploads recover from failures?",
        snippet: "Uploads retry with backoff…",
      },
      { page: "Auth notes", page_id: "p2", snippet: "Tokens rotate daily." },
    ]);
    // The credit reminder rides with the hits: the session guide has scrolled away by the time a
    // search lands mid-session, and a paraphrased snippet otherwise gets absorbed uncredited.
    expect(payload.crediting).toContain("From Hindsight memory");
    expect(payload.crediting).toContain("paraphrased");
  });

  it("hindsight_search_knowledge_pages adds toolGuideExtra after the crediting note (#4791)", async () => {
    const extra = "Memory is a past record: verify it against the code first.";
    const client = stubClient({ searchKnowledgePages: vi.fn(async () => []) });
    const tool = findTool(
      buildKnowledgeTools(client, "repo-a", { toolGuideExtra: extra }),
      "hindsight_search_knowledge_pages"
    );
    const { crediting } = JSON.parse((await tool.handler({ query: "q" })).content[0].text);
    // Added, not replacing: the crediting rule is still there, and the team's text follows it.
    expect(crediting).toContain("From Hindsight memory");
    expect(crediting.endsWith(extra)).toBe(true);
    expect(tool.description.endsWith(extra)).toBe(true);
  });

  it("hindsight_search_knowledge_pages returns isError:true when the server search throws", async () => {
    const client = stubClient({
      searchKnowledgePages: vi.fn(async () => {
        throw new Error("search down");
      }),
    });
    const tool = findTool(
      buildKnowledgeTools(client, "repo-a"),
      "hindsight_search_knowledge_pages"
    );
    const result = await tool.handler({ query: "x" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("search down");
  });

  it("hindsight_list_knowledge_pages calls client.listPages() with no args", async () => {
    const client = stubClient({ listPages: vi.fn(async () => ({ pages: [{ id: "p1" }] })) });
    const tools = buildKnowledgeTools(client, "repo-a");
    const tool = findTool(tools, "hindsight_list_knowledge_pages");
    const result = await tool.handler({});
    expect(client.listPages).toHaveBeenCalledWith();
    expect(JSON.parse(result.content[0].text)).toEqual({ pages: [{ id: "p1" }] });
  });

  it("hindsight_read_knowledge_page calls client.getPage(page_id)", async () => {
    const client = stubClient({ getPage: vi.fn(async (id: string) => ({ id, name: "X" })) });
    const tools = buildKnowledgeTools(client, "repo-a");
    const tool = findTool(tools, "hindsight_read_knowledge_page");
    const result = await tool.handler({ page_id: "p1" });
    expect(client.getPage).toHaveBeenCalledWith("p1");
    expect(JSON.parse(result.content[0].text)).toEqual({ id: "p1", name: "X" });
  });

  it("hindsight_reflect calls client.reflect(query, {budget: high}) and returns the synthesis", async () => {
    const client = stubClient({
      reflect: vi.fn(async () => "the decided rule is X=3"),
    });
    const tool = findTool(buildKnowledgeTools(client, "repo-a"), "hindsight_reflect");
    const result = await tool.handler({ query: "why is X 3?" });
    expect(result.isError).toBeFalsy();
    expect(client.reflect).toHaveBeenCalledWith("why is X 3?", {
      budget: "high",
      timeoutMs: DEFAULT_REFLECT_TOOL_TIMEOUT_MS,
    });
    expect(JSON.parse(result.content[0].text)).toBe("the decided rule is X=3");
  });

  // #3590: the handler used to pass NO timeout, so the client fell back to a hardcoded 120s and
  // aborted every high-budget synthesis on a populated bank — with the configured value dead.
  it("hindsight_reflect passes the configured timeout and budget through to the client", async () => {
    const client = stubClient({ reflect: vi.fn(async () => "answer") });
    const tool = findTool(
      buildKnowledgeTools(client, "repo-a", { reflectTimeoutMs: 660_000, reflectBudget: "mid" }),
      "hindsight_reflect"
    );
    await tool.handler({ query: "why?" });
    expect(client.reflect).toHaveBeenCalledWith("why?", { budget: "mid", timeoutMs: 660_000 });
  });

  it("hindsight_reflect never leaves the timeout unset (the client default would abort at 120s)", async () => {
    const client = stubClient({ reflect: vi.fn(async () => "answer") });
    const tool = findTool(buildKnowledgeTools(client, "repo-a"), "hindsight_reflect");
    await tool.handler({ query: "why?" });
    const opts = (client.reflect as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(opts.timeoutMs).toBeGreaterThan(300_000); // above the server's own reflect wall timeout
  });

  it("hindsight_capture_initiative calls client.captureInitiative({title, summary, relatesToPageId}) and returns the page id", async () => {
    const client = stubClient({
      captureInitiative: vi.fn(async (_a: unknown) => ({ page_id: "initiative-retry-backoff" })),
    });
    const tools = buildKnowledgeTools(client, "repo-a");
    const tool = findTool(tools, "hindsight_capture_initiative");
    const result = await tool.handler({
      title: "Retry backoff for the uploader",
      summary: "Add exponential backoff so transient upload failures self-heal.",
      relates_to_page_id: "initiative-uploader",
    });
    expect(client.captureInitiative).toHaveBeenCalledWith({
      title: "Retry backoff for the uploader",
      summary: "Add exponential backoff so transient upload failures self-heal.",
      relatesToPageId: "initiative-uploader",
    });
    expect(JSON.parse(result.content[0].text)).toEqual({ page_id: "initiative-retry-backoff" });
  });

  // ★ FORK PATCH（tag discovery，v447/v452）：list_tags 的价值在【发现】，所以测三件事：
  //   ① 它确实调用 client.listTags（而不是别的读法）
  //   ② prefix 在客户端过滤（服务端忽略 prefix/tag 参数 —— 契约实测于 2026-10-08）
  //   ③ limit/offset 以数字传给 client（参数进来是 string，见 dsh 投影层限制）
  it("hindsight_list_tags lists tags and forwards numeric paging", async () => {
    const client = stubClient({
      listTags: vi.fn(async () => [
        { tag: "env:local", count: 12 },
        { tag: "story:s00", count: 4 },
        { tag: "story:s01", count: 3 },
      ]),
    });
    const tools = buildKnowledgeTools(client, "repo-a");
    const tool = findTool(tools, "hindsight_list_tags");
    const result = await tool.handler({ limit: "50", offset: "5" });
    expect(client.listTags).toHaveBeenCalledWith({ limit: 50, offset: 5, prefix: undefined });
    expect(JSON.parse(result.content[0].text)).toEqual({
      prefix: null,
      count: 3,
      tags: [
        { tag: "env:local", count: 12 },
        { tag: "story:s00", count: 4 },
        { tag: "story:s01", count: 3 },
      ],
    });
  });

  it("hindsight_list_tags passes prefix through to the client (server ignores it)", async () => {
    const client = stubClient({ listTags: vi.fn(async () => []) });
    const tools = buildKnowledgeTools(client, "repo-a");
    const tool = findTool(tools, "hindsight_list_tags");
    await tool.handler({ prefix: "story:" });
    expect(client.listTags).toHaveBeenCalledWith({ limit: 200, offset: 0, prefix: "story:" });
  });

  it("hindsight_list_tags clamps paging to safe bounds and tolerates garbage", async () => {
    const client = stubClient({ listTags: vi.fn(async () => []) });
    const tools = buildKnowledgeTools(client, "repo-a");
    const tool = findTool(tools, "hindsight_list_tags");
    await tool.handler({ limit: "99999", offset: "-3" });
    expect(client.listTags).toHaveBeenCalledWith({ limit: 1000, offset: 0, prefix: undefined });
    await tool.handler({ limit: "abc", offset: "xyz" });
    expect(client.listTags).toHaveBeenLastCalledWith({ limit: 200, offset: 0, prefix: undefined });
  });

  it("hindsight_list_tags' description points at the chain tool and the uuid problem", () => {
    const tools = buildKnowledgeTools(stubClient(), "repo-a");
    const desc = findTool(tools, "hindsight_list_tags").description ?? "";
    expect(desc).toContain("hindsight_read_memory_chain");
    expect(desc).toContain("story:");
  });

  // ★ FORK PATCH（v485）：链工具的 tags_match 参数
  //   缺口：listByTag 原本只发 ?tags=X（不带 tags_match）⇒ 服务端按 `all` 处理
  //        ⇒ 把 tags 完全为空的记忆一并返回。实测（隔离库 2 带标签 + 2 真无标签）：
  //          不传 ⇒ 4 条（含 2 条无标签）；all_strict ⇒ 2 条。
  //        真实 archive 有 84.9% 无标签 ⇒ 按 story 取回会被淹没。
  it("hindsight_read_memory_chain defaults to all_strict and forwards the mode", async () => {
    const client = stubClient({ listByTag: vi.fn(async () => []) });
    const tools = buildKnowledgeTools(client, "repo-a");
    const tool = findTool(tools, "hindsight_read_memory_chain");

    // 省略 tags_match ⇒ 默认 all_strict（不是服务端的 all）
    await tool.handler({ tag: "story:s1" });
    expect(client.listByTag).toHaveBeenCalledWith("story:s1", 50, "all_strict");

    // 显式传合法值 ⇒ 透传
    await tool.handler({ tag: "story:s1", tags_match: "all" });
    expect(client.listByTag).toHaveBeenLastCalledWith("story:s1", 50, "all");

    await tool.handler({ tag: "story:s1", limit: "200", tags_match: "any_strict" });
    expect(client.listByTag).toHaveBeenLastCalledWith("story:s1", 200, "any_strict");
  });

  it("hindsight_read_memory_chain falls back to all_strict on an unknown tags_match", async () => {
    const client = stubClient({ listByTag: vi.fn(async () => []) });
    const tools = buildKnowledgeTools(client, "repo-a");
    const tool = findTool(tools, "hindsight_read_memory_chain");
    // 写错一个值（大小写/拼写）不应变成服务端的 all，而应回落到工具的正确默认
    await tool.handler({ tag: "t", tags_match: "ALL" });
    expect(client.listByTag).toHaveBeenLastCalledWith("t", 50, "all_strict");
    await tool.handler({ tag: "t", tags_match: "strict" });
    expect(client.listByTag).toHaveBeenLastCalledWith("t", 50, "all_strict");
  });

  it("hindsight_read_memory_chain reports the mode it actually used", async () => {
    const client = stubClient({ listByTag: vi.fn(async () => []) });
    const tools = buildKnowledgeTools(client, "repo-a");
    const tool = findTool(tools, "hindsight_read_memory_chain");
    const out = JSON.parse((await tool.handler({ tag: "t" })).content[0].text);
    expect(out.tags_match).toBe("all_strict");
  });

  // Regression guard for the "ONCE, EARLY" contract that told agents to capture the opening plan
  // and never recapture, so mid-work pivots never reached the initiative page.
  it("hindsight_capture_initiative's description tells the agent to recapture when the plan changes", () => {
    const tools = buildKnowledgeTools(stubClient(), "repo-a");
    const desc = findTool(tools, "hindsight_capture_initiative").description;
    expect(desc).not.toMatch(/ONCE, EARLY/i);
    expect(desc).toMatch(/call it AGAIN/i);
    expect(desc).toMatch(/goal, scope, or rationale/i);
    expect(desc).toMatch(/mid-implementation/i);
    // The recapture must reuse the existing page, not create a parallel one.
    expect(desc).toMatch(/relates_to_page_id = that/i);
    expect(desc).toMatch(/[Nn]ever mint a second page/);
    // Summary guidance must ask for the current intent, not the originally approved plan.
    expect(desc).toMatch(/CURRENT intent/);
    // Trivial course-corrections are still out of scope.
    expect(desc).toMatch(/trivial course-corrections/i);
  });

  // The recapture-on-plan-change contract lives in three places an agent can read it from: this
  // tool description, TOOL_GUIDE (knowledge-injection.ts), and the installed skill. SKILL.md is
  // copied verbatim by skill-sync, so nothing else would catch it drifting back to "once".
  it("SKILL.md documents the same recapture-on-plan-change trigger", () => {
    const md = readFileSync(
      fileURLToPath(new URL("../../skill/SKILL.md", import.meta.url)),
      "utf8"
    );
    expect(md).toMatch(/plan that materially changed/i);
    expect(md).toMatch(/`relates_to_page_id`/);
    expect(md).toMatch(/never a second page/i);
  });

  it("hindsight_capture_initiative passes relatesToPageId: undefined for a brand-new initiative", async () => {
    const client = stubClient();
    const tools = buildKnowledgeTools(client, "repo-a");
    const tool = findTool(tools, "hindsight_capture_initiative");
    await tool.handler({ title: "New thing", summary: "why" });
    expect(client.captureInitiative).toHaveBeenCalledWith({
      title: "New thing",
      summary: "why",
      relatesToPageId: undefined,
    });
  });

  it("applies retain attribution to initiative capture and manual document ingestion", async () => {
    const client = stubClient();
    const stampFor = vi.fn(() => ({
      tags: ["project:repo-a"],
      metadata: { project: "repo-a" },
    }));
    const tools = buildKnowledgeTools(client, "repo-a", { harness: "codex", stampFor });

    await findTool(tools, "hindsight_capture_initiative").handler({
      title: "New thing",
      summary: "why",
    });
    expect(client.captureInitiative).toHaveBeenCalledWith({
      title: "New thing",
      summary: "why",
      relatesToPageId: undefined,
      stamp: { tags: ["project:repo-a"], metadata: { project: "repo-a" } },
    });

    await findTool(tools, "hindsight_ingest_document").handler({ title: "Notes", content: "x" });
    expect(client.retain).toHaveBeenCalledWith(
      "x",
      "ingested document",
      "notes",
      ["project:repo-a", "source:upload", "harness:codex"],
      "document",
      { metadata: { project: "repo-a", harness: "codex" } }
    );
    expect(stampFor).toHaveBeenCalledTimes(2);
  });

  it("hindsight_ingest_document slugifies the title and calls client.retain(...) with the 'document' strategy", async () => {
    const client = stubClient();
    const tools = buildKnowledgeTools(client, "repo-a");
    const tool = findTool(tools, "hindsight_ingest_document");
    const result = await tool.handler({ title: "My Title", content: "some content" });
    expect(client.retain).toHaveBeenCalledWith(
      "some content",
      "ingested document",
      "my-title",
      ["source:upload"],
      "document",
      {} // no harness in these tests: nothing to stamp
    );
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true, doc_id: "my-title" });
  });

  it("hindsight_ingest_document collapses internal whitespace runs in the title into single hyphens", async () => {
    const client = stubClient();
    const tools = buildKnowledgeTools(client, "repo-a");
    const tool = findTool(tools, "hindsight_ingest_document");
    await tool.handler({ title: "Repo   Core  Concepts", content: "x" });
    expect(client.retain).toHaveBeenCalledWith(
      "x",
      "ingested document",
      "repo-core-concepts",
      ["source:upload"],
      "document",
      {} // no harness in these tests: nothing to stamp
    );
  });

  it("hindsight_ingest_document strips punctuation from the title into a safe slug", async () => {
    const client = stubClient();
    const tools = buildKnowledgeTools(client, "repo-a");
    const tool = findTool(tools, "hindsight_ingest_document");
    await tool.handler({ title: "Repo: Component Map! (v2/final)", content: "x" });
    expect(client.retain).toHaveBeenCalledWith(
      "x",
      "ingested document",
      "repo-component-map-v2-final",
      ["source:upload"],
      "document",
      {} // no harness in these tests: nothing to stamp
    );
  });

  it.each([
    ["测试问题17记忆文档一", "测试问题17记忆文档二"],
    ["记忆文档一", "记忆文档二"],
    ["Résumé", "Rèsumé"],
    ["!!!///???", "???///!!!"],
  ])(
    "hindsight_ingest_document keeps distinct lossy titles: %s / %s",
    async (title, otherTitle) => {
      const documents = new Map<string, string>();
      const client = stubClient({
        retain: vi.fn(async (content: string, _context: string, documentId: string) => {
          documents.set(documentId, content);
        }),
      });
      const tool = findTool(buildKnowledgeTools(client, "repo-a"), "hindsight_ingest_document");
      const first = JSON.parse(
        (await tool.handler({ title, content: "first document" })).content[0].text
      );
      const second = JSON.parse(
        (await tool.handler({ title: otherTitle, content: "second document" })).content[0].text
      );
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(first.doc_id).not.toBe(second.doc_id);
      expect(documents.get(first.doc_id)).toBe("first document");
      expect(documents.get(second.doc_id)).toBe("second document");

      const updated = await tool.handler({ title, content: "updated first document" });
      expect(JSON.parse(updated.content[0].text)).toEqual(first);
      expect(documents.size).toBe(2);
      expect(documents.get(first.doc_id)).toBe("updated first document");
      expect(documents.get(second.doc_id)).toBe("second document");
    }
  );

  for (const name of [
    "hindsight_list_knowledge_pages",
    "hindsight_read_knowledge_page",
    "hindsight_reflect",
    "hindsight_capture_initiative",
    "hindsight_ingest_document",
  ] as const) {
    it(`${name} returns isError:true with the error text when the client method throws`, async () => {
      const boom = new Error("boom: not found");
      const client = stubClient({
        listPages: vi.fn(async () => {
          throw boom;
        }),
        getPage: vi.fn(async () => {
          throw boom;
        }),
        reflect: vi.fn(async () => {
          throw boom;
        }),
        captureInitiative: vi.fn(async () => {
          throw boom;
        }),
        retain: vi.fn(async () => {
          throw boom;
        }),
      });
      const tools = buildKnowledgeTools(client, "repo-a");
      const tool = findTool(tools, name);
      const args =
        name === "hindsight_reflect"
          ? { query: "q" }
          : name === "hindsight_capture_initiative"
            ? { title: "T", summary: "S" }
            : name === "hindsight_ingest_document"
              ? { title: "T", content: "C" }
              : name === "hindsight_read_knowledge_page"
                ? { page_id: "p1" }
                : {};
      const result = await tool.handler(args);
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual({ error: "boom: not found" });
    });
  }
});
