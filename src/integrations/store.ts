import {
	decryptWithKeyring,
	encryptSecretValue,
	randomId,
	sha256Hex,
	type EncryptedValue,
	type MasterKeyring,
} from '../lib/crypto.ts'
import { KodyError } from '../lib/errors.ts'
import { isCredentialTransportAllowed, isHostApproved } from '../secrets/host-policy.ts'
import {
	buildAuthorizeUrl,
	buildTokenRequest,
	connectTicketTtlMs,
	encodeState,
	isTokenExpired,
	parseTokenResponse,
	pkceChallenge,
	randomUrlSafe,
	usagePermits,
	type IntegrationConfig,
	type IntegrationUsage,
	type TokenGrant,
	type TokenResponse,
} from './oauth.ts'

// Per-user OAuth integrations, stored inside the UserCell's SQLite. One row is
// both the OAuth app (client id + encrypted client secret) and the connection
// (encrypted access/refresh tokens). Everything that leaves this module is
// metadata: tokens are only handed to `tokenResolve`, whose sole caller is the
// fetch gateway.

export type IntegrationStatus = 'pending' | 'connected' | 'auth_failed'

export type IntegrationRecord = IntegrationConfig & {
	hasClientSecret: boolean
	status: IntegrationStatus
	tokenType: string | null
	expiresAt: string | null
	hasRefreshToken: boolean
	grantedScope: string | null
	connectedAt: string | null
	refreshedAt: string | null
	lastUsedAt: string | null
	authFailedAt: string | null
	authFailedReason: string | null
	createdAt: string
	updatedAt: string
	placeholder: string
}

export type ConnectTicket = { connectId: string; ticket: string; expiresAt: string }

export type ConnectRecord = {
	id: string
	name: string
	redirectUri: string
	createdAt: string
	expiresAt: string
	startedAt: string | null
	completedAt: string | null
	error: string | null
}

export type TokenResolution =
	| { ok: true; token: string; record: IntegrationRecord; refreshed: boolean }
	| { ok: false; code: string; status: number; message: string; record: IntegrationRecord | null }

type IntegrationRow = {
	name: string
	config_json: string
	client_secret_iv: string | null
	client_secret_ciphertext: string | null
	client_secret_key_id: string | null
	access_iv: string | null
	access_ciphertext: string | null
	access_key_id: string | null
	refresh_iv: string | null
	refresh_ciphertext: string | null
	refresh_key_id: string | null
	token_type: string | null
	expires_at: string | null
	granted_scope: string | null
	status: string
	connected_at: string | null
	refreshed_at: string | null
	last_used_at: string | null
	auth_failed_at: string | null
	auth_failed_reason: string | null
	created_at: string
	updated_at: string
}

type ConnectRow = {
	id: string
	name: string
	ticket_hash: string
	nonce_hash: string | null
	verifier_iv: string | null
	verifier_ciphertext: string | null
	verifier_key_id: string | null
	redirect_uri: string
	created_at: string
	expires_at: string
	started_at: string | null
	completed_at: string | null
	error: string | null
}

export type IntegrationStoreHost = {
	sql: SqlStorage
	userId: () => string
	keyring: () => Promise<MasterKeyring>
	insecureAllowance: ReadonlyArray<string>
	fetch: typeof fetch
}

export const integrationSchema = `
	CREATE TABLE IF NOT EXISTS integrations (
		name TEXT PRIMARY KEY,
		config_json TEXT NOT NULL,
		client_secret_iv TEXT,
		client_secret_ciphertext TEXT,
		client_secret_key_id TEXT,
		access_iv TEXT,
		access_ciphertext TEXT,
		access_key_id TEXT,
		refresh_iv TEXT,
		refresh_ciphertext TEXT,
		refresh_key_id TEXT,
		token_type TEXT,
		expires_at TEXT,
		granted_scope TEXT,
		status TEXT NOT NULL,
		connected_at TEXT,
		refreshed_at TEXT,
		last_used_at TEXT,
		auth_failed_at TEXT,
		auth_failed_reason TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS integration_connects (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		ticket_hash TEXT NOT NULL,
		nonce_hash TEXT,
		verifier_iv TEXT,
		verifier_ciphertext TEXT,
		verifier_key_id TEXT,
		redirect_uri TEXT NOT NULL,
		created_at TEXT NOT NULL,
		expires_at TEXT NOT NULL,
		started_at TEXT,
		completed_at TEXT,
		error TEXT
	);
	CREATE INDEX IF NOT EXISTS integration_connects_name ON integration_connects (name, created_at);
`

