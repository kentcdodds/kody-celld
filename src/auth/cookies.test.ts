import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	assertSameOrigin,
	clearCookie,
	cookiesAreSecure,
	csrfToken,
	readCookie,
	serializeCookie,
	sessionSignature,
} from './cookies.ts'

describe('cookies', () => {
	it('reads a named Cookie header value and decodes it', async () => {
		const request = new Request('https://kody.example', {
			headers: { cookie: 'a=1; kody_session=kss_abc%3Ddef; =ignored; bare' },
		})
		assert.equal(await readCookie(request, 'kody_session'), 'kss_abc=def')
		assert.equal(await readCookie(request, 'missing'), null)
		assert.equal(await readCookie(new Request('https://kody.example'), 'kody_session'), null)
	})

	it('round-trips values using the existing cookie encoding', async () => {
		const value = 'a=b.c%;d'
		const serialized = await serializeCookie('kody_session', value, { maxAgeSeconds: 60, secure: false })
		const cookieHeader = serialized.slice(0, serialized.indexOf(';'))
		const request = new Request('https://kody.example', {
			headers: { cookie: cookieHeader },
		})
		assert.equal(await readCookie(request, 'kody_session'), value)
	})

	it('reads console cookie values in their existing wire format', async () => {
		const request = new Request('https://kody.example', {
			headers: { cookie: 'kody_console=1700000000000.abcdef' },
		})
		assert.equal(await readCookie(request, 'kody_console'), '1700000000000.abcdef')
	})

	it('serializes HttpOnly SameSite=Lax cookies, Secure only for https deployments', async () => {
		const plain = await serializeCookie('kody_session', 'kss_x', { maxAgeSeconds: 60, secure: false })
		assert.equal(plain, 'kody_session=kss_x; HttpOnly; Max-Age=60; Path=/; SameSite=Lax')
		const secure = await serializeCookie('kody_console', 'v', {
			maxAgeSeconds: 1.9,
			secure: true,
			path: '/console',
		})
		assert.equal(secure, 'kody_console=v; HttpOnly; Max-Age=1; Path=/console; SameSite=Lax; Secure')
		assert.equal(await clearCookie('kody_session', false), 'kody_session=; HttpOnly; Max-Age=0; Path=/; SameSite=Lax')
		assert.equal(cookiesAreSecure('https://kody.example'), true)
		assert.equal(cookiesAreSecure('http://127.0.0.1:8787'), false)
		assert.equal(cookiesAreSecure('not a url'), false)
	})
})

describe('assertSameOrigin', () => {
	const publicUrl = 'https://kody.example'
	const post = (headers: Record<string, string>) =>
		new Request('https://kody.example/account/tokens', { method: 'POST', headers })

	it('accepts same-origin, own-origin behind a proxy, and header-less scripts', () => {
		assertSameOrigin(post({ origin: 'https://kody.example', 'sec-fetch-site': 'same-origin' }), publicUrl)
		assertSameOrigin(post({ origin: 'https://kody.example' }), publicUrl)
		assertSameOrigin(post({ 'sec-fetch-site': 'none' }), publicUrl)
		assertSameOrigin(post({}), publicUrl)
		assertSameOrigin(
			new Request('http://node-1:8088/account', { method: 'POST', headers: { origin: 'http://node-1:8088' } }),
			publicUrl,
		)
	})

	it('refuses cross-site and foreign-origin submissions', () => {
		assert.throws(() => assertSameOrigin(post({ 'sec-fetch-site': 'cross-site' }), publicUrl), /Cross-site/)
		assert.throws(() => assertSameOrigin(post({ 'sec-fetch-site': 'same-site' }), publicUrl), /Cross-site/)
		assert.throws(() => assertSameOrigin(post({ origin: 'https://evil.example' }), publicUrl), /Cross-site/)
		assert.throws(
			() => assertSameOrigin(post({ origin: 'https://kody.example.evil' }), publicUrl),
			(error: unknown) => (error as { status: number }).status === 403,
		)
	})
})

describe('session-bound signatures', () => {
	it('csrf tokens are deterministic per session and key, never the session id itself', async () => {
		const a = await csrfToken('master-a', 'sess_1')
		assert.equal(a, await csrfToken('master-a', 'sess_1'))
		assert.notEqual(a, await csrfToken('master-a', 'sess_2'))
		assert.notEqual(a, await csrfToken('master-b', 'sess_1'))
		assert.match(a, /^[0-9a-f]{40}$/)
		assert.ok(!a.includes('sess_1'))
	})

	it('payload signatures bind purpose, session, and the exact payload', async () => {
		const sig = await sessionSignature('master-a', 'sess_1', 'authorize', 'client_id=x&scope=openid')
		assert.equal(sig, await sessionSignature('master-a', 'sess_1', 'authorize', 'client_id=x&scope=openid'))
		assert.notEqual(sig, await sessionSignature('master-a', 'sess_1', 'authorize', 'client_id=y&scope=openid'))
		assert.notEqual(sig, await sessionSignature('master-a', 'sess_1', 'other', 'client_id=x&scope=openid'))
		assert.notEqual(sig, await sessionSignature('master-a', 'sess_2', 'authorize', 'client_id=x&scope=openid'))
		// Length is part of the signed message, so `a` + `b:c` cannot collide with `a:b` + `c`.
		assert.notEqual(await sessionSignature('k', 's', 'p', 'ab'), await sessionSignature('k', 's', 'p:a', 'b'))
		assert.notEqual(await csrfToken('master-a', 'sess_1'), sig)
	})
})
