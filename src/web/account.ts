import type { Env } from '../env.ts'
import { getUserCell } from '../execute/engine.ts'
import { recordAudit } from '../lib/audit.ts'
import { mcpCell, mcpDeps } from '../capabilities/mcp-servers.ts'
import { parseIntegrationUsage } from '../integrations/oauth.ts'
import {
	describeMcpOAuth,
	finishMcpOAuth,
	refreshMcpServer,
	removeMcpOAuthClient,
	setMcpOAuthClient,
	startMcpOAuth,
} from '../mcp-client/service.ts'
import { KodyError } from '../lib/errors.ts'
import { loadEmailConfig } from '../email/service.ts'
import { getMemoryCell } from '../capabilities/memory.ts'
import { memoryStatuses } from '../cells/memory-cell.ts'
import { defaultPublisher, renamePackageFiles } from '../capabilities/community.ts'
import { fetchPackageSourceCached } from '../packages/fetched-package-cache.ts'
import {
	fetchPackageSource,
	packageSourceHostsFromEnv,
	parsePackageSource,
	packagePreviewFromFetched,
	pinPackageSourceToCommit,
	previewPackageSource,
	type PackagePreview,
} from '../packages/install.ts'
import { parsePackageManifest } from '../packages/manifest.ts'
import { decodePreviewSource, encodePreviewSource } from '../packages/preview-source.ts'
import { renderPage } from '#app/render.tsx'
import { inProcessHighlightEnv, loadPackageFilesData } from '#app/package-files-data.ts'
import { type AppLoaderData, type PageFlash, type RunDetailView } from '#universal/loader-data.ts'
import type { RunRecord } from '../cells/user-cell.ts'
import { routes } from '#universal/routes.ts'
import { accountAliasLocation } from './account-aliases.ts'
import { matchAccountDetailPath } from './account-detail-paths.ts'
import { appSessionOf, readForm, redirect } from './http.ts'
import { summarizeJobSchedule } from './job-schedule-summary.ts'
import { assertCsrf, readWebSession, type WebSession } from './session.ts'
import { passwordFormView } from './signin.ts'
import { matchesSearchQuery } from './search-filter.ts'

const registry = (env: Env) => env.REGISTRY.getByName('registry')

const flashes: Record<string, PageFlash> = {
	welcome: { kind: 'ok', text: 'Your account is ready. Connect an MCP client or create an API token to get started.' },
	saved: { kind: 'ok', text: 'Saved.' },
	revoked: { kind: 'ok', text: 'Revoked.' },
	deleted: { kind: 'ok', text: 'Deleted.' },
	password_set: { kind: 'ok', text: 'Password updated.' },
	disconnected: { kind: 'ok', text: 'Disconnected.' },
	installed: { kind: 'ok', text: 'Package installed.' },
	forked: { kind: 'ok', text: 'Package forked into your catalog.' },
	published: { kind: 'ok', text: 'Published to the community catalog.' },
	unpublished: { kind: 'ok', text: 'Removed from the community catalog.' },
	run_ignored: { kind: 'ok', text: 'Run marked ignored.' },
	run_resolved: { kind: 'ok', text: 'Run marked resolved.' },
	run_reopened: { kind: 'ok', text: 'Run reopened.' },
	mcp_auth_success: { kind: 'ok', text: 'Authorized. The MCP server is connected.' },
	mcp_auth_error: { kind: 'error', text: 'Authorization did not finish; see the server status below.' },
	mcp_oauth_client_error: {
		kind: 'error',
		text: 'Could not save or remove the OAuth client. Check the client id and secret, then try again.',
	},
}

const noReferrer = { 'referrer-policy': 'no-referrer' }

function view(
	session: WebSession,
	input: {
		title: string
		current: string
		data: AppLoaderData
		flash?: PageFlash | null
		status?: number
		headers?: Record<string, string>
	},
) {
	return renderPage({
		title: input.title,
		pathname: input.current,
		session: appSessionOf(session),
		flash: input.flash ?? null,
		...(input.status === undefined ? {} : { status: input.status }),
		...(input.headers ? { headers: input.headers } : {}),
		data: input.data,
	})
}

