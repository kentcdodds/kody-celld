// Shared helpers for the smoke workloads. Plain Node (>= 20), no dependencies.
import { readdir, readFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'

export const baseUrl = (process.env.KODY_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
export const adminToken = process.env.KODY_ADMIN_TOKEN ?? 'dev-admin-token'

export class SmokeError extends Error {}

export function assert(condition, message, extra) {
	if (condition) return
	const detail = extra === undefined ? '' : `\n${JSON.stringify(extra, null, 2)}`
	throw new SmokeError(`${message}${detail}`)
}

export function log(step, detail) {
	const suffix = detail === undefined ? '' : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
	console.log(`  • ${step}${suffix}`)
}

async function request(pathname, { method = 'GET', token, body } = {}) {
	const response = await fetch(`${baseUrl}${pathname}`, {
		method,
		headers: {
			...(token ? { authorization: `Bearer ${token}` } : {}),
			...(body !== undefined ? { 'content-type': 'application/json' } : {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	const text = await response.text()
	let json
	try {
		json = JSON.parse(text)
	} catch {
		json = { raw: text }
	}
	return { status: response.status, json }
}

export const admin = {
	createUser: (email) =>
		request('/admin/users', { method: 'POST', token: adminToken, body: { email, label: 'smoke' } }),
	approveHost: (userId, host) =>
		request(`/admin/users/${encodeURIComponent(userId)}/secret-hosts`, {
			method: 'POST',
			token: adminToken,
			body: { host },
		}),
	revokeHost: (userId, host) =>
		request(`/admin/users/${encodeURIComponent(userId)}/secret-hosts/${encodeURIComponent(host)}`, {
			method: 'DELETE',
			token: adminToken,
		}),
	listHosts: (userId) => request(`/admin/users/${encodeURIComponent(userId)}/secret-hosts`, { token: adminToken }),
	dispatchJobs: () => request('/admin/jobs', { method: 'POST', token: adminToken }),
	jobs: (userId) => request(`/admin/users/${encodeURIComponent(userId)}/jobs`, { token: adminToken }),
	runs: (userId, limit = 20) =>
		request(`/admin/users/${encodeURIComponent(userId)}/runs?limit=${limit}`, { token: adminToken }),
	limits: () => request('/admin/limits', { token: adminToken }),
	ai: () => request('/admin/ai', { token: adminToken }),
	memories: (userId, limit = 50) =>
		request(`/admin/users/${encodeURIComponent(userId)}/memories?limit=${limit}`, { token: adminToken }),
	reindexMemories: (userId) =>
		request(`/admin/users/${encodeURIComponent(userId)}/memories/reindex`, { method: 'POST', token: adminToken }),
	usage: (userId, days = 7) =>
		request(`/admin/users/${encodeURIComponent(userId)}/usage?days=${days}`, { token: adminToken }),
	setQuota: (userId, override) =>
		request(`/admin/users/${encodeURIComponent(userId)}/quota`, { method: 'PUT', token: adminToken, body: override }),
	clearQuota: (userId) =>
		request(`/admin/users/${encodeURIComponent(userId)}/quota`, { method: 'DELETE', token: adminToken }),
	invite: (userId, reset = false) =>
		request(`/admin/users/${encodeURIComponent(userId)}/invite`, {
			method: 'POST',
			token: adminToken,
			body: { reset },
		}),
	audit: (filter = {}) => {
		const params = new URLSearchParams(Object.entries(filter).map(([k, v]) => [k, String(v)]))
		return request(`/admin/audit?${params}`, { token: adminToken })
	},
}

export class McpClient {
	#id = 0
	constructor(token) {
		this.token = token
	}

	async rpc(method, params) {
		const id = ++this.#id
		const { status, json } = await request('/mcp', {
			method: 'POST',
			token: this.token,
			body: { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) },
		})
		assert(status === 200, `MCP ${method} returned HTTP ${status}`, json)
		assert(!json.error, `MCP ${method} returned a JSON-RPC error`, json.error)
		return json.result
	}

	async initialize() {
		const result = await this.rpc('initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'kody-celld-smoke', version: '0.1.0' },
		})
		await request('/mcp', {
			method: 'POST',
			token: this.token,
			body: { jsonrpc: '2.0', method: 'notifications/initialized' },
		})
		return result
	}

	async tool(name, args) {
		const result = await this.rpc('tools/call', { name, arguments: args })
		return { isError: result.isError === true, payload: result.structuredContent, content: result.content }
	}

	async search(args) {
		const { isError, payload } = await this.tool('search', args)
		assert(!isError, 'search returned isError', payload)
		return payload
	}

	/** Runs `code` and returns the execute payload (throws only on transport errors). */
	async execute(code, params = {}, extra = {}) {
		const { payload } = await this.tool('execute', { code, params, ...extra })
		return payload
	}

	/** Runs `code`, asserting a successful run, and returns its result. */
	async run(code, params = {}, extra = {}) {
		const payload = await this.execute(code, params, extra)
		assert(payload.ok, 'execute failed', { error: payload.error, logs: payload.logs, gateway: payload.gateway })
		return payload.result
	}

	/**
	 * Calls a capability directly over the REST surface (POST /api/call/:name),
	 * i.e. from outside a run. Needed for host-only capabilities such as
	 * packageRun and jobRunNow, which are not available to sandbox code.
	 */
	async callDirect(capability, args = {}) {
		const { status, json } = await request(`/api/call/${capability}`, { method: 'POST', token: this.token, body: args })
		assert(status === 200 && json.ok, `direct call ${capability} failed (HTTP ${status})`, json)
		return json.result
	}

	/** Like callDirect but returns the raw outcome so callers can assert on refusals. */
	async callDirectRaw(capability, args = {}) {
		const { status, json } = await request(`/api/call/${capability}`, { method: 'POST', token: this.token, body: args })
		return { status, isError: !(status === 200 && json.ok), payload: json }
	}

	/** Calls a single capability from inside an execute run. */
	async call(capability, args = {}) {
		return this.run(
			`import { kody } from 'kody:runtime'\nexport default async function main(args) { return await kody.${capability}(args) }`,
			args,
		)
	}
}

/**
 * A cookie-jar HTTP client that behaves like a browser for the web UI smoke:
 * stores Set-Cookie, sends Origin on POSTs, never follows redirects (callers
 * assert on Location), and parses HTML forms just enough to pull hidden inputs.
 */
export class Browser {
	#jar = new Map()

	cookie(name) {
		return this.#jar.get(name) ?? null
	}

	#store(setCookies) {
		for (const header of setCookies) {
			const [pair, ...attrs] = header.split(';')
			const eq = pair.indexOf('=')
			const name = pair.slice(0, eq).trim()
			const value = pair.slice(eq + 1).trim()
			const expired = attrs.some((a) => /^\s*max-age=0$/i.test(a))
			if (expired || value === '') this.#jar.delete(name)
			else this.#jar.set(name, value)
		}
	}

	async fetch(pathnameOrUrl, { method = 'GET', form, headers = {}, accept = 'text/html' } = {}) {
		const url = new URL(pathnameOrUrl.startsWith('http') ? pathnameOrUrl : `${baseUrl}${pathnameOrUrl}`)
		const cookie = [...this.#jar].map(([k, v]) => `${k}=${v}`).join('; ')
		const body = form ? new URLSearchParams(form).toString() : null
		// node:http rather than fetch(): undici pins `sec-fetch-mode: cors`, and the
		// server treats that as an API call, not a browser navigation.
		const response = await new Promise((resolve, reject) => {
			const req = httpRequest(
				url,
				{
					method,
					headers: {
						accept,
						'sec-fetch-mode': 'navigate',
						...(cookie ? { cookie } : {}),
						...(body !== null
							? {
									'content-type': 'application/x-www-form-urlencoded',
									'content-length': String(Buffer.byteLength(body)),
									origin: baseUrl,
								}
							: {}),
						...headers,
					},
				},
				(res) => {
					const chunks = []
					res.on('data', (chunk) => chunks.push(chunk))
					res.on('end', () =>
						resolve({
							status: res.statusCode,
							location: res.headers.location ?? null,
							headers: new Headers(
								Object.entries(res.headers).flatMap(([k, v]) =>
									k === 'set-cookie' ? [] : [[k, Array.isArray(v) ? v.join(', ') : String(v)]],
								),
							),
							setCookies: res.headers['set-cookie'] ?? [],
							text: Buffer.concat(chunks).toString('utf8'),
						}),
					)
					res.on('error', reject)
				},
			)
			req.on('error', reject)
			if (body !== null) req.write(body)
			req.end()
		})
		this.#store(response.setCookies)
		return response
	}

	get(pathname, options) {
		return this.fetch(pathname, options)
	}

	post(pathname, form, options = {}) {
		return this.fetch(pathname, { ...options, method: 'POST', form })
	}
}

/** Pulls `<input type="hidden" name="…" value="…">` pairs out of a page (attribute order as rendered by src/web). */
export function hiddenInputs(htmlText) {
	const values = {}
	for (const [tag] of htmlText.matchAll(/<input\b[^>]*>/g)) {
		if (!/type="hidden"/.test(tag)) continue
		const name = /\bname="([^"]+)"/.exec(tag)?.[1]
		const value = /\bvalue="([^"]*)"/.exec(tag)?.[1] ?? ''
		if (name) values[name] = value.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&')
	}
	return values
}

export async function readPackageDir(dir) {
	const files = {}
	async function walk(current) {
		for (const entry of await readdir(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name)
			if (entry.isDirectory()) await walk(full)
			else files[path.relative(dir, full).split(path.sep).join('/')] = await readFile(full, 'utf8')
		}
	}
	await walk(dir)
	return files
}

export async function bootstrapUser(label = 'smoke') {
	const email = `${label}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}@example.test`
	const { status, json } = await admin.createUser(email)
	assert(status === 201, 'admin user creation failed', json)
	return { user: json.user, token: json.token, mcp: new McpClient(json.token) }
}

export function sha256(text) {
	return createHash('sha256').update(text).digest('hex')
}

/**
 * A local HTTP target that never echoes credentials back: it only reports a
 * hash and length of the Authorization header so the smoke can prove
 * injection happened without ever seeing the secret on the wire twice.
 */
export async function startEchoServer(port = Number(process.env.SMOKE_ECHO_PORT ?? 9797)) {
	// SMOKE_ECHO_HOST is the name the Kody runtime uses to reach this process
	// (host.docker.internal when Kody runs in Docker); SMOKE_ECHO_BIND is the
	// interface to listen on (0.0.0.0 for Docker, loopback otherwise).
	const host = process.env.SMOKE_ECHO_HOST ?? '127.0.0.1'
	const bind = process.env.SMOKE_ECHO_BIND ?? (host === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0')
	const seen = []
	const server = createServer(async (req, res) => {
		let body = ''
		for await (const chunk of req) body += chunk
		const authorization = req.headers.authorization ?? ''
		const record = {
			method: req.method,
			url: req.url,
			authorizationSha256: authorization ? sha256(authorization) : null,
			authorizationLength: authorization.length,
			bodySha256: body ? sha256(body) : null,
			bodyHadPlaceholder: body.includes('{{secret'),
			headerHadPlaceholder: authorization.includes('{{secret'),
		}
		seen.push(record)
		res.setHeader('content-type', 'application/json')
		res.end(JSON.stringify(record))
	})
	await new Promise((resolve) => server.listen(port, bind, resolve))
	return {
		url: `http://${host}:${port}`,
		host,
		seen,
		close: () => new Promise((resolve) => server.close(resolve)),
	}
}

export async function waitFor(description, predicate, { timeoutMs = 90_000, intervalMs = 3_000 } = {}) {
	const started = Date.now()
	for (;;) {
		const value = await predicate()
		if (value) return value
		if (Date.now() - started > timeoutMs) throw new SmokeError(`Timed out waiting for ${description}`)
		await new Promise((resolve) => setTimeout(resolve, intervalMs))
	}
}
