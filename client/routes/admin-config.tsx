import { type Handle } from 'remix/ui'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	AccountManagementPanel,
	AccountManagementShell,
	AdminPageHeader,
	MetadataGrid,
} from './account-management-components.tsx'
import { Code, Lede, PreBlock, SignOutForm } from './form-controls.tsx'

type Data = Extract<AppLoaderData, { page: 'adminConfig' }>

/** `/console/config`: redacted adapter configuration (`describe*Config`). */
export function AdminConfig(handle: Handle<{ data: Data; pathname: string }>) {
	return () => {
		const d = handle.props.data
		return (
			<AccountManagementShell>
				<AdminPageHeader
					title="Configuration"
					description="Adapter settings come from the environment; secrets are never shown here."
					currentHref={handle.props.pathname}
					actions={
						<SignOutForm action={routes.adminLogout.href()} csrf={d.csrf} />
					}
				/>
				<AccountManagementPanel ariaLabel="Deployment">
					<MetadataGrid
						items={[
							{ label: 'Version', value: <Code>kody-celld {d.version}</Code> },
							{ label: 'Public URL', value: <Code>{d.publicUrl}</Code> },
							{
								label: 'MCP endpoint',
								value: <Code>{`${d.publicUrl}/mcp`}</Code>,
							},
						]}
					/>
				</AccountManagementPanel>
				{d.sections.map((section) => (
					<AccountManagementPanel key={section.name} title={section.name}>
						<PreBlock>{section.json}</PreBlock>
					</AccountManagementPanel>
				))}
				<Lede>
					See <Code>docs/operations.md</Code> for every <Code>KODY_*</Code>{' '}
					variable.
				</Lede>
			</AccountManagementShell>
		)
	}
}
