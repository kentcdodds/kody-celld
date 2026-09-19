import { aiConfigFromEnv, describeAiConfig } from './ai/config.ts'
import { authenticateBearer, bearer, mcpUnauthorized, type Principal } from './auth/authenticate.ts'
import { blobConfigFromEnv, describeBlobConfig } from './blobs/config.ts'
import { verifyBlobUrlSignature } from './blobs/keys.ts'
import { BlobService, normalizeMetadata } from './blobs/service.ts'
import { browserConfigFromEnv, describeBrowserConfig } from './browser/config.ts'
import { describeNpmConfig, npmConfigFromEnv } from './execute/npm-config.ts'
import { describeEmailConfig } from './email/config.ts'
import { handleEmailEvents, handleEmailInbound, loadEmailConfig } from './email/service.ts'
import type { CapabilityContext } from './capabilities/define.ts'
import { getMemoryCell } from './capabilities/memory.ts'
import { capabilities, domains, runCapability } from './capabilities/registry.ts'
import { KODY_CELLD_VERSION, type Env } from './env.ts'
import { getUserCell } from './execute/engine.ts'
import { handleOAuthConnect } from './integrations/connect.ts'
import { dispatchDueJobs } from './jobs/dispatcher.ts'
import { recordAudit } from './lib/audit.ts'
import { errorStatus, errorToJson, KodyError } from './lib/errors.ts'
import { limitsFromEnv, parseQuotaOverride, quotasFromEnv } from './lib/limits.ts'
import { handleMcpRequest } from './mcp/server.ts'
import { handleOAuth, isOAuthRoute } from './oauth/routes.ts'
import { handleAccount, isAccountRoute } from './web/account.ts'
import { handleCommunity, isCommunityRoute } from './web/community.ts'
import { handleConsole, isConsoleRoute } from './web/console.ts'
import { html, page, redirect } from './web/html.ts'
import { readWebSession } from './web/session.ts'
import { handleSignin, isSigninRoute, issueSigninLink } from './web/signin.ts'
import { isLoopbackHost } from './secrets/host-policy.ts'
import { handleWebhookIngress } from './webhooks/ingress.ts'
import { webhookUrl } from './webhooks/urls.ts'

export { MemoryCell } from './cells/memory-cell.ts'
export { NpmCacheCell } from './cells/npm-cache-cell.ts'
export { PackageStorageCell } from './cells/package-storage-cell.ts'
export { RegistryCell } from './cells/registry-cell.ts'
export { UserCell } from './cells/user-cell.ts'
export { RuntimeHost } from './execute/runtime-host.ts'
export { FetchGateway } from './secrets/fetch-gateway.ts'

const DEV_ADMIN_TOKEN = 'dev-admin-token'
const DEV_MASTER_KEY = 'dev-master-key-only-for-celld-dev'

function json(payload: unknown, status = 200, headers: HeadersInit = {}) {
	return Response.json(payload, { status, headers })
}

function unauthorized(message: string) {
	return json({ error: 'unauthorized', message }, 401, { 'www-authenticate': 'Bearer realm="kody-celld"' })
}

function timingSafeEqual(a: string, b: string) {
	const enc = new TextEncoder()
	const ab = enc.encode(a)
	const bb = enc.encode(b)
	if (ab.byteLength !== bb.byteLength) return false
	return crypto.subtle.timingSafeEqual(ab, bb)
}

function insecureConfigError(env: Env, url: URL) {
	if (isLoopbackHost(url.hostname)) return null
	const problems: Array<string> = []
	if (env.KODY_MASTER_KEY === DEV_MASTER_KEY || env.KODY_MASTER_KEY.length < 32) {
		problems.push('KODY_MASTER_KEY must be a random value of at least 32 characters outside loopback.')
	}
	if (env.KODY_ADMIN_TOKEN === DEV_ADMIN_TOKEN || env.KODY_ADMIN_TOKEN.length < 24) {
		problems.push('KODY_ADMIN_TOKEN must be a random value of at least 24 characters outside loopback.')
	}
	return problems.length > 0 ? problems : null
}

