// End-to-end: real SMTP session -> bridge -> fake Kody, and POST /send -> fake relay -> event back.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import { after, before, describe, it } from 'node:test'
import { createTransport } from 'nodemailer'
import { SMTPServer } from 'smtp-server'

const here = new URL('.', import.meta.url).pathname

function freePort() {
	return new Promise((resolve) => {
		const server = net.createServer()
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address()
			server.close(() => resolve(port))
		})
	})
}

function waitFor(check, timeoutMs = 10_000) {
	const started = Date.now()
	return new Promise((resolve, reject) => {
		const tick = async () => {
			try {
				const value = await check()
				if (value) return resolve(value)
			} catch {
				// not ready yet
			}
			if (Date.now() - started > timeoutMs) return reject(new Error('timed out'))
			setTimeout(tick, 100)
		}
		void tick()
	})
}

const kodyRequests = []
const relayMessages = []
let bridge
let ports
let cleanup = () => {}

describe('mail bridge', () => {
	after(() => cleanup())
	before(async () => {
		ports = { kody: await freePort(), relay: await freePort(), smtp: await freePort(), http: await freePort() }
		const fakeKody = http.createServer((request, response) => {
			const chunks = []
			request.on('data', (c) => chunks.push(c))
			request.on('end', () => {
				const body = Buffer.concat(chunks)
				kodyRequests.push({ url: request.url, headers: request.headers, body })
				response.setHeader('content-type', 'application/json')
				if (request.url === '/email/inbound/bridge') {
					const to = request.headers['x-kody-envelope-to'] ?? ''
					if (to.includes('nobody@')) {
						response.writeHead(404)
						return response.end(JSON.stringify({ error: 'not_accepted' }))
					}
					response.writeHead(200)
					return response.end(JSON.stringify({ accepted: [to] }))
				}
				response.writeHead(200)
				response.end('{}')
			})
		})
		await new Promise((resolve) => fakeKody.listen(ports.kody, '127.0.0.1', resolve))
		const relay = new SMTPServer({
			authOptional: true,
			disabledCommands: ['AUTH', 'STARTTLS'],
			onData(stream, session, callback) {
				const chunks = []
				stream.on('data', (c) => chunks.push(c))
				stream.on('end', () => {
					relayMessages.push({ envelope: session.envelope, raw: Buffer.concat(chunks).toString() })
					callback(null, 'OK relayed')
				})
			},
		})
		await new Promise((resolve) => relay.listen(ports.relay, '127.0.0.1', resolve))
		bridge = spawn(process.execPath, ['server.mjs'], {
			cwd: here,
			env: {
				...process.env,
				KODY_URL: `http://127.0.0.1:${ports.kody}`,
				KODY_EMAIL_DOMAIN: 'kody.test',
				KODY_EMAIL_INBOUND_TOKEN: 'inbound-token-for-test',
				MAIL_BRIDGE_TOKEN: 'bridge-token-for-test',
				MAIL_BRIDGE_SMTP_URL: `smtp://127.0.0.1:${ports.relay}?ignoreTLS=true`,
				MAIL_BRIDGE_SMTP_PORT: String(ports.smtp),
				MAIL_BRIDGE_HTTP_PORT: String(ports.http),
				MAIL_BRIDGE_HOSTNAME: 'bridge.kody.test',
			},
			stdio: ['ignore', 'pipe', 'inherit'],
		})
		bridge.stdout.on('data', () => {})
		cleanup = () => {
			bridge.kill('SIGTERM')
			fakeKody.close()
			relay.close()
		}
		await waitFor(async () => (await fetch(`http://127.0.0.1:${ports.http}/health`)).ok)
	})

	it('forwards SMTP deliveries to Kody with the envelope and a Received header', async () => {
		const client = createTransport({ host: '127.0.0.1', port: ports.smtp, ignoreTLS: true })
		const info = await client.sendMail({
			from: 'sender@example.com',
			to: 'kent+tag@kody.test',
			subject: 'Hello bridge',
			text: 'hi',
		})
		assert.deepEqual(info.accepted, ['kent+tag@kody.test'])
		const inbound = kodyRequests.find((r) => r.url === '/email/inbound/bridge')
		assert.ok(inbound)
		assert.equal(inbound.headers.authorization, 'Bearer inbound-token-for-test')
		assert.equal(inbound.headers['content-type'], 'message/rfc822')
		assert.equal(inbound.headers['x-kody-envelope-from'], 'sender@example.com')
		assert.equal(inbound.headers['x-kody-envelope-to'], 'kent+tag@kody.test')
		const raw = inbound.body.toString()
		assert.match(raw, /^Received: from .*\s+by bridge\.kody\.test \(kody-mail-bridge\)/s)
		assert.match(raw, /Subject: Hello bridge/)
	})

	it('rejects foreign recipients at RCPT and unknown inboxes at DATA', async () => {
		const client = createTransport({ host: '127.0.0.1', port: ports.smtp, ignoreTLS: true })
		await assert.rejects(
			client.sendMail({ from: 'sender@example.com', to: 'someone@other.test', subject: 'x', text: 'x' }),
			/Relay access denied/,
		)
		await assert.rejects(
			client.sendMail({ from: 'sender@example.com', to: 'nobody@kody.test', subject: 'x', text: 'x' }),
			/No such Kody inbox/,
		)
	})

	it('sends via the relay and reports a delivery event to Kody', async () => {
		const unauthorized = await fetch(`http://127.0.0.1:${ports.http}/send`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		})
		assert.equal(unauthorized.status, 401)
		const response = await fetch(`http://127.0.0.1:${ports.http}/send`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: 'Bearer bridge-token-for-test' },
			body: JSON.stringify({
				from: { name: 'Kent', address: 'kent@kody.test' },
				to: [{ address: 'friend@example.com' }],
				subject: 'Out',
				text: 'outbound body',
				headers: { 'x-kody-tag': 'smoke' },
				attachments: [
					{ filename: 'a.txt', contentType: 'text/plain', contentBase64: Buffer.from('att').toString('base64') },
				],
			}),
		})
		assert.equal(response.status, 202)
		const { messageId } = await response.json()
		assert.match(messageId, /@kody\.test$/)
		await waitFor(() => relayMessages.length > 0)
		const relayed = relayMessages[0]
		assert.equal(relayed.envelope.mailFrom.address, 'kent@kody.test')
		assert.equal(relayed.envelope.rcptTo[0].address, 'friend@example.com')
		assert.match(relayed.raw, new RegExp(`Message-ID: <${messageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`, 'i'))
		assert.match(relayed.raw, /X-Kody-Tag: smoke/i)
		assert.match(relayed.raw, /filename=a\.txt/)
		const event = await waitFor(() => kodyRequests.find((r) => r.url === '/email/events/bridge'))
		const payload = JSON.parse(event.body.toString())
		assert.equal(payload.messageId, messageId)
		assert.equal(payload.event, 'sent')
	})
})
