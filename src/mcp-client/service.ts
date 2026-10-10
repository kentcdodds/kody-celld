import { parseIntegrationUsage, usagePermits, type IntegrationUsage } from '../integrations/oauth.ts'
import { KodyError } from '../lib/errors.ts'
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import {
	callServerTool,
	discoverServer,
	httpStatusOf,
	isUnknownToolError,
	oauthPolicyFetch,
	redactSecrets,
	type McpToolResult,
} from './client.ts'
import {
	assertBrowserRedirect,
	beginMcpAuthorization,
	completeMcpAuthorization,
	mcpAuthorizeUrl,
	mcpOAuthScopes,
	mcpOAuthUrls,
	pickClientMode,
	probeMcpOAuth,
} from './oauth.ts'
import type { McpOAuthClient, McpOAuthClientMode, McpOAuthPending } from './oauth-store.ts'
import { assertMcpServerName, assertMcpUrl, normalizeBearerToken, type McpConfig } from './policy.ts'
import { assertResolvedHostAllowed } from './resolve.ts'
import {
	publicMcpServer,
	type McpDiscoveryOutcome,
	type McpServerRecord,
	type McpServerStore,
	type PublicMcpServer,
} from './store.ts'

export type McpServerCell = {
	mcpServerGet(name: string): Promise<McpServerRecord | null>
	mcpServerSave(input: Parameters<McpServerStore['save']>[0]): Promise<McpServerRecord>
	mcpServerSetDiscovery(input: { name: string; outcome: McpDiscoveryOutcome }): Promise<McpServerRecord>
	/** The call's Authorization: the bearer, or an OAuth access token (refreshed when expiring or forced). */
	mcpServerAuthorization(
		name: string,
		options?: { forceRefresh?: boolean; staleAccessToken?: string },
	): Promise<string | null>
	mcpServerOAuthLoad(name: string): Promise<{ client: McpOAuthClient | null; discovery: OAuthDiscoveryState | null }>
	mcpServerOAuthBegin(input: {
		name: string
		state: string
		verifier: string
		redirectUri: string
		serverOrigin: string
		client: McpOAuthClient | null
		discovery: OAuthDiscoveryState | null
	}): Promise<{ expiresAt: string }>
	mcpServerOAuthClaim(state: string): Promise<{
		pending: McpOAuthPending
		firstClaim: boolean
		expired: boolean
		client: McpOAuthClient | null
		discovery: OAuthDiscoveryState | null
	} | null>
	mcpServerOAuthComplete(input: {
		name: string
		tokens: OAuthTokens
		savedClient: OAuthClientInformationMixed | null
	}): Promise<McpServerRecord>
}

/** Every `mcpServer*` UserCell RPC with its real record type (the generated RPC stub types collapse `unknown` fields to `never`). */
export type McpAdminCell = McpServerCell & {
	mcpServerList(): Promise<Array<McpServerRecord>>
	mcpServerSetEnabled(input: { name: string; enabled: boolean }): Promise<McpServerRecord>
	mcpServerSetUsage(input: { name: string; usage: IntegrationUsage }): Promise<McpServerRecord>
	mcpServerRemove(name: string): Promise<{ removed: boolean }>
}

export type McpDeps = {
	cell: McpServerCell
	config: McpConfig
	maxResultBytes: number
	fetch?: typeof fetch
	publicUrl: string
}

const needsClientMessage =
	"This server's authorization server supports neither dynamic client registration nor client metadata documents; it needs a pre-registered OAuth client. Add one on /account/mcp-servers."

function nowIso() {
	return new Date().toISOString()
}

function oauthFetch(deps: McpDeps) {
	return oauthPolicyFetch(deps.config, deps.fetch)
}

