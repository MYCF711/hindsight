import { describe, expect, it } from "vitest";
import { parsePageList, buildKnowledgePreamble, buildRosterRefresh } from "./knowledge-injection";
import { buildSystemInjection } from "./inject";

describe("parsePageList", () => {
  it("extracts {id,title} from the page list shape, tolerating junk", () => {
    const raw = {
      items: [
        { id: "p1", name: "Component map" },
        { id: "p2", name: "Core concepts" },
        { nope: 1 },
      ],
    };
    expect(parsePageList(raw)).toEqual([
      { id: "p1", title: "Component map" },
      { id: "p2", title: "Core concepts" },
    ]);
  });
  it("returns [] for null/garbage", () => {
    expect(parsePageList(null)).toEqual([]);
    expect(parsePageList(42 as unknown)).toEqual([]);
  });
});

describe("buildKnowledgePreamble", () => {
  it("names how many pages exist, withholds the index, and gives the FULL tool guide", () => {
    const out = buildKnowledgePreamble([{ id: "p1", title: "Component map" }]);
    expect(out).toContain("<hindsight_knowledge>");
    expect(out).toContain("1 knowledge page covers this repository");
    expect(out).toContain("deliberately NOT listed here");
    // Crediting is stated as an obligation triggered by the CALL. Measured on a real session: the
    // agent searched, built its answer from ten on-topic pages and credited nothing, because
    // "credit what you use" reads as a rule about quoting and a paraphrase feels like neither.
    expect(out).toContain("CREDITING IS NOT OPTIONAL");
    expect(out).toContain("does not make it yours");
    // Titles and ids stay OUT: handed the index, the agent reads by id and never
    // searches — 0 searches over 40 measured turns, at 3 pages and at 12.
    expect(out).not.toContain("Component map");
    // Every meaningful tool must be named with a when-to-call, not just pages.
    expect(out).toContain("hindsight_list_knowledge_pages");
    expect(out).toContain("hindsight_read_knowledge_page");
    expect(out).toContain("hindsight_reflect");
    expect(out).toContain("hindsight_capture_initiative");
    expect(out).toContain("hindsight_ingest_document");
  });

  // ★ FORK PATCH（v485）：新增的 tags_match 参数也要在说明里出现 ——
  //   否则又是「工具实现了但 agent 不知道能传」的老问题（v457 的翻版）。
  it("names the chain tool's tags_match parameter in the injected memory block", () => {
    const out = buildSystemInjection("some recalled line");
    expect(out).toContain("hindsight_read_memory_chain(tag,tags_match)");
    expect(out).toContain("all_strict");
  });

  // ★ FORK PATCH（v458）：补一条【完整性】守卫，替代逐个人工列举的清单。
  //   由来：v457 补 list_tags 时，我又是「发现一个、补一个」。随后做全量核查，
  //   发现 sync_status / diagnose 两个工具在两处说明里【都】没有 —— 同一缺口的第二、三例。
  //   ⇒ 与其继续手工列举，不如断言「注册的工具集 ⊆ 说明提到的工具集」。
  //   ⚠ 两个函数分工不同，合起来才算「说明」：
  //        · buildKnowledgePreamble ＝ TOOL_GUIDE
  //        · buildSystemInjection   ＝ <hindsight_memory> 走链块
  it("mentions EVERY registered tool somewhere in the injected guidance", async () => {
    const { buildKnowledgeTools } = await import("./knowledge-tools");
    // 本测试只取「工具名清单」，不驱动行为 —— stub 只需存在。
    const stub = {} as unknown as import("./hindsight").HindsightClient;
    const registered = buildKnowledgeTools(stub, "repo-a").map((t) => t.name);

    const guidance =
      buildKnowledgePreamble([{ id: "p1", title: "Component map" }]) +
      "\n" +
      buildSystemInjection("some recalled line");

    const unmentioned = registered.filter((name) => !guidance.includes(name));
    // 失败信息要直接列出漏了谁，而不是只给一个 true/false。
    expect(unmentioned, `tools absent from the injected guidance: ${unmentioned.join(", ")}`).toEqual(
      []
    );
  });

  // ★ FORK PATCH（v460）：上一条守卫只管「注册了 ⇒ 要提到」，反方向没人管 ——
  //   说明里若出现一个【并未注册】的工具名（改名/删除后漏改说明），agent 照着调用
  //   必然得到 "unknown tool"，而且这类错误极难从会话里自查（它看起来像工具坏了）。
  //   ⇒ 断言「说明里提到的 hindsight_* ⇒ 必须是注册过的工具名」。
  //   ⚠ 只校验 hindsight_ 前缀的名字：说明里还有 history:... 之类的非工具标识。
  it("mentions no hindsight tool that is not actually registered (no ghost tools)", async () => {
    const { buildKnowledgeTools } = await import("./knowledge-tools");
    const stub = {} as unknown as import("./hindsight").HindsightClient;
    const registered = new Set(buildKnowledgeTools(stub, "repo-a").map((t) => t.name));

    const guidance =
      buildKnowledgePreamble([{ id: "p1", title: "Component map" }]) +
      "\n" +
      buildSystemInjection("some recalled line");

    // ⚠ 先剥掉【包裹标签】：说明里用 <hindsight_knowledge> / <hindsight_memory> /
    //   <hindsight_knowledge_refresh> 三个非工具标识做外壳，它们不是工具名。
    //   第一版正则没排除它们，守卫立刻把 hindsight_knowledge / hindsight_memory 报成幽灵工具。
    const withoutWrapperTags = guidance.replace(/<\/?hindsight_[a-z_]+>/g, " ");
    const mentioned = new Set(withoutWrapperTags.match(/hindsight_[a-z_]+/g) ?? []);
    const ghosts = [...mentioned].filter((name) => !registered.has(name));
    expect(ghosts, `tool names in the guidance that are NOT registered: ${ghosts.join(", ")}`).toEqual(
      []
    );
    // 反向保险：这条断言只在真的解析出名字时才有意义（防止正则失效后静默通过）。
    expect(mentioned.size).toBeGreaterThanOrEqual(registered.size);
  });

  // ★ FORK PATCH（tag discovery，v457）：这条守卫是补出来的 ——
  //   加 hindsight_list_tags 时，工具本身注册好了、测试也过了，但【注入给 agent 的说明里
  //   一处都没提它】。一个 agent 不知道存在的工具等于不存在。
  //   本文件上方「Every meaningful tool must be named」正是为这类缺口写的守卫，
  //   而上面那组断言的清单比工具集【旧】—— 所以这里补上。
  //   ⚠ 两个函数分工不同，断言也要分开写（我第一版把它们混在一起，测试立刻指出了）：
  //     · buildKnowledgePreamble（本文件）＝ TOOL_GUIDE：页面/反思/记录类工具
  //     · inject.ts 的注入块          ＝ 走链清单：read_* 四件套 + 本轮的 list_tags
  it("names the tag-discovery tool in the preamble's tool guide", () => {
    const out = buildKnowledgePreamble([{ id: "p1", title: "Component map" }]);
    // 发现工具：没有它，只出现在某个 family 标签下、从未被召回过的行就够不着。
    expect(out).toContain("hindsight_list_tags");
    expect(out).toContain("hindsight_read_memory_chain"); // 说明它之后的用法
  });
  it("names every chain tool (plus the tag lister) in the injected memory block", () => {
    // buildSystemInjection 输出的是 <hindsight_memory> 块 —— agent 每轮真正读到的走链指引。
    // 它和 TOOL_GUIDE 是两个不同的函数，所以两处都得点名，缺一处就等于缺一条路。
    const out = buildSystemInjection("some recalled line");
    for (const t of [
      "hindsight_read_memory",
      "hindsight_read_chunk",
      "hindsight_read_memory_chain",
      "hindsight_read_source",
      "hindsight_list_tags",
    ]) {
      expect(out).toContain(t);
    }
  });
  it("tells the agent to recapture an initiative when the plan changes mid-work", () => {
    // Same contract as the MCP tool description (knowledge-tools.ts) — the two must not drift.
    for (const out of [
      buildKnowledgePreamble([{ id: "p1", title: "Component map" }]),
      buildRosterRefresh([]),
    ]) {
      expect(out).not.toMatch(/call this ONCE/i);
      expect(out).toMatch(/call it AGAIN with relates_to_page_id/i);
      expect(out).toMatch(/goal, scope, or rationale materially changes/i);
    }
  });

  it("has an empty-state line when there are no pages", () => {
    const out = buildKnowledgePreamble([]);
    expect(out).toMatch(/no knowledge pages yet|still learning/i);
  });

  it("checks knowledge pages before reflection in tool-only mode", () => {
    for (const out of [
      buildKnowledgePreamble([{ id: "p1", title: "Component map" }], {
        reflectOnNewGoals: true,
      }),
      buildRosterRefresh([{ id: "p1", title: "Component map" }], {
        reflectOnNewGoals: true,
      }),
    ]) {
      expect(out).toMatch(/new task or goal.*knowledge pages FIRST/is);
      expect(out).toMatch(/hindsight_reflect only when.*pages are too shallow/is);
      // No `s` flag ON PURPOSE: this must stay a per-LINE guard against the old wording
      // ("call hindsight_reflect with that goal FIRST"). With `s` it would span newlines and
      // match the legitimate "hindsight_reflect ..." / "FIRST STOP" lines further down the guide.
      expect(out).not.toMatch(/hindsight_reflect.*FIRST/);
    }
  });
});

