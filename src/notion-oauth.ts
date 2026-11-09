import { createHash, randomBytes } from 'node:crypto'

export function base64url(buf: Buffer): string {
  return buf.toString('base64url')
}

export function generateVerifier(): string {
  return base64url(randomBytes(32))
}

export function computeChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest())
}

export function generateState(): string {
  return base64url(randomBytes(16))
}

export interface OAuthDiscovery {
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint: string
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.json()
}

export async function discoverOAuth(resourceBaseUrl: string, signal?: AbortSignal): Promise<OAuthDiscovery> {
  const base = new URL(resourceBaseUrl)
  const protectedResource = await fetchJson(`${base.origin}/.well-known/oauth-protected-resource`, { signal })
  const authServer: string = protectedResource.authorization_servers?.[0]
  if (!authServer) throw new Error('OAuth discovery: no authorization_servers advertised')
  const meta = await fetchJson(`${authServer}/.well-known/oauth-authorization-server`, { signal })
  return {
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint: meta.registration_endpoint,
  }
}

export async function registerClient(
  registrationEndpoint: string,
  redirectUris: string[],
): Promise<{ clientId: string }> {
  const res = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'dsh-notion-mcp',
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
    }),
  })
  if (!res.ok) throw new Error(`DCR failed: HTTP ${res.status}`)
  const body = await res.json()
  return { clientId: body.client_id }
}

export class InvalidGrantError extends Error {
  constructor() { super('invalid_grant: refresh token expired or rotated away — re-authorize required') }
}

export interface TokenResponse {
  accessToken: string
  refreshToken?: string
  expiresIn: number
  identity?: { userId: string; workspaceId: string }
}

export function buildAuthorizeUrl(
  authorizationEndpoint: string,
  opts: { clientId: string; redirectUri: string; state: string; codeChallenge: string },
): string {
  const url = new URL(authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', opts.clientId)
  url.searchParams.set('redirect_uri', opts.redirectUri)
  url.searchParams.set('state', opts.state)
  url.searchParams.set('code_challenge', opts.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

function parseTokenBody(body: any): TokenResponse {
  const accessToken: unknown = body.access_token
  const expiresIn: unknown = body.expires_in
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('token response missing access_token')
  }
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('token response missing or invalid expires_in')
  }
  return {
    accessToken,
    refreshToken: body.refresh_token,
    expiresIn,
    identity: body.user_id ? { userId: body.user_id, workspaceId: body.workspace_id } : undefined,
  }
}

export async function exchangeCode(
  tokenEndpoint: string,
  opts: { clientId: string; code: string; redirectUri: string; codeVerifier: string },
): Promise<TokenResponse> {
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: opts.clientId,
      code: opts.code,
      redirect_uri: opts.redirectUri,
      code_verifier: opts.codeVerifier,
    }),
  })
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status}`)
  return parseTokenBody(await res.json())
}

export async function refreshAccessToken(
  tokenEndpoint: string,
  opts: { clientId: string; refreshToken: string },
  signal?: AbortSignal,
): Promise<TokenResponse> {
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: opts.clientId,
      refresh_token: opts.refreshToken,
    }),
  })
  const body = await res.json().catch(() => ({}))
  if (body.error === 'invalid_grant') throw new InvalidGrantError()
  if (!res.ok) throw new Error(`refresh failed: HTTP ${res.status}`)
  return parseTokenBody(body)
}