/** A 401 without a bearer: is this an OAuth server, and can we identify ourselves to it? */
async function oauthOutcome(
	deps: McpDeps,
	record: McpServerRecord,
	challenge: string | null,
): Promise<McpDiscoveryOutcome> {
	let discovery
	try {
		discovery = await probeMcpOAuth(record.url, oauthFetch(deps), challenge)
	} catch (error) {
		const kody = KodyError.fromUnknown(error)
		return { error: { phase: 'authorize', message: kody?.message ?? String(error), at: nowIso() } }
	}
	if (!discovery) {
		return {
			error: {
				phase: 'connect',
				message: 'The server answered 401 and advertises no OAuth authorization server; pass bearerToken instead.',
				at: nowIso(),
			},
		}
	}
	const stored = await deps.cell.mcpServerOAuthLoad(record.name)
	const mode = pickClientMode(discovery, {
		hasPreregistered: stored.client?.mode === 'preregistered',
		clientMetadataUrl: mcpOAuthUrls(deps.publicUrl).clientMetadataUrl,
	})
	if (!mode)
		return { auth: { status: 'error', error: { phase: 'authorize', message: needsClientMessage, at: nowIso() } } }
	return {
		auth: {
			status: 'authenticating',
			error: {
				phase: 'authorize',
				message: `Authorization required at ${new URL(discovery.authorizationServerUrl).host}; open authUrl.`,
				at: nowIso(),
			},
		},
	}
}

/** Runs `run` with the server's Authorization; a rejected OAuth access token is refreshed once and the call retried once. */
async function withAuthorization<T>(
	deps: McpDeps,
	record: McpServerRecord,
	run: (authorization: string | null) => Promise<T>,
) {
	const authorization = await deps.cell.mcpServerAuthorization(record.name)
	try {
		return await run(authorization)
	} catch (error) {
		if (record.auth.kind !== 'oauth' || httpStatusOf(error) !== 401 || !authorization) throw error
		const refreshed = await deps.cell.mcpServerAuthorization(record.name, {
			forceRefresh: true,
			staleAccessToken: authorization.replace(/^Bearer\s+/, ''),
		})
		return run(refreshed)
	}
}

function unauthorizedWithLink(deps: McpDeps, name: string, error: unknown): never {
	const kody = KodyError.fromUnknown(error)
	if (kody?.code === 'mcp_server_unauthorized') {
		throw new KodyError(
			'mcp_server_unauthorized',
			`${kody.message.replace(/ Authorize it on \/account\/mcp-servers\.$/, '')} Authorize: ${mcpAuthorizeUrl(deps.publicUrl, name)}`,
			{ status: 401 },
		)
	}
	throw error
}

async function discover(deps: McpDeps, record: McpServerRecord): Promise<McpServerRecord> {
	let outcome: McpDiscoveryOutcome
	try {
		outcome = await withAuthorization(deps, record, (authorization) =>
			discoverServer({ url: record.url, authorization }, { config: deps.config, fetch: deps.fetch }),
		)
	} catch (error) {
		const kody = KodyError.fromUnknown(error)
		if (record.auth.kind !== 'bearer' && (kody?.code === 'mcp_server_unauthorized' || httpStatusOf(error) === 401)) {
			outcome = await oauthOutcome(deps, record, (kody?.details?.challenge as string | undefined) ?? null)
		} else {
			const phase = /tools\/list/.test(kody?.message ?? '') ? 'tools/list' : 'connect'
			outcome = { error: { phase, message: kody?.message ?? String(error), at: nowIso() } }
		}
	}
	return deps.cell.mcpServerSetDiscovery({ name: record.name, outcome })
}

/** An explicit usage on replace may keep or widen the stored grant list; unlocking or removing grants is UI-only. */
function assertUsageNotLooser(name: string, stored: IntegrationUsage, next: IntegrationUsage) {
	if (stored.mode === 'any') return
	const dropped = next.mode === 'any' ? [] : stored.packages.filter((p) => !next.packages.includes(p))
	if (next.mode === 'packages' && dropped.length === 0) return
	throw new KodyError(
		'mcp_server_locked',
		next.mode === 'any'
			? `MCP server "${name}" is locked to package(s) ${stored.packages.join(', ')}; unlocking it is done on /account/mcp-servers.`
			: `MCP server "${name}" grants package(s) ${dropped.join(', ')}; removing a grant is done on /account/mcp-servers.`,
		{ status: 403 },
	)
}

