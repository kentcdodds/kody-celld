import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import {
	normalizeProviderHosts,
	parseProviderConfig,
	SecretProviderStore,
	secretProviderSchema,
	validateProviderRef,
} from './provider-store.ts'

/** Just enough of Durable Object `SqlStorage` (exec -> toArray/rowsWritten) for the store. */
function memorySql() {
	const db = new DatabaseSync(':memory:')
	return {
		exec(query: string, ...params: Array<string | number>) {
			const statements = query.split(';').filter((s) => s.trim())
			if (statements.length > 1) {
				for (const statement of statements) db.exec(statement)
				return { toArray: () => [], rowsWritten: 0 }
			}
			const statement = db.prepare(query)
			if (/^\s*select/i.test(query)) return { toArray: () => statement.all(...params), rowsWritten: 0 }
			const result = statement.run(...params)
			return { toArray: () => [], rowsWritten: Number(result.changes) }
		},
	} as unknown as SqlStorage
}

function store() {
	const sql = memorySql()
	sql.exec(secretProviderSchema)
	return new SecretProviderStore(sql)
}

describe('provider ref/config validation', () => {
	it('accepts plain config and refuses credential-looking keys', () => {
		assert.deepEqual(parseProviderConfig({ baseUrl: 'http://vault.local', vault: 'Personal' }), {
			baseUrl: 'http://vault.local',
			vault: 'Personal',
		})
		assert.deepEqual(parseProviderConfig(undefined), {})
		assert.throws(() => parseProviderConfig({ apiToken: 'x' }), /looks like a credential/)
		assert.throws(() => parseProviderConfig({ password: 'x' }), /looks like a credential/)
		assert.throws(() => parseProviderConfig({ ok: 1 }), /must be a string/)
		assert.throws(() => parseProviderConfig([]), /must be an object/)
	})

	it('refs may not contain whitespace or braces', () => {
		assert.equal(validateProviderRef('vault/item/field'), 'vault/item/field')
		assert.throws(() => validateProviderRef(''), /Provider ref/)
		assert.throws(() => validateProviderRef('a b'), /Provider ref/)
		assert.throws(() => validateProviderRef('{{x}}'), /Provider ref/)
	})

	it('normalizes item hosts like secret-host approvals', () => {
		assert.deepEqual(normalizeProviderHosts(['API.Example.com', 'https://Other.example/path', 'x.example/p', 3]), [
			'api.example.com',
			'other.example',
			'x.example',
		])
		assert.deepEqual(normalizeProviderHosts('nope'), [])
	})
})

describe('SecretProviderStore', () => {
	const bind = (s: SecretProviderStore, packageName = '@t/vault', locked?: boolean) =>
		s.bind({ providerId: 'vault', packageName, doorSecretName: 'door', config: { baseUrl: 'http://v' }, locked })

	it('unlocked bindings permit anyone; locked ones need a grant on the canonical ref', () => {
		const s = store()
		const binding = bind(s)
		assert.equal(binding.locked, false)
		assert.equal(s.permits(binding, 'item-1', null), true)
		assert.equal(s.permits(binding, 'item-1', '@t/consumer'), true)

		const locked = s.setLocked('vault', true)
		assert.equal(locked.locked, true)
		assert.equal(s.permits(locked, 'item-1', null), false, 'ad hoc code is always refused on a locked binding')
		assert.equal(s.permits(locked, 'item-1', '@t/consumer'), false)

		s.grant({ providerId: 'vault', canonicalRef: 'item-1', packageName: '@t/consumer' })
		assert.equal(s.permits(locked, 'item-1', '@t/consumer'), true)
		assert.equal(s.permits(locked, 'item-2', '@t/consumer'), false)
		assert.equal(s.permits(locked, 'item-1', '@t/other'), false)
		assert.equal(s.grants('vault').length, 1)
		assert.equal(
			s.grant({ providerId: 'vault', canonicalRef: 'item-1', packageName: '@t/consumer' }).canonicalRef,
			'item-1',
		)
		assert.equal(s.grants('vault').length, 1, 'grants are idempotent')

		assert.deepEqual(s.revoke({ providerId: 'vault', canonicalRef: 'item-1', packageName: '@t/consumer' }), {
			deleted: true,
		})
		assert.equal(s.permits(locked, 'item-1', '@t/consumer'), false)
		assert.deepEqual(s.revoke({ providerId: 'vault', canonicalRef: 'item-1', packageName: '@t/consumer' }), {
			deleted: false,
		})
		assert.throws(() => s.setLocked('missing', true), /secret_provider_not_bound/)
	})

	it('rebinding to another package drops its grants; unbind removes everything', () => {
		const s = store()
		bind(s, '@t/vault', true)
		s.grant({ providerId: 'vault', canonicalRef: 'item-1', packageName: '@t/consumer' })
		bind(s, '@t/vault')
		assert.equal(s.grants('vault').length, 1, 'same package keeps grants')
		assert.equal(s.get('vault')?.locked, true, 'lock state survives a re-bind without `locked`')
		bind(s, '@t/vault2')
		assert.equal(s.grants('vault').length, 0)
		assert.deepEqual(s.unbind('vault'), { deleted: true })
		assert.equal(s.get('vault'), null)
		assert.deepEqual(s.unbind('vault'), { deleted: false })
	})

	it('unbindPackage clears bindings of packages that stop being providers', () => {
		const s = store()
		bind(s)
		s.bind({ providerId: 'other', packageName: '@t/other', doorSecretName: 'd', config: {}, locked: undefined })
		assert.equal(s.unbindPackage('@t/vault'), 1)
		assert.deepEqual(
			s.list().map((b) => b.providerId),
			['other'],
		)
	})

	it('cache: alias and canonical share an entry; lock/revoke/rebind invalidate; ttl expires', () => {
		const s = store()
		bind(s)
		s.cachePut('vault', 'alias', { value: 'v', hosts: ['api.example'], canonicalRef: 'item-1' }, 60_000)
		assert.equal(s.cacheGet('vault', 'alias')?.canonicalRef, 'item-1')
		assert.equal(s.cacheGet('vault', 'item-1')?.value, 'v')
		assert.equal(s.cacheGet('other', 'alias'), null)

		s.setLocked('vault', true)
		assert.equal(s.cacheGet('vault', 'alias'), null, 'locking invalidates')
		s.cachePut('vault', 'alias', { value: 'v', hosts: [], canonicalRef: 'item-1' }, 60_000)
		s.revoke({ providerId: 'vault', canonicalRef: 'item-1', packageName: '@t/consumer' })
		assert.equal(s.cacheGet('vault', 'alias'), null, 'revoking invalidates')
		s.cachePut('vault', 'alias', { value: 'v', hosts: [], canonicalRef: 'item-1' }, 60_000)
		bind(s)
		assert.equal(s.cacheGet('vault', 'alias'), null, 'rebinding invalidates')

		s.cachePut('vault', 'alias', { value: 'v', hosts: [], canonicalRef: 'alias' }, 0)
		assert.equal(s.cacheGet('vault', 'alias'), null, 'ttl 0 disables caching')
		s.cachePut('vault', 'alias', { value: 'v', hosts: [], canonicalRef: 'alias' }, -1)
		assert.equal(s.cacheGet('vault', 'alias'), null)
	})
})
