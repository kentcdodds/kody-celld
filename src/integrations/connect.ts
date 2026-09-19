import type { Env } from '../env.ts'
import { getUserCell } from '../execute/engine.ts'
import { recordAudit } from '../lib/audit.ts'
import { errorToJson, KodyError } from '../lib/errors.ts'
import { dispatchTopic } from '../packages/subscriptions.ts'
import { decodeState } from './oauth.ts'
import { integrationEventPayload, type IntegrationRecord } from './store.ts'

export const oauthCallbackPath = '/connect/oauth/callback'

export function oauthRedirectUri(baseUrl: string) {
	return `${baseUrl}${oauthCallbackPath}`
}

export function connectUrl(baseUrl: string, userId: string, connectId: string, ticket: string) {
	return `${baseUrl}/connect/oauth/${encodeURIComponent(userId)}/${encodeURIComponent(connectId)}?ticket=${encodeURIComponent(ticket)}`
}

function escapeHtml(value: string) {
	return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function page(title: string, body: string, status = 200) {
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Kody</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#111}code{background:#f3f3f3;padding:.1em .3em;border-radius:3px}button{font:inherit;padding:.6em 1.2em;border-radius:6px;border:1px solid #333;background:#111;color:#fff;cursor:pointer}ul{padding-left:1.2em}.muted{color:#666}</style></head><body>${body}</body></html>`,
		{
			status,
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store',
				'referrer-policy': 'no-referrer',
			},
		},
	)
}

function errorPage(error: unknown) {
	const json = errorToJson(error)
	const status = KodyError.fromUnknown(error)?.status ?? 500
	return page(
		'Connection failed',
		`<h1>Connection failed</h1><p><code>${escapeHtml(json.error)}</code>: ${escapeHtml(json.message)}</p><p class="muted">Ask your assistant for a fresh connect link and try again.</p>`,
		status,
	)
}

async function lookupUser(env: Env, userId: string) {
	const user = await env.REGISTRY.getByName('registry').getUser(userId)
	if (!user) throw new KodyError('connect_link_invalid', 'This connect link is invalid or expired.', { status: 404 })
	const userCell = getUserCell(env, user.id)
	await userCell.init(user.id)
	return { user, userCell }
}

function notify(
	env: Env,
	ctx: ExecutionContext,
	user: { id: string; email: string },
	topic: 'integration.auth.succeeded' | 'integration.auth.failed',
	record: IntegrationRecord,
	reason: string | null,
) {
	ctx.waitUntil(
		dispatchTopic(env, ctx.exports, user, topic, {
			integration: integrationEventPayload(record),
			source: 'connect',
			...(reason ? { reason } : {}),
		}),
	)
}

/**
 * `GET|POST /connect/oauth/:userId/:connectId?ticket=…` and
 * `GET /connect/oauth/callback?code=…&state=…`.
 *
 * The connect link is the user's consent point: GET shows what will be
 * connected and which hosts may receive the token; POST burns the one-time
 * ticket, mints PKCE + state and redirects to the provider. The callback
 * validates state against the pending attempt, exchanges the code host-side
 * and seals the tokens; nothing about the token reaches the browser.
 */
export async function handleOAuthConnect(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	url: URL,
): Promise<Response> {
	try {
		if (url.pathname === oauthCallbackPath) return await handleCallback(request, env, ctx, url)
		const segments = url.pathname.split('/').filter(Boolean) // ['connect', 'oauth', userId, connectId]
		if (segments.length !== 4) throw new KodyError('not_found', `No route for ${url.pathname}.`, { status: 404 })
		const userId = decodeURIComponent(segments[2] ?? '')
		const connectId = decodeURIComponent(segments[3] ?? '')
		const { user, userCell } = await lookupUser(env, userId)

		if (request.method === 'GET') {
			const ticket = url.searchParams.get('ticket') ?? ''
			const connect = await userCell.integrationConnectGet(connectId)
			if (!connect || !ticket || connect.startedAt !== null || connect.completedAt !== null) {
				throw new KodyError('connect_link_invalid', 'This connect link is invalid, expired, or was already used.', {
					status: 404,
				})
			}
			const record = await userCell.integrationGet(connect.name)
			if (!record) throw new KodyError('integration_not_found', 'This integration no longer exists.', { status: 404 })
			const hosts = record.allowedHosts.map((h) => `<li><code>${escapeHtml(h)}</code></li>`).join('')
			const scopes = record.scopes.length
				? `<p>Requested scopes: ${record.scopes.map((s) => `<code>${escapeHtml(s)}</code>`).join(' ')}</p>`
				: ''
			return page(
				`Connect ${record.provider}`,
				`<h1>Connect <code>${escapeHtml(record.name)}</code> (${escapeHtml(record.provider)})</h1>
				<p>Signed in as <strong>${escapeHtml(user.email)}</strong>.</p>
				<p>After you authorize, Kody will hold the access token encrypted and inject it only into requests to:</p>
				<ul>${hosts}</ul>${scopes}
				${record.description ? `<p class="muted">${escapeHtml(record.description)}</p>` : ''}
				<form method="post"><input type="hidden" name="ticket" value="${escapeHtml(ticket)}"><button type="submit">Continue to ${escapeHtml(record.provider)}</button></form>
				<p class="muted">This link expires ${escapeHtml(connect.expiresAt)} and works once.</p>`,
			)
		}

		if (request.method === 'POST') {
			const form = await request.formData()
			const ticket = String(form.get('ticket') ?? '')
			const { authorizeUrl } = await userCell.integrationConnectBegin({ connectId, ticket })
			return new Response(null, { status: 303, headers: { location: authorizeUrl, 'cache-control': 'no-store' } })
		}
		return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
	} catch (error) {
		return errorPage(error)
	}
}

async function handleCallback(request: Request, env: Env, ctx: ExecutionContext, url: URL) {
	if (request.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
	const state = decodeState(url.searchParams.get('state') ?? '')
	if (!state) throw new KodyError('connect_state_invalid', 'Missing or malformed OAuth state.', { status: 400 })
	const { user, userCell } = await lookupUser(env, state.userId)
	const providerError = url.searchParams.get('error')
	const pending = await userCell.integrationConnectGet(state.connectId)
	try {
		const { record } = await userCell.integrationConnectComplete({
			connectId: state.connectId,
			nonce: state.nonce,
			code: url.searchParams.get('code'),
			providerError: providerError
				? `${providerError}${url.searchParams.get('error_description') ? `: ${url.searchParams.get('error_description')}` : ''}`
				: null,
		})
		await recordAudit(env, {
			actor: `user:${user.id}`,
			action: 'integration.connect',
			target: record.name,
			details: { provider: record.provider, grantedScope: record.grantedScope, expiresAt: record.expiresAt },
		})
		notify(env, ctx, user, 'integration.auth.succeeded', record, null)
		return page(
			'Connected',
			`<h1>Connected <code>${escapeHtml(record.name)}</code></h1><p>${escapeHtml(record.provider)} is now connected for <strong>${escapeHtml(user.email)}</strong>. You can close this tab and tell your assistant to continue.</p>`,
		)
	} catch (error) {
		const json = errorToJson(error)
		// A connect attempt fails at most once; later hits on the same state are replays.
		if (pending && pending.completedAt === null) {
			const record = await userCell.integrationGet(pending.name)
			await recordAudit(env, {
				actor: `user:${user.id}`,
				action: 'integration.connect_failed',
				target: pending.name,
				details: { error: json.error, message: json.message },
			})
			if (record) notify(env, ctx, user, 'integration.auth.failed', record, `${json.error}: ${json.message}`)
		}
		throw error
	}
}
