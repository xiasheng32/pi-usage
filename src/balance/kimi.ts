/**
 * Kimi (moonshotai-cn) balance adapter.
 *
 * Keeps the payload validation from xiasheng32/pi-kimi: only validated fields
 * are surfaced, cash arrears are netted against the voucher balance, and the
 * reported precision (including exponents) is preserved.
 *
 * The refresh policy lives in ./core.ts.
 */

import {
	BalanceDataError, currencySymbol, detailLines as coreDetailLines, isRecord,
	statusLine as coreStatusLine, summaryLine as coreSummaryLine,
} from "./core.ts";
import type { BalanceBrand, BalanceInfo, BalanceSnapshot, BalanceState } from "./core.ts";

export const PROVIDER = "moonshotai-cn";
export const API_URL = "https://api.moonshot.cn/v1/users/me/balance";

export interface KimiBalanceInfo extends BalanceInfo {
	availableBalance: string;
	voucherBalance: string;
	cashBalance: string;
}

function expandExponential(value: string): string {
	const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(value);
	if (!match) return value;
	const [, sign, integer, fraction = "", exponentText] = match;
	const digits = integer + fraction;
	const decimalPosition = integer.length + Number(exponentText);
	if (decimalPosition <= 0) return `${sign}0.${"0".repeat(-decimalPosition)}${digits}`;
	if (decimalPosition >= digits.length) return `${sign}${digits}${"0".repeat(decimalPosition - digits.length)}`;
	return `${sign}${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
}

function decimal(value: unknown): string {
	// Keep API numbers and bounded plain decimal strings without rounding.
	// A cash balance can be negative; voucher balances are checked separately.
	if (typeof value === "number" && Number.isFinite(value)) return expandExponential(String(value));
	if (typeof value === "string" && /^-?\d{1,18}(?:\.\d{1,18})?$/.test(value)) return value;
	throw new BalanceDataError();
}

function isNegativeBalance(value: string): boolean {
	return value.startsWith("-") && /[1-9]/.test(value);
}

function isPositiveBalance(value: string): boolean {
	return !value.startsWith("-") && /[1-9]/.test(value);
}

function addBalances(left: string, right: string): string {
	const [leftInteger, leftFraction = ""] = left.replace(/^-/, "").split(".");
	const [rightInteger, rightFraction = ""] = right.replace(/^-/, "").split(".");
	const scale = Math.max(leftFraction.length, rightFraction.length);
	const asUnits = (integer: string, fraction: string, value: string) => {
		const magnitude = BigInt(`${integer}${fraction.padEnd(scale, "0")}`);
		return value.startsWith("-") ? -magnitude : magnitude;
	};
	const sum = asUnits(leftInteger, leftFraction, left) + asUnits(rightInteger, rightFraction, right);
	const negative = sum < 0n;
	const magnitude = (negative ? -sum : sum).toString().padStart(scale + 1, "0");
	if (!scale) return `${negative ? "-" : ""}${magnitude}`;
	return `${negative ? "-" : ""}${magnitude.slice(0, -scale)}.${magnitude.slice(-scale)}`;
}

/** Keep only validated fields; never surface raw response content. */
export function parseBalance(payload: unknown, receivedAt: number): BalanceSnapshot<KimiBalanceInfo> {
	if (!isRecord(payload) || payload.code !== 0 || payload.status !== true || !isRecord(payload.data)) {
		throw new BalanceDataError();
	}
	const reportedAvailableBalance = decimal(payload.data.available_balance);
	const voucherBalance = decimal(payload.data.voucher_balance);
	const cashBalance = decimal(payload.data.cash_balance);
	if (Number(voucherBalance) < 0) throw new BalanceDataError();
	// When cash is in arrears, the API may report available_balance as zero even
	// though the account overview shows the net voucher-plus-cash balance.
	const availableBalance = isNegativeBalance(cashBalance)
		? addBalances(voucherBalance, cashBalance)
		: reportedAvailableBalance;
	const info: KimiBalanceInfo = {
		currency: "CNY",
		availableBalance,
		voucherBalance,
		cashBalance,
	};
	return { isAvailable: isPositiveBalance(info.availableBalance), infos: [info], receivedAt };
}

export function formatBalance(value: string): string {
	return expandExponential(value);
}

export function formatCurrencyBalance(currency: string, value: string): string {
	const amount = formatBalance(value);
	const symbol = currencySymbol(currency);
	return amount.startsWith("-") ? `-${symbol}${amount.slice(1)}` : `${symbol}${amount}`;
}

export const brand: BalanceBrand<KimiBalanceInfo> = {
	id: PROVIDER,
	icon: "🌙",
	label: "Kimi",
	loginCommand: PROVIDER,
	envVariable: "MOONSHOT_API_KEY",
	amount: (info) => formatCurrencyBalance(info.currency, info.availableBalance),
	detailRows: (info) => [
		`可用余额    ${formatCurrencyBalance(info.currency, info.availableBalance)}`,
		`代金券余额  ${formatBalance(info.voucherBalance)}`,
		`现金余额    ${formatBalance(info.cashBalance)}`,
	],
	statusGap: "        ",
	detailAccent: /^可用余额/,
	summaryEntry: (info) => `${formatCurrencyBalance(info.currency, info.availableBalance)}（代金券 ${formatBalance(info.voucherBalance)} / 现金 ${formatBalance(info.cashBalance)}）`,
	summaryWarnsWhenUnavailable: true,
};

/** Provider-bound views so callers and tests need no brand argument. */
export function statusLine(state: BalanceState<KimiBalanceInfo>, now: number) {
	return coreStatusLine(brand, state, now);
}

export function detailLines(state: BalanceState<KimiBalanceInfo>, now: number): string[] {
	return coreDetailLines(brand, state, now);
}

export function summaryLine(state: BalanceState<KimiBalanceInfo>): { text: string; type: "info" | "warning" | "error" } {
	return coreSummaryLine(brand, state);
}
