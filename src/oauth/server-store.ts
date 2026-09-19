import {
	decryptWithKeyring,
	encryptSecretValue,
	randomId,
	randomToken,
	sha256Hex,
	type EncryptedValue,
	type MasterKeyring,
} from '../lib/crypto.ts'
import { KodyError } from '../lib/errors.ts'
import {
	accessTokenTtlSeconds,
	codeTtlMs,
	OAuthProtocolError,
	refreshReplayGraceMs,
	refreshTokenTtlMs,
	unusedClientTtlMs,
	type ClientRegistration,
	type TokenEndpointAuthMethod,
} from './protocol.ts'
import { constantTimeEqualString } from '../auth/password.ts'

export type OAuthClient = ClientRegistration & {
	clientId: string
	createdAt: string
	lastUsedAt: string | null
	/** Present only in the registration response. */
	clientSecret?: string
}

export type OAuthGrant = {
	id: string
	userId: string
	clientId: string
	clientName: string
	scope: string
	createdAt: string
	lastUsedAt: string | null
	/** Live (unexpired, unrevoked) refresh-token families under this grant. */
	activeFamilies: number
}

export type TokenResponse = {
	access_token: string
	token_type: 'Bearer'
	expires_in: number
	refresh_token: string
	scope: string
}

export type ResolvedAccessToken = {
	userId: string
	grantId: string
	clientId: string
	clientName: string
	scope: string
	expiresAt: string
}

export const oauthServerSchema = `
	CREATE TABLE IF NOT EXISTS oauth_clients (
		client_id TEXT PRIMARY KEY,
		client_secret_hash TEXT,
		client_name TEXT NOT NULL,
		redirect_uris_json TEXT NOT NULL,
		token_endpoint_auth_method TEXT NOT NULL,
		grant_types_json TEXT NOT NULL,
		client_uri TEXT,
		logo_uri TEXT,
		software_id TEXT,
		software_version TEXT,
		created_at TEXT NOT NULL,
		last_used_at TEXT
	);
	CREATE TABLE IF NOT EXISTS oauth_codes (
		code_hash TEXT PRIMARY KEY,
		client_id TEXT NOT NULL,
		user_id TEXT NOT NULL,
		redirect_uri TEXT NOT NULL,
		code_challenge TEXT NOT NULL,
		scope TEXT NOT NULL,
		resource TEXT NOT NULL,
		created_at TEXT NOT NULL,
		expires_at TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS oauth_grants (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		client_id TEXT NOT NULL,
		scope TEXT NOT NULL,
		created_at TEXT NOT NULL,
		last_used_at TEXT,
		UNIQUE(user_id, client_id)
	);
	CREATE TABLE IF NOT EXISTS oauth_tokens (
		token_hash TEXT PRIMARY KEY,
		kind TEXT NOT NULL,
		grant_id TEXT NOT NULL,
		family_id TEXT NOT NULL,
		created_at TEXT NOT NULL,
		expires_at TEXT NOT NULL,
		replaced_at TEXT,
		replay_json TEXT
	);
	CREATE INDEX IF NOT EXISTS oauth_tokens_grant ON oauth_tokens(grant_id);
	CREATE INDEX IF NOT EXISTS oauth_tokens_family ON oauth_tokens(family_id);
`

type ClientRow = {
	client_id: string
	client_secret_hash: string | null
	client_name: string
	redirect_uris_json: string
	token_endpoint_auth_method: string
	grant_types_json: string
	client_uri: string | null
	logo_uri: string | null
	software_id: string | null
	software_version: string | null
	created_at: string
	last_used_at: string | null
}

type TokenRow = {
	token_hash: string
	kind: 'access' | 'refresh'
	grant_id: string
	family_id: string
	created_at: string
	expires_at: string
	replaced_at: string | null
	replay_json: string | null
}

/**
 * Authorization-server state for MCP clients. Only SHA-256 hashes of codes,
 * tokens and client secrets are stored; the sole plaintext at rest is the
 * short-lived refresh-replay snapshot, sealed with the master keyring.
 */
