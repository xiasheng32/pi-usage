/**
 * pi-usage — one usage HUD for the active model.
 *
 * Three providers share a single footer status key (`pi-usage`) and one detail
 * overlay that follows the active model:
 *
 * - `deepseek`  → account balance (api.deepseek.com), see src/balance/deepseek.ts
 * - `moonshotai-cn` → account balance (api.moonshot.cn), see src/balance/kimi.ts
 * - `openai-codex` OAuth subscription → quota, reset cards and session-local
 *   Fast mode, see src/codex/*
 *
 * Commands: `/pi-usage` (refresh + open the active provider's panel) and
 * `/fast on|off` (Codex subscription only).
 *
 * Refresh: session start (immediate) + 60s poll + agent_settled (30s throttle).
 * The footer entry exists only while the active model belongs to a supported
 * provider; switching away clears it and stops polling that provider.
 */

import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { createBalanceRuntime, isOffline, POLL_MS } from "../src/balance/core.ts";
import type { BalanceRuntime } from "../src/balance/core.ts";
import * as deepseek from "../src/balance/deepseek.ts";
import * as kimi from "../src/balance/kimi.ts";
import { FAST_ENTRY, FastModeController, isCodexSubscription, restoreFastMode } from "../src/codex/fast-mode.ts";
import type { FastCapability, FastModel } from "../src/codex/fast-mode.ts";
import { FastCatalog } from "../src/codex/fast-catalog.ts";
import { createFastProvider } from "../src/codex/fast-provider.ts";
import { detailLines as quotaDetailLines, PROVIDER, QuotaController, statusLine as quotaStatusLine } from "../src/codex/quota.ts";
import { BalancePanel, QuotaPanel } from "../src/panels.ts";
import { isCodexCandidate, resolveUsage, usesCodexSubscription } from "../src/registry.ts";
import type { BalanceProviderId } from "../src/registry.ts";

const STATUS_KEY = "pi-usage";

