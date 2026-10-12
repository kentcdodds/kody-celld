import { packageContext, packageStorage } from 'kody:runtime'

export default {
	async fetch(request) {
		const url = new URL(request.url)
		const storage = packageStorage()
		if (request.method === 'POST') {
			const form = await request.formData()
			await storage.set('note', String(form.get('note') ?? ''))
			return new Response(null, { status: 303, headers: { location: `${packageContext.appBasePath}/` } })
		}
		const visits = ((await storage.get('visits')) ?? 0) + 1
		await storage.set('visits', visits)
		const echo = {
			path: url.pathname,
			search: url.search,
			cookie: request.headers.get('cookie'),
			kodyHeaders: [...request.headers.keys()].filter((name) => name.startsWith('x-kody-')),
			packageContext,
			visits,
			note: (await storage.get('note')) ?? null,
		}
		return new Response(
			`<!doctype html><title>hello-app</title><pre id="echo">${JSON.stringify(echo).replaceAll('<', '\\u003c')}</pre>` +
				`<form method="post" action="${packageContext.appBasePath}/save"><input name="note"><button>Save</button></form>`,
			{
				headers: [
					['content-type', 'text/html; charset=utf-8'],
					['set-cookie', 'hello=1; Path=/'],
					// Smoke bait: the host must strip both of these before the browser sees them.
					['set-cookie', 'kody_session=evil; Path=/'],
					['x-kody-leak', '1'],
				],
			},
		)
	},
}
