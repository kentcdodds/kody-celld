import type { Env } from '../env.ts'
import { getUserCell } from '../execute/engine.ts'
import { KodyError } from '../lib/errors.ts'
import { packageNamePattern } from '../packages/manifest.ts'
import { redirect } from '../web/http.ts'
import { readWebSession } from '../web/session.ts'
import { appUrl, readAppConfig } from './app-url.ts'
import { handoffParam } from './forward.ts'
import { decideAppsOpen } from './open-decision.ts'
import { mintHandoff } from './tokens.ts'

export function isAppsOpenRoute(pathname: string) {
	return pathname === '/apps/open'
}

/** `GET /apps/open?package=<name>`: the only way into a package app (mints the handoff). */
export async function handleAppsOpen(request: Request, env: Env, url: URL): Promise<Response> {
	const apps = readAppConfig(env)
	if (!apps) {
		throw new KodyError('apps_disabled', 'Package apps are off on this server (set KODY_APP_BASE_URL).', {
			status: 404,
		})
	}
	if (!apps.ok) throw new KodyError('app_origin_misconfigured', apps.error, { status: 500 })
	if (request.method !== 'GET') throw new KodyError('method_not_allowed', 'Use GET.', { status: 405 })
	const session = await readWebSession(request, env)
	if (!session) return redirect(`/signin?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`)
	const name = url.searchParams.get('package') ?? ''
	const pkg = packageNamePattern.test(name) ? await getUserCell(env, session.user.id).packageGet(name) : null
	if (!pkg?.manifest.app) throw new KodyError('not_an_app', `"${name}" is not a saved package app.`, { status: 404 })
	const base = appUrl(apps.config, session.user.id, pkg.name)
	if (!base) {
		throw new KodyError('app_origin_unmappable', 'This account id cannot be used as a package-app subdomain.', {
			status: 500,
		})
	}
	// The handoff is bound to the browser by the app origin's `kody_app_state` cookie (login-CSRF fix).
	// Without a state, send the browser to the app first; the app origin sets the cookie and comes back here.
	const state = url.searchParams.get('state') ?? ''
	if (decideAppsOpen(state) === 'bounce') {
		return new Response(null, { status: 302, headers: { location: `${base}/`, 'cache-control': 'no-store' } })
	}
	const token = await mintHandoff(env.KODY_MASTER_KEY, {
		uid: session.user.id,
		pkg: pkg.name,
		sid: session.session.id,
		st: state,
	})
	return new Response(null, {
		status: 302,
		headers: {
			location: `${base}/?${handoffParam}=${encodeURIComponent(token)}`,
			'cache-control': 'no-store',
			'referrer-policy': 'no-referrer',
		},
	})
}
