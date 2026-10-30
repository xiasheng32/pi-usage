/**
 * Merged wiring: one footer key, one panel per provider, two commands.
 *
 * Provider parsers and the Codex quota/Fast internals have their own suites;
 * these cases cover the dispatch that the merge introduced.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Provider } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import piUsage from "../extensions/index.ts";
import { BalancePanel, QuotaPanel } from "../src/panels.ts";
import { API_URL as DEEPSEEK_API_URL } from "../src/balance/deepseek.ts";
import { API_URL as KIMI_API_URL } from "../src/balance/kimi.ts";

const DEEPSEEK = { id: "deepseek-flash", provider: "deepseek", api: "openai-completions", baseUrl: "https://api.deepseek.com" };
const KIMI = { id: "kimi-k2", provider: "moonshotai-cn", api: "openai-completions", baseUrl: "https://api.moonshot.cn/v1" };
const CODEX = { id: "gpt-6.1-sol", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" };
const ANTHROPIC = { id: "claude-sonnet", provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" };

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
type Command = { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };
type Panel = { render(width: number): string[] };
type Factory = (tui: TUI, theme: unknown, keys: unknown, done: (action?: "use") => void) => Panel;

const previousOffline = process.env.PI_OFFLINE;

function harness(options: { model?: Record<string, unknown>; oauth?: boolean } = {}) {
	const events = new Map<string, Handler>();
	const commands = new Map<string, Command>();
	const notices: { message: string; type: string }[] = [];
	const statuses = new Map<string, string | undefined>();
	const statusHistory: { key: string; text: string | undefined }[] = [];
	const panels: Panel[] = [];
	let model: Record<string, unknown> | undefined = options.model ?? DEEPSEEK;
	let oauth = options.oauth ?? true;
	const native = openaiCodexProvider();
	let registered: Provider | undefined;
	const tui = { terminal: { rows: 32 }, requestRender: () => {} } as unknown as TUI;
	const rawContext = {
		mode: "tui", hasUI: true,
		get model() { return model; },
		modelRegistry: {
			getProvider: () => registered ?? native,
			getRegisteredNativeProvider: () => registered,
			getRegisteredProviderConfig: () => undefined,
			isUsingOAuth: () => oauth,
			getApiKeyForProvider: async (provider: string) => `sk-${provider}`,
			getProviderAuth: async () => undefined,
		},
		sessionManager: { getEntries: () => [], getSessionId: () => "session-A" },
		ui: {
			theme: { appearance: "dark", fg: (_color: string, text: string) => text, style: (text: string) => text },
			setStatus: (key: string, text: string | undefined) => { statuses.set(key, text); statusHistory.push({ key, text }); },
			notify: (message: string, type: string) => { notices.push({ message, type }); },
			select: async () => { throw new Error("Unexpected reset-card selection"); },
			custom: async (factory: Factory) => {
				const panel = factory(tui, undefined, undefined, () => {});
				panels.push(panel);
				return undefined;
			},
		},
	};
	const ctx = rawContext as unknown as ExtensionCommandContext;
	const api = {
		on: (name: string, handler: Handler) => { events.set(name, handler); return () => events.delete(name); },
		registerCommand: (name: string, command: Command) => { commands.set(name, command); },
		registerProvider: (provider: Provider) => { registered = provider; },
		unregisterProvider: () => { registered = undefined; },
		appendEntry: () => {},
	} as unknown as ExtensionAPI;
	piUsage(api);
	const fire = async (name: string, event: Record<string, unknown> = {}) => {
		const handler = events.get(name);
		if (handler) await handler({ type: name, ...event }, ctx);
	};
	const command = async (name: string, args = "") => {
		const registered = commands.get(name);
		assert.ok(registered, `Missing /${name} command`);
		await registered.handler(args, ctx);
	};
	return {
		ctx, commands, notices, panels, statuses, statusHistory, fire, command,
		status: () => statuses.get("pi-usage"),
		setModel: (next: Record<string, unknown>) => { model = next; },
		setOAuth: (value: boolean) => { oauth = value; },
	};
}

beforeEach(() => {
	process.env.PI_OFFLINE = "0";
	mock.method(globalThis, "setInterval", ((_callback: () => void) => ({ unref() {} }) as ReturnType<typeof setInterval>) as typeof setInterval);
	mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
		const url = String(input);
		if (url === DEEPSEEK_API_URL) {
			return Response.json({ is_available: true, balance_infos: [
				{ currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
			] });
		}
		if (url === KIMI_API_URL) {
			return Response.json({ code: 0, status: true, data: { available_balance: "50.00", voucher_balance: "10.00", cash_balance: "40.00" } });
		}
		throw new Error(`Unexpected request: ${url}`);
	});
});
afterEach(() => {
	mock.restoreAll();
	if (previousOffline === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = previousOffline;
});

test("registers exactly /pi-usage and /fast with no legacy provider commands", () => {
	const h = harness();
	assert.deepEqual([...h.commands.keys()].sort(), ["fast", "pi-usage"]);
});

test("one footer key follows the active provider and clears elsewhere", async () => {
	const h = harness();
	await h.fire("session_start", { reason: "startup" });
	await tick();
	assert.equal(h.status(), "🐳 DeepSeek 余额：¥110.00");

	h.setModel(KIMI);
	await h.fire("model_select");
	await tick();
	assert.equal(h.status(), "🌙 Kimi 余额：¥50.00");

	h.setModel(CODEX);
	await h.fire("model_select");
	await tick();
	assert.ok(h.status() !== undefined, "Codex subscription should own the footer");

	h.setModel(ANTHROPIC);
	await h.fire("model_select");
	await tick();
	assert.equal(h.status(), undefined, "unsupported providers must clear the entry");

	assert.deepEqual([...new Set(h.statusHistory.map((entry) => entry.key))], ["pi-usage"]);
});

test("/pi-usage opens the balance panel for deepseek and kimi", async () => {
	const h = harness();
	await h.fire("session_start", { reason: "startup" });
	await h.command("pi-usage");
	const deepseekPanel = h.panels.at(-1)!;
	assert.ok(deepseekPanel instanceof BalancePanel);
	assert.match(deepseekPanel.render(60).join("\n"), /🐳 DeepSeek 余额/);
	assert.match(deepseekPanel.render(60).join("\n"), /110\.00/);

	h.setModel(KIMI);
	await h.fire("model_select");
	await h.command("pi-usage");
	const kimiPanel = h.panels.at(-1)!;
	assert.ok(kimiPanel instanceof BalancePanel);
	assert.match(kimiPanel.render(60).join("\n"), /🌙 Kimi 余额/);
	assert.match(kimiPanel.render(60).join("\n"), /50\.00/);
});

test("/pi-usage opens the quota panel on the Codex subscription and warns elsewhere", async () => {
	const h = harness({ model: CODEX });
	await h.fire("session_start", { reason: "startup" });
	await h.command("pi-usage");
	assert.ok(h.panels.at(-1) instanceof QuotaPanel);

	h.setModel(ANTHROPIC);
	await h.fire("model_select");
	const panels = h.panels.length;
	await h.command("pi-usage");
	assert.equal(h.panels.length, panels, "no panel for an unsupported provider");
	assert.match(h.notices.at(-1)!.message, /没有可用的用量面板/);
});

test("/pi-usage rejects arguments and Codex Fast only warns outside the subscription", async () => {
	const h = harness({ model: DEEPSEEK });
	await h.fire("session_start", { reason: "startup" });
	await h.command("pi-usage", "codex");
	assert.match(h.notices.at(-1)!.message, /用法：\/pi-usage/);

	await h.command("fast", "on");
	assert.match(h.notices.at(-1)!.message, /Fast 仅适用于官方 Codex 订阅/);
});
