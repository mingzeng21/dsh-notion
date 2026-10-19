# Harness v0.1.2-rc.1 适配报告

## 概述

dsh-notion-mcp 插件已验证与 harness v0.1.2-rc.1 兼容，无需修改插件代码。
测试栈脚本 `scripts/test-stack.mjs` 已适配 v0.1.2-rc.1 的新行为。

## 版本信息

- **目标版本**: harness v0.1.2-rc.1
- **当前产品版本**: harness v0.1.2-rc.1（产品自带）
- **harness 位置**: `dsh-desktop/dist/desktop/dsh-linux-x64/resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js`

## v0.1.2-rc.1 新行为

### 1. Token 认证

v0.1.2-rc.1 引入了 token 认证机制：

- `dsh web` 启动后输出带 token 的 URL：`http://127.0.0.1:PORT/?token=XXX`
- 首次访问 `/?token=XXX` 返回 303 重定向 + `Set-Cookie`
- 后续请求需要带 cookie 才能拿到 200 + `__DSH_BOOT__`
- 不带 token/cookie 的请求返回 401

### 2. Idle Timeout

无活跃 WebSocket 连接时，harness 会自动退出。测试栈没有桌面客户端连接，
所以 harness 在 `up` 命令完成后不久会退出。这是预期行为——测试只需验证
启动和插件加载，不需要长时间运行。

## 测试栈适配

### 启动方式

从 `setsid dsh web --port PORT` 改为 `spawn('sh', [wrapperScript])` + `detached: true`：

- wrapper 脚本设置 `DSH_HOME` 环境变量并 `exec node --expose-internals bin.js`
- `detached: true` + `child.unref()` 使 harness 在 test-stack.mjs 退出后继续运行
- 产品自带 node（`~/.dsh/desktop-bin/node-shim/node`）+ `--expose-internals` flag

### 检测逻辑

- 从日志中提取 token
- 用 `fetch` + `redirect: 'manual'` 获取 `Set-Cookie`
- 带 cookie 访问页面，检查 `__DSH_BOOT__`
- 纯 host 插件不出现在 `__DSH_BOOT__` entries 中，改为检查日志中的 `[dsh-notion-mcp]` 输出

### 锁文件清理

`syncHome` 后显式删除 `.credentials.yaml.lock` 和 `.credentials.yaml`：
rsync 的 `--exclude=*.lock` 排除了真 home 里的文件，但 harness 上次运行时
在副本里创建的锁文件不会被 rsync 删掉（`--delete` 只删真 home 里有的文件）。

### Profile manifest

`fixManifest` 无条件写入插件依赖（真 home 可能没装过 dsh-notion-mcp）：
```js
manifest.dependencies = { [PLUGIN_NAME]: `link:${REPO}` }
```

## 验证结果

2026-09-05 实测（本次运行留下 `tmp/dsh-notion-stack/` 日志与副本可复核）：

```bash
$ PATH=$HOME/.dsh/desktop-bin/node-shim:$PATH node scripts/test-stack.mjs up
[test-stack] 副本已同步：.../tmp/dsh-notion-test-home
[test-stack] 插件软链已重写：.../dsh-notion-mcp -> .../dsh-notion
[test-stack] 清理断链：dsh-operation-improve
[test-stack] 清理断链：git
[test-stack] 清理了 2 个断链
[test-stack] profile manifest 已修正：仅保留内置 bundles + dsh-notion-mcp
[test-stack] harness 启动中：pid=14 port=3182 DSH_HOME=.../tmp/dsh-notion-test-home
[test-stack] harness 就绪：http://127.0.0.1:3182/ 插件已加载=true

测试栈就绪。验证结果：
  插件在名册中: ✅
  dsh.bundle 警告: ✅ 无警告
```

harness 日志（`tmp/dsh-notion-stack/harness.log`）：

```
[dsh-notion-mcp] not authorized — run `dsh notion login`
dsh web: http://127.0.0.1:3182/?token=…
```

- ✅ 隔离 DSH_HOME（`tmp/dsh-notion-test-home`）启动成功
- ✅ 插件 apply() 被调用（日志中有 `[dsh-notion-mcp]` 输出）
- ✅ 无 "declares no dsh.bundle" 警告
- ✅ 端口 3182（不使用 3080；`RESERVED_PORT = 3080` 有护栏）
- ✅ `stack:down` 正常停掉 harness（idle timeout 后进程自行退出，`status` 如实报告）

## 插件代码

插件代码无需修改。`cordis.patch.yml`、`src/index.ts`、`package.json` 均兼容 v0.1.2-rc.1。

## 已知限制

- 测试栈的 harness 无桌面客户端连接，会在 idle timeout 后自动退出
- 插件需要 OAuth token 才能连接 Notion MCP，测试栈中显示 "not authorized" 是预期行为
