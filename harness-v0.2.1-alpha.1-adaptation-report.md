# Harness v0.2.1-alpha.1 适配报告

## 概述

dsh-notion-mcp 已验证与 harness v0.2.1-alpha.1 兼容。**插件业务代码（`src/*.ts` 的运行期逻辑）无需修改**——
重新构建产出的 `lib/index.js` 与 0.2.0-rc.2 下入库的版本**逐字节相同**（`git status lib/` 为空）。

本次改动的实质是**依赖闭包的结构变化**，加上两处 README 里已经过时的开发约束说明。

## 版本信息

- **目标版本**: harness v0.2.1-alpha.1
- **验证用 harness**: 产品自带那份，`dsh-desktop/dist/desktop/dsh-linux-x64/resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js --version` → `0.2.1-alpha.1`（本次实跑确认）
- **配套依赖**（对齐产品 dist 的权威版本，逐字）:

  | 包 | 0.2.0-rc.2 | 0.2.1-alpha.1 |
  | --- | --- | --- |
  | `@deepseek-ai/dsh-*`（24 个） | `0.2.0-rc.2` | `0.2.1-alpha.1` |
  | `@deepseek-ai/cordis` | `4.0.4` | `4.0.5-alpha.1` |
  | `@deepseek-ai/cordis-plugin-loader` | `1.0.5` | `1.0.6-alpha.1` |
  | `@deepseek-ai/cosmokit` | `1.8.5` | `1.8.6-alpha.1` |
  | `@deepseek-ai/schemastery` | `3.18.4` | `3.18.5-alpha.1` |

  dist 内另有 `cordis-plugin-include@1.0.10-alpha.1`、`cordis-plugin-timer@1.1.7-alpha.1`（传递依赖，不入 devDeps）。

### 为什么必须钉精确版本（README 旧说法已失效）

旧 README 写「peer 链包含非公开包 `dsh-type-meta`，自动安装 peer 必然 404」。**这个理由在 0.2.1-alpha.1 已经不成立**——
本次实测 `grep -rl dsh-type-meta node_modules/.pnpm --include=package.json` 与 0.2.0-rc.2 的锁文件均为 0 命中，该包已从生态里彻底消失。
所以 README 改成了真正成立的理由：**自动安装 peer 会按浮动 range 解析，得到的版本与 harness 不一致**，而不是"会 404"。

同时实测了 registry 的 dist-tag 现状（重要，上一轮报告的说法已过时）：

```
@deepseek-ai/dsh-mcp-client: dist-tags {"latest":"0.0.1-rc.1","alpha":"0.2.1-alpha.1","next":"0.2.0-rc.2"}
@deepseek-ai/cordis:          dist-tags {"latest":"4.0.4","next":"4.0.1-rc.4","dsh-0-2-1-alpha-1":"4.0.5-alpha.1"}
@deepseek-ai/schemastery:     dist-tags {"latest":"3.18.4","next":"3.18.1-rc.4","dsh-0-2-1-alpha-1":"3.18.5-alpha.1"}
@deepseek-ai/dsh-invariants:  dist-tags {"latest":"0.0.1-rc.1","alpha":"0.1.7-alpha.2","next":"0.2.0-rc.2"}
```

- `dsh-*` 的 `0.2.1-alpha.1` 挂在 **`alpha`** tag 上，`next` 仍指向 `0.2.0-rc.2`；`cordis`/`schemastery` 系列挂在 **`dsh-0-2-1-alpha-1`** 专用 tag 上。
- 32 个 `@deepseek-ai/*` devDeps 全部实测可从 public registry 解析（`checked=32 problems=0`）。
- `dsh-invariants` **没有 `0.2.1-alpha.1`**（最后版本仍是 `0.2.0-rc.2`），见下节。

## 1. 依赖闭包的结构变化

### 移除 `@deepseek-ai/dsh-invariants`

该包在 0.2.0-rc.2 时被 10 个包 peer（`dsh-agent`、`dsh-commands`、`dsh-sandbox-policy`、`dsh-scope`、`dsh-storage-domain`、
`dsh-system-prompt`、`dsh-tools`、`dsh-user-approval`、`dsh-workspace`、`dsh-credentials`），是闭包里最大的一根横梁。
0.2.1-alpha.1 起**没有任何包再引用它**，且它自身没有 `0.2.1-alpha.1` 这个版本——继续留在 devDeps 里就只能钉在
0.2.0-rc.2，等于在闭包里混进一个异版本孤岛。故移除。

### 新增 7 个 peer

peer 闭包从 21 个包涨到 32 个（28 个 `dsh-*` + 4 个 cordis 家族）：

| 包 | 被谁要求 |
| --- | --- |
| `@deepseek-ai/dsh-mcp-resources` | `dsh-mcp-client`（0.2.0-rc.2 时不是 peer，本次新增） |
| `@deepseek-ai/dsh-session-persistence` | `dsh-session` |
| `@deepseek-ai/dsh-storage` | `dsh-session-persistence` / `dsh-base` |
| `@deepseek-ai/dsh-storage-domain` | `dsh-storage` |
| `@deepseek-ai/dsh-util-crypto` | `dsh-commands` |
| `@deepseek-ai/dsh-util-values` | `dsh-agent` / `dsh-mcp-client` |
| `@deepseek-ai/dsh-workspace` | `dsh-agent` |

