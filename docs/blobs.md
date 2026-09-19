# Blob storage

Production Kody stores user files in Cloudflare R2. kody-celld gives every user
the same thing on your own hardware: an **R2-compatible bucket binding that
celld serves from its own storage** by default, or a **direct S3 adapter** when
you would rather keep files in a bucket you already run (MinIO, Garage,
SeaweedFS, AWS S3, Cloudflare R2, Backblaze B2, …). Both are behind one
interface, so packages and MCP clients never know which one is in use.

| Piece          | Self-hosted built-in                                                                                          | Adapter(s)                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Object bytes   | celld R2 binding `BLOBS` (`wrangler.jsonc`) — local disk in single-node, `r2/kody-blobs/` in the fleet bucket | `KODY_BLOB_PROVIDER=s3`: any S3-compatible endpoint (SigV4, path-style or virtual-hosted) |
| Index + quotas | `blobs` table in the user's `UserCell` (size, type, sha256, etag, metadata)                                   | —                                                                                         |
| Download links | HMAC-signed URLs served by Kody itself (`/blobs/:userId/:key?exp=&sig=`)                                      | —                                                                                         |

## What users get

Capabilities (discover them with `search`, call them inside `execute` as
`kody.<name>()` or via `POST /api/call/<name>`):

| Capability   | Purpose                                                                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `blobPut`    | Create/overwrite `key` with utf8 text or base64 bytes; `contentType` inferred from the extension; ≤ 20 metadata entries |
| `blobGet`    | Read back as `utf8` or `base64` (inline cap 5 MB — use `blobUrl` for bigger files)                                      |
| `blobHead`   | Metadata only: `size`, `contentType`, `sha256`, `etag`, `metadata`, `packageName`, timestamps                           |
| `blobList`   | `prefix` + `cursor` pagination                                                                                          |
| `blobDelete` | Remove one key (`deleted: false` when it did not exist)                                                                 |
| `blobUrl`    | Time-limited signed download link (default `KODY_BLOB_URL_TTL_SECONDS`, max 7 days)                                     |
| `blobUsage`  | Count/bytes used, effective quotas, provider description (never credentials)                                            |

```ts
import { kody } from 'kody:runtime'
export default async function main() {
  await kody.blobPut({ key: 'reports/2026-09/summary.md', content: '# Weekly\n…' })
  const { url } = await kody.blobUrl({ key: 'reports/2026-09/summary.md', expiresIn: 3600 })
  const { blobs, blobBytes, quotas } = await kody.blobUsage()
  return { url, blobs, blobBytes, quotas }
}
```

Raw-bytes HTTP routes exist for clients that would rather stream than base64
through `execute` (same user bearer token as `/mcp`):

```sh
curl -X PUT $BASE/api/blobs/photos/cat.png -H "authorization: Bearer kc_..." \
  -H 'content-type: image/png' -H 'x-kody-blob-metadata: {"album":"pets"}' --data-binary @cat.png
curl $BASE/api/blobs/photos/cat.png -H "authorization: Bearer kc_..." -o cat.png   # also HEAD, DELETE
```

Keys are path-like (`a/b/c.ext`), ≤ 512 characters, no leading slash, no empty
segment, no `.`/`..`, no control characters. Every object is stored below
`users/<userId>/` (plus `KODY_BLOB_S3_PREFIX` for the S3 adapter), so users
cannot see or name each other's objects and the index in the user's cell is
the source of truth for listing.

## Configuration

