# @kody-smoke/counter

A tiny package that exercises the three package primitives on kody-celld:

- `packageStorage()` key/value (`count`, `ticks`) and SQL (`events` table)
- exports callable from `execute` (`.`, `./increment`, `./tick`)
- package-owned jobs declared in `package.json#kody.jobs` (`tick` every minute,
  `backfill` once)

```js
import increment from 'kody:@kody-smoke/counter/increment'
export default async function main() {
  return await increment({ by: 2 })
}
```
