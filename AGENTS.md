# AGENTS.md — 维护 `hz` fork 的约定

> 给后续接手的 agent。读完这份 + [FORK.md](FORK.md) + [CHANGELOG-hz.md](CHANGELOG-hz.md)
> 就能独立维护，不必重新推导为什么这里和上游不一样。
>
> 上游项目的开发约定在 [CLAUDE.md](CLAUDE.md)（Python/TS 风格、测试要求、迁移脚本规范），
> 那份仍然适用；本文件只写 **fork 自己的规矩**。

---

## 一 · fork 的初衷（判断一切的基准）

**上游按「托管 API、面向大众、很可能收费」设计；我们跑的是「局域网里另一台机器上自建的服务端」。**
这两个前提不一样，默认值就不该一样。

| 维度 | 上游假设 | 本地现实 |
|---|---|---|
| 服务端可用性 | 要么在线要么挂掉（2 轮失败 = 判定） | 重启 / Wi-Fi 漫游 / 归并高峰 / 休眠唤醒都会超时，**是常态不是判决** |
| 延迟 | 云端推理，稳定 | 本机 GPU，归并时会抢占（实测重排 3522ms → 168ms 的优化就是为这个） |
| 数据 | 多租户、收费 | 单机库、7 万条级，随便折腾 |
| 升级节奏 | 跟随 release | 我们自己决定何时跟（`main` 随时可快进） |

**⇒ 凡是「上游为稳定性做的保守取舍」撞上「本地抖动」，一律向本地倾斜；
但尽量做成可覆盖的旋钮，而不是硬改默认行为** —— 见第三节。

## 二 · 分支与版本

- `main` = 上游镜像，**只做 fast-forward 同步，不放任何自己的提交**
- `hz/main` = 我们的发行线，tag 一律打在这里
- 版本号 `v<上游版本>-hz.<序号>`；上游版本取上游最新 release tag，序号我们自增
- 每个 hz 版本必须在 [CHANGELOG-hz.md](CHANGELOG-hz.md) 追加一节（新的在最上面），
  并在 GitHub Releases 发布对应说明
- **tag 一经发布不再移动**（移动会导致 release 断链、改不回来；要改就发 `hz.N+1`）

## 三 · 和上游有差异时怎么判断（核心规则）

按顺序过这三问，命中即定：

1. **这个差异能不能做成「可覆盖的默认值」？**
   能 → 就做成 `envTurns(...)` 那种形式：默认取本地最优，环境变量能改回上游值。
   这一类的目标是**提 PR 给上游**（上游拿去只是多一个旋钮，没有本地部署前提也能接受），
   提上去之后我们的维护面归零。
2. **这个差异是不是纯粹因为「本地部署」才成立？**
   是（例如 `recency-rerank` 针对本机 GPU 与归并抢占的调优、memory-chain 工具）
   → 留在 fork，不硬提上游；在 CHANGELOG 和这里写清「为什么上游不需要它」。
3. **上游是不是已经用自己的方式修了同一件事？**
   → 先读上游实现再决定，**不要默认自己的补丁更好**。实测例子：
   上游 0.8.2 的 `resolveInjection` 已用 `HOOK_INJECT_EMPTY_ATTEMPTS` / `HOOK_INJECT_ATTEMPTS`
   处理了 #4607 / #5082，覆盖了本 fork 早期 `emptyStreak` / `failStreak` 补丁要解决的问题；
   差别只在**预算数值**（上游 2/5，本地要 8），所以正确做法是保留上游结构、只把数值做成可配，
   而不是把整个 `failStreak` 状态机搬回来。

## 四 · 当前携带的差异（维护清单）

