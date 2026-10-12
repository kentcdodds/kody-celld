# hello-app

The smallest package app. It serves one page that echoes the request the host
hands it (path, cookies, `x-kody-*` headers, `packageContext`), counts visits in
`packageStorage`, and saves a note from a form.

Open it from Kody with `packageAppUrl({ name: "hello-app" }).openUrl` (needs
`KODY_APP_BASE_URL` set on the node). The link signs you in to the app origin
and lands on the page.
