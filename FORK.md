# 本 fork 的维护方式（hz 版本线）

上游：[vectorize-io/hindsight](https://github.com/vectorize-io/hindsight)。本仓库是它的 fork，
只承载我们自用的改动，不向上游提 PR（#5429 之后不再跟进上游）。

## 版本号

```
v<上游版本>-hz.<序号>
```

例：`v1.1.0-hz.1` = 基于上游 v1.1.0 的我们的第 1 次发行。序号只在我们自己的发行上递增。

## 分支

| 分支 | 用途 |
|---|---|
| `main` | 上游镜像。只做 fast-forward 同步，不放自己的提交 |
| `hz/main` | 我们的发行线 = `main` + 本地改动。**tag 都打在这里** |

## 当前携带的改动（hz.1）

- 5 个只读 memory-chain 工具：`list_tags` / `read_memory` / `read_chunk` / `read_source` / `read_memory_chain`
- `listByTag` 补 `tags_match` 参数
- `getChunk` 拼接绝对 URL

前两项对应上游 #5428 / #5427（已由上游修复），第三项对应 #5429（**上游至今 open**，故本 fork 自用携带）。

## 升级流程

1. 在 GitHub 上 Sync fork（或 `POST /repos/MYCF711/hindsight/merge-upstream`），把 `main` 快进到上游最新
2. 本地：`git fetch && git checkout hz/main && git rebase main`
   冲突面固定在这 6 个文件：`hindsight-integrations/coding-agents/src/core/`
   （`hindsight.ts` / `inject.ts` / `knowledge-injection.ts` / `knowledge-tools.ts` 及两个 `.test.ts`）
3. 跑 `hindsight-integrations/coding-agents` 的测试（我们加了 39 个工具测试）
4. 打新 tag `v<新上游版本>-hz.<N+1>`，release 说明写清这次带了什么、上游合了哪些
5. 部署侧再更新构建产物（见下）

## 部署侧现状（重要）

`D:\DeepSeek Harness\vendor\hindsight` **目前不是**从本分支构建的：

- 它的 `.install-origin.json` 记录来源是 npm 缓存里的 `@vectorize-io/hindsight-coding-agents`，版本 **0.8.0**（2026-09-30 落的盘）
- 之后在本地对 `dist/dsh.js` **手工打了十几轮补丁**，备份链就是补丁日志：`dist/dsh.js.bak-before-*`
  （`chunkurl-fix` / `listtags` / `tagsmatch` / `injectfailretry` / `injectunchanged` / `guide-*` …），
  与 npm 0.8.0 相差约 967 行
- 因此本 fork 的 `hz/main` 是这批改动的**源码级归档**，vendor 里跑的仍是旧线 + 手补丁

把 vendor 切到本分支的构建产物是下一步工作，尚未执行。切换前需先核对上游 v1.1.0 已自行修复的部分
（如 #6053 把记忆块从 system 挪到 user message、#5514 长 prompt / 空召回注入），避免本地补丁与上游修法打架。
