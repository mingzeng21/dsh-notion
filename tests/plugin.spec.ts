import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import * as plugin from '../src/index.js'
import { NOTION_GRANT_KEY, type NotionTokens } from '../src/notion-token-store.js'

const { mount, unmount } = vi.hoisted(() => ({ mount: vi.fn(), unmount: vi.fn() }))

vi.mock('@deepseek-ai/dsh-mcp-client', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-mcp-client')>(),
  name: 'test-mcp-client',
  inject: [],
  apply(ctx: Context, config: { headers: { Authorization: string } }) {
    mount(config.headers.Authorization)
    ctx.effect(() => () => { unmount() })
  },
}))

it('connects after login and replaces the connection when the saved access token changes', async () => {
  const ctx = new Context()
  let tokens: NotionTokens | undefined
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  ctx.provide('cmdlineArgs', { get: () => [] })
  ctx.provide('credentials', {
    async resolve() { return undefined },
    async readRecord() { return tokens && { kind: 'grant', payload: tokens } },
    async modifyRecord() { throw new Error('unexpected credential write') },
  })

  try {
    await ctx.plugin(plugin, { mcpUrl: 'https://fixture.invalid/mcp', port: 53007 })
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining('not authorized')))
    expect(mount).not.toHaveBeenCalled()

    tokens = { accessToken: 'first', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000, clientId: 'client' }
    ctx.emit('credentials/record-updated', NOTION_GRANT_KEY)
    await vi.waitFor(() => expect(mount).toHaveBeenCalledWith('Bearer first'))

    tokens = { ...tokens, accessToken: 'next' }
    ctx.emit('credentials/record-updated', NOTION_GRANT_KEY)
    ctx.emit('credentials/record-updated', NOTION_GRANT_KEY)
    await vi.waitFor(() => expect(mount).toHaveBeenCalledWith('Bearer next'))
    expect(mount).toHaveBeenCalledTimes(2)
    expect(unmount).toHaveBeenCalledTimes(1)

    tokens = undefined
    ctx.emit('credentials/record-updated', NOTION_GRANT_KEY)
    await vi.waitFor(() => expect(unmount).toHaveBeenCalledTimes(2))
  } finally {
    await ctx.fiber.dispose()
    log.mockRestore()
  }
})
