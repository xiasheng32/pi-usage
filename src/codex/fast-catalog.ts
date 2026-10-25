import { createHash } from "node:crypto";
import { extractAccountId } from "./quota.ts";
import type { ProviderAuth } from "./quota.ts";
import { isCodexSubscription } from "./fast-mode.ts";
import type { FastCapability, FastModel } from "./fast-mode.ts";

const FAST_CATALOG_TTL = 5 * 60_000;
const FAST_CATALOG_BACKOFF = 30_000;
const FAST_CATALOG_MAX_BYTES = 8 * 1024 * 1024;

function catalogRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function parseFastCatalog(payload: unknown): ReadonlyMap<string, FastCapability> {
	const data = catalogRecord(payload);
	if (!Array.isArray(data?.models)) throw new Error("Invalid model directory");
	const models = new Map<string, FastCapability>();
	for (const row of data.models) {
		const item = catalogRecord(row);
		if (!item || typeof item.slug !== "string" || !item.slug.trim() || models.has(item.slug)) throw new Error("Invalid model ID");
		const tiers = item.service_tiers;
		const legacy = item.additional_speed_tiers;
		if (tiers !== undefined && (!Array.isArray(tiers) || tiers.some((tier) => typeof catalogRecord(tier)?.id !== "string"))) throw new Error("Invalid tiers");
		if (legacy !== undefined && (!Array.isArray(legacy) || legacy.some((tier) => typeof tier !== "string"))) throw new Error("Invalid legacy tiers");
		models.set(item.slug, tiers === undefined && legacy === undefined ? { kind: "unknown", reason: "模型目录未提供 Fast 能力" }
			: { kind: (tiers as { id: string }[] | undefined)?.some((tier) => tier.id === "priority")
				|| (legacy as string[] | undefined)?.includes("fast") ? "supported" : "unsupported" });
	}
	return models;
}

function catalogWait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(new Error("Cancelled"));
		if (signal.aborted) { abort(); return; }
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

async function catalogJson(response: Response, signal: AbortSignal): Promise<unknown> {
	if (!response.body) throw new Error("Missing directory body");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const part = await catalogWait(reader.read(), signal);
			if (part.done) break;
			size += part.value.byteLength;
			if (size > FAST_CATALOG_MAX_BYTES) throw new Error("Directory too large");
			chunks.push(part.value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
		return JSON.parse(new TextDecoder().decode(bytes));
	} finally { void reader.cancel().catch(() => {}); }
}

/** Only capability metadata survives a call; tokens and directory instructions are never cached. */
export class FastCatalog {
	private identity: string | undefined;
	private models: ReadonlyMap<string, FastCapability> | undefined;
	private fetchedAt = 0;
	private retryAt = 0;
	private failure = "尚未查询模型能力";
	private generation = 0;
	private identitySequence = 0;
	private latestIdentity = 0;
	private lifecycle = new AbortController();
	private inflight: { identity: string; controller: AbortController; promise: Promise<void> } | undefined;
	private readonly options: {
		resolveAuth: () => Promise<ProviderAuth | undefined>; version: string; fetch?: typeof globalThis.fetch;
		now?: () => number; offline?: boolean; timeoutMs?: number;
	};
	constructor(options: FastCatalog["options"]) { this.options = options; }

	reset(): void {
		this.generation++;
		this.lifecycle.abort();
		this.lifecycle = new AbortController();
		this.clearAccount();
	}

	private clearAccount(): void {
		this.inflight?.controller.abort();
		this.inflight = undefined;
		this.identity = undefined;
		this.models = undefined;
		this.fetchedAt = this.retryAt = 0;
	}

	async read(model: FastModel | undefined, oauth: boolean): Promise<FastCapability> {
		return this.readCapability(model, oauth);
	}

	/** Request-local credentials are authoritative; never resolve the current UI account. */
	async readForAuth(model: FastModel | undefined, oauth: boolean, auth: ProviderAuth | undefined, signal?: AbortSignal): Promise<FastCapability> {
		return this.readCapability(model, oauth, { auth, signal });
	}

