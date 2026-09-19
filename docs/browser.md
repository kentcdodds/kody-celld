# Browser rendering

Production Kody uses Cloudflare Browser Rendering for "load this page in a real
browser" work. celld has no built-in headless browser, so kody-celld talks to a
**browser service through an adapter**: a self-hosted
[browserless](https://github.com/browserless/browserless) container (Chromium
behind an HTTP API — bundled as `compose.browser.yaml`) or Cloudflare's
Browser Rendering REST API if you have an account and prefer not to run
Chromium yourself. Off by default; nothing else in Kody depends on it.

| Piece                    | Self-hosted                                                                                     | Adapter(s)                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Headless browser         | `ghcr.io/browserless/chromium` beside Kody (`compose.browser.yaml`), or any browserless you run | Cloudflare Browser Rendering (`KODY_BROWSER_PROVIDER=cloudflare`) |
| Screenshot / PDF storage | blob storage ([blobs.md](./blobs.md)) via `saveAs`                                              | —                                                                 |
| Inline images in MCP     | `__mcpContent` image blocks returned by `execute`                                               | —                                                                 |

## What users get

| Capability          | Purpose                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `browserContent`    | Load a URL (or supplied `html`) with JavaScript executed; returns `title`, extracted visible `text`, optionally `html`          |
| `browserScreenshot` | `png`/`jpeg`/`webp`, viewport or `fullPage`, optional `selector` clip; base64 `data` + `__mcpContent` image, or `saveAs` a blob |
| `browserPdf`        | Print to PDF (`A4`/`Letter`/`Legal`, landscape, background); `saveAs` a blob (recommended) or `inline` base64                   |
| `browserStatus`     | Which provider is configured (`hasToken`, never the token)                                                                      |

All of them accept `url` **or** `html`, `waitUntil`
(`load`/`domcontentloaded`/`networkidle0`/`networkidle2`) and `timeoutMs`.

```ts
import { kody } from 'kody:runtime'
export default async function main({ url }) {
  const page = await kody.browserContent({ url })
  const shot = await kody.browserScreenshot({ url, fullPage: true, saveAs: 'shots/latest.png' })
  const pdf = await kody.browserPdf({ url, saveAs: 'archive/latest.pdf' })
  // Returning __mcpContent makes execute hand the image to the MCP client as a
  // real image block (in addition to the JSON text block).
  return { title: page.title, shotUrl: shot.url, pdfUrl: pdf.url, __mcpContent: shot.__mcpContent }
}
```

### Images through MCP

`execute` normally returns one JSON text block. A run may return
`{ __mcpContent: [...] }` with protocol-valid `image`, `audio`, `resource` or
`resource_link` blocks; they are emitted **before** the JSON text block and the
JSON keeps a size-only summary (so run history and `runGet` never store
megabytes of base64). Blocks are validated (`invalid_mcp_content`) and the
serialized total is capped at `KODY_MCP_CONTENT_LIMIT_BYTES` (default 512 000;
`mcp_content_too_large`). `browserScreenshot` only attaches the image block
when it fits; use `saveAs` (the response then carries the blob record and a
signed download `url`) for large captures.

## Configuration

| Variable                           | Default  | Notes                                                                                                                                            |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `KODY_BROWSER_PROVIDER`            | `none`   | `none` (capabilities answer `browser_not_configured`, 501), `browserless`, `cloudflare`.                                                         |
| `KODY_BROWSER_URL`                 | —        | browserless base URL, e.g. `http://browserless:3000` (compose) or `http://192.168.1.20:3000`. For cloudflare, optional API base override.        |
| `KODY_BROWSER_TOKEN`               | —        | browserless `TOKEN` (query-string auth) or a Cloudflare API token with Browser Rendering permission. Operator-only; surfaced as `hasToken`.      |
| `KODY_BROWSER_CF_ACCOUNT_ID`       | —        | Required for `cloudflare`.                                                                                                                       |
| `KODY_BROWSER_TIMEOUT_MS`          | `30000`  | Per render request (1 s – 5 min). Also the default in-page navigation timeout.                                                                   |
| `KODY_BROWSER_ALLOW_PRIVATE_HOSTS` | —        | Comma-separated hostnames/IPs the browser may render although they are loopback/private/link-local (a LAN dashboard, `host.docker.internal`, …). |
| `KODY_MCP_CONTENT_LIMIT_BYTES`     | `512000` | Cap for `__mcpContent` returned by `execute` (see above).                                                                                        |

