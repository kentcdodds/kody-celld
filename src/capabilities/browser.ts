import { BlobService, encodeBase64 } from '../blobs/service.ts'
import { browserConfigFromEnv, describeBrowserConfig, type BrowserConfig } from '../browser/config.ts'
import {
	assertRenderableUrl,
	createRenderer,
	htmlTitle,
	htmlToText,
	pdfFormats,
	screenshotFormats,
	waitUntilValues,
	type PageTarget,
	type RenderOptions,
	type ScreenshotFormat,
	type WaitUntil,
} from '../browser/providers.ts'
import { KodyError } from '../lib/errors.ts'
import { limitsFromEnv } from '../lib/limits.ts'
import { mcpContentKey } from '../mcp/content.ts'
import { defineCapability, defineDomain, type CapabilityContext, type JsonSchema } from './define.ts'

export const browserDomain = defineDomain({
	name: 'browser',
	description:
		'Headless-browser rendering through a configurable service: a self-hosted browserless container (compose.browser.yaml) or Cloudflare Browser Rendering. Extract rendered HTML/text, take screenshots, or print PDFs of a URL or of HTML you supply.',
	guide:
		'browserContent returns rendered HTML plus extracted text. browserScreenshot / browserPdf return the bytes base64-encoded and can also store them as a blob (`saveAs`) so you get a signed download `url` instead of a large payload. When called from execute, return `{ __mcpContent: [...] }` from browserScreenshot to show the image inline. Private/loopback hosts are refused unless the operator lists them in KODY_BROWSER_ALLOW_PRIVATE_HOSTS.',
})

const maxHtmlLength = 2_000_000
const maxTextReturn = 200_000

function configured(ctx: CapabilityContext): NonNullable<BrowserConfig> {
	const config = browserConfigFromEnv(ctx.env)
	if (!config) {
		throw new KodyError(
			'browser_not_configured',
			'No browser rendering service is configured. Set KODY_BROWSER_PROVIDER=browserless with KODY_BROWSER_URL (see compose.browser.yaml) or KODY_BROWSER_PROVIDER=cloudflare.',
			{ status: 501 },
		)
	}
	return config
}

type CommonArgs = { url?: string; html?: string; waitUntil?: WaitUntil; timeoutMs?: number }

function renderOptions(args: CommonArgs, config: NonNullable<BrowserConfig>): RenderOptions {
	let target: PageTarget
	if (typeof args.html === 'string') {
		if (args.url !== undefined) throw new KodyError('invalid_args', 'Pass either url or html, not both.')
		if (args.html.length > maxHtmlLength) {
			throw new KodyError('invalid_args', `html must be at most ${maxHtmlLength} characters.`)
		}
		target = { html: args.html }
	} else {
		if (args.url === undefined) throw new KodyError('invalid_args', 'Either url or html is required.')
		target = { url: assertRenderableUrl(args.url, config) }
	}
	const waitUntil = args.waitUntil ?? 'networkidle2'
	if (!waitUntilValues.includes(waitUntil)) {
		throw new KodyError('invalid_args', `waitUntil must be one of ${waitUntilValues.join(', ')}.`)
	}
	const timeoutMs = Math.min(
		Math.max(args.timeoutMs ?? Math.min(config.timeoutMs - 1_000, 20_000), 1_000),
		config.timeoutMs,
	)
	return { ...target, waitUntil, timeoutMs }
}

async function maybeSave(ctx: CapabilityContext, saveAs: string | undefined, bytes: Uint8Array, contentType: string) {
	if (!saveAs) return null
	const blobs = new BlobService({
		env: ctx.env,
		userCell: ctx.userCell,
		userId: ctx.user.id,
		packageName: ctx.packageName,
		baseUrl: ctx.baseUrl,
	})
	const record = await blobs.put({ key: saveAs, body: bytes, contentType })
	const link = await blobs.url({ key: saveAs })
	return { blob: record, url: link.url, urlExpiresAt: link.expiresAt }
}

