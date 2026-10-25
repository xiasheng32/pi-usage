/**
 * Shared balance refresh policy for provider APIs that report an account balance.
 *
 * Ported from xiasheng32/pi-deepseek v0.2.0 (and its Kimi port): controller-scoped
 * state, guard ordering, per-request timeout, exponential backoff, Retry-After
 * cooldown, stale marking and a phase-driven status line.
 *
 * Everything provider-specific lives in the adapter next to this file:
 * the API URL, the payload parser and the brand strings/amount formatting.
 *
 * Deliberately dependency-free (no imports, no `node:` builtins) so the file can
 * be unit-tested under `node --test`.
 */

export const THROTTLE_MS = 30_000;
export const TIMEOUT_MS = 10_000;
export const POLL_MS = 60_000;
const BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 300_000;
const MAX_DATE_MS = 8_640_000_000_000_000;

/** Every balance row carries a currency; field-level details stay in the adapter. */
export interface BalanceInfo {
	currency: string;
}

export interface BalanceSnapshot<TInfo extends BalanceInfo = BalanceInfo> {
	isAvailable: boolean;
	infos: TInfo[];
	receivedAt: number;
}

export type BalancePhase =
	| "idle" | "offline" | "loading" | "ready" | "not_configured"
	| "auth_error" | "rate_limited" | "data_error" | "network_error" | "timeout";

export interface BalanceError {
	kind: "auth" | "http_auth" | "rate_limit" | "data" | "http" | "network" | "timeout";
	httpStatus?: number;
}

export interface BalanceState<TInfo extends BalanceInfo = BalanceInfo> {
	phase: BalancePhase;
	snapshot: BalanceSnapshot<TInfo> | null;
	lastAttemptAt: number | null;
	lastSuccessAt: number | null;
	stale: boolean;
	retryAt: number | null;
	error: BalanceError | null;
}

export interface ControllerOptions<TInfo extends BalanceInfo> {
	/** Balance endpoint of the bound provider. */
	apiUrl: string;
	/** Validates the provider payload; throws BalanceDataError on any surprise. */
	parse: (payload: unknown, receivedAt: number) => BalanceSnapshot<TInfo>;
	/** Request-time credential resolution; the resolved key is never retained. */
	resolveAuth: () => Promise<string | undefined>;
	fetch?: typeof globalThis.fetch;
	now?: () => number;
	timeoutSignal?: (milliseconds: number) => AbortSignal;
	onChange?: (state: BalanceState<TInfo>) => void;
	offline?: boolean;
}

/** Display identity of a balance provider, shared by the footer, panel and summary. */
export interface BalanceBrand<TInfo extends BalanceInfo> {
	id: string;
	icon: string;
	label: string;
	/** `/login <provider>` hint shown while no credential is configured. */
	loginCommand: string;
	envVariable: string;
	/** Amount rendered in the status line and panel rows, e.g. `¥110.00`. */
	amount(info: TInfo): string;
	/** Extra detail rows for one balance entry (currency line is added by the core). */
	detailRows(info: TInfo): string[];
	/** Spaces after `状态` so the value lines up with this provider's row labels. */
	statusGap: string;
	/** One summary fragment per balance entry. */
	summaryEntry(info: TInfo): string;
	/** Panel rows painted with the accent colour (e.g. the primary amount row). */
	detailAccent: RegExp;
	/** Kimi warns in summaries when the account is unavailable; DeepSeek does not. */
	summaryWarnsWhenUnavailable: boolean;
}

export class BalanceDataError extends Error {}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isOffline(value: string | undefined): boolean {
	return /^(1|true|yes)$/i.test(value?.trim() ?? "");
}

/**
 * Non-cryptographic fingerprint used only to notice a credential change without
 * retaining the secret itself. A collision merely delays the reset until the
 * next refresh.
 */
