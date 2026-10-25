import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { TestContext } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { rgbColor, visibleWidth } from "@earendil-works/pi-tui";
import piUsage from "../extensions/index.ts";
import { QuotaPanel } from "../src/panels.ts";
import { FAST_ENTRY, FastModeController } from "../src/codex/fast-mode.ts";
import { API_URL, CONSUME_RESET_URL, QuotaController, RESET_CREDITS_URL } from "../src/codex/quota.ts";
import { FastCatalog } from "../src/codex/fast-catalog.ts";
import type { FastModel } from "../src/codex/fast-mode.ts";
import type { ProviderAuth, QuotaState } from "../src/codex/quota.ts";

// No real credential lookup, model request, quota request or reset consumption is allowed.
process.env.PI_OFFLINE = "1";
globalThis.fetch = async () => { throw new Error("Unexpected live fetch in extension test"); };
const codex: FastModel = { id: "gpt-6.1-sol", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" };

// Catalog wire/auth tests live separately. Extension tests inject capability facts.
beforeEach(() => {
	mock.method(FastCatalog.prototype, "read", async () => ({ kind: "supported" as const }));
	mock.method(FastCatalog.prototype, "readForAuth", function(this: FastCatalog, model: FastModel | undefined, oauth: boolean) {
		return this.read(model, oauth);
	});
});
afterEach(() => { mock.restoreAll(); });
const payload = () => ({ model: codex.id, input: [], reasoning: { effort: "high" }, tools: [], prompt_cache_key: "synthetic-cache" });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
type Entry = { type: "custom"; customType: string; data: { enabled: boolean; sessionId: string } };
type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
type Command = { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };
type Factory = (tui: TUI, theme: unknown, keys: unknown, done: (action?: "use") => void) => QuotaPanel;

function harness(options: { entries?: Entry[]; sessionId?: string; model?: FastModel; oauth?: boolean; mode?: string; hasUI?: boolean;
	auth?: () => Promise<ProviderAuth | undefined> } = {}) {
	const events = new Map<string, Handler>();
	const commands = new Map<string, Command>();
	const entries = options.entries ?? [];
	const notices: { message: string; type: string }[] = [];
	const statusHistory: { key: string; text: string | undefined }[] = [];
	const statuses = new Map<string, string | undefined>();
	const panels: QuotaPanel[] = [];
	let authCalls = 0;
	let appendFailure = false;
	let selected = 0;
	let oauth = options.oauth ?? true;
	let sessionId = options.sessionId ?? "session-A";
	let renders = 0;
	let provider: Provider | undefined;
	const terminal = { rows: 32 };
	const tui = { terminal, requestRender: () => { renders++; } } as unknown as TUI;
	const rawContext = {
		mode: options.mode ?? "tui", hasUI: options.hasUI ?? true, model: options.model ?? codex,
		modelRegistry: {
			isUsingOAuth: () => oauth,
			getProviderAuth: () => {
				authCalls++;
				if (options.auth) return options.auth();
				throw new Error("Unexpected credential lookup in extension test");
			},
		},
		sessionManager: { getEntries: () => entries, getSessionId: () => sessionId },
		ui: {
			theme: { appearance: "dark", fg: (_color: string, text: string) => text, style: (text: string) => text },
			setStatus: (key: string, text: string | undefined) => { statuses.set(key, text); statusHistory.push({ key, text }); },
			notify: (message: string, type: string) => { notices.push({ message, type }); },
			select: async () => { selected++; throw new Error("Unexpected reset-card selection"); },
			custom: async (factory: Factory) => {
				let action: "use" | undefined;
				const panel = factory(tui, undefined, undefined, (value) => { action = value; });
				panels.push(panel);
				panel.handleInput("q");
				return action;
			},
		},
	};
	const ctx = rawContext as unknown as ExtensionCommandContext;
	const api = {
		on: (name: string, handler: Handler) => { events.set(name, handler); return () => events.delete(name); },
		registerCommand: (name: string, command: Command) => { commands.set(name, command); },
		registerProvider: (value: Provider) => { provider = value; },
		appendEntry: (customType: string, data: Entry["data"]) => {
			if (appendFailure) throw new Error("Synthetic session write failure");
			entries.push({ type: "custom", customType, data });
		},
	} as unknown as ExtensionAPI;
	piUsage(api);
	const fire = async (name: string, event: Record<string, unknown> = {}) => {
		const handler = events.get(name);
		if (name !== "before_provider_request") return handler ? await handler({ type: name, ...event }, ctx) : undefined;
		// Exercise the actual request-bound provider hook, after all extension payload hooks.
		if (!oauth || ctx.model?.provider !== codex.provider || ctx.model.api !== codex.api
			|| new URL(ctx.model.baseUrl).origin !== "https://chatgpt.com") {
			return handler ? await handler({ type: name, ...event }, ctx) : undefined;
		}
		assert.ok(provider);
		let transformed: unknown;
		const model = { ...ctx.model, type: "chat", name: "Synthetic", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000,
		} as Model<"openai-codex-responses">;
		const result = await provider.streamSimple(model, normalizeContext({ messages: [] }), {
			apiKey: `synthetic.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-A" } })).toString("base64url")}.synthetic`,
			transport: "sse", maxRetries: 0,
			onPayload: async () => {
				const next = handler ? await handler({ type: name, ...event }, ctx) : undefined;
				return next === undefined ? event.payload : next;
			},
			fetch: async (_url, init) => {
				const raw = new Headers(init?.headers).get("content-encoding") === "zstd"
					? zstdDecompressSync(Buffer.from(init!.body as Uint8Array)).toString("utf8") : String(init?.body);
				transformed = JSON.parse(raw);
				return new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
					id: "synthetic-harness", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
				} })}\n\n`, { headers: { "content-type": "text/event-stream" } });
			},
		}).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		return transformed;
	};
	const command = async (name: string, args = "") => {
		const registered = commands.get(name);
		assert.ok(registered, `Missing /${name} command`);
		await registered.handler(args, ctx);
	};
	return { ctx, rawContext, tui, terminal, commands, entries, notices, panels, statuses, statusHistory, fire, command,
		get authCalls() { return authCalls; }, get selected() { return selected; }, get renders() { return renders; },
		setOAuth: (value: boolean) => { oauth = value; }, setSessionId: (value: string) => { sessionId = value; },
		failAppend: (value: boolean) => { appendFailure = value; },
		status: () => statuses.get("pi-usage"),
	};
}

async function start(h: ReturnType<typeof harness>, reason = "startup") {
	await h.fire("session_start", { reason });
	await tick();
}
const streamEvent = (tier?: string) => ({ provider: codex.provider, api: codex.api, model: codex.id,
	data: { type: "response.completed", response: { id: "synthetic-response", service_tier: tier } } });

test("only /fast on and off change Fast; commands run offline without looking up credentials", async () => {
	const h = harness();
	assert.deepEqual([...h.commands.keys()].sort(), ["fast", "pi-usage"]);
	await start(h);
	assert.ok(!h.status()?.includes("Fast"));
	await h.command("fast", " on ");
	assert.match(h.status()!, / · Fast$/);
	assert.deepEqual(h.entries, [{ type: "custom", customType: FAST_ENTRY, data: { enabled: true, sessionId: "session-A" } }]);
	assert.match(h.notices.at(-1)!.message, /2\.5 倍/);
	await h.command("fast", "off");
	assert.ok(!h.status()?.includes("Fast"));
	assert.equal(h.entries.at(-1)!.data.enabled, false);
	assert.equal(h.authCalls, 0);
	assert.equal(h.selected, 0);
	await h.fire("session_shutdown", { reason: "quit" });
});

test("bare /fast, status, toggle and invalid arguments cannot change the session preference", async () => {
	const h = harness();
	await start(h);
	await h.command("fast", "on");
	for (const argument of ["", "status", "toggle", "ON", "on off", "on\nextra"]) {
		await h.command("fast", argument);
		assert.match(h.notices.at(-1)!.message, /用法：\/fast on 或 \/fast off/);
		assert.equal(h.entries.length, 1);
		assert.match(h.status()!, / · Fast$/);
	}
	await h.command("pi-usage", "fast on");
	assert.match(h.notices.at(-1)!.message, /用法：\/pi-usage/);
	assert.equal(h.panels.length, 0);
	assert.equal(h.authCalls, 0);
});

test("failed session-entry persistence preserves the previous switch state in both directions", async () => {
	const h = harness();
	await start(h);
	h.failAppend(true);
	await h.command("fast", "on");
	assert.ok(!h.status()?.includes("Fast"));
	assert.equal(h.entries.length, 0);
	assert.match(h.notices.at(-1)!.message, /原状态保持不变/);
	h.failAppend(false);
	await h.command("fast", "on");
	h.failAppend(true);
	await h.command("fast", "off");
	assert.match(h.status()!, / · Fast$/);
	assert.equal(h.entries.length, 1);
});

test("unsupported or unknown catalog capability refuses /fast on without persisting a choice", async (t: TestContext) => {
	for (const kind of ["unsupported", "unknown"] as const) {
		t.mock.method(FastCatalog.prototype, "read", async () => ({ kind, reason: "Synthetic capability result" }));
		const h = harness();
		await start(h);
		await h.command("fast", "on");
		assert.equal(h.entries.length, 0);
		assert.ok(!h.status()?.includes(" · Fast"));
		assert.deepEqual(await h.fire("before_provider_request", { payload: payload() }), { ...payload(), service_tier: "default" });
		assert.equal(h.notices.at(-1)!.type, "warning");
		assert.equal(h.authCalls, 0);
	}
});

test("restored preferences display unavailable or unknown capability and send default", async (t: TestContext) => {
	for (const kind of ["unsupported", "unknown"] as const) {
		t.mock.method(FastCatalog.prototype, "read", async () => ({ kind, reason: "Synthetic capability result" }));
		const entries: Entry[] = [{ type: "custom", customType: FAST_ENTRY, data: { enabled: true, sessionId: "session-A" } }];
		const h = harness({ entries });
		await start(h, "resume");
		assert.match(h.status()!, kind === "unknown" ? /Fast能力未知/ : /Fast不可用/);
		assert.deepEqual(await h.fire("before_provider_request", { payload: payload() }), { ...payload(), service_tier: "default" });
		await h.command("fast", "on");
		assert.equal(entries.length, 1, "a refused command cannot replace the restored preference");
		await h.command("fast", "off");
		assert.equal(entries.at(-1)!.data.enabled, false);
		assert.ok(!h.status()?.includes("Fast"));
	}
});

test("/fast off and an off startup never query catalog or credentials even with the real offline catalog", async () => {
	mock.restoreAll();
	const h = harness();
	await start(h);
	await h.command("fast", "off");
	assert.equal(h.authCalls, 0);
	assert.equal(h.entries.at(-1)!.data.enabled, false);
	assert.deepEqual(await h.fire("before_provider_request", { payload: payload() }), { ...payload(), service_tier: "default" });
});

test("late catalog results cannot override off, logout or model/session replacement", async (t: TestContext) => {
	for (const replacement of ["model", "new-session", "shutdown", "off", "logout", "logout-without-event"]) {
		let finish!: (value: { kind: "supported" }) => void;
		const waiting = new Promise<{ kind: "supported" }>((resolve) => { finish = resolve; });
		t.mock.method(FastCatalog.prototype, "read", () => waiting);
		const h = harness();
		await start(h);
		const command = h.command("fast", "on");
		await tick();
		if (replacement === "model") {
			h.rawContext.model = { ...codex, provider: "google" };
			await h.fire("model_select");
		} else if (replacement === "new-session") {
			h.setSessionId("session-B");
			await start(h, "new");
		} else if (replacement === "off") await h.command("fast", "off");
		else if (replacement === "logout") { h.setOAuth(false); await h.fire("model_select"); }
		else if (replacement === "logout-without-event") h.setOAuth(false);
		else await h.fire("session_shutdown", { reason: "quit" });
		finish({ kind: "supported" });
		await command;
		assert.equal(h.entries.length, replacement === "off" ? 1 : 0, `${replacement} invalidates the command's awaited catalog result`);
		if (replacement === "off") assert.equal(h.entries[0]!.data.enabled, false);
		assert.ok(!h.status()?.includes(" · Fast"));
	}
});

