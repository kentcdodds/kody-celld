import { KODY_CELLD_VERSION } from '../env.ts'

/**
 * The `guide:provision` search guide: what kody-celld provides in place of Cloudflare-only features.
 * Kept in its own module so a test can pin it to the code it describes. It only imports the
 * version constant from env.ts (no Worker runtime, cells, or capability registry).
 */
export const provisionGuide = {
	id: 'guide:provision',
	entity: 'guide' as const,
	title: 'How Cloudflare-only features are provided here',
	summary:
		'Cloudflare-only pieces run through generic self-hosted adapters: OpenAI-compatible AI, sqlite-vec/Qdrant vectors, the celld bucket or any S3-compatible store for blobs, an SMTP mail-bridge for email, and browserless for rendering. Workflows are not provided yet.',
	domain: 'system',
	exactNames: [
		'deferred',
		'gaps',
		'unsupported',
		'adapters',
		'ai',
		'email',
		'blobs',
		'browser',
		'oauth',
		'workflows',
		'provision',
	],
	detail: {
		text: `kody-celld ${KODY_CELLD_VERSION} runs on celld (self-hosted Workers + Durable Objects).
Built in: MCP search/execute, packages, secrets with gateway injection, jobs on cron, webhooks, quotas/audit, memories (FTS5 + vectors), the web UI, OAuth integrations ({{integration-token:...}}, createAuthenticatedFetch), and external MCP servers (kody.mcp["name"].tool()).
Through operator-configured generic adapters: AI chat/embeddings (any OpenAI-compatible endpoint; see kody.aiStatus()), vectors (sqlite-vec or Qdrant), blob storage (the celld bucket binding or any S3-compatible endpoint), email (SMTP mail-bridge; see kody.emailStatus()), browser rendering (browserless).
Not yet in this build: Workflows. The kody:runtime exports \`email\` and \`workflows\` are null; use the kody.email* capabilities for mail. See docs/known-gaps.md for the full matrix.`,
	},
}
