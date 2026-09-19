import { post, route } from 'remix/routes'

/**
 * Typed route table for every browser-facing URL, mirroring
 * `packages/worker/universal/routes.ts` upstream so ported components can
 * keep calling `routes.<name>.href()`. Keys follow upstream names where the
 * page exists in both projects (`login`, `account`, `accountSecrets`, …) even
 * when the self-hosted path differs (`/signin` vs `/login`), so an upstream
 * diff that touches `routes.login.href()` applies here unchanged.
 */
export const routes = route({
	home: '/',
	health: '/health',
	mcp: '/mcp',
	// Sign-in (`/login` upstream). `/setup` only exists while the registry has
	// zero users.
	setup: '/setup',
	login: '/signin',
	loginLink: '/signin/link/:token',
	logout: post('/signout'),
	account: '/account',
	accountPassword: post('/account/password'),
	accountMcpOauthClients: '/account/clients',
	accountApiTokens: '/account/tokens',
	accountSecrets: '/account/secrets',
	accountPackages: '/account/packages',
	accountJobs: '/account/jobs',
	accountActivity: '/account/runs',
	accountIntegrations: '/account/integrations',
	accountEmail: '/account/inbox',
	accountSessions: '/account/sessions',
	// Operator console (`/admin` upstream). The console has its own cookie
	// (KODY_ADMIN_TOKEN), separate from user sessions.
	admin: '/console',
	adminLogin: post('/console/signin'),
	adminLogout: post('/console/signout'),
	adminUsers: '/console',
	adminUserDetail: '/console/users/:userId',
	adminAudit: '/console/audit',
	adminConfig: '/console/config',
	community: '/community',
	communityDetail: '/community/:name',
	oauthAuthorize: '/oauth/authorize',
	connectOauth: '/connect/oauth/:userId/:connectId',
	connectOauthCallback: '/connect/oauth/callback',
})