const tokenRequestTimeoutMs = 15_000
const maxTokenResponseBytes = 64 * 1024

function nowIso() {
	return new Date().toISOString()
}

function constantTimeEqual(a: string, b: string) {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
	return diff === 0
}

function sealed(iv: string | null, ciphertext: string | null, keyId: string | null): EncryptedValue | null {
	if (iv === null || ciphertext === null) return null
	return { iv, ciphertext, keyId: keyId || undefined }
}

/** What subscribed packages see about a connection on `integration.auth.*` events: metadata only. */
export function integrationEventPayload(record: IntegrationRecord) {
	return {
		name: record.name,
		provider: record.provider,
		flow: record.flow,
		status: record.status,
		scopes: record.scopes,
		grantedScope: record.grantedScope,
		expiresAt: record.expiresAt,
		allowedHosts: record.allowedHosts,
		placeholder: record.placeholder,
	}
}

export class IntegrationStore {
	private readonly inFlightRefresh = new Map<string, Promise<TokenResolution>>()

	constructor(private readonly host: IntegrationStoreHost) {}

	private row(name: string) {
		return this.host.sql.exec<IntegrationRow>('SELECT * FROM integrations WHERE name = ?', name).toArray()[0] ?? null
	}

	private toRecord(row: IntegrationRow): IntegrationRecord {
		const config = JSON.parse(row.config_json) as IntegrationConfig
		return {
			...config,
			hasClientSecret: row.client_secret_ciphertext !== null,
			status: row.status as IntegrationStatus,
			tokenType: row.token_type,
			expiresAt: row.expires_at,
			hasRefreshToken: row.refresh_ciphertext !== null,
			grantedScope: row.granted_scope,
			connectedAt: row.connected_at,
			refreshedAt: row.refreshed_at,
			lastUsedAt: row.last_used_at,
			authFailedAt: row.auth_failed_at,
			authFailedReason: row.auth_failed_reason,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			placeholder: `{{integration-token:${config.name}}}`,
		}
	}

	private async seal(plaintext: string) {
		const { current } = await this.host.keyring()
		const encrypted = await encryptSecretValue(current.key, this.host.userId(), plaintext)
		return { iv: encrypted.iv, ciphertext: encrypted.ciphertext, keyId: current.id }
	}

	private async open(value: EncryptedValue) {
		return decryptWithKeyring(await this.host.keyring(), this.host.userId(), value)
	}

	list(): Array<IntegrationRecord> {
		return this.host.sql
			.exec<IntegrationRow>('SELECT * FROM integrations ORDER BY name')
			.toArray()
			.map((row) => this.toRecord(row))
	}

	get(name: string): IntegrationRecord | null {
		const row = this.row(name)
		return row ? this.toRecord(row) : null
	}

	require(name: string) {
		const record = this.get(name)
		if (!record) throw new KodyError('integration_not_found', `Integration "${name}" was not found.`, { status: 404 })
		return record
	}

