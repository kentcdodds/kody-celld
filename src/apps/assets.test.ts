import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isAssetPath, serveAppAsset } from './assets.ts'

const files = {
	'public/styles.css': 'body{}',
	'public/img/logo.svg': '<svg/>',
	'public/data.bin': 'x',
	'secret.ts': 'nope',
}
const get = (restPath: string, init: RequestInit = {}) =>
	serveAppAsset({
		request: new Request(`https://a.example${restPath}`, init),
		restPath,
		files,
		assetsDir: 'public',
	})

describe('isAssetPath', () => {
	it('matches /_assets and below only', () => {
		assert.equal(isAssetPath('/_assets/x.css'), true)
		assert.equal(isAssetPath('/_assets'), true)
		assert.equal(isAssetPath('/_assetsx'), false)
		assert.equal(isAssetPath('/x/_assets/y'), false)
	})
})

describe('serveAppAsset', () => {
	it('serves a file with type, etag and cache headers', async () => {
		const res = await get('/_assets/styles.css')
		assert.equal(res.status, 200)
		assert.equal(res.headers.get('content-type'), 'text/css; charset=utf-8')
		assert.equal(res.headers.get('cache-control'), 'private, max-age=300')
		assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
		assert.match(res.headers.get('etag') ?? '', /^"[0-9a-f]{64}"$/)
		assert.equal(await res.text(), 'body{}')
	})
	it('answers 304 for a matching If-None-Match', async () => {
		const etag = (await get('/_assets/styles.css')).headers.get('etag') ?? ''
		const res = await get('/_assets/styles.css', { headers: { 'if-none-match': etag } })
		assert.equal(res.status, 304)
	})
	it('honours If-None-Match lists, weak validators and *', async () => {
		const etag = (await get('/_assets/styles.css')).headers.get('etag') ?? ''
		for (const header of [`"other", ${etag}`, `W/${etag}`, ` W/${etag} , "x"`, '*']) {
			const res = await get('/_assets/styles.css', { headers: { 'if-none-match': header } })
			assert.equal(res.status, 304, header)
		}
		const miss = await get('/_assets/styles.css', { headers: { 'if-none-match': '"nope", W/"also-no"' } })
		assert.equal(miss.status, 200)
	})
	it('serves nested files and HEAD without a body', async () => {
		assert.equal((await get('/_assets/img/logo.svg')).headers.get('content-type'), 'image/svg+xml')
		const head = await get('/_assets/styles.css', { method: 'HEAD' })
		assert.equal(head.status, 200)
		assert.equal(await head.text(), '')
	})
	it('falls back to text/plain for unknown extensions', async () => {
		assert.equal((await get('/_assets/data.bin')).headers.get('content-type'), 'text/plain; charset=utf-8')
	})
	it('refuses escapes, missing files, __version.json, other methods, and apps without assets', async () => {
		for (const path of [
			'/_assets/../secret.ts',
			'/_assets/%2e%2e/secret.ts',
			'/_assets/%00secret.ts',
			'/_assets/nope.css',
			'/_assets/',
			'/_assets/__version.json',
		]) {
			assert.equal((await get(path)).status, 404, path)
		}
		assert.equal((await get('/_assets/styles.css', { method: 'POST', body: 'x' })).status, 405)
		const none = await serveAppAsset({
			request: new Request('https://a.example/_assets/styles.css'),
			restPath: '/_assets/styles.css',
			files,
			assetsDir: null,
		})
		assert.equal(none.status, 404)
	})
})