test("catalog support allows future model IDs and never relies on a hardcoded list", async (t: TestContext) => {
	const future = { ...codex, id: "gpt-synthetic-future" };
	const queried: (FastModel | undefined)[] = [];
	t.mock.method(FastCatalog.prototype, "read", async (model: FastModel | undefined) => {
		queried.push(model);
		return { kind: "supported" as const };
	});
	const h = harness({ model: future });
	await start(h);
	await h.command("fast", "on");
	assert.ok(queried.some((model) => model?.id === future.id));
	const futurePayload = { ...payload(), model: future.id };
	assert.deepEqual(await h.fire("before_provider_request", { payload: futurePayload }), { ...futurePayload, service_tier: "priority" });
	assert.match(h.status()!, / · Fast$/);
});

test("request-time catalog refresh uses default while capability is unknown or unavailable and recovers priority", async (t: TestContext) => {
	let kind: "supported" | "unsupported" | "unknown" = "supported";
	t.mock.method(FastCatalog.prototype, "read", async () => ({ kind }));
	const h = harness();
	await start(h);
	await h.command("fast", "on");
	for (const next of ["unknown", "unsupported", "supported"] as const) {
		kind = next;
		const tier = next === "supported" ? "priority" : "default";
		assert.deepEqual(await h.fire("before_provider_request", { payload: payload() }), { ...payload(), service_tier: tier });
		assert.match(h.status()!, next === "unknown" ? /Fast能力未知/ : next === "unsupported" ? /Fast不可用/ : / · Fast$/);
		assert.equal(h.entries.length, 1, "capability changes must not change the saved preference");
	}
});