function hrefWithFlash(href: string, flash: string) {
	const target = new URL(href, 'http://localhost')
	target.searchParams.set('flash', flash)
	return target.toString().replace(target.origin, '')
}

async function handlePackageMutation(input: {
	action: string
	name: string | undefined
	successHref: string
	env: Env
	userId: string
	email: string
	userCell: Awaited<ReturnType<typeof getUserCell>>
	audit: (action: string, target: string | null, details?: Record<string, unknown> | null) => Promise<void>
}): Promise<Response | { error: string } | null> {
	if (!input.name || !['delete', 'publish', 'unpublish'].includes(input.action)) return null

	const pkg = await input.userCell.packageGet(input.name)
	if (!pkg) {
		throw new KodyError('package_not_found', `Package "${input.name}" is not saved.`, { status: 404 })
	}

	if (input.action === 'delete') {
		await input.userCell.packageDelete(input.name)
		await input.audit('package.delete', input.name, { via: 'web' })
		return redirect(hrefWithFlash(routes.accountPackages.href(), 'deleted'))
	}

	if (input.action === 'publish') {
		try {
			const listing = await registry(input.env).communityPublish({
				userId: input.userId,
				publisher: defaultPublisher(input.email),
				name: pkg.name,
				version: pkg.version,
				manifest: pkg.manifest,
				files: pkg.files,
			})
			await input.audit('community.publish', listing.name, {
				version: listing.version,
				via: 'web',
			})
			return redirect(hrefWithFlash(input.successHref, 'published'))
		} catch (error) {
			return { error: KodyError.fromUnknown(error)?.message ?? 'Publish failed.' }
		}
	}

	const removed = await registry(input.env).communityUnpublish({
		userId: input.userId,
		name: input.name,
	})
	if (removed) await input.audit('community.unpublish', input.name, { via: 'web' })
	return redirect(hrefWithFlash(input.successHref, 'unpublished'))
}

export function isAccountRoute(pathname: string) {
	return pathname === '/account' || pathname.startsWith('/account/')
}

