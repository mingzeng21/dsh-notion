import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Command } from 'commander'
import { spawn } from 'node:child_process'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { NotionTokenStore, type NotionTokens } from './notion-token-store.js'
import {
  discoverOAuth,
  registerClient,
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  generateVerifier,
  generateState,
  computeChallenge,
  InvalidGrantError,
} from './notion-oauth.js'
import { startLoginServer } from './login-server.js'

export const name = 'notion'
export const inject = ['cmdlineArgs', 'credentials', 'commands']

export const Config = z.object({
  mcpUrl: z.string().default('https://mcp.notion.com/mcp'),
  port: z.number().default(53007),
})

type Cfg = { mcpUrl: string; port: number }

const LOGIN_COMMAND = 'notion-login'
const LOGOUT_COMMAND = 'notion-logout'

async function unmount(slot: { child?: Fiber }): Promise<void> {
  if (slot.child) {
    await slot.child.dispose()
    slot.child = undefined
  }
}

async function mountMcp(ctx: Context, accessToken: string, config: Cfg, slot: { child?: Fiber }): Promise<void> {
  await unmount(slot)
  slot.child = ctx.plugin(mcpClient, {
    transport: 'streamable-http',
    serverName: 'notion',
    url: config.mcpUrl,
    headers: { Authorization: `Bearer ${accessToken}` },
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
  })
}

async function refreshAndMount(
  ctx: Context,
  store: NotionTokenStore,
  config: Cfg,
  slot: { child?: Fiber },
  refreshMutex: { running: boolean },
): Promise<void> {
  if (refreshMutex.running) return
  refreshMutex.running = true
  try {
    const tokens = await store.load()
    if (!tokens) return
    const disc = await discoverOAuth(config.mcpUrl)
    let next
    try {
      next = await refreshAccessToken(disc.tokenEndpoint, { clientId: tokens.clientId, refreshToken: tokens.refreshToken })
    } catch (e) {
      if (e instanceof InvalidGrantError) {
        await store.clear()
        await unmount(slot)
        console.error('[dsh-notion-mcp] invalid_grant: run `dsh notion login` to re-authorize')
        return
      }
      throw e
    }
    const refreshed: NotionTokens = {
      accessToken: next.accessToken,
      refreshToken: next.refreshToken ?? tokens.refreshToken,
      expiresAt: Date.now() + next.expiresIn * 1000,
      clientId: tokens.clientId,
    }
    await store.save(refreshed) // single atomic write (rotated refresh persisted with access)
    await mountMcp(ctx, refreshed.accessToken, config, slot)
  } finally {
    refreshMutex.running = false
  }
}

function openExternalBrowser(url: string): void {
  try {
    if (process.platform === 'darwin') {
      const child = spawn('open', [url], { detached: true, stdio: 'ignore' })
      child.unref()
      return
    }
    if (process.platform === 'win32') {
      const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
      child.unref()
      return
    }
    const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
    child.unref()
  } catch (error) {
    console.error('[dsh-notion-mcp] failed to open browser automatically, open URL manually:', error)
  }
}

async function runLogout(ctx: Context, store: NotionTokenStore, slot: { child?: Fiber }): Promise<void> {
  await store.clear()
  await unmount(slot)
  console.log('[dsh-notion-mcp] logged out — Notion tools removed')
}

async function runLogin(ctx: Context, store: NotionTokenStore, config: Cfg, slot: { child?: Fiber }): Promise<void> {
  const redirectBase = `http://127.0.0.1:${config.port}/callback`
  const disc = await discoverOAuth(config.mcpUrl)
  const { clientId } = await registerClient(disc.registrationEndpoint, [redirectBase])
  const verifier = generateVerifier()
  const state = generateState()
  const authorizeUrl = buildAuthorizeUrl(disc.authorizationEndpoint, {
    clientId,
    redirectUri: redirectBase,
    state,
    codeChallenge: computeChallenge(verifier),
  })
  // 直接写终端：`dsh notion login` 这个 CLI 子命令下 ctx.logger 只进内存缓冲区，不落终端。
  console.log(`[dsh-notion-mcp] open this URL to authorize Notion:\n${authorizeUrl}`)
  openExternalBrowser(authorizeUrl)
  const { wait } = await startLoginServer(state, config.port)
  const cb = await wait
  const tokens = await exchangeCode(disc.tokenEndpoint, {
    clientId, code: cb.code, redirectUri: redirectBase, codeVerifier: verifier,
  })
  if (!tokens.refreshToken) {
    throw new Error('authorization response missing refresh_token — cannot persist a usable token')
  }
  const stored: NotionTokens = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: Date.now() + tokens.expiresIn * 1000,
    clientId,
  }
  await store.save(stored)
  await mountMcp(ctx, stored.accessToken, config, slot)
  console.log('[dsh-notion-mcp] authorized — Notion tools now available as mcp__notion__*')
}

