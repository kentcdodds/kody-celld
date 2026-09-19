import { css, type Handle, type RemixNode } from 'remix/ui'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	getPrimaryButtonCss,
	layoutMaxWidths,
	mutedLinkCss,
	pageGutter,
	pageHeadCss,
} from '#universal/styles/style-primitives.ts'
import { spacing } from '#universal/styles/tokens.ts'
import {
	AccountManagementPanel,
	MetadataGrid,
	TimestampValue,
	accountInputCss,
} from './account-management-components.tsx'
import { Badge, Code, Lede, Muted, PreBlock } from './form-controls.tsx'
import { RecordTable } from './record-table.tsx'

type IndexData = Extract<AppLoaderData, { page: 'community' }>
type DetailData = Extract<AppLoaderData, { page: 'communityDetail' }>
type NotFoundData = Extract<AppLoaderData, { page: 'communityNotFound' }>

function plural(n: number, word: string) {
	return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** Public page column: centred head, hairline sections, no account nav. */
function PublicPage(
	handle: Handle<{
		title: RemixNode
		description?: RemixNode
		children: RemixNode
	}>,
) {
	return () => (
		<section
			mix={css({
				maxWidth: layoutMaxWidths.extended,
				margin: '0 auto',
				padding: `clamp(2rem, 5vw, 3.5rem) ${pageGutter} clamp(3rem, 7vw, 5rem)`,
				boxSizing: 'border-box',
				display: 'grid',
				gap: 'clamp(2rem, 4vw, 2.75rem)',
			})}
		>
			<div mix={css(pageHeadCss)}>
				<h1>{handle.props.title}</h1>
				{handle.props.description ? <p>{handle.props.description}</p> : null}
			</div>
			{handle.props.children}
		</section>
	)
}

/** `/community`: public, no sign-in; renders only what CommunityStore exposes. */
export function Community(handle: Handle<{ data: IndexData }>) {
	return () => {
		const d = handle.props.data
		return (
			<PublicPage
				title={
					<>
						Community <em>packages</em>
					</>
				}
				description={`${plural(d.stats.packages, 'package')} from ${plural(d.stats.publishers, 'publisher')}, ${plural(d.stats.installs, 'install')}.`}
			>
				<AccountManagementPanel ariaLabel="Search">
					<form
						method="get"
						action={routes.community.href()}
						mix={css({
							display: 'flex',
							gap: spacing.sm,
							flexWrap: 'wrap',
							alignItems: 'center',
						})}
					>
						<input
							name="q"
							type="search"
							aria-label="Search packages"
							placeholder="Search name, description, keywords"
							value={d.query}
							mix={css({
								...accountInputCss,
								flex: '1 1 18rem',
								maxWidth: '32rem',
							})}
						/>
						<button type="submit" mix={css(getPrimaryButtonCss())}>
							Search
						</button>
					</form>
					<Lede>
						Publish your own with <Code>communityPublish</Code> or from{' '}
						<a href={routes.accountPackages.href()}>your packages</a>.
					</Lede>
				</AccountManagementPanel>
				<AccountManagementPanel ariaLabel="Catalog">
					<RecordTable
						mode="none"
						ariaLabel="Community packages"
						emptyLabel={
							d.query ? 'No packages match.' : 'Nothing published yet.'
						}
						countLabel={`${d.listings.length} shown`}
						columns={[
							{ key: 'name', label: 'Package', primary: true },
							{ key: 'version', label: 'Version', drop: 3 },
							{ key: 'publisher', label: 'Publisher', drop: 2 },
							{ key: 'installs', label: 'Installs', align: 'end', drop: 2 },
							{ key: 'updated', label: 'Updated', drop: 1 },
						]}
						rows={d.listings.map((listing) => ({
							id: listing.name,
							href: routes.communityDetail.href({ name: listing.name }),
							cells: {
								name: (
									<>
										<strong>{listing.name}</strong>
										{listing.description ? (
											<>
												<br />
												<Muted small>{listing.description}</Muted>
											</>
										) : null}
									</>
								),
								version: listing.version,
								publisher: listing.publisher,
								installs: String(listing.installs),
								updated: <TimestampValue value={listing.updatedAt} />,
							},
						}))}
					/>
				</AccountManagementPanel>
			</PublicPage>
		)
	}
}

export function CommunityNotFound(handle: Handle<{ data: NotFoundData }>) {
	return () => (
		<PublicPage title="Not found">
			<AccountManagementPanel ariaLabel="Not found">
				<p>
					No community package named <Code>{handle.props.data.name}</Code>.
				</p>
				<p>
					<a href={routes.community.href()} mix={css(mutedLinkCss)}>
						Back to the catalog
					</a>
				</p>
			</AccountManagementPanel>
		</PublicPage>
	)
}

/** `/community/:name`: manifest, files and README of one listing. */
export function CommunityDetail(handle: Handle<{ data: DetailData }>) {
	return () => {
		const { pkg, publicUrl } = handle.props.data
		return (
			<PublicPage
				title={
					<>
						<a href={routes.community.href()} mix={css(mutedLinkCss)}>
							Community
						</a>{' '}
						/ {pkg.name}
					</>
				}
				description={pkg.description ?? undefined}
			>
				<AccountManagementPanel ariaLabel="Package">
					<MetadataGrid
						items={[
							{ label: 'Version', value: <Badge>v{pkg.version}</Badge> },
							{ label: 'Publisher', value: pkg.publisher },
							{ label: 'Installs', value: String(pkg.installs) },
							{ label: 'Files', value: String(pkg.fileCount) },
							{
								label: 'Published',
								value: <TimestampValue value={pkg.publishedAt} />,
							},
							{
								label: 'Updated',
								value: <TimestampValue value={pkg.updatedAt} />,
							},
						]}
					/>
					{pkg.keywords.length > 0 ? (
						<div
							mix={css({ display: 'flex', gap: spacing.xs, flexWrap: 'wrap' })}
						>
							{pkg.keywords.map((keyword) => (
								<Badge key={keyword}>{keyword}</Badge>
							))}
						</div>
					) : null}
					<PreBlock>
						{`// from any MCP client connected to ${publicUrl}/mcp
execute: import { kody } from 'kody:runtime'
export default () => kody.communityInstall({ name: ${JSON.stringify(pkg.name)} })`}
					</PreBlock>
				</AccountManagementPanel>
				<AccountManagementPanel title="Exports">
					<RecordTable
						mode="none"
						ariaLabel="Exports"
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
				{pkg.jobs.length > 0 ? (
					<AccountManagementPanel title="Jobs">
						<RecordTable
							mode="none"
							ariaLabel="Jobs"
							columns={[
								{ key: 'name', label: 'Job', primary: true },
								{ key: 'entry', label: 'Export' },
								{ key: 'schedule', label: 'Schedule' },
							]}
							rows={pkg.jobs.map((job) => ({
								id: job.name,
								cells: {
									name: job.name,
									entry: <Code>{job.entry}</Code>,
									schedule: <Code>{job.schedule}</Code>,
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
							gap: '0.3rem',
						})}
					>
						{pkg.files.map((file) => (
							<li key={file}>
								<Code>{file}</Code>
							</li>
						))}
					</ul>
				</AccountManagementPanel>
				<AccountManagementPanel title="README">
					<PreBlock>{pkg.readme || '(empty)'}</PreBlock>
				</AccountManagementPanel>
				{pkg.agents ? (
					<AccountManagementPanel title="AGENTS">
						<PreBlock>{pkg.agents}</PreBlock>
					</AccountManagementPanel>
				) : null}
			</PublicPage>
		)
	}
}
