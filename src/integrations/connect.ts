import { renderPage } from '#app/render.tsx'
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

function errorPage(error: unknown) {
	const json = errorToJson(error)
	const status = KodyError.fromUnknown(error)?.status ?? 500
	return renderPage({
		title: 'Connection failed',
		pathname: oauthCallbackPath,
		status,
		headers: { 'referrer-policy': 'no-referrer' },
		data: { page: 'connectOauthError', error: json.error, message: json.message },
	})
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
			return renderPage({
				title: `Connect ${record.provider}`,
				pathname: url.pathname,
				headers: { 'referrer-policy': 'no-referrer' },
				data: {
					page: 'connectOauth',
					name: record.name,
					provider: record.provider,
					email: user.email,
					hosts: record.allowedHosts,
					scopes: record.scopes,
					description: record.description ?? null,
					ticket,
					expiresAt: connect.expiresAt,
				},
			})
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
		return renderPage({
			title: 'Connected',
			pathname: oauthCallbackPath,
			headers: { 'referrer-policy': 'no-referrer' },
			data: { page: 'connectOauthDone', name: record.name, provider: record.provider, email: user.email },
		})
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
