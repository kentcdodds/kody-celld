/**
 * Corpus-agnostic ranking primitives shared by capability search and memory
 * search. Mirrors the shape of kentcdodds/kody `worker/src/vectorize/scoring.ts`
 * (RRF fusion of a lexical list and a vector list).
 */

export const rrfK = 60

export function cosineSimilarity(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
	if (a.length !== b.length || a.length === 0) return 0
	let dot = 0
	let na = 0
	let nb = 0
	for (let i = 0; i < a.length; i += 1) {
		const x = a[i]!
		const y = b[i]!
		dot += x * y
		na += x * x
		nb += y * y
	}
	if (na === 0 || nb === 0) return 0
	return dot / Math.sqrt(na * nb)
}

export function reciprocalRankFusion(rankedLists: Array<ReadonlyArray<string>>, k = rrfK): Map<string, number> {
	const scores = new Map<string, number>()
	for (const list of rankedLists) {
		list.forEach((id, rank) => {
			scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1))
		})
	}
	return scores
}

export function sortIdsByScore(ids: ReadonlyArray<string>, scoreOf: (id: string) => number): Array<string> {
	return [...ids]
		.map((id) => ({ id, score: scoreOf(id) }))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
		.map((entry) => entry.id)
}

export function float32Bytes(vector: ReadonlyArray<number>): Uint8Array {
	return new Uint8Array(Float32Array.from(vector).buffer)
}

export function vectorFromBytes(bytes: ArrayBuffer | Uint8Array): Array<number> {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
	const aligned = view.byteOffset % 4 === 0 ? view : Uint8Array.from(view)
	return Array.from(new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4))
}