test("a slower older capability result cannot overwrite the newest request-time capability", async (t: TestContext) => {
	const h = harness();
	await start(h);
	await h.command("fast", "on");
	let finish!: (value: { kind: "unknown" }) => void;
	const waiting = new Promise<{ kind: "unknown" }>((resolve) => { finish = resolve; });
	let calls = 0;
	t.mock.method(FastCatalog.prototype, "read", () => ++calls === 1 ? waiting : Promise.resolve({ kind: "supported" as const }));
	const older = h.fire("before_provider_request", { payload: payload() });
	await tick();
	assert.deepEqual(await h.fire("before_provider_request", { payload: payload() }), { ...payload(), service_tier: "priority" });
	finish({ kind: "unknown" });
	assert.deepEqual(await older, { ...payload(), service_tier: "priority" });
	assert.match(h.status()!, / · Fast$/);
});

test("unofficial origins have no Codex status, payload rewriting or Fast command persistence", async () => {
	for (const baseUrl of ["https://proxy.invalid/backend-api", "https://api.openai.com/v1", "http://chatgpt.com/backend-api", "https://chatgpt.com.evil.invalid"]) {
		const h = harness({ model: { ...codex, baseUrl } });
		await start(h);
		assert.equal(h.status(), undefined);
		assert.equal(await h.fire("before_provider_request", { payload: payload() }), undefined);
		await h.command("fast", "on");
		assert.equal(h.entries.length, 0);
		assert.equal(h.authCalls, 0);
	}
});

test("new sessions and forks start off, while startup, resume and reload restore this session only", async () => {
	const entries: Entry[] = [];
	const h = harness({ entries });
	await start(h);
	await h.command("fast", "on");
	for (const reason of ["startup", "reload", "resume"]) {
		const restored = harness({ entries });
		await start(restored, reason);
		assert.match(restored.status()!, / · Fast$/);
		await restored.fire("session_shutdown", { reason: "reload" });
	}
	for (const reason of ["new", "fork"]) {
		h.setSessionId(`session-${reason}`);
		await start(h, reason);
		assert.ok(!h.status()?.includes("Fast"));
		assert.deepEqual(await h.fire("before_provider_request", { payload: payload() }), { ...payload(), service_tier: "default" });
	}
	h.setSessionId("session-A");
	await start(h, "resume");
	assert.match(h.status()!, / · Fast$/);
	await h.command("fast", "off");
	await start(h, "reload");
	assert.ok(!h.status()?.includes("Fast"));
});

test("same-session tree navigation retains the session-wide preference", async () => {
	const h = harness();
	await start(h);
	await h.command("fast", "on");
	await h.fire("session_tree", { oldLeafId: "branch-A", newLeafId: "branch-B", fromExtension: false });
	assert.deepEqual(await h.fire("before_provider_request", { payload: payload() }), { ...payload(), service_tier: "priority" });
	assert.equal(h.entries.length, 1);
});

test("switching providers hides the complete status and restores Fast only on return to subscription OAuth", async () => {
	const h = harness();
	await start(h);
	await h.command("fast", "on");
	for (const model of [{ ...codex, provider: "openai" }, { ...codex, provider: "anthropic" },
		{ ...codex, provider: "google" }, { ...codex, api: "openai-responses" }]) {
		h.rawContext.model = model;
		await h.fire("model_select");
		assert.equal(h.status(), undefined);
		assert.equal(await h.fire("before_provider_request", { payload: payload() }), undefined);
		await h.fire("provider_stream_event", streamEvent("fast"));
		await h.fire("agent_settled");
		assert.equal(h.status(), undefined);
		await h.command("fast", "on");
		assert.equal(h.entries.length, 1, "rejected on must not overwrite stored session preference");
		assert.match(h.notices.at(-1)!.message, /仅适用于.*Codex 订阅 OAuth/);
	}
	h.rawContext.model = codex;
	h.setOAuth(false);
	await h.fire("model_select");
	assert.equal(h.status(), undefined);
	assert.equal(await h.fire("before_provider_request", { payload: payload() }), undefined);
	await h.command("fast", "on");
	assert.equal(h.entries.length, 1);
	h.setOAuth(true);
	await h.fire("model_select");
	assert.match(h.status()!, / · Fast$/);
	assert.equal(h.authCalls, 0);
});

test("/fast off can clear the retained session preference while another provider is selected", async () => {
	const h = harness();
	await start(h);
	await h.command("fast", "on");
	h.rawContext.model = { ...codex, provider: "google" };
	await h.fire("model_select");
	await h.command("fast", "off");
	assert.equal(h.entries.at(-1)!.data.enabled, false);
	assert.equal(h.status(), undefined);
	h.rawContext.model = codex;
	await h.fire("model_select");
	assert.ok(!h.status()?.includes("Fast"));
});

