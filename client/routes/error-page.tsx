import { css, type Handle } from 'remix/component'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
import { getPageShellCss } from '#client/page-layout.ts'
import { Code } from './form-controls.tsx'

type Data = Extract<AppLoaderData, { page: 'error' }>

/**
 * Every HTML error the Worker renders (`errorPage()` in `src/index.ts`). 404s
 * and 5xx get kody's illustrated pages (`client/not-found-page.tsx`,
 * `client/internal-error-page.tsx` upstream); other 4xx are request problems
 * the reader can fix, so they stay plain. The error code and message are
 * always shown — they are what an operator greps the audit log for.
 */
export function ErrorPage(handle: Handle<{ data: Data; signedIn: boolean }>) {
	return () => {
		const { data, signedIn } = handle.props
		const kind =
			data.status === 404
				? 'notFound'
				: data.status >= 500
					? 'server'
					: 'request'
		const copy = errorCopy[kind]
		const homeHref = signedIn ? routes.account.href() : routes.home.href()
		return (
			<section mix={css(errorPageCss)}>
				{copy.image ? (
					<img
						src={copy.image.src}
						alt={copy.image.alt}
						width={copy.image.width}
						height={copy.image.height}
						mix={css(copy.image.tall ? errorTallImageCss : errorImageCss)}
					/>
				) : null}
				<h1 mix={css(errorHeadingCss)}>{copy.heading}</h1>
				<p mix={css(errorCopyCss)}>{copy.body}</p>
				<p mix={css(errorDetailCss)}>
					<Code>{data.error}</Code>: {data.message}
				</p>
				<nav aria-label="What to try next" mix={css(errorActionsCss)}>
					<a href={homeHref} mix={css(getPillButtonCss())}>
						{signedIn ? 'Back to your account' : 'Go home'}
					</a>
					<a href={routes.community.href()} mix={css(getGhostButtonCss())}>
						Browse packages
					</a>
				</nav>
			</section>
		)
	}
}

type ErrorCopy = {
	heading: string
	body: string
	image: {
		src: string
		alt: string
		width: number
		height: number
		tall?: boolean
	} | null
}

const errorCopy: Record<'notFound' | 'server' | 'request', ErrorCopy> = {
	notFound: {
		heading: "This doesn't quite connect.",
		body: "That address isn't a page on this server. It may have moved, never existed, or the package was unpublished.",
		image: {
			src: '/images/kody-404-disappointed.webp',
			alt: 'Kody looking disappointed, holding an Ethernet plug and a USB-C cable that do not match',
			width: 576,
			height: 576,
		},
	},
	server: {
		heading: 'We got a little zapped.',
		body: 'Something went wrong on this server. Try again in a moment; if it keeps happening, the operator can find the details in the logs.',
		image: {
			src: '/images/kody-500-zapped.webp',
			alt: 'Kody with sparking fur holding two cables that just shorted',
			width: 512,
			height: 768,
			tall: true,
		},
	},
	request: {
		heading: "That didn't go through.",
		body: 'The server could not act on this request. Go back, check the form, and try again.',
		image: null,
	},
}

const errorPageCss = {
	...getPageShellCss('message'),
	display: 'grid',
	justifyItems: 'center',
	textAlign: 'center' as const,
	gap: '1rem',
}

const errorImageCss = {
	width: 'min(18rem, 72vw)',
	height: 'auto',
	display: 'block',
}

/* The 500 art is taller than it is wide; cap it so the heading and actions
   stay on a phone screen. */
const errorTallImageCss = {
	...errorImageCss,
	width: 'min(16rem, 64vw)',
	maxHeight: 'min(24rem, 52vh)',
	objectFit: 'contain' as const,
}

const errorHeadingCss = {
	margin: '0.4rem 0 0',
	font: `700 clamp(1.6rem, 4vw, 2.1rem)/1.15 ${typography.fontFamilyDisplay}`,
	letterSpacing: '-0.02em',
	color: colors.text,
	textWrap: 'balance' as const,
}

const errorCopyCss = {
	margin: 0,
	maxWidth: '36rem',
	color: colors.textMuted,
	fontSize: '1.02rem',
	lineHeight: 1.5,
	textWrap: 'pretty' as const,
}

const errorDetailCss = {
	margin: 0,
	maxWidth: '36rem',
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
	overflowWrap: 'anywhere' as const,
}

const errorActionsCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	justifyContent: 'center',
	gap: '0.7rem',
	marginTop: '0.6rem',
}
