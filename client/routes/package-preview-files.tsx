import { css, type Handle } from 'remix/component'
import { PackageFilesExplorerIsland } from '#client/package-files-explorer-island.tsx'
import { AccountManagementMessage } from './account-management-components.tsx'
import {
	Actions,
	Code,
	CsrfInput,
	Field,
	Hidden,
	Lede,
	Muted,
	StackedForm,
	SubmitButton,
} from './form-controls.tsx'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { spacing } from '#universal/styles/tokens.ts'
import {
	layoutMaxWidths,
	pageGutter,
} from '#universal/styles/style-primitives.ts'

type Data = Extract<AppLoaderData, { page: 'accountPackagePreviewFiles' }>

// Same width and gutter as kody's explorer <article>, so the summary lines up with the tree.
const summaryCss = {
	maxWidth: layoutMaxWidths.extended,
	marginInline: 'auto',
	padding: `${spacing.lg} ${pageGutter} 0`,
	display: 'grid',
	gap: spacing.md,
}

/** `/account/packages/preview/:source/files/*` — review a remote package in kody's explorer before installing it. */
export function PackagePreviewFiles(
	handle: Handle<{ data: Data; pathname: string }>,
) {
	return () => {
		const { data } = handle.props
		const p = data.preview
		return (
			<>
				<section aria-label="Package preview" mix={css(summaryCss)}>
					<Lede>
						Preview of{' '}
						<strong>
							{p.name}@{p.version}
						</strong>{' '}
						— not installed.
						<br />
						<Muted small>
							Source <Code>{p.source}</Code>
							{p.commit ? (
								<>
									{' '}
									· commit <Code>{p.commit.slice(0, 12)}</Code>
								</>
							) : null}{' '}
							· {data.files.paths.length} files
						</Muted>
					</Lede>
					{p.warnings.length > 0 ? (
						<AccountManagementMessage tone="error">
							{p.warnings.join(' ')}
						</AccountManagementMessage>
					) : null}
					<Muted small>
						jobs: {p.permissions.jobs.join(', ') || 'none'} · webhooks:{' '}
						{p.permissions.webhooks.join(', ') || 'none'} · subscriptions:{' '}
						{p.permissions.subscriptions.join(', ') || 'none'} · secretProvider:{' '}
						{p.permissions.secretProvider ?? 'none'} · dependencies:{' '}
						{p.permissions.dependencies.join(', ') || 'none'}
					</Muted>
					<StackedForm action={routes.accountPackages.href()}>
						<CsrfInput token={data.csrf} />
						<Hidden name="source" value={p.source} />
						<Hidden name="subdir" value={p.subdir} />
						<Field
							label="Fork as (optional)"
							name="as"
							placeholder="@me/package-name"
							value=""
						/>
						<Actions>
							<SubmitButton name="action" value="install" variant="secondary">
								Install as {p.name}
							</SubmitButton>
							<SubmitButton name="action" value="fork" variant="secondary">
								Fork
							</SubmitButton>
						</Actions>
					</StackedForm>
				</section>
				<PackageFilesExplorerIsland data={data.files} />
			</>
		)
	}
}
