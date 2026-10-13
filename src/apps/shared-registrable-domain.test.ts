import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	registrableDomain,
	shareRegistrableDomain,
	sharedRegistrableDomainWarning,
} from './shared-registrable-domain.ts'

describe('registrableDomain', () => {
	it('returns the PSL registrable domain for normal hosts', () => {
		assert.equal(registrableDomain('kody.example.com'), 'example.com')
		assert.equal(registrableDomain('apps.example.com'), 'example.com')
		assert.equal(registrableDomain('user-abc.apps.example.com'), 'example.com')
		assert.equal(registrableDomain('EXAMPLE.COM'), 'example.com')
	})

	it('treats public-suffix multi-labels correctly', () => {
		assert.equal(registrableDomain('kody.example.co.uk'), 'example.co.uk')
		assert.equal(registrableDomain('apps.example.co.uk'), 'example.co.uk')
		// github.io is on the PSL: each label under it is its own registrable domain.
		assert.equal(registrableDomain('kody.github.io'), 'kody.github.io')
		assert.equal(registrableDomain('apps.github.io'), 'apps.github.io')
	})

	it('returns null for hosts without a registrable domain', () => {
		assert.equal(registrableDomain('localhost'), null)
		assert.equal(registrableDomain('127.0.0.1'), null)
		assert.equal(registrableDomain(''), null)
	})
})

describe('shareRegistrableDomain', () => {
	it('is true only when both hosts share a non-null registrable domain', () => {
		assert.equal(shareRegistrableDomain('kody.example.com', 'apps.example.com'), true)
		assert.equal(shareRegistrableDomain('kody.example.com', 'example.com'), true)
		assert.equal(shareRegistrableDomain('kody.example.com', 'apps.other.net'), false)
		assert.equal(shareRegistrableDomain('kody.github.io', 'apps.github.io'), false)
		assert.equal(shareRegistrableDomain('localhost', 'apps.localhost'), false)
		assert.equal(shareRegistrableDomain('kody.localhost', 'apps.localhost'), false)
		assert.equal(shareRegistrableDomain('kody.lan', 'apps.lan'), false)
	})
})

describe('sharedRegistrableDomainWarning', () => {
	it('warns when Kody and apps share a registrable domain', () => {
		const message = sharedRegistrableDomainWarning({
			KODY_PUBLIC_URL: 'https://kody.example.com',
			KODY_APP_BASE_URL: 'https://apps.example.com',
		})
		assert.ok(message)
		assert.match(message!, /share the registrable domain "example\.com"/)
		assert.match(message!, /Domain=example\.com/)
		assert.match(message!, /On http installs/)
		assert.match(message!, /On https installs/)
		assert.match(message!, /__Host-kody_session/)
		assert.match(message!, /non-__Host- cookies still can/)
		assert.match(message!, /separate registrable domain/)
	})

	it('warns for subdomain-mode app bases on the same parent', () => {
		const message = sharedRegistrableDomainWarning({
			KODY_PUBLIC_URL: 'https://kody.example.com',
			KODY_APP_BASE_URL: 'https://*.apps.example.com',
		})
		assert.ok(message)
		assert.match(message!, /example\.com/)
	})

	it('is silent when domains differ, apps are off, or hosts have no registrable domain', () => {
		assert.equal(
			sharedRegistrableDomainWarning({
				KODY_PUBLIC_URL: 'https://kody.example.com',
				KODY_APP_BASE_URL: 'https://apps.other.net',
			}),
			null,
		)
		assert.equal(sharedRegistrableDomainWarning({ KODY_PUBLIC_URL: 'https://kody.example.com' }), null)
		assert.equal(
			sharedRegistrableDomainWarning({
				KODY_PUBLIC_URL: 'http://localhost:8787',
				KODY_APP_BASE_URL: 'http://apps.localhost:8787',
			}),
			null,
		)
		assert.equal(
			sharedRegistrableDomainWarning({
				KODY_PUBLIC_URL: 'https://kody.github.io',
				KODY_APP_BASE_URL: 'https://apps.github.io',
			}),
			null,
		)
	})
})
