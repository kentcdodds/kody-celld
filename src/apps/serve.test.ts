import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { appIsolateName } from './serve-name.ts'
import { decideAppsOpen } from './open-decision.ts'

describe('appIsolateName', () => {
	const base = {
		userId: 'user_a',
		packageName: 'notes',
		updatedAt: '2026-10-12T10:00:00.000Z',
		hostedUrl: 'https://apps.example/u/user_a/packages/notes',
	}
	it('is stable for the same package version and mount', async () => {
		assert.equal(await appIsolateName(base), await appIsolateName({ ...base }))
		assert.match(await appIsolateName(base), /^kody-app-[0-9a-f]{64}$/)
	})
	it('changes when the package is re-saved', async () => {
		assert.notEqual(
			await appIsolateName(base),
			await appIsolateName({ ...base, updatedAt: '2026-10-12T10:00:01.000Z' }),
		)
	})
	it('changes per user and per mount', async () => {
		assert.notEqual(await appIsolateName(base), await appIsolateName({ ...base, userId: 'user_b' }))
		assert.notEqual(
			await appIsolateName(base),
			await appIsolateName({ ...base, hostedUrl: 'https://other.example/packages/notes' }),
		)
	})
})

describe('decideAppsOpen', () => {
	it('mints only for a valid 32-hex state', () => {
		assert.equal(decideAppsOpen('0123456789abcdef0123456789abcdef'), 'mint')
	})
	it('bounces to the app origin when state is missing or malformed', () => {
		assert.equal(decideAppsOpen(''), 'bounce')
		assert.equal(decideAppsOpen('nothex'), 'bounce')
		assert.equal(decideAppsOpen('0123456789ABCDEF0123456789abcdef'), 'bounce')
	})
})
