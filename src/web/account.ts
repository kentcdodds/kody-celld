import type { Env } from '../env.ts'
import { getUserCell } from '../execute/engine.ts'
import { recordAudit } from '../lib/audit.ts'
import { KodyError } from '../lib/errors.ts'
import { loadEmailConfig } from '../email/service.ts'
import { defaultPublisher } from '../capabilities/community.ts'
import { fetchPackageSource, packageSourceHostsFromEnv, parsePackageSource } from '../packages/install.ts'
import { renderPage } from '#app/render.tsx'
import { type AppLoaderData, type PageFlash } from '#universal/loader-data.ts'
import { appSessionOf, readForm, redirect } from './http.ts'
import { assertCsrf, readWebSession, type WebSession } from './session.ts'
import { passwordFormView } from './signin.ts'

const registry = (env: Env) => env.REGISTRY.getByName('registry')

const flashes: Record<string, PageFlash> = {
	welcome: { kind: 'ok', text: 'Your account is ready. Connect an MCP client or create an API token to get started.' },
	saved: { kind: 'ok', text: 'Saved.' },
	revoked: { kind: 'ok', text: 'Revoked.' },
	deleted: { kind: 'ok', text: 'Deleted.' },
	password_set: { kind: 'ok', text: 'Password updated.' },
	disconnected: { kind: 'ok', text: 'Disconnected.' },
	installed: { kind: 'ok', text: 'Package installed.' },
	published: { kind: 'ok', text: 'Published to the community catalog.' },
	unpublished: { kind: 'ok', text: 'Removed from the community catalog.' },
}

