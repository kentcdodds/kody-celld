import { authenticateBearer, mcpUnauthorized } from '../auth/authenticate.ts'
import { sessionSignature } from '../auth/cookies.ts'
import { constantTimeEqualString } from '../auth/password.ts'
import type { Env } from '../env.ts'
import { recordAudit } from '../lib/audit.ts'
import { renderPage } from '#app/render.tsx'
import { appSessionOf, readForm, redirect } from '../web/http.ts'
import { assertCsrf, readWebSession } from '../web/session.ts'
import {
	authorizationServerMetadata,
	oauthErrorBody,
	oauthPaths,
	OAuthProtocolError,
	parseAuthorizeRequest,
	parseClientRegistration,
	protectedResourceMetadata,
	readClientCredentials,
	redirectWithParams,
	verifyPkce,
} from './protocol.ts'

const corsHeaders = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, POST, OPTIONS',
	'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
	'access-control-max-age': '86400',
}

function oauthJson(payload: unknown, status = 200) {
	return Response.json(payload, {
		status,
		headers: { ...corsHeaders, 'cache-control': 'no-store', pragma: 'no-cache' },
	})
}

function oauthError(error: unknown) {
	const { status, body } = oauthErrorBody(error)
	const headers: Record<string, string> = { ...corsHeaders, 'cache-control': 'no-store' }
	if (status === 401) headers['www-authenticate'] = `Basic realm="kody-celld oauth", Bearer realm="kody-celld oauth"`
	return Response.json(body, { status, headers })
}

const registry = (env: Env) => env.REGISTRY.getByName('registry')

function isWellKnown(pathname: string) {
	return (
		pathname === oauthPaths.authorizationServerMetadata ||
		pathname === `${oauthPaths.authorizationServerMetadata}/mcp` ||
		pathname === oauthPaths.protectedResourceMetadata ||
		pathname === `${oauthPaths.protectedResourceMetadata}/mcp`
	)
}

export function isOAuthRoute(pathname: string) {
	return isWellKnown(pathname) || pathname === '/oauth' || pathname.startsWith('/oauth/')
}

/** MCP authorization server: discovery, DCR, consent, token, revoke, userinfo. */
export async function handleOAuth(request: Request, env: Env, url: URL): Promise<Response> {
	const issuer = env.KODY_PUBLIC_URL
	if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })

	if (isWellKnown(url.pathname)) {
		if (request.method !== 'GET') return oauthError(new OAuthProtocolError('invalid_request', 'GET only.', 405))
		const body = url.pathname.startsWith(oauthPaths.protectedResourceMetadata)
			? protectedResourceMetadata(issuer)
			: authorizationServerMetadata(issuer)
		return Response.json(body, { headers: { ...corsHeaders, 'cache-control': 'public, max-age=300' } })
	}

	try {
		switch (url.pathname) {
			case oauthPaths.register:
				return await handleRegister(request, env)
			case oauthPaths.authorize:
				return await handleAuthorize(request, env, url)
			case oauthPaths.token:
				return await handleToken(request, env)
			case oauthPaths.revoke:
				return await handleRevoke(request, env)
			case '/oauth/userinfo':
				return await handleUserinfo(request, env)
			default:
				throw new OAuthProtocolError('invalid_request', `No OAuth route for ${url.pathname}.`, 404)
		}
	} catch (error) {
		return oauthError(error)
	}
}

// ---------------------------------------------------------------- register

async function handleRegister(request: Request, env: Env) {
	if (request.method !== 'POST') throw new OAuthProtocolError('invalid_request', 'POST only.', 405)
	let body: unknown
	try {
		body = await request.json()
	} catch {
		throw new OAuthProtocolError('invalid_client_metadata', 'Body must be JSON.')
	}
	const registration = parseClientRegistration(body)
	const client = await registry(env).oauthClientRegister(registration)
	await recordAudit(env, {
		actor: 'system',
		action: 'mcp_client.register',
		target: client.clientId,
		details: { clientName: client.clientName, redirectUris: client.redirectUris, auth: client.tokenEndpointAuthMethod },
	})
	return oauthJson(
		{
			client_id: client.clientId,
			client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
			...(client.clientSecret ? { client_secret: client.clientSecret, client_secret_expires_at: 0 } : {}),
			client_name: client.clientName,
			redirect_uris: client.redirectUris,
			token_endpoint_auth_method: client.tokenEndpointAuthMethod,
			grant_types: client.grantTypes,
			response_types: ['code'],
			...(client.clientUri ? { client_uri: client.clientUri } : {}),
			...(client.logoUri ? { logo_uri: client.logoUri } : {}),
			...(client.softwareId ? { software_id: client.softwareId } : {}),
			...(client.softwareVersion ? { software_version: client.softwareVersion } : {}),
		},
		201,
	)
}

