import assert from "node:assert/strict";
import { test } from "node:test";
import { BalanceController, isOffline, parseRetryAfter, POLL_MS, THROTTLE_MS, TIMEOUT_MS } from "../src/balance/core.ts";
import type { BalanceSnapshot, BalanceState, ControllerOptions } from "../src/balance/core.ts";
import { API_URL, detailLines, parseBalance, statusLine, summaryLine } from "../src/balance/kimi.ts";
import type { KimiBalanceInfo } from "../src/balance/kimi.ts";

type State = BalanceState<KimiBalanceInfo>;
const balanceOptions = (options: Omit<ControllerOptions<KimiBalanceInfo>, "apiUrl" | "parse">) =>
	new BalanceController<KimiBalanceInfo>({ apiUrl: API_URL, parse: parseBalance, ...options });

// Tripwire: tests must never fall through to a real network request.
globalThis.fetch = async () => { throw new Error("Unexpected live fetch in test"); };

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function present<T>(value: T | null | undefined): T {
	assert.ok(value != null, "Expected test data to be present");
	return value;
}
const snapshot = (state: State): BalanceSnapshot<KimiBalanceInfo> => present(state.snapshot);

const PAYLOAD = {
	code: 0,
	status: true,
	scode: "0x0",
	data: { available_balance: "110.00", voucher_balance: "10.00", cash_balance: "100.00" },
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

interface RecordedRequest {
	url: Parameters<typeof globalThis.fetch>[0];
	init: Parameters<typeof globalThis.fetch>[1];
}
interface HarnessOptions {
	resolveAuth?: ControllerOptions<KimiBalanceInfo>["resolveAuth"];
	respond?: (count: number, ...request: Parameters<typeof globalThis.fetch>) => ReturnType<typeof globalThis.fetch>;
	offline?: boolean;
	timeoutSignal?: ControllerOptions<KimiBalanceInfo>["timeoutSignal"];
}

/** Controller with an injectable clock/transport and a recorded fetch call log. */
function harness(options: HarnessOptions = {}) {
	const clock = { t: NOW };
	const calls: RecordedRequest[] = [];
	const states: State[] = [];
	const controller = balanceOptions({
		resolveAuth: options.resolveAuth ?? (async () => "sk-test"),
		now: () => clock.t,
		offline: options.offline,
		timeoutSignal: options.timeoutSignal,
		fetch: (url, init) => {
			calls.push({ url, init });
			return options.respond ? options.respond(calls.length, url, init) : Promise.resolve(jsonResponse(PAYLOAD));
		},
		onChange: (state) => states.push(state),
	});
	return {
		controller,
		calls,
		states,
		advance: (ms: number) => { clock.t += ms; },
		get now() { return clock.t; },
	};
}

test("statusLine shows loading with the previous value and the accent color", async () => {
	const h = harness({ respond: (n) => n === 1 ? Promise.resolve(jsonResponse(PAYLOAD)) : new Promise(() => {}) });
	await h.controller.refresh(true);
	assert.equal(h.controller.getState().phase, "ready");

	void h.controller.refresh(true);
	await tick();
	const state = h.controller.getState();
	assert.equal(state.phase, "loading");
	const line = statusLine(state, h.now);
	assert.equal(line.text, "🌙 Kimi[更新中] 余额：¥110.00");
	assert.equal(line.color, "accent");
});

test("stale marker wins over the loading marker", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const h = harness({
		respond: (n) => n === 1 ? Promise.resolve(jsonResponse(PAYLOAD))
			: n === 2 ? Promise.resolve(jsonResponse({}, 500))
			: gate.then(() => jsonResponse({}, 500)),
	});
	await h.controller.refresh(true);
	h.advance(THROTTLE_MS + 1);
	await h.controller.refresh();
	const failed = h.controller.getState();
	assert.equal(failed.phase, "network_error");
	assert.equal(failed.stale, true);
	assert.equal(statusLine(failed, h.now).text, "🌙 Kimi[过期] 余额：¥110.00");
	assert.equal(statusLine(failed, h.now).color, "warning");

	// While the next attempt is in flight, the stale marker still wins over [更新中].
	const pending = h.controller.refresh(true);
	await tick();
	const loading = h.controller.getState();
	assert.equal(loading.phase, "loading");
	assert.equal(loading.stale, true);
	assert.equal(statusLine(loading, h.now).text, "🌙 Kimi[过期] 余额：¥110.00");
	assert.equal(statusLine(loading, h.now).color, "warning");
	release();
	await pending;
});

