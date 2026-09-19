import { type Handle, type RemixNode } from 'remix/ui'
import { type AppRootProps } from '#universal/app-root-props.ts'

/**
 * Worker-side type stand-in for `client/app-root.tsx`. `tsconfig.json` maps
 * `#client/app-root.tsx` here so the Worker typecheck never loads the browser
 * component tree (which uses DOM types); the bundle itself resolves the real
 * module through `package.json#imports`. Same trick as upstream kody.
 */
export declare function AppRoot(handle: Handle<AppRootProps>): () => RemixNode
