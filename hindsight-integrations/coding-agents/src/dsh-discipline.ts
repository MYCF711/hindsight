/**
 * `hindsight:discipline` —— DSH system-prompt section。
 *
 * 为什么放在插件本体而不是宿主配置：
 *   DSH 的 system prompt 只接受「拥有事实的插件」注册段 ——
 *   `dsh-system-prompt/README.zh.md` 逐字：「其他段来自拥有相应事实的插件。
 *   不存在终端用户提示词编辑 API。」记忆使用纪律的事实拥有者是 Hindsight 插件，
 *   所以由本插件在 `apply` 里注册，而不是由用户手写进 persona。
 *
 * 位置：order = Number.MAX_SAFE_INTEGER - 1，落在 system 段最末（recency 最高），
 * 与 dsh-sovereign 的 `sovereign:clause` 同权重、按名字排序（h 在 s 前）。
 *
 * 成本：约 1,200 字符 / 约 350 token，每轮重复。
 */
export const DISCIPLINE_SECTION_NAME = "hindsight:discipline";
export const DISCIPLINE_SECTION_ORDER = Number.MAX_SAFE_INTEGER - 1;

export const DISCIPLINE = `<hindsight_discipline>
本工作区有**持久记忆库**（Hindsight）。它保存了这个仓库过去的决策、约定与踩过的坑。
你**必须**主动检索它，而不是凭印象作答 —— 尤其在下列时刻，检索**优先于**你的第一反应：

- 用户报告 bug、说「不对」「又坏了」→ 先查该问题是否已有定论或根因记录
- 用户问「为什么这样设计」「还剩什么没做」→ 先查，别重新推导
- 你要改测试、写新代码、动配置 → 先查本项目的约定与既往决策
- **你自己干活时遇到似曾相识的问题** → 先查，别从零再撞一遍

工具（按此顺序用，别自己发明）：
- 检索：\`hindsight_search_knowledge_pages(query)\` → \`hindsight_read_knowledge_page(<id>)\` → 页面太浅才 \`hindsight_reflect(query)\`
- 原始层：知识页是**摘要**，要核对原文用 \`hindsight_read_memory\` / \`hindsight_read_chunk\` / \`hindsight_read_source\`（\`src=Y\` 的行可追到原文）；按家族读全用 \`hindsight_list_tags\` / \`hindsight_read_memory_chain\`
- 写入：\`hindsight_ingest_document(title, content)\` / \`hindsight_capture_initiative\`
- 诊断：\`hindsight_diagnose\` / \`hindsight_sync_status\`

三条反模式：
1. 不要手动解析 asar / 读二进制 / grep 磁盘去找「DSH 有哪些 slot、某包管什么」—— 先搜知识页。
2. 记忆库的状态、内容、写入 —— 一律走这些工具；工具的报错原文就是全部事实。不要用 ping/curl/端口探测判断死活（实测过旁路探测给错结论而工具正常）。
3. 一次取不到 ≠ 记忆库坏了（云端、偶发延迟、自动恢复）；知识页可能属于别的项目，没命中就换关键词再搜。

写记忆之前先判落点：会持续增长（踩坑/决策理由/根因/领域知识/现状快照）→ \`hindsight_ingest_document\`；一成不变（目录/端口/绝对禁令）→ AGENTS.md 且极短。发现库里某条是错的，写「Correction: <主题>」作废旧说法。

⚠ 自动注入的记忆可能因故障而缺失或不全。**工具始终可用** ——
注入为空时更要主动检索，不要因此假定「这个项目没有相关记忆」。
⚠ 检索到的内容是**过去的记录**：若与当前代码冲突，以代码为准；并**纠正记忆库**。
</hindsight_discipline>`;

/** DSH 的 systemPrompt 服务（Cordis）在本插件里用到的最小结构。 */
export interface DshSystemPromptContext {
  systemPrompt: {
    section(options: { name: string; order: number; text: string }): (() => void) | void;
  };
}

/**
 * 注册纪律段。幂等：同名 section 已存在时静默跳过（例如本地补丁层已注册）。
 */
export function registerDisciplineSection(ctx: DshSystemPromptContext): void {
  try {
    ctx.systemPrompt.section({
      name: DISCIPLINE_SECTION_NAME,
      order: DISCIPLINE_SECTION_ORDER,
      text: DISCIPLINE,
    });
  } catch {
    // 已注册 —— 不炸。
  }
}