`GET /admin/browser` returns the parsed provider (no token).

### Recipes

**Self-hosted, single node (Docker)**

```sh
# .env
COMPOSE_FILE=compose.yaml:compose.browser.yaml
BROWSERLESS_TOKEN=$(openssl rand -hex 16)     # optional but recommended
docker compose up -d
```

The overlay adds a `browserless` service (no host port — only Kody can reach
it), waits for its `/active` health probe, and sets
`KODY_BROWSER_PROVIDER=browserless`, `KODY_BROWSER_URL=http://browserless:3000`
and `KODY_BROWSER_TOKEN` on the `kody` service. Tune `BROWSERLESS_CONCURRENT`,
`BROWSERLESS_QUEUED`, `BROWSERLESS_TIMEOUT`, `BROWSERLESS_VERSION` in `.env`.
A NAS with 2 GB free RAM is fine for a few concurrent sessions; the container
gets `shm_size: 1gb` because Chromium needs it.

**Self-hosted, fleet or bare metal**

Run browserless wherever you like (`docker run -e TOKEN=… -p 3000:3000
ghcr.io/browserless/chromium:v2.35.0`) on a private network, then set
`KODY_BROWSER_PROVIDER=browserless`, `KODY_BROWSER_URL=http://<host>:3000`
and `KODY_BROWSER_TOKEN` before `npm run fleet:deploy` (or in `.env` before the
compose `deploy` service). Every node uses the same service.

**Cloudflare Browser Rendering (no Chromium to run)**

```sh
KODY_BROWSER_PROVIDER=cloudflare
KODY_BROWSER_CF_ACCOUNT_ID=…
KODY_BROWSER_TOKEN=…            # API token with "Browser Rendering: Edit"
```

Uses the REST endpoints (`/content`, `/screenshot`, `/pdf`) with the same
request shapes, so packages behave identically.

## Safety

- **SSRF guard.** `url` must be `http(s)`, without embedded credentials, and
  its host may not be loopback, RFC 1918 / CGNAT / link-local (including
  `169.254.169.254` cloud metadata and IPv4-mapped IPv6 like `::ffff:10.0.0.1`),
  `.local`/`.internal`/single-label names, or `file:`/`data:` schemes — unless
  the exact host is in `KODY_BROWSER_ALLOW_PRIVATE_HOSTS`. The check is on the
  literal URL; DNS names that resolve to private addresses are not detected, so
  keep the browser on an isolated network (the compose overlay does this: the
  browser shares only the compose network with Kody) if untrusted users can
  render arbitrary URLs.
- **The browser is not the gateway.** Pages are fetched by Chromium, so
  `{{secret:…}}` placeholders are never resolved in browser requests and
  approved-host rules do not apply — the browser sees whatever a public visitor
  would see. Authenticated scraping belongs in package `fetch` code through the
  gateway.
- **Limits.** `html` inputs ≤ 2 000 000 characters, extracted text ≤ 200 000
  characters (`maxTextLength`, default 50 000), request timeout
  `KODY_BROWSER_TIMEOUT_MS`, stored captures count against blob quotas, inline
  images against `KODY_MCP_CONTENT_LIMIT_BYTES`.
- **Tokens** stay operator-side: `browserStatus`, `GET /admin/browser`, results,
  logs and the audit log only ever carry `hasToken: true|false`.

## Smoke coverage

`npm run smoke` runs the `browser` scenario: with no provider it checks
`browserStatus` against `GET /admin/browser` and skips; with a provider
configured it renders inline HTML (JavaScript executed), takes a screenshot and checks the
`image` block arrives through `execute` ahead of the JSON block, prints a PDF to
a blob and downloads it through the signed link, and exercises the guard
against metadata/loopback/private/`file:` targets. Set
`SMOKE_BROWSER_TARGET_HOST=host.docker.internal` (or another allowlisted host)
to also drive a real URL navigation against a throwaway HTTP server started by
the smoke run. It passed against a browserless container both from `celld dev`
and from the Docker overlay (`docker compose -f compose.yaml -f
compose.browser.yaml up -d`).
