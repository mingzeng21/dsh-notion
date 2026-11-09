import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Command } from 'commander'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { NOTION_GRANT_KEY, NOTION_LEGACY_REF, NotionTokenStore, type NotionTokens } from './notion-token-store.js'
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
export const inject = ['cmdlineArgs', 'credentials']

export const Config = z.object({
  mcpUrl: z.string().default('https://mcp.notion.com/mcp'),
  port: z.number().default(53007),
})

type Cfg = { mcpUrl: string; port: number }

const REFRESH_LEAD_MS = 5 * 60_000
const RETRY_MS = 60_000
const REFRESH_TIMEOUT_MS = 10_000

// The two credential service generations declare different events.
declare module '@deepseek-ai/cordis' {
  interface Events {
    'credentials/record-updated'(key: string): void
    'credentials/updated'(ref: typeof NOTION_LEGACY_REF): void
  }
}

async function renewTokens(config: Cfg, tokens: NotionTokens, signal: AbortSignal): Promise<NotionTokens | undefined> {
  const timeout = AbortSignal.timeout(REFRESH_TIMEOUT_MS)
  const disc = await discoverOAuth(config.mcpUrl, AbortSignal.any([signal, timeout]))
  signal.throwIfAborted()
  try {
    // If the plugin is unloaded after sending the exchange, still save a rotated token.
    const next = await refreshAccessToken(disc.tokenEndpoint, {
      clientId: tokens.clientId, refreshToken: tokens.refreshToken,
    }, timeout)
    return {
      accessToken: next.accessToken,
      refreshToken: next.refreshToken ?? tokens.refreshToken,
      expiresAt: Date.now() + next.expiresIn * 1000,
      clientId: tokens.clientId,
    }
  } catch (error) {
    if (error instanceof InvalidGrantError) return undefined
    throw error
  }
}

async function runLogin(store: NotionTokenStore, config: Cfg): Promise<void> {
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
  console.log('[dsh-notion-mcp] authorized — Notion credentials saved')
}

function connectAgent(ctx: Context, store: NotionTokenStore, config: Cfg): void {
  const lifetime = new AbortController()
  const { signal } = lifetime
  let child: Fiber | undefined
  let mountedToken: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = Promise.resolve()
  let queued = false
  let refreshBefore = 0
  let reportedMissing = false

  function schedule(delay: number): void {
    timer = setTimeout(() => reconcile(Date.now() + REFRESH_LEAD_MS), delay)
  }

  function reconcile(cutoff = 0): void {
    if (signal.aborted) return
    refreshBefore = Math.max(refreshBefore, cutoff)
    if (queued) return
    queued = true
    pending = pending.then(async () => {
      queued = false
      const cutoff = refreshBefore
      refreshBefore = 0
      if (signal.aborted) return
      clearTimeout(timer)

      try {
        let tokens = await store.load()
        if (signal.aborted) return
        if (tokens && tokens.expiresAt <= cutoff) {
          tokens = await store.refresh(tokens, current => renewTokens(config, current, signal))
        }
        if (signal.aborted) return

        const accessToken = tokens?.accessToken
        if (accessToken !== mountedToken) {
          if (child) await child.dispose()
          child = undefined
          mountedToken = undefined
          if (signal.aborted) return
          if (accessToken) {
            child = ctx.plugin(mcpClient, {
              transport: 'streamable-http',
              serverName: 'notion',
              url: config.mcpUrl,
              headers: { Authorization: `Bearer ${accessToken}` },
              toolCallTimeoutMs: 60_000,
              failOnStartupError: false,
            })
            mountedToken = accessToken
          }
        }
        if (tokens) {
          reportedMissing = false
          const delay = Math.max(RETRY_MS, tokens.expiresAt - Date.now() - REFRESH_LEAD_MS)
          schedule(Math.min(2_147_483_647, delay))
        } else if (!reportedMissing) {
          reportedMissing = true
          console.error('[dsh-notion-mcp] not authorized — run `dsh --profile notion notion login`')
        }
      } catch (error) {
        if (signal.aborted) return
        console.error('[dsh-notion-mcp] could not update the Notion connection', error)
        schedule(RETRY_MS)
      }
    })
  }

  ctx.effect(() => () => {
    lifetime.abort()
    clearTimeout(timer)
  })
  ctx.on('credentials/record-updated', key => {
    if (key === NOTION_GRANT_KEY) reconcile()
  })
  ctx.on('credentials/updated', ref => {
    if (ref === NOTION_LEGACY_REF) reconcile()
  })
  reconcile(Date.now() + RETRY_MS)
}

export function apply(ctx: Context, config: Cfg): void {
  const store = new NotionTokenStore(ctx.credentials)
  if ((ctx.cmdlineArgs?.get() ?? [])[0] !== 'notion') {
    connectAgent(ctx, store, config)
    return
  }

  const exit = ctx.get('appExit')
  const program = new Command()
  program
    .command('notion')
    .command('login')
    .description('Authorize Notion via the official MCP OAuth flow')
    .action(() => {
      void runLogin(store, config)
        .then(() => exit?.(0))
        .catch((error) => { console.error(error); exit?.(1) })
    })
  parseCmdline(ctx, program)
}
