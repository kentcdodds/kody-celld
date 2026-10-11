import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { provisionGuide } from './provision-guide.ts'

const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url).href)
const capabilitySource = readdirSync(here('../capabilities/'))
	.filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
	.map((f) => readFileSync(here(`../capabilities/${f}`), 'utf8'))
	.join('\n')
const runtimeModule = readFileSync(here('../execute/runtime-module.ts'), 'utf8')
const text = `${provisionGuide.title}\n${provisionGuide.summary}\n${String(provisionGuide.detail.text)}`

describe('guide:provision', () => {
	it('does not name removed adapters', () => {
		assert.doesNotMatch(text, /anthropic/i)
	})

	it('does not list shipped features as missing', () => {
		const match = /not (?:yet )?in this build:[^\n]*/i.exec(text)
		assert.ok(match, 'guide must keep a "Not yet in this build:" line so this pin fails loudly')
		const missing = match[0]
		for (const shipped of [/email inbox/i, /oauth integrations/i, /blob/i, /browser/i, /web ui/i]) {
			assert.doesNotMatch(missing, shipped, `${shipped} ships in this build`)
		}
	})

	it('names only capabilities that exist', () => {
		const named = [...text.matchAll(/kody\.([a-z][A-Za-z]+)\(/g)].map((m) => m[1]!)
		for (const name of named) assert.ok(capabilitySource.includes(`name: '${name}'`), `kody.${name} exists`)
	})

	it('calls only those kody:runtime exports null that really are null', () => {
		assert.doesNotMatch(text, /throw or are null/i, 'name the null exports exactly')
		const nullExports = [...runtimeModule.matchAll(/export const (\w+) = null/g)].map((m) => m[1]!)
		const sentence = /runtime exports? ((?:`\w+`(?:, | and )?)+) (?:are|is) null/i.exec(text)
		assert.ok(sentence, 'guide must name the null runtime exports so this pin fails loudly')
		const claimed = [...sentence[1]!.matchAll(/`(\w+)`/g)].map((m) => m[1]!)
		assert.ok(claimed.length > 0, 'guide must name at least one null runtime export')
		for (const name of claimed) assert.ok(nullExports.includes(name), `${name} is null in runtime-module.ts`)
	})
})