export class OAuthServerStore {
	private readonly sql: SqlStorage
	private readonly keyring: () => Promise<MasterKeyring>

	constructor(sql: SqlStorage, keyring: () => Promise<MasterKeyring>) {
		this.sql = sql
		this.keyring = keyring
	}

	// ------------------------------------------------------------------ clients

	private toClient(row: ClientRow): OAuthClient {
		return {
			clientId: row.client_id,
			clientName: row.client_name,
			redirectUris: JSON.parse(row.redirect_uris_json) as Array<string>,
			tokenEndpointAuthMethod: row.token_endpoint_auth_method as TokenEndpointAuthMethod,
			grantTypes: JSON.parse(row.grant_types_json) as OAuthClient['grantTypes'],
			clientUri: row.client_uri,
			logoUri: row.logo_uri,
			softwareId: row.software_id,
			softwareVersion: row.software_version,
			createdAt: row.created_at,
			lastUsedAt: row.last_used_at,
		}
	}

	async clientRegister(registration: ClientRegistration): Promise<OAuthClient> {
		this.purge()
		const clientId = randomId('mcpc')
		const confidential = registration.tokenEndpointAuthMethod !== 'none'
		const clientSecret = confidential ? randomToken('mcps', 32) : null
		const now = new Date().toISOString()
		this.sql.exec(
			`INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris_json, token_endpoint_auth_method,
			   grant_types_json, client_uri, logo_uri, software_id, software_version, created_at, last_used_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
			clientId,
			clientSecret ? await sha256Hex(clientSecret) : null,
			registration.clientName,
			JSON.stringify(registration.redirectUris),
			registration.tokenEndpointAuthMethod,
			JSON.stringify(registration.grantTypes),
			registration.clientUri,
			registration.logoUri,
			registration.softwareId,
			registration.softwareVersion,
			now,
		)
		const client = this.clientGet(clientId)!
		return clientSecret ? { ...client, clientSecret } : client
	}

	clientGet(clientId: string): OAuthClient | null {
		const row = this.sql.exec<ClientRow>('SELECT * FROM oauth_clients WHERE client_id = ?', clientId).toArray()[0]
		return row ? this.toClient(row) : null
	}

	/**
	 * Token/revoke endpoint client authentication. Public clients must not send
	 * a secret; confidential ones must send the right one via a method they
	 * registered with.
	 */
	async clientAuthenticate(input: {
		clientId: string | null
		clientSecret: string | null
		method: TokenEndpointAuthMethod
	}): Promise<OAuthClient> {
		if (!input.clientId) throw new OAuthProtocolError('invalid_client', 'client_id is required.', 401)
		const row = this.sql.exec<ClientRow>('SELECT * FROM oauth_clients WHERE client_id = ?', input.clientId).toArray()[0]
		if (!row) throw new OAuthProtocolError('invalid_client', 'Unknown client.', 401)
		if (row.client_secret_hash) {
			if (!input.clientSecret) {
				throw new OAuthProtocolError('invalid_client', 'This client must authenticate with its client_secret.', 401)
			}
			if (input.method !== row.token_endpoint_auth_method) {
				throw new OAuthProtocolError(
					'invalid_client',
					`This client registered token_endpoint_auth_method=${row.token_endpoint_auth_method}.`,
					401,
				)
			}
			if (!constantTimeEqualString(await sha256Hex(input.clientSecret), row.client_secret_hash)) {
				throw new OAuthProtocolError('invalid_client', 'Client authentication failed.', 401)
			}
		} else if (input.clientSecret) {
			throw new OAuthProtocolError('invalid_client', 'This is a public client; do not send a client_secret.', 401)
		}
		return this.toClient(row)
	}

	private touchClient(clientId: string) {
		this.sql.exec('UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?', new Date().toISOString(), clientId)
	}

	// -------------------------------------------------------------------- codes

	async codeIssue(input: {
		clientId: string
		userId: string
		redirectUri: string
		codeChallenge: string
		scope: string
		resource: string
	}) {
		const code = randomToken('mcpac', 32)
		const now = Date.now()
		this.sql.exec(
			`INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, resource, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			await sha256Hex(code),
			input.clientId,
			input.userId,
			input.redirectUri,
			input.codeChallenge,
			input.scope,
			input.resource,
			new Date(now).toISOString(),
			new Date(now + codeTtlMs).toISOString(),
		)
		return code
	}

