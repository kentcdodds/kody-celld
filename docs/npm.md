# npm imports

Ad hoc runs and packages can import npm packages by bare specifier:

```ts
import ms from 'ms@2.1.3'
import { format } from 'date-fns@4'
export default async () => ({ ms: ms('2h'), day: format(new Date(), 'yyyy-MM-dd') })
```

The module graph resolves each bare specifier through an **esm.sh-compatible
CDN** at graph-build time, follows the CDN's own `/…` imports, rewrites every
specifier to the exact root-anchored name celld's Worker Loader needs, and
inlines the result into the isolate. Nothing is downloaded inside the sandbox
and package code has no network access of its own — the fetch happens on the
node, through the same policy for every user.

## Configuration

| Variable                  | Default          | Notes                                                                                                                       |
| ------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `KODY_NPM_IMPORTS`        | `on`             | `off` rejects every bare specifier with `unsupported_import` (packages using only `kody:` imports keep working).            |
| `KODY_ESM_CDN_URL`        | `https://esm.sh` | Origin of the CDN. Any esm.sh-compatible server works: the public esm.sh, your own esm.sh (`compose.esm.yaml`), or a proxy. |
| `KODY_NPM_CACHE_MAX_MB`   | `256`            | Size of the durable module cache; `0` disables it (the CDN is asked on every cold node).                                    |
| `KODY_NPM_CACHE_TTL_DAYS` | `30`             | How long a cached module is served before it is re-fetched.                                                                 |

The active values (never any token) show up in `GET /admin/npm-cache`, the
operator console and the `npm` smoke scenario.

## Cache layers

1. **Process memo** — the last 500 fetched modules per node, so a hot isolate
   graph rebuild does not touch storage.
2. **Durable cache** — the `NpmCacheCell` Durable Object (SQLite, replicated by
   celld onto the fleet bucket) keyed by absolute URL. LRU eviction at
   `KODY_NPM_CACHE_MAX_MB`, expiry at `KODY_NPM_CACHE_TTL_DAYS`, single modules
   above ~1.8 MB are served but not stored (celld's SQLite value cap).
3. **CDN** — whatever `KODY_ESM_CDN_URL` points at.

Operators can inspect and flush it:

```sh
curl -s $BASE/admin/npm-cache -H "authorization: Bearer $ADMIN"
# {"npm":{"enabled":true,"cdnOrigin":"https://esm.sh","durableCache":true,"cacheMaxMb":256,"cacheTtlDays":30},
#  "cache":{"modules":42,"bytes":1234567,"hits":310,"misses":42,"oldestFetchedAt":"…","newestFetchedAt":"…"}}
curl -s -X DELETE $BASE/admin/npm-cache -H "authorization: Bearer $ADMIN"
# {"cleared":42,"bytes":1234567}   (audited as npm_cache.clear)
```

Clearing is safe at any time; the next run re-fetches what it needs.

## Self-hosting the CDN

`compose.esm.yaml` adds an `esm` service (`ghcr.io/esm-dev/esm.sh`) with
persistent storage and points Kody at it:

```sh
docker compose -f compose.yaml -f compose.esm.yaml up -d
```

`ESM_NPM_REGISTRY` / `ESM_NPM_TOKEN` point the CDN at a private registry
(Verdaccio, GitHub Packages, Artifactory…) so scoped internal packages resolve
too. The CDN itself needs outbound access to that registry; Kody only needs to
reach the CDN. For a fleet, run one `esm` container reachable from every node
and set `KODY_ESM_CDN_URL` to its URL (`CDN_ORIGIN` on the esm side must match
what Kody calls it by, because the CDN embeds absolute URLs in its output).

Cache entries are keyed by absolute URL, so switching `KODY_ESM_CDN_URL` to a
different origin starts from an empty cache for that origin (the old entries
age out by TTL/LRU or go with `DELETE /admin/npm-cache`). While the CDN is
unreachable, imports already in the cache keep resolving until their TTL
expires; anything else fails with `npm_fetch_failed`.

## Limits and failure modes

- Graph limits: 40 npm modules and 6 MiB of module text per run
  (`npm_graph_too_large`).
- Pin versions in the specifier (`ms@2.1.3`); there is no lockfile. An unpinned
  or range specifier is resolved by the CDN and the resolution is cached for
  the TTL, so different nodes may disagree for up to one TTL after a release.
- Packages that need Node built-ins beyond `nodejs_compat` (fs, child_process,
  native addons) fail at import with the CDN's error in `warnings`/`error`.
- Unknown package or version → `npm_fetch_failed` with the CDN status.
- The CDN is a supply-chain trust point: whoever controls it controls the code
  that runs in your users' isolates. Self-host it (or pin to esm.sh and rely on
  the immutable version URLs) accordingly.

## Smoke

`node smoke/run.mjs --only npm` clears the cache, imports `ms@2.1.3` twice (the
second run must not add a miss), asserts the cache stats, checks an unknown
package fails cleanly and that `DELETE /admin/npm-cache` empties the store.
