// M4 blob smoke: put/get/head/list/delete through capabilities, the raw-bytes
// /api/blobs route, signed download links, per-user isolation, quotas, and
// that nothing ever leaks bucket credentials. All content is random and
// generated here; assertions compare SHA-256 digests.
import { randomBytes } from 'node:crypto'
import { admin, adminToken, assert, baseUrl, bootstrapUser, log, sha256 } from './lib.mjs'

const credentialPattern = /secretAccessKey|KODY_BLOB_S3_SECRET|AWS4-HMAC/i

export async function smokeBlobs({ mcp, user, token }) {
	const status = await fetch(`${baseUrl}/admin/blobs`, { headers: { authorization: `Bearer ${adminToken}` } })
	const statusBody = await status.json()
	assert(status.status === 200, 'GET /admin/blobs failed', statusBody)
	const { blobs: providerInfo, bucketBound } = statusBody
	assert(providerInfo.provider === 'r2' || providerInfo.provider === 's3', 'unknown blob provider', providerInfo)
	assert(providerInfo.provider !== 'r2' || bucketBound, 'r2 provider without a BLOBS binding', providerInfo)
	assert(!credentialPattern.test(JSON.stringify(providerInfo)), 'ADMIN BLOB STATUS LEAKED CREDENTIALS')
	log('provider', { provider: providerInfo.provider, bucketBound, maxBytes: providerInfo.maxBytes })

	const found = await mcp.search({ entity: 'capability', domain: 'blobs' })
	const ids = new Set(found.results.map((hit) => hit.id))
	for (const expected of ['blobPut', 'blobGet', 'blobList', 'blobDelete', 'blobUrl', 'blobUsage']) {
		assert(ids.has(expected), `search should surface ${expected}`, [...ids])
	}

	// 1. text + binary round trips from sandbox code
	const text = `smoke ${randomBytes(16).toString('hex')}\nline two\n`
	const bytes = randomBytes(70_000)
	const stored = await mcp.run(
		`import { kody } from 'kody:runtime'
export default async function main({ text, base64 }) {
  const t = await kody.blobPut({ key: 'smoke/notes/hello.txt', content: text, metadata: { source: 'smoke' } })
  const b = await kody.blobPut({ key: 'smoke/bin/blob.bin', content: base64, encoding: 'base64', contentType: 'application/x-smoke' })
  const back = await kody.blobGet({ key: 'smoke/notes/hello.txt', encoding: 'utf8' })
  const head = await kody.blobHead({ key: 'smoke/bin/blob.bin' })
  const listed = await kody.blobList({ prefix: 'smoke/' })
  return { t, b, back, head, listed }
}`,
		{ text, base64: bytes.toString('base64') },
	)
	assert(stored.t.size === Buffer.byteLength(text) && stored.t.sha256 === sha256(text), 'text put mismatch', stored.t)
	assert(stored.t.contentType === 'text/plain; charset=utf-8', 'content type not inferred', stored.t)
	assert(stored.t.metadata.source === 'smoke', 'metadata not stored', stored.t)
	assert(stored.back.content === text, 'utf8 read mismatch')
	assert(stored.b.size === bytes.length && stored.b.sha256 === sha256(bytes), 'binary put mismatch', stored.b)
	assert(
		stored.head.contentType === 'application/x-smoke' && stored.head.size === bytes.length,
		'head mismatch',
		stored.head,
	)
	assert(stored.listed.items.length === 2 && stored.listed.cursor === null, 'list mismatch', stored.listed)
	assert(stored.t.packageName === null, 'ad hoc puts have no package provenance', stored.t)
	log('put/get/head/list', {
		text: stored.t.size,
		binary: stored.b.size,
		listed: stored.listed.items.map((i) => i.key),
	})

	// 2. raw-bytes HTTP route: GET what the capability wrote, PUT a new object
	const raw = await fetch(`${baseUrl}/api/blobs/smoke/bin/blob.bin`, { headers: { authorization: `Bearer ${token}` } })
	assert(raw.status === 200, 'GET /api/blobs failed', raw.status)
	assert(raw.headers.get('content-type') === 'application/x-smoke', 'raw content-type', raw.headers.get('content-type'))
	assert(raw.headers.get('x-kody-sha256') === sha256(bytes), 'raw sha header')
	assert(Buffer.from(await raw.arrayBuffer()).equals(bytes), 'raw bytes differ')
	const uploaded = randomBytes(1234)
	const putRes = await fetch(`${baseUrl}/api/blobs/smoke/raw/upload.bin`, {
		method: 'PUT',
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/octet-stream',
			'x-kody-blob-metadata': '{"via":"http"}',
		},
		body: uploaded,
	})
	const putRecord = await putRes.json()
	assert(putRes.status === 201, 'PUT /api/blobs failed', putRecord)
	assert(putRecord.sha256 === sha256(uploaded) && putRecord.metadata.via === 'http', 'PUT record mismatch', putRecord)
	const anon = await fetch(`${baseUrl}/api/blobs/smoke/raw/upload.bin`)
	assert(anon.status === 401, 'unauthenticated /api/blobs must be rejected', anon.status)
	log('http route', { get: 'ok', put: putRecord.size, unauthenticated: anon.status })

	// 3. signed links: work until expiry, fail when tampered, never carry credentials
	const link = await mcp.call('blobUrl', { key: 'smoke/notes/hello.txt', expiresIn: 120 })
	assert(link.url.startsWith(`${baseUrl}/blobs/`), 'signed url should be served by kody', link)
	assert(!credentialPattern.test(link.url), 'SIGNED URL LEAKED CREDENTIALS')
	const viaLink = await fetch(link.url)
	assert(viaLink.status === 200 && (await viaLink.text()) === text, 'signed link download failed', viaLink.status)
	const tampered = new URL(link.url)
	tampered.pathname = tampered.pathname.replace('hello.txt', 'other.txt')
	assert((await fetch(tampered)).status === 403, 'tampered signed link must fail')
	const expired = new URL(link.url)
	expired.searchParams.set('exp', String(Math.floor(Date.now() / 1000) - 10))
	assert((await fetch(expired)).status === 403, 'expired signed link must fail')
	log('signed url', { expiresAt: link.expiresAt, tampered: 403, expired: 403 })

	// 4. isolation: another user sees nothing and cannot read by key
	const other = await bootstrapUser('blob-other')
	await other.mcp.initialize()
	const otherList = await other.mcp.call('blobList', { prefix: 'smoke/' })
	assert(otherList.items.length === 0, 'blobs leaked across users', otherList)
	const otherGet = await other.mcp.execute(
		`import { kody } from 'kody:runtime'
export default async function main() { return await kody.blobGet({ key: 'smoke/notes/hello.txt' }) }`,
	)
	assert(
		!otherGet.ok && /blob_not_found/.test(otherGet.error?.message ?? ''),
		'cross-user read must 404',
		otherGet.error,
	)
	log('isolation', { otherUserSees: otherList.items.length })

	// 5. quotas + invalid keys + oversized objects
	const quotaSet = await admin.setQuota(other.user.id, { blobs: 1, blobBytes: 100 })
	assert(quotaSet.status === 200, 'blob quota override failed', quotaSet.json)
	const quota = await other.mcp.run(
		`import { kody } from 'kody:runtime'
async function attempt(fn) { try { return { ok: true, value: await fn() } } catch (e) { return { ok: false, error: String(e.message) } } }
export default async function main() {
  const first = await attempt(() => kody.blobPut({ key: 'q/a.txt', content: 'x'.repeat(50) }))
  const tooMany = await attempt(() => kody.blobPut({ key: 'q/b.txt', content: 'y' }))
  const tooBig = await attempt(() => kody.blobPut({ key: 'q/a.txt', content: 'z'.repeat(101) }))
  const badKey = await attempt(() => kody.blobPut({ key: '../escape', content: 'nope' }))
  const usage = await kody.blobUsage()
  return { first, tooMany, tooBig, badKey, usage }
}`,
	)
	assert(quota.first.ok, 'first put within quota should succeed', quota.first)
	assert(!quota.tooMany.ok && /quota_exceeded/.test(quota.tooMany.error), 'blob count quota', quota.tooMany)
	assert(!quota.tooBig.ok && /quota_exceeded/.test(quota.tooBig.error), 'blob bytes quota', quota.tooBig)
	assert(!quota.badKey.ok && /invalid_blob_key/.test(quota.badKey.error), 'key validation', quota.badKey)
	assert(quota.usage.blobs === 1 && quota.usage.blobBytes === 50, 'blobUsage counts', quota.usage)
	assert(quota.usage.quotas.blobs === 1 && quota.usage.quotas.blobBytes === 100, 'blobUsage quotas', quota.usage)
	assert(!credentialPattern.test(JSON.stringify(quota.usage)), 'blobUsage LEAKED CREDENTIALS')
	await admin.clearQuota(other.user.id)
	const tooLarge = await fetch(`${baseUrl}/api/blobs/smoke/huge.bin`, {
		method: 'PUT',
		headers: { authorization: `Bearer ${token}` },
		body: Buffer.alloc(providerInfo.maxBytes + 1),
	})
	assert(tooLarge.status === 413, 'object above KODY_BLOB_MAX_BYTES must be 413', tooLarge.status)
	log('quotas', { count: 'quota_exceeded', bytes: 'quota_exceeded', badKey: 'invalid_blob_key', oversize: 413 })

	// 6. admin visibility + delete + usage accounting
	const adminList = await fetch(`${baseUrl}/admin/users/${encodeURIComponent(user.id)}/blobs?prefix=smoke/`, {
		headers: { authorization: `Bearer ${adminToken}` },
	})
	const adminBody = await adminList.json()
	assert(adminList.status === 200, 'admin blob list failed', adminBody)
	const adminItems = adminBody.items
	assert(
		adminItems.length === 3,
		'admin should see all three smoke blobs',
		adminItems.map((i) => i.key),
	)
	const usageBefore = await mcp.call('blobUsage')
	const deleted = await mcp.run(
		`import { kody } from 'kody:runtime'
export default async function main() {
  const a = await kody.blobDelete({ key: 'smoke/bin/blob.bin' })
  const again = await kody.blobDelete({ key: 'smoke/bin/blob.bin' })
  const rest = await kody.blobList({ prefix: 'smoke/' })
  return { a, again, rest }
}`,
	)
	assert(deleted.a.deleted === true && deleted.a.freedBytes === bytes.length, 'delete mismatch', deleted.a)
	assert(deleted.again.deleted === false, 'second delete should be a no-op', deleted.again)
	assert(deleted.rest.items.length === 2, 'two blobs should remain', deleted.rest)
	const gone = await fetch(`${baseUrl}/api/blobs/smoke/bin/blob.bin`, { headers: { authorization: `Bearer ${token}` } })
	assert(gone.status === 404, 'deleted blob must 404', gone.status)
	const usageAfter = await mcp.call('blobUsage')
	assert(usageAfter.blobBytes === usageBefore.blobBytes - bytes.length, 'byte accounting after delete', {
		before: usageBefore,
		after: usageAfter,
	})
	const usage = await admin.usage(user.id)
	assert(usage.json.counts.blobs === usageAfter.blobs, 'usageGet counts should include blobs', usage.json.counts)
	log('delete/usage', { blobs: usageAfter.blobs, blobBytes: usageAfter.blobBytes })
}
