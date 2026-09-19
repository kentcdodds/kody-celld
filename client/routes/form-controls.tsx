import { css, type Handle, type RemixNode } from 'remix/ui'
import { ConfirmSubmitButton } from '#client/confirm-submit-button.tsx'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import {
	getDangerPillCss,
	getPillButtonCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	accountActionsCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountInputCss,
	accountTextareaCss,
} from './account-management-components.tsx'

/*
 * Plain-HTML form building blocks for the server-rendered account, console
 * and auth pages. Every mutation here is a same-origin `POST` carrying the
 * session's CSRF token (`<CsrfInput>`); nothing needs JS to submit, so the
 * pages keep working with scripts disabled. Interactive extras (copy,
 * two-step confirmation) hydrate as islands on top.
 */

type Slot = RemixNode

/** Hidden field carrying the session CSRF token; required on every POST form. */
export function CsrfInput(handle: Handle<{ token: string }>) {
	return () => <input type="hidden" name="csrf" value={handle.props.token} />
}

export function Hidden(handle: Handle<{ name: string; value: string }>) {
	return () => (
		<input type="hidden" name={handle.props.name} value={handle.props.value} />
	)
}

type FieldProps = {
	label: string
	name: string
	type?: 'text' | 'email' | 'password' | 'url' | 'search'
	value?: string
	placeholder?: string
	autocomplete?: string
	required?: boolean
	minlength?: number
	maxlength?: number
	pattern?: string
	note?: string
	multiline?: boolean
	/** Wider label/field for auth screens; default is the account field. */
	size?: 'auth' | 'account'
}

export function Field(handle: Handle<FieldProps>) {
	return () => {
		const p = handle.props
		const id = `field-${p.name}`
		return (
			<div mix={css(accountFieldCss)}>
				<label for={id} mix={css(accountFieldLabelCss)}>
					{p.label}
				</label>
				{p.multiline ? (
					<textarea
						id={id}
						name={p.name}
						required={p.required}
						spellcheck={false}
						defaultValue={p.value ?? ''}
						mix={css(accountTextareaCss)}
					/>
				) : p.type === 'password' ? (
					<input
						id={id}
						name={p.name}
						type="password"
						placeholder={p.placeholder}
						autocomplete={p.autocomplete}
						required={p.required}
						minlength={p.minlength}
						maxlength={p.maxlength}
						mix={css(accountInputCss)}
					/>
				) : (
					<input
						id={id}
						name={p.name}
						type={p.type ?? 'text'}
						list={undefined}
						value={p.value}
						placeholder={p.placeholder}
						autocomplete={p.autocomplete}
						required={p.required}
						minlength={p.minlength}
						maxlength={p.maxlength}
						pattern={p.pattern}
						mix={css(accountInputCss)}
					/>
				)}
				{p.note ? <p mix={css(accountFieldNoteCss)}>{p.note}</p> : null}
			</div>
		)
	}
}

type ButtonProps = {
	children: Slot
	variant?: 'primary' | 'secondary' | 'pill' | 'danger'
	name?: string
	value?: string
	disabled?: boolean
}

function buttonCss(variant: ButtonProps['variant']) {
	switch (variant) {
		case 'secondary':
			return getSecondaryButtonCss()
		case 'pill':
			return getPillButtonCss()
		case 'danger':
			return getDangerPillCss()
		default:
			return getPrimaryButtonCss()
	}
}

export function SubmitButton(handle: Handle<ButtonProps>) {
	return () => (
		<button
			type="submit"
			name={handle.props.name}
			value={handle.props.value}
			disabled={handle.props.disabled}
			mix={css(buttonCss(handle.props.variant))}
		>
			{handle.props.children}
		</button>
	)
}

/**
 * A destructive POST as a single-control form: hidden action fields plus a
 * two-step confirm button (works as a plain submit before hydration).
 */
export function DangerForm(
	handle: Handle<{
		action: string
		csrf: string
		fields: Record<string, string>
		label: string
		confirmLabel?: string
	}>,
) {
	return () => (
		<form method="post" action={handle.props.action} mix={css(inlineFormCss)}>
			<CsrfInput token={handle.props.csrf} />
			{Object.entries(handle.props.fields).map(([name, value]) => (
				<Hidden key={name} name={name} value={value} />
			))}
			<ConfirmSubmitButton
				label={handle.props.label}
				confirmLabel={
					handle.props.confirmLabel ??
					`Confirm ${handle.props.label.toLowerCase()}`
				}
				variant="danger"
			/>
		</form>
	)
}

/** A non-destructive one-click POST (pause, publish, issue a link…). */
export function ActionForm(
	handle: Handle<{
		action: string
		csrf: string
		fields: Record<string, string>
		label: string
		disabled?: boolean
	}>,
) {
	return () => (
		<form method="post" action={handle.props.action} mix={css(inlineFormCss)}>
			<CsrfInput token={handle.props.csrf} />
			{Object.entries(handle.props.fields).map(([name, value]) => (
				<Hidden key={name} name={name} value={value} />
			))}
			<SubmitButton variant="pill" disabled={handle.props.disabled}>
				{handle.props.label}
			</SubmitButton>
		</form>
	)
}

