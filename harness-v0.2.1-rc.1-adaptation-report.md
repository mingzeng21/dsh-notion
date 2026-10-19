# Harness v0.2.1-rc.1 适配报告

## 概述

dsh-notion-mcp 已验证与 harness v0.2.1-rc.1 兼容。**插件业务代码（`src/*.ts`）零改动**——重新构建产出的 `lib/index.js`、`lib/index.d.ts` 与 0.1.2 入库版本逐字节相同（构建后 `git status lib/` 为空）。

本轮的实质变化在依赖闭包：30 个 `dsh-*` 与 4 个 cordis 家族包全部抬到 rc.1 对应的版本；`dsh-tools` 在 rc.1 新增了一个**必填** peer `dsh-working-directory`（它又要求 `dsh-fs`），闭包因此从 32 个涨到 **34 个** `@deepseek-ai/*`。

## 版本信息

- **目标版本**：harness v0.2.1-rc.1
- **验证用 harness**：产品自带那份，`dsh-desktop/dist/desktop/dsh-linux-x64/resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js --version` → `0.2.1-rc.1`（实跑确认；与三方 `package.json` 一致）
- **配套依赖**（逐字对齐产品 dist）：

  | 包 | 0.2.1-alpha.1 | 0.2.1-rc.1 |
  | --- | --- | --- |
  | `@deepseek-ai/dsh-*`（30 个） | `0.2.1-alpha.1` | `0.2.1-rc.1` |
  | `@deepseek-ai/cordis` | `4.0.5-alpha.1` | `4.0.5` |
  | `@deepseek-ai/cordis-plugin-loader` | `1.0.6-alpha.1` | `1.0.6` |
  | `@deepseek-ai/cosmokit` | `1.8.6-alpha.1` | `1.8.6` |
  | `@deepseek-ai/schemastery` | `3.18.5-alpha.1` | `3.18.5` |

  四个 cordis 家族包在 rc.1 走出了 prerelease：dist 里就是无后缀的 `4.0.5` / `1.0.6` / `1.8.6` / `3.18.5`，devDeps 必须跟着去掉 `-alpha.1`，否则锁文件会装出与产品不一致的副本。

### registry 现状（本轮实测）

```
@deepseek-ai/dsh-mcp-client   dist-tags {"latest":"0.0.1-rc.1","alpha":"0.2.1-alpha.5","next":"0.2.1-rc.2"}
@deepseek-ai/dsh-working-directory {"latest":"0.2.1-alpha.2","alpha":"0.2.1-alpha.5","next":"0.2.1-rc.2"}
@deepseek-ai/cordis           {"latest":"4.0.5","next":"4.0.1-rc.4", ...}
@deepseek-ai/schemastery      {"latest":"3.18.5", ...}
```

`next` 已经指到 **rc.2**，而产品 dist 仍是 rc.1——这正是不用 `"*"`、不跟 tag 的理由：精确版本 `0.2.1-rc.1` 与 `4.0.5` / `1.0.6` / `1.8.6` / `3.18.5` 逐个实测仍可解析（`npm view <pkg>@<version> version` 全部命中）。

## 1. 依赖闭包的结构变化

### 新增 2 个必填 peer

`dsh-tools@0.2.1-rc.1` 的 `peerDependencies` 比 alpha.1 多出 `@deepseek-ai/dsh-working-directory@0.2.1-rc.1`，且**没有** `optional` 标记；后者又要求 `@deepseek-ai/dsh-fs@0.2.1-rc.1`。按 README 的闭包不变量（`autoInstallPeers: false`，peer 必须显式列出），两者都进 devDependencies：

| 包 | 被谁要求 | optional? |
| --- | --- | --- |
| `@deepseek-ai/dsh-working-directory` | `dsh-tools` | 否 |
| `@deepseek-ai/dsh-fs` | `dsh-working-directory` | 否 |

`cordis` 的 `cordis-plugin-include`、`cordis-plugin-loader` 的 `node-addon-require-builtin` 仍是 **optional** peer，沿用上一轮口径不入 devDeps。

`pnpm peers check` → `No peer dependency issues found`。

### 30 个 dsh-* 的版本抬升

