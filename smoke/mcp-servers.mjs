// External MCP servers (#44): add with a bearer token, search, call from ad hoc and a package,
// lock, disable, refresh, refuse a non-allowlisted host, remove, account page. Token never echoed.
import { randomBytes } from 'node:crypto'
import { admin, assert, Browser, log, waitFor } from './lib.mjs'
import { startMockMcpServer } from './mcp-mock-server.mjs'

export async function smokeMcpServers(ctx) {
	const { mcp } = ctx
	const bearer = `smoke-mcp-${randomBytes(12).toString('hex')}`
	const mock = await startMockMcpServer({ port: Number(process.env.SMOKE_MCP_PORT ?? 9798), bearer })
	try {
		const added = await mcp.call('mcpServerAdd', { name: 'smoke', url: mock.url, bearerToken: bearer })
		assert(
			added.status === 'ready' && added.toolCount === 3,
			'mcpServerAdd discovers 3 tools (is KODY_MCP_ALLOW_PRIVATE_HOSTS set in .dev.vars?)',
			added,
		)
		const listed = await mcp.call('mcpServerList')
		assert(!JSON.stringify(listed).includes(bearer), 'mcpServerList never returns the token')
		log('add + list', `${added.toolCount} tools, token hidden`)

		const found = await mcp.search({ domain: 'mcp:smoke' })
		const ids = found.results.map((r) => r.id)
		assert(
			['mcp-server:smoke', 'mcp:smoke:echo', 'mcp:smoke:add', 'mcp:smoke:image'].every((id) => ids.includes(id)),
			'search lists the server and its tools',
			ids,
		)
		log('search', ids.join(', '))

		const sumRun = await mcp.execute(
			`import { kody } from 'kody:runtime'\nexport default async () => kody.mcp['smoke'].add({ a: 2, b: 3 })`,
		)
		assert(sumRun.ok, 'ad hoc kody.mcp.smoke.add runs', sumRun)
		const sum = sumRun.result
		assert(sum.structuredContent?.sum === 5 && sum.isError === false, 'ad hoc kody.mcp.smoke.add returns 5', sum)
		const image = await mcp.run(
			`import { kody } from 'kody:runtime'\nexport default async () => kody.mcp['smoke'].image({})`,
		)
		assert(image.content?.[0]?.type === 'image', 'image content passes through', image)
		log('ad hoc call', 'add=5, image block')

		// The call is recorded in run history as a gateway event (recorded via waitUntil, so poll).
		const event = await waitFor(
			'the MCP gateway event in run history',
			async () => {
				const run = await mcp.call('runGet', { id: sumRun.runId })
				return run.gateway?.find((e) => e.method === 'MCP') ?? null
			},
			{ timeoutMs: 15_000, intervalMs: 500 },
		)
		assert(
			event.mcp?.server === 'smoke' &&
				event.mcp?.tool === 'add' &&
				event.outcome === 'injected' &&
				event.url === mock.url &&
				!JSON.stringify(event).includes(bearer),
			'run history records the MCP call (server, tool, url) without the token',
			event,
		)
		log('run history', `${event.method} ${event.url} ${event.mcp.server}.${event.mcp.tool}`)

		const pkg = '@kody-smoke/mcp-user'
		await mcp.call('packageSave', {
			files: {
				'package.json': JSON.stringify({
					name: pkg,
					version: '1.0.0',
					description: 'mcp-servers smoke',
					exports: { '.': './index.js' },
				}),
				'README.md': `# ${pkg}`,
				'AGENTS.md': 'Calls the smoke MCP server.',
				'index.js': `import { kody } from 'kody:runtime'\nexport default async () => (await kody.mcp['smoke'].echo({ text: 'from package' })).content[0].text`,
			},
		})
		const fromPkg = await mcp.callDirect('packageRun', { name: pkg })
		assert(fromPkg.ok && fromPkg.result === 'from package', 'package call works', fromPkg)

		await mcp.call('mcpServerLock', { name: 'smoke', packageName: pkg })
		const locked = await mcp.execute(
			`import { kody } from 'kody:runtime'\nexport default async () => kody.mcp['smoke'].echo({ text: 'x' })`,
		)
		assert(
			!locked.ok && /mcp_server_locked/.test(locked.error?.message ?? ''),
			'locked server refuses ad hoc execute',
			locked.error,
		)
		const stillOk = await mcp.callDirect('packageRun', { name: pkg })
		assert(stillOk.ok && stillOk.result === 'from package', 'granted package still works', stillOk)
		const hidden = await mcp.search({ domain: 'mcp:smoke' })
		assert(hidden.results.length === 0, 'locked server is hidden from MCP-session search', hidden.results)
		log('lock', 'ad hoc refused, package ok, hidden from search')

		await mcp.call('mcpServerSetEnabled', { name: 'smoke', enabled: false })
		const disabled = await mcp.callDirect('packageRun', { name: pkg })
		assert(
			!disabled.ok && /mcp_server_disabled/.test(disabled.error?.message ?? ''),
			'disabled server refuses',
			disabled,
		)
		await mcp.call('mcpServerSetEnabled', { name: 'smoke', enabled: true })

		mock.addTool('late')
		const refreshed = await mcp.call('mcpServerRefresh', { name: 'smoke' })
		assert(refreshed.toolCount === 4, 'refresh sees the new tool', refreshed)
		log('disable + refresh', '4 tools after refresh')

		const refused = await mcp.execute(
			`import { kody } from 'kody:runtime'\nexport default async () => kody.mcpServerAdd({ name: 'lan', url: 'http://192.0.2.1/mcp' })`,
		)
		assert(
			!refused.ok && /mcp_host_not_allowed|KODY_MCP_ALLOW_PRIVATE_HOSTS|https/.test(refused.error?.message ?? ''),
			'non-allowlisted http host refused',
			refused.error,
		)
		const after = await mcp.call('mcpServerList')
		assert(!after.servers.some((s) => s.name === 'lan'), 'refused server is not saved')

		// Web sign-in the same way smoke/web.mjs does: admin invite link -> set a password -> session cookie.
		const invite = await admin.invite(ctx.user.id)
		assert(invite.status === 201, 'admin invite for the account page', invite)
		const browser = new Browser()
		const password = `pw-${randomBytes(12).toString('hex')}`
		await browser.get(invite.json.url)
		const accepted = await browser.post(invite.json.url, { password, confirm: password })
		assert(accepted.status === 303, 'signed in through the invite link', accepted.status)
		const page = await browser.get('/account/mcp-servers')
		assert(
			page.status === 200 && page.text.includes('<strong>smoke</strong>') && !page.text.includes(bearer),
			'account page lists the server without the token',
			page.status,
		)
		log('account page', 'renders, token hidden')

		const removed = await mcp.call('mcpServerRemove', { name: 'smoke' })
		assert(removed.removed === true, 'remove')
		const gone = await mcp.search({ query: 'mcp-server:smoke' })
		assert(!gone.results.some((r) => r.id === 'mcp-server:smoke'), 'removed server gone from search')
		assert(
			!mock.hits.some((h) => h.authorization && h.authorization !== `Bearer ${bearer}`),
			'only the stored bearer was ever sent',
		)
		log('remove', 'gone from search')
	} finally {
		await mock.close()
	}
}