	/** One-time: the row is deleted whether or not the rest of the exchange succeeds. */
	async codeConsume(code: string) {
		const hash = await sha256Hex(code)
		const row = this.sql
			.exec<{
				client_id: string
				user_id: string
				redirect_uri: string
				code_challenge: string
				scope: string
				resource: string
				expires_at: string
			}>(
				'SELECT client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at FROM oauth_codes WHERE code_hash = ?',
				hash,
			)
			.toArray()[0]
		if (!row) return null
		const deleted = this.sql.exec('DELETE FROM oauth_codes WHERE code_hash = ?', hash).rowsWritten > 0
		if (!deleted || Date.parse(row.expires_at) <= Date.now()) return null
		return {
			clientId: row.client_id,
			userId: row.user_id,
			redirectUri: row.redirect_uri,
			codeChallenge: row.code_challenge,
			scope: row.scope,
			resource: row.resource,
		}
	}

	// ------------------------------------------------------------------- grants

	/** Idempotent per (user, client): re-authorizing widens scope and starts a new family. */
	grantEnsure(input: { userId: string; clientId: string; scope: string }) {
		const now = new Date().toISOString()
		const existing = this.sql
			.exec<{ id: string; scope: string }>(
				'SELECT id, scope FROM oauth_grants WHERE user_id = ? AND client_id = ?',
				input.userId,
				input.clientId,
			)
			.toArray()[0]
		if (existing) {
			const scope = [...new Set([...existing.scope.split(' '), ...input.scope.split(' ')].filter(Boolean))].join(' ')
			this.sql.exec('UPDATE oauth_grants SET scope = ?, last_used_at = ? WHERE id = ?', scope, now, existing.id)
			return existing.id
		}
		const id = randomId('grant')
		this.sql.exec(
			'INSERT INTO oauth_grants (id, user_id, client_id, scope, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)',
			id,
			input.userId,
			input.clientId,
			input.scope,
			now,
			now,
		)
		return id
	}

	grantList(userId: string): Array<OAuthGrant> {
		this.purge()
		return this.sql
			.exec<{
				id: string
				user_id: string
				client_id: string
				client_name: string
				scope: string
				created_at: string
				last_used_at: string | null
				families: number
			}>(
				`SELECT g.id, g.user_id, g.client_id, c.client_name, g.scope, g.created_at, g.last_used_at,
				   (SELECT count(DISTINCT family_id) FROM oauth_tokens t
				     WHERE t.grant_id = g.id AND t.kind = 'refresh' AND t.replaced_at IS NULL AND t.expires_at > ?) AS families
				 FROM oauth_grants g JOIN oauth_clients c ON c.client_id = g.client_id
				 WHERE g.user_id = ? ORDER BY g.created_at DESC`,
				new Date().toISOString(),
				userId,
			)
			.toArray()
			.map((row) => ({
				id: row.id,
				userId: row.user_id,
				clientId: row.client_id,
				clientName: row.client_name,
				scope: row.scope,
				createdAt: row.created_at,
				lastUsedAt: row.last_used_at,
				activeFamilies: Number(row.families),
			}))
	}