export const inlineFormCss = { display: 'inline-flex', margin: 0 }

/** Sign-out is a POST too (`/signout`, `/console/signout`), never a GET link. */
export function SignOutForm(handle: Handle<{ action: string; csrf: string }>) {
	return () => (
		<form method="post" action={handle.props.action} mix={css(inlineFormCss)}>
			<CsrfInput token={handle.props.csrf} />
			<SubmitButton variant="pill">Sign out</SubmitButton>
		</form>
	)
}

/** Wrap of action controls in a table cell or under a section. */
export function Actions(handle: Handle<{ children: Slot }>) {
	return () => <div mix={css(accountActionsCss)}>{handle.props.children}</div>
}

/** A stacked form: fields then the submit row, at the account rhythm. */
export function StackedForm(
	handle: Handle<{
		action: string
		method?: 'post' | 'get'
		autocomplete?: 'off'
		children: Slot
	}>,
) {
	return () => (
		<form
			method={handle.props.method ?? 'post'}
			action={handle.props.action}
			autocomplete={handle.props.autocomplete}
			mix={css({ display: 'grid', gap: spacing.md, maxWidth: '36rem' })}
		>
			{handle.props.children}
		</form>
	)
}

/**
 * A credential shown exactly once after issuance: monospace, wraps anywhere,
 * with a copy button. Never rendered again by any page.
 */
export function SecretReveal(handle: Handle<{ value: string; label: string }>) {
	return () => (
		<div
			mix={css({
				display: 'flex',
				gap: spacing.sm,
				alignItems: 'flex-start',
				flexWrap: 'wrap',
			})}
		>
			<pre
				class="secret"
				mix={css({
					margin: 0,
					flex: '1 1 20rem',
					minWidth: 0,
					whiteSpace: 'pre-wrap',
					overflowWrap: 'anywhere',
					fontFamily: 'monospace',
					fontSize: typography.fontSize.sm,
					padding: spacing.md,
					borderRadius: radius.sm,
					border: `1px solid ${colors.border}`,
					backgroundColor: colors.background,
					color: colors.text,
					userSelect: 'all',
				})}
			>
				{handle.props.value}
			</pre>
			<CopyTextButton
				value={handle.props.value}
				variant="pill"
				ariaLabel={`Copy ${handle.props.label}`}
			/>
		</div>
	)
}

export function Badge(
	handle: Handle<{ children: Slot; tone?: 'neutral' | 'ok' | 'warn' }>,
) {
	return () => {
		const tone = handle.props.tone ?? 'neutral'
		return (
			<span
				class="badge"
				mix={css({
					display: 'inline-block',
					padding: '0.15rem 0.6rem',
					borderRadius: radius.full,
					fontSize: typography.fontSize.sm,
					fontWeight: 600,
					whiteSpace: 'nowrap',
					border: `1px solid ${
						tone === 'ok'
							? colors.primary
							: tone === 'warn'
								? colors.error
								: colors.border
					}`,
					color:
						tone === 'ok'
							? colors.primary
							: tone === 'warn'
								? colors.error
								: colors.textMuted,
					backgroundColor: colors.surface,
				})}
			>
				{handle.props.children}
			</span>
		)
	}
}

export function Code(handle: Handle<{ children: Slot }>) {
	return () => (
		<code
			mix={css({
				fontFamily: 'monospace',
				fontSize: '0.92em',
				padding: '0.1em 0.35em',
				borderRadius: radius.sm,
				backgroundColor: colors.background,
				border: `1px solid ${colors.border}`,
				overflowWrap: 'anywhere',
			})}
		>
			{handle.props.children}
		</code>
	)
}

export function Muted(handle: Handle<{ children: Slot; small?: boolean }>) {
	return () => (
		<span
			class="muted"
			mix={css({
				color: colors.textMuted,
				fontSize: handle.props.small ? typography.fontSize.sm : undefined,
			})}
		>
			{handle.props.children}
		</span>
	)
}

/** Preformatted block for JSON dumps, READMEs and install snippets. */
export function PreBlock(handle: Handle<{ children: Slot }>) {
	return () => (
		<pre
			mix={css({
				margin: 0,
				padding: spacing.md,
				borderRadius: radius.sm,
				border: `1px solid ${colors.border}`,
				backgroundColor: colors.background,
				color: colors.text,
				fontFamily: 'monospace',
				fontSize: typography.fontSize.sm,
				lineHeight: 1.5,
				overflowX: 'auto',
				whiteSpace: 'pre-wrap',
				overflowWrap: 'anywhere',
			})}
		>
			{handle.props.children}
		</pre>
	)
}

export function Lede(handle: Handle<{ children: Slot }>) {
	return () => (
		<p
			mix={css({
				margin: 0,
				color: colors.textMuted,
				maxWidth: '64ch',
			})}
		>
			{handle.props.children}
		</p>
	)
}
