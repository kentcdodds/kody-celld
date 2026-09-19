import { inviteTtlMs, magicLinkTtlMs, type SigninTokenKind } from '../auth/account-store.ts'
import { assertSameOrigin } from '../auth/cookies.ts'
import { passwordMinLength } from '../auth/password.ts'
import { sendOutbound } from '../email/outbound.ts'
import { loadEmailConfig } from '../email/service.ts'
import type { Env } from '../env.ts'
import { getUserCell } from '../execute/engine.ts'
import { recordAudit } from '../lib/audit.ts'
import { KodyError } from '../lib/errors.ts'
import { renderPage } from '#app/render.tsx'
import { type PageFlash } from '#universal/loader-data.ts'
import { readForm, redirect, safeNext } from './http.ts'
import { passwordFormView, passwordProblem } from './password-form.ts'
export { passwordFormView, passwordProblem }
import { endWebSession, readWebSession, startWebSession } from './session.ts'

const registry = (env: Env) => env.REGISTRY.getByName('registry')

export function isSigninRoute(pathname: string) {
	return pathname === '/signin' || pathname.startsWith('/signin/') || pathname === '/signout' || pathname === '/setup'
}

/** Whether magic links can actually be delivered (an outbound email adapter is configured). */
export function magicLinksAvailable(env: Env) {
	return loadEmailConfig(env)?.outbound != null
}

export function signinLinkUrl(env: Env, token: string) {
	return `${env.KODY_PUBLIC_URL}/signin/link/${encodeURIComponent(token)}`
}

/**
 * Issues a one-time sign-in link. Invite/reset links are shown to the admin
 * (console) to hand over out of band; magic links are emailed to the account.
 */
export async function issueSigninLink(env: Env, input: { userId: string; kind: SigninTokenKind }) {
	const issued = await registry(env).signinTokenIssue({
		userId: input.userId,
		kind: input.kind,
		ttlMs: input.kind === 'magic' ? magicLinkTtlMs : inviteTtlMs,
	})
	return { url: signinLinkUrl(env, issued.token), expiresAt: issued.expiresAt }
}

async function emailMagicLink(env: Env, email: string, url: string) {
	const config = loadEmailConfig(env)
	if (!config?.outbound)
		throw new KodyError('email_outbound_not_configured', 'Magic links need an outbound email adapter.')
	await sendOutbound(config.outbound, {
		from: { address: `no-reply@${config.domain}`, name: config.fromName },
		to: [{ address: email, name: null }],
		cc: [],
		replyTo: [],
		subject: 'Your Kody sign-in link',
		text: `Open this link within 15 minutes to sign in to Kody:\n\n${url}\n\nIf you did not request it, ignore this email.`,
		html: null,
		headers: {},
		inReplyTo: null,
		references: [],
		attachments: [],
	})
}

