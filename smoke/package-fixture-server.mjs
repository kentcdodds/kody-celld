// Local HTTP server that serves a deterministic package JSON file-map for the
// web Packages preview and install smokes, plus a small git smart-HTTP repo for
// `.git` install coverage. Avoids live GitHub/codeload/kody.codes fetches
// (CI flakes; this monorepo's tarball can also exceed the product 400-file
// archive ceiling, which is unrelated to the install path under test).
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
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

export const gitPackageName = '@kody-smoke/http-probe-git'

// Fixed identity/dates and no user/system config so the commit SHA is the same
// on every machine (and a global commit.gpgsign can't prompt).
const gitEnv = {
	...process.env,
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_AUTHOR_NAME: 'kody smoke',
	GIT_AUTHOR_EMAIL: 'smoke@kody.invalid',
	GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
	GIT_COMMITTER_NAME: 'kody smoke',
	GIT_COMMITTER_EMAIL: 'smoke@kody.invalid',
	GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
}

/** One-commit repo of the http-probe files, renamed so it doesn't clobber the JSON install. */
async function makeGitRepo(files) {
	const dir = await mkdtemp(path.join(tmpdir(), 'kody-smoke-git-'))
	const git = (...args) => execFileSync('git', ['-C', dir, ...args], { env: gitEnv })
	git('-c', 'init.defaultBranch=main', 'init', '-q')
	for (const [name, content] of Object.entries(files)) {
		const body =
			name === 'package.json'
				? `${JSON.stringify({ ...JSON.parse(content), name: gitPackageName }, null, 2)}\n`
				: content
		await writeFile(path.join(dir, name), body)
	}
	git('add', '.')
	git('commit', '-q', '-m', 'http-probe fixture')
	return { dir, commit: git('rev-parse', 'HEAD').toString().trim() }
}

function pktLine(text) {
	return `${(Buffer.byteLength(text) + 4).toString(16).padStart(4, '0')}${text}`
}

/** `git http-backend`'s two upload-pack routes, without CGI. */
function serveGit(req, res, url, repoDir) {
	if (url.pathname.endsWith('/info/refs') && url.searchParams.get('service') === 'git-upload-pack') {
		const refs = execFileSync('git', ['upload-pack', '--stateless-rpc', '--advertise-refs', repoDir], {
			env: gitEnv,
		})
		res.writeHead(200, {
			'content-type': 'application/x-git-upload-pack-advertisement',
			'cache-control': 'no-cache',
		})
		res.end(Buffer.concat([Buffer.from(`${pktLine('# service=git-upload-pack\n')}0000`), refs]))
		return
	}
	if (url.pathname.endsWith('/git-upload-pack') && req.method === 'POST') {
		const child = spawn('git', ['upload-pack', '--stateless-rpc', repoDir], { env: gitEnv })
		res.writeHead(200, {
			'content-type': 'application/x-git-upload-pack-result',
			'cache-control': 'no-cache',
		})
		req.pipe(child.stdin)
		child.stdout.pipe(res)
		child.on('error', () => res.destroy())
		return
	}
	res.writeHead(404, { 'content-type': 'text/plain' })
	res.end('not found')
}

/**
 * Serves:
 *   GET /http-probe.json  — flat http-probe file map
 *   GET /repo.json        — same files under examples/packages/http-probe/ (for subdir)
 *   /@kody-smoke/http-probe-git.git/… — git smart-HTTP (upload-pack) of the same files
 *
 * Host is SMOKE_ECHO_HOST (host.docker.internal in Docker CI) so the kody
 * container can fetch it; that host must be listed exactly in
 * KODY_PRIVATE_HOSTS (it is private by name).
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
	const repo = await makeGitRepo(flat)
	const gitPath = `/${gitPackageName}.git`
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', `http://${host}`)
		if (url.pathname.startsWith(`${gitPath}/`)) {
			serveGit(req, res, url, repo.dir)
			return
		}
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
		gitUrl: `${base}${gitPath}`,
		gitCommit: repo.commit,
		close: async () => {
			await new Promise((resolve) => server.close(resolve))
			await rm(repo.dir, { recursive: true, force: true })
		},
	}
}
