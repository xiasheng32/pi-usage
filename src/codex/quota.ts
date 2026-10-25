import { randomUUID } from "node:crypto";

export const PROVIDER = "openai-codex";
export const API_URL = "https://chatgpt.com/backend-api/wham/usage";
export const RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
export const CONSUME_RESET_URL = `${RESET_CREDITS_URL}/consume`;
export const THROTTLE_MS = 30_000;
export const TIMEOUT_MS = 10_000;
export const POLL_MS = 60_000;
const BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 300_000;
const MAX_DATE_MS = 8_640_000_000_000_000;
const JWT_CLAIM = "https://api.openai.com/auth";

export interface QuotaWindow {
	key: "primary_window" | "secondary_window";
	periodSeconds: number | null;
	usedPercent: number;
	remainingPercent: number;
	resetAt: number | null;
}

export interface ResetCredit {
	status: "available" | "used" | "expired" | "pending" | "unknown";
	fullReset: boolean;
	grantedAt: number | null;
	expiresAt: number | null;
	redeemedAt: number | null;
}

export interface ResetCreditsSnapshot {
	availableCount: number | null;
	totalEarnedCount: number | null;
	credits: ResetCredit[] | null;
	receivedAt: number;
}

export interface ResetCreditsState {
	snapshot: ResetCreditsSnapshot | null;
	stale: boolean;
	error: QuotaError | null;
	retryAt: number | null;
}

export interface QuotaSnapshot {
	plan: string | null;
	allowed: boolean | null;
	limitReached: boolean | null;
	windows: QuotaWindow[];
	resetAvailableCount: number | null;
	receivedAt: number;
}

export type QuotaPhase =
	| "idle" | "offline" | "loading" | "ready" | "not_logged_in"
	| "auth_error" | "rate_limited" | "data_error" | "network_error" | "timeout";

export interface QuotaError {
	kind: "auth" | "unsupported_auth" | "invalid_auth" | "http_auth" | "rate_limit" | "data" | "http" | "network" | "timeout";
	httpStatus?: number;
}

export interface QuotaState {
	phase: QuotaPhase;
	snapshot: QuotaSnapshot | null;
	lastAttemptAt: number | null;
	lastSuccessAt: number | null;
	stale: boolean;
	retryAt: number | null;
	error: QuotaError | null;
	resetCredits?: ResetCreditsState;
	resetUse?: { message: string; warning: boolean };
}

export interface ResetButtonState {
	phase: "ready" | "disabled" | "busy";
	enabled: boolean;
	hint: string;
}

/** User-only dialogs; no model-callable consumption tool. */
export interface ResetCreditUI {
	select: (title: string, options: string[]) => Promise<string | undefined>;
	notify: (message: string, type: "info" | "warning") => void;
}

interface PrivateResetCredit {
	id: string;
	index: number;
	card: ResetCredit;
	eligible: boolean;
}

export function parseConsumeResult(payload: unknown): { code: "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed"; windowsReset: number | null } {
	if (!isRecord(payload) || !["reset", "nothing_to_reset", "no_credit", "already_redeemed"].includes(payload.code as string)) throw new QuotaDataError();
	const windowsReset = optionalCount(payload.windows_reset);
	if (payload.windows_reset != null && windowsReset === null) throw new QuotaDataError();
	return { code: payload.code as "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed", windowsReset };
}

/** IDs stay in controller-private memory, never in snapshots or UI values. */
function privateResetCredits(payload: unknown, snapshot: ResetCreditsSnapshot): PrivateResetCredit[] {
	if (!isRecord(payload)) return [];
	const data = isRecord(payload.data) ? payload.data : payload;
	if (!Array.isArray(data.credits)) return [];
	const counts = new Map<string, number>();
	for (const row of data.credits) {
		if (isRecord(row) && typeof row.id === "string") counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
	}
	return data.credits.flatMap((row, index) => {
		const card = snapshot.credits?.[index];
		if (!isRecord(row) || !card || typeof row.id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(row.id) || counts.get(row.id) !== 1) return [];
		return [{ id: row.id, index, card, eligible: card.fullReset && card.status === "available"
			&& (row.expires_at == null || card.expiresAt !== null)
			&& (row.granted_at == null || card.grantedAt !== null)
			&& (row.redeemed_at == null || card.redeemedAt !== null) }];
	});
}

/** Only request-time auth; never read or retain a refresh token. */
export interface ProviderAuth {
	auth: { apiKey?: string };
	source?: string;
}

export interface ControllerOptions {
	resolveAuth: () => Promise<ProviderAuth | undefined>;
	fetch?: typeof globalThis.fetch;
	now?: () => number;
	timeoutSignal?: (milliseconds: number) => AbortSignal;
	onChange?: (state: QuotaState) => void;
	offline?: boolean;
}

class QuotaDataError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveSeconds(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value * 1000 <= MAX_DATE_MS;
}

function optionalBoolean(value: unknown): boolean | null {
	if (value == null) return null;
	if (typeof value !== "boolean") throw new QuotaDataError();
	return value;
}

export function isOffline(value: string | undefined): boolean {
	return /^(1|true|yes)$/i.test(value?.trim() ?? "");
}

