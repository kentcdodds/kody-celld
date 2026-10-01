import assert from 'node:assert/strict'
import test from 'node:test'
import { matchesSearchQuery } from './search-filter.ts'

test('empty search matches every record', () => {
	assert.equal(matchesSearchQuery('  ', ['subject', null]), true)
})

test('search is case-insensitive', () => {
	assert.equal(matchesSearchQuery('PREFERENCE', ['Preference']), true)
})

test('every search token must match somewhere in the record', () => {
	assert.equal(matchesSearchQuery('favorite editor', ['Favorite tool', 'Editor: Zed']), true)
	assert.equal(matchesSearchQuery('favorite editor', ['Favorite tool', 'Emacs']), false)
})

test('tags are searchable', () => {
	assert.equal(matchesSearchQuery('smoke-web', ['Memory', 'Seeded', 'smoke-web']), true)
})

test('null categories do not break matching', () => {
	assert.equal(matchesSearchQuery('editor', ['Editor preference', null, 'Prefers Zed']), true)
})