function fingerprint(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return `${value.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

export function parseRetryAfter(value: string | null, now: number): number | undefined {
	if (!value?.trim()) return undefined;
	const text = value.trim();
	const numeric = /^\d+(?:\.\d+)?$/.test(text);
	// Date.parse also accepts strings such as "-1" as calendar dates, not valid Retry-After.
	if (!numeric && !/^[a-z]{3,9}(?:,|\s)/i.test(text)) return undefined;
	const retryAt = numeric ? now + Number(text) * 1000 : Date.parse(text);
	return Number.isFinite(retryAt) && retryAt <= MAX_DATE_MS ? Math.max(now, retryAt) : undefined;
}

/** Cancel the caller's wait even when a host operation or mock ignores its signal. */
function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			reject(signal.reason);
		};
		operation.then(
			(value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
			(error) => { signal.removeEventListener("abort", onAbort); reject(error); },
		);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
}

/** Per-extension-session controller, with an injectable transport for offline tests. */
export class BalanceController<TInfo extends BalanceInfo = BalanceInfo> {
	private readonly options: ControllerOptions<TInfo>;
	private readonly now: () => number;
	private readonly fetch: typeof globalThis.fetch;
	private state: BalanceState<TInfo>;
	private inflight: Promise<BalanceState<TInfo>> | null = null;
	private request: AbortController | null = null;
	private credential: string | null = null;
	private generation = 0;
	private disposed = false;
	private failures = 0;
	private nextAutomaticAt = 0;
	private rateLimitUntil = 0;

	constructor(options: ControllerOptions<TInfo>) {
		this.options = options;
		this.now = options.now ?? Date.now;
		this.fetch = options.fetch ?? globalThis.fetch;
		this.state = {
			phase: options.offline ? "offline" : "idle",
			snapshot: null, lastAttemptAt: null, lastSuccessAt: null,
			stale: false, retryAt: null, error: null,
		};
	}

	getState(): BalanceState<TInfo> {
		return {
			...this.state,
			error: this.state.error ? { ...this.state.error } : null,
			snapshot: this.state.snapshot ? {
				...this.state.snapshot,
				infos: this.state.snapshot.infos.map((info) => ({ ...info })),
			} : null,
		};
	}

	refresh(force = false): Promise<BalanceState<TInfo>> {
		if (this.disposed) return Promise.resolve(this.getState());
		if (this.options.offline) {
			this.publish();
			return Promise.resolve(this.getState());
		}
		if (this.inflight) return this.inflight;
		const now = this.now();
		if (now < this.rateLimitUntil) return Promise.resolve(this.getState());
		if (!force && (now < this.nextAutomaticAt
			|| (this.state.lastAttemptAt !== null && now - this.state.lastAttemptAt < THROTTLE_MS))) {
			return Promise.resolve(this.getState());
		}

		const generation = ++this.generation;
		const request = new AbortController();
		this.request = request;
		this.state = { ...this.state, phase: "loading", lastAttemptAt: now, error: null };
		this.inflight = Promise.resolve().then(() => this.performRefresh(generation, request)).finally(() => {
			if (this.request === request) {
				this.request = null;
				this.inflight = null;
			}
		});
		this.publish();
		return this.inflight;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.generation++;
		this.request?.abort();
		this.credential = null;
		this.state = {
			phase: "idle", snapshot: null, lastAttemptAt: null, lastSuccessAt: null,
			stale: false, retryAt: null, error: null,
		};
	}

	private current(generation: number): boolean {
		return !this.disposed && generation === this.generation;
	}

	private publish(): void {
		if (this.disposed) return;
		// A UI callback must not turn background polling into an unhandled rejection.
		try { this.options.onChange?.(this.getState()); } catch { /* UI may be tearing down. */ }
	}

	private clearCredential(): void {
		this.credential = null;
		this.state = { ...this.state, snapshot: null, lastSuccessAt: null, stale: false };
	}

	private fail(phase: BalancePhase, error: BalanceError, retryAt?: number): void {
		const now = this.now();
		const delay = Math.min(MAX_BACKOFF_MS, BACKOFF_MS * 2 ** Math.min(this.failures++, 3));
		const next = retryAt ?? now + delay;
		this.nextAutomaticAt = Math.max(now + THROTTLE_MS, next);
		this.state = {
			...this.state, phase, error,
			stale: this.state.snapshot !== null,
			retryAt: this.nextAutomaticAt,
		};
		this.publish();
	}

	private async performRefresh(generation: number, request: AbortController): Promise<BalanceState<TInfo>> {
		let signal: AbortSignal | undefined;
		try {
			let key: string | undefined;
			try {
				request.signal.throwIfAborted();
				key = await withAbort(this.options.resolveAuth(), request.signal);
			} catch {
				if (!this.current(generation) || request.signal.aborted) return this.getState();
				this.clearCredential();
				this.fail("auth_error", { kind: "auth" });
				return this.getState();
			}
			if (!this.current(generation)) return this.getState();
			if (!key) {
				this.clearCredential();
				this.failures = 0;
				this.nextAutomaticAt = this.now() + THROTTLE_MS;
				this.state = { ...this.state, phase: "not_configured", error: null, retryAt: null };
				this.publish();
				return this.getState();
			}
			const credential = fingerprint(key);
			if (this.credential !== credential) {
				// credential === null implies snapshot === null, so the first sighting of a
				// key has nothing stale to clear and needs no extra notification.
				const rotated = this.credential !== null;
				this.clearCredential();
				this.credential = credential;
				if (rotated) this.publish();
			}

			signal = AbortSignal.any([request.signal, (this.options.timeoutSignal ?? AbortSignal.timeout)(TIMEOUT_MS)]);
			signal.throwIfAborted();
			const response = await withAbort(this.fetch(this.options.apiUrl, {
				method: "GET", redirect: "error",
				headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
				signal,
			}), signal);
			if (!this.current(generation)) return this.getState();
			if (!response.ok) {
				void response.body?.cancel().catch(() => {});
				if (response.status === 401 || response.status === 403) {
					this.clearCredential();
					this.fail("auth_error", { kind: "http_auth", httpStatus: response.status });
				} else if (response.status === 429) {
					this.rateLimitUntil = Math.max(this.now() + THROTTLE_MS, parseRetryAfter(response.headers.get("Retry-After"), this.now()) ?? this.now() + BACKOFF_MS);
					this.fail("rate_limited", { kind: "rate_limit", httpStatus: 429 }, this.rateLimitUntil);
				} else {
					this.fail("network_error", { kind: "http", httpStatus: response.status });
				}
				return this.getState();
			}

			let payload: unknown;
			try { payload = await withAbort(response.json(), signal); }
			catch { signal.throwIfAborted(); throw new BalanceDataError(); }
			const snapshot = this.options.parse(payload, this.now());
			if (!this.current(generation)) return this.getState();
			this.failures = 0;
			this.rateLimitUntil = 0;
			this.nextAutomaticAt = (this.state.lastAttemptAt ?? this.now()) + THROTTLE_MS;
			this.state = { ...this.state, phase: "ready", snapshot, lastSuccessAt: snapshot.receivedAt, stale: false, error: null, retryAt: null };
			this.publish();
		} catch (error) {
			if (!this.current(generation) || request.signal.aborted) return this.getState();
			if (signal?.aborted) this.fail("timeout", { kind: "timeout" });
			else if (error instanceof BalanceDataError) this.fail("data_error", { kind: "data" });
			else this.fail("network_error", { kind: "network" });
		}
		return this.getState();
	}
}

export function currencySymbol(currency: string): string {
	if (currency === "CNY") return "¥";
	if (currency === "USD") return "$";
	return `${currency} `;
}

function localTime(timestamp: number | null): string {
	if (timestamp === null) return "未知";
	const date = new Date(timestamp);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function retryRemaining(retryAt: number, now: number): string {
	const seconds = Math.max(0, Math.ceil((retryAt - now) / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.ceil(seconds / 60)}m`;
}

