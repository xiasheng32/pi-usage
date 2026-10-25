/** Session-local Codex subscription speed preference; never stores request content. */
export const FAST_ENTRY = "pi-codex-fast";

export interface FastModel {
	id: string;
	provider: string;
	api: string;
	baseUrl: string;
}

export type FastCapability = { kind: "supported" | "unsupported" | "unknown"; reason?: string };

export type FastPhase = "idle" | "requested" | "fast" | "standard" | "unknown";

export interface FastSummary {
	switchLabel: string;
	costLabel: string;
	responseLabel: string;
	warning: boolean;
}

function fastRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : undefined;
}

export function isCodexSubscription(model: FastModel | undefined, oauth: boolean): boolean {
	if (!oauth || model?.provider !== "openai-codex" || model.api !== "openai-codex-responses") return false;
	try { return new URL(model.baseUrl).origin === "https://chatgpt.com"; } catch { return false; }
}

export function restoreFastMode(entries: readonly unknown[], sessionId: string): boolean {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = fastRecord(entries[i]);
		const data = fastRecord(entry?.data);
		if (entry?.type === "custom" && entry.customType === FAST_ENTRY && data?.sessionId === sessionId
			&& typeof data.enabled === "boolean") return data.enabled;
	}
	return false;
}

export class FastModeController {
	enabled = false;
	phase: FastPhase = "idle";
	capability: FastCapability = { kind: "unknown" };
	private reported: "pending" | "missing" | "unattributed" = "pending";
	private request: { model: string; responseId?: string } | undefined;
	private overlapping = false;

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		this.resetResponse();
	}

	resetSession(enabled: boolean): void {
		this.request = undefined;
		this.overlapping = false;
		this.capability = { kind: "unknown" };
		this.setEnabled(enabled);
	}

	setCapability(capability: FastCapability): void {
		this.capability = { ...capability };
	}

	resetResponse(): void {
		if (this.request) this.overlapping = true;
		this.phase = this.overlapping ? "unknown" : "idle";
		this.request = undefined;
		this.reported = this.overlapping ? "unattributed" : "pending";
	}

	transform(payload: unknown, model: FastModel | undefined, oauth: boolean, capability: FastCapability = this.capability): unknown {
		const body = fastRecord(payload);
		if (!isCodexSubscription(model, oauth) || body?.model !== model?.id
			|| !Array.isArray(body?.input)) return undefined;
		// The public payload hook has no request ID. If background warming overlaps a
		// foreground stream, never attribute one stream's tier to the other request.
		if (this.request) this.overlapping = true;
		this.request = { model: model!.id };
		this.phase = this.overlapping ? "unknown" : "requested";
		this.reported = this.overlapping ? "unattributed" : "pending";
		return { ...body, service_tier: this.enabled && capability.kind === "supported" ? "priority" : "default" };
	}

	observe(event: { provider: string; api: string; model: string; data: unknown }): void {
		if (!this.request || event.provider !== "openai-codex"
			|| event.api !== "openai-codex-responses" || event.model !== this.request.model) return;
		const data = fastRecord(event.data);
		const response = fastRecord(data?.response);
		if (!response) return;
		if (typeof response.id === "string") {
			if (this.request.responseId && this.request.responseId !== response.id) return;
			this.request.responseId = response.id;
		}
		if (!["response.completed", "response.done", "response.incomplete", "response.failed"].includes(String(data?.type))) return;
		this.phase = this.overlapping || data?.type === "response.failed" || data?.type === "response.incomplete" ? "unknown"
			: response.service_tier === "fast" || response.service_tier === "priority" ? "fast"
			: response.service_tier === "default" ? "standard" : "unknown";
		this.reported = this.overlapping || data?.type === "response.failed" || data?.type === "response.incomplete" ? "unattributed" : "missing";
		this.request = undefined;
	}

	settle(): void {
		if (this.request) this.overlapping = true;
		if (this.phase === "requested") this.phase = "unknown";
		if (this.overlapping) this.reported = "unattributed";
		this.request = undefined;
	}

	suffix(): string {
		if (!this.enabled) return "";
		return this.capability.kind === "supported" ? " · Fast"
			: this.capability.kind === "unsupported" ? " · Fast不可用" : " · Fast能力未知";
	}

	/** Compact presentation; a preference never claims a confirmed server tier. */
	summary(model: FastModel | undefined, oauth: boolean): FastSummary {
		const applicable = isCodexSubscription(model, oauth);
		const supported = this.capability.kind === "supported";
		const unavailable = applicable && this.enabled && !supported;
		const switchLabel = `${this.enabled ? "已开启" : "已关闭"}${unavailable
			? this.capability.kind === "unsupported" ? "·不可用" : "·能力未知" : ""}`;
		const responseLabel = !applicable ? "当前模型不适用" : this.phase === "fast" ? "服务端 Fast"
			: this.phase === "standard" ? "服务端标准" : this.reported === "unattributed" ? "响应无法确认"
				: this.reported === "missing" ? "档位未返回" : this.phase === "requested" ? "响应待确认" : "等待响应";
		return {
			switchLabel, costLabel: !applicable ? "—" : this.enabled && supported ? "×2.5" : "标准", responseLabel,
			warning: !applicable || unavailable || this.phase === "unknown" || (this.enabled && this.phase === "standard"),
		};
	}

	details(model: FastModel | undefined, oauth: boolean): string[] {
		const applicable = isCodexSubscription(model, oauth);
		const modelId = model && /^[a-zA-Z0-9._:/-]{1,128}$/.test(model.id) ? model.id : "未知模型";
		const tier = !applicable ? "当前模型未应用" : this.phase === "fast" ? "Fast（priority / fast）"
			: this.phase === "standard" ? "服务端返回标准档位（default）"
				: this.reported === "missing" ? "未返回" : this.reported === "unattributed" ? "无法确认（请求失败或并发结果无法归属）" : "等待下一次响应";
		const capability = !applicable ? "当前模型不适用" : this.capability.kind === "supported" ? "支持 Fast"
			: this.capability.kind === "unsupported" ? "不支持 Fast" : "未知";
		const requestTier = !applicable ? "当前模型不应用" : this.enabled && this.capability.kind === "supported" ? "priority（Fast 路由已启用）" : "default（标准路由）";
		return ["▸ Fast 模式", `Fast 开关：${this.enabled ? "开启" : "关闭"}（仅当前会话）`,
			`当前模型：${modelId}`, `模型能力：${capability}`, `请求档位：${requestTier}`, `最近服务端档位：${tier}`,
			...(this.capability.reason ? [this.capability.reason] : []),
			"页脚 Fast 表示已启用路由，不代表服务端已确认加速。",
			"Fast 消耗：订阅额度按标准的 2.5 倍", "使用 /fast on 或 /fast off；新会话默认关闭。"];
	}
}
