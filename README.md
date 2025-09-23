# cf-pages-functions-loader-hono

Mount your **Cloudflare Pages Functions** into a **Hono** app with **reliable header propagation**, **deep tracing**, and **dev-adapter-resistant** “last-mile” header stamping. Designed for local dev with Vite and for Pages/Workers runtime in production.

> TL;DR: If you’ve ever set headers in middleware and then watched them mysteriously vanish by the time the client receives a response, this loader fixes that—consistently.

---

## Why this exists

- **Header propagation that actually sticks.**  
  Some dev adapters and finalizers can drop or override headers. This loader mirrors headers into Hono’s context **and** clones the final `Response` with headers baked in—so the client always gets them.

- **Compatible with CF Pages Functions semantics.**  
  Write functions as `onRequest`, `onRequestGet`, `onRequestPost`, etc. Place `_middleware.(js|ts)` files alongside routes—just like Pages Functions.

- **Deep tracing & debugging.**  
  Every request gets an `X-Trace-Id`. Optional verbose logs show the chain and headers at each step.

---

## Features

- ✅ Maps file paths to Hono routes (including dynamic/optional segments)  
- ✅ Supports `_middleware` with `onRequest*` methods (ALL/GET/POST/etc.)  
- ✅ Reflects middleware-set headers into `c.header()` and the final `Response`  
- ✅ Adds `X-Trace-Id` automatically  
- ✅ Dev-friendly optional CORS scaffold (commented; enable if you want)  
- ✅ Works with `import.meta.glob()` lazy modules  
- ✅ Provides `cf`-style context shape inside handlers (request, env, params, locals/data, waitUntil)

---

## Install

```bash
# your project likely already has hono
npm i hono
# this file is just a drop-in; no package to install
# copy src/server/loadPageFunctions.js into your project
````

> The loader is a single file: `src/server/loadPageFunctions.js`. Add it to your repo and import it from your server bootstrap.

---

## Quick start

**1) Add your CF-style functions**

```
/src/functions
  /api/hello.ts
  /api/_middleware.ts
  /blog/[slug].ts
  /catchall/[[...rest]].ts
```

**Example: `/src/functions/api/hello.ts`**

```ts
export async function onRequestGet(ctx) {
  // set a header the loader will preserve end-to-end
  const res = new Response(JSON.stringify({ ok: true }), {
    headers: { 'Access-Control-Expose-Headers': 'X-Trace-Id' },
  })
  return res
}
```

**Example middleware: `/src/functions/api/_middleware.ts`**

```ts
export async function onRequest(ctx, next) {
  // add a header that must survive to the client
  const res = await next()
  res.headers.set('X-From-Middleware', 'yes')
  return res
}
```

**2) Wire the loader into Hono**

```ts
// src/server/app.ts
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { loadFunctions } from './loadPageFunctions'

const app = new Hono()
app.use(logger())

await loadFunctions(app, {
  baseDir: '../functions', // folder containing your CF functions
  modules: import.meta.glob('../functions/**/*.{js,ts}', { eager: false }),
})

