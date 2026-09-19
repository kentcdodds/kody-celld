import { type Handle } from 'remix/ui'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	AccountManagementPanel,
	AccountManagementShell,
	AdminPageHeader,
	IdValue,
	TimestampValue,
} from './account-management-components.tsx'
import {
	ActionForm,
	Actions,
	CsrfInput,
	Field,
	Hidden,
	Lede,
	Muted,
	SecretReveal,
	SignOutForm,
	StackedForm,
	SubmitButton,
} from './form-controls.tsx'
import { RecordTable } from './record-table.tsx'

type Data = Extract<AppLoaderData, { page: 'adminUsers' }>

/** `/console`: user list, invite/token issuance, manual job dispatch. */
export function AdminUsers(handle: Handle<{ data: Data; pathname: string }>) {
	return () => {
		const d = handle.props.data
		const action = routes.admin.href()
		return (
			<AccountManagementShell>
				<AdminPageHeader
					title="Users"
					description="Every account on this server. Invite links and admin-issued tokens are shown once."
					currentHref={handle.props.pathname}
					actions={
						<SignOutForm action={routes.adminLogout.href()} csrf={d.csrf} />
					}
				/>
				{d.issued ? (
					<AccountManagementPanel
						title={`${d.issued.kind === 'invite' ? 'One-time sign-in link' : 'API token'} for ${d.issued.label}`}
						description={`Hand it over out of band; it is not shown again${
							d.issued.expiresAt ? ' and expires soon' : ''
						}.`}
					>
						<SecretReveal
							value={d.issued.value}
							label={d.issued.kind === 'invite' ? 'sign-in link' : 'API token'}
						/>
						{d.issued.expiresAt ? (
							<Muted small>
								Expires <TimestampValue value={d.issued.expiresAt} />.
							</Muted>
						) : null}
					</AccountManagementPanel>
				) : null}
				<AccountManagementPanel ariaLabel="Users">
					<RecordTable
						mode="none"
						ariaLabel="Users"
						emptyLabel="No users yet."
						countLabel={`${d.users.length} total`}
						columns={[
							{ key: 'email', label: 'Email', primary: true },
							{ key: 'created', label: 'Created', drop: 2 },
							{ key: 'actions', label: 'Actions' },
						]}
						rows={d.users.map((user) => ({
							id: user.id,
							href: routes.adminUserDetail.href({ userId: user.id }),
							cells: {
								email: user.email,
								created: <TimestampValue value={user.createdAt} />,
								actions: (
									<Actions>
										<ActionForm
											action={action}
											csrf={d.csrf}
											fields={{ action: 'invite', userId: user.id }}
											label="Sign-in link"
										/>
										<ActionForm
											action={action}
											csrf={d.csrf}
											fields={{ action: 'token', userId: user.id }}
											label="API token"
										/>
									</Actions>
								),
							},
							primaryAccessory: <IdValue value={user.id} label="user id" />,
						}))}
					/>
				</AccountManagementPanel>
				<AccountManagementPanel
					title="Add a user"
					description="Creates the account and a one-time invite link (valid 7 days) the person uses to set a password."
				>
					<StackedForm action={action}>
						<CsrfInput token={d.csrf} />
						<Hidden name="action" value="create" />
						<Field label="Email" name="email" type="email" required />
						<div>
							<SubmitButton>Create and invite</SubmitButton>
						</div>
					</StackedForm>
				</AccountManagementPanel>
				<AccountManagementPanel title="Jobs">
					<Actions>
						<ActionForm
							action={action}
							csrf={d.csrf}
							fields={{ action: 'dispatch' }}
							label="Run due jobs now"
						/>
					</Actions>
					<Lede>Same as the cron trigger firing.</Lede>
				</AccountManagementPanel>
			</AccountManagementShell>
		)
	}
}
