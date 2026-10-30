import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import {
	API_URL, detailLines, detailSections, extractAccountId, isOffline, parseQuota, parseRetryAfter,
	QuotaController, resetRemaining, statusLine, THROTTLE_MS, TIMEOUT_MS, windowLabel,
	RESET_CREDITS_URL, CONSUME_RESET_URL, parseResetCredits, parseConsumeResult, quotaBar, isLowQuota,
} from "../src/codex/quota.ts";
import type {
	ControllerOptions, ProviderAuth, QuotaSnapshot, QuotaState, QuotaWindow,
	ResetCredit, ResetCreditsSnapshot, ResetCreditsState, ResetCreditUI,
} from "../src/codex/quota.ts";

// Tripwire: tests must never fall through to a real account/network request.
globalThis.fetch = async () => { throw new Error("Unexpected live fetch in offline test"); };
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
function present<T>(value: T | null | undefined): T {
	assert.ok(value != null, "Expected test data to be present");
	return value;
}
const quotaSnapshot = (state: QuotaState): QuotaSnapshot => present(state.snapshot);
const resetCredits = (state: QuotaState): ResetCreditsState => present(state.resetCredits);
const resetSnapshot = (state: QuotaState): ResetCreditsSnapshot => present(resetCredits(state).snapshot);
const resetCards = (state: QuotaState): ResetCredit[] => present(resetSnapshot(state).credits);
function token(accountId = "synthetic-account-A") {
	return [
		Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
		Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId }, note: "合成数据" })).toString("base64url"),
		"synthetic-signature",
	].join(".");
}
const oauth = (id?: string): ProviderAuth => ({ source: "OAuth", auth: { apiKey: token(id) } });

// Wire fixtures deliberately include absent/invalid fields; they are not parsed snapshots.
interface WindowFixture {
	used_percent: number;
	limit_window_seconds?: number;
	reset_at?: number | string;
	reset_after_seconds?: number;
}
interface UsageFixture {
	plan_type?: string;
	rate_limit: {
		allowed: boolean;
		limit_reached: boolean;
		primary_window: WindowFixture;
		secondary_window: WindowFixture;
	};
	rate_limit_reset_credits?: { available_count: number };
}
interface CreditFixture {
	id?: string;
	reset_type?: string;
	status: string;
	granted_at?: string;
	expires_at?: string | null;
	redeemed_at?: string;
	title?: string;
	description?: string;
}
interface ResetFixture {
	available_count: number;
	total_earned_count: number;
	credits: CreditFixture[];
}
function payload(): UsageFixture {
	return {
		plan_type: "plus",
		rate_limit: {
			allowed: true, limit_reached: false,
			primary_window: { used_percent: 22, limit_window_seconds: 18000, reset_at: NOW / 1000 + 7200, reset_after_seconds: 7200 },
			secondary_window: { used_percent: 36, limit_window_seconds: 604800, reset_at: NOW / 1000 + 259200 },
		},
	};
}
function resetPayload(): ResetFixture {
	return {
		available_count: 2, total_earned_count: 4,
		credits: [
			{ id: "synthetic-credit-secret", reset_type: "codex_rate_limits", status: "available", granted_at: "2026-09-23T21:00:00Z", expires_at: "2026-10-22T21:00:00Z" },
			{ reset_type: "codex_rate_limits", status: "available", expires_at: "2026-10-29T18:34:00Z" },
			{ status: "redeemed", redeemed_at: "2026-10-01T12:00:00Z" },
			{ status: "expired", expires_at: "2026-10-01T00:00:00Z" },
		],
	};
}
function ready(snapshot: QuotaSnapshot): QuotaState & { snapshot: QuotaSnapshot } {
	return { phase: "ready", snapshot, lastAttemptAt: NOW, lastSuccessAt: NOW, stale: false, retryAt: null, error: null };
}

type RecordedInit = RequestInit & { headers: Record<string, string>; signal: AbortSignal };
interface RecordedRequest {
	url: Parameters<typeof globalThis.fetch>[0];
	init: RecordedInit;
}
interface ConsumeRequest extends RecordedRequest {
	init: RecordedInit & { body: string };
}
interface HarnessOptions {
	auth?: ControllerOptions["resolveAuth"];
	transport?: typeof globalThis.fetch;
	resetTransport?: typeof globalThis.fetch;
	consumeTransport?: typeof globalThis.fetch;
	offline?: boolean;
	timeoutSignal?: ControllerOptions["timeoutSignal"];
}
function assertRecordedInit(init: RequestInit | undefined): asserts init is RecordedInit {
	assert.ok(init?.signal instanceof AbortSignal);
	assert.ok(init.headers && !Array.isArray(init.headers) && !(init.headers instanceof Headers));
	assert.ok(Object.values(init.headers).every((value) => typeof value === "string"));
}
function assertConsumeInit(init: RecordedInit): asserts init is ConsumeRequest["init"] {
	assert.ok(typeof init.body === "string");
}
function consumeBody(request: ConsumeRequest): { credit_id: string; redeem_request_id: string } {
	const body: unknown = JSON.parse(request.init.body);
	assert.ok(body && typeof body === "object"
		&& "credit_id" in body && typeof body.credit_id === "string"
		&& "redeem_request_id" in body && typeof body.redeem_request_id === "string");
	return { credit_id: body.credit_id, redeem_request_id: body.redeem_request_id };
}
function harness({ auth = async () => oauth(), transport = async () => Response.json(payload()), resetTransport = async () => Response.json(resetPayload()), consumeTransport = async () => Response.json({ code: "reset", windows_reset: 2 }), offline = false, timeoutSignal }: HarnessOptions = {}) {
	let time = NOW;
	let authCalls = 0;
	const requests: RecordedRequest[] = [];
	const resetRequests: RecordedRequest[] = [];
	const consumeRequests: ConsumeRequest[] = [];
	const allRequests: RecordedRequest[] = [];
	const changes: QuotaState[] = [];
	const controller = new QuotaController({
		now: () => time,
		resolveAuth: async () => { authCalls++; return auth(); },
		fetch: async (url, init) => {
			assertRecordedInit(init);
			allRequests.push({ url, init });
			if (url === CONSUME_RESET_URL) { assertConsumeInit(init); consumeRequests.push({ url, init }); return consumeTransport(url, init); }
			if (url === RESET_CREDITS_URL) { resetRequests.push({ url, init }); return resetTransport(url, init); }
			requests.push({ url, init }); return transport(url, init);
		},
		onChange: (state) => changes.push(state),
		offline, timeoutSignal,
	});
	return {
		controller, requests, resetRequests, consumeRequests, allRequests, changes,
		advance: (milliseconds: number) => { time += milliseconds; },
		get now() { return time; },
		get authCalls() { return authCalls; },
	};
}
function assertSanitized(state: QuotaState, ...secrets: string[]) {
	const output = JSON.stringify(state) + detailLines(state, NOW).join("\n") + statusLine(state, NOW).text;
	for (const secret of secrets) assert.ok(!output.includes(secret), "State and UI must not contain authentication/provider secrets");
}

interface ResetUIOptions {
	pick?: boolean;
	choice?: number;
	confirm?: boolean;
	onSelect?: (count: number, options: string[]) => Promise<void>;
}
interface RecordedUI extends ResetCreditUI {
	dialogs: { title: string; options: string[] }[];
	notices: { message: string; type: "info" | "warning" }[];
}
function resetUI({ pick = true, choice = 0, confirm = true, onSelect }: ResetUIOptions = {}): RecordedUI {
	const dialogs: RecordedUI["dialogs"] = [];
	const notices: RecordedUI["notices"] = [];
	return {
		dialogs, notices,
		select: async (title, options) => {
			dialogs.push({ title, options: [...options] });
			if (onSelect) await onSelect(dialogs.length, options);
			return dialogs.length === 1 ? (pick ? options[choice] : undefined) : (confirm ? options[1] : options[0]);
		},
		notify: (message, type) => notices.push({ message, type }),
	};
}

function assertResetSanitized(h: ReturnType<typeof harness>, ui: RecordedUI) {
	const id = h.consumeRequests.length ? consumeBody(h.consumeRequests[0]).redeem_request_id : "unused-request-id";
	const secrets = [token(), "synthetic-account-A", "synthetic-credit-secret", id, "synthetic-body-secret"];
	assertSanitized(h.controller.getState(), ...secrets);
	for (const state of h.changes) assertSanitized(state, ...secrets);
	const text = JSON.stringify({ dialogs: ui.dialogs, notices: ui.notices });
	for (const secret of secrets) assert.ok(!text.includes(secret), "Dialogs and notices must stay sanitized");
}