`pnpm peers check` 从升级前的 5 条 `missing peer` 变为 **`No peer dependency issues found`**。

## 2. 插件 API 兼容性逐项核对

插件只用到这些 host API，全部逐条比对 dist 里 0.2.1-alpha.1 的真实 `.d.ts`：

| 插件用到的 API | 0.2.1-alpha.1 现状 | 结论 |
| --- | --- | --- |
| `ctx.plugin(mcpClient, { transport, serverName, url, headers, toolCallTimeoutMs, failOnStartupError })` | `Config` 仍是 `StdioConfig \| StreamableHttpConfig`；后者六个字段全必填，与插件传参逐字对齐；`apply(ctx, config): Promise<void>` 仍显式 async | ✅ 零改动 |
| `ctx.commands.register({ name, description, recordInput, handler: ({signal}) => … })` | `dsh-commands/lib/types/index.d.ts:63-67` 仍有 `declare module '@deepseek-ai/cordis'` 增强；`CommandInvocation.signal: AbortSignal`、`register(): () => void` | ✅ 零改动 |
| `parseCmdline(ctx, program)` | 签名仍为 `(ctx: Context, program: Command): void`；新增 `provideCmdline` / `exitOnStdinEnd` / `AppReady.onReady` 导出（不影响本插件） | ✅ 零改动 |
| `ctx.cmdlineArgs?.get()` / `ctx.appExit?.(code)` | 仍在 `dsh-cmdline` 的 `declare module` 增强里声明为可选 | ✅ 零改动 |
| `ctx.effect(() => disposer)` / `Fiber` | cordis 4.0.5-alpha.1 仍导出 `Fiber` | ✅ |
| `ctx.credentials.resolve/set/unset` + `credentialRef()` | `dsh-credentials@0.2.1-alpha.1` deps 收窄为 `{dsh-brand}`、peers 只剩 `cordis`，接口三方法未变 | ✅ |
| `cordis.patch.yml` 插入行 `name` | 须与 package.json `name` 逐字一致：`dsh-notion-mcp` = `dsh-notion-mcp` | ✅ |
| `peerDependencies: "*"` | 运行期用 `semver.satisfies(runtimeVersion, range, {includePrerelease:true})` 校验，`"*"` 恒真 | ✅ |

**没有任何一处使用 `as any` / 适配层 / fallback 去掩盖上游不兼容**——因为确实不存在不兼容。

## 3. 验证结果（本次真实运行）

### 静态门禁

```
tsc --noEmit          → exit 0
pnpm peers check      → No peer dependency issues found
vitest run            → Test Files 3 passed (3) / Tests 15 passed (15)
tsdown build          → lib/index.js 12.98 kB、lib/index.d.ts 0.60 kB，Build complete
                        git status lib/ 为空 ⇒ 产物与入库版本逐字节相同
```

### 隔离栈实跑

`node scripts/test-stack.mjs up`：

```
[test-stack] 副本已同步：…/tmp/dsh-notion-test-home
[test-stack] 插件软链已重写：…/profiles/web/node_modules/dsh-notion-mcp -> /home/kaixiang/dev/co-creation-project/dsh-notion
[test-stack] 清理断链：dsh-operation-improve / git / @Tinnikx/dsh-operation-improve
[test-stack] 清理了 3 个断链
[test-stack] profile manifest 已修正：仅保留内置 bundles + dsh-notion-mcp
[test-stack] harness 启动中：pid=870367 port=3182 DSH_HOME=…/tmp/dsh-notion-test-home
[test-stack] harness 就绪：http://127.0.0.1:3182/ 插件已加载=true

============================================================
测试栈就绪。验证结果：
  插件在名册中: ✅
  dsh.bundle 警告: ✅ 无警告
  harness URL: http://127.0.0.1:3182/
============================================================
```

`tmp/dsh-notion-stack/harness.log`（本次实跑全文，2 行）：

```
[dsh-notion-mcp] not authorized — run `dsh notion login`
dsh web: http://127.0.0.1:3182/?token=21RJeoimSE-_9p5ZUU2XqQUxCbL7iJJcu2FZK_YPoEg
```

`grep -inE "error|warn|fail|deprecat|invalid"` 对该日志 **0 命中**；`declares no dsh.bundle` /
`plugin tree failed to load` 同样 0 命中。

`status`（down 之后）：`harnessPid: null`、`harnessServing: false`、`hasBundleWarning: false`。

### `notion login` 子命令实跑（上一轮报告没验过的一项）

在隔离副本里建一个最小 profile，只挂 `@deepseek-ai/dsh-base` + 本插件，然后：

