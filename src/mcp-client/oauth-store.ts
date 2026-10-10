import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { isTokenExpired } from '../integrations/oauth.ts'
import { decryptWithKeyring, encryptSecretValue, type MasterKeyring } from '../lib/crypto.ts'
import { redactSecrets } from './client.ts'

export const mcpOAuthSchema = `
	CREATE TABLE IF NOT EXISTS mcp_server_oauth (
		server_name TEXT PRIMARY KEY,
		client_mode TEXT,
		client_id TEXT,
		client_secret_iv TEXT,
		client_secret_ciphertext TEXT,
		client_secret_key_id TEXT,
		client_issuer TEXT,
		client_info_json TEXT,
		discovery_json TEXT,
		access_iv TEXT,
		access_ciphertext TEXT,
		access_key_id TEXT,
		refresh_iv TEXT,
		refresh_ciphertext TEXT,
		refresh_key_id TEXT,
		token_issuer TEXT,
		token_type TEXT,
		scope TEXT,
		expires_at TEXT,
		refreshed_at TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS mcp_server_oauth_pending (
		state TEXT PRIMARY KEY,
		server_name TEXT NOT NULL,
		server_origin TEXT NOT NULL,
		verifier_iv TEXT NOT NULL,
		verifier_ciphertext TEXT NOT NULL,
		verifier_key_id TEXT,
		redirect_uri TEXT NOT NULL,
		created_at TEXT NOT NULL,
		expires_at TEXT NOT NULL,
		completed_at TEXT
	);
`

export type McpOAuthClientMode = 'preregistered' | 'metadata' | 'dynamic'
export type McpOAuthClient = { mode: McpOAuthClientMode; information: OAuthClientInformationMixed }
export type McpOAuthSummary = {
	clientMode: McpOAuthClientMode | null
	clientId: string | null
	hasClientSecret: boolean
	hasAccessToken: boolean
	hasRefreshToken: boolean
	expiresAt: string | null
}
export type McpOAuthTokenSet = {
	accessToken: string
	refreshToken: string | null
	tokenType: string
	scope: string | null
	expiresAt: string | null
	issuer: string | null
}
export type McpOAuthPending = {
	state: string
	serverName: string
	serverOrigin: string
	verifier: string
	redirectUri: string
	createdAt: string
	expiresAt: string
	completedAt: string | null
}
export type McpTokenRefresher = (input: {
	client: OAuthClientInformationMixed
	refreshToken: string
	discovery: OAuthDiscoveryState | null
}) => Promise<OAuthTokens>
export type McpAccessResult =
	{ ok: true; accessToken: string } | { ok: false; status: 'authenticating' | 'error'; message: string }

export const mcpOAuthPendingTtlMs = 15 * 60_000

type Sealed = { iv: string; ciphertext: string; keyId: string }
type Row = {
	server_name: string
	client_mode: string | null
	client_id: string | null
	client_secret_iv: string | null
	client_secret_ciphertext: string | null
	client_secret_key_id: string | null
	client_issuer: string | null
	client_info_json: string | null
	discovery_json: string | null
	access_iv: string | null
	access_ciphertext: string | null
	access_key_id: string | null
	refresh_iv: string | null
	refresh_ciphertext: string | null
	refresh_key_id: string | null
	token_issuer: string | null
	token_type: string | null
	scope: string | null
	expires_at: string | null
	refreshed_at: string | null
	created_at: string
	updated_at: string
}
type PendingRow = {
	state: string
	server_name: string
	server_origin: string
	verifier_iv: string
	verifier_ciphertext: string
	verifier_key_id: string | null
	redirect_uri: string
	created_at: string
	expires_at: string
	completed_at: string | null
}

const nowIso = () => new Date().toISOString()

/** True for an OAuth `invalid_grant` (SDK OAuthError.errorCode, or the code in the message). */
export function isInvalidGrant(error: unknown) {
	const code = (error as { errorCode?: unknown } | null)?.errorCode
	return code === 'invalid_grant' || /\binvalid_grant\b/.test(error instanceof Error ? error.message : String(error))
}

