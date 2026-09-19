import { DurableObject } from 'cloudflare:workers'
import { AccountStore, accountSchema, type SigninTokenKind } from '../auth/account-store.ts'
import type { Env } from '../env.ts'
import { buildMasterKeyring, randomId, randomToken, sha256Hex, type MasterKeyring } from '../lib/crypto.ts'
import { KodyError } from '../lib/errors.ts'
import { limitsFromEnv } from '../lib/limits.ts'
import { type ClientRegistration, type TokenEndpointAuthMethod } from '../oauth/protocol.ts'
import { OAuthServerStore, oauthServerSchema } from '../oauth/server-store.ts'
import {
	CommunityStore,
	communitySchema,
	type CommunityListing,
	type CommunityPackage,
} from '../packages/community-store.ts'
import type { PackageFiles, PackageManifest } from '../packages/manifest.ts'

export type UserRecord = { id: string; email: string; createdAt: string }

export type InboxLocal = { local: string; userId: string; createdAt: string }

/** Local parts nobody may claim: role addresses and platform names. */
export const reservedInboxLocals = new Set([
	'abuse',
	'admin',
	'administrator',
	'hostmaster',
	'kody',
	'mailer-daemon',
	'no-reply',
	'noreply',
	'postmaster',
	'root',
	'security',
	'support',
	'webmaster',
])

export const inboxLocalPattern = /^[a-z0-9][a-z0-9._-]{1,62}$/

export const maxInboxLocalsPerUser = 10
/** Delivery events (bounces, complaints) arrive within days; the routing index does not need to outlive that. */
export const outboundEmailIndexTtlMs = 30 * 24 * 60 * 60 * 1000

export type AuditEntry = {
	id: string
	at: string
	/** `admin`, `user:<id>`, or `system` (cron / internal). */
	actor: string
	/** Dotted verb, e.g. `user.create`, `secret_host.approve`, `secret.rekey`. */
	action: string
	/** What was acted on: a user id, host, package or secret *name* — never a value. */
	target: string | null
	details: Record<string, unknown> | null
}

/**
 * Fleet-wide registry: one cell (`getByName('registry')`) that owns user
 * accounts and API-token hashes. Everything user-scoped lives in UserCell.
 */
