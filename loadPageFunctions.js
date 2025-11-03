// src/server/loadPageFunctions.js
// Hono loader for Cloudflare Pages Functions with reliable header propagation,
// deep tracing, and dev-adapter-resistant header stamping.
//
// Key tactics:
//  - Set baseline CORS via c.header() *before* next()  (Hono finalizer path)
//  - Reflect CF-middleware-set headers back into c.header()
//  - Clone the final Response with headers baked in (last-mile guarantee)

const DEBUG = false // flip to false to quiet logs
// const FORCE_CORS = false // set dev-friendly CORS automatically (you can turn off if not needed)

// ---------- debug helpers ----------
function randId() {
	return Math.random().toString(36).slice(2, 10)
}
function dbgOn() {
	try {
		return (
			DEBUG === true ||
			String(
				(typeof process !== "undefined"
					? process.env?.DEBUG_HONO_LOADER
					: "") || ""
			).toLowerCase() === "true"
		)
	} catch {
		return DEBUG === true
	}
}
function headersObj(h) {
	try {
		return Object.fromEntries(h.entries())
	} catch {
		return {}
	}
}
function dbg(id, ...args) {
	if (!dbgOn()) return
	const prefix = id ? `[TRACE ${id}]` : "[TRACE]"
	const safe = args.map((a) => (a instanceof Headers ? headersObj(a) : a))
	console.log(prefix, ...safe)
}

// ---------- small utils ----------
// function setHeadersOnContext(c, kv) {
// 	for (const [k, v] of Object.entries(kv)) {
// 		// c.header() ensures Hono finalizer carries these headers through
// 		c.header(k, v)
// 	}
// }

function ensureVaryOrigin(c) {
	const prev = c.res?.headers?.get?.("Vary")
	if (!prev) c.header("Vary", "Origin")
	else if (
		!prev
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.includes("origin")
	) {
		c.header("Vary", `${prev}, Origin`)
	}
}
function cloneWithExtraHeaders(res, extra = {}, trace = "no-trace") {
	const headers = new Headers(res.headers)
	for (const [k, v] of Object.entries(extra)) headers.set(k, v)
	const out = new Response(res.body, {
		status: res.status,
		statusText: res.statusText ?? undefined,
		headers,
	})
	dbg(trace, "cloneWithExtraHeaders ->", headersObj(out.headers))
	return out
}

// ---------- route mapping ----------
function filepathToRoutes(filepath, baseDir = "../functions") {
	const posixPath = String(filepath).replace(/\\/g, "/")
	const posixBase = String(baseDir).replace(/\\/g, "/").replace(/\/+$/, "")
	let p = posixPath.startsWith(posixBase + "/")
		? posixPath.slice(posixBase.length + 1)
		: posixPath
	const ext = p.match(/\.([jt]s)$/)
	if (ext) p = p.slice(0, -ext[0].length)
	const rawSegs = p.split("/").filter(Boolean)

	let last = rawSegs.pop()
	let isMiddleware = false
	if (last === "_middleware") isMiddleware = true
	else if (last && last !== "index") rawSegs.push(last)

	const expand = (seg) => {
		if (seg.startsWith("[[...") && seg.endsWith("]]")) {
			const n = seg.slice(5, -2)
			return [[], [`:${n}{.+}`]]
		}
		if (seg.startsWith("[[") && seg.endsWith("]]")) {
			const n = seg.slice(2, -2)
			return [[], [`:${n}`]]
		}
		if (seg.startsWith("[...") && seg.endsWith("]")) {
			const n = seg.slice(4, -1)
			return [[`:${n}{.+}`]]
		}
		if (seg.startsWith("[") && seg.endsWith("]")) {
			const n = seg.slice(1, -1)
			return [[`:${n}`]]
		}
		return [[seg]]
	}

	const parts = rawSegs.map(expand)
	let routesParts = [[]]
	for (const choices of parts) {
		const next = []
		for (const pref of routesParts)
			for (const choice of choices) next.push([...pref, ...choice])
		routesParts = next
	}

	const baseRoutes = Array.from(
		new Set(
			routesParts.map(
				(pp) => "/" + pp.filter(Boolean).join("/").replace(/^\/+/, "")
			)
		)
	)
	if (baseRoutes.length === 0) baseRoutes.push("/")

	const augmented = new Set(baseRoutes)
	for (const r of baseRoutes)
		if (r.match(/\/:([A-Za-z0-9_]+)$/)) augmented.add(`${r}{.+}`)

	const lastRaw = rawSegs[rawSegs.length - 1] || ""
	const optTail = lastRaw.match(/^\[\[([A-Za-z0-9_]+)\]\]$/)?.[1] || null

	const routes = []
	for (const pathStr of augmented) {
		const arrayParams = new Set()
		for (const m of pathStr.matchAll(/:([A-Za-z0-9_]+)\{\.\+\}/g))
			arrayParams.add(m[1])
		if (
			optTail &&
			(pathStr.endsWith(`/:${optTail}`) || pathStr.endsWith(`/:${optTail}{.+}`))
		)
			arrayParams.add(optTail)
		routes.push({ path: pathStr, arrayParams: Array.from(arrayParams) })
	}
	return { routes, isMiddleware }
}