export class McpOAuthStore {
	private readonly host: { sql: SqlStorage; userId: () => string; keyring: () => Promise<MasterKeyring> }
	private readonly inFlight = new Map<string, Promise<McpAccessResult>>()
	/** Bumped by clear(): a refresh that started before it must not write tokens back. */
	private readonly generation = new Map<string, number>()

	constructor(host: { sql: SqlStorage; userId: () => string; keyring: () => Promise<MasterKeyring> }) {
		this.host = host
	}

	private row(name: string) {
		return this.host.sql.exec<Row>('SELECT * FROM mcp_server_oauth WHERE server_name = ?', name).toArray()[0] ?? null
	}

	private ensureRow(name: string) {
		const now = nowIso()
		this.host.sql.exec(
			'INSERT INTO mcp_server_oauth (server_name, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(server_name) DO NOTHING',
			name,
			now,
			now,
		)
	}

	private async seal(plaintext: string): Promise<Sealed> {
		const { current } = await this.host.keyring()
		const encrypted = await encryptSecretValue(current.key, this.host.userId(), plaintext)
		return { iv: encrypted.iv, ciphertext: encrypted.ciphertext, keyId: current.id }
	}

	private async open(iv: string | null, ciphertext: string | null, keyId: string | null) {
		if (!iv || !ciphertext) return null
		return decryptWithKeyring(await this.host.keyring(), this.host.userId(), {
			iv,
			ciphertext,
			keyId: keyId || undefined,
		})
	}

	summary(name: string): McpOAuthSummary | null {
		const row = this.row(name)
		if (!row) return null
		return {
			clientMode: (row.client_mode as McpOAuthClientMode | null) ?? null,
			clientId: row.client_id,
			hasClientSecret: row.client_secret_ciphertext !== null,
			hasAccessToken: row.access_ciphertext !== null,
			hasRefreshToken: row.refresh_ciphertext !== null,
			expiresAt: row.expires_at,
		}
	}

	async client(name: string): Promise<McpOAuthClient | null> {
		const row = this.row(name)
		if (!row?.client_id || !row.client_mode) return null
		const secret = await this.open(row.client_secret_iv, row.client_secret_ciphertext, row.client_secret_key_id)
		const info = row.client_info_json ? (JSON.parse(row.client_info_json) as Record<string, unknown>) : {}
		return {
			mode: row.client_mode as McpOAuthClientMode,
			information: {
				...info,
				client_id: row.client_id,
				...(secret ? { client_secret: secret } : {}),
				...(row.client_issuer ? { issuer: row.client_issuer } : {}),
			} as OAuthClientInformationMixed,
		}
	}

	async saveClient(name: string, client: McpOAuthClient) {
		const { client_id, client_secret, issuer, ...rest } = client.information as OAuthClientInformationMixed & {
			client_secret?: string
			issuer?: string
		}
		const secret = client_secret ? await this.seal(client_secret) : null
		this.ensureRow(name)
		this.host.sql.exec(
			`UPDATE mcp_server_oauth SET client_mode = ?, client_id = ?, client_secret_iv = ?, client_secret_ciphertext = ?,
			   client_secret_key_id = ?, client_issuer = ?, client_info_json = ?, updated_at = ? WHERE server_name = ?`,
			client.mode,
			client_id,
			secret?.iv ?? null,
			secret?.ciphertext ?? null,
			secret?.keyId ?? null,
			issuer ?? null,
			JSON.stringify(rest),
			nowIso(),
			name,
		)
	}

	/** The SDK hands back client information (DCR result, or an issuer-stamped stored client): keep the stored mode. */
	async saveClientInformation(name: string, information: OAuthClientInformationMixed) {
		const mode = (this.row(name)?.client_mode as McpOAuthClientMode | null) ?? 'dynamic'
		await this.saveClient(name, { mode, information })
	}

	clearClient(name: string) {
		this.host.sql.exec(
			`UPDATE mcp_server_oauth SET client_mode = NULL, client_id = NULL, client_secret_iv = NULL, client_secret_ciphertext = NULL,
			   client_secret_key_id = NULL, client_issuer = NULL, client_info_json = NULL, updated_at = ? WHERE server_name = ?`,
			nowIso(),
			name,
		)
		this.clearTokens(name)
	}

