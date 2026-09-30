import { css, type Handle, type RemixNode } from 'remix/ui'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
	mergeCss,
	pageHeadCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	spacing,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import { getPageShellCss } from '#client/page-layout.ts'
import {
	AccountManagementHeader,
	AccountManagementPanel,
	MetadataGrid,
	TimestampValue,
} from './account-management-components.tsx'
import { Badge, Code, Muted, PreBlock } from './form-controls.tsx'
import { RecordTable } from './record-table.tsx'

type IndexData = Extract<AppLoaderData, { page: 'community' }>
type DetailData = Extract<AppLoaderData, { page: 'communityDetail' }>
type NotFoundData = Extract<AppLoaderData, { page: 'communityNotFound' }>

function plural(n: number, word: string) {
	return `${n} ${word}${n === 1 ? '' : 's'}`
}

/**
 * One package or a miss: the reading column with a way back to the catalog,
 * the account-page heading, and hairline sections below.
 */
function CommunityArticle(
	handle: Handle<{
		title: string
		description?: string
		children: RemixNode
	}>,
) {
	return () => (
		<article mix={css(communityArticleCss)}>
			<a href={routes.community.href()} mix={css(backLinkCss)}>
				<span aria-hidden="true">←</span> Community
			</a>
			<AccountManagementHeader
				title={handle.props.title}
				description={handle.props.description ?? ''}
			/>
			{handle.props.children}
		</article>
	)
}

/** `/community`: public, no sign-in; renders only what CommunityStore exposes. */
export function Community(handle: Handle<{ data: IndexData }>) {
	return () => {
		const d = handle.props.data
		return (
			<section mix={css(communityPageCss)}>
				<header mix={css(communityHeadCss)}>
					<div>
						<h1 mix={css(headTitleCss)}>
							Take what others
							<br />
							built. <em>Make it yours.</em>
						</h1>
						<p mix={css(headSubCss)}>
							Packages people on this server have published. Install one from
							any connected MCP client, then adapt it to your goals.
						</p>
						<form
							data-focus-container
							role="search"
							method="get"
							action={routes.community.href()}
							mix={css(searchPillCss)}
						>
							<label for="community-q" mix={css(visuallyHiddenCss)}>
								Search packages
							</label>
							<input
								id="community-q"
								name="q"
								type="search"
								placeholder="Search by name, description, or keywords"
								value={d.query}
								mix={css(searchInputCss)}
							/>
							<button type="submit" mix={css(getPillButtonCss())}>
								Search
							</button>
						</form>
						<p mix={css(headStatsCss)}>
							{`${plural(d.stats.packages, 'package')} from ${plural(d.stats.publishers, 'publisher')}, ${plural(d.stats.installs, 'install')}.`}
						</p>
					</div>
					<img
						src="/images/kody-community-packages-480.webp"
						srcset="/images/kody-community-packages-480.webp 480w, /images/kody-community-packages.webp 627w"
						sizes="(max-width: 720px) 52vw, 230px"
						width={627}
						height={627}
						decoding="async"
						alt="Kody handing a wrapped package across a counter of neatly sorted parcels"
						mix={css(communityArtCss)}
					/>
				</header>
				<section aria-label="Catalog">
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
				</section>
				<div mix={css(communityCloseCss)}>
					<p>
						Built something useful? Publish it back with{' '}
						<Code>communityPublish</Code> from an MCP client, or from your
						packages page — everyone on this server can install it.
					</p>
					<a href={routes.accountPackages.href()} mix={css(closeButtonCss)}>
						Your packages
					</a>
				</div>
			</section>
		)
	}
}

export function CommunityNotFound(handle: Handle<{ data: NotFoundData }>) {
	return () => (
		<CommunityArticle
			title="Not found"
			description="Nothing in this server's catalog goes by that name. It may have been unpublished."
		>
			<AccountManagementPanel ariaLabel="Not found">
				<p mix={css({ margin: 0 })}>
					No community package named <Code>{handle.props.data.name}</Code>.
				</p>
			</AccountManagementPanel>
		</CommunityArticle>
	)
}

/** `/community/:name`: manifest, files and README of one listing. */
export function CommunityDetail(handle: Handle<{ data: DetailData }>) {
	return () => {
		const { pkg, publicUrl } = handle.props.data
		return (
			<CommunityArticle
				title={pkg.name}
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
			</CommunityArticle>
		)
	}
}

