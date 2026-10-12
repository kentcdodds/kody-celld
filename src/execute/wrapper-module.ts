const prelude = `
const RUN_HEADER = 'x-kody-run'
const __originalFetch = globalThis.fetch
const __originalConsole = globalThis.console
let __patched = false

function __safe(value) {
	try {
		if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack }
		return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
	} catch {
		return String(value)
	}
}

function __patchGlobals() {
	if (__patched) return
	__patched = true
	globalThis.fetch = (input, init) => {
		const store = __current()
		if (!store) return __originalFetch(input, init)
		const request = new Request(input, init)
		const headers = new Headers(request.headers)
		headers.set(RUN_HEADER, store.runId)
		return __originalFetch(new Request(request, { headers }))
	}
	const levels = ['log', 'info', 'warn', 'error', 'debug']
	const proxy = {}
	for (const key of Object.keys(__originalConsole)) proxy[key] = __originalConsole[key]
	for (const level of levels) {
		proxy[level] = (...args) => {
			const store = __current()
			if (store && store.logs.length < 500) store.logs.push({ level, args: args.map(__safe) })
			else if (!store) __originalConsole[level](...args)
		}
	}
	globalThis.console = proxy
}
`

// Source of the host-owned entry module for a Worker Loader isolate. The host
// calls it over `fetch` with { params, context }; it runs the user's default
// export inside an AsyncLocalStorage scope so console output and the run id
// stay attached to the right run even when the isolate is shared.
export function buildWrapperModule(entrySpecifier: string) {
	return `
import * as __entry from ${JSON.stringify(entrySpecifier)}
import { __init, __run, __current, __setPackageContext } from './kody-runtime.js'

${prelude}
async function __serialize(result) {
	if (result instanceof Response) {
		return { __type: 'Response', status: result.status, headers: Object.fromEntries(result.headers), body: await result.text() }
	}
	if (result === undefined) return null
	return __safe(result)
}

export default {
	async fetch(request, env) {
		__init(env)
		__patchGlobals()
		const { params, context } = await request.json()
		const store = { runId: context.runId, packageName: context.packageName ?? null, logs: [] }
		__setPackageContext(
			context.packageName ? { packageName: context.packageName, version: context.packageVersion ?? null, runId: context.runId } : null,
		)
		return __run(store, async () => {
			const fn = __entry.default
			if (typeof fn !== 'function') {
				return Response.json({
					ok: false,
					error: { name: 'TypeError', message: 'The module must have a default export function.' },
					logs: store.logs,
				})
			}
			try {
				const result = await fn(params)
				return Response.json({ ok: true, result: await __serialize(result), logs: store.logs })
			} catch (error) {
				return Response.json({ ok: false, error: __safe(error) ?? { name: 'Error', message: String(error) }, logs: store.logs })
			}
		})
	},
}
`
}

/**
 * Host-owned entry for a package app isolate (docs/package-apps.md). The host
 * forwards the browser's Request with the app context in a header; this
 * wrapper sets `packageContext`, runs the package's fetch handler inside the
 * run scope, and streams its Response back untouched. Failures (throw, a
 * non-Response, status >= 500) are reported to the host as an `app` run.
 */
export function buildAppWrapperModule(entrySpecifier: string) {
	return `
import * as __entry from ${JSON.stringify(entrySpecifier)}
import { __init, __run, __current, __setPackageContext } from './kody-runtime.js'
${prelude}
const CONTEXT_HEADER = 'x-kody-app-context'
const __emptyEnv = Object.freeze({})

function __handler() {
	const mod = __entry
	if (typeof mod.default === 'function') return (request, env, ctx) => mod.default(request, env, ctx)
	if (mod.default && typeof mod.default.fetch === 'function') return (request, env, ctx) => mod.default.fetch(request, env, ctx)
	if (typeof mod.fetch === 'function') return (request, env, ctx) => mod.fetch(request, env, ctx)
	return null
}

function __errorPage() {
	return new Response('This app failed. The error is in your Kody run history.', {
		status: 500,
		headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
	})
}

export default {
	async fetch(request, env, ctx) {
		__init(env)
		__patchGlobals()
		const context = JSON.parse(request.headers.get(CONTEXT_HEADER) ?? '{}')
		const headers = new Headers(request.headers)
		headers.delete(CONTEXT_HEADER)
		const appRequest = new Request(request, { headers })
		const packageContext = { ...(context.packageContext ?? {}), runId: context.runId ?? null }
		__setPackageContext(packageContext)
		const store = { runId: context.runId ?? null, packageName: packageContext.packageName ?? null, logs: [] }
		const report = (status, error) => {
			const pending = env.KODY.appRunReport({ status, error, logs: store.logs }).catch(() => {})
			if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(pending)
		}
		return __run(store, async () => {
			const handler = __handler()
			if (!handler) {
				report(500, { name: 'TypeError', message: 'kody.app.entry must export a fetch handler: a default function, a default { fetch }, or a named fetch.' })
				return __errorPage()
			}
			try {
				const response = await handler(appRequest, __emptyEnv, ctx)
				if (!(response instanceof Response)) {
					report(500, { name: 'TypeError', message: 'The app fetch handler must return a Response.' })
					return __errorPage()
				}
				if (response.status >= 500) report(response.status, null)
				return response
			} catch (error) {
				report(500, __safe(error) ?? { name: 'Error', message: String(error) })
				return __errorPage()
			}
		})
	},
}
`
}