	async tokens(name: string): Promise<McpOAuthTokenSet | null> {
		const row = this.row(name)
		const access = row ? await this.open(row.access_iv, row.access_ciphertext, row.access_key_id) : null
		if (!row || !access) return null
		return {
			accessToken: access,
			refreshToken: await this.open(row.refresh_iv, row.refresh_ciphertext, row.refresh_key_id),
			tokenType: row.token_type ?? 'Bearer',
			scope: row.scope,
			expiresAt: row.expires_at,
			issuer: row.token_issuer,
		}
	}

	async saveTokens(name: string, tokens: OAuthTokens) {
		const access = await this.seal(tokens.access_token)
		const refresh = tokens.refresh_token ? await this.seal(tokens.refresh_token) : null
		const now = nowIso()
		const expiresAt =
			typeof tokens.expires_in === 'number' ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null
		this.ensureRow(name)
		this.host.sql.exec(
			`UPDATE mcp_server_oauth SET access_iv = ?, access_ciphertext = ?, access_key_id = ?, token_type = ?, scope = ?,
			   expires_at = ?, token_issuer = COALESCE(?, token_issuer), refreshed_at = ?, updated_at = ? WHERE server_name = ?`,
			access.iv,
			access.ciphertext,
			access.keyId,
			tokens.token_type,
			tokens.scope ?? null,
			expiresAt,
			tokens.issuer ?? null,
			now,
			now,
			name,
		)
		// RFC 6749 §6: a refresh response may omit refresh_token; keep the stored one then.
		if (refresh) {
			this.host.sql.exec(
				'UPDATE mcp_server_oauth SET refresh_iv = ?, refresh_ciphertext = ?, refresh_key_id = ? WHERE server_name = ?',
				refresh.iv,
				refresh.ciphertext,
				refresh.keyId,
				name,
			)
		}
	}

	clearTokens(name: string) {
		this.host.sql.exec(
			`UPDATE mcp_server_oauth SET access_iv = NULL, access_ciphertext = NULL, access_key_id = NULL, refresh_iv = NULL,
			   refresh_ciphertext = NULL, refresh_key_id = NULL, token_issuer = NULL, token_type = NULL, scope = NULL,
			   expires_at = NULL, updated_at = ? WHERE server_name = ?`,
			nowIso(),
			name,
		)
	}

	discovery(name: string): OAuthDiscoveryState | null {
		const raw = this.row(name)?.discovery_json
		return raw ? (JSON.parse(raw) as OAuthDiscoveryState) : null
	}

	saveDiscovery(name: string, discovery: OAuthDiscoveryState) {
		this.ensureRow(name)
		this.host.sql.exec(
			'UPDATE mcp_server_oauth SET discovery_json = ?, updated_at = ? WHERE server_name = ?',
			JSON.stringify(discovery),
			nowIso(),
			name,
		)
	}

