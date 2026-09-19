// M6 provider-backed secrets smoke, against a mock vault hosted by this process:
// bind a kody.secretProvider package with a door secret, resolve
// {{secret/<provider>:<ref>}} through a sealed provider run, inject only into
// requests for the item's hosts, cache in memory, lock/grant/revoke per package,
// refuse to run the provider export directly, and keep values out of run
// history, MCP results and the audit log.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { admin, assert, log, readPackageDir, sha256 } from './lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const providerPackage = '@kody-smoke/smoke-vault'
const consumerPackage = '@kody-smoke/http-probe'
const providerId = 'smokevault'

function safeEqual(a, b) {
	const x = Buffer.from(String(a ?? ''))
	const y = Buffer.from(String(b ?? ''))
	return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Mock vault (needs the door token) + a mock API (needs the item value). The
 * vault listens on `vaultHost`; the API is reached via `apiHost` so that the
 * item-host allowlist can be exercised independently of admin host approval.
 */
async function startMockVault(port) {
	const vaultHost = process.env.SMOKE_ECHO_HOST ?? '127.0.0.1'
	const apiHost = process.env.SMOKE_ECHO_HOST ?? 'localhost'
	const bind = process.env.SMOKE_ECHO_BIND ?? (vaultHost === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0')
	const doorToken = `door-${randomBytes(20).toString('hex')}`
	const items = {
		alias: { id: 'item-01', value: `vault-${randomBytes(20).toString('hex')}`, hosts: [apiHost] },
		'item-01': null, // filled below: canonical id resolves to the same item
		noaccess: { id: 'item-02', value: `vault-${randomBytes(20).toString('hex')}`, hosts: ['api.other.example'] },
	}
	items['item-01'] = items.alias
	const state = { doorToken, items, vaultHits: [], apiHits: [] }
	const server = createServer((req, res) => {
		const url = new URL(req.url, `http://${vaultHost}:${port}`)
		const json = (status, payload) => {
			res.statusCode = status
			res.setHeader('content-type', 'application/json')
			res.end(JSON.stringify(payload))
		}
		const auth = req.headers.authorization ?? ''
		const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : ''
		if (url.pathname === '/health') return json(200, { ok: true })
		if (url.pathname.startsWith('/v1/items/')) {
			const ref = decodeURIComponent(url.pathname.slice('/v1/items/'.length))
			const authorized = safeEqual(bearer, doorToken)
			state.vaultHits.push({ ref, authorized, hadPlaceholder: auth.includes('{{'), authorizationSha256: sha256(auth) })
			if (!authorized) return json(401, { error: 'bad_door_token' })
			const item = items[ref]
			if (!item) return json(404, { error: 'not_found' })
			return json(200, item)
		}
		if (url.pathname === '/api/whoami') {
			const ok = safeEqual(bearer, items.alias.value)
			state.apiHits.push({ ok, hadPlaceholder: auth.includes('{{'), authorizationSha256: sha256(auth) })
			if (!ok) return json(401, { error: 'invalid_token' })
			return json(200, { ok: true, who: 'smoke' })
		}
		json(404, { error: 'not_found' })
	})
	await new Promise((resolve) => server.listen(port, bind, resolve))
	return {
		state,
		vaultHost,
		apiHost,
		vaultUrl: `http://${vaultHost}:${port}`,
		apiUrl: `http://${apiHost}:${port}/api/whoami`,
		close: () => new Promise((resolve) => server.close(resolve)),
	}
}

export async function smokeSecretProviders({ mcp, user }) {
	const vault = await startMockVault(Number(process.env.SMOKE_VAULT_PORT ?? 9795))
	const { state } = vault
	const secretMaterial = () => [state.doorToken, state.items.alias.value, state.items.noaccess.value]
	const assertClean = (label, value) => {
		const text = JSON.stringify(value)
		for (const s of secretMaterial()) assert(!text.includes(s), `${label} must never contain a secret value`)
	}
	const placeholderCall = (ref) =>
		mcp.execute(
			`export default async function main({ url }) {
  const res = await fetch(url, { headers: { authorization: 'Bearer {{secret/${providerId}:${ref}}}' } })
  return { status: res.status, body: await res.json() }
}`,
			{ url: vault.apiUrl },
		)
	const packageCall = (ref) =>
		mcp.callDirect('packageRun', {
			name: consumerPackage,
			export: './provider',
			params: { url: vault.apiUrl, provider: providerId, ref },
		})
	try {
		for (const dir of ['smoke-vault', 'http-probe']) {
			const files = await readPackageDir(path.join(here, '..', 'examples', 'packages', dir))
			const saved = await mcp.call('packageSave', { files, source: `examples/packages/${dir}` })
			log('packageSave', { name: saved.name, secretProvider: saved.manifest.secretProvider?.id ?? null })
		}

		const found = await mcp.search({ entity: 'capability', domain: 'secret-providers' })
		const ids = new Set(found.results.map((hit) => hit.id))
		for (const expected of [
			'secretProviderBind',
			'secretProviderList',
			'secretProviderGrant',
			'secretProviderRevoke',
			'secretProviderLock',
			'secretProviderUnbind',
		]) {
			assert(ids.has(expected), `search should surface ${expected}`, [...ids])
		}
		const byQuery = await mcp.search({ query: '1password vault secret provider' })
		assert(
			byQuery.results.some((hit) => hit.id === 'secretProviderBind'),
			'free-text search should find secretProviderBind',
			byQuery.results.map((r) => r.id),
		)
		log('search', 'secret-provider capabilities discoverable')

		// The provider's own door secret and its host approval (admin-only, as for any secret).
		await mcp.call('secretProviderUnbind', { providerId }).catch(() => {})
		const missingDoor = await mcp.execute(
			`import { kody } from 'kody:runtime'
export default async function main(args) { return await kody.secretProviderBind(args) }`,
			{
				providerId,
				packageName: providerPackage,
				doorSecretName: 'smoke-vault-door',
				config: { baseUrl: vault.vaultUrl },
			},
		)
		assert(
			!missingDoor.ok && /secret_not_found/.test(missingDoor.error?.message ?? ''),
			'bind needs the door secret first',
			missingDoor.error,
		)
		await mcp.call('secretSave', { name: 'smoke-vault-door', value: state.doorToken, description: 'smoke vault door' })
		const approved = await admin.approveHost(user.id, vault.vaultHost)
		assert(approved.status === 201 || approved.status === 409, 'admin approval of the vault host failed', approved)
		if (vault.apiHost !== vault.vaultHost) await admin.revokeHost(user.id, vault.apiHost)

		const badConfig = await mcp.execute(
			`import { kody } from 'kody:runtime'
export default async function main(args) { return await kody.secretProviderBind(args) }`,
			{ providerId, packageName: providerPackage, doorSecretName: 'smoke-vault-door', config: { apiToken: 'nope' } },
		)
		assert(
			!badConfig.ok && /looks like a credential/i.test(badConfig.error?.message ?? ''),
			'credential-looking config keys are refused',
			badConfig.error,
		)

		const binding = await mcp.call('secretProviderBind', {
			providerId,
			packageName: providerPackage,
			doorSecretName: 'smoke-vault-door',
			config: { baseUrl: vault.vaultUrl },
		})
		assertClean('secretProviderBind', binding)
		assert(binding.providerId === providerId && binding.locked === false, 'binding metadata', binding)
		assert(
			binding.placeholderExample === `{{secret/${providerId}:<ref>}}`,
			'binding placeholder hint',
			binding.placeholderExample,
		)
		log('secretProviderBind', { providerId: binding.providerId, package: binding.packageName, locked: binding.locked })

		// Wrong package: not a declared provider for that id.
		const wrongPackage = await mcp.execute(
			`import { kody } from 'kody:runtime'
export default async function main(args) { return await kody.secretProviderBind(args) }`,
			{ providerId: 'other', packageName: consumerPackage, doorSecretName: 'smoke-vault-door', config: {} },
		)
		assert(!wrongPackage.ok, 'binding a package that does not declare the provider must fail', wrongPackage.error)

		// --- resolve + inject (ad hoc code)
		const first = await placeholderCall('alias')
		assert(first.ok && first.result.status === 200, 'placeholder should resolve via the provider', first)
		assertClean('execute payload', first)
		assert(
			state.vaultHits.length === 1 && state.vaultHits[0].authorized && !state.vaultHits[0].hadPlaceholder,
			'door token injected into the provider request',
			state.vaultHits,
		)
		assert(state.vaultHits[0].authorizationSha256 === sha256(`Bearer ${state.doorToken}`), 'door token digest')
		assert(state.apiHits.at(-1).ok && !state.apiHits.at(-1).hadPlaceholder, 'item value injected into the API request')
		assert(state.apiHits.at(-1).authorizationSha256 === sha256(`Bearer ${state.items.alias.value}`), 'value digest')
		assert(
			first.gateway.some((e) => e.outcome === 'injected' && e.secrets.includes(`secret/${providerId}:alias`)),
			'gateway event names the provider ref, not the value',
			first.gateway,
		)
		log('inject', { vaultHits: state.vaultHits.length, apiStatus: first.result.status })

		// Cached: no second vault round-trip.
		const second = await placeholderCall('alias')
		assert(
			second.ok && second.result.status === 200 && state.vaultHits.length === 1,
			'second resolution should hit the in-memory cache',
			{ vaultHits: state.vaultHits.length },
		)
		log('cache', 'second call served without the vault')

		// --- run history: the sealed provider run keeps metadata only.
		const runs = await admin.runs(user.id, 30)
		assertClean('admin runs', runs.json)
		const providerRun = runs.json.runs.find((r) => r.kind === 'secret-provider')
		assert(
			providerRun && providerRun.status === 'success' && providerRun.packageName === providerPackage,
			'sealed provider run should be recorded',
			providerRun,
		)
		const providerRunDetail = await mcp.call('runGet', { id: providerRun.id })
		assertClean('runGet (sealed run)', providerRunDetail)
		assert(
			providerRunDetail.result === undefined && providerRunDetail.logs.length === 0,
			'sealed run must store neither result nor logs',
			providerRunDetail,
		)
		assert(
			providerRunDetail.gateway.some((e) => e.outcome === 'injected' && e.secrets.includes('smoke-vault-door')),
			'sealed run keeps gateway metadata (door secret name)',
			providerRunDetail.gateway,
		)
		log('sealed run', {
			id: providerRun.id,
			result: providerRunDetail.result ?? null,
			logs: providerRunDetail.logs.length,
		})

		// --- the provider export cannot be run directly.
		const direct = await mcp.callDirectRaw('packageRun', {
			name: providerPackage,
			export: './secretProvider',
			params: { providerId, ref: 'alias', config: { baseUrl: vault.vaultUrl }, doorSecretName: 'smoke-vault-door' },
		})
		assert(
			direct.isError && JSON.stringify(direct.payload).includes('secret_provider_entry_sealed'),
			'provider entry must be sealed',
			direct.payload,
		)
		const viaKodyImport = await mcp.execute(
			`import provider from 'kody:${providerPackage}/secretProvider'
export default async function main() { return await provider({ ref: 'alias', config: { baseUrl: ${JSON.stringify(vault.vaultUrl)} }, doorSecretName: 'smoke-vault-door' }) }`,
		)
		assert(
			!viaKodyImport.ok && /secret_provider_entry_sealed/.test(JSON.stringify(viaKodyImport.error)),
			'importing the provider module must be refused',
			viaKodyImport.error,
		)
		assertClean('kody: import of the provider', viaKodyImport)
		log('sealed entry', 'direct packageRun + kody: import refused')

		// --- item hosts: a value may only travel to the item's hosts (or admin-approved hosts).
		if (vault.apiHost !== vault.vaultHost) {
			const wrongHost = await placeholderCall('noaccess')
			assert(
				wrongHost.ok &&
					wrongHost.result.status === 403 &&
					wrongHost.result.body.error === 'secret_provider_host_not_allowed',
				'value must not be sent to a host outside the item hosts',
				wrongHost.result,
			)
			assert(
				state.apiHits.every((h) => h.ok),
				'the denied request must never reach the API',
			)
			log('item hosts', wrongHost.result.body.error)
		} else {
			log('item hosts', 'skipped (SMOKE_ECHO_HOST makes API and vault the same admin-approved host)')
		}

		// --- lock + grants
		const locked = await mcp.call('secretProviderLock', { providerId, locked: true })
		assert(locked.locked === true, 'lock', locked)
		const adHocLocked = await placeholderCall('alias')
		assert(
			adHocLocked.ok &&
				adHocLocked.result.status === 403 &&
				adHocLocked.result.body.error === 'secret_provider_not_granted',
			'locked provider refuses ad hoc code',
			adHocLocked.result,
		)
		const pkgUngranted = await packageCall('alias')
		assert(
			pkgUngranted.result.status === 403 && pkgUngranted.result.body.error === 'secret_provider_not_granted',
			'locked provider refuses ungranted packages',
			pkgUngranted.result,
		)
		const grant = await mcp.call('secretProviderGrant', { providerId, ref: 'item-01', packageName: consumerPackage })
		assert(
			grant.canonicalRef === 'item-01' && grant.packageName === consumerPackage,
			'grant on the canonical ref',
			grant,
		)
		const pkgGranted = await packageCall('alias')
		assert(
			pkgGranted.ok && pkgGranted.result.status === 200,
			'granted package may use the alias (canonical ref matches)',
			pkgGranted,
		)
		assertClean('granted packageRun', pkgGranted)
		const pkgOtherRef = await packageCall('noaccess')
		assert(pkgOtherRef.result.status === 403, 'grant is per ref', pkgOtherRef.result)
		const stillAdHoc = await placeholderCall('alias')
		assert(stillAdHoc.result.status === 403, 'ad hoc code stays refused while locked')
		const listed = await mcp.call('secretProviderList')
		assertClean('secretProviderList', listed)
		const listedBinding = listed.providers.find((p) => p.providerId === providerId)
		assert(
			listedBinding?.locked === true &&
				listedBinding.grants.some((g) => g.canonicalRef === 'item-01' && g.packageName === consumerPackage),
			'list shows lock + grant',
			listedBinding,
		)
		const revoked = await mcp.call('secretProviderRevoke', { providerId, ref: 'item-01', packageName: consumerPackage })
		assert(revoked.deleted === true, 'revoke', revoked)
		const pkgRevoked = await packageCall('alias')
		assert(pkgRevoked.result.status === 403, 'revoked package is refused again', pkgRevoked.result)
		await mcp.call('secretProviderLock', { providerId, locked: false })
		const unlocked = await placeholderCall('alias')
		assert(unlocked.ok && unlocked.result.status === 200, 'unlock restores ad hoc use', unlocked)
		log('lock/grant/revoke', 'ok')

		// Revoke dropped the cache: the provider ran again for the unlock call.
		assert(
			state.vaultHits.length >= 2 && state.vaultHits.every((h) => h.authorized),
			'cache invalidated on revoke',
			state.vaultHits.length,
		)

		// --- provider errors are surfaced as gateway denials, not thrown into code.
		const missing = await placeholderCall('does-not-exist')
		assert(
			missing.ok && missing.result.status === 502 && missing.result.body.error === 'secret_provider_failed',
			'unknown ref should be a 502 secret_provider_failed',
			missing.result,
		)
		assertClean('provider failure', missing)
		log('provider error', missing.result.body.error)

		// --- audit + unbind
		const audit = await admin.audit({ target: providerId })
		assertClean('audit', audit.json)
		const actions = new Set(audit.json.entries.map((e) => e.action))
		for (const action of [
			'secret_provider.bind',
			'secret_provider.lock',
			'secret_provider.grant',
			'secret_provider.revoke',
		]) {
			assert(actions.has(action), `audit should contain ${action}`, [...actions])
		}
		const unbound = await mcp.call('secretProviderUnbind', { providerId })
		assert(unbound.deleted === true, 'unbind', unbound)
		const afterUnbind = await placeholderCall('alias')
		assert(
			afterUnbind.result.status === 404 && afterUnbind.result.body.error === 'secret_provider_not_bound',
			'unbound provider fails closed',
			afterUnbind.result,
		)
		log('unbind', afterUnbind.result.body.error)
	} finally {
		await vault.close()
	}
}