function wantsHtml(request: Request) {
	const accept = request.headers.get('accept') ?? ''
	return accept.includes('text/html') && request.headers.get('sec-fetch-mode') !== 'cors'
}

function isWebRoute(pathname: string) {
	return (
		pathname === '/' ||
		isSigninRoute(pathname) ||
		isAccountRoute(pathname) ||
		isConsoleRoute(pathname) ||
		isCommunityRoute(pathname) ||
		pathname === '/oauth/authorize'
	)
}

function errorPage(error: unknown) {
	const body = errorToJson(error)
	const status = errorStatus(error)
	return page({
		title: status === 404 ? 'Not found' : 'Something went wrong',
		status,
		body: html`<div class="card">
			<p><strong>${body.error}</strong> — ${body.message}</p>
			<p><a href="/">Back</a></p>
		</div>`,
	})
}

/** Browser-based MCP clients preflight; the 401 challenge must be readable cross-origin too. */
function mcpPreflight() {
	return new Response(null, {
		status: 204,
		headers: {
			'access-control-allow-origin': '*',
			'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
			'access-control-allow-headers': 'authorization, content-type, mcp-session-id, mcp-protocol-version, accept',
			'access-control-expose-headers': 'www-authenticate, mcp-session-id',
			'access-control-max-age': '86400',
		},
	})
}

function capabilityContext(env: Env, ctx: ExecutionContext, auth: Principal): CapabilityContext {
	return {
		env,
		exports: ctx.exports,
		user: { id: auth.user.id, email: auth.user.email },
		userCell: auth.userCell,
		packageName: null,
		runId: null,
		baseUrl: env.KODY_PUBLIC_URL,
		fromRuntime: false,
	}
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
	if (!request.body) return {}
	try {
		const body = (await request.json()) as unknown
		return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
	} catch {
		throw new KodyError('invalid_json', 'Request body must be a JSON object.')
	}
}

