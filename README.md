# dsh-notion-mcp

通过官方 Notion MCP 服务器，用 OAuth 2.0（授权码 + PKCE）把 [DeepSeek Harness](https://github.com/deepseek-ai/dsh)（`dsh`）连接到 [Notion](https://www.notion.com)。完成一次性浏览器授权后，你的 `dsh` agent 就能通过标准的 `mcp__notion__*` 工具搜索、读取和写入 Notion 的页面、数据库与评论。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Node: 22.19%2B%20or%2024%2B](https://img.shields.io/badge/Node-22.19%2B%20or%2024%2B-339933.svg)](https://nodejs.org) [![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

中文 | [English](README.en.md)

## 它能帮你做什么

装上 `dsh-notion-mcp` 后，你的 `dsh` agent 即可直接读写 Notion。你只需要在浏览器里完成一次授权，剩下的事插件都会自动打理：跑完整套 OAuth 2.0（授权码 + PKCE）流程、把 token 安全保存到 dsh 的凭据层、在后台静默刷新保持有效，并把 Notion 的搜索、页面、数据库、评论等工具以 `mcp__notion__*` 的形式挂载给 agent。

## 特性

- **零配置 OAuth** —— 动态客户端注册（RFC 7591）在运行时注册客户端，无需复制任何 `client_id` 或密钥。
- **一次性浏览器登录** —— `dsh notion login` 打印授权 URL，并在 `127.0.0.1:53007` 等待回调。
- **静默刷新 token** —— access token（约 8 小时）到期前自动刷新；轮换后的 refresh token 原子落盘。
- **`invalid_grant` 终态处理** —— 过期或已被轮换作废的 refresh token 绝不重试；插件会清掉它并提示你重新授权。
- **仓库不含任何密钥** —— token 存在 dsh 的凭据存储里，不进入本仓库。

## 0.2.0 更新

- 在支持授权记录的 DSH 版本中，插件会自动迁移已有 Notion 凭据，无需重新授权。多个 DSH 进程共享凭据时，只需刷新一次。
- Web 已经打开时，在终端完成 Notion 登录后，插件会自动连接，无需重启 Web。

## 截图

让 `dsh` agent 总结一段技术架构并写入 Notion：

![dsh 里请求写入 Notion](./docs/screenshots/dsh-notion-sc1.png)

写好的 Notion 页面：

![写入后的 Notion 页面](./docs/screenshots/dsh-notion-sc2.png)

## 工作原理

```text
dsh notion login
   │  1. OAuth 发现（RFC 9470 / RFC 8414）
   │  2. 动态客户端注册（RFC 7591）
   │  3. PKCE S256 + state → 授权 URL
   ▼
浏览器批准 → 回调到 127.0.0.1:53007
   │  4. 用 code（加 PKCE verifier）换取 token
   ▼
token 落盘 → Notion MCP 挂载为 mcp__notion__*
```

启动时插件读取已存 token 并挂载 MCP 客户端。在支持授权记录的 DSH 版本中，插件会自动迁移已有的 `NOTION_OAUTH` 凭据，无需重新授权。临近过期时，插件在 DSH 的凭据事务内读取最新记录、刷新并保存结果，避免多个进程同时使用同一个 refresh token。

## 安装

```sh
dsh plugin --profile web add dsh-notion-mcp
```

把 `web` 换成你运行 agent 所用的 profile。DSH `v0.2.2-rc.1` 的默认 `headless` profile 关闭了凭据服务，使用本插件前需[恢复凭据服务](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/bundle/headless/README.zh.md#credentials)。

## 授权

`notion` 命令需要在一个「最小 profile」里运行，因为 `web` 等 UI app 会自行解析命令行参数。授权一次后，同一 DSH 主目录下安装了本插件且启用了凭据服务的 profile 可以共用 token。

```sh
dsh plugin --profile notion add dsh-notion-mcp
dsh --profile notion notion login
```

该命令会注册一个动态 OAuth 客户端，在 `127.0.0.1:53007` 起一个临时本地 HTTP 服务，并打印授权 URL。在浏览器里打开并批准后，Notion 会重定向到 `http://127.0.0.1:53007/callback`。插件校验 `state`，用 code 和 PKCE verifier 换取 token，再保存凭据。

授权完成后，已打开的 Web profile 会读取新凭据并连接 Notion，无需重启。连接成功后，Notion 工具以 `mcp__notion__*` 形式可用。

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
- 若 Notion 拒绝当前凭据的 refresh token 并返回 `invalid_grant`，插件会清掉失效的 token 并停止重试。运行 `dsh --profile notion notion login` 重新授权。

## 环境要求

- [DSH `v0.2.2-rc.1`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1)（本地源码提交 `fcc0ad4621`）已验证可加载 `dsh-notion-mcp@0.2.0`。使用本地模拟服务验证了 CLI 登录、凭据迁移、跨进程刷新，以及 Web profile 中的 MCP 工具调用。
- 此前已验证兼容 DSH `v0.1.0-rc.8`、`v0.1.1-rc.1`、`v0.1.1-rc.2` 和 `v0.1.2-alpha.1`，并在 `v0.1.7-rc.2` 的 Web profile 中验证了 Notion MCP 工具发现与注册。
- DSH `v0.2.2-rc.1` 需要 Node.js `>=24.9.0`。使用较早的 DSH 版本时，插件本身支持 Node.js `^22.19.0` 或 `>=24.0.0`，运行环境须同时满足所用 DSH 版本的要求。

## 开发

```sh
npm install
npm run build      # tsdown → lib/
npm run typecheck  # tsc --noEmit
npm test           # vitest
```

## 许可证

[MIT](LICENSE) © 2026 mingzeng