	/** Revokes the grant and every token under it (the user's "disconnect this client"). */
	grantRevoke(userId: string, grantId: string) {
		const owned = this.sql
			.exec('SELECT 1 AS one FROM oauth_grants WHERE id = ? AND user_id = ?', grantId, userId)
			.toArray()[0]
		if (!owned) throw new KodyError('oauth_grant_not_found', `No MCP client grant ${grantId}.`, { status: 404 })
		this.sql.exec('DELETE FROM oauth_tokens WHERE grant_id = ?', grantId)
		this.sql.exec('DELETE FROM oauth_grants WHERE id = ?', grantId)
	}

	/** Every grant/token for a user (account deletion, "sign out everywhere"). */
	grantRevokeAll(userId: string) {
		this.sql.exec('DELETE FROM oauth_tokens WHERE grant_id IN (SELECT id FROM oauth_grants WHERE user_id = ?)', userId)
		this.sql.exec('DELETE FROM oauth_grants WHERE user_id = ?', userId)
	}

	// ------------------------------------------------------------------- tokens

	private async mintPair(grantId: string, familyId: string, scope: string): Promise<TokenResponse> {
		const accessToken = randomToken('mcpat', 32)
		const refreshToken = randomToken('mcprt', 32)
		const now = Date.now()
		this.sql.exec(
			`INSERT INTO oauth_tokens (token_hash, kind, grant_id, family_id, created_at, expires_at) VALUES (?, 'access', ?, ?, ?, ?)`,
			await sha256Hex(accessToken),
			grantId,
			familyId,
			new Date(now).toISOString(),
			new Date(now + accessTokenTtlSeconds * 1000).toISOString(),
		)
		this.sql.exec(
			`INSERT INTO oauth_tokens (token_hash, kind, grant_id, family_id, created_at, expires_at) VALUES (?, 'refresh', ?, ?, ?, ?)`,
			await sha256Hex(refreshToken),
			grantId,
			familyId,
			new Date(now).toISOString(),
			new Date(now + refreshTokenTtlMs).toISOString(),
		)
		this.sql.exec('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?', new Date(now).toISOString(), grantId)
		return {
			access_token: accessToken,
			token_type: 'Bearer',
			expires_in: accessTokenTtlSeconds,
			refresh_token: refreshToken,
			scope,
		}
	}

	/** Authorization-code exchange: a fresh refresh-token family under the grant. */
	async tokensIssue(input: { grantId: string; clientId: string; scope: string }) {
		this.purge()
		this.touchClient(input.clientId)
		return this.mintPair(input.grantId, randomId('fam'), input.scope)
	}

	/**
	 * Refresh-token rotation with reuse detection. The presented token must be
	 * the family's live refresh token for `clientId`. A token rotated out within
	 * the last minute replays the same response (clients retry after a lost
	 * reply); older reuse kills the whole family — someone else has the token.
	 */
	async tokensRefresh(input: { refreshToken: string; clientId: string }): Promise<TokenResponse> {
		this.purge()
		const hash = await sha256Hex(input.refreshToken)
		const row = this.sql
			.exec<TokenRow & { client_id: string; scope: string }>(
				`SELECT t.*, g.client_id, g.scope FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
				 WHERE t.token_hash = ? AND t.kind = 'refresh'`,
				hash,
			)
			.toArray()[0]
		if (!row || row.client_id !== input.clientId) {
			throw new OAuthProtocolError('invalid_grant', 'Unknown or revoked refresh_token.')
		}
		const now = Date.now()
		if (Date.parse(row.expires_at) <= now) {
			this.familyRevoke(row.family_id)
			throw new OAuthProtocolError('invalid_grant', 'refresh_token has expired; authorize again.')
		}
		if (row.replaced_at) {
			if (now - Date.parse(row.replaced_at) <= refreshReplayGraceMs && row.replay_json) {
				const replay = await this.openReplay(row.replay_json)
				if (replay) return replay
			}
			this.familyRevoke(row.family_id)
			throw new OAuthProtocolError('invalid_grant', 'refresh_token was already used; the session has been revoked.')
		}
		// Rotate: retire the family's current access tokens, drop older replay
		// snapshots (only the immediately previous token may be replayed), mark
		// this refresh token replaced.
		this.sql.exec(`DELETE FROM oauth_tokens WHERE family_id = ? AND kind = 'access'`, row.family_id)
		this.sql.exec('UPDATE oauth_tokens SET replay_json = NULL WHERE family_id = ?', row.family_id)
		const fresh = await this.mintPair(row.grant_id, row.family_id, row.scope)
		this.sql.exec(
			'UPDATE oauth_tokens SET replaced_at = ?, replay_json = ? WHERE token_hash = ?',
			new Date(now).toISOString(),
			await this.sealReplay(fresh),
			hash,
		)
		this.touchClient(input.clientId)
		return fresh
	}

