import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai";
import * as sdk from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piUsage from "../extensions/index.ts";

// Optional absolute module URL exercises the installed host without replacing
// dependencies, loading user resources, or writing any real cache/config.
const { ModelRuntime, ModelRegistry } = process.env.PI_USAGE_TEST_HOST
	? await import(process.env.PI_USAGE_TEST_HOST) as typeof sdk : sdk;
process.env.PI_OFFLINE = "1";
type Handler = (event: never, ctx: ExtensionContext) => unknown;

for (const previous of ["builtin", "native", "legacy"] as const) {
	test(`host lifecycle preserves dynamic catalogs and models.json over ${previous}`, async (t) => {
		t.mock.method(globalThis, "fetch", async () => { throw new Error("No live network permitted"); });
		const directory = await mkdtemp(join(tmpdir(), "pi-usage-lifecycle-"));
		t.after(() => rm(directory, { recursive: true, force: true }));
		const modelsStore = new InMemoryModelsStore();
		const credentials = new InMemoryCredentialStore();
		const seed = await ModelRuntime.create({ credentials, modelsStore, modelsPath: null, allowModelNetwork: false });
		const template = seed.getModels("openai-codex")[0]!;
		const terra = { ...template, id: "gpt-6.1-terra", name: "Synthetic Terra" };
		await modelsStore.write("openai-codex", { lastModified: Number.MAX_SAFE_INTEGER, models: [terra] });
		const modelsPath = join(directory, "models.json");
		await writeFile(modelsPath, JSON.stringify({ providers: { "openai-codex": {
			baseUrl: "https://synthetic.invalid/backend-api",
			models: [{ id: "synthetic-configured", name: "Configured", api: template.api,
				reasoning: true, input: ["text"], cost: template.cost, contextWindow: 10000, maxTokens: 1000 }],
			modelOverrides: { "gpt-6.1-terra": { name: "Configured Terra", contextWindow: 123456 } },
		} } }));
		const runtime = await ModelRuntime.create({ credentials, modelsStore, modelsPath, allowModelNetwork: false });
		if (previous === "native") runtime.registerNativeProvider(seed.getProvider("openai-codex")!);
		if (previous === "legacy") runtime.registerProvider("openai-codex", { headers: { "x-synthetic": "legacy" } });
		await runtime.refresh({ allowNetwork: false });
		const registry = new ModelRegistry(runtime);
		const originalNative = registry.getRegisteredNativeProvider("openai-codex");
		const originalLegacy = registry.getRegisteredProviderConfig("openai-codex");
		const snapshot = () => runtime.getAllModels("openai-codex");
		const before = snapshot();
		assert.equal(before.find((model) => model.id === terra.id)?.name, "Configured Terra");
		assert.equal(runtime.getModel("openai-codex", terra.id)?.contextWindow, 123456);
		assert.ok(before.some((model) => model.id === "synthetic-configured"));
		const events = new Map<string, Handler>();
		let registrations = 0;
		const api = {
			on: (name: string, handler: Handler) => { events.set(name, handler); },
			registerCommand: () => {},
			registerProvider: (provider: Provider | string, config?: Parameters<typeof runtime.registerProvider>[1]) => {
				registrations++;
				if (typeof provider === "string") runtime.registerProvider(provider, config!);
				else runtime.registerNativeProvider(provider);
			},
			unregisterProvider: (id: string) => runtime.unregisterProvider(id),
		} as unknown as ExtensionAPI;
		// Initially another provider is selected: Fast must still install for a later switch.
		const ctx = { modelRegistry: registry, mode: "rpc", hasUI: false,
			sessionManager: { getEntries: () => [], getSessionId: () => "synthetic" },
			ui: { notify: () => {} } } as unknown as ExtensionContext;
		const fire = async (name: string) => events.get(name)?.({} as never, ctx);
		for (let cycle = 0; cycle < 3; cycle++) {
			piUsage(api);
			assert.deepEqual(snapshot(), before, "factory enumeration must not register");
			const count = registrations;
			await fire("session_start");
			const installed = registry.getRegisteredNativeProvider("openai-codex");
			await fire("session_start");
			assert.equal(registrations, count + 1, "repeated start must not wrap twice");
			assert.equal(registry.getRegisteredNativeProvider("openai-codex"), installed);
			await runtime.refresh({ allowNetwork: false });
			assert.deepEqual(snapshot(), before);
			assert.equal(typeof registry.getProvider("openai-codex")?.refreshModels, "function");
			const later = { ...terra, id: "synthetic-later", name: "Later refresh" };
			await modelsStore.write("openai-codex", { lastModified: Number.MAX_SAFE_INTEGER, models: [terra, later] });
			await runtime.refresh({ allowNetwork: false, providers: ["openai-codex"] });
			assert.ok(snapshot().some((model) => model.id === later.id), "delegated refresh publishes new models");
			await fire("session_shutdown");
			assert.equal(registry.getRegisteredNativeProvider("openai-codex"), originalNative);
			assert.deepEqual(registry.getRegisteredProviderConfig("openai-codex"), originalLegacy);
			assert.ok(snapshot().some((model) => model.id === later.id));
			await modelsStore.write("openai-codex", { lastModified: Number.MAX_SAFE_INTEGER, models: [terra] });
			await runtime.refresh({ allowNetwork: false });
			assert.deepEqual(snapshot(), before, "reload must not accumulate config layers");
		}
		piUsage(api);
		await fire("session_start");
		const laterOwner = seed.getProvider("openai-codex")!;
		runtime.registerNativeProvider(laterOwner);
		await fire("session_shutdown");
		assert.equal(registry.getRegisteredNativeProvider("openai-codex"), laterOwner, "cleanup respects later owner");
	});
}

test("missing provider or lifecycle API leaves the host untouched", async () => {
	for (const registry of [{ getProvider: () => undefined, getRegisteredNativeProvider: () => undefined,
		getRegisteredProviderConfig: () => undefined }, {}]) {
		const events = new Map<string, Handler>();
		const notices: string[] = [];
		piUsage({ on: (name: string, handler: Handler) => events.set(name, handler), registerCommand: () => {},
			registerProvider: () => assert.fail("must not install a static fallback"), unregisterProvider: () => assert.fail("nothing to remove"),
		} as unknown as ExtensionAPI);
		const ctx = { modelRegistry: registry, mode: "rpc", hasUI: false,
			sessionManager: { getEntries: () => [], getSessionId: () => "synthetic" },
			ui: { notify: (message: string) => notices.push(message) } } as unknown as ExtensionContext;
		await events.get("session_start")!({} as never, ctx);
		await events.get("session_shutdown")!({} as never, ctx);
		assert.equal(notices.length, 1);
		assert.match(notices[0]!, /Fast 无法安装/);
	}
});
