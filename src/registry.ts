/**
 * Provider registry: decides which usage panel the active model belongs to.
 *
 * One extension serves three providers, so this file is the single place that
 * answers "whose panel should the footer and /pi-usage show right now?".
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PROVIDER as DEEPSEEK_PROVIDER } from "./balance/deepseek.ts";
import { PROVIDER as KIMI_PROVIDER } from "./balance/kimi.ts";
import { isCodexSubscription } from "./codex/fast-mode.ts";
import { PROVIDER as CODEX_PROVIDER } from "./codex/quota.ts";

export const BALANCE_PROVIDERS = [DEEPSEEK_PROVIDER, KIMI_PROVIDER] as const;
export type BalanceProviderId = (typeof BALANCE_PROVIDERS)[number];

export type UsageSelection =
	| { kind: "balance"; provider: BalanceProviderId }
	| { kind: "quota" };

/** Codex panels and Fast mode are only valid for the official OAuth subscription. */
export function usesCodexSubscription(ctx: ExtensionContext): boolean {
	return !!ctx.model && isCodexSubscription(ctx.model, ctx.modelRegistry.isUsingOAuth(ctx.model));
}

/**
 * True for a Codex subscription model even while logged out. The controller is
 * kept alive in that state so a later login can start the HUD without a
 * model_select event, which is also why the endpoint is polled while suspended.
 */
export function isCodexCandidate(ctx: ExtensionContext): boolean {
	return isCodexSubscription(ctx.model, true);
}

/**
 * Resolve the panel for the current model. Anything else (including a Codex
 * model without OAuth) returns undefined, which clears the footer entry.
 */
export function resolveUsage(ctx: ExtensionContext): UsageSelection | undefined {
	const provider = ctx.model?.provider;
	if (provider === DEEPSEEK_PROVIDER) return { kind: "balance", provider: DEEPSEEK_PROVIDER };
	if (provider === KIMI_PROVIDER) return { kind: "balance", provider: KIMI_PROVIDER };
	if (provider === CODEX_PROVIDER && usesCodexSubscription(ctx)) return { kind: "quota" };
	return undefined;
}
