import { css, type Handle } from 'remix/ui'
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

/** `/account/packages`: saved packages, install from GitHub/URL, community publish. */
export function AccountPackages(
	handle: Handle<{ data: Data; pathname: string }>,
) {
	return () => {
		const d = handle.props.data
		const action = routes.accountPackages.href()
		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Packages"
					description="Code your assistant can run: saved from an MCP client with packageSave, installed from a repository, or forked from the community catalog."
					currentHref={handle.props.pathname}
				/>
				<AccountManagementPanel title="Install from GitHub or URL">
					{d.installError ? (
						<AccountManagementMessage tone="error">
							{d.installError}
						</AccountManagementMessage>
					) : null}
					<StackedForm action={action}>
						<CsrfInput token={d.csrf} />
						<Hidden name="action" value="install" />
						<Field
							label="Source"
							name="source"
							required
							placeholder="github:owner/repo/sub/dir#ref or https://…/package.tgz"
							value={d.installDraft.source}
						/>
						<Field
							label="Subdirectory (optional)"
							name="subdir"
							placeholder="examples/hello"
							value={d.installDraft.subdir}
						/>
						<div>
							<SubmitButton variant="secondary">Install</SubmitButton>
						</div>
					</StackedForm>
					<Lede>
						Allowed source hosts: <Code>{d.sourceHosts.join(', ')}</Code> (
						<Code>KODY_PACKAGE_SOURCE_HOSTS</Code>).
					</Lede>
				</AccountManagementPanel>
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
										<strong>{pkg.name}</strong>
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
