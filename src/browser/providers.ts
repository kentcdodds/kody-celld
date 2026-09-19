import { KodyError } from '../lib/errors.ts'
import { hostMatchesApproval } from '../secrets/host-policy.ts'
import type { BrowserConfig } from './config.ts'

export type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'
export type ScreenshotFormat = 'png' | 'jpeg' | 'webp'

export type PageTarget = { url: string } | { html: string }

export type RenderOptions = PageTarget & {
	waitUntil: WaitUntil
	/** Navigation timeout inside the browser (ms); the HTTP call itself uses config.timeoutMs. */
	timeoutMs: number
}

export type ScreenshotOptions = RenderOptions & {
	fullPage: boolean
	format: ScreenshotFormat
	quality?: number | undefined
	width: number
	height: number
	selector?: string | undefined
}

export type PdfOptions = RenderOptions & {
	format: 'A4' | 'Letter' | 'Legal'
	landscape: boolean
	printBackground: boolean
}

export type RenderedBytes = { bytes: Uint8Array; contentType: string }

export interface BrowserRenderer {
	readonly kind: 'browserless' | 'cloudflare'
	screenshot(options: ScreenshotOptions): Promise<RenderedBytes>
	content(options: RenderOptions): Promise<string>
	pdf(options: PdfOptions): Promise<RenderedBytes>
}

export const waitUntilValues: ReadonlyArray<WaitUntil> = ['load', 'domcontentloaded', 'networkidle0', 'networkidle2']
export const screenshotFormats: ReadonlyArray<ScreenshotFormat> = ['png', 'jpeg', 'webp']
export const pdfFormats = ['A4', 'Letter', 'Legal'] as const

const ipv4Pattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function isPrivateIpv4(host: string) {
	const match = ipv4Pattern.exec(host)
	if (!match) return false
	const [a = 0, b = 0] = match.slice(1).map(Number)
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 100 && b >= 64 && b <= 127) ||
		a >= 224
	)
}