	async createPending(input: {
		state: string
		serverName: string
		serverOrigin: string
		verifier: string
		redirectUri: string
	}) {
		const now = Date.now()
		this.host.sql.exec(
			'DELETE FROM mcp_server_oauth_pending WHERE expires_at < ? OR (completed_at IS NOT NULL AND completed_at < ?)',
			new Date(now).toISOString(),
			new Date(now - 86_400_000).toISOString(),
		)
		const verifier = await this.seal(input.verifier)
		const expiresAt = new Date(now + mcpOAuthPendingTtlMs).toISOString()
		this.host.sql.exec(
			`INSERT INTO mcp_server_oauth_pending (state, server_name, server_origin, verifier_iv, verifier_ciphertext, verifier_key_id, redirect_uri, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			input.state,
			input.serverName,
			input.serverOrigin,
			verifier.iv,
			verifier.ciphertext,
			verifier.keyId,
			input.redirectUri,
			new Date(now).toISOString(),
			expiresAt,
		)
		return { expiresAt }
	}

	/** Marks the attempt used in the same synchronous step that reads it, so a second callback is always a replay. */
	async claimPending(state: string) {
		const row = this.host.sql
			.exec<PendingRow>('SELECT * FROM mcp_server_oauth_pending WHERE state = ?', state)
			.toArray()[0]
		if (!row) return null
		const firstClaim = row.completed_at === null
		const completedAt = row.completed_at ?? nowIso()
		if (firstClaim)
			this.host.sql.exec('UPDATE mcp_server_oauth_pending SET completed_at = ? WHERE state = ?', completedAt, state)
		const pending: McpOAuthPending = {
			state: row.state,
			serverName: row.server_name,
			serverOrigin: row.server_origin,
			verifier: (await this.open(row.verifier_iv, row.verifier_ciphertext, row.verifier_key_id)) ?? '',
			redirectUri: row.redirect_uri,
			createdAt: row.created_at,
			expiresAt: row.expires_at,
			completedAt,
		}
		return { pending, firstClaim, expired: Date.parse(row.expires_at) < Date.now() }
	}

	async accessToken(
		name: string,
		options: { forceRefresh: boolean; refresher: McpTokenRefresher; staleAccessToken?: string },
	): Promise<McpAccessResult> {
		const running = this.inFlight.get(name)
		if (running) return running
		const tokens = await this.tokens(name)
		if (!tokens) return { ok: false, status: 'authenticating', message: 'No OAuth grant yet; authorize the server.' }
		if (options.staleAccessToken && options.staleAccessToken !== tokens.accessToken) {
			return { ok: true, accessToken: tokens.accessToken }
		}
		const expiring = tokens.expiresAt !== null && isTokenExpired(tokens.expiresAt)
		if (!options.forceRefresh && !expiring) return { ok: true, accessToken: tokens.accessToken }
		if (!tokens.refreshToken) {
			this.clearTokens(name)
			return {
				ok: false,
				status: 'authenticating',
				message: options.forceRefresh
					? 'The access token was rejected and there is no refresh token; authorize again.'
					: 'The access token expired and there is no refresh token; authorize again.',
			}
		}
		const again = this.inFlight.get(name)
		if (again) return again
		const task = this.refreshNow(name, tokens, options.refresher).finally(() => this.inFlight.delete(name))
		this.inFlight.set(name, task)
		return task
	}

	private async refreshNow(
		name: string,
		tokens: McpOAuthTokenSet,
		refresher: McpTokenRefresher,
	): Promise<McpAccessResult> {
		const startedAt = this.generation.get(name) ?? 0
		const changed = () => (this.generation.get(name) ?? 0) !== startedAt || this.row(name) === null
		const changedResult: McpAccessResult = {
			ok: false,
			status: 'authenticating',
			message: 'The server was changed while refreshing; authorize again.',
		}
		const client = await this.client(name)
		if (changed()) return changedResult
		const discovery = this.discovery(name)
		if (!client) {
			this.clearTokens(name)
			return {
				ok: false,
				status: 'authenticating',
				message: 'The OAuth client registration is missing; authorize again.',
			}
		}
		if (tokens.issuer && discovery && tokens.issuer !== discovery.authorizationServerUrl) {
			this.clearTokens(name)
			return {
				ok: false,
				status: 'authenticating',
				message: 'The tokens were issued by a different authorization server; authorize again.',
			}
		}
		let next: OAuthTokens
		try {
			next = await refresher({ client: client.information, refreshToken: tokens.refreshToken!, discovery })
		} catch (error) {
			if (changed()) return changedResult
			if (isInvalidGrant(error)) {
				this.clearTokens(name)
				return { ok: false, status: 'authenticating', message: 'The refresh token was rejected; authorize again.' }
			}
			const secret = (client.information as { client_secret?: string }).client_secret
			const message = redactSecrets(error instanceof Error ? error.message : String(error), [
				tokens.accessToken,
				tokens.refreshToken,
				secret,
			]).slice(0, 300)
			return { ok: false, status: 'error', message: `Token refresh failed: ${message}` }
		}
		if (changed()) return changedResult
		await this.saveTokens(name, { ...next, issuer: next.issuer ?? tokens.issuer ?? undefined })
		return { ok: true, accessToken: next.access_token }
	}

	clear(name: string) {
		this.generation.set(name, (this.generation.get(name) ?? 0) + 1)
		this.inFlight.delete(name)
		this.host.sql.exec('DELETE FROM mcp_server_oauth WHERE server_name = ?', name)
		this.host.sql.exec('DELETE FROM mcp_server_oauth_pending WHERE server_name = ?', name)
	}

	/** Re-seals client secrets, tokens and pending verifiers with the current master key (see secretRekey). */
	async rekey(): Promise<{ resealed: number; remaining: number }> {
		const keyring = await this.host.keyring()
		const current = keyring.current.id
		let resealed = 0
		const columns = [
			['client_secret_iv', 'client_secret_ciphertext', 'client_secret_key_id'],
			['access_iv', 'access_ciphertext', 'access_key_id'],
			['refresh_iv', 'refresh_ciphertext', 'refresh_key_id'],
		] as const
		for (const [ivCol, ctCol, keyCol] of columns) {
			const rows = this.host.sql
				.exec<Record<string, string | null>>(
					`SELECT server_name, ${ivCol} AS iv, ${ctCol} AS ct, ${keyCol} AS k FROM mcp_server_oauth WHERE ${ctCol} IS NOT NULL AND (${keyCol} IS NULL OR ${keyCol} != ?)`,
					current,
				)
				.toArray()
			for (const row of rows) {
				try {
					const plaintext = await decryptWithKeyring(keyring, this.host.userId(), {
						iv: row.iv!,
						ciphertext: row.ct!,
						keyId: row.k || undefined,
					})
					const next = await encryptSecretValue(keyring.current.key, this.host.userId(), plaintext)
					this.host.sql.exec(
						`UPDATE mcp_server_oauth SET ${ivCol} = ?, ${ctCol} = ?, ${keyCol} = ? WHERE server_name = ?`,
						next.iv,
						next.ciphertext,
						current,
						row.server_name,
					)
					resealed++
				} catch (error) {
					console.error(
						`mcp oauth rekey: cannot decrypt ${ctCol} for "${row.server_name}":`,
						error instanceof Error ? error.message : error,
					)
				}
			}
		}
		const pending = this.host.sql
			.exec<PendingRow>(
				'SELECT * FROM mcp_server_oauth_pending WHERE verifier_key_id IS NULL OR verifier_key_id != ?',
				current,
			)
			.toArray()
		for (const row of pending) {
			try {
				const plaintext = await decryptWithKeyring(keyring, this.host.userId(), {
					iv: row.verifier_iv,
					ciphertext: row.verifier_ciphertext,
					keyId: row.verifier_key_id || undefined,
				})
				const next = await encryptSecretValue(keyring.current.key, this.host.userId(), plaintext)
				this.host.sql.exec(
					'UPDATE mcp_server_oauth_pending SET verifier_iv = ?, verifier_ciphertext = ?, verifier_key_id = ? WHERE state = ?',
					next.iv,
					next.ciphertext,
					current,
					row.state,
				)
				resealed++
			} catch (error) {
				console.error(
					'mcp oauth rekey: cannot decrypt a pending verifier:',
					error instanceof Error ? error.message : error,
				)
			}
		}
		const remaining =
			columns.reduce(
				(sum, [, ctCol, keyCol]) =>
					sum +
					(this.host.sql
						.exec<{ c: number }>(
							`SELECT count(*) AS c FROM mcp_server_oauth WHERE ${ctCol} IS NOT NULL AND (${keyCol} IS NULL OR ${keyCol} != ?)`,
							current,
						)
						.toArray()[0]?.c ?? 0),
				0,
			) +
			(this.host.sql
				.exec<{ c: number }>(
					'SELECT count(*) AS c FROM mcp_server_oauth_pending WHERE verifier_key_id IS NULL OR verifier_key_id != ?',
					current,
				)
				.toArray()[0]?.c ?? 0)
		return { resealed, remaining }
	}
}
