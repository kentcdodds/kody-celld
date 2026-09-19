import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { escapeHtml, html, page, raw, safeNext } from './html.ts'

describe('html templating', () => {
	it('escapes interpolations, keeps raw() and nested templates, and skips null/false', () => {
		const out = html`<p>${'<script>alert("x")</script>'}${raw('<b>ok</b>')}${html`<i>${"it's"}</i>`}${null}${false}</p>`
		assert.equal(out.toString(), '<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;<b>ok</b><i>it&#39;s</i></p>')
		assert.equal(escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;')
		assert.equal(escapeHtml(5), '5')
	})

	it('pages carry the hardening headers', async () => {
		const response = page({ title: 'T', body: html`<p>${'<x>'}</p>` })
		assert.equal(response.status, 200)
		assert.match(response.headers.get('content-type') ?? '', /text\/html/)
		assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'.*frame-ancestors 'none'/)
		assert.equal(response.headers.get('x-frame-options'), 'DENY')
		assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
		assert.equal(response.headers.get('cache-control'), 'no-store')
		assert.equal(response.headers.get('referrer-policy'), 'same-origin')
		const text = await response.text()
		assert.ok(text.includes('&lt;x&gt;') && !text.includes('<x>'))
		assert.equal(page({ title: 'T', body: html``, status: 404 }).status, 404)
	})
})

describe('safeNext', () => {
	it('only allows same-origin relative paths', () => {
		assert.equal(safeNext('/account/tokens?x=1'), '/account/tokens?x=1')
		assert.equal(safeNext('/oauth/authorize?client_id=x'), '/oauth/authorize?client_id=x')
		assert.equal(safeNext(null), '/account')
		assert.equal(safeNext(''), '/account')
		assert.equal(safeNext('https://evil.example'), '/account')
		assert.equal(safeNext('//evil.example/x'), '/account')
		assert.equal(safeNext('/\\evil.example'), '/account')
		assert.equal(safeNext('account'), '/account')
		assert.equal(safeNext('javascript:alert(1)', '/console'), '/console')
	})
})
