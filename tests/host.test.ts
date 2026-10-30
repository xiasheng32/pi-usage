import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piUsage from "../extensions/index.ts";
import { FastCatalog } from "../src/codex/fast-catalog.ts";
import { FAST_ENTRY, FastModeController } from "../src/codex/fast-mode.ts";

process.env.PI_OFFLINE = "1";
const syntheticToken = "synthetic." + Buffer.from(JSON.stringify({
	"https://api.openai.com/auth": { chatgpt_account_id: "synthetic-host-account" },
})).toString("base64url") + ".synthetic";

for (const transport of ["sse", "websocket"] as const) {
	test(`Pi SDK and ExtensionRunner drive ${transport} off → on → off with synthetic OAuth`, { timeout: 15_000 }, async (t) => {
		const directory = await mkdtemp(join(tmpdir(), "pi-codex-host-"));
		t.after(() => rm(directory, { recursive: true, force: true }));
		t.mock.method(FastCatalog.prototype, "read", async () => ({ kind: "supported" as const }));
		t.mock.method(FastCatalog.prototype, "readForAuth", async () => ({ kind: "supported" as const }));
		const transforms = t.mock.method(FastModeController.prototype, "transform");
		const sent: Record<string, unknown>[] = [];
		const observed: unknown[] = [];
		const reported: unknown[] = [];
		const errors: unknown[] = [];
		const responseEvents = () => [
			{ type: "response.created", response: { id: `synthetic-host-${sent.length}`, status: "in_progress" } },
			{ type: "response.completed", response: { id: `synthetic-host-${sent.length}`, status: "completed", service_tier: "default",
				usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 }, output: [] } },
		];
		t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
			assert.equal(transport, "sse", "WebSocket must not silently fall back to HTTP");
			assert.equal(new URL(String(url)).origin, "https://chatgpt.com");
			assert.ok(new URL(String(url)).pathname.endsWith("/responses"), "no auth/catalog/quota network path is permitted");
			const raw = new Headers(init?.headers).get("content-encoding") === "zstd"
				? zstdDecompressSync(Buffer.from(init!.body as Uint8Array)).toString("utf8") : String(init?.body);
			sent.push(JSON.parse(raw) as Record<string, unknown>);
			return new Response(responseEvents().map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
				headers: { "content-type": "text/event-stream" },
			});
		});
		class SyntheticSocket extends EventTarget {
			readyState = 0;
			constructor(url: string) {
				super();
				assert.equal(new URL(url).hostname, "chatgpt.com");
				queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); });
			}
			send(value: string): void {
				sent.push(JSON.parse(value) as Record<string, unknown>);
				setImmediate(() => { for (const event of responseEvents()) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) })); });
			}
			close(): void { this.readyState = 3; }
		}
		if (transport === "websocket") {
			const original = globalThis.WebSocket;
			globalThis.WebSocket = SyntheticSocket as unknown as typeof WebSocket;
			t.after(() => { globalThis.WebSocket = original; });
		}
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("openai-codex", async () => ({ type: "oauth", access: syntheticToken,
			refresh: "synthetic-refresh", expires: Date.now() + 86400_000 }));
		const modelsStore = new InMemoryModelsStore();
		const seed = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore, allowModelNetwork: false });
		const template = seed.getModels("openai-codex")[0]!;
		await modelsStore.write("openai-codex", { lastModified: Number.MAX_SAFE_INTEGER, models: [...seed.getModels("openai-codex"),
			{ ...template, id: "gpt-6.1-terra", name: "Synthetic cached Terra" }] });
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore, allowModelNetwork: false });
		const before = runtime.getModels("openai-codex");
		const model = before.find((candidate) => candidate.id === "gpt-6.1-terra");
		assert.ok(model, "installed host must expose a built-in Codex subscription model");
		assert.equal(runtime.isUsingOAuth("openai-codex"), true);
		const settings = SettingsManager.inMemory({ transport, cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } });
		const observer = (pi: ExtensionAPI) => {
			pi.on("before_provider_request", (event) => { observed.push(event.payload); });
			pi.on("provider_stream_event", (event) => { reported.push(event.data); });
		};
		const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, disabledBuiltinExtensions: ["mcp"],
			extensionFactories: [piUsage, observer] });
		await loader.reload();
		assert.deepEqual(runtime.getModels("openai-codex"), before, "factory-only enumeration preserves the catalog");
		const manager = SessionManager.inMemory(directory);
		const { session, extensionsResult } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime,
			model, thinkingLevel: "high", noTools: "all", settingsManager: settings, sessionManager: manager, resourceLoader: loader });
		t.after(() => session.dispose());
		assert.deepEqual(extensionsResult.errors, []);
		await session.bindExtensions({ mode: "rpc", onError: (error) => { errors.push(error); } });
		assert.deepEqual(runtime.getModels("openai-codex"), before, "session installation preserves cached models and metadata");
		assert.equal(session.model?.id, "gpt-6.1-terra");
		assert.equal(typeof runtime.getProvider("openai-codex")?.refreshModels, "function");
		await session.prompt("Synthetic initial request");
		assert.equal(sent.length, 1);
		await session.prompt("/fast on");
		assert.equal(sent.length, 1, "slash command must not become a model request");
		await session.prompt("Synthetic Fast request");
		await session.prompt("/fast off");
		assert.equal(sent.length, 2, "off command must not become a model request");
		await session.prompt("Synthetic standard request");
		assert.deepEqual(sent.map((body) => body.service_tier), ["default", "priority", "default"]);
		assert.deepEqual(observed.map((body) => (body as Record<string, unknown>).service_tier), [undefined, undefined, undefined],
			"payload observers run before the final request-bound tier decision");
		assert.equal(reported.filter((event) => (event as { type: string }).type === "response.completed").length, 3);
		assert.deepEqual(manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === FAST_ENTRY)
			.map((entry) => (entry as { data: { enabled: boolean } }).data.enabled), [true, false]);
		for (let reload = 0; reload < 2; reload++) {
			await session.reload({ beforeSessionStart: () => {
				assert.equal(runtime.getRegisteredNativeProvider("openai-codex"), undefined, "reload removes the old controller wrapper");
				assert.deepEqual(runtime.getModels("openai-codex"), before);
			} });
			assert.deepEqual(runtime.getModels("openai-codex"), before);
			await session.prompt("/fast on");
			await session.prompt("Synthetic post-reload request");
			assert.equal(sent.at(-1)?.service_tier, "priority");
		}
		assert.equal(transforms.mock.callCount(), sent.length, "exactly one Fast transform per request across reloads");
		assert.deepEqual(errors, []);
	});
}

