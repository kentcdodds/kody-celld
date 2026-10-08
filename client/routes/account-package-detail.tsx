import { css, type Handle } from 'remix/component'
import { PackageFilesExplorerIsland } from '#client/package-files-explorer-island.tsx'
import { getPageShellCss } from '#client/page-layout.ts'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { mutedLinkCss } from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementHeader,
	MetadataGrid,
	TimestampValue,
} from './account-management-components.tsx'
import {
	ActionForm,
	Actions,
	Badge,
	Code,
	DangerForm,
	Lede,
	Muted,
} from './form-controls.tsx'
import { RecordTable } from './record-table.tsx'

type Data = Extract<AppLoaderData, { page: 'accountPackageDetail' }>

export function AccountPackageDetail(
	handle: Handle<{ data: Data; pathname: string }>,
) {
	return () => {
		const { data } = handle.props
		const { pkg } = data
		const detailHref = routes.accountPackageDetail.href({ name: pkg.name })

		return (
			// kody: a package page is its files view, full width with no account
			// rail (same frame as /files); details follow below the explorer.
			<section mix={css(pageCss)}>
				<a href={routes.accountPackages.href()} mix={css(backLinkCss)}>
					<span aria-hidden="true">←</span> Packages
				</a>
				<AccountManagementHeader
					title={pkg.name}
					description={pkg.description ?? 'Saved package details.'}
					actions={
						<Actions>
							<ActionForm
								action={detailHref}
								csrf={data.csrf}
								fields={{ action: 'publish', name: pkg.name }}
								disabled={pkg.hidden}
								label={
									pkg.published
										? pkg.published.version === pkg.version
											? 'Republish'
											: `Publish v${pkg.version}`
										: 'Publish'
								}
							/>
							{pkg.published ? (
								<>
									<a
										href={routes.communityDetail.href({ name: pkg.name })}
										mix={css({
											...mutedLinkCss,
											alignSelf: 'center',
											whiteSpace: 'nowrap',
										})}
									>
										v{pkg.published.version} public
									</a>
									<ActionForm
										action={detailHref}
										csrf={data.csrf}
										fields={{ action: 'unpublish', name: pkg.name }}
										label="Unpublish"
									/>
								</>
							) : null}
							<DangerForm
								action={detailHref}
								csrf={data.csrf}
								fields={{ action: 'delete', name: pkg.name }}
								label="Delete"
							/>
						</Actions>
					}
				/>
				{data.error ? (
					<AccountManagementMessage tone="error">
						{data.error}
					</AccountManagementMessage>
				) : null}
				<AccountManagementPanel ariaLabel="Package">
					<MetadataGrid
						items={[
							{ label: 'Version', value: <Badge>v{pkg.version}</Badge> },
							{ label: 'Source', value: <Code>{pkg.source}</Code> },
							{
								label: 'Updated',
								value: <TimestampValue value={pkg.updatedAt} />,
							},
							{
								label: 'Created',
								value: <TimestampValue value={pkg.createdAt} />,
							},
							{ label: 'Files', value: String(pkg.fileCount) },
							{
								label: 'Community',
								value: pkg.published ? (
									<a href={routes.communityDetail.href({ name: pkg.name })}>
										Published v{pkg.published.version}
									</a>
								) : (
									'Not listed'
								),
							},
						]}
					/>
					{pkg.description ? null : <Lede>No description.</Lede>}
				</AccountManagementPanel>
				{/* kody: a package's page opens on its files (tree + README). */}
				<PackageFilesExplorerIsland data={data.files} embedded />
				<AccountManagementPanel title="Exports">
					<RecordTable
						mode="none"
						ariaLabel="Package exports"
						emptyLabel="No exports declared."
						columns={[
							{ key: 'specifier', label: 'Export', primary: true },
							{ key: 'path', label: 'Module' },
						]}
						rows={pkg.exports.map((entry) => ({
							id: entry.specifier,
							cells: {
								specifier: <Code>{entry.specifier}</Code>,
								path: <Code>{entry.path}</Code>,
							},
						}))}
					/>
				</AccountManagementPanel>
				<AccountManagementPanel title="Jobs">
					<RecordTable
						mode="none"
						ariaLabel="Package jobs"
						emptyLabel="No jobs declared."
						columns={[
							{ key: 'name', label: 'Job', primary: true },
							{ key: 'entry', label: 'Entry' },
							{ key: 'schedule', label: 'Schedule' },
							{ key: 'enabled', label: 'Status' },
						]}
						rows={pkg.jobs.map((job) => ({
							id: job.id,
							cells: {
								name: (
									<a href={routes.accountJobDetail.href({ jobId: job.id })}>
										{job.name}
									</a>
								),
								entry: <Code>{job.entry}</Code>,
								schedule: (
									<>
										<Code>{job.schedule}</Code>
										{job.timezone ? <Muted small> {job.timezone}</Muted> : null}
									</>
								),
								enabled: (
									<Badge
										tone={
											job.enabled === true
												? 'ok'
												: job.enabled === false
													? 'neutral'
													: 'warn'
										}
									>
										{job.enabled === null
											? 'No schedule'
											: job.enabled
												? 'Enabled'
												: 'Paused'}
									</Badge>
								),
							},
						}))}
					/>
				</AccountManagementPanel>
				{pkg.webhooks.length > 0 ? (
					<AccountManagementPanel title="Webhooks">
						<RecordTable
							mode="none"
							ariaLabel="Package webhooks"
							columns={[
								{ key: 'name', label: 'Webhook', primary: true },
								{ key: 'export', label: 'Export' },
								{ key: 'mode', label: 'Mode' },
								{ key: 'rate', label: 'Rate limit' },
								{ key: 'verification', label: 'Verification' },
							]}
							rows={pkg.webhooks.map((webhook) => ({
								id: webhook.name,
								cells: {
									name: (
										<>
											<strong>{webhook.name}</strong>
											{webhook.description ? (
												<>
													<br />
													<Muted small>{webhook.description}</Muted>
												</>
											) : null}
										</>
									),
									export: <Code>{webhook.export}</Code>,
									mode: `${webhook.responseMode} / ${webhook.inputMode}`,
									rate: `${webhook.rateLimitPerMinute}/min`,
									verification: webhook.verification ?? 'None',
								},
							}))}
						/>
					</AccountManagementPanel>
				) : null}
			</section>
		)
	}
}

const pageCss = {
	...getPageShellCss('app'),
	display: 'grid',
	gap: spacing.xl,
	alignContent: 'start',
}

// Same look as the explorer's own back link on /files.
const backLinkCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: spacing.xs,
	justifySelf: 'start',
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.medium,
	color: colors.primaryText,
	textDecoration: 'none',
	'&:hover': { color: colors.text },
}
