import { css, type Handle } from 'remix/ui'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
import {
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	TimestampValue,
} from './account-management-components.tsx'
import { ActionForm, Code, Muted } from './form-controls.tsx'
import { RecordTable } from './record-table.tsx'

type Data = Extract<AppLoaderData, { page: 'accountJobs' }>

/** `/account/jobs`: package-owned schedules with pause/resume. */
export function AccountJobs(handle: Handle<{ data: Data; pathname: string }>) {
	return () => {
		const d = handle.props.data
		const action = routes.accountJobs.href()
		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Jobs"
					description="Recurring work declared by your packages (kody.jobs in the manifest). Paused jobs keep their schedule but do not run."
					currentHref={handle.props.pathname}
				/>
				<AccountManagementPanel ariaLabel="Scheduled jobs">
					<RecordTable
						mode="none"
						ariaLabel="Jobs"
						emptyLabel="No jobs. Jobs come from package manifests."
						countLabel={`${d.jobs.length} total`}
						columns={[
							{ key: 'job', label: 'Job', primary: true },
							{ key: 'schedule', label: 'Schedule', drop: 3 },
							{ key: 'next', label: 'Next run', drop: 2 },
							{ key: 'last', label: 'Last run', drop: 2 },
							{ key: 'status', label: 'Status', drop: 1 },
							{ key: 'actions', label: 'Actions' },
						]}
						rows={d.jobs.map((job) => ({
							id: job.id,
							cells: {
								job: (
									<>
										<strong>
											{job.packageName}/{job.jobName}
										</strong>
										{job.description ? (
											<>
												<br />
												<Muted small>{job.description}</Muted>
											</>
										) : null}
									</>
								),
								schedule: (
									<>
										<Code>{job.schedule}</Code>
										{job.timezone ? <Muted small> {job.timezone}</Muted> : null}
									</>
								),
								next: job.enabled ? (
									<TimestampValue value={job.nextRunAt} />
								) : (
									<Muted>paused</Muted>
								),
								last: <TimestampValue value={job.lastRunAt} fallback="never" />,
								status: (
									<>
										{job.lastStatus ?? '—'}
										{job.lastError ? (
											<>
												<br />
												<span
													mix={css({
														color: colors.error,
														fontSize: typography.fontSize.sm,
													})}
												>
													{job.lastError}
												</span>
											</>
										) : null}
									</>
								),
								actions: (
									<ActionForm
										action={action}
										csrf={d.csrf}
										fields={{
											action: 'toggle',
											id: job.id,
											enabled: job.enabled ? 'false' : 'true',
										}}
										label={job.enabled ? 'Pause' : 'Resume'}
									/>
								),
							},
						}))}
					/>
				</AccountManagementPanel>
			</AccountManagementShell>
		)
	}
}
