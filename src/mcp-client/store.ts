import type { IntegrationUsage } from '../integrations/oauth.ts'
import { decryptWithKeyring, encryptSecretValue, randomId, type MasterKeyring } from '../lib/crypto.ts'
import { KodyError } from '../lib/errors.ts'
import type { McpServerInfo, McpTool } from './client.ts'
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { McpOAuthStore, McpOAuthSummary, McpTokenRefresher } from './oauth-store.ts'

export const mcpServerSchema = `
	CREATE TABLE IF NOT EXISTS mcp_servers (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL UNIQUE,
		url TEXT NOT NULL,
		enabled INTEGER NOT NULL DEFAULT 1,
		usage_json TEXT NOT NULL,
		auth_json TEXT NOT NULL,
		bearer_iv TEXT,
		bearer_ciphertext TEXT,
		bearer_key_id TEXT,
		status TEXT NOT NULL,
		last_error_json TEXT,
		server_info_json TEXT,
		tools_json TEXT NOT NULL DEFAULT '[]',
		tools_refreshed_at TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);
`

export type McpLastError = { phase: string; message: string; at: string }
export type McpServerRecord = {
	id: string
	name: string
	url: string
	enabled: boolean
	usage: IntegrationUsage
	auth: { kind: 'none' | 'bearer' | 'oauth' }
	status: 'ready' | 'error' | 'authenticating'
	oauth: McpOAuthSummary | null
	lastError: McpLastError | null
	serverInfo: McpServerInfo | null
	tools: Array<McpTool>
	toolsRefreshedAt: string | null
	createdAt: string
	updatedAt: string
}
export type McpDiscoveryOutcome =
	| { serverInfo: McpServerInfo; tools: Array<McpTool> }
	| { error: McpLastError }
	/** `origin`: write only while the server still has this origin (a late write after a replace is dropped). */
	| { auth: { status: 'authenticating' | 'error'; error: McpLastError; origin?: string } }
export type PublicMcpServer = Omit<McpServerRecord, 'tools'> & {
	toolCount: number
	tools: Array<{ name: string; title?: string; description?: string }>
	accessor: string
}

type Row = {
	id: string
	name: string
	url: string
	enabled: number
	usage_json: string
	auth_json: string
	bearer_iv: string | null
	bearer_ciphertext: string | null
	bearer_key_id: string | null
	status: string
	last_error_json: string | null
	server_info_json: string | null
	tools_json: string
	tools_refreshed_at: string | null
	created_at: string
	updated_at: string
}

const nowIso = () => new Date().toISOString()

function sameOrigin(a: string, b: string) {
	try {
		return new URL(a).origin === new URL(b).origin
	} catch {
		return false
	}
}