function errorDescription(brand: BalanceBrand<BalanceInfo>, error: BalanceError): string {
	switch (error.kind) {
		case "auth": return `pi 认证解析/续期失败，请重新配置 ${brand.label} 凭据`;
		case "http_auth": return `余额接口拒绝认证（HTTP ${error.httpStatus}），请重新配置 ${brand.label} 凭据`;
		case "rate_limit": return "余额查询被限流（HTTP 429），请等待冷却";
		case "data": return "余额响应格式异常，未显示未经校验的数据";
		case "http": return `余额接口查询失败（HTTP ${error.httpStatus}）`;
		case "network": return "余额查询网络失败，请检查连接或代理";
		case "timeout": return "余额查询超时（10 秒）";
	}
}

export function statusLine<TInfo extends BalanceInfo>(brand: BalanceBrand<TInfo>, state: BalanceState<TInfo>, now: number): { text: string; color: "dim" | "accent" | "success" | "warning" | "error" } {
	void now; // Kept for parity with the Codex status line; balances have no wall-clock window.
	if (state.phase === "offline") return { text: `${brand.icon} ${brand.label} 离线`, color: "dim" };
	if (state.phase === "not_configured") return { text: `${brand.icon} ${brand.label} 未配置`, color: "dim" };
	if (state.phase === "auth_error") return { text: `${brand.icon} ${brand.label} 凭据失效`, color: "warning" };
	const snapshot = state.snapshot;
	if (!snapshot) {
		if (state.phase === "loading") return { text: `${brand.icon} ${brand.label} 查询中…`, color: "accent" };
		const text = state.phase === "rate_limited" ? `${brand.icon} ${brand.label} 查询限流`
			: state.phase === "data_error" ? `${brand.icon} ${brand.label} 数据异常`
			: state.phase === "timeout" ? `${brand.icon} ${brand.label} 查询超时`
			: state.phase === "network_error" ? `${brand.icon} ${brand.label} 查询失败` : `${brand.icon} ${brand.label} 待查询`;
		return { text, color: state.error ? "warning" : "dim" };
	}
	const marker = state.stale ? "[过期]" : state.phase === "loading" ? "[更新中]" : "";
	const body = snapshot.infos.length
		? snapshot.infos.map((info) => brand.amount(info)).join("；")
		: "无余额数据";
	const text = `${brand.icon} ${brand.label}${marker} 余额：${body}${snapshot.isAvailable ? "" : " ⚠"}`;
	const color = state.stale ? "warning" : state.phase === "loading" ? "accent"
		: !snapshot.isAvailable ? "warning" : "success";
	return { text, color };
}

