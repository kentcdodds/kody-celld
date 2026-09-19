// M5 webhook smoke: mint/rotate/enable/disable through capabilities, the
// unauthenticated provider ingress (URL secret, HMAC hex prefix + Stripe
// timestamp.body, replay window, delivery-id and Idempotency-Key dedupe, ack vs
// sync, params vs request input), rate limiting, and that neither capabilities
// nor the ledger ever return the credential URL or secret values.
import { createHmac, randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, baseUrl, log, readPackageDir } from './lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageName = '@kody-smoke/inbox-hooks'

async function post(url, { headers = {}, body }) {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body,
	})
	const text = await response.text()
	let json
	try {
		json = JSON.parse(text)
	} catch {
		json = { raw: text }
	}
	return { status: response.status, json, headers: response.headers }
}

async function waitFor(check, label, timeoutMs = 15_000) {
	const started = Date.now()
	for (;;) {
		const value = await check()
		if (value) return value
		assert(Date.now() - started < timeoutMs, `timed out waiting for ${label}`)
		await new Promise((resolve) => setTimeout(resolve, 250))
	}
}

export async function smokeWebhooks({ mcp, user, token }) {
	const files = await readPackageDir(path.join(here, '..', 'examples', 'packages', 'inbox-hooks'))
	const saved = await mcp.call('packageSave', { files, source: 'examples/packages/inbox-hooks' })
	assert(saved.name === packageName, 'packageSave returned the wrong package', saved)
	log('packageSave', { name: saved.name, webhooks: saved.manifest.webhooks.map((w) => w.name) })

	const found = await mcp.search({ entity: 'capability', domain: 'webhooks' })
	const ids = new Set(found.results.map((hit) => hit.id))
	for (const expected of [
		'webhookList',
		'webhookUrlMint',
		'webhookUrlApply',
		'webhookUrlRotate',
		'webhookDeliveryList',
	]) {
		assert(ids.has(expected), `search should surface ${expected}`, [...ids])
	}

	const githubSecret = randomBytes(24).toString('hex')
	const stripeSecret = `whsec_${randomBytes(24).toString('base64url')}`
	await mcp.call('secretSave', { name: 'githubWebhookSecret', value: githubSecret })
	await mcp.call('secretSave', { name: 'stripeWebhookSecret', value: stripeSecret })

	// 1. mint: from a run it must be refused (runtime code can't mint credentials); directly it works.
	const fromRuntime = await mcp.execute(
		`import { kody } from 'kody:runtime'\nexport default async function main() { return await kody.webhookUrlMint({ packageName: ${JSON.stringify(packageName)}, webhookName: 'plain' }) }`,
	)
	assert(
		!fromRuntime.ok && /forbidden_from_runtime/.test(JSON.stringify(fromRuntime.error)),
		'mint from runtime must be refused',
		fromRuntime,
	)
	const mints = {}
	for (const webhookName of ['github', 'stripe', 'plain']) {
		const minted = await mcp.callDirect('webhookUrlMint', { packageName, webhookName })
		assert(typeof minted.handle === 'string' && minted.handle.length >= 16, 'mint handle missing', minted)
		assert(!('url' in minted) && !('secret' in minted), 'MINT LEAKED THE CREDENTIAL', minted)
		mints[webhookName] = minted
	}
	const again = await mcp.callDirect('webhookUrlMint', { packageName, webhookName: 'plain' })
	assert(again.handle === mints.plain.handle, 'mint must be idempotent per declaration', { again, first: mints.plain })
	const listed = await mcp.call('webhookList', { packageName })
	assert(
		listed.webhooks.length === 3 && listed.webhooks.every((w) => w.mint?.handle && w.mint.enabled && w.definition),
		'webhookList mismatch',
		listed,
	)
	assert(!/"secret"|"url"/.test(JSON.stringify(listed)), 'LIST LEAKED THE CREDENTIAL', listed)
	log('mint', Object.fromEntries(Object.entries(mints).map(([k, v]) => [k, v.handle])))

	// 2. reveal is an authenticated HTTP route only (audited), never a capability
	const reveal = async (handle) => {
		const res = await fetch(`${baseUrl}/api/webhooks/${encodeURIComponent(handle)}/url`, {
			headers: { authorization: `Bearer ${token}` },
		})
		const json = await res.json()
		assert(res.status === 200 && typeof json.url === 'string', 'reveal failed', json)
		assert(json.url.startsWith(`${baseUrl}/webhooks/${user.id}/${handle}/`), 'reveal url shape', json.url)
		return json.url
	}
	const anonReveal = await fetch(`${baseUrl}/api/webhooks/${encodeURIComponent(mints.plain.handle)}/url`)
	assert(anonReveal.status === 401, 'reveal without token must be 401', anonReveal.status)
	const urls = {
		github: await reveal(mints.github.handle),
		stripe: await reveal(mints.stripe.handle),
		plain: await reveal(mints.plain.handle),
	}
	log('reveal', { route: '/api/webhooks/:handle/url', unauthenticated: anonReveal.status })

	// 3. plain: sync + params, result becomes the response; bad JSON is 400
	const plainBody = { order: randomBytes(4).toString('hex'), amount: 42 }
	const plain = await post(urls.plain, { body: JSON.stringify(plainBody) })
	assert(
		plain.status === 200 && plain.json.ok && plain.json.result.echoed.order === plainBody.order,
		'plain sync delivery',
		plain.json,
	)
	assert(
		typeof plain.json.runId === 'string' && typeof plain.json.deliveryId === 'string',
		'sync response ids',
		plain.json,
	)
	const plainBad = await post(urls.plain, { body: '[1,2,3]' })
	assert(
		plainBad.status === 400 && plainBad.json.error === 'invalid_params',
		'params mode needs an object',
		plainBad.json,
	)
	const plainFail = await post(urls.plain, { body: JSON.stringify({ fail: 'yes' }) })
	assert(
		plainFail.status === 500 &&
			plainFail.json.ok === false &&
			/asked to fail/.test(plainFail.json.error?.message ?? ''),
		'sync failure surfaces',
		plainFail.json,
	)
	const wrongSecret = await post(`${urls.plain.slice(0, -4)}nope`, { body: '{}' })
	assert(wrongSecret.status === 404, 'wrong url secret must be 404', wrongSecret.json)
	const wrongMethod = await fetch(urls.plain, { method: 'GET' })
	assert(wrongMethod.status === 405, 'GET must be 405', wrongMethod.status)
	log('plain', {
		sync: plain.status,
		invalidParams: plainBad.status,
		handlerError: plainFail.status,
		wrongSecret: wrongSecret.status,
	})

	// 4. Idempotency-Key: same key + same payload replays; different payload conflicts
	const key = `k-${randomBytes(6).toString('hex')}`
	const body1 = JSON.stringify({ order: 'idem', n: 1 })
	const first = await post(urls.plain, { headers: { 'idempotency-key': key }, body: body1 })
	const replay = await post(urls.plain, { headers: { 'idempotency-key': key }, body: body1 })
	const conflict = await post(urls.plain, {
		headers: { 'idempotency-key': key },
		body: JSON.stringify({ order: 'idem', n: 2 }),
	})
	assert(first.status === 200 && replay.status === 200, 'idempotent replay status', {
		first: first.json,
		replay: replay.json,
	})
	assert(replay.json.replayed === true && replay.json.runId === first.json.runId, 'replay must reuse the run', {
		first: first.json,
		replay: replay.json,
	})
	assert(replay.headers.get('x-kody-replayed') === 'true', 'replay header')
	assert(
		conflict.status === 409 && conflict.json.error === 'idempotency_mismatch',
		'payload mismatch must conflict',
		conflict.json,
	)
	log('idempotency', { first: first.json.runId, replayed: replay.json.replayed, conflict: conflict.status })

	// 5. github: hmac hex with prefix, ack mode, delivery-id dedupe, bad signature rejected
	const ghBody = JSON.stringify({ ref: 'refs/heads/main', after: randomBytes(20).toString('hex') })
	const sign = (secret, message) => createHmac('sha256', secret).update(message).digest('hex')
	const deliveryId = crypto.randomUUID()
	const ghHeaders = {
		'x-github-event': 'push',
		'x-github-delivery': deliveryId,
		'x-hub-signature-256': `sha256=${sign(githubSecret, ghBody)}`,
	}
	const gh = await post(urls.github, { headers: ghHeaders, body: ghBody })
	assert(gh.status === 202 && gh.json.accepted === true && gh.json.deliveryId, 'github ack delivery', gh.json)
	const ghDup = await post(urls.github, { headers: ghHeaders, body: ghBody })
	assert(ghDup.status === 202 && ghDup.json.replayed === true, 'duplicate delivery id must replay', ghDup.json)
	const ghBadSig = await post(urls.github, {
		headers: {
			...ghHeaders,
			'x-github-delivery': crypto.randomUUID(),
			'x-hub-signature-256': `sha256=${sign('wrong', ghBody)}`,
		},
		body: ghBody,
	})
	assert(ghBadSig.status === 401, 'bad signature must be 401', ghBadSig.json)
	const ghNoSig = await post(urls.github, { headers: { 'x-github-event': 'push' }, body: ghBody })
	assert(ghNoSig.status === 401, 'missing signature must be 401', ghNoSig.json)
	const ghUpper = await post(urls.github, {
		headers: {
			...ghHeaders,
			'x-github-delivery': crypto.randomUUID(),
			'x-hub-signature-256': `sha256=${sign(githubSecret, ghBody).toUpperCase()}`,
		},
		body: ghBody,
	})
	assert(ghUpper.status === 202, 'hex signatures compare case-insensitively', ghUpper.json)
	const status = await waitFor(async () => {
		const s = await mcp.callDirect('packageRun', { name: packageName })
		const rows = s.result?.recent ?? s.recent
		const hits = rows.filter((row) => row.kind === 'webhook:github')
		return hits.length >= 2 ? hits : null
	}, 'github ack runs to land in packageStorage')
	assert(
		status.some((row) => row.summary.deliveryId === gh.json.deliveryId && row.summary.event === 'push'),
		'ack run did not receive the request envelope',
		status,
	)
	log('github', {
		ack: gh.status,
		duplicate: ghDup.json.replayed,
		badSignature: ghBadSig.status,
		landed: status.length,
	})

	// 6. stripe: timestamp.body signing, replay window, sync response
	const stripeBody = JSON.stringify({ id: `evt_${randomBytes(8).toString('hex')}`, type: 'invoice.paid' })
	const t = Math.floor(Date.now() / 1000)
	const stripeHeader = (ts, secret = stripeSecret) =>
		`t=${ts},v1=${sign(secret, `${ts}.${stripeBody}`)},v1=${sign('other', `${ts}.${stripeBody}`)}`
	const stripe = await post(urls.stripe, { headers: { 'stripe-signature': stripeHeader(t) }, body: stripeBody })
	assert(stripe.status === 200 && stripe.json.result.type === 'invoice.paid', 'stripe sync delivery', stripe.json)
	const stale = await post(urls.stripe, { headers: { 'stripe-signature': stripeHeader(t - 3600) }, body: stripeBody })
	assert(stale.status === 401, 'stale timestamp must be rejected', stale.json)
	const noTs = await post(urls.stripe, {
		headers: { 'stripe-signature': `v1=${sign(stripeSecret, stripeBody)}` },
		body: stripeBody,
	})
	assert(noTs.status === 401, 'missing timestamp must be rejected', noTs.json)
	log('stripe', { sync: stripe.status, stale: stale.status, missingTimestamp: noTs.status })

	// 7. rate limit: stripe allows 5/min; we've used 3 admitted attempts (rate counts admissions)
	let limited = null
	for (let i = 0; i < 6 && !limited; i++) {
		const res = await post(urls.stripe, { headers: { 'stripe-signature': stripeHeader(t) }, body: stripeBody })
		if (res.status === 429) limited = res
	}
	assert(limited && limited.headers.get('retry-after') === '60', 'rate limit must trip with retry-after', limited?.json)
	log('rate limit', { status: limited.status, retryAfter: limited.headers.get('retry-after') })

	// 8. disable/enable, rotate (previous URL stays valid until first accepted delivery on the new one), delete
	await mcp.call('webhookDisable', { handle: mints.plain.handle })
	const disabled = await post(urls.plain, { body: '{}' })
	assert(disabled.status === 404, 'disabled webhook must 404', disabled.json)
	await mcp.call('webhookEnable', { handle: mints.plain.handle })
	const rotated = await mcp.callDirect('webhookUrlRotate', { handle: mints.plain.handle })
	assert(rotated.previousExpiresAt && !('url' in rotated), 'rotate response', rotated)
	const newUrl = await reveal(mints.plain.handle)
	assert(newUrl !== urls.plain, 'rotate must change the url')
	const oldStillWorks = await post(urls.plain, { body: JSON.stringify({ via: 'old' }) })
	assert(oldStillWorks.status === 200, 'previous url must work during the grace period', oldStillWorks.json)
	const newWorks = await post(newUrl, { body: JSON.stringify({ via: 'new' }) })
	assert(newWorks.status === 200, 'new url must work', newWorks.json)
	const oldDead = await post(urls.plain, { body: JSON.stringify({ via: 'old-after' }) })
	assert(oldDead.status === 404, 'previous url must die after the first delivery on the new one', oldDead.json)
	log('rotate', { previousDuringGrace: oldStillWorks.status, previousAfterNew: oldDead.status })

	// 9. ledger: metadata only, reasons explain rejections, nothing secret
	const deliveries = await mcp.call('webhookDeliveryList', { handle: mints.github.handle, limit: 50 })
	const reasons = new Set(deliveries.deliveries.map((d) => d.reason).filter(Boolean))
	assert(reasons.has('signature_mismatch') && reasons.has('signature_missing'), 'ledger must explain rejections', [
		...reasons,
	])
	assert(
		deliveries.deliveries.some((d) => d.status === 'success'),
		'ledger must record successful runs',
		deliveries.deliveries.slice(0, 3),
	)
	const ledgerText = JSON.stringify(deliveries)
	assert(!ledgerText.includes(githubSecret) && !ledgerText.includes(ghBody), 'LEDGER LEAKED SECRET OR BODY')
	const everything = JSON.stringify([listed, rotated, deliveries, gh.json, plain.json])
	for (const url of Object.values(urls))
		assert(!everything.includes(url.split('/').at(-1)), 'A RESPONSE LEAKED A URL SECRET')
	const deleted = await mcp.callDirect('webhookDelete', { handle: mints.stripe.handle })
	assert(deleted.deleted === true, 'delete', deleted)
	const afterDelete = await post(urls.stripe, { headers: { 'stripe-signature': stripeHeader(t) }, body: stripeBody })
	assert(afterDelete.status === 404, 'deleted webhook must 404', afterDelete.json)
	log('ledger', { deliveries: deliveries.deliveries.length, reasons: [...reasons], deleted: deleted.deleted })

	// 10. webhookUrlApply against a local "provider": the URL is substituted server-side, never returned
	const applyTarget = await startApplyTarget()
	try {
		const host = `${applyTarget.host}:${applyTarget.port}`
		const applied = await mcp.callDirect('webhookUrlApply', {
			handle: mints.plain.handle,
			target: { type: 'http', url: `http://${host}/register`, body: { callback: '{{webhookUrl}}', name: 'kody' } },
		})
		assert(applied.applied === true && applied.host === host, 'apply result', applied)
		assert(!JSON.stringify(applied).includes(newUrl.split('/').at(-1)), 'APPLY LEAKED THE URL')
		assert(applyTarget.seen[0]?.callback === newUrl, 'provider must receive the real URL', applyTarget.seen)
		log('apply', { status: applied.status, providerReceivedUrl: applyTarget.seen[0]?.callback === newUrl })
	} finally {
		await applyTarget.close()
	}
}

async function startApplyTarget() {
	const { createServer } = await import('node:http')
	const host = process.env.SMOKE_ECHO_HOST ?? '127.0.0.1'
	const bind = process.env.SMOKE_ECHO_BIND ?? (host === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0')
	const port = Number(process.env.SMOKE_APPLY_PORT ?? 9798)
	const seen = []
	const server = createServer(async (req, res) => {
		let body = ''
		for await (const chunk of req) body += chunk
		seen.push(JSON.parse(body))
		res.writeHead(201, { 'content-type': 'application/json' })
		res.end(JSON.stringify({ id: 'hook_1' }))
	})
	await new Promise((resolve) => server.listen(port, bind, resolve))
	return { host, port, seen, close: () => new Promise((resolve) => server.close(resolve)) }
}
