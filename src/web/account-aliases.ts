/**
 * kody.codes paths for account sections that live under a different name
 * here (`universal/routes.ts` keeps upstream's route keys, not its paths).
 * People and agents that know the hosted product land on the right page
 * instead of a 404.
 */
const upstreamAccountSections: Record<string, string> = {
	email: 'inbox',
	activity: 'runs',
	'mcp-oauth-clients': 'clients',
}

/** Where a GET for an upstream-named account path should go, or null. */
export function accountAliasLocation(url: URL): string | null {
	const match = /^\/account\/([^/]+)(\/.*)?$/.exec(url.pathname)
	if (!match) return null
	const target = upstreamAccountSections[match[1] ?? '']
	if (!target) return null
	return `/account/${target}${match[2] ?? ''}${url.search}`
}
