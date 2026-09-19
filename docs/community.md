# Community package catalog

Every kody-celld install has a small package catalog of its own: users publish
packages they saved, everyone with an account can search and install them, and
the listings are public HTML at `/community` so people can browse before they
sign in. It is the self-hosted counterpart of "published packages" on
kody.codes — scoped to your node or fleet, no central registry involved.

## What a listing is

A listing is a **copy** of a saved package's files taken at publish time
(manifest, README, AGENTS, modules) plus the publisher handle and an install
counter. Editing the private package afterwards changes nothing public until
you republish. Unpublishing removes the listing; copies other users installed
stay in their accounts (with `source: "community:<name>@<version>"`).

Listings never carry the publisher's user id, email, secrets, package storage,
jobs or run history — only the files and a handle you choose.

## Publish

```ts
import { kody } from 'kody:runtime'
export default async () => kody.communityPublish({ name: '@me/weather', publisher: 'kent' })
```

- The catalog name is the package's `package.json` name. The first user to
  publish a name owns it; others get `community_name_taken`. Republishing
  (same user, same name) replaces the listing and its version.
- `publisher` is a public handle (`a-z 0-9 . _ -`, ≤ 40 chars); it defaults to
  the local part of your email. Change it on the next republish.
- Packages marked `"kody": { "hidden": true }` cannot be published.
- Each user can publish up to 100 packages.
- Publishing is a user action: package code calling `communityPublish`,
  `communityUnpublish` or `communityInstall` gets `forbidden`.

The account **Packages** page has Publish / Republish / Unpublish buttons for
each saved package and links to the public page once it is listed.

## Discover and install

```ts
import { kody } from 'kody:runtime'
const found = await kody.communitySearch({ query: 'weather', limit: 10 })
const listing = await kody.communityGet({ name: found.packages[0].name, includeFiles: true })
await kody.communityInstall({ name: '@kent/weather' }) // exact copy
await kody.communityInstall({ name: '@kent/weather', as: '@me/weather' }) // fork under a new name
await kody.packageUpdate({ name: '@kent/weather' }) // pull the latest republished version
```

- `communitySearch` matches name, description and keywords, ranked by
  installs; an empty query lists the most installed packages (≤ 50).
- `communityInstall` runs the same validation as `packageSave`. A fork rewrites
  the `package.json` name so `packageStorage()` and `kody:` imports refer to the
  new name; forks are independent copies (`packageUpdate` refuses them).
- Installing increments the listing's install count (a plain counter, not a
  per-user record).

Public pages: `/community` (list + `?q=` search) and
`/community/<encoded name>` (README, AGENTS, manifest, exports, jobs, file
list, and a copy-paste install snippet). They are read-only and need no
sign-in; nothing on them is per-viewer.

## Trust model

The catalog is a convenience for a group that already shares a node — a family,
a team, a small community. Installing a listing means running someone else's
code under **your** account with **your** secrets and storage, exactly like
pasting a package into `packageSave`. Read the code (`communityGet` with
`includeFiles`, or the public page) before installing. There is no signing,
malware scanning or moderation queue; the audit log records every
`community.publish`, `community.unpublish` and `community.install` with the
acting user, so an operator can see who published what and ask them to pull
it (or mint a token for that user and call `communityUnpublish`).

## Storage and operations

Listings live in the fleet-wide `RegistryCell` (`community_packages` table)
next to users and audit entries, so they follow the same durability path as
everything else. Stats (`packages`, `publishers`, `installs`) are shown at the top of
`/community`.

## Smoke

`node smoke/run.mjs --only community` publishes from one user, searches and
reads the public pages, installs and forks as a second user, runs the fork,
checks ownership (`community_name_taken`, unpublish by a non-owner refused),
republishes and updates the installed copy, then unpublishes and verifies the
installed copy survives. The `web` scenario covers the account-page buttons.
