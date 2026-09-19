import { type Handle } from 'remix/ui'
import { type AppLoaderData } from '#universal/loader-data.ts'
import {
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	TimestampValue,
} from './account-management-components.tsx'
import { Code, Lede, Muted } from './form-controls.tsx'
import { RecordTable } from './record-table.tsx'

type Data = Extract<AppLoaderData, { page: 'accountEmail' }>

/** `/account/inbox`: claimed addresses and recent messages (metadata + snippet). */
export function AccountEmail(handle: Handle<{ data: Data; pathname: string }>) {
	return () => {
		const d = handle.props.data
		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Email"
					description="Inboxes your packages can receive on and messages they have sent."
					currentHref={handle.props.pathname}
				/>
				{d.domain === null ? (
					<AccountManagementPanel ariaLabel="Email status">
						<Lede>
							Email is not configured on this server (
							<Code>KODY_EMAIL_DOMAIN</Code>).
						</Lede>
					</AccountManagementPanel>
				) : (
					<>
						<AccountManagementPanel title="Addresses">
							{d.addresses.length === 0 ? (
								<Lede>
									None claimed yet — use <Code>emailInboxClaim</Code> from an
									MCP client.
								</Lede>
							) : (
								<p>
									{d.addresses.map((address) => (
										<>
											<Code key={address}>{address}</Code>{' '}
										</>
									))}
								</p>
							)}
						</AccountManagementPanel>
						<AccountManagementPanel ariaLabel="Messages">
							<RecordTable
								mode="none"
								ariaLabel="Messages"
								emptyLabel="No messages."
								countLabel={`${d.messages.length} shown`}
								columns={[
									{ key: 'subject', label: 'Subject', primary: true },
									{ key: 'received', label: 'Received', drop: 2 },
									{ key: 'from', label: 'From / to', drop: 1 },
									{ key: 'class', label: 'Class', drop: 3 },
									{ key: 'size', label: 'Size', align: 'end', drop: 3 },
								]}
								rows={d.messages.map((message) => ({
									id: message.id,
									cells: {
										subject: (
											<>
												{message.subject || <Muted>(no subject)</Muted>}
												<br />
												<Muted small>{message.snippet}</Muted>
											</>
										),
										received: <TimestampValue value={message.receivedAt} />,
										from: (
											<>
												{message.direction === 'outbound' ? (
													<Muted>→ </Muted>
												) : null}
												{message.counterpart}
											</>
										),
										class: message.classification ?? message.direction,
										size: `${Math.round(message.sizeBytes / 1024)} KiB`,
									},
								}))}
							/>
						</AccountManagementPanel>
					</>
				)}
			</AccountManagementShell>
		)
	}
}