test("non-forced refresh is throttled to one request per 30s", async () => {
	const h = harness();
	await h.controller.refresh(true);
	assert.equal(h.calls.length, 1);

	await h.controller.refresh();
	assert.equal(h.calls.length, 1, "second call within the throttle window must not fetch");

	h.advance(THROTTLE_MS + 1);
	await h.controller.refresh();
	assert.equal(h.calls.length, 2);

	h.advance(POLL_MS);
	await h.controller.refresh();
	assert.equal(h.calls.length, 3);
});

test("force bypasses the throttle but never the rate-limit cooldown", async () => {
	const h = harness();
	await h.controller.refresh(true);
	await h.controller.refresh(true);
	assert.equal(h.calls.length, 2, "force must bypass the 30s throttle");
});

test("concurrent refreshes share a single in-flight request", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const h = harness({ respond: () => gate.then(() => jsonResponse(PAYLOAD)) });
	const first = h.controller.refresh(true);
	const second = h.controller.refresh(true);
	assert.equal(first, second);
	release();
	await first;
	assert.equal(h.calls.length, 1);
});

test("HTTP 429 enters a cooldown that force cannot bypass and honours Retry-After", async () => {
	const h = harness({ respond: () => Promise.resolve(jsonResponse({}, 429, { "Retry-After": "42" })) });
	await h.controller.refresh(true);
	const state = h.controller.getState();
	assert.equal(state.phase, "rate_limited");
	assert.equal(state.retryAt, h.now + 42_000);
	assert.equal(state.snapshot, null);

	h.advance(1_000);
	await h.controller.refresh(true);
	assert.equal(h.calls.length, 1, "force must not bypass the cooldown");

	h.advance(42_000);
	await h.controller.refresh(true);
	assert.equal(h.calls.length, 2);
});

test("an out-of-range Retry-After falls back to the backoff window", async () => {
	const h = harness({ respond: () => Promise.resolve(jsonResponse({}, 429, { "Retry-After": "99999999999999" })) });
	await h.controller.refresh(true);
	assert.equal(h.controller.getState().retryAt, h.now + 60_000);
});

test("failures back off 60s, 120s, 240s and cap at 300s", async () => {
	const h = harness({ respond: () => Promise.resolve(jsonResponse({}, 500)) });
	const observed: number[] = [];
	for (let attempt = 0; attempt < 5; attempt++) {
		await h.controller.refresh(true);
		observed.push(present(h.controller.getState().retryAt) - h.now);
		h.advance(1_000);
	}
	assert.deepEqual(observed, [60_000, 120_000, 240_000, 300_000, 300_000]);
});

test("a success resets the failure backoff", async () => {
	let fail = true;
	const h = harness({ respond: () => Promise.resolve(fail ? jsonResponse({}, 500) : jsonResponse(PAYLOAD)) });
	await h.controller.refresh(true);
	assert.equal(present(h.controller.getState().retryAt) - h.now, 60_000);

	fail = false;
	await h.controller.refresh(true);
	const state = h.controller.getState();
	assert.equal(state.phase, "ready");
	assert.equal(state.retryAt, null);
	assert.equal(state.stale, false);

	// The next failure restarts the backoff ladder at 60s.
	fail = true;
	h.advance(THROTTLE_MS + 1);
	await h.controller.refresh(true);
	assert.equal(present(h.controller.getState().retryAt) - h.now, 60_000);
});

test("missing credentials park in not_configured without entering backoff", async () => {
	let key: string | undefined;
	const h = harness({ resolveAuth: async () => key });
	await h.controller.refresh(true);
	let state = h.controller.getState();
	assert.equal(state.phase, "not_configured");
	assert.equal(state.retryAt, null);
	assert.equal(h.calls.length, 0);

	// Only a throttle window is enforced, so a late login recovers on the next attempt.
	h.advance(THROTTLE_MS + 1);
	key = "sk-live";
	await h.controller.refresh();
	state = h.controller.getState();
	assert.equal(state.phase, "ready");
	assert.equal(h.calls.length, 1);
});

