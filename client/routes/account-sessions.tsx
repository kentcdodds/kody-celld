import { type Handle } from 'remix/ui'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	TimestampValue,
} from './account-management-components.tsx'
import {
	ActionForm,
	Actions,
	Badge,
	DangerForm,
	Muted,
} from './form-controls.tsx'
import { RecordTable } from './record-table.tsx'

type Data = Extract<AppLoaderData, { page: 'accountSessions' }>

/** `/account/sessions`: browser sessions with per-device revoke. */
export function AccountSessions(
	handle: Handle<{ data: Data; pathname: string }>,
) {
	return () => {
		const d = handle.props.data
		const action = routes.accountSessions.href()
		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Sessions"
					description="Browsers currently signed in to this account. Revoking one signs that browser out immediately."
					currentHref={handle.props.pathname}
				/>
				<AccountManagementPanel ariaLabel="Browser sessions">
					<RecordTable
						mode="none"
						ariaLabel="Browser sessions"
						emptyLabel="No sessions."
						countLabel={`${d.sessions.length} active`}
						columns={[
							{ key: 'device', label: 'Device', primary: true },
							{ key: 'signedIn', label: 'Signed in', drop: 2 },
							{ key: 'lastSeen', label: 'Last seen', drop: 3 },
							{ key: 'expires', label: 'Expires', drop: 1 },
							{ key: 'actions', label: 'Actions' },
						]}
						rows={d.sessions.map((item) => ({
							id: item.id,
							cells: {
								device: <Muted small>{item.userAgent ?? 'unknown'}</Muted>,
								signedIn: <TimestampValue value={item.createdAt} />,
								lastSeen: (
									<TimestampValue value={item.lastSeenAt} fallback="—" />
								),
								expires: <TimestampValue value={item.expiresAt} />,
								actions: (
									<DangerForm
										action={action}
										csrf={d.csrf}
										fields={{ action: 'revoke', sessionId: item.id }}
										label={item.current ? 'Sign out' : 'Revoke'}
									/>
								),
							},
							primaryAccessory: item.current ? (
								<Badge tone="ok">this browser</Badge>
							) : undefined,
						}))}
					/>
					<Actions>
						<ActionForm
							action={action}
							csrf={d.csrf}
							fields={{ action: 'revoke_others' }}
							label="Sign out other browsers"
						/>
					</Actions>
				</AccountManagementPanel>
			</AccountManagementShell>
		)
	}
}
