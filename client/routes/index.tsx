import { type Handle } from 'remix/ui'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { Account } from './account.tsx'
import { AccountActivity } from './account-activity.tsx'
import { AccountApiTokens } from './account-api-tokens.tsx'
import { AccountEmail } from './account-email.tsx'
import { AccountIntegrations } from './account-integrations.tsx'
import { AccountJobs } from './account-jobs.tsx'
import { AccountMemories } from './account-memories.tsx'
import { AccountMcpOauthClients } from './account-mcp-oauth-clients.tsx'
import { AccountPackages } from './account-packages.tsx'
import { AccountSecrets } from './account-secrets.tsx'
import { AccountSessions } from './account-sessions.tsx'
import { AccountWebhooks } from './account-webhooks.tsx'
import { AdminAudit } from './admin-audit.tsx'
import { AdminConfig } from './admin-config.tsx'
import { AdminUserDetail } from './admin-user-detail.tsx'
import { AdminUsers } from './admin-users.tsx'
import { Community, CommunityDetail, CommunityNotFound } from './community.tsx'
import {
	ConnectOauth,
	ConnectOauthDone,
	ConnectOauthError,
} from './connect-oauth.tsx'
import { ErrorPage } from './error-page.tsx'
import {
	AdminLogin,
	Login,
	Setup,
	SigninLinkExpired,
	SigninLinkPassword,
} from './login.tsx'
import { OauthAuthorize, OauthAuthorizeError } from './oauth-authorize.tsx'

/**
 * Server-side page dispatch: the handler decides which `AppLoaderData`
 * variant a request yields, and this picks the route component. kody does
 * the same in `client/routes.tsx` with its client router; here every page
 * is a full document, so the switch is the whole router.
 */
export function RouteView(
	handle: Handle<{ data: AppLoaderData; pathname: string; signedIn: boolean }>,
) {
	return () => {
		const { data, pathname } = handle.props
		switch (data.page) {
			case 'login':
				return <Login data={data} />
			case 'setup':
				return <Setup data={data} />
			case 'signinLinkExpired':
				return <SigninLinkExpired />
			case 'signinLinkPassword':
				return <SigninLinkPassword data={data} />
			case 'error':
				return <ErrorPage data={data} signedIn={handle.props.signedIn} />
			case 'account':
				return <Account data={data} pathname={pathname} />
			case 'accountMcpOauthClients':
				return <AccountMcpOauthClients data={data} pathname={pathname} />
			case 'accountApiTokens':
				return <AccountApiTokens data={data} pathname={pathname} />
			case 'accountSecrets':
				return <AccountSecrets data={data} pathname={pathname} />
			case 'accountPackages':
				return <AccountPackages data={data} pathname={pathname} />
			case 'accountJobs':
				return <AccountJobs data={data} pathname={pathname} />
			case 'accountMemories':
				return <AccountMemories data={data} pathname={pathname} />
			case 'accountWebhooks':
				return <AccountWebhooks data={data} pathname={pathname} />
			case 'accountActivity':
				return <AccountActivity data={data} pathname={pathname} />
			case 'accountIntegrations':
				return <AccountIntegrations data={data} pathname={pathname} />
			case 'accountEmail':
				return <AccountEmail data={data} pathname={pathname} />
			case 'accountSessions':
				return <AccountSessions data={data} pathname={pathname} />
			case 'adminLogin':
				return <AdminLogin />
			case 'adminUsers':
				return <AdminUsers data={data} pathname={pathname} />
			case 'adminUserDetail':
				return <AdminUserDetail data={data} pathname={pathname} />
			case 'adminAudit':
				return <AdminAudit data={data} pathname={pathname} />
			case 'adminConfig':
				return <AdminConfig data={data} pathname={pathname} />
			case 'community':
				return <Community data={data} />
			case 'communityNotFound':
				return <CommunityNotFound data={data} />
			case 'communityDetail':
				return <CommunityDetail data={data} />
			case 'oauthAuthorize':
				return <OauthAuthorize data={data} />
			case 'oauthAuthorizeError':
				return <OauthAuthorizeError data={data} />
			case 'connectOauth':
				return <ConnectOauth data={data} />
			case 'connectOauthDone':
				return <ConnectOauthDone data={data} />
			case 'connectOauthError':
				return <ConnectOauthError data={data} />
		}
	}
}
