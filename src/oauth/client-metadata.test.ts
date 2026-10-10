import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { clientMetadataResponse } from './client-metadata.ts'

describe('GET /oauth/client-metadata.json', () => {
	it('serves the document on https origins with a cache header', async () => {
		const res = clientMetadataResponse('https://kody.example.com')
		assert.equal(res.status, 200)
		assert.equal(res.headers.get('cache-control'), 'public, max-age=3600')
		const body = (await res.json()) as Record<string, unknown>
		assert.equal(body.client_id, 'https://kody.example.com/oauth/client-metadata.json')
		assert.deepEqual(body.redirect_uris, ['https://kody.example.com/account/mcp-servers/oauth/callback'])
	})
	it('404 on http origins', () => {
		assert.equal(clientMetadataResponse('http://localhost:8080').status, 404)
	})
})
