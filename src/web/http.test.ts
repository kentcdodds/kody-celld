import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { appSessionOf, safeNext } from './http.ts'

describe('safeNext', () => {
	it('only allows same-origin relative paths', () => {
		assert.equal(safeNext('/account/tokens?x=1'), '/account/tokens?x=1')
		assert.equal(safeNext('/oauth/authorize?client_id=x'), '/oauth/authorize?client_id=x')
		assert.equal(safeNext(null), '/account')
		assert.equal(safeNext(''), '/account')
		assert.equal(safeNext('https://evil.example'), '/account')
		assert.equal(safeNext('//evil.example/x'), '/account')
		assert.equal(safeNext('/\\evil.example'), '/account')
		assert.equal(safeNext('account'), '/account')
		assert.equal(safeNext('javascript:alert(1)', '/console'), '/console')
	})
})

describe('appSessionOf', () => {
	it('exposes identity only, never the session id or csrf token', () => {
		const now = '2026-01-01T00:00:00.000Z'
		const app = appSessionOf(
			{
				user: { id: 'u1', email: 'kent@example.com', createdAt: now },
				session: { id: 'sess-secret', userId: 'u1', createdAt: now, expiresAt: now, lastSeenAt: now, userAgent: null },
				csrf: 'csrf-secret',
			},
			{ isAdmin: true },
		)
		assert.deepEqual(app, { displayName: 'kent', email: 'kent@example.com', avatarUrl: null, isAdmin: true })
		assert.ok(!JSON.stringify(app).includes('secret'))
		assert.equal(appSessionOf(null), null)
	})
})
