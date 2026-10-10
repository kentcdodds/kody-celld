import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { oauthAttemptIdentityMatches } from './oauth-identity.ts'

describe('oauthAttemptIdentityMatches', () => {
	it('requires both pending ids and an exact match on each', () => {
		assert.equal(
			oauthAttemptIdentityMatches({
				pendingServerId: 'mcp_1',
				pendingClientId: 'cid',
				serverId: 'mcp_1',
				clientId: 'cid',
			}),
			true,
		)
		assert.equal(
			oauthAttemptIdentityMatches({
				pendingServerId: null,
				pendingClientId: 'cid',
				serverId: 'mcp_1',
				clientId: 'cid',
			}),
			false,
		)
		assert.equal(
			oauthAttemptIdentityMatches({
				pendingServerId: 'mcp_1',
				pendingClientId: null,
				serverId: 'mcp_1',
				clientId: 'cid',
			}),
			false,
		)
		assert.equal(
			oauthAttemptIdentityMatches({
				pendingServerId: 'mcp_1',
				pendingClientId: 'cid',
				serverId: 'mcp_2',
				clientId: 'cid',
			}),
			false,
		)
		assert.equal(
			oauthAttemptIdentityMatches({
				pendingServerId: 'mcp_1',
				pendingClientId: 'cid',
				serverId: 'mcp_1',
				clientId: 'other',
			}),
			false,
		)
	})
})