除上述两枚新包，原有 32 个 `@deepseek-ai/*` 全部改到 rc.1 对应版本；`pnpm install` 后逐个与 dist 的 `package.json` 比对：**34/34 完全一致**（脚本同时核对 `specifier` 与 `installed`）。`pnpm-lock.yaml` 随之重生成，`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 清掉旧条目、只保留本轮 34 条。

## 2. 插件 API 兼容性逐项核对

逐包对读「仓库 node_modules 里 alpha.1 的产物」与「dist 里 rc.1 的产物」（`diff -rq` + 声明文件）：

| 插件用到的 API | rc.1 现状 | 结论 |
| --- | --- | --- |
| `ctx.plugin(mcpClient, { transport, serverName, url, headers, toolCallTimeoutMs, failOnStartupError })` | `dsh-mcp-client/lib/**` 与 alpha.1 **逐字节相同**（`diff -rq` 零输出）；Config 的 `StreamableHttpConfig` 六字段未变 | ✅ 零改动 |
| `ctx.commands.register({ name, description, recordInput, handler })` | `lib/types/index.d.ts` 与 alpha.1 相同；只有生成的 `typert.remote-client.d.ts` 从 `TypertRemoteContribution` 换成 `TypertRemoteInfo`/`TypertRemoteMethod`（typert 协议面，不影响 Host 侧 `register`） | ✅ 零改动 |
| `parseCmdline(ctx, program)` / `ctx.cmdlineArgs` / `ctx.appExit` | `dsh-cmdline/lib` 与 alpha.1 相同 | ✅ 零改动 |
| `ctx.effect(() => disposer)` / `Fiber` | `cordis/lib` 与 `4.0.5-alpha.1` 相同，只有 `package.json` 的版本号变化 | ✅ 零改动 |
| `ctx.credentials.resolve/set/unset` + `credentialRef('NOTION_OAUTH')` | 签名未变；**语义有变**：存储层现在优先于环境 / `.env`，`set` 不再因「环境里有同名变量」而拒绝，`unset` 之后环境层会重新生效 | ✅ 代码无需改；行为记录在下面 |
| `cordis.patch.yml` 插入行 `name` | `dsh-notion-mcp` 与 `package.json` 的 `name` 逐字一致 | ✅ |
| `peerDependencies: "*"` | 运行期 `semver.satisfies(..., {includePrerelease:true})`，`"*"` 恒真 | ✅ |

### credentials 语义变化对本插件的影响

rc.1 的 `dsh-credentials-local` 写明优先级 `$DSH_HOME/.credentials.yaml` > 进程环境 > `.env`，并说明「用户在产品里显式保存的凭据必须稳定生效」。对 NOTION_OAUTH 的含义：用户在设置里保存的 token 会压过程序环境里的同名变量；`dsh notion login` 写入的新 token 也一定生效。本插件的 `NotionTokenStore` 只做单条 JSON 的 `set/unset/resolve`，不依赖旧的「被环境遮蔽时拒绝写入」行为，故无改动。

未使用任何 `as any`、适配层、fallback 或版本探测来掩盖差异——逐包对读显示不存在差异。

## 3. 验证结果（本次真实运行）

### 静态门禁

```
node -e …（34 个 @deepseek-ai/* 与 dist 逐一比对）→ all 34 match dist
tsc --noEmit                                        → exit 0
pnpm peers check                                    → No peer dependency issues found
vitest run                                          → Test Files 3 passed (3) / Tests 15 passed (15)
tsdown build                                        → lib/index.js 12.98 kB、lib/index.d.ts 0.60 kB，Build complete
                                                      git status lib/ 为空 ⇒ 产物与入库版本逐字节相同
```

### 隔离栈实跑（web profile）

`PATH=$HOME/.dsh/desktop-bin/node-shim:$PATH pnpm stack:up`：

```
[test-stack] 副本已同步：…/tmp/dsh-notion-test-home
[test-stack] 插件软链已重写：…/profiles/web/node_modules/dsh-notion-mcp -> /home/kaixiang/dev/co-creation-project/dsh-notion
[test-stack] 清理断链：dsh-operation-improve / git / @Tinnikx/dsh-operation-improve
[test-stack] 清理了 3 个断链
[test-stack] profile manifest 已修正：仅保留内置 bundles + dsh-notion-mcp
[test-stack] harness 启动中：pid=1120546 port=3182 DSH_HOME=…/tmp/dsh-notion-test-home
[test-stack] harness 就绪：http://127.0.0.1:3182/ 插件已加载=true

============================================================
测试栈就绪。验证结果：
  插件在名册中: ✅
  dsh.bundle 警告: ✅ 无警告
============================================================
```

`tmp/dsh-notion-stack/harness.log`（本次实跑全文，2 行）：

```
[dsh-notion-mcp] not authorized — run `dsh notion login`
dsh web: http://127.0.0.1:3182/?token=…
```

- `插件已加载=true` 的判据是日志出现 `[dsh-notion-mcp]`：纯 host 插件不出现在 `__DSH_BOOT__` 的 client entries 里。
- 该行同时证明 rc.1 下 `ctx.credentials.resolve(credentialRef('NOTION_OAUTH'))` 正常返回 `undefined`（副本不含凭据）。
- `declares no dsh.bundle` / `plugin tree failed to load` / `ERR_MODULE_NOT_FOUND` 均 **0 命中**——34 个包的闭包在 harness 的 `link:` 解析下完整。
- `pnpm stack:status` 如实报 `harnessServing: true`；`pnpm stack:down` → `harness: 已停（pid 1120546）`。

### CLI 路径（`parseCmdline` / `appExit` 那条链）

在副本里建最小 profile（只挂 `@deepseek-ai/dsh-base` + 本插件），用 dist 的 rc.1 二进制跑：

```
$ dsh --profile notion notion --help
Usage: program notion [options] [command]

Options:
  -h, --help      display help for command

Commands:
  login           Authorize Notion via the official MCP OAuth flow
  logout          Logout from Notion and uninstall MCP tools
  help [command]  display help for command
exit=0
```

两个子命令都注册成功，`parseCmdline` 在不带 UI 的 profile 上完好。

### 存储 token 的启动路径（刷新链路）

往副本的 `.credentials.yaml` 写一条**过期假 token**（`version: 1` / `refs.NOTION_OAUTH`），再用同一个 rc.1 二进制起 web profile：

```
Error: refresh failed: HTTP 401
    at refreshAccessToken (file:///…/lib/index.js:132:21)
    at async refreshAndMount (file:///…/lib/index.js:231:11)
    at async file:///…/lib/index.js:370:4
dsh web: http://127.0.0.1:3182/?token=…
```

这条读数同时证明：存储层里的 JSON 被 `resolve` 读出 → `store.load()` 解析成功 → OAuth 发现与 refresh 请求真的发出（假 token 被 Notion 以 401 拒绝）→ 失败后按设计进入重试调度，harness 本身照常就绪。验证后已删除该假凭据，副本不留残余。

## 4. 未验证的部分

诚实标注，不把「启动了」读成「全链路可用」：

- **真实 OAuth 端到端未跑完**：浏览器批准后的 `exchangeCode` 与 token 落盘需要人工交互，无法自动化。
- **有效 token 下 `mcp__notion__*` 工具真正注册成功未验证**：同样需要一次真实授权。
- **`/notion-login` 对话框命令未实跑**：`ctx.commands.register` 已随 web 启动执行，但对话通道未触发。
- **未在 headless / tui profile 上验证**：本轮只跑 `web` 与自建最小 profile。

## 5. 改动清单

| 文件 | 改动 |
| --- | --- |
| `package.json` | version `0.1.2` → `0.1.3`；原有 36 个 devDependencies 中的 `@deepseek-ai/*` 抬到 rc.1 对应版本；新增 `dsh-fs`、`dsh-working-directory`（共 34 个 `@deepseek-ai/*`） |
| `pnpm-lock.yaml` | `pnpm install` 重新生成 |
| `pnpm-workspace.yaml` | `minimumReleaseAgeExclude` 换成 rc.1 的 34 条，旧 alpha.1 条目清零 |
| `README.md` / `README.en.md` | 已验证版本补 `v0.2.1-rc.1`（并把 `v0.2.1-alpha.1` 移入「更早验证过」列表）；闭包规模 32 → 34，注明 rc.1 新增的两个必填 peer |
| `lib/` | 重新构建后与入库产物逐字节相同，**无实际变更** |
| `scripts/test-stack.mjs` | 无改动（逻辑与端口在 rc.1 上直接可用） |

## 6. 给下一轮适配的经验

- **peer 闭包要实算，不要照抄上一版**：rc.1 唯一的结构性变化就是 `dsh-tools` 新增一个非 optional 的 peer，人工读 release notes 很容易漏；从 dist 的 `package.json` 做闭包遍历能一次抓全。
- **cordis 家族包会「毕业」**：`-alpha.1` 到无后缀不是格式问题，dist 里就是 release 版本；照抄旧 specifier 会让锁文件与产品不一致。
- **registry 的 `next` 可能已经跑在 dist 前面**（本轮 `next` = rc.2、dist = rc.1）：只要精确版本仍可解析，就按 dist 钉，不跟 tag。
- **credentials 层的语义变化值得单独记一笔**：本轮它从「环境遮蔽时拒绝写」变成「存储层优先」，适配时容易误判为 API 不兼容，实际签名没动。
