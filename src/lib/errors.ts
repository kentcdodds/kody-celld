// Errors cross Durable Object / WorkerEntrypoint RPC boundaries, which only
// preserve `name` and `message`. The code and status are therefore encoded in
// `name` so they survive the hop and can be revived on the other side.
const namePrefix = 'KodyError:'

export class KodyError extends Error {
	readonly status: number
	readonly code: string
	readonly details: Record<string, unknown> | undefined

	constructor(code: string, message: string, options: { status?: number; details?: Record<string, unknown> } = {}) {
		super(message)
		this.code = code
		this.status = options.status ?? 400
		this.details = options.details
		this.name = `${namePrefix}${code}:${this.status}`
	}

	toJSON() {
		return {
			error: this.code,
			message: this.message,
			...(this.details ? { details: this.details } : {}),
		}
	}

	/** Revives a KodyError that was serialized over RPC (name + message only). */
	static fromUnknown(error: unknown): KodyError | null {
		if (error instanceof KodyError) return error
		if (error instanceof Error && error.name.startsWith(namePrefix)) {
			const [, code = 'internal_error', status = '500'] = error.name.split(':')
			return new KodyError(code, error.message, { status: Number(status) || 500 })
		}
		return null
	}
}

export function errorToJson(error: unknown) {
	const kody = KodyError.fromUnknown(error)
	if (kody) return kody.toJSON()
	if (error instanceof Error) {
		return { error: 'internal_error', message: error.message, errorName: error.name }
	}
	return { error: 'internal_error', message: String(error) }
}

export function errorStatus(error: unknown) {
	return KodyError.fromUnknown(error)?.status ?? 500
}
