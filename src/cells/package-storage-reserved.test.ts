import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	hasReservedTableWrite,
	isReservedTableName,
	likeLiteralPrefix,
	reservedTableExclusionSql,
	reservedTablePrefixes,
	touchesReservedTable,
} from './package-storage-reserved.ts'

describe('package-storage reserved tables', () => {
	it('escapes underscores in every LIKE prefix so _ is literal', () => {
		assert.equal(likeLiteralPrefix('_cf_'), '\\_cf\\_%')
		assert.equal(likeLiteralPrefix('_litestream_'), '\\_litestream\\_%')
		assert.equal(likeLiteralPrefix('__kody_'), '\\_\\_kody\\_%')
		assert.equal(likeLiteralPrefix('sqlite_'), 'sqlite\\_%')
	})

	it('builds one ESCAPE clause per reserved prefix', () => {
		assert.equal(
			reservedTableExclusionSql('name'),
			[
				"name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
				"name NOT LIKE '\\_\\_kody\\_%' ESCAPE '\\'",
				"name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
				"name NOT LIKE '\\_litestream\\_%' ESCAPE '\\'",
			].join(' AND '),
		)
		assert.deepEqual([...reservedTablePrefixes], ['sqlite_', '__kody_', '_cf_', '_litestream_'])
	})

	it('recognizes reserved table names including celld litestream tables', () => {
		assert.equal(isReservedTableName('_litestream_seq'), true)
		assert.equal(isReservedTableName('_litestream_lock'), true)
		assert.equal(isReservedTableName('_cf_KV'), true)
		assert.equal(isReservedTableName('__kody_kv'), true)
		assert.equal(isReservedTableName('sqlite_master'), true)
		assert.equal(isReservedTableName('notes'), false)
		assert.equal(isReservedTableName('events'), false)
	})

	it('guards non-select SQL that names reserved prefixes', () => {
		assert.equal(touchesReservedTable('DROP TABLE _litestream_seq'), true)
		assert.equal(touchesReservedTable('DELETE FROM __kody_kv'), true)
		assert.equal(touchesReservedTable('DROP TABLE _cf_ALARM'), true)
		assert.equal(touchesReservedTable('DROP TABLE notes'), false)
		assert.equal(touchesReservedTable('INSERT INTO notes VALUES (1)'), false)
	})

	it('rejects reserved-table writes even after a leading SELECT', () => {
		assert.equal(hasReservedTableWrite('SELECT 1; DROP TABLE __kody_kv'), true)
		assert.equal(hasReservedTableWrite('SELECT 1; DROP TABLE _litestream_seq'), true)
		assert.equal(hasReservedTableWrite('SELECT * FROM __kody_kv'), false)
		assert.equal(hasReservedTableWrite('SELECT 1; INSERT INTO notes VALUES (1)'), false)
		assert.equal(hasReservedTableWrite('DROP TABLE __kody_kv'), true)
	})
})
