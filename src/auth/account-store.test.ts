import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { AccountStore, accountSchema, apiTokenId, signinMaxFailures } from './account-store.ts'
import { hashPassword } from './password.ts'

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

function store() {
	const { db, sql } = memorySql()
	sql.exec(accountSchema)
	// The API-token table lives in the registry schema; mirror the columns the store reads.
	db.exec(
		'CREATE TABLE tokens (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, label TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT)',
	)
	return { db, store: new AccountStore(sql) }
}

const user = 'user_a'
const email = 'A@Example.test'
const password = 'correct horse battery staple'

describe('AccountStore passwords', () => {
	it('sets, verifies, and case-folds the email; wrong passwords count failures', async () => {
		const { db, store: s } = store()
		assert.equal(s.passwordIsSet(user), false)
		await s.passwordSet(user, password)
		assert.equal(s.passwordIsSet(user), true)
		const row = db.prepare('SELECT password_hash FROM credentials WHERE user_id = ?').get(user) as {
			password_hash: string
		}
		assert.match(row.password_hash, /^pbkdf2-sha256\$/)
		assert.ok(!row.password_hash.includes(password))

		assert.equal(await s.passwordVerify({ email, userId: user, password }), true)
		assert.equal(await s.passwordVerify({ email, userId: user, password: 'wrong wrong wrong' }), false)
		assert.equal(await s.passwordVerify({ email, userId: null, password }), false, 'unknown account never verifies')
		assert.equal(
			(db.prepare('SELECT failures FROM signin_attempts WHERE email = ?').get('a@example.test') as { failures: number })
				.failures,
			2,
		)
		assert.equal(await s.passwordVerify({ email, userId: user, password }), true)
		assert.equal((db.prepare('SELECT count(*) AS n FROM signin_attempts').get() as { n: number }).n, 0)
	})

	it('locks the email after the failure budget, even for the right password', async () => {
		const { store: s } = store()
		await s.passwordSet(user, password)
		for (let i = 0; i < signinMaxFailures; i += 1) {
			assert.equal(await s.passwordVerify({ email, userId: user, password: `wrong-${i}-wrong-wrong` }), false)
		}
		await assert.rejects(
			s.passwordVerify({ email, userId: user, password }),
			(error: unknown) => (error as { status: number }).status === 429,
		)
	})

	it('upgrades legacy work factors on a successful verify and refuses short passwords', async () => {
		const { db, store: s } = store()
		db.prepare('INSERT INTO credentials (user_id, password_hash, updated_at) VALUES (?, ?, ?)').run(
			user,
			await hashPassword(password, 1000),
			new Date().toISOString(),
		)
		assert.equal(await s.passwordVerify({ email, userId: user, password }), true)
		const row = db.prepare('SELECT password_hash FROM credentials WHERE user_id = ?').get(user) as {
			password_hash: string
		}
		assert.match(row.password_hash, /^pbkdf2-sha256\$600000\$/)
		await assert.rejects(s.passwordSet(user, 'short'), /at least 12/)
		s.passwordClear(user)
		assert.equal(s.passwordIsSet(user), false)
	})
})