function isPrivateIpv6(host: string) {
	const inner = host.replace(/^\[|\]$/g, '').toLowerCase()
	if (inner === '::1' || inner === '::') return true
	if (inner.startsWith('fe80:') || inner.startsWith('fc') || inner.startsWith('fd')) return true
	// IPv4-mapped: the URL parser normalizes ::ffff:a.b.c.d to ::ffff:hhhh:hhhh.
	const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(inner)
	if (dotted) return isPrivateIpv4(dotted[1] ?? '')
	const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(inner)
	if (hex) {
		const hi = parseInt(hex[1] ?? '0', 16)
		const lo = parseInt(hex[2] ?? '0', 16)
		return isPrivateIpv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`)
	}
	return false
}

/**
 * The rendering browser fetches the target from *its* network position, which
 * for a self-hosted sidecar is inside the compose network next to Kody, MinIO
 * and Qdrant. Refuse loopback / link-local / RFC1918 literals and `localhost`
 * names unless the operator listed the host in KODY_BROWSER_ALLOW_PRIVATE_HOSTS.
 * Names that merely *resolve* to private space cannot be checked here — see
 * docs/browser.md for the network-isolation recommendation.
 */
export function assertRenderableUrl(raw: unknown, config: NonNullable<BrowserConfig>) {
	if (typeof raw !== 'string' || !raw.trim()) throw new KodyError('invalid_args', 'url must be a non-empty string.')
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		throw new KodyError('invalid_args', `"${raw}" is not a valid URL.`)
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new KodyError('invalid_args', 'Only http(s) URLs can be rendered.')
	}
	if (url.username || url.password) {
		throw new KodyError('invalid_args', 'URLs with embedded credentials cannot be rendered.')
	}
	const host = url.hostname.toLowerCase()
	const allowed = config.allowPrivateHosts.some((entry) => hostMatchesApproval(host, entry))
	if (allowed) return url.toString()
	const isPrivate = host.includes(':')
		? isPrivateIpv6(host)
		: host === 'localhost' ||
			host.endsWith('.localhost') ||
			host.endsWith('.internal') ||
			host.endsWith('.local') ||
			!host.includes('.') ||
			isPrivateIpv4(host)
	if (isPrivate) {
		throw new KodyError(
			'browser_private_host',
			`"${host}" is a loopback/private host. Add it to KODY_BROWSER_ALLOW_PRIVATE_HOSTS on the server to render it.`,
			{ status: 403 },
		)
	}
	return url.toString()
}

async function post(
	config: NonNullable<BrowserConfig>,
	url: string,
	body: unknown,
	headers: Record<string, string>,
): Promise<Response> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), config.timeoutMs)
	try {
		return await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...headers },
			body: JSON.stringify(body),
			signal: controller.signal,
		})
	} catch (error) {
		const aborted = error instanceof Error && error.name === 'AbortError'
		throw new KodyError(
			aborted ? 'browser_timeout' : 'browser_unavailable',
			aborted
				? `The browser service did not answer within ${config.timeoutMs}ms.`
				: `The browser service is unreachable: ${(error as Error).message}`,
			{ status: aborted ? 504 : 502 },
		)
	} finally {
		clearTimeout(timer)
	}
}

async function failure(response: Response, action: string): Promise<never> {
	const text = (await response.text()).slice(0, 600)
	let message = text
	try {
		const parsed = JSON.parse(text) as { errors?: Array<{ message?: string }>; message?: string }
		message = parsed.errors?.map((e) => e.message).join('; ') || parsed.message || text
	} catch {
		// keep raw text
	}
	throw new KodyError('browser_render_failed', `${action} failed (HTTP ${response.status}): ${message}`, {
		status: 502,
		details: { httpStatus: response.status },
	})
}

function target(options: PageTarget) {
	return 'html' in options ? { html: options.html } : { url: options.url }
}

async function bytesOf(response: Response, fallbackType: string): Promise<RenderedBytes> {
	return {
		bytes: new Uint8Array(await response.arrayBuffer()),
		contentType: response.headers.get('content-type')?.split(';')[0]?.trim() || fallbackType,
	}
}

/** browserless v2 REST API (`/screenshot`, `/content`, `/pdf`). */
export class BrowserlessRenderer implements BrowserRenderer {
	readonly kind = 'browserless' as const
	private readonly config: NonNullable<BrowserConfig>

	constructor(config: NonNullable<BrowserConfig>) {
		this.config = config
	}

	private endpoint(path: string) {
		const url = new URL(`${this.config.baseUrl}${path}`)
		if (this.config.token) url.searchParams.set('token', this.config.token)
		return url.toString()
	}

	private goto(options: RenderOptions) {
		return { gotoOptions: { waitUntil: options.waitUntil, timeout: options.timeoutMs } }
	}

	async screenshot(options: ScreenshotOptions) {
		const response = await post(
			this.config,
			this.endpoint('/screenshot'),
			{
				...target(options),
				...this.goto(options),
				viewport: { width: options.width, height: options.height },
				...(options.selector ? { selector: options.selector } : {}),
				options: {
					fullPage: options.fullPage,
					type: options.format,
					...(options.format !== 'png' && options.quality !== undefined ? { quality: options.quality } : {}),
				},
			},
			{},
		)
		if (!response.ok) return failure(response, 'Screenshot')
		return bytesOf(response, `image/${options.format}`)
	}

	async content(options: RenderOptions) {
		const response = await post(
			this.config,
			this.endpoint('/content'),
			{ ...target(options), ...this.goto(options) },
			{},
		)
		if (!response.ok) return failure(response, 'Content extraction')
		return response.text()
	}

	async pdf(options: PdfOptions) {
		const response = await post(
			this.config,
			this.endpoint('/pdf'),
			{
				...target(options),
				...this.goto(options),
				options: { format: options.format, landscape: options.landscape, printBackground: options.printBackground },
			},
			{},
		)
		if (!response.ok) return failure(response, 'PDF rendering')
		return bytesOf(response, 'application/pdf')
	}
}

/** Cloudflare Browser Rendering REST API (`/accounts/:id/browser-rendering/*`). */
export class CloudflareRenderer implements BrowserRenderer {
	readonly kind = 'cloudflare' as const
	private readonly config: NonNullable<BrowserConfig>

	constructor(config: NonNullable<BrowserConfig>) {
		this.config = config
	}

	private headers() {
		return { authorization: `Bearer ${this.config.token ?? ''}` }
	}

	private goto(options: RenderOptions) {
		return { gotoOptions: { waitUntil: options.waitUntil, timeout: options.timeoutMs } }
	}

	async screenshot(options: ScreenshotOptions) {
		const response = await post(
			this.config,
			`${this.config.baseUrl}/screenshot`,
			{
				...target(options),
				...this.goto(options),
				viewport: { width: options.width, height: options.height },
				...(options.selector ? { selector: options.selector } : {}),
				screenshotOptions: {
					fullPage: options.fullPage,
					type: options.format,
					...(options.format !== 'png' && options.quality !== undefined ? { quality: options.quality } : {}),
				},
			},
			this.headers(),
		)
		if (!response.ok) return failure(response, 'Screenshot')
		return bytesOf(response, `image/${options.format}`)
	}

	async content(options: RenderOptions) {
		const response = await post(
			this.config,
			`${this.config.baseUrl}/content`,
			{ ...target(options), ...this.goto(options) },
			this.headers(),
		)
		if (!response.ok) return failure(response, 'Content extraction')
		const text = await response.text()
		if (response.headers.get('content-type')?.includes('application/json')) {
			const parsed = JSON.parse(text) as { result?: unknown }
			if (typeof parsed.result === 'string') return parsed.result
		}
		return text
	}

	async pdf(options: PdfOptions) {
		const response = await post(
			this.config,
			`${this.config.baseUrl}/pdf`,
			{
				...target(options),
				...this.goto(options),
				pdfOptions: { format: options.format, landscape: options.landscape, printBackground: options.printBackground },
			},
			this.headers(),
		)
		if (!response.ok) return failure(response, 'PDF rendering')
		return bytesOf(response, 'application/pdf')
	}
}

export function createRenderer(config: BrowserConfig): BrowserRenderer | null {
	if (!config) return null
	return config.provider === 'cloudflare' ? new CloudflareRenderer(config) : new BrowserlessRenderer(config)
}

/** Best-effort visible-text extraction from rendered HTML (no DOM available in the worker). */
export function htmlToText(html: string) {
	return html
		.replace(/<head[\s\S]*?<\/head>/gi, ' ')
		.replace(/<title[\s\S]*?<\/title>/gi, ' ')
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|br|blockquote|pre)>/gi, '\n')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/[ \t\f\v]+/g, ' ')
		.replace(/\s*\n\s*/g, '\n')
		.trim()
}

export function htmlTitle(html: string) {
	const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
	return match ? htmlToText(match[1] ?? '') : null
}
