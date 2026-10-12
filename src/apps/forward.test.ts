import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	appContextHeader,
	buildAppRequest,
	cookieHeaderWithoutKody,
	sanitizeAppResponse,
	searchWithoutHandoff,
} from './forward.ts'

const context = {
	runId: 'app_1',
	packageContext: {
		packageName: 'notes',
		version: '1.0.0',
		hostedUrl: 'https://apps.example/u/user_a/packages/notes',
		appBasePath: '/u/user_a/packages/notes',
		assetBasePath: '/u/user_a/packages/notes/_assets',
	},
}

describe('searchWithoutHandoff', () => {
	it('keeps other params byte-for-byte when no handoff is present', () => {
		assert.equal(searchWithoutHandoff(new URL('https://a.example/x?q=a%20b&z=1')), '?q=a%20b&z=1')
	})
	it('drops the handoff, including an empty one', () => {
		assert.equal(searchWithoutHandoff(new URL('https://a.example/x?tab=2&__kody_handoff=t')), '?tab=2')
		assert.equal(searchWithoutHandoff(new URL('https://a.example/x?__kody_handoff=')), '')
	})
})

describe('cookieHeaderWithoutKody', () => {
	it('strips every Kody cookie and keeps the app’s own', () => {
		assert.equal(
			cookieHeaderWithoutKody(
				'kody_session=s; theme=dark; kody_app_session=a; kody_app_state=st; kody_console=c; cart=1',
			),
			'theme=dark; cart=1',
		)
		assert.equal(cookieHeaderWithoutKody('kody_app_session=a'), null)
		assert.equal(cookieHeaderWithoutKody(null), null)
	})
})

describe('buildAppRequest', () => {
	it('strips the mount, Kody cookies, and x-kody headers, and adds the context header', async () => {
		const incoming = new Request('https://apps.example/u/user_a/packages/notes/list?x=1&__kody_handoff=t', {
			headers: {
				cookie: 'kody_session=s; theme=dark',
				'x-kody-run': 'evil',
				[appContextHeader]: 'evil',
				accept: 'text/html',
			},
		})
		const forwarded = buildAppRequest(incoming, { origin: 'https://apps.example', restPath: '/list', context })
		assert.equal(forwarded.url, 'https://apps.example/list?x=1')
		assert.equal(forwarded.headers.get('cookie'), 'theme=dark')
		assert.equal(forwarded.headers.get('x-kody-run'), null)
		assert.equal(forwarded.headers.get('accept'), 'text/html')
		assert.deepEqual(JSON.parse(forwarded.headers.get(appContextHeader) ?? ''), context)
		assert.equal(forwarded.redirect, 'manual')
	})
	it('forwards POST bodies', async () => {
		const incoming = new Request('https://apps.example/u/user_a/packages/notes/save', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: 'title=hi&n=2',
		})
		const forwarded = buildAppRequest(incoming, { origin: 'https://apps.example', restPath: '/save', context })
		assert.equal(forwarded.method, 'POST')
		assert.equal(forwarded.headers.get('content-type'), 'application/x-www-form-urlencoded')
		assert.equal(await forwarded.text(), 'title=hi&n=2')
	})
})

describe('sanitizeAppResponse', () => {
	it('drops x-kody headers and Kody cookies, keeps Location and app cookies, adds nosniff', async () => {
		const headers = new Headers({
			location: '/u/user_a/packages/notes/login',
			'x-kody-run': 'r',
			'content-type': 'text/plain',
		})
		headers.append('set-cookie', 'kody_app_session=forged; Path=/')
		headers.append('set-cookie', 'kody_session=forged; Path=/')
		headers.append('set-cookie', 'kody_app_state=forged; Path=/')
		headers.append('set-cookie', 'theme=dark; Path=/')
		const clean = sanitizeAppResponse(new Response('body', { status: 302, headers }))
		assert.equal(clean.status, 302)
		assert.equal(clean.headers.get('location'), '/u/user_a/packages/notes/login')
		assert.equal(clean.headers.get('x-kody-run'), null)
		assert.deepEqual(clean.headers.getSetCookie(), ['theme=dark; Path=/'])
		assert.equal(clean.headers.get('x-content-type-options'), 'nosniff')
		assert.equal(await clean.text(), 'body')
	})
	it('passes null-body statuses through', () => {
		assert.equal(sanitizeAppResponse(new Response(null, { status: 204 })).status, 204)
	})
})
