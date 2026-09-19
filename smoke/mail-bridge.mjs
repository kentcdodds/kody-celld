// Real mail-bridge sidecar against a running kody-celld: an SMTP client
// delivers to the bridge, the bridge forwards the raw message to
// POST /email/inbound/bridge; emailSend goes Kody -> bridge /send -> a local
// SMTP relay sink, and the bridge posts the delivery event back so the message
// ends up "sent". Opt in with SMOKE_MAIL_BRIDGE=1 (needs `npm ci` in
// mail-bridge/ and Kody's bridge outbound URL pointing at SMOKE_BRIDGE_PORT).
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, log } from './lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const bridgeDir = path.join(here, '..', 'mail-bridge')
const inboundToken = process.env.KODY_EMAIL_INBOUND_TOKEN ?? 'dev-email-inbound-token-only-for-celld-dev'
const bridgeToken = process.env.KODY_EMAIL_OUTBOUND_TOKEN ?? 'dev-email-bridge-token-only-for-celld-dev'

function freePort() {
	return new Promise((resolve) => {
		const server = net.createServer()
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address()
			server.close(() => resolve(port))
		})
	})
}

async function waitFor(check, label, timeoutMs = 15_000) {
	const started = Date.now()
	for (;;) {
		try {
			const value = await check()
			if (value) return value
		} catch {
			// not ready yet
		}
		assert(Date.now() - started < timeoutMs, `timed out waiting for ${label}`)
		await new Promise((resolve) => setTimeout(resolve, 200))
	}
}