export class RegistryCell extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS users (
				id TEXT PRIMARY KEY,
				email TEXT NOT NULL UNIQUE,
				created_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS tokens (
				token_hash TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				label TEXT NOT NULL,
				created_at TEXT NOT NULL,
				last_used_at TEXT
			);
			CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id);
			CREATE TABLE IF NOT EXISTS audit (
				id TEXT PRIMARY KEY,
				at TEXT NOT NULL,
				actor TEXT NOT NULL,
				action TEXT NOT NULL,
				target TEXT,
				details_json TEXT
			);
			CREATE INDEX IF NOT EXISTS audit_at ON audit(at DESC);
			CREATE TABLE IF NOT EXISTS inbox_locals (
				local TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS inbox_locals_user ON inbox_locals(user_id);
			CREATE TABLE IF NOT EXISTS outbound_email_index (
				provider TEXT NOT NULL,
				provider_message_id TEXT NOT NULL,
				user_id TEXT NOT NULL,
				message_id TEXT NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY (provider, provider_message_id)
			);
			CREATE INDEX IF NOT EXISTS outbound_email_index_created ON outbound_email_index(created_at);
		`)
		this.ctx.storage.sql.exec(accountSchema)
		this.ctx.storage.sql.exec(oauthServerSchema)
		this.ctx.storage.sql.exec(communitySchema)
		this.community = new CommunityStore(this.ctx.storage.sql)
		this.auditRetentionCount = limitsFromEnv(env).auditRetentionCount
		this.accounts = new AccountStore(this.ctx.storage.sql)
		this.oauth = new OAuthServerStore(this.ctx.storage.sql, () => this.keyring())
	}

	private readonly auditRetentionCount: number
	private readonly accounts: AccountStore
	private readonly oauth: OAuthServerStore
	private readonly community: CommunityStore

	private keyringPromise: Promise<MasterKeyring> | undefined
	private keyring() {
		this.keyringPromise ??= buildMasterKeyring(this.env.KODY_MASTER_KEY, this.env.KODY_MASTER_KEY_PREVIOUS)
		return this.keyringPromise
	}

	// -------------------------------------------------------------- community

	async communityPublish(input: {
		userId: string
		publisher: string
		name: string
		version: string
		manifest: PackageManifest
		files: PackageFiles
	}): Promise<CommunityListing> {
		return this.community.publish(input)
	}

	async communityUnpublish(input: { userId: string; name: string }): Promise<boolean> {
		return this.community.unpublish(input)
	}

	async communityGet(name: string): Promise<CommunityPackage | null> {
		return this.community.get(name)
	}

	async communityOwnerOf(name: string): Promise<string | null> {
		return this.community.ownerOf(name)
	}

	async communitySearch(input: {
		query?: string | undefined
		limit?: number | undefined
	}): Promise<Array<CommunityListing>> {
		return this.community.search(input)
	}

	async communityListByUser(userId: string): Promise<Array<CommunityListing>> {
		return this.community.listByUser(userId)
	}

	async communityRecordInstall(name: string): Promise<void> {
		this.community.recordInstall(name)
	}

	async communityStats(): Promise<{ packages: number; publishers: number; installs: number }> {
		return this.community.stats()
	}

	// ------------------------------------------------------------------ audit

	async auditAppend(entry: Omit<AuditEntry, 'id' | 'at'>): Promise<AuditEntry> {
		const record: AuditEntry = { id: randomId('audit'), at: new Date().toISOString(), ...entry }
		this.ctx.storage.sql.exec(
			'INSERT INTO audit (id, at, actor, action, target, details_json) VALUES (?, ?, ?, ?, ?, ?)',
			record.id,
			record.at,
			record.actor,
			record.action,
			record.target,
			record.details ? JSON.stringify(record.details) : null,
		)
		this.ctx.storage.sql.exec(
			'DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY at DESC LIMIT ?)',
			this.auditRetentionCount,
		)
		return record
	}

	async auditList(
		filter: { limit?: number | undefined; actor?: string | undefined; action?: string | undefined } = {},
	): Promise<Array<AuditEntry>> {
		const limit = Math.min(Math.max(filter.limit ?? 50, 1), 1000)
		const where: Array<string> = []
		const params: Array<string> = []
		if (filter.actor) {
			where.push('actor = ?')
			params.push(filter.actor)
		}
		if (filter.action) {
			where.push('action LIKE ?')
			params.push(`${filter.action}%`)
		}
		return this.ctx.storage.sql
			.exec<{
				id: string
				at: string
				actor: string
				action: string
				target: string | null
				details_json: string | null
			}>(
				`SELECT id, at, actor, action, target, details_json FROM audit
				 ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC LIMIT ?`,
				...params,
				limit,
			)
			.toArray()
			.map((row) => ({
				id: row.id,
				at: row.at,
				actor: row.actor,
				action: row.action,
				target: row.target,
				details: row.details_json ? (JSON.parse(row.details_json) as Record<string, unknown>) : null,
			}))
	}

	async createUser(input: { email: string; label?: string }) {
		const email = input.email.trim().toLowerCase()
		if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
			throw new KodyError('invalid_email', 'A valid email address is required.')
		}
		const existing = this.ctx.storage.sql
			.exec<{ id: string; created_at: string }>('SELECT id, created_at FROM users WHERE email = ?', email)
			.toArray()[0]
		const now = new Date().toISOString()
		const id = existing?.id ?? randomId('user')
		if (!existing) {
			this.ctx.storage.sql.exec('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)', id, email, now)
		}
		const token = await this.issueToken(id, input.label ?? 'default')
		return {
			user: { id, email, createdAt: existing?.created_at ?? now } satisfies UserRecord,
			token,
			created: !existing,
		}
	}

	async issueToken(userId: string, label: string) {
		const token = randomToken('kc')
		this.ctx.storage.sql.exec(
			'INSERT INTO tokens (token_hash, user_id, label, created_at) VALUES (?, ?, ?, ?)',
			await sha256Hex(token),
			userId,
			label,
			new Date().toISOString(),
		)
		return token
	}

	async resolveToken(token: string): Promise<UserRecord | null> {
		const hash = await sha256Hex(token)
		const row = this.ctx.storage.sql
			.exec<{ id: string; email: string; created_at: string }>(
				`SELECT u.id, u.email, u.created_at FROM tokens t
				 JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
				hash,
			)
			.toArray()[0]
		if (!row) return null
		this.ctx.storage.sql.exec('UPDATE tokens SET last_used_at = ? WHERE token_hash = ?', new Date().toISOString(), hash)
		return { id: row.id, email: row.email, createdAt: row.created_at }
	}

	async listUsers(): Promise<Array<UserRecord>> {
		return this.ctx.storage.sql
			.exec<{ id: string; email: string; created_at: string }>(
				'SELECT id, email, created_at FROM users ORDER BY created_at ASC',
			)
			.toArray()
			.map((row) => ({ id: row.id, email: row.email, createdAt: row.created_at }))
	}

	// ----------------------------------------------------------- inbox locals

	/** Claims `local@<inbox domain>` for a user. Plus-suffixes are never stored; ingress strips them. */
	async inboxClaim(input: { userId: string; local: string }): Promise<InboxLocal> {
		const local = input.local.trim().toLowerCase()
		if (!inboxLocalPattern.test(local) || local.includes('+') || local.includes('..')) {
			throw new KodyError(
				'invalid_inbox_local',
				'Inbox names are 2-63 chars of a-z, 0-9, ".", "_", "-" and start with a letter or digit.',
			)
		}
		if (reservedInboxLocals.has(local)) {
			throw new KodyError('inbox_local_reserved', `"${local}" is reserved.`, { status: 409 })
		}
		const existing = this.ctx.storage.sql
			.exec<{ user_id: string; created_at: string }>(
				'SELECT user_id, created_at FROM inbox_locals WHERE local = ?',
				local,
			)
			.toArray()[0]
		if (existing && existing.user_id !== input.userId) {
			throw new KodyError('inbox_local_taken', `"${local}" is already claimed.`, { status: 409 })
		}
		if (existing) return { local, userId: input.userId, createdAt: existing.created_at }
		const owned = (await this.inboxListForUser(input.userId)).length
		if (owned >= maxInboxLocalsPerUser) {
			throw new KodyError('inbox_local_limit', `At most ${maxInboxLocalsPerUser} inbox names per user.`, {
				status: 429,
			})
		}
		const now = new Date().toISOString()
		this.ctx.storage.sql.exec(
			'INSERT INTO inbox_locals (local, user_id, created_at) VALUES (?, ?, ?)',
			local,
			input.userId,
			now,
		)
		return { local, userId: input.userId, createdAt: now }
	}

	async inboxRelease(input: { userId: string; local: string }) {
		const cursor = this.ctx.storage.sql.exec(
			'DELETE FROM inbox_locals WHERE local = ? AND user_id = ?',
			input.local.trim().toLowerCase(),
			input.userId,
		)
		return { deleted: cursor.rowsWritten > 0 }
	}

	async inboxListForUser(userId: string): Promise<Array<InboxLocal>> {
		return this.ctx.storage.sql
			.exec<{ local: string; user_id: string; created_at: string }>(
				'SELECT local, user_id, created_at FROM inbox_locals WHERE user_id = ? ORDER BY created_at',
				userId,
			)
			.toArray()
			.map((row) => ({ local: row.local, userId: row.user_id, createdAt: row.created_at }))
	}

	/** Resolves the base local part (plus-suffix already stripped) to its owner. */
	async inboxResolve(local: string): Promise<UserRecord | null> {
		const row = this.ctx.storage.sql
			.exec<{ id: string; email: string; created_at: string }>(
				`SELECT u.id, u.email, u.created_at FROM inbox_locals l JOIN users u ON u.id = l.user_id WHERE l.local = ?`,
				local.trim().toLowerCase(),
			)
			.toArray()[0]
		return row ? { id: row.id, email: row.email, createdAt: row.created_at } : null
	}

	// ------------------------------------------------- outbound email routing

	/** Remembers which user's cell owns an outbound message so provider delivery events can find it. */
	async outboundEmailIndexSet(input: {
		provider: string
		providerMessageId: string
		userId: string
		messageId: string
	}) {
		this.ctx.storage.sql.exec(
			`INSERT INTO outbound_email_index (provider, provider_message_id, user_id, message_id, created_at) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(provider, provider_message_id) DO UPDATE SET user_id = excluded.user_id, message_id = excluded.message_id`,
			input.provider,
			input.providerMessageId,
			input.userId,
			input.messageId,
			new Date().toISOString(),
		)
		this.ctx.storage.sql.exec(
			`DELETE FROM outbound_email_index WHERE created_at < ?`,
			new Date(Date.now() - outboundEmailIndexTtlMs).toISOString(),
		)
	}

	async outboundEmailIndexResolve(input: {
		provider: string
		providerMessageId: string
	}): Promise<{ userId: string; messageId: string } | null> {
		const row = this.ctx.storage.sql
			.exec<{ user_id: string; message_id: string }>(
				'SELECT user_id, message_id FROM outbound_email_index WHERE provider = ? AND provider_message_id = ?',
				input.provider,
				input.providerMessageId,
			)
			.toArray()[0]
		return row ? { userId: row.user_id, messageId: row.message_id } : null
	}

	async getUser(userId: string): Promise<UserRecord | null> {
		const row = this.ctx.storage.sql
			.exec<{ id: string; email: string; created_at: string }>(
				'SELECT id, email, created_at FROM users WHERE id = ?',
				userId,
			)
			.toArray()[0]
		return row ? { id: row.id, email: row.email, createdAt: row.created_at } : null
	}

	async getUserByEmail(email: string): Promise<UserRecord | null> {
		const row = this.ctx.storage.sql
			.exec<{ id: string; email: string; created_at: string }>(
				'SELECT id, email, created_at FROM users WHERE email = ?',
				email.trim().toLowerCase(),
			)
			.toArray()[0]
		return row ? { id: row.id, email: row.email, createdAt: row.created_at } : null
	}

	/** Creates the account row without minting an API token (web invite path). */
	async ensureUser(email: string): Promise<{ user: UserRecord; created: boolean }> {
		const normalized = email.trim().toLowerCase()
		if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
			throw new KodyError('invalid_email', 'A valid email address is required.')
		}
		const existing = await this.getUserByEmail(normalized)
		if (existing) return { user: existing, created: false }
		const user: UserRecord = { id: randomId('user'), email: normalized, createdAt: new Date().toISOString() }
		this.ctx.storage.sql.exec(
			'INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)',
			user.id,
			user.email,
			user.createdAt,
		)
		return { user, created: true }
	}

	async userCount(): Promise<number> {
		return Number(this.ctx.storage.sql.exec<{ c: number }>('SELECT count(*) AS c FROM users').toArray()[0]?.c ?? 0)
	}

	// -------------------------------------------------------- sign-in / sessions

	async passwordSet(userId: string, password: string) {
		await this.accounts.passwordSet(userId, password)
	}

	async passwordIsSet(userId: string) {
		return this.accounts.passwordIsSet(userId)
	}

	/** Email + password → user, or null. Lockout and dummy-hash timing live in the store. */
	async passwordSignin(input: { email: string; password: string }): Promise<UserRecord | null> {
		const user = await this.getUserByEmail(input.email)
		const ok = await this.accounts.passwordVerify({
			email: input.email,
			userId: user?.id ?? null,
			password: input.password,
		})
		return ok ? user : null
	}

	async signinTokenIssue(input: { userId: string; kind: SigninTokenKind; ttlMs?: number }) {
		return this.accounts.signinTokenIssue(input)
	}

	async signinTokenPeek(token: string) {
		const record = await this.accounts.signinTokenPeek(token)
		if (!record) return null
		const user = await this.getUser(record.userId)
		return user ? { ...record, user } : null
	}

	async signinTokenConsume(token: string) {
		const record = await this.accounts.signinTokenConsume(token)
		if (!record) return null
		const user = await this.getUser(record.userId)
		return user ? { ...record, user } : null
	}

	async sessionCreate(input: { userId: string; ttlMs: number; userAgent: string | null }) {
		return this.accounts.sessionCreate(input)
	}

	async sessionResolve(id: string, ttlMs: number) {
		const session = await this.accounts.sessionResolve(id, ttlMs)
		if (!session) return null
		const user = await this.getUser(session.userId)
		return user ? { session, user } : null
	}

	async sessionDelete(id: string) {
		return this.accounts.sessionDelete(id)
	}

	async sessionList(userId: string) {
		return this.accounts.sessionList(userId)
	}

	async sessionRevoke(userId: string, sessionId: string | null) {
		return this.accounts.sessionRevoke(userId, sessionId)
	}

	async tokenList(userId: string) {
		return this.accounts.tokenList(userId)
	}

	async tokenRevoke(userId: string, tokenId: string) {
		return this.accounts.tokenRevoke(userId, tokenId)
	}

	// -------------------------------------------------- MCP OAuth (authorization server)

	async oauthClientRegister(registration: ClientRegistration) {
		return this.oauth.clientRegister(registration)
	}

	async oauthClientGet(clientId: string) {
		return this.oauth.clientGet(clientId)
	}

	async oauthClientAuthenticate(input: {
		clientId: string | null
		clientSecret: string | null
		method: TokenEndpointAuthMethod
	}) {
		return this.oauth.clientAuthenticate(input)
	}

	async oauthCodeIssue(input: {
		clientId: string
		userId: string
		redirectUri: string
		codeChallenge: string
		scope: string
		resource: string
	}) {
		return this.oauth.codeIssue(input)
	}

	async oauthCodeConsume(code: string) {
		return this.oauth.codeConsume(code)
	}

	async oauthGrantEnsure(input: { userId: string; clientId: string; scope: string }) {
		return this.oauth.grantEnsure(input)
	}

	async oauthGrantList(userId: string) {
		return this.oauth.grantList(userId)
	}

	async oauthGrantRevoke(userId: string, grantId: string) {
		this.oauth.grantRevoke(userId, grantId)
	}

	async oauthGrantRevokeAll(userId: string) {
		this.oauth.grantRevokeAll(userId)
	}

	async oauthTokensIssue(input: { grantId: string; clientId: string; scope: string }) {
		return this.oauth.tokensIssue(input)
	}

	async oauthTokensRefresh(input: { refreshToken: string; clientId: string }) {
		return this.oauth.tokensRefresh(input)
	}

	async oauthAccessTokenResolve(token: string) {
		const resolved = await this.oauth.accessTokenResolve(token)
		if (!resolved) return null
		const user = await this.getUser(resolved.userId)
		return user ? { ...resolved, user } : null
	}

	async oauthTokenRevoke(input: { token: string; clientId: string }) {
		return this.oauth.tokenRevoke(input)
	}
}
