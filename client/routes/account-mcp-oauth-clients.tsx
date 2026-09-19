import { type Handle } from 'remix/ui'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	IdValue,
	TimestampValue,
} from './account-management-components.tsx'
import { Actions, Code, DangerForm, Muted } from './form-controls.tsx'
import { RecordTable } from './record-table.tsx'

type Data = Extract<AppLoaderData, { page: 'accountMcpOauthClients' }>

/** `/account/clients`: OAuth grants issued by the built-in MCP authorization server. */
export function AccountMcpOauthClients(
	handle: Handle<{ data: Data; pathname: string }>,
) {
	return () => {
		const d = handle.props.data
		const action = routes.accountMcpOauthClients.href()
		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="MCP clients"
					description="Applications you approved through OAuth. Revoking a client invalidates its access and refresh tokens immediately; it will have to ask for approval again."
					currentHref={handle.props.pathname}
				/>
				<AccountManagementPanel ariaLabel="Connected clients">
					<RecordTable
						mode="none"
						ariaLabel="Connected MCP clients"
						emptyLabel="No connected clients yet."
						countLabel={`${d.grants.length} connected`}
						columns={[
							{ key: 'client', label: 'Client', primary: true },
							{ key: 'approved', label: 'Approved', drop: 2 },
							{ key: 'lastUsed', label: 'Last used', drop: 3 },
							{
								key: 'devices',
								label: 'Active devices',
								align: 'end',
								drop: 1,
							},
							{ key: 'actions', label: 'Actions' },
						]}
						rows={d.grants.map((grant) => ({
							id: grant.id,
							cells: {
								client: <strong>{grant.clientName}</strong>,
								approved: <TimestampValue value={grant.createdAt} />,
								lastUsed: (
									<TimestampValue value={grant.lastUsedAt} fallback="never" />
								),
								devices: String(grant.activeFamilies),
								actions: (
									<DangerForm
										action={action}
										csrf={d.csrf}
										fields={{ action: 'revoke', grantId: grant.id }}
										label="Revoke"
									/>
								),
							},
							primaryAccessory: (
								<IdValue value={grant.clientId} label="client id" />
							),
						}))}
					/>
					{d.grants.length === 0 ? (
						<Muted>
							Point an MCP client at <Code>{`${d.publicUrl}/mcp`}</Code> and
							approve it here.
						</Muted>
					) : (
						<Actions>
							<DangerForm
								action={action}
								csrf={d.csrf}
								fields={{ action: 'revoke_all' }}
								label="Revoke all clients"
							/>
						</Actions>
					)}
				</AccountManagementPanel>
			</AccountManagementShell>
		)
	}
}
