# Shared-from-kody sync lock

kody-celld copies selected files from
[kentcdodds/kody](https://github.com/kentcdodds/kody) and pins them in
[`shared-from-kody.json`](../../shared-from-kody.json). CI fails when a pinned
file drifts from the upstream bytes at the pinned commit.

## Commands

```sh
npm run sync:kody          # update pins from kody main, copy verbatim files, report adapted diffs
npm run sync:kody -- --commit <sha>
npm run sync:kody:check    # verify every pinned file matches upstream (also run in CI)
```

## Verbatim vs adapted

- **Verbatim** (`files`): must match upstream byte-for-byte. Do not hand-edit.
  Change them in hosted Kody, then run `npm run sync:kody`.
- **Adapted** (`adapted`): share a path with hosted Kody but differ on purpose.
  The sync script reports diffs and never overwrites them. To promote an
  adapted file to verbatim, make celld match hosted (or document why it cannot)
  and move the entry.

## Resync vs delist (Oct 10, 2026)

Of the 36 non-route `client/` + `universal/` files that share a path with
hosted Kody, 17 differed from kody main. Choices:

| File                                   | Choice | Why                                           |
| -------------------------------------- | ------ | --------------------------------------------- |
| `client/copy-code-block.tsx`           | resync | Styling drift only; prefer hosted             |
| `client/double-check.ts`               | resync | Missing hosted `arm()` helper                 |
| `universal/package-file-media.ts`      | resync | Formatting-only drift                         |
| `universal/styles/style-primitives.ts` | resync | Missing hosted YouTube poster rule            |
| `universal/icon-glyphs.tsx`            | resync | Missing hosted glyphs (`plus`, `git-fork`, …) |
| `client/app-root.tsx`                  | delist | Different shell / route dispatch              |
| `client/client-router.tsx`             | delist | Hosted full router vs celld helper            |
| `client/copy-text-button.tsx`          | delist | `clientEntry` island wrap                     |
| `client/entry.tsx`                     | delist | Island registry / Navigation API stop         |
| `client/package-files-explorer.tsx`    | delist | `embedded` prop for package detail            |
| `client/site-footer.tsx`               | delist | Self-hosted nav and version                   |
| `client/site-header.tsx`               | delist | Account/console nav, no org chrome            |
| `client/toaster.tsx`                   | delist | `clientEntry` island wrap                     |
| `universal/loader-data.ts`             | delist | celld `AppLoaderData` shapes                  |
| `universal/package-files.ts`           | delist | Community/public href helpers not ported      |
| `universal/package-readme-images.ts`   | delist | No `/assets/` route                           |
| `universal/routes.ts`                  | delist | celld route table only                        |

Contract modules (`src/jobs/schedule.ts`, `src/secrets/placeholders.ts`,
`src/packages/manifest.ts`) and `public/styles.css` are listed as adapted until
a shared `@kody/core` package exists. Principle pages under
`docs/principles/` (except the celld-owned index and celld-only pages) are
verbatim.

## Related

- [Match hosted first](../principles/match-hosted-first.md)
- [Keep agent context lean](../principles/lean-agent-context.md)
