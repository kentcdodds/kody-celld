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

const secretNamePattern = /^[a-zA-Z0-9._-]+$/

function assertSecretName(value, label) {
	if (typeof value !== 'string' || !secretNamePattern.test(value)) {
		throw new TypeError(label + ' must be a secret name (letters, digits, ".", "_", "-").')
	}
	return value
}

/**
 * Returns a fetch that sends \`Authorization: Bearer {{integration-token:<name>}}\`.
 * The placeholder is swapped for the real access token by the host gateway,
 * which also enforces the connection's host allowlist and refreshes expired
 * tokens; sandbox code never sees a raw token.
 */
export function createAuthenticatedFetch(integrationName, options = {}) {
	const name = assertSecretName(integrationName, 'createAuthenticatedFetch(name)')
	const headerName = typeof options.headerName === 'string' && options.headerName ? options.headerName : 'authorization'
	const scheme = options.scheme === undefined ? 'Bearer' : options.scheme
	const placeholder = '{{integration-token:' + name + '}}'
	const headerValue = scheme ? scheme + ' ' + placeholder : placeholder
	return async (input, init) => {
		const request = new Request(input, init)
		if (!request.headers.has(headerName)) request.headers.set(headerName, headerValue)
		return fetch(request)
	}
}

/** Client-credentials connections are ordinary integrations; the grant type only changes how the host refreshes. */
export const oauthClientCredentials = createAuthenticatedFetch

export const secretHeaders = {
	basic({ usernameSecret, passwordSecret, scope } = {}) {
		const username = assertSecretName(usernameSecret, 'secretHeaders.basic({ usernameSecret })')
		const password = assertSecretName(passwordSecret, 'secretHeaders.basic({ passwordSecret })')
		const suffix = scope === 'package' || scope === 'user' ? '|scope=' + scope : ''
		return { authorization: '{{secret-basic:username=' + username + ',password=' + password + suffix + '}}' }
	},
	bearer(secretName, scope) {
		const name = assertSecretName(secretName, 'secretHeaders.bearer(name)')
		const suffix = scope === 'package' || scope === 'user' ? '|scope=' + scope : ''
		return { authorization: 'Bearer {{secret:' + name + suffix + '}}' }
	},
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