async function handleAdmin(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
	const token = bearer(request)
	if (!token || !timingSafeEqual(token, env.KODY_ADMIN_TOKEN)) return unauthorized('Admin token required.')
	const registry = env.REGISTRY.getByName('registry')
	const segments = url.pathname.split('/').filter(Boolean) // ['admin', ...]
	const audit = (action: string, target: string | null, details: Record<string, unknown> | null = null) =>
		recordAudit(env, { actor: 'admin', action, target, details })

	if (segments.length === 2 && segments[1] === 'users') {
		if (request.method === 'GET') return json({ users: await registry.listUsers() })
		if (request.method === 'POST') {
			const body = await readJson(request)
			if (typeof body.email !== 'string') throw new KodyError('invalid_args', '"email" is required.')
			const created = await registry.createUser({
				email: body.email,
				...(typeof body.label === 'string' ? { label: body.label } : {}),
			})
			await getUserCell(env, created.user.id).init(created.user.id)
			await audit(created.created ? 'user.create' : 'token.issue', created.user.id, { email: created.user.email })
			return json(created, created.created ? 201 : 200)
		}
	}

	if (segments.length === 2 && segments[1] === 'jobs' && request.method === 'POST') {
		// Manual dispatcher tick, equivalent to the cron trigger firing now.
		const summary = await dispatchDueJobs(env, ctx.exports)
		await audit('jobs.dispatch', null, { ran: summary.ran.length })
		return json(summary)
	}

	if (segments.length === 2 && segments[1] === 'audit' && request.method === 'GET') {
		return json({
			entries: await registry.auditList({
				limit: Number(url.searchParams.get('limit') ?? 50),
				actor: url.searchParams.get('actor') ?? undefined,
				action: url.searchParams.get('action') ?? undefined,
			}),
		})
	}

	if (segments.length === 2 && segments[1] === 'limits' && request.method === 'GET') {
		return json({ limits: limitsFromEnv(env), quotaDefaults: quotasFromEnv(env) })
	}

	if (segments.length === 2 && segments[1] === 'ai' && request.method === 'GET') {
		return json({ ai: describeAiConfig(aiConfigFromEnv(env)) })
	}

	if (segments.length === 2 && segments[1] === 'blobs' && request.method === 'GET') {
		return json({ blobs: describeBlobConfig(blobConfigFromEnv(env)), bucketBound: env.BLOBS !== undefined })
	}

	if (segments.length === 2 && segments[1] === 'browser' && request.method === 'GET') {
		return json({ browser: describeBrowserConfig(browserConfigFromEnv(env)) })
	}

	if (segments.length === 2 && segments[1] === 'email' && request.method === 'GET') {
		return json({ email: describeEmailConfig(loadEmailConfig(env)) })
	}

	if (segments.length === 2 && segments[1] === 'npm-cache') {
		const cache = env.NPM_CACHE.get(env.NPM_CACHE.idFromName('npm-cache'))
		if (request.method === 'GET') {
			return json({ npm: describeNpmConfig(npmConfigFromEnv(env)), cache: await cache.stats() })
		}
		if (request.method === 'DELETE') {
			const result = await cache.clear()
			await audit('npm_cache.clear', null, { cleared: result.cleared, bytes: result.bytes })
			return json({ cleared: result.cleared, bytes: result.bytes })
		}
	}

	if (segments.length === 3 && segments[1] === 'secrets' && segments[2] === 'rekey' && request.method === 'POST') {
		// Master-key rotation step 2: re-seal every user's secrets with KODY_MASTER_KEY.
		const users = await registry.listUsers()
		const perUser: Array<{ userId: string; resealed: number; remaining: number }> = []
		let currentKeyId = ''
		for (const user of users) {
			const userCell = getUserCell(env, user.id)
			await userCell.init(user.id)
			const result = await userCell.secretRekey()
			currentKeyId = result.currentKeyId
			perUser.push({ userId: user.id, resealed: result.resealed, remaining: result.remaining })
		}
		const remaining = perUser.reduce((sum, u) => sum + u.remaining, 0)
		const resealed = perUser.reduce((sum, u) => sum + u.resealed, 0)
		await audit('secret.rekey', null, { currentKeyId, resealed, remaining })
		return json({
			currentKeyId,
			resealed,
			remaining,
			users: perUser,
			next:
				remaining === 0
					? 'Every secret uses the current key; KODY_MASTER_KEY_PREVIOUS can be removed.'
					: 'Some secrets could not be re-sealed; keep KODY_MASTER_KEY_PREVIOUS and check the logs.',
		})
	}

	if (segments.length >= 3 && segments[1] === 'users') {
		const userId = decodeURIComponent(segments[2] ?? '')
		const user = await registry.getUser(userId)
		if (!user) throw new KodyError('user_not_found', `User "${userId}" was not found.`, { status: 404 })
		const userCell = getUserCell(env, user.id)
		await userCell.init(user.id)
		const resource = segments[3]

		if (resource === 'tokens' && request.method === 'POST') {
			const body = await readJson(request)
			const label = typeof body.label === 'string' ? body.label : 'admin-issued'
			const issued = await registry.issueToken(user.id, label)
			await audit('token.issue', user.id, { label })
			return json({ token: issued }, 201)
		}
		if (resource === 'invite' && request.method === 'POST') {
			// One-time sign-in link for the web UI (sets a password); `reset: true` for an existing account.
			const body = await readJson(request)
			const kind = body.reset === true ? 'reset' : 'invite'
			const link = await issueSigninLink(env, { userId: user.id, kind })
			await audit('user.invite', user.id, { kind })
			return json({ ...link, kind }, 201)
		}
		if (resource === 'signout' && request.method === 'POST') {
			await registry.sessionRevoke(user.id, null)
			await registry.oauthGrantRevokeAll(user.id)
			await audit('user.signout_everywhere', user.id)
			return json({ ok: true })
		}
		if (resource === 'secret-hosts') {
			if (request.method === 'GET') return json({ hosts: await userCell.secretHostList() })
			if (request.method === 'POST') {
				const body = await readJson(request)
				if (typeof body.host !== 'string') throw new KodyError('invalid_args', '"host" is required.')
				const approved = await userCell.secretHostApprove({ host: body.host, approvedBy: 'admin' })
				await audit('secret_host.approve', user.id, { host: approved.host })
				return json(approved, 201)
			}
			if (request.method === 'DELETE' && segments[4]) {
				const revoked = await userCell.secretHostRevoke({ host: decodeURIComponent(segments[4]) })
				await audit('secret_host.revoke', user.id, { host: revoked.host, revoked: revoked.revoked })
				return json(revoked)
			}
		}
		if (resource === 'jobs' && request.method === 'GET') return json({ jobs: await userCell.jobList() })
		if (resource === 'webhooks' && request.method === 'GET') {
			return json({
				webhooks: await userCell.webhookList(),
				deliveries: await userCell.webhookDeliveryList({ limit: Number(url.searchParams.get('limit') ?? 20) }),
			})
		}
		if (resource === 'runs' && request.method === 'GET') {
			return json({ runs: await userCell.runList({ limit: Number(url.searchParams.get('limit') ?? 20) }) })
		}
		if (resource === 'usage' && request.method === 'GET') {
			return json(await userCell.usageGet({ days: Number(url.searchParams.get('days') ?? 7) }))
		}
		if (resource === 'blobs' && request.method === 'GET') {
			const listing = await userCell.blobIndexList({
				prefix: url.searchParams.get('prefix') ?? undefined,
				cursor: url.searchParams.get('cursor') ?? undefined,
				limit: Number(url.searchParams.get('limit') ?? 100),
			})
			return json({ ...listing, usage: await userCell.blobUsage() })
		}
		if (resource === 'memories') {
			const memoryCell = getMemoryCell(env, user.id)
			await memoryCell.init(user.id)
			if (request.method === 'GET' && !segments[4]) {
				return json({
					memories: await memoryCell.memoryList({ limit: Number(url.searchParams.get('limit') ?? 50) }),
					status: await memoryCell.aiStatus(),
				})
			}
			if (request.method === 'POST' && segments[4] === 'reindex') {
				const result = await memoryCell.memoryReindex()
				await audit('memory.reindex', user.id, { model: result.model, reindexed: result.reindexed })
				return json(result)
			}
		}
		if (resource === 'quota') {
			if (request.method === 'GET') return json(await userCell.quotaGet())
			if (request.method === 'PUT') {
				let override
				try {
					override = parseQuotaOverride(await readJson(request))
				} catch (error) {
					throw new KodyError('invalid_args', error instanceof Error ? error.message : String(error))
				}
				const result = await userCell.quotaSet(override)
				await audit('quota.set', user.id, { override: result.override })
				return json(result)
			}
			if (request.method === 'DELETE') {
				const result = await userCell.quotaSet(null)
				await audit('quota.clear', user.id)
				return json(result)
			}
		}
	}

	throw new KodyError('not_found', `No admin route for ${request.method} ${url.pathname}.`, { status: 404 })
}

