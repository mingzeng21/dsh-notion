# Harness v0.2.0-rc.2 适配报告

## 概述

dsh-notion-mcp 已验证与 harness v0.2.0-rc.2 兼容。**插件业务代码（`src/*.ts` 的运行期逻辑）无需修改**，
但仓库侧有三处必须跟进：devDependencies 升级、`tsc --noEmit` 的类型图修复、测试栈就绪检测 bug。

## 版本信息

- **目标版本**: harness v0.2.0-rc.2
- **验证用 harness**: 产品自带那份，`dsh-desktop/dist/desktop/dsh-linux-x64/resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js --version` → `0.2.0-rc.2`
- **配套依赖**（对齐产品 dist 的权威版本）:
  - `@deepseek-ai/dsh-*`：`0.0.1-rc.1` → `0.2.0-rc.2`（agent/typert-protocol 原为 `0.1.0-rc.6`）
  - `@deepseek-ai/cordis`: `4.0.2` → `4.0.4`
  - `@deepseek-ai/schemastery`: `3.18.2` → `3.18.4`
  - `@deepseek-ai/cordis-plugin-loader`: `1.0.3` → `1.0.5`
  - `@deepseek-ai/cosmokit`: `1.8.3` → `1.8.5`

### 为什么必须钉版本而不能用 `"*"`

npm 上 `@deepseek-ai/dsh-*` 的 `latest` tag 仍停在 `0.0.1-rc.1`，`0.2.0-rc.2` 只挂在 `next` tag 上。
`"*"` 这个 range 在 `includePrerelease` 语义下解析到 `latest`，装不出 0.2.0-rc.2。
因此 devDependencies 从 `"*"` 改为**精确版本**，与产品 dist 逐字对齐——这同时让 `pnpm-lock.yaml`
成为"我们验证过的那组版本"的唯一真相，而不是随时会漂的浮动 range。

## 1. 依赖升级

devDependencies 全量钉到上表版本。相对上一版的两处结构变化：

**新增 `@deepseek-ai/dsh-commands`**。0.2.0-rc.2 起 `ctx.commands` 的类型由这个包提供
（见第 2 节），同时它是 `mcp__notion__*` 工具的注册路径所需。

**移除 `@deepseek-ai/dsh-code-runtime`**。该包最后版本是 `0.1.5-rc.3`，没有 0.2.0-rc.2；
且它只贡献 `ctx.codeRuntime` 的类型增强，本插件源码零引用
（`grep -rn code-runtime src/ tests/ scripts/` 无命中）。它此前只是 peer 闭包里的搭车项。

**补齐 5 个新 peer**，保持 README.md:129 要求的"完整闭包"不变量：

| 包 | 被谁要求 |
| --- | --- |
| `@deepseek-ai/dsh-session-projection` | `dsh-agent` |
| `@deepseek-ai/dsh-http-proxy` | `dsh-subprocess` |
| `@deepseek-ai/dsh-ptc-runtime` | `dsh-tools` |
| `@deepseek-ai/dsh-sandbox` | `dsh-tools` |
| `@deepseek-ai/dsh-sandbox-policy` | `dsh-tools` |

`pnpm peers check` 从 5 条 `missing peer` 变为 `No peer dependency issues found`。

## 2. `tsc --noEmit` 4 处报错（非本次引入，但本次修掉）

自 `1c21014` 起 `typecheck` 就失败，只是没人跑：

```
src/index.ts(156,7): error TS2339: Property 'commands' does not exist on type 'Context'.
src/index.ts(160,17): error TS7031: Binding element 'signal' implicitly has an 'any' type.
src/index.ts(169,7): error TS2339: Property 'commands' does not exist on type 'Context'.
src/index.ts(173,17): error TS7031: Binding element 'signal' implicitly has an 'any' type.
```

