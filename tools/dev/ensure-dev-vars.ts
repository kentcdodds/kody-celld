// Ensures `.dev.vars` exists for local `celld dev` / smoke. Copies the committed
// `.dev.vars.example` when missing so loopback smoke defaults never need to live
// in wrangler.jsonc (which single-node Docker would inherit).
import { copyFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const target = path.join(root, '.dev.vars')
const example = path.join(root, '.dev.vars.example')

if (!existsSync(target)) {
	if (!existsSync(example)) {
		console.error(`[kody-celld] missing ${path.relative(root, example)}; cannot seed .dev.vars`)
		process.exit(1)
	}
	copyFileSync(example, target)
	console.error('[kody-celld] wrote .dev.vars from .dev.vars.example (loopback smoke defaults)')
}
