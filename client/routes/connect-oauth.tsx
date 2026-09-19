import { css, type Handle } from 'remix/ui'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { getPrimaryButtonCss } from '#universal/styles/style-primitives.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import { TimestampValue } from './account-management-components.tsx'
import { AuthShell } from './auth-shell.tsx'
import { Code, Hidden, Muted } from './form-controls.tsx'

type ConnectData = Extract<AppLoaderData, { page: 'connectOauth' }>
type DoneData = Extract<AppLoaderData, { page: 'connectOauthDone' }>
type ErrorData = Extract<AppLoaderData, { page: 'connectOauthError' }>

/**
 * Integration connect consent (`/connect/oauth/:userId/:connectId?ticket=…`).
 * The one-time ticket in the URL is the credential here (the user may not
 * have a browser session); POST burns it and redirects to the provider.
 */
export function ConnectOauth(handle: Handle<{ data: ConnectData }>) {
	return () => {
		const d = handle.props.data
		return (
			<AuthShell
				title={`Connect ${d.name}`}
				description={
					<>
						{d.provider} · signed in as <strong>{d.email}</strong>
					</>
				}
				wide
			>
				<p mix={css({ margin: 0 })}>
					After you authorize, Kody will hold the access token encrypted and
					inject it only into requests to:
				</p>
				<ul
					mix={css({
						margin: 0,
						paddingLeft: '1.2rem',
						display: 'grid',
						gap: '0.3rem',
					})}
				>
					{d.hosts.map((host) => (
						<li key={host}>
							<Code>{host}</Code>
						</li>
					))}
				</ul>
				{d.scopes.length > 0 ? (
					<p
						mix={css({
							margin: 0,
							display: 'flex',
							gap: spacing.xs,
							flexWrap: 'wrap',
						})}
					>
						<span>Requested scopes:</span>
						{d.scopes.map((scope) => (
							<Code key={scope}>{scope}</Code>
						))}
					</p>
				) : null}
				{d.description ? (
					<p mix={css({ margin: 0, color: colors.textMuted })}>
						{d.description}
					</p>
				) : null}
				<form method="post">
					<Hidden name="ticket" value={d.ticket} />
					<button type="submit" mix={css(getPrimaryButtonCss())}>
						Continue to {d.provider}
					</button>
				</form>
				<Muted small>
					This link expires <TimestampValue value={d.expiresAt} /> and works
					once.
				</Muted>
			</AuthShell>
		)
	}
}

export function ConnectOauthDone(handle: Handle<{ data: DoneData }>) {
	return () => {
		const d = handle.props.data
		return (
			<AuthShell title={`Connected ${d.name}`}>
				<p mix={css({ margin: 0 })}>
					{d.provider} is now connected for <strong>{d.email}</strong>. You can
					close this tab and tell your assistant to continue.
				</p>
			</AuthShell>
		)
	}
}

export function ConnectOauthError(handle: Handle<{ data: ErrorData }>) {
	return () => (
		<AuthShell title="Connection failed">
			<p mix={css({ margin: 0 })}>
				<Code>{handle.props.data.error}</Code>: {handle.props.data.message}
			</p>
			<p mix={css({ margin: 0, color: colors.textMuted })}>
				Ask your assistant for a fresh connect link and try again.
			</p>
		</AuthShell>
	)
}
