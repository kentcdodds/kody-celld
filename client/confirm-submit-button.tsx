import { type Handle, clientEntry, css } from 'remix/ui'
import { createDoubleCheck } from '#client/double-check.ts'
import { clientEntryId } from '#universal/client-entry.ts'
import {
	getDangerPillCss,
	getGhostButtonCss,
} from '#universal/styles/style-primitives.ts'

export type ConfirmSubmitButtonProps = {
	label: string
	/** Label shown after the first click, while the action is armed. */
	confirmLabel?: string
	variant?: 'danger' | 'ghost'
	name?: string
	value?: string
	formaction?: string
}

const dangerCss = css(getDangerPillCss({ size: 'sm' }))
const ghostCss = css(getGhostButtonCss({ size: 'sm' }))

/**
 * Submit button for destructive forms with kody's double-check: the first
 * click arms the button (label swaps to "Really delete?"), the second submits,
 * and blur disarms. Without JavaScript it is a plain submit, so the form
 * still works — the confirmation is an enhancement, never a gate.
 */
export const ConfirmSubmitButton = clientEntry(
	clientEntryId('ConfirmSubmitButton'),
	ConfirmSubmitButtonComponent,
)

function ConfirmSubmitButtonComponent(
	handle: Handle<ConfirmSubmitButtonProps>,
) {
	const doubleCheck = createDoubleCheck(handle)
	return () => (
		<button
			type="submit"
			name={handle.props.name}
			value={handle.props.value}
			formAction={handle.props.formaction}
			aria-live="polite"
			mix={[
				handle.props.variant === 'ghost' ? ghostCss : dangerCss,
				...doubleCheck.getButtonMix(),
			]}
		>
			{doubleCheck.doubleCheck
				? (handle.props.confirmLabel ?? 'Are you sure?')
				: handle.props.label}
		</button>
	)
}
