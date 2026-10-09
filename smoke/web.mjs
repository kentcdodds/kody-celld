// M7 web UI smoke: admin invite link -> set password (one-time link is
// consumed), password sign-in with lockout, sliding browser sessions, CSRF and
// Origin enforcement on every state-changing form, safe `next` redirects, the
// account pages (tokens, secrets, sessions, clients) and the operator console.
// No credential is ever printed; the smoke only asserts on status codes,
// redirect targets, and page text.
import { randomBytes } from 'node:crypto'
import { admin, adminToken, assert, baseUrl, Browser, hiddenInputs, log } from './lib.mjs'
import { startPackageFixtureServer } from './package-fixture-server.mjs'

function randomPassword() {
	return `pw-${randomBytes(12).toString('hex')}`
}

function assertUniqueIds(html, path) {
	const tags = html.match(/<[a-z][^>]*>/gi) ?? []
	const ids = tags.flatMap((tag) => {
		const id = /\bid="([^"]*)"/.exec(tag)?.[1]
		return id === undefined ? [] : [id]
	})
	const counts = new Map()
	for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
	const duplicates = [...counts].filter(([, count]) => count !== 1).map(([id]) => id)
	assert(duplicates.length === 0, `${path} has unique IDs`, duplicates)

	const labels = tags.flatMap((tag) => {
		if (!/^<label\b/i.test(tag)) return []
		const target = /\bfor="([^"]*)"/.exec(tag)?.[1]
		return target === undefined ? [] : [target]
	})
	const unmatched = labels.filter((target) => counts.get(target) !== 1)
	assert(unmatched.length === 0, `${path} label targets match exactly one ID`, unmatched)
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
	assertUniqueIds(signinPage.text, '/signin')
	assert(
		!signinPage.text.includes('Email me a link') || signinPage.text.includes('name="intent" value="magic"'),
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
	assertUniqueIds(overview.text, '/account')
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

	// Memories list/search/detail/delete through the server-rendered account page.
	const hex = randomBytes(4).toString('hex')
	const memorySubject = `web-memory-${hex}`
	const createdMemory = await mcp.call('metaMemoryUpsert', {
		subject: memorySubject,
		summary: 'Seeded by smoke/web.mjs',
		tags: ['smoke-web'],
	})
	const memoryId = createdMemory.memory.id
	const memoriesPage = await browser.get('/account/memories')
	assert(
		memoriesPage.status === 200 && memoriesPage.text.includes(memorySubject),
		'memories page lists a created memory',
		memoriesPage.status,
	)
	const matchingSearch = await browser.get(`/account/memories?q=${encodeURIComponent(memorySubject)}`)
	assert(matchingSearch.text.includes(memorySubject), 'memory search finds a matching subject')
	const nonmatchingSearch = await browser.get(`/account/memories?q=${encodeURIComponent(`zz-no-match-${hex}`)}`)
	assert(!nonmatchingSearch.text.includes(memorySubject), 'memory search excludes a nonmatch')
	const memoryDetail = await browser.get(`/account/memories/${encodeURIComponent(memoryId)}`)
	assert(
		memoryDetail.status === 200 &&
			memoryDetail.text.includes('Seeded by smoke/web.mjs') &&
			memoryDetail.text.includes(`name="memoryId" value="${memoryId}"`),
		'memory detail shows summary and delete form id',
		memoryDetail.status,
	)
	const missingMemory = await browser.get(`/account/memories/${encodeURIComponent(`missing-${hex}`)}`)
	assert(
		missingMemory.status === 404 && missingMemory.text.includes('Memory not found'),
		'unknown memory detail renders a not-found page',
		missingMemory.status,
	)
	const memoryNoCsrf = await browser.post('/account/memories', {
		action: 'delete',
		memoryId,
	})
	assert(memoryNoCsrf.status === 403, 'memory delete without CSRF is refused')
	const softDelete = await browser.post('/account/memories', {
		action: 'delete',
		memoryId,
		csrf,
	})
	assert(
		softDelete.status === 303 && softDelete.location?.includes('flash=deleted'),
		'memory soft delete redirects with a flash',
		softDelete,
	)
	const activeList = await browser.get('/account/memories')
	assert(!activeList.text.includes(memorySubject), 'soft-deleted memory is hidden by default')
	const deletedList = await browser.get('/account/memories?includeDeleted=1')
	assert(deletedList.text.includes(memorySubject), 'include-deleted list shows soft-deleted memory')
	const softDeletedMemory = await mcp.call('metaMemoryGet', { id: memoryId })
	assert(softDeletedMemory.memory?.status === 'deleted', 'soft delete updates memory status')
	const permanentDelete = await browser.post('/account/memories', {
		action: 'delete',
		memoryId,
		force: 'true',
		csrf,
	})
	assert(permanentDelete.status === 303, 'permanent memory delete redirects', permanentDelete)
	const permanentlyDeletedMemory = await mcp.call('metaMemoryGet', { id: memoryId })
	assert(permanentlyDeletedMemory.memory === null, 'permanent delete removes memory')
	log('memories', 'list/search/detail, unknown id, CSRF, soft delete and permanent delete')

	// The index exposes webhook metadata but never the ingress URL or secret.
	const webhookPackageName = `@kody-smoke/web-hooks-${hex}`
	await mcp.call('packageSave', {
		files: {
			'package.json': JSON.stringify({
				name: webhookPackageName,
				version: '1.0.0',
				exports: { '.': './main.js', './hook': './hook.js' },
				kody: {
					webhooks: [
						{
							name: 'inbound',
							export: './hook',
							responseMode: 'sync',
							inputMode: 'params',
						},
					],
				},
			}),
			'README.md': `# ${webhookPackageName}`,
			'AGENTS.md': 'Handles the inbound smoke webhook.',
			'main.js': 'export default async () => "ok"',
			'hook.js': 'export default async (params) => ({ received: params })',
		},
		source: 'smoke/web.mjs',
	})
	const mintedWebhook = await mcp.callDirect('webhookUrlMint', {
		packageName: webhookPackageName,
		webhookName: 'inbound',
	})
	const revealResponse = await fetch(`${baseUrl}/api/webhooks/${encodeURIComponent(mintedWebhook.handle)}/url`, {
		headers: { authorization: `Bearer ${mcp.token}` },
	})
	const revealPayload = await revealResponse.json()
	assert(
		revealResponse.status === 200 && typeof revealPayload.url === 'string',
		'authenticated webhook URL reveal succeeds',
		revealResponse.status,
	)
	const webhookUrl = revealPayload.url
	const webhookSecret = webhookUrl.split('/').at(-1)
	const deliveryResponse = await fetch(webhookUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: '{}',
	})
	assert(deliveryResponse.status === 200, 'smoke webhook creates one delivery')
	const webhooksPage = await browser.get('/account/webhooks')
	const expectedPackageHref = `/account/packages/${encodeURIComponent(webhookPackageName)}`
	assert(
		webhooksPage.status === 200 &&
			webhooksPage.text.includes(webhookPackageName) &&
			webhooksPage.text.includes('inbound') &&
			webhooksPage.text.includes(mintedWebhook.handle) &&
			webhooksPage.text.includes(expectedPackageHref),
		'webhooks index lists package, declaration, handle and package link',
		webhooksPage.status,
	)
	assert(
		!webhooksPage.text.includes(webhookSecret) &&
			!webhooksPage.text.includes(`/webhooks/${user.id}/${mintedWebhook.handle}/`) &&
			!webhooksPage.text.includes(webhookUrl),
		'webhooks index never renders the ingress URL or secret',
	)
	await mcp.call('packageDelete', { name: webhookPackageName })
	log('webhooks', 'declaration, minted handle, delivery, package link, no URL secret')

	// Other read-only pages render.
	for (const path of [
		'/account/packages',
		'/account/jobs',
		'/account/runs',
		'/account/memories',
		'/account/webhooks',
		'/account/integrations',
		'/account/inbox',
		'/account/clients',
		'/account/sessions',
	]) {
		const res = await browser.get(path)
		assert(res.status === 200, `${path} renders`, res.status)
	}
	log('pages', 'packages, jobs, activity, memories, webhooks, integrations, email, clients, sessions render')

	// Activity triage: summary line, Open errors view, Ignore POST, Recent runs badge.
	const triageFail = await mcp.execute(
		`export default async function main() { console.log('web triage smoke log line'); throw new Error('web triage smoke') }`,
	)
	assert(!triageFail.ok && triageFail.runId, 'a failing execute records an error run for the Activity page', triageFail)
	const errorsView = await browser.get('/account/runs?view=errors')
	assert(
		errorsView.status === 200 &&
			/\d+ open errors? · \d+ ignored · \d+ resolved · \d+ running/.test(errorsView.text) &&
			errorsView.text.includes(`name="runId" value="${triageFail.runId}"`) &&
			errorsView.text.includes('name="triage" value="ignored"'),
		'Activity open-errors view shows the summary and an Ignore form for the failing run',
		errorsView.status,
	)
	const runDetail = await browser.get(`/account/runs/${triageFail.runId}?view=errors`)
	assert(
		errorsView.text.includes(`href="/account/runs/${triageFail.runId}?view=errors"`) &&
			runDetail.status === 200 &&
			runDetail.text.includes('data-testid="run-detail"') &&
			runDetail.text.includes('web triage smoke log line') &&
			runDetail.text.includes(`Kody run ${triageFail.runId} failed (ad hoc execute): Error: web triage smoke.`) &&
			runDetail.text.includes('Look at my open Kody activity errors.'),
		'an error row links to its expanded run with logs and a fix prompt',
		runDetail.status,
	)
	assert(
		runDetail.text.includes('href="/account/runs?view=errors"') &&
			!runDetail.text.includes(`href="/account/runs/${triageFail.runId}?view=errors"`),
		'the expanded row links back to the list, so clicking it again closes the run',
	)
	const missingRun = await browser.get('/account/runs/run_does_not_exist')
	assert(
		missingRun.status === 200 && missingRun.text.includes('Run not found'),
		'an unknown run id shows Run not found inline',
		missingRun.status,
	)
	const noCsrfTriage = await browser.post('/account/runs', {
		action: 'triage',
		runId: triageFail.runId,
		triage: 'ignored',
	})
	assert(noCsrfTriage.status === 403, 'Activity triage POST needs the csrf token', noCsrfTriage.status)
	const ignoredPost = await browser.post('/account/runs', {
		action: 'triage',
		runId: triageFail.runId,
		triage: 'ignored',
		view: 'errors',
		csrf: hiddenInputs(errorsView.text).csrf,
	})
	assert(
		ignoredPost.status === 303 &&
			ignoredPost.location?.includes('/account/runs?view=errors') &&
			ignoredPost.location.includes('flash=run_ignored'),
		'Ignore redirects back to the open-errors view',
		ignoredPost,
	)
	const errorsAfter = await browser.get('/account/runs?view=errors')
	const recentAfter = await browser.get('/account/runs?view=recent')
	assert(
		!errorsAfter.text.includes(`value="${triageFail.runId}"`) &&
			recentAfter.text.includes(`value="${triageFail.runId}"`) &&
			recentAfter.text.includes('name="triage" value="open"'),
		'an ignored run leaves Open errors and shows a Reopen form in Recent runs',
	)
	const staleTriage = await browser.post('/account/runs', {
		action: 'triage',
		runId: 'run_does_not_exist',
		triage: 'resolved',
		view: 'errors',
		csrf: hiddenInputs(recentAfter.text).csrf,
	})
	assert(
		staleTriage.status === 400 && staleTriage.text.includes('was not found'),
		'triaging a run that no longer exists re-renders with the error',
		staleTriage.status,
	)
	log('activity triage', { runId: triageFail.runId })

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
	if (process.env.SMOKE_OFFLINE !== '1') {
		// Preview the files explorer against a local JSON file-map. Live
		// github:/codeload fetches flake under CI (status 200, no browse link
		// when the download fails); install.mjs still covers real GitHub.
		const fixture = await startPackageFixtureServer()
		try {
			const previewed = await browser.post('/account/packages', {
				action: 'preview',
				source: fixture.flatUrl,
				csrf,
			})
			const browse = /href="(\/account\/package-preview\/[A-Za-z0-9_-]+\/files)"/.exec(previewed.text)?.[1]
			const alertText = /role="alert"[^>]*>([\s\S]*?)<\//
				.exec(previewed.text)?.[1]
				?.replace(/<[^>]+>/g, '')
				.trim()
			assert(previewed.status === 200 && browse, 'package preview links to the files explorer', {
				status: previewed.status,
				browseFound: Boolean(browse),
				alertText: alertText ?? null,
				source: fixture.flatUrl,
			})
			const previewRoot = await browser.get(browse)
			// Scope to the summary (`aria-label="Package preview"`) — the README on
			// the same page can share description wording, so a full-page includes
			// would pass even if the summary never rendered `p.description`.
			const previewSummary = /<section[^>]*aria-label="Package preview"[^>]*>([\s\S]*?)<\/section>/.exec(
				previewRoot.text,
			)?.[1]
			assert(
				previewRoot.status === 200 &&
					previewRoot.text.includes('data-testid="package-files-markdown"') &&
					Boolean(previewSummary?.includes('Calls an HTTP endpoint with a secret placeholder header.')),
				'preview explorer opens on the README under the package description',
				previewRoot.status,
			)
			const previewProbe = await browser.get(`${browse}/probe.js`)
			assert(
				previewProbe.status === 200 &&
					previewProbe.text.includes('data-testid="package-files-code"') &&
					previewProbe.text.includes('--shiki-dark') &&
					previewProbe.text.includes('name="action" value="install"'),
				'preview explorer highlights a remote file and offers install',
				previewProbe.status,
			)
			// The subdir field travels inside the :source segment and back out to Install.
			const subdirPreview = await browser.post('/account/packages', {
				action: 'preview',
				source: fixture.repoUrl,
				subdir: fixture.subdir,
				csrf,
			})
			const subdirBrowse = /href="(\/account\/package-preview\/[A-Za-z0-9_-]+\/files)"/.exec(subdirPreview.text)?.[1]
			const subdirAlert = /role="alert"[^>]*>([\s\S]*?)<\//
				.exec(subdirPreview.text)?.[1]
				?.replace(/<[^>]+>/g, '')
				.trim()
			assert(subdirPreview.status === 200 && subdirBrowse, 'subdir preview links to the files explorer', {
				status: subdirPreview.status,
				browseFound: Boolean(subdirBrowse),
				alertText: subdirAlert ?? null,
				source: fixture.repoUrl,
				subdir: fixture.subdir,
			})
			const subdirProbe = await browser.get(`${subdirBrowse}/probe.js`)
			assert(
				subdirProbe.status === 200 &&
					subdirProbe.text.includes('data-testid="package-files-code"') &&
					subdirProbe.text.includes(`name="subdir" value="${fixture.subdir}"`),
				'subdir preview round-trips: opens the subdir file and keeps the subdir for install',
				subdirProbe.status,
			)
			log('package preview', { source: fixture.flatUrl, subdirSource: fixture.repoUrl })
		} finally {
			await fixture.close()
		}
	}
	const junkPreview = await browser.get('/account/package-preview/not*base64/files')
	assert(junkPreview.status === 400, 'undecodable preview link is a 400', junkPreview.status)
	const privatePreview = await browser.get(
		`/account/package-preview/${Buffer.from(JSON.stringify(['https://10.0.0.7/pkg.tgz'])).toString('base64url')}/files`,
	)
	assert(
		privatePreview.status >= 400 && privatePreview.text.includes('private host'),
		'preview explorer refuses private hosts',
		privatePreview.status,
	)
	const unlistedPreview = await browser.get(
		`/account/package-preview/${Buffer.from(JSON.stringify(['https://example.com/pkg.tgz'])).toString('base64url')}/files`,
	)
	assert(
		unlistedPreview.status >= 400 && unlistedPreview.text.includes('KODY_PACKAGE_SOURCE_HOSTS'),
		'preview explorer refuses public hosts outside the allowlist',
		unlistedPreview.status,
	)
	const pkgName = `@kody-smoke/web-${randomBytes(3).toString('hex')}`
	await mcp.call('packageSave', {
		files: {
			'package.json': JSON.stringify({
				name: pkgName,
				version: '1.0.0',
				description: 'web smoke',
				exports: './main.js',
				kody: {
					jobs: {
						nightly: {
							entry: './main.js',
							schedule: { type: 'interval', every: '1h' },
							enabled: false,
							description: 'nightly web smoke',
						},
					},
				},
			}),
			'README.md': `# ${pkgName}`,
			'AGENTS.md': 'Returns ok.',
			'main.js': 'export default async () => "ok"',
			'lib/util.js': 'export const nestedFile = "web smoke file"',
		},
		source: 'smoke/web.mjs',
	})
	const jobId = `${pkgName}#nightly`
	const packageHref = `/account/packages/${encodeURIComponent(pkgName)}`
	const jobHref = `/account/jobs/${encodeURIComponent(jobId)}`
	const packageDetail = await browser.get(packageHref)
	assert(
		packageDetail.status === 200 &&
			packageDetail.text.includes(pkgName) &&
			packageDetail.text.includes('web smoke') &&
			packageDetail.text.includes(jobHref) &&
			packageDetail.text.includes('data-testid="package-files"') &&
			packageDetail.text.includes('data-testid="package-files-markdown"') &&
			packageDetail.text.includes(`href="${packageHref}/files/lib"`),
		'package detail links its job and shows the files explorer with the README',
		packageDetail.status,
	)
	const filesRoot = await browser.get(`${packageHref}/files`)
	assert(
		filesRoot.status === 200 &&
			filesRoot.text.includes('data-testid="package-files"') &&
			filesRoot.text.includes('data-testid="package-files-markdown"') &&
			filesRoot.text.includes(`href="${packageHref}/files/lib"`),
		'package files root shows the tree and the rendered README',
		filesRoot.status,
	)
	const filePage = await browser.get(`${packageHref}/files/lib/util.js`)
	assert(
		filePage.status === 200 &&
			filePage.text.includes('data-testid="package-files-code"') &&
			filePage.text.includes('class="shiki shiki-themes github-light github-dark"') &&
			filePage.text.includes('--shiki-dark'),
		'nested package file page shows Shiki-highlighted content',
		filePage.status,
	)
	for (const bad of ['nope.js', '..%2Fpackage.json', 'constructor']) {
		const missing = await browser.get(`${packageHref}/files/${bad}`)
		assert(missing.status === 404, `package files 404 for ${bad}`, missing.status)
	}
	const jobPage = await browser.get(jobHref)
	assert(
		jobPage.status === 200 &&
			jobPage.text.includes(jobId) &&
			jobPage.text.includes('nightly web smoke') &&
			jobPage.text.includes('every 1h') &&
			jobPage.text.includes('Paused'),
		'job detail shows id, description, schedule and paused status',
		jobPage.status,
	)
	assert(
		(await browser.get(`/account/packages/${encodeURIComponent('@kody-smoke/does-not-exist')}`)).status === 404,
		'unknown package detail returns 404',
	)
	assert(
		(await browser.get(`/account/jobs/${encodeURIComponent(`${pkgName}#does-not-exist`)}`)).status === 404,
		'unknown job detail returns 404',
	)
	const detailPostWithoutCsrf = await browser.post(jobHref, {
		action: 'toggle',
		id: jobId,
		enabled: 'true',
	})
	assert(detailPostWithoutCsrf.status === 403, 'detail POST without csrf is refused', detailPostWithoutCsrf.status)
	const toggled = await browser.post(jobHref, {
		action: 'toggle',
		id: jobId,
		enabled: 'true',
		csrf,
	})
	assert(
		toggled.status === 303 && toggled.location?.includes(`${jobHref}?flash=saved`),
		'job toggle redirects back to job detail',
		toggled,
	)
	const enabledJobPage = await browser.get(jobHref)
	assert(
		enabledJobPage.status === 200 && enabledJobPage.text.includes('Enabled'),
		'job detail reflects the enabled state',
	)
	assert((await browser.get('/account/packages')).text.includes(packageHref), 'packages list links to package detail')
	assert((await browser.get('/account/jobs')).text.includes(jobHref), 'jobs list links to job detail')
	log('account details', 'package, nested file, and job pages render; 404, CSRF, and toggle checks passed')
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
	const detailPublished = await browser.post(packageHref, {
		action: 'publish',
		name: pkgName,
		csrf,
	})
	assert(
		detailPublished.status === 303 && detailPublished.location?.includes(`${packageHref}?flash=published`),
		'publish from package detail redirects to the detail page',
		detailPublished,
	)
	const publishedDetailPage = await browser.get(packageHref)
	assert(
		publishedDetailPage.status === 200 &&
			publishedDetailPage.text.includes('Republish') &&
			publishedDetailPage.text.includes('Unpublish'),
		'published package detail shows Republish and Unpublish actions',
	)
	const detailUnpublished = await browser.post(packageHref, {
		action: 'unpublish',
		name: pkgName,
		csrf,
	})
	assert(
		detailUnpublished.status === 303 && detailUnpublished.location?.includes(`${packageHref}?flash=unpublished`),
		'unpublish from package detail redirects to the detail page',
		detailUnpublished,
	)
	assert(
		(await fetch(`${baseUrl}/community/${encodeURIComponent(pkgName)}`)).status === 404,
		'detail unpublish removes the community listing',
	)
	log('package detail actions', 'publish and unpublish redirect to the package detail page')

	// Password sign-in on a second browser, wrong password, lockout after 5 failures.
	const second = new Browser()
	const wrong = await second.post('/signin', {
		intent: 'password',
		email: user.email,
		password: 'definitely-not-it-12345',
	})
	assert(
		wrong.status === 401 && wrong.text.includes('Wrong email or password'),
		'wrong password rejected',
		wrong.status,
	)
	const right = await second.post('/signin', {
		intent: 'password',
		email: user.email,
		password,
		next: '/account/sessions',
	})
	assert(right.status === 303 && right.location?.endsWith('/account/sessions'), 'password sign-in honours next', right)
	const openRedirect = await new Browser().post('/signin', {
		intent: 'password',
		email: user.email,
		password,
		next: 'https://evil.example/',
	})
	assert(openRedirect.location?.endsWith('/account'), 'external next is ignored', openRedirect.location)
	const protoRelative = await new Browser().post('/signin', {
		intent: 'password',
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
	const viaToken = await new Browser().post('/signin', { intent: 'token', token: mcp.token })
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
		await locker.post('/signin', { intent: 'password', email: user.email, password: `wrong-${i}-xxxxxxxxxxxx` })
	}
	const locked = await locker.post('/signin', { intent: 'password', email: user.email, password })
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
	await userSecrets.post('/signin', { intent: 'token', token: mcp.token })
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
