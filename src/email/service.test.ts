import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Env } from '../env.ts'
import { handleEmailEvents, handleEmailInbound } from './service.ts'

function emailEnv(overrides: Partial<Env> = {}): Env {
	return {
		KODY_ADMIN_TOKEN: 'a'.repeat(64),
		KODY_MASTER_KEY: 'b'.repeat(64),
		KODY_PUBLIC_URL: 'https://kody.example.com',
		...overrides,
	} as Env
}

const noopCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext

describe('email inbound/events without a token', () => {
	it('refuses inbound with 501 when the domain is set but no inbound token is configured', async () => {
		const url = new URL('http://kody.example.com/email/inbound/generic')
		const response = await handleEmailInbound(
			new Request(url, {
				method: 'POST',
				headers: { authorization: 'Bearer anything', 'content-type': 'application/json' },
				body: JSON.stringify({ from: 'a@b.c', to: 'x@mail.example.com', subject: 't', text: 't' }),
			}),
			emailEnv({ KODY_EMAIL_DOMAIN: 'mail.example.com' }),
			noopCtx,
			url,
		)
		assert.equal(response.status, 501)
		const body = (await response.json()) as { error: string }
		assert.equal(body.error, 'email_inbound_disabled')
	})

	it('refuses events with 501 when the domain is set but no inbound token is configured', async () => {
		const url = new URL('http://kody.example.com/email/events/bridge')
		const response = await handleEmailEvents(
			new Request(url, {
				method: 'POST',
				headers: { authorization: 'Bearer anything', 'content-type': 'application/json' },
				body: JSON.stringify({ messageId: 'x', event: 'delivered' }),
			}),
			emailEnv({ KODY_EMAIL_DOMAIN: 'mail.example.com' }),
			noopCtx,
			url,
		)
		assert.equal(response.status, 501)
		const body = (await response.json()) as { error: string }
		assert.equal(body.error, 'email_inbound_disabled')
	})

	it('returns 501 email_not_configured when the domain is unset (default single-node)', async () => {
		const url = new URL('http://kody.example.com/email/inbound/generic')
		const response = await handleEmailInbound(
			new Request(url, {
				method: 'POST',
				headers: {
					authorization: 'Bearer dev-email-inbound-token-only-for-celld-dev',
					'content-type': 'application/json',
				},
				body: '{}',
			}),
			emailEnv(),
			noopCtx,
			url,
		)
		assert.equal(response.status, 501)
		const body = (await response.json()) as { error: string }
		assert.equal(body.error, 'email_not_configured')
	})

	it('returns 410 for removed inbound adapters', async () => {
		const url = new URL('http://kody.example.com/email/inbound/postmark')
		const response = await handleEmailInbound(
			new Request(url, { method: 'POST', body: '{}' }),
			emailEnv({ KODY_EMAIL_DOMAIN: 'mail.example.com' }),
			noopCtx,
			url,
		)
		assert.equal(response.status, 410)
		const body = (await response.json()) as { error: string; message: string }
		assert.equal(body.error, 'adapter_removed')
		assert.match(body.message, /was removed/)
	})
})