export async function smokeMailBridge({ mcp, user }) {
	if (process.env.SMOKE_MAIL_BRIDGE !== '1') {
		log('skip', 'set SMOKE_MAIL_BRIDGE=1 (after `npm ci` in mail-bridge/) to run the real sidecar')
		return
	}
	const status = await mcp.call('emailStatus', {})
	if (!status.configured || status.outbound !== 'bridge') {
		log('skip', `email outbound is ${status.outbound ?? 'off'}; the sidecar scenario needs the bridge provider`)
		return
	}
	const require = createRequire(path.join(bridgeDir, 'package.json'))
	let nodemailer, SMTPServer
	try {
		nodemailer = require('nodemailer')
		;({ SMTPServer } = require('smtp-server'))
	} catch {
		assert(false, 'mail-bridge dependencies missing: run `npm ci` in mail-bridge/')
	}
	const httpPort = Number(new URL(status.outboundBaseUrl).port || 80)
	const smtpPort = await freePort()
	const relayPort = await freePort()
	const kodyUrl = process.env.KODY_URL ?? 'http://127.0.0.1:8787'

	const relayed = []
	const relay = new SMTPServer({
		authOptional: true,
		disabledCommands: ['AUTH', 'STARTTLS'],
		onData(stream, session, callback) {
			const chunks = []
			stream.on('data', (c) => chunks.push(c))
			stream.on('end', () => {
				relayed.push({ envelope: session.envelope, raw: Buffer.concat(chunks).toString() })
				callback(null, 'OK relayed')
			})
		},
	})
	await new Promise((resolve) => relay.listen(relayPort, '127.0.0.1', resolve))

	const bridgeLog = []
	const bridge = spawn(process.execPath, ['server.mjs'], {
		cwd: bridgeDir,
		env: {
			PATH: process.env.PATH,
			KODY_URL: kodyUrl,
			KODY_EMAIL_DOMAIN: status.domain,
			KODY_EMAIL_INBOUND_TOKEN: inboundToken,
			MAIL_BRIDGE_TOKEN: bridgeToken,
			MAIL_BRIDGE_HOSTNAME: `mail.${status.domain}`,
			MAIL_BRIDGE_SMTP_PORT: String(smtpPort),
			MAIL_BRIDGE_HTTP_PORT: String(httpPort),
			MAIL_BRIDGE_SMTP_URL: `smtp://127.0.0.1:${relayPort}`,
			MAIL_BRIDGE_BIND: '127.0.0.1',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	bridge.stdout.on('data', (chunk) => bridgeLog.push(String(chunk)))
	bridge.stderr.on('data', (chunk) => bridgeLog.push(String(chunk)))
	try {
		await waitFor(
			async () => (await fetch(`http://127.0.0.1:${httpPort}/health`)).ok,
			`mail bridge on :${httpPort}${bridgeLog.length ? `\n${bridgeLog.join('')}` : ''}`,
		)
		const local = `bridge-${randomBytes(3).toString('hex')}`
		const claimed = await mcp.callDirect('emailInboxClaim', { local })
		log('bridge', { smtp: smtpPort, http: httpPort, relay: relayPort, inbox: claimed.address })

		// 1. SMTP in: a real client session ends up as a stored message with envelope routing
		const client = nodemailer.createTransport({ host: '127.0.0.1', port: smtpPort, secure: false, ignoreTLS: true })
		const subject = `Via SMTP ${randomBytes(3).toString('hex')}`
		const info = await client.sendMail({
			from: 'Carol <carol@sender.example>',
			to: `${local}+smtp@${status.domain}`,
			subject,
			text: 'Delivered over a real SMTP session.',
			attachments: [{ filename: 'note.txt', content: 'hello' }],
		})
		assert(info.accepted.length === 1, 'bridge must accept RCPT for our domain', info)
		const rejected = await client
			.sendMail({ from: 'carol@sender.example', to: 'someone@elsewhere.example', subject: 'x', text: 'y' })
			.then(
				() => null,
				(error) => error,
			)
		assert(rejected && /550/.test(rejected.message), 'foreign recipients must be refused at RCPT TO', rejected?.message)
		const unknownInbox = await client
			.sendMail({ from: 'carol@sender.example', to: `nobody-${local}@${status.domain}`, subject: 'x', text: 'y' })
			.then(
				() => null,
				(error) => error,
			)
		assert(
			unknownInbox && /550/.test(unknownInbox.message),
			'unknown inbox must be refused at DATA',
			unknownInbox?.message,
		)
		const stored = await waitFor(async () => {
			const list = await mcp.call('emailMessageList', { direction: 'inbound' })
			return list.messages.find((m) => m.subject === subject) ?? null
		}, 'the SMTP message to be stored')
		const full = await mcp.call('emailMessageGet', { id: stored.id })
		assert(full.from.address === 'carol@sender.example' && full.headers['x-kody-plus-tag'] === 'smtp', 'routing', full)
		assert(full.attachments[0]?.filename === 'note.txt', 'attachment parsed from MIME', full.attachments)
		assert(/^from /i.test(full.headers.received ?? ''), 'bridge prepends a Received header', full.headers)
		log('smtp in', { accepted: info.accepted, foreign: 550, unknownInbox: 550, stored: stored.id })

		// 2. Kody -> bridge /send -> relay; the bridge reports the delivery event back
		const sent = await mcp.call('emailSend', { to: user.email, subject: 'Via bridge', text: 'out through the sidecar' })
		assert(sent.deliveryStatus === 'queued' && sent.providerMessageId, 'send accepted by the bridge', sent)
		const relayedMessage = await waitFor(
			() => relayed.find((m) => m.raw.includes('Subject: Via bridge')),
			'relay delivery',
		)
		assert(relayedMessage.envelope.rcptTo[0].address === user.email, 'relay envelope', relayedMessage.envelope)
		assert(relayedMessage.raw.includes(`Message-ID: <${sent.providerMessageId}>`), 'bridge message id on the wire')
		const final = await waitFor(async () => {
			const m = await mcp.call('emailMessageGet', { id: sent.id })
			return m.deliveryStatus === 'sent' ? m : null
		}, 'the delivery event to land')
		const history = await mcp.call('emailDeliveryEventList', { id: sent.id })
		assert(
			history.events.some((e) => e.event === 'sent'),
			'event history',
			history,
		)
		assert(!bridgeLog.join('').includes('out through the sidecar'), 'BRIDGE LOGGED A MESSAGE BODY')
		log('send', { relayed: relayed.length, status: final.deliveryStatus, events: history.events.map((e) => e.event) })
		await mcp.callDirect('emailInboxRelease', { local })
	} finally {
		bridge.kill('SIGTERM')
		await new Promise((resolve) => relay.close(resolve))
	}
}
