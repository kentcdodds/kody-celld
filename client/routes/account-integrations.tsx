import { type Handle } from 'remix/ui'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	TimestampValue,
} from './account-management-components.tsx'
import { Badge, DangerForm, Muted } from './form-controls.tsx'
import { RecordTable } from './record-table.tsx'

type Data = Extract<AppLoaderData, { page: 'accountIntegrations' }>

/** `/account/integrations`: OAuth connections used via `{{integration-token:name}}`. */
export function AccountIntegrations(
	handle: Handle<{ data: Data; pathname: string }>,
) {
	return () => {
		const d = handle.props.data
		const action = routes.accountIntegrations.href()
		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Integrations"
					description="OAuth connections to third-party APIs ({{integration-token:name}}). Configure and connect them from an MCP client with integrationSave / integrationConnect."
					currentHref={handle.props.pathname}
				/>
				<AccountManagementPanel ariaLabel="Integrations">
					<RecordTable
						mode="none"
						ariaLabel="Integrations"
						emptyLabel="No integrations."
						countLabel={`${d.integrations.length} total`}
						columns={[
							{ key: 'name', label: 'Name', primary: true },
							{ key: 'provider', label: 'Provider', drop: 3 },
							{ key: 'status', label: 'Status' },
							{ key: 'expires', label: 'Expires', drop: 2 },
							{ key: 'hosts', label: 'Hosts', drop: 1 },
							{ key: 'actions', label: 'Actions' },
						]}
						rows={d.integrations.map((integration) => ({
							id: integration.name,
							cells: {
								name: <strong>{integration.name}</strong>,
								provider: integration.provider,
								status: (
									<Badge
										tone={integration.status === 'connected' ? 'ok' : 'warn'}
									>
										{integration.status}
									</Badge>
								),
								expires: (
									<TimestampValue value={integration.expiresAt} fallback="—" />
								),
								hosts: (
									<Muted small>{integration.allowedHosts.join(', ')}</Muted>
								),
								actions:
									integration.status === 'connected' ? (
										<DangerForm
											action={action}
											csrf={d.csrf}
											fields={{ action: 'disconnect', name: integration.name }}
											label="Disconnect"
										/>
									) : (
										''
									),
							},
						}))}
					/>
				</AccountManagementPanel>
			</AccountManagementShell>
		)
	}
}