**根因不是版本不兼容，是类型图缺一个入口。** 插件 `inject` 了 `commands` service，
`ctx.commands.register(...)` 完全合法；但 `@deepseek-ai/dsh-commands` 的
`lib/types/index.d.ts:63-67` 通过 `declare module '@deepseek-ai/cordis'` 增强 `Context`，
而 TypeScript 只加载**被 import 到**的 `.d.ts`。`src/index.ts` 从未 import 过这个包，
`tsconfig.json` 也没有 `types` 字段兜底，于是增强进不了编译程序集 —— `ctx.commands` 不存在，
`handler: ({ signal })` 的 `signal` 顺带退化成隐式 `any`。

**修法**（`src/index.ts:7-9`）：

```ts
// 类型侧：把 dsh-commands 的 `declare module '@deepseek-ai/cordis'` 增强拉进本程序的类型图，
// 否则 ctx.commands / CommandDefinition 在 tsc 下不可见（运行期由 harness 提供该 service）。
import type {} from '@deepseek-ai/dsh-commands'
```

用 `import type {}`（空导入）而不是 `import {}`：只引入类型副作用，不产生运行期 import，
`tsdown` 打包后该行被完全擦除 —— 实测 `grep dsh-commands lib/index.js` 无命中，
所以插件不会因此硬依赖 `dsh-commands` 在运行期可解析（该 service 由 harness 提供）。

## 3. 测试栈就绪检测 bug（`scripts/test-stack.mjs`）

`up` 命令长期报「harness N 秒内没就绪」，但 harness 一直活得好好的。根因在就绪探测链路：

```js
const location = cookieRes.headers.get('location') ?? '/'
await fetch(`http://127.0.0.1:${HARNESS_PORT}${location}`, …)
```

0.2.0-rc.2 的 web 层返回的 `location` 是 **`"./"`（相对路径）**，直接字符串拼接得到
`http://127.0.0.1:3182./` —— 非法 URL，`fetch` 抛 `Failed to parse URL from …`，
被外层 `catch {}` 吞掉后 `continue`，于是永远探测不到就绪，只能等超时 `die`。

**修法**：按 RFC 3986 用 `new URL` 解析相对引用：

```js
const pageRes = await fetch(new URL(location, PAGE_URL), { … })
```

同时把轮询上限从 120×500ms（60s）放宽到 360×500ms（180s）：0.2.0-rc.2 依赖体积更大、首次启动更慢。

### 另一处修复：删除实体目录

`relinkPlugin()` 原来只 `rmSync(link, { force: true })`，删得掉软链、删不掉目录。
真 home 里插件若以 `github:` 形式安装就是实体目录，rsync 会原样复制进副本，
此时 `symlinkSync` 抛 `EEXIST`。改为 `{ recursive: true, force: true }` 两种都能删。

## 4. 插件 API 兼容性逐项核对

插件只用到这些 host API。全部逐条比对 0.2.0-rc.2 的真实产物（dist 里的 `.d.ts` 与运行期 schema）：

| 插件用到的 API | 0.2.0-rc.2 现状 | 结论 |
| --- | --- | --- |
| `ctx.plugin(mcpClient, { transport, serverName, url, headers, toolCallTimeoutMs, failOnStartupError })` | Config schema 实跑接受原样输入，补默认 `maxInstructionBytes:32768` / `reconnect` | ✅ |
| `ctx.effect(() => disposer)`、`Fiber` | cordis 4.0.4 仍导出 `Fiber`，`Context extends Pick<Fiber,'effect'>` | ✅ |
| `ctx.credentials.resolve/set/unset` | `CredentialProvider` 抽象类三方法签名未变 | ✅ |
| `ctx.commands.register({ name, description, recordInput, handler: ({signal}) => … })` | `CommandDefinition`（`definitionId?`/`input?`/`recordInput?` 全可选）+ `register(): () => void` | ✅ |
| `parseCmdline(ctx, program)` | 签名不变，内部改为 `program.parse(args.get(), {from:'user'})` | ✅ |
| `cordis.patch.yml` 插入行 `name` | 必须与 package.json `name` 逐字一致：`dsh-notion-mcp` = `dsh-notion-mcp` | ✅ |
| `peerDependencies: "*"` | 运行时用 `semver.satisfies(runtimeVersion, range, {includePrerelease:true})` 校验，`"*"` 恒真 | ✅ |

新增的 `attachments` / `definitionId` 字段都是可选，不影响既有调用点。

