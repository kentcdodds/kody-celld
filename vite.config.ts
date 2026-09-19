import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// Builds the browser hydration bundle (client/entry.tsx) into public/build/, which
// celld serves as static assets (wrangler.jsonc `assets`). The Worker itself is
// bundled by celld's esbuild, so this config only covers the client side.
const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
	root,
	publicDir: false,
	resolve: {
		alias: [
			{ find: /^#app\//, replacement: `${root}src/app/` },
			{ find: /^#client\//, replacement: `${root}client/` },
			{ find: /^#universal\//, replacement: `${root}universal/` },
		],
	},
	oxc: {
		jsx: { runtime: 'automatic', importSource: 'remix/ui' },
	},
	build: {
		outDir: 'public/build',
		emptyOutDir: true,
		sourcemap: true,
		target: 'es2022',
		rollupOptions: {
			input: `${root}client/entry.tsx`,
			output: {
				entryFileNames: 'client-entry.js',
				chunkFileNames: 'chunks/[name]-[hash].js',
				assetFileNames: 'assets/[name]-[hash][extname]',
			},
		},
	},
})