| 差异 | 位置 | 动机 | 可覆盖 |
|---|---|---|---|
| 注入失败预算 8（上游 2） | `src/core/hook.ts` `HOOK_INJECT_ATTEMPTS` | 本地超时是常态 | `HINDSIGHT_INJECT_FAIL_ATTEMPTS` |
| 空召回预算 8（上游 5） | `src/core/hook.ts` `HOOK_INJECT_EMPTY_ATTEMPTS` | 同上 | `HINDSIGHT_INJECT_EMPTY_ATTEMPTS` |
| 5 个 memory-chain 只读工具 | `src/core/knowledge-tools.ts` | 上游 #5429 未合，走链查原文要用 | — |
| `tags_match` 参数 | `src/core/hindsight.ts` | 上游 #5428 | — |
| getChunk 绝对 URL | `src/core/hindsight.ts` | 上游 #5427 | — |
| 时效重排 | `src/core/recency-rerank.ts`（**不在仓库里，见第五节**） | 本地库的更正类记忆需要时效权重 | `HINDSIGHT_RECENCY_RERANK` |
| 注入指南压缩 | `src/core/knowledge-injection.ts` | 注入块里工具说明占比过高 | — |

改动差异时**必须同时更新这张表和 CHANGELOG**。

## 五 · 构建（每次换 vendor 都要照做）

```bash
cd hindsight-integrations/coding-agents
npm ci                                 # package-lock 已把 zod 钉在 4.4.3；别的版本会多出 181 个 zod 函数
cp <本地>/recency-rerank.ts      src/core/     # ⚠ 见下
cp <本地>/recency-rerank.test.ts src/core/
npm run build                          # tsup → dist/dsh.js
```

⚠ **`src/core/recency-rerank.ts` 不在本仓库里**，但 `src/core/hindsight.ts` 会 import 它。
来源：`D:\主工作区\记忆系统-局域网方案\fork\client-build\src\core\recency-rerank.ts`。
不拷进来就报 `Could not resolve "./recency-rerank"`。
（历史原因：该特性先落在本机构建树里，迁进仓库这步没做完。补齐它是待办。）

构建后自检：

```bash
node --input-type=module -e "import('file:///<abs>/dist/dsh.js').then(m=>console.log(Object.keys(m)))"
# 期望 9 个导出：apply, createDshHooks, default, dshSessionEvents, inject,
#               lastInjectedText, name, ownEvents, toDshParameters
```

## 六 · 部署侧（DSH 的 vendor）

DSH 实际加载的是 `D:\DeepSeek Harness\vendor\hindsight\dist\dsh.js`，**不是 npm 包**；
`.install-origin.json` 记录它从哪来。

换版本：

1. 备份整个 `vendor/hindsight` 到 `D:\DeepSeek Harness\_plugin-backups\hindsight-before-hz-<日期>`
2. `cp -r dist/. <vendor>/hindsight/dist/`（保留历史 `.bak` 不动）
3. 改写 `.install-origin.json`（source / commit / tag / rollback）
4. **重启 DSH 才生效**（已加载模块在内存里）

回滚：`rm -rf vendor/hindsight && cp -r <备份> vendor/hindsight`。

## 七 · 配置面与 GUI（待办方向）

现状：旋钮分两处 —— 宿主插件读 `~/.hindsight/coding-agent.json`（手改 + 重启）；
本插件自己的 `HINDSIGHT_*` 在宿主进程的环境变量里读。

已知旋钮：`apiUrl` / `apiToken` / `autoInject` / `recallOptions.{types,budget,max_tokens,min_scores}`
/ `pageRefreshEveryTurns` / 第四节列出的全部 `HINDSIGHT_*`。

**方向**：做成可视化调节（DSH 设置页卡片，注册 `settings.plugins.tab`），而不是让用户改 JSON
和环境变量。做出来之后，「本地默认值」就不再是硬编码的分歧，而是**用户可调的默认值** ——
这时提上游 PR 的接受度也最高。
（注意：DSH 的 `settingsScope` / `settings.plugin.item` 契约在 0.1.7 之后已移除，
第三方设置卡片要用 `settings.plugins.tab`。）

## 八 · 不要做的事

- 不要往 `main` 提交（它要能 fast-forward；提交会让下次 sync 变成 merge）
- 不要在 `dist/dsh.js` 上手改（那正是 fork 要消灭的做法：一次 `npm run build` 就静默抹掉全部补丁）
- 不要搬回「上游已修」的补丁，先读上游实现（第三节第 3 问）
- 不要在没跑构建自检、没备份 vendor 的情况下替换部署产物
