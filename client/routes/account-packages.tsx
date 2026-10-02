import { css, type Handle } from 'remix/component'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { mutedLinkCss } from '#universal/styles/style-primitives.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	TimestampValue,
} from './account-management-components.tsx'
import {
	ActionForm,
	Actions,
	Code,
	CsrfInput,
	DangerForm,
	Field,
	Hidden,
	Lede,
	Muted,
	StackedForm,
	SubmitButton,
} from './form-controls.tsx'
import { RecordTable } from './record-table.tsx'

type Data = Extract<AppLoaderData, { page: 'accountPackages' }>

/** `/account/packages`: saved packages, preview/install from GitHub/URL/kody.codes, community publish. */
export function AccountPackages(
	handle: Handle<{ data: Data; pathname: string }>,
) {
	return () => {
		const d = handle.props.data
		const action = routes.accountPackages.href()
		const preview = d.preview
		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Packages"
					description="Code your assistant can run: saved from an MCP client with packageSave, previewed and installed from a repository or public kody.codes package, or forked from the community catalog."
					currentHref={handle.props.pathname}
				/>
				<AccountManagementPanel title="Preview or install from a source">
					{d.installError ? (
						<AccountManagementMessage tone="error">
							{d.installError}
						</AccountManagementMessage>
					) : null}
					<StackedForm action={action}>
						<CsrfInput token={d.csrf} />
						<Field
							label="Source"
							name="source"
							required
							placeholder="https://kody.codes/@owner/pkg.git or github:owner/repo/sub/dir#ref"
							value={d.installDraft.source}
						/>
						<Field
							label="Subdirectory (optional)"
							name="subdir"
							placeholder="examples/hello"
							value={d.installDraft.subdir}
						/>
						<Actions>
							<SubmitButton name="action" value="preview" variant="secondary">
								Preview
							</SubmitButton>
							<SubmitButton name="action" value="install" variant="secondary">
								Install
							</SubmitButton>
						</Actions>
					</StackedForm>
					<Lede>
						Allowed source hosts: <Code>{d.sourceHosts.join(', ')}</Code> (
						<Code>KODY_PACKAGE_SOURCE_HOSTS</Code>). Public kody.codes listing
						URLs clone read-only via <Code>.git</Code>; secrets are never
						transferred.
					</Lede>
				</AccountManagementPanel>
				{preview ? (
					<AccountManagementPanel
						title={`Preview: ${preview.name}@${preview.version}`}
					>
						<Lede>
							{preview.description || 'No description.'}
							<br />
							<Muted small>
								Source <Code>{preview.source}</Code>
								{preview.commit ? (
									<>
										{' '}
										· commit <Code>{preview.commit.slice(0, 12)}</Code>
									</>
								) : null}{' '}
								· {preview.fileList.length} files
							</Muted>
						</Lede>
						{preview.warnings.length > 0 ? (
							<AccountManagementMessage tone="error">
								{preview.warnings.join(' ')}
							</AccountManagementMessage>
						) : null}
						<Lede>
							<strong>Declared surfaces</strong>
							<br />
							<Muted small>
								jobs: {preview.permissions.jobs.join(', ') || 'none'} ·
								webhooks: {preview.permissions.webhooks.join(', ') || 'none'} ·
								subscriptions:{' '}
								{preview.permissions.subscriptions.join(', ') || 'none'} ·
								secretProvider: {preview.permissions.secretProvider ?? 'none'} ·
								dependencies:{' '}
								{preview.permissions.dependencies.join(', ') || 'none'}
							</Muted>
						</Lede>
						<pre
							mix={css({
								margin: 0,
								maxHeight: '12rem',
								overflow: 'auto',
								whiteSpace: 'pre-wrap',
								fontSize: '0.85rem',
							})}
						>
							{preview.readme.slice(0, 4000)}
							{preview.readme.length > 4000 ? '\n…' : ''}
						</pre>
						<details>
							<summary>Files ({preview.fileList.length})</summary>
							<ul>
								{preview.fileList.map((path) => (
									<li key={path}>
										<Code>{path}</Code>
									</li>
								))}
							</ul>
						</details>
						<StackedForm action={action}>
							<CsrfInput token={d.csrf} />
							<Hidden
								name="source"
								value={d.installDraft.source || preview.source}
							/>
							<Hidden name="subdir" value={d.installDraft.subdir} />
							<Field
								label="Fork as (optional)"
								name="as"
								placeholder="@me/package-name"
								value={d.installDraft.as}
							/>
							<Actions>
								<SubmitButton name="action" value="install" variant="secondary">
									Install as {preview.name}
								</SubmitButton>
								<SubmitButton name="action" value="fork" variant="secondary">
									Fork
								</SubmitButton>
							</Actions>
						</StackedForm>
					</AccountManagementPanel>
				) : null}
				<AccountManagementPanel ariaLabel="Saved packages">
					<RecordTable
						mode="none"
						ariaLabel="Packages"
						emptyLabel="No packages saved. Use packageSave from an MCP client."
						countLabel={`${d.packages.length} total`}
						columns={[
							{ key: 'name', label: 'Name', primary: true },
							{ key: 'version', label: 'Version', drop: 3 },
							{ key: 'files', label: 'Files', align: 'end', drop: 2 },
							{ key: 'jobs', label: 'Jobs', align: 'end', drop: 2 },
							{ key: 'updated', label: 'Updated', drop: 1 },
							{ key: 'actions', label: 'Actions' },
						]}
						rows={d.packages.map((pkg) => ({
							id: pkg.name,
							cells: {
								name: (
									<>
										<a
											href={routes.accountPackageDetail.href({
												name: pkg.name,
											})}
										>
											<strong>{pkg.name}</strong>
										</a>
										{pkg.description ? (
											<>
												<br />
												<Muted small>{pkg.description}</Muted>
											</>
										) : null}
									</>
								),
								version: (
									<>
										{pkg.version}
										<br />
										<Muted small>{pkg.source}</Muted>
									</>
								),
								files: String(pkg.fileCount),
								jobs: String(pkg.jobCount),
								updated: <TimestampValue value={pkg.updatedAt} />,
								actions: (
									<Actions>
										<ActionForm
											action={action}
											csrf={d.csrf}
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
													action={action}
													csrf={d.csrf}
													fields={{ action: 'unpublish', name: pkg.name }}
													label="Unpublish"
												/>
											</>
										) : null}
										<DangerForm
											action={action}
											csrf={d.csrf}
											fields={{ action: 'delete', name: pkg.name }}
											label="Delete"
										/>
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