## 5. 验证结果（本次真实运行）

### 静态门禁

```
tsc --noEmit          → exit 0（升级前 4 处报错）
pnpm peers check      → No peer dependency issues found（升级前 5 条 missing peer）
vitest run            → Test Files 3 passed (3) / Tests 15 passed (15)
tsdown build          → lib/index.js 12.98 kB、lib/index.d.ts 0.60 kB，Build complete
```

### 隔离栈实跑

`PATH=$HOME/.dsh/desktop-bin/node-shim:$PATH node scripts/test-stack.mjs up`

```
[test-stack] 副本已同步：…/tmp/dsh-notion-test-home
[test-stack] 插件软链已重写：…/profiles/web/node_modules/dsh-notion-mcp -> /home/kaixiang/dev/co-creation-project/dsh-notion
[test-stack] 清理断链：dsh-operation-improve / dsh-secret-guard / git / @Tinnikx/dsh-operation-improve
[test-stack] 清理了 4 个断链
[test-stack] profile manifest 已修正：仅保留内置 bundles + dsh-notion-mcp
[test-stack] harness 启动中：pid=16 port=3182 DSH_HOME=…/tmp/dsh-notion-test-home
[test-stack] harness 就绪：http://127.0.0.1:3182/ 插件已加载=true

============================================================
测试栈就绪。验证结果：
  插件在名册中: ✅
  dsh.bundle 警告: ✅ 无警告
============================================================
```

`tmp/dsh-notion-stack/harness.log`（本次实跑全文）：

```
[dsh-notion-mcp] not authorized — run `dsh notion login`
dsh web: http://127.0.0.1:3182/?token=SG0K3o2KAI6HCWsgPxQNYVwavEYRDC3hJ0hqF0TtBUw
```

- `pluginLoaded=true` 的判据是日志里出现 `[dsh-notion-mcp]` —— dsh-notion 是纯 host 插件，
  不出现在 `__DSH_BOOT__` 的 client entries 里，只能靠 `apply()` 打过日志来确认它真的加载了。
- `declares no dsh.bundle` / `is incompatible with dsh` / `plugin tree failed to load`
  三类告警计数均为 **0**。
- token 认证链路（0.2.0-rc.2 起）：无 token → 401；带 token → 303 + `Set-Cookie`；带 cookie → 200 + `__DSH_BOOT__`。

`status` / `down` 如实报告 `harness 没有在跑`（无桌面客户端连接时 harness 会在 idle timeout 后退出，属预期行为）。

## 6. 未验证的部分

诚实标注，避免把"启动了"读成"全链路可用"：

- **真实 OAuth 端到端未跑**：只验到假 token 下 `refresh failed: HTTP 401`，
  证明配置解析、discovery、refresh 调用链都走到了，但没真授权过。
- **有效 token 下 `mcp__notion__*` 工具真正注册成功未验证**：需要一次真实授权。
- **README 方式 A 的最小 profile 不完整**：按 `dsh-profile-notion` 的读法只列 `dsh-notion-mcp` 会
  `pending (waiting for services: credentials, commands)` —— 需同时列 `@deepseek-ai/dsh-base`。
  用户判定为上游问题，本次不改文档，留待上游处理。

## 7. 改动清单

| 文件 | 改动 |
| --- | --- |
| `package.json` | devDependencies 20 项从 `"*"` 钉到精确版本；移除 `dsh-code-runtime`；新增 `dsh-commands` 及 5 个新 peer |
| `src/index.ts` | 新增 3 行 `import type {} from '@deepseek-ai/dsh-commands'` + 注释 |
| `scripts/test-stack.mjs` | 就绪检测改用 `new URL(location, PAGE_URL)`；轮询上限 60s→180s；`rmSync` 加 `recursive` |
| `README.md` / `README.en.md` | 已验证版本列表补 `v0.2.0-rc.2` |
| `pnpm-lock.yaml` | 随依赖升级重新生成 |
| `lib/index.d.ts` | 重新构建；schemastery 3.18.4 的类型签名多出 `NoInfer<…>` 与 `"plain"` 标记（由 schemastery 版本决定，非手写） |