test("HTTP 401 clears the snapshot and reports an auth error", async () => {
	const h = harness({ respond: (n) => Promise.resolve(n === 1 ? jsonResponse(PAYLOAD) : jsonResponse({}, 401)) });
	await h.controller.refresh(true);
	assert.equal(snapshot(h.controller.getState()).isAvailable, true);

	h.advance(THROTTLE_MS + 1);
	await h.controller.refresh();
	const state = h.controller.getState();
	assert.equal(state.phase, "auth_error");
	assert.equal(state.snapshot, null);
	assert.equal(statusLine(state, h.now).text, "🌙 Kimi 凭据失效");
});

test("a changed credential discards the previous snapshot", async () => {
	let key = "sk-one";
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const h = harness({
		resolveAuth: async () => key,
		respond: (n) => n === 1 ? Promise.resolve(jsonResponse(PAYLOAD)) : gate.then(() => jsonResponse(PAYLOAD)),
	});
	await h.controller.refresh(true);
	assert.ok(h.controller.getState().snapshot);

	key = "sk-two";
	h.advance(THROTTLE_MS + 1);
	const pending = h.controller.refresh();
	await tick();
	assert.equal(h.controller.getState().snapshot, null, "a rotated key must not present the old balance as current");
	release();
	await pending;
	assert.ok(h.controller.getState().snapshot, "the new credential's balance is shown once it lands");
});

test("a hung request is classified as a timeout", async () => {
	const abort = new AbortController();
	const h = harness({ timeoutSignal: () => abort.signal, respond: () => new Promise(() => {}) });
	const promise = h.controller.refresh(true);
	await tick();
	abort.abort();
	await promise;
	const state = h.controller.getState();
	assert.equal(state.phase, "timeout");
	assert.equal(present(state.error).kind, "timeout");
	assert.match(detailLines(state, h.now).join("\n"), /超时/);
});

test("malformed payloads produce a data error without inventing a balance", async () => {
	const h = harness({ respond: () => Promise.resolve(jsonResponse({ code: 0, status: true, data: "nope" })) });
	await h.controller.refresh(true);
	const state = h.controller.getState();
	assert.equal(state.phase, "data_error");
	assert.equal(state.snapshot, null);
	assert.equal(statusLine(state, h.now).text, "🌙 Kimi 数据异常");
});

test("a zero available balance is coloured as a warning even when the request succeeds", async () => {
	const h = harness({ respond: () => Promise.resolve(jsonResponse({ ...PAYLOAD, data: { available_balance: "0.00", voucher_balance: 0, cash_balance: 0 } })) });
	await h.controller.refresh(true);
	const state = h.controller.getState();
	assert.equal(statusLine(state, h.now).color, "warning");
	assert.equal(statusLine(state, h.now).text, "🌙 Kimi 余额：¥0.00 ⚠");
	assert.match(detailLines(state, h.now).join("\n"), /不可用/);
	assert.equal(summaryLine(state).type, "warning");
});

test("getState returns a detached copy of the snapshot", async () => {
	const h = harness();
	await h.controller.refresh(true);
	const copy = h.controller.getState();
	snapshot(copy).infos[0].currency = "XXX";
	snapshot(copy).isAvailable = false;
	copy.error = { kind: "network" };
	assert.equal(snapshot(h.controller.getState()).infos[0].currency, "CNY");
	assert.equal(snapshot(h.controller.getState()).isAvailable, true);
	assert.equal(h.controller.getState().error, null);
});

test("dispose aborts the request and ignores a late response", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const h = harness({ respond: () => gate.then(() => jsonResponse(PAYLOAD)) });
	const promise = h.controller.refresh(true);
	await tick();
	h.controller.dispose();
	release();
	const settled = await promise;
	assert.equal(settled.phase, "idle");
	assert.equal(h.controller.getState().snapshot, null);
	assert.equal(h.controller.getState().phase, "idle");
});

test("offline mode never resolves credentials or fetches", async () => {
	let resolved = 0;
	const h = harness({ offline: true, resolveAuth: async () => { resolved++; return "sk-test"; } });
	const state = await h.controller.refresh(true);
	assert.equal(state.phase, "offline");
	assert.equal(h.calls.length, 0);
	assert.equal(resolved, 0);
	assert.equal(statusLine(state, h.now).text, "🌙 Kimi 离线");
	assert.deepEqual(detailLines(state, h.now), ["离线模式：未解析凭据，未发起余额请求。", "取消 PI_OFFLINE / --offline 后重新启动 pi。"]);
});

