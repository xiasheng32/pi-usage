/**
 * DeepSeek balance adapter.
 *
 * Keeps the payload validation from xiasheng32/pi-deepseek: signed amounts are
 * accepted (clawed-back grants can make topped_up_balance negative) and every
 * currency row is surfaced as reported.
 *
 * The refresh policy lives in ./core.ts.
 */

import {
	BalanceDataError, currencySymbol, detailLines as coreDetailLines, isRecord,
	statusLine as coreStatusLine, summaryLine as coreSummaryLine,
} from "./core.ts";
import type { BalanceBrand, BalanceInfo, BalanceSnapshot, BalanceState } from "./core.ts";

export const PROVIDER = "deepseek";
export const API_URL = "https://api.deepseek.com/user/balance";

export interface DeepSeekBalanceInfo extends BalanceInfo {
	totalBalance: string;
	grantedBalance: string;
	toppedUpBalance: string;
}

function decimal(value: unknown): string {
	// DeepSeek reports signed amounts: clawed-back grants can make topped_up_balance
	// (and occasionally total_balance) negative, e.g. "-0.23". Rejecting the sign
	// turned those real responses into "数据异常".
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "string" && /^-?\d{1,18}(?:\.\d{1,8})?$/.test(value)) return value;
	throw new BalanceDataError();
}

/** Keep only validated fields; never surface raw response content. */
export function parseBalance(payload: unknown, receivedAt: number): BalanceSnapshot<DeepSeekBalanceInfo> {
	if (!isRecord(payload)) throw new BalanceDataError();
	if (typeof payload.is_available !== "boolean") throw new BalanceDataError();
	if (!Array.isArray(payload.balance_infos) || payload.balance_infos.length > 32) throw new BalanceDataError();
	const infos = payload.balance_infos.map((row) => {
		if (!isRecord(row)) throw new BalanceDataError();
		if (typeof row.currency !== "string" || !/^[A-Z0-9]{2,8}$/.test(row.currency)) throw new BalanceDataError();
		return {
			currency: row.currency,
			totalBalance: decimal(row.total_balance),
			grantedBalance: decimal(row.granted_balance),
			toppedUpBalance: decimal(row.topped_up_balance),
		};
	});
	return { isAvailable: payload.is_available, infos, receivedAt };
}

export const brand: BalanceBrand<DeepSeekBalanceInfo> = {
	id: PROVIDER,
	icon: "🐳",
	label: "DeepSeek",
	loginCommand: PROVIDER,
	envVariable: "DEEPSEEK_API_KEY",
	amount: (info) => `${currencySymbol(info.currency)}${info.totalBalance}`,
	detailRows: (info) => [
		`总余额    ${currencySymbol(info.currency)}${info.totalBalance}`,
		`赠送余额  ${info.grantedBalance}`,
		`充值余额  ${info.toppedUpBalance}`,
	],
	statusGap: "      ",
	detailAccent: /^总余额/,
	summaryEntry: (info) => `${currencySymbol(info.currency)}${info.totalBalance}（赠送 ${info.grantedBalance} / 充值 ${info.toppedUpBalance}）`,
	summaryWarnsWhenUnavailable: false,
};

/** Provider-bound views so callers and tests need no brand argument. */
export function statusLine(state: BalanceState<DeepSeekBalanceInfo>, now: number) {
	return coreStatusLine(brand, state, now);
}

export function detailLines(state: BalanceState<DeepSeekBalanceInfo>, now: number): string[] {
	return coreDetailLines(brand, state, now);
}

export function summaryLine(state: BalanceState<DeepSeekBalanceInfo>): { text: string; type: "info" | "warning" | "error" } {
	return coreSummaryLine(brand, state);
}
