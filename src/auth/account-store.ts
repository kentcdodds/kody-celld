import { randomId, randomToken, sha256Hex } from '../lib/crypto.ts'
import { KodyError } from '../lib/errors.ts'
import { hashPassword, passwordNeedsRehash, validatePassword, verifyPassword } from './password.ts'

export const signinTokenKinds = ['invite', 'magic', 'reset'] as const
export type SigninTokenKind = (typeof signinTokenKinds)[number]

export const inviteTtlMs = 7 * 24 * 60 * 60 * 1000
export const magicLinkTtlMs = 15 * 60 * 1000
/** Failed password attempts per email before a temporary lock. */
export const signinMaxFailures = 5
export const signinLockMs = 15 * 60 * 1000

export type SessionRecord = {
	id: string
	userId: string
	createdAt: string
	expiresAt: string
	lastSeenAt: string
	userAgent: string | null
}

export type ApiTokenRecord = { id: string; label: string; createdAt: string; lastUsedAt: string | null }

export type SigninTokenRecord = { kind: SigninTokenKind; userId: string; expiresAt: string }

export const accountSchema = `
	CREATE TABLE IF NOT EXISTS credentials (
		user_id TEXT PRIMARY KEY,
		password_hash TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS signin_tokens (
		token_hash TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		kind TEXT NOT NULL,
		created_at TEXT NOT NULL,
		expires_at TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS signin_tokens_user ON signin_tokens(user_id);
	CREATE TABLE IF NOT EXISTS sessions (
		id_hash TEXT PRIMARY KEY,
		id TEXT NOT NULL,
		user_id TEXT NOT NULL,
		created_at TEXT NOT NULL,
		expires_at TEXT NOT NULL,
		last_seen_at TEXT NOT NULL,
		user_agent TEXT
	);
	CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
	CREATE TABLE IF NOT EXISTS signin_attempts (
		email TEXT PRIMARY KEY,
		failures INTEGER NOT NULL,
		locked_until TEXT
	);
`

/** Public, non-secret handle for an API token row (the row key is the token's full SHA-256). */
export function apiTokenId(tokenHash: string) {
	return tokenHash.slice(0, 16)
}

/**
 * Sign-in state for the web UI: passwords, one-time sign-in links, browser
 * sessions, and per-user API-token management. Lives inside RegistryCell so
 * password hashes and session ids never cross an RPC boundary.
 */
export class AccountStore {
	private readonly sql: SqlStorage

	constructor(sql: SqlStorage) {
		this.sql = sql
	}

	// ---------------------------------------------------------------- passwords

	async passwordSet(userId: string, password: string) {
		const hash = await hashPassword(validatePassword(password))
		this.sql.exec(
			`INSERT INTO credentials (user_id, password_hash, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at`,
			userId,
			hash,
			new Date().toISOString(),
		)
	}

	passwordIsSet(userId: string) {
		return this.sql.exec('SELECT 1 AS one FROM credentials WHERE user_id = ?', userId).toArray().length > 0
	}

	passwordClear(userId: string) {
		this.sql.exec('DELETE FROM credentials WHERE user_id = ?', userId)
	}

	/**
	 * Verifies a password for a user id (the caller resolves email -> user so
	 * unknown emails and wrong passwords take the same path). Applies the
	 * per-email lockout and transparently upgrades old work factors.
	 */
	async passwordVerify(input: { email: string; userId: string | null; password: string }) {
		const email = input.email.trim().toLowerCase()
		const now = Date.now()
		const attempt = this.sql
			.exec<{ failures: number; locked_until: string | null }>(
				'SELECT failures, locked_until FROM signin_attempts WHERE email = ?',
				email,
			)
			.toArray()[0]
		if (attempt?.locked_until && Date.parse(attempt.locked_until) > now) {
			throw new KodyError('signin_locked', 'Too many failed sign-in attempts. Try again in a few minutes.', {
				status: 429,
			})
		}
		const row = input.userId
			? this.sql
					.exec<{ password_hash: string }>('SELECT password_hash FROM credentials WHERE user_id = ?', input.userId)
					.toArray()[0]
			: undefined
		// Always burn the same CPU so a missing account is indistinguishable from a wrong password.
		const ok = await verifyPassword(input.password, row?.password_hash ?? dummyHash)
		if (!ok || !row || !input.userId) {
			const failures = (attempt?.failures ?? 0) + 1
			const lockedUntil = failures >= signinMaxFailures ? new Date(now + signinLockMs).toISOString() : null
			this.sql.exec(
				`INSERT INTO signin_attempts (email, failures, locked_until) VALUES (?, ?, ?)
				 ON CONFLICT(email) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until`,
				email,
				lockedUntil ? 0 : failures,
				lockedUntil,
			)
			return false
		}
		this.sql.exec('DELETE FROM signin_attempts WHERE email = ?', email)
		if (passwordNeedsRehash(row.password_hash)) await this.passwordSet(input.userId, input.password)
		return true
	}

	// ----------------------------------------------------------- signin tokens

	/** One-time link tokens: invites (set a password), magic links, password resets. */
	async signinTokenIssue(input: { userId: string; kind: SigninTokenKind; ttlMs?: number }) {
		this.purge()
		const token = randomToken(`ks${input.kind[0]}`, 32)
		const now = Date.now()
		const ttl = input.ttlMs ?? (input.kind === 'magic' ? magicLinkTtlMs : inviteTtlMs)
		const expiresAt = new Date(now + ttl).toISOString()
		this.sql.exec(
			'INSERT INTO signin_tokens (token_hash, user_id, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
			await sha256Hex(token),
			input.userId,
			input.kind,
			new Date(now).toISOString(),
			expiresAt,
		)
		return { token, expiresAt }
	}

