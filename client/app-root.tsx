import { type Handle, css } from 'remix/ui'
import { SiteFooter } from '#client/site-footer.tsx'
import { SiteHeader } from '#client/site-header.tsx'
import { Toaster } from '#client/toaster.tsx'
import { RouteView } from '#client/routes/index.tsx'
import { type AppRootProps } from '#universal/app-root-props.ts'
import { isAuthShellPage } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	getAlertCardCss,
	layoutMaxWidths,
	pageGutter,
	visuallyHiddenUntilFocusedCss,
} from '#universal/styles/style-primitives.ts'
import { spacing } from '#universal/styles/tokens.ts'

export type { AppRootProps }

/**
 * Document body for every server-rendered page: skip link, header, `<main>`,
 * footer, toaster. Mirrors `packages/worker/client/app.tsx` minus the client
 * router, session fetching and marketing overlays — kody-celld renders the
 * whole page on the server and navigates with full documents. Auth-style
 * pages (sign-in, consent, connect) drop the header the way kody's `/login`
 * does; `isAuthShellPage` decides from the route data.
 */
export function AppRoot(handle: Handle<AppRootProps>) {
	return () => {
		const { session, pathname, flash, data } = handle.props
		const loginHref = routes.login.href()
		const authShell = isAuthShellPage(data.page)
		return (
			<div mix={css(rootCss)}>
				<a href="#main" mix={css(visuallyHiddenUntilFocusedCss)}>
					Skip to content
				</a>
				{authShell ? null : (
					<SiteHeader
						loggedIn={session != null}
						displayName={session?.displayName ?? ''}
						avatarUrl={session?.avatarUrl ?? null}
						showAdminLink={session?.isAdmin ?? false}
						loginHref={loginHref}
						currentPathname={pathname}
					/>
				)}
				<main id="main" mix={css(mainCss)}>
					{flash ? (
						<div mix={css(authShell ? authFlashWrapCss : flashWrapCss)}>
							<p
								class={`flash ${flash.kind}`}
								role={flash.kind === 'error' ? 'alert' : 'status'}
								mix={css(
									getAlertCardCss(flash.kind === 'error' ? 'error' : 'info'),
								)}
							>
								{flash.text}
							</p>
						</div>
					) : null}
					<RouteView data={data} pathname={pathname} />
				</main>
				<SiteFooter
					loggedIn={session != null}
					loginHref={loginHref}
					version={handle.props.version}
				/>
				<Toaster />
			</div>
		)
	}
}

const rootCss = {
	display: 'flex',
	flexDirection: 'column' as const,
	minHeight: '100vh',
}

const mainCss = {
	flex: 1,
	display: 'flex',
	flexDirection: 'column' as const,
}

const flashWrapCss = {
	width: '100%',
	maxWidth: layoutMaxWidths.extended,
	margin: '0 auto',
	padding: `${spacing.lg} ${pageGutter} 0`,
	boxSizing: 'border-box' as const,
}

const authFlashWrapCss = {
	width: '100%',
	maxWidth: '28rem',
	margin: '0 auto',
	padding: `${spacing.xl} ${pageGutter} 0`,
	boxSizing: 'border-box' as const,
}
