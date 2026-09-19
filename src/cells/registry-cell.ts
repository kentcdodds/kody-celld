import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env.ts'
import { randomId, randomToken, sha256Hex } from '../lib/crypto.ts'
import { KodyError } from '../lib/errors.ts'

export type UserRecord = { id: string; email: string; createdAt: string }

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
		`)
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

	async getUser(userId: string): Promise<UserRecord | null> {
		const row = this.ctx.storage.sql
			.exec<{ id: string; email: string; created_at: string }>(
				'SELECT id, email, created_at FROM users WHERE id = ?',
				userId,
			)
			.toArray()[0]
		return row ? { id: row.id, email: row.email, createdAt: row.created_at } : null
	}
}