test("detailLines carries the stale banner, local time and restart countdown", async () => {
	const h = harness({ respond: (n) => Promise.resolve(n === 1 ? jsonResponse(PAYLOAD) : jsonResponse({}, 500)) });
	await h.controller.refresh(true);
	h.advance(THROTTLE_MS + 1);
	await h.controller.refresh();
	const text = detailLines(h.controller.getState(), h.now).join("\n");
	assert.match(text, /以下为过期缓存，不代表当前余额。/);
	assert.match(text, /可用余额\s+¥110.00/);
	assert.match(text, /代金券余额\s+10\.00/);
	assert.match(text, /现金余额\s+100\.00/);
	assert.match(text, /更新：\d{4}-\d{2}-\d{2} \d{2}:\d{2} · 本机时区/);
	assert.match(text, /自动重试：\d+m后/);
});

test("summaryLine reports staleness for non-TUI notifications", async () => {
	const h = harness({ respond: (n) => Promise.resolve(n === 1 ? jsonResponse(PAYLOAD) : jsonResponse({}, 500)) });
	await h.controller.refresh(true);
	h.advance(THROTTLE_MS + 1);
	await h.controller.refresh();
	const summary = summaryLine(h.controller.getState());
	assert.equal(summary.type, "warning");
	assert.match(summary.text, /^\[过期\] Kimi 余额：¥110\.00（代金券 10\.00 \/ 现金 100\.00） · 可用$/);
});

test("change notifications fire for loading, success and failure", async () => {
	const h = harness({ respond: (n) => Promise.resolve(n === 1 ? jsonResponse(PAYLOAD) : jsonResponse({}, 500)) });
	await h.controller.refresh(true);
	assert.deepEqual(h.states.map((state) => state.phase), ["loading", "ready"]);
	h.advance(THROTTLE_MS + 1);
	await h.controller.refresh();
	assert.deepEqual(h.states.map((state) => state.phase), ["loading", "ready", "loading", "network_error"]);
});

test("a throwing onChange callback cannot break the refresh", async () => {
	const controller = balanceOptions({
		resolveAuth: async () => "sk-test",
		now: () => NOW,
		fetch: () => Promise.resolve(jsonResponse(PAYLOAD)),
		onChange: () => { throw new Error("UI torn down"); },
	});
	const state = await controller.refresh(true);
	assert.equal(state.phase, "ready");
});

test("parseBalance accepts signed balances and keeps the sign", () => {
	const signed = {
		...PAYLOAD,
		data: { available_balance: "1.74", voucher_balance: "1.74", cash_balance: "-0.23" },
	};
	assert.deepEqual(parseBalance(signed, NOW).infos[0], {
		currency: "CNY", availableBalance: "1.51", voucherBalance: "1.74", cashBalance: "-0.23",
	});
	const negativeTotal = {
		...PAYLOAD,
		data: { available_balance: "-1.50", voucher_balance: 0, cash_balance: -1.5 },
	};
	assert.deepEqual(parseBalance(negativeTotal, NOW).infos[0], {
		currency: "CNY", availableBalance: "-1.5", voucherBalance: "0", cashBalance: "-1.5",
	});
	for (const bad of ["--1.00", "1e5", "- 1.00", "1.00 ", "-1.2.3", "-", "−1"]) {
		assert.throws(() => parseBalance({ ...PAYLOAD, data: { ...PAYLOAD.data, available_balance: bad } }, NOW), bad);
	}
	assert.throws(() => parseBalance({ ...PAYLOAD, data: { ...PAYLOAD.data, available_balance: Number.NEGATIVE_INFINITY } }, NOW));
	assert.equal(parseBalance(negativeTotal, NOW).isAvailable, false);
});

const SIGNED_PAYLOAD = {
	...PAYLOAD,
	data: { available_balance: "0", voucher_balance: "0", cash_balance: "-0.05185" },
};