/** Decode a host-issued token for routing, not for signature verification. */
export function extractAccountId(token: string): string | undefined {
	try {
		const parts = token.split(".");
		if (parts.length !== 3 || !parts.every(Boolean) || parts[1].length > 16_384) return undefined;
		if (!/^[A-Za-z0-9_-]+={0,2}$/.test(parts[1])) return undefined;
		const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		const claim = isRecord(payload) ? payload[JWT_CLAIM] : undefined;
		const accountId = isRecord(claim) ? claim.chatgpt_account_id : undefined;
		// Routing header values must not contain whitespace/control characters.
		return typeof accountId === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(accountId) ? accountId : undefined;
	} catch {
		return undefined;
	}
}

function optionalCount(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function creditDate(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
	if (!match) return null;
	const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	// Validate components directly: Date.parse normalizes invalid days, and Date.UTC remaps years 00–99.
	if (month < 1 || month > 12 || day < 1 || day > days[month - 1]
		|| hour > 23 || minute > 59 || second > 59
		|| Number(match[7] ?? 0) > 23 || Number(match[8] ?? 0) > 59) return null;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : null;
}

/** Keep only known metadata, never IDs, names, descriptions or raw responses. */
export function parseResetCredits(payload: unknown, receivedAt: number): ResetCreditsSnapshot {
	if (!isRecord(payload)) throw new QuotaDataError();
	const data = isRecord(payload.data) ? payload.data : payload;
	const availableCount = optionalCount(data.available_count);
	const totalEarnedCount = optionalCount(data.total_earned_count);
	if (data.available_count != null && availableCount === null) throw new QuotaDataError();
	if (data.credits != null && (!Array.isArray(data.credits) || data.credits.length > 1000)) throw new QuotaDataError();
	const credits: ResetCredit[] | null = Array.isArray(data.credits) ? data.credits.map((row) => {
		if (!isRecord(row)) throw new QuotaDataError();
		const status = row.status === "available" ? "available"
			: ["redeemed", "consumed", "used"].includes(row.status as string) ? "used"
			: row.status === "expired" ? "expired"
			: ["pending", "redeeming", "redeem_started"].includes(row.status as string) ? "pending" : "unknown";
		return {
			status, fullReset: row.reset_type === "codex_rate_limits",
			grantedAt: creditDate(row.granted_at), expiresAt: creditDate(row.expires_at), redeemedAt: creditDate(row.redeemed_at),
		};
	}) : null;
	if (availableCount === null && credits === null) throw new QuotaDataError();
	return { availableCount, totalEarnedCount, credits, receivedAt };
}

export function parseQuota(payload: unknown, receivedAt: number): QuotaSnapshot {
	if (!isRecord(payload)) throw new QuotaDataError();
	const plan = typeof payload.plan_type === "string" && /^[a-zA-Z0-9_+-]{1,64}$/.test(payload.plan_type)
		? payload.plan_type : null;
	if (!("rate_limit" in payload) && !plan) throw new QuotaDataError();

	const limits = payload.rate_limit;
	if (limits != null && !isRecord(limits)) throw new QuotaDataError();
	const windows: QuotaWindow[] = [];
	for (const key of ["primary_window", "secondary_window"] as const) {
		const window = limits?.[key];
		if (window == null) continue;
		if (!isRecord(window) || typeof window.used_percent !== "number" || !Number.isFinite(window.used_percent) || window.used_percent < 0) {
			throw new QuotaDataError();
		}
		let resetAt: number | null = null;
		if (positiveSeconds(window.reset_at)) {
			resetAt = window.reset_at * 1000;
		} else if (window.reset_at == null && typeof window.reset_after_seconds === "number"
			&& Number.isSafeInteger(window.reset_after_seconds) && window.reset_after_seconds >= 0) {
			const candidate = receivedAt + window.reset_after_seconds * 1000;
			if (Number.isSafeInteger(candidate) && candidate <= MAX_DATE_MS) resetAt = candidate;
		}
		const usedPercent = Math.min(100, window.used_percent);
		windows.push({
			key,
			periodSeconds: positiveSeconds(window.limit_window_seconds) ? window.limit_window_seconds : null,
			usedPercent,
			remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent)),
			resetAt,
		});
	}
	return {
		plan,
		allowed: optionalBoolean(limits?.allowed),
		limitReached: optionalBoolean(limits?.limit_reached),
		windows,
		resetAvailableCount: isRecord(payload.rate_limit_reset_credits) ? optionalCount(payload.rate_limit_reset_credits.available_count) : null,
		receivedAt,
	};
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

/** Per-extension instance, with an injectable transport for entirely offline tests. */
export class QuotaController {
	private readonly options: ControllerOptions;
	private readonly now: () => number;
	private readonly fetch: typeof globalThis.fetch;
	private state: QuotaState;
	private inflight: Promise<QuotaState> | null = null;
	private request: AbortController | null = null;
	private accountId: string | null = null;
	private generation = 0;
	private disposed = false;
	private failures = 0;
	private nextAutomaticAt = 0;
	private rateLimitUntil = 0;
	private resetRetryAt = 0;
	private resetRateLimitUntil = 0;
	private creditRows: PrivateResetCredit[] = [];
	private cardsRevision = 0;
	private accountEpoch = 0;
	private resetFlow: AbortController | null = null;
	private consumeRateLimitUntil = 0;
	// Account-scoped locks survive switching away and back, but not disposal/reload.
	private blockedCredits = new Map<string, Set<string>>();

