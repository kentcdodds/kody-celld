import { type Handle } from 'remix/component'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
} from './account-management-components.tsx'
import { ActionForm, Badge, Code, DangerForm, Muted } from './form-controls.tsx'
import { RecordTable } from './record-table.tsx'

type Data = Extract<AppLoaderData, { page: 'accountMcpServers' }>

/** `/account/mcp-servers`: remote MCP servers called as kody.mcp["name"].tool(input). */
export function AccountMcpServers(
	handle: Handle<{ data: Data; pathname: string }>,
) {
	return () => {
		const d = handle.props.data
		const action = routes.accountMcpServers.href()
		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="MCP servers"
					description='Remote MCP servers your code calls as kody.mcp["name"].tool(input). Add them from an MCP client with mcpServerAdd.'
					currentHref={handle.props.pathname}
				/>
				<AccountManagementPanel ariaLabel="MCP servers">
					<RecordTable
						mode="none"
						ariaLabel="MCP servers"
						emptyLabel="No MCP servers. Add one with: await kody.mcpServerAdd({ name: 'home', url: 'https://…/mcp', bearerToken: '…' }). OAuth servers show an Authorize link."
						countLabel={`${d.servers.length} total`}
						columns={[
							{ key: 'name', label: 'Name', primary: true },
							{ key: 'status', label: 'Status' },
							{ key: 'tools', label: 'Tools' },
							{ key: 'usage', label: 'Usage' },
							{ key: 'actions', label: 'Actions' },
						]}
						rows={d.servers.map((s) => ({
							id: s.name,
							cells: {
								name: (
									<span>
										<strong>{s.name}</strong>
										<br />
										<Muted small>
											{s.host} ·{' '}
											{s.authKind === 'bearer'
												? 'bearer token'
												: s.authKind === 'oauth'
													? `OAuth${s.hasRefreshToken ? '' : ' (no refresh token)'}`
													: 'no auth'}
										</Muted>
									</span>
								),
								status: (
									<span>
										<Badge
											tone={
												!s.enabled
													? 'warn'
													: s.status === 'ready'
														? 'ok'
														: 'warn'
											}
										>
											{!s.enabled ? 'disabled' : s.status}
										</Badge>
										{s.lastError ? (
											<>
												<br />
												<Muted small>{s.lastError}</Muted>
											</>
										) : null}
										{s.authorizeHref ? (
											<>
												<br />
												<a href={s.authorizeHref} rel="noopener noreferrer">
													Authorize
												</a>
											</>
										) : null}
									</span>
								),
								tools: (
									<details>
										<summary>{s.tools.length} tools</summary>
										<ul>
											{s.tools.map((t) => (
												<li key={t.name}>
													<Code>{t.name}</Code>{' '}
													<Muted small>{t.description}</Muted>
												</li>
											))}
										</ul>
									</details>
								),
								usage:
									s.usage.mode === 'any' ? (
										'any code'
									) : (
										<span>
											{s.usage.packages.map((p) => (
												<span key={p}>
													<Code>{p}</Code>{' '}
													<DangerForm
														action={action}
														csrf={d.csrf}
														fields={{
															action: 'ungrant',
															name: s.name,
															packageName: p,
														}}
														label="Remove grant"
													/>
													<br />
												</span>
											))}
											<ActionForm
												action={action}
												csrf={d.csrf}
												fields={{ action: 'allow_all', name: s.name }}
												label="Allow all code"
											/>
										</span>
									),
								actions: (
									<span>
										<ActionForm
											action={action}
											csrf={d.csrf}
											fields={{ action: 'refresh', name: s.name }}
											label="Refresh"
										/>{' '}
										<ActionForm
											action={action}
											csrf={d.csrf}
											fields={{
												action: s.enabled ? 'disable' : 'enable',
												name: s.name,
											}}
											label={s.enabled ? 'Disable' : 'Enable'}
										/>{' '}
										<DangerForm
											action={action}
											csrf={d.csrf}
											fields={{ action: 'remove', name: s.name }}
											label="Remove"
										/>
									</span>
								),
							},
						}))}
					/>
				</AccountManagementPanel>
			</AccountManagementShell>
		)
	}
}
