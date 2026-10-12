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

function harness(overrides: Partial<AppOriginDeps> = {}) {
	const result = readAppConfig({ KODY_APP_BASE_URL: 'https://apps.example.com', KODY_PUBLIC_URL: publicUrl })
	assert.ok(result?.ok)
	const used = new Set<string>()
	const served: Array<{ url: string; cookie: string | null }> = []
	const deps: AppOriginDeps = {
		config: result.config,
		masterKey: key,
		publicUrl,
		burnHandoff: async (jti) => (used.has(jti) ? false : (used.add(jti), true)),
		sessionAlive: async (userId, sid) => userId === uid && sid === 'sess_live',
		getUser: async (id) => (id === uid ? { id, email: 'a@example.test', createdAt: '' } : null),
		serve: async (request, target) => {
			served.push({ url: request.url, cookie: request.headers.get('cookie') })
			return new Response(`app:${target.packageName}:${target.restPath}`)
		},
		now: () => now,
		...overrides,
	}
	const call = (url: string, init: RequestInit = {}) =>
		handleAppOriginRequest(new Request(url, init), new URL(url), deps)
	return { deps, call, served }
}

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
	it('swaps a valid handoff for a cookie and strips only the handoff', async () => {
		const { call, served } = harness()
		const token = await mintHandoff(key, { uid, pkg: 'notes', sid: 'sess_live' }, now)
		const response = await call(`${base}/?tab=2&__kody_handoff=${encodeURIComponent(token)}`)
		assert.equal(response.status, 302)
		assert.equal(response.headers.get('location'), `${base}/?tab=2`)
		const cookie = response.headers.get('set-cookie') ?? ''
		assert.match(cookie, /^kody_app_session=/)
		assert.match(cookie, new RegExp(`Path=/u/${uid}/`))
		assert.match(cookie, /HttpOnly/)
		assert.match(cookie, /Secure/)
		assert.match(cookie, /SameSite=Lax/)
		assert.equal(served.length, 0)
	})
	it('shows the open-from-Kody page for a replayed handoff without a session', async () => {
		const { call } = harness()
		const token = await mintHandoff(key, { uid, pkg: 'notes', sid: 'sess_live' }, now)
		await call(`${base}/?__kody_handoff=${encodeURIComponent(token)}`)
		const replay = await call(`${base}/?__kody_handoff=${encodeURIComponent(token)}`)
		assert.equal(replay.status, 403)
		assert.match(await replay.text(), /apps\/open\?package=notes/)
	})
	it('serves with a live session even when a stale handoff is present', async () => {
		const { call, served } = harness()
		const response = await call(`${base}/list?__kody_handoff=stale`, { headers: { cookie: await sessionCookie() } })
		assert.equal(response.status, 200)
		assert.equal(await response.text(), 'app:notes:/list')
		assert.equal(served.length, 1)
	})
	it('refuses a dead parent session, another user’s session, and no session', async () => {
		const { call } = harness()
		for (const cookie of [
			await sessionCookie('sess_dead'),
			await sessionCookie('sess_live', 'user_ffffffffffffffffffffffffffffffff'),
			'',
		]) {
			const response = await call(`${base}/`, { headers: cookie ? { cookie } : {} })
			assert.equal(response.status, 403, cookie)
		}
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
	it('uses Path=/ and no Secure in http subdomain mode', async () => {
		const result = readAppConfig({
			KODY_APP_BASE_URL: 'http://*.apps.localhost:8787',
			KODY_PUBLIC_URL: 'http://127.0.0.1:8787',
		})
		assert.ok(result?.ok)
		const { call } = harness({ config: result.config })
		const host = `http://user-0123456789abcdef0123456789abcdef.apps.localhost:8787`
		const token = await mintHandoff(key, { uid, pkg: 'notes', sid: 'sess_live' }, now)
		const response = await call(`${host}/packages/notes/?__kody_handoff=${encodeURIComponent(token)}`)
		const cookie = response.headers.get('set-cookie') ?? ''
		assert.match(cookie, /Path=\//)
		assert.doesNotMatch(cookie, /Secure/)
	})
})
