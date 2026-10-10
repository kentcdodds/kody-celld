import { type Handle } from 'remix/component'
import { type AppLoaderData } from '#universal/loader-data.ts'
import {
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
} from './account-management-components.tsx'
import { ActionForm, Code, Muted } from './form-controls.tsx'

type Data = Extract<AppLoaderData, { page: 'accountMcpServerAuthorize' }>

const modeLabel = {
	preregistered: 'pre-registered OAuth client',
	metadata: 'client metadata document',
	dynamic: 'dynamic client registration',
} as const

/** `/account/mcp-servers/:name/authorize`: what will be authorized, then Continue → the provider. */
export function AccountMcpServerAuthorize(
	handle: Handle<{ data: Data; pathname: string }>,
) {
	return () => {
		const d = handle.props.data
		return (
			<AccountManagementShell>
				<AccountPageHeader
					title={`Authorize MCP server "${d.name}"`}
					description="Kody will send you to the server's sign-in page. Approve only if you added this server."
					currentHref="/account/mcp-servers"
				/>
				<AccountManagementPanel ariaLabel="Authorization details">
					<dl>
						<dt>Server</dt>
						<dd>
							<Code>{d.url}</Code>
						</dd>
						<dt>Sign-in at</dt>
						<dd>{d.authorizationServerHost ?? <Muted>unknown</Muted>}</dd>
						<dt>Kody identifies itself by</dt>
						<dd>
							{d.clientMode ? (
								modeLabel[d.clientMode]
							) : (
								<Muted>no supported method</Muted>
							)}
						</dd>
						<dt>Scopes</dt>
						<dd>
							{d.scopes.length ? (
								d.scopes.map((s) => <Code key={s}>{s}</Code>)
							) : (
								<Muted>none requested</Muted>
							)}
						</dd>
					</dl>
					{d.message ? <p>{d.message}</p> : null}
					{d.canContinue ? (
						<ActionForm
							action={`/account/mcp-servers/${encodeURIComponent(d.name)}/authorize`}
							csrf={d.csrf}
							fields={{ action: 'authorize' }}
							label="Continue"
						/>
					) : (
						<a href="/account/mcp-servers">Back to MCP servers</a>
					)}
				</AccountManagementPanel>
			</AccountManagementShell>
		)
	}
}
