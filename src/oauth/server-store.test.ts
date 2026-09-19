import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { pkceChallenge } from '../integrations/oauth.ts'
import { buildMasterKeyring } from '../lib/crypto.ts'
import { OAuthProtocolError, refreshReplayGraceMs, verifyPkce, type ClientRegistration } from './protocol.ts'
import { OAuthServerStore, oauthServerSchema } from './server-store.ts'

/** Just enough of Durable Object `SqlStorage` for the store. */
function memorySql() {
	const db = new DatabaseSync(':memory:')
	const sql = {
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
	return { db, sql }
}

const keyring = buildMasterKeyring('unit-test-master-key')

function store() {
	const { db, sql } = memorySql()
	sql.exec(oauthServerSchema)
	return { db, store: new OAuthServerStore(sql, () => keyring) }
}

const registration = (over: Partial<ClientRegistration> = {}): ClientRegistration => ({
	clientName: 'Test MCP host',
	redirectUris: ['https://app.example/cb'],
	tokenEndpointAuthMethod: 'none',
	grantTypes: ['authorization_code', 'refresh_token'],
	clientUri: null,
	logoUri: null,
	softwareId: null,
	softwareVersion: null,
	...over,
})

const resource = 'https://kody.example/mcp'
const verifier = 'v'.repeat(43)

async function oauthCode(fn: () => Promise<unknown>) {
	try {
		await fn()
		return null
	} catch (error) {
		return error instanceof OAuthProtocolError ? error.code : String(error)
	}
}

/** Registers a public client, walks the code flow, and returns the first token pair. */
async function authorized(s: OAuthServerStore, userId = 'user_a') {
	const client = await s.clientRegister(registration())
	const code = await s.codeIssue({
		clientId: client.clientId,
		userId,
		redirectUri: 'https://app.example/cb',
		codeChallenge: await pkceChallenge(verifier),
		scope: 'openid profile',
		resource,
	})
	const consumed = (await s.codeConsume(code))!
	const grantId = s.grantEnsure({ userId, clientId: client.clientId, scope: consumed.scope })
	const tokens = await s.tokensIssue({ grantId, clientId: client.clientId, scope: consumed.scope })
	return { client, grantId, tokens }
}

describe('OAuthServerStore clients', () => {
	it('registers public and confidential clients; only a secret hash is persisted', async () => {
		const { db, store: s } = store()
		const pub = await s.clientRegister(registration())
		assert.match(pub.clientId, /^mcpc_/)
		assert.equal('clientSecret' in pub, false)

		const conf = await s.clientRegister(registration({ tokenEndpointAuthMethod: 'client_secret_basic' }))
		assert.match(conf.clientSecret!, /^mcps_/)
		const rows = db.prepare('SELECT client_id, client_secret_hash FROM oauth_clients').all() as Array<{
			client_id: string
			client_secret_hash: string | null
		}>
		assert.equal(rows.find((r) => r.client_id === pub.clientId)?.client_secret_hash, null)
		const stored = rows.find((r) => r.client_id === conf.clientId)?.client_secret_hash
		assert.ok(stored && stored !== conf.clientSecret && !stored.includes(conf.clientSecret!))
		assert.equal('clientSecret' in s.clientGet(conf.clientId)!, false, 'reads never return the secret')
		assert.equal(s.clientGet('mcpc_missing'), null)
	})

	it('authenticates by the registered method and refuses mismatches', async () => {
		const { store: s } = store()
		const pub = await s.clientRegister(registration())
		const conf = await s.clientRegister(registration({ tokenEndpointAuthMethod: 'client_secret_post' }))
		const auth = (
			clientId: string | null,
			clientSecret: string | null,
			method: ClientRegistration['tokenEndpointAuthMethod'],
		) => oauthCode(() => s.clientAuthenticate({ clientId, clientSecret, method }))

		assert.equal(await auth(pub.clientId, null, 'none'), null)
		assert.equal(await auth(conf.clientId, conf.clientSecret!, 'client_secret_post'), null)
		assert.equal(await auth(null, null, 'none'), 'invalid_client')
		assert.equal(await auth('mcpc_ghost', null, 'none'), 'invalid_client')
		assert.equal(await auth(conf.clientId, null, 'none'), 'invalid_client', 'confidential client needs its secret')
		assert.equal(await auth(conf.clientId, 'mcps_wrong', 'client_secret_post'), 'invalid_client')
		assert.equal(
			await auth(conf.clientId, conf.clientSecret!, 'client_secret_basic'),
			'invalid_client',
			'method is pinned',
		)
		assert.equal(
			await auth(pub.clientId, 'mcps_any', 'client_secret_post'),
			'invalid_client',
			'public clients have no secret',
		)
	})
})

describe('OAuthServerStore authorization codes', () => {
	it('stores a hash, binds the request, and is consumed exactly once', async () => {
		const { db, store: s } = store()
		const client = await s.clientRegister(registration())
		const challenge = await pkceChallenge(verifier)
		const code = await s.codeIssue({
			clientId: client.clientId,
			userId: 'user_a',
			redirectUri: 'https://app.example/cb',
			codeChallenge: challenge,
			scope: 'openid',
			resource,
		})
		assert.match(code, /^mcpac_/)
		const row = db.prepare('SELECT code_hash FROM oauth_codes').get() as { code_hash: string }
		assert.notEqual(row.code_hash, code)

		const consumed = await s.codeConsume(code)
		assert.deepEqual(consumed, {
			clientId: client.clientId,
			userId: 'user_a',
			redirectUri: 'https://app.example/cb',
			codeChallenge: challenge,
			scope: 'openid',
			resource,
		})
		assert.equal(await verifyPkce(verifier, consumed!.codeChallenge), true)
		assert.equal(await s.codeConsume(code), null, 'second exchange fails')
		assert.equal(await s.codeConsume('mcpac_unknown'), null)
	})

	it('expired codes are dead on arrival', async () => {
		const { db, store: s } = store()
		const client = await s.clientRegister(registration())
		const code = await s.codeIssue({
			clientId: client.clientId,
			userId: 'user_a',
			redirectUri: 'https://app.example/cb',
			codeChallenge: await pkceChallenge(verifier),
			scope: '',
			resource,
		})
		db.prepare('UPDATE oauth_codes SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString())
		assert.equal(await s.codeConsume(code), null)
		assert.equal((db.prepare('SELECT count(*) AS n FROM oauth_codes').get() as { n: number }).n, 0)
	})
})

describe('OAuthServerStore grants and tokens', () => {
	it('issues hashed token pairs that resolve to the grant without exposing material', async () => {
		const { db, store: s } = store()
		const { client, grantId, tokens } = await authorized(s)
		assert.match(tokens.access_token, /^mcpat_/)
		assert.match(tokens.refresh_token, /^mcprt_/)
		assert.equal(tokens.token_type, 'Bearer')
		assert.equal(tokens.expires_in, 3600)
		assert.equal(tokens.scope, 'openid profile')

		const hashes = (db.prepare('SELECT token_hash FROM oauth_tokens').all() as Array<{ token_hash: string }>).map(
			(r) => r.token_hash,
		)
		assert.equal(hashes.length, 2)
		assert.ok(!hashes.includes(tokens.access_token) && !hashes.includes(tokens.refresh_token))

		const resolved = await s.accessTokenResolve(tokens.access_token)
		assert.equal(resolved?.userId, 'user_a')
		assert.equal(resolved?.grantId, grantId)
		assert.equal(resolved?.clientId, client.clientId)
		assert.equal(resolved?.clientName, 'Test MCP host')
		assert.equal(await s.accessTokenResolve(tokens.refresh_token), null, 'refresh tokens are not bearer tokens')
		assert.equal(await s.accessTokenResolve('mcpat_nope'), null)

		const [grant] = s.grantList('user_a')
		assert.equal(grant?.id, grantId)
		assert.equal(grant?.clientName, 'Test MCP host')
		assert.ok(!JSON.stringify(grant).includes('mcpat_') && !JSON.stringify(grant).includes('mcprt_'))
	})

	it('grantEnsure is idempotent per (user, client) and widens scope', async () => {
		const { store: s } = store()
		const client = await s.clientRegister(registration())
		const a = s.grantEnsure({ userId: 'user_a', clientId: client.clientId, scope: 'openid' })
		const b = s.grantEnsure({ userId: 'user_a', clientId: client.clientId, scope: 'email' })
		assert.equal(a, b)
		assert.equal(s.grantList('user_a')[0]?.scope, 'openid email')
		assert.notEqual(s.grantEnsure({ userId: 'user_b', clientId: client.clientId, scope: 'openid' }), a)
	})

	it('rotates refresh tokens, replays within the grace window, and kills the family on stale reuse', async () => {
		const { db, store: s } = store()
		const { client, tokens } = await authorized(s)
		const second = await s.tokensRefresh({ refreshToken: tokens.refresh_token, clientId: client.clientId })
		assert.notEqual(second.access_token, tokens.access_token)
		assert.notEqual(second.refresh_token, tokens.refresh_token)
		assert.equal(await s.accessTokenResolve(tokens.access_token), null, 'old access token retired')
		assert.equal((await s.accessTokenResolve(second.access_token))?.userId, 'user_a')

		// A client that lost the reply retries with the token it just used: same answer, no new pair.
		const replay = await s.tokensRefresh({ refreshToken: tokens.refresh_token, clientId: client.clientId })
		assert.deepEqual(replay, second)
		assert.equal((await s.accessTokenResolve(second.access_token))?.userId, 'user_a')

		// The snapshot is sealed with the master key, not stored in the clear.
		const snapshot = db.prepare('SELECT replay_json FROM oauth_tokens WHERE replay_json IS NOT NULL').get() as {
			replay_json: string
		}
		assert.ok(
			!snapshot.replay_json.includes(second.access_token) && !snapshot.replay_json.includes(second.refresh_token),
		)

		const third = await s.tokensRefresh({ refreshToken: second.refresh_token, clientId: client.clientId })
		// Two generations back: someone else has that token. Everything in the family dies.
		assert.equal(
			await oauthCode(() => s.tokensRefresh({ refreshToken: tokens.refresh_token, clientId: client.clientId })),
			'invalid_grant',
		)
		assert.equal(await s.accessTokenResolve(third.access_token), null)
		assert.equal(
			await oauthCode(() => s.tokensRefresh({ refreshToken: third.refresh_token, clientId: client.clientId })),
			'invalid_grant',
		)
		assert.equal((db.prepare('SELECT count(*) AS n FROM oauth_tokens').get() as { n: number }).n, 0)
	})

	it('grace replay expires, and refresh is bound to the issuing client', async () => {
		const { db, store: s } = store()
		const { client, tokens } = await authorized(s)
		const other = await s.clientRegister(registration())
		assert.equal(
			await oauthCode(() => s.tokensRefresh({ refreshToken: tokens.refresh_token, clientId: other.clientId })),
			'invalid_grant',
		)
		const second = await s.tokensRefresh({ refreshToken: tokens.refresh_token, clientId: client.clientId })
		db.prepare('UPDATE oauth_tokens SET replaced_at = ? WHERE replaced_at IS NOT NULL').run(
			new Date(Date.now() - refreshReplayGraceMs - 1000).toISOString(),
		)
		assert.equal(
			await oauthCode(() => s.tokensRefresh({ refreshToken: tokens.refresh_token, clientId: client.clientId })),
			'invalid_grant',
		)
		assert.equal(await s.accessTokenResolve(second.access_token), null, 'late replay revokes the family')
	})

	it('expired refresh and access tokens stop working', async () => {
		const { db, store: s } = store()
		const { client, tokens } = await authorized(s)
		db.prepare('UPDATE oauth_tokens SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString())
		assert.equal(await s.accessTokenResolve(tokens.access_token), null)
		assert.equal(
			await oauthCode(() => s.tokensRefresh({ refreshToken: tokens.refresh_token, clientId: client.clientId })),
			'invalid_grant',
		)
	})

	it('revocation: access token alone, refresh token ends the family, grant revocation ends everything', async () => {
		const { store: s } = store()
		const { client, grantId, tokens } = await authorized(s)
		const other = await s.clientRegister(registration())
		assert.equal(await s.tokenRevoke({ token: tokens.access_token, clientId: other.clientId }), false)
		assert.equal(await s.tokenRevoke({ token: 'mcpat_unknown', clientId: client.clientId }), false)

		assert.equal(await s.tokenRevoke({ token: tokens.access_token, clientId: client.clientId }), true)
		assert.equal(await s.accessTokenResolve(tokens.access_token), null)
		const next = await s.tokensRefresh({ refreshToken: tokens.refresh_token, clientId: client.clientId })
		assert.equal((await s.accessTokenResolve(next.access_token))?.grantId, grantId)

		assert.equal(await s.tokenRevoke({ token: next.refresh_token, clientId: client.clientId }), true)
		assert.equal(await s.accessTokenResolve(next.access_token), null)
		assert.equal(s.grantList('user_a').length, 1, 'the consent itself survives token revocation')

		const again = await s.tokensIssue({ grantId, clientId: client.clientId, scope: 'openid' })
		assert.throws(() => s.grantRevoke('user_b', grantId), /No MCP client grant/)
		s.grantRevoke('user_a', grantId)
		assert.equal(await s.accessTokenResolve(again.access_token), null)
		assert.equal(s.grantList('user_a').length, 0)
	})

	it('grantRevokeAll clears every client for the user only', async () => {
		const { store: s } = store()
		const a = await authorized(s, 'user_a')
		const b = await authorized(s, 'user_b')
		s.grantRevokeAll('user_a')
		assert.equal(await s.accessTokenResolve(a.tokens.access_token), null)
		assert.equal((await s.accessTokenResolve(b.tokens.access_token))?.userId, 'user_b')
	})
})
