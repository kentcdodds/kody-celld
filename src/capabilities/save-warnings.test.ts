import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeSaveWarnings } from './save-warnings.ts'

test('mergeSaveWarnings keeps save warnings and appends fetch warnings', () => {
	assert.deepEqual(mergeSaveWarnings({ warnings: ['client not built'] }, ['fetch note']), [
		'client not built',
		'fetch note',
	])
})

test('mergeSaveWarnings tolerates missing save warnings', () => {
	assert.deepEqual(mergeSaveWarnings({}, ['fetch note']), ['fetch note'])
	assert.deepEqual(mergeSaveWarnings({ warnings: ['a'] }, []), ['a'])
})