function getMethodFromExportName(name) {
	if (!name.startsWith("onRequest")) return null
	const suffix = name.slice(9)
	if (suffix === "") return "ALL"
	const method = suffix.toUpperCase()
	return ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].includes(
		method
	)
		? method
		: null
}

// ---------- plumbing ----------
function createSharedProxy(c) {
	return new Proxy(
		{},
		{
			get(_t, k) {
				if (k === "get") return (x) => c.get(x)
				if (k === "set") return (x, v) => void c.set(x, v)
				if (k === "has") return (x) => c.get(x) !== undefined
				if (k === "delete") return (x) => void c.set(x, undefined)
				if (typeof k === "symbol") return undefined
				return c.get(k)
			},
			set(_t, k, v) {
				if (typeof k !== "symbol") c.set(k, v)
				return true
			},
			has(_t, k) {
				return typeof k !== "symbol" && c.get(k) !== undefined
			},
			deleteProperty(_t, k) {
				if (typeof k !== "symbol") c.set(k, undefined)
				return true
			},
			ownKeys() {
				return []
			},
			getOwnPropertyDescriptor() {
				return { enumerable: false, configurable: true }
			},
		}
	)
}

function toMutableResponse(res, trace) {
	if (res === undefined || res === null) {
		dbg(trace, "toMutableResponse <- undefined/null -> 204")
		return new Response(null, { status: 204 })
	}
	if (res instanceof Response) {
		const out = new Response(res.body, {
			status: res.status,
			statusText: res.statusText,
			headers: new Headers(res.headers),
		})
		dbg(trace, "toMutableResponse <- Response", {
			status: out.status,
			headers: headersObj(out.headers),
		})
		return out
	}
	if (typeof res === "object") {
		let out
		try {
			if (res?.status && res?.headers && ("body" in res || "bodyUsed" in res)) {
				out = new Response(res.body ?? null, {
					status: res.status,
					headers: new Headers(res.headers),
				})
			} else {
				out = Response.json(res)
			}
		} catch {
			out = Response.json(res)
		}
		dbg(trace, "toMutableResponse <- Object", {
			status: out.status,
			headers: headersObj(out.headers),
		})
		return out
	}
	const out = new Response(res)
	dbg(trace, "toMutableResponse <- Primitive", {
		status: out.status,
		headers: headersObj(out.headers),
	})
	return out
}