export async function addMcpServer(
	deps: McpDeps,
	input: { name: unknown; url: unknown; bearerToken?: unknown; enabled?: boolean; usage?: unknown; replace?: boolean },
): Promise<McpServerRecord> {
	const name = assertMcpServerName(input.name)
	if (typeof input.url !== 'string') throw new KodyError('invalid_args', 'url must be a string.')
	const url = assertMcpUrl(input.url, deps.config)
	const authorization =
		input.bearerToken === undefined || input.bearerToken === null ? null : normalizeBearerToken(input.bearerToken)
	const requested = input.usage === undefined ? null : parseIntegrationUsage(input.usage)
	const existing = input.replace === true ? await deps.cell.mcpServerGet(name) : null
	if (existing && requested) assertUsageNotLooser(name, existing.usage, requested)
	const usage: IntegrationUsage = requested ?? existing?.usage ?? { mode: 'any' }
	await assertResolvedHostAllowed(url, deps.config, deps.fetch ?? fetch)
	const saved = await deps.cell.mcpServerSave({
		name,
		url: url.href,
		enabled: input.enabled ?? existing?.enabled ?? true,
		usage,
		authorization,
		replace: input.replace === true,
	})
	return discover(deps, saved)
}

export async function refreshMcpServer(deps: McpDeps, name: string): Promise<McpServerRecord> {
	const record = await deps.cell.mcpServerGet(assertMcpServerName(name))
	if (!record) throw new KodyError('mcp_server_not_found', `MCP server "${name}" was not found.`, { status: 404 })
	try {
		assertMcpUrl(record.url, deps.config)
	} catch (error) {
		const kody = KodyError.fromUnknown(error)
		if (!kody) throw error
		return deps.cell.mcpServerSetDiscovery({
			name: record.name,
			outcome: { error: { phase: 'connect', message: kody.message, at: nowIso() } },
		})
	}
	return discover(deps, record)
}

function assertResultSize(result: McpToolResult, max: number, server: string, tool: string) {
	const size = new TextEncoder().encode(JSON.stringify(result)).length
	if (size > max) {
		throw new KodyError(
			'mcp_result_too_large',
			`${server}.${tool} returned ${size} bytes; the limit is ${max} (KODY_MCP_CONTENT_LIMIT_BYTES).`,
			{ status: 413 },
		)
	}
}

export async function callMcpTool(
	deps: McpDeps,
	input: { server: string; tool: string; args: unknown; packageName: string | null },
): Promise<McpToolResult & { authKind: 'none' | 'bearer' | 'oauth'; url: string }> {
	if (
		input.args !== undefined &&
		(typeof input.args !== 'object' || input.args === null || Array.isArray(input.args))
	) {
		throw new KodyError('invalid_args', `kody.mcp["${input.server}"].${input.tool}(input) takes one object argument.`)
	}
	const args = (input.args ?? {}) as Record<string, unknown>
	let record = await deps.cell.mcpServerGet(input.server)
	if (!record)
		throw new KodyError(
			'mcp_server_not_found',
			`MCP server "${input.server}" was not found. List servers with mcpServerList.`,
			{ status: 404 },
		)
	if (!record.enabled)
		throw new KodyError('mcp_server_disabled', `MCP server "${input.server}" is disabled.`, { status: 409 })
	if (!usagePermits(record.usage, input.packageName)) {
		const allowed = record.usage.mode === 'packages' ? record.usage.packages.join(', ') : ''
		throw new KodyError(
			'mcp_server_locked',
			`MCP server "${input.server}" is locked to package(s) ${allowed}; ${input.packageName ? `package "${input.packageName}"` : 'ad hoc execute'} may not use it.`,
			{ status: 403 },
		)
	}
	if (record.auth.kind === 'oauth' && record.status === 'authenticating') {
		unauthorizedWithLink(
			deps,
			record.name,
			new KodyError('mcp_server_unauthorized', `MCP server "${record.name}" needs authorization.`, { status: 401 }),
		)
	}
	assertMcpUrl(record.url, deps.config)
	if (!record.tools.some((t) => t.name === input.tool)) {
		record = await discover(deps, record)
		if (!record.tools.some((t) => t.name === input.tool)) {
			const known = record.tools
				.slice(0, 20)
				.map((t) => t.name)
				.join(', ')
			throw new KodyError(
				'mcp_tool_not_found',
				`MCP server "${input.server}" has no tool "${input.tool}". Known tools: ${known || '(none)'}.`,
				{ status: 404 },
			)
		}
	}
	const call = () =>
		withAuthorization(deps, record!, (authorization) =>
			callServerTool({ url: record!.url, authorization }, input.tool, args, { config: deps.config, fetch: deps.fetch }),
		).catch((error: unknown) => unauthorizedWithLink(deps, record!.name, error))
	let result: McpToolResult
	try {
		result = await call()
	} catch (error) {
		if (!isUnknownToolError(error, input.tool)) throw error
		record = await discover(deps, record)
		result = await call()
	}
	assertResultSize(result, deps.maxResultBytes, input.server, input.tool)
	return { ...result, authKind: record.auth.kind, url: record.url }
}