export default function piUsage(pi: ExtensionAPI): void {
	// State is factory-local: reloads and different sessions cannot share requests.
	let balance: { runtime: BalanceRuntime; provider: BalanceProviderId } | null = null;
	let quota: QuotaController | null = null;
	let timer: ReturnType<typeof setInterval> | undefined;
	let activeContext: ExtensionContext | undefined;
	let installation: {
		registry: ExtensionContext["modelRegistry"];
		provider: Provider;
		previousNative: Provider | undefined;
		previousLegacy: ReturnType<ExtensionContext["modelRegistry"]["getRegisteredProviderConfig"]>;
	} | undefined;

	function installFast(ctx: ExtensionContext): void {
		if (installation) return;
		const registry = ctx.modelRegistry;
		if (typeof registry.getProvider !== "function"
			|| typeof registry.getRegisteredNativeProvider !== "function"
			|| typeof registry.getRegisteredProviderConfig !== "function"
			|| typeof pi.unregisterProvider !== "function") {
			ctx.ui.notify("Fast 无法安装：宿主缺少 provider 生命周期 API；模型目录保持不变。", "warning");
			return;
		}
		const native = registry.getProvider(PROVIDER);
		if (!native) {
			ctx.ui.notify("Fast 无法安装：宿主未提供 Codex provider；模型目录保持不变。", "warning");
			return;
		}
		const previousNative = registry.getRegisteredNativeProvider(PROVIDER);
		const previousLegacy = registry.getRegisteredProviderConfig(PROVIDER);
		const provider = createFastProvider(native, prepareFast);
		pi.registerProvider(provider);
		installation = { registry, provider, previousNative, previousLegacy };
	}

	function uninstallFast(): void {
		const installed = installation;
		installation = undefined;
		if (!installed || installed.registry.getRegisteredNativeProvider(PROVIDER) !== installed.provider) return;
		// Do not overwrite another extension's later registration. Unregistering
		// first also discards our composed models.json layer before restoration.
		pi.unregisterProvider(PROVIDER);
		if (installed.previousNative) pi.registerProvider(installed.previousNative);
		else if (installed.previousLegacy) pi.registerProvider(PROVIDER, installed.previousLegacy);
	}

	const fast = new FastModeController();
	let fastGeneration = 0;
	let preferenceRevision = 0;
	let capabilityRevision = 0;
	let latestCapability = 0;
	const catalog = new FastCatalog({
		resolveAuth: async () => activeContext?.modelRegistry.getProviderAuth(PROVIDER),
		version: VERSION, offline: isOffline(process.env.PI_OFFLINE),
	});
	const modelKey = (ctx: ExtensionContext) => JSON.stringify([ctx.model?.provider, ctx.model?.api, ctx.model?.id, ctx.model?.baseUrl]);

	/** Repaint the single footer entry from whichever provider is active now. */
	function updateStatus(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		const selection = resolveUsage(ctx);
		if (selection?.kind === "balance" && balance && selection.provider === balance.provider) {
			const status = balance.runtime.status(Date.now());
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(status.color, status.text));
			return;
		}
		if (selection?.kind === "quota" && quota) {
			const status = quotaStatusLine(quota.getState(), Date.now());
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(status.color, status.text + fast.suffix()));
			return;
		}
		// Late callbacks and /pi-usage must not resurrect the footer elsewhere.
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	function createRuntime(ctx: ExtensionContext, provider: BalanceProviderId): BalanceRuntime {
		const offline = isOffline(process.env.PI_OFFLINE);
		let runtime: BalanceRuntime | null = null;
		// Late callbacks from a replaced runtime must not repaint the footer.
		const onChange = () => { if (activeContext && runtime && balance?.runtime === runtime) updateStatus(activeContext); };
		if (provider === deepseek.PROVIDER) {
			runtime = createBalanceRuntime({
				apiUrl: deepseek.API_URL, parse: deepseek.parseBalance, brand: deepseek.brand, offline, onChange,
				resolveAuth: () => ctx.modelRegistry.getApiKeyForProvider(deepseek.PROVIDER),
			});
		} else {
			runtime = createBalanceRuntime({
				apiUrl: kimi.API_URL, parse: kimi.parseBalance, brand: kimi.brand, offline, onChange,
				resolveAuth: () => ctx.modelRegistry.getApiKeyForProvider(kimi.PROVIDER),
			});
		}
		return runtime;
	}

	function ensureBalance(ctx: ExtensionContext, provider: BalanceProviderId): BalanceRuntime {
		if (balance && balance.provider === provider) return balance.runtime;
		balance?.runtime.dispose();
		const runtime = createRuntime(ctx, provider);
		balance = { runtime, provider };
		updateStatus(ctx);
		return runtime;
	}

	function startBalance(ctx: ExtensionContext, provider: BalanceProviderId): void {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		const runtime = ensureBalance(ctx, provider);
		void runtime.refresh(true);
	}

	function stopBalance(ctx: ExtensionContext): void {
		balance?.runtime.dispose();
		balance = null;
		updateStatus(ctx);
	}

	function getQuotaController(ctx: ExtensionContext): QuotaController {
		if (!quota) {
			const instance = new QuotaController({
				resolveAuth: () => ctx.modelRegistry.getProviderAuth(PROVIDER),
				offline: isOffline(process.env.PI_OFFLINE),
				// Late callbacks must not repaint a disposed controller or another provider.
				onChange: () => {
					if (quota === instance && activeContext && usesCodexSubscription(activeContext)) updateStatus(activeContext);
				},
			});
			quota = instance;
		}
		return quota;
	}

	function hideQuota(ctx: ExtensionContext): void {
		// Model changes must not erase this session's consumption locks or cooldowns.
		quota?.suspend();
		updateStatus(ctx);
	}

	function stopQuota(ctx: ExtensionContext): void {
		quota?.dispose();
		quota = null;
		updateStatus(ctx);
	}

	function refreshQuota(ctx: ExtensionContext, instance: QuotaController): void {
		if (!usesCodexSubscription(ctx)) {
			// Logout does not emit model_select. Keep the controller for a later login,
			// but cancel old work and clear the previous account immediately.
			instance.suspend();
			catalog.reset();
			fast.setCapability({ kind: "unknown", reason: "Codex 登录已变化" });
			fast.resetResponse();
			updateStatus(ctx);
			return;
		}
		void instance.refresh();
		updateStatus(ctx);
	}

	function startQuota(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui" || !ctx.hasUI || !isCodexCandidate(ctx)) return;
		refreshQuota(ctx, getQuotaController(ctx));
	}

	/** One timer for the active provider; nothing is polled when the model is unsupported. */
	function ensureTimer(): void {
		if (timer !== undefined || isOffline(process.env.PI_OFFLINE)) return;
		if (!balance && !quota) return;
		timer = setInterval(() => {
			if (!activeContext) return;
			if (balance) {
				void balance.runtime.refresh();
				updateStatus(activeContext);
			} else if (quota) {
				// Also re-checks the login, so a logged-out Codex model recovers here.
				refreshQuota(activeContext, quota);
			}
		}, POLL_MS);
		timer.unref();
	}

	function stopTimer(): void {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
	}

	async function readCapability(ctx: ExtensionContext) {
		const owner = fastGeneration;
		const revision = ++capabilityRevision;
		const key = modelKey(ctx);
		const session = ctx.sessionManager.getSessionId();
		const capability = await catalog.read(ctx.model, usesCodexSubscription(ctx));
		if (owner !== fastGeneration || key !== modelKey(ctx) || session !== ctx.sessionManager.getSessionId()) return undefined;
		if (!usesCodexSubscription(ctx)) {
			catalog.reset();
			fast.setCapability({ kind: "unknown", reason: "Codex 登录已变化" });
			updateStatus(ctx);
			return undefined;
		}
		if (revision >= latestCapability) {
			latestCapability = revision;
			fast.setCapability(capability);
			updateStatus(ctx);
		}
		return capability;
	}

	/** Apply the current model to the HUD: start, switch or clear the active provider. */
	function syncActive(ctx: ExtensionContext): void {
		const selection = resolveUsage(ctx);
		if (selection?.kind === "balance") {
			if (quota) hideQuota(ctx);
			if (!balance || balance.provider !== selection.provider) startBalance(ctx, selection.provider);
			else updateStatus(ctx);
			return;
		}
		if (selection?.kind === "quota" || isCodexCandidate(ctx)) {
			if (balance) stopBalance(ctx);
			startQuota(ctx);
			return;
		}
		if (balance) stopBalance(ctx);
		if (quota) hideQuota(ctx);
		stopTimer();
		updateStatus(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		installFast(ctx);
		fastGeneration++;
		preferenceRevision++;
		catalog.reset();
		activeContext = ctx;
		stopTimer();
		stopBalance(ctx);
		stopQuota(ctx);
		fast.resetSession(restoreFastMode(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId()));
		syncActive(ctx);
		ensureTimer();
		const selection = resolveUsage(ctx);
		if (fast.enabled && selection?.kind === "quota") await readCapability(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		fastGeneration++;
		preferenceRevision++;
		activeContext = ctx;
		fast.resetResponse();
		fast.setCapability({ kind: "unknown" });
		syncActive(ctx);
		ensureTimer();
		const selection = resolveUsage(ctx);
		if (fast.enabled && selection?.kind === "quota") void readCapability(ctx);
	});

	// The payload event exposes no request credentials. Bind the final tier to
	// the native provider's already-resolved token, not the current login.
	function prepareFast(model: FastModel, apiKey: string | undefined, signal: AbortSignal | undefined) {
		const owner = fastGeneration;
		const revision = preferenceRevision;
		const key = JSON.stringify([model.provider, model.api, model.id, model.baseUrl]);
		const applicable = !!activeContext && key === modelKey(activeContext)
			&& isCodexSubscription(model, usesCodexSubscription(activeContext));
		return async (payload: unknown) => {
			if (!applicable) return undefined;
			const current = () => owner === fastGeneration && revision === preferenceRevision
				&& !!activeContext && key === modelKey(activeContext) && usesCodexSubscription(activeContext);
			const capability: FastCapability = fast.enabled && current()
				? await catalog.readForAuth(model, true, apiKey ? { source: "OAuth", auth: { apiKey } } : undefined, signal)
				: { kind: "unknown" };
			if (!current()) {
				// A replaced session/model must not mutate the new response tracker.
				if (payload !== null && typeof payload === "object" && !Array.isArray(payload)
					&& (payload as Record<string, unknown>).model === model.id && Array.isArray((payload as Record<string, unknown>).input)) {
					return { ...payload, service_tier: "default" };
				}
				return undefined;
			}
			const result = fast.transform(payload, model, true, capability);
			if (activeContext) updateStatus(activeContext);
			return result;
		};
	}

	pi.on("before_provider_request", async (_event, ctx) => {
		activeContext = ctx;
		if (fast.enabled && usesCodexSubscription(ctx)) await readCapability(ctx);
	});

	pi.on("provider_stream_event", (event, ctx) => {
		if (event.provider !== PROVIDER || !usesCodexSubscription(ctx)) return;
		const previousPhase = fast.phase;
		fast.observe(event);
		if (previousPhase !== fast.phase) updateStatus(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		activeContext = ctx;
		fast.settle();
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		const selection = resolveUsage(ctx);
		if (selection?.kind === "balance" && balance) {
			void balance.runtime.refresh();
			updateStatus(ctx);
		} else if (quota && (selection?.kind === "quota" || isCodexCandidate(ctx))) {
			refreshQuota(ctx, quota);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		uninstallFast();
		fastGeneration++;
		preferenceRevision++;
		catalog.reset();
		stopTimer();
		stopBalance(ctx);
		stopQuota(ctx);
		fast.setEnabled(false);
		activeContext = undefined;
	});

	pi.registerCommand("fast", {
		description: "仅当前会话：/fast on 开启 Codex Fast，/fast off 关闭",
		handler: async (args, ctx) => {
			activeContext = ctx;
			const value = args.trim();
			if (value !== "on" && value !== "off") {
				ctx.ui.notify("用法：/fast on 或 /fast off（仅当前会话，新会话默认关闭）", "warning");
				return;
			}
			const enabled = value === "on";
			if (enabled && !usesCodexSubscription(ctx)) {
				ctx.ui.notify("Fast 仅适用于官方 Codex 订阅 OAuth 模型，请先切换到 openai-codex。", "warning");
				return;
			}
			const revision = ++preferenceRevision;
			const owner = fastGeneration;
			const session = ctx.sessionManager.getSessionId();
			if (enabled) {
				const capability = await readCapability(ctx);
				if (!capability || !usesCodexSubscription(ctx) || revision !== preferenceRevision || owner !== fastGeneration || session !== ctx.sessionManager.getSessionId()) return;
				if (capability.kind !== "supported") {
					ctx.ui.notify(capability.reason ?? (capability.kind === "unsupported" ? "当前模型的官方目录不支持 Fast。" : "当前模型的 Fast 能力未知，未启用 Fast。"), "warning");
					return;
				}
			}
			try {
				pi.appendEntry(FAST_ENTRY, { enabled, sessionId: ctx.sessionManager.getSessionId() });
			} catch {
				ctx.ui.notify("无法保存当前会话的 Fast 开关，原状态保持不变。", "warning");
				return;
			}
			fast.setEnabled(enabled);
			updateStatus(ctx);
			ctx.ui.notify(enabled ? "Fast 路由已开启，仅当前会话（priority）；订阅额度按标准的 2.5 倍消耗。面板独立显示服务端返回档位。"
				: "Fast 已关闭，仅当前会话。", "info");
		},
	});

	pi.registerCommand("pi-usage", {
		description: "查看当前模型的用量：DeepSeek / Kimi 余额或 Codex 额度",
		handler: async (args, ctx) => {
			activeContext = ctx;
			if (!ctx.hasUI) return;
			if (args.trim()) {
				ctx.ui.notify("用法：/pi-usage", "warning");
				return;
			}
			const selection = resolveUsage(ctx);
			if (!selection && !isCodexCandidate(ctx)) {
				ctx.ui.notify("当前模型没有可用的用量面板：请切换到 deepseek、moonshotai-cn 或 openai-codex 订阅模型。", "warning");
				return;
			}
			if (selection?.kind === "balance") {
				const runtime = ensureBalance(ctx, selection.provider);
				await runtime.refresh(true);
				if (balance?.runtime !== runtime) return; // Context may have been invalidated while awaiting.
				if (ctx.mode === "tui") {
					await ctx.ui.custom<undefined>(
						(tui, _theme, _keybindings, done) => new BalancePanel(tui, ctx, runtime, () => done(undefined)),
						{ overlay: true, overlayOptions: { anchor: "center", width: 64, margin: 1 } },
					);
				} else {
					const summary = runtime.summary();
					ctx.ui.notify(summary.text, summary.type);
				}
				return;
			}
			const instance = getQuotaController(ctx);
			if (usesCodexSubscription(ctx)) await readCapability(ctx);
			await instance.refresh();
			if (quota !== instance) return; // Context may have been invalidated while awaiting auth.
			if (ctx.mode === "tui") {
				while (quota === instance) {
					const action = await ctx.ui.custom<"use" | undefined>(
						(tui, _theme, _keybindings, done) => new QuotaPanel(tui, ctx, instance, done, fast),
						{ overlay: true, overlayOptions: { anchor: "center", width: 68, margin: 1 } },
					);
					if (quota !== instance || action !== "use") break;
					// The overlay is disposed before opening built-in dialogs. Only this u path consumes.
					await instance.useResetCredit({
						select: (title, options) => ctx.ui.select(title, options),
						notify: (message, type) => ctx.ui.notify(message, type),
					});
				}
			} else {
				const state = instance.getState();
				ctx.ui.notify([...fast.details(ctx.model, usesCodexSubscription(ctx)), "", ...quotaDetailLines(state, Date.now())].join("\n"), state.error ? "warning" : "info");
			}
		},
	});
}
