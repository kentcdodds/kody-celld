import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { buildMasterKeyring } from '../lib/crypto.ts'
import { McpOAuthStore, mcpOAuthSchema } from './oauth-store.ts'

/** Just enough of Durable Object `SqlStorage` for the store (same shim as provider-store.test.ts). */
function memorySql() {
	const db = new DatabaseSync(':memory:')
	return {
		exec(query: string, ...params: Array<string | number | null>) {
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

async function makeOAuth(key = 'oauth-store-key', previous?: string) {
	const sql = memorySql()
	sql.exec(mcpOAuthSchema)
	let ring = await buildMasterKeyring(key, previous)
	const store = new McpOAuthStore({ sql, userId: () => 'user_1', keyring: async () => ring })
	return { store, sql, setRing: async (k: string, p?: string) => (ring = await buildMasterKeyring(k, p)) }
}

const dynamicClient = {
	mode: 'dynamic' as const,
	information: { client_id: 'cid', client_secret: 'csecret', issuer: 'http://172.30.1.5' },
}

describe('McpOAuthStore', () => {
	it('seals client secret and tokens; summary never contains them', async () => {
		const { store, sql } = await makeOAuth()
		await store.saveClient('home', dynamicClient)
		await store.saveTokens('home', {
			access_token: 'at-1',
			refresh_token: 'rt-1',
			token_type: 'Bearer',
			expires_in: 3600,
			issuer: 'http://172.30.1.5',
		})
		const raw = JSON.stringify(sql.exec('SELECT * FROM mcp_server_oauth').toArray())
		for (const secret of ['csecret', 'at-1', 'rt-1']) assert.doesNotMatch(raw, new RegExp(secret))
		const summary = store.summary('home')!
		assert.deepEqual(
			{ ...summary, expiresAt: null },
			{
				clientMode: 'dynamic',
				clientId: 'cid',
				hasClientSecret: true,
				hasAccessToken: true,
				hasRefreshToken: true,
				expiresAt: null,
			},
		)
		assert.equal((await store.client('home'))!.information.client_secret, 'csecret')
		assert.equal((await store.tokens('home'))!.accessToken, 'at-1')
	})

	it('keeps the old refresh token when a token response omits one', async () => {
		const { store } = await makeOAuth()
		await store.saveTokens('home', { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer' })
		await store.saveTokens('home', { access_token: 'at-2', token_type: 'Bearer' })
		const tokens = (await store.tokens('home'))!
		assert.equal(tokens.accessToken, 'at-2')
		assert.equal(tokens.refreshToken, 'rt-1')
	})

	it('pending attempts are single-claim and expire', async () => {
		const { store } = await makeOAuth()
		await store.createPending({
			state: 's1',
			serverName: 'home',
			serverOrigin: 'http://172.30.1.5',
			verifier: 'v',
			redirectUri: 'https://k/cb',
		})
		const first = (await store.claimPending('s1'))!
		assert.equal(first.firstClaim, true)
		assert.equal(first.pending.verifier, 'v')
		assert.equal((await store.claimPending('s1'))!.firstClaim, false)
		assert.equal(await store.claimPending('nope'), null)
	})

	it('accessToken: valid token returned without refreshing', async () => {
		const { store } = await makeOAuth()
		await store.saveClient('home', dynamicClient)
		await store.saveTokens('home', {
			access_token: 'at-1',
			refresh_token: 'rt-1',
			token_type: 'Bearer',
			expires_in: 3600,
		})
		let calls = 0
		const result = await store.accessToken('home', {
			forceRefresh: false,
			refresher: async () => (calls++, { access_token: 'x', token_type: 'Bearer' }),
		})
		assert.deepEqual(result, { ok: true, accessToken: 'at-1' })
		assert.equal(calls, 0)
	})

	it('accessToken: two concurrent callers with an expiring token cause ONE refresh', async () => {
		const { store } = await makeOAuth()
		await store.saveClient('home', dynamicClient)
		await store.saveTokens('home', {
			access_token: 'at-1',
			refresh_token: 'rt-1',
			token_type: 'Bearer',
			expires_in: 10,
		})
		let calls = 0
		const refresher = async (input: { refreshToken: string }) => {
			calls++
			assert.equal(input.refreshToken, 'rt-1')
			await new Promise((r) => setTimeout(r, 20))
			return { access_token: 'at-2', refresh_token: 'rt-2', token_type: 'Bearer', expires_in: 3600 }
		}
		const [a, b] = await Promise.all([
			store.accessToken('home', { forceRefresh: false, refresher }),
			store.accessToken('home', { forceRefresh: false, refresher }),
		])
		assert.equal(calls, 1)
		assert.deepEqual(a, { ok: true, accessToken: 'at-2' })
		assert.deepEqual(b, { ok: true, accessToken: 'at-2' })
	})

	it('accessToken: a forced refresh after another refresh already rotated the token reuses the new token', async () => {
		const { store } = await makeOAuth()
		await store.saveClient('home', dynamicClient)
		await store.saveTokens('home', {
			access_token: 'at-1',
			refresh_token: 'rt-1',
			token_type: 'Bearer',
			expires_in: 3600,
		})
		let calls = 0
		const refresher = async () => (
			calls++,
			{ access_token: `at-${calls + 1}`, refresh_token: `rt-${calls + 1}`, token_type: 'Bearer', expires_in: 3600 }
		)
		await store.accessToken('home', { forceRefresh: true, refresher }) // rotates to at-2/rt-2
		// a caller that saw at-1 rejected forces a refresh: the stored token already changed, so no second token request
		const stale = await store.accessToken('home', { forceRefresh: true, refresher, staleAccessToken: 'at-1' })
		assert.equal(calls, 1)
		assert.deepEqual(stale, { ok: true, accessToken: 'at-2' })
	})

	it('accessToken: invalid_grant wipes the tokens and asks for authorization; transient failure keeps them', async () => {
		const { store } = await makeOAuth()
		await store.saveClient('home', dynamicClient)
		await store.saveTokens('home', { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer', expires_in: 1 })
		const transient = await store.accessToken('home', {
			forceRefresh: true,
			refresher: async () => {
				throw new Error('HTTP 503 from token endpoint')
			},
		})
		assert.equal(transient.ok, false)
		assert.equal(!transient.ok && transient.status, 'error')
		assert.equal((await store.tokens('home'))!.refreshToken, 'rt-1')
		const rejected = await store.accessToken('home', {
			forceRefresh: true,
			refresher: async () => {
				throw Object.assign(new Error('invalid_grant: refresh token revoked'), { errorCode: 'invalid_grant' })
			},
		})
		assert.equal(!rejected.ok && rejected.status, 'authenticating')
		assert.equal(await store.tokens('home'), null)
	})

	it('accessToken: no grant, or an expired token with no refresh token, means authenticating', async () => {
		const { store } = await makeOAuth()
		const none = await store.accessToken('home', {
			forceRefresh: false,
			refresher: async () => ({ access_token: 'x', token_type: 'Bearer' }),
		})
		assert.equal(!none.ok && none.status, 'authenticating')
		await store.saveTokens('home', { access_token: 'at-1', token_type: 'Bearer', expires_in: 1 })
		const expired = await store.accessToken('home', {
			forceRefresh: false,
			refresher: async () => ({ access_token: 'x', token_type: 'Bearer' }),
		})
		assert.equal(!expired.ok && expired.status, 'authenticating')
	})

	it('clear removes client, tokens and pending; rekey reseals everything', async () => {
		const { store, setRing } = await makeOAuth('k1')
		await store.saveClient('home', dynamicClient)
		await store.saveTokens('home', { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer' })
		await store.createPending({
			state: 's1',
			serverName: 'home',
			serverOrigin: 'http://172.30.1.5',
			verifier: 'v',
			redirectUri: 'https://k/cb',
		})
		await setRing('k2', 'k1')
		assert.deepEqual(await store.rekey(), { resealed: 4, remaining: 0 })
		assert.equal((await store.tokens('home'))!.refreshToken, 'rt-1')
		store.clear('home')
		assert.equal(store.summary('home'), null)
		assert.equal(await store.claimPending('s1'), null)
	})

	it('accessToken: a refresh in flight when clear() runs does not re-create the tokens', async () => {
		const { store } = await makeOAuth()
		await store.saveClient('home', dynamicClient)
		await store.saveTokens('home', {
			access_token: 'at-1',
			refresh_token: 'rt-1',
			token_type: 'Bearer',
			expires_in: 10,
		})
		let release!: () => void
		const gate = new Promise<void>((resolve) => (release = resolve))
		const pending = store.accessToken('home', {
			forceRefresh: true,
			refresher: async () => {
				await gate
				return { access_token: 'at-old-origin', refresh_token: 'rt-old', token_type: 'Bearer', expires_in: 3600 }
			},
		})
		await new Promise((r) => setTimeout(r, 10))
		store.clear('home')
		release()
		const result = await pending
		assert.equal(result.ok, false)
		assert.equal(store.summary('home'), null)
		assert.equal(await store.tokens('home'), null)
	})
})