async function handleApi(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
	const auth = await authenticateBearer(request, env)
	if (!auth) return unauthorized('A user API token or OAuth access token is required (Authorization: Bearer <token>).')
	const context = capabilityContext(env, ctx, auth)
	const segments = url.pathname.split('/').filter(Boolean) // ['api', ...]
	if (segments[1] === 'call' && segments[2] && request.method === 'POST') {
		const result = await runCapability(segments[2], await readJson(request), context)
		return json({ ok: true, result })
	}
	if (segments[1] === 'blobs' && segments.length > 2) {
		return handleBlobApi(request, context, segments.slice(2).map(decodeURIComponent).join('/'))
	}
	if (segments[1] === 'webhooks' && segments[2] && segments[3] === 'url' && request.method === 'GET') {
		// The only place the credential URL is ever shown; each reveal is audited.
		const handle = decodeURIComponent(segments[2])
		const revealed = await auth.userCell.webhookReveal(handle)
		await recordAudit(env, { actor: `user:${auth.user.id}`, action: 'webhook.reveal', target: handle, details: null })
		return json(
			{
				handle,
				url: webhookUrl(env.KODY_PUBLIC_URL, auth.user.id, handle, revealed.secret),
				previousExpiresAt: revealed.previousExpiresAt,
			},
			200,
			{ 'cache-control': 'no-store' },
		)
	}
	if (segments[1] === 'capabilities' && request.method === 'GET') {
		return json({
			domains,
			capabilities: capabilities.map((c) => ({
				name: c.name,
				domain: c.domain,
				description: c.description,
				inputSchema: c.inputSchema,
			})),
		})
	}
	throw new KodyError('not_found', `No API route for ${request.method} ${url.pathname}.`, { status: 404 })
}

