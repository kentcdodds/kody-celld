import {
	layoutMaxWidths,
	pageGutter,
} from '#universal/styles/style-primitives.ts'

/*
 * The one page box every top-level route renders into. Header, footer, the
 * account/console shell, public pages, auth cards and error pages all take
 * their width, gutter and centring from here, so moving between pages never
 * shifts the content sideways. See docs/web-ui.md#page-layout.
 *
 * `width: 100%` is load-bearing: inside a flex or grid parent, auto inline
 * margins without an explicit width shrink the box to its content, so each
 * page would size (and centre) itself by how long its copy happens to be.
 */

export const pageWidths = {
	/** Header, footer, account and console shell, community catalog. */
	app: layoutMaxWidths.extended,
	/** Illustrated error pages and other centred single messages. */
	message: layoutMaxWidths.narrow,
	/** One thing to read: a community package. */
	article: '46rem',
	/** Sign-in, setup, invite links. */
	auth: '28rem',
	/** Consent and connect screens that list scopes or hosts. */
	authWide: '40rem',
} as const

export type PageWidth = keyof typeof pageWidths

/** Vertical rhythm between the header hairline, the page, and the footer. */
export const pageBlockPadding = {
	top: 'clamp(2rem, 5vw, 3.5rem)',
	bottom: 'clamp(3rem, 7vw, 5rem)',
} as const

/** Width, gutter and centring only — for bands such as the flash row. */
export function getPageContainerCss(width: PageWidth = 'app') {
	return {
		boxSizing: 'border-box' as const,
		width: '100%',
		maxWidth: pageWidths[width],
		marginInline: 'auto',
		paddingInline: pageGutter,
	}
}

/** A whole page: the container plus the standard top and bottom rhythm. */
export function getPageShellCss(width: PageWidth = 'app') {
	return {
		...getPageContainerCss(width),
		paddingTop: pageBlockPadding.top,
		paddingBottom: pageBlockPadding.bottom,
	}
}
