// M4 browser rendering smoke. Skips (with a hint) when no provider is
// configured; otherwise proves: rendered HTML/text (JavaScript executed),
// screenshot bytes that come back as a protocol-valid MCP image block through
// `execute`, PDF -> blob + signed link, SSRF refusal, and that no token leaks.
//
// The browser fetches from its own network position. By default everything is
// rendered from inline HTML (no network needed). Set SMOKE_BROWSER_TARGET_HOST
// to the name the browser can use to reach this process (host.docker.internal
// for the compose.browser.yaml sidecar) to also exercise URL navigation; that
// host must be in KODY_BROWSER_ALLOW_PRIVATE_HOSTS on the server.
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { adminToken, assert, baseUrl, log, sha256 } from './lib.mjs'

const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function page(marker) {
	return `<!doctype html><html><head><title>Smoke ${marker}</title>
<style>body{font:20px sans-serif;background:#fff}#js{color:#0a0}</style></head>
<body><h1>kody-celld browser smoke</h1><p id="js">javascript did not run</p>
<script>document.getElementById('js').textContent = 'rendered:${marker}'</script></body></html>`
}

export async function smokeBrowser({ mcp, token }) {
	const adminRes = await fetch(`${baseUrl}/admin/browser`, { headers: { authorization: `Bearer ${adminToken}` } })
	const adminBody = await adminRes.json()
	assert(adminRes.status === 200, 'GET /admin/browser failed', adminBody)
	const { browser } = adminBody
	const status = await mcp.call('browserStatus')
	assert(status.provider === browser.provider, 'browserStatus should match admin view', { status, browser })
	assert(
		!JSON.stringify({ status, browser }).includes(process.env.KODY_BROWSER_TOKEN || '\u0000'),
		'BROWSER TOKEN LEAKED',
	)
	if (browser.provider === 'none') {
		log('skipped', 'no browser provider (start compose.browser.yaml or set KODY_BROWSER_PROVIDER/KODY_BROWSER_URL)')
		return
	}
	log('provider', browser)

	const found = await mcp.search({ entity: 'capability', domain: 'browser' })
	const ids = new Set(found.results.map((hit) => hit.id))
	for (const expected of ['browserContent', 'browserScreenshot', 'browserPdf']) {
		assert(ids.has(expected), `search should surface ${expected}`, [...ids])
	}

	// 1. rendered content from inline HTML: the script must have run
	const marker = randomBytes(6).toString('hex')
	const content = await mcp.call('browserContent', { html: page(marker), includeHtml: true })
	assert(content.title === `Smoke ${marker}`, 'title mismatch', content)
	assert(content.text.includes(`rendered:${marker}`), 'JavaScript did not execute in the browser', content.text)
	assert(!content.text.includes('javascript did not run'), 'stale text returned', content.text)
	assert(content.html.includes(`rendered:${marker}`), 'rendered html should reflect the DOM, not the source', {
		htmlLength: content.htmlLength,
	})
	log('browserContent', { provider: content.provider, title: content.title, textLength: content.textLength })

	// 2. screenshot through execute: the image comes back as an MCP image block
	const shot = await mcp.tool('execute', {
		code: `import { kody } from 'kody:runtime'
export default async function main({ html }) {
  const shot = await kody.browserScreenshot({ html, width: 640, height: 400 })
  return { __mcpContent: shot.__mcpContent, bytes: shot.bytes, width: shot.width, height: shot.height, contentType: shot.contentType }
}`,
		params: { html: page(marker) },
	})
	assert(!shot.isError, 'screenshot run failed', shot.payload)
	assert(shot.payload.ok, 'screenshot execute failed', shot.payload.error)
	const image = shot.content.find((block) => block.type === 'image')
	assert(
		image,
		'execute result should include an MCP image block',
		shot.content.map((b) => b.type),
	)
	assert(image.mimeType === 'image/png', 'screenshot should be a PNG', image.mimeType)
	const imageBytes = Buffer.from(image.data, 'base64')
	assert(imageBytes.subarray(0, 8).equals(pngMagic), 'image block is not a PNG')
	assert(imageBytes.length === shot.payload.result.bytes, 'image block size should match the capability result', {
		block: imageBytes.length,
		result: shot.payload.result.bytes,
	})
	assert(
		shot.content.some((block) => block.type === 'text'),
		'structured text block should accompany media',
	)
	assert(
		!JSON.stringify(shot.payload).includes(image.data),
		'structuredContent must not duplicate the raw base64 image',
	)
	log('browserScreenshot', { bytes: imageBytes.length, blocks: shot.content.map((b) => b.type) })

	// 3. PDF stored as a blob with a signed link
	const pdf = await mcp.call('browserPdf', { html: page(marker), saveAs: 'smoke/browser/page.pdf' })
	assert(pdf.blob?.contentType === 'application/pdf' && pdf.blob.size === pdf.bytes, 'pdf blob mismatch', pdf)
	assert(pdf.url?.startsWith(`${baseUrl}/blobs/`), 'pdf should come with a signed link', pdf)
	const download = await fetch(pdf.url)
	assert(download.status === 200, 'pdf signed link failed', download.status)
	const pdfBytes = Buffer.from(await download.arrayBuffer())
	assert(pdfBytes.subarray(0, 5).toString() === '%PDF-', 'downloaded file is not a PDF')
	assert(sha256(pdfBytes) === pdf.blob.sha256, 'pdf digest mismatch')
	await mcp.call('blobDelete', { key: 'smoke/browser/page.pdf' })
	log('browserPdf', { bytes: pdf.bytes, blob: pdf.blob.key })

	// 4. SSRF guard: cloud metadata / loopback literals are refused before any request
	for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://[::1]:9000/', 'http://10.0.0.1/']) {
		const refused = await mcp.execute(
			`import { kody } from 'kody:runtime'
export default async function main({ url }) { return await kody.browserContent({ url }) }`,
			{ url },
		)
		assert(
			!refused.ok && /browser_private_host/.test(refused.error?.message ?? ''),
			`should refuse ${url}`,
			refused.error,
		)
	}
	const badScheme = await mcp.execute(
		`import { kody } from 'kody:runtime'
export default async function main() { return await kody.browserContent({ url: 'file:///etc/hostname' }) }`,
	)
	assert(
		!badScheme.ok && /invalid_args/.test(badScheme.error?.message ?? ''),
		'file: URLs must be refused',
		badScheme.error,
	)
	log('ssrf guard', 'metadata/loopback/private literals and file: refused')

	// 5. optional: navigate to a URL served by this process
	const targetHost = process.env.SMOKE_BROWSER_TARGET_HOST
	if (!targetHost) {
		log('url navigation', 'skipped (set SMOKE_BROWSER_TARGET_HOST, e.g. host.docker.internal, to verify)')
		void token
		return
	}
	const port = Number(process.env.SMOKE_BROWSER_TARGET_PORT ?? 9798)
	const hits = []
	const server = createServer((req, res) => {
		hits.push(req.url)
		res.setHeader('content-type', 'text/html; charset=utf-8')
		res.end(page(`url-${marker}`))
	})
	await new Promise((resolve) => server.listen(port, '0.0.0.0', resolve))
	try {
		const url = `http://${targetHost}:${port}/smoke`
		const navigated = await mcp.call('browserContent', { url })
		assert(
			navigated.url === url && navigated.text.includes(`rendered:url-${marker}`),
			'url navigation failed',
			navigated,
		)
		assert(hits.includes('/smoke'), 'browser never requested the page', hits)
		log('url navigation', { url, hits: hits.length })
	} finally {
		await new Promise((resolve) => server.close(resolve))
	}
}
