# dsh-notion-mcp

通过官方 Notion MCP 服务器，用 OAuth 2.0（授权码 + PKCE）把 [DeepSeek Harness](https://github.com/deepseek-ai/dsh)（`dsh`）连接到 [Notion](https://www.notion.com)。完成一次性浏览器授权后，你的 `dsh` agent 就能通过标准的 `mcp__notion__*` 工具搜索、读取和写入 Notion 的页面、数据库与评论。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Node: 22.19%2B%20or%2024%2B](https://img.shields.io/badge/Node-22.19%2B%20or%2024%2B-339933.svg)](https://nodejs.org) [![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

中文 | [English](README.en.md)

## 它能帮你做什么

装上 `dsh-notion-mcp` 后，你的 `dsh` agent 即可直接读写 Notion。你只需要在浏览器里完成一次授权，剩下的事插件都会自动打理：跑完整套 OAuth 2.0（授权码 + PKCE）流程、把 token 安全保存到 dsh 的凭据层、在后台静默刷新保持有效，并把 Notion 的搜索、页面、数据库、评论等工具以 `mcp__notion__*` 的形式挂载给 agent。

## 特性

- **零配置 OAuth** —— 动态客户端注册（RFC 7591）在运行时注册客户端，无需复制任何 `client_id` 或密钥。
- **一次性浏览器登录** —— 支持两种入口：`dsh notion login`（CLI）或在对话框里调用 `/notion-login` 命令。
- **自动拉起外部浏览器** —— 登录流程会在打印授权 URL 的同时尝试自动打开系统浏览器到`127.0.0.1:53007`；若失败可手动复制 URL 打开。
- **静默刷新 token** —— access token（约 8 小时）到期前自动刷新；轮换后的 refresh token 原子落盘。
- **`invalid_grant` 终态处理** —— 过期或已被轮换作废的 refresh token 绝不重试；插件会清掉它并提示你重新授权。
- **仓库不含任何密钥** —— token 存在 dsh 的凭据存储里，不进入本仓库。

## 截图

让 `dsh` agent 总结一段技术架构并写入 Notion：

![dsh 里请求写入 Notion](./docs/screenshots/dsh-notion-sc1.png)

写好的 Notion 页面：

![写入后的 Notion 页面](./docs/screenshots/dsh-notion-sc2.png)

认证方式B

![认证方式B](./docs/screenshots/dsh-notion-sc3.png)

## 工作原理

```text
入口 A：dsh notion login
入口 B：在对话框里调用 /notion-login
   │  1. OAuth 发现（RFC 9470 / RFC 8414）
   │  2. 动态客户端注册（RFC 7591）
   │  3. PKCE S256 + state → 授权 URL（并尝试自动打开外部浏览器）
   ▼
浏览器批准 → 回调到 127.0.0.1:53007
   │  4. 用 code（加 PKCE verifier）换取 token
   ▼
token 落盘 → Notion MCP 挂载为 mcp__notion__*
```

启动时插件会读取已存 token 并挂载 MCP 客户端；临近过期时在后台刷新（串行化，避免并发重放已轮换的 refresh token）。

## 安装

```sh
dsh plugin --profile web add dsh-notion-mcp
or
dsh plugin --profile web install github:mingzeng21/dsh-notion
```

把 `web` 换成你运行 agent 所用的 profile（`web`、`headless`、`tui` 等）。

## 授权

你可以任选一种入口发起授权（最终都会走同一套 OAuth 流程）：

### 方式 A：CLI 命令（原有方式）

`notion` 命令需要在一个「最小 profile」里运行——像 `web` 这类 UI app 会独占自己的命令行，不会把 `notion` 转发给插件。token 是全局存储的，所以在任意最小 profile 里授权一次，所有安装了本插件的 profile 都能直接使用：

```sh
dsh plugin --profile notion add dsh-notion-mcp
dsh --profile notion notion login
```
授权完成后，Notion 工具即以 `mcp__notion__*` 形式可用。

### 方式 B：对话框命令（新增）

在对话框里调用 `/notion-login`，即可触发同一登录流程。

### 新授权步骤（两种入口一致）

1. 插件做 OAuth 发现与动态客户端注册。
2. 启动本地临时回调服务：`http://127.0.0.1:53007/callback`。
3. 生成授权 URL，并尝试自动拉起系统外部浏览器；若自动拉起失败，可手动复制终端里的 URL 打开。
4. 你在浏览器里批准后，Notion 重定向到本地回调地址。
5. 插件校验 `state`，再用 `code + PKCE verifier` 换取 token。
6. token 落盘后自动挂载 Notion MCP 客户端。

按方式B授权完成后，无需重启 Harness，Notion 工具即以 `mcp__notion__*` 形式可用。

## 卸载

```sh
dsh plugin --profile web remove dsh-notion-mcp
```

## 配置

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `mcpUrl` | `https://mcp.notion.com/mcp` | Notion MCP 服务器 URL |
| `port` | `53007` | 本地 OAuth 回调端口（`127.0.0.1`） |

## 安全性

- token 通过 dsh 的凭据层（`ctx.credentials`）以单条原子记录存储，绝不提交到本仓库；也不嵌入任何 `client_id` 或密钥——客户端在运行时通过动态客户端注册。
- Notion 每次刷新都会轮换 refresh token；新 token 与 access token 一起原子落盘。
- 若 Notion 返回 `invalid_grant`（refresh token 过期或被轮换作废），插件会清掉已存 token 并停止重试——用 `dsh notion login` 重新授权即可。

## 环境要求

- [DeepSeek Harness](https://github.com/deepseek-ai/dsh)（`dsh`）—— 已验证兼容 `v0.1.0-rc.8`、`v0.1.1-rc.1`、`v0.1.1-rc.2`、`v0.1.2-alpha.1`、`v0.1.2-rc.1`
- Node.js `^22.19.0` 或 `>=24.0.0`（与 dsh `v0.1.2-alpha.1` 一致；Node 23 不在支持范围内）

## 开发

```sh
pnpm install
pnpm run build      # tsdown → lib/
pnpm run typecheck  # tsc --noEmit
pnpm test           # vitest
pnpm stack:up       # 隔离 DSH_HOME + 独立端口启动真实 harness，验证插件可加载
```

依赖与构建基于 pnpm（仓库根 `pnpm-workspace.yaml` + `pnpm-lock.yaml`）。改依赖前先读下面的约束：

- **`lib/` 产物提交入库，package.json 不声明 `prepare` 脚本**：git-hosted 安装因此「无需构建」，安装方不需要 allowBuilds，也不随仓库提交变化而失效。改源码后先 `pnpm run build`，再把 `lib/` 和源码一起提交。
- **`autoInstallPeers: false`（`pnpm-workspace.yaml`）不能打开**：本仓库的 `@deepseek-ai` peer 链包含非公开包（如 `dsh-type-meta`），自动安装 peer 必然 404。运行期需要的 `@deepseek-ai/*` 必须**显式**列在 devDependencies 中，并维护为完整闭包（21 个包，含 `dsh-mcp-client` 静态 import 的 `dsh-subprocess`、`dsh-tools`）。漏装时，harness 以 `link:` 从本仓库加载插件会报 `ERR_MODULE_NOT_FOUND`——仓库自身的 node_modules 优先于 harness 运行时的解析，缺包无法回退。
- 依赖只由 pnpm 管理：提交 `pnpm-lock.yaml`，不提交 npm 的 `package-lock.json`（双锁文件会漂移）。
- `pnpm-workspace.yaml` 的 `allowBuilds` 放行 `esbuild` 的构建脚本（pnpm 11 只接受精确版本），供本地 `pnpm install` 使用；升级依赖时同步更新该版本号。

## 许可证

[MIT](LICENSE) © 2026 mingzeng
