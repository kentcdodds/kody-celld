import { css, type Handle } from 'remix/component'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import {
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	TimestampValue,
} from './account-management-components.tsx'
import { Code, Muted } from './form-controls.tsx'
import { RecordTable, recordCellClamp } from './record-table.tsx'

type Data = Extract<AppLoaderData, { page: 'accountWebhooks' }>
type Webhook = Data['webhooks'][number]

const clampedCellCss = css(recordCellClamp(28))

function webhookStatusLabel(webhook: Webhook) {
	if (!webhook.minted) return 'No URL yet'
	return webhook.enabled ? 'Active' : 'Disabled'
}

function webhookStatusColor(webhook: Webhook) {
	if (!webhook.minted) return colors.textMuted
	return webhook.enabled ? colors.primary : colors.error
}

function webhookModeLabel(webhook: Webhook) {
	return `${webhook.responseMode} · ${webhook.inputMode}`
}

function webhookVerificationLabel(webhook: Webhook) {
	if (!webhook.verification) return 'URL secret only'
	return `${webhook.verification.type} · ${webhook.verification.header}`
}

export function AccountWebhooks(
	handle: Handle<{ data: Data; pathname: string }>,
) {
	return () => {
		const d = handle.props.data
		const minted = d.webhooks.filter((webhook) => webhook.minted).length
		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Webhooks"
					description="Every inbound webhook your packages declare, in one list. Webhooks belong to the package that declares them; mint, rotate, or disable a URL with the webhook capabilities (webhookUrlMint, webhookUrlRotate, webhookDisable). The URL is never shown here."
					currentHref={handle.props.pathname}
				/>
				<AccountManagementPanel ariaLabel="Webhooks">
					<RecordTable
						mode="none"
						ariaLabel="Webhooks"
						countLabel={`${d.webhooks.length} declared · ${minted} minted`}
						emptyLabel="No package on this account declares a webhook yet. Add a kody.webhooks entry to a package manifest and publish it."
						columns={[
							{ key: 'name', label: 'Webhook', primary: true },
							{ key: 'package', label: 'Package' },
							{ key: 'status', label: 'Status' },
							{ key: 'delivery', label: 'Last delivery', drop: 1 },
							{ key: 'mode', label: 'Mode', drop: 3 },
							{ key: 'verification', label: 'Verification', drop: 3 },
						]}
						rows={d.webhooks.map((webhook) => ({
							id: webhook.id,
							cells: {
								name: (
									<span
										mix={css({ display: 'grid', gap: spacing.xs, minWidth: 0 })}
									>
										<strong mix={clampedCellCss}>{webhook.name}</strong>
										{webhook.handle ? (
											<span mix={clampedCellCss} title={webhook.handle}>
												<Code>{webhook.handle}</Code>
											</span>
										) : (
											<Muted small>No URL minted</Muted>
										)}
									</span>
								),
								package: (
									<a
										href={routes.accountPackageDetail.href({
											name: webhook.packageName,
										})}
										mix={clampedCellCss}
									>
										{webhook.packageName}
									</a>
								),
								status: (
									<span mix={css({ color: webhookStatusColor(webhook) })}>
										{webhookStatusLabel(webhook)}
									</span>
								),
								delivery: webhook.lastDeliveryAt ? (
									<>
										{webhook.lastDeliveryStatus ?? '—'}
										{webhook.lastDeliveryHttpStatus !== null
											? ` · HTTP ${webhook.lastDeliveryHttpStatus}`
											: null}
										<br />
										<TimestampValue value={webhook.lastDeliveryAt} />
									</>
								) : (
									<Muted>none</Muted>
								),
								mode: (
									<span mix={clampedCellCss}>{webhookModeLabel(webhook)}</span>
								),
								verification: (
									<span mix={clampedCellCss}>
										{webhookVerificationLabel(webhook)}
									</span>
								),
							},
						}))}
					/>
					<p
						mix={css({
							color: colors.textMuted,
							margin: `${spacing.md} 0 0`,
						})}
					>
						Webhooks are declared in <code>package.json#kody.webhooks</code>.
					</p>
				</AccountManagementPanel>
			</AccountManagementShell>
		)
	}
}
