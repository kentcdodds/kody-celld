import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { browserConfigFromEnv, describeBrowserConfig } from './config.ts'
import { assertRenderableUrl, htmlTitle, htmlToText } from './providers.ts'

const browserless = browserConfigFromEnv({
	KODY_BROWSER_PROVIDER: 'browserless',
	KODY_BROWSER_URL: 'http://browserless:3000/',
})

describe('browser config', () => {
	it('is off by default and validates each provider', () => {
		assert.equal(browserConfigFromEnv({}), null)
		assert.deepEqual(describeBrowserConfig(null), { provider: 'none', configured: false })
		assert.equal(browserless?.baseUrl, 'http://browserless:3000')
		assert.equal(browserless?.token, null)
		assert.throws(
			() => browserConfigFromEnv({ KODY_BROWSER_PROVIDER: 'puppeteer' }),
			/expected none, browserless or cloudflare/,
		)
		assert.throws(() => browserConfigFromEnv({ KODY_BROWSER_PROVIDER: 'browserless' }), /KODY_BROWSER_URL is required/)
		assert.throws(
			() => browserConfigFromEnv({ KODY_BROWSER_PROVIDER: 'cloudflare', KODY_BROWSER_CF_ACCOUNT_ID: 'acc' }),
			/KODY_BROWSER_TOKEN/,
		)
		assert.throws(
			() =>
				browserConfigFromEnv({
					KODY_BROWSER_PROVIDER: 'browserless',
					KODY_BROWSER_URL: 'http://x',
					KODY_BROWSER_TIMEOUT_MS: '10',
				}),
			/between 1000 and 300000/,
		)
	})

	it('describes the cloudflare provider without the token', () => {
		const config = browserConfigFromEnv({
			KODY_BROWSER_PROVIDER: 'cloudflare',
			KODY_BROWSER_CF_ACCOUNT_ID: 'acc/1',
			KODY_BROWSER_TOKEN: 'unit-test-token-not-real',
			KODY_BROWSER_ALLOW_PRIVATE_HOSTS: 'Dash.Home.LAN, *.lab.internal',
		})
		assert.equal(config?.baseUrl, 'https://api.cloudflare.com/client/v4/accounts/acc%2F1/browser-rendering')
		assert.deepEqual(config?.allowPrivateHosts, ['dash.home.lan', '*.lab.internal'])
		const described = JSON.stringify(describeBrowserConfig(config))
		assert.doesNotMatch(described, /unit-test-token-not-real/)
		assert.match(described, /"hasToken":true/)
	})
})

describe('assertRenderableUrl', () => {
	const config = browserless!

	it('accepts public http(s) URLs only', () => {
		assert.equal(assertRenderableUrl('https://example.com/page?q=1', config), 'https://example.com/page?q=1')
		assert.equal(assertRenderableUrl('http://[2001:db8::1]/', config), 'http://[2001:db8::1]/')
		assert.throws(() => assertRenderableUrl('ftp://example.com', config), /Only http\(s\)/)
		assert.throws(() => assertRenderableUrl('file:///etc/hosts', config), /Only http\(s\)/)
		assert.throws(() => assertRenderableUrl('https://user:pw@example.com', config), /embedded credentials/)
		assert.throws(() => assertRenderableUrl('nope', config), /not a valid URL/)
		assert.throws(() => assertRenderableUrl('', config), /non-empty/)
	})

	it('refuses loopback, private and single-label hosts unless allowlisted', () => {
		for (const url of [
			'http://localhost:8787/',
			'http://kody.localhost/',
			'http://127.0.0.1/',
			'http://10.1.2.3/',
			'http://172.16.0.1/',
			'http://192.168.1.1/',
			'http://169.254.169.254/latest/meta-data',
			'http://100.64.0.1/',
			'http://0.0.0.0/',
			'http://[::1]/',
			'http://[fe80::1]/',
			'http://[fd00::1]/',
			'http://[::ffff:10.0.0.1]/',
			'http://minio:9000/',
			'http://qdrant.internal/',
			'http://nas.local/',
		]) {
			assert.throws(() => assertRenderableUrl(url, config), /browser_private_host/, url)
		}
		const allowing = { ...config, allowPrivateHosts: ['localhost', '*.home.lan', '192.168.1.10'] }
		assert.equal(assertRenderableUrl('http://localhost:8787/x', allowing), 'http://localhost:8787/x')
		assert.equal(assertRenderableUrl('http://dash.home.lan/', allowing), 'http://dash.home.lan/')
		assert.equal(assertRenderableUrl('http://192.168.1.10/', allowing), 'http://192.168.1.10/')
		assert.throws(() => assertRenderableUrl('http://192.168.1.11/', allowing), /browser_private_host/)
	})
})

describe('html helpers', () => {
	it('extracts title and visible text', () => {
		const html = `<html><head><title> Hello &amp; welcome </title><style>p{}</style></head>
<body><script>var x = 1</script><h1>Kody</h1><p>Self-hosted<br>core</p><!-- hidden --><div>&nbsp;ok</div></body></html>`
		assert.equal(htmlTitle(html), 'Hello & welcome')
		assert.equal(htmlToText(html), 'Kody\nSelf-hosted\ncore\nok')
		assert.equal(htmlTitle('<p>no title</p>'), null)
	})
})