/* Browse page: the app-width box, sections spaced like the account shell. */
const communityPageCss = {
	...getPageShellCss('app'),
	display: 'grid',
	gap: 'clamp(2rem, 4vw, 2.75rem)',
}

const communityArticleCss = {
	...getPageShellCss('article'),
	display: 'grid',
	gap: 'clamp(2rem, 4vw, 2.75rem)',
	alignContent: 'start',
}

/* Split head from kody's `/community`: Kody at the side, not overhead. The
   shirt-pattern whisper drifts toward the mascot. */
const communityHeadCss = {
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 1fr) clamp(150px, 22vw, 230px)',
	gap: 'clamp(1.5rem, 4vw, 3.5rem)',
	alignItems: 'center',
	position: 'relative' as const,
	// See `pageHeadCss`: the fabric is a backdrop, so it paints under the head.
	isolation: 'isolate' as const,
	'&::before': {
		...pageHeadCss['&::before'],
		inset: '-55% -14% -35%',
		background: `radial-gradient(ellipse 40% 65% at 82% 45%, oklch(from ${colors.text} l c h / 0.055), transparent 72%)`,
	},
	'@media (max-width: 720px)': {
		gridTemplateColumns: '1fr',
		textAlign: 'center' as const,
	},
}

const headTitleCss = {
	margin: 0,
	fontSize: 'clamp(2.4rem, 5vw, 3.4rem)',
	fontWeight: 760,
	letterSpacing: '-0.028em',
	lineHeight: 1.04,
	'& em': {
		fontStyle: 'normal',
		color: colors.primaryText,
	},
}

const headSubCss = {
	margin: '1rem 0 0',
	color: colors.textMuted,
	fontSize: '1.08rem',
	maxWidth: '46ch',
	textWrap: 'balance' as const,
	'@media (max-width: 720px)': {
		marginInline: 'auto',
	},
}

const headStatsCss = {
	margin: `${spacing.md} 0 0`,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
	fontVariantNumeric: 'tabular-nums',
}

/* Search: connected-pill grammar, one field + one verb. */
const searchPillCss = {
	marginTop: '1.8rem',
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 1fr) auto',
	alignItems: 'stretch',
	width: 'min(100%, 34rem)',
	boxSizing: 'border-box' as const,
	backgroundColor: colors.surface,
	border: `1.5px solid ${colors.border}`,
	borderRadius: '999px',
	padding: '0.3rem',
	transition: `border-color 160ms ${transitions.easeOut}, box-shadow 160ms ${transitions.easeOut}`,
	'&:focus-within': {
		borderColor: colors.primary,
		boxShadow: `0 0 0 3px oklch(from ${colors.primary} l c h / 0.25)`,
	},
	'@media (max-width: 720px)': {
		marginInline: 'auto',
	},
}

const searchInputCss = {
	font: `400 1rem/1.2 ${typography.fontFamilyBody}`,
	color: colors.text,
	backgroundColor: 'transparent',
	border: 'none',
	borderRadius: '999px',
	padding: '0.7rem 1.1rem',
	minWidth: 0,
	'&::placeholder': { color: colors.textMuted, opacity: 1 },
	'&:focus': { outline: 'none' },
	'&::-webkit-search-cancel-button': { WebkitAppearance: 'none' },
}

const communityArtCss = {
	width: '100%',
	height: 'auto',
	'@media (max-width: 720px)': {
		width: 'min(52%, 210px)',
		marginInline: 'auto',
		order: -1,
	},
}

/* Publish close: the catalog grows when people publish back. */
const communityCloseCss = {
	paddingTop: 'clamp(1.8rem, 4vw, 2.5rem)',
	borderTop: `1px solid ${colors.border}`,
	display: 'flex',
	alignItems: 'center',
	gap: '1.2rem',
	flexWrap: 'wrap' as const,
	'& > p': {
		// Wraps above the button on a phone instead of squeezing beside it.
		flex: '1 1 20rem',
		minWidth: 0,
		margin: 0,
		color: colors.textMuted,
		fontSize: '0.98rem',
	},
}

const closeButtonCss = mergeCss(getGhostButtonCss(), {
	fontSize: '0.95rem',
	padding: '0.8rem 1.35rem',
})

const backLinkCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.4rem',
	justifySelf: 'start',
	fontSize: '0.95rem',
	fontWeight: 550,
	color: colors.primaryText,
	textDecoration: 'none',
	'&:hover': {
		color: colors.text,
	},
}