function localDateTime(timestamp: number): string {
	const date = new Date(timestamp);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

test("detail sections expose stable fields and preserve full quota dates and every card record", () => {
	const state: QuotaState = {
		...ready(parseQuota(payload(), NOW)),
		resetCredits: { snapshot: parseResetCredits(resetPayload(), NOW), stale: false, error: null, retryAt: null },
	};
	const before = structuredClone(state);
	const sections = detailSections(state, NOW);
	assert.deepEqual(Object.keys(sections).sort(), ["summary", "status", "quota", "resetSummary", "resets", "updated"].sort());
	assert.equal(sections.summary, "PLUS  ·  可用");
	assert.deepEqual(sections.status, []);
	assert.equal(sections.resetSummary, "可用 2 张");
	assert.equal(sections.updated, `更新于 ${localDateTime(NOW).slice(-5)} · 本机时区`);
	assert.equal(sections.quota.length, 4);
	for (const [index, window] of quotaSnapshot(state).windows.entries()) {
		assert.ok(sections.quota[index * 2].includes(`剩${window.remainingPercent}% · 已用${window.usedPercent}%`));
		assert.ok(sections.quota[index * 2 + 1].includes(localDateTime(present(window.resetAt))));
	}
	assert.deepEqual(sections.resets.filter((line) => /^  #/.test(line)), [
		"  #1 完全重置（7d + 5h） · 可用", "  #2 完全重置（7d + 5h） · 可用",
		"  #3 重置卡 · 已使用", "  #4 重置卡 · 已过期",
	]);
	for (const card of resetCards(state)) {
		const timestamp = card.status === "used" ? card.redeemedAt : card.expiresAt;
		assert.ok(sections.resets.some((line) => line.includes(localDateTime(present(timestamp)))));
	}
	assert.ok(sections.resets.includes("  仅显示接口返回记录，不推断完整历史。"));
	assert.deepEqual(state, before, "section rendering must not change the cached state");
	assert.deepEqual(detailLines(state, NOW), [
		sections.summary, "", "▸ 订阅额度", ...sections.quota,
		"", `▸ 重置卡  ·  ${sections.resetSummary}`, ...sections.resets,
		"", `更新：${localDateTime(NOW)} · 本机时区`,
	]);
});

test("detail sections keep global errors separate from reset outcomes, card errors and card retries", () => {
	for (const error of [
		{ kind: "rate_limit", httpStatus: 429 }, { kind: "data" }, { kind: "timeout" }, { kind: "http", httpStatus: 503 },
	] as const) {
		const state: QuotaState = {
			...ready(parseQuota(payload(), NOW)), phase: "network_error", stale: true,
			error: { kind: "network" }, retryAt: NOW + 120_000,
			resetUse: { message: "synthetic reset result", warning: true },
			resetCredits: { snapshot: parseResetCredits(resetPayload(), NOW), stale: true, error, retryAt: NOW + 180_000 },
		};
		const sections = detailSections(state, NOW);
		assert.deepEqual(sections.status, [
			"额度查询网络失败，请检查连接或代理", "以下为过期缓存，不代表当前剩余额度。", "自动重试：2m后",
		]);
		assert.equal(sections.resetSummary, "可用 2 张 [过期缓存]");
		assert.equal(sections.resets[0], state.resetUse?.message);
		assert.match(sections.resets[1], /明细为过期缓存/);
		assert.equal(sections.resets.at(-1), "  重置卡重试：3m后");
		assert.doesNotMatch(sections.resets.join("\n"), /额度查询网络失败|自动重试/);
		assert.doesNotMatch([...sections.status, ...sections.quota].join("\n"), /synthetic reset result|重置卡重试|明细为过期缓存/);
		assert.equal(sections.resets.filter((line) => /^  #/.test(line)).length, 4);
	}
});

test("card-only failure remains in resets while fresh usage and its summary remain visible", () => {
	const state: QuotaState = {
		...ready(parseQuota(payload(), NOW)),
		resetCredits: { snapshot: null, stale: false, error: { kind: "http", httpStatus: 502 }, retryAt: NOW + 60_000 },
	};
	const sections = detailSections(state, NOW);
	assert.equal(sections.summary, "PLUS  ·  可用");
	assert.deepEqual(sections.status, []);
	assert.equal(sections.quota.length, 4);
	assert.equal(sections.resetSummary, "可用 未知");
	assert.deepEqual(sections.resets, ["  查询失败（HTTP 502）；明细暂不可用", "  未提供使用记录 / 有效期明细", "  重置卡重试：1m后"]);
	state.resetCredits!.retryAt = NOW;
	assert.ok(!detailSections(state, NOW).resets.some((line) => line.includes("重置卡重试")));
});

test("updated uses last successful local HH:mm, stays unknown for null, and survives refresh failure", async () => {
	let fail = false;
	const h = harness({ transport: async () => {
		if (fail) throw new Error("synthetic network failure");
		return Response.json(payload());
	} });
	try {
		assert.equal(detailSections(h.controller.getState(), NOW).updated, "更新于 未知 · 本机时区");
		h.advance(7 * 60_000);
		const success = await h.controller.refresh();
		const expected = `更新于 ${localDateTime(h.now).slice(-5)} · 本机时区`;
		assert.equal(detailSections(success, h.now).updated, expected);
		fail = true;
		h.advance(83 * 60_000);
		const failed = await h.controller.refresh(true);
		assert.equal(failed.phase, "network_error");
		assert.equal(failed.lastSuccessAt, success.lastSuccessAt);
		assert.equal(detailSections(failed, h.now).updated, expected);
		assert.notEqual(failed.lastAttemptAt, failed.lastSuccessAt);
	} finally { h.controller.dispose(); }
});

test("updated follows the host timezone in isolated processes rather than UTC or a fixed offset", () => {
	for (const TZ of ["UTC", "Asia/Kathmandu", "America/St_Johns"]) {
		const source = `
			import assert from 'node:assert/strict';
			import { detailSections } from ${JSON.stringify(new URL("../src/codex/quota.ts", import.meta.url).href)};
			const lastSuccessAt = Date.UTC(2026, 9, 7, 23, 7);
			const date = new Date(lastSuccessAt);
			const time = [date.getHours(), date.getMinutes()].map(v => String(v).padStart(2, '0')).join(':');
			const state = { phase: 'ready', snapshot: null, lastAttemptAt: lastSuccessAt + 3600000,
				lastSuccessAt, stale: false, retryAt: null, error: null };
			assert.equal(detailSections(state, lastSuccessAt + 7200000).updated, '更新于 ' + time + ' · 本机时区');
		`;
		const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
			env: { ...process.env, TZ }, encoding: "utf8",
		});
		assert.equal(result.status, 0, `${TZ}: ${result.stderr || result.error?.message}`);
	}
});

test("offline and logged-out sections never expose old quota, cards, errors or reset outcomes", () => {
	for (const phase of ["offline", "not_logged_in"] as const) {
		const state: QuotaState = {
			...ready(parseQuota(payload(), NOW)), phase, stale: true, error: { kind: "network" }, retryAt: NOW + 60_000,
			resetUse: { message: "synthetic old reset outcome", warning: true },
			resetCredits: { snapshot: parseResetCredits(resetPayload(), NOW), stale: true,
				error: { kind: "rate_limit", httpStatus: 429 }, retryAt: NOW + 120_000 },
		};
		const before = structuredClone(state);
		const sections = detailSections(state, NOW);
		assert.equal(sections.summary, null);
		assert.deepEqual(sections.quota, []);
		assert.equal(sections.resetSummary, "可用 未知");
		assert.deepEqual(sections.resets, []);
		assert.deepEqual(sections.status, phase === "offline"
			? ["离线模式：未解析认证，未发起额度请求。", "取消 PI_OFFLINE / --offline 后重新启动 pi。"]
			: ["尚未登录 openai-codex。", "请在 pi 中执行 /login openai-codex。"]);
		assert.deepEqual(detailLines(state, NOW), sections.status);
		assert.deepEqual(state, before);
	}
});

test("reset cards parse known metadata and discard all account/credit secrets", () => {
	const data = resetPayload();
	data.credits[0].title = "synthetic-title-secret\u001b[31m";
	data.credits[0].description = "synthetic-description-secret";
	const cards = parseResetCredits(data, NOW);
	assert.equal(cards.availableCount, 2);
	assert.equal(cards.totalEarnedCount, 4);
	assert.deepEqual(present(cards.credits).map((card) => card.status), ["available", "available", "used", "expired"]);
	assert.equal(present(cards.credits)[0].expiresAt, Date.parse("2026-10-22T21:00:00Z"));
	assert.equal(present(cards.credits)[2].redeemedAt, Date.parse("2026-10-01T12:00:00Z"));
	const state = { ...ready(parseQuota(payload(), NOW)), resetCredits: { snapshot: cards, stale: false, error: null, retryAt: null } };
	assert.equal(statusLine(state, NOW).text, "🍧 Codex 额度：5h 78% (↻2h) 7d 64% (↻3d)");
	const detail = detailLines(state, NOW).join("\n");
	assert.match(detail, /可用 2 张/);
	assert.doesNotMatch(detail, /返回记录：|累计获得：|卡片更新：/);
	assert.equal(detail.split("\n").filter((line) => line.startsWith("更新：")).length, 1);
	assert.match(detail, /#3 重置卡 · 已使用/);
	assert.match(detail, /#4 重置卡 · 已过期/);
	assert.match(detail, /完全重置（7d \+ 5h）/);
	assert.match(detail, /仅显示接口返回记录/);
	assertSanitized(state, "synthetic-credit-secret", "synthetic-title-secret", "synthetic-description-secret", "\u001b");
});

test("card details omit history totals even when the server returns zero counts", () => {
	const cards = parseResetCredits({ available_count: 0, total_earned_count: 0, credits: [] }, NOW);
	const state = { ...ready(parseQuota(payload(), NOW)), resetCredits: { snapshot: cards, stale: false, error: null, retryAt: null } };
	const detail = detailLines(state, NOW).join("\n");
	assert.doesNotMatch(detail, /返回记录：|累计获得：/);
	assert.match(detail, /可用 0 张/);
	assert.match(detail, /暂无卡片记录/);
});

test("missing card count, missing history and zero cards are different states", () => {
	for (const bad of [null, {}, { available_count: -1 }, { available_count: "2" }, { available_count: 2, credits: {} }, { credits: [null] }]) {
		assert.throws(() => parseResetCredits(bad, NOW));
	}
	assert.equal(parseResetCredits({ credits: [{ status: "available" }] }, NOW).availableCount, null);
	assert.equal(parseResetCredits({ available_count: 0 }, NOW).credits, null);
	assert.deepEqual(parseResetCredits({ data: { available_count: 0, credits: [] } }, NOW).credits, []);
	const data = payload();
	data.rate_limit_reset_credits = { available_count: 2 };
	const state = ready(parseQuota(data, NOW));
	assert.match(detailLines(state, NOW).join("\n"), /可用 2 张/);
	assert.match(detailLines(state, NOW).join("\n"), /未提供使用记录/);
});

test("unknown card statuses/dates never masquerade as available or unlimited", () => {
	const cards = parseResetCredits({ credits: [{ status: "raw-secret", expires_at: "tomorrow", granted_at: "2026-10-07T12:00:00" }] }, NOW);
	assert.equal(present(cards.credits)[0].status, "unknown");
	assert.equal(present(cards.credits)[0].expiresAt, null);
	assert.equal(present(cards.credits)[0].grantedAt, null);
	const state = { ...ready(parseQuota(payload(), NOW)), resetCredits: { snapshot: cards, stale: false, error: null, retryAt: null } };
	assert.match(detailLines(state, NOW).join("\n"), /状态未知/);
	assert.match(detailLines(state, NOW).join("\n"), /有效期未知/);
	assertSanitized(state, "raw-secret");
});

test("credit dates strictly validate calendar, clock and offsets before consumption", async () => {
	const invalid = [
		"2027-02-29T12:00:00Z", "2100-02-29T12:00:00Z", "2028-02-30T12:00:00Z",
		"2027-04-31T12:00:00Z", "2027-00-01T12:00:00Z", "2027-13-01T12:00:00Z",
		"2027-01-00T12:00:00Z", "2027-01-32T12:00:00Z", "2027-01-01T24:00:00Z",
		"2027-01-01T12:60:00Z", "2027-01-01T12:00:60Z", "2027-01-01T12:00:00+24:00",
		"2027-01-01T12:00:00-01:60", "2027-01-01T12:00:00+1:00", "2027-01-01T12:00:00",
		"0001-02-29T00:00:00Z", "0099-02-29T00:00:00Z",
	];
	for (const date of invalid) {
		const cards = parseResetCredits({ credits: [{ status: "available", expires_at: date, granted_at: date, redeemed_at: date }] }, NOW);
		assert.deepEqual(present(cards.credits)[0], { status: "available", fullReset: false, expiresAt: null, grantedAt: null, redeemedAt: null }, date);
		for (const field of ["expires_at", "granted_at", "redeemed_at"] as const) {
			const h = harness({ resetTransport: async () => {
				const data = resetPayload(); data.credits[0][field] = date; return Response.json(data);
			} });
			await h.controller.useResetCredit(resetUI());
			assert.equal(h.consumeRequests.length, 0, `${field}: ${date}`);
			h.controller.dispose();
		}
	}
	for (const date of ["0000-02-29T00:00:00Z", "0004-02-29T00:00:00Z", "0099-12-31T23:59:59Z",
		"2000-02-29T12:00:00Z", "2028-02-29T12:34:56.123456+05:45", "2028-03-01T00:00:00.5-03:30",
		"2028-03-01T00:00:00+23:59"]) {
		assert.equal(present(parseResetCredits({ credits: [{ expires_at: date }] }, NOW).credits)[0].expiresAt, Date.parse(date), date);
	}
	const h = harness({ resetTransport: async () => {
		const data = resetPayload(); data.credits[0].expires_at = "2028-02-29T12:34:56.123456+05:45"; return Response.json(data);
	} });
	await h.controller.useResetCredit(resetUI());
	assert.equal(h.consumeRequests.length, 1, "valid offset and fractional seconds remain eligible");
	h.controller.dispose();
});

test("low-quota bar threshold includes 20% and zero without rounding", () => {
	for (const remaining of [0, 0.1, 19.9, 20]) assert.equal(isLowQuota(remaining), true);
	for (const remaining of [20.001, 21, 77, 100]) assert.equal(isLowQuota(remaining), false);
});

test("quota-line formatting binds each original window independently and leaves default text unchanged", () => {
	for (const used of [[80, 23], [23, 80], [79.999, 91]]) {
		const data = payload();
		data.rate_limit.primary_window.used_percent = used[0];
		data.rate_limit.secondary_window.used_percent = used[1];
		const state = ready(parseQuota(data, NOW));
		const before = structuredClone(state);
		const seen: { key: QuotaWindow["key"]; remaining: number; low: boolean }[] = [];
		const formatted = detailLines(state, NOW, 12, (line, window) => {
			seen.push({ key: window.key, remaining: window.remainingPercent, low: isLowQuota(window.remainingPercent) });
			assert.match(line, /[█░]/);
			return line;
		});
		assert.deepEqual(formatted, detailLines(state, NOW, 12));
		assert.deepEqual(seen, quotaSnapshot(state).windows.map((window) => ({ key: window.key, remaining: window.remainingPercent, low: isLowQuota(window.remainingPercent) })));
		assert.deepEqual(seen.map((window) => window.low), used[0] === 80 ? [true, false] : used[1] === 80 ? [false, true] : [false, true]);
		if (used[0] === 79.999) {
			assert.match(formatted.join("\n"), /5h .*剩20%/);
			assert.ok(seen[0].remaining > 20, "The rounded 20% text must not drive the threshold");
		}
		assert.deepEqual(state, before);
		assert.ok(!formatted.join("\n").includes("\u001b"));
	}
});

test("progress bars show remaining quota and stay bounded on narrow layouts", () => {
	assert.equal(quotaBar(0, 12), "░".repeat(12));
	assert.equal(quotaBar(100, 12), "█".repeat(12));
	assert.equal(quotaBar(50, 12), "█".repeat(6) + "░".repeat(6));
	assert.equal(quotaBar(100, 100).length, 30, "default callers retain their existing cap");
	assert.equal(quotaBar(100, 100, true).length, 36);
	assert.equal(quotaBar(50, 12, true), "█".repeat(6) + "░".repeat(6));
	assert.match(detailLines(ready(parseQuota(payload(), NOW)), NOW, 12).join("\n"), /[█░]{12}/);
});

test("compact details opt into wider remaining-only bars without changing default output or state", () => {
	const state = ready(parseQuota(payload(), NOW));
	const before = structuredClone(state);
	const defaults = detailLines(state, NOW, 36);
	const compact = detailSections(state, NOW, 36, undefined, { compact: true });
	for (const [index, window] of quotaSnapshot(state).windows.entries()) {
		assert.match(compact.quota[index * 2], /[█░]{36}  剩余 /);
		assert.ok(compact.quota[index * 2].includes(`剩余 ${window.remainingPercent}%`));
		assert.ok(compact.quota[index * 2 + 1].endsWith(localDateTime(present(window.resetAt)).slice(5)));
	}
	assert.doesNotMatch(compact.quota.join("\n"), /已用/);
	assert.deepEqual(detailLines(state, NOW, 36), defaults);
	assert.match(defaults.join("\n"), /[█░]{30}  剩78% · 已用22%/);
	assert.deepEqual(state, before);
});

test("compact dates preserve cross-year, missing and elapsed resets and tiny percentages", () => {
	const state = ready(parseQuota(payload(), NOW));
	const windows = quotaSnapshot(state).windows;
	windows[0].resetAt = new Date(new Date(NOW).getFullYear() + 1, 0, 2, 3, 4).getTime();
	windows[0].remainingPercent = 0.1;
	let compact = detailSections(state, NOW, 36, undefined, { compact: true });
	assert.match(compact.quota[0], /剩余 <1%/);
	assert.ok(compact.quota[1].endsWith(localDateTime(windows[0].resetAt)));
	windows[0].resetAt = null;
	windows[1].resetAt = NOW - 60_000;
	compact = detailSections(state, NOW, 36, undefined, { compact: true });
	assert.equal(compact.quota[1], "  ↻ 未知 · 未知");
	assert.match(compact.quota[3], /^  ↻ 待刷新 · /);
	assert.doesNotMatch(compact.quota[3], /后重置/);
});

test("compact card empty states remain distinct from missing records and retain errors and outcomes", () => {
	const state = { ...ready(parseQuota(payload(), NOW)), resetCredits: {
		snapshot: parseResetCredits({ available_count: 0, credits: [] }, NOW), stale: false,
		error: null as QuotaState["error"], retryAt: null as number | null,
	}, resetUse: undefined as QuotaState["resetUse"] };
	let compact = detailSections(state, NOW, 36, undefined, { compact: true });
	assert.equal(compact.resetSummary, "可用 0 张");
	assert.deepEqual(compact.resets, ["暂无卡片记录"]);
	assert.match(detailLines(state, NOW).join("\n"), /仅显示接口返回记录/);
	state.resetCredits.snapshot = parseResetCredits({ credits: [{ status: "unknown" }] }, NOW);
	compact = detailSections(state, NOW, 36, undefined, { compact: true });
	assert.equal(compact.resetSummary, "可用 未知");
	assert.match(compact.resets.join("\n"), /状态未知[\s\S]*有效期未知[\s\S]*不推断完整历史/);
	state.resetCredits.snapshot = parseResetCredits({ available_count: 0 }, NOW);
	state.resetCredits.stale = true;
	state.resetCredits.error = { kind: "timeout" };
	state.resetCredits.retryAt = NOW + 120_000;
	state.resetUse = { message: "重置结果不确定，请刷新明细", warning: true };
	compact = detailSections(state, NOW, 36, undefined, { compact: true });
	assert.match(compact.resetSummary, /过期缓存/);
	assert.match(compact.resets.join("\n"), /结果不确定[\s\S]*查询超时[\s\S]*未提供使用记录[\s\S]*重置卡重试/);
	assert.doesNotMatch(compact.resets.join("\n"), /暂无卡片记录/);
});

test("card endpoint errors do not hide successfully fetched usage", async () => {
	for (const status of [404, 500]) {
		const h = harness({ resetTransport: async () => new Response("synthetic-card-body-secret", { status }) });
		const state = await h.controller.refresh();
		assert.equal(state.phase, "ready");
		assert.equal(state.stale, false);
		assert.equal(resetCredits(state).snapshot, null);
		assert.equal(present(resetCredits(state).error).httpStatus, status);
		assert.match(detailLines(state, NOW).join("\n"), /可用 未知/);
		assertSanitized(state, "synthetic-card-body-secret");
		h.controller.dispose();
	}
});

test("card failures retain explicitly stale cards and have independent backoff", async () => {
	let fail = false;
	const h = harness({ resetTransport: async () => {
		if (fail) throw new Error("synthetic-reset-secret");
		return Response.json(resetPayload());
	} });
	await h.controller.refresh();
	fail = true;
	h.advance(THROTTLE_MS);
	const state = await h.controller.refresh();
	assert.equal(state.phase, "ready");
	assert.equal(resetCredits(state).stale, true);
	assert.match(detailLines(state, h.now).join("\n"), /可用 2 张 \[过期缓存\]/);
	assert.match(detailLines(state, h.now).join("\n"), /明细为过期缓存/);
	assertSanitized(state, "synthetic-reset-secret");
	h.advance(THROTTLE_MS);
	await h.controller.refresh();
	assert.equal(h.requests.length, 3);
	assert.equal(h.resetRequests.length, 2);
	fail = false;
	await h.controller.refresh(true);
	assert.equal(resetCredits(h.controller.getState()).stale, false);
	h.controller.dispose();
});

test("card 429 cooldown cannot be bypassed by force, while usage stays fresh", async () => {
	const h = harness({ resetTransport: async () => new Response("", { status: 429, headers: { "Retry-After": "120" } }) });
	await h.controller.refresh();
	await h.controller.refresh(true);
	assert.equal(h.requests.length, 2);
	assert.equal(h.resetRequests.length, 1);
	assert.equal(h.controller.getState().phase, "ready");
	h.advance(120_000);
	await h.controller.refresh(true);
	assert.equal(h.resetRequests.length, 2);
	h.controller.dispose();
});

test("card auth failure and account changes clear both usage and card caches", async () => {
	let id = "synthetic-account-A";
	let status = 200;
	const h = harness({ auth: async () => oauth(id), resetTransport: async () => status === 200 ? Response.json(resetPayload()) : new Response("", { status }) });
	await h.controller.refresh();
	id = "synthetic-account-B";
	status = 404;
	let state = await h.controller.refresh(true);
	assert.equal(resetCredits(state).snapshot, null);
	status = 401;
	state = await h.controller.refresh(true);
	assert.equal(state.phase, "auth_error");
	assert.equal(state.snapshot, null);
	assert.equal(resetCredits(state).snapshot, null);
	h.controller.dispose();
});

test("card timeout keeps usage ready and shutdown cancels in-flight card reads", async () => {
	const timeout = new AbortController();
	let timeouts = 0;
	const h = harness({ resetTransport: () => new Promise(() => {}), timeoutSignal: () => ++timeouts === 1 ? new AbortController().signal : timeout.signal });
	const pending = h.controller.refresh();
	await tick();
	assert.equal(h.resetRequests.length, 1);
	timeout.abort(new DOMException("Synthetic card timeout", "TimeoutError"));
	const state = await pending;
	assert.equal(state.phase, "ready");
	assert.equal(present(resetCredits(state).error).kind, "timeout");
	h.controller.dispose();
	const h2 = harness({ resetTransport: () => new Promise(() => {}) });
	const pending2 = h2.controller.refresh();
	await tick();
	h2.controller.dispose();
	await pending2;
	assert.equal(h2.resetRequests[0].init.signal.aborted, true);
	assert.equal(resetCredits(h2.controller.getState()).snapshot, null);
});

test("22% used becomes 78% remaining; reset_at is Unix seconds", () => {
	const snapshot = parseQuota(payload(), NOW);
	assert.deepEqual(snapshot.windows.map((window) => window.remainingPercent), [78, 64]);
	assert.equal(snapshot.windows[0].resetAt, NOW + 7200_000);
	assert.equal(statusLine(ready(snapshot), NOW).text, "🍧 Codex 额度：5h 78% (↻2h) 7d 64% (↻3d)");
	assert.match(detailLines(ready(snapshot), NOW).join("\n"), /7d .*剩64%/);
});

test("HUD shows a reset countdown for each window while preserving percentages and markers", () => {
	const data = payload();
	data.rate_limit.primary_window.used_percent = 24;
	data.rate_limit.primary_window.reset_at = NOW / 1000 + 11 * 60;
	data.rate_limit.secondary_window.used_percent = 4;
	data.rate_limit.secondary_window.reset_at = NOW / 1000 + (6 * 24 + 19) * 3600;
	const state = ready(parseQuota(data, NOW));
	assert.equal(statusLine(state, NOW).text, "🍧 Codex 额度：5h 76% (↻11m) 7d 96% (↻6d19h)");
	assert.match(detailLines(state, NOW).join("\n"), /↻ 11m 后重置/);
	assert.match(detailLines(state, NOW).join("\n"), /↻ 6d19h 后重置/);
	assert.match(statusLine({ ...state, phase: "loading" }, NOW).text, /^🍧 Codex\[更新中\] 额度：/);
	assert.match(statusLine({ ...state, snapshot: { ...state.snapshot, allowed: false } }, NOW).text, / \| 受限$/);
});

test("HUD omits the plan and outer parentheses; details retain the live plan", () => {
	const data = payload();
	data.rate_limit.primary_window.used_percent = 4;
	data.rate_limit.primary_window.reset_at = NOW / 1000 + (4 * 60 + 56) * 60;
	data.rate_limit.secondary_window.used_percent = 13;
	data.rate_limit.secondary_window.reset_at = NOW / 1000 + (6 * 24 + 12) * 3600;
	data.rate_limit_reset_credits = { available_count: 2 };
	const expected = "🍧 Codex 额度：5h 96% (↻4h56m) 7d 87% (↻6d12h)";
	for (const plan of ["plus", "pro", undefined]) {
		if (plan === undefined) delete data.plan_type;
		else data.plan_type = plan;
		const state = ready(parseQuota(data, NOW));
		assert.equal(statusLine(state, NOW).text, expected);
		assert.match(detailLines(state, NOW)[0], plan === undefined ? /^未知套餐/ : new RegExp(`^${plan.toUpperCase()}`));
	}
});

test("HUD still omits reset cards and subscription expiry", () => {
	const state = { ...ready(parseQuota(payload(), NOW)), resetCredits: { snapshot: parseResetCredits(resetPayload(), NOW), stale: false, error: null, retryAt: null } };
	assert.doesNotMatch(statusLine(state, NOW).text, /重置卡|订阅到期|->/);
	assert.match(statusLine(state, NOW).text, /\(↻2h\) .*\(↻3d\)/);
	assert.match(detailLines(state, NOW).join("\n"), /可用 2 张/);
});

test("HUD countdown advances with the supplied clock without changing cached percentages", () => {
	const state = ready(parseQuota(payload(), NOW));
	const original = structuredClone(state);
	assert.equal(statusLine(state, NOW + 60_000).text, "🍧 Codex 额度：5h 78% (↻1h59m) 7d 64% (↻2d23h)");
	assert.equal(statusLine(state, NOW + 7200_000).text, "🍧 Codex 额度：5h 78% (↻待刷新) 7d 64% (↻2d22h)");
	assert.equal(statusLine(state, NOW + 7200_000).color, "warning");
	assert.deepEqual(state, original, "Rendering must not restore quotas or mutate snapshots");
	assert.match(statusLine({ ...state, stale: true }, NOW).text, /^🍧 Codex\[过期\].*↻2h/);
	assert.equal(statusLine({ ...state, stale: true }, NOW).color, "warning");
});

test("HUD shows unknown or awaiting refresh for missing, due and past reset timestamps", () => {
	const data = payload();
	delete data.rate_limit.primary_window.reset_at;
	delete data.rate_limit.primary_window.reset_after_seconds;
	data.rate_limit.secondary_window.reset_at = NOW / 1000;
	const state = ready(parseQuota(data, NOW));
	assert.equal(statusLine(state, NOW).text, "🍧 Codex 额度：5h 78% (↻未知) 7d 64% (↻待刷新)");
	assert.equal(statusLine(state, NOW + 60_000).text, statusLine(state, NOW).text);
	assert.equal(statusLine(state, NOW).color, "warning");
});

test("a lone primary weekly window is not mislabeled 5h; extra quotas are not mixed in", () => {
	const data = payload();
	const weekly = {
		...data,
		rate_limit: { ...data.rate_limit, primary_window: data.rate_limit.secondary_window, secondary_window: null },
		additional_rate_limits: [{ rate_limit: { primary_window: { used_percent: 99 } } }],
	};
	const snapshot = parseQuota(weekly, NOW);
	assert.equal(snapshot.windows.length, 1);
	assert.equal(windowLabel(snapshot.windows[0]), "7d");
	assert.equal(statusLine(ready(snapshot), NOW).text, "🍧 Codex 额度：7d 64% (↻3d)");
	assert.doesNotMatch(statusLine(ready(snapshot), NOW).text, /5h|1%/);
});

test("other window lengths are displayed honestly instead of hardcoded as weekly", () => {
	const data = payload();
	data.rate_limit.primary_window.limit_window_seconds = 2628000;
	assert.equal(windowLabel(parseQuota(data, NOW).windows[0]), "30d10h");
	delete data.rate_limit.primary_window.limit_window_seconds;
	assert.equal(windowLabel(parseQuota(data, NOW).windows[0]), "主窗口");
});

test("valid null/absent/empty windows mean no data, not zero or unlimited", () => {
	for (const data of [
		{ plan_type: "enterprise", rate_limit: null }, { plan_type: "enterprise" },
		{ rate_limit: {} }, { rate_limit: { primary_window: null, secondary_window: null } },
	]) {
		const state = ready(parseQuota(data, NOW));
		assert.equal(quotaSnapshot(state).windows.length, 0);
		assert.match(statusLine(state, NOW).text, /暂无主额度数据/);
		assert.doesNotMatch(statusLine(state, NOW).text, /0%|100%|无限/);
	}
});

test("malformed responses and missing/non-numeric percentages are rejected", () => {
	const bad: unknown[] = [null, [], {}, { error: "synthetic-secret" }, { rate_limit: "bad" }];
	for (const percent of [undefined, null, "22", NaN, Infinity, -1]) {
		bad.push({ rate_limit: { primary_window: { used_percent: percent } } });
	}
	bad.push({ rate_limit: { allowed: "true" } });
	for (const data of bad) assert.throws(() => parseQuota(data, NOW));
	const over = { rate_limit: { primary_window: { used_percent: 110 } } };
	assert.equal(parseQuota(over, NOW).windows[0].remainingPercent, 0);
});

test("relative reset fallback is anchored to receipt time, only when reset_at is absent", () => {
	const data: { rate_limit: { primary_window: WindowFixture } } = { rate_limit: { primary_window: { used_percent: 22, reset_after_seconds: 120 } } };
	let snapshot = parseQuota(data, NOW);
	assert.equal(snapshot.windows[0].resetAt, NOW + 120_000);
	assert.equal(resetRemaining(snapshot.windows[0].resetAt, NOW + 60_000), "1m");
	data.rate_limit.primary_window.reset_at = "invalid";
	snapshot = parseQuota(data, NOW);
	assert.equal(snapshot.windows[0].resetAt, null);
	assert.equal(resetRemaining(null, NOW), "未知");
	data.rate_limit.primary_window.reset_at = NOW / 1000 - 1;
	snapshot = parseQuota(data, NOW);
	assert.equal(snapshot.windows[0].remainingPercent, 78);
	assert.match(detailLines(ready(snapshot), NOW).join("\n"), /待刷新/);
	assert.equal(statusLine(ready(snapshot), NOW).color, "warning");
});

test("display labels cannot inject terminal control characters", () => {
	const data = payload();
	data.plan_type = "pro\u001b[31m";
	const state = ready(parseQuota(data, NOW));
	assert.equal(state.snapshot.plan, null);
	assert.ok(!detailLines(state, NOW).join("\n").includes("\u001b"));
});

test("JWT base64url account routing accepts synthetic claims but rejects malformed/header-injection data", () => {
	assert.equal(extractAccountId(token()), "synthetic-account-A");
	for (const bad of ["sk-synthetic", "a.!.b", "a.e30.b", token("bad\r\nheader"), token(""), `${token()}.extra`]) {
		assert.equal(extractAccountId(bad), undefined);
	}
});

test("only the two fixed read-only endpoints receive OAuth headers, with redirects disabled", async () => {
	const h = harness();
	const state = await h.controller.refresh();
	assert.equal(state.phase, "ready");
	assert.equal(h.authCalls, 1);
	assert.equal(h.requests.length, 1);
	const { url, init } = h.requests[0];
	assert.equal(url, API_URL);
	assert.equal(init.method, "GET");
	assert.equal(init.redirect, "error");
	assert.equal(init.headers.Authorization, `Bearer ${token()}`);
	assert.equal(init.headers["ChatGPT-Account-Id"], "synthetic-account-A");
	assert.equal(init.headers.Accept, "application/json");
	assert.equal(h.resetRequests.length, 1);
	assert.equal(h.resetRequests[0].url, RESET_CREDITS_URL);
	assert.equal(h.resetRequests[0].init.method, "GET");
	assert.equal(h.resetRequests[0].init.redirect, "error");
	assert.deepEqual(h.resetRequests[0].init.headers, init.headers);
	assertSanitized(state, token(), "synthetic-account-A", "synthetic-credit-secret");
	h.controller.dispose();
});

test("offline flags prevent even credential resolution, including forced refresh", async () => {
	for (const value of ["1", "true", "yes", " YES "]) assert.equal(isOffline(value), true);
	for (const value of [undefined, "0", "false", "no"]) assert.equal(isOffline(value), false);
	const h = harness({ offline: true, auth: async () => { throw new Error("Must not resolve auth"); } });
	assert.equal((await h.controller.refresh(true)).phase, "offline");
	assert.equal(h.authCalls, 0);
	assert.equal(h.requests.length, 0);
});

test("logout clears cached account data without making another HTTP request", async () => {
	let loggedIn = true;
	const h = harness({ auth: async () => loggedIn ? oauth() : undefined });
	await h.controller.refresh();
	loggedIn = false;
	const state = await h.controller.refresh(true);
	assert.equal(state.phase, "not_logged_in");
	assert.equal(state.snapshot, null);
	assert.equal(state.lastSuccessAt, null);
	assert.equal(h.requests.length, 1);
	h.controller.dispose();
});

test("API keys and invalid OAuth claims never reach the usage endpoint", async () => {
	for (const auth of [{ source: "API key", auth: { apiKey: "synthetic-api-key" } }, { source: "OAuth", auth: { apiKey: "invalid-token" } }]) {
		const h = harness({ auth: async () => auth });
		const state = await h.controller.refresh();
		assert.equal(state.phase, "auth_error");
		assert.equal(h.requests.length, 0);
		assertSanitized(state, auth.auth.apiKey);
		h.controller.dispose();
	}
});

test("host OAuth errors are distinguished from missing login and fully sanitized", async () => {
	const secret = "synthetic-refresh-secret";
	const h = harness({ auth: async () => { throw new Error(`OAuth response: {refresh_token:${secret}}`); } });
	const state = await h.controller.refresh();
	assert.equal(state.phase, "auth_error");
	assert.equal(present(state.error).kind, "auth");
	assert.equal(h.requests.length, 0);
	assert.match(detailLines(state, NOW).join("\n"), /续期失败/);
	assertSanitized(state, secret, "OAuth response");
});

test("concurrent automatic/manual refreshes share one auth resolution and one request", async () => {
	const auth = deferred<ProviderAuth>();
	const h = harness({ auth: () => auth.promise });
	const first = h.controller.refresh();
	const second = h.controller.refresh(true);
	assert.equal(first, second);
	await tick();
	assert.equal(h.authCalls, 1);
	assert.equal(h.requests.length, 0);
	auth.resolve(oauth());
	await Promise.all([first, second]);
	assert.equal(h.requests.length, 1);
	h.controller.dispose();
});

test("automatic refresh is throttled from attempt time, while manual refresh bypasses normal TTL", async () => {
	const h = harness();
	await h.controller.refresh();
	h.advance(THROTTLE_MS - 1);
	await h.controller.refresh();
	assert.equal(h.requests.length, 1);
	await h.controller.refresh(true);
	assert.equal(h.requests.length, 2);
	h.advance(THROTTLE_MS);
	await h.controller.refresh();
	assert.equal(h.requests.length, 3);
	h.controller.dispose();
});

test("network failure preserves a visibly stale cache and backs off failed attempts", async () => {
	let fail = false;
	const h = harness({ transport: async () => {
		if (fail) throw new Error("synthetic-network-secret");
		return Response.json(payload());
	} });
	await h.controller.refresh();
	fail = true;
	h.advance(THROTTLE_MS);
	const state = await h.controller.refresh();
	assert.equal(state.phase, "network_error");
	assert.equal(quotaSnapshot(state).windows[0].remainingPercent, 78);
	assert.equal(state.stale, true);
	assert.equal(state.lastSuccessAt, NOW);
	assert.match(statusLine(state, h.now).text, /^🍧 Codex\[过期\] 额度：/);
	assertSanitized(state, "synthetic-network-secret");
	h.advance(59_999);
	await h.controller.refresh();
	assert.equal(h.requests.length, 2);
	fail = false;
	h.advance(1);
	assert.equal((await h.controller.refresh()).phase, "ready");
	assert.equal(h.requests.length, 3);
	h.controller.dispose();
});

test("automatic error backoff is capped at five minutes", async () => {
	const h = harness({ transport: async () => { throw new Error("offline"); } });
	for (const delay of [60_000, 120_000, 240_000, 300_000, 300_000]) {
		const state = await h.controller.refresh();
		assert.equal(present(state.retryAt) - h.now, delay);
		h.advance(delay);
	}
	h.controller.dispose();
});

test("Retry-After supports seconds and HTTP dates and rejects invalid values", () => {
	assert.equal(parseRetryAfter("120", NOW), NOW + 120_000);
	assert.equal(parseRetryAfter(new Date(NOW + 120_000).toUTCString(), NOW), NOW + 120_000);
	for (const value of [null, "", "garbage", "-1", "Infinity"]) assert.equal(parseRetryAfter(value, NOW), undefined);
});

test("429 cooldown blocks manual refresh too, then permits recovery", async () => {
	let limited = false;
	const h = harness({ transport: async () => limited
		? new Response("synthetic-provider-secret", { status: 429, headers: { "Retry-After": "120" } })
		: Response.json(payload()) });
	await h.controller.refresh();
	limited = true;
	const state = await h.controller.refresh(true);
	assert.equal(state.phase, "rate_limited");
	assert.equal(state.stale, true);
	assert.equal(state.retryAt, NOW + 120_000);
	assertSanitized(state, "synthetic-provider-secret");
	h.advance(119_999);
	await h.controller.refresh(true);
	assert.equal(h.requests.length, 2);
	limited = false;
	h.advance(1);
	assert.equal((await h.controller.refresh(true)).phase, "ready");
	assert.equal(h.requests.length, 3);
	h.controller.dispose();
});

test("429 auth-only refresh detects account/logout without HTTP or changing attempt/cooldown", async () => {
	for (const force of [false, true]) {
		for (const change of ["account", "logout"]) {
			let auth: ProviderAuth | undefined = oauth();
			let limited = false;
			const h = harness({ auth: async () => auth, transport: async () => limited
				? new Response("", { status: 429, headers: { "Retry-After": "120" } }) : Response.json(payload()) });
			await h.controller.refresh(); limited = true;
			const before = await h.controller.refresh(true);
			h.advance(10_000);
			const changes = h.changes.length;
			assert.deepEqual(await h.controller.refresh(force), before, "same-account check must not extend cooldown or flash loading");
			assert.equal(h.changes.length, changes);
			auth = change === "account" ? oauth("synthetic-account-B") : undefined;
			const after = await h.controller.refresh(force);
			assert.equal(after.phase, change === "account" ? "rate_limited" : "not_logged_in");
			assert.equal(after.snapshot, null);
			assert.equal(after.resetCredits?.snapshot, null);
			assert.equal(after.lastSuccessAt, null);
			assert.equal(after.lastAttemptAt, before.lastAttemptAt);
			assert.equal(h.requests.length, 2);
			assert.equal(h.resetRequests.length, 1);
			if (change === "account") assert.equal(after.retryAt, before.retryAt);
			auth = oauth("synthetic-account-B");
			await h.controller.refresh(true);
			assert.equal(h.requests.length, 2, "login must not bypass 429");
			h.advance(110_000); limited = false;
			assert.equal((await h.controller.refresh()).phase, "ready");
			assert.equal(h.requests.length, 3);
			h.controller.dispose();
		}
	}
});

test("auth-only throttled checks stay single-flight and clear identities without loading", async () => {
	let auth: ProviderAuth | undefined = oauth();
	let waiting: ReturnType<typeof deferred<ProviderAuth | undefined>> | undefined;
	const h = harness({ auth: () => waiting ? waiting.promise : Promise.resolve(auth) });
	const initial = await h.controller.refresh();
	h.advance(1_000);
	waiting = deferred<ProviderAuth | undefined>();
	const changes = h.changes.length;
	const first = h.controller.refresh();
	assert.equal(first, h.controller.refresh(true));
	await tick();
	assert.equal(h.changes.length, changes);
	waiting.resolve(oauth()); await first; waiting = undefined;
	assert.deepEqual(h.controller.getState(), initial);
	auth = undefined; assert.equal((await h.controller.refresh()).phase, "not_logged_in");
	auth = oauth("synthetic-account-B");
	const switched = await h.controller.refresh();
	assert.equal(switched.phase, "idle");
	assert.equal(switched.snapshot, null);
	assert.equal(switched.lastAttemptAt, initial.lastAttemptAt);
	assert.equal(h.requests.length, 1);
	h.advance(THROTTLE_MS - 1_000);
	assert.equal((await h.controller.refresh()).phase, "ready");
	h.controller.dispose();
});

test("identity changes during ordinary failure backoff clear cache without extending HTTP retry", async () => {
	let auth: ProviderAuth | undefined = oauth();
	let fail = false;
	const h = harness({ auth: async () => auth, transport: async () => {
		if (fail) throw new Error("synthetic-offline");
		return Response.json(payload());
	} });
	await h.controller.refresh(); fail = true;
	const failed = await h.controller.refresh(true);
	h.advance(10_000);
	auth = oauth("synthetic-account-B");
	const switched = await h.controller.refresh();
	assert.equal(switched.phase, "idle");
	assert.equal(switched.snapshot, null);
	assert.equal(switched.resetCredits?.snapshot, null);
	assert.equal(switched.lastAttemptAt, failed.lastAttemptAt);
	assert.equal(switched.retryAt, failed.retryAt);
	auth = undefined;
	assert.equal((await h.controller.refresh()).phase, "not_logged_in");
	assert.equal(h.requests.length, 2);
	auth = oauth("synthetic-account-B"); fail = false;
	assert.equal((await h.controller.refresh(true)).phase, "ready", "force bypasses normal backoff");
	assert.equal(h.requests.length, 3);
	h.controller.dispose();
});

test("401/403 clear old quotas and ask for pi login without echoing response bodies", async () => {
	for (const status of [401, 403]) {
		let fail = false;
		const h = harness({ transport: async () => fail ? new Response("synthetic-auth-body", { status }) : Response.json(payload()) });
		await h.controller.refresh();
		fail = true;
		const state = await h.controller.refresh(true);
		assert.equal(state.phase, "auth_error");
		assert.equal(state.snapshot, null);
		assert.equal(state.lastSuccessAt, null);
		assert.match(detailLines(state, NOW).join("\n"), /\/login openai-codex/);
		assertSanitized(state, "synthetic-auth-body");
		h.controller.dispose();
	}
});

test("account changes discard the previous account cache even if the new fetch fails", async () => {
	let id = "synthetic-account-A";
	const h = harness({ auth: async () => oauth(id), transport: async () => {
		if (id === "synthetic-account-B") throw new Error("offline");
		return Response.json(payload());
	} });
	await h.controller.refresh();
	id = "synthetic-account-B";
	const state = await h.controller.refresh(true);
	assert.equal(state.phase, "network_error");
	assert.equal(state.snapshot, null);
	assert.equal(state.lastSuccessAt, null);
	assert.equal(h.requests[1].init.headers["ChatGPT-Account-Id"], id);
	h.controller.dispose();
});

test("malformed JSON/data produce sanitized data errors without inventing a quota", async () => {
	for (const transport of [
		async () => new Response("synthetic-invalid-json-secret"),
		async () => Response.json({ rate_limit: { primary_window: { used_percent: "synthetic-data-secret" } } }),
	]) {
		const h = harness({ transport });
		const state = await h.controller.refresh();
		assert.equal(state.phase, "data_error");
		assert.equal(state.snapshot, null);
		assertSanitized(state, "synthetic-invalid-json-secret", "synthetic-data-secret");
		h.controller.dispose();
	}
});

test("the 10-second quota timeout also settles transports that ignore AbortSignal", async () => {
	const timeout = new AbortController();
	let requestedTimeout;
	const response = deferred<Response>();
	const h = harness({ transport: () => response.promise, timeoutSignal: (milliseconds) => {
		requestedTimeout = milliseconds;
		return timeout.signal;
	} });
	const pending = h.controller.refresh();
	await tick();
	assert.equal(requestedTimeout, TIMEOUT_MS);
	timeout.abort(new DOMException("Synthetic timeout", "TimeoutError"));
	const state = await pending;
	assert.equal(state.phase, "timeout");
	assert.equal(h.requests[0].init.signal.aborted, true);
	response.resolve(Response.json(payload()));
	await tick();
	assert.equal(h.controller.getState().phase, "timeout");
	h.controller.dispose();
});

test("shutdown settles the wait and ignores late host authentication without fetching", async () => {
	const auth = deferred<ProviderAuth>();
	const h = harness({ auth: () => auth.promise });
	const pending = h.controller.refresh();
	await tick();
	const notifications = h.changes.length;
	h.controller.dispose();
	h.controller.dispose();
	await pending;
	auth.resolve(oauth());
	await tick();
	assert.equal(h.requests.length, 0);
	assert.equal(h.changes.length, notifications);
	assert.equal(h.controller.getState().snapshot, null);
	await h.controller.refresh(true);
	assert.equal(h.authCalls, 1);
});

test("shutdown aborts HTTP requests and prevents a late response from updating UI", async () => {
	const response = deferred<Response>();
	const h = harness({ transport: () => response.promise });
	const pending = h.controller.refresh();
	await tick();
	assert.equal(h.requests.length, 1);
	const notifications = h.changes.length;
	h.controller.dispose();
	assert.equal(h.requests[0].init.signal.aborted, true);
	await pending;
	response.resolve(Response.json(payload()));
	await tick();
	assert.equal(h.changes.length, notifications);
	assert.equal(h.controller.getState().snapshot, null);
});

test("restricted and nearly exhausted quotas are not colored as healthy", () => {
	const data = payload();
	data.rate_limit.allowed = false;
	assert.equal(statusLine(ready(parseQuota(data, NOW)), NOW).color, "error");
	data.rate_limit.allowed = true;
	data.rate_limit.primary_window.used_percent = 95;
	assert.equal(statusLine(ready(parseQuota(data, NOW)), NOW).color, "warning");
	data.rate_limit.primary_window.used_percent = 100;
	assert.equal(statusLine(ready(parseQuota(data, NOW)), NOW).color, "error");
});

test("public state snapshots cannot mutate the controller's cached values", async () => {
	const h = harness();
	const state = await h.controller.refresh();
	quotaSnapshot(state).windows[0].remainingPercent = 1;
	resetCards(state)[0].status = "used";
	assert.equal(quotaSnapshot(h.controller.getState()).windows[0].remainingPercent, 78);
	assert.equal(resetCards(h.controller.getState())[0].status, "available");
	h.controller.dispose();
});

test("reset button reflects usable cards, errors, expiry, cooldown and offline without requesting data", async () => {
	const h = harness();
	assert.equal(h.controller.getResetButton().phase, "disabled");
	assert.equal(h.authCalls, 0);
	await h.controller.refresh();
	assert.deepEqual(h.controller.getResetButton(), { phase: "ready", enabled: true, hint: "可选 1 张 · 选卡后确认，不会自动消费" });
	const requests = h.allRequests.length;
	for (let i = 0; i < 3; i++) h.controller.getResetButton();
	assert.equal(h.allRequests.length, requests);
	h.advance(30 * 86400_000);
	assert.equal(h.controller.getResetButton().enabled, false);
	assert.equal(h.controller.getResetButton().reason, "no_usable_cards");
	assert.match(h.controller.getResetButton().hint, /已到期/);
	h.controller.dispose();
	assert.equal(h.controller.getResetButton().enabled, false);
	for (const options of [
		{ offline: true },
		{ auth: async () => undefined },
		{ transport: async () => new Response("", { status: 429 }) },
		{ resetTransport: async () => new Response("", { status: 500 }) },
	]) {
		const h = harness(options);
		await h.controller.refresh();
		assert.equal(h.controller.getResetButton().phase, "disabled");
		assert.equal(h.controller.getResetButton().enabled, false);
		if (options.offline) { assert.match(h.controller.getResetButton().hint, /离线/); assert.equal(h.authCalls, 0); }
		h.controller.dispose();
	}
});

test("reset button is busy through dialogs and disabled when the card outcome is unresolved", async () => {
	const waiting = deferred();
	const h = harness({ consumeTransport: async () => new Response("", { status: 502 }) });
	const ui = resetUI({ onSelect: async (count) => { if (count === 1) await waiting.promise; } });
	const use = h.controller.useResetCredit(ui);
	await tick();
	assert.deepEqual(h.controller.getResetButton(), { phase: "busy", enabled: false, hint: "正在处理，请勿重复操作" });
	waiting.resolve();
	await use;
	assert.equal(h.controller.getResetButton().enabled, false);
	assert.match(h.controller.getResetButton().hint, /结果未决/);
	assert.equal(h.consumeRequests.length, 1);
	h.controller.dispose();
});

test("confirmed selected card posts once with UUID and synchronizes actual server values", async () => {
	let consumed = false;
	const h = harness({
		consumeTransport: async () => { consumed = true; return Response.json({ code: "reset", windows_reset: 2 }); },
		transport: async () => { const data = payload(); if (consumed) data.rate_limit.primary_window.used_percent = 7; return Response.json(data); },
		resetTransport: async () => { const data = resetPayload(); if (consumed) { data.available_count = 1; data.credits[0].status = "redeemed"; } return Response.json(data); },
	});
	const ui = resetUI();
	await h.controller.useResetCredit(ui);
	assert.equal(h.consumeRequests.length, 1);
	const { url, init } = h.consumeRequests[0];
	assert.equal(url, CONSUME_RESET_URL);
	assert.equal(init.method, "POST");
	assert.equal(init.redirect, "error");
	assert.equal(init.headers.Authorization, `Bearer ${token()}`);
	assert.equal(init.headers["ChatGPT-Account-Id"], "synthetic-account-A");
	assert.equal(init.headers["Content-Type"], "application/json");
	const body = consumeBody(h.consumeRequests[0]);
	assert.equal(body.credit_id, "synthetic-credit-secret");
	assert.match(body.redeem_request_id, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
	assert.deepEqual(h.allRequests.map((req) => req.url), [API_URL, RESET_CREDITS_URL, API_URL, RESET_CREDITS_URL, CONSUME_RESET_URL, API_URL, RESET_CREDITS_URL]);
	assert.equal(quotaSnapshot(h.controller.getState()).windows[0].remainingPercent, 93);
	assert.equal(resetSnapshot(h.controller.getState()).availableCount, 1);
	assert.match(present(ui.notices.at(-1)).message, /确认重置成功.*已重新查询/);
	assert.deepEqual(ui.dialogs[1].options, ["取消", "确认使用这张卡"]);
	assertResetSanitized(h, ui);
	h.controller.dispose();
});

test("selection remains bound to its card ID even when revalidation reorders rows", async () => {
	let reordered = false;
	const h = harness({ resetTransport: async () => {
		const data = resetPayload();
		data.credits[1].id = "synthetic-second-credit";
		if (reordered) data.credits.reverse();
		return Response.json(data);
	} });
	const ui = resetUI({ choice: 1, onSelect: async (count) => { if (count === 2) reordered = true; } });
	await h.controller.useResetCredit(ui);
	assert.equal(h.consumeRequests.length, 1);
	assert.equal(consumeBody(h.consumeRequests[0]).credit_id, "synthetic-second-credit");
	assert.match(ui.dialogs[1].title, /#2/);
	assert.ok(!JSON.stringify(ui.dialogs).includes("synthetic-second-credit"));
	h.controller.dispose();
});

test("cancel selection, default cancellation, absent UI and offline never consume", async () => {
	for (const options of [{ pick: false }, { confirm: false }]) {
		const h = harness();
		await h.controller.useResetCredit(resetUI(options));
		assert.equal(h.consumeRequests.length, 0);
		h.controller.dispose();
	}
	for (const options of [{ offline: true }, {}]) {
		const h = harness(options);
		await h.controller.useResetCredit(options.offline ? resetUI() : undefined);
		assert.equal(h.authCalls, 0);
		assert.equal(h.allRequests.length, 0);
		h.controller.dispose();
	}
});

test("only unique valid known available unexpired card IDs can be selected", async () => {
	for (const rows of [
		[{ id: "valid", status: "redeemed", reset_type: "codex_rate_limits" }],
		[{ id: "valid", status: "available", reset_type: "unknown" }],
		[{ id: "valid", status: "pending", reset_type: "codex_rate_limits" }],
		[{ id: "valid", status: "available", reset_type: "codex_rate_limits", expires_at: "2026-10-01T00:00:00Z" }],
		[{ id: "valid", status: "available", reset_type: "codex_rate_limits", expires_at: "not-a-date" }],
		[{ id: "bad\r\nsecret", status: "available", reset_type: "codex_rate_limits" }],
		[{ status: "available", reset_type: "codex_rate_limits" }],
		[1, 2].map(() => ({ id: "duplicate", status: "available", reset_type: "codex_rate_limits" })),
		[],
	]) {
		const h = harness({ resetTransport: async () => Response.json({ available_count: 2, credits: rows }) });
		const ui = resetUI();
		await h.controller.useResetCredit(ui);
		assert.equal(ui.dialogs.length, 0);
		assert.equal(h.consumeRequests.length, 0);
		h.controller.dispose();
	}
	const h = harness({ resetTransport: async () => Response.json({ credits: [{ id: "valid", status: "available", reset_type: "codex_rate_limits", expires_at: null }] }) });
	const ui = resetUI();
	await h.controller.useResetCredit(ui);
	assert.match(ui.dialogs[0].options[0], /到期：未知/);
	assert.equal(h.consumeRequests.length, 1);
	h.controller.dispose();
});

test("query failure, missing details, no OAuth and query cooldown cannot use cached cards", async () => {
	for (const options of [
		{ auth: async () => undefined },
		{ auth: async () => ({ source: "API key", auth: { apiKey: "synthetic-body-secret" } }) },
		{ auth: async () => oauth("bad\r\naccount") },
		{ auth: async () => { throw new Error("synthetic-body-secret"); } },
		{ transport: async () => new Response("", { status: 429 }) },
		{ resetTransport: async () => new Response("", { status: 429 }) },
		{ resetTransport: async () => Response.json({ available_count: 2 }) },
	]) {
		const h = harness(options);
		await h.controller.useResetCredit(resetUI());
		await h.controller.useResetCredit(resetUI());
		assert.equal(h.consumeRequests.length, 0);
		h.controller.dispose();
	}
	let fail = false;
	const h = harness({ resetTransport: async () => fail ? new Response("", { status: 500 }) : Response.json(resetPayload()) });
	await h.controller.refresh();
	fail = true;
	await h.controller.useResetCredit(resetUI());
	assert.equal(h.consumeRequests.length, 0);
	assert.equal(resetCredits(h.controller.getState()).stale, true);
	h.controller.dispose();
});

test("consume result parser recognizes only official codes and valid windows_reset", () => {
	for (const code of ["reset", "nothing_to_reset", "no_credit", "already_redeemed"]) {
		assert.deepEqual(parseConsumeResult({ code }), { code, windowsReset: null });
	}
	for (const data of [{}, null, { code: "synthetic-body-secret" }, { code: "reset", windows_reset: -1 }, { code: "reset", windows_reset: "2" }]) assert.throws(() => parseConsumeResult(data));
});

test("all official outcomes are distinguished and never fabricate quotas/card counts", async () => {
	const expected = { reset: /确认重置成功/, nothing_to_reset: /无需重置/, no_credit: /无可用重置卡/, already_redeemed: /不代表此次又成功重置/ };
	for (const [code, message] of Object.entries(expected)) {
		const h = harness({ consumeTransport: async () => Response.json({ code }) });
		const ui = resetUI();
		await h.controller.useResetCredit(ui);
		assert.match(present(ui.notices.at(-1)).message, message);
		assert.equal(h.consumeRequests.length, 1);
		assert.equal(quotaSnapshot(h.controller.getState()).windows[0].remainingPercent, 78);
		assert.equal(resetSnapshot(h.controller.getState()).availableCount, 2);
		if (code === "reset" || code === "already_redeemed") {
			await h.controller.useResetCredit(resetUI());
			assert.equal(h.consumeRequests.length, 1, "stale available record must not allow a second POST");
		}
		assertResetSanitized(h, ui);
		h.controller.dispose();
	}
});

test("HTTP auth rejection clears caches, while 429 honors consumption cooldown", async () => {
	for (const status of [401, 403, 429]) {
		const h = harness({ consumeTransport: async () => new Response("synthetic-body-secret", { status, headers: { "Retry-After": "120" } }) });
		const ui = resetUI();
		await h.controller.useResetCredit(ui);
		assert.equal(h.consumeRequests.length, 1);
		assert.match(present(ui.notices.at(-1)).message, new RegExp(`HTTP ${status}`));
		if (status === 429) {
			assert.equal(h.requests.length, 3, "429 still permits read-only reconciliation");
			await h.controller.useResetCredit(resetUI());
			await h.controller.refresh(true);
			await h.controller.useResetCredit(resetUI());
			assert.equal(h.consumeRequests.length, 1);
			h.advance(120_000);
			await h.controller.useResetCredit(resetUI());
			assert.equal(h.consumeRequests.length, 2, "a new explicit confirmation may consume after cooldown");
		} else {
			assert.equal(h.controller.getState().phase, "auth_error");
			assert.equal(h.controller.getState().snapshot, null);
			assert.equal(resetCredits(h.controller.getState()).snapshot, null);
		}
		assertResetSanitized(h, ui);
		h.controller.dispose();
	}
});

test("ambiguous 5xx, network and malformed 2xx stay locked, with no automatic POST retry", async () => {
	for (const consumeTransport of [
		async () => new Response("synthetic-body-secret", { status: 500 }),
		async () => { throw new Error("synthetic-body-secret"); },
		async () => Response.json({ code: "synthetic-body-secret" }),
		async () => new Response("synthetic-body-secret", { status: 200 }),
	]) {
		const h = harness({ consumeTransport });
		const ui = resetUI();
		await h.controller.useResetCredit(ui);
		assert.match(present(ui.notices.at(-1)).message, /结果不确定/);
		await h.controller.refresh(true);
		h.advance(60_000);
		await h.controller.refresh();
		await h.controller.useResetCredit(resetUI());
		assert.equal(h.consumeRequests.length, 1);
		assertResetSanitized(h, ui);
		h.controller.dispose();
	}
});

test("unknown outcome remains locked across pending records and account switching", async () => {
	let id = "synthetic-account-A";
	let status = "available";
	const h = harness({ auth: async () => oauth(id), consumeTransport: async () => new Response("", { status: 502 }), resetTransport: async () => { const data = resetPayload(); data.credits[0].status = status; return Response.json(data); } });
	await h.controller.useResetCredit(resetUI());
	status = "pending";
	await h.controller.refresh(true);
	status = "available";
	id = "synthetic-account-B";
	await h.controller.refresh(true);
	id = "synthetic-account-A";
	await h.controller.refresh(true);
	await h.controller.useResetCredit(resetUI());
	assert.equal(h.consumeRequests.length, 1);
	status = "redeemed";
	await h.controller.refresh(true);
	assert.equal(resetCards(h.controller.getState())[0].status, "used");
	h.controller.dispose();
});

test("successful/uncertain POST locks survive terminal records, old available and account round trips", async () => {
	for (const result of ["reset", "uncertain"]) {
		for (const terminal of ["used", "expired"]) {
			let status = "available";
			let id = "synthetic-account-A";
			const h = harness({ auth: async () => oauth(id),
				consumeTransport: async () => result === "reset" ? Response.json({ code: "reset" }) : new Response("", { status: 502 }),
				resetTransport: async () => { const data = resetPayload(); data.credits[0].status = status; return Response.json(data); } });
			await h.controller.useResetCredit(resetUI());
			assert.equal(h.consumeRequests.length, 1);
			status = terminal; await h.controller.refresh(true);
			assert.equal(resetCards(h.controller.getState())[0].status, terminal);
			status = "available"; await h.controller.refresh(true);
			await h.controller.useResetCredit(resetUI());
			assert.equal(h.consumeRequests.length, 1);
			id = "synthetic-account-B"; await h.controller.refresh(true);
			id = "synthetic-account-A"; await h.controller.refresh(true);
			await h.controller.useResetCredit(resetUI());
			assert.equal(h.consumeRequests.length, 1);
			h.controller.suspend();
			await h.controller.refresh(true);
			await h.controller.useResetCredit(resetUI());
			assert.equal(h.consumeRequests.length, 1, "suspend must also retain locks");
			h.controller.dispose();
		}
	}
});

test("explicit non-consuming rejections still allow a new confirmed POST", async () => {
	for (const response of [() => Response.json({ code: "nothing_to_reset" }), () => Response.json({ code: "no_credit" }), () => new Response("", { status: 400 })]) {
		const h = harness({ consumeTransport: async () => response() });
		await h.controller.useResetCredit(resetUI());
		await h.controller.useResetCredit(resetUI());
		assert.equal(h.consumeRequests.length, 2);
		h.controller.dispose();
	}
});

test("success and uncertain results keep old data stale when reconciliation fails", async () => {
	for (const code of ["reset", "unknown"]) {
		let sent = false;
		const h = harness({
			consumeTransport: async () => { sent = true; return Response.json({ code }); },
			transport: async () => sent ? new Response("", { status: 500 }) : Response.json(payload()),
		});
		const ui = resetUI();
		await h.controller.useResetCredit(ui);
		const state = h.controller.getState();
		assert.equal(state.stale, true);
		assert.equal(resetCredits(state).stale, true);
		assert.equal(quotaSnapshot(state).windows[0].remainingPercent, 78);
		assert.match(present(ui.notices.at(-1)).message, /数据同步未完成/);
		assert.match(present(ui.notices.at(-1)).message, code === "reset" ? /确认重置成功/ : /结果不确定/);
		await h.controller.useResetCredit(resetUI());
		assert.equal(h.consumeRequests.length, 1);
		h.controller.dispose();
	}
});

test("consume timeout settles transports ignoring AbortSignal and blocks subsequent dispatch", async () => {
	const timeout = new AbortController();
	let timeouts = 0;
	const h = harness({ consumeTransport: () => new Promise(() => {}), timeoutSignal: () => ++timeouts === 5 ? timeout.signal : new AbortController().signal });
	const ui = resetUI();
	const operation = h.controller.useResetCredit(ui);
	await tick();
	assert.equal(h.consumeRequests.length, 1);
	timeout.abort(new Error("synthetic-body-secret"));
	await operation;
	assert.equal(h.consumeRequests[0].init.signal.aborted, true);
	assert.match(present(ui.notices.at(-1)).message, /结果不确定/);
	await h.controller.useResetCredit(resetUI());
	assert.equal(h.consumeRequests.length, 1);
	assertResetSanitized(h, ui);
	h.controller.dispose();
});

test("account/logout/card changes and expiry during confirmation cancel without replacing card", async () => {
	for (const change of ["account", "logout", "card", "expiry"]) {
		let id = "synthetic-account-A";
		let valid = true;
		let loggedIn = true;
		const h = harness({ auth: async () => loggedIn ? oauth(id) : undefined, resetTransport: async () => { const data = resetPayload(); if (!valid) data.credits[0].status = "redeemed"; return Response.json(data); } });
		const ui = resetUI({ onSelect: async (count) => {
			if (count === 2) {
				if (change === "account") id = "synthetic-account-B";
				if (change === "logout") loggedIn = false;
				if (change === "card") valid = false;
				if (change === "expiry") h.advance(30 * 86400_000);
			}
		} });
		await h.controller.useResetCredit(ui);
		assert.equal(h.consumeRequests.length, 0);
		h.controller.dispose();
	}
	for (const mode of ["switch", "throw"]) {
		let authCalls = 0;
		const h = harness({ auth: async () => {
			if (++authCalls === 3) {
				if (mode === "throw") throw new Error("synthetic-body-secret");
				return oauth("synthetic-account-B");
			}
			return oauth();
		} });
		const ui = resetUI();
		await h.controller.useResetCredit(ui);
		assert.equal(h.consumeRequests.length, 0, "final request-time auth must also match confirmed account");
		assert.equal(h.controller.getState().phase, "auth_error");
		assert.equal(h.controller.getState().snapshot, null);
		assertResetSanitized(h, ui);
		h.controller.dispose();
	}
});

test("single-flight covers selection, confirmation and POST while polls cannot overwrite it", async () => {
	const waitSelection = deferred();
	const waitPost = deferred<Response>();
	const h = harness({ consumeTransport: () => waitPost.promise });
	const ui = resetUI({ onSelect: async (count) => { if (count === 1) await waitSelection.promise; } });
	const first = h.controller.useResetCredit(ui);
	await tick();
	const repeatUI = resetUI();
	await h.controller.useResetCredit(repeatUI);
	await h.controller.refresh(true);
	assert.equal(h.requests.length, 1);
	assert.equal(repeatUI.dialogs.length, 0);
	assert.match(repeatUI.notices[0].message, /正在进行/);
	waitSelection.resolve();
	await tick();
	assert.equal(h.consumeRequests.length, 1);
	await h.controller.refresh(true);
	assert.equal(h.requests.length, 2);
	await h.controller.useResetCredit(resetUI());
	assert.equal(h.consumeRequests.length, 1);
	waitPost.resolve(Response.json({ code: "reset" }));
	await first;
	assert.equal(h.requests.length, 3);
	h.controller.dispose();
});

test("an existing refresh completes before reset preparation; no stale refresh races POST", async () => {
	const waiting = deferred<Response>();
	let first = true;
	const h = harness({ transport: async () => { if (first) { first = false; return waiting.promise; } return Response.json(payload()); } });
	const refresh = h.controller.refresh();
	await tick();
	const use = h.controller.useResetCredit(resetUI());
	await tick();
	assert.equal(h.consumeRequests.length, 0);
	waiting.resolve(Response.json(payload()));
	await Promise.all([refresh, use]);
	assert.equal(h.consumeRequests.length, 1);
	assert.equal(h.requests.length, 4);
	h.controller.dispose();
});

test("suspend cancels auth/HTTP and a new refresh never reuses or is cleared by old work", async () => {
	for (const stage of ["auth", "http"]) {
		const oldAuth = deferred<ProviderAuth>();
		const oldResponse = deferred<Response>();
		const newResponse = deferred<Response>();
		let old = true;
		const h = harness({ auth: () => old && stage === "auth" ? oldAuth.promise : Promise.resolve(oauth()),
			transport: () => old ? oldResponse.promise : newResponse.promise });
		const pending = h.controller.refresh(); await tick();
		const changes = h.changes.length;
		h.controller.suspend();
		assert.equal(h.changes.length, changes, "entrypoint owns hiding/publishing");
		assert.equal(h.controller.getState().phase, "idle");
		assert.equal(h.controller.getState().snapshot, null);
		assert.equal(h.controller.getState().resetCredits?.snapshot, null);
		if (stage === "http") assert.equal(h.requests[0].init.signal.aborted, true);
		old = false;
		const resumed = h.controller.refresh(true);
		assert.notEqual(resumed, pending);
		await pending; await tick();
		assert.equal(h.controller.refresh(true), resumed, "old finally must not clear resumed single-flight");
		newResponse.resolve(Response.json(payload()));
		assert.equal((await resumed).phase, "ready");
		oldAuth.resolve(oauth("late-account")); oldResponse.resolve(Response.json({ plan_type: "late" }));
		await tick();
		assert.equal(h.controller.getState().snapshot?.plan, "plus");
		h.controller.dispose();
	}
});

test("suspend cancels reset dialogs/POST, ignores late completion and allows fresh refresh", async () => {
	for (const stage of ["dialog", "post"]) {
		const dialog = deferred();
		const post = deferred<Response>();
		const h = harness({ consumeTransport: () => post.promise });
		const ui = resetUI({ onSelect: async () => { if (stage === "dialog") await dialog.promise; } });
		const pending = h.controller.useResetCredit(ui); await tick();
		h.controller.suspend(); await pending;
		assert.equal(h.controller.getState().resetUse, undefined);
		assert.equal(h.controller.getState().lastSuccessAt, null);
		assert.equal(h.controller.getResetButton().phase, "disabled");
		assert.equal((await h.controller.refresh(true)).phase, "ready");
		dialog.resolve(); post.resolve(Response.json({ code: "reset" })); await tick();
		assert.equal(ui.notices.length, 0);
		assert.equal(h.controller.getState().resetUse, undefined);
		if (stage === "post") {
			assert.equal(h.consumeRequests[0].init.signal.aborted, true);
			await h.controller.useResetCredit(resetUI());
			assert.equal(h.consumeRequests.length, 1, "cancelled dispatched POST stays locked");
		} else {
			await h.controller.useResetCredit(resetUI({ pick: false }));
			assert.equal(h.consumeRequests.length, 0);
		}
		h.controller.dispose();
	}
});

test("suspend preserves usage, card and consume 429 cooldowns across resumed authentication", async () => {
	for (const endpoint of [API_URL, RESET_CREDITS_URL, CONSUME_RESET_URL]) {
		const limited = async () => new Response("", { status: 429, headers: { "Retry-After": "120" } });
		const h = harness({ transport: endpoint === API_URL ? limited : undefined,
			resetTransport: endpoint === RESET_CREDITS_URL ? limited : undefined,
			consumeTransport: endpoint === CONSUME_RESET_URL ? limited : undefined });
		if (endpoint === CONSUME_RESET_URL) await h.controller.useResetCredit(resetUI());
		else await h.controller.refresh();
		const attempts = h.allRequests.filter((request) => request.url === endpoint).length;
		h.controller.suspend();
		assert.equal(h.controller.getState().error, null);
		assert.equal(h.controller.getState().retryAt, null);
		h.advance(119_999);
		await h.controller.refresh(true);
		await h.controller.useResetCredit(resetUI());
		assert.equal(h.allRequests.filter((request) => request.url === endpoint).length, attempts, endpoint);
		h.advance(1);
		if (endpoint === CONSUME_RESET_URL) await h.controller.useResetCredit(resetUI());
		else await h.controller.refresh(true);
		assert.equal(h.allRequests.filter((request) => request.url === endpoint).length, attempts + 1, endpoint);
		h.controller.dispose();
	}
});

test("shutdown settles waiting dialogs/auth/POST and ignores late results", async () => {
	for (const stage of ["dialog", "auth", "post"]) {
		const dialog = deferred();
		const auth = deferred<ProviderAuth>();
		const post = deferred<Response>();
		const h = harness({
			auth: stage === "auth" ? () => auth.promise : async () => oauth(),
			consumeTransport: stage === "post" ? () => post.promise : undefined,
		});
		const ui = resetUI({ onSelect: stage === "dialog" ? () => dialog.promise : undefined });
		const use = h.controller.useResetCredit(ui);
		await tick();
		const changesBefore = h.changes.length;
		h.controller.dispose();
		await use;
		dialog.resolve();
		auth.resolve(oauth());
		post.resolve(Response.json({ code: "reset" }));
		await tick();
		assert.equal(h.changes.length, changesBefore);
		assert.equal(h.controller.getState().snapshot, null);
		assert.equal(ui.notices.length, 0);
		assert.equal(h.consumeRequests.length, stage === "post" ? 1 : 0);
		if (stage === "post") assert.equal(h.consumeRequests[0].init.signal.aborted, true);
	}
});