	/** Reads a token without spending it (the landing page shows a form first). */
	async signinTokenPeek(token: string): Promise<SigninTokenRecord | null> {
		const row = this.sql
			.exec<{ user_id: string; kind: string; expires_at: string }>(
				'SELECT user_id, kind, expires_at FROM signin_tokens WHERE token_hash = ?',
				await sha256Hex(token),
			)
			.toArray()[0]
		if (!row || Date.parse(row.expires_at) <= Date.now()) return null
		if (!signinTokenKinds.includes(row.kind as SigninTokenKind)) return null
		return { userId: row.user_id, kind: row.kind as SigninTokenKind, expiresAt: row.expires_at }
	}

	async signinTokenConsume(token: string): Promise<SigninTokenRecord | null> {
		const record = await this.signinTokenPeek(token)
		if (!record) return null
		const cursor = this.sql.exec('DELETE FROM signin_tokens WHERE token_hash = ?', await sha256Hex(token))
		return cursor.rowsWritten > 0 ? record : null
	}

	signinTokensRevoke(userId: string, kind?: SigninTokenKind) {
		if (kind) this.sql.exec('DELETE FROM signin_tokens WHERE user_id = ? AND kind = ?', userId, kind)
		else this.sql.exec('DELETE FROM signin_tokens WHERE user_id = ?', userId)
	}

	// ----------------------------------------------------------------- sessions

	async sessionCreate(input: { userId: string; ttlMs: number; userAgent: string | null }) {
		this.purge()
		const id = randomToken('kss', 32)
		const now = new Date()
		const expiresAt = new Date(now.getTime() + input.ttlMs).toISOString()
		this.sql.exec(
			`INSERT INTO sessions (id_hash, id, user_id, created_at, expires_at, last_seen_at, user_agent)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			await sha256Hex(id),
			randomId('sess'),
			input.userId,
			now.toISOString(),
			expiresAt,
			now.toISOString(),
			input.userAgent?.slice(0, 200) ?? null,
		)
		return { id, expiresAt }
	}

	/** Resolves a cookie value; sliding expiry extends the session on use. */
	async sessionResolve(id: string, ttlMs: number): Promise<SessionRecord | null> {
		const hash = await sha256Hex(id)
		const row = this.sql
			.exec<{
				id: string
				user_id: string
				created_at: string
				expires_at: string
				last_seen_at: string
				user_agent: string | null
			}>('SELECT id, user_id, created_at, expires_at, last_seen_at, user_agent FROM sessions WHERE id_hash = ?', hash)
			.toArray()[0]
		if (!row) return null
		const now = Date.now()
		if (Date.parse(row.expires_at) <= now) {
			this.sql.exec('DELETE FROM sessions WHERE id_hash = ?', hash)
			return null
		}
		const lastSeen = new Date(now).toISOString()
		const expiresAt = new Date(now + ttlMs).toISOString()
		if (now - Date.parse(row.last_seen_at) > 60_000) {
			this.sql.exec('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?', lastSeen, expiresAt, hash)
		}
		return {
			id: row.id,
			userId: row.user_id,
			createdAt: row.created_at,
			expiresAt,
			lastSeenAt: lastSeen,
			userAgent: row.user_agent,
		}
	}

	async sessionDelete(id: string) {
		const cursor = this.sql.exec('DELETE FROM sessions WHERE id_hash = ?', await sha256Hex(id))
		return cursor.rowsWritten > 0
	}

	sessionList(userId: string): Array<SessionRecord> {
		this.purge()
		return this.sql
			.exec<{
				id: string
				user_id: string
				created_at: string
				expires_at: string
				last_seen_at: string
				user_agent: string | null
			}>(
				`SELECT id, user_id, created_at, expires_at, last_seen_at, user_agent FROM sessions
				 WHERE user_id = ? ORDER BY last_seen_at DESC`,
				userId,
			)
			.toArray()
			.map((row) => ({
				id: row.id,
				userId: row.user_id,
				createdAt: row.created_at,
				expiresAt: row.expires_at,
				lastSeenAt: row.last_seen_at,
				userAgent: row.user_agent,
			}))
	}

	/** Revokes by public session id (`sess_…`), or every session for the user. */
	sessionRevoke(userId: string, sessionId: string | null) {
		const cursor = sessionId
			? this.sql.exec('DELETE FROM sessions WHERE user_id = ? AND id = ?', userId, sessionId)
			: this.sql.exec('DELETE FROM sessions WHERE user_id = ?', userId)
		return cursor.rowsWritten
	}

	// --------------------------------------------------------------- api tokens

	tokenList(userId: string): Array<ApiTokenRecord> {
		return this.sql
			.exec<{ token_hash: string; label: string; created_at: string; last_used_at: string | null }>(
				'SELECT token_hash, label, created_at, last_used_at FROM tokens WHERE user_id = ? ORDER BY created_at DESC',
				userId,
			)
			.toArray()
			.map((row) => ({
				id: apiTokenId(row.token_hash),
				label: row.label,
				createdAt: row.created_at,
				lastUsedAt: row.last_used_at,
			}))
	}

	tokenRevoke(userId: string, tokenId: string) {
		const cursor = this.sql.exec(
			'DELETE FROM tokens WHERE user_id = ? AND substr(token_hash, 1, 16) = ?',
			userId,
			tokenId,
		)
		return cursor.rowsWritten > 0
	}

	private purge() {
		const now = new Date().toISOString()
		this.sql.exec('DELETE FROM signin_tokens WHERE expires_at <= ?', now)
		this.sql.exec('DELETE FROM sessions WHERE expires_at <= ?', now)
	}
}

/** Well-formed but unmatchable; verifying against it costs the same CPU as a genuine check. */
const dummyHash =
	'pbkdf2-sha256$600000$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000'
