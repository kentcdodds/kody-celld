// Package apps (docs/package-apps.md): /apps/open → handoff → app-origin cookie → app.
// Needs KODY_APP_BASE_URL=http://apps.localhost:<port> (path mode) in .dev.vars.
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { admin, assert, baseUrl, Browser, log, readPackageDir } from './lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Same invite → password flow as smoke/web.mjs, returning a signed-in Browser. */
async function signedInBrowser(userId) {
	const invite = await admin.invite(userId)
	assert(invite.status === 201 && invite.json.url, 'admin invite returns a link', invite)
	const browser = new Browser()
	const password = `smoke-${randomBytes(12).toString('hex')}`
	const accepted = await browser.post(invite.json.url, { password, confirm: password })
	assert(accepted.status === 303 && browser.cookie('kody_session'), 'browser signed in via invite', accepted)
	return browser
}

function viaAppHost(appBase, location) {
	// Node cannot always resolve *.localhost; connect to the Kody listener and send the app Host header.
	const target = new URL(location)
	return { url: `${baseUrl}${target.pathname}${target.search}`, host: target.host }
}

function echoOf(page) {
	const match = /<pre id="echo">(.*?)<\/pre>/s.exec(page.text)
	assert(match, 'app page carries the echo block', page.text.slice(0, 400))
	return JSON.parse(match[1])
}

export async function smokeApps(ctx) {
	const health = await fetch(`${baseUrl}/health`).then((res) => res.json())
	if (!health.apps) {
		log('skipped', 'KODY_APP_BASE_URL unset')
		return
	}
	assert(typeof health.apps === 'string', 'health.apps is the app base URL', health.apps)
	const appHost = new URL(health.apps.replace('*.', '')).host

	const files = await readPackageDir(path.join(here, '..', 'examples', 'packages', 'hello-app'))
	const saved = await ctx.mcp.call('packageSave', { files, source: 'examples/packages/hello-app' })
	assert(
		saved.name === 'hello-app' && saved.manifest.app?.entry === 'app/server.js',
		'hello-app saved as an app',
		saved,
	)

	const links = await ctx.mcp.call('packageAppUrl', { name: 'hello-app' })
	assert(
		links.openUrl === `${baseUrl}/apps/open?package=hello-app`,
		'packageAppUrl.openUrl points at /apps/open',
		links,
	)

	const browser = await signedInBrowser(ctx.user.id)

	// 1. /apps/open (no state) → app URL → app origin sets kody_app_state → /apps/open?state= → handoff
	const open = await browser.get('/apps/open?package=hello-app')
	assert(
		open.status === 302 && !open.location?.includes('__kody_handoff='),
		'/apps/open without state bounces to the app',
		open,
	)
	const bounce = viaAppHost(health.apps, open.location)
	const dance = await browser.get(bounce.url, { headers: { host: bounce.host } })
	assert(dance.status === 302 && browser.cookie('kody_app_state'), 'app origin sets kody_app_state', dance)
	const stateMatch = /[?&]state=([0-9a-f]{32})/.exec(dance.location ?? '')
	assert(
		stateMatch && stateMatch[1] === browser.cookie('kody_app_state'),
		'state in the redirect equals the cookie',
		dance,
	)
	const mint = await browser.get(new URL(dance.location).pathname + new URL(dance.location).search)
	assert(
		mint.status === 302 && mint.location?.includes('__kody_handoff='),
		'/apps/open with state redirects with a handoff',
		mint,
	)
	const handoff = viaAppHost(health.apps, mint.location)

	// 2. handoff → 302 + cookie, handoff removed
	const swap = await browser.get(handoff.url, { headers: { host: handoff.host } })
	assert(swap.status === 302 && browser.cookie('kody_app_session'), 'handoff swapped for kody_app_session', swap)
	assert(!swap.location.includes('__kody_handoff'), 'redirect drops the handoff', swap.location)

	// 3. app renders; no Kody credentials or headers reach it
	const appPath = viaAppHost(health.apps, swap.location)
	const page = await browser.get(appPath.url, { headers: { host: appPath.host } })
	assert(page.status === 200, 'app page 200', page)
	const echo = echoOf(page)
	assert(echo.path === '/', 'handler sees the mount-stripped path', echo)
	assert(!String(echo.cookie ?? '').includes('kody_'), 'no Kody cookie reaches the app', echo)
	assert(echo.kodyHeaders.length === 0, 'no x-kody-* header reaches the app', echo)
	assert(echo.packageContext.appBasePath.endsWith('/packages/hello-app'), 'packageContext.appBasePath', echo)
	assert(echo.packageContext.assetBasePath === `${echo.packageContext.appBasePath}/_assets`, 'assetBasePath', echo)
	assert(!('clientModuleUrl' in echo.packageContext), 'clientModuleUrl is absent', echo)
	assert(page.headers.get('x-content-type-options') === 'nosniff', 'nosniff added', page.headers)

	// 4. POST body arrives; storage persists
	const post = await browser.fetch(appPath.url.replace(/\/?$/, '/save'), {
		method: 'POST',
		form: { note: 'hello from smoke' },
		headers: { host: appPath.host, origin: `http://${appPath.host}` },
	})
	assert(post.status === 303, 'POST handled by the app', post)
	const after = echoOf(await browser.get(appPath.url, { headers: { host: appPath.host } }))
	assert(after.note === 'hello from smoke' && after.visits >= 2, 'packageStorage persisted the form value', after)

	// 5. replayed handoff without a cookie → open-from-Kody page
	const stranger = new Browser()
	const replay = await stranger.get(handoff.url, { headers: { host: handoff.host } })
	assert(
		replay.status === 403 && replay.text.includes('/apps/open?package=hello-app'),
		'replayed handoff in another browser → open-from-Kody page',
		replay,
	)

	// 6. first-party routes do not exist on the app host
	for (const route of ['/mcp', '/api/packages', '/account', '/admin/users']) {
		const res = await browser.get(`${baseUrl}${route}`, { headers: { host: appHost } })
		assert(res.status === 404, `${route} is 404 on the app host`, res.status)
	}

	// 7. signing out of Kody ends app access
	await browser.post('/signout', {})
	const gone = await browser.get(appPath.url, { headers: { host: appPath.host } })
	assert(
		gone.status === 302 && gone.location?.includes('/apps/open?package=hello-app&state='),
		'after sign-out a GET restarts the open flow instead of serving the app',
		gone,
	)
	const retry = await browser.get(new URL(gone.location).pathname + new URL(gone.location).search)
	assert(!retry.location?.includes('__kody_handoff='), 'signed-out /apps/open mints no handoff', retry)
	const goneForm = await browser.fetch(appPath.url.replace(/\/?$/, '/save'), {
		method: 'POST',
		form: { note: 'after sign-out' },
		headers: { host: appPath.host, origin: `http://${appPath.host}` },
	})
	assert(goneForm.status === 403, 'after sign-out a POST gets the open-from-Kody page', goneForm.status)
	log('apps', 'handoff, session, isolation, storage, sign-out ok')
}