export async function handleAccount(request: Request, env: Env, url: URL): Promise<Response> {
	const alias = request.method === 'GET' ? accountAliasLocation(url) : null
	if (alias) return redirect(alias)
	const session = await readWebSession(request, env)
	if (!session) return redirect(`/signin?flash=signin_required&next=${encodeURIComponent(url.pathname + url.search)}`)
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

	const detailPath = matchAccountDetailPath(url)
	if (detailPath?.kind === 'package') {
		const detailHref = routes.accountPackageDetail.href({ name: detailPath.name })
		let error: string | null = null
		if (post) {
			const result = await handlePackageMutation({
				action: form.action ?? '',
				name: form.name === detailPath.name ? form.name : undefined,
				successHref: detailHref,
				env,
				userId: session.user.id,
				email: session.user.email,
				userCell,
				audit,
			})
			if (result instanceof Response) return result
			if (result) {
				error = result.error
			} else {
				if (!(await userCell.packageGet(detailPath.name))) {
					throw new KodyError('package_not_found', `Package "${detailPath.name}" is not saved.`, { status: 404 })
				}
				return redirect(detailHref)
			}
		}

		const pkg = await userCell.packageGet(detailPath.name)
		if (!pkg) {
			throw new KodyError('package_not_found', `Package "${detailPath.name}" is not saved.`, {
				status: 404,
			})
		}
		const [jobRecords, webhooks, published] = await Promise.all([
			userCell.jobList({ packageName: pkg.name }),
			userCell.webhookList({ packageName: pkg.name }),
			registry(env).communityListByUser(session.user.id),
		])
		const jobsByName = new Map(jobRecords.map((job) => [job.jobName, job]))
		const listing = published.find((item) => item.name === pkg.name)
		// kody: the package page is its files view (tree + README at the root).
		const explorer = await loadPackageFilesData({
			env: inProcessHighlightEnv(),
			files: pkg.files,
			selectedPath: '',
			title: pkg.name,
			backHref: routes.accountPackages.href(),
			backLabel: 'Packages',
			filesBasePath: routes.accountPackageFiles.href({ name: pkg.name }),
		})
		if (!explorer) {
			throw new KodyError('package_file_not_found', 'Package file was not found.', { status: 404 })
		}
		return view(session, {
			title: pkg.name,
			current: url.pathname,
			flash,
			data: {
				page: 'accountPackageDetail',
				csrf: session.csrf,
				error,
				files: explorer,
				pkg: {
					name: pkg.name,
					version: pkg.version,
					description: pkg.manifest.description || null,
					source: pkg.source,
					createdAt: pkg.createdAt,
					updatedAt: pkg.updatedAt,
					hidden: pkg.manifest.hidden,
					published: listing ? { version: listing.version } : null,
					exports: Object.entries(pkg.manifest.exports).map(([specifier, path]) => ({
						specifier,
						path,
					})),
					jobs: Object.entries(pkg.manifest.jobs).map(([name, definition]) => {
						const job = jobsByName.get(name)
						return {
							id: job?.id ?? `${pkg.name}#${name}`,
							name,
							entry: definition.entry,
							schedule: summarizeJobSchedule(definition.schedule),
							timezone: definition.timezone ?? job?.timezone ?? null,
							description: job?.description ?? definition.description ?? null,
							enabled: job?.enabled ?? null,
						}
					}),
					webhooks: webhooks.map(({ definition }) => ({
						name: definition.name,
						export: definition.export,
						responseMode: definition.responseMode,
						inputMode: definition.inputMode,
						rateLimitPerMinute: definition.rateLimitPerMinute,
						verification: definition.verification
							? `${definition.verification.type} (header ${definition.verification.header}, secret ${definition.verification.secretName})`
							: null,
						description: definition.description ?? null,
					})),
					fileCount: Object.keys(pkg.files).length,
				},
			},
		})
	}

	if (detailPath?.kind === 'packagePreviewFiles') {
		if (post) return redirect(url.pathname)
		const ref = decodePreviewSource(detailPath.source)
		const fetched = await fetchPackageSourceCached(parsePackageSource(ref.source, ref.subdir), {
			allowedHosts: packageSourceHostsFromEnv(env),
		})
		const preview = packagePreviewFromFetched(fetched)
		// Pin the commit into the URL so Install (and later file clicks) resolve the
		// same tree the explorer showed; unpinned github:/kody: refs can drift.
		const pinnedSource = pinPackageSourceToCommit(ref.source, preview.commit)
		if (pinnedSource !== ref.source) {
			return redirect(
				routes.accountPackagePreviewFiles.href({
					source: encodePreviewSource({ source: pinnedSource, subdir: ref.subdir }),
					relativePath: detailPath.relativePath ?? undefined,
				}),
			)
		}
		const files = await loadPackageFilesData({
			env: inProcessHighlightEnv(),
			files: fetched.files,
			selectedPath: detailPath.relativePath ?? '',
			title: preview.name,
			backHref: routes.accountPackages.href(),
			backLabel: 'Packages',
			filesBasePath: routes.accountPackagePreviewFiles.href({ source: detailPath.source }),
		})
		if (!files) {
			throw new KodyError('package_file_not_found', 'Package file was not found.', { status: 404 })
		}
		return view(session, {
			title: `Preview ${preview.name}`,
			current: url.pathname,
			flash,
			data: {
				page: 'accountPackagePreviewFiles',
				csrf: session.csrf,
				files,
				preview: {
					source: ref.source,
					subdir: ref.subdir ?? '',
					fetchedFrom: preview.fetchedFrom,
					commit: preview.commit,
					name: preview.name,
					version: preview.version,
					description: preview.description,
					warnings: preview.warnings,
					permissions: preview.permissions,
				},
			},
		})
	}

	if (detailPath?.kind === 'packageFiles') {
		const pkg = await userCell.packageGet(detailPath.name)
		if (!pkg) {
			throw new KodyError('package_not_found', `Package "${detailPath.name}" is not saved.`, {
				status: 404,
			})
		}
		if (post) return redirect(url.pathname)
		const files = await loadPackageFilesData({
			env: inProcessHighlightEnv(),
			files: pkg.files,
			selectedPath: detailPath.relativePath ?? '',
			title: pkg.name,
			backHref: routes.accountPackageDetail.href({ name: pkg.name }),
			backLabel: pkg.name,
			filesBasePath: routes.accountPackageFiles.href({ name: pkg.name }),
		})
		if (!files) {
			throw new KodyError('package_file_not_found', 'Package file was not found.', { status: 404 })
		}
		return view(session, {
			title: `${pkg.name} files`,
			current: url.pathname,
			flash,
			data: { page: 'accountPackageFiles', files },
		})
	}

	if (detailPath?.kind === 'job') {
		const job = await userCell.jobGet(detailPath.jobId)
		if (!job) {
			throw new KodyError('job_not_found', `Job "${detailPath.jobId}" was not found.`, {
				status: 404,
			})
		}
		const detailHref = routes.accountJobDetail.href({ jobId: detailPath.jobId })
		if (post) {
			if (form.action === 'toggle' && form.id === detailPath.jobId) {
				const enabled = form.enabled === 'true'
				await userCell.jobUpdate({ id: detailPath.jobId, enabled })
				await audit('job.update', detailPath.jobId, { enabled, via: 'web' })
				return redirect(hrefWithFlash(detailHref, 'saved'))
			}
			return redirect(detailHref)
		}
		const [pkg, runs] = await Promise.all([
			userCell.packageGet(job.packageName),
			userCell.jobRunList({ jobId: job.id, limit: 20 }),
		])
		return view(session, {
			title: job.id,
			current: url.pathname,
			flash,
			data: {
				page: 'accountJobDetail',
				csrf: session.csrf,
				packageExists: pkg !== null,
				job: {
					id: job.id,
					packageName: job.packageName,
					jobName: job.jobName,
					entry: job.entry,
					description: job.description,
					schedule: summarizeJobSchedule(job.schedule),
					timezone: job.timezone,
					enabled: job.enabled,
					nextRunAt: job.nextRunAt,
					lastRunAt: job.lastRunAt,
					lastStatus: job.lastStatus,
					lastError: job.lastError,
				},
				runs: runs.map((run) => ({
					id: run.id,
					trigger: run.trigger,
					startedAt: run.startedAt,
					finishedAt: run.finishedAt,
					status: run.status,
					durationMs: run.finishedAt ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime() : null,
					error: run.error,
				})),
			},
		})
	}

	if ((section === 'packages' && segments.length > 1) || (section === 'jobs' && segments.length > 1)) {
		throw new KodyError('not_found', `No account page for ${request.method} ${url.pathname}.`, {
			status: 404,
		})
	}

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
			let preview: PackagePreview | null = null
			if (post) {
				const mutation = await handlePackageMutation({
					action: form.action ?? '',
					name: form.name,
					successHref: routes.accountPackages.href(),
					env,
					userId: session.user.id,
					email: session.user.email,
					userCell,
					audit,
				})
				if (mutation instanceof Response) return mutation
				if (mutation) installError = mutation.error
				if ((form.action === 'preview' || form.action === 'install' || form.action === 'fork') && form.source) {
					try {
						const source = parsePackageSource(form.source, form.subdir || null)
						if (form.action === 'preview') {
							preview = await previewPackageSource(source, { allowedHosts: packageSourceHostsFromEnv(env) })
						} else {
							const fetched = await fetchPackageSource(source, { allowedHosts: packageSourceHostsFromEnv(env) })
							const forkAs = form.action === 'fork' ? (form.as || '').trim() : ''
							if (form.action === 'fork' && !forkAs) {
								throw new KodyError('invalid_args', 'Fork requires a new package name in "as".')
							}
							let files = fetched.files
							let savedSource = fetched.source
							if (forkAs) {
								const manifestName = parsePackageManifest(fetched.files).name
								if (forkAs !== manifestName) {
									files = renamePackageFiles(fetched.files, forkAs)
									parsePackageManifest(files)
									savedSource = `${fetched.source} (fork)`
								}
							}
							const saved = await userCell.packageSave({ files, source: savedSource })
							await audit('package.install', saved.name, {
								version: saved.version,
								source: savedSource,
								commit: fetched.commit ?? null,
								fork: savedSource.endsWith('(fork)'),
								via: 'web',
							})
							return redirect(
								savedSource.endsWith('(fork)') ? '/account/packages?flash=forked' : '/account/packages?flash=installed',
							)
						}
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
			const pinnedPreviewSource = preview ? pinPackageSourceToCommit(preview.source, preview.commit) : null
			return view(session, {
				title: 'Packages',
				current: '/account/packages',
				flash,
				data: {
					page: 'accountPackages',
					csrf: session.csrf,
					sourceHosts: packageSourceHostsFromEnv(env),
					installError,
					installDraft: {
						// After a successful preview, draft the pinned source so Install
						// matches Browse files (form.source is always set when preview is).
						source: pinnedPreviewSource ?? form.source ?? '',
						subdir: form.subdir ?? '',
						as: form.as ?? '',
					},
					preview: preview
						? {
								source: pinnedPreviewSource ?? preview.source,
								fetchedFrom: preview.fetchedFrom,
								commit: preview.commit,
								name: preview.name,
								version: preview.version,
								description: preview.description,
								readme: preview.readme,
								fileList: preview.fileList,
								permissions: preview.permissions,
								warnings: preview.warnings,
								browseHref: routes.accountPackagePreviewFiles.href({
									source: encodePreviewSource({
										source: pinnedPreviewSource ?? preview.source,
										subdir: form.subdir || null,
									}),
								}),
							}
						: null,
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

		case 'memories': {
			const cell = getMemoryCell(env, session.user.id)
			await cell.init(session.user.id)
			if (post) {
				if (form.action === 'delete' && form.memoryId) {
					const result = await cell.memoryDelete({
						id: form.memoryId,
						force: form.force === 'true',
					})
					await audit(`memory.delete.${result.mode}`, result.id, { via: 'web' })
					return redirect('/account/memories?flash=deleted')
				}
				return redirect('/account/memories')
			}

			const query = url.searchParams.get('q')?.trim() ?? ''
			const includeDeletedValue = url.searchParams.get('includeDeleted')?.trim().toLowerCase()
			const includeDeleted =
				includeDeletedValue === '1' || includeDeletedValue === 'true' || includeDeletedValue === 'yes'
			const visibleMemories = includeDeleted
				? await cell.memoryList({ limit: 100 })
				: (
						await Promise.all(
							memoryStatuses
								.filter((status) => status !== 'deleted')
								.map((status) => cell.memoryList({ limit: 100, status })),
						)
					)
						.flat()
						.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
						.slice(0, 100)
			const memories = visibleMemories
				.filter((memory) =>
					matchesSearchQuery(query, [memory.subject, memory.category, memory.status, memory.summary, ...memory.tags]),
				)
				.map((memory) => ({
					id: memory.id,
					subject: memory.subject,
					category: memory.category,
					status: memory.status,
					tags: memory.tags,
					summary: memory.summary,
					updatedAt: memory.updatedAt,
				}))

			let selectedId = segments[1] ?? null
			if (selectedId) {
				try {
					selectedId = decodeURIComponent(selectedId)
				} catch {
					selectedId = segments[1] ?? null
				}
			}
			const selectedRecord = selectedId ? await cell.memoryGet({ id: selectedId }) : null
			const selected = selectedRecord
				? {
						id: selectedRecord.id,
						subject: selectedRecord.subject,
						category: selectedRecord.category,
						status: selectedRecord.status,
						tags: selectedRecord.tags,
						summary: selectedRecord.summary,
						updatedAt: selectedRecord.updatedAt,
						details: selectedRecord.details,
						sourceUris: selectedRecord.sourceUris,
						dedupeKey: selectedRecord.dedupeKey,
						createdAt: selectedRecord.createdAt,
						lastAccessedAt: selectedRecord.lastAccessedAt,
						deletedAt: selectedRecord.deletedAt,
					}
				: null

			return view(session, {
				title: 'Memories',
				current: url.pathname,
				flash,
				status: selectedId && !selected ? 404 : undefined,
				data: {
					page: 'accountMemories',
					csrf: session.csrf,
					query,
					includeDeleted,
					total: visibleMemories.length,
					memories,
					selectedId,
					selected,
				},
			})
		}

		case 'webhooks': {
			if (post) break
			const listings = await userCell.webhookList()
			const deliveries = await Promise.all(
				listings.flatMap(({ mint }) => (mint ? [userCell.webhookDeliveryList({ handle: mint.handle, limit: 1 })] : [])),
			)
			const latestDeliveryByHandle = new Map(deliveries.flat().map((delivery) => [delivery.handle, delivery] as const))
			return view(session, {
				title: 'Webhooks',
				current: url.pathname,
				data: {
					page: 'accountWebhooks',
					webhooks: listings.map(({ packageName, definition, mint }) => {
						const lastDelivery = mint ? latestDeliveryByHandle.get(mint.handle) : undefined
						return {
							id: `${packageName}/${definition.name}`,
							packageName,
							name: definition.name,
							exportName: definition.export,
							description: definition.description ?? null,
							responseMode: definition.responseMode,
							inputMode: definition.inputMode,
							verification: definition.verification
								? {
										type: definition.verification.type,
										header: definition.verification.header,
									}
								: null,
							minted: mint !== null,
							handle: mint?.handle ?? null,
							enabled: mint?.enabled ?? null,
							deliveries: mint?.deliveries ?? 0,
							lastDeliveryAt: lastDelivery?.receivedAt ?? mint?.lastDeliveryAt ?? null,
							lastDeliveryStatus: lastDelivery?.status ?? null,
							lastDeliveryHttpStatus: lastDelivery?.httpStatus ?? null,
						}
					}),
				},
			})
		}

		case 'runs': {
			let triageError: string | null = null
			if (post) {
				const triage =
					form.triage === 'ignored' || form.triage === 'resolved' || form.triage === 'open' ? form.triage : null
				const back = form.view === 'recent' ? 'recent' : 'errors'
				if (form.action !== 'triage' || !form.runId || !triage) return redirect(routes.accountActivity.href())
				// Triage from the expanded run returns to it (`open` = run id).
				const backPath = form.open
					? `${routes.accountActivity.href()}/${encodeURIComponent(form.open)}`
					: routes.accountActivity.href()
				try {
					await userCell.runTriageUpdate({ runId: form.runId, triage, note: undefined })
					await audit('run.triage', form.runId, { triage, via: 'web' })
					return redirect(
						hrefWithFlash(`${backPath}?view=${back}`, triage === 'open' ? 'run_reopened' : `run_${triage}`),
					)
				} catch (error) {
					const known = KodyError.fromUnknown(error)
					if (!known) console.error('[kody-celld] Activity triage update failed', form.runId, error)
					triageError = known?.message ?? 'Update failed.'
				}
			}
			const summary = await userCell.runSummary({})
			const viewParam = url.searchParams.get('view') ?? (post ? form.view : null)
			const viewMode: 'errors' | 'recent' =
				viewParam === 'errors' || viewParam === 'recent' ? viewParam : summary.errors > 0 ? 'errors' : 'recent'
			const runs = await userCell.runList({ limit: 50, errorTriage: viewMode === 'errors' ? 'open' : 'all' })
			let selectedId: string | null = post ? (form.open ?? null) : (segments[1] ?? null)
			if (selectedId && !post) {
				try {
					selectedId = decodeURIComponent(selectedId)
				} catch {
					selectedId = null
				}
			}
			const selectedRun = selectedId ? await userCell.runGet({ id: selectedId }) : null
			return view(session, {
				title: 'Runs',
				current: '/account/runs',
				flash,
				...(triageError ? { status: 400 } : {}),
				data: {
					page: 'accountActivity',
					csrf: session.csrf,
					view: viewMode,
					error: triageError,
					summary: {
						errors: summary.errors,
						ignored: summary.ignored,
						resolved: summary.resolved,
						running: summary.running,
					},
					runs: runs.map((run) => ({
						id: run.id,
						createdAt: run.createdAt,
						kind: run.kind,
						packageName: run.packageName,
						status: run.status,
						durationMs: run.durationMs,
						error: run.error ? `${run.error.name}: ${run.error.message}` : null,
						errorTriage: run.errorTriage,
					})),
					selectedId,
					selected: selectedRun ? runDetailView(selectedRun) : null,
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

		case 'mcp-servers': {
			const cell = mcpCell({ userCell })
			if (segments[1] === 'oauth' && segments[2] === 'callback' && segments.length === 3) {
				if (request.method === 'HEAD') return new Response(null, { status: 200, headers: noReferrer })
				if (post) return new Response(null, { status: 405, headers: { allow: 'GET, HEAD', ...noReferrer } })
				const result = await finishMcpOAuth(mcpDeps({ env, userCell }), {
					state: url.searchParams.get('state') ?? '',
					code: url.searchParams.get('code'),
					error: url.searchParams.get('error'),
					errorDescription: url.searchParams.get('error_description'),
					iss: url.searchParams.get('iss'),
				})
				const nameParam = encodeURIComponent(result.name)
				// A replayed callback must not claim success: the first attempt may have failed.
				if (result.replay) return redirect(`/account/mcp-servers?name=${nameParam}`, noReferrer)
				await audit(result.ok ? 'mcp_server.oauth_connected' : 'mcp_server.oauth_failed', result.name, {
					...(result.message ? { message: result.message } : {}),
				})
				return redirect(
					`/account/mcp-servers?flash=${result.ok ? 'mcp_auth_success' : 'mcp_auth_error'}&name=${nameParam}`,
					noReferrer,
				)
			}
			if (segments[2] === 'authorize' && segments.length === 3) {
				let name: string
				try {
					name = decodeURIComponent(segments[1] ?? '')
				} catch {
					throw new KodyError('mcp_server_not_found', 'MCP server was not found.', { status: 404 })
				}
				if (post) {
					const started = await startMcpOAuth(mcpDeps({ env, userCell }), name)
					await audit('mcp_server.authorize', name, { clientMode: started.clientMode })
					return new Response(null, {
						status: 303,
						headers: {
							location: started.authorizationUrl,
							'cache-control': 'no-store',
							'referrer-policy': 'no-referrer',
						},
					})
				}
				const d = await describeMcpOAuth(mcpDeps({ env, userCell }), name)
				return view(session, {
					title: `Authorize ${d.name}`,
					current: '/account/mcp-servers',
					headers: { 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' },
					data: { page: 'accountMcpServerAuthorize', csrf: session.csrf, ...d },
				})
			}
			if (post) {
				const name = form.name ?? ''
				const record = name ? await cell.mcpServerGet(name) : null
				let clientError: string | null = null
				if (record) {
					if (form.action === 'refresh') {
						try {
							await refreshMcpServer(mcpDeps({ env, userCell }), name)
						} catch (error) {
							if (!KodyError.fromUnknown(error)) throw error
						}
					} else if (form.action === 'oauth_client_set') {
						try {
							await setMcpOAuthClient(mcpDeps({ env, userCell }), name, {
								clientId: form.clientId ?? '',
								clientSecret: form.clientSecret ?? null,
							})
							await audit('mcp_server.oauth_client_set', name, { clientId: (form.clientId ?? '').trim(), via: 'web' })
						} catch (error) {
							const known = KodyError.fromUnknown(error)
							if (!known) throw error
							clientError = known.message
						}
					} else if (form.action === 'oauth_client_remove') {
						try {
							await removeMcpOAuthClient(mcpDeps({ env, userCell }), name)
							await audit('mcp_server.oauth_client_removed', name, { via: 'web' })
						} catch (error) {
							const known = KodyError.fromUnknown(error)
							if (!known) throw error
							clientError = known.message
						}
					} else if (form.action === 'enable' || form.action === 'disable') {
						await cell.mcpServerSetEnabled({ name, enabled: form.action === 'enable' })
						await audit('mcp_server.enabled', name, { enabled: form.action === 'enable', via: 'web' })
					} else if (form.action === 'remove') {
						await cell.mcpServerRemove(name)
						await audit('mcp_server.remove', name, { via: 'web' })
					} else if (form.action === 'allow_all') {
						await cell.mcpServerSetUsage({ name, usage: { mode: 'any' } })
						await audit('mcp_server.unlock', name, { via: 'web' })
					} else if (form.action === 'ungrant' && form.packageName && record.usage.mode === 'packages') {
						const rest = record.usage.packages.filter((p) => p !== form.packageName)
						const usage = rest.length
							? parseIntegrationUsage({ mode: 'packages', packages: rest })
							: ({ mode: 'any' } as const)
						await cell.mcpServerSetUsage({ name, usage })
						await audit('mcp_server.ungrant', name, { packageName: form.packageName, via: 'web' })
					}
				}
				if (clientError) return redirect('/account/mcp-servers?flash=mcp_oauth_client_error')
				return redirect('/account/mcp-servers')
			}
			const servers = await cell.mcpServerList()
			return view(session, {
				title: 'MCP servers',
				current: '/account/mcp-servers',
				flash,
				data: {
					page: 'accountMcpServers',
					csrf: session.csrf,
					servers: servers.map((s) => ({
						name: s.name,
						host: (() => {
							try {
								return new URL(s.url).host
							} catch {
								return s.url
							}
						})(),
						status: s.status,
						lastError: s.lastError ? `${s.lastError.phase}: ${s.lastError.message}` : null,
						enabled: s.enabled,
						authKind: s.auth.kind,
						authorizeHref:
							s.auth.kind === 'oauth' && s.status === 'authenticating'
								? `/account/mcp-servers/${encodeURIComponent(s.name)}/authorize`
								: null,
						hasRefreshToken: s.oauth?.hasRefreshToken ?? false,
						oauthClient: s.oauth?.clientMode
							? { clientId: s.oauth.clientId ?? '', hasSecret: s.oauth.hasClientSecret, mode: s.oauth.clientMode }
							: null,
						usage:
							s.usage.mode === 'any'
								? { mode: 'any' as const, packages: [] }
								: { mode: 'packages' as const, packages: s.usage.packages },
						tools: s.tools.map((t) => ({ name: t.name, description: t.description ?? '' })),
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

const runDetailResultLimit = 4000
const runDetailLogLimit = 200

/** Activity's expanded run: full error, readable log lines, a capped result. */
function runDetailView(run: RunRecord): RunDetailView {
	const logs = (JSON.parse(run.logsJson) as Array<unknown>).slice(0, runDetailLogLimit).map((entry) => {
		const line = entry as { level?: unknown; args?: unknown }
		const args = Array.isArray(line?.args) ? line.args : [entry]
		const level = typeof line?.level === 'string' ? line.level : 'log'
		return `${level}: ${args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')}`
	})
	const result =
		run.resultJson === null
			? null
			: run.resultJson.length > runDetailResultLimit
				? `${run.resultJson.slice(0, runDetailResultLimit)}…`
				: run.resultJson
	return {
		id: run.id,
		kind: run.kind,
		packageName: run.packageName,
		jobId: run.jobId,
		status: run.status,
		createdAt: run.createdAt,
		durationMs: run.durationMs,
		error: run.error ? `${run.error.name}: ${run.error.message}` : null,
		errorTriage: run.errorTriage,
		triageNote: run.triageNote,
		triagedAt: run.triagedAt,
		triagedBy: run.triagedBy,
		logs,
		result,
		warnings: run.warnings,
		gateway: run.gateway.map((event) => ({
			method: event.method,
			host: event.host,
			outcome: event.outcome,
			status: event.status,
			reason: event.reason ?? null,
		})),
	}
}
