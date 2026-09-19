import { css, type Handle } from 'remix/ui'
import {
	type AppLoaderData,
	type PasswordFormView,
} from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { mutedLinkCss } from '#universal/styles/style-primitives.ts'
import { colors } from '#universal/styles/tokens.ts'
import { AuthSection, AuthShell } from './auth-shell.tsx'
import {
	Code,
	CsrfInput,
	Field,
	Hidden,
	Muted,
	StackedForm,
	SubmitButton,
} from './form-controls.tsx'

type LoginData = Extract<AppLoaderData, { page: 'login' }>

/**
 * `/signin`. Three plain POST forms — password, emailed link (only when an
 * outbound email adapter exists), API token — each tagged with a hidden
 * `method` the handler switches on. No JS required.
 */
export function Login(handle: Handle<{ data: LoginData }>) {
	return () => {
		const { next, email, magicLinks } = handle.props.data
		return (
			<AuthShell
				title="Sign in"
				description="Your self-hosted Kody. Sign in to manage packages, secrets, jobs and connected MCP clients."
			>
				<AuthSection title="Email and password" first>
					<StackedForm action={routes.login.href()}>
						<Hidden name="method" value="password" />
						<Hidden name="next" value={next} />
						<Field
							label="Email"
							name="email"
							type="email"
							autocomplete="username"
							value={email}
							required
						/>
						<Field
							label="Password"
							name="password"
							type="password"
							autocomplete="current-password"
							required
						/>
						<div>
							<SubmitButton>Sign in</SubmitButton>
						</div>
					</StackedForm>
				</AuthSection>
				{magicLinks ? (
					<AuthSection title="Email me a link">
						<StackedForm action={routes.login.href()}>
							<Hidden name="method" value="magic" />
							<Hidden name="next" value={next} />
							<Field
								label="Email"
								name="email"
								type="email"
								autocomplete="username"
								required
							/>
							<div>
								<SubmitButton variant="secondary">
									Send sign-in link
								</SubmitButton>
							</div>
						</StackedForm>
					</AuthSection>
				) : null}
				<AuthSection title="API token">
					<Muted small>
						Have a <Code>kc_…</Code> token from the admin? Paste it to sign in
						and set a password.
					</Muted>
					<StackedForm action={routes.login.href()}>
						<Hidden name="method" value="token" />
						<Hidden name="next" value={next} />
						<Field
							label="Token"
							name="token"
							type="password"
							autocomplete="off"
							required
						/>
						<div>
							<SubmitButton variant="secondary">
								Sign in with token
							</SubmitButton>
						</div>
					</StackedForm>
				</AuthSection>
				<p
					mix={css({ margin: 0, color: colors.textMuted, fontSize: '0.92rem' })}
				>
					No account? Ask the operator for an invite link
					{magicLinks ? '' : ' or an API token'}. Operators use the{' '}
					<a href={routes.admin.href()} mix={css(mutedLinkCss)}>
						admin console
					</a>
					.
				</p>
			</AuthShell>
		)
	}
}

type SetupData = Extract<AppLoaderData, { page: 'setup' }>

/** `/setup`: the first account, gated on `KODY_ADMIN_TOKEN`. */
export function Setup(handle: Handle<{ data: SetupData }>) {
	return () => {
		const { passwordMinLength } = handle.props.data
		return (
			<AuthShell
				title="Set up Kody"
				description={
					<>
						No accounts exist yet. Create the first one with the admin token
						from your deployment's <Code>KODY_ADMIN_TOKEN</Code> (see{' '}
						<Code>.env</Code> or the Docker volume).
					</>
				}
			>
				<StackedForm action={routes.setup.href()}>
					<Field
						label="Admin token"
						name="adminToken"
						type="password"
						autocomplete="off"
						required
					/>
					<Field
						label="Your email"
						name="email"
						type="email"
						autocomplete="email"
						required
					/>
					<Field
						label={`Password (${passwordMinLength}+ characters)`}
						name="password"
						type="password"
						autocomplete="new-password"
						minlength={passwordMinLength}
						required
					/>
					<Field
						label="Confirm password"
						name="confirm"
						type="password"
						autocomplete="new-password"
						required
					/>
					<div>
						<SubmitButton>Create account</SubmitButton>
					</div>
				</StackedForm>
			</AuthShell>
		)
	}
}

/** Shared by `/account` (change) and one-time links (set/reset). */
export function PasswordForm(
	handle: Handle<{ form: PasswordFormView; csrf?: string }>,
) {
	return () => {
		const { form, csrf } = handle.props
		return (
			<StackedForm action={form.action}>
				{csrf ? <CsrfInput token={csrf} /> : null}
				{form.requireCurrent ? (
					<Field
						label="Current password"
						name="current"
						type="password"
						autocomplete="current-password"
						required
					/>
				) : null}
				<Field
					label={`New password (${form.minLength}+ characters)`}
					name="password"
					type="password"
					autocomplete="new-password"
					minlength={form.minLength}
					required
				/>
				<Field
					label="Confirm"
					name="confirm"
					type="password"
					autocomplete="new-password"
					required
				/>
				<div>
					<SubmitButton>{form.submit}</SubmitButton>
				</div>
			</StackedForm>
		)
	}
}

type LinkPasswordData = Extract<AppLoaderData, { page: 'signinLinkPassword' }>

export function SigninLinkPassword(handle: Handle<{ data: LinkPasswordData }>) {
	return () => {
		const { kind, email, passwordForm } = handle.props.data
		return (
			<AuthShell
				title={kind === 'invite' ? 'Welcome to Kody' : 'Reset your password'}
				description={
					<>
						{kind === 'invite'
							? 'Set a password for '
							: 'Choose a new password for '}
						<strong>{email}</strong>.
					</>
				}
			>
				<PasswordForm form={passwordForm} />
			</AuthShell>
		)
	}
}

export function SigninLinkExpired() {
	return () => (
		<AuthShell title="Link expired">
			<p mix={css({ margin: 0 })}>
				This sign-in link is invalid, expired, or was already used.
			</p>
			<p mix={css({ margin: 0 })}>
				<a href={routes.login.href()}>Back to sign in</a>
			</p>
		</AuthShell>
	)
}

/** `/console` before the operator cookie exists. */
export function AdminLogin() {
	return () => (
		<AuthShell
			title="Admin console"
			description={
				<>
					Sign in with the deployment's <Code>KODY_ADMIN_TOKEN</Code>. Looking
					for your own account?{' '}
					<a href={routes.login.href()} mix={css(mutedLinkCss)}>
						User sign-in
					</a>
					.
				</>
			}
		>
			<StackedForm action={routes.adminLogin.href()}>
				<Field
					label="Admin token"
					name="token"
					type="password"
					autocomplete="off"
					required
				/>
				<div>
					<SubmitButton>Sign in</SubmitButton>
				</div>
			</StackedForm>
		</AuthShell>
	)
}
