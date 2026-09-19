import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decryptSecretValue, encryptSecretValue, sha256Hex } from './crypto.ts'

describe('secret value encryption', () => {
	const masterKey = 'unit-test-master-key-material'

	it('round-trips and uses a fresh IV per encryption', async () => {
		const a = await encryptSecretValue(masterKey, 'user_1', 'plain')
		const b = await encryptSecretValue(masterKey, 'user_1', 'plain')
		assert.notEqual(a.iv, b.iv)
		assert.notEqual(a.ciphertext, b.ciphertext)
		assert.equal(await decryptSecretValue(masterKey, 'user_1', a), 'plain')
	})

	it('derives distinct keys per user and per master key', async () => {
		const sealed = await encryptSecretValue(masterKey, 'user_1', 'plain')
		await assert.rejects(decryptSecretValue(masterKey, 'user_2', sealed))
		await assert.rejects(decryptSecretValue('another-master-key', 'user_1', sealed))
	})

	it('hashes deterministically', async () => {
		assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
	})
})