test("provider request and stream events update Fast confirmation, fallback and unconfirmed status", async () => {
	const h = harness();
	await start(h);
	await h.command("fast", "on");
	for (const [tier, status] of [["fast", / · Fast$/], ["priority", / · Fast$/], ["default", / · Fast$/], [undefined, / · Fast$/]] as const) {
		const input = payload();
		const before = structuredClone(input);
		assert.deepEqual(await h.fire("before_provider_request", { payload: input }), { ...input, service_tier: "priority" });
		assert.deepEqual(input, before);
		assert.match(h.status()!, / · Fast$/);
		await h.fire("provider_stream_event", streamEvent(tier));
		assert.match(h.status()!, status);
		await h.fire("agent_settled");
		assert.match(h.status()!, status);
	}
	await h.fire("before_provider_request", { payload: payload() });
	await h.fire("agent_settled");
	assert.match(h.status()!, / · Fast$/);
	await h.fire("model_select");
	assert.match(h.status()!, / · Fast$/, "model selection cannot prove an unfinished response has stopped");
	await h.command("fast", "off");
	await h.fire("provider_stream_event", streamEvent("fast"));
	assert.ok(!h.status()?.includes("Fast"));
	assert.deepEqual(await h.fire("before_provider_request", { payload: payload() }), { ...payload(), service_tier: "default" });
});

test("the supported Fast footer remains enabled while the panel reports a standard server response", async () => {
	const h = harness();
	await start(h);
	await h.command("fast", "on");
	await h.fire("before_provider_request", { payload: payload() });
	await h.fire("provider_stream_event", streamEvent("default"));
	assert.match(h.status()!, / · Fast$/);
	await h.command("pi-usage");
	const detail = h.panels.at(-1)!.render(68).join("\n");
	assert.match(detail, /已开启 · ×2\.5/);
	assert.match(detail, /服务端标准 · 仅本会话/);
	assert.doesNotMatch(detail, /模型能力|请求档位|最近服务端档位/);
	assert.ok(!detail.includes("Fast 未生效"));
});

test("late quota callbacks from disposed controllers cannot make hidden status reappear", async (t: TestContext) => {
	const controllers: QuotaController[] = [];
	t.mock.method(QuotaController.prototype, "refresh", function(this: QuotaController) {
		controllers.push(this);
		return Promise.resolve(this.getState());
	});
	const h = harness();
	await start(h);
	const old = controllers[0]!;
	assert.ok(old);
	await start(h, "reload"); // Only a session/runtime replacement disposes the controller.
	h.rawContext.model = { ...codex, provider: "anthropic" };
	await h.fire("model_select");
	const writes = h.statusHistory.length;
	const lateCallback = (old as unknown as { options: { onChange: (state: QuotaState) => void } }).options.onChange;
	lateCallback(old.getState());
	assert.equal(h.status(), undefined);
	assert.equal(h.statusHistory.length, writes);
	h.rawContext.model = codex;
	await h.fire("model_select");
	const currentStatus = h.status();
	const returnedWrites = h.statusHistory.length;
	lateCallback(old.getState());
	assert.equal(h.status(), currentStatus);
	assert.equal(h.statusHistory.length, returnedWrites);
	await h.fire("session_shutdown", { reason: "quit" });
	lateCallback(old.getState());
	assert.equal(h.status(), undefined);
});

test("overlapping, failed and incomplete stream diagnostics preserve the supported Fast footer", async () => {
	const h = harness();
	await start(h);
	await h.command("fast", "on");
	await h.fire("before_provider_request", { payload: payload() });
	await h.fire("before_provider_request", { payload: payload() });
	await h.fire("provider_stream_event", streamEvent("fast"));
	assert.match(h.status()!, / · Fast$/);
	await h.fire("agent_settled");
	await start(h, "reload"); // A fresh extension runtime clears ambiguous old streams.
	for (const type of ["response.failed", "response.incomplete"]) {
		await h.fire("before_provider_request", { payload: payload() });
		const event = streamEvent("fast");
		event.data.type = type;
		await h.fire("provider_stream_event", event);
		assert.match(h.status()!, / · Fast$/);
		await h.fire("agent_settled");
	}
	await h.fire("before_provider_request", { payload: payload() });
	await h.fire("provider_stream_event", streamEvent("fast"));
	assert.match(h.status()!, / · Fast$/);
});

test("supported Fast footer survives overlapping streams, settlement, toggles and model changes", async () => {
	const h = harness();
	await start(h);
	await h.command("fast", "on");
	await h.fire("before_provider_request", { payload: payload() });
	await h.fire("before_provider_request", { payload: payload() });
	assert.match(h.status()!, / · Fast$/);
	const foregroundA = streamEvent("fast");
	foregroundA.data.response.id = "foreground-A";
	await h.fire("provider_stream_event", foregroundA);
	await h.fire("agent_settled");
	await h.fire("before_provider_request", { payload: payload() });
	const oldBackground = streamEvent("fast");
	oldBackground.data.response.id = "late-background-W";
	await h.fire("provider_stream_event", oldBackground);
	assert.match(h.status()!, / · Fast$/);
	await h.command("fast", "off");
	assert.ok(!h.status()?.includes("Fast"));
	await h.command("fast", "on");
	assert.match(h.status()!, / · Fast$/);
	h.rawContext.model = { ...codex, provider: "google" };
	await h.fire("model_select");
	assert.equal(h.status(), undefined);
	h.rawContext.model = codex;
	await h.fire("model_select");
	assert.match(h.status()!, / · Fast$/);
	await h.fire("before_provider_request", { payload: payload() });
	await h.fire("provider_stream_event", streamEvent("fast"));
	assert.match(h.status()!, / · Fast$/);
	await start(h, "reload");
	assert.match(h.status()!, / · Fast$/);
	await h.fire("before_provider_request", { payload: payload() });
	await h.fire("provider_stream_event", streamEvent("fast"));
	assert.match(h.status()!, / · Fast$/);
});

test("supported Fast footer stays stable across unfinished requests and context events", async () => {
	for (const reset of ["off/on", "model_select", "agent_settled"]) {
		const h = harness();
		await start(h);
		await h.command("fast", "on");
		await h.fire("before_provider_request", { payload: payload() }); // A, no prior overlap.
		assert.match(h.status()!, / · Fast$/);
		if (reset === "off/on") { await h.command("fast", "off"); await h.command("fast", "on"); }
		else await h.fire(reset);
		assert.match(h.status()!, / · Fast$/);
		await h.fire("before_provider_request", { payload: payload() }); // B.
		const lateA = streamEvent("fast");
		lateA.data.response.id = "late-response-A";
		await h.fire("provider_stream_event", lateA);
		assert.match(h.status()!, / · Fast$/, `${reset} must not attribute A's old response to B`);
		await h.fire("before_provider_request", { payload: payload() });
		await start(h, "reload");
		assert.match(h.status()!, / · Fast$/);
		await h.fire("before_provider_request", { payload: payload() });
		await h.fire("provider_stream_event", streamEvent("fast"));
		assert.match(h.status()!, / · Fast$/);
	}
});