export function apply(ctx: Context, config: Cfg): void {
  const store = new NotionTokenStore(ctx.credentials)
  const slot: { child?: Fiber } = {}
  const refreshMutex = { running: false }
  const isNotionCommand = (ctx.cmdlineArgs?.get() ?? [])[0] === 'notion'

  ctx.commands.register({
    name: LOGIN_COMMAND,
    description: 'Start Notion OAuth login flow',
    recordInput: false,
    handler: ({ signal }) => {
      if (signal.aborted) {
        return { kind: 'error', text: 'login cancelled' }
      }
      void runLogin(ctx, store, config, slot).catch((e) => console.error(e))
      return { kind: 'success', text: 'Notion OAuth login started, check your browser.' }
    },
  })

  ctx.commands.register({
    name: LOGOUT_COMMAND,
    description: 'Logout from Notion and uninstall MCP tools',
    recordInput: false,
    handler: ({ signal }) => {
      if (signal.aborted) {
        return { kind: 'error', text: 'logout cancelled' }
      }
      void runLogout(ctx, store, slot).catch((e) => console.error(e))
      return { kind: 'success', text: 'Notion logged out, MCP tools removed.' }
    },
  })

  // 启动时：有 token 直接挂载；过期则静默刷新；无 token 则提示。
  // 仅在 agent 常驻（web/headless 等）时挂载；notion 命令（login/--help）是短命进程，
  // 会调用 appExit 触发 dispose，异步挂载会踩到 inactive context。
  if (!isNotionCommand) {
    void (async () => {
      const tokens = await store.load()
      if (!tokens) {
        console.error('[dsh-notion-mcp] not authorized — run `dsh notion login`')
        return
      }
      if (tokens.expiresAt > Date.now() + 60_000) {
        await mountMcp(ctx, tokens.accessToken, config, slot)
        scheduleRefresh(ctx, store, config, slot, refreshMutex, tokens.expiresAt)
      } else {
        await refreshAndMount(ctx, store, config, slot, refreshMutex)
        const fresh = await store.load()
        if (fresh) scheduleRefresh(ctx, store, config, slot, refreshMutex, fresh.expiresAt)
      }
    })().catch((e) => {
      // 启动时短暂失败（网络 / discovery / 存储）重试，避免插件永远不挂载。
      console.error(e)
      scheduleRefresh(ctx, store, config, slot, refreshMutex, Date.now() + 60_000)
    })
  }

  // 登录命令：只有当本次调用就是 `dsh ... notion ...` 时才接管命令行解析；否则（如
  // `dsh web`）命令行归 app（web/headless）所有。
  if (isNotionCommand) {
    const program = new Command()
    const notion = program.command('notion')
    notion
      .command('login')
      .description('Authorize Notion via the official MCP OAuth flow')
      .action(() => {
        void runLogin(ctx, store, config, slot)
          .then(() => ctx.appExit?.(0))
          .catch((e) => { console.error(e); ctx.appExit?.(1) })
      })
    notion
      .command('logout')
      .description('Logout from Notion and uninstall MCP tools')
      .action(() => {
        void runLogout(ctx, store, slot)
          .then(() => ctx.appExit?.(0))
          .catch((e) => { console.error(e); ctx.appExit?.(1) })
      })
    parseCmdline(ctx, program)
  }

  // 卸载时关闭子 mcp-client。cordis 4.0.1 用 `ctx.effect(() => disposer)` 做清理，
  // 不是 `ctx.on('dispose')`。
  ctx.effect(() => () => { void slot.child?.dispose() })
}

function scheduleRefresh(
  ctx: Context,
  store: NotionTokenStore,
  config: Cfg,
  slot: { child?: Fiber },
  refreshMutex: { running: boolean },
  expiresAt: number,
): void {
  const delay = Math.max(60_000, expiresAt - Date.now() - 5 * 60_000) // 到期前 5 分钟
  // 用 Node 全局 setTimeout（cordis 4.0.1 无 `ctx.setTimeout`）；定时器经 `ctx.effect` 在卸载时清理。
  const timer = setTimeout(() => {
    void refreshAndMount(ctx, store, config, slot, refreshMutex)
      .then(() => store.load())
      .then((t) => { if (t) scheduleRefresh(ctx, store, config, slot, refreshMutex, t.expiresAt) })
      .catch((e) => {
        // 短暂失败（网络 / discovery / 存储）重试，避免刷新循环就此停止。
        // invalid_grant 由 refreshAndMount 内部清 token 并 resolve，不会走到这里。
        console.error(e)
        scheduleRefresh(ctx, store, config, slot, refreshMutex, Date.now() + 60_000)
      })
  }, delay)
  ctx.effect(() => () => clearTimeout(timer))
}