export function detailLines<TInfo extends BalanceInfo>(brand: BalanceBrand<TInfo>, state: BalanceState<TInfo>, now: number): string[] {
	if (state.phase === "offline") return ["离线模式：未解析凭据，未发起余额请求。", "取消 PI_OFFLINE / --offline 后重新启动 pi。"];
	if (state.phase === "not_configured") return [`未配置 ${brand.label} API Key。`, `请在 pi 中执行 /login ${brand.loginCommand} 或设置 ${brand.envVariable}。`];
	const lines: string[] = [];
	if (state.phase === "loading") lines.push("正在刷新…");
	if (state.error) lines.push(errorDescription(brand, state.error));
	if (state.stale) lines.push("以下为过期缓存，不代表当前余额。");
	const snapshot = state.snapshot;
	if (snapshot) {
		if (!snapshot.infos.length) lines.push("服务端未提供余额明细。");
		for (const info of snapshot.infos) {
			lines.push(info.currency);
			lines.push(...brand.detailRows(info));
		}
		lines.push(`状态${brand.statusGap}${snapshot.isAvailable ? "可用" : "不可用"}`);
		lines.push("", `更新：${localTime(state.lastSuccessAt)} · 本机时区`);
	}
	if (state.retryAt !== null && state.retryAt > now) {
		lines.push(`${state.phase === "rate_limited" ? "限流冷却" : "自动重试"}：${retryRemaining(state.retryAt, now)}后`);
	}
	return lines.length ? lines : ["暂无余额数据。"];
}

export function summaryLine<TInfo extends BalanceInfo>(brand: BalanceBrand<TInfo>, state: BalanceState<TInfo>): { text: string; type: "info" | "warning" | "error" } {
	if (state.phase === "offline") return { text: `离线模式：未查询 ${brand.label} 余额`, type: "info" };
	if (state.phase === "not_configured") return { text: `未配置 ${brand.label} API Key`, type: "error" };
	const snapshot = state.snapshot;
	if (!snapshot) {
		return state.error
			? { text: `${brand.label} 余额查询失败：${errorDescription(brand, state.error)}`, type: "error" }
			: { text: `${brand.label} 余额：暂无数据`, type: "info" };
	}
	const parts = snapshot.infos.map((info) => brand.summaryEntry(info));
	const text = `${state.stale ? "[过期] " : ""}${brand.label} 余额：${parts.join("；") || "无"} · ${snapshot.isAvailable ? "可用" : "不可用"}`;
	const warn = state.stale || state.error || (brand.summaryWarnsWhenUnavailable && !snapshot.isAvailable);
	return { text, type: warn ? "warning" : "info" };
}

/** Provider-erased view consumed by the panel and the extension wiring. */
export interface BalanceRuntime {
	readonly id: string;
	readonly title: string;
	readonly accent: RegExp;
	refresh(force?: boolean): Promise<void>;
	state(): BalanceState;
	status(now: number): { text: string; color: "dim" | "accent" | "success" | "warning" | "error" };
	details(now: number): string[];
	summary(): { text: string; type: "info" | "warning" | "error" };
	dispose(): void;
}

/** Binds one provider adapter to a live controller without leaking its balance type. */
export function createBalanceRuntime<TInfo extends BalanceInfo>(options: ControllerOptions<TInfo> & { brand: BalanceBrand<TInfo> }): BalanceRuntime {
	const controller = new BalanceController<TInfo>(options);
	const brand = options.brand;
	return {
		id: brand.id,
		title: `${brand.icon} ${brand.label} 余额`,
		accent: brand.detailAccent,
		refresh: async (force = false) => { await controller.refresh(force); },
		state: () => controller.getState(),
		status: (now) => statusLine(brand, controller.getState(), now),
		details: (now) => detailLines(brand, controller.getState(), now),
		summary: () => summaryLine(brand, controller.getState()),
		dispose: () => controller.dispose(),
	};
}