test("the detail panel is read-only for Fast, with only u retaining the reset action", async (t: TestContext) => {
	const h = harness();
	await start(h);
	await h.command("fast", "on");
	await h.command("pi-usage");
	const output = h.panels[0]!.render(68).join("\n");
	assert.match(output, /🍧 Codex 额度/);
	assert.match(output, /已开启 · ×2\.5/);
	assert.match(output, /等待响应 · 仅本会话/);
	assert.doesNotMatch(output, /\/fast on|不会自动消耗|不会自动消费|f 切换/);
	const controller = new QuotaController({ offline: true, resolveAuth: async () => { throw new Error("Unexpected credential lookup"); } });
	const fast = new FastModeController();
	fast.setCapability({ kind: "supported" });
	fast.setEnabled(true);
	const actions: ("use" | undefined)[] = [];
	const panel = new QuotaPanel(h.tui, h.ctx, controller, (action) => actions.push(action), fast);
	panel.handleInput("f");
	assert.equal(fast.enabled, true);
	assert.deepEqual(actions, []);
	panel.handleInput("u");
	assert.deepEqual(actions, []);
	assert.match(h.notices.at(-1)!.message, /离线/);
	t.mock.method(controller, "getResetButton", () => ({ enabled: true, phase: "ready" as const, hint: "synthetic ready card" }));
	panel.handleInput("u");
	panel.handleInput("u");
	assert.deepEqual(actions, ["use"], "reset action is emitted exactly once and never consumed by the panel itself");
	assert.equal(h.selected, 0);
	assert.equal(h.authCalls, 0);
	controller.dispose();
});

test("panel scrolling and compact layouts fit all terminal sizes with a fixed update footer", () => {
	const h = harness();
	const fast = new FastModeController();
	fast.setCapability({ kind: "supported" });
	fast.setEnabled(true);
	const controller = new QuotaController({ offline: true, resolveAuth: async () => { throw new Error("Unexpected credential lookup"); } });
	const panel = new QuotaPanel(h.tui, h.ctx, controller, () => {}, fast);
	for (const rows of [0, 1, 4, 8, 10, 16, 32]) {
		h.terminal.rows = rows;
		for (const width of [0, 1, 5, 12, 24, 40, 68, 90]) {
			panel.render(width);
			panel.handleInput("\x1b[H");
			const lines = panel.render(width);
			assert.ok(lines.length <= rows, `height overflow at ${width}x${rows}`);
			for (const line of lines) assert.ok(visibleWidth(line) <= Math.min(width, 68), `width overflow at ${width}x${rows}: ${line}`);
			if (!width || !rows) assert.deepEqual(lines, []);
			if (width >= 40 && rows > 0) {
				const footer = lines.find((line) => line.includes("更新于"));
				assert.ok(footer?.includes("更新于 未知 · 本机时区"));
				assert.equal(lines.filter((line) => line.includes("更新于")).length, 1);
				panel.handleInput("\x1b[F");
				const end = panel.render(width);
				assert.equal(end.find((line) => line.includes("更新于")), footer);
				if (rows >= 4) assert.match(end.join("\n"), /仅本会话/);
			}
		}
	}
	h.terminal.rows = 16;
	panel.render(40);
	panel.handleInput("\x1b[B");
	panel.handleInput("\x1b[F");
	assert.ok(h.renders >= 1);
	assert.ok(panel.render(40).every((line) => visibleWidth(line) <= 40));
	panel.handleInput("\x1b[H");
	controller.dispose();
});

test("short terminals scroll from reset details to the two-line Fast summary", () => {
	const h = harness();
	h.terminal.rows = 8;
	const fast = new FastModeController();
	const controller = new QuotaController({ offline: true, resolveAuth: async () => { throw new Error("Unexpected credential lookup"); } });
	const panel = new QuotaPanel(h.tui, h.ctx, controller, () => {}, fast);
	panel.render(40);
	panel.handleInput("\x1b[F");
	assert.match(panel.render(40).join("\n"), /已关闭 · 标准/);
	fast.setCapability({ kind: "supported" });
	fast.setEnabled(true);
	fast.transform(payload(), codex, true);
	fast.observe(streamEvent("fast"));
	let output = panel.render(40).join("\n");
	assert.match(output, /已开启 · ×2\.5/);
	assert.match(output, /服务端 Fast · 仅本会话/);
	assert.doesNotMatch(output, /模型能力|请求档位|\/fast on|f 切换/);
	panel.handleInput("\x1b[H");
	output = panel.render(40).join("\n");
	assert.match(output, /离线模式/);
	assert.doesNotMatch(output, /服务端 Fast/);
	controller.dispose();
});

function panelState(now: number, count = 3): QuotaState {
	return {
		phase: "ready", lastAttemptAt: now, lastSuccessAt: now, stale: false, retryAt: null, error: null,
		snapshot: { plan: "plus", allowed: true, limitReached: false, resetAvailableCount: count, receivedAt: now,
			windows: [
				{ key: "primary_window", periodSeconds: 18000, usedPercent: 25, remainingPercent: 75, resetAt: now + 3600000 },
				{ key: "secondary_window", periodSeconds: 604800, usedPercent: 4, remainingPercent: 96, resetAt: now + 86400000 },
			] },
		resetCredits: { stale: false, error: null, retryAt: null,
			snapshot: { availableCount: count, totalEarnedCount: count, receivedAt: now,
				credits: Array.from({ length: count }, () => ({ status: "available", fullReset: true,
					grantedAt: null, expiresAt: now + 86400000, redeemedAt: null })) } },
	};
}

