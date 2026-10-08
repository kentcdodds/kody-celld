import { css, type Handle } from 'remix/component'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	TimestampValue,
} from './account-management-components.tsx'
import { ActionForm, Actions, Badge, Lede, Muted } from './form-controls.tsx'
import { RecordTable } from './record-table.tsx'

type Data = Extract<AppLoaderData, { page: 'accountActivity' }>

function plural(n: number, one: string, many: string) {
	return `${n} ${n === 1 ? one : many}`
}

/**
 * `/account/runs`: recent runs with kody's soft triage (kody:
 * client/routes/account-activity.tsx, trimmed to the summary, the
 * Open errors / Recent runs toggle and Ignore / Resolve / Reopen).
 */
export function AccountActivity(
	handle: Handle<{ data: Data; pathname: string }>,
) {
	return () => {
		const d = handle.props.data
		const base = routes.accountActivity.href()
		const triageForm = (
			runId: string,
			triage: 'ignored' | 'resolved' | 'open',
			label: string,
		) => (
			<ActionForm
				action={base}
				csrf={d.csrf}
				fields={{ action: 'triage', runId, triage, view: d.view }}
				label={label}
			/>
		)
		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Activity"
					description="The most recent runs of ad hoc code, package exports and jobs."
					currentHref={handle.props.pathname}
				/>
				{d.error ? (
					<AccountManagementMessage tone="error">
						{d.error}
					</AccountManagementMessage>
				) : null}
				<Lede>
					{plural(d.summary.errors, 'open error', 'open errors')} ·{' '}
					{d.summary.ignored} ignored · {d.summary.resolved} resolved ·{' '}
					{d.summary.running} running
				</Lede>
				<nav aria-label="Activity view" mix={css(toggleCss)}>
					{d.view === 'errors' ? (
						<span aria-current="page" mix={css(toggleCurrentCss)}>
							Open errors
						</span>
					) : (
						<a href={`${base}?view=errors`} mix={css(toggleLinkCss)}>
							Open errors
						</a>
					)}
					{d.view === 'recent' ? (
						<span aria-current="page" mix={css(toggleCurrentCss)}>
							Recent runs
						</span>
					) : (
						<a href={`${base}?view=recent`} mix={css(toggleLinkCss)}>
							Recent runs
						</a>
					)}
				</nav>
				<AccountManagementPanel
					ariaLabel={d.view === 'errors' ? 'Open errors' : 'Recent runs'}
				>
					<RecordTable
						mode="none"
						scrollHeight="40rem"
						ariaLabel="Runs"
						emptyLabel={
							d.view === 'errors' ? 'No open errors.' : 'No runs yet.'
						}
						countLabel={`${d.runs.length} shown`}
						columns={[
							{ key: 'when', label: 'When', primary: true },
							{ key: 'kind', label: 'Kind', drop: 3 },
							{ key: 'package', label: 'Package', drop: 2 },
							{ key: 'status', label: 'Status' },
							{ key: 'duration', label: 'Duration', align: 'end', drop: 3 },
							{ key: 'error', label: 'Error' },
							{ key: 'triage', label: 'Triage' },
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
													? 'danger'
													: 'neutral'
										}
									>
										{run.status}
									</Badge>
								),
								duration:
									run.durationMs === null ? '—' : `${run.durationMs} ms`,
								error: run.error ? <Muted small>{run.error}</Muted> : '',
								triage:
									run.status !== 'error' ? (
										''
									) : run.errorTriage ? (
										<Actions>
											<Badge tone="neutral">{run.errorTriage}</Badge>
											{triageForm(run.id, 'open', 'Reopen')}
										</Actions>
									) : (
										<Actions>
											{triageForm(run.id, 'ignored', 'Ignore')}
											{triageForm(run.id, 'resolved', 'Resolve')}
										</Actions>
									),
							},
						}))}
					/>
				</AccountManagementPanel>
			</AccountManagementShell>
		)
	}
}

const toggleCss = {
	display: 'flex',
	gap: spacing.md,
	fontSize: typography.fontSize.sm,
}

const toggleCurrentCss = {
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
}

const toggleLinkCss = {
	color: colors.primaryText,
	textDecoration: 'none',
	'&:hover': { textDecoration: 'underline' },
}