describe('AccountStore sign-in tokens', () => {
	it('issues hashed one-time tokens that peek without spending and consume exactly once', async () => {
		const { db, store: s } = store()
		const { token } = await s.signinTokenIssue({ userId: user, kind: 'invite' })
		assert.match(token, /^ksi_/)
		const rows = db.prepare('SELECT token_hash, kind FROM signin_tokens').all() as Array<{
			token_hash: string
			kind: string
		}>
		assert.equal(rows.length, 1)
		assert.notEqual(rows[0]!.token_hash, token)
		assert.equal(rows[0]!.kind, 'invite')

		assert.equal((await s.signinTokenPeek(token))?.userId, user)
		assert.equal((await s.signinTokenPeek(token))?.kind, 'invite', 'peek is repeatable')
		assert.equal((await s.signinTokenConsume(token))?.userId, user)
		assert.equal(await s.signinTokenConsume(token), null, 'second use is refused')
		assert.equal(await s.signinTokenPeek('ksi_nope'), null)
	})

	it('expired tokens and revoked kinds are dead', async () => {
		const { store: s } = store()
		const expired = await s.signinTokenIssue({ userId: user, kind: 'magic', ttlMs: -1 })
		assert.equal(await s.signinTokenPeek(expired.token), null)
		const reset = await s.signinTokenIssue({ userId: user, kind: 'reset' })
		const invite = await s.signinTokenIssue({ userId: user, kind: 'invite' })
		s.signinTokensRevoke(user, 'reset')
		assert.equal(await s.signinTokenPeek(reset.token), null)
		assert.equal((await s.signinTokenPeek(invite.token))?.kind, 'invite')
		s.signinTokensRevoke(user)
		assert.equal(await s.signinTokenPeek(invite.token), null)
	})
})

describe('AccountStore browser sessions', () => {
	it('persists only a hash of the cookie value plus a public id, and resolves with sliding expiry', async () => {
		const { db, store: s } = store()
		const { id } = await s.sessionCreate({ userId: user, ttlMs: 60_000, userAgent: 'x'.repeat(300) })
		assert.match(id, /^kss_/)
		const row = db.prepare('SELECT id_hash, id, user_agent FROM sessions').get() as {
			id_hash: string
			id: string
			user_agent: string
		}
		assert.notEqual(row.id_hash, id)
		assert.match(row.id, /^sess_/)
		assert.equal(row.user_agent.length, 200)

		const resolved = await s.sessionResolve(id, 60_000)
		assert.equal(resolved?.userId, user)
		assert.equal(resolved?.id, row.id, 'public id, never the cookie value')
		assert.equal(await s.sessionResolve('kss_unknown', 60_000), null)
		assert.equal(s.sessionList(user).length, 1)
	})

	it('expired sessions vanish; revoke by id or all', async () => {
		const { store: s } = store()
		const gone = await s.sessionCreate({ userId: user, ttlMs: -1, userAgent: null })
		assert.equal(await s.sessionResolve(gone.id, 60_000), null)
		const a = await s.sessionCreate({ userId: user, ttlMs: 60_000, userAgent: null })
		const b = await s.sessionCreate({ userId: user, ttlMs: 60_000, userAgent: null })
		assert.equal(s.sessionList(user).length, 2)
		assert.equal(await s.sessionDelete(a.id), true)
		assert.equal(await s.sessionDelete(a.id), false)
		assert.equal(await s.sessionResolve(a.id, 60_000), null)
		const [remaining] = s.sessionList(user)
		assert.equal(s.sessionRevoke('someone_else', remaining!.id), 0, 'scoped to the owner')
		assert.equal(s.sessionRevoke(user, remaining!.id), 1)
		assert.equal(await s.sessionResolve(b.id, 60_000), null)
		const c = await s.sessionCreate({ userId: user, ttlMs: 60_000, userAgent: null })
		assert.equal(s.sessionRevoke(user, null), 1)
		assert.equal(await s.sessionResolve(c.id, 60_000), null)
	})
})

describe('AccountStore API tokens', () => {
	it('lists tokens by a hash-derived id and revokes only the owner’s', () => {
		const { db, store: s } = store()
		const hash = 'a'.repeat(64)
		db.prepare('INSERT INTO tokens (token_hash, user_id, label, created_at) VALUES (?, ?, ?, ?)').run(
			hash,
			user,
			'laptop',
			new Date().toISOString(),
		)
		const [token] = s.tokenList(user)
		assert.equal(token?.id, apiTokenId(hash))
		assert.equal(token?.label, 'laptop')
		assert.ok(!JSON.stringify(token).includes(hash))
		assert.equal(s.tokenRevoke('someone_else', token!.id), false)
		assert.equal(s.tokenRevoke(user, token!.id), true)
		assert.equal(s.tokenList(user).length, 0)
	})
})
