// Plain pages for the app origin. They never load Kody's shell, scripts, or styles.

function escapeHtml(value: string) {
	return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
}

function page(status: number, title: string, body: string) {
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`,
		{
			status,
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store',
				'x-content-type-options': 'nosniff',
				'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
				'referrer-policy': 'no-referrer',
			},
		},
	)
}

export function openFromKodyPage(publicUrl: string, packageName: string) {
	const href = `${publicUrl}/apps/open?package=${encodeURIComponent(packageName)}`
	return page(
		403,
		'Open this app from Kody',
		`<p>This package app needs a fresh sign-in handoff from Kody.</p><p><a href="${escapeHtml(href)}">Open ${escapeHtml(packageName)} from Kody</a></p>`,
	)
}

export function appNotFoundPage() {
	return page(404, 'No app here', '<p>There is no package app at this address.</p>')
}

export function appErrorPage(status: number, message: string, publicUrl: string) {
	return page(
		status,
		'This app failed',
		`<p>${escapeHtml(message)}</p><p>Details are in your <a href="${escapeHtml(publicUrl)}/account">Kody</a> run history (kind: app).</p>`,
	)
}