const commonProperties: Record<string, JsonSchema> = {
	url: { type: 'string', description: 'Public http(s) URL to render.' },
	html: { type: 'string', description: 'Render this HTML instead of fetching a URL.' },
	waitUntil: { type: 'string', enum: [...waitUntilValues], default: 'networkidle2' },
	timeoutMs: { type: 'integer', description: 'Navigation timeout inside the browser.' },
}

export const browserContent = defineCapability<CommonArgs & { includeHtml?: boolean; maxTextLength?: number }>({
	domain: 'browser',
	name: 'browserContent',
	description:
		'Load a page in a real browser (JavaScript executed) and return the rendered HTML, its title, and extracted visible text.',
	tags: ['browser', 'read', 'scrape'],
	keywords: ['scrape page', 'rendered html', 'javascript page', 'page text', 'headless chrome', 'fetch spa'],
	inputSchema: {
		type: 'object',
		properties: {
			...commonProperties,
			includeHtml: { type: 'boolean', default: false },
			maxTextLength: { type: 'integer', default: 50_000 },
		},
	},
	readOnly: true,
	example: `import { kody } from 'kody:runtime'
export default async function main({ url }) {
  const page = await kody.browserContent({ url })
  return { title: page.title, text: page.text.slice(0, 2000) }
}`,
	async handler(args, ctx) {
		const config = configured(ctx)
		const renderer = createRenderer(config)!
		const options = renderOptions(args, config)
		const html = await renderer.content(options)
		const text = htmlToText(html)
		const cap = Math.min(Math.max(args.maxTextLength ?? 50_000, 100), maxTextReturn)
		return {
			provider: renderer.kind,
			url: 'url' in options ? options.url : null,
			title: htmlTitle(html),
			text: text.length > cap ? text.slice(0, cap) : text,
			textTruncated: text.length > cap,
			textLength: text.length,
			htmlLength: html.length,
			...(args.includeHtml ? { html: html.length > cap * 4 ? html.slice(0, cap * 4) : html } : {}),
		}
	},
})

export const browserScreenshot = defineCapability<
	CommonArgs & {
		fullPage?: boolean
		format?: ScreenshotFormat
		quality?: number
		width?: number
		height?: number
		selector?: string
		saveAs?: string
		inline?: boolean
	}
>({
	domain: 'browser',
	name: 'browserScreenshot',
	description:
		'Screenshot a URL or HTML. Returns base64 image data (and an `__mcpContent` image block so execute can show it inline) or stores it as a blob when `saveAs` is set.',
	tags: ['browser', 'read', 'image'],
	keywords: ['screenshot', 'capture page', 'render image', 'png of website', 'visual snapshot'],
	inputSchema: {
		type: 'object',
		properties: {
			...commonProperties,
			fullPage: { type: 'boolean', default: false },
			format: { type: 'string', enum: [...screenshotFormats], default: 'png' },
			quality: { type: 'integer', description: '0-100, jpeg/webp only.' },
			width: { type: 'integer', default: 1280 },
			height: { type: 'integer', default: 800 },
			selector: { type: 'string', description: 'CSS selector to clip the screenshot to one element.' },
			saveAs: {
				type: 'string',
				description: 'Blob key to store the image under; the response then carries `blob` and a signed download `url`.',
			},
			inline: {
				type: 'boolean',
				default: true,
				description:
					'Include base64 `data` and an `__mcpContent` image block (set false with saveAs to keep responses small).',
			},
		},
	},
	readOnly: true,
	example: `import { kody } from 'kody:runtime'
export default async function main({ url }) {
  const shot = await kody.browserScreenshot({ url, fullPage: true })
  return { __mcpContent: shot.__mcpContent, width: shot.width, height: shot.height }
}`,
	async handler(args, ctx) {
		const config = configured(ctx)
		const renderer = createRenderer(config)!
		const format = args.format ?? 'png'
		if (!screenshotFormats.includes(format)) {
			throw new KodyError('invalid_args', `format must be one of ${screenshotFormats.join(', ')}.`)
		}
		const width = Math.min(Math.max(args.width ?? 1280, 200), 4096)
		const height = Math.min(Math.max(args.height ?? 800, 200), 4096)
		const quality = args.quality === undefined ? undefined : Math.min(Math.max(Math.floor(args.quality), 0), 100)
		const rendered = await renderer.screenshot({
			...renderOptions(args, config),
			fullPage: args.fullPage ?? false,
			format,
			quality,
			width,
			height,
			selector: args.selector,
		})
		const saved = await maybeSave(ctx, args.saveAs, rendered.bytes, rendered.contentType)
		const inline = args.inline ?? true
		const limit = limitsFromEnv(ctx.env).mcpContentLimitBytes
		const base64 = inline ? encodeBase64(rendered.bytes) : null
		return {
			provider: renderer.kind,
			contentType: rendered.contentType,
			bytes: rendered.bytes.byteLength,
			width,
			height,
			fullPage: args.fullPage ?? false,
			...(saved ?? {}),
			...(base64 !== null ? { data: base64 } : {}),
			...(base64 !== null && base64.length + 200 <= limit
				? { [mcpContentKey]: [{ type: 'image', data: base64, mimeType: rendered.contentType }] }
				: {}),
		}
	},
})