export default app
```

Use this `app` in your dev server or export for Cloudflare Workers/Pages adapters as usual.

---

## Routing rules

File path → Route path (mirrors CF Pages Functions):

* `index.ts` → `/`
* `api/hello.ts` → `/api/hello`
* `blog/[slug].ts` → `/blog/:slug`
* `catchall/[...rest].ts` → `/catchall/:rest{.+}`
* `docs/[[section]].ts` → `/docs` and `/docs/:section` (optional)
* `_middleware.ts` in any folder attaches to that folder’s subtree

  * `api/_middleware.ts` applies to `/api/*`
  * Handlers: `onRequest` (ALL), `onRequestGet`, `onRequestPost`, etc.

Supported exports:

* Routes: `onRequest`, `onRequestGet`, `onRequestPost`, `onRequestPut`, `onRequestDelete`, `onRequestPatch`, `onRequestHead`, `onRequestOptions`
* You may also `export default` a function (treated like `onRequest`)

---

## Header guarantees

1. **Reflect to Hono context:**
   When a middleware returns a `Response`, its headers are copied into `c.header(...)` so Hono’s finalizer retains them.

2. **Clone with extras (“last-mile guarantee”):**
   The loader clones the final `Response` and stamps critical headers (e.g., `X-Trace-Id`) so no adapter can strip them after the fact.

3. **Vary: Origin safety:**
   When CORS is in play, `Vary: Origin` is ensured to keep caches honest.

---

## Tracing & Debugging

* Every response includes `X-Trace-Id`.
* Turn on logs via either:

  * Edit the file: `const DEBUG = true`, or
  * Env var: `DEBUG_HONO_LOADER=true`

You’ll see trace lines like:

```
[TRACE lngz8vk5] MW chain returned Response { status: 200, headers: {...} }
```

---

## Optional dev CORS

There’s a commented block in the “GLOBAL wrap” that sets permissive CORS.
Uncomment it while developing if you want easy cross-origin testing.

```js
// const FORCE_CORS = false
// ...
// if (FORCE_CORS) { /* setHeadersOnContext(...); ensureVaryOrigin(c) */ }
```

> In many cases, your own `_middleware.ts` with `onRequestOptions` + per-route headers is preferable for production.

---

## API

### `await loadFunctions(app, options)`

* **`app`**: a Hono instance
* **`options.functionsDir` | `options.baseDir`**: string path (required; use one)
  Relative to this loader file; defaults to `../functions`
* **`options.modules`**: result of `import.meta.glob('<dir>/**/*.{js,ts}', { eager: false })` (required)

The loader:

* Registers a **global wrapper** (first) that stamps trace and final headers
* Mounts `_middleware` handlers (ALL first, then method-specific gates)
* Registers route files per their exported `onRequest*` handlers

---

## Context shape inside handlers

Your function receives a CF-like context:

```ts
type Ctx = {
  request: Request
  env: Record<string, unknown>
  params: Record<string, string | string[]>
  locals: MapLike            // shared bag (also available as data)
  data: MapLike              // alias of locals
  waitUntil: (p: Promise<any>) => void
  // next is only provided for middleware chains you compose yourself
}
```

For catch-alls/optional segments, `params` uses arrays for `:name{.+}`.

---

## Examples

**Return plain JSON**

```ts
export async function onRequestGet() {
  return Response.json({ hello: 'world' }, { headers: { 'X-Foo': 'bar' } })
}
```

**Use middleware to add headers**

```ts
export async function onRequest(ctx, next) {
  const res = await next()
  res.headers.set('X-From-MW', '1')
  return res
}
```

**Change the request mid-chain**

```ts
export async function onRequest(ctx, next) {
  const url = new URL(ctx.request.url)
  url.searchParams.set('mw', 'true')
  const req2 = new Request(url, ctx.request)
  return next(req2) // downstream sees modified request
}
```

---

## Troubleshooting

* **“My header shows in logs but not in the client.”**
  This loader reflects headers to `c.header()` and clones the final `Response`. If you still don’t see it, check any reverse proxies/CDNs in front of your app that may be stripping headers.

* **“Dynamic routes aren’t matching how I expect.”**
  Verify your file name syntax:

  * `[slug]` → `:slug`
  * `[...rest]` → `:rest{.+}`
  * `[[section]]` → optional `:section`

* **“I’m on Vite dev, client still not seeing headers.”**
  Ensure you’re using the exported `app` from Hono via your dev server entry. Some custom adapters may wrap responses again—this loader’s final clone should win.

---

## Compatibility

* **Runtime:** Cloudflare Pages Functions / Workers, Node during dev with Vite
* **Framework:** Hono (v3+ recommended)
* **Module format:** ESM

---

## Folder structure suggestion

```
src/
  server/
    app.ts
    loadPageFunctions.js  ← this loader
  functions/
    api/
      _middleware.ts
      hello.ts
    blog/
      [slug].ts
    catchall/
      [[...rest]].ts
```

---

## License

MIT

---

## Acknowledgements

Built after too many nights of “why did my header disappear?”—now it doesn’t. 😅

---

### Maintainer notes

* Keep the file as a single drop-in to minimize friction.
* Add tests against common adapter paths if you wire CI.

```