export async function handleSignin(request: Request, env: Env, url: URL): Promise<Response> {
	if (url.pathname === '/signout') return handleSignout(request, env)
	if (url.pathname === '/setup') return handleSetup(request, env)
	if (url.pathname.startsWith('/signin/link/')) {
		return handleLink(request, env, decodeURIComponent(url.pathname.slice('/signin/link/'.length)))
	}
	if (url.pathname !== '/signin') throw new KodyError('not_found', `No route for ${url.pathname}.`, { status: 404 })

	const next = safeNext(url.searchParams.get('next'))
	const existing = await readWebSession(request, env)
	if (existing && request.method === 'GET') return redirect(next)
	if ((await registry(env).userCount()) === 0) return redirect('/setup')

	if (request.method === 'GET') {
		return signinPage(env, { next, flash: flashFromQuery(url) })
	}
	if (request.method !== 'POST') throw new KodyError('method_not_allowed', 'GET or POST only.', { status: 405 })
	assertSameOrigin(request, env.KODY_PUBLIC_URL)
	const form = await readForm(request)
	const nextTarget = safeNext(form.next)

	if (form.method === 'password') {
		const email = (form.email ?? '').trim().toLowerCase()
		if (!email || !form.password)
			return signinPage(env, { next: nextTarget, error: 'Email and password are required.', email })
		const user = await registry(env).passwordSignin({ email, password: form.password })
		if (!user) {
			await recordAudit(env, {
				actor: 'anonymous',
				action: 'signin.failed',
				target: email,
				details: { method: 'password' },
			})
			return signinPage(env, { next: nextTarget, error: 'Wrong email or password.', email, status: 401 })
		}
		return await finishSignin(request, env, user.id, 'password', nextTarget)
	}

	if (form.method === 'token') {
		const token = (form.token ?? '').trim()
		const user = token ? await registry(env).resolveToken(token) : null
		if (!user) {
			await recordAudit(env, {
				actor: 'anonymous',
				action: 'signin.failed',
				target: null,
				details: { method: 'token' },
			})
			return signinPage(env, { next: nextTarget, error: 'That API token is not valid.', status: 401 })
		}
		return await finishSignin(request, env, user.id, 'token', nextTarget)
	}

	if (form.method === 'magic') {
		if (!magicLinksAvailable(env)) {
			return signinPage(env, { next: nextTarget, error: 'This server has no outbound email adapter configured.' })
		}
		const email = (form.email ?? '').trim().toLowerCase()
		// Always answer the same way so the form does not reveal which emails have accounts.
		const user = email ? await registry(env).getUserByEmail(email) : null
		if (user) {
			const link = await issueSigninLink(env, { userId: user.id, kind: 'magic' })
			await emailMagicLink(env, user.email, link.url)
			await recordAudit(env, { actor: 'anonymous', action: 'signin.magic_link', target: user.id, details: null })
		}
		return signinPage(env, {
			next: nextTarget,
			flash: { kind: 'ok', text: 'If that address has an account, a sign-in link is on its way (valid 15 minutes).' },
		})
	}

	return signinPage(env, { next: nextTarget, error: 'Unknown sign-in method.' })
}

async function finishSignin(request: Request, env: Env, userId: string, method: string, next: string) {
	await getUserCell(env, userId).init(userId)
	const cookie = await startWebSession(request, env, userId)
	await recordAudit(env, { actor: `user:${userId}`, action: 'signin', target: null, details: { method } })
	return redirect(next, { 'set-cookie': cookie })
}

async function handleSignout(request: Request, env: Env) {
	if (request.method !== 'POST') return redirect('/signin')
	assertSameOrigin(request, env.KODY_PUBLIC_URL)
	const cookie = await endWebSession(request, env)
	return redirect('/signin?flash=signed_out', { 'set-cookie': cookie })
}

// ---------------------------------------------------------- one-time links

async function handleLink(request: Request, env: Env, token: string) {
	const peek = await registry(env).signinTokenPeek(token)
	if (!peek) {
		return renderPage({
			title: 'Link expired',
			pathname: '/signin',
			status: 410,
			data: { page: 'signinLinkExpired' },
		})
	}

	if (peek.kind === 'magic') {
		// Magic links sign in on GET; the token is consumed so the link is single-use.
		const consumed = await registry(env).signinTokenConsume(token)
		if (!consumed) return redirect('/signin?flash=link_expired')
		return await finishSignin(request, env, consumed.user.id, 'magic', '/account')
	}

	const kind = peek.kind
	const title = kind === 'invite' ? 'Welcome to Kody' : 'Reset your password'
	const pathname = new URL(request.url).pathname
	const linkPage = (input: { submit: string; status?: number; flash?: PageFlash | null }) =>
		renderPage({
			title,
			pathname,
			status: input.status ?? 200,
			flash: input.flash ?? null,
			data: {
				page: 'signinLinkPassword',
				kind,
				email: peek.user.email,
				passwordForm: passwordFormView({ action: pathname, submit: input.submit }),
			},
		})
	if (request.method === 'GET') {
		return linkPage({ submit: peek.kind === 'invite' ? 'Create account' : 'Set password' })
	}
	if (request.method !== 'POST') throw new KodyError('method_not_allowed', 'GET or POST only.', { status: 405 })
	assertSameOrigin(request, env.KODY_PUBLIC_URL)
	const form = await readForm(request)
	const problem = passwordProblem(form)
	if (problem || !form.password) {
		return linkPage({
			submit: 'Set password',
			status: 400,
			flash: { kind: 'error', text: problem ?? 'Passwords do not match.' },
		})
	}
	const consumed = await registry(env).signinTokenConsume(token)
	if (!consumed) return redirect('/signin?flash=link_expired')
	await registry(env).passwordSet(consumed.user.id, form.password)
	await recordAudit(env, {
		actor: `user:${consumed.user.id}`,
		action: consumed.kind === 'invite' ? 'signin.invite_accepted' : 'password.reset',
		target: null,
		details: null,
	})
	return await finishSignin(request, env, consumed.user.id, consumed.kind, '/account')
}