test("negative cash is included in the available balance shown across outputs", async () => {
	const h = harness({ respond: () => Promise.resolve(jsonResponse(SIGNED_PAYLOAD)) });
	await h.controller.refresh(true);
	const state = h.controller.getState();
	assert.equal(state.phase, "ready");
	assert.equal(state.error, null);
	assert.equal(statusLine(state, h.now).text, "🌙 Kimi 余额：-¥0.05185 ⚠");
	assert.match(detailLines(state, h.now).join("\n"), /可用余额\s+-¥0\.05185/);
	assert.match(detailLines(state, h.now).join("\n"), /现金余额\s+-0\.05185/);
	assert.equal(summaryLine(state).text, "Kimi 余额：-¥0.05185（代金券 0 / 现金 -0.05185） · 不可用");
});

test("parseBalance validates required fields and keeps only balance data", () => {
	assert.throws(() => parseBalance(null, NOW));
	assert.throws(() => parseBalance({ data: PAYLOAD.data }, NOW));
	assert.throws(() => parseBalance({ ...PAYLOAD, data: [] }, NOW));
	assert.throws(() => parseBalance({ ...PAYLOAD, data: { ...PAYLOAD.data, available_balance: "1.00; invalid" } }, NOW));
	const parsed = parseBalance(PAYLOAD, NOW);
	assert.deepEqual(parsed, {
		isAvailable: true,
		receivedAt: NOW,
		infos: [{ currency: "CNY", availableBalance: "110.00", voucherBalance: "10.00", cashBalance: "100.00" }],
	});
});

test("parseRetryAfter accepts seconds and HTTP dates and rejects out-of-range values", () => {
	assert.equal(parseRetryAfter("42", NOW), NOW + 42_000);
	assert.equal(parseRetryAfter("1.5", NOW), NOW + 1_500);
	assert.equal(parseRetryAfter(new Date(NOW + 30_000).toUTCString(), NOW), NOW + 30_000);
	assert.equal(parseRetryAfter("-1", NOW), undefined);
	assert.equal(parseRetryAfter("99999999999999", NOW), undefined);
	assert.equal(parseRetryAfter(null, NOW), undefined);
	assert.equal(parseRetryAfter("   ", NOW), undefined);
});

test("the documented numeric response keeps all available, voucher and cash digits", () => {
	const result = parseBalance({
		code: 0, status: true, scode: "0x0",
		data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 },
	}, NOW);
	assert.deepEqual(result.infos, [{
		currency: "CNY", availableBalance: "49.58894", voucherBalance: "46.58893", cashBalance: "3.00001",
	}]);
	assert.equal(result.isAvailable, true);
});

test("plain decimal strings retain precision and net negative cash without rounding", () => {
	// 0.1.3 nets cash arrears against the voucher balance; digits must survive exactly.
	const precise = parseBalance({
		...PAYLOAD,
		data: { available_balance: "1.123456789012345678", voucher_balance: "1.123456789012345678", cash_balance: "-0.2300" },
	}, NOW);
	assert.equal(precise.infos[0].availableBalance, "0.893456789012345678");
	assert.equal(precise.infos[0].voucherBalance, "1.123456789012345678");
	assert.equal(precise.infos[0].cashBalance, "-0.2300");
	assert.equal(precise.isAvailable, true);
});

test("footer, details and text notifications preserve API balance digits", async () => {
	const h = harness({ respond: () => Promise.resolve(jsonResponse({
		...PAYLOAD,
		data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 },
	})) });
	await h.controller.refresh(true);
	const state = h.controller.getState();
	assert.equal(statusLine(state, h.now).text, "🌙 Kimi 余额：¥49.58894");
	const details = detailLines(state, h.now).join("\n");
	assert.match(details, /可用余额\s+¥49\.58894\n/);
	assert.match(details, /代金券余额\s+46\.58893\n/);
	assert.match(details, /现金余额\s+3\.00001\n/);
	assert.equal(summaryLine(state).text, "Kimi 余额：¥49.58894（代金券 46.58893 / 现金 3.00001） · 可用");
	assert.equal(snapshot(state).infos[0].availableBalance, "49.58894");
});

