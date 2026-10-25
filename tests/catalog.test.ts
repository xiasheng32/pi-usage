import assert from "node:assert/strict";
import { test } from "node:test";
import { FastCatalog, parseFastCatalog } from "../src/codex/fast-catalog.ts";
import type { ProviderAuth } from "../src/codex/quota.ts";

const model = { id: "gpt-6.1-sol", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" };
const token = (account = "synthetic-A", suffix = "synthetic") => "synthetic." + Buffer.from(JSON.stringify({
	"https://api.openai.com/auth": { chatgpt_account_id: account },
})).toString("base64url") + "." + suffix;
const credential = (account = "synthetic-A", suffix = "synthetic"): ProviderAuth => ({ source: "OAuth", auth: { apiKey: token(account, suffix) } });
const directory = { models: [{ slug: model.id, service_tiers: [{ id: "priority" }] },
	{ slug: "future-model", additional_speed_tiers: ["fast"] }, { slug: "standard-only", service_tiers: [] }] };
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
function fixture(options: { fetch?: typeof fetch; auth?: () => Promise<ProviderAuth | undefined>; offline?: boolean; timeoutMs?: number } = {}) {
	let now = 1000;
	let requests = 0;
	let authCalls = 0;
	const catalog = new FastCatalog({ version: "1.2.0", now: () => now, offline: options.offline, timeoutMs: options.timeoutMs,
		resolveAuth: async () => { authCalls++; return options.auth ? options.auth() : credential(); },
		fetch: async (url, init) => {
			requests++;
			assert.equal(String(url), "https://chatgpt.com/backend-api/codex/models?client_version=1.2.0");
			assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error");
			assert.ok(init?.signal);
			return options.fetch ? options.fetch(url, init) : Response.json(directory);
		},
	});
	return { catalog, read: (candidate = model) => catalog.read(candidate, true), advance: (ms: number) => { now += ms; },
		get requests() { return requests; }, get authCalls() { return authCalls; } };
}

test("directory distinguishes supported, legacy, unsupported, absent metadata and missing models", async () => {
	const parsed = parseFastCatalog({ models: [...directory.models, { slug: "unknown-model" }] });
	assert.equal(parsed.get(model.id)?.kind, "supported");
	assert.equal(parsed.get("future-model")?.kind, "supported");
	assert.equal(parsed.get("standard-only")?.kind, "unsupported");
	assert.equal(parsed.get("unknown-model")?.kind, "unknown");
	for (const malformed of [{}, { models: null }, { models: [null] }, { models: [{ slug: "" }] },
		{ models: [{ slug: "A" }, { slug: "A" }] }, { models: [{ slug: "A", service_tiers: "priority" }] },
		{ models: [{ slug: "A", service_tiers: [{}] }] }, { models: [{ slug: "A", additional_speed_tiers: [null] }] }]) {
		assert.throws(() => parseFastCatalog(malformed));
	}
	const f = fixture();
	assert.equal((await f.read({ ...model, id: "not-in-directory" })).kind, "unknown");
});

test("official OAuth only, with offline and unrelated models never even resolving auth", async () => {
	const f = fixture();
	for (const candidate of [{ ...model, provider: "openai" }, { ...model, api: "openai-responses" },
		{ ...model, baseUrl: "https://relay.example/backend-api" }, { ...model, baseUrl: "invalid" }]) {
		assert.equal((await f.read(candidate)).kind, "unknown");
	}
	assert.equal((await f.catalog.read(model, false)).kind, "unknown");
	assert.equal(f.authCalls, 0); assert.equal(f.requests, 0);
	const offline = fixture({ offline: true });
	assert.match((await offline.read()).reason!, /离线/);
	assert.equal(offline.authCalls, 0); assert.equal(offline.requests, 0);
	for (const auth of [undefined, { source: "API key", auth: { apiKey: token() } }, { source: "OAuth", auth: { apiKey: "invalid" } }]) {
		const invalid = fixture({ auth: async () => auth });
		assert.equal((await invalid.read()).kind, "unknown"); assert.equal(invalid.requests, 0);
	}
});

test("requests route the current account, cache for five minutes across models and refresh at expiry", async () => {
	const f = fixture({ fetch: async (_url, init) => {
		const headers = new Headers(init?.headers);
		assert.equal(headers.get("authorization"), `Bearer ${token()}`);
		assert.equal(headers.get("chatgpt-account-id"), "synthetic-A");
		return Response.json(directory);
	} });
	assert.equal((await f.read()).kind, "supported");
	f.advance(299_999);
	assert.equal((await f.read({ ...model, id: "future-model" })).kind, "supported");
	assert.equal((await f.read({ ...model, id: "standard-only" })).kind, "unsupported");
	assert.equal(f.requests, 1);
	f.advance(1); await f.read(); assert.equal(f.requests, 2);
});

test("parallel reads share a directory request", async () => {
	const response = deferred<Response>();
	const f = fixture({ fetch: async () => response.promise });
	const a = f.read(); const b = f.read({ ...model, id: "future-model" });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(f.requests, 1);
	response.resolve(Response.json(directory));
	assert.equal((await a).kind, "supported"); assert.equal((await b).kind, "supported");
});

test("account and token changes discard cached capabilities and never expose routing secrets", async () => {
	let auth = credential();
	const f = fixture({ auth: async () => auth, fetch: async (_url, init) => {
		const account = new Headers(init?.headers).get("chatgpt-account-id");
		return Response.json(account === "synthetic-A" ? directory : { models: [{ slug: model.id, service_tiers: [] }] });
	} });
	assert.equal((await f.read()).kind, "supported");
	auth = credential("synthetic-B"); assert.equal((await f.read()).kind, "unsupported");
	auth = credential("synthetic-B", "rotated"); await f.read(); assert.equal(f.requests, 3);
	assert.ok(!JSON.stringify(await f.read()).includes("synthetic-B"));
	f.catalog.reset(); await f.read(); assert.equal(f.requests, 4);
});

test("failures use thirty-second backoff, then retry even after a synchronous fetch throw", async () => {
	let fails = true;
	const f = fixture({ fetch: (() => { if (fails) throw new Error(token()); return Promise.resolve(Response.json(directory)); }) as typeof fetch });
	const failure = await f.read(); assert.equal(failure.kind, "unknown");
	assert.ok(!JSON.stringify(failure).includes(token()));
	fails = false; f.advance(29_999); await f.read({ ...model, id: "future-model" }); assert.equal(f.requests, 1);
	f.advance(1); assert.equal((await f.read()).kind, "supported"); assert.equal(f.requests, 2);
});

test("expired advertisements become unknown on HTTP or malformed directory failure", async () => {
	for (const invalid of [() => new Response("secret", { status: 401 }), () => new Response("secret", { status: 429 }),
		() => Response.json({ models: [{ slug: model.id, service_tiers: "priority" }] })]) {
		let good = true;
		const f = fixture({ fetch: async () => good ? Response.json(directory) : invalid() });
		assert.equal((await f.read()).kind, "supported"); good = false; f.advance(300_000);
		assert.equal((await f.read()).kind, "unknown");
		await f.read(); assert.equal(f.requests, 2);
	}
});

test("directory retains capability metadata only and enforces an eight-MiB body limit", async () => {
	const normal = fixture({ fetch: async () => Response.json({ models: [{ ...directory.models[0], base_instructions: "private".repeat(10_000) }] }) });
	assert.deepEqual(await normal.read(), { kind: "supported" });
	const large = fixture({ fetch: async () => new Response("x".repeat(8 * 1024 * 1024 + 1)) });
	assert.equal((await large.read()).kind, "unknown");
});

test("reset cancels uncooperative transports and ignores their late directory result", async () => {
	const held = deferred<Response>(); let first = true;
	const f = fixture({ fetch: async () => { if (first) { first = false; return held.promise; } return Response.json({ models: [] }); } });
	const pending = f.read(); await new Promise((resolve) => setImmediate(resolve)); f.catalog.reset();
	assert.equal((await pending).kind, "unknown");
	held.resolve(Response.json(directory));
	assert.equal((await f.read()).kind, "unknown"); assert.equal(f.requests, 2);
});

test("newer auth identity wins over delayed previous-account authentication", async () => {
	const held = deferred<ProviderAuth | undefined>(); let calls = 0;
	const f = fixture({ auth: async () => ++calls === 1 ? held.promise : credential("synthetic-B") });
	const old = f.read(); assert.equal((await f.read()).kind, "supported");
	held.resolve(credential()); assert.equal((await old).kind, "unknown"); assert.equal(f.requests, 1);
});

test("login and logout during directory I/O are revalidated even without another read", async () => {
	for (const next of [credential("synthetic-B"), undefined]) {
		let auth: ProviderAuth | undefined = credential();
		const held = deferred<Response>();
		const f = fixture({ auth: async () => auth, fetch: async () => held.promise });
		const pending = f.read(); await new Promise((resolve) => setImmediate(resolve));
		auth = next; held.resolve(Response.json(directory));
		assert.equal((await pending).kind, "unknown");
	}
});

test("readForAuth never resolves UI auth and binds both capability directions to the supplied token", async () => {
	for (const aSupported of [false, true]) {
		const f = fixture({ auth: async () => { throw new Error("UI resolver must not run"); }, fetch: async (_url, init) => {
			const headers = new Headers(init?.headers);
			const a = headers.get("chatgpt-account-id") === "synthetic-A";
			assert.equal(headers.get("authorization"), `Bearer ${token(a ? "synthetic-A" : "synthetic-B")}`);
			return Response.json({ models: [{ slug: model.id, service_tiers: a === aSupported ? [{ id: "priority" }] : [] }] });
		} });
		// Simulate a UI/cache already on B, then an A request whose auth was captured earlier.
		assert.equal((await f.catalog.readForAuth(model, true, credential("synthetic-B"))).kind, aSupported ? "unsupported" : "supported");
		assert.equal((await f.catalog.readForAuth(model, true, credential())).kind, aSupported ? "supported" : "unsupported");
		assert.equal((await f.catalog.readForAuth(model, true, credential())).kind, aSupported ? "supported" : "unsupported");
		assert.equal(f.requests, 2); assert.equal(f.authCalls, 0);
	}
});

test("readForAuth does not revalidate against UI account changes after directory I/O", async () => {
	let current = credential();
	const held = deferred<Response>();
	const f = fixture({ auth: async () => current, fetch: async () => held.promise });
	const pending = f.catalog.readForAuth(model, true, current);
	current = credential("synthetic-B"); held.resolve(Response.json(directory));
	assert.equal((await pending).kind, "supported"); assert.equal(f.authCalls, 0);
});

test("readForAuth isolates concurrent identities, including same-account token rotation", async () => {
	for (const next of [credential("synthetic-B"), credential("synthetic-A", "rotated")]) {
		const held = deferred<Response>(); let calls = 0;
		const f = fixture({ fetch: async () => ++calls === 1 ? held.promise : Response.json({ models: [{ slug: model.id, service_tiers: [] }] }) });
		const a = f.catalog.readForAuth(model, true, credential());
		await new Promise((resolve) => setImmediate(resolve));
		const b = f.catalog.readForAuth(model, true, next);
		assert.equal((await a).kind, "unknown"); assert.equal((await b).kind, "unsupported");
		held.resolve(Response.json(directory));
		assert.equal((await f.catalog.readForAuth(model, true, next)).kind, "unsupported");
		assert.equal(f.requests, 2); assert.equal(f.authCalls, 0);
	}
});

test("readForAuth shares same-identity fetches and honors cache expiry, failure backoff and reset", async () => {
	let fails = false;
	const f = fixture({ fetch: async () => fails ? new Response("private", { status: 401 }) : Response.json(directory) });
	const read = () => f.catalog.readForAuth(model, true, credential());
	assert.deepEqual((await Promise.all([read(), read()])).map((v) => v.kind), ["supported", "supported"]);
	assert.equal(f.requests, 1);
	f.advance(299_999); await read(); assert.equal(f.requests, 1);
	fails = true; f.advance(1); assert.equal((await read()).kind, "unknown");
	fails = false; f.advance(29_999); assert.equal((await read()).kind, "unknown"); assert.equal(f.requests, 2);
	f.advance(1); assert.equal((await read()).kind, "supported"); assert.equal(f.requests, 3);
	f.catalog.reset(); assert.equal((await read()).kind, "supported"); assert.equal(f.requests, 4);
	assert.equal(f.authCalls, 0);
});

test("readForAuth rejects invalid auth and applicability without resolving or fetching", async () => {
	const f = fixture();
	for (const auth of [undefined, { source: "API key", auth: { apiKey: token() } }, credential(""),
		{ source: "OAuth", auth: { apiKey: "invalid" } }]) {
		assert.equal((await f.catalog.readForAuth(model, true, auth)).kind, "unknown");
	}
	assert.equal((await f.catalog.readForAuth(model, false, credential())).kind, "unknown");
	assert.equal((await f.catalog.readForAuth({ ...model, baseUrl: "https://relay.example" }, true, credential())).kind, "unknown");
	const offline = fixture({ offline: true });
	assert.equal((await offline.catalog.readForAuth(model, true, credential())).kind, "unknown");
	assert.equal(f.requests, 0); assert.equal(f.authCalls, 0); assert.equal(offline.requests, 0);
});

test("readForAuth cancellation and reset settle uncooperative fetches and discard late results", async () => {
	for (const cancel of ["signal", "reset"] as const) {
		const held = deferred<Response>(); let calls = 0; let transportSignal: AbortSignal | undefined;
		const controller = new AbortController();
		const f = fixture({ fetch: async (_url, init) => {
			transportSignal = init?.signal ?? undefined;
			return ++calls === 1 ? held.promise : Response.json({ models: [] });
		} });
		const pending = f.catalog.readForAuth(model, true, credential(), controller.signal);
		await new Promise((resolve) => setImmediate(resolve));
		if (cancel === "signal") controller.abort(); else f.catalog.reset();
		assert.equal((await pending).kind, "unknown"); assert.ok(transportSignal?.aborted);
		held.resolve(Response.json(directory));
		assert.equal((await f.catalog.readForAuth(model, true, credential())).kind, "unknown");
		assert.equal(f.requests, 2); assert.equal(f.authCalls, 0);
	}
	const f = fixture(); const controller = new AbortController(); controller.abort();
	assert.equal((await f.catalog.readForAuth(model, true, credential(), controller.signal)).kind, "unknown");
	assert.equal(f.requests, 0);
});

test("readForAuth enforces timeout and eight-MiB directory limit", async () => {
	const large = fixture({ fetch: async () => new Response("x".repeat(8 * 1024 * 1024 + 1)) });
	assert.equal((await large.catalog.readForAuth(model, true, credential())).kind, "unknown");
	const f = fixture({ fetch: () => new Promise<never>(() => {}), timeoutMs: 10 });
	const keepAlive = setTimeout(() => {}, 1000);
	try { assert.equal((await f.catalog.readForAuth(model, true, credential())).kind, "unknown"); }
	finally { clearTimeout(keepAlive); }
	assert.equal(f.authCalls, 0);
});

test("timeouts settle auth and transports that ignore cancellation", async () => {
	const never = new Promise<never>(() => {});
	const auth = fixture({ auth: () => never, timeoutMs: 10 });
	const fetch = fixture({ fetch: () => never, timeoutMs: 10 });
	const keepAlive = setTimeout(() => {}, 1000);
	try { assert.equal((await auth.read()).kind, "unknown"); assert.equal((await fetch.read()).kind, "unknown"); }
	finally { clearTimeout(keepAlive); }
});
