# Changelog

Release notes for **kody-celld**. Tagged GitHub Releases remain the published
source; this file holds the draft for the next tag and a short index of past
ones.

## [Unreleased]

### Image registry path (self-hosters)

Images now publish to `ghcr.io/kody-hq/kody-celld` (Publish workflow uses
`ghcr.io/${{ github.repository }}` after the repo moved to `kody-hq`).

`ghcr.io/kentcdodds/kody-celld` **no longer receives updates**. Existing tags
there are left in place so current pulls keep working, but `:latest` and new
version tags only appear under `kody-hq`.

**One-line change** in your Compose (or equivalent) `image:` field:

```diff
-    image: ghcr.io/kentcdodds/kody-celld:latest
+    image: ghcr.io/kody-hq/kody-celld:latest
```

Then `docker compose pull && docker compose up -d`. Pin a version tag the same
way (`:0.2.0`, `:0.2`, …) once that tag exists under `kody-hq`.

## Past releases

- [v0.2.0](https://github.com/kody-hq/kody-celld/releases/tag/v0.2.0) — external MCP servers, package apps, one private-host allowlist
- [v0.1.1](https://github.com/kody-hq/kody-celld/releases/tag/v0.1.1) — keep dev email defaults out of single-node Docker
- [v0.1.0](https://github.com/kody-hq/kody-celld/releases/tag/v0.1.0) — first public self-hosted release
