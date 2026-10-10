import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	contentSecurityPolicyWithFormAction,
	firstPartySecurityHeaders,
	pageResponseHeaders,
} from './security-headers.ts'

function directive(csp: string, name: string) {
	return csp.split('; ').find((d) => d.startsWith(`${name} `)) ?? ''
}

describe('contentSecurityPolicyWithFormAction', () => {
	it('adds only the given origins to form-action and leaves every other directive as is', () => {
		const base = firstPartySecurityHeaders['content-security-policy']!
		const widened = contentSecurityPolicyWithFormAction([
			'http://172.30.0.85:8123',
		])
		assert.equal(
			directive(widened, 'form-action'),
			"form-action 'self' https: http://localhost:* http://127.0.0.1:* http://172.30.0.85:8123",
		)
		assert.deepEqual(
			widened.split('; ').filter((d) => !d.startsWith('form-action ')),
			base.split('; ').filter((d) => !d.startsWith('form-action ')),
		)
		assert.equal(contentSecurityPolicyWithFormAction([]), base)
	})

	it('refuses anything that is not a bare http(s) origin', () => {
		for (const bad of [
			"'unsafe-inline'",
			'http://a.example/path',
			'javascript:alert(1)',
			'http://a.example; script-src *',
		]) {
			assert.throws(() => contentSecurityPolicyWithFormAction([bad]))
		}
	})
})

describe('pageResponseHeaders', () => {
	it('replaces the first-party CSP with a page override instead of sending two', () => {
		const widened = contentSecurityPolicyWithFormAction([
			'http://172.30.0.85:8123',
		])
		const headers = pageResponseHeaders({
			'Content-Security-Policy': widened,
			'referrer-policy': 'no-referrer',
		})
		assert.equal(headers['content-security-policy'], widened)
		assert.equal(headers['referrer-policy'], 'no-referrer')
		assert.equal(
			headers['x-frame-options'],
			firstPartySecurityHeaders['x-frame-options'],
		)
		const response = new Response(null, { headers })
		assert.equal(response.headers.get('content-security-policy'), widened)
		assert.equal(
			[...response.headers.keys()].filter(
				(k) => k === 'content-security-policy',
			).length,
			1,
		)
	})
})
