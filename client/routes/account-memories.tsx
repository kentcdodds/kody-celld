import { css, type Handle } from 'remix/ui'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	accountInputCss,
	accountFieldCss,
	accountFieldLabelCss,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	MetadataGrid,
	TimestampValue,
} from './account-management-components.tsx'
import { DangerForm, SubmitButton } from './form-controls.tsx'
import {
	RecordChips,
	RecordTable,
	recordBodyCss,
	recordCellClamp,
} from './record-table.tsx'
import {
	cardTitleCss,
	descriptionCss,
} from '#universal/styles/style-primitives.ts'

type Data = Extract<AppLoaderData, { page: 'accountMemories' }>

const clampedCellCss = css(recordCellClamp(30))

function statusLabel(status: Data['memories'][number]['status']) {
	switch (status) {
		case 'active':
			return 'Active'
		case 'archived':
			return 'Archived'
		case 'deleted':
			return 'Deleted'
		default: {
			const unhandled: never = status
			return String(unhandled)
		}
	}
}

function statusColor(status: Data['memories'][number]['status']) {
	switch (status) {
		case 'active':
			return colors.primary
		case 'archived':
			return colors.textMuted
		case 'deleted':
			return colors.error
		default: {
			const unhandled: never = status
			return String(unhandled)
		}
	}
}

function isWebUri(uri: string) {
	return /^https?:\/\//i.test(uri)
}

function formatOptional(value: string | null) {
	return value?.trim() ? value : '—'
}