async function getSharedMutableResponse(c, next) {
	const trace = c.get?.("__trace_id__") || "no-trace"
	let shared = c.get?.("__cf_mutable_response__")
	if (shared) {
		dbg(trace, "shared exists", {
			status: shared.status,
			headers: headersObj(shared.headers),
		})
		return shared
	}
	dbg(trace, "getSharedMutableResponse: calling downstream next()")
	const downstream = await next()
	const downstreamResponse =
		downstream instanceof Response
			? downstream
			: c.res instanceof Response
			? c.res
			: downstream

	dbg(trace, "downstream returned", {
		isResponse: downstream instanceof Response,
		type: typeof downstream,
		headers:
			downstream instanceof Response
				? headersObj(downstream.headers)
				: undefined,
		usedContextRes: downstreamResponse !== downstream,
		contextHeaders:
			downstreamResponse !== downstream && downstreamResponse instanceof Response
				? headersObj(downstreamResponse.headers)
				: undefined,
	})

	shared = toMutableResponse(downstreamResponse, trace)
	c.set?.("__cf_mutable_response__", shared)
	dbg(trace, "cached shared", {
		status: shared.status,
		headers: headersObj(shared.headers),
	})
	return shared
}

function composeCFChain(exported) {
	const fns = Array.isArray(exported) ? exported : [exported]
	const chain = fns.filter((fn) => typeof fn === "function")
	return async function run(rootCtx, finalNext) {
		const trace = rootCtx.locals?.get?.("__trace_id__") || "no-trace"
		let idx = -1
		const runAt = async (i, ctx) => {
			if (i <= idx) throw new Error("next() called multiple times")
			idx = i
			if (i >= chain.length) {
				dbg(trace, "chain finished -> finalNext()")
				return finalNext ? await finalNext() : undefined
			}
			const fn = chain[i]
			dbg(trace, `enter handler[${i}]`, { arity: fn.length })
			let called = false
			const stepNext = async (reqOverride) => {
				called = true
				if (reqOverride && reqOverride !== ctx.request) {
					ctx.locals?.set?.(
						"__cf_override_request__",
						reqOverride.clone ? reqOverride.clone() : new Request(reqOverride)
					)
					dbg(trace, `handler[${i}] set override request`)
				}
				dbg(trace, `handler[${i}] -> next()`)
				return runAt(i + 1, ctx)
			}
			const ctxWithNext = Object.create(ctx)
			ctxWithNext.next = stepNext
			const out =
				fn.length >= 2 ? await fn(ctxWithNext, stepNext) : await fn(ctxWithNext)
			if (out instanceof Response) {
				dbg(trace, `handler[${i}] returned Response`, {
					status: out.status,
					headers: headersObj(out.headers),
				})
				return out
			}
			if (out !== undefined) {
				dbg(trace, `handler[${i}] returned value`, { type: typeof out })
				return out
			}
			if (!called) {
				dbg(trace, `handler[${i}] neither returned nor called next -> advance`)
				return runAt(i + 1, ctx)
			}
			dbg(trace, `handler[${i}] completed after next()`)
			return out
		}
		return runAt(0, rootCtx)
	}
}

function makeCFContext(c, arrayParams = [], extras = {}) {
	const request = c.req?.raw ?? c.req
	const shared = createSharedProxy(c)
	const override = c.get?.("__cf_override_request__")

	let trace = c.get?.("__trace_id__")
	if (!trace) {
		trace = randId()
		c.set?.("__trace_id__", trace)
	}

	const base = (c.req?.param ? c.req.param() : c.params) || {}
	const params = { ...base }
	for (const name of arrayParams) {
		const v = params[name]
		if (Array.isArray(v)) continue
		if (typeof v === "string") params[name] = v.split("/").filter(Boolean)
		else if (v == null) params[name] = []
	}

	const ctx = {
		request: override || request,
		env: c.env || {},
		params,
		locals: shared,
		data: shared,
		waitUntil: (p) => c.executionCtx?.waitUntil?.(p),
		...extras,
	}
	dbg(trace, "makeCFContext", { arrayParams, params })
	return ctx
}

