import { css, type Handle } from 'remix/ui'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	mutedLinkCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import { AuthShell } from './auth-shell.tsx'
import { Code, CsrfInput, Hidden, Muted } from './form-controls.tsx'

type ConsentData = Extract<AppLoaderData, { page: 'oauthAuthorize' }>
type ErrorData = Extract<AppLoaderData, { page: 'oauthAuthorizeError' }>

/**
 * MCP OAuth consent. The form re-posts the authorization request (`q`) with a
 * per-session signature (`sig`); the server refuses a mismatch before parsing,
 * so what the user approved is what gets granted.
 */
export function OauthAuthorize(handle: Handle<{ data: ConsentData }>) {
	return () => {
		const d = handle.props.data
		return (
			<AuthShell
				title={`Connect ${d.clientName}`}
				description={
					<>
						<strong>{d.clientName}</strong>
						{d.clientUri ? <Muted small> ({d.clientUri})</Muted> : null} wants
						to use your Kody as an MCP server.
					</>
				}
				wide
			>
				<p mix={css({ margin: 0 })}>
					One approval grants the whole assistant: the client will be able to{' '}
					<Code>search</Code> and <Code>execute</Code> as you — packages,
					secrets (by name), jobs, storage, everything your API token can do.
				</p>
				<p mix={css({ margin: 0, color: colors.textMuted })}>
					After approval your browser returns to <Code>{d.redirectHost}</Code>.
					You can disconnect this client any time under{' '}
					<a
						href={routes.accountMcpOauthClients.href()}
						mix={css(mutedLinkCss)}
					>
						Account → MCP clients
					</a>
					.
				</p>
				<form
					method="post"
					action={d.action}
					mix={css({ display: 'flex', gap: spacing.sm, flexWrap: 'wrap' })}
				>
					<CsrfInput token={d.csrf} />
					<Hidden name="q" value={d.q} />
					<Hidden name="sig" value={d.sig} />
					<button
						type="submit"
						name="decision"
						value="approve"
						mix={css(getPrimaryButtonCss())}
					>
						Approve
					</button>
					<button
						type="submit"
						name="decision"
						value="deny"
						mix={css(getSecondaryButtonCss())}
					>
						Deny
					</button>
				</form>
			</AuthShell>
		)
	}
}

/** Shown when the request is invalid before the redirect URI is trusted (no redirect). */
export function OauthAuthorizeError(handle: Handle<{ data: ErrorData }>) {
	return () => (
		<AuthShell title="Cannot authorize this client">
			<p mix={css({ margin: 0 })}>
				<strong>{handle.props.data.error}</strong> —{' '}
				{handle.props.data.description}
			</p>
			<p mix={css({ margin: 0, color: colors.textMuted })}>
				The application that sent you here made an invalid authorization
				request. Nothing was granted.
			</p>
		</AuthShell>
	)
}
