import z from "@deepseek-ai/schemastery";
import { Command } from "commander";
import { spawn } from "node:child_process";
import { parseCmdline } from "@deepseek-ai/dsh-cmdline";
import * as mcpClient from "@deepseek-ai/dsh-mcp-client";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
//#region src/notion-token-store.ts
const REF = credentialRef("NOTION_OAUTH");
var NotionTokenStore = class {
	credentials;
	constructor(credentials) {
		this.credentials = credentials;
	}
	async load() {
		const resolved = await this.credentials.resolve(REF);
		if (!resolved) return void 0;
		try {
			return JSON.parse(resolved.value);
		} catch {
			return;
		}
	}
	async save(tokens) {
		await this.credentials.set(REF, JSON.stringify(tokens));
	}
	async clear() {
		await this.credentials.unset(REF);
	}
};
//#endregion
//#region src/notion-oauth.ts
function base64url(buf) {
	return buf.toString("base64url");
}
function generateVerifier() {
	return base64url(randomBytes(32));
}
function computeChallenge(verifier) {
	return base64url(createHash("sha256").update(verifier).digest());
}
function generateState() {
	return base64url(randomBytes(16));
}
async function fetchJson(url, init) {
	const res = await fetch(url, init);
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	return res.json();
}
async function discoverOAuth(resourceBaseUrl) {
	const authServer = (await fetchJson(`${new URL(resourceBaseUrl).origin}/.well-known/oauth-protected-resource`)).authorization_servers?.[0];
	if (!authServer) throw new Error("OAuth discovery: no authorization_servers advertised");
	const meta = await fetchJson(`${authServer}/.well-known/oauth-authorization-server`);
	return {
		authorizationEndpoint: meta.authorization_endpoint,
		tokenEndpoint: meta.token_endpoint,
		registrationEndpoint: meta.registration_endpoint
	};
}
async function registerClient(registrationEndpoint, redirectUris) {
	const res = await fetch(registrationEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			client_name: "dsh-notion-mcp",
			redirect_uris: redirectUris,
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code", "refresh_token"]
		})
	});
	if (!res.ok) throw new Error(`DCR failed: HTTP ${res.status}`);
	return { clientId: (await res.json()).client_id };
}
var InvalidGrantError = class extends Error {
	constructor() {
		super("invalid_grant: refresh token expired or rotated away — re-authorize required");
	}
};
function buildAuthorizeUrl(authorizationEndpoint, opts) {
	const url = new URL(authorizationEndpoint);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", opts.clientId);
	url.searchParams.set("redirect_uri", opts.redirectUri);
	url.searchParams.set("state", opts.state);
	url.searchParams.set("code_challenge", opts.codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	return url.toString();
}
function parseTokenBody(body) {
	const accessToken = body.access_token;
	const expiresIn = body.expires_in;
	if (typeof accessToken !== "string" || accessToken.length === 0) throw new Error("token response missing access_token");
	if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error("token response missing or invalid expires_in");
	return {
		accessToken,
		refreshToken: body.refresh_token,
		expiresIn,
		identity: body.user_id ? {
			userId: body.user_id,
			workspaceId: body.workspace_id
		} : void 0
	};
}
async function exchangeCode(tokenEndpoint, opts) {
	const res = await fetch(tokenEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: opts.clientId,
			code: opts.code,
			redirect_uri: opts.redirectUri,
			code_verifier: opts.codeVerifier
		})
	});
	if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status}`);
	return parseTokenBody(await res.json());
}
async function refreshAccessToken(tokenEndpoint, opts) {
	const res = await fetch(tokenEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			client_id: opts.clientId,
			refresh_token: opts.refreshToken
		})
	});
	const body = await res.json().catch(() => ({}));
	if (body.error === "invalid_grant") throw new InvalidGrantError();
	if (!res.ok) throw new Error(`refresh failed: HTTP ${res.status}`);
	return parseTokenBody(body);
}
//#endregion
//#region src/login-server.ts
function startLoginServer(expectedState, port) {
	return new Promise((resolveListen, rejectListen) => {
		let resolveWait;
		let rejectWait;
		const wait = new Promise((resolve, reject) => {
			resolveWait = resolve;
			rejectWait = reject;
		});
		wait.catch(() => {});
		const server = createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			if (url.pathname !== "/callback") {
				res.writeHead(404).end();
				return;
			}
			const respond = (body, status = 200) => {
				res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
				res.end(body);
				server.close();
			};
			const error = url.searchParams.get("error");
			if (error) {
				respond("<h1>授权失败</h1>");
				rejectWait(/* @__PURE__ */ new Error(`OAuth error: ${error}`));
				return;
			}
			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state");
			if (!code || !state) {
				respond("<h1>缺少 code 或 state</h1>");
				rejectWait(/* @__PURE__ */ new Error("missing code or state"));
				return;
			}
			if (state !== expectedState) {
				respond("<h1>state 校验失败</h1>");
				rejectWait(/* @__PURE__ */ new Error("state mismatch"));
				return;
			}
			respond("<h1>授权成功，可关闭此页</h1>");
			resolveWait({
				code,
				state
			});
		});
		server.on("error", rejectListen);
		server.listen(port, "127.0.0.1", () => {
			const actual = server.address().port;
			resolveListen({
				redirectUri: `http://127.0.0.1:${actual}/callback`,
				wait
			});
		});
	});
}
//#endregion
//#region src/index.ts
const name = "notion";
const inject = [
	"cmdlineArgs",
	"credentials",
	"commands"
];
const Config = z.object({
	mcpUrl: z.string().default("https://mcp.notion.com/mcp"),
	port: z.number().default(53007)
});
const LOGIN_COMMAND = "notion-login";
const LOGOUT_COMMAND = "notion-logout";
async function unmount(slot) {
	if (slot.child) {
		await slot.child.dispose();
		slot.child = void 0;
	}
}
async function mountMcp(ctx, accessToken, config, slot) {
	await unmount(slot);
	slot.child = ctx.plugin(mcpClient, {
		transport: "streamable-http",
		serverName: "notion",
		url: config.mcpUrl,
		headers: { Authorization: `Bearer ${accessToken}` },
		toolCallTimeoutMs: 6e4,
		failOnStartupError: false
	});
}
async function refreshAndMount(ctx, store, config, slot, refreshMutex) {
	if (refreshMutex.running) return;
	refreshMutex.running = true;
	try {
		const tokens = await store.load();
		if (!tokens) return;
		const disc = await discoverOAuth(config.mcpUrl);
		let next;
		try {
			next = await refreshAccessToken(disc.tokenEndpoint, {
				clientId: tokens.clientId,
				refreshToken: tokens.refreshToken
			});
		} catch (e) {
			if (e instanceof InvalidGrantError) {
				await store.clear();
				await unmount(slot);
				console.error("[dsh-notion-mcp] invalid_grant: run `dsh notion login` to re-authorize");
				return;
			}
			throw e;
		}
		const refreshed = {
			accessToken: next.accessToken,
			refreshToken: next.refreshToken ?? tokens.refreshToken,
			expiresAt: Date.now() + next.expiresIn * 1e3,
			clientId: tokens.clientId
		};
		await store.save(refreshed);
		await mountMcp(ctx, refreshed.accessToken, config, slot);
	} finally {
		refreshMutex.running = false;
	}
}
function openExternalBrowser(url) {
	try {
		if (process.platform === "darwin") {
			spawn("open", [url], {
				detached: true,
				stdio: "ignore"
			}).unref();
			return;
		}
		if (process.platform === "win32") {
			spawn("cmd", [
				"/c",
				"start",
				"",
				url
			], {
				detached: true,
				stdio: "ignore"
			}).unref();
			return;
		}
		spawn("xdg-open", [url], {
			detached: true,
			stdio: "ignore"
		}).unref();
	} catch (error) {
		console.error("[dsh-notion-mcp] failed to open browser automatically, open URL manually:", error);
	}
}
async function runLogout(ctx, store, slot) {
	await store.clear();
	await unmount(slot);
	console.log("[dsh-notion-mcp] logged out — Notion tools removed");
}
async function runLogin(ctx, store, config, slot) {
	const redirectBase = `http://127.0.0.1:${config.port}/callback`;
	const disc = await discoverOAuth(config.mcpUrl);
	const { clientId } = await registerClient(disc.registrationEndpoint, [redirectBase]);
	const verifier = generateVerifier();
	const state = generateState();
	const authorizeUrl = buildAuthorizeUrl(disc.authorizationEndpoint, {
		clientId,
		redirectUri: redirectBase,
		state,
		codeChallenge: computeChallenge(verifier)
	});
	console.log(`[dsh-notion-mcp] open this URL to authorize Notion:\n${authorizeUrl}`);
	openExternalBrowser(authorizeUrl);
	const { wait } = await startLoginServer(state, config.port);
	const cb = await wait;
	const tokens = await exchangeCode(disc.tokenEndpoint, {
		clientId,
		code: cb.code,
		redirectUri: redirectBase,
		codeVerifier: verifier
	});
	if (!tokens.refreshToken) throw new Error("authorization response missing refresh_token — cannot persist a usable token");
	const stored = {
		accessToken: tokens.accessToken,
		refreshToken: tokens.refreshToken,
		expiresAt: Date.now() + tokens.expiresIn * 1e3,
		clientId
	};
	await store.save(stored);
	await mountMcp(ctx, stored.accessToken, config, slot);
	console.log("[dsh-notion-mcp] authorized — Notion tools now available as mcp__notion__*");
}
function apply(ctx, config) {
	const store = new NotionTokenStore(ctx.credentials);
	const slot = {};
	const refreshMutex = { running: false };
	const isNotionCommand = (ctx.cmdlineArgs?.get() ?? [])[0] === "notion";
	ctx.commands.register({
		name: LOGIN_COMMAND,
		description: "Start Notion OAuth login flow",
		recordInput: false,
		handler: ({ signal }) => {
			if (signal.aborted) return {
				kind: "error",
				text: "login cancelled"
			};
			runLogin(ctx, store, config, slot).catch((e) => console.error(e));
			return {
				kind: "success",
				text: "Notion OAuth login started, check your browser."
			};
		}
	});
	ctx.commands.register({
		name: LOGOUT_COMMAND,
		description: "Logout from Notion and uninstall MCP tools",
		recordInput: false,
		handler: ({ signal }) => {
			if (signal.aborted) return {
				kind: "error",
				text: "logout cancelled"
			};
			runLogout(ctx, store, slot).catch((e) => console.error(e));
			return {
				kind: "success",
				text: "Notion logged out, MCP tools removed."
			};
		}
	});
	if (!isNotionCommand) (async () => {
		const tokens = await store.load();
		if (!tokens) {
			console.error("[dsh-notion-mcp] not authorized — run `dsh notion login`");
			return;
		}
		if (tokens.expiresAt > Date.now() + 6e4) {
			await mountMcp(ctx, tokens.accessToken, config, slot);
			scheduleRefresh(ctx, store, config, slot, refreshMutex, tokens.expiresAt);
		} else {
			await refreshAndMount(ctx, store, config, slot, refreshMutex);
			const fresh = await store.load();
			if (fresh) scheduleRefresh(ctx, store, config, slot, refreshMutex, fresh.expiresAt);
		}
	})().catch((e) => {
		console.error(e);
		scheduleRefresh(ctx, store, config, slot, refreshMutex, Date.now() + 6e4);
	});
	if (isNotionCommand) {
		const program = new Command();
		const notion = program.command("notion");
		notion.command("login").description("Authorize Notion via the official MCP OAuth flow").action(() => {
			runLogin(ctx, store, config, slot).then(() => ctx.appExit?.(0)).catch((e) => {
				console.error(e);
				ctx.appExit?.(1);
			});
		});
		notion.command("logout").description("Logout from Notion and uninstall MCP tools").action(() => {
			runLogout(ctx, store, slot).then(() => ctx.appExit?.(0)).catch((e) => {
				console.error(e);
				ctx.appExit?.(1);
			});
		});
		parseCmdline(ctx, program);
	}
	ctx.effect(() => () => {
		slot.child?.dispose();
	});
}
function scheduleRefresh(ctx, store, config, slot, refreshMutex, expiresAt) {
	const delay = Math.max(6e4, expiresAt - Date.now() - 3e5);
	const timer = setTimeout(() => {
		refreshAndMount(ctx, store, config, slot, refreshMutex).then(() => store.load()).then((t) => {
			if (t) scheduleRefresh(ctx, store, config, slot, refreshMutex, t.expiresAt);
		}).catch((e) => {
			console.error(e);
			scheduleRefresh(ctx, store, config, slot, refreshMutex, Date.now() + 6e4);
		});
	}, delay);
	ctx.effect(() => () => clearTimeout(timer));
}
//#endregion
export { Config, apply, inject, name };
