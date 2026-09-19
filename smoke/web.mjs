// M7 web UI smoke: admin invite link -> set password (one-time link is
// consumed), password sign-in with lockout, sliding browser sessions, CSRF and
// Origin enforcement on every state-changing form, safe `next` redirects, the
// account pages (tokens, secrets, sessions, clients) and the operator console.
// No credential is ever printed; the smoke only asserts on status codes,
// redirect targets, and page text.
import { randomBytes } from 'node:crypto'
import { admin, adminToken, assert, baseUrl, Browser, hiddenInputs, log } from './lib.mjs'

function randomPassword() {
	return `pw-${randomBytes(12).toString('hex')}`
}

export async function smokeWeb({ user, mcp }) {
	// Unauthenticated surfaces.
	const anon = new Browser()
	const root = await anon.get('/')
	assert(root.status === 303 && root.location?.endsWith('/signin'), 'browser GET / redirects to /signin', root)
	const gate = await anon.get('/account/secrets')
	assert(
		gate.status === 303 && gate.location?.includes('next=%2Faccount%2Fsecrets'),
		'account pages require sign-in',
		gate,
	)
	const signinPage = await anon.get('/signin')
	assert(
		signinPage.status === 200 && signinPage.text.includes('name="password"'),
		'sign-in page renders',
		signinPage.status,
	)
	assert(
		!signinPage.text.includes('Email me a link') || signinPage.text.includes('name="method" value="magic"'),
		'magic form only when outbound email exists',
	)
	log('anonymous', 'sign-in page reachable, account pages gated')

	// Invite link from the admin API (same thing the console renders).
	const invite = await admin.invite(user.id)
	assert(
		invite.status === 201 && invite.json.url?.startsWith(`${baseUrl}/signin/link/`),
		'admin invite returns a link',
		invite,
	)
	const browser = new Browser()
	const invitePage = await browser.get(invite.json.url)
	assert(
		invitePage.status === 200 && invitePage.text.includes('Set a password for'),
		'invite link shows password form',
		invitePage.status,
	)

	const password = randomPassword()
	const tooShort = await browser.post(invite.json.url, { password: 'short', confirm: 'short' })
	assert(
		tooShort.status === 400 && tooShort.text.includes('at least'),
		'short password rejected before the link is consumed',
		tooShort.status,
	)
	const accepted = await browser.post(invite.json.url, { password, confirm: password })
	assert(accepted.status === 303 && accepted.location?.endsWith('/account'), 'invite accepted -> /account', accepted)
	assert(browser.cookie('kody_session'), 'session cookie set after invite')
	const reused = await anon.get(invite.json.url)
	assert(reused.status === 410, 'invite link is single-use', reused.status)
	log('invite', 'one-time link set a password and signed in')

	// Account overview + CSRF token.
	const overview = await browser.get('/account')
	assert(
		overview.status === 200 && overview.text.includes(user.email),
		'account overview renders for the signed-in user',
	)
	assert(overview.text.includes('password set'), 'overview shows password badge')
	const csrf = hiddenInputs(overview.text).csrf
	assert(csrf && csrf.length >= 32, 'overview carries a CSRF token')

	// CSRF: missing token and cross-origin submissions are refused.
	const noCsrf = await browser.post('/account/tokens', { action: 'create', label: 'nope' })
	assert(noCsrf.status === 403, 'form without csrf token is refused', noCsrf.status)
	const crossOrigin = await browser.post(
		'/account/tokens',
		{ action: 'create', label: 'nope', csrf },
		{ headers: { origin: 'https://evil.example' } },
	)
	assert(crossOrigin.status === 403, 'cross-origin form is refused', crossOrigin.status)
	const crossSite = await browser.post(
		'/account/tokens',
		{ action: 'create', label: 'nope', csrf },
		{ headers: { 'sec-fetch-site': 'cross-site' } },
	)
	assert(crossSite.status === 403, 'sec-fetch-site: cross-site form is refused', crossSite.status)
	log('csrf', 'missing token, cross-origin and cross-site posts all 403')

	// API tokens: create (value shown once) then revoke; token works on /mcp until revoked.
	const created = await browser.post('/account/tokens', { action: 'create', label: 'smoke-web', csrf })
	assert(created.status === 200 && created.text.includes('smoke-web'), 'token created page shows label', created.status)
	const shownToken = /<pre class="secret[^"]*"[^>]*>([^<]+)<\/pre>/.exec(created.text)?.[1]
	assert(shownToken?.startsWith('kc_'), 'token value shown once')
	const probe = await fetch(`${baseUrl}/mcp`, {
		method: 'POST',
		headers: { authorization: `Bearer ${shownToken}`, 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
	})
	assert(probe.status === 200, 'new token authenticates /mcp', probe.status)
	const tokensPage = await browser.get('/account/tokens')
	assert(!tokensPage.text.includes(shownToken), 'token list never repeats the value')
	const tokenId = [...tokensPage.text.matchAll(/name="tokenId" value="([^"]+)"/g)].map((m) => m[1]).find(Boolean)
	assert(tokenId, 'token list exposes short ids for revocation')
	const listed = await mcp.call('apiTokenList')
	assert(
		listed.tokens.some((t) => t.id === tokenId && t.label === 'smoke-web'),
		'apiTokenList sees the web-created token',
		listed,
	)
	const revoke = await browser.post('/account/tokens', { action: 'revoke', tokenId, csrf })
	assert(revoke.status === 303, 'token revoked', revoke)
	const afterRevoke = await fetch(`${baseUrl}/mcp`, {
		method: 'POST',
		headers: { authorization: `Bearer ${shownToken}`, 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
	})
	assert(afterRevoke.status === 401, 'revoked token is refused', afterRevoke.status)
	log('tokens', 'create, use, list (no value), revoke')

	// Secrets via the UI: saved value is never echoed; list shows the name.
	const secretName = `web-secret-${randomBytes(3).toString('hex')}`
	const secretValue = `sv-${randomBytes(16).toString('hex')}`
	const saved = await browser.post('/account/secrets', { action: 'save', name: secretName, value: secretValue, csrf })
	assert(saved.status === 303, 'secret saved from the form', saved)
	const secretsPage = await browser.get('/account/secrets')
	assert(secretsPage.text.includes(secretName) && !secretsPage.text.includes(secretValue), 'secret listed by name only')
	const deleted = await browser.post('/account/secrets', { action: 'delete', name: secretName, csrf })
	assert(deleted.status === 303, 'secret deleted from the form', deleted)
	log('secrets', 'save/list/delete through the form; value never echoed')

	// Other read-only pages render.
	for (const path of [
		'/account/packages',
		'/account/jobs',
		'/account/runs',
		'/account/integrations',
		'/account/inbox',
		'/account/clients',
		'/account/sessions',
	]) {
		const res = await browser.get(path)
		assert(res.status === 200, `${path} renders`, res.status)
	}
	log('pages', 'packages, jobs, runs, integrations, inbox, clients, sessions render')

	// Packages page: install form enforces the source-host policy; publish /
	// unpublish toggles a community listing for a saved package.
	const refused = await browser.post('/account/packages', {
		action: 'install',
		source: 'https://10.0.0.7/pkg.tgz',
		csrf,
	})
	assert(
		refused.status === 200 && refused.text.includes('private host'),
		'install form surfaces the refusal',
		refused.status,
	)
	const pkgName = `@kody-smoke/web-${randomBytes(3).toString('hex')}`
	await mcp.call('packageSave', {
		files: {
			'package.json': JSON.stringify({
				name: pkgName,
				version: '1.0.0',
				description: 'web smoke',
				exports: './main.js',
			}),
			'README.md': `# ${pkgName}`,
			'AGENTS.md': 'Returns ok.',
			'main.js': 'export default async () => "ok"',
		},
		source: 'smoke/web.mjs',
	})
	const published = await browser.post('/account/packages', { action: 'publish', name: pkgName, csrf })
	assert(
		published.status === 303 && published.location?.includes('flash=published'),
		'publish from the form',
		published,
	)
	const publicPage = await fetch(`${baseUrl}/community/${encodeURIComponent(pkgName)}`)
	assert(publicPage.status === 200, 'published package has a public page', publicPage.status)
	const packagesPage = await browser.get('/account/packages')
	assert(
		packagesPage.text.includes('Unpublish') && packagesPage.text.includes(`/community/${encodeURIComponent(pkgName)}`),
		'packages page links the listing',
	)
	const unpublished = await browser.post('/account/packages', { action: 'unpublish', name: pkgName, csrf })
	assert(
		unpublished.status === 303 && unpublished.location?.includes('flash=unpublished'),
		'unpublish from the form',
		unpublished,
	)
	assert(
		(await fetch(`${baseUrl}/community/${encodeURIComponent(pkgName)}`)).status === 404,
		'listing gone after unpublish',
	)
	log('packages form', 'install refusal shown; publish/unpublish toggle the public listing')

	// Password sign-in on a second browser, wrong password, lockout after 5 failures.
	const second = new Browser()
	const wrong = await second.post('/signin', {
		method: 'password',
		email: user.email,
		password: 'definitely-not-it-12345',
	})
	assert(
		wrong.status === 401 && wrong.text.includes('Wrong email or password'),
		'wrong password rejected',
		wrong.status,
	)
	const right = await second.post('/signin', {
		method: 'password',
		email: user.email,
		password,
		next: '/account/sessions',
	})
	assert(right.status === 303 && right.location?.endsWith('/account/sessions'), 'password sign-in honours next', right)
	const openRedirect = await new Browser().post('/signin', {
		method: 'password',
		email: user.email,
		password,
		next: 'https://evil.example/',
	})
	assert(openRedirect.location?.endsWith('/account'), 'external next is ignored', openRedirect.location)
	const protoRelative = await new Browser().post('/signin', {
		method: 'password',
		email: user.email,
		password,
		next: '//evil.example/',
	})
	assert(protoRelative.location?.endsWith('/account'), 'protocol-relative next is ignored', protoRelative.location)
	const sessionsPage = await second.get('/account/sessions')
	const sessionCount = (sessionsPage.text.match(/name="sessionId"/g) ?? []).length
	assert(sessionCount >= 3, 'sessions page lists every signed-in browser', sessionCount)
	log('password', 'sign-in works, wrong password refused, next sanitised')

	// Token sign-in (existing API token) also works.
	const viaToken = await new Browser().post('/signin', { method: 'token', token: mcp.token })
	assert(viaToken.status === 303 && viaToken.location?.endsWith('/account'), 'API token sign-in works', viaToken)

	// Revoke other sessions from the first browser: the second browser is signed out.
	const csrf1 = hiddenInputs((await browser.get('/account/sessions')).text).csrf
	const revokeOthers = await browser.post('/account/sessions', { action: 'revoke_others', csrf: csrf1 })
	assert(revokeOthers.status === 303, 'revoke other sessions', revokeOthers)
	const secondAfter = await second.get('/account')
	assert(
		secondAfter.status === 303 && secondAfter.location?.includes('/signin'),
		'other browser is signed out',
		secondAfter,
	)
	const firstAfter = await browser.get('/account')
	assert(firstAfter.status === 200, 'current browser stays signed in', firstAfter.status)
	log('sessions', 'revoke-others signs out the other browser only')

	// Password change requires the current password.
	const changeBad = await browser.post('/account/password', {
		current: 'nope-nope-nope-nope',
		password: randomPassword(),
		confirm: 'mismatch',
		csrf: csrf1,
	})
	assert(changeBad.status === 403, 'password change needs the current password', changeBad.status)
	const mismatch = await browser.post('/account/password', {
		current: password,
		password: randomPassword(),
		confirm: 'mismatch',
		csrf: csrf1,
	})
	assert(mismatch.status === 400, 'password change needs matching confirmation', mismatch.status)
	log('password', 'change requires the current password and a matching confirmation')

	// Lockout: 5 wrong passwords lock the account even for the right password.
	const locker = new Browser()
	for (let i = 0; i < 5; i += 1) {
		await locker.post('/signin', { method: 'password', email: user.email, password: `wrong-${i}-xxxxxxxxxxxx` })
	}
	const locked = await locker.post('/signin', { method: 'password', email: user.email, password })
	assert(locked.status === 429, 'account locked after 5 failures (right password refused with 429)', locked.status)
	log('lockout', '5 failures lock password sign-in for 15 minutes')

	// Sign out clears the cookie.
	const signout = await browser.post('/signout', {})
	assert(signout.status === 303 && !browser.cookie('kody_session'), 'sign-out clears the session cookie', signout)
	const afterSignout = await browser.get('/account')
	assert(afterSignout.status === 303, 'signed-out browser is redirected', afterSignout.status)
	log('signout', 'cookie cleared')

	// Operator console: admin token sign-in, users list, per-user host approval, audit, config.
	const operator = new Browser()
	const consoleGate = await operator.get('/console')
	assert(consoleGate.status === 200 && consoleGate.text.includes('Admin token'), 'console asks for the admin token')
	const badAdmin = await operator.post('/console/signin', { token: 'not-the-admin-token' })
	assert(badAdmin.status === 401, 'wrong admin token refused', badAdmin.status)
	const goodAdmin = await operator.post('/console/signin', { token: adminToken })
	assert(goodAdmin.status === 303 && operator.cookie('kody_console'), 'admin console signed in', goodAdmin)
	const users = await operator.get('/console')
	assert(users.status === 200 && users.text.includes(user.email), 'console lists users')
	const consoleCsrf = hiddenInputs(users.text).csrf
	const userPage = await operator.get(`/console/users/${encodeURIComponent(user.id)}`)
	assert(userPage.status === 200 && userPage.text.includes('Approved secret hosts'), 'console user page renders')
	const host = `smoke-${randomBytes(2).toString('hex')}.example.test`
	const approve = await operator.post(`/console/users/${encodeURIComponent(user.id)}`, {
		action: 'approve_host',
		host,
		csrf: consoleCsrf,
	})
	assert(approve.status === 303, 'host approved from the console', approve)
	const hosts = await admin.listHosts(user.id)
	assert(
		hosts.json.hosts.some((h) => h.host === host),
		'approved host visible via admin API',
		hosts.json,
	)
	const revokeHost = await operator.post(`/console/users/${encodeURIComponent(user.id)}`, {
		action: 'revoke_host',
		host,
		csrf: consoleCsrf,
	})
	assert(revokeHost.status === 303, 'host revoked from the console', revokeHost)
	const auditPage = await operator.get('/console/audit?action=secret_host')
	assert(
		auditPage.status === 200 && auditPage.text.includes('secret_host.approve'),
		'console audit page shows host approvals',
	)
	const configPage = await operator.get('/console/config')
	assert(
		configPage.status === 200 && configPage.text.includes('kody-celld') && !configPage.text.includes(adminToken),
		'config page renders without secrets',
	)
	const inviteFromConsole = await operator.post('/console', { action: 'invite', userId: user.id, csrf: consoleCsrf })
	assert(
		inviteFromConsole.status === 200 && inviteFromConsole.text.includes('/signin/link/'),
		'console issues sign-in links',
	)
	const consoleOut = await operator.post('/console/signout', { csrf: consoleCsrf })
	assert(consoleOut.status === 303 && !operator.cookie('kody_console'), 'console sign-out clears cookie')
	log('console', 'admin sign-in, users, host approve/revoke, audit, config, invite')

	// The user's own UI must not offer host approval (admin-only invariant).
	const userSecrets = await new Browser()
	await userSecrets.post('/signin', { method: 'token', token: mcp.token })
	const secretsHtml = (await userSecrets.get('/account/secrets')).text
	assert(!/name="action" value="approve_host"/.test(secretsHtml), 'account UI has no host-approval form')
	const forgedApprove = await userSecrets.post('/account/secrets', {
		action: 'approve_host',
		host: 'evil.example',
		csrf: hiddenInputs(secretsHtml).csrf,
	})
	assert(
		forgedApprove.status !== 200 || !(await admin.listHosts(user.id)).json.hosts.some((h) => h.host === 'evil.example'),
		'user cannot approve hosts',
	)
	log('invariant', 'host approval stays admin-only')
}