describe("buildRosterRefresh", () => {
  it("re-states the page count and the full tool guide, still without the index", () => {
    const out = buildRosterRefresh([{ id: "p1", title: "Component map" }]);
    expect(out).toContain("1 knowledge page covers this repository");
    expect(out).toContain("deliberately NOT listed here");
    // Titles and ids stay OUT: handed the index, the agent reads by id and never
    // searches — 0 searches over 40 measured turns, at 3 pages and at 12.
    expect(out).not.toContain("Component map");
    for (const tool of [
      "hindsight_list_knowledge_pages",
      "hindsight_read_knowledge_page",
      "hindsight_capture_initiative",
      "hindsight_ingest_document",
    ]) {
      expect(out).toContain(tool);
    }
  });
  it("still emits the full tool guide when there are no pages yet (no roster, but the guide persists)", () => {
    const out = buildRosterRefresh([]);
    expect(out).toContain("<hindsight_knowledge_refresh>");
    expect(out).toContain("hindsight_capture_initiative");
    expect(out).toContain("hindsight_ingest_document");
    // No roster block when there are no pages.
    expect(out).not.toContain("Current Hindsight knowledge pages");
  });
});

describe("toolGuideExtra (#4791)", () => {
  const pages = [{ id: "p1", title: "Component map" }];
  const extra = "Memory is a past record: verify it against the code first.";

  it("adds the team's text after the built-in guide at session start and on refresh", () => {
    for (const out of [
      buildKnowledgePreamble(pages, { extra }),
      buildRosterRefresh(pages, { extra }),
    ]) {
      // Added, not replacing: the built-in triggers and crediting rule are still there.
      expect(out).toContain("CREDITING IS NOT OPTIONAL");
      expect(out.indexOf(extra)).toBeGreaterThan(out.indexOf("hindsight_ingest_document("));
    }
  });

  it("adds nothing when unset or blank", () => {
    expect(buildKnowledgePreamble(pages, { extra: "  " })).toBe(buildKnowledgePreamble(pages));
  });
});
