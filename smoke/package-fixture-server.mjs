// Local HTTP server that serves a deterministic package JSON file-map for the
// web Packages preview and install smokes. Avoids live GitHub/codeload fetches
// (CI flakes; this monorepo's tarball can also exceed the product 400-file
// archive ceiling, which is unrelated to the install path under test).
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../examples/packages/http-probe')

async function httpProbeFiles() {
	const names = ['package.json', 'README.md', 'AGENTS.md', 'probe.js', 'provider-probe.js']
	const files = {}
	for (const name of names) {
		files[name] = await readFile(path.join(examples, name), 'utf8')
	}
	return files
}

/**
 * Serves:
 *   GET /http-probe.json  — flat http-probe file map
 *   GET /repo.json        — same files under examples/packages/http-probe/ (for subdir)
 *
 * Host is SMOKE_ECHO_HOST (host.docker.internal in Docker CI) so the kody
 * container can fetch it; that host must be listed exactly in
 * KODY_PACKAGE_SOURCE_HOSTS (it is private by name).
 */
export async function startPackageFixtureServer(port = Number(process.env.SMOKE_PACKAGE_FIXTURE_PORT ?? 9798)) {
	const host = process.env.SMOKE_ECHO_HOST ?? '127.0.0.1'
	const bind = process.env.SMOKE_ECHO_BIND ?? (host === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0')
	const flat = await httpProbeFiles()
	const nested = Object.fromEntries(
		Object.entries(flat).map(([name, content]) => [`examples/packages/http-probe/${name}`, content]),
	)
	const bodies = {
		'/http-probe.json': JSON.stringify(flat),
		'/repo.json': JSON.stringify(nested),
	}
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', `http://${host}`)
		const body = bodies[url.pathname]
		if (!body) {
			res.writeHead(404, { 'content-type': 'text/plain' })
			res.end('not found')
			return
		}
		res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
		res.end(body)
	})
	await new Promise((resolve) => server.listen(port, bind, resolve))
	const base = `http://${host}:${port}`
	return {
		host,
		flatUrl: `${base}/http-probe.json`,
		repoUrl: `${base}/repo.json`,
		subdir: 'examples/packages/http-probe',
		close: () => new Promise((resolve) => server.close(resolve)),
	}
}