// ------------------------------------------------------------ first run

/**
 * `/setup` creates the very first account. It is only reachable while the
 * registry has zero users and requires KODY_ADMIN_TOKEN, so a fresh public
 * deployment cannot be claimed by a stranger who finds it first.
 */
async function handleSetup(request: Request, env: Env) {
	if ((await registry(env).userCount()) > 0) return redirect('/signin')
	const body = (error: string | null = null) =>
		renderPage({
			title: 'Set up Kody',
			pathname: '/setup',
			status: error ? 400 : 200,
			flash: error ? { kind: 'error', text: error } : null,
			data: { page: 'setup', passwordMinLength },
		})
	if (request.method === 'GET') return body()
	if (request.method !== 'POST') throw new KodyError('method_not_allowed', 'GET or POST only.', { status: 405 })
	assertSameOrigin(request, env.KODY_PUBLIC_URL)
	const form = await readForm(request)
	if (!timingSafeEqual(form.adminToken ?? '', env.KODY_ADMIN_TOKEN)) return body('Admin token does not match.')
	const email = (form.email ?? '').trim().toLowerCase()
	if (!email.includes('@')) return body('A valid email is required.')
	const problem = passwordProblem(form)
	if (problem || !form.password) return body(problem ?? 'Passwords do not match.')
	// Re-check under the same request: two racing setups must not both succeed.
	if ((await registry(env).userCount()) > 0) return redirect('/signin')
	const created = await registry(env).createUser({ email, label: 'first account (setup)' })
	await registry(env).passwordSet(created.user.id, form.password)
	await recordAudit(env, {
		actor: 'admin',
		action: 'user.create',
		target: created.user.id,
		details: { email, via: 'setup' },
	})
	return await finishSignin(request, env, created.user.id, 'setup', '/account?flash=welcome')
}

function timingSafeEqual(a: string, b: string) {
	const enc = new TextEncoder()
	const ab = enc.encode(a)
	const bb = enc.encode(b)
	if (ab.byteLength !== bb.byteLength) return false
	return crypto.subtle.timingSafeEqual(ab, bb)
}

// ------------------------------------------------------------------ views

const flashes: Record<string, PageFlash> = {
	signed_out: { kind: 'ok', text: 'Signed out.' },
	link_expired: { kind: 'error', text: 'That link expired or was already used. Request a new one.' },
	signin_required: { kind: 'error', text: 'Sign in to continue.' },
}

function flashFromQuery(url: URL) {
	return flashes[url.searchParams.get('flash') ?? ''] ?? null
}

function signinPage(
	env: Env,
	input: {
		next: string
		error?: string
		email?: string
		status?: number
		flash?: PageFlash | null
	},
) {
	return renderPage({
		title: 'Sign in',
		pathname: '/signin',
		status: input.status ?? (input.error ? 400 : 200),
		flash: input.error ? { kind: 'error', text: input.error } : (input.flash ?? null),
		data: {
			page: 'login',
			next: input.next,
			email: input.email ?? '',
			magicLinks: magicLinksAvailable(env),
		},
	})
}