	constructor(options: ControllerOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
		this.fetch = options.fetch ?? globalThis.fetch;
		this.state = {
			phase: options.offline ? "offline" : "idle",
			snapshot: null, lastAttemptAt: null, lastSuccessAt: null,
			stale: false, retryAt: null, error: null,
			resetCredits: { snapshot: null, stale: false, error: null, retryAt: null },
		};
	}

	getState(): QuotaState {
		return {
			...this.state,
			error: this.state.error ? { ...this.state.error } : null,
			resetUse: this.state.resetUse ? { ...this.state.resetUse } : undefined,
			resetCredits: this.state.resetCredits ? {
				...this.state.resetCredits,
				error: this.state.resetCredits.error ? { ...this.state.resetCredits.error } : null,
				snapshot: this.state.resetCredits.snapshot ? {
					...this.state.resetCredits.snapshot,
					credits: this.state.resetCredits.snapshot.credits?.map((credit) => ({ ...credit })) ?? null,
				} : null,
			} : undefined,
			snapshot: this.state.snapshot ? {
				...this.state.snapshot,
				windows: this.state.snapshot.windows.map((window) => ({ ...window })),
			} : null,
		};
	}

	/** Presentation only: never resolves auth or sends a request. */
	getResetButton(): ResetButtonState {
		const disabled = (hint: string): ResetButtonState => ({ phase: "disabled", enabled: false, hint });
		if (this.disposed) return disabled("会话已结束");
		if (this.options.offline) return disabled("离线模式，不能使用重置卡");
		if (this.resetFlow) return { phase: "busy", enabled: false, hint: "正在处理，请勿重复操作" };
		if (this.now() < Math.max(this.rateLimitUntil, this.resetRateLimitUntil, this.consumeRateLimitUntil)) return disabled("限流冷却中，请稍后刷新");
		if (this.state.phase === "loading") return disabled("正在查询额度与卡片…");
		if (!this.accountId) return disabled(this.state.phase === "idle" ? "尚未获取卡片明细" : "请先 /login openai-codex");
		if (this.state.phase !== "ready" || this.state.stale || this.state.resetCredits?.stale || this.state.resetCredits?.error
			|| !this.state.resetCredits?.snapshot) return disabled("数据不可用，请先刷新明细");
		const count = this.creditRows.filter((row) => this.canUse(row, this.accountId!)).length;
		if (!count) return disabled("无可用卡，或卡片已到期 / 结果未决");
		return { phase: "ready", enabled: true, hint: `可选 ${count} 张 · 选卡后确认，不会自动消费` };
	}

	refresh(force = false): Promise<QuotaState> {
		if (this.resetFlow) return Promise.resolve(this.getState());
		return this.refreshUnlocked(force);
	}

	private refreshUnlocked(force = false): Promise<QuotaState> {
		if (this.disposed) return Promise.resolve(this.getState());
		if (this.options.offline) {
			this.publish();
			return Promise.resolve(this.getState());
		}
		if (this.inflight) return this.inflight;
		const generation = ++this.generation;
		const request = new AbortController();
		this.request = request;
		this.inflight = Promise.resolve().then(() => this.performRefresh(generation, request, force)).finally(() => {
			if (this.request === request) {
				this.request = null;
				this.inflight = null;
			}
		});
		return this.inflight;
	}

	/** Called only after the detail panel yields its u action. Entire flow is single-flight. */
	async useResetCredit(ui?: ResetCreditUI): Promise<void> {
		if (!ui || this.disposed) return;
		if (this.options.offline) { ui.notify("离线模式：不会查询或使用重置卡。", "warning"); return; }
		if (this.resetFlow) { ui.notify("重置卡操作正在进行，请勿重复触发。", "warning"); return; }
		const flow = new AbortController();
		this.resetFlow = flow;
		try {
			if (this.inflight) await withAbort(this.inflight, flow.signal);
			if (!await this.freshForReset(flow)) {
				if (!this.disposed) ui.notify("无法获取新鲜额度与卡片明细；请检查登录、网络或限流冷却。未使用重置卡。", "warning");
				return;
			}
			const epoch = this.accountEpoch;
			const account = this.accountId!;
			const choices = this.creditRows.filter((row) => this.canUse(row, account));
			if (!choices.length) {
				ui.notify("没有可安全使用的重置卡（可能已到期、结果未决或明细不完整）。", "warning");
				return;
			}
			const labels = choices.map((row) => `#${row.index + 1} 完全重置（7d + 5h） · 到期：${localTime(row.card.expiresAt)}`);
			const selection = await withAbort(ui.select("选择一张重置卡（Esc 取消）", labels), flow.signal);
			if (!this.flowCurrent(flow, epoch)) return;
			const selected = choices[labels.indexOf(selection ?? "")];
			if (!selected) return;
			const confirm = "确认使用这张卡";
			const quota = this.state.snapshot!.windows.map((window) => `${windowLabel(window)} 剩${percentage(window.remainingPercent)}%`).join(" · ") || "额度未知";
			const answer = await withAbort(ui.select(`使用 ${labels[choices.indexOf(selected)]}？\n当前：${quota}\n会消耗一张卡，不可撤销；不会自动重试。`, ["取消", confirm]), flow.signal);
			if (!this.flowCurrent(flow, epoch) || answer !== confirm) return;
			// Re-read auth AND card state after confirmation. Never replace the selected ID.
			if (!await this.freshForReset(flow) || !this.flowCurrent(flow, epoch)) {
				if (!this.disposed) ui.notify("账号或明细已变化/查询失败，已取消；请重新选择。未使用重置卡。", "warning");
				return;
			}
			const current = this.creditRows.find((row) => row.id === selected.id);
			if (!current || !this.canUse(current, account)) {
				ui.notify("所选卡片已失效或状态变化，未使用重置卡。", "warning"); return;
			}
			await this.consumeSelected(current, account, epoch, flow, ui);
		} catch {
			if (!this.disposed && !flow.signal.aborted) ui.notify("重置卡操作未完成；未自动重试，请刷新并核对官方用量页。", "warning");
		} finally {
			if (this.resetFlow === flow) this.resetFlow = null;
		}
	}