// ---------- wrappers ----------
function makeRouteHandler(exported, arrayParams) {
	const run = composeCFChain(exported)
	return async (c) => {
		const trace = c.get?.("__trace_id__") || randId()
		c.set?.("__trace_id__", trace)
		dbg(trace, "ROUTE start", { method: c.req?.method, path: c.req?.path })
		const cfCtx = makeCFContext(c, arrayParams)
		const raw = await run(cfCtx, async () => undefined)
		if (raw instanceof Response) {
			dbg(trace, "ROUTE returning Response", {
				status: raw.status,
				headers: headersObj(raw.headers),
			})
			return raw
		}
		if (raw === undefined) {
			dbg(trace, "ROUTE returned undefined -> 204")
			return new Response(null, { status: 204 })
		}
		const wrapped = toMutableResponse(raw, trace)
		dbg(trace, "ROUTE returning wrapped", {
			status: wrapped.status,
			headers: headersObj(wrapped.headers),
		})
		return wrapped
	}
}

function makeMiddlewareHandler(exported, arrayParams) {
	const run = composeCFChain(exported)
	return async (c, next) => {
		const trace = c.get?.("__trace_id__") || randId()
		c.set?.("__trace_id__", trace)
		dbg(trace, "MW start", { method: c.req?.method, route: c.req?.path })

		const finalNext = async () => {
			dbg(trace, "MW finalNext -> getSharedMutableResponse")
			return getSharedMutableResponse(c, next)
		}

		const cfCtx = makeCFContext(c, arrayParams, { next: undefined })
		const result = await run(cfCtx, finalNext)

		// If CF middleware returned a Response, reflect those headers to c.header() *as well*
		if (result instanceof Response) {
			dbg(trace, "MW chain returned Response", {
				status: result.status,
				headers: headersObj(result.headers),
			})

			// Reflect to Hono context so its finalizer path also includes them:
			for (const [k, v] of result.headers) c.header(k, v)
			ensureVaryOrigin(c)

			// Cache/merge into shared
			let shared = c.get?.("__cf_mutable_response__")
			if (!shared) {
				shared = toMutableResponse(result, trace)
				c.set?.("__cf_mutable_response__", shared)
				dbg(trace, "MW cached chain Response as shared", {
					status: shared.status,
					headers: headersObj(shared.headers),
				})
			} else if (shared !== result) {
				for (const [k, v] of result.headers) shared.headers.set(k, v)
				dbg(trace, "MW merged chain Response headers into shared", {
					status: shared.status,
					headers: headersObj(shared.headers),
				})
			}

			// Return a brand-new instance
			return cloneWithExtraHeaders(shared, {}, trace)
		}

		const final = await finalNext()
		dbg(trace, "MW returning shared final", {
			status: final.status,
			headers: headersObj(final.headers),
		})
		return final
	}
}