	/**
	 * Creates or updates the app + connection description. `clientSecret`
	 * undefined keeps the stored secret, null clears it (public PKCE client),
	 * a string replaces it. Changing token endpoints or client id invalidates
	 * the stored tokens, so the connection drops back to pending.
	 */
	async save(config: IntegrationConfig, clientSecret: string | null | undefined): Promise<IntegrationRecord> {
		const existing = this.row(config.name)
		const now = nowIso()
		const secret = clientSecret === undefined ? undefined : clientSecret === null ? null : await this.seal(clientSecret)
		if (!existing) {
			this.host.sql.exec(
				`INSERT INTO integrations (name, config_json, client_secret_iv, client_secret_ciphertext, client_secret_key_id,
				   status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
				config.name,
				JSON.stringify(config),
				secret?.iv ?? null,
				secret?.ciphertext ?? null,
				secret?.keyId ?? null,
				now,
				now,
			)
			return this.require(config.name)
		}
		const previous = JSON.parse(existing.config_json) as IntegrationConfig
		const credentialsChanged =
			previous.tokenUrl !== config.tokenUrl ||
			previous.clientId !== config.clientId ||
			previous.flow !== config.flow ||
			previous.authorizeUrl !== config.authorizeUrl ||
			(previous.scopes.join(' ') !== config.scopes.join(' ') && config.flow === 'authorization_code')
		this.host.sql.exec(
			'UPDATE integrations SET config_json = ?, updated_at = ? WHERE name = ?',
			JSON.stringify(config),
			now,
			config.name,
		)
		if (secret !== undefined) {
			this.host.sql.exec(
				'UPDATE integrations SET client_secret_iv = ?, client_secret_ciphertext = ?, client_secret_key_id = ? WHERE name = ?',
				secret?.iv ?? null,
				secret?.ciphertext ?? null,
				secret?.keyId ?? null,
				config.name,
			)
		}
		if (credentialsChanged) this.clearTokens(config.name, 'pending', null)
		return this.require(config.name)
	}

	setUsage(name: string, usage: IntegrationUsage): IntegrationRecord {
		const record = this.require(name)
		const config: IntegrationConfig = { ...record, usage }
		this.host.sql.exec(
			'UPDATE integrations SET config_json = ?, updated_at = ? WHERE name = ?',
			JSON.stringify(stripRecord(config)),
			nowIso(),
			name,
		)
		return this.require(name)
	}

	delete(name: string) {
		const cursor = this.host.sql.exec('DELETE FROM integrations WHERE name = ?', name)
		this.host.sql.exec('DELETE FROM integration_connects WHERE name = ?', name)
		return { deleted: cursor.rowsWritten > 0 }
	}

	private clearTokens(name: string, status: IntegrationStatus, reason: string | null) {
		const now = nowIso()
		this.host.sql.exec(
			`UPDATE integrations SET access_iv = NULL, access_ciphertext = NULL, access_key_id = NULL,
			   refresh_iv = NULL, refresh_ciphertext = NULL, refresh_key_id = NULL, token_type = NULL, expires_at = NULL,
			   granted_scope = NULL, status = ?, auth_failed_at = ?, auth_failed_reason = ?, updated_at = ? WHERE name = ?`,
			status,
			status === 'auth_failed' ? now : null,
			reason,
			now,
			name,
		)
	}

	/** Disconnects (drops tokens) but keeps the app description so the user can reconnect. */
	disconnect(name: string) {
		this.require(name)
		this.clearTokens(name, 'pending', null)
		return this.require(name)
	}

	// ------------------------------------------------------------- connect flow

	/** Mints a one-time connect link ticket; the plaintext ticket is returned exactly once. */
	async connectStart(name: string, redirectUri: string): Promise<ConnectTicket> {
		const record = this.require(name)
		if (record.flow !== 'authorization_code') {
			throw new KodyError(
				'integration_flow_mismatch',
				`Integration "${name}" uses ${record.flow}; connect it with integrationTokenRefresh instead.`,
			)
		}
		const id = randomId('cn')
		const ticket = randomUrlSafe(32)
		const now = new Date()
		const expiresAt = new Date(now.getTime() + connectTicketTtlMs).toISOString()
		this.host.sql.exec(
			`INSERT INTO integration_connects (id, name, ticket_hash, redirect_uri, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
			id,
			name,
			await sha256Hex(ticket),
			redirectUri,
			now.toISOString(),
			expiresAt,
		)
		this.host.sql.exec(`DELETE FROM integration_connects WHERE name = ? AND id != ? AND completed_at IS NULL`, name, id)
		return { connectId: id, ticket, expiresAt }
	}

	private connectRow(id: string) {
		return this.host.sql.exec<ConnectRow>('SELECT * FROM integration_connects WHERE id = ?', id).toArray()[0] ?? null
	}

	private toConnect(row: ConnectRow): ConnectRecord {
		return {
			id: row.id,
			name: row.name,
			redirectUri: row.redirect_uri,
			createdAt: row.created_at,
			expiresAt: row.expires_at,
			startedAt: row.started_at,
			completedAt: row.completed_at,
			error: row.error,
		}
	}

	connectGet(id: string): ConnectRecord | null {
		const row = this.connectRow(id)
		return row ? this.toConnect(row) : null
	}

	/** Latest connect attempt for an integration (status for the agent to poll). */
	connectLatest(name: string): ConnectRecord | null {
		const row = this.host.sql
			.exec<ConnectRow>('SELECT * FROM integration_connects WHERE name = ? ORDER BY created_at DESC LIMIT 1', name)
			.toArray()[0]
		return row ? this.toConnect(row) : null
	}

	/**
	 * The user opened the connect link: burns the ticket, generates PKCE + state
	 * and returns the provider authorize URL to redirect to.
	 */
	async connectBegin(input: { connectId: string; ticket: string }): Promise<{ authorizeUrl: string }> {
		const row = this.connectRow(input.connectId)
		const invalid = () =>
			new KodyError(
				'connect_link_invalid',
				'This connect link is invalid, expired, or was already used. Ask for a new one.',
				{
					status: 404,
				},
			)
		if (!row || row.started_at !== null || row.completed_at !== null) throw invalid()
		if (new Date(row.expires_at).getTime() <= Date.now()) throw invalid()
		if (!constantTimeEqual(await sha256Hex(input.ticket), row.ticket_hash)) throw invalid()
		const record = this.require(row.name)
		const verifier = randomUrlSafe(48)
		const nonce = randomUrlSafe(24)
		const verifierSealed = await this.seal(verifier)
		this.host.sql.exec(
			`UPDATE integration_connects SET started_at = ?, nonce_hash = ?, verifier_iv = ?, verifier_ciphertext = ?, verifier_key_id = ? WHERE id = ?`,
			nowIso(),
			await sha256Hex(nonce),
			verifierSealed.iv,
			verifierSealed.ciphertext,
			verifierSealed.keyId,
			row.id,
		)
		return {
			authorizeUrl: buildAuthorizeUrl({
				config: record,
				redirectUri: row.redirect_uri,
				state: encodeState(this.host.userId(), row.id, nonce),
				codeChallenge: await pkceChallenge(verifier),
			}),
		}
	}

	/** Provider redirected back: validates state, exchanges the code, seals the tokens. */
	async connectComplete(input: {
		connectId: string
		nonce: string
		code: string | null
		providerError: string | null
	}): Promise<{ record: IntegrationRecord; connect: ConnectRecord }> {
		const row = this.connectRow(input.connectId)
		const invalid = () =>
			new KodyError('connect_state_invalid', 'The OAuth state does not match a pending connect attempt.', {
				status: 400,
			})
		if (!row || row.started_at === null || row.completed_at !== null || row.nonce_hash === null) throw invalid()
		if (!constantTimeEqual(await sha256Hex(input.nonce), row.nonce_hash)) throw invalid()
		const record = this.require(row.name)
		const finishConnect = (error: string | null) => {
			this.host.sql.exec(
				'UPDATE integration_connects SET completed_at = ?, error = ? WHERE id = ?',
				nowIso(),
				error,
				row.id,
			)
		}
		if (new Date(row.expires_at).getTime() + connectTicketTtlMs <= Date.now()) {
			finishConnect('expired')
			throw new KodyError('connect_link_invalid', 'This connect attempt expired. Ask for a new link.', { status: 400 })
		}
		// A failed (re)connect only downgrades the integration when there is no
		// live token to keep; a denied consent screen must not break a working one.
		const failAuth = (reason: string) => {
			if (record.status !== 'connected') this.clearTokens(record.name, 'auth_failed', reason)
		}
		if (input.providerError !== null || input.code === null) {
			const reason = (input.providerError ?? 'missing_code').slice(0, 120)
			finishConnect(reason)
			failAuth(`provider: ${reason}`)
			throw new KodyError('oauth_denied', `The provider returned "${reason}" instead of an authorization code.`, {
				status: 400,
			})
		}
		const verifierSealed = sealed(row.verifier_iv, row.verifier_ciphertext, row.verifier_key_id)
		if (!verifierSealed) throw invalid()
		const codeVerifier = await this.open(verifierSealed)
		try {
			const tokens = await this.requestTokens(record, {
				grantType: 'authorization_code',
				code: input.code,
				redirectUri: row.redirect_uri,
				codeVerifier,
			})
			await this.storeTokens(record.name, tokens, { keepRefresh: false })
			finishConnect(null)
		} catch (error) {
			const kody = KodyError.fromUnknown(error)
			const reason = (kody?.message ?? (error instanceof Error ? error.message : String(error))).slice(0, 200)
			finishConnect(reason)
			failAuth(reason)
			throw error
		}
		return { record: this.require(record.name), connect: this.connectGet(row.id)! }
	}

	// ---------------------------------------------------------------- tokens

	private async requestTokens(record: IntegrationRecord, grant: TokenGrant): Promise<TokenResponse> {
		const row = this.row(record.name)
		if (!row)
			throw new KodyError('integration_not_found', `Integration "${record.name}" was not found.`, { status: 404 })
		const tokenUrl = new URL(record.tokenUrl)
		if (!isCredentialTransportAllowed(tokenUrl, this.host.insecureAllowance)) {
			throw new KodyError('integration_requires_https', `tokenUrl ${tokenUrl.origin} must use https.`, { status: 403 })
		}
		const clientSecretSealed = sealed(row.client_secret_iv, row.client_secret_ciphertext, row.client_secret_key_id)
		const clientSecret = clientSecretSealed ? await this.open(clientSecretSealed) : null
		if (grant.grantType === 'client_credentials' && clientSecret === null) {
			throw new KodyError('integration_client_secret_required', 'client_credentials needs a clientSecret.')
		}
		const request = buildTokenRequest({ config: record, clientSecret, grant })
		let response: Response
		try {
			response = await this.host.fetch(request.url, {
				method: request.method,
				headers: request.headers,
				body: request.body,
				signal: AbortSignal.timeout(tokenRequestTimeoutMs),
				redirect: 'manual',
			})
		} catch (error) {
			throw new KodyError(
				'oauth_token_error',
				`Token endpoint unreachable: ${error instanceof Error ? error.message : String(error)}`,
				{
					status: 502,
				},
			)
		}
		const body = (await response.text()).slice(0, maxTokenResponseBytes)
		return parseTokenResponse({ status: response.status, contentType: response.headers.get('content-type'), body })
	}

	private async storeTokens(name: string, tokens: TokenResponse, options: { keepRefresh: boolean }) {
		const access = await this.seal(tokens.accessToken)
		const refresh = tokens.refreshToken ? await this.seal(tokens.refreshToken) : null
		const now = nowIso()
		this.host.sql.exec(
			`UPDATE integrations SET access_iv = ?, access_ciphertext = ?, access_key_id = ?, token_type = ?, expires_at = ?,
			   granted_scope = ?, status = 'connected', auth_failed_at = NULL, auth_failed_reason = NULL,
			   connected_at = COALESCE(connected_at, ?), refreshed_at = ?, updated_at = ? WHERE name = ?`,
			access.iv,
			access.ciphertext,
			access.keyId,
			tokens.tokenType,
			tokens.expiresAt,
			tokens.scope,
			now,
			now,
			now,
			name,
		)
		if (refresh) {
			this.host.sql.exec(
				'UPDATE integrations SET refresh_iv = ?, refresh_ciphertext = ?, refresh_key_id = ? WHERE name = ?',
				refresh.iv,
				refresh.ciphertext,
				refresh.keyId,
				name,
			)
		} else if (!options.keepRefresh) {
			this.host.sql.exec(
				'UPDATE integrations SET refresh_iv = NULL, refresh_ciphertext = NULL, refresh_key_id = NULL WHERE name = ?',
				name,
			)
		}
	}

	/**
	 * Host-side refresh. `refresh_token` grants rotate the access token (and the
	 * refresh token when the provider issues a new one); `client_credentials`
	 * connections simply mint a fresh token. Returns metadata only.
	 */
	refresh(name: string): Promise<TokenResolution> {
		const pending = this.inFlightRefresh.get(name)
		if (pending) return pending
		const task = this.refreshNow(name).finally(() => this.inFlightRefresh.delete(name))
		this.inFlightRefresh.set(name, task)
		return task
	}

	private async refreshNow(name: string): Promise<TokenResolution> {
		const row = this.row(name)
		if (!row)
			return {
				ok: false,
				code: 'integration_not_found',
				status: 404,
				message: `Integration "${name}" was not found.`,
				record: null,
			}
		const record = this.toRecord(row)
		let grant: TokenGrant
		if (record.flow === 'client_credentials') grant = { grantType: 'client_credentials' }
		else {
			const refreshSealed = sealed(row.refresh_iv, row.refresh_ciphertext, row.refresh_key_id)
			if (!refreshSealed) {
				return {
					ok: false,
					code: 'integration_reconnect_required',
					status: 401,
					message: `Integration "${name}" has no refresh token; reconnect it with integrationConnect.`,
					record,
				}
			}
			grant = { grantType: 'refresh_token', refreshToken: await this.open(refreshSealed) }
		}
		try {
			const tokens = await this.requestTokens(record, grant)
			await this.storeTokens(name, tokens, { keepRefresh: true })
		} catch (error) {
			const kody = KodyError.fromUnknown(error)
			const message = kody?.message ?? (error instanceof Error ? error.message : String(error))
			const providerError = kody?.details?.providerError
			// invalid_grant means the refresh token is dead; other failures may be transient.
			if (providerError === 'invalid_grant' || providerError === 'invalid_client') {
				this.clearTokens(name, 'auth_failed', message.slice(0, 200))
			} else {
				this.host.sql.exec(
					'UPDATE integrations SET auth_failed_at = ?, auth_failed_reason = ?, updated_at = ? WHERE name = ?',
					nowIso(),
					message.slice(0, 200),
					nowIso(),
					name,
				)
			}
			return {
				ok: false,
				code: kody?.code ?? 'oauth_token_error',
				status: kody?.status ?? 502,
				message,
				record: this.require(name),
			}
		}
		const refreshed = this.require(name)
		const accessSealed = sealed(
			this.row(name)!.access_iv,
			this.row(name)!.access_ciphertext,
			this.row(name)!.access_key_id,
		)
		return { ok: true, token: await this.open(accessSealed!), record: refreshed, refreshed: true }
	}

	/**
	 * The only path that returns an access token, called by the fetch gateway
	 * for `{{integration-token:name}}`. Enforces the connection's usage grant
	 * and host allowlist, and refreshes expired tokens first.
	 */
	async tokenResolve(input: {
		name: string
		packageName: string | null
		host: string
		forceRefresh?: boolean
	}): Promise<TokenResolution> {
		const row = this.row(input.name)
		if (!row) {
			return {
				ok: false,
				code: 'integration_not_found',
				status: 404,
				message: `Integration "${input.name}" was not found. Save it with integrationSave first.`,
				record: null,
			}
		}
		const record = this.toRecord(row)
		if (!usagePermits(record.usage, input.packageName)) {
			return {
				ok: false,
				code: 'integration_locked',
				status: 403,
				message: `Integration "${input.name}" is locked to package(s) ${record.usage.mode === 'packages' ? record.usage.packages.join(', ') : ''}; ${input.packageName ? `package "${input.packageName}"` : 'ad hoc execute'} may not use it.`,
				record,
			}
		}
		if (!isHostApproved(input.host, record.allowedHosts)) {
			return {
				ok: false,
				code: 'integration_host_not_allowed',
				status: 403,
				message: `Integration "${input.name}" may only be sent to ${record.allowedHosts.join(', ')}; "${input.host}" is not in its allowedHosts.`,
				record,
			}
		}
		const accessSealed = sealed(row.access_iv, row.access_ciphertext, row.access_key_id)
		if (accessSealed === null || record.status !== 'connected') {
			if (record.flow === 'client_credentials') return this.refresh(input.name)
			return {
				ok: false,
				code: 'integration_not_connected',
				status: 401,
				message: `Integration "${input.name}" is ${record.status}. ${record.status === 'auth_failed' ? `Last error: ${record.authFailedReason ?? 'unknown'}. ` : ''}Get a connect link with integrationConnect and open it in a browser.`,
				record,
			}
		}
		if (input.forceRefresh || isTokenExpired(record.expiresAt)) return this.refresh(input.name)
		this.host.sql.exec('UPDATE integrations SET last_used_at = ? WHERE name = ?', nowIso(), input.name)
		return { ok: true, token: await this.open(accessSealed), record, refreshed: false }
	}

	/** Re-seals every encrypted column with the current master key (see secretRekey). */
	async rekey(): Promise<{ resealed: number; remaining: number }> {
		const keyring = await this.host.keyring()
		let resealed = 0
		const columns = [
			['client_secret_iv', 'client_secret_ciphertext', 'client_secret_key_id'],
			['access_iv', 'access_ciphertext', 'access_key_id'],
			['refresh_iv', 'refresh_ciphertext', 'refresh_key_id'],
		] as const
		for (const [ivCol, ctCol, keyCol] of columns) {
			const rows = this.host.sql
				.exec<{ name: string; iv: string; ciphertext: string; key_id: string | null }>(
					`SELECT name, ${ivCol} AS iv, ${ctCol} AS ciphertext, ${keyCol} AS key_id FROM integrations
					 WHERE ${ctCol} IS NOT NULL AND (${keyCol} IS NULL OR ${keyCol} != ?)`,
					keyring.current.id,
				)
				.toArray()
			for (const row of rows) {
				let plaintext: string
				try {
					plaintext = await decryptWithKeyring(keyring, this.host.userId(), {
						iv: row.iv,
						ciphertext: row.ciphertext,
						keyId: row.key_id || undefined,
					})
				} catch (error) {
					console.error(
						`integration rekey: cannot decrypt ${ctCol} for "${row.name}":`,
						error instanceof Error ? error.message : error,
					)
					continue
				}
				const next = await encryptSecretValue(keyring.current.key, this.host.userId(), plaintext)
				this.host.sql.exec(
					`UPDATE integrations SET ${ivCol} = ?, ${ctCol} = ?, ${keyCol} = ? WHERE name = ?`,
					next.iv,
					next.ciphertext,
					keyring.current.id,
					row.name,
				)
				resealed++
			}
		}
		const remaining = this.host.sql
			.exec<{ c: number }>(
				`SELECT count(*) AS c FROM integrations WHERE
				   (client_secret_ciphertext IS NOT NULL AND (client_secret_key_id IS NULL OR client_secret_key_id != ?))
				OR (access_ciphertext IS NOT NULL AND (access_key_id IS NULL OR access_key_id != ?))
				OR (refresh_ciphertext IS NOT NULL AND (refresh_key_id IS NULL OR refresh_key_id != ?))`,
				keyring.current.id,
				keyring.current.id,
				keyring.current.id,
			)
			.toArray()[0]
		return { resealed, remaining: remaining?.c ?? 0 }
	}
}

/** Drops the record-only fields so a mutated record can be written back as config. */
function stripRecord(record: IntegrationConfig & Partial<IntegrationRecord>): IntegrationConfig {
	return {
		name: record.name,
		provider: record.provider,
		description: record.description,
		flow: record.flow,
		authorizeUrl: record.authorizeUrl,
		tokenUrl: record.tokenUrl,
		clientId: record.clientId,
		tokenAuthStyle: record.tokenAuthStyle,
		scopes: record.scopes,
		scopeSeparator: record.scopeSeparator,
		authorizeParams: record.authorizeParams,
		allowedHosts: record.allowedHosts,
		usage: record.usage,
	}
}