test("display API decimal strings without rounding or padding", async () => {
	for (const raw of [
		"1", "0", "1.005", "9.999", "-1.005", "-0.001", "999999999999999999.995",
	]) {
		const h = harness({ respond: () => Promise.resolve(jsonResponse({
			...PAYLOAD, data: { available_balance: raw, voucher_balance: 0, cash_balance: raw },
		})) });
		await h.controller.refresh(true);
		const state = h.controller.getState();
		const available = Number(raw) > 0;
		const availableText = raw.startsWith("-") ? `-¥${raw.slice(1)}` : `¥${raw}`;
		assert.equal(statusLine(state, h.now).text, `🌙 Kimi 余额：${availableText}${available ? "" : " ⚠"}`, raw);
		assert.ok(detailLines(state, h.now).includes(`现金余额    ${raw}`), raw);
		assert.equal(summaryLine(state).text, `Kimi 余额：${availableText}（代金券 0 / 现金 ${raw}） · ${available ? "可用" : "不可用"}`, raw);
	}
});

test("small numeric balances are displayed as ordinary decimal values", async () => {
	const h = harness({ respond: () => Promise.resolve(jsonResponse({
		...PAYLOAD, data: { available_balance: 1e-7, voucher_balance: 1e-7, cash_balance: 1e-7 },
	})) });
	await h.controller.refresh(true);
	const state = h.controller.getState();
	assert.equal(statusLine(state, h.now).text, "🌙 Kimi 余额：¥0.0000001");
	assert.equal(statusLine(state, h.now).color, "success");
	assert.equal(snapshot(state).isAvailable, true);
	assert.match(detailLines(state, h.now).join("\n"), /现金余额\s+0\.0000001\n/);
	assert.equal(snapshot(state).infos[0].availableBalance, "0.0000001");
});

test("business success requires numeric code zero and boolean status true", () => {
	for (const payload of [
		{ ...PAYLOAD, code: 123 }, { ...PAYLOAD, code: "0" },
		{ ...PAYLOAD, code: undefined }, { ...PAYLOAD, status: false },
		{ ...PAYLOAD, status: 1 }, { ...PAYLOAD, status: undefined },
	]) assert.throws(() => parseBalance(payload, NOW));
});

test("missing, non-finite and malformed balances never become zero", () => {
	for (const field of ["available_balance", "voucher_balance", "cash_balance"]) {
		for (const invalid of [undefined, null, true, [], {}, "", " ", "1e3", "NaN", NaN, Infinity, -Infinity]) {
			assert.throws(() => parseBalance({ ...PAYLOAD, data: { ...PAYLOAD.data, [field]: invalid } }, NOW), `${field}: ${String(invalid)}`);
		}
	}
	for (const negative of [-0.01, "-0.01"]) {
		assert.throws(() => parseBalance({ ...PAYLOAD, data: { ...PAYLOAD.data, voucher_balance: negative } }, NOW));
	}
});

test("a business error marks the last balance stale without exposing response messages", async () => {
	const rawMessage = "private-server-message-should-not-render";
	const h = harness({ respond: (n) => Promise.resolve(jsonResponse(n === 1 ? PAYLOAD : { ...PAYLOAD, code: 17, status: false, message: rawMessage })) });
	await h.controller.refresh(true);
	h.advance(THROTTLE_MS + 1);
	await h.controller.refresh();
	const state = h.controller.getState();
	assert.equal(state.phase, "data_error");
	assert.equal(state.stale, true);
	assert.equal(snapshot(state).infos[0].availableBalance, "110.00");
	assert.doesNotMatch(detailLines(state, h.now).join("\n"), /private-server-message/);
});

test("balance requests use the fixed domestic endpoint, Bearer authentication and no redirects", async () => {
	const h = harness();
	await h.controller.refresh(true);
	assert.equal(h.calls.length, 1);
	assert.equal(h.calls[0].url, "https://api.moonshot.cn/v1/users/me/balance");
	const init = present(h.calls[0].init);
	assert.equal(init.method, "GET");
	assert.equal(init.redirect, "error");
	assert.equal(new Headers(init.headers).get("Authorization"), "Bearer sk-test");
	assert.equal(init.body, undefined);
});

test("isOffline honours the usual truthy spellings", () => {
	for (const value of ["1", "true", "TRUE", "yes", " Yes "]) assert.equal(isOffline(value), true, value);
	for (const value of [undefined, "", "0", "false", "no", "offline"]) assert.equal(isOffline(value), false, String(value));
});

test("the exported API_URL is the documented balance endpoint", () => {
	assert.equal(API_URL, "https://api.moonshot.cn/v1/users/me/balance");
	assert.equal(POLL_MS, 60_000);
	assert.equal(TIMEOUT_MS, 10_000);
});
