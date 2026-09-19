// Source of the host-owned `kody:runtime` module that is injected into every
// Worker Loader isolate. It talks to the host through the `KODY` service
// binding (RuntimeHost RPC). Kept as a string so the runtime never needs a
// bundler at execution time.
export const RUNTIME_MODULE_SOURCE = `
import { AsyncLocalStorage } from 'node:async_hooks'

const __als = new AsyncLocalStorage()
let __env = null

export function __init(env) {
	__env = env
}

export function __run(context, fn) {
	return __als.run(context, fn)
}

export function __current() {
	return __als.getStore() ?? null
}

function __callContext() {
	const store = __current()
	return store ? { runId: store.runId, packageName: store.packageName } : null
}

function host() {
	if (!__env) throw new Error('kody:runtime is not initialized for this isolate.')
	return __env.KODY
}

function deferred(name) {
	return () => {
		throw new Error(name + ' is not available in kody-celld v1 (deferred; see docs/known-gaps.md).')
	}
}

export const kody = new Proxy(Object.create(null), {
	get(_target, name) {
		if (typeof name !== 'string' || name === 'then' || name === 'toJSON') return undefined
		return async (args = {}) => host().capability(name, args ?? {}, __callContext())
	},
	has() {
		return true
	},
})

export let packageContext = null

export function __setPackageContext(context) {
	packageContext = context
}

// Package modules are stamped at graph-build time: packageStorage() becomes
// packageStorage('<their package>'), so provenance follows the declaring
// module even when it is imported from ad hoc code or another package.
export function packageStorage(__declaringPackage) {
	const context = __current()
	const packageName = typeof __declaringPackage === 'string' && __declaringPackage !== '' ? __declaringPackage : context?.packageName
	if (typeof packageName !== 'string' || packageName === '') {
		throw new Error(
			'packageStorage() requires package provenance: this module was not run from a saved package. ' +
				'Ad hoc execute has no scratch SQLite helper. Save a package and call its export, ' +
				"or statically import the owning package's export (kody:@scope/package/export).",
		)
	}
	return {
		id: 'package-storage:' + packageName,
		get: (key) => host().storageGet(packageName, key),
		set: (key, value) => host().storageSet(packageName, key, value),
		delete: (key) => host().storageDelete(packageName, key),
		list: (options) => host().storageList(packageName, options ?? {}),
		clear: () => host().storageClear(packageName),
		sql: (query, ...params) => host().storageSql(packageName, query, params),
	}
}

export const packageSecrets = {
	async list() {
		const result = await host().capability('secretList', {}, __callContext())
		return result.secrets
	},
}

export const createAuthenticatedFetch = deferred('createAuthenticatedFetch')
export const oauthClientCredentials = deferred('oauthClientCredentials')
export const secretHeaders = undefined
export const email = null
export const workflows = null
export const packages = null
export const events = null

export default {
	kody,
	packageStorage,
	packageContext,
	packageSecrets,
	createAuthenticatedFetch,
	oauthClientCredentials,
	secretHeaders,
	email,
	workflows,
	packages,
	events,
}
`