test("dashboard orders quota, reset cards with their button, Fast, and a time-only footer", (t: TestContext) => {
	const now = Date.UTC(2026, 9, 15, 11, 6);
	t.mock.method(Date, "now", () => now);
	const h = harness();
	h.terminal.rows = 60;
	const state = panelState(now);
	const controller = new QuotaController({ offline: true, resolveAuth: async () => { throw new Error("Unexpected credentials"); } });
	t.mock.method(controller, "getState", () => state);
	t.mock.method(controller, "getResetButton", () => ({ enabled: true, phase: "ready" as const, hint: "可选 3 张 · 选卡后确认，不会自动消费" }));
	const fast = new FastModeController();
	fast.setCapability({ kind: "supported" });
	fast.setEnabled(true);
	fast.transform(payload(), codex, true);
	const panel = new QuotaPanel(h.tui, h.ctx, controller, () => {}, fast);
	const lines = panel.render(68);
	const text = lines.join("\n");
	const positions = ["订阅额度", "重置卡", "#1", "#3", "↻ 重置额度 · u", "─ Fast ─", "已开启 · ×2.5", "响应待确认 · 仅本会话", "更新于"].map((part) => text.indexOf(part));
	assert.ok(positions.every((position, index) => position >= 0 && (!index || position > positions[index - 1]!)), text);
	assert.match(lines[1]!, /🍧 Codex 额度.*PLUS.*可用/);
	assert.match(text, /剩75% · 已用25%/);
	assert.match(text, /到期：2026-10-/);
	assert.equal(lines.filter((line) => line.includes("重置额度")).length, 1);
	assert.equal(lines.filter((line) => line.includes("更新于")).length, 1);
	assert.match(lines.at(-2)!, /更新于 \d{2}:\d{2} · 本机时区/);
	assert.doesNotMatch(text, /更新：|选卡后确认|不会自动消费|按 u 选卡|\/fast on|当前模型：|请求档位：|Enter\/Esc/);
	const fastStart = lines.findIndex((line) => line.includes("─ Fast ─"));
	assert.match(lines[fastStart + 1]!, /已开启 · ×2\.5/);
	assert.match(lines[fastStart + 2]!, /响应待确认 · 仅本会话/);
	controller.dispose();
});

test("headings, body lines and the boxed reset button center on the framed content width", (t: TestContext) => {
	const now = Date.UTC(2026, 9, 15, 11, 6);
	t.mock.method(Date, "now", () => now);
	const h = harness();
	h.terminal.rows = 60;
	const state = panelState(now);
	const controller = new QuotaController({ offline: true, resolveAuth: async () => { throw new Error("Unexpected credentials"); } });
	t.mock.method(controller, "getState", () => state);
	t.mock.method(controller, "getResetButton", () => ({ enabled: true, phase: "ready" as const, hint: "可选 3 张 · 选卡后确认，不会自动消费" }));
	const fast = new FastModeController();
	fast.setCapability({ kind: "supported" });
	fast.setEnabled(true);
	const panel = new QuotaPanel(h.tui, h.ctx, controller, () => {}, fast);
	const lines = panel.render(68);
	const text = lines.join("\n");
	const contentWidth = 64;
	const innerOf = (line: string) => {
		const start = line.indexOf("│");
		const end = line.lastIndexOf("│");
		assert.ok(start >= 0 && end > start, `missing frame borders: ${line}`);
		return line.slice(start + 1, end);
	};
	for (const heading of ["─ 订阅额度 ─", "─ 重置卡 · 可用 3 张 ─", "─ Fast ─"]) {
		const line = lines.find((entry) => entry.includes(heading));
		assert.ok(line, `missing heading ${heading}`);
		const inner = innerOf(line!);
		assert.equal(inner.trim(), heading);
		assert.equal(inner.length - inner.trimStart().length, 1 + Math.floor((contentWidth - visibleWidth(heading)) / 2), heading);
	}
	assert.doesNotMatch(text, /── /);
	assert.doesNotMatch(text, /\[ ↻ 重置额度 · u \]/);
	const buttonIndex = lines.findIndex((line) => line.includes("↻ 重置额度 · u"));
	assert.ok(buttonIndex > 0);
	const box = [lines[buttonIndex - 1]!, lines[buttonIndex]!, lines[buttonIndex + 1]!].map(innerOf);
	assert.equal(box[0]!.trim(), `┌${"─".repeat(16)}┐`);
	assert.equal(box[1]!.trim(), "│ ↻ 重置额度 · u │");
	assert.equal(box[2]!.trim(), `└${"─".repeat(16)}┘`);
	assert.deepEqual(box.map((line) => visibleWidth(line.trim())), [18, 18, 18], "the three box lines are equally wide");
	const leads = box.map((line) => line.length - line.trimStart().length);
	assert.deepEqual(leads, [1 + Math.floor((contentWidth - 18) / 2), 1 + Math.floor((contentWidth - 18) / 2), 1 + Math.floor((contentWidth - 18) / 2)],
		"the whole box is centered as one block");
	const narrow = panel.render(20);
	assert.ok(narrow.some((line) => line.includes("[u 重置额度]")));
	assert.ok(narrow.every((line) => visibleWidth(line) <= 20));
	controller.dispose();
});

test("the three section headings take distinct rgb colors per theme appearance", (t: TestContext) => {
	const h = harness();
	h.terminal.rows = 64;
	const state = panelState(Date.now());
	const controller = new QuotaController({ offline: true, resolveAuth: async () => { throw new Error("Unexpected credentials"); } });
	t.mock.method(controller, "getState", () => state);
	const calls: { text: string; color: unknown }[] = [];
	t.mock.method(h.rawContext.ui.theme, "style", (text: string, options?: { fg?: unknown }) => {
		calls.push({ text, color: options?.fg });
		return text;
	});
	const panel = new QuotaPanel(h.tui, h.ctx, controller, () => {}, new FastModeController());
	const headings = ["─ 订阅额度 ─", "─ 重置卡 · 可用 3 张 ─", "─ Fast ─"];
	const expected = {
		dark: [rgbColor(125, 211, 252), rgbColor(196, 181, 253), rgbColor(134, 239, 172)],
		light: [rgbColor(8, 123, 164), rgbColor(109, 40, 217), rgbColor(21, 128, 61)],
	};
	const seen: unknown[] = [];
	for (const appearance of ["dark", "light"] as const) {
		h.rawContext.ui.theme.appearance = appearance;
		calls.length = 0;
		panel.render(68);
		const colors = headings.map((text) => {
			const call = calls.find((entry) => entry.text === text);
			assert.ok(call, `missing styled heading ${text}`);
			return call!.color;
		});
		assert.deepEqual(colors, expected[appearance], appearance);
		assert.equal(new Set(colors.map((color) => JSON.stringify(color))).size, 3, appearance);
		seen.push(...colors);
	}
	assert.equal(new Set(seen.map((color) => JSON.stringify(color))).size, 6, "dark and light never share a heading color");
	controller.dispose();
});

