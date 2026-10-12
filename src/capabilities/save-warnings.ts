/** Keep the warnings `packageSave` produced and append any from the fetch step. */
export function mergeSaveWarnings(saved: { warnings?: Array<string> }, extra: Array<string>): Array<string> {
	return [...(saved.warnings ?? []), ...extra]
}
