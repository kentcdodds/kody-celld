// Source of the host-owned entry module for a Worker Loader isolate. The host
// calls it over `fetch` with { params, context }; it runs the user's default
// export inside an AsyncLocalStorage scope so console output and the run id
// stay attached to the right run even when the isolate is shared.
export function buildWrapperModule(entrySpecifier: string) {
	return `
import * as __entry from ${JSON.stringify(entrySpecifier)}
import { __init, __run, __current, __setPackageContext } from './kody-runtime.js'

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
