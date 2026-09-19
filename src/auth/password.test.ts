import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	constantTimeEqualString,
	hashPassword,
	passwordIterations,
	passwordNeedsRehash,
	validatePassword,
	verifyPassword,
} from './password.ts'

describe('validatePassword', () => {
	it('enforces the length window', () => {
		assert.equal(validatePassword('correct horse battery'), 'correct horse battery')
		assert.throws(() => validatePassword('short'), /at least 12/)
		assert.throws(() => validatePassword('x'.repeat(257)), /at most 256/)
		assert.throws(() => validatePassword(undefined), /required/)
		assert.throws(() => validatePassword(12345678901234), /required/)
	})
})

describe('hashPassword / verifyPassword', () => {
	it('stores a self-describing PBKDF2 record with a fresh salt and never the password', async () => {
		const a = await hashPassword('correct horse battery', 1000)
		const b = await hashPassword('correct horse battery', 1000)
		assert.match(a, /^pbkdf2-sha256\$1000\$[0-9a-f]{32}\$[0-9a-f]{64}$/)
		assert.notEqual(a, b, 'salt must differ per hash')
		assert.ok(!a.includes('correct'))
		assert.equal(await verifyPassword('correct horse battery', a), true)
		assert.equal(await verifyPassword('correct horse battery', b), true)
		assert.equal(await verifyPassword('Correct horse battery', a), false)
	})

	it('treats malformed records as a mismatch instead of throwing', async () => {
		assert.equal(await verifyPassword('anything at all', 'garbage'), false)
		assert.equal(await verifyPassword('anything at all', 'pbkdf2-sha256$abc$zz$zz'), false)
		assert.equal(await verifyPassword('anything at all', ''), false)
	})

	it('flags records below the current work factor for rehash', async () => {
		const weak = await hashPassword('correct horse battery', 1000)
		assert.equal(passwordNeedsRehash(weak), true)
		assert.equal(passwordNeedsRehash(weak, 1000), false)
		assert.equal(passwordNeedsRehash(`pbkdf2-sha256$${passwordIterations}$00$00`), false)
		assert.equal(passwordNeedsRehash(`pbkdf2-sha256$${passwordIterations + 1}$00$00`), false)
		assert.equal(passwordNeedsRehash('not-a-record'), true)
	})
})

describe('constantTimeEqualString', () => {
	it('compares equal-length strings and refuses length leaks', () => {
		assert.equal(constantTimeEqualString('abc', 'abc'), true)
		assert.equal(constantTimeEqualString('abc', 'abd'), false)
		assert.equal(constantTimeEqualString('abc', 'abcd'), false)
		assert.equal(constantTimeEqualString('', ''), true)
	})
})
