import { css, type Handle } from 'remix/component'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { mutedLinkCss } from '#universal/styles/style-primitives.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
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
		const { data, pathname } = handle.props
		const { pkg } = data
		const detailHref = routes.accountPackageDetail.href({ name: pkg.name })

		return (
			<AccountManagementShell>
				<AccountPageHeader
					title={pkg.name}
					description={pkg.description ?? 'Saved package details.'}
					currentHref={pathname}
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
				<a href={routes.accountPackages.href()}>Back to packages</a>
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
							{ label: 'Files', value: String(pkg.files.length) },
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
				<AccountManagementPanel title="Files">
					<ul
						mix={css({
							margin: 0,
							paddingLeft: '1.2rem',
							display: 'grid',
							gap: spacing.xs,
							color: colors.text,
						})}
					>
						{pkg.files.map((file) => (
							<li key={file.path}>
								<a
									href={routes.accountPackageFiles.href({
										name: pkg.name,
										relativePath: file.path,
									})}
								>
									<Code>{file.path}</Code>
								</a>
								<Muted small> {file.bytes} bytes</Muted>
							</li>
						))}
					</ul>
				</AccountManagementPanel>
			</AccountManagementShell>
		)
	}
}
