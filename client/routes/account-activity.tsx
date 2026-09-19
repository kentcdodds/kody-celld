import { type Handle } from 'remix/ui'
import { type AppLoaderData } from '#universal/loader-data.ts'
import {
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	TimestampValue,
} from './account-management-components.tsx'
import { Badge, Muted } from './form-controls.tsx'
import { RecordTable } from './record-table.tsx'

type Data = Extract<AppLoaderData, { page: 'accountActivity' }>

/** `/account/runs`: recent execute/job runs (secret names only, never values). */
export function AccountActivity(
	handle: Handle<{ data: Data; pathname: string }>,
) {
	return () => {
		const d = handle.props.data
		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Activity"
					description="The most recent runs of ad hoc code, package exports and jobs."
					currentHref={handle.props.pathname}
				/>
				<AccountManagementPanel ariaLabel="Recent runs">
					<RecordTable
						mode="none"
						ariaLabel="Runs"
						emptyLabel="No runs yet."
						countLabel={`${d.runs.length} shown`}
						columns={[
							{ key: 'when', label: 'When', primary: true },
							{ key: 'kind', label: 'Kind', drop: 3 },
							{ key: 'package', label: 'Package', drop: 2 },
							{ key: 'status', label: 'Status' },
							{ key: 'duration', label: 'Duration', align: 'end', drop: 3 },
							{ key: 'error', label: 'Error', drop: 1 },
						]}
						rows={d.runs.map((run) => ({
							id: run.id,
							cells: {
								when: <TimestampValue value={run.createdAt} />,
								kind: run.kind,
								package: run.packageName ?? <Muted>ad hoc</Muted>,
								status: (
									<Badge
										tone={
											run.status === 'success'
												? 'ok'
												: run.status === 'error'
													? 'warn'
													: 'neutral'
										}
									>
										{run.status}
									</Badge>
								),
								duration:
									run.durationMs === null ? '—' : `${run.durationMs} ms`,
								error: run.error ? <Muted small>{run.error}</Muted> : '',
							},
						}))}
					/>
				</AccountManagementPanel>
			</AccountManagementShell>
		)
	}
}