function blobService(context: CapabilityContext) {
	return new BlobService({
		env: context.env,
		userCell: context.userCell,
		userId: context.user.id,
		packageName: null,
		baseUrl: context.baseUrl,
	})
}

function blobResponse(
	record: { contentType: string; size: number; etag: string; sha256: string },
	body: BodyInit | null,
) {
	return new Response(body, {
		headers: {
			'content-type': record.contentType,
			'content-length': String(record.size),
			etag: `"${record.etag}"`,
			'x-kody-sha256': record.sha256,
			'cache-control': 'private, no-store',
			'x-content-type-options': 'nosniff',
		},
	})
}

/**
 * Raw-bytes companion to the blob capabilities for clients that would rather
 * stream a file than base64 it through execute: PUT uploads the request body,
 * GET downloads, DELETE removes.
 */
async function handleBlobApi(request: Request, context: CapabilityContext, key: string): Promise<Response> {
	const blobs = blobService(context)
	if (request.method === 'PUT' || request.method === 'POST') {
		const body = new Uint8Array(await request.arrayBuffer())
		const metadataHeader = request.headers.get('x-kody-blob-metadata')
		let metadata: Record<string, string> | undefined
		if (metadataHeader) {
			try {
				metadata = normalizeMetadata(JSON.parse(metadataHeader))
			} catch (error) {
				if (error instanceof KodyError) throw error
				throw new KodyError('invalid_args', 'x-kody-blob-metadata must be a JSON object of strings.')
			}
		}
		const record = await blobs.put({
			key,
			body,
			contentType: request.headers.get('content-type')?.split(';')[0]?.trim() || undefined,
			metadata,
		})
		return json(record, 201)
	}
	if (request.method === 'GET' || request.method === 'HEAD') {
		const found = await blobs.get(key)
		if (!found) throw new KodyError('blob_not_found', `No blob at "${key}".`, { status: 404 })
		return blobResponse(found.record, request.method === 'HEAD' ? null : (found.body as BodyInit))
	}
	if (request.method === 'DELETE') {
		const record = await blobs.delete(key)
		return json({ key, deleted: record !== null })
	}
	throw new KodyError('not_found', `No blob route for ${request.method}.`, { status: 404 })
}

