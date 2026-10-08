import { css, type Handle, type RemixNode } from 'remix/component'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	activityErrorReviewPrompt,
	buildRunFixPrompt,
} from '#universal/run-fix-prompt.ts'
import { cardTitleCss } from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	MetadataGrid,
	TimestampValue,
} from './account-management-components.tsx'
import {
	ActionForm,
	Actions,
	Badge,
	Code,
	Lede,
	Muted,
	PreBlock,
} from './form-controls.tsx'
import { RecordTable, recordBodyCss } from './record-table.tsx'

type Data = Extract<AppLoaderData, { page: 'accountActivity' }>
type RunDetail = NonNullable<Data['selected']>

function plural(n: number, one: string, many: string) {
	return `${n} ${n === 1 ? one : many}`
}

function statusTone(status: string) {
	return status === 'success' ? 'ok' : status === 'error' ? 'danger' : 'neutral'
}

/**
 * `/account/runs(/:runId)`: recent runs with kody's soft triage (kody:
 * client/routes/account-activity.tsx + account-activity-detail.tsx, trimmed
 * to the summary, the Open errors / Recent runs toggle, Ignore / Resolve /
 * Reopen, the expanded run with its logs, and copyable agent prompts).
 */
export function AccountActivity(
	handle: Handle<{ data: Data; pathname: string }>,
) {
	return () => {
		const d = handle.props.data
		const base = routes.accountActivity.href()
		const runHref = (id: string) =>
			`${base}/${encodeURIComponent(id)}?view=${d.view}`
		const triageForm = (
			runId: string,
			triage: 'ignored' | 'resolved' | 'open',
			label: string,
			open?: boolean,
		) => (
			<ActionForm
				action={base}
				csrf={d.csrf}
				fields={{
					action: 'triage',
					runId,
					triage,
					view: d.view,
					...(open ? { open: runId } : {}),
				}}
				label={label}
				ariaLabel={`${label} run ${runId}`}
			/>
		)
		const triageActions = (
			run: { id: string; status: string; errorTriage: string | null },
			open?: boolean,
		) =>
			run.status !== 'error' ? null : run.errorTriage ? (
				<Actions>
					<Badge tone="neutral">{run.errorTriage}</Badge>
					{triageForm(run.id, 'open', 'Reopen', open)}
				</Actions>
			) : (
				<Actions>
					{triageForm(run.id, 'ignored', 'Ignore', open)}
					{triageForm(run.id, 'resolved', 'Resolve', open)}
				</Actions>
			)

		const runRecord = d.selected ? (
			renderRunDetail(d.selected, triageActions(d.selected, true))
		) : d.selectedId ? (
			<div mix={css({ ...recordBodyCss, gap: spacing.sm })}>
				<h2 mix={css(cardTitleCss)}>Run not found</h2>
				<p mix={css({ margin: 0, color: colors.textMuted })}>
					This run does not exist for this account, or it was pruned from the
					run history.
				</p>
			</div>
		) : null

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
				{d.view === 'errors' && d.summary.errors > 0 ? (
					<figure mix={css(promptFigureCss)}>
						<figcaption mix={css(promptCaptionCss)}>Ask your agent</figcaption>
						<blockquote mix={css(promptQuoteCss)}>
							{activityErrorReviewPrompt}
						</blockquote>
						<CopyTextButton
							value={activityErrorReviewPrompt}
							idleLabel="Copy prompt"
							variant="ghost"
						/>
					</figure>
				) : null}
				<AccountManagementPanel
					ariaLabel={d.view === 'errors' ? 'Open errors' : 'Recent runs'}
				>
					<div mix={css(wholeRowLinkCss)}>
						<RecordTable
							mode="expand"
							ariaLabel="Runs"
							selectedId={d.selectedId}
							record={runRecord}
							emptyLabel={
								d.view === 'errors' ? 'No open errors.' : 'No runs yet.'
							}
							countLabel={
								d.view === 'errors' && d.summary.errors > d.runs.length
									? `${d.runs.length} of ${d.summary.errors}`
									: `${d.runs.length} shown`
							}
							columns={[
								{ key: 'when', label: 'When', primary: true },
								// No `drop` columns: the expanded run's row spans every column,
								// and dropped ones would still take width. Kind and duration
								// are in the expanded run.
								{ key: 'package', label: 'Package' },
								{ key: 'status', label: 'Status' },
								{ key: 'error', label: 'Error' },
								{ key: 'triage', label: 'Triage' },
							]}
							rows={d.runs.map((run) => ({
								id: run.id,
								// The open run links back to the list: a second click closes it.
								href:
									run.id === d.selectedId
										? `${base}?view=${d.view}`
										: runHref(run.id),
								cells: {
									when: <TimestampValue value={run.createdAt} />,
									package: run.packageName ?? <Muted>ad hoc {run.kind}</Muted>,
									status: (
										<Badge tone={statusTone(run.status)}>{run.status}</Badge>
									),
									error: run.error ? (
										<span mix={css(oneLineCss)} title={run.error}>
											<Muted small>{run.error}</Muted>
										</span>
									) : (
										''
									),
									triage: triageActions(run) ?? '',
								},
							}))}
						/>
					</div>
				</AccountManagementPanel>
			</AccountManagementShell>
		)
	}
}

