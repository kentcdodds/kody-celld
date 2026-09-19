// Password-form helpers kept free of the SSR renderer so `node --test` can load them.

import { type PasswordFormView } from '#universal/loader-data.ts'
import { passwordMinLength, validatePassword } from '../auth/password.ts'
import { KodyError } from '../lib/errors.ts'

/** Validates before any token is consumed or account created, so a typo does not burn a one-time link. */
export function passwordProblem(form: { password?: string; confirm?: string }) {
	if (!form.password || form.password !== form.confirm) return 'Passwords do not match.'
	try {
		validatePassword(form.password)
		return null
	} catch (error) {
		return KodyError.fromUnknown(error)?.message ?? 'That password is not allowed.'
	}
}

/** Serializable description of a password form; `client/routes/login.tsx` renders it. */
export function passwordFormView(input: {
	action: string
	submit: string
	requireCurrent?: boolean
}): PasswordFormView {
	return {
		action: input.action,
		submit: input.submit,
		requireCurrent: input.requireCurrent ?? false,
		minLength: passwordMinLength,
	}
}