export async function reconnectMcpServer(deps: McpDeps, name: string): Promise<McpServerRecord> {
	const record = await deps.cell.mcpServerGet(assertMcpServerName(name))
	if (!record) throw new KodyError('mcp_server_not_found', `MCP server "${name}" was not found.`, { status: 404 })
	if (record.auth.kind === 'oauth') {
		try {
			await deps.cell.mcpServerAuthorization(record.name, { forceRefresh: true })
		} catch (error) {
			const kody = KodyError.fromUnknown(error)
			if (kody?.code !== 'mcp_server_unauthorized' && kody?.code !== 'mcp_call_failed') throw error
		}
	}
	return refreshMcpServer(deps, record.name)
}

async function requireOAuthServer(deps: McpDeps, name: string) {
	const record = await deps.cell.mcpServerGet(assertMcpServerName(name))
	if (!record || record.auth.kind === 'bearer') {
		throw new KodyError('mcp_server_not_found', `MCP server "${name}" is not an OAuth server.`, { status: 404 })
	}
	return record
}

export type McpOAuthDescription = {
	name: string
	url: string
	authorizationServerHost: string | null
	clientMode: McpOAuthClientMode | null
	scopes: Array<string>
	canContinue: boolean
	message: string | null
}

export async function describeMcpOAuth(deps: McpDeps, name: string): Promise<McpOAuthDescription> {
	const record = await requireOAuthServer(deps, name)
	const discovery = await probeMcpOAuth(record.url, oauthFetch(deps))
	if (!discovery) {
		return {
			name: record.name,
			url: record.url,
			authorizationServerHost: null,
			clientMode: null,
			scopes: [],
			canContinue: false,
			message: 'This server advertises no OAuth authorization server.',
		}
	}
	const stored = await deps.cell.mcpServerOAuthLoad(record.name)
	const clientMode = pickClientMode(discovery, {
		hasPreregistered: stored.client?.mode === 'preregistered',
		clientMetadataUrl: mcpOAuthUrls(deps.publicUrl).clientMetadataUrl,
	})
	return {
		name: record.name,
		url: record.url,
		authorizationServerHost: new URL(discovery.authorizationServerUrl).host,
		clientMode,
		scopes: mcpOAuthScopes(discovery),
		canContinue: clientMode !== null,
		message: clientMode ? null : needsClientMessage,
	}
}

export async function startMcpOAuth(
	deps: McpDeps,
	name: string,
): Promise<{ authorizationUrl: string; clientMode: McpOAuthClientMode }> {
	const record = await requireOAuthServer(deps, name)
	const fetchFn = oauthFetch(deps)
	const discovery = await probeMcpOAuth(record.url, fetchFn)
	if (!discovery) {
		throw new KodyError('mcp_oauth_failed', 'This server advertises no OAuth authorization server.', { status: 502 })
	}
	const urls = mcpOAuthUrls(deps.publicUrl)
	const stored = await deps.cell.mcpServerOAuthLoad(record.name)
	const clientMode = pickClientMode(discovery, {
		hasPreregistered: stored.client?.mode === 'preregistered',
		clientMetadataUrl: urls.clientMetadataUrl,
	})
	if (!clientMode) throw new KodyError('mcp_oauth_client_required', needsClientMessage, { status: 409 })
	const begun = await beginMcpAuthorization({
		serverUrl: record.url,
		urls,
		client: clientMode === 'metadata' ? null : (stored.client?.information ?? null),
		discovery,
		fetchFn,
	})
	assertBrowserRedirect(begun.authorizationUrl, deps.config)
	await deps.cell.mcpServerOAuthBegin({
		name: record.name,
		state: begun.state,
		verifier: begun.verifier,
		redirectUri: urls.callbackUrl,
		serverOrigin: new URL(record.url).origin,
		client: begun.savedClient ? { mode: stored.client?.mode ?? clientMode, information: begun.savedClient } : null,
		discovery: begun.discovery,
	})
	return { authorizationUrl: begun.authorizationUrl.href, clientMode }
}

