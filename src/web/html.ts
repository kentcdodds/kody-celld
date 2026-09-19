// Server-rendered HTML for the minimal web UI: no client framework, no inline
// scripts (the CSP below forbids them), forms post back to the same route.

export function escapeHtml(value: unknown) {
	return String(value ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;')
}

/** Marks a string as already-escaped markup. */
export class Html {
	readonly value: string
	constructor(value: string) {
		this.value = value
	}
	toString() {
		return this.value
	}
}

export function raw(value: string) {
	return new Html(value)
}

/** Tagged template: interpolations are escaped unless they are `Html` (or arrays of them). */
export function html(strings: TemplateStringsArray, ...values: Array<unknown>) {
	let out = ''
	strings.forEach((chunk, index) => {
		out += chunk
		if (index < values.length) out += render(values[index])
	})
	return new Html(out)
}

function render(value: unknown): string {
	if (value === null || value === undefined || value === false) return ''
	if (value instanceof Html) return value.value
	if (Array.isArray(value)) return value.map(render).join('')
	return escapeHtml(value)
}

const styles = `
:root{color-scheme:light dark;--fg:#1f2328;--muted:#59636e;--bg:#fff;--card:#f6f8fa;--line:#d1d9e0;--accent:#0969da;--danger:#cf222e;--ok:#1a7f37}
@media(prefers-color-scheme:dark){:root{--fg:#e6edf3;--muted:#9198a1;--bg:#0d1117;--card:#161b22;--line:#30363d;--accent:#4493f8;--danger:#f85149;--ok:#3fb950}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--fg);background:var(--bg)}
a{color:var(--accent)}code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
pre{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:10px;overflow:auto;white-space:pre-wrap;word-break:break-all}
header{border-bottom:1px solid var(--line);background:var(--card)}header .bar{max-width:960px;margin:0 auto;padding:10px 20px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
header .brand{font-weight:600;text-decoration:none;color:var(--fg)}header nav{display:flex;gap:12px;flex-wrap:wrap}header nav a{text-decoration:none;color:var(--muted)}header nav a[aria-current]{color:var(--fg);font-weight:600}
header .who{margin-left:auto;color:var(--muted);font-size:13px;display:flex;gap:10px;align-items:center}
main{max-width:960px;margin:0 auto;padding:24px 20px}h1{font-size:22px;margin:0 0 16px}h2{font-size:17px;margin:28px 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px 18px;margin:0 0 16px}
.muted{color:var(--muted)}.small{font-size:13px}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
td form{display:inline}
form.stack{display:grid;gap:10px;max-width:520px}label{display:grid;gap:4px;font-size:13px;color:var(--muted)}
input,textarea,select{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:7px 9px;width:100%}textarea{min-height:100px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
button,.button{font:inherit;font-weight:600;border-radius:6px;border:1px solid var(--line);padding:6px 12px;background:var(--bg);color:var(--fg);cursor:pointer;text-decoration:none;display:inline-block}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.danger{color:var(--danger)}button.small{padding:3px 8px;font-size:13px;font-weight:500}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.flash{border-left:4px solid var(--ok);padding:10px 14px;margin:0 0 16px;background:var(--card);border-radius:6px}.flash.error{border-left-color:var(--danger)}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;background:var(--card);border:1px solid var(--line)}
.badge.ok{color:var(--ok)}.badge.warn{color:var(--danger)}
.secret{user-select:all}
footer{max-width:960px;margin:0 auto;padding:16px 20px 32px;color:var(--muted);font-size:13px}
`

export type NavItem = { href: string; label: string }

export type PageOptions = {
	title: string
	body: Html
	/** Signed-in identity shown top-right, when any. */
	who?: Html | null
	nav?: Array<NavItem>
	current?: string
	flash?: { kind: 'ok' | 'error'; text: string } | null
	status?: number
	headers?: HeadersInit
}

export function page(options: PageOptions) {
	const nav = (options.nav ?? []).map(
		(item) =>
			html`<a href="${item.href}" ${options.current === item.href ? raw('aria-current="page"') : ''}>${item.label}</a>`,
	)
	const flash = options.flash
		? html`<div class="flash ${options.flash.kind === 'error' ? 'error' : ''}">${options.flash.text}</div>`
		: ''
	const document = html`<!doctype html>
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="robots" content="noindex" />
				<title>${options.title} · Kody</title>
				<style>
					${raw(styles)}
				</style>
			</head>
			<body>
				<header>
					<div class="bar">
						<a class="brand" href="/">Kody</a>
						<nav>${nav}</nav>
						<div class="who">${options.who ?? ''}</div>
					</div>
				</header>
				<main>
					<h1>${options.title}</h1>
					${flash} ${options.body}
				</main>
				<footer>kody-celld · self-hosted Kody core</footer>
			</body>
		</html>`
	return new Response(document.value, {
		status: options.status ?? 200,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
			'referrer-policy': 'same-origin',
			'x-content-type-options': 'nosniff',
			'x-frame-options': 'DENY',
			'content-security-policy':
				"default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: https:; form-action 'self' https: http://localhost:* http://127.0.0.1:*; base-uri 'none'; frame-ancestors 'none'",
			...options.headers,
		},
	})
}

export function redirect(location: string, headers: HeadersInit = {}) {
	return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store', ...headers } })
}

/** Reads a form post (urlencoded or multipart) into a flat string map. */
export async function readForm(request: Request): Promise<Record<string, string>> {
	const out: Record<string, string> = {}
	const type = request.headers.get('content-type') ?? ''
	if (!type.includes('application/x-www-form-urlencoded') && !type.includes('multipart/form-data')) return out
	const data = await request.formData()
	for (const [key, value] of data.entries()) if (typeof value === 'string') out[key] = value
	return out
}

export function formatWhen(iso: string | null | undefined) {
	if (!iso) return '—'
	const date = new Date(iso)
	if (Number.isNaN(date.getTime())) return iso
	return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

/** Only `/path` continuations are honored so a sign-in link cannot bounce off-site. */
export function safeNext(value: string | null | undefined, fallback = '/account') {
	if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback
	return value
}
