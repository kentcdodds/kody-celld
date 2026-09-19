import { css, type Handle } from 'remix/ui'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { spacing } from '#universal/styles/tokens.ts'
import {
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	MetadataGrid,
	TimestampValue,
} from './account-management-components.tsx'
import { Badge, Code, Lede, Muted, SignOutForm } from './form-controls.tsx'
import { PasswordForm } from './login.tsx'
import { RecordTable } from './record-table.tsx'

type AccountData = Extract<AppLoaderData, { page: 'account' }>

function plural(n: number, word: string) {
	return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** `/account` overview: identity, MCP endpoint, today's usage, password. */
export function Account(
	handle: Handle<{ data: AccountData; pathname: string }>,
) {
	return () => {
		const d = handle.props.data
		const u = d.usage
		const cap = (used: number, quota: number | null, unit = '') =>
			quota ? `${used}${unit} / ${quota}${unit}` : `${used}${unit}`
		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Account"
					description="Your self-hosted Kody: connected clients, usage and sign-in."
					currentHref={handle.props.pathname}
					actions={<SignOutForm action={routes.logout.href()} csrf={d.csrf} />}
				/>
				<AccountManagementPanel ariaLabel="Identity">
					<MetadataGrid
						items={[
							{ label: 'Signed in as', value: <strong>{d.email}</strong> },
							{
								label: 'Member since',
								value: <TimestampValue value={d.createdAt} />,
							},
							{
								label: 'MCP endpoint',
								value: <Code>{`${d.publicUrl}/mcp`}</Code>,
							},
						]}
					/>
					<Lede>
						Add the endpoint to any MCP client that supports OAuth (Claude,
						Cursor, VS Code, …) and approve the connection here — no token
						pasting needed. Clients without OAuth can use an API token.
					</Lede>
					<div
						mix={css({ display: 'flex', gap: spacing.sm, flexWrap: 'wrap' })}
					>
						<a href={routes.accountMcpOauthClients.href()}>
							<Badge>{plural(d.grantCount, 'connected client')}</Badge>
						</a>
						<a href={routes.accountApiTokens.href()}>
							<Badge>{plural(d.tokenCount, 'API token')}</Badge>
						</a>
						<Badge tone={d.hasPassword ? 'ok' : 'warn'}>
							{d.hasPassword ? 'password set' : 'no password'}
						</Badge>
					</div>
				</AccountManagementPanel>
				<AccountManagementPanel
					title="Today"
					description={`Execute timeout ${u.limits.executeTimeoutMs} ms · runs retained ${u.limits.runRetentionCount}.`}
				>
					<RecordTable
						mode="none"
						ariaLabel="Usage today"
						columns={[
							{ key: 'runs', label: 'Runs', primary: true },
							{ key: 'errors', label: 'Errors', align: 'end' },
							{ key: 'time', label: 'Execute time', align: 'end' },
							{ key: 'packages', label: 'Packages', align: 'end' },
							{ key: 'secrets', label: 'Secrets', align: 'end' },
							{ key: 'jobs', label: 'Jobs', align: 'end', drop: 3 },
							{ key: 'blobs', label: 'Blobs', align: 'end', drop: 2 },
						]}
						rows={[
							{
								id: 'today',
								cells: {
									runs: cap(u.today.runs, u.quotas.runsPerDay),
									errors: String(u.today.errors),
									time: cap(
										Math.round(u.today.executeMs / 1000),
										u.quotas.executeMsPerDay
											? Math.round(u.quotas.executeMsPerDay / 1000)
											: null,
										' s',
									),
									packages: cap(u.counts.packages, u.quotas.packages),
									secrets: cap(u.counts.secrets, u.quotas.secrets),
									jobs: String(u.counts.jobs),
									blobs: (
										<>
											{u.counts.blobs}{' '}
											<Muted small>
												({Math.round(u.counts.blobBytes / 1024)} KiB)
											</Muted>
										</>
									),
								},
							},
						]}
					/>
				</AccountManagementPanel>
				<AccountManagementPanel
					title="Password"
					description={
						d.hasPassword
							? 'Change the password you sign in with.'
							: 'Set a password so you can sign in without a token or link.'
					}
				>
					<PasswordForm form={d.passwordForm} csrf={d.csrf} />
				</AccountManagementPanel>
			</AccountManagementShell>
		)
	}
}