	async accessTokenResolve(token: string): Promise<ResolvedAccessToken | null> {
		const row = this.sql
			.exec<{
				grant_id: string
				expires_at: string
				user_id: string
				client_id: string
				client_name: string
				scope: string
			}>(
				`SELECT t.grant_id, t.expires_at, g.user_id, g.client_id, c.client_name, g.scope
				 FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id JOIN oauth_clients c ON c.client_id = g.client_id
				 WHERE t.token_hash = ? AND t.kind = 'access'`,
				await sha256Hex(token),
			)
			.toArray()[0]
		if (!row || Date.parse(row.expires_at) <= Date.now()) return null
		return {
			userId: row.user_id,
			grantId: row.grant_id,
			clientId: row.client_id,
			clientName: row.client_name,
			scope: row.scope,
			expiresAt: row.expires_at,
		}
	}

	/** RFC 7009: revoking a refresh token ends its family; an access token only itself. Unknown tokens are a no-op. */
	async tokenRevoke(input: { token: string; clientId: string }) {
		const row = this.sql
			.exec<{ kind: string; family_id: string; client_id: string }>(
				`SELECT t.kind, t.family_id, g.client_id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
				 WHERE t.token_hash = ?`,
				await sha256Hex(input.token),
			)
			.toArray()[0]
		if (!row || row.client_id !== input.clientId) return false
		if (row.kind === 'refresh') this.familyRevoke(row.family_id)
		else this.sql.exec('DELETE FROM oauth_tokens WHERE token_hash = ?', await sha256Hex(input.token))
		return true
	}

	private familyRevoke(familyId: string) {
		this.sql.exec('DELETE FROM oauth_tokens WHERE family_id = ?', familyId)
	}

	private async sealReplay(response: TokenResponse) {
		const keyring = await this.keyring()
		return JSON.stringify(await encryptSecretValue(keyring.current.key, replayScope, JSON.stringify(response)))
	}

	private async openReplay(json: string): Promise<TokenResponse | null> {
		try {
			const sealed = JSON.parse(json) as EncryptedValue
			return JSON.parse(await decryptWithKeyring(await this.keyring(), replayScope, sealed)) as TokenResponse
		} catch {
			return null
		}
	}

	private purge() {
		const now = Date.now()
		const nowIso = new Date(now).toISOString()
		this.sql.exec('DELETE FROM oauth_codes WHERE expires_at <= ?', nowIso)
		this.sql.exec('DELETE FROM oauth_tokens WHERE expires_at <= ?', nowIso)
		// Replay snapshots are only useful for a minute.
		this.sql.exec(
			'UPDATE oauth_tokens SET replay_json = NULL WHERE replay_json IS NOT NULL AND replaced_at <= ?',
			new Date(now - refreshReplayGraceMs).toISOString(),
		)
		this.sql.exec(
			`DELETE FROM oauth_clients WHERE last_used_at IS NULL AND created_at <= ?
			 AND client_id NOT IN (SELECT client_id FROM oauth_grants)`,
			new Date(now - unusedClientTtlMs).toISOString(),
		)
	}
}

/** Stands in for a user id when deriving the replay-snapshot key (the snapshot is not user data). */
const replayScope = 'oauth-server:replay'
