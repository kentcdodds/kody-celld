import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	assertNoRemovedPrivateHostEnv,
	privateHostsEnvKey,
	privateHostsFromEnv,
	removedPrivateHostEnvKeys,
} from './private-hosts-env.ts'

describe('privateHostsFromEnv', () => {
	it('parses KODY_PRIVATE_HOSTS', () => {
		assert.deepEqual(privateHostsFromEnv({ KODY_PRIVATE_HOSTS: ' ha.home ,172.30.0.0/16,' }), [
			'ha.home',
			'172.30.0.0/16',
		])
		assert.deepEqual(privateHostsFromEnv({}), [])
	})
	it('refuses each removed variable and points at the notice issue', () => {
		for (const key of removedPrivateHostEnvKeys) {
			assert.throws(
				() => assertNoRemovedPrivateHostEnv({ [key]: '' }),
				new RegExp(`${key}.*${privateHostsEnvKey}.*issues/62`),
			)
			assert.throws(() => privateHostsFromEnv({ [key]: 'localhost', KODY_PRIVATE_HOSTS: 'ha.home' }), /issues\/62/)
		}
	})
})