function view(
	session: WebSession,
	input: { title: string; current: string; data: AppLoaderData; flash?: PageFlash | null; status?: number },
) {
	return renderPage({
		title: input.title,
		pathname: input.current,
		session: appSessionOf(session),
		flash: input.flash ?? null,
		...(input.status === undefined ? {} : { status: input.status }),
		data: input.data,
	})
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
				data: {
					page: 'account',
					csrf: session.csrf,
					email: session.user.email,
					createdAt: session.user.createdAt,
					publicUrl: env.KODY_PUBLIC_URL,
					grantCount: grants.length,
					tokenCount: tokens.length,
					hasPassword,
					usage,
					passwordForm: passwordFormView({
						action: '/account/password',
						submit: hasPassword ? 'Change password' : 'Set password',
						requireCurrent: hasPassword,
					}),
				},
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
				data: {
					page: 'accountMcpOauthClients',
					csrf: session.csrf,
					publicUrl: env.KODY_PUBLIC_URL,
					grants: grants.map((grant) => ({
						id: grant.id,
						clientId: grant.clientId,
						clientName: grant.clientName,
						createdAt: grant.createdAt,
						lastUsedAt: grant.lastUsedAt,
						activeFamilies: grant.activeFamilies,
					})),
				},
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
				data: {
					page: 'accountApiTokens',
					csrf: session.csrf,
					publicUrl: env.KODY_PUBLIC_URL,
					tokens: tokens.map((token) => ({
						id: token.id,
						label: token.label,
						createdAt: token.createdAt,
						lastUsedAt: token.lastUsedAt,
					})),
					issued: issued ? { kind: 'token', label: issued.label, value: issued.token, expiresAt: null } : null,
				},
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
				data: {
					page: 'accountSecrets',
					csrf: session.csrf,
					secrets: secrets.map((secret) => ({
						name: secret.name,
						scope: secret.scope,
						packageName: secret.packageName ?? null,
						description: secret.description ?? null,
						updatedAt: secret.updatedAt,
					})),
					hosts: hosts.map((host) => ({ host: host.host, approvedAt: host.approvedAt, approvedBy: host.approvedBy })),
				},
			})
		}

		case 'packages': {
			let installError: string | null = null
			if (post) {
				if (form.action === 'delete' && form.name) {
					await userCell.packageDelete(form.name)
					await audit('package.delete', form.name, { via: 'web' })
					return redirect('/account/packages?flash=deleted')
				}
				if (form.action === 'publish' && form.name) {
					const pkg = await userCell.packageGet(form.name)
					if (!pkg) throw new KodyError('package_not_found', `Package "${form.name}" is not saved.`, { status: 404 })
					try {
						const listing = await registry(env).communityPublish({
							userId: session.user.id,
							publisher: defaultPublisher(session.user.email),
							name: pkg.name,
							version: pkg.version,
							manifest: pkg.manifest,
							files: pkg.files,
						})
						await audit('community.publish', listing.name, { version: listing.version, via: 'web' })
						return redirect('/account/packages?flash=published')
					} catch (error) {
						installError = KodyError.fromUnknown(error)?.message ?? 'Publish failed.'
					}
				}
				if (form.action === 'unpublish' && form.name) {
					const removed = await registry(env).communityUnpublish({ userId: session.user.id, name: form.name })
					if (removed) await audit('community.unpublish', form.name, { via: 'web' })
					return redirect('/account/packages?flash=unpublished')
				}
				if (form.action === 'install' && form.source) {
					try {
						const source = parsePackageSource(form.source, form.subdir || null)
						const fetched = await fetchPackageSource(source, { allowedHosts: packageSourceHostsFromEnv(env) })
						const saved = await userCell.packageSave({ files: fetched.files, source: fetched.source })
						await audit('package.install', saved.name, { version: saved.version, source: fetched.source, via: 'web' })
						return redirect('/account/packages?flash=installed')
					} catch (error) {
						installError = KodyError.fromUnknown(error)?.message ?? 'Install failed.'
					}
				}
			}
			const [packages, published] = await Promise.all([
				userCell.packageList(),
				registry(env).communityListByUser(session.user.id),
			])
			const publishedByName = new Map(published.map((listing) => [listing.name, listing]))
			return view(session, {
				title: 'Packages',
				current: '/account/packages',
				flash,
				data: {
					page: 'accountPackages',
					csrf: session.csrf,
					sourceHosts: packageSourceHostsFromEnv(env),
					installError,
					installDraft: installError
						? { source: form.source ?? '', subdir: form.subdir ?? '' }
						: { source: '', subdir: '' },
					packages: packages.map((pkg) => {
						const listing = publishedByName.get(pkg.name)
						return {
							name: pkg.name,
							version: pkg.version,
							description: pkg.manifest.description ?? null,
							source: pkg.source,
							fileCount: pkg.fileCount,
							jobCount: Object.keys(pkg.manifest.jobs ?? {}).length,
							hidden: pkg.manifest.hidden === true,
							updatedAt: pkg.updatedAt,
							published: listing ? { version: listing.version } : null,
						}
					}),
				},
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
				data: {
					page: 'accountJobs',
					csrf: session.csrf,
					jobs: jobs.map((job) => ({
						id: job.id,
						packageName: job.packageName,
						jobName: job.jobName,
						description: job.description ?? null,
						schedule: JSON.stringify(job.schedule),
						timezone: job.timezone ?? null,
						enabled: job.enabled,
						nextRunAt: job.nextRunAt,
						lastRunAt: job.lastRunAt,
						lastStatus: job.lastStatus,
						lastError: job.lastError,
					})),
				},
			})
		}

		case 'runs': {
			if (post) break
			const runs = await userCell.runList({ limit: 50 })
			return view(session, {
				title: 'Runs',
				current: '/account/runs',
				data: {
					page: 'accountActivity',
					runs: runs.map((run) => ({
						id: run.id,
						createdAt: run.createdAt,
						kind: run.kind,
						packageName: run.packageName,
						status: run.status,
						durationMs: run.durationMs,
						error: run.error ? `${run.error.name}: ${run.error.message}` : null,
					})),
				},
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
				data: {
					page: 'accountIntegrations',
					csrf: session.csrf,
					integrations: integrations.map((integration) => ({
						name: integration.name,
						provider: integration.provider,
						status: integration.status,
						expiresAt: integration.expiresAt,
						allowedHosts: integration.allowedHosts,
					})),
				},
			})
		}

		case 'inbox': {
			if (post) break
			const config = loadEmailConfig(env)
			if (!config) {
				return view(session, {
					title: 'Inbox',
					current: '/account/inbox',
					data: { page: 'accountEmail', domain: null, addresses: [], messages: [] },
				})
			}
			const [locals, messages] = await Promise.all([
				registry(env).inboxListForUser(session.user.id),
				userCell.emailMessageList({ limit: 50 }),
			])
			return view(session, {
				title: 'Inbox',
				current: '/account/inbox',
				data: {
					page: 'accountEmail',
					domain: config.domain,
					addresses: locals.map((local) => `${local.local}@${config.domain}`),
					messages: messages.map((message) => ({
						id: message.id,
						receivedAt: message.receivedAt,
						direction: message.direction,
						counterpart:
							message.direction === 'outbound' ? message.to.map((t) => t.address).join(', ') : message.from.address,
						subject: message.subject,
						snippet: message.snippet,
						classification: message.classification,
						sizeBytes: message.sizeBytes,
					})),
				},
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
				data: {
					page: 'accountSessions',
					csrf: session.csrf,
					sessions: sessions.map((item) => ({
						id: item.id,
						userAgent: item.userAgent,
						createdAt: item.createdAt,
						lastSeenAt: item.lastSeenAt,
						expiresAt: item.expiresAt,
						current: item.id === session.session.id,
					})),
				},
			})
		}
	}
	throw new KodyError('not_found', `No account page for ${request.method} ${url.pathname}.`, { status: 404 })
}
