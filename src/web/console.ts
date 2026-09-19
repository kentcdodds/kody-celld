import { aiConfigFromEnv, describeAiConfig } from '../ai/config.ts'
import { assertSameOrigin } from '../auth/cookies.ts'
import { constantTimeEqualString } from '../auth/password.ts'
import { blobConfigFromEnv, describeBlobConfig } from '../blobs/config.ts'
import { browserConfigFromEnv, describeBrowserConfig } from '../browser/config.ts'
import { describeEmailConfig } from '../email/config.ts'
import { describeNpmConfig, npmConfigFromEnv } from '../execute/npm-config.ts'
import { loadEmailConfig } from '../email/service.ts'
import type { AuditEntry } from '../cells/registry-cell.ts'
import { KODY_CELLD_VERSION, type Env } from '../env.ts'
import { getUserCell } from '../execute/engine.ts'
import { dispatchDueJobs } from '../jobs/dispatcher.ts'
import { recordAudit } from '../lib/audit.ts'
import { KodyError } from '../lib/errors.ts'
import { renderPage } from '#app/render.tsx'
import { type AppSession } from '#universal/app-session.ts'
import { type AppLoaderData, type PageFlash } from '#universal/loader-data.ts'
import { appSessionOf, readForm, redirect } from './http.ts'
import { endConsoleSession, readConsoleSession, readWebSession, startConsoleSession } from './session.ts'
import { issueSigninLink } from './signin.ts'

const registry = (env: Env) => env.REGISTRY.getByName('registry')

export function isConsoleRoute(pathname: string) {
	return pathname === '/console' || pathname.startsWith('/console/')
}

function view(
	shellSession: AppSession | null,
	input: { title: string; current: string; data: AppLoaderData; flash?: PageFlash | null },
) {
	return renderPage({
		title: input.title,
		pathname: input.current,
		session: shellSession,
		flash: input.flash ?? null,
		data: input.data,
	})
}

/**
 * Operator UI over the same operations as the JSON `/admin` API. Signing in
 * requires KODY_ADMIN_TOKEN; the console cookie is scoped to /console.
 */
