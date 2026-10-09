import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { accountAliasLocation } from './account-aliases.ts'

const at = (path: string) => accountAliasLocation(new URL(path, 'http://127.0.0.1:8787'))

describe('accountAliasLocation', () => {
	it('maps kody.codes account paths onto the self-hosted ones', () => {
		assert.equal(at('/account/email'), '/account/inbox')
		assert.equal(at('/account/activity'), '/account/runs')
		assert.equal(at('/account/mcp-oauth-clients'), '/account/clients')
	})

	it('keeps the rest of the path and the query string', () => {
		assert.equal(at('/account/email/msg_1?flash=saved'), '/account/inbox/msg_1?flash=saved')
	})

	it('leaves self-hosted and unknown paths alone', () => {
		assert.equal(at('/account'), null)
		assert.equal(at('/account/inbox'), null)
		assert.equal(at('/account/integrations'), null)
		assert.equal(at('/account/mcp-servers'), null)
		assert.equal(at('/account/emailish'), null)
		assert.equal(at('/community/email'), null)
	})
})