for (const transport of ["sse", "websocket"] as const) {
	for (const stage of ["payload", "headers", "catalog"] as const) {
		for (const supportsA of [false, true]) {
			test(`SDK ${transport} binds Fast to A/${supportsA ? "priority" : "default"} after login changes in ${stage}`, { timeout: 15_000 }, async (t) => {
				const previousOffline = process.env.PI_OFFLINE;
				process.env.PI_OFFLINE = "0";
				t.after(() => { if (previousOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previousOffline; });
				let now = Date.parse("2026-10-16T12:00:00Z");
				t.mock.method(Date, "now", () => now);
				const directory = await mkdtemp(join(tmpdir(), "pi-codex-host-identity-"));
				t.after(() => rm(directory, { recursive: true, force: true }));
				const credentials = new InMemoryCredentialStore();
				const token = (account: string) => `synthetic.${Buffer.from(JSON.stringify({
					"https://api.openai.com/auth": { chatgpt_account_id: account },
				})).toString("base64url")}.synthetic`;
				const login = (account: string) => credentials.modify("openai-codex", async () => ({
					type: "oauth", access: token(account), refresh: "synthetic-refresh", expires: now + 86400_000,
				}));
				await login("A");
				let armed = false;
				let modelId = "";
				const sent: { account: string | null; tier: unknown }[] = [];
				const directoryAccounts: (string | null)[] = [];
				const responseEvents = () => [
					{ type: "response.created", response: { id: "synthetic-identity", status: "in_progress" } },
					{ type: "response.completed", response: { id: "synthetic-identity", status: "completed", service_tier: "default",
						usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 }, output: [] } },
				];
				t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
					const parsed = new URL(String(url));
					assert.equal(parsed.origin, "https://chatgpt.com");
					const account = new Headers(init?.headers).get("chatgpt-account-id");
					if (parsed.pathname.endsWith("/models")) {
						directoryAccounts.push(account);
						if (armed && stage === "catalog") await login("B");
						return Response.json({ models: [{ slug: modelId,
							service_tiers: (account === "A" ? supportsA : !supportsA) ? [{ id: "priority" }] : [],
						}] });
					}
					assert.equal(transport, "sse", "WebSocket must not fall back to HTTP");
					assert.ok(parsed.pathname.endsWith("/responses"));
					const raw = new Headers(init?.headers).get("content-encoding") === "zstd"
						? zstdDecompressSync(Buffer.from(init!.body as Uint8Array)).toString("utf8") : String(init?.body);
					sent.push({ account, tier: (JSON.parse(raw) as Record<string, unknown>).service_tier });
					return new Response(responseEvents().map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
						headers: { "content-type": "text/event-stream" },
					});
				});
				class SyntheticSocket extends EventTarget {
					readyState = 0;
					private readonly account: string | null;
					constructor(url: string, options: { headers: Record<string, string> }) {
						super();
						assert.equal(new URL(url).hostname, "chatgpt.com");
						this.account = new Headers(options.headers).get("chatgpt-account-id");
						queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); });
					}
					send(value: string): void {
						sent.push({ account: this.account, tier: (JSON.parse(value) as Record<string, unknown>).service_tier });
						setImmediate(() => { for (const event of responseEvents()) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) })); });
					}
					close(): void { this.readyState = 3; }
				}
				if (transport === "websocket") {
					const original = globalThis.WebSocket;
					globalThis.WebSocket = SyntheticSocket as unknown as typeof WebSocket;
					t.after(() => { globalThis.WebSocket = original; });
				}
				const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
				const model = runtime.getModels("openai-codex").find((candidate) => candidate.api === "openai-codex-responses");
				assert.ok(model);
				modelId = model.id;
				const settings = SettingsManager.inMemory({ transport, cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } });
				const switcher = (pi: ExtensionAPI) => {
					pi.on("before_provider_request", async () => { if (armed && stage === "payload") await login("B"); });
					pi.on("before_provider_headers", async () => { if (armed && stage === "headers") await login("B"); });
				};
				const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings,
					noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, disabledBuiltinExtensions: ["mcp"],
					extensionFactories: [switcher, piUsage] });
				await loader.reload();
				const manager = SessionManager.inMemory(directory);
				manager.appendCustomEntry(FAST_ENTRY, { enabled: true, sessionId: manager.getSessionId() });
				const { session, extensionsResult } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime,
					model, thinkingLevel: "high", noTools: "all", settingsManager: settings, sessionManager: manager, resourceLoader: loader });
				t.after(() => session.dispose());
				assert.deepEqual(extensionsResult.errors, []);
				const errors: unknown[] = [];
				await session.bindExtensions({ mode: "rpc", onError: (error) => { errors.push(error); } });
				armed = true;
				if (stage === "catalog") now += 6 * 60_000;
				await session.prompt("Synthetic account-bound Fast request");
				assert.deepEqual(sent, [{ account: "A", tier: supportsA ? "priority" : "default" }]);
				assert.ok(directoryAccounts.includes("A"));
				assert.deepEqual(errors, []);
			});
		}
	}
}
