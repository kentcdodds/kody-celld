import type { Env } from '../env.ts'
import { getUserCell } from '../execute/engine.ts'
import { recordAudit } from '../lib/audit.ts'
import { KodyError } from '../lib/errors.ts'
import { loadEmailConfig } from '../email/service.ts'
import { formatWhen, html, page, readForm, redirect, type Html } from './html.ts'
import { assertCsrf, readWebSession, type WebSession } from './session.ts'
import { passwordForm } from './signin.ts'

const registry = (env: Env) => env.REGISTRY.getByName('registry')

const nav = [
	{ href: '/account', label: 'Overview' },
	{ href: '/account/clients', label: 'MCP clients' },
	{ href: '/account/tokens', label: 'API tokens' },
	{ href: '/account/secrets', label: 'Secrets' },
	{ href: '/account/packages', label: 'Packages' },
	{ href: '/account/jobs', label: 'Jobs' },
	{ href: '/account/runs', label: 'Runs' },
	{ href: '/account/integrations', label: 'Integrations' },
	{ href: '/account/inbox', label: 'Inbox' },
	{ href: '/account/sessions', label: 'Sessions' },
]

type Flash = { kind: 'ok' | 'error'; text: string } | null

const flashes: Record<string, NonNullable<Flash>> = {
	welcome: { kind: 'ok', text: 'Your account is ready. Connect an MCP client or create an API token to get started.' },
	saved: { kind: 'ok', text: 'Saved.' },
	revoked: { kind: 'ok', text: 'Revoked.' },
	deleted: { kind: 'ok', text: 'Deleted.' },
	password_set: { kind: 'ok', text: 'Password updated.' },
	disconnected: { kind: 'ok', text: 'Disconnected.' },
}

function view(
	session: WebSession,
	input: { title: string; current: string; body: Html; flash?: Flash; status?: number },
) {
	return page({
		title: input.title,
		nav,
		current: input.current,
		who: html`${session.user.email}
			<form method="post" action="/signout"><button class="small" type="submit">Sign out</button></form>`,
		flash: input.flash ?? null,
		...(input.status === undefined ? {} : { status: input.status }),
		body: input.body,
	})
}

function csrfInput(session: WebSession) {
	return html`<input type="hidden" name="csrf" value="${session.csrf}" />`
}

export function isAccountRoute(pathname: string) {
	return pathname === '/account' || pathname.startsWith('/account/')
}

