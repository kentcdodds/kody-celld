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
import { formatWhen, html, page, readForm, redirect, type Html } from './html.ts'
import { endConsoleSession, readConsoleSession, startConsoleSession, type ConsoleSession } from './session.ts'
import { issueSigninLink } from './signin.ts'

const registry = (env: Env) => env.REGISTRY.getByName('registry')

export function isConsoleRoute(pathname: string) {
	return pathname === '/console' || pathname.startsWith('/console/')
}

const nav = [
	{ href: '/console', label: 'Users' },
	{ href: '/console/audit', label: 'Audit log' },
	{ href: '/console/config', label: 'Configuration' },
]

function view(
	session: ConsoleSession,
	input: { title: string; current: string; body: Html; flash?: { kind: 'ok' | 'error'; text: string } | null },
) {
	return page({
		title: input.title,
		nav,
		current: input.current,
		who: html`admin console
			<form method="post" action="/console/signout">
				<input type="hidden" name="csrf" value="${session.csrf}" /><button class="small" type="submit">Sign out</button>
			</form>`,
		flash: input.flash ?? null,
		body: input.body,
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
		return view(session, {
			title: 'Users',
			current: '/console',
			flash,
			body: html` ${
					issued
						? html`<div class="card">
								<p>
									<strong
										>${issued.kind === 'invite' ? 'One-time sign-in link' : 'API token'} for ${issued.email}</strong
									>
									— hand it over out of band; it is not shown
									again${issued.expiresAt ? html` and expires ${formatWhen(issued.expiresAt)}` : ''}.
								</p>
								<pre class="secret">${issued.value}</pre>
							</div>`
						: ''
				}
				<div class="card">
					<table>
						<tr>
							<th>Email</th>
							<th>Id</th>
							<th>Created</th>
							<th></th>
						</tr>
						${
							users.length === 0
								? html`<tr>
										<td colspan="4" class="muted">No users yet.</td>
									</tr>`
								: ''
						}
						${users.map(
							(user) =>
								html`<tr>
									<td>${user.email}</td>
									<td><code>${user.id}</code></td>
									<td>${formatWhen(user.createdAt)}</td>
									<td class="row">
										<a class="button small" href="/console/users/${encodeURIComponent(user.id)}">Manage</a>
										<form method="post" action="/console">
											<input type="hidden" name="csrf" value="${session.csrf}" />
											<input type="hidden" name="action" value="invite" />
											<input type="hidden" name="userId" value="${user.id}" />
											<button class="small" type="submit">Sign-in link</button>
										</form>
										<form method="post" action="/console">
											<input type="hidden" name="csrf" value="${session.csrf}" />
											<input type="hidden" name="action" value="token" />
											<input type="hidden" name="userId" value="${user.id}" />
											<button class="small" type="submit">API token</button>
										</form>
									</td>
								</tr>`,
						)}
					</table>
				</div>
				<h2>Add a user</h2>
				<div class="card">
					<p class="muted small">
						Creates the account and a one-time invite link (valid 7 days) the person uses to set a password.
					</p>
					<form method="post" action="/console" class="stack">
						<input type="hidden" name="csrf" value="${session.csrf}" />
						<input type="hidden" name="action" value="create" />
						<label>Email <input name="email" type="email" required /></label>
						<div><button class="primary" type="submit">Create and invite</button></div>
					</form>
				</div>
				<h2>Jobs</h2>
				<div class="card">
					<form method="post" action="/console" class="row">
						<input type="hidden" name="csrf" value="${session.csrf}" />
						<input type="hidden" name="action" value="dispatch" />
						<button type="submit">Run due jobs now</button>
						<span class="muted small">Same as the cron trigger firing.</span>
					</form>
				</div>`,
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
		return view(session, {
			title: user.email,
			current: '/console',
			flash,
			body: html` <div class="card">
					<p><code>${user.id}</code> · created ${formatWhen(user.createdAt)}</p>
					<p class="row">
						<span class="badge">${tokens.length} API tokens</span>
						<span class="badge">${grants.length} MCP clients</span>
						<span class="badge">${sessions.length} browser sessions</span>
						<span class="badge">${jobs.length} jobs</span>
						<span class="badge">${usage.today.runs} runs today</span>
					</p>
					<form method="post" action="${base}">
						<input type="hidden" name="csrf" value="${session.csrf}" />
						<input type="hidden" name="action" value="revoke_sessions" />
						<button class="danger" type="submit">Sign out everywhere</button>
					</form>
				</div>
				<h2>Approved secret hosts</h2>
				<div class="card">
					<p class="muted small">
						Only the operator can approve hosts; secrets are injected solely into requests to these hosts.
					</p>
					<table>
						<tr>
							<th>Host</th>
							<th>Approved</th>
							<th>By</th>
							<th></th>
						</tr>
						${
							hosts.length === 0
								? html`<tr>
										<td colspan="4" class="muted">None.</td>
									</tr>`
								: ''
						}
						${hosts.map(
							(host) =>
								html`<tr>
									<td><code>${host.host}</code></td>
									<td>${formatWhen(host.approvedAt)}</td>
									<td>${host.approvedBy}</td>
									<td>
										<form method="post" action="${base}">
											<input type="hidden" name="csrf" value="${session.csrf}" />
											<input type="hidden" name="action" value="revoke_host" />
											<input type="hidden" name="host" value="${host.host}" />
											<button class="small danger" type="submit">Revoke</button>
										</form>
									</td>
								</tr>`,
						)}
					</table>
					<form method="post" action="${base}" class="row" style="margin-top:12px">
						<input type="hidden" name="csrf" value="${session.csrf}" />
						<input type="hidden" name="action" value="approve_host" />
						<input name="host" placeholder="api.example.com" required style="max-width:320px" />
						<button class="primary" type="submit">Approve host</button>
					</form>
				</div>
				<h2>Quotas</h2>
				<div class="card">
					<table>
						<tr>
							<th>Runs / day</th>
							<th>Execute ms / day</th>
							<th>Packages</th>
							<th>Secrets</th>
						</tr>
						<tr>
							<td>${usage.quotas.runsPerDay || 'unlimited'}</td>
							<td>${usage.quotas.executeMsPerDay || 'unlimited'}</td>
							<td>${usage.quotas.packages || 'unlimited'}</td>
							<td>${usage.quotas.secrets || 'unlimited'}</td>
						</tr>
					</table>
					<p class="muted small">Override with <code>PUT /admin/users/${user.id}/quota</code>.</p>
				</div>`,
		})
	}

	if (segments[0] === 'audit' && !post) {
		// `details` is Record<string, unknown>, which the RPC type mapper cannot express; the wire value is plain JSON.
		const entries: Array<AuditEntry> = await registry(env).auditList({
			limit: Number(url.searchParams.get('limit') ?? 100),
			actor: url.searchParams.get('actor') ?? undefined,
			action: url.searchParams.get('action') ?? undefined,
		})
		return view(session, {
			title: 'Audit log',
			current: '/console/audit',
			body: html`<div class="card">
				<table>
					<tr>
						<th>When</th>
						<th>Actor</th>
						<th>Action</th>
						<th>Target</th>
						<th>Details</th>
					</tr>
					${entries.map(
						(entry) =>
							html`<tr>
								<td>${formatWhen(entry.at)}</td>
								<td>${entry.actor}</td>
								<td><code>${entry.action}</code></td>
								<td class="small">${entry.target ?? ''}</td>
								<td class="small"><code>${entry.details ? JSON.stringify(entry.details) : ''}</code></td>
							</tr>`,
					)}
				</table>
			</div>`,
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
		return view(session, {
			title: 'Configuration',
			current: '/console/config',
			body: html`<div class="card">
					<p>
						kody-celld ${KODY_CELLD_VERSION} · public URL <code>${env.KODY_PUBLIC_URL}</code> · MCP
						<code>${env.KODY_PUBLIC_URL}/mcp</code>
					</p>
					<p class="muted small">Adapter settings come from the environment; secrets are never shown here.</p>
				</div>
				${sections.map(
					([name, value]) =>
						html`<h2>${name}</h2>
							<pre>${JSON.stringify(value, null, 2)}</pre>`,
				)}`,
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
	return page({
		title: 'Admin console',
		status: error ? 401 : 200,
		flash: error ? { kind: 'error', text: error } : null,
		body: html`<div class="card">
			<p>
				Sign in with the deployment's <code>KODY_ADMIN_TOKEN</code>. Looking for your own account?
				<a href="/signin">User sign-in</a>.
			</p>
			<form method="post" action="/console/signin" class="stack">
				<label>Admin token <input name="token" type="password" autocomplete="off" required /></label>
				<div><button class="primary" type="submit">Sign in</button></div>
			</form>
		</div>`,
	})
}