export async function finishMcpOAuth(
	deps: McpDeps,
	input: { state: string; code: string | null; error: string | null; errorDescription: string | null },
): Promise<{ name: string; ok: boolean; replay: boolean; message: string | null }> {
	const invalid = () =>
		new KodyError(
			'mcp_oauth_state_invalid',
			'This authorization link is invalid or expired. Start again from /account/mcp-servers.',
			{ status: 400 },
		)
	const claimed = input.state ? await deps.cell.mcpServerOAuthClaim(input.state) : null
	if (!claimed) throw invalid()
	const { pending } = claimed
	if (!claimed.firstClaim) return { name: pending.serverName, ok: true, replay: true, message: null }
	const record = await deps.cell.mcpServerGet(pending.serverName)
	if (claimed.expired || !record || new URL(record.url).origin !== pending.serverOrigin) throw invalid()
	const park = async (phase: string, message: string) => {
		await deps.cell.mcpServerSetDiscovery({
			name: record.name,
			outcome: { auth: { status: 'authenticating', error: { phase, message, at: nowIso() } } },
		})
		return { name: record.name, ok: false, replay: false, message }
	}
	if (input.error) {
		return park(
			'authorize',
			`${input.error}${input.errorDescription ? `: ${input.errorDescription}` : ''}`.slice(0, 300),
		)
	}
	if (!input.code) return park('authorize', 'The provider returned no authorization code.')
	let done
	try {
		done = await completeMcpAuthorization({
			serverUrl: record.url,
			urls: mcpOAuthUrls(deps.publicUrl),
			client: claimed.client?.information ?? null,
			discovery: claimed.discovery,
			verifier: pending.verifier,
			state: pending.state,
			code: input.code,
			fetchFn: oauthFetch(deps),
		})
	} catch (error) {
		const secret = (claimed.client?.information as { client_secret?: string } | undefined)?.client_secret
		return park(
			'token exchange',
			redactSecrets(KodyError.fromUnknown(error)?.message ?? String(error), [input.code, pending.verifier, secret]),
		)
	}
	await deps.cell.mcpServerOAuthComplete({ name: record.name, tokens: done.tokens, savedClient: done.savedClient })
	const updated = await refreshMcpServer(deps, record.name)
	return {
		name: record.name,
		ok: updated.status === 'ready',
		replay: false,
		message: updated.lastError?.message ?? null,
	}
}

export type McpServerResult = PublicMcpServer & {
	authUrl: string | null
	oauthClientOrigin: string
	oauthCallbackUrl: string
	oauthClientMetadataUrl: string | null
	nextStep: string
}

export function mcpServerResult(record: McpServerRecord, publicUrl: string): McpServerResult {
	const urls = mcpOAuthUrls(publicUrl)
	const authUrl =
		record.auth.kind === 'oauth' && record.status !== 'ready' ? mcpAuthorizeUrl(publicUrl, record.name) : null
	const nextStep =
		record.status === 'ready'
			? `Connected with ${record.tools.length} tool(s). Call them as kody.mcp[${JSON.stringify(record.name)}].<tool>(input); search({ domain: "mcp:${record.name}" }) lists them.`
			: authUrl && record.status === 'authenticating'
				? `The server requires OAuth authorization. Ask the user to open ${authUrl} to authorize Kody. If the provider rejects Kody's origin or redirect URI, allow ${urls.clientOrigin} and ${urls.callbackUrl}${urls.clientMetadataUrl ? ` (client id ${urls.clientMetadataUrl})` : ''}. Then check mcpServerList.`
				: `Status "${record.status}": ${record.lastError?.message ?? 'unknown error'}${authUrl ? ` Authorize at ${authUrl}.` : ' Fix it and call mcpServerRefresh or mcpServerReconnect.'}`
	return {
		...publicMcpServer(record),
		authUrl,
		oauthClientOrigin: urls.clientOrigin,
		oauthCallbackUrl: urls.callbackUrl,
		oauthClientMetadataUrl: urls.clientMetadataUrl,
		nextStep,
	}
}
