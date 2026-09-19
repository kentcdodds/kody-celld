import { type Handle } from 'remix/ui'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	AccountManagementPanel,
	AccountManagementShell,
	AdminPageHeader,
	TimestampValue,
} from './account-management-components.tsx'
import { Code, Muted, SignOutForm } from './form-controls.tsx'
import { RecordTable } from './record-table.tsx'

type Data = Extract<AppLoaderData, { page: 'adminAudit' }>

/** `/console/audit`: registry-backed audit log (filters via `?actor=&action=&limit=`). */
export function AdminAudit(handle: Handle<{ data: Data; pathname: string }>) {
	return () => {
		const d = handle.props.data
		return (
			<AccountManagementShell>
				<AdminPageHeader
					title="Audit log"
					description="Operator and user actions that changed state. Credential values are never recorded, only their labels."
					currentHref={handle.props.pathname}
					actions={
						<SignOutForm action={routes.adminLogout.href()} csrf={d.csrf} />
					}
				/>
				<AccountManagementPanel ariaLabel="Audit entries">
					<RecordTable
						mode="none"
						ariaLabel="Audit entries"
						emptyLabel="Nothing recorded yet."
						countLabel={`${d.entries.length} shown`}
						columns={[
							{ key: 'when', label: 'When', primary: true },
							{ key: 'actor', label: 'Actor', drop: 3 },
							{ key: 'action', label: 'Action' },
							{ key: 'target', label: 'Target', drop: 2 },
							{ key: 'details', label: 'Details', drop: 1 },
						]}
						rows={d.entries.map((entry) => ({
							id: entry.id,
							cells: {
								when: <TimestampValue value={entry.at} />,
								actor: entry.actor,
								action: <Code>{entry.action}</Code>,
								target: entry.target ? <Muted small>{entry.target}</Muted> : '',
								details: entry.details ? (
									<Muted small>
										<code>{entry.details}</code>
									</Muted>
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
