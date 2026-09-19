/**
 * Page payloads the Worker renders and the browser hydrates. Everything here
 * must be plain JSON: it is serialized into the document for `clientEntry`
 * islands. Mirrors kody's `universal/loader-data.ts` — one discriminated
 * union keyed by page, so `client/routes/*` stays free of cell/RPC types and
 * the same component can render on both sides.
 */

export type PageFlash = { kind: 'ok' | 'error'; text: string }

export type UsageSummary = {
	today: { runs: number; errors: number; executeMs: number }
	counts: {
		packages: number
		secrets: number
		jobs: number
		blobs: number
		blobBytes: number
	}
	quotas: {
		runsPerDay: number | null
		executeMsPerDay: number | null
		packages: number | null
		secrets: number | null
	}
	limits: { executeTimeoutMs: number; runRetentionCount: number }
}

export type McpGrantView = {
	id: string
	clientId: string
	clientName: string
	createdAt: string
	lastUsedAt: string | null
	activeFamilies: number
}

export type ApiTokenView = {
	id: string
	label: string
	createdAt: string
	lastUsedAt: string | null
}

export type SecretView = {
	name: string
	scope: string
	packageName: string | null
	description: string | null
	updatedAt: string
}

export type SecretHostView = {
	host: string
	approvedAt: string
	approvedBy: string
}

export type PackageView = {
	name: string
	version: string
	description: string | null
	source: string
	fileCount: number
	jobCount: number
	hidden: boolean
	updatedAt: string
	published: { version: string } | null
}

export type JobView = {
	id: string
	packageName: string
	jobName: string
	description: string | null
	schedule: string
	timezone: string | null
	enabled: boolean
	nextRunAt: string | null
	lastRunAt: string | null
	lastStatus: string | null
	lastError: string | null
}

export type RunView = {
	id: string
	createdAt: string
	kind: string
	packageName: string | null
	status: string
	durationMs: number | null
	error: string | null
}

export type IntegrationView = {
	name: string
	provider: string
	status: string
	expiresAt: string | null
	allowedHosts: Array<string>
}

export type EmailMessageView = {
	id: string
	receivedAt: string
	direction: 'inbound' | 'outbound'
	counterpart: string
	subject: string
	snippet: string
	classification: string | null
	sizeBytes: number
}

export type BrowserSessionView = {
	id: string
	userAgent: string | null
	createdAt: string
	lastSeenAt: string | null
	expiresAt: string
	current: boolean
}

export type UserView = { id: string; email: string; createdAt: string }

export type AuditEntryView = {
	id: string
	at: string
	actor: string
	action: string
	target: string | null
	details: string | null
}

export type CommunityListingView = {
	name: string
	version: string
	description: string | null
	publisher: string
	installs: number
	updatedAt: string
}

export type CommunityPackageView = CommunityListingView & {
	publishedAt: string
	fileCount: number
	keywords: Array<string>
	exports: Array<{ specifier: string; path: string }>
	jobs: Array<{ name: string; entry: string; schedule: string }>
	files: Array<string>
	readme: string
	agents: string | null
}

/** A one-time credential shown exactly once after issuance. */
export type IssuedCredential = {
	kind: 'token' | 'invite'
	label: string
	value: string
	expiresAt: string | null
}

export type PasswordFormView = {
	action: string
	submit: string
	requireCurrent: boolean
	minLength: number
}

export type AppLoaderData =
	| {
			page: 'login'
			next: string
			email: string
			magicLinks: boolean
	  }
	| { page: 'setup'; passwordMinLength: number }
	| { page: 'signinLinkExpired' }
	| {
			page: 'signinLinkPassword'
			kind: 'invite' | 'reset'
			email: string
			passwordForm: PasswordFormView
	  }
	| { page: 'error'; error: string; message: string; status: number }
	| {
			page: 'account'
			csrf: string
			email: string
			createdAt: string
			publicUrl: string
			grantCount: number
			tokenCount: number
			hasPassword: boolean
			usage: UsageSummary
			passwordForm: PasswordFormView
	  }
	| {
			page: 'accountMcpOauthClients'
			csrf: string
			publicUrl: string
			grants: Array<McpGrantView>
	  }
	| {
			page: 'accountApiTokens'
			csrf: string
			publicUrl: string
			tokens: Array<ApiTokenView>
			issued: IssuedCredential | null
	  }
	| {
			page: 'accountSecrets'
			csrf: string
			secrets: Array<SecretView>
			hosts: Array<SecretHostView>
	  }
	| {
			page: 'accountPackages'
			csrf: string
			packages: Array<PackageView>
			sourceHosts: Array<string>
			installError: string | null
			installDraft: { source: string; subdir: string }
	  }
	| { page: 'accountJobs'; csrf: string; jobs: Array<JobView> }
	| { page: 'accountActivity'; runs: Array<RunView> }
	| {
			page: 'accountIntegrations'
			csrf: string
			integrations: Array<IntegrationView>
	  }
	| {
			page: 'accountEmail'
			domain: string | null
			addresses: Array<string>
			messages: Array<EmailMessageView>
	  }
	| {
			page: 'accountSessions'
			csrf: string
			sessions: Array<BrowserSessionView>
	  }
	| { page: 'adminLogin' }
	| {
			page: 'adminUsers'
			csrf: string
			users: Array<UserView>
			issued: IssuedCredential | null
	  }
	| {
			page: 'adminUserDetail'
			csrf: string
			user: UserView
			action: string
			counts: {
				tokens: number
				grants: number
				sessions: number
				jobs: number
				runsToday: number
			}
			hosts: Array<SecretHostView>
			quotas: UsageSummary['quotas']
	  }
	| { page: 'adminAudit'; csrf: string; entries: Array<AuditEntryView> }
	| {
			page: 'adminConfig'
			csrf: string
			version: string
			publicUrl: string
			sections: Array<{ name: string; json: string }>
	  }
	| {
			page: 'community'
			query: string
			stats: { packages: number; publishers: number; installs: number }
			listings: Array<CommunityListingView>
	  }
	| { page: 'communityNotFound'; name: string }
	| {
			page: 'communityDetail'
			publicUrl: string
			pkg: CommunityPackageView
	  }
	| {
			page: 'oauthAuthorize'
			clientName: string
			clientUri: string | null
			redirectHost: string
			action: string
			csrf: string
			q: string
			sig: string
	  }
	| { page: 'oauthAuthorizeError'; error: string; description: string }
	| {
			page: 'connectOauth'
			name: string
			provider: string
			email: string
			hosts: Array<string>
			scopes: Array<string>
			description: string | null
			ticket: string
			expiresAt: string
	  }
	| { page: 'connectOauthDone'; name: string; provider: string; email: string }
	| { page: 'connectOauthError'; error: string; message: string }

export type AppPage = AppLoaderData['page']

/** Pages rendered in kody's centred auth shell (no site header/footer). */
export function isAuthShellPage(page: AppPage) {
	return (
		page === 'login' ||
		page === 'setup' ||
		page === 'signinLinkExpired' ||
		page === 'signinLinkPassword' ||
		page === 'adminLogin' ||
		page === 'oauthAuthorize' ||
		page === 'oauthAuthorizeError' ||
		page === 'connectOauth' ||
		page === 'connectOauthDone' ||
		page === 'connectOauthError'
	)
}
