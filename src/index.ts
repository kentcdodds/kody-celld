import type { CapabilityContext } from './capabilities/define.ts'
import { capabilities, domains, runCapability } from './capabilities/registry.ts'
import { KODY_CELLD_VERSION, type Env } from './env.ts'
import { getUserCell } from './execute/engine.ts'
import { dispatchDueJobs } from './jobs/dispatcher.ts'
import { errorStatus, errorToJson, KodyError } from './lib/errors.ts'
import { handleMcpRequest } from './mcp/server.ts'
import { isLoopbackHost } from './secrets/host-policy.ts'

export { PackageStorageCell } from './cells/package-storage-cell.ts'
export { RegistryCell } from './cells/registry-cell.ts'
export { UserCell } from './cells/user-cell.ts'
export { RuntimeHost } from './execute/runtime-host.ts'
export { FetchGateway } from './secrets/fetch-gateway.ts'

const DEV_ADMIN_TOKEN = 'dev-admin-token'
const DEV_MASTER_KEY = 'dev-master-key-only-for-celld-dev'

function bearer(request: Request) {
	const header = request.headers.get('authorization') ?? ''
	const match = /^Bearer\s+(.+)$/i.exec(header)
	return match?.[1]?.trim() ?? null
}

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

async function authenticateUser(request: Request, env: Env) {
	const token = bearer(request)
	if (!token) return null
	const user = await env.REGISTRY.getByName('registry').resolveToken(token)
	if (!user) return null
	const userCell = getUserCell(env, user.id)
	await userCell.init(user.id)
	return { user, userCell }
}

function capabilityContext(
	env: Env,
	ctx: ExecutionContext,
	auth: NonNullable<Awaited<ReturnType<typeof authenticateUser>>>,
): CapabilityContext {
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
			return json(created, created.created ? 201 : 200)
		}
	}

	if (segments.length === 2 && segments[1] === 'jobs' && request.method === 'POST') {
		// Manual dispatcher tick, equivalent to the cron trigger firing now.
		return json(await dispatchDueJobs(env, ctx.exports))
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
			return json(
				{ token: await registry.issueToken(user.id, typeof body.label === 'string' ? body.label : 'admin-issued') },
				201,
			)
		}
		if (resource === 'secret-hosts') {
			if (request.method === 'GET') return json({ hosts: await userCell.secretHostList() })
			if (request.method === 'POST') {
				const body = await readJson(request)
				if (typeof body.host !== 'string') throw new KodyError('invalid_args', '"host" is required.')
				return json(await userCell.secretHostApprove({ host: body.host, approvedBy: 'admin' }), 201)
			}
			if (request.method === 'DELETE' && segments[4]) {
				return json(await userCell.secretHostRevoke({ host: decodeURIComponent(segments[4]) }))
			}
		}
		if (resource === 'jobs' && request.method === 'GET') return json({ jobs: await userCell.jobList() })
		if (resource === 'runs' && request.method === 'GET') {
			return json({ runs: await userCell.runList({ limit: Number(url.searchParams.get('limit') ?? 20) }) })
		}
	}

	throw new KodyError('not_found', `No admin route for ${request.method} ${url.pathname}.`, { status: 404 })
}

async function handleApi(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
	const auth = await authenticateUser(request, env)
	if (!auth) return unauthorized('A user API token is required (Authorization: Bearer <token>).')
	const context = capabilityContext(env, ctx, auth)
	const segments = url.pathname.split('/').filter(Boolean) // ['api', ...]
	if (segments[1] === 'call' && segments[2] && request.method === 'POST') {
		const result = await runCapability(segments[2], await readJson(request), context)
		return json({ ok: true, result })
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

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url)
		try {
			const insecure = insecureConfigError(env, url)
			if (insecure) return json({ error: 'insecure_configuration', problems: insecure }, 500)

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
				const auth = await authenticateUser(request, env)
				if (!auth) return unauthorized('A Kody API token is required (Authorization: Bearer <token>).')
				return handleMcpRequest(request, capabilityContext(env, ctx, auth), env)
			}
			if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return handleAdmin(request, env, ctx, url)
			if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return handleApi(request, env, ctx, url)
			return json({ error: 'not_found', message: `No route for ${url.pathname}.` }, 404)
		} catch (error) {
			return json(errorToJson(error), errorStatus(error))
		}
	},

	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		const summary = await dispatchDueJobs(env, ctx.exports)
		if (summary.ran.length > 0) console.log('[kody-celld] jobs dispatched', JSON.stringify(summary))
	},
} satisfies ExportedHandler<Env>
