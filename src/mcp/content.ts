import { KodyError } from '../lib/errors.ts'

/**
 * `execute` normally serializes the run result into one `text` block. Code
 * that needs a real non-text block (a screenshot, a chart, audio) returns
 * `{ __mcpContent: [...] }` instead and the blocks pass straight through as
 * the tool result content. Mirrors production Kody's docs/use/raw-content-blocks.md.
 */

export type McpContentBlock =
	| { type: 'text'; text: string }
	| { type: 'image'; data: string; mimeType: string }
	| { type: 'audio'; data: string; mimeType: string }
	| { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string; blob?: string } }
	| { type: 'resource_link'; uri: string; name: string; description?: string; mimeType?: string }

export const mcpContentKey = '__mcpContent'

const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(index: number, reason: string): never {
	throw new KodyError('invalid_mcp_content', `__mcpContent[${index}] ${reason}`, { status: 422 })
}

function validateBlock(block: unknown, index: number): McpContentBlock {
	if (!isRecord(block) || typeof block.type !== 'string') return invalid(index, 'must be an object with a `type`.')
	switch (block.type) {
		case 'text':
			if (typeof block.text !== 'string') return invalid(index, 'text blocks need a string `text`.')
			return { type: 'text', text: block.text }
		case 'image':
		case 'audio': {
			if (typeof block.data !== 'string' || !base64Pattern.test(block.data) || block.data.length % 4 !== 0) {
				return invalid(index, `${block.type} blocks need base64 \`data\`.`)
			}
			const expectedPrefix = `${block.type}/`
			if (typeof block.mimeType !== 'string' || !block.mimeType.startsWith(expectedPrefix)) {
				return invalid(index, `${block.type} blocks need a \`mimeType\` starting with "${expectedPrefix}".`)
			}
			return { type: block.type, data: block.data, mimeType: block.mimeType }
		}
		case 'resource': {
			const resource = block.resource
			if (!isRecord(resource) || typeof resource.uri !== 'string') {
				return invalid(index, 'resource blocks need `resource.uri`.')
			}
			if (typeof resource.text !== 'string' && typeof resource.blob !== 'string') {
				return invalid(index, 'resource blocks need `resource.text` or base64 `resource.blob`.')
			}
			return {
				type: 'resource',
				resource: {
					uri: resource.uri,
					...(typeof resource.mimeType === 'string' ? { mimeType: resource.mimeType } : {}),
					...(typeof resource.text === 'string' ? { text: resource.text } : {}),
					...(typeof resource.blob === 'string' ? { blob: resource.blob } : {}),
				},
			}
		}
		case 'resource_link':
			if (typeof block.uri !== 'string' || typeof block.name !== 'string') {
				return invalid(index, 'resource_link blocks need `uri` and `name`.')
			}
			return {
				type: 'resource_link',
				uri: block.uri,
				name: block.name,
				...(typeof block.description === 'string' ? { description: block.description } : {}),
				...(typeof block.mimeType === 'string' ? { mimeType: block.mimeType } : {}),
			}
		default:
			return invalid(index, `has unsupported type "${block.type}" (text, image, audio, resource, resource_link).`)
	}
}

export type ExtractedContent = {
	blocks: Array<McpContentBlock>
	/** The result minus `__mcpContent`, or undefined when nothing else was returned. */
	rest: Record<string, unknown> | undefined
	serializedBytes: number
}

/**
 * Detects and validates a `__mcpContent` return. Throws `invalid_mcp_content`
 * for malformed blocks and `mcp_content_too_large` when the serialized blocks
 * exceed `limitBytes` (oversized media must fail loudly, not be truncated
 * into unusable text).
 */
export function extractMcpContent(result: unknown, limitBytes: number): ExtractedContent | null {
	if (!isRecord(result) || !(mcpContentKey in result)) return null
	const raw = result[mcpContentKey]
	if (!Array.isArray(raw) || raw.length === 0) {
		throw new KodyError('invalid_mcp_content', '__mcpContent must be a non-empty array of content blocks.', {
			status: 422,
		})
	}
	const blocks = raw.map((block, index) => validateBlock(block, index))
	const serializedBytes = JSON.stringify(blocks).length
	if (serializedBytes > limitBytes) {
		throw new KodyError(
			'mcp_content_too_large',
			`__mcpContent serializes to ${serializedBytes} bytes; the limit is ${limitBytes} (KODY_MCP_CONTENT_LIMIT_BYTES). Store large media with blobPut and return a blobUrl instead.`,
			{ status: 413, details: { serializedBytes, limitBytes } },
		)
	}
	const { [mcpContentKey]: _content, ...rest } = result
	return { blocks, rest: Object.keys(rest).length > 0 ? rest : undefined, serializedBytes }
}

/** Replaces base64 payloads with a size note for run history / logs. */
export function summarizeMcpContent(blocks: Array<McpContentBlock>) {
	return blocks.map((block) => {
		if (block.type === 'image' || block.type === 'audio') {
			return { type: block.type, mimeType: block.mimeType, bytes: Math.floor((block.data.length * 3) / 4) }
		}
		if (block.type === 'resource' && block.resource.blob !== undefined) {
			return {
				type: block.type,
				resource: {
					uri: block.resource.uri,
					mimeType: block.resource.mimeType,
					bytes: Math.floor((block.resource.blob.length * 3) / 4),
				},
			}
		}
		return block
	})
}