function renderRunDetail(run: RunDetail, actions: RemixNode) {
	const fixPrompt =
		run.status === 'error'
			? buildRunFixPrompt({
					id: run.id,
					kind: run.kind,
					packageName: run.packageName,
					jobId: run.jobId,
					error: run.error,
				})
			: null
	return (
		<section
			data-testid="run-detail"
			mix={css({ ...recordBodyCss, gap: spacing.md })}
		>
			<h2 mix={css(cardTitleCss)}>
				{run.packageName ?? 'Ad hoc'} · {run.kind}
			</h2>
			<MetadataGrid
				items={[
					{
						label: 'Status',
						value: <Badge tone={statusTone(run.status)}>{run.status}</Badge>,
					},
					{
						label: 'Triage',
						value: run.errorTriage ?? (run.status === 'error' ? 'open' : '—'),
					},
					...(run.triageNote
						? [{ label: 'Triage note', value: run.triageNote }]
						: []),
					...(run.triagedAt
						? [
								{
									label: 'Triaged',
									value: (
										<>
											<TimestampValue value={run.triagedAt} />
											{run.triagedBy ? ` by ${run.triagedBy}` : ''}
										</>
									),
								},
							]
						: []),
					{ label: 'Started', value: <TimestampValue value={run.createdAt} /> },
					{
						label: 'Duration',
						value: run.durationMs === null ? '—' : `${run.durationMs} ms`,
					},
					{
						label: 'Package',
						value: run.packageName ? (
							<a
								href={routes.accountPackageDetail.href({
									name: run.packageName,
								})}
							>
								{run.packageName}
							</a>
						) : (
							'ad hoc'
						),
					},
					...(run.jobId
						? [
								{
									label: 'Job',
									value: (
										<a
											href={routes.accountJobDetail.href({ jobId: run.jobId })}
										>
											{run.jobId}
										</a>
									),
								},
							]
						: []),
					{ label: 'Run id', value: <Code>{run.id}</Code> },
				]}
			/>
			{run.error ? detailBlock('Error', run.error) : null}
			{detailBlock(
				`Logs (${run.logs.length})`,
				run.logs.length > 0 ? run.logs.join('\n') : 'No log lines.',
			)}
			{run.result !== null ? detailBlock('Result', run.result) : null}
			{run.warnings.length > 0
				? detailBlock('Warnings', run.warnings.join('\n'))
				: null}
			{run.gateway.length > 0
				? detailBlock(
						'Gateway',
						run.gateway
							.map(
								(g) =>
									`${g.outcome} ${g.method} ${g.host}${g.status === null ? '' : ` → ${g.status}`}${g.reason ? ` (${g.reason})` : ''}`,
							)
							.join('\n'),
					)
				: null}
			{fixPrompt ? (
				<figure mix={css(promptFigureCss)}>
					<figcaption mix={css(promptCaptionCss)}>Fix with AI</figcaption>
					<blockquote mix={css(promptQuoteCss)}>{fixPrompt}</blockquote>
					<CopyTextButton
						value={fixPrompt}
						idleLabel="Copy fix prompt"
						variant="ghost"
					/>
				</figure>
			) : null}
			{actions}
		</section>
	)
}

function detailBlock(label: string, text: string) {
	return (
		<div mix={css({ display: 'grid', gap: spacing.xs, minWidth: 0 })}>
			<span mix={css(promptCaptionCss)}>{label}</span>
			<div mix={css({ maxHeight: '24rem', overflow: 'auto' })}>
				<PreBlock>{text}</PreBlock>
			</div>
		</div>
	)
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

const promptFigureCss = {
	margin: 0,
	display: 'grid',
	gap: spacing.sm,
	justifyItems: 'start',
}

const promptCaptionCss = {
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
}

const promptQuoteCss = {
	margin: 0,
	paddingLeft: spacing.md,
	borderLeft: `3px solid ${colors.border}`,
	color: colors.textMuted,
	lineHeight: 1.5,
	overflowWrap: 'anywhere' as const,
}

const oneLineCss = {
	display: 'block',
	whiteSpace: 'nowrap' as const,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
}

// The whole row opens the run: the row's own link (the When cell) is
// stretched over the row, and the triage forms sit above it so their buttons
// still submit. CSS only, so it works with JavaScript off.
const wholeRowLinkCss = {
	'& tbody tr:has(a[aria-expanded])': {
		position: 'relative',
		cursor: 'pointer',
	},
	'& tbody tr a[aria-expanded]::after': {
		content: "''",
		position: 'absolute',
		inset: 0,
	},
	'& tbody tr form': { position: 'relative', zIndex: 1 },
}