// --------------------------------------------------------------- authorize

/** Errors before the redirect URI is validated must not redirect (open-redirect guard). */
function authorizeErrorPage(error: unknown) {
	const { body, status } = oauthErrorBody(error)
	return renderPage({
		title: 'Cannot authorize this client',
		pathname: oauthPaths.authorize,
		status: status >= 400 && status < 600 ? status : 400,
		data: { page: 'oauthAuthorizeError', error: body.error, description: body.error_description },
	})
}

async function loadAuthorizeRequest(env: Env, params: URLSearchParams) {
	const clientId = params.get('client_id')
	const client = clientId ? await registry(env).oauthClientGet(clientId) : null
	const authorize = parseAuthorizeRequest(params, client, env.KODY_PUBLIC_URL)
	return { client: client!, authorize }
}

async function handleAuthorize(request: Request, env: Env, url: URL) {
	if (request.method !== 'GET' && request.method !== 'POST') {
		throw new OAuthProtocolError('invalid_request', 'GET or POST only.', 405)
	}
	const form = request.method === 'POST' ? await readForm(request) : {}
	const session = await readWebSession(request, env)

	if (request.method === 'POST') {
		// The consent form carries the authorization request it was rendered for,
		// signed for this session: a tampered client_id / redirect_uri / PKCE
		// challenge / scope between display and submit is refused before parsing.
		if (!session) return redirect('/signin?flash=signin_required')
		assertCsrf(request, env, session, form)
		const expected = await sessionSignature(env.KODY_MASTER_KEY, session.session.id, 'authorize', form.q ?? '')
		if (!form.sig || !constantTimeEqualString(form.sig, expected)) {
			return authorizeErrorPage(
				new OAuthProtocolError('invalid_request', 'The consent form did not match the authorization request.'),
			)
		}
	}
	const params = request.method === 'POST' ? new URLSearchParams(form.q ?? '') : url.searchParams

	let loaded: Awaited<ReturnType<typeof loadAuthorizeRequest>>
	try {
		loaded = await loadAuthorizeRequest(env, params)
	} catch (error) {
		return authorizeErrorPage(error)
	}
	const { client, authorize } = loaded

	if (!session) {
		const next = `${oauthPaths.authorize}?${params.toString()}`
		return redirect(`/signin?next=${encodeURIComponent(next)}`)
	}

	if (request.method === 'GET') {
		const q = params.toString()
		return renderPage({
			title: `Connect ${client.clientName}`,
			pathname: oauthPaths.authorize,
			session: appSessionOf(session),
			data: {
				page: 'oauthAuthorize',
				clientName: client.clientName,
				clientUri: client.clientUri,
				redirectHost: new URL(authorize.redirectUri).host || authorize.redirectUri,
				action: oauthPaths.authorize,
				csrf: session.csrf,
				q,
				sig: await sessionSignature(env.KODY_MASTER_KEY, session.session.id, 'authorize', q),
			},
		})
	}

	if (form.decision !== 'approve') {
		await recordAudit(env, {
			actor: `user:${session.user.id}`,
			action: 'mcp_client.deny',
			target: client.clientId,
			details: { clientName: client.clientName },
		})
		return redirect(
			redirectWithParams(authorize.redirectUri, {
				error: 'access_denied',
				error_description: 'The user declined the request.',
				state: authorize.state,
			}),
		)
	}
	const code = await registry(env).oauthCodeIssue({
		clientId: client.clientId,
		userId: session.user.id,
		redirectUri: authorize.redirectUri,
		codeChallenge: authorize.codeChallenge,
		scope: authorize.scope,
		resource: authorize.resource,
	})
	await recordAudit(env, {
		actor: `user:${session.user.id}`,
		action: 'mcp_client.authorize',
		target: client.clientId,
		details: { clientName: client.clientName, redirectHost: new URL(authorize.redirectUri).host },
	})
	return redirect(redirectWithParams(authorize.redirectUri, { code, state: authorize.state, iss: env.KODY_PUBLIC_URL }))
}

