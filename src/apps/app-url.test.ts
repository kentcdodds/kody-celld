import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { appMountPath, appOrigin, appUrl, isAppOriginHost, matchAppRequest, readAppConfig } from './app-url.ts'

const publicUrl = 'https://kody.example.com'
const uid = 'user_0123456789abcdef0123456789abcdef'
const label = 'user-0123456789abcdef0123456789abcdef'

function config(value: string) {
	const result = readAppConfig({ KODY_APP_BASE_URL: value, KODY_PUBLIC_URL: publicUrl })
	assert.ok(result && result.ok, JSON.stringify(result))
	return result.config
}

describe('readAppConfig', () => {
	it('is disabled when unset or blank', () => {
		assert.equal(readAppConfig({ KODY_PUBLIC_URL: publicUrl }), null)
		assert.equal(readAppConfig({ KODY_APP_BASE_URL: '  ', KODY_PUBLIC_URL: publicUrl }), null)
	})
	it('parses path mode with a tolerated trailing slash', () => {
		const result = readAppConfig({ KODY_APP_BASE_URL: 'https://apps.example.com/', KODY_PUBLIC_URL: publicUrl })
		assert.deepEqual(result, {
			ok: true,
			config: { mode: 'path', protocol: 'https:', hostname: 'apps.example.com', port: '' },
			baseUrl: 'https://apps.example.com',
		})
	})
	it('parses subdomain mode with a port', () => {
		const result = readAppConfig({
			KODY_APP_BASE_URL: 'http://*.apps.localhost:8787',
			KODY_PUBLIC_URL: 'http://127.0.0.1:8787',
		})
		assert.deepEqual(result, {
			ok: true,
			config: { mode: 'subdomain', protocol: 'http:', hostname: 'apps.localhost', port: ':8787' },
			baseUrl: 'http://*.apps.localhost:8787',
		})
	})
	it('rejects the Kody host, even on another port', () => {
		const result = readAppConfig({ KODY_APP_BASE_URL: 'https://kody.example.com:8443', KODY_PUBLIC_URL: publicUrl })
		assert.equal(result?.ok, false)
	})
	it('rejects a wildcard that covers the Kody host', () => {
		const result = readAppConfig({ KODY_APP_BASE_URL: 'https://*.example.com', KODY_PUBLIC_URL: publicUrl })
		assert.equal(result?.ok, false)
	})
	it('rejects paths, queries, other schemes and garbage', () => {
		for (const value of [
			'https://apps.example.com/x',
			'https://apps.example.com?a=1',
			'ftp://apps.example.com',
			'not a url',
		]) {
			assert.equal(readAppConfig({ KODY_APP_BASE_URL: value, KODY_PUBLIC_URL: publicUrl })?.ok, false, value)
		}
	})
})

describe('app URLs', () => {
	it('builds path-mode URLs', () => {
		const c = config('https://apps.example.com')
		assert.equal(appOrigin(c, uid), 'https://apps.example.com')
		assert.equal(appMountPath(c, uid, '@scope/notes'), `/u/${uid}/packages/@scope/notes`)
		assert.equal(appUrl(c, uid, 'notes'), `https://apps.example.com/u/${uid}/packages/notes`)
	})
	it('builds subdomain-mode URLs and refuses unmappable ids', () => {
		const c = config('https://*.apps.example.com')
		assert.equal(appUrl(c, uid, 'notes'), `https://${label}.apps.example.com/packages/notes`)
		assert.equal(appOrigin(c, 'admin'), null)
		assert.equal(appUrl(c, 'admin', 'notes'), null)
	})
})

describe('isAppOriginHost', () => {
	it('matches by hostname only', () => {
		const path = config('https://apps.example.com')
		assert.equal(isAppOriginHost(path, new URL('http://apps.example.com:8080/x')), true)
		assert.equal(isAppOriginHost(path, new URL('https://kody.example.com/')), false)
		const sub = config('https://*.apps.example.com')
		assert.equal(isAppOriginHost(sub, new URL(`https://${label}.apps.example.com/`)), true)
		assert.equal(isAppOriginHost(sub, new URL('https://apps.example.com/')), true)
		assert.equal(isAppOriginHost(sub, new URL('https://evilapps.example.com/')), false)
	})
})

describe('matchAppRequest (path mode)', () => {
	const c = config('https://apps.example.com')
	const at = (path: string) => matchAppRequest(c, new URL(`https://apps.example.com${path}`))
	it('ignores other hosts', () => {
		assert.equal(matchAppRequest(c, new URL('https://kody.example.com/u/x/packages/y')), null)
	})
	it('maps the mount root with and without a trailing slash', () => {
		const expected = {
			kind: 'app',
			userId: uid,
			packageName: 'notes',
			origin: 'https://apps.example.com',
			mountPath: `/u/${uid}/packages/notes`,
			restPath: '/',
		}
		assert.deepEqual(at(`/u/${uid}/packages/notes`), expected)
		assert.deepEqual(at(`/u/${uid}/packages/notes/`), expected)
	})
	it('builds the origin from the configured protocol, not the request protocol', () => {
		const match = matchAppRequest(c, new URL(`http://apps.example.com/u/${uid}/packages/notes/`))
		assert.equal(match?.kind === 'app' && match.origin, 'https://apps.example.com')
	})
	it('keeps the rest path and handles scoped names', () => {
		const match = at(`/u/${uid}/packages/@scope/notes/a/b.css`)
		assert.equal(match?.kind, 'app')
		assert.equal(match?.kind === 'app' && match.packageName, '@scope/notes')
		assert.equal(match?.kind === 'app' && match.restPath, '/a/b.css')
	})
	it('does not confuse a longer name with a prefix', () => {
		const match = at(`/u/${uid}/packages/notesx/`)
		assert.equal(match?.kind === 'app' && match.packageName, 'notesx')
	})
	it('returns root and not-found', () => {
		assert.deepEqual(at('/'), { kind: 'root' })
		for (const path of [
			'/mcp',
			'/api/x',
			`/u/${uid}`,
			`/u/${uid}/packages/`,
			`/u/${uid}/packages/@scope`,
			`/u/${uid}/packages/%40scope/x`,
			'/u/a b/packages/x',
		]) {
			assert.deepEqual(at(path), { kind: 'not-found' }, path)
		}
	})
})

describe('matchAppRequest (subdomain mode)', () => {
	const c = config('https://*.apps.example.com')
	it('maps a user subdomain', () => {
		const match = matchAppRequest(c, new URL(`https://${label}.apps.example.com/packages/notes/x?y=1`))
		assert.deepEqual(match, {
			kind: 'app',
			userId: uid,
			packageName: 'notes',
			origin: `https://${label}.apps.example.com`,
			mountPath: '/packages/notes',
			restPath: '/x',
		})
	})
	it('treats apex and user roots as root, everything else as not-found', () => {
		assert.deepEqual(matchAppRequest(c, new URL('https://apps.example.com/')), { kind: 'root' })
		assert.deepEqual(matchAppRequest(c, new URL(`https://${label}.apps.example.com/`)), { kind: 'root' })
		assert.deepEqual(matchAppRequest(c, new URL('https://apps.example.com/packages/notes')), { kind: 'not-found' })
		assert.deepEqual(matchAppRequest(c, new URL('https://bob.apps.example.com/packages/notes')), { kind: 'not-found' })
		assert.deepEqual(matchAppRequest(c, new URL(`https://${label}.apps.example.com/mcp`)), { kind: 'not-found' })
	})
})
