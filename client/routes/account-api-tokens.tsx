import { type Handle } from 'remix/ui'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	IdValue,
	TimestampValue,
} from './account-management-components.tsx'
import {
	Code,
	CsrfInput,
	DangerForm,
	Field,
	Hidden,
	Lede,
	SecretReveal,
	StackedForm,
	SubmitButton,
} from './form-controls.tsx'
import { RecordTable } from './record-table.tsx'

type Data = Extract<AppLoaderData, { page: 'accountApiTokens' }>

/** `/account/tokens`: static bearer tokens for clients without OAuth. */
export function AccountApiTokens(
	handle: Handle<{ data: Data; pathname: string }>,
) {
	return () => {
		const d = handle.props.data
		const action = routes.accountApiTokens.href()
		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="API tokens"
					description="Bearer tokens for MCP clients and scripts that cannot use OAuth. Each is shown once at creation."
					currentHref={handle.props.pathname}
				/>
				{d.issued ? (
					<AccountManagementPanel
						title={`New token "${d.issued.label}"`}
						description="Copy it now — it is not shown again."
					>
						<SecretReveal value={d.issued.value} label="API token" />
						<Lede>
							Use as <Code>Authorization: Bearer …</Code> against{' '}
							<Code>{`${d.publicUrl}/mcp`}</Code> or <Code>/api</Code>.
						</Lede>
					</AccountManagementPanel>
				) : null}
				<AccountManagementPanel ariaLabel="Tokens">
					<RecordTable
						mode="none"
						ariaLabel="API tokens"
						emptyLabel="No API tokens."
						countLabel={`${d.tokens.length} total`}
						columns={[
							{ key: 'label', label: 'Label', primary: true },
							{ key: 'created', label: 'Created', drop: 2 },
							{ key: 'lastUsed', label: 'Last used', drop: 3 },
							{ key: 'actions', label: 'Actions' },
						]}
						rows={d.tokens.map((token) => ({
							id: token.id,
							cells: {
								label: token.label,
								created: <TimestampValue value={token.createdAt} />,
								lastUsed: (
									<TimestampValue value={token.lastUsedAt} fallback="never" />
								),
								actions: (
									<DangerForm
										action={action}
										csrf={d.csrf}
										fields={{ action: 'revoke', tokenId: token.id }}
										label="Revoke"
									/>
								),
							},
							primaryAccessory: <IdValue value={token.id} label="token id" />,
						}))}
					/>
				</AccountManagementPanel>
				<AccountManagementPanel title="Create a token">
					<StackedForm action={action}>
						<CsrfInput token={d.csrf} />
						<Hidden name="action" value="create" />
						<Field
							label="Label"
							name="label"
							placeholder="laptop, CI, my-script"
							maxlength={80}
						/>
						<div>
							<SubmitButton>Create token</SubmitButton>
						</div>
					</StackedForm>
				</AccountManagementPanel>
			</AccountManagementShell>
		)
	}
}
