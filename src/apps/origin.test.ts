import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readAppConfig } from './app-url.ts'
import { type AppOriginDeps, handleAppOriginRequest } from './origin.ts'
import { mintHandoff, signAppSession } from './tokens.ts'

const key = 'test-master-key-0123456789abcdef0123456789'
const uid = 'user_0123456789abcdef0123456789abcdef'
const publicUrl = 'https://kody.example.com'
const base = `https://apps.example.com/u/${uid}/packages/notes`
const now = 1_760_000_000_000
const st = 'c'.repeat(32)

function harness(overrides: Partial<AppOriginDeps> = {}) {
	const result = readAppConfig({ KODY_APP_BASE_URL: 'https://apps.example.com', KODY_PUBLIC_URL: publicUrl })
	assert.ok(result?.ok)
	const used = new Set<string>()
	const served: string[] = []
	const deps: AppOriginDeps = {
		config: result.config,
		masterKey: key,
		publicUrl,
		burnHandoff: async (jti) => (used.has(jti) ? false : (used.add(jti), true)),
		sessionAlive: async (userId, sid) => userId === uid && sid === 'sess_live',
		getUser: async (id) => (id === uid ? { id, email: 'a@example.test', createdAt: '' } : null),
		serve: async (request, target) => {
			served.push(request.url)
			return new Response(`app:${target.packageName}:${target.restPath}`)
		},
		now: () => now,
		...overrides,
	}
	const call = (url: string, init: RequestInit = {}) =>
		handleAppOriginRequest(new Request(url, init), new URL(url), deps)
	return { deps, call, served }
}

const stateCookie = (value = st) => `kody_app_state=${value}`
const handoffQuery = (token: string) => `__kody_handoff=${encodeURIComponent(token)}`
const mint = (state = st, pkg = 'notes', userId = uid) =>
	mintHandoff(key, { uid: userId, pkg, sid: 'sess_live', st: state }, now)

async function sessionCookie(sid = 'sess_live', userId = uid) {
	const value = await signAppSession(key, { uid: userId, sid, exp: now + 60_000 })
	return `kody_app_session=${encodeURIComponent(value)}`
}

