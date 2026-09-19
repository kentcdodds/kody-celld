import type { Env } from '../env.ts'
import type { CommunityListing } from '../packages/community-store.ts'
import { formatWhen, html, page, type Html } from './html.ts'
import { readWebSession } from './session.ts'

/**
 * Public community catalog pages. No sign-in needed: listings are meant to be
 * browsed and linked. Only what CommunityStore exposes is rendered — never the
 * publisher's user id, email, secrets, storage or private packages.
 */

export function isCommunityRoute(pathname: string) {
	return pathname === '/community' || pathname.startsWith('/community/')
}

const nav = [
	{ href: '/community', label: 'Community' },
	{ href: '/account', label: 'Account' },
]

function listingRow(listing: CommunityListing) {
	return html`<tr>
		<td>
			<a href="/community/${encodeURIComponent(listing.name)}"><strong>${listing.name}</strong></a>
			${listing.description ? html`<br /><span class="muted small">${listing.description}</span>` : ''}
		</td>
		<td>${listing.version}</td>
		<td>${listing.publisher}</td>
		<td>${listing.installs}</td>
		<td>${formatWhen(listing.updatedAt)}</td>
	</tr>`
}

function installSnippet(env: Env, listing: CommunityListing): Html {
	return html`<pre><code>// from any MCP client connected to ${env.KODY_PUBLIC_URL}/mcp
execute: import { kody } from 'kody:runtime'
export default () => kody.communityInstall({ name: ${JSON.stringify(listing.name)} })</code></pre>`
}

export async function handleCommunity(request: Request, env: Env, url: URL): Promise<Response> {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
	}
	const registry = env.REGISTRY.getByName('registry')
	const session = await readWebSession(request, env)
	const who = session ? html`${session.user.email}` : html`<a href="/signin">Sign in</a>`
	const name = decodeURIComponent(url.pathname.slice('/community/'.length))

	if (url.pathname === '/community' || url.pathname === '/community/') {
		const query = url.searchParams.get('q')?.trim() ?? ''
		const [listings, stats] = await Promise.all([
			registry.communitySearch({ query, limit: 50 }),
			registry.communityStats(),
		])
		return page({
			title: 'Community packages',
			nav,
			current: '/community',
			who,
			body: html`<div class="card">
					<p class="muted">
						${stats.packages} package${stats.packages === 1 ? '' : 's'} from ${stats.publishers}
						publisher${stats.publishers === 1 ? '' : 's'}, ${stats.installs} install${stats.installs === 1 ? '' : 's'}.
						Publish your own with <code>communityPublish</code> or from <a href="/account/packages">your packages</a>.
					</p>
					<form method="get" action="/community" class="row">
						<input name="q" placeholder="Search name, description, keywords" value="${query}" />
						<button type="submit">Search</button>
					</form>
				</div>
				<div class="card">
					<table>
						<tr>
							<th>Package</th>
							<th>Version</th>
							<th>Publisher</th>
							<th>Installs</th>
							<th>Updated</th>
						</tr>
						${
							listings.length === 0
								? html`<tr>
										<td colspan="5" class="muted">${query ? 'No packages match.' : 'Nothing published yet.'}</td>
									</tr>`
								: listings.map(listingRow)
						}
					</table>
				</div>`,
		})
	}

	const pkg = await registry.communityGet(name)
	if (!pkg) {
		return page({
			title: 'Not found',
			nav,
			who,
			status: 404,
			body: html`<div class="card">
				<p>No community package named <code>${name}</code>.</p>
				<p><a href="/community">Back to the catalog</a></p>
			</div>`,
		})
	}
	const exportsList = Object.entries(pkg.manifest.exports)
	const jobs = Object.entries(pkg.manifest.jobs)
	return page({
		title: pkg.name,
		nav,
		current: '/community',
		who,
		body: html`<div class="card">
				<p>
					<a href="/community">Community</a> / <strong>${pkg.name}</strong> <span class="badge">v${pkg.version}</span>
				</p>
				${pkg.description ? html`<p>${pkg.description}</p>` : ''}
				<p class="muted small">
					by ${pkg.publisher} · ${pkg.installs} install${pkg.installs === 1 ? '' : 's'} · ${pkg.fileCount} files ·
					published ${formatWhen(pkg.publishedAt)} · updated ${formatWhen(pkg.updatedAt)}
					${pkg.keywords.length > 0 ? html`· ${pkg.keywords.map((k) => html`<span class="badge">${k}</span> `)}` : ''}
				</p>
				${installSnippet(env, pkg)}
			</div>
			<div class="card">
				<h2>Exports</h2>
				<table>
					<tr>
						<th>Export</th>
						<th>Module</th>
					</tr>
					${exportsList.map(
						([exportName, path]) =>
							html`<tr>
								<td><code>kody:${pkg.name}${exportName === '.' ? '' : `/${exportName}`}</code></td>
								<td><code>${path}</code></td>
							</tr>`,
					)}
				</table>
				${
					jobs.length > 0
						? html`<h2>Jobs</h2>
								<table>
									<tr>
										<th>Job</th>
										<th>Export</th>
										<th>Schedule</th>
									</tr>
									${jobs.map(
										([jobName, job]) =>
											html`<tr>
												<td>${jobName}</td>
												<td><code>${job.entry}</code></td>
												<td><code>${JSON.stringify(job.schedule)}</code></td>
											</tr>`,
									)}
								</table>`
						: ''
				}
				<h2>Files</h2>
				<ul>
					${Object.keys(pkg.files)
						.sort()
						.map((file) => html`<li><code>${file}</code></li>`)}
				</ul>
			</div>
			<div class="card">
				<h2>README</h2>
				<pre>${pkg.readme || '(empty)'}</pre>
				${
					pkg.agents
						? html`<h2>AGENTS</h2>
								<pre>${pkg.agents}</pre>`
						: ''
				}
			</div>`,
	})
}
