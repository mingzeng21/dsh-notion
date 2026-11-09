import { it, expect, vi } from 'vitest'
import { NOTION_GRANT_KEY, NotionTokenStore, type NotionTokens } from '../src/notion-token-store.js'

const tokens: NotionTokens = { accessToken: 'at', refreshToken: 'rt', expiresAt: 123456, clientId: 'cid' }
const rotated = { ...tokens, accessToken: 'new-at', refreshToken: 'new-rt', expiresAt: 234567 }

function legacyProvider(value?: string) {
  return {
    async resolve() { return value === undefined ? undefined : { value, source: 'file' } },
    async set(_ref: string, next: string) { value = next },
    async unset() { value = undefined },
  }
}

function transactionalProvider(legacy?: NotionTokens) {
  type Record = { kind: 'grant'; payload: unknown } | { kind: 'api-key' }
  const records = new Map<string, Record>()
  let tail = Promise.resolve()
  return {
    ...legacyProvider(legacy && JSON.stringify(legacy)),
    async readRecord(key: string) { return records.get(key) },
    modifyRecord(key: string, update: (current: Record | undefined) => Promise<Record | undefined>) {
      const operation = tail.then(async () => {
        const next = await update(records.get(key))
        if (next) records.set(key, next)
        return records.get(key)
      })
      tail = operation.then(() => {}, () => {})
      return operation
    },
  }
}

it('continues to store and refresh credentials on providers that only support references', async () => {
  const store = new NotionTokenStore(legacyProvider())
  expect(await store.load()).toBeUndefined()
  await store.save(tokens)
  expect(await store.load()).toEqual(tokens)
  expect(await store.refresh(tokens, async () => rotated)).toEqual(rotated)
  await store.refresh(rotated, async () => undefined)
  expect(await store.load()).toBeUndefined()
})

it('migrates existing credentials and only removes the old entry after the grant is saved', async () => {
  const provider = transactionalProvider(tokens)
  const store = new NotionTokenStore(provider)
  const modify = vi.spyOn(provider, 'modifyRecord').mockRejectedValueOnce(new Error('write failed'))
  await expect(store.load()).rejects.toThrow('write failed')
  expect(await provider.resolve()).toEqual({ value: JSON.stringify(tokens), source: 'file' })

  expect(await store.load()).toEqual(tokens)
  expect(await provider.readRecord(NOTION_GRANT_KEY)).toEqual({ kind: 'grant', payload: tokens })
  expect(await provider.resolve()).toBeUndefined()
  expect(await store.load()).toEqual(tokens)
  expect(modify).toHaveBeenCalledTimes(2)
})

it('refreshes a shared credential once even if two instances read the old grant', async () => {
  const provider = transactionalProvider(tokens)
  const first = new NotionTokenStore(provider)
  const second = new NotionTokenStore(provider)
  expect(await Promise.all([first.load(), second.load()])).toEqual([tokens, tokens])

  const renew = vi.fn(async () => rotated)
  expect(await Promise.all([first.refresh(tokens, renew), second.refresh(tokens, renew)])).toEqual([rotated, rotated])
  expect(renew).toHaveBeenCalledTimes(1)
  expect(await second.load()).toEqual(rotated)
})

it('does not restore an invalidated grant from a legacy entry', async () => {
  const provider = transactionalProvider(tokens)
  // A failed cleanup leaves the reference behind after the grant is written.
  vi.spyOn(provider, 'unset').mockResolvedValue(undefined)
  const store = new NotionTokenStore(provider)
  expect(await store.load()).toEqual(tokens)
  expect(await store.refresh(tokens, async () => undefined)).toBeUndefined()
  expect(await provider.resolve()).toBeDefined()
  expect(await new NotionTokenStore(provider).load()).toBeUndefined()

  await store.save(rotated)
  expect(await store.load()).toEqual(rotated)
})
