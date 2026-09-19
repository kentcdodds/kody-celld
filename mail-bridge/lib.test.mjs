import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	acceptsRecipient,
	bareMessageId,
	bearerMatches,
	buildMailOptions,
	configFromEnv,
	receivedHeader,
	smtpReplyFor,
} from './lib.mjs'

const env = {
	KODY_URL: 'http://kody:8080/',
	KODY_EMAIL_DOMAIN: 'kody.example',
	KODY_EMAIL_INBOUND_TOKEN: 'inbound-token-value',
	MAIL_BRIDGE_TOKEN: 'bridge-token-value-1234',
}
const config = configFromEnv(env)

describe('configFromEnv', () => {
	it('normalizes and validates', () => {
		assert.equal(config.kodyUrl, 'http://kody:8080')
		assert.deepEqual(config.domains, ['kody.example'])
		assert.equal(config.smtpUrl, null)
		assert.equal(config.smtpPort, 25)
		assert.throws(() => configFromEnv({ ...env, MAIL_BRIDGE_TOKEN: 'short' }), /at least 16/)
		assert.throws(() => configFromEnv({ ...env, MAIL_BRIDGE_SMTP_URL: 'http://relay' }), /smtp:\/\//)
		assert.throws(() => configFromEnv({ ...env, KODY_EMAIL_DOMAIN: 'nope' }), /bare domain/)
	})
})

describe('acceptsRecipient / bearerMatches', () => {
	it('only takes mail for our domains', () => {
		assert.equal(acceptsRecipient(config, '<Kent@Kody.Example>'), true)
		assert.equal(acceptsRecipient(config, 'kent@other.example'), false)
		assert.equal(acceptsRecipient(config, 'not-an-address'), false)
	})
	it('constant-time bearer check', () => {
		assert.equal(bearerMatches('Bearer bridge-token-value-1234', config.token), true)
		assert.equal(bearerMatches('Bearer nope', config.token), false)
		assert.equal(bearerMatches(undefined, config.token), false)
	})
})

describe('smtpReplyFor / receivedHeader', () => {
	it('maps Kody statuses to SMTP codes', () => {
		assert.equal(smtpReplyFor(200).code, 250)
		assert.equal(smtpReplyFor(404).code, 550)
		assert.equal(smtpReplyFor(413).code, 552)
		assert.equal(smtpReplyFor(429).code, 452)
		assert.equal(smtpReplyFor(400, { message: 'bad' }).message, '5.6.0 Rejected by Kody: bad')
		assert.equal(smtpReplyFor(500).code, 451)
		assert.equal(smtpReplyFor(401).code, 451)
	})
	it('writes a folded Received header', () => {
		const header = receivedHeader({
			clientHostname: 'mx.sender.example',
			remoteAddress: '203.0.113.5',
			hostname: 'bridge.kody.example',
			recipients: ['kent@kody.example'],
			now: new Date('2026-01-01T00:00:00Z'),
		})
		assert.match(header, /^Received: from mx\.sender\.example \(203\.0\.113\.5\)\r\n\tby bridge\.kody\.example/)
		assert.match(header, /for <kent@kody\.example>;\r\n\tThu, 01 Jan 2026 00:00:00 GMT\r\n$/)
	})
})

describe('buildMailOptions', () => {
	const body = {
		from: { name: 'Kent', address: 'kent@kody.example' },
		to: [{ address: 'friend@example.com', name: 'Friend' }, 'plain@example.com'],
		cc: [],
		replyTo: [{ address: 'kent+r@kody.example' }],
		subject: 'Hi\r\nBcc: evil@example.com',
		text: 'hello',
		headers: { 'x-kody-tag': 'smoke', 'in-reply-to': '<orig@example.com>', bcc: 'evil@example.com', 'x-bad': 'a\r\nb' },
		attachments: [
			{ filename: '../a.txt', contentType: 'text/plain', contentBase64: Buffer.from('x').toString('base64') },
		],
	}

	it('builds safe nodemailer options', () => {
		const options = buildMailOptions(config, body)
		assert.deepEqual(options.from, { name: 'Kent', address: 'kent@kody.example' })
		assert.deepEqual(options.to, [{ name: 'Friend', address: 'friend@example.com' }, 'plain@example.com'])
		assert.equal(options.subject, 'Hi Bcc: evil@example.com')
		assert.deepEqual(options.headers, { 'x-kody-tag': 'smoke' })
		assert.equal(options.inReplyTo, '<orig@example.com>')
		assert.equal(options.cc, undefined)
		assert.deepEqual(options.replyTo, ['kent+r@kody.example'])
		assert.equal(options.attachments[0].filename, '.._a.txt')
		assert.equal(options.attachments[0].content.toString(), 'x')
		assert.match(options.messageId, /^<[0-9a-f-]{36}@kody\.example>$/)
		assert.equal(bareMessageId(options.messageId).includes('<'), false)
	})

	it('refuses foreign senders and empty recipients', () => {
		assert.throws(() => buildMailOptions(config, { ...body, from: 'kent@other.example' }), /from must be an address on/)
		assert.throws(() => buildMailOptions(config, { ...body, to: [], cc: [] }), /recipient/)
		assert.throws(() => buildMailOptions(config, { ...body, attachments: [{ filename: 'x' }] }), /contentBase64/)
	})
})