test("reset results and disabled or busy hints stay inside the card section without duplication", (t: TestContext) => {
	const h = harness();
	h.terminal.rows = 64;
	const state = panelState(Date.now());
	state.resetUse = { message: "确认重置成功；已重新查询。", warning: false };
	const controller = new QuotaController({ offline: true, resolveAuth: async () => { throw new Error("Unexpected credentials"); } });
	t.mock.method(controller, "getState", () => state);
	const panel = new QuotaPanel(h.tui, h.ctx, controller, () => {}, new FastModeController());
	for (const phase of ["disabled", "busy"] as const) {
		const hint = phase === "busy" ? "正在处理，请勿重复操作" : "数据不可用，请先刷新明细";
		t.mock.method(controller, "getResetButton", () => ({ enabled: false, phase, hint }));
		const text = panel.render(68).join("\n");
		const cardStart = text.indexOf("重置卡");
		const fastStart = text.indexOf("─ Fast ─");
		for (const message of [state.resetUse.message, hint, "重置额度"]) {
			assert.ok(text.indexOf(message) > cardStart && text.indexOf(message) < fastStart, message);
			assert.equal(text.split(message).length - 1, 1, message);
		}
	}
	state.resetUse = { message: "数据不可用，请先刷新明细", warning: true };
	t.mock.method(controller, "getResetButton", () => ({ enabled: false, phase: "disabled" as const, hint: state.resetUse!.message }));
	assert.equal(panel.render(68).join("\n").split(state.resetUse.message).length - 1, 1);
	controller.dispose();
});

test("all cards remain scrollable while the update footer is fixed and u works off-screen", (t: TestContext) => {
	const h = harness();
	h.terminal.rows = 16;
	const state = panelState(Date.now(), 30);
	const controller = new QuotaController({ offline: true, resolveAuth: async () => { throw new Error("Unexpected credentials"); } });
	t.mock.method(controller, "getState", () => state);
	t.mock.method(controller, "getResetButton", () => ({ enabled: true, phase: "ready" as const, hint: "synthetic ready" }));
	const actions: ("use" | undefined)[] = [];
	const panel = new QuotaPanel(h.tui, h.ctx, controller, (action) => actions.push(action), new FastModeController());
	let output = "";
	const footer = panel.render(68).at(-2);
	for (let i = 0; i < state.resetCredits!.snapshot!.credits!.length * 3 + 30; i++) {
		const lines = panel.render(68);
		assert.equal(lines.at(-2), footer);
		assert.ok(lines.length <= h.terminal.rows);
		output += "\n" + lines.join("\n");
		panel.handleInput("\x1b[B");
	}
	for (let i = 1; i <= 30; i++) assert.ok(output.includes(`#${i} `), `missing card ${i}`);
	panel.handleInput("\x1b[F");
	assert.match(panel.render(68).join("\n"), /仅本会话/);
	panel.handleInput("\x1b[H");
	assert.doesNotMatch(panel.render(68).join("\n"), /重置额度/);
	panel.handleInput("u");
	panel.handleInput("u");
	assert.deepEqual(actions, ["use"]);
	assert.equal(h.authCalls, 0);
	assert.equal(h.selected, 0);
	controller.dispose();
});

test("low-quota bar colors are window-local and follow light or dark appearance", (t: TestContext) => {
	const h = harness();
	h.terminal.rows = 64;
	const state = panelState(Date.now());
	const controller = new QuotaController({ offline: true, resolveAuth: async () => { throw new Error("Unexpected credentials"); } });
	t.mock.method(controller, "getState", () => state);
	const calls: { text: string; color: unknown }[] = [];
	t.mock.method(h.rawContext.ui.theme, "style", (text: string, options?: { fg?: unknown }) => {
		calls.push({ text, color: options?.fg });
		return text;
	});
	const panel = new QuotaPanel(h.tui, h.ctx, controller, () => {}, new FastModeController());
	for (const appearance of ["dark", "light"]) {
		h.rawContext.ui.theme.appearance = appearance;
		for (const percent of [20, 0, 20.01]) {
			state.snapshot!.windows[0]!.remainingPercent = percent;
			calls.length = 0;
			panel.render(68);
			const barCalls = calls.filter((call) => /^[█░]+$/.test(call.text));
			assert.equal(barCalls.length, percent <= 20 ? 1 : 0);
			if (percent <= 20) assert.deepEqual(barCalls[0]!.color, appearance === "light" ? rgbColor(176, 82, 92) : rgbColor(240, 160, 160));
		}
	}
	controller.dispose();
});

