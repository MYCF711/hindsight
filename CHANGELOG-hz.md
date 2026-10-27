# hz 发行说明

本文件只记录**我们自己的发行**（版本号后缀 `-hz.N`）。上游改了什么看
[上游 releases](https://github.com/vectorize-io/hindsight/releases)。

版本号规则、分支职责、升级流程见 [FORK.md](FORK.md)。

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
