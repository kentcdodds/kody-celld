import { css, type Handle } from 'remix/ui'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { spacing } from '#universal/styles/tokens.ts'
import {
	AccountManagementPanel,
	AccountManagementShell,
	AdminPageHeader,
	IdValue,
	MetadataGrid,
	TimestampValue,
} from './account-management-components.tsx'
import {
	Badge,
	Code,
	CsrfInput,
	DangerForm,
	Field,
	Hidden,
	Lede,
	SignOutForm,
	SubmitButton,
} from './form-controls.tsx'
import { RecordTable } from './record-table.tsx'

type Data = Extract<AppLoaderData, { page: 'adminUserDetail' }>

/** `/console/users/:userId`: the only place secret hosts can be approved. */
export function AdminUserDetail(
	handle: Handle<{ data: Data; pathname: string }>,
) {
	return () => {
		const d = handle.props.data
		const unlimited = (n: number | null) => (n ? String(n) : 'unlimited')
		return (
			<AccountManagementShell>
				<AdminPageHeader
					title={d.user.email}
					description="Account overview, secret host approvals and quotas."
					currentHref={handle.props.pathname}
					actions={
						<SignOutForm action={routes.adminLogout.href()} csrf={d.csrf} />
					}
				/>
				<AccountManagementPanel ariaLabel="User">
					<MetadataGrid
						items={[
							{
								label: 'User id',
								value: <IdValue value={d.user.id} label="user id" />,
							},
							{
								label: 'Created',
								value: <TimestampValue value={d.user.createdAt} />,
							},
						]}
					/>
					<div
						mix={css({ display: 'flex', gap: spacing.sm, flexWrap: 'wrap' })}
					>
						<Badge>{d.counts.tokens} API tokens</Badge>
						<Badge>{d.counts.grants} MCP clients</Badge>
						<Badge>{d.counts.sessions} browser sessions</Badge>
						<Badge>{d.counts.jobs} jobs</Badge>
						<Badge>{d.counts.runsToday} runs today</Badge>
					</div>
					<div>
						<DangerForm
							action={d.action}
							csrf={d.csrf}
							fields={{ action: 'revoke_sessions' }}
							label="Sign out everywhere"
						/>
					</div>
				</AccountManagementPanel>
				<AccountManagementPanel
					title="Approved secret hosts"
					description="Only the operator can approve hosts; secrets are injected solely into requests to these hosts."
				>
					<RecordTable
						mode="none"
						ariaLabel="Approved secret hosts"
						emptyLabel="None."
						columns={[
							{ key: 'host', label: 'Host', primary: true },
							{ key: 'approved', label: 'Approved', drop: 2 },
							{ key: 'by', label: 'By', drop: 3 },
							{ key: 'actions', label: 'Actions' },
						]}
						rows={d.hosts.map((host) => ({
							id: host.host,
							cells: {
								host: <Code>{host.host}</Code>,
								approved: <TimestampValue value={host.approvedAt} />,
								by: host.approvedBy,
								actions: (
									<DangerForm
										action={d.action}
										csrf={d.csrf}
										fields={{ action: 'revoke_host', host: host.host }}
										label="Revoke"
									/>
								),
							},
						}))}
					/>
					<form
						method="post"
						action={d.action}
						mix={css({
							display: 'flex',
							gap: spacing.sm,
							alignItems: 'flex-end',
							flexWrap: 'wrap',
						})}
					>
						<CsrfInput token={d.csrf} />
						<Hidden name="action" value="approve_host" />
						<Field
							label="Host"
							name="host"
							placeholder="api.example.com"
							required
						/>
						<SubmitButton>Approve host</SubmitButton>
					</form>
				</AccountManagementPanel>
				<AccountManagementPanel title="Quotas">
					<MetadataGrid
						items={[
							{ label: 'Runs / day', value: unlimited(d.quotas.runsPerDay) },
							{
								label: 'Execute ms / day',
								value: unlimited(d.quotas.executeMsPerDay),
							},
							{ label: 'Packages', value: unlimited(d.quotas.packages) },
							{ label: 'Secrets', value: unlimited(d.quotas.secrets) },
						]}
					/>
					<Lede>
						Override with <Code>{`PUT /admin/users/${d.user.id}/quota`}</Code>.
					</Lede>
				</AccountManagementPanel>
			</AccountManagementShell>
		)
	}
}