test("ANSI-styled ready panels stay bounded through resize and recompute theme colors", (t: TestContext) => {
	const h = harness();
	const state = panelState(Date.now());
	const controller = new QuotaController({ offline: true, resolveAuth: async () => { throw new Error("Unexpected credentials"); } });
	t.mock.method(controller, "getState", () => state);
	t.mock.method(controller, "getResetButton", () => ({ enabled: true, phase: "ready" as const, hint: "not displayed" }));
	t.mock.method(h.rawContext.ui.theme, "fg", (_color: string, text: string) => {
		const code = h.rawContext.ui.theme.appearance === "light" ? 34 : 35;
		return `\x1b[${code}m${text}\x1b[39m`;
	});
	t.mock.method(h.rawContext.ui.theme, "style", (text: string) => `\x1b[1;44m${text}\x1b[0m`);
	const fast = new FastModeController();
	fast.setEnabled(true);
	fast.setCapability({ kind: "supported" });
	const panel = new QuotaPanel(h.tui, h.ctx, controller, () => {}, fast);
	for (const appearance of ["dark", "light"]) {
		h.rawContext.ui.theme.appearance = appearance;
		for (const rows of [1, 4, 8, 10, 16, 32]) {
			h.terminal.rows = rows;
			for (const width of [1, 5, 12, 24, 40, 68, 90]) {
				panel.render(width);
				panel.handleInput("\x1b[F");
				const lines = panel.render(width);
				assert.ok(lines.length <= rows);
				assert.ok(lines.every((line) => visibleWidth(line) <= Math.min(width, 68)), `${width}x${rows}`);
				if (width >= 40) assert.match(lines.join("\n"), appearance === "light" ? /\x1b\[34m/ : /\x1b\[35m/);
			}
		}
	}
	h.terminal.rows = 64;
	panel.render(68);
	panel.handleInput("\x1b[F");
	assert.match(panel.render(68).join("\n"), /订阅额度/); // Enlarging clamps the old scroll offset back to zero.
	controller.dispose();
});

function onlineQuotaHarness(t: TestContext, postStatus = 503) {
	const previousOffline = process.env.PI_OFFLINE;
	process.env.PI_OFFLINE = "0";
	t.after(() => { if (previousOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previousOffline; });
	let now = Date.parse("2026-10-16T12:00:00Z");
	t.mock.method(Date, "now", () => now);
	let poll: () => void = () => { throw new Error("Missing quota timer"); };
	t.mock.method(globalThis, "setInterval", ((callback: () => void) => {
		poll = callback;
		return { unref() {} } as ReturnType<typeof setInterval>;
	}) as typeof setInterval);
	const posts: Record<string, unknown>[] = [];
	let gets = 0;
	t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
		if (String(url) === CONSUME_RESET_URL) {
			assert.equal(init?.method, "POST");
			posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return new Response("", { status: postStatus, headers: postStatus === 429 ? { "Retry-After": "600" } : {} });
		}
		assert.equal(init?.method, "GET");
		gets++;
		if (String(url) === API_URL) return Response.json({ plan_type: "plus", rate_limit: {
			primary_window: { used_percent: 22, limit_window_seconds: 18000 },
		} });
		assert.equal(String(url), RESET_CREDITS_URL);
		return Response.json({ available_count: 1, credits: [{ id: "synthetic-card", status: "available",
			reset_type: "codex_rate_limits", expires_at: new Date(now + 86400_000).toISOString(),
		}] });
	});
	const token = `synthetic.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-A" } })).toString("base64url")}.synthetic`;
	const h = harness({ auth: async () => ({ source: "OAuth", auth: { apiKey: token } }) });
	t.after(() => h.fire("session_shutdown", { reason: "quit" }));
	return { h, posts, get gets() { return gets; }, advance: (milliseconds: number) => { now += milliseconds; }, poll: () => poll() };
}

test("idle logout clears the HUD and cached account without model_select, and polling resumes login", async (t: TestContext) => {
	const online = onlineQuotaHarness(t);
	const { h } = online;
	await start(h);
	assert.match(h.status()!, /78%/);
	await h.command("pi-usage");
	const panel = h.panels.at(-1)!;
	const instance = (panel as unknown as { controller: QuotaController }).controller;
	assert.ok(instance.getState().snapshot);
	const gets = online.gets;
	h.setOAuth(false);
	online.poll();
	await tick();
	assert.equal(h.status(), undefined);
	assert.equal(instance.getState().snapshot, null);
	assert.equal(instance.getState().resetCredits?.snapshot, null);
	assert.equal(online.gets, gets);
	online.advance(60_000);
	h.setOAuth(true);
	online.poll();
	await tick();
	assert.match(h.status()!, /78%/);
	assert.ok(online.gets > gets);
	h.setOAuth(false);
	await h.fire("agent_settled");
	assert.equal(h.status(), undefined, "settlement must also clear a logged-out HUD");
	assert.equal(instance.getState().snapshot, null);
});

test("logging in after an unauthenticated startup starts the HUD without a model event", async (t: TestContext) => {
	const online = onlineQuotaHarness(t);
	const { h } = online;
	h.setOAuth(false);
	await start(h);
	assert.equal(h.status(), undefined);
	assert.equal(online.gets, 0);
	assert.equal(h.authCalls, 0);
	h.setOAuth(true);
	online.advance(60_000);
	online.poll();
	await tick();
	assert.match(h.status()!, /78%/);
	assert.equal(online.gets, 2);
});

for (const postStatus of [503, 429]) {
	test(`same-session provider switching retains reset protection after HTTP ${postStatus}`, async (t: TestContext) => {
		const online = onlineQuotaHarness(t, postStatus);
		const { h, posts } = online;
		let use = false;
		t.mock.method(h.ctx.ui, "select", async (_title: string, options: string[]) => options.at(-1));
		h.rawContext.ui.custom = async (factory: Factory) => {
			let action: "use" | undefined;
			const panel = factory(h.tui, undefined, undefined, (value) => { action = value; });
			h.panels.push(panel);
			panel.render(68);
			if (use) { use = false; panel.handleInput("u"); }
			panel.handleInput("q");
			return action;
		};
		const attempt = async () => { use = true; await h.command("pi-usage"); };
		await start(h);
		await attempt();
		assert.equal(posts.length, 1);
		const instance = (h.panels.at(-1)! as unknown as { controller: QuotaController }).controller;
		await attempt();
		assert.equal(posts.length, 1);
		h.rawContext.model = { ...codex, provider: "google" };
		await h.fire("model_select");
		assert.equal(h.status(), undefined);
		online.advance(60_000);
		h.rawContext.model = codex;
		await h.fire("model_select");
		await tick();
		await attempt();
		const resumed = (h.panels.at(-1)! as unknown as { controller: QuotaController }).controller;
		assert.equal(resumed, instance, "model switches retain the session's safety controller");
		assert.equal(posts.length, 1, "neither an uncertain POST nor a 429 may be retried by switching providers");
		assert.match(resumed.getResetButton().hint, postStatus === 429 ? /冷却/ : /结果未决/);
		if (postStatus === 429) {
			online.advance(540_000);
			await attempt();
			assert.equal(posts.length, 2, "an explicit retry is allowed only after the original cooldown");
		}
	});
}

test("non-TUI and headless sessions never install a status bar", async () => {
	for (const options of [{ mode: "rpc" }, { hasUI: false }]) {
		const h = harness(options);
		await start(h);
		await h.command("fast", "on");
		assert.equal(h.statusHistory.length, 0);
		assert.deepEqual(await h.fire("before_provider_request", { payload: payload() }), { ...payload(), service_tier: "priority" });
		assert.equal(h.authCalls, 0);
		await h.fire("session_shutdown", { reason: "quit" });
	}
});