// ------------------------------------------------------------------- token

async function readTokenForm(request: Request) {
	if (request.method !== 'POST') throw new OAuthProtocolError('invalid_request', 'POST only.', 405)
	const type = request.headers.get('content-type') ?? ''
	if (!type.includes('application/x-www-form-urlencoded')) {
		throw new OAuthProtocolError('invalid_request', 'Send application/x-www-form-urlencoded.')
	}
	return new URLSearchParams(await request.text())
}

async function handleToken(request: Request, env: Env) {
	const form = await readTokenForm(request)
	const credentials = readClientCredentials(request, form)
	const client = await registry(env).oauthClientAuthenticate(credentials)
	const grantType = form.get('grant_type')

	if (grantType === 'authorization_code') {
		if (!client.grantTypes.includes('authorization_code')) {
			throw new OAuthProtocolError('unauthorized_client', 'Client may not use authorization_code.')
		}
		const code = form.get('code')
		if (!code) throw new OAuthProtocolError('invalid_request', 'code is required.')
		const record = await registry(env).oauthCodeConsume(code)
		if (!record || record.clientId !== client.clientId) {
			throw new OAuthProtocolError('invalid_grant', 'Unknown, expired, or already-used code.')
		}
		const redirectUri = form.get('redirect_uri')
		if (redirectUri && redirectUri !== record.redirectUri) {
			throw new OAuthProtocolError('invalid_grant', 'redirect_uri does not match the authorization request.')
		}
		if (!(await verifyPkce(form.get('code_verifier'), record.codeChallenge))) {
			throw new OAuthProtocolError('invalid_grant', 'PKCE code_verifier does not match.')
		}
		const resource = form.get('resource')
		if (resource && resource !== record.resource) {
			throw new OAuthProtocolError('invalid_target', `Tokens are issued for ${record.resource} only.`)
		}
		const grantId = await registry(env).oauthGrantEnsure({
			userId: record.userId,
			clientId: client.clientId,
			scope: record.scope,
		})
		const tokens = await registry(env).oauthTokensIssue({ grantId, clientId: client.clientId, scope: record.scope })
		return oauthJson(tokens)
	}

	if (grantType === 'refresh_token') {
		if (!client.grantTypes.includes('refresh_token')) {
			throw new OAuthProtocolError('unauthorized_client', 'Client may not use refresh_token.')
		}
		const refreshToken = form.get('refresh_token')
		if (!refreshToken) throw new OAuthProtocolError('invalid_request', 'refresh_token is required.')
		const tokens = await registry(env).oauthTokensRefresh({ refreshToken, clientId: client.clientId })
		return oauthJson(tokens)
	}

	throw new OAuthProtocolError('unsupported_grant_type', 'Use authorization_code or refresh_token.')
}

// ------------------------------------------------------------------ revoke

async function handleRevoke(request: Request, env: Env) {
	const form = await readTokenForm(request)
	const client = await registry(env).oauthClientAuthenticate(readClientCredentials(request, form))
	const token = form.get('token')
	if (!token) throw new OAuthProtocolError('invalid_request', 'token is required.')
	await registry(env).oauthTokenRevoke({ token, clientId: client.clientId })
	// RFC 7009 §2.2: 200 whether or not the token existed.
	return new Response(null, { status: 200, headers: { ...corsHeaders, 'cache-control': 'no-store' } })
}

// ---------------------------------------------------------------- userinfo

async function handleUserinfo(request: Request, env: Env) {
	if (request.method !== 'GET' && request.method !== 'POST') {
		throw new OAuthProtocolError('invalid_request', 'GET or POST only.', 405)
	}
	const principal = await authenticateBearer(request, env)
	if (!principal) return mcpUnauthorized(env, request, 'A valid access token is required.')
	return oauthJson({
		sub: principal.user.id,
		email: principal.user.email,
		email_verified: true,
		name: principal.user.email.split('@')[0],
		preferred_username: principal.user.email,
	})
}