function toRecord(row: Row, oauth: McpOAuthSummary | null): McpServerRecord {
	return {
		id: row.id,
		name: row.name,
		url: row.url,
		enabled: row.enabled === 1,
		usage: JSON.parse(row.usage_json) as IntegrationUsage,
		auth: JSON.parse(row.auth_json) as McpServerRecord['auth'],
		status: row.status === 'ready' || row.status === 'authenticating' ? row.status : 'error',
		oauth,
		lastError: row.last_error_json ? (JSON.parse(row.last_error_json) as McpLastError) : null,
		serverInfo: row.server_info_json ? (JSON.parse(row.server_info_json) as McpServerInfo) : null,
		tools: JSON.parse(row.tools_json) as Array<McpTool>,
		toolsRefreshedAt: row.tools_refreshed_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

export function publicMcpServer(record: McpServerRecord): PublicMcpServer {
	return {
		...record,
		toolCount: record.tools.length,
		tools: record.tools.map((t) => ({
			name: t.name,
			...(t.title ? { title: t.title } : {}),
			...(t.description ? { description: t.description } : {}),
		})),
		accessor: `kody.mcp[${JSON.stringify(record.name)}]`,
	}
}

export class McpServerStore {
	private readonly host: {
		sql: SqlStorage
		userId: () => string
		keyring: () => Promise<MasterKeyring>
		oauth: McpOAuthStore
	}

	constructor(host: {
		sql: SqlStorage
		userId: () => string
		keyring: () => Promise<MasterKeyring>
		oauth: McpOAuthStore
	}) {
		this.host = host
	}

	private row(name: string) {
		return this.host.sql.exec<Row>('SELECT * FROM mcp_servers WHERE name = ?', name).toArray()[0] ?? null
	}

	private require(name: string) {
		const row = this.row(name)
		if (!row)
			throw new KodyError('mcp_server_not_found', `MCP server "${name}" was not found. Add it with mcpServerAdd.`, {
				status: 404,
			})
		return row
	}

	private record(row: Row) {
		return toRecord(row, this.host.oauth.summary(row.name))
	}

	list(): Array<McpServerRecord> {
		return this.host.sql
			.exec<Row>('SELECT * FROM mcp_servers ORDER BY name')
			.toArray()
			.map((row) => this.record(row))
	}

	get(name: string): McpServerRecord | null {
		const row = this.row(name)
		return row ? this.record(row) : null
	}

	async save(input: {
		name: string
		url: string
		enabled: boolean
		usage: IntegrationUsage
		authorization: string | null
		replace: boolean
	}) {
		const existing = this.row(input.name)
		if (existing && !input.replace) {
			throw new KodyError(
				'mcp_server_exists',
				`MCP server "${input.name}" already exists. Pass replace: true to overwrite it.`,
				{ status: 409 },
			)
		}
		// Bearer: replace without a new token keeps the sealed bearer only for the same origin
		// (otherwise discovery would send it to a new host). Clearing is remove + re-add.
		// OAuth: any URL change (path included) drops the grant; tokens are bound to the resource URL.
		// A fresh add also clears: an OAuth row left under this name (a write that raced a remove) must not carry over.
		const urlChanged = existing !== null && existing.url !== input.url
		if (!existing || urlChanged || input.authorization) this.host.oauth.clear(input.name)
		let sealed: {
			iv: string | null
			ciphertext: string | null
			keyId: string | null
			kind: 'none' | 'bearer' | 'oauth'
		} = {
			iv: null,
			ciphertext: null,
			keyId: null,
			kind: 'none',
		}
		if (input.authorization) {
			const { current } = await this.host.keyring()
			const encrypted = await encryptSecretValue(current.key, this.host.userId(), input.authorization)
			sealed = { iv: encrypted.iv, ciphertext: encrypted.ciphertext, keyId: current.id, kind: 'bearer' }
		} else if (existing?.bearer_ciphertext && sameOrigin(existing.url, input.url)) {
			sealed = {
				iv: existing.bearer_iv,
				ciphertext: existing.bearer_ciphertext,
				keyId: existing.bearer_key_id,
				kind: 'bearer',
			}
		} else if (existing && !urlChanged && (JSON.parse(existing.auth_json) as { kind: string }).kind === 'oauth') {
			sealed.kind = 'oauth'
		}
		const now = nowIso()
		this.host.sql.exec(
			`INSERT INTO mcp_servers (id, name, url, enabled, usage_json, auth_json, bearer_iv, bearer_ciphertext, bearer_key_id, status, last_error_json, server_info_json, tools_json, tools_refreshed_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'error', ?, NULL, '[]', NULL, ?, ?)
			 ON CONFLICT(name) DO UPDATE SET url = excluded.url, enabled = excluded.enabled, usage_json = excluded.usage_json,
			   auth_json = excluded.auth_json, bearer_iv = excluded.bearer_iv, bearer_ciphertext = excluded.bearer_ciphertext,
			   bearer_key_id = excluded.bearer_key_id, status = 'error', last_error_json = excluded.last_error_json,
			   server_info_json = NULL, tools_json = '[]', tools_refreshed_at = NULL, updated_at = excluded.updated_at`,
			existing?.id ?? randomId('mcp'),
			input.name,
			input.url,
			input.enabled ? 1 : 0,
			JSON.stringify(input.usage),
			JSON.stringify({ kind: sealed.kind }),
			sealed.iv,
			sealed.ciphertext,
			sealed.keyId,
			JSON.stringify({ phase: 'connect', message: 'Not discovered yet.', at: now }),
			existing?.created_at ?? now,
			now,
		)
		return this.record(this.require(input.name))
	}

	setDiscovery(name: string, outcome: McpDiscoveryOutcome): McpServerRecord {
		this.require(name)
		const now = nowIso()
		if ('auth' in outcome) {
			// Checked and written synchronously: a bearer record, or one that moved origin, is never relabelled oauth.
			const row = this.require(name)
			if (row.bearer_ciphertext !== null) return this.record(row)
			if (outcome.auth.origin && !sameOrigin(row.url, outcome.auth.origin)) return this.record(row)
			this.host.sql.exec(
				`UPDATE mcp_servers SET status = ?, auth_json = '{"kind":"oauth"}', last_error_json = ?, updated_at = ? WHERE name = ?`,
				outcome.auth.status,
				JSON.stringify(outcome.auth.error),
				now,
				name,
			)
		} else if ('error' in outcome) {
			this.host.sql.exec(
				`UPDATE mcp_servers SET status = 'error', last_error_json = ?, updated_at = ? WHERE name = ?`,
				JSON.stringify(outcome.error),
				now,
				name,
			)
		} else {
			this.host.sql.exec(
				`UPDATE mcp_servers SET status = 'ready', last_error_json = NULL, server_info_json = ?, tools_json = ?, tools_refreshed_at = ?, updated_at = ? WHERE name = ?`,
				JSON.stringify(outcome.serverInfo),
				JSON.stringify(outcome.tools),
				now,
				now,
				name,
			)
		}
		return this.record(this.require(name))
	}

	setAuthState(name: string, status: 'authenticating' | 'error', error: McpLastError): McpServerRecord {
		return this.setDiscovery(name, { auth: { status, error } })
	}

	/**
	 * Saves a code-exchange result for the server the attempt was started for. Everything is sealed first; then,
	 * with no await before the write, the server must still exist, have the same URL, and not use a bearer.
	 * Otherwise nothing is written (a remove or replace during the exchange wins).
	 */
	async completeOAuth(input: {
		name: string
		serverOrigin: string
		/** Full server URL at authorization start; path changes refuse the grant write. */
		serverUrl: string
		tokens: OAuthTokens
		savedClient: OAuthClientInformationMixed | null
	}): Promise<McpServerRecord> {
		const commit = await this.host.oauth.sealGrant(input.name, input)
		const row = this.row(input.name)
		const kind = row ? (JSON.parse(row.auth_json) as { kind: string }).kind : null
		if (!row || row.url !== input.serverUrl || !sameOrigin(row.url, input.serverOrigin) || kind === 'bearer') {
			throw new KodyError(
				'mcp_oauth_state_invalid',
				`MCP server "${input.name}" was removed or changed while authorizing; nothing was saved. Start again from /account/mcp-servers.`,
				{ status: 400 },
			)
		}
		commit()
		return this.markOAuth(input.name)
	}

	/** After a successful code exchange: oauth kind; status stays "error / Not discovered yet" until discovery runs. */
	markOAuth(name: string): McpServerRecord {
		this.require(name)
		this.host.sql.exec(
			`UPDATE mcp_servers SET auth_json = '{"kind":"oauth"}', bearer_iv = NULL, bearer_ciphertext = NULL, bearer_key_id = NULL, updated_at = ? WHERE name = ?`,
			nowIso(),
			name,
		)
		return this.get(name)!
	}

	/** The Authorization for a call: the sealed bearer, or a (refreshed) OAuth access token. */
	async callAuthorization(
		name: string,
		options: { forceRefresh: boolean; refresher: McpTokenRefresher; staleAccessToken?: string },
	) {
		const row = this.require(name)
		if ((JSON.parse(row.auth_json) as { kind: string }).kind !== 'oauth') return this.authorization(name)
		const result = await this.host.oauth.accessToken(name, options)
		if (result.ok) return `Bearer ${result.accessToken}`
		// A remove or replace during the refresh wins: hand back the newer record's credential instead of relabelling it.
		const current = this.require(name)
		if ((JSON.parse(current.auth_json) as { kind: string }).kind !== 'oauth') return this.authorization(name)
		this.setAuthState(name, result.status, { phase: 'token exchange', message: result.message, at: nowIso() })
		if (result.status === 'error') {
			throw new KodyError('mcp_call_failed', `MCP server "${name}": ${result.message}`, { status: 502 })
		}
		throw new KodyError(
			'mcp_server_unauthorized',
			`MCP server "${name}" needs authorization: ${result.message} Authorize it on /account/mcp-servers.`,
			{ status: 401 },
		)
	}

	setEnabled(name: string, enabled: boolean): McpServerRecord {
		this.require(name)
		this.host.sql.exec(
			'UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE name = ?',
			enabled ? 1 : 0,
			nowIso(),
			name,
		)
		return this.record(this.require(name))
	}

	setUsage(name: string, usage: IntegrationUsage): McpServerRecord {
		this.require(name)
		this.host.sql.exec(
			'UPDATE mcp_servers SET usage_json = ?, updated_at = ? WHERE name = ?',
			JSON.stringify(usage),
			nowIso(),
			name,
		)
		return this.record(this.require(name))
	}

	remove(name: string): { removed: boolean } {
		const existed = this.row(name) !== null
		this.host.oauth.clear(name)
		this.host.sql.exec('DELETE FROM mcp_servers WHERE name = ?', name)
		return { removed: existed }
	}

	async authorization(name: string): Promise<string | null> {
		const row = this.require(name)
		if (!row.bearer_iv || !row.bearer_ciphertext) return null
		return decryptWithKeyring(await this.host.keyring(), this.host.userId(), {
			iv: row.bearer_iv,
			ciphertext: row.bearer_ciphertext,
			keyId: row.bearer_key_id || undefined,
		})
	}

	/** Re-seals bearer tokens with the current master key (see secretRekey). */
	async rekey(): Promise<{ resealed: number; remaining: number }> {
		const a = await this.rekeyBearers()
		const b = await this.host.oauth.rekey()
		return { resealed: a.resealed + b.resealed, remaining: a.remaining + b.remaining }
	}

	private async rekeyBearers(): Promise<{ resealed: number; remaining: number }> {
		const keyring = await this.host.keyring()
		const rows = this.host.sql
			.exec<Row>(
				'SELECT * FROM mcp_servers WHERE bearer_ciphertext IS NOT NULL AND (bearer_key_id IS NULL OR bearer_key_id != ?)',
				keyring.current.id,
			)
			.toArray()
		let resealed = 0
		for (const row of rows) {
			let plaintext: string
			try {
				plaintext = await decryptWithKeyring(keyring, this.host.userId(), {
					iv: row.bearer_iv!,
					ciphertext: row.bearer_ciphertext!,
					keyId: row.bearer_key_id || undefined,
				})
			} catch (error) {
				console.error(
					`mcp server rekey: cannot decrypt bearer for "${row.name}":`,
					error instanceof Error ? error.message : error,
				)
				continue
			}
			const next = await encryptSecretValue(keyring.current.key, this.host.userId(), plaintext)
			this.host.sql.exec(
				'UPDATE mcp_servers SET bearer_iv = ?, bearer_ciphertext = ?, bearer_key_id = ? WHERE name = ?',
				next.iv,
				next.ciphertext,
				keyring.current.id,
				row.name,
			)
			resealed++
		}
		const remaining = this.host.sql
			.exec<{ c: number }>(
				'SELECT count(*) AS c FROM mcp_servers WHERE bearer_ciphertext IS NOT NULL AND (bearer_key_id IS NULL OR bearer_key_id != ?)',
				keyring.current.id,
			)
			.toArray()[0]
		return { resealed, remaining: remaining?.c ?? 0 }
	}
}