describe('handleAppOriginRequest', () => {
	it('redirects the root to Kody and 404s unknown paths', async () => {
		const { call } = harness()
		const root = await call('https://apps.example.com/')
		assert.equal(root.status, 302)
		assert.equal(root.headers.get('location'), `${publicUrl}/`)
		assert.equal((await call('https://apps.example.com/mcp')).status, 404)
	})
	it('swaps a valid handoff for a cookie and keeps other query params', async () => {
		const { call, served } = harness()
		const token = await mint()
		const response = await call(`${base}/?tab=2&${handoffQuery(token)}`, { headers: { cookie: stateCookie() } })
		assert.equal(response.status, 302)
		assert.equal(response.headers.get('location'), `${base}/?tab=2`)
		const [cookie = '', cleared = ''] = response.headers.getSetCookie()
		assert.match(cookie, /^kody_app_session=/)
		assert.match(cookie, new RegExp(`Path=/u/${uid}/`))
		assert.match(cookie, /HttpOnly/)
		assert.match(cookie, /Secure/)
		assert.match(cookie, /SameSite=Lax/)
		assert.match(cleared, /^kody_app_state=;/)
		assert.match(cleared, /Max-Age=0/)
		assert.match(cleared, new RegExp(`Path=/u/${uid}/`))
		assert.equal(served.length, 0)
	})
	it('swaps only when the state cookie equals the token state, without burning on mismatch', async () => {
		const { call } = harness()
		const token = await mint(st)
		for (const headers of [{ cookie: stateCookie('d'.repeat(32)) }, {} as Record<string, string>]) {
			const refused = await call(`${base}/?${handoffQuery(token)}`, { headers })
			assert.equal(refused.status, 403)
			assert.match(await refused.text(), /apps\/open\?package=notes/)
			assert.deepEqual(refused.headers.getSetCookie(), [])
		}
		const ok = await call(`${base}/?${handoffQuery(token)}`, { headers: { cookie: stateCookie() } })
		assert.equal(ok.status, 302)
		assert.match(ok.headers.getSetCookie()[0] ?? '', /^kody_app_session=/)
	})
	it('shows the open-from-Kody page for a replayed handoff without a session', async () => {
		const { call } = harness()
		const token = await mint()
		await call(`${base}/?${handoffQuery(token)}`, { headers: { cookie: stateCookie() } })
		const replay = await call(`${base}/?${handoffQuery(token)}`, { headers: { cookie: stateCookie() } })
		assert.equal(replay.status, 403)
		assert.match(await replay.text(), /apps\/open\?package=notes/)
	})
	it('falls through for a handoff minted for another package or user', async () => {
		const { call } = harness()
		for (const token of [await mint(st, 'other'), await mint(st, 'notes', 'user_ffffffffffffffffffffffffffffffff')]) {
			const response = await call(`${base}/?${handoffQuery(token)}`, { headers: { cookie: stateCookie() } })
			assert.equal(response.status, 403)
			assert.deepEqual(response.headers.getSetCookie(), [])
		}
	})
	it('serves with a live session even when a stale handoff is present', async () => {
		const { call, served } = harness()
		const response = await call(`${base}/list?__kody_handoff=stale`, { headers: { cookie: await sessionCookie() } })
		assert.equal(response.status, 200)
		assert.equal(await response.text(), 'app:notes:/list')
		assert.equal(served.length, 1)
	})
	it('starts the state dance for a GET without a session and without a handoff', async () => {
		const { call, served } = harness()
		const response = await call(`${base}/x`)
		assert.equal(response.status, 302)
		const location = response.headers.get('location') ?? ''
		const match = new RegExp(`^${publicUrl}/apps/open\\?package=notes&state=([0-9a-f]{32})$`).exec(location)
		assert.ok(match, location)
		const cookie = response.headers.get('set-cookie') ?? ''
		assert.ok(cookie.startsWith(`kody_app_state=${match[1]}`), cookie)
		assert.match(cookie, /HttpOnly/)
		assert.match(cookie, /SameSite=Lax/)
		assert.match(cookie, /Secure/)
		assert.match(cookie, /Max-Age=300/)
		assert.match(cookie, new RegExp(`Path=/u/${uid}/`))
		assert.equal(response.headers.get('cache-control'), 'no-store')
		assert.equal(served.length, 0)
	})
	it('does not redirect a dead or foreign session into serving, and 403s non-GET and failed handoffs', async () => {
		const { call, served } = harness()
		for (const cookie of [
			await sessionCookie('sess_dead'),
			await sessionCookie('sess_live', 'user_ffffffffffffffffffffffffffffffff'),
		]) {
			const response = await call(`${base}/`, { headers: { cookie } })
			assert.equal(response.status, 302, cookie)
			assert.match(response.headers.get('location') ?? '', /\/apps\/open\?package=notes&state=/)
			const post = await call(`${base}/`, { method: 'POST', headers: { cookie }, body: 'x' })
			assert.equal(post.status, 403, cookie)
		}
		const noSession = await call(`${base}/save`, { method: 'POST', body: 'x' })
		assert.equal(noSession.status, 403)
		assert.match(await noSession.text(), /apps\/open\?package=notes/)
		const failed = await call(`${base}/?__kody_handoff=junk`)
		assert.equal(failed.status, 403)
		assert.equal(served.length, 0)
	})
	it('refuses a valid session whose user no longer exists', async () => {
		const { call } = harness({ getUser: async () => null })
		const response = await call(`${base}/`, { headers: { cookie: await sessionCookie() } })
		assert.equal(response.status, 403)
	})
	it('blocks cross-origin mutating requests but allows same-origin ones', async () => {
		const { call } = harness()
		const cookie = await sessionCookie()
		const cross = await call(`${base}/save`, {
			method: 'POST',
			headers: { cookie, origin: 'https://evil.example' },
			body: 'x',
		})
		assert.equal(cross.status, 403)
		const same = await call(`${base}/save`, {
			method: 'POST',
			headers: { cookie, origin: 'https://apps.example.com' },
			body: 'x',
		})
		assert.equal(same.status, 200)
	})
	it('refuses a mutating request marked same-site by the browser', async () => {
		const { call } = harness()
		const cookie = await sessionCookie()
		const response = await call(`${base}/save`, {
			method: 'POST',
			headers: { cookie, 'sec-fetch-site': 'same-site' },
			body: 'x',
		})
		assert.equal(response.status, 403)
		const ok = await call(`${base}/save`, {
			method: 'POST',
			headers: { cookie, 'sec-fetch-site': 'same-origin' },
			body: 'x',
		})
		assert.equal(ok.status, 200)
	})
	it('builds origins from the configured protocol behind a TLS-terminating proxy', async () => {
		const { call } = harness()
		const httpBase = base.replace('https:', 'http:')
		const post = await call(`${httpBase}/save`, {
			method: 'POST',
			headers: { cookie: await sessionCookie(), origin: 'https://apps.example.com' },
			body: 'x',
		})
		assert.equal(post.status, 200)
		const token = await mint()
		const swap = await call(`${httpBase}/?tab=2&${handoffQuery(token)}`, { headers: { cookie: stateCookie() } })
		assert.equal(swap.status, 302)
		assert.equal(swap.headers.get('location'), `${base}/?tab=2`)
	})
	it('uses Path=/ and no Secure in http subdomain mode', async () => {
		const result = readAppConfig({
			KODY_APP_BASE_URL: 'http://*.apps.localhost:8787',
			KODY_PUBLIC_URL: 'http://127.0.0.1:8787',
		})
		assert.ok(result?.ok)
		const { call } = harness({ config: result.config })
		const host = `http://user-0123456789abcdef0123456789abcdef.apps.localhost:8787`
		const token = await mint()
		const response = await call(`${host}/packages/notes/?${handoffQuery(token)}`, {
			headers: { cookie: stateCookie() },
		})
		for (const cookie of response.headers.getSetCookie()) {
			assert.match(cookie, /Path=\//)
			assert.doesNotMatch(cookie, /Secure/)
		}
		assert.equal(response.headers.getSetCookie().length, 2)
	})
})
