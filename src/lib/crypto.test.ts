import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	buildMasterKeyring,
	decryptSecretValue,
	decryptWithKeyring,
	encryptSecretValue,
	masterKeyId,
	sha256Hex,
} from './crypto.ts'

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

	it('stamps values with a non-reversible key id', async () => {
		const sealed = await encryptSecretValue(masterKey, 'user_1', 'plain')
		assert.equal(sealed.keyId, await masterKeyId(masterKey))
		assert.equal(sealed.keyId?.length, 16)
		assert.notEqual(sealed.keyId, await masterKeyId('another-master-key'))
	})

	it('hashes deterministically', async () => {
		assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
	})
})

describe('master keyring', () => {
	const oldKey = 'old-master-key-material-0123456789'
	const newKey = 'new-master-key-material-0123456789'

	it('seals with the current key and decrypts with retired ones', async () => {
		const sealedWithOld = await encryptSecretValue(oldKey, 'user_1', 'plain')
		const ring = await buildMasterKeyring(newKey, ` ${oldKey} ,`)
		assert.equal(ring.current.id, await masterKeyId(newKey))
		assert.deepEqual(
			ring.all.map((k) => k.id),
			[await masterKeyId(newKey), await masterKeyId(oldKey)],
		)
		assert.equal(await decryptWithKeyring(ring, 'user_1', sealedWithOld), 'plain')
	})

	it('tries every key for legacy rows without a key id', async () => {
		const { iv, ciphertext } = await encryptSecretValue(oldKey, 'user_1', 'plain')
		const ring = await buildMasterKeyring(newKey, oldKey)
		assert.equal(await decryptWithKeyring(ring, 'user_1', { iv, ciphertext }), 'plain')
	})

	it('fails clearly when the sealing key is no longer configured', async () => {
		const sealed = await encryptSecretValue(oldKey, 'user_1', 'plain')
		const ring = await buildMasterKeyring(newKey)
		await assert.rejects(decryptWithKeyring(ring, 'user_1', sealed), /KODY_MASTER_KEY_PREVIOUS/)
	})

	it('de-duplicates keys that appear twice', async () => {
		const ring = await buildMasterKeyring(newKey, `${newKey},${oldKey},${oldKey}`)
		assert.equal(ring.all.length, 2)
	})
})