export async function handleConsole(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
	const segments = url.pathname.split('/').filter(Boolean).slice(1) // after 'console'
	const post = request.method === 'POST'
	const form = post ? await readForm(request) : {}
	if (post) assertSameOrigin(request, env.KODY_PUBLIC_URL)

	if (segments[0] === 'signin' && post) {
		if (!constantTimeEqualString(form.token ?? '', env.KODY_ADMIN_TOKEN)) {
			await recordAudit(env, { actor: 'anonymous', action: 'console.signin_failed', target: null, details: null })
			return signinPage('Admin token does not match.')
		}
		await recordAudit(env, { actor: 'admin', action: 'console.signin', target: null, details: null })
		return redirect('/console', { 'set-cookie': await startConsoleSession(env) })
	}

	const session = await readConsoleSession(request, env)
	if (!session) return signinPage(null)
	// The site header shows whoever is signed in as a user in this browser; the console cookie is separate.
	const shellSession = appSessionOf(await readWebSession(request, env), { isAdmin: true })
	if (post && !constantTimeEqualString(form.csrf ?? '', session.csrf)) {
		throw new KodyError('csrf_mismatch', 'This form has expired. Reload the page and try again.', { status: 403 })
	}
	const audit = (action: string, target: string | null, details: Record<string, unknown> | null = null) =>
		recordAudit(env, { actor: 'admin', action, target, details })
	const flashParam = url.searchParams.get('flash')
	const flash = flashParam ? { kind: 'ok' as const, text: flashParam.slice(0, 200) } : null

	if (segments[0] === 'signout' && post) {
		return redirect('/console', { 'set-cookie': endConsoleSession(env) })
	}

	if (segments.length === 0) {
		let issued: { kind: 'invite' | 'token'; email: string; value: string; expiresAt: string | null } | null = null
		if (post) {
			if (form.action === 'create') {
				if (!form.email) throw new KodyError('invalid_args', 'Email is required.')
				const created = await registry(env).createUser({ email: form.email })
				await getUserCell(env, created.user.id).init(created.user.id)
				await audit(created.created ? 'user.create' : 'user.invite', created.user.id, {
					email: created.user.email,
					via: 'console',
				})
				const link = await issueSigninLink(env, { userId: created.user.id, kind: 'invite' })
				issued = { kind: 'invite', email: created.user.email, value: link.url, expiresAt: link.expiresAt }
			} else if (form.action === 'invite' && form.userId) {
				const user = await requireUser(env, form.userId)
				const link = await issueSigninLink(env, { userId: user.id, kind: form.reset === 'true' ? 'reset' : 'invite' })
				await audit('user.invite', user.id, { kind: form.reset === 'true' ? 'reset' : 'invite' })
				issued = { kind: 'invite', email: user.email, value: link.url, expiresAt: link.expiresAt }
			} else if (form.action === 'token' && form.userId) {
				const user = await requireUser(env, form.userId)
				const token = await registry(env).issueToken(user.id, (form.label ?? '').trim() || 'admin-issued')
				await audit('token.issue', user.id, { label: form.label || 'admin-issued', via: 'console' })
				issued = { kind: 'token', email: user.email, value: token, expiresAt: null }
			} else if (form.action === 'dispatch') {
				const summary = await dispatchDueJobs(env, ctx.exports)
				await audit('jobs.dispatch', null, { ran: summary.ran.length, via: 'console' })
				return redirect(`/console?flash=${encodeURIComponent(`Dispatched ${summary.ran.length} due job(s).`)}`)
			}
		}
		const users = await registry(env).listUsers()
		return view(shellSession, {
			title: 'Users',
			current: '/console',
			flash,
			data: {
				page: 'adminUsers',
				csrf: session.csrf,
				users: users.map((user) => ({ id: user.id, email: user.email, createdAt: user.createdAt })),
				issued: issued
					? { kind: issued.kind, label: issued.email, value: issued.value, expiresAt: issued.expiresAt }
					: null,
			},
		})
	}

	if (segments[0] === 'users' && segments[1]) {
		const user = await requireUser(env, decodeURIComponent(segments[1]))
		const userCell = getUserCell(env, user.id)
		await userCell.init(user.id)
		const base = `/console/users/${encodeURIComponent(user.id)}`
		if (post) {
			if (form.action === 'approve_host' && form.host) {
				const approved = await userCell.secretHostApprove({ host: form.host, approvedBy: 'admin' })
				await audit('secret_host.approve', user.id, { host: approved.host, via: 'console' })
				return redirect(`${base}?flash=${encodeURIComponent(`Approved ${approved.host}.`)}`)
			}
			if (form.action === 'revoke_host' && form.host) {
				const revoked = await userCell.secretHostRevoke({ host: form.host })
				await audit('secret_host.revoke', user.id, { host: revoked.host, revoked: revoked.revoked, via: 'console' })
				return redirect(`${base}?flash=${encodeURIComponent(`Revoked ${revoked.host}.`)}`)
			}
			if (form.action === 'revoke_sessions') {
				await registry(env).sessionRevoke(user.id, null)
				await registry(env).oauthGrantRevokeAll(user.id)
				await audit('user.signout_everywhere', user.id, { via: 'console' })
				return redirect(`${base}?flash=${encodeURIComponent('Signed the user out of every browser and MCP client.')}`)
			}
			return redirect(base)
		}
		const [hosts, usage, tokens, grants, sessions, jobs] = await Promise.all([
			userCell.secretHostList(),
			userCell.usageGet({ days: 7 }),
			registry(env).tokenList(user.id),
			registry(env).oauthGrantList(user.id),
			registry(env).sessionList(user.id),
			userCell.jobList(),
		])
		return view(shellSession, {
			title: user.email,
			current: '/console',
			flash,
			data: {
				page: 'adminUserDetail',
				csrf: session.csrf,
				user: { id: user.id, email: user.email, createdAt: user.createdAt },
				action: base,
				counts: {
					tokens: tokens.length,
					grants: grants.length,
					sessions: sessions.length,
					jobs: jobs.length,
					runsToday: usage.today.runs,
				},
				hosts: hosts.map((host) => ({ host: host.host, approvedAt: host.approvedAt, approvedBy: host.approvedBy })),
				quotas: usage.quotas,
			},
		})
	}

	if (segments[0] === 'audit' && !post) {
		// `details` is Record<string, unknown>, which the RPC type mapper cannot express; the wire value is plain JSON.
		const entries: Array<AuditEntry> = await registry(env).auditList({
			limit: Number(url.searchParams.get('limit') ?? 100),
			actor: url.searchParams.get('actor') ?? undefined,
			action: url.searchParams.get('action') ?? undefined,
		})
		return view(shellSession, {
			title: 'Audit log',
			current: '/console/audit',
			data: {
				page: 'adminAudit',
				csrf: session.csrf,
				entries: entries.map((entry) => ({
					id: entry.id,
					at: entry.at,
					actor: entry.actor,
					action: entry.action,
					target: entry.target,
					details: entry.details ? JSON.stringify(entry.details) : null,
				})),
			},
		})
	}

	if (segments[0] === 'config' && !post) {
		const sections: Array<[string, unknown]> = [
			['ai', describeAiConfig(aiConfigFromEnv(env))],
			['blobs', { ...describeBlobConfig(blobConfigFromEnv(env)), bucketBound: env.BLOBS !== undefined }],
			['browser', describeBrowserConfig(browserConfigFromEnv(env))],
			['email', describeEmailConfig(loadEmailConfig(env))],
			['npm', describeNpmConfig(npmConfigFromEnv(env))],
		]
		return view(shellSession, {
			title: 'Configuration',
			current: '/console/config',
			data: {
				page: 'adminConfig',
				csrf: session.csrf,
				version: KODY_CELLD_VERSION,
				publicUrl: env.KODY_PUBLIC_URL,
				sections: sections.map(([name, value]) => ({ name, json: JSON.stringify(value, null, 2) })),
			},
		})
	}

	throw new KodyError('not_found', `No console page for ${request.method} ${url.pathname}.`, { status: 404 })
}

async function requireUser(env: Env, userId: string) {
	const user = await registry(env).getUser(userId)
	if (!user) throw new KodyError('user_not_found', `User "${userId}" was not found.`, { status: 404 })
	return user
}

function signinPage(error: string | null) {
	return renderPage({
		title: 'Admin console',
		pathname: '/console',
		status: error ? 401 : 200,
		flash: error ? { kind: 'error', text: error } : null,
		data: { page: 'adminLogin' },
	})
}
