import { css, type Handle, type RemixNode } from 'remix/ui'
import { routes } from '#universal/routes.ts'
import {
	getSurfaceCardCss,
	pageGutter,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'

/**
 * Centred single-card layout for the stand-alone pages (sign-in, setup,
 * consent, connect). Same silhouette as kody's `/login`: brand mark on top,
 * display-face title, muted lede, then the form.
 */
export function AuthShell(
	handle: Handle<{
		title: string
		description?: RemixNode
		wide?: boolean
		children: RemixNode
	}>,
) {
	return () => (
		<section
			mix={css({
				width: '100%',
				maxWidth: handle.props.wide ? '40rem' : '28rem',
				margin: '0 auto',
				padding: `clamp(2rem, 6vw, 4rem) ${pageGutter} clamp(3rem, 7vw, 5rem)`,
				boxSizing: 'border-box',
				display: 'grid',
				gap: spacing.lg,
			})}
		>
			<a
				href={routes.home.href()}
				mix={css({
					display: 'inline-flex',
					alignItems: 'center',
					gap: spacing.sm,
					justifySelf: 'start',
					color: colors.text,
					textDecoration: 'none',
					fontWeight: 700,
					fontSize: '1.1rem',
				})}
			>
				<img src="/images/kody-mark.png" alt="" width={34} height={34} />
				<span>Kody</span>
			</a>
			<div mix={css({ display: 'grid', gap: '0.5rem' })}>
				<h1
					mix={css({
						margin: 0,
						fontSize: 'clamp(1.8rem, 4vw, 2.3rem)',
						fontWeight: 760,
						letterSpacing: '-0.024em',
						lineHeight: 1.1,
						color: colors.text,
					})}
				>
					{handle.props.title}
				</h1>
				{handle.props.description ? (
					<p mix={css({ margin: 0, color: colors.textMuted })}>
						{handle.props.description}
					</p>
				) : null}
			</div>
			<div
				mix={css({
					...getSurfaceCardCss(),
					display: 'grid',
					gap: spacing.lg,
					padding: 'clamp(1.25rem, 3vw, 2rem)',
				})}
			>
				{handle.props.children}
			</div>
		</section>
	)
}

/** Divided sub-block inside the auth card (e.g. alternate sign-in methods). */
export function AuthSection(
	handle: Handle<{ title?: string; children: RemixNode; first?: boolean }>,
) {
	return () => (
		<div
			mix={css({
				display: 'grid',
				gap: spacing.md,
				...(handle.props.first
					? {}
					: {
							borderTop: `1px solid ${colors.border}`,
							paddingTop: spacing.lg,
						}),
			})}
		>
			{handle.props.title ? (
				<h2
					mix={css({
						margin: 0,
						fontSize: '1.05rem',
						fontWeight: 700,
						color: colors.text,
					})}
				>
					{handle.props.title}
				</h2>
			) : null}
			{handle.props.children}
		</div>
	)
}
