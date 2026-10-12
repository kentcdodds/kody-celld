import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	appStatePattern,
	consumeHandoff,
	mintHandoff,
	newAppState,
	signAppSession,
	verifyAppSession,
} from './tokens.ts'

const key = 'test-master-key-0123456789abcdef0123456789'
const expected = { uid: 'user_a', pkg: '@s/notes', st: 'a'.repeat(32) }
const now = 1_760_000_000_000

function burner() {
	const used = new Set<string>()
	return async (jti: string) => {
		if (used.has(jti)) return false
		used.add(jti)
		return true
	}
}

describe('handoff tokens', () => {
	it('round-trips once and then reports replay', async () => {
		const burn = burner()
		const token = await mintHandoff(key, { ...expected, sid: 'sess_1' }, now)
		const first = await consumeHandoff({ masterKey: key, token, expected, burn, now: now + 1000 })
		assert.equal(first.ok, true)
		assert.equal(first.ok && first.claims.sid, 'sess_1')
		const second = await consumeHandoff({ masterKey: key, token, expected, burn, now: now + 1000 })
		assert.deepEqual(second, { ok: false, reason: 'replay' })
	})
	it('rejects expiry at exactly 60 s', async () => {
		const token = await mintHandoff(key, { ...expected, sid: 's' }, now)
		const result = await consumeHandoff({ masterKey: key, token, expected, burn: burner(), now: now + 60_000 })
		assert.deepEqual(result, { ok: false, reason: 'expired' })
	})
	it('checks user, package and state before burning', async () => {
		let burned = 0
		const burn = async () => {
			burned++
			return true
		}
		const token = await mintHandoff(key, { ...expected, sid: 's' }, now)
		for (const other of [
			{ ...expected, uid: 'user_b' },
			{ ...expected, pkg: 'other' },
			{ ...expected, st: 'b'.repeat(32) },
			{ ...expected, st: '' },
		]) {
			assert.deepEqual(await consumeHandoff({ masterKey: key, token, expected: other, burn, now }), {
				ok: false,
				reason: 'mismatch',
			})
		}
		assert.equal(burned, 0)
	})
	it('rejects a different key, tampering, and garbage', async () => {
		const token = await mintHandoff(key, { ...expected, sid: 's' }, now)
		const wrongKey = await consumeHandoff({ masterKey: `${key}x`, token, expected, burn: burner(), now })
		assert.deepEqual(wrongKey, { ok: false, reason: 'signature' })
		const [payload, sig] = token.split('.')
		const tampered = `${payload}A.${sig}`
		assert.deepEqual(await consumeHandoff({ masterKey: key, token: tampered, expected, burn: burner(), now }), {
			ok: false,
			reason: 'signature',
		})
		for (const junk of ['', 'a', 'a.b.c', '!!.??']) {
			const result = await consumeHandoff({ masterKey: key, token: junk, expected, burn: burner(), now })
			assert.equal(result.ok, false, junk)
		}
	})
	it('does not accept an app-session value as a handoff', async () => {
		const value = await signAppSession(key, { uid: expected.uid, sid: 's', exp: now + 1000 })
		const result = await consumeHandoff({ masterKey: key, token: value, expected, burn: burner(), now })
		assert.deepEqual(result, { ok: false, reason: 'signature' })
	})
})

describe('newAppState', () => {
	it('returns 32 lowercase hex chars, fresh each time', () => {
		const a = newAppState()
		assert.match(a, appStatePattern)
		assert.notEqual(a, newAppState())
	})
})

describe('app session values', () => {
	it('verifies until exp', async () => {
		const value = await signAppSession(key, { uid: 'user_a', sid: 'sess_1', exp: now + 5000 })
		assert.deepEqual(await verifyAppSession(key, value, now), { v: 1, uid: 'user_a', sid: 'sess_1', exp: now + 5000 })
		assert.equal(await verifyAppSession(key, value, now + 5000), null)
	})
	it('rejects a handoff token, another key, and garbage', async () => {
		const token = await mintHandoff(key, { ...expected, sid: 's' }, now)
		assert.equal(await verifyAppSession(key, token, now), null)
		const value = await signAppSession(key, { uid: 'user_a', sid: 's', exp: now + 5000 })
		assert.equal(await verifyAppSession(`${key}x`, value, now), null)
		assert.equal(await verifyAppSession(key, 'nope', now), null)
	})
})