// ---------- loader ----------
export async function loadFunctions(app, options = {}) {
	// Support both 'functionsDir' and 'baseDir' (you passed baseDir)
	const baseDir = (options.functionsDir || options.baseDir || "../functions")
		.replace(/\\/g, "/")
		.replace(/\/+$/, "")
	const modules = options.modules
	if (!modules || typeof modules !== "object") {
		throw new Error(
			"loadFunctions: options.modules is required. Pass import.meta.glob('<functionsDir>/**/*.{js,ts}', { eager: false })."
		)
	}

	// *** GLOBAL WRAPPER registered FIRST so it wraps EVERYTHING ***
	app.use("/*", async (c, next) => {
		const trace = c.get?.("__trace_id__") || randId()
		c.set?.("__trace_id__", trace)
		dbg(trace, "GLOBAL wrap (pre)")

		// Baseline dev CORS via Hono's header api (like official cors())
		// if (FORCE_CORS) {
		// 	setHeadersOnContext(c, {
		// 		"Access-Control-Allow-Origin": "*",
		// 		"Access-Control-Max-Age": "86400",
		// 		// Uncomment for fully permissive dev CORS:
		// 		// "Access-Control-Allow-Headers": "*",
		// 		// "Access-Control-Allow-Methods": "*",
		// 		// "Access-Control-Expose-Headers": "*",
		// 	})
		// 	ensureVaryOrigin(c)
		// }

		const res = await next()

		// Prefer shared if any middleware created it; otherwise wrap result now.
		let shared = c.get?.("__cf_mutable_response__")
		shared = shared ? shared : toMutableResponse(res, trace)

		// Make sure trace header is present both paths
		c.header("X-Trace-Id", trace)
		const extraHeaders = {
			"X-Trace-Id": trace,
			// ...(FORCE_CORS
			// 	? {
			// 			"Access-Control-Allow-Origin":
			// 				c.res.headers.get("Access-Control-Allow-Origin") || "*",
			// 			"Access-Control-Max-Age":
			// 				c.res.headers.get("Access-Control-Max-Age") || "86400",
			// 	  }
			// 	: {}),
		}

		const finalRes = cloneWithExtraHeaders(shared, extraHeaders, trace)
		dbg(trace, "GLOBAL wrap (post) returning FINAL", {
			status: finalRes.status,
			headers: headersObj(finalRes.headers),
		})
		return finalRes
	})

	// Collect modules
	const all = []
	for (const [filepath, lazy] of Object.entries(modules)) {
		const mod = await lazy()
		const { routes, isMiddleware } = filepathToRoutes(filepath, baseDir)

		const handlers = []
		for (const name of Object.keys(mod)) {
			const method = getMethodFromExportName(name)
			if (!method) continue
			const exported = mod[name]
			if (typeof exported === "function" || Array.isArray(exported))
				handlers.push({ method, exported })
		}
		if (
			handlers.length === 0 &&
			(typeof mod.default === "function" || Array.isArray(mod.default))
		) {
			handlers.push({ method: "ALL", exported: mod.default })
		}
		if (handlers.length === 0) continue

		all.push({ filepath, routes, isMiddleware, handlers })
	}

	// PASS 1: _middleware onRequest (ALL)
	const mwAll = []
	for (const entry of all) {
		if (!entry.isMiddleware) continue
		for (const { path, arrayParams } of entry.routes) {
			const mwRoute = path === "/" ? "/*" : `${path}/*`
			const allH = entry.handlers.find((h) => h.method === "ALL")
			if (allH)
				mwAll.push({
					mwRoute,
					depth: mwRoute.split("/").length,
					handler: makeMiddlewareHandler(allH.exported, arrayParams),
					file: entry.filepath,
				})
		}
	}
	mwAll.sort((a, b) => a.depth - b.depth)
	for (const m of mwAll) {
		dbg(null, "REGISTER middleware (ALL)", {
			route: m.mwRoute,
			depth: m.depth,
			file: m.file,
		})
		app.use(m.mwRoute, m.handler)
	}

	// PASS 2: method-specific _middleware; non-middleware files as routes.
	for (const entry of all) {
		for (const { path, arrayParams } of entry.routes) {
			if (entry.isMiddleware) {
				const mwRoute = path === "/" ? "/*" : `${path}/*`
				for (const { method, exported } of entry.handlers) {
					if (method === "ALL") continue
					const mw = makeMiddlewareHandler(exported, arrayParams)
					dbg(null, "REGISTER middleware (METHOD)", {
						method,
						route: mwRoute,
						file: entry.filepath,
					})
					app.use(mwRoute, async (c, next) => {
						const reqMethod = (
							c.req?.method ||
							c.req?.raw?.method ||
							""
						).toUpperCase()
						const trace = c.get?.("__trace_id__") || randId()
						c.set?.("__trace_id__", trace)
						if (reqMethod === method) {
							dbg(trace, `gate: ${method} matches -> run`)
							return mw(c, next)
						}
						dbg(trace, `gate: ${method} does not match (${reqMethod}) -> skip`)
						return next()
					})
				}
			} else {
				for (const { method, exported } of entry.handlers) {
					const wrapped = makeRouteHandler(exported, arrayParams)
					if (method === "ALL") {
						dbg(null, "REGISTER route (ALL)", { path, file: entry.filepath })
						app.all(path, wrapped)
					} else {
						const fn = app[method.toLowerCase()]
						if (typeof fn !== "function")
							throw new Error(
								`Unsupported HTTP method "${method}" on route "${path}" for ${entry.filepath}`
							)
						dbg(null, "REGISTER route (METHOD)", {
							method,
							path,
							file: entry.filepath,
						})
						fn.call(app, path, wrapped)
					}
				}
			}
		}
	}
}