export function AccountMemories(
	handle: Handle<{ data: Data; pathname: string }>,
) {
	return () => {
		const d = handle.props.data
		const query = new URLSearchParams()
		if (d.query) query.set('q', d.query)
		if (d.includeDeleted) query.set('includeDeleted', '1')
		const search = query.size > 0 ? `?${query.toString()}` : ''
		const memoryRecord = d.selected ? (
			<section mix={css(recordBodyCss)}>
				<div mix={css({ display: 'grid', gap: spacing.xs })}>
					<h2 mix={css(cardTitleCss)}>{d.selected.subject}</h2>
					<p mix={css(descriptionCss)}>{d.selected.summary}</p>
				</div>

				<MetadataGrid
					items={[
						{
							label: 'Status',
							value: (
								<span mix={css({ color: statusColor(d.selected.status) })}>
									{statusLabel(d.selected.status)}
								</span>
							),
						},
						{ label: 'Category', value: formatOptional(d.selected.category) },
						{
							label: 'Tags',
							value:
								d.selected.tags.length > 0 ? d.selected.tags.join(', ') : '—',
						},
						{
							label: 'Dedupe key',
							value: formatOptional(d.selected.dedupeKey),
						},
						{
							label: 'Created',
							value: <TimestampValue value={d.selected.createdAt} />,
						},
						{
							label: 'Updated',
							value: <TimestampValue value={d.selected.updatedAt} />,
						},
						{
							label: 'Last accessed',
							value: <TimestampValue value={d.selected.lastAccessedAt} />,
						},
						{
							label: 'Deleted',
							value: <TimestampValue value={d.selected.deletedAt} />,
						},
					]}
				/>

				<div mix={css(accountFieldCss)}>
					<span mix={css(accountFieldLabelCss)}>Details</span>
					<p
						mix={css({
							margin: 0,
							padding: spacing.sm,
							borderRadius: radius.md,
							border: `1px solid ${colors.border}`,
							backgroundColor: colors.background,
							color: colors.text,
							whiteSpace: 'pre-wrap',
							overflowWrap: 'anywhere',
						})}
					>
						{d.selected.details.trim() ? d.selected.details : '—'}
					</p>
				</div>

				<div mix={css(accountFieldCss)}>
					<span mix={css(accountFieldLabelCss)}>Source URIs</span>
					{d.selected.sourceUris.length === 0 ? (
						<p mix={css({ margin: 0, color: colors.textMuted })}>—</p>
					) : (
						<ul
							mix={css({
								margin: 0,
								paddingLeft: spacing.lg,
								display: 'grid',
								gap: spacing.xs,
							})}
						>
							{d.selected.sourceUris.map((uri) => (
								<li key={uri}>
									{isWebUri(uri) ? (
										<a
											href={uri}
											target="_blank"
											rel="noreferrer"
											mix={css({
												color: colors.primary,
												overflowWrap: 'anywhere',
											})}
										>
											{uri}
										</a>
									) : (
										<span mix={css({ overflowWrap: 'anywhere' })}>{uri}</span>
									)}
								</li>
							))}
						</ul>
					)}
				</div>

				<div
					mix={css({
						display: 'flex',
						gap: spacing.sm,
						flexWrap: 'wrap',
						alignItems: 'center',
					})}
				>
					{d.selected.status !== 'deleted' ? (
						<DangerForm
							action={routes.accountMemories.href()}
							csrf={d.csrf}
							fields={{ action: 'delete', memoryId: d.selected.id }}
							label="Soft delete"
						/>
					) : null}
					<DangerForm
						action={routes.accountMemories.href()}
						csrf={d.csrf}
						fields={{
							action: 'delete',
							memoryId: d.selected.id,
							force: 'true',
						}}
						label="Delete permanently"
					/>
				</div>
			</section>
		) : d.selectedId ? (
			<div mix={css({ ...recordBodyCss, gap: spacing.sm })}>
				<h2 mix={css(cardTitleCss)}>Memory not found</h2>
				<p mix={css({ margin: 0, color: colors.textMuted })}>
					This memory does not exist for this account or is unavailable.
				</p>
			</div>
		) : null

		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Memories"
					description="Long-term memories Kody stores for your account. Agents create and update them; you can browse, filter, and delete here."
					currentHref={handle.props.pathname}
				/>
				<AccountManagementPanel ariaLabel="Saved memories">
					<p
						mix={css({
							margin: 0,
							color: colors.textMuted,
							fontSize: typography.fontSize.sm,
						})}
					>
						Showing up to the 100 most recent memories. Agents create them
						through verify and upsert.
					</p>
					<RecordTable
						mode="expand"
						ariaLabel="Saved memories"
						selectedId={d.selectedId}
						countLabel={`${d.memories.length} of ${d.total} shown`}
						emptyLabel={
							d.total === 0
								? 'No memories yet. Agents create them through verify and upsert.'
								: 'No memories match the current filters.'
						}
						toolbar={
							<form
								method="get"
								action={routes.accountMemories.href()}
								mix={css({
									display: 'flex',
									alignItems: 'center',
									gap: spacing.sm,
									flexWrap: 'wrap',
									width: '100%',
								})}
							>
								<input
									type="search"
									name="q"
									value={d.query}
									placeholder="Search subject, category, tags, summary"
									aria-label="Search memories"
									mix={css({
										...accountInputCss,
										flex: '1 1 18rem',
									})}
								/>
								<label
									mix={css({
										display: 'flex',
										alignItems: 'center',
										gap: spacing.xs,
										flex: 'none',
										color: colors.textMuted,
										fontSize: typography.fontSize.sm,
										whiteSpace: 'nowrap',
									})}
								>
									<input
										type="checkbox"
										name="includeDeleted"
										value="1"
										checked={d.includeDeleted}
									/>
									Include deleted
								</label>
								<SubmitButton variant="secondary">Search</SubmitButton>
							</form>
						}
						columns={[
							{ key: 'subject', label: 'Subject', primary: true },
							{ key: 'status', label: 'Status' },
							{ key: 'category', label: 'Category' },
							{ key: 'tags', label: 'Tags' },
						]}
						rows={d.memories.map((memory) => ({
							id: memory.id,
							href: `${routes.accountMemories.href()}/${encodeURIComponent(memory.id)}${search}`,
							cells: {
								subject: <span mix={clampedCellCss}>{memory.subject}</span>,
								status: (
									<span mix={css({ color: statusColor(memory.status) })}>
										{statusLabel(memory.status)}
									</span>
								),
								category: memory.category ?? '—',
								tags: <RecordChips items={memory.tags} empty="—" />,
							},
						}))}
						record={memoryRecord}
					/>
				</AccountManagementPanel>
			</AccountManagementShell>
		)
	}
}