export async function handleAccount(request: Request, env: Env, url: URL): Promise<Response> {
	const session = await readWebSession(request, env)
	if (!session) return redirect(`/signin?flash=signin_required&next=${encodeURIComponent(url.pathname)}`)
	const userCell = getUserCell(env, session.user.id)
	await userCell.init(session.user.id)
	const flash = flashes[url.searchParams.get('flash') ?? ''] ?? null
	const segments = url.pathname.split('/').filter(Boolean).slice(1) // after 'account'
	const section = segments[0] ?? ''
	const post = request.method === 'POST'
	const form = post ? await readForm(request) : {}
	if (post) assertCsrf(request, env, session, form)
	const audit = (action: string, target: string | null, details: Record<string, unknown> | null = null) =>
		recordAudit(env, { actor: `user:${session.user.id}`, action, target, details })

	switch (section) {
		case '': {
			if (post) break
			const usage = await userCell.usageGet({ days: 7 })
			const [grants, tokens, hasPassword] = await Promise.all([
				registry(env).oauthGrantList(session.user.id),
				registry(env).tokenList(session.user.id),
				registry(env).passwordIsSet(session.user.id),
			])
			return view(session, {
				title: 'Account',
				current: '/account',
				flash,
				body: html` <div class="card">
						<p>
							Signed in as <strong>${session.user.email}</strong> · member since ${formatWhen(session.user.createdAt)}
						</p>
						<p>
							MCP endpoint: <code>${env.KODY_PUBLIC_URL}/mcp</code><br />
							<span class="muted small"
								>Add it to any MCP client that supports OAuth (Claude, Cursor, VS Code, …) and approve the connection
								here — no token pasting needed. Clients without OAuth can use an API token.</span
							>
						</p>
						<p class="row">
							<span class="badge">${grants.length} connected client${grants.length === 1 ? '' : 's'}</span>
							<span class="badge">${tokens.length} API token${tokens.length === 1 ? '' : 's'}</span>
							<span class="badge ${hasPassword ? 'ok' : 'warn'}">${hasPassword ? 'password set' : 'no password'}</span>
						</p>
					</div>
					<h2>Today</h2>
					<div class="card">
						<table>
							<tr>
								<th>Runs</th>
								<th>Errors</th>
								<th>Execute time</th>
								<th>Packages</th>
								<th>Secrets</th>
								<th>Jobs</th>
								<th>Blobs</th>
							</tr>
							<tr>
								<td>${usage.today.runs}${usage.quotas.runsPerDay ? html` / ${usage.quotas.runsPerDay}` : ''}</td>
								<td>${usage.today.errors}</td>
								<td>
									${Math.round(usage.today.executeMs / 1000)}
									s${usage.quotas.executeMsPerDay ? html` / ${Math.round(usage.quotas.executeMsPerDay / 1000)} s` : ''}
								</td>
								<td>${usage.counts.packages}${usage.quotas.packages ? html` / ${usage.quotas.packages}` : ''}</td>
								<td>${usage.counts.secrets}${usage.quotas.secrets ? html` / ${usage.quotas.secrets}` : ''}</td>
								<td>${usage.counts.jobs}</td>
								<td>${usage.counts.blobs} (${Math.round(usage.counts.blobBytes / 1024)} KiB)</td>
							</tr>
						</table>
						<p class="muted small">
							Execute timeout ${usage.limits.executeTimeoutMs} ms · runs retained ${usage.limits.runRetentionCount}
						</p>
					</div>
					<h2>Password</h2>
					<div class="card">
						${passwordForm({
							action: '/account/password',
							submit: hasPassword ? 'Change password' : 'Set password',
							requireCurrent: hasPassword,
							csrf: session.csrf,
						})}
					</div>`,
			})
		}

		case 'password': {
			if (!post) return redirect('/account')
			const hasPassword = await registry(env).passwordIsSet(session.user.id)
			if (hasPassword) {
				const ok = await registry(env).passwordSignin({ email: session.user.email, password: form.current ?? '' })
				if (!ok) throw new KodyError('invalid_password', 'Current password is wrong.', { status: 403 })
			}
			if (!form.password || form.password !== form.confirm) {
				throw new KodyError('invalid_args', 'Passwords do not match.')
			}
			await registry(env).passwordSet(session.user.id, form.password)
			await audit('password.set', null)
			return redirect('/account?flash=password_set')
		}

		case 'clients': {
			if (post) {
				if (form.action === 'revoke' && form.grantId) {
					await registry(env).oauthGrantRevoke(session.user.id, form.grantId)
					await audit('mcp_client.revoke', form.grantId)
				} else if (form.action === 'revoke_all') {
					await registry(env).oauthGrantRevokeAll(session.user.id)
					await audit('mcp_client.revoke_all', null)
				}
				return redirect('/account/clients?flash=revoked')
			}
			const grants = await registry(env).oauthGrantList(session.user.id)
			return view(session, {
				title: 'MCP clients',
				current: '/account/clients',
				flash,
				body: html` <p class="muted">
						Applications you approved through OAuth. Revoking a client invalidates its access and refresh tokens
						immediately; it will have to ask for approval again.
					</p>
					<div class="card">
						${
							grants.length === 0
								? html`<p class="muted">
										No connected clients yet. Point an MCP client at <code>${env.KODY_PUBLIC_URL}/mcp</code>.
									</p>`
								: html`<table>
											<tr>
												<th>Client</th>
												<th>Approved</th>
												<th>Last used</th>
												<th>Active devices</th>
												<th></th>
											</tr>
											${grants.map(
												(grant) =>
													html`<tr>
														<td>
															<strong>${grant.clientName}</strong><br /><span class="muted small"
																><code>${grant.clientId}</code></span
															>
														</td>
														<td>${formatWhen(grant.createdAt)}</td>
														<td>${formatWhen(grant.lastUsedAt)}</td>
														<td>${grant.activeFamilies}</td>
														<td>
															<form method="post" action="/account/clients">
																${csrfInput(session)}
																<input type="hidden" name="action" value="revoke" />
																<input type="hidden" name="grantId" value="${grant.id}" />
																<button class="small danger" type="submit">Revoke</button>
															</form>
														</td>
													</tr>`,
											)}
										</table>
										<form method="post" action="/account/clients" style="margin-top:12px">
											${csrfInput(session)}
											<input type="hidden" name="action" value="revoke_all" />
											<button class="danger" type="submit">Revoke all clients</button>
										</form>`
						}
					</div>`,
			})
		}

		case 'tokens': {
			let issued: { token: string; label: string } | null = null
			if (post) {
				if (form.action === 'create') {
					const label = (form.label ?? '').trim() || 'web'
					const token = await registry(env).issueToken(session.user.id, label)
					await audit('token.issue', null, { label, via: 'web' })
					issued = { token, label }
				} else if (form.action === 'revoke' && form.tokenId) {
					await registry(env).tokenRevoke(session.user.id, form.tokenId)
					await audit('token.revoke', form.tokenId)
					return redirect('/account/tokens?flash=revoked')
				}
			}
			const tokens = await registry(env).tokenList(session.user.id)
			return view(session, {
				title: 'API tokens',
				current: '/account/tokens',
				flash,
				body: html` ${
						issued
							? html`<div class="card">
									<p><strong>New token "${issued.label}"</strong> — copy it now, it is not shown again:</p>
									<pre class="secret">${issued.token}</pre>
									<p class="muted small">
										Use as <code>Authorization: Bearer …</code> against <code>${env.KODY_PUBLIC_URL}/mcp</code> or
										<code>/api</code>.
									</p>
								</div>`
							: ''
					}
					<div class="card">
						<table>
							<tr>
								<th>Label</th>
								<th>Id</th>
								<th>Created</th>
								<th>Last used</th>
								<th></th>
							</tr>
							${
								tokens.length === 0
									? html`<tr>
											<td colspan="5" class="muted">No API tokens.</td>
										</tr>`
									: ''
							}
							${tokens.map(
								(token) =>
									html`<tr>
										<td>${token.label}</td>
										<td><code>${token.id}</code></td>
										<td>${formatWhen(token.createdAt)}</td>
										<td>${formatWhen(token.lastUsedAt)}</td>
										<td>
											<form method="post" action="/account/tokens">
												${csrfInput(session)}
												<input type="hidden" name="action" value="revoke" />
												<input type="hidden" name="tokenId" value="${token.id}" />
												<button class="small danger" type="submit">Revoke</button>
											</form>
										</td>
									</tr>`,
							)}
						</table>
					</div>
					<h2>Create a token</h2>
					<div class="card">
						<form method="post" action="/account/tokens" class="stack">
							${csrfInput(session)}
							<input type="hidden" name="action" value="create" />
							<label>Label <input name="label" placeholder="laptop, CI, my-script" maxlength="80" /></label>
							<div><button class="primary" type="submit">Create token</button></div>
						</form>
					</div>`,
			})
		}

		case 'secrets': {
			if (post) {
				if (form.action === 'save') {
					if (!form.name || !form.value) throw new KodyError('invalid_args', 'Name and value are required.')
					await userCell.secretSave({
						name: form.name,
						value: form.value,
						description: form.description || undefined,
					})
					await audit('secret.save', form.name, { via: 'web' })
					return redirect('/account/secrets?flash=saved')
				}
				if (form.action === 'delete' && form.name) {
					await userCell.secretDelete({
						name: form.name,
						...(form.packageName ? { scope: 'package' as const, packageName: form.packageName } : {}),
					})
					await audit('secret.delete', form.name, { via: 'web' })
					return redirect('/account/secrets?flash=deleted')
				}
				return redirect('/account/secrets')
			}
			const [secrets, hosts] = await Promise.all([userCell.secretList(), userCell.secretHostList()])
			return view(session, {
				title: 'Secrets',
				current: '/account/secrets',
				flash,
				body: html` <p class="muted">
						Values are encrypted at rest and only ever injected into outbound requests to approved hosts by the fetch
						gateway. Reference them in code as <code>{{secret:NAME}}</code>.
					</p>
					<div class="card">
						<table>
							<tr>
								<th>Name</th>
								<th>Scope</th>
								<th>Description</th>
								<th>Updated</th>
								<th></th>
							</tr>
							${
								secrets.length === 0
									? html`<tr>
											<td colspan="5" class="muted">No secrets yet.</td>
										</tr>`
									: ''
							}
							${secrets.map(
								(secret) =>
									html`<tr>
										<td><code>${secret.name}</code></td>
										<td>
											${secret.scope}${secret.packageName ? html` <span class="muted small">(${secret.packageName})</span>` : ''}
										</td>
										<td>${secret.description ?? html`<span class="muted">—</span>`}</td>
										<td>${formatWhen(secret.updatedAt)}</td>
										<td>
											<form method="post" action="/account/secrets">
												${csrfInput(session)}
												<input type="hidden" name="action" value="delete" />
												<input type="hidden" name="name" value="${secret.name}" />
												<input type="hidden" name="packageName" value="${secret.packageName ?? ''}" />
												<button class="small danger" type="submit">Delete</button>
											</form>
										</td>
									</tr>`,
							)}
						</table>
					</div>
					<h2>Add or replace a secret</h2>
					<div class="card">
						<form method="post" action="/account/secrets" class="stack" autocomplete="off">
							${csrfInput(session)}
							<input type="hidden" name="action" value="save" />
							<label>Name <input name="name" pattern="[a-zA-Z0-9._-]+" placeholder="GITHUB_TOKEN" required /></label>
							<label>Value <textarea name="value" required spellcheck="false"></textarea></label>
							<label>Description <input name="description" placeholder="what it is for" /></label>
							<div><button class="primary" type="submit">Save secret</button></div>
						</form>
					</div>
					<h2>Approved hosts</h2>
					<div class="card">
						<p class="muted small">
							Secrets are only injected into requests to these hosts. Approvals are made by the operator (admin console)
							— ask them to approve a new host.
						</p>
						${
							hosts.length === 0
								? html`<p class="muted">No approved hosts.</p>`
								: html`<table>
										<tr>
											<th>Host</th>
											<th>Approved</th>
											<th>By</th>
										</tr>
										${hosts.map(
											(host) =>
												html`<tr>
													<td><code>${host.host}</code></td>
													<td>${formatWhen(host.approvedAt)}</td>
													<td>${host.approvedBy}</td>
												</tr>`,
										)}
									</table>`
						}
					</div>`,
			})
		}

		case 'packages': {
			if (post) {
				if (form.action === 'delete' && form.name) {
					await userCell.packageDelete(form.name)
					await audit('package.delete', form.name, { via: 'web' })
				}
				return redirect('/account/packages?flash=deleted')
			}
			const packages = await userCell.packageList()
			return view(session, {
				title: 'Packages',
				current: '/account/packages',
				flash,
				body: html`<div class="card">
					<table>
						<tr>
							<th>Name</th>
							<th>Version</th>
							<th>Files</th>
							<th>Jobs</th>
							<th>Updated</th>
							<th></th>
						</tr>
						${
							packages.length === 0
								? html`<tr>
										<td colspan="6" class="muted">
											No packages saved. Use <code>packageSave</code> from an MCP client.
										</td>
									</tr>`
								: ''
						}
						${packages.map(
							(pkg) =>
								html`<tr>
									<td>
										<strong>${pkg.name}</strong
										>${pkg.manifest.description ? html`<br /><span class="muted small">${pkg.manifest.description}</span>` : ''}
									</td>
									<td>${pkg.version}</td>
									<td>${pkg.fileCount}</td>
									<td>${Object.keys(pkg.manifest.jobs ?? {}).length}</td>
									<td>${formatWhen(pkg.updatedAt)}</td>
									<td>
										<form method="post" action="/account/packages">
											${csrfInput(session)}
											<input type="hidden" name="action" value="delete" />
											<input type="hidden" name="name" value="${pkg.name}" />
											<button class="small danger" type="submit">Delete</button>
										</form>
									</td>
								</tr>`,
						)}
					</table>
				</div>`,
			})
		}

		case 'jobs': {
			if (post) {
				if (form.action === 'toggle' && form.id) {
					await userCell.jobUpdate({ id: form.id, enabled: form.enabled === 'true' })
					await audit('job.update', form.id, { enabled: form.enabled === 'true', via: 'web' })
				}
				return redirect('/account/jobs?flash=saved')
			}
			const jobs = await userCell.jobList()
			return view(session, {
				title: 'Jobs',
				current: '/account/jobs',
				flash,
				body: html`<div class="card">
					<table>
						<tr>
							<th>Job</th>
							<th>Schedule</th>
							<th>Next run</th>
							<th>Last run</th>
							<th>Status</th>
							<th></th>
						</tr>
						${
							jobs.length === 0
								? html`<tr>
										<td colspan="6" class="muted">No jobs. Jobs come from package manifests.</td>
									</tr>`
								: ''
						}
						${jobs.map(
							(job) =>
								html`<tr>
									<td>
										<strong>${job.packageName}/${job.jobName}</strong
										>${job.description ? html`<br /><span class="muted small">${job.description}</span>` : ''}
									</td>
									<td>
										<code>${JSON.stringify(job.schedule)}</code
										>${job.timezone ? html` <span class="muted small">${job.timezone}</span>` : ''}
									</td>
									<td>${job.enabled ? formatWhen(job.nextRunAt) : html`<span class="muted">paused</span>`}</td>
									<td>${formatWhen(job.lastRunAt)}</td>
									<td>
										${job.lastStatus ?? '—'}${job.lastError ? html`<br /><span class="small" style="color:var(--danger)">${job.lastError}</span>` : ''}
									</td>
									<td>
										<form method="post" action="/account/jobs">
											${csrfInput(session)}
											<input type="hidden" name="action" value="toggle" />
											<input type="hidden" name="id" value="${job.id}" />
											<input type="hidden" name="enabled" value="${job.enabled ? 'false' : 'true'}" />
											<button class="small" type="submit">${job.enabled ? 'Pause' : 'Resume'}</button>
										</form>
									</td>
								</tr>`,
						)}
					</table>
				</div>`,
			})
		}

		case 'runs': {
			if (post) break
			const runs = await userCell.runList({ limit: 50 })
			return view(session, {
				title: 'Runs',
				current: '/account/runs',
				body: html`<div class="card">
					<table>
						<tr>
							<th>When</th>
							<th>Kind</th>
							<th>Package</th>
							<th>Status</th>
							<th>Duration</th>
							<th>Error</th>
						</tr>
						${
							runs.length === 0
								? html`<tr>
										<td colspan="6" class="muted">No runs yet.</td>
									</tr>`
								: ''
						}
						${runs.map(
							(run) =>
								html`<tr>
									<td>${formatWhen(run.createdAt)}</td>
									<td>${run.kind}</td>
									<td>${run.packageName ?? html`<span class="muted">ad hoc</span>`}</td>
									<td>
										<span class="badge ${run.status === 'success' ? 'ok' : run.status === 'error' ? 'warn' : ''}"
											>${run.status}</span
										>
									</td>
									<td>${run.durationMs === null ? '—' : `${run.durationMs} ms`}</td>
									<td class="small">${run.error ? `${run.error.name}: ${run.error.message}` : ''}</td>
								</tr>`,
						)}
					</table>
				</div>`,
			})
		}

		case 'integrations': {
			if (post) {
				if (form.action === 'disconnect' && form.name) {
					await userCell.integrationDisconnect(form.name)
					await audit('integration.disconnect', form.name, { via: 'web' })
				}
				return redirect('/account/integrations?flash=disconnected')
			}
			const integrations = await userCell.integrationList()
			return view(session, {
				title: 'Integrations',
				current: '/account/integrations',
				flash,
				body: html`<p class="muted">
						OAuth connections to third-party APIs (<code>{{integration-token:name}}</code>). Configure and connect them
						from an MCP client with <code>integrationSave</code> / <code>integrationConnect</code>.
					</p>
					<div class="card">
						<table>
							<tr>
								<th>Name</th>
								<th>Provider</th>
								<th>Status</th>
								<th>Expires</th>
								<th>Hosts</th>
								<th></th>
							</tr>
							${
								integrations.length === 0
									? html`<tr>
											<td colspan="6" class="muted">No integrations.</td>
										</tr>`
									: ''
							}
							${integrations.map(
								(integration) =>
									html`<tr>
										<td><strong>${integration.name}</strong></td>
										<td>${integration.provider}</td>
										<td>
											<span class="badge ${integration.status === 'connected' ? 'ok' : 'warn'}"
												>${integration.status}</span
											>
										</td>
										<td>${formatWhen(integration.expiresAt)}</td>
										<td class="small">${integration.allowedHosts.join(', ')}</td>
										<td>
											${
												integration.status === 'connected'
													? html`<form method="post" action="/account/integrations">
															${csrfInput(session)}
															<input type="hidden" name="action" value="disconnect" />
															<input type="hidden" name="name" value="${integration.name}" />
															<button class="small danger" type="submit">Disconnect</button>
														</form>`
													: ''
											}
										</td>
									</tr>`,
							)}
						</table>
					</div>`,
			})
		}

		case 'inbox': {
			if (post) break
			const config = loadEmailConfig(env)
			if (!config) {
				return view(session, {
					title: 'Inbox',
					current: '/account/inbox',
					body: html`<div class="card">
						<p class="muted">Email is not configured on this server (<code>KODY_EMAIL_DOMAIN</code>).</p>
					</div>`,
				})
			}
			const [locals, messages] = await Promise.all([
				registry(env).inboxListForUser(session.user.id),
				userCell.emailMessageList({ limit: 50 }),
			])
			return view(session, {
				title: 'Inbox',
				current: '/account/inbox',
				body: html`<div class="card">
						<p>
							Addresses:
							${
								locals.length === 0
									? html`<span class="muted">none claimed (use <code>emailInboxClaim</code>)</span>`
									: locals.map((local) => html`<code>${local.local}@${config.domain}</code> `)
							}
						</p>
					</div>
					<div class="card">
						<table>
							<tr>
								<th>Received</th>
								<th>From</th>
								<th>Subject</th>
								<th>Class</th>
								<th>Size</th>
							</tr>
							${
								messages.length === 0
									? html`<tr>
											<td colspan="5" class="muted">No messages.</td>
										</tr>`
									: ''
							}
							${messages.map(
								(message) =>
									html`<tr>
										<td>${formatWhen(message.receivedAt)}</td>
										<td>
											${message.direction === 'outbound' ? html`<span class="muted">→</span> ${message.to.map((t) => t.address).join(', ')}` : message.from.address}
										</td>
										<td>${message.subject}<br /><span class="muted small">${message.snippet}</span></td>
										<td>${message.classification ?? message.direction}</td>
										<td>${Math.round(message.sizeBytes / 1024)} KiB</td>
									</tr>`,
							)}
						</table>
					</div>`,
			})
		}

		case 'sessions': {
			if (post) {
				if (form.action === 'revoke' && form.sessionId) {
					await registry(env).sessionRevoke(session.user.id, form.sessionId)
				} else if (form.action === 'revoke_others') {
					const all = await registry(env).sessionList(session.user.id)
					for (const other of all) {
						if (other.id !== session.session.id) await registry(env).sessionRevoke(session.user.id, other.id)
					}
				}
				await audit('session.revoke', form.sessionId ?? null)
				return redirect(
					form.sessionId === session.session.id ? '/signin?flash=signed_out' : '/account/sessions?flash=revoked',
				)
			}
			const sessions = await registry(env).sessionList(session.user.id)
			return view(session, {
				title: 'Browser sessions',
				current: '/account/sessions',
				flash,
				body: html`<div class="card">
					<table>
						<tr>
							<th>Device</th>
							<th>Signed in</th>
							<th>Last seen</th>
							<th>Expires</th>
							<th></th>
						</tr>
						${sessions.map(
							(item) =>
								html`<tr>
									<td class="small">
										${item.userAgent ?? 'unknown'}${item.id === session.session.id ? html` <span class="badge ok">this browser</span>` : ''}
									</td>
									<td>${formatWhen(item.createdAt)}</td>
									<td>${formatWhen(item.lastSeenAt)}</td>
									<td>${formatWhen(item.expiresAt)}</td>
									<td>
										<form method="post" action="/account/sessions">
											${csrfInput(session)}
											<input type="hidden" name="action" value="revoke" />
											<input type="hidden" name="sessionId" value="${item.id}" />
											<button class="small danger" type="submit">
												${item.id === session.session.id ? 'Sign out' : 'Revoke'}
											</button>
										</form>
									</td>
								</tr>`,
						)}
					</table>
					<form method="post" action="/account/sessions" style="margin-top:12px">
						${csrfInput(session)}
						<input type="hidden" name="action" value="revoke_others" />
						<button type="submit">Sign out other browsers</button>
					</form>
				</div>`,
			})
		}
	}
	throw new KodyError('not_found', `No account page for ${request.method} ${url.pathname}.`, { status: 404 })
}