/** `GET /blobs/:userId/:key?exp=&sig=` — HMAC-signed download links minted by blobUrl. */
async function handleSignedBlob(request: Request, env: Env, url: URL): Promise<Response> {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		throw new KodyError('not_found', 'Signed blob links are read-only.', { status: 405 })
	}
	const segments = url.pathname.split('/').filter(Boolean) // ['blobs', userId, ...key]
	const userId = decodeURIComponent(segments[1] ?? '')
	const key = segments.slice(2).map(decodeURIComponent).join('/')
	const expiresAt = Number(url.searchParams.get('exp'))
	const signatureHex = url.searchParams.get('sig') ?? ''
	if (!userId || !key) throw new KodyError('not_found', 'Malformed blob link.', { status: 404 })
	const valid = await verifyBlobUrlSignature(env.KODY_MASTER_KEY, { userId, key, expiresAt, signatureHex })
	if (!valid) {
		throw new KodyError('blob_link_invalid', 'This blob link is invalid or has expired.', { status: 403 })
	}
	const userCell = getUserCell(env, userId)
	await userCell.init(userId)
	const blobs = new BlobService({ env, userCell, userId, packageName: null, baseUrl: env.KODY_PUBLIC_URL })
	const found = await blobs.get(key)
	if (!found) throw new KodyError('blob_not_found', 'This blob no longer exists.', { status: 404 })
	return blobResponse(found.record, request.method === 'HEAD' ? null : (found.body as BodyInit))
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url)
		try {
			const insecure = insecureConfigError(env, url)
			if (insecure) return json({ error: 'insecure_configuration', problems: insecure }, 500)

			if (url.pathname === '/' && wantsHtml(request)) {
				return redirect((await readWebSession(request, env)) ? '/account' : '/signin')
			}
			if (url.pathname === '/' || url.pathname === '/health') {
				return json({
					name: 'kody-celld',
					version: KODY_CELLD_VERSION,
					mcp: `${env.KODY_PUBLIC_URL}/mcp`,
					ok: true,
					time: new Date().toISOString(),
				})
			}
			if (url.pathname === '/mcp') {
				if (request.method === 'OPTIONS') return mcpPreflight()
				const auth = await authenticateBearer(request, env)
				if (!auth) {
					return mcpUnauthorized(
						env,
						request,
						bearer(request)
							? 'The bearer token is unknown, expired, or revoked.'
							: 'Authenticate with OAuth (see resource_metadata) or a Kody API token (Authorization: Bearer <token>).',
					)
				}
				return await handleMcpRequest(request, capabilityContext(env, ctx, auth), env)
			}
			if (isOAuthRoute(url.pathname)) return await handleOAuth(request, env, url)
			if (isSigninRoute(url.pathname)) return await handleSignin(request, env, url)
			if (isAccountRoute(url.pathname)) return await handleAccount(request, env, url)
			if (isConsoleRoute(url.pathname)) return await handleConsole(request, env, ctx, url)
			if (isCommunityRoute(url.pathname)) return await handleCommunity(request, env, url)
			if (url.pathname.startsWith('/blobs/')) return await handleSignedBlob(request, env, url)
			if (url.pathname.startsWith('/webhooks/')) return await handleWebhookIngress(request, env, ctx, url)
			if (url.pathname.startsWith('/email/inbound/')) return await handleEmailInbound(request, env, ctx, url)
			if (url.pathname.startsWith('/email/events/')) return await handleEmailEvents(request, env, ctx, url)
			if (url.pathname.startsWith('/connect/oauth/')) return await handleOAuthConnect(request, env, ctx, url)
			if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
				return await handleAdmin(request, env, ctx, url)
			}
			if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return await handleApi(request, env, ctx, url)
			return json({ error: 'not_found', message: `No route for ${url.pathname}.` }, 404)
		} catch (error) {
			if (isWebRoute(url.pathname) && wantsHtml(request)) return errorPage(error)
			return json(errorToJson(error), errorStatus(error))
		}
	},

	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		const summary = await dispatchDueJobs(env, ctx.exports)
		if (summary.ran.length > 0) console.log('[kody-celld] jobs dispatched', JSON.stringify(summary))
	},
} satisfies ExportedHandler<Env>