```
$ dsh --profile notion notion --help
Usage: program notion [options] [command]

Options:
  -h, --help      display help for command

Commands:
  login           Authorize Notion via the official MCP OAuth flow
  logout          Logout from Notion and uninstall MCP tools
  help [command]  display help for command
```

两个子命令都注册成功——`parseCmdline` 接管 CLI 的路径在 0.2.1-alpha.1 上完好。

```
$ dsh --profile notion notion login          # 45s 超时截断
[dsh-notion-mcp] open this URL to authorize Notion:
https://mcp.notion.com/authorize?response_type=code&client_id=-m-_i2m4MCItMGgO&
  redirect_uri=http%3A%2F%2F127.0.0.1%3A53007%2Fcallback&state=IgPlaW5bvlvYcxFi4WptBQ&
  code_challenge=7yTBfQEymQdnBSH8CYAyDlPJ2JkCHBjkZg_X8B8yTYI&code_challenge_method=S256
exit=124
```

OAuth 发现 → 动态客户端注册（拿到真实 `client_id`）→ PKCE `code_challenge` 生成 → 本地回调服务挂起等待，
整条链路都在跑。`exit=124` 是 `timeout 45` 主动截断，属预期——它在等浏览器回调。

### 顺带验证并修正了 README 的最小 profile 说明

上一轮报告把「README 方式 A 的最小 profile 不完整」标为未解决、且判断为上游问题。**本次实测证伪了这个判断**：

1. 手写只列 `dsh-notion-mcp` 一个 bundle 的 manifest → `notion (dsh-notion-mcp): pending (waiting for services: credentials, commands)`，
   插件不激活（符合上一轮记录）。
2. 补上 `@deepseek-ai/dsh-base` → 立刻正常，子命令全部注册。
3. 但 README 教用户走 `dsh plugin --profile notion add dsh-notion-mcp`，而 `dsh plugin add` **自己就会把
   `@deepseek-ai/dsh-base` 写进 bundles**：

```
$ dsh plugin --profile fresh add dsh-notion-mcp
dsh: initialized profile fresh at …/profiles/fresh
dependencies:
+ dsh-notion-mcp ^0.1.0
$ cat …/profiles/fresh/package.json
  "dependencies": { "dsh-notion-mcp": "^0.1.0" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-notion-mcp"] } }
```

结论：README 原写法是对的，上一轮那个「上游问题」的结论作废，本文档更正记录在此。

## 4. 未验证的部分

诚实标注，避免把"启动了"读成"全链路可用"：

- **真实 OAuth 端到端未跑完**：验到 authorize URL 打印 + 回调服务挂起，浏览器批准后的 `exchangeCode`
  与 token 落盘需要人工交互，无法自动化。
- **有效 token 下 `mcp__notion__*` 工具真正注册成功未验证**：同样需要一次真实授权。
- **`/notion-login` 对话框命令未实跑**：`ctx.commands.register` 本身已验证注册成功，但对话通道的实际调用未触发。
- **未在 headless / tui profile 上验证**：本次只在 `web` 与自建最小 profile 上验证。

## 5. 改动清单

| 文件 | 改动 |
| --- | --- |
| `package.json` | version `0.1.1` → `0.1.2`；devDependencies 25 项改版本 + 新增 7 个 peer + 移除 `dsh-invariants`（共 32 个 `@deepseek-ai/*`） |
| `pnpm-lock.yaml` | 随依赖升级重新生成 |
| `pnpm-workspace.yaml` | pnpm 自动追加 `minimumReleaseAgeExclude`（32 条 `pkg@version`）——这些版本刚发布，低于 `minimumReleaseAge` 门槛必须显式放行 |
| `README.md` / `README.en.md` | 已验证版本列表补 `v0.2.1-alpha.1`；改写 `autoInstallPeers` 那条约束的理由（`dsh-type-meta` 已不存在→ 换成"版本漂移"）；闭包规模 21 → 32；新增"必须钉精确版本、不能用 `\"*\"`"一条 |
| `scripts/test-stack.mjs` | 仅更新文件头注释里的目标 harness 版本表述（陈旧的 `v0.1.2-rc.1`）；逻辑零改动 |
| `lib/` | 重新构建后与入库产物逐字节相同，**无实际变更** |

## 6. 给下一轮适配的经验

- **先用 peer 闭包算子决定 devDeps 集合，别照抄上一版再逐个改**。本轮 `dsh-invariants` 的消失和 7 个新 peer
  都是从闭包实算里冒出来的，人工比对 peer 列表容易漏。
- **`grep 'dsh-type-meta'` 这类"历史结论"每轮都要重新验**。README 里上一轮写的理由在本轮已经不成立，
  但没人会去质疑一段看起来很笃定的文档。
- **验证要覆盖 CLI 路径而不只是 web 路径**。`parseCmdline` / `ctx.appExit` 这条链只在 `dsh ... notion login`
  下才走到，只验 web 启动等于漏掉一半代码路径。
- **`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 是自动生成的**，但它进了版本控制——下次适配
  要记得清理上一轮的条目，否则清单会无限膨胀。