	private async readCapability(model: FastModel | undefined, oauth: boolean,
		request?: { auth: ProviderAuth | undefined; signal?: AbortSignal }): Promise<FastCapability> {
		const unknown = (reason: string): FastCapability => ({ kind: "unknown", reason });
		if (!isCodexSubscription(model, oauth)) return unknown("仅适用于官方 Codex OAuth 订阅模型");
		if (this.options.offline) return unknown("离线模式，未查询模型能力");
		const owner = this.generation;
		const sequence = ++this.identitySequence;
		const signal = AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
			...(request?.signal ? [request.signal] : [])]);
		if (signal.aborted) return unknown("模型能力查询已取消");
		let auth: ProviderAuth | undefined;
		try { auth = request ? request.auth : await catalogWait(this.options.resolveAuth(), signal); }
		catch {
			if (owner === this.generation && sequence >= this.latestIdentity) { this.latestIdentity = sequence; this.clearAccount(); }
			return unknown("无法验证当前 Codex 账号的模型能力");
		}
		if (signal.aborted || owner !== this.generation || sequence < this.latestIdentity) return unknown("模型能力查询已取消");
		this.latestIdentity = sequence;
		const token = auth?.auth?.apiKey;
		const account = token && extractAccountId(token);
		if (auth?.source !== "OAuth" || !account || !token) { this.clearAccount(); return unknown("需要有效的 Codex OAuth 登录"); }
		const identity = createHash("sha256").update(account).update("\0").update(token).digest("hex");
		if (identity !== this.identity) { this.clearAccount(); this.identity = identity; }
		const now = this.options.now ?? Date.now;
		let waitedForDirectory = false;
		if ((!this.models || now() - this.fetchedAt >= FAST_CATALOG_TTL) && now() >= this.retryAt) {
			if (!this.inflight) {
				const controller = new AbortController();
				const requestSignal = AbortSignal.any([this.lifecycle.signal, controller.signal, AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
					...(request?.signal ? [request.signal] : [])]);
				const url = new URL("https://chatgpt.com/backend-api/codex/models");
				url.searchParams.set("client_version", this.options.version);
				const promise = Promise.resolve().then(async () => {
					try {
						const response = await catalogWait((this.options.fetch ?? globalThis.fetch)(url.href, {
							method: "GET", redirect: "error", signal: requestSignal,
							headers: { Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": account, Accept: "application/json" },
						}), requestSignal);
						if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error("Directory rejected"); }
						const models = parseFastCatalog(await catalogJson(response, requestSignal));
						if (!requestSignal.aborted && owner === this.generation && this.identity === identity) {
							this.models = models; this.fetchedAt = now(); this.retryAt = 0;
							this.failure = "模型目录未提供当前模型的 Fast 能力";
						}
					} catch {
						if (!controller.signal.aborted && !request?.signal?.aborted && owner === this.generation && this.identity === identity) {
							this.models = undefined; this.retryAt = now() + FAST_CATALOG_BACKOFF;
							this.failure = "模型目录查询失败，Fast 能力未知（30 秒后重试）";
						}
					} finally { if (this.inflight?.controller === controller) this.inflight = undefined; }
				});
				this.inflight = { identity, controller, promise };
			}
			waitedForDirectory = true;
			try { await catalogWait(this.inflight.promise, signal); } catch { return unknown("模型能力查询已取消"); }
		}
		if (signal.aborted || owner !== this.generation || this.identity !== identity) return unknown("当前 Codex 账号已变化");
		if (waitedForDirectory && !request) {
			// Login/logout does not necessarily emit model_select. Revalidate the account
			// after directory I/O before applying its advertised capability.
			let latest: ProviderAuth | undefined;
			try { latest = await catalogWait(this.options.resolveAuth(), signal); } catch { latest = undefined; }
			if (signal.aborted || owner !== this.generation || this.identity !== identity) return unknown("模型能力查询已取消");
			const latestToken = latest?.auth?.apiKey;
			const latestAccount = latestToken && extractAccountId(latestToken);
			const latestKey = latest?.source === "OAuth" && latestAccount && latestToken
				? createHash("sha256").update(latestAccount).update("\0").update(latestToken).digest("hex") : undefined;
			if (latestKey !== identity) { this.clearAccount(); return unknown("当前 Codex 账号已变化，请重新查询模型能力"); }
		}
		return { ...(this.models?.get(model!.id) ?? unknown(this.failure)) };
	}
}