| Variable                                                        | Default         | Notes                                                                                                                   |
| --------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `KODY_BLOB_PROVIDER`                                            | `r2`            | `r2` = celld's bucket binding (no extra setup); `s3` = direct S3-compatible adapter.                                    |
| `KODY_BLOB_S3_ENDPOINT`                                         | —               | `http://minio:9000`, `https://s3.eu-central-1.amazonaws.com`, `https://<account>.r2.cloudflarestorage.com`…             |
| `KODY_BLOB_S3_BUCKET`                                           | —               | Must already exist (the fleet's `docker/ensure-bucket.mjs` can create it: see below).                                   |
| `KODY_BLOB_S3_REGION`                                           | `auto`          | `us-east-1` for MinIO/most, `auto` for R2.                                                                              |
| `KODY_BLOB_S3_ACCESS_KEY_ID` / `KODY_BLOB_S3_SECRET_ACCESS_KEY` | —               | Operator credentials; never returned by any capability, admin route, or log.                                            |
| `KODY_BLOB_S3_PREFIX`                                           | —               | Optional key prefix so several Kody instances can share one bucket.                                                     |
| `KODY_BLOB_S3_FORCE_PATH_STYLE`                                 | `1`             | Path-style URLs (`endpoint/bucket/key`). MinIO and Garage need it; AWS/R2 accept either.                                |
| `KODY_BLOB_MAX_BYTES`                                           | `26214400`      | Per object (25 MiB). Larger uploads are rejected with `blob_too_large` (413).                                           |
| `KODY_BLOB_URL_TTL_SECONDS`                                     | `3600`          | Default lifetime of `blobUrl` links; callers may pass a shorter/longer `expiresIn` up to 7 days.                        |
| `KODY_QUOTA_BLOBS` / `KODY_QUOTA_BLOB_BYTES`                    | `0` (unlimited) | Per-user object count / total bytes; admins override per user with `PUT /admin/users/:id/quota` (`blobs`, `blobBytes`). |

`GET /admin/blobs` shows the parsed provider (`bucketBound` tells you whether
the `BLOBS` binding is present); `GET /admin/users/:id/blobs` lists a user's
index and usage.

### Where the bytes live

- **Single node (Docker `compose.yaml` or `celld dev`)**: celld's local object
  store inside the `kody-data` volume / `.celld/dev`. Backing up the volume backs
  up the blobs.
- **Fleet**: the R2 binding maps to `r2/kody-blobs/` inside `CELLD_BUCKET`, so
  blobs share the durability, replication, and backup story of the rest of the
  fleet. Nothing extra to provision.
- **`KODY_BLOB_PROVIDER=s3`**: exactly where you point it. Use this when files
  should outlive the Kody deployment, be reachable by other tools, or live in a
  different bucket/account than celld's state. Create the bucket first, e.g.

  ```sh
  CELLD_BUCKET=s3://kody-files S3_ENDPOINT=http://localhost:9000 \
    AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… node docker/ensure-bucket.mjs
  ```

  The S3 adapter was verified against MinIO with a prefix and path-style URLs;
  it uses plain SigV4 over `fetch` (PUT/GET/HEAD/DELETE/ListObjectsV2), no SDK.

### Signed URLs

`blobUrl` returns `${KODY_PUBLIC_URL}/blobs/<userId>/<key>?exp=<unix>&sig=<hmac>`.
The signature is an HMAC-SHA256 with a key derived (HKDF) from `KODY_MASTER_KEY`
and the user id, so:

- links are served by Kody, never by the bucket — S3 credentials and bucket
  names stay server-side, and a link never works for a different user's key;
- tampering with the key or `exp`, or a past `exp`, yields 403
  `blob_link_invalid`;
- rotating the master key (see [secrets.md](./secrets.md#master-key-rotation))
  invalidates outstanding links — mint new ones.

Responses carry `content-type`, `etag`, `x-kody-sha256`,
`cache-control: private, no-store` and `x-content-type-options: nosniff`.

## Safety properties

- Package code gets `kody.blob*()` only; there is no bucket client in the
  sandbox and `FetchGateway` still governs any direct `fetch` a package makes.
- Blobs written from a package are stamped with `packageName` in the index (and
  as object metadata) — same provenance idea as `packageStorage()`.
- Quotas are checked in the user's Durable Object before the upload and
  re-checked when the index row is written; a failed index write deletes the
  freshly stored object so storage and index cannot drift.
- Uploads are hashed (SHA-256) on the way in; `blobHead`/`blobGet`/HTTP responses
  return the digest so clients can verify integrity.

## Smoke coverage

`npm run smoke` runs the `blobs` scenario against whichever provider the node is
configured with: provider discovery via `search` and `GET /admin/blobs`, utf8 +
70 kB binary round trips, raw HTTP PUT/GET plus a 401 without a token, signed
URL download / tampering / expiry, cross-user isolation, count and byte quotas,
invalid keys and oversize uploads, and the admin listing. It asserts that no
credential-like strings appear in any response. The same scenario passed on
celld dev (R2 binding), the Docker single node, and `KODY_BLOB_PROVIDER=s3`
against MinIO.
