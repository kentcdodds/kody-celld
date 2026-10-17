// Unit coverage for the single-node deploy/node helpers used by
// docker/entrypoint.sh. Integration coverage is the CI smoke job.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, describe, it } from 'node:test'
import { celldDevNodeId, objectsDbPath, readDeployPointerEtag, resolveProjectDir } from './single-local.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'kody-single-local-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

describe('single-local helpers', () => {
	it('celldDevNodeId matches celld.dev (sha256 of project path, first 12 hex)', () => {
		const project = '/app'
		const expected = 'dev-' + createHash('sha256').update(Buffer.from(project)).digest('hex').slice(0, 12)
		assert.equal(celldDevNodeId(project), expected)
		assert.match(celldDevNodeId('/tmp/tiny-worker'), /^dev-[0-9a-f]{12}$/)
	})

	it('resolveProjectDir follows the Wrangler config parent', () => {
		const project = join(scratch, 'proj')
		mkdirSync(project, { recursive: true })
		writeFileSync(join(project, 'wrangler.jsonc'), '{ "name": "x", "main": "i.js" }\n')
		writeFileSync(join(project, 'i.js'), 'export default {}\n')
		assert.equal(resolveProjectDir(project), project)
	})

	it('resolveProjectDir fails loudly when no Wrangler config exists', () => {
		const empty = join(scratch, 'empty')
		mkdirSync(empty, { recursive: true })
		assert.throws(() => resolveProjectDir(empty), /no Wrangler config/)
	})

	it('readDeployPointerEtag returns null for a missing store and the etag after a write', () => {
		const state = join(scratch, 'state')
		mkdirSync(state, { recursive: true })
		const database = objectsDbPath(state)
		assert.equal(readDeployPointerEtag(database), null)

		const db = new DatabaseSync(database)
		db.exec(`
			CREATE TABLE objects (
				key TEXT PRIMARY KEY,
				body BLOB NOT NULL,
				etag INTEGER NOT NULL,
				modified_ms INTEGER NOT NULL,
				attributes TEXT NOT NULL
			);
		`)
		db.prepare('INSERT INTO objects(key, body, etag, modified_ms, attributes) VALUES (?, ?, ?, ?, ?)').run(
			'deploy/current.json',
			Buffer.from('{}'),
			42,
			Date.now(),
			'[]',
		)
		db.close()

		assert.equal(readDeployPointerEtag(database), 42)
	})

	it('readDeployPointerEtag returns null when the objects table is missing', () => {
		const state = join(scratch, 'empty-db')
		mkdirSync(state, { recursive: true })
		const database = objectsDbPath(state)
		const db = new DatabaseSync(database)
		db.exec('CREATE TABLE unrelated (id INTEGER)')
		db.close()
		assert.equal(readDeployPointerEtag(database), null)
	})

	it('entrypoint runs deploy then execs the direct node (no long-lived celld.dev)', () => {
		const body = readFileSync(new URL('./entrypoint.sh', import.meta.url), 'utf8')
		assert.match(body, /single-local\.mjs deploy/)
		assert.match(body, /--no-control-plane/)
		assert.match(body, /CELLD_INTERNAL_DEV_STORE/)
		assert.match(body, /bucket celld-dev/)
		assert.doesNotMatch(body, /exec celld dev /)
	})
})