	private flowCurrent(flow: AbortController, epoch: number): boolean {
		return !this.disposed && !flow.signal.aborted && this.resetFlow === flow && this.accountEpoch === epoch;
	}

	private canUse(row: PrivateResetCredit, account: string): boolean {
		return row.eligible && (row.card.expiresAt === null || row.card.expiresAt > this.now())
			&& !this.blockedCredits.get(account)?.has(row.id);
	}

	private async freshForReset(flow: AbortController): Promise<boolean> {
		if (this.disposed || flow.signal.aborted || this.now() < this.rateLimitUntil || this.now() < this.resetRateLimitUntil
			|| this.now() < this.consumeRateLimitUntil) return false;
		const revision = this.cardsRevision;
		await withAbort(this.refreshUnlocked(true), flow.signal);
		return !this.disposed && !flow.signal.aborted && this.cardsRevision > revision
			&& this.state.phase === "ready" && !this.state.stale && !this.state.resetCredits?.stale
			&& !this.state.resetCredits?.error && this.accountId !== null;
	}

	private async consumeSelected(row: PrivateResetCredit, account: string, epoch: number, flow: AbortController, ui: ResetCreditUI): Promise<void> {
		let sent = false;
		let message = "消费结果不确定；不会重发，请核对官方用量页。";
		let warning = true;
		let sync = false;
		const blocked = this.blockedCredits.get(account) ?? new Set<string>();
		this.blockedCredits.set(account, blocked);
		try {
			const auth = await withAbort(this.options.resolveAuth(), flow.signal);
			if (!this.flowCurrent(flow, epoch)) return;
			const token = auth?.auth?.apiKey;
			if (auth?.source !== "OAuth" || !token || extractAccountId(token) !== account) {
				this.clearAccount();
				this.fail("auth_error", { kind: "auth" });
				ui.notify("登录或账号已变化，未使用重置卡；请重新登录/选择。", "warning"); return;
			}
			if (!this.canUse(row, account) || this.now() < this.consumeRateLimitUntil) {
				ui.notify("卡片已到期、结果未决或正在冷却，未使用重置卡。", "warning"); return;
			}
			const signal = AbortSignal.any([flow.signal, (this.options.timeoutSignal ?? AbortSignal.timeout)(TIMEOUT_MS)]);
			signal.throwIfAborted();
			const body = JSON.stringify({ redeem_request_id: randomUUID(), credit_id: row.id });
			blocked.add(row.id); // Before dispatch: any ambiguous result must stay locked.
			sent = true;
			this.state.resetUse = { message: "正在使用重置卡…", warning: false };
			this.markResetStale();
			this.publish();
			const response = await withAbort(this.fetch(CONSUME_RESET_URL, {
				method: "POST", redirect: "error", signal,
				headers: { Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": account, Accept: "application/json", "Content-Type": "application/json" }, body,
			}), signal);
			if (!this.flowCurrent(flow, epoch)) return;
			if (!response.ok) {
				void response.body?.cancel().catch(() => {});
				if (response.status >= 400 && response.status < 500 && response.status !== 408) {
					blocked.delete(row.id);
					message = `消费请求被拒绝（HTTP ${response.status}），不会自动重试。`;
					if (response.status === 429) this.consumeRateLimitUntil = Math.max(this.now() + THROTTLE_MS,
						parseRetryAfter(response.headers.get("Retry-After"), this.now()) ?? this.now() + BACKOFF_MS);
					if (response.status === 401 || response.status === 403) {
						this.clearAccount();
						this.fail("auth_error", { kind: "http_auth", httpStatus: response.status });
						ui.notify(`${message} 请重新 /login openai-codex。`, "warning"); return;
					}
				}
			} else {
				const result = parseConsumeResult(await withAbort(response.json(), signal));
				if (!this.flowCurrent(flow, epoch)) return;
				if (result.code === "reset") {
					message = `服务端确认重置成功${result.windowsReset === null ? "" : `（${result.windowsReset} 个窗口）`}。`;
					warning = false;
				} else if (result.code === "nothing_to_reset") {
					blocked.delete(row.id); message = "服务端返回无需重置（nothing_to_reset），未确认重置成功。";
				} else if (result.code === "no_credit") {
					blocked.delete(row.id); message = "服务端返回无可用重置卡（no_credit）。";
				} else message = "服务端返回卡片已兑换（already_redeemed），不代表此次又成功重置。";
			}
		} catch {
			if (!sent) {
				if (!this.flowCurrent(flow, epoch)) return;
				this.clearAccount();
				this.fail("auth_error", { kind: "auth" });
				ui.notify("消费前认证或准备失败，未发送消费请求。", "warning"); return;
			}
			// Never echo exception/body or retry an ambiguous POST.
		}
		if (!this.flowCurrent(flow, epoch)) return;
		if (sent) {
			this.markResetStale();
			// Consumption cooldown blocks more consumption, not read-only reconciliation.
			const revision = this.cardsRevision;
			await withAbort(this.refreshUnlocked(true), flow.signal);
			if (!this.flowCurrent(flow, epoch)) return;
			sync = this.cardsRevision > revision && this.state.phase === "ready" && !this.state.stale
				&& !this.state.resetCredits?.stale && !this.state.resetCredits?.error;
		}
		this.state.resetUse = { message: `${message}${sync ? " 已重新查询额度与卡片。" : " 数据同步未完成，缓存不是当前额度。"}`, warning: warning || !sync };
		this.publish();
		ui.notify(this.state.resetUse.message, this.state.resetUse.warning ? "warning" : "info");
	}

	private markResetStale(): void {
		this.state.stale = this.state.snapshot !== null;
		if (this.state.resetCredits) this.state.resetCredits.stale = this.state.resetCredits.snapshot !== null;
	}

	/** Cancel this session's work without losing consumption locks or HTTP cooldowns. */
	suspend(): void {
		if (this.disposed) return;
		this.generation++;
		this.request?.abort();
		this.resetFlow?.abort();
		this.request = null;
		this.inflight = null;
		this.resetFlow = null;
		this.clearAccount();
		this.state = { ...this.state, phase: "idle", error: null, retryAt: null };
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.generation++;
		this.request?.abort();
		this.resetFlow?.abort();
		this.creditRows = [];
		this.blockedCredits.clear();
		this.accountEpoch++;
		this.accountId = null;
		this.state = { ...this.state, phase: "idle", snapshot: null, lastSuccessAt: null, stale: false, error: null, retryAt: null, resetUse: undefined, resetCredits: { snapshot: null, stale: false, error: null, retryAt: null } };
	}

	private current(generation: number): boolean {
		return !this.disposed && generation === this.generation;
	}

	private publish(): void {
		if (this.disposed) return;
		// A UI callback must not turn background polling into an unhandled rejection.
		try { this.options.onChange?.(this.getState()); } catch { /* UI may be tearing down. */ }
	}

	private clearAccount(): void {
		this.accountEpoch++;
		this.creditRows = [];
		this.accountId = null;
		this.resetRetryAt = 0;
		// HTTP 429 cooldowns survive identity changes and suspension.
		this.state = { ...this.state, snapshot: null, lastSuccessAt: null, stale: false, resetUse: undefined, resetCredits: { snapshot: null, stale: false, error: null, retryAt: null } };
	}

	private fail(phase: QuotaPhase, error: QuotaError, retryAt?: number): void {
		const now = this.now();
		const delay = Math.min(MAX_BACKOFF_MS, BACKOFF_MS * 2 ** Math.min(this.failures++, 3));
		const next = retryAt ?? now + delay;
		this.nextAutomaticAt = Math.max(now + THROTTLE_MS, next);
		this.state = {
			...this.state, phase, error,
			stale: this.state.snapshot !== null,
			resetCredits: this.state.resetCredits ? { ...this.state.resetCredits, stale: this.state.resetCredits.snapshot !== null } : undefined,
			retryAt: this.nextAutomaticAt,
		};
		this.publish();
	}

	private async fetchResetCredits(token: string, accountId: string, generation: number, request: AbortController, force: boolean): Promise<void> {
		if (this.now() < this.resetRateLimitUntil || (!force && this.now() < this.resetRetryAt)) return;
		let signal: AbortSignal | undefined;
		const fail = (error: QuotaError, retryAt = this.now() + BACKOFF_MS) => {
			this.resetRetryAt = retryAt;
			this.state.resetCredits = { snapshot: this.state.resetCredits?.snapshot ?? null, stale: !!this.state.resetCredits?.snapshot, error, retryAt };
		};
		try {
			signal = AbortSignal.any([request.signal, (this.options.timeoutSignal ?? AbortSignal.timeout)(TIMEOUT_MS)]);
			signal.throwIfAborted();
			const response = await withAbort(this.fetch(RESET_CREDITS_URL, {
				method: "GET", redirect: "error",
				headers: { Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": accountId, Accept: "application/json" }, signal,
			}), signal);
			if (!this.current(generation)) return;
			if (!response.ok) {
				void response.body?.cancel().catch(() => {});
				if (response.status === 401 || response.status === 403) {
					this.clearAccount();
					this.fail("auth_error", { kind: "http_auth", httpStatus: response.status });
				} else if (response.status === 429) {
					this.resetRateLimitUntil = Math.max(this.now() + THROTTLE_MS, parseRetryAfter(response.headers.get("Retry-After"), this.now()) ?? this.now() + BACKOFF_MS);
					fail({ kind: "rate_limit", httpStatus: 429 }, this.resetRateLimitUntil);
				} else fail({ kind: "http", httpStatus: response.status });
				return;
			}
			let payload: unknown;
			try { payload = await withAbort(response.json(), signal); }
			catch { signal.throwIfAborted(); throw new QuotaDataError(); }
			const snapshot = parseResetCredits(payload, this.now());
			if (!this.current(generation)) return;
			this.creditRows = privateResetCredits(payload, snapshot);
			this.cardsRevision++;
			this.resetRetryAt = 0;
			this.resetRateLimitUntil = 0;
			this.state.resetCredits = { snapshot, stale: false, error: null, retryAt: null };
		} catch (error) {
			if (!this.current(generation) || request.signal.aborted) return;
			fail({ kind: signal?.aborted ? "timeout" : error instanceof QuotaDataError ? "data" : "network" });
		}
	}

	private async performRefresh(generation: number, request: AbortController, force: boolean): Promise<QuotaState> {
		let quotaSignal: AbortSignal | undefined;
		try {
			let auth: ProviderAuth | undefined;
			try {
				request.signal.throwIfAborted();
				auth = await withAbort(this.options.resolveAuth(), request.signal);
			} catch {
				if (!this.current(generation) || request.signal.aborted) return this.getState();
				this.clearAccount();
				this.state = { ...this.state, phase: "auth_error", error: { kind: "auth" } };
				this.publish();
				return this.getState();
			}
			if (!this.current(generation)) return this.getState();
			if (!auth) {
				this.clearAccount();
				this.state = { ...this.state, phase: "not_logged_in", error: null, retryAt: null };
				this.publish();
				return this.getState();
			}
			const token = auth.auth?.apiKey;
			const accountId = token && extractAccountId(token);
			if (auth.source !== "OAuth" || !accountId) {
				this.clearAccount();
				this.state = { ...this.state, phase: "auth_error", error: { kind: auth.source !== "OAuth" ? "unsupported_auth" : "invalid_auth" } };
				this.publish();
				return this.getState();
			}
			if (this.accountId !== accountId) {
				this.clearAccount();
				this.accountId = accountId;
				const limited = this.now() < this.rateLimitUntil;
				this.state = { ...this.state, phase: limited ? "rate_limited" : "idle",
					error: limited ? { kind: "rate_limit", httpStatus: 429 } : null,
					retryAt: limited ? this.rateLimitUntil : this.now() < this.nextAutomaticAt ? this.nextAutomaticAt : null };
				this.publish();
			}

			// Auth is single-flight even during cooldown; only HTTP attempts affect timing/loading.
			const now = this.now();
			if (now < this.rateLimitUntil || (!force && (now < this.nextAutomaticAt
				|| (this.state.lastAttemptAt !== null && now - this.state.lastAttemptAt < THROTTLE_MS)))) return this.getState();
			this.state = { ...this.state, phase: "loading", lastAttemptAt: now, error: null };
			this.publish();
			const timeout = (this.options.timeoutSignal ?? AbortSignal.timeout)(TIMEOUT_MS);
			quotaSignal = AbortSignal.any([request.signal, timeout]);
			quotaSignal.throwIfAborted();
			const response = await withAbort(this.fetch(API_URL, {
				method: "GET", redirect: "error",
				headers: { Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": accountId, Accept: "application/json" },
				signal: quotaSignal,
			}), quotaSignal);
			if (!this.current(generation)) return this.getState();
			if (!response.ok) {
				void response.body?.cancel().catch(() => {});
				if (response.status === 401 || response.status === 403) {
					this.clearAccount();
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
			try { payload = await withAbort(response.json(), quotaSignal); }
			catch {
				quotaSignal.throwIfAborted();
				throw new QuotaDataError();
			}
			const snapshot = parseQuota(payload, this.now());
			if (!this.current(generation)) return this.getState();
			this.failures = 0;
			this.rateLimitUntil = 0;
			this.nextAutomaticAt = (this.state.lastAttemptAt ?? this.now()) + THROTTLE_MS;
			this.state = { ...this.state, phase: "ready", snapshot, lastSuccessAt: snapshot.receivedAt, stale: false, error: null, retryAt: null };
			this.publish();
			await this.fetchResetCredits(token!, accountId, generation, request, force);
			if (this.current(generation)) this.publish();
		} catch (error) {
			if (!this.current(generation) || request.signal.aborted) return this.getState();
			if (quotaSignal?.aborted) this.fail("timeout", { kind: "timeout" });
			else if (error instanceof QuotaDataError) this.fail("data_error", { kind: "data" });
			else this.fail("network_error", { kind: "network" });
		}
		return this.getState();
	}
}

export function windowLabel(window: QuotaWindow): string {
	const seconds = window.periodSeconds;
	if (seconds === null) return window.key === "primary_window" ? "主窗口" : "次窗口";
	let remaining = seconds;
	let label = "";
	for (const [unit, suffix] of [[86400, "d"], [3600, "h"], [60, "m"], [1, "s"]] as const) {
		const count = Math.floor(remaining / unit);
		remaining %= unit;
		if (count) label += `${count}${suffix}`;
	}
	return label;
}

function percentage(value: number): string {
	return value > 0 && value < 1 ? "<1" : `${Math.round(value * 10) / 10}`;
}

export function resetRemaining(resetAt: number | null, now: number): string {
	if (resetAt === null) return "未知";
	if (resetAt <= now) return "待刷新";
	const minutes = Math.ceil((resetAt - now) / 60_000);
	if (minutes < 60) return `${minutes}m`;
	if (minutes < 1440) return `${Math.floor(minutes / 60)}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
	return `${Math.floor(minutes / 1440)}d${Math.floor(minutes % 1440 / 60) ? `${Math.floor(minutes % 1440 / 60)}h` : ""}`;
}

function errorDescription(error: QuotaError): string {
	switch (error.kind) {
		case "unsupported_auth": return "仅支持 pi 的 openai-codex OAuth 登录，不支持 API key";
		case "invalid_auth": return "登录凭据缺少有效账号信息，请重新 /login openai-codex";
		case "auth": return "pi 认证解析/续期失败，请重新 /login openai-codex";
		case "http_auth": return `额度接口拒绝认证（HTTP ${error.httpStatus}），请重新 /login openai-codex`;
		case "rate_limit": return "额度查询被限流（HTTP 429），请等待冷却";
		case "data": return "额度响应格式异常，未推断剩余比例";
		case "http": return `额度接口查询失败（HTTP ${error.httpStatus}）`;
		case "network": return "额度查询网络失败，请检查连接或代理";
		case "timeout": return "额度查询超时（10 秒）";
	}
}

function availableResets(state: QuotaState): { count: number | null; stale: boolean } {
	const reset = state.resetCredits;
	if (reset?.snapshot && !reset.stale && reset.snapshot.availableCount !== null) {
		return { count: reset.snapshot.availableCount, stale: state.stale };
	}
	if (state.snapshot?.resetAvailableCount != null) return { count: state.snapshot.resetAvailableCount, stale: state.stale };
	return { count: reset?.snapshot?.availableCount ?? null, stale: !!reset?.stale || state.stale };
}

export function statusLine(state: QuotaState, now: number): { text: string; color: "dim" | "accent" | "success" | "warning" | "error" } {
	if (state.phase === "offline") return { text: "Codex 离线", color: "dim" };
	if (state.phase === "not_logged_in") return { text: "Codex 未登录", color: "dim" };
	if (state.phase === "auth_error") return { text: state.error?.kind === "unsupported_auth" ? "Codex 需 OAuth 登录" : "Codex 登录失效", color: "warning" };
	const snapshot = state.snapshot;
	if (!snapshot) {
		if (state.phase === "loading") return { text: "Codex 查询中…", color: "accent" };
		const text = state.phase === "rate_limited" ? "Codex 查询限流"
			: state.phase === "data_error" ? "Codex 数据异常"
			: state.phase === "timeout" ? "Codex 查询超时"
			: state.phase === "network_error" ? "Codex 查询失败" : "Codex 待查询";
		return { text, color: state.error ? "warning" : "dim" };
	}
	const marker = state.stale ? "[过期]" : state.phase === "loading" ? "[更新中]" : "";
	const windows = snapshot.windows.map((window) => `${windowLabel(window)} ${percentage(window.remainingPercent)}% (↻${resetRemaining(window.resetAt, now)})`);
	const restricted = snapshot.allowed === false || snapshot.limitReached === true;
	const expired = snapshot.windows.some((window) => window.resetAt !== null && window.resetAt <= now);
	const minimum = Math.min(...snapshot.windows.map((window) => window.remainingPercent));
	const text = `🍧 Codex${marker} 额度：${windows.join(" ") || "暂无主额度数据"}${restricted ? " | 受限" : ""}`;
	const color = state.stale || expired ? "warning" : state.phase === "loading" ? "accent"
		: restricted || minimum === 0 ? "error" : minimum <= 10 ? "warning" : windows.length ? "success" : "dim";
	return { text, color };
}

function localTime(timestamp: number | null): string {
	if (timestamp === null) return "未知";
	const date = new Date(timestamp);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function isLowQuota(remainingPercent: number): boolean {
	return remainingPercent <= 20;
}

export function quotaBar(remaining: number, width = 20): string {
	const columns = Math.max(1, Math.min(30, Math.floor(width)));
	const filled = Math.max(0, Math.min(columns, Math.round(remaining / 100 * columns)));
	return "█".repeat(filled) + "░".repeat(columns - filled);
}

export interface QuotaDetailSections {
	summary: string | null;
	status: string[];
	quota: string[];
	resetSummary: string;
	resets: string[];
	updated: string;
}

/** Presentation only. Keep section boundaries independent of translated labels. */
export function detailSections(state: QuotaState, now: number, barWidth = 20, formatQuota?: (line: string, window: QuotaWindow) => string): QuotaDetailSections {
	const sections: QuotaDetailSections = {
		summary: null, status: [], quota: [], resetSummary: "可用 未知", resets: [],
		updated: `更新于 ${state.lastSuccessAt === null ? "未知" : localTime(state.lastSuccessAt).slice(-5)} · 本机时区`,
	};
	if (state.phase === "offline") {
		sections.status.push("离线模式：未解析认证，未发起额度请求。", "取消 PI_OFFLINE / --offline 后重新启动 pi。");
		return sections;
	}
	if (state.phase === "not_logged_in") {
		sections.status.push("尚未登录 openai-codex。", "请在 pi 中执行 /login openai-codex。");
		return sections;
	}
	if (state.phase === "loading") sections.status.push("正在刷新…");
	if (state.error) sections.status.push(errorDescription(state.error));
	if (state.stale) sections.status.push("以下为过期缓存，不代表当前剩余额度。");
	if (state.retryAt !== null && state.retryAt > now) sections.status.push(`${state.phase === "rate_limited" ? "限流冷却" : "自动重试"}：${resetRemaining(state.retryAt, now)}后`);
	const snapshot = state.snapshot;
	if (snapshot) {
		sections.summary = `${snapshot.plan?.toUpperCase() ?? "未知套餐"}  ·  ${snapshot.allowed === false || snapshot.limitReached === true ? "受限" : snapshot.allowed === true ? "可用" : "状态未知"}`;
		if (!snapshot.windows.length) sections.quota.push("服务端未提供主额度窗口（不等于 0% 或无限额度）。");
		for (const window of snapshot.windows) {
			const line = `${windowLabel(window)}  ${quotaBar(window.remainingPercent, barWidth)}  剩${percentage(window.remainingPercent)}% · 已用${percentage(window.usedPercent)}%`;
			sections.quota.push(formatQuota ? formatQuota(line, window) : line);
			const countdown = resetRemaining(window.resetAt, now);
			sections.quota.push(`  ↻ ${countdown}${window.resetAt !== null && window.resetAt > now ? " 后重置" : ""} · ${localTime(window.resetAt)}`);
		}
	} else if (!sections.status.length) sections.status.push("暂无额度数据。");
	const resets = availableResets(state);
	sections.resetSummary = `可用 ${resets.count === null ? "未知" : `${resets.count} 张`}${resets.stale ? " [过期缓存]" : ""}`;
	const lines = sections.resets;
	if (state.resetUse) lines.push(state.resetUse.message);
	const reset = state.resetCredits;
	if (reset?.error) {
		const message = reset.error.kind === "rate_limit" ? "查询限流" : reset.error.kind === "data" ? "响应格式异常" : reset.error.kind === "timeout" ? "查询超时" : "查询失败";
		lines.push(`  ${message}${reset.error.httpStatus ? `（HTTP ${reset.error.httpStatus}）` : ""}；${reset.snapshot ? "明细为过期缓存" : "明细暂不可用"}`);
	}
	const cards = reset?.snapshot?.credits;
	if (cards) {
		if (!cards.length) lines.push("  暂无卡片记录");
		const labels = { available: "可用", used: "已使用", expired: "已过期", pending: "使用中", unknown: "状态未知" };
		cards.forEach((card, index) => {
			lines.push(`  #${index + 1} ${card.fullReset ? "完全重置（7d + 5h）" : "重置卡"} · ${labels[card.status]}`);
			if (card.status === "used") lines.push(`     使用：${localTime(card.redeemedAt)}`);
			else {
				const expires = card.expiresAt === null ? "有效期未知" : `${localTime(card.expiresAt)}${card.status === "available" ? ` · ${card.expiresAt <= now ? "已到期，待刷新" : `${resetRemaining(card.expiresAt, now)}后到期`}` : ""}`;
				lines.push(`     到期：${expires}`);
			}
		});
		lines.push("  仅显示接口返回记录，不推断完整历史。");
	} else lines.push("  未提供使用记录 / 有效期明细");
	if (reset?.retryAt != null && reset.retryAt > now) lines.push(`  重置卡重试：${resetRemaining(reset.retryAt, now)}后`);
	return sections;
}

/** Flat details remain available to non-TUI consumers. */
export function detailLines(state: QuotaState, now: number, barWidth = 20, formatQuota?: (line: string, window: QuotaWindow) => string): string[] {
	const sections = detailSections(state, now, barWidth, formatQuota);
	if (state.phase === "offline" || state.phase === "not_logged_in") return sections.status;
	return [
		...sections.status,
		...(sections.summary === null ? [] : [sections.summary, "", "▸ 订阅额度", ...sections.quota]),
		"", `▸ 重置卡  ·  ${sections.resetSummary}`, ...sections.resets,
		...(sections.summary === null ? [] : ["", `更新：${localTime(state.lastSuccessAt)} · 本机时区`]),
	];
}
