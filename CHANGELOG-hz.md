# hz 发行说明

本文件只记录**我们自己的发行**（版本号后缀 `-hz.N`）。上游改了什么看
[上游 releases](https://github.com/vectorize-io/hindsight/releases)。

版本号规则、分支职责、升级流程见 [FORK.md](FORK.md)。

---

## v1.1.0-hz.3 — 2026-10-28

**基点**：同 hz.2（上游 `main@1e3a4841`）。

**新增**

- **DSH 记忆纪律段**（`hindsight-integrations/coding-agents/src/dsh-discipline.ts` + `src/dsh.ts` 接线）：
  - 注册 `hindsight:discipline` system prompt section，`order = Number.MAX_SAFE_INTEGER - 1`
    （system 段末尾，recency 最高；与 `sovereign:clause` 同权重、按名字排序）
  - 内容约 1,200 字符：三条反模式（不手动解析 asar / 状态与写入一律走工具 / 一次取不到 ≠ 坏了）
    + 13 工具全表（含原始层 `read_memory` / `read_chunk` / `read_source`）
    + 「知识页是摘要，核对原文用 read_chunk」+「写记忆之前先判落点」
  - 与 `LocalMemory/plugin/hindsight-client/hindsight-discipline.js`（本机补丁层）同源；
    本 fork 构建产物生效后，该本地补丁层应删除，避免两份同名 section

**验证**

- TypeScript 类型改动：`DshContext.inject` 改为泛型 `inject<T = DshToolContext>`，调用处显式传 `DshSystemPromptContext`
- 未构建/未替换 `vendor/hindsight`（当前 vendor 仍是旧线 + 手补丁；见 FORK.md「部署侧现状」）

**部署状态**

- 仅源码提交；构建与 vendor 替换留待下一次升级（按 FORK.md 流程）

---

## v1.1.0-hz.2 — 2026-10-28

**基点**：同 hz.1（上游 `main@1e3a4841`）。

**新增**

- **注入预算可配，并把默认值调到自建服务端的量级**（`src/core/hook.ts`）：
  - `HINDSIGHT_INJECT_FAIL_ATTEMPTS` —— 注入失败（超时 / 5xx）可重试的轮数，**默认 8**（上游 2）
  - `HINDSIGHT_INJECT_EMPTY_ATTEMPTS` —— 空召回可重试的轮数，**默认 8**（上游 5）
  - 两者都设 `0` 即关闭重试；想回到上游行为就设成 2 / 5
- 新增 `envTurns()` helper，统一「环境变量取非负整数、非法值回落默认」的读法

**为什么不直接把旧补丁搬回来**

hz.1 之前本机有一份 `failStreak` 补丁（12 处引用、自带状态持久化）。核对上游 0.8.2 后发现
它已经用 `resolveInjection` 覆盖了同一缺陷（`got === undefined` 无预算，即 #4607 / #5082），
差别只在**数值**：上游给托管 API 定 2 轮，本地自建服务端超时是常态，需要 8 轮。
所以 hz.2 保留上游的结构与语义，只把数值改成可覆盖的 —— 维护面比搬回状态机小得多，
而且这个改动上游也能直接收。

**文档**

- `README.md` 顶部写明 fork 初衷（本地自建服务端 vs 托管 API）与差异表
- `AGENTS.md` 重写为维护手册：分支模型、差异判断三问、当前差异清单、构建步骤、部署与回滚、GUI 方向
- `FORK.md` 保留（版本规则 + 升级流程）

**上游状态**

- 本节的两处差异属于「上游也能收的可配项」，可作为 PR 提交；提交后本 fork 该项维护面归零。
- #5429（memory-chain 工具）仍 open，继续由本 fork 携带。

**部署状态**

- 已构建并替换 `D:\DeepSeek Harness\vendor\hindsight\dist`（776,302 B），**需重启 DSH 生效**
- 回滚点：`D:\DeepSeek Harness\_plugin-backups\hindsight-before-hz-20261028`

**验证**

- 构建产物含两个新环境变量，默认值均为 8（grep 逐个核对）
- `import()` 冒烟通过，导出 9 项与上游一致

---

## v1.1.0-hz.1 — 2026-10-28

**基点**：上游 `v1.1.0`（2026-10-21 发）之后的 `main` — `1e3a4841`（2026-10-27）。
上游最新 tag 就是 v1.1.0，`main` 在此之上还有 6 个未发版提交，本发行包含它们。

**新增**

- 5 个只读 memory-chain 工具（上游 issue #5429）：
  - `hindsight_list_tags` — 列出本 bank 里**实际存在**的 tag 及各自承载条数，用来发现没法靠猜的族名（例如 `story:<sessionId>` 的 uuid）
  - `hindsight_read_memory` — 按 id 读一条记忆的完整字段：entities、`occurred_start/end`、`document_id`、`chunk_id`、ingest 时写入的原始 metadata
  - `hindsight_read_chunk` — 读一条记忆被抽取前的**逐字原文**（recall 返回的只是改写过的摘要，摘要可以丢限定词，只有原文能判定它有没有歪）
  - `hindsight_read_source` — 自动跟随 consolidation 那一跳，读任意一行（含合并出来的 observation）背后的原文
  - `hindsight_read_memory_chain` — 按 tag 读**整族**记忆，而不是 recall 只给排名靠前的几条（实测：recall 给 5 条，按 tag 能取到 24 条，其中第 70 名那条才是决定性的）
- 39 个工具测试，覆盖 `tags_match` 行为、ledger guard、指引完整性

**修复**

- `listByTag` 从不发送 `tags_match` 参数，导致按 tag 检索静默退化（上游 #5428，已由上游修复）
- `getChunk` 拼的是相对 URL（上游 #5427，已由上游修复）

**上游状态**

- #5427、#5428：已由上游修复。
- **#5429（memory-chain 工具）：至今 open**。本项目不再向上游提 PR 或跟进，故本 fork 自用携带。

**验证**

- 3-way merge 到 v1.1.0 之后的 `main`，6 个文件全部 cleanly，**零冲突**
- 冲突面固定：`hindsight-integrations/coding-agents/src/core/`
  （`hindsight.ts` / `inject.ts` / `knowledge-injection.ts` / `knowledge-tools.ts` + 两个 `.test.ts`）

**部署状态**

- DSH 的 `vendor/hindsight` **尚未**切到本发行 —— 它仍是 npm `@vectorize-io/hindsight-coding-agents`
  **0.8.0** 的拷贝 + 本地 17 轮 `dist/dsh.js` 手工补丁（与 0.8.0 差约 967 行）
- 切换前必须先核对上游 #6053（记忆块从 system 挪进 user message）、#5514（长 prompt / 空召回注入）
  与本地的 `injectfailretry` / `injectunchanged` / `guide-*` 补丁是否打架

---

<!--
下次发版的模板，照抄这一段到最上面（新的在上）：

## v<上游版本>-hz.<N> — <YYYY-MM-DD>

**基点**：上游 `<tag>`（<发布日期>）之后的 `main` — `<sha>`（<日期>）

**新增**
-

**修复**
-

**移除**
-

**上游状态**
-

**验证**
-

**部署状态**
-
-->