export const browserPdf = defineCapability<
	CommonArgs & {
		format?: (typeof pdfFormats)[number]
		landscape?: boolean
		printBackground?: boolean
		saveAs?: string
		inline?: boolean
	}
>({
	domain: 'browser',
	name: 'browserPdf',
	description: 'Print a URL or HTML to PDF. Store it as a blob with `saveAs` (recommended) or receive base64 inline.',
	tags: ['browser', 'read', 'pdf'],
	keywords: ['pdf', 'print page', 'html to pdf', 'export pdf', 'invoice pdf'],
	inputSchema: {
		type: 'object',
		properties: {
			...commonProperties,
			format: { type: 'string', enum: [...pdfFormats], default: 'A4' },
			landscape: { type: 'boolean', default: false },
			printBackground: { type: 'boolean', default: true },
			saveAs: {
				type: 'string',
				description: 'Blob key to store the PDF under; the response then carries `blob` and a signed download `url`.',
			},
			inline: { type: 'boolean', default: false, description: 'Include base64 `data` in the response.' },
		},
	},
	readOnly: true,
	async handler(args, ctx) {
		const config = configured(ctx)
		const renderer = createRenderer(config)!
		const format = args.format ?? 'A4'
		if (!pdfFormats.includes(format)) {
			throw new KodyError('invalid_args', `format must be one of ${pdfFormats.join(', ')}.`)
		}
		const rendered = await renderer.pdf({
			...renderOptions(args, config),
			format,
			landscape: args.landscape ?? false,
			printBackground: args.printBackground ?? true,
		})
		const saved = await maybeSave(ctx, args.saveAs, rendered.bytes, 'application/pdf')
		if (!saved && !args.inline) {
			throw new KodyError(
				'invalid_args',
				'Set saveAs (store as blob) or inline: true (base64 in response) for browserPdf.',
			)
		}
		return {
			provider: renderer.kind,
			contentType: 'application/pdf',
			bytes: rendered.bytes.byteLength,
			...(saved ?? {}),
			...(args.inline ? { data: encodeBase64(rendered.bytes) } : {}),
		}
	},
})

export const browserStatus = defineCapability<Record<string, never>>({
	domain: 'browser',
	name: 'browserStatus',
	description: 'Report which browser rendering provider is configured (no tokens).',
	tags: ['browser', 'read', 'status'],
	keywords: ['browser configured', 'browserless status', 'rendering provider'],
	inputSchema: { type: 'object', properties: {} },
	readOnly: true,
	async handler(_args, ctx) {
		return describeBrowserConfig(browserConfigFromEnv(ctx.env))
	},
})

export const browserCapabilities = [browserContent, browserScreenshot, browserPdf, browserStatus]
