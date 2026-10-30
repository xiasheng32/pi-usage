import assert from "node:assert/strict";
import { test } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import type { Model, Provider, RefreshModelsContext } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { createFastProvider } from "../src/codex/fast-provider.ts";
import { FastModeController } from "../src/codex/fast-mode.ts";

const model: Model<"openai-codex-responses"> = {
	id: "gpt-6.1-sol", name: "Synthetic Codex", provider: "openai-codex", api: "openai-codex-responses",
	baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000,
};
const token = (account: string) => "synthetic." + Buffer.from(JSON.stringify({
	"https://api.openai.com/auth": { chatgpt_account_id: account },
})).toString("base64url") + ".synthetic";
const context = normalizeContext({ systemPrompt: "Synthetic", messages: [{ role: "user", content: "Synthetic", timestamp: 0 }] });
const events = [
	{ type: "response.created", response: { id: "synthetic-response", status: "in_progress" } },
	{ type: "response.completed", response: { id: "synthetic-response", status: "completed", service_tier: "default",
		usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 }, output: [] } },
];
function body(init?: RequestInit): Record<string, unknown> {
	return JSON.parse(new Headers(init?.headers).get("content-encoding") === "zstd"
		? zstdDecompressSync(Buffer.from(init!.body as Uint8Array)).toString("utf8") : String(init?.body));
}
function sse(): Response {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream", "x-synthetic": "response" },
	});
}

