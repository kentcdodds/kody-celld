import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	attachmentFromInput,
	cleanSubject,
	parseAddressList,
	parseRawEmail,
	parseReferences,
	pickSafeHeaders,
	splitInboxAddress,
	toAddressInput,
} from './message.ts'

describe('parseAddressList', () => {
	it('parses names, groups, and bare addresses', () => {
		const list = parseAddressList('Kent <Kent@Example.com>, plain@example.com')
		assert.deepEqual(list, [
			{ address: 'kent@example.com', name: 'Kent' },
			{ address: 'plain@example.com', name: null },
		])
	})

	it('returns [] for empty input', () => {
		assert.deepEqual(parseAddressList(''), [])
		assert.deepEqual(parseAddressList(null), [])
	})
})

describe('toAddressInput', () => {
	it('accepts a single { address, name } object', () => {
		assert.deepEqual(toAddressInput({ address: 'A@b.co', name: 'A' }), [{ address: 'a@b.co', name: 'A' }])
	})
	it('accepts strings, arrays, and provider-shaped objects', () => {
		assert.deepEqual(toAddressInput('a@b.co'), [{ address: 'a@b.co', name: null }])
		assert.deepEqual(toAddressInput([{ Email: 'A@B.co', Name: 'A' }, 'c@d.co']), [
			{ address: 'a@b.co', name: 'A' },
			{ address: 'c@d.co', name: null },
		])
		assert.deepEqual(toAddressInput([{ email: 'not an address' }]), [])
	})
})

describe('splitInboxAddress', () => {
	it('splits local part and plus tag on our domain only', () => {
		assert.deepEqual(splitInboxAddress('Kent+news@Kody.Example', 'kody.example'), { local: 'kent', tag: 'news' })
		assert.deepEqual(splitInboxAddress('kent@kody.example', 'kody.example'), { local: 'kent', tag: null })
		assert.equal(splitInboxAddress('kent@other.example', 'kody.example'), null)
		assert.equal(splitInboxAddress('+tag@kody.example', 'kody.example'), null)
	})
})

describe('pickSafeHeaders', () => {
	it('keeps only allowlisted headers and truncates long values', () => {
		const picked = pickSafeHeaders([
			['Subject', 'hello'],
			['Authorization', 'Bearer nope'],
			['X-Forwarded-For', '10.0.0.1'],
			['List-Unsubscribe', 'x'.repeat(5_000)],
		])
		assert.equal(picked.subject, 'hello')
		assert.equal(picked.authorization, undefined)
		assert.equal(picked['x-forwarded-for'], undefined)
		assert.equal(picked['list-unsubscribe']?.length, 2_000)
	})
	it('keeps only the top-most Received header', () => {
		const picked = pickSafeHeaders([
			['Received', 'from bridge by kody'],
			['Received', 'from upstream by bridge'],
			['To', 'a@x.co'],
			['To', 'b@x.co'],
		])
		assert.equal(picked.received, 'from bridge by kody')
		assert.equal(picked.to, 'a@x.co, b@x.co')
	})
})

describe('parseReferences / cleanSubject', () => {
	it('strips angle brackets and splits on whitespace or commas', () => {
		assert.deepEqual(parseReferences('<a@x> <b@x>,<c@x>'), ['a@x', 'b@x', 'c@x'])
	})
	it('collapses line breaks in subjects', () => {
		assert.equal(cleanSubject('Hi\r\nBcc: evil@x'), 'Hi Bcc: evil@x')
		assert.equal(cleanSubject(undefined), '')
	})
})

describe('attachmentFromInput', () => {
	it('fills defaults and computes size from base64', () => {
		const attachment = attachmentFromInput(
			{ filename: null, contentType: null, contentBase64: btoa('hello'), contentId: null, disposition: 'attachment' },
			0,
		)
		assert.equal(attachment.filename, 'attachment-1')
		assert.equal(attachment.contentType, 'application/octet-stream')
		assert.equal(attachment.size, 5)
		assert.equal(attachment.contentBase64, btoa('hello'))
	})
	it('strips path separators from filenames', () => {
		const attachment = attachmentFromInput(
			{
				filename: '../../etc/passwd',
				contentType: 'text/plain',
				contentBase64: '',
				contentId: null,
				disposition: 'attachment',
			},
			0,
		)
		assert.ok(!attachment.filename.includes('/'))
	})
})

describe('parseRawEmail', () => {
	it('parses a multipart RFC 5322 message with an attachment', async () => {
		const raw = [
			'From: Ada <ada@example.com>',
			'To: kent@kody.example',
			'Cc: bob@example.com',
			'Subject: =?UTF-8?Q?Caf=C3=A9_report?=',
			'Message-ID: <m1@example.com>',
			'In-Reply-To: <m0@example.com>',
			'References: <m0@example.com>',
			'Date: Tue, 01 Sep 2026 10:00:00 +0000',
			'X-Secret-Header: hidden',
			'MIME-Version: 1.0',
			'Content-Type: multipart/mixed; boundary="b1"',
			'',
			'--b1',
			'Content-Type: multipart/alternative; boundary="b2"',
			'',
			'--b2',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'Hello there',
			'--b2',
			'Content-Type: text/html; charset=utf-8',
			'',
			'<p>Hello <b>there</b></p>',
			'--b2--',
			'--b1',
			'Content-Type: text/csv',
			'Content-Disposition: attachment; filename="data.csv"',
			'Content-Transfer-Encoding: base64',
			'',
			btoa('a,b\n1,2\n'),
			'--b1--',
			'',
		].join('\r\n')
		const parsed = await parseRawEmail(raw)
		assert.deepEqual(parsed.from, { address: 'ada@example.com', name: 'Ada' })
		assert.deepEqual(parsed.to, [{ address: 'kent@kody.example', name: null }])
		assert.equal(parsed.subject, 'Café report')
		assert.equal(parsed.messageId, 'm1@example.com')
		assert.equal(parsed.inReplyTo, 'm0@example.com')
		assert.deepEqual(parsed.references, ['m0@example.com'])
		assert.equal(parsed.text?.trim(), 'Hello there')
		assert.match(parsed.html ?? '', /<b>there<\/b>/)
		assert.equal(parsed.headers['x-secret-header'], undefined)
		assert.equal(parsed.attachments.length, 1)
		assert.equal(parsed.attachments[0]?.filename, 'data.csv')
		assert.equal(atob(parsed.attachments[0]?.contentBase64 ?? ''), 'a,b\n1,2\n')
	})
})
