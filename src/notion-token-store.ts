import { credentialRef } from '@deepseek-ai/dsh-credentials'

export const NOTION_LEGACY_REF = credentialRef('NOTION_OAUTH')
export const NOTION_GRANT_KEY = 'notion/oauth'

export interface NotionTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  clientId: string
}

export interface CredentialStore {
  resolve(ref: typeof NOTION_LEGACY_REF): Promise<{ value: string; source: string } | undefined>
  set(ref: typeof NOTION_LEGACY_REF, value: string): Promise<void>
  unset(ref: typeof NOTION_LEGACY_REF): Promise<void>
}

type CredentialRecord = { kind: 'grant'; payload: unknown } | { kind: 'api-key' }

// The oldest supported DSH and our pinned build dependency only expose refs.
interface RecordStore extends CredentialStore {
  readRecord(key: string): Promise<CredentialRecord | undefined>
  modifyRecord(
    key: string,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined>
}

function supportsRecords(store: CredentialStore): store is RecordStore {
  return 'readRecord' in store && typeof store.readRecord === 'function'
    && 'modifyRecord' in store && typeof store.modifyRecord === 'function'
}

function parseTokens(value: unknown): NotionTokens | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { accessToken, refreshToken, expiresAt, clientId } = value as Partial<NotionTokens>
  if (typeof accessToken !== 'string' || !accessToken || typeof refreshToken !== 'string' || !refreshToken
    || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || typeof clientId !== 'string' || !clientId) {
    return undefined
  }
  return { accessToken, refreshToken, expiresAt, clientId }
}

function tokensFrom(record: CredentialRecord | undefined): NotionTokens | undefined {
  return record?.kind === 'grant' ? parseTokens(record.payload) : undefined
}

function matches(current: NotionTokens | undefined, previous: NotionTokens): current is NotionTokens {
  return current !== undefined && current.accessToken === previous.accessToken
    && current.refreshToken === previous.refreshToken && current.expiresAt === previous.expiresAt
    && current.clientId === previous.clientId
}

export class NotionTokenStore {
  constructor(private credentials: CredentialStore) {}

  async load(): Promise<NotionTokens | undefined> {
    if (!supportsRecords(this.credentials)) return this.loadLegacy()

    let record = await this.credentials.readRecord(NOTION_GRANT_KEY)
    if (!record && await this.loadLegacy()) {
      record = await this.credentials.modifyRecord(NOTION_GRANT_KEY, async current => {
        if (current) return undefined
        const tokens = await this.loadLegacy()
        if (tokens) return { kind: 'grant', payload: tokens }
      })
    }
    if (record) await this.removeLegacy()
    return tokensFrom(record)
  }

  async save(tokens: NotionTokens): Promise<void> {
    if (!supportsRecords(this.credentials)) {
      await this.credentials.set(NOTION_LEGACY_REF, JSON.stringify(tokens))
      return
    }
    await this.credentials.modifyRecord(NOTION_GRANT_KEY, async () => ({ kind: 'grant', payload: tokens }))
    await this.removeLegacy()
  }

  /** Refresh only if the credential still matches the one that was due. */
  async refresh(
    previous: NotionTokens,
    renew: (current: NotionTokens) => Promise<NotionTokens | undefined>,
  ): Promise<NotionTokens | undefined> {
    if (supportsRecords(this.credentials)) {
      const record = await this.credentials.modifyRecord(NOTION_GRANT_KEY, async record => {
        const current = tokensFrom(record)
        if (!matches(current, previous)) return undefined
        const next = await renew(current)
        // Invalidate under the same lock. A separate delete could remove a new login.
        return { kind: 'grant', payload: next ?? { reauthorize: true } }
      })
      return tokensFrom(record)
    }

    const current = await this.loadLegacy()
    if (!matches(current, previous)) return current
    const next = await renew(current)
    // Older providers have no transaction. Avoid overwriting a change they can already see.
    const latest = await this.loadLegacy()
    if (!matches(latest, current)) return latest
    if (next) await this.save(next)
    else await this.credentials.unset(NOTION_LEGACY_REF)
    return next
  }

  private async loadLegacy(): Promise<NotionTokens | undefined> {
    const resolved = await this.credentials.resolve(NOTION_LEGACY_REF)
    if (!resolved) return undefined
    try {
      return parseTokens(JSON.parse(resolved.value))
    } catch {
      return undefined
    }
  }

  private async removeLegacy(): Promise<void> {
    try {
      if ((await this.credentials.resolve(NOTION_LEGACY_REF))?.source === 'file') {
        await this.credentials.unset(NOTION_LEGACY_REF)
      }
    } catch (error) {
      // The grant is already committed. Retry cleanup the next time we read it.
      console.warn('[dsh-notion-mcp] could not remove the legacy credential', error)
    }
  }
}