// Native transport is exercised with synthetic JWTs and an injected HTTP implementation only.
for (const method of ["stream", "streamSimple"] as const) {
	test(`${method} captures request auth before hooks and preserves native options, instrumentation and replacements`, async () => {
		const a = token("synthetic-A"); let current = a; let prepared = 0; let transformed = 0;
		let responses = 0; let observed = 0; let sent: Record<string, unknown> | undefined;
		const controller = new AbortController();
		const fast = new FastModeController(); fast.setEnabled(true); fast.setCapability({ kind: "supported" });
		const provider = createFastProvider(openaiCodexProvider(), (capturedModel, apiKey, signal) => {
			prepared++; assert.equal(apiKey, a); assert.equal(current, a);
			assert.equal(signal, controller.signal); assert.equal(capturedModel, model);
			return async (payload) => {
				transformed++; assert.equal(current, token("synthetic-B")); assert.equal(apiKey, a);
				const data = payload as Record<string, unknown>;
				assert.equal(data.marker, "original-hook-replacement");
				assert.equal((data.reasoning as { effort: string }).effort, "high");
				if (method === "stream") {
					assert.equal(data.service_tier, "flex");
					assert.deepEqual(data.text, { verbosity: "low" });
				}
				// A's local unsupported result must override B's shared/UI supported capability.
				return fast.transform(payload, capturedModel, true, { kind: "unsupported" });
			};
		});
		const options = {
			apiKey: a, signal: controller.signal, transport: "sse" as const, maxRetries: 0, timeoutMs: 1000,
			sessionId: `synthetic-${method}`, headers: { "x-synthetic-request": "preserved" },
			fetch: (async (_url, init) => {
				assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${a}`);
				assert.equal(new Headers(init?.headers).get("chatgpt-account-id"), "synthetic-A");
				assert.equal(new Headers(init?.headers).get("x-synthetic-request"), "preserved");
				assert.ok(init?.signal); sent = body(init); return sse();
			}) as typeof fetch,
			onPayload: async (payload: unknown, nativeModel: Model<string>) => {
				assert.equal(prepared, 1); assert.equal(transformed, 0); assert.equal(nativeModel, model);
				await Promise.resolve(); current = token("synthetic-B");
				return { ...payload as Record<string, unknown>, marker: "original-hook-replacement" };
			},
			onResponse: async (response: { status: number; headers: Record<string, string> }) => {
				responses++; assert.equal(response.status, 200); assert.equal(response.headers["x-synthetic"], "response");
			},
			onProviderStreamEvent: async (event: unknown) => { observed++; assert.ok(event); },
		};
		const originalHook = options.onPayload;
		const result = await (method === "stream"
			? provider.stream(model, context, { ...options, reasoningEffort: "high", serviceTier: "flex", textVerbosity: "low" })
			: provider.streamSimple(model, context, { ...options, reasoning: "high" })).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(sent?.service_tier, "default"); assert.equal(sent?.marker, "original-hook-replacement");
		assert.equal(prepared, 1); assert.equal(transformed, 1); assert.equal(responses, 1); assert.equal(observed, events.length);
		assert.equal(options.apiKey, a); assert.equal(options.onPayload, originalHook);
		assert.equal(JSON.stringify(sent).includes(a), false);
	});
}

test("undefined preserves the previous payload while null is a real replacement", async () => {
	for (const first of ["undefined", "replace", "null"] as const) {
		let seen: unknown; let sent: Record<string, unknown> | undefined;
		const provider = createFastProvider(openaiCodexProvider(), () => async (payload) => {
			seen = payload;
			if (first === "null") return { model: model.id, input: [], marker: "from-null" };
			return undefined;
		});
		const result = await provider.stream(model, context, {
			apiKey: token("synthetic-A"), transport: "sse", maxRetries: 0,
			onPayload: (payload) => first === "null" ? null : first === "replace" ? { ...payload as object, marker: "replacement" } : undefined,
			fetch: async (_url, init) => { sent = body(init); return sse(); },
		}).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		if (first === "null") { assert.equal(seen, null); assert.equal(sent?.marker, "from-null"); }
		else { assert.deepEqual(sent, JSON.parse(JSON.stringify(seen))); assert.equal(sent?.model, model.id); }
	}
});

test("concurrent stream and streamSimple requests retain independent auth-bound closures", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const captured: string[] = []; const seen = new Map<string, string>();
	const provider = createFastProvider(openaiCodexProvider(), (_model, apiKey) => {
		captured.push(apiKey!);
		return async (payload) => {
			await gate;
			return { ...payload as object, service_tier: apiKey === token("synthetic-A") ? "default" : "priority" };
		};
	});
	const options = (account: string) => ({
		apiKey: token(account), transport: "sse" as const, maxRetries: 0,
		fetch: (async (_url, init) => {
			const auth = new Headers(init?.headers).get("authorization")!;
			seen.set(auth, String(body(init).service_tier)); return sse();
		}) as typeof fetch,
	});
	const a = provider.stream(model, context, options("synthetic-A"));
	const b = provider.streamSimple(model, context, options("synthetic-B"));
	assert.deepEqual(captured, [token("synthetic-A"), token("synthetic-B")]); release();
	for (const result of await Promise.all([a.result(), b.result()])) assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.equal(seen.get(`Bearer ${token("synthetic-A")}`), "default");
	assert.equal(seen.get(`Bearer ${token("synthetic-B")}`), "priority");
});

test("native provider metadata and methods remain available without legacy registration", () => {
	const builtin = openaiCodexProvider(); const provider = createFastProvider(builtin, () => async () => undefined);
	assert.deepEqual(provider.getModels(), builtin.getModels());
	assert.equal(provider.id, builtin.id); assert.equal(provider.name, builtin.name); assert.equal(provider.baseUrl, builtin.baseUrl);
	assert.deepEqual(Object.keys(provider.auth), Object.keys(builtin.auth));
	for (const key of Object.keys(builtin) as (keyof typeof builtin)[]) {
		assert.equal(typeof provider[key], typeof builtin[key], key);
	}
});

test("live catalog, refresh publication, auth and prototype methods retain the native receiver", async () => {
	const native = openaiCodexProvider();
	let models = [model];
	let received: RefreshModelsContext | undefined;
	const prototype = {
		getModels(this: Provider) { assert.equal(this, original); return models; },
		getAllModels(this: Provider) { assert.equal(this, original); return models; },
		filterModels(this: Provider, entries: readonly Model<string>[]) { assert.equal(this, original); return entries; },
		filterAllModels(this: Provider, entries: readonly Model<string>[]) { assert.equal(this, original); return entries; },
		async refreshModels(this: Provider, context: RefreshModelsContext) {
			assert.equal(this, original); received = context;
			if (!context.signal.aborted) await context.publish({ update: () => { models = [...models, { ...model, id: "synthetic-later" }]; } });
		},
	};
	const original = Object.assign(Object.create(prototype), native) as Provider;
	// Exercise non-enumerable/prototype methods, not only object-literal closures.
	for (const key of Object.keys(prototype)) Reflect.deleteProperty(original, key);
	const provider = createFastProvider(original, () => async () => undefined);
	assert.equal(provider.auth, original.auth);
	assert.equal(provider.getModels(), models);
	models = [...models, { ...model, id: "gpt-6.1-terra", name: "Synthetic Terra" }];
	assert.equal(provider.getModels(), models);
	assert.equal(provider.getAllModels!(), models);
	assert.equal(provider.filterModels!(models, undefined), models);
	assert.equal(provider.filterAllModels!(models, undefined), models);
	const context: RefreshModelsContext = { allowNetwork: false, signal: new AbortController().signal,
		publish: async ({ update }) => { update?.(); return true; } };
	await provider.refreshModels!(context);
	assert.equal(received, context, "pass publish, signal, stored and refresh policy unchanged");
	assert.equal(provider.getModels(), models);
	assert.ok(models.some((entry) => entry.id === "synthetic-later"));
	const before = models;
	await provider.refreshModels!({ ...context, signal: AbortSignal.abort() });
	assert.equal(provider.getModels(), before);
});

test("request-local supported capability overrides shared unsupported UI capability", () => {
	const fast = new FastModeController(); fast.setEnabled(true); fast.setCapability({ kind: "unsupported" });
	assert.equal((fast.transform({ model: model.id, input: [] }, model, true, { kind: "supported" }) as { service_tier: string }).service_tier, "priority");
	assert.equal(fast.capability.kind, "unsupported");
});
