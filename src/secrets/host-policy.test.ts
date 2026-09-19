import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isHostApproved, isLoopbackHost, normalizeSecretHost, requestHost } from './host-policy.ts'

describe('normalizeSecretHost', () => {
	it('lowercases and accepts hostnames, IPv4, bracketed IPv6, and one-level wildcards', () => {
		assert.equal(normalizeSecretHost(' API.Example.com '), 'api.example.com')
		assert.equal(normalizeSecretHost('127.0.0.1'), '127.0.0.1')
		assert.equal(normalizeSecretHost('[::1]'), '[::1]')
		assert.equal(normalizeSecretHost('*.example.com'), '*.example.com')
	})

	it('rejects schemes, paths, ports, credentials, and bare wildcards', () => {
		for (const bad of [
			'https://example.com',
			'example.com/path',
			'example.com:443',
			'user@example.com',
			'*.com',
			'*.1.2.3.4',
			'',
		]) {
			assert.throws(() => normalizeSecretHost(bad), /invalid_host/, bad)
		}
	})
})

describe('isHostApproved', () => {
	it('matches exact hosts and wildcard suffixes but never the apex for a wildcard', () => {
		assert.equal(isHostApproved('api.example.com', ['api.example.com']), true)
		assert.equal(isHostApproved('api.example.com', ['*.example.com']), true)
		assert.equal(isHostApproved('example.com', ['*.example.com']), false)
		assert.equal(isHostApproved('evil-example.com', ['*.example.com']), false)
		assert.equal(isHostApproved('api.example.com', []), false)
	})

	it('derives the comparable host from a URL without the port', () => {
		assert.equal(requestHost(new URL('https://API.Example.com:8443/x')), 'api.example.com')
	})
})

describe('isLoopbackHost', () => {
	it('recognises loopback names and addresses only', () => {
		assert.equal(isLoopbackHost('localhost'), true)
		assert.equal(isLoopbackHost('app.localhost'), true)
		assert.equal(isLoopbackHost('127.0.0.1'), true)
		assert.equal(isLoopbackHost('example.com'), false)
	})
})
