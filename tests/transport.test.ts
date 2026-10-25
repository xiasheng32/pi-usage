import assert from "node:assert/strict";
import { test } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { stream, closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { Model } from "@earendil-works/pi-ai";
import { FastModeController } from "../src/codex/fast-mode.ts";

const transportModel: Model<"openai-codex-responses"> = {
	id: "gpt-6.1-sol", name: "Synthetic Codex", provider: "openai-codex", api: "openai-codex-responses",
	baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000,
};
const syntheticToken = "synthetic." + Buffer.from(JSON.stringify({
	"https://api.openai.com/auth": { chatgpt_account_id: "synthetic-transport-account" },
})).toString("base64url") + ".synthetic";
const transportEvents = [
	{ type: "response.created", response: { id: "synthetic-transport-response", status: "in_progress" } },
	{ type: "response.completed", response: { id: "synthetic-transport-response", status: "completed", service_tier: "default",
		usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 }, output: [] } },
];
const transportContext = normalizeContext({ systemPrompt: "Synthetic test", messages: [{ role: "user", content: "Synthetic test", timestamp: 0 }] });

// Every HTTP or WebSocket transport is replaced in memory; no account or network is accessed.
for (const transport of ["sse", "websocket"] as const) {
	test(`Pi 1.2.0 ${transport} serializes off/on/off while preserving the actual default response`, async (t) => {
		const fast = new FastModeController();
		fast.setCapability({ kind: "supported" });
		let sent: Record<string, unknown> | undefined;
		let requests = 0;
		let connections = 0;
		const sessionId = `synthetic-tier-cycle-${transport}`;
		t.after(() => closeOpenAICodexWebSocketSessions(sessionId));
		const fakeFetch: typeof fetch = async (_url, init) => {
			assert.equal(transport, "sse", "WebSocket test must not fall back to HTTP");
			requests++;
			const raw = new Headers(init?.headers).get("content-encoding") === "zstd"
				? zstdDecompressSync(Buffer.from(init!.body as Uint8Array)).toString("utf8") : String(init?.body);
			sent = JSON.parse(raw) as Record<string, unknown>;
			return new Response(transportEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
				headers: { "content-type": "text/event-stream" },
			});
		};
		class SyntheticSocket extends EventTarget {
			readyState = 0;
			constructor(url: string) {
				super();
				connections++;
				assert.equal(new URL(url).hostname, "chatgpt.com");
				queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); });
			}
			send(value: string): void {
				requests++;
				sent = JSON.parse(value) as Record<string, unknown>;
				setImmediate(() => {
					for (const event of transportEvents) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
				});
			}
			close(): void { this.readyState = 3; }
		}
		if (transport === "websocket") {
			const original = globalThis.WebSocket;
			globalThis.WebSocket = SyntheticSocket as unknown as typeof WebSocket;
			t.after(() => { globalThis.WebSocket = original; });
		}
		for (const enabled of [false, true, false]) {
			fast.setEnabled(enabled);
			const result = await stream(transportModel, transportContext, {
				apiKey: syntheticToken, transport, fetch: fakeFetch, maxRetries: 0, timeoutMs: 1000,
				reasoningEffort: "high", sessionId,
				onPayload: (body, model) => fast.transform(body, model, true),
				onProviderStreamEvent: (data, model) => fast.observe({ provider: model.provider, api: model.api, model: model.id, data }),
			}).result();
			assert.equal(result.stopReason, "stop", result.errorMessage);
			assert.equal(sent?.service_tier, enabled ? "priority" : "default");
			assert.equal(sent?.model, transportModel.id);
			assert.equal((sent?.reasoning as { effort: string }).effort, "high");
			assert.equal(fast.phase, "standard");
			assert.equal(fast.suffix(), enabled ? " · Fast" : "");
			if (transport === "websocket") assert.equal(sent?.type, "response.create");
		}
		assert.equal(requests, 3);
		if (transport === "websocket") assert.equal(connections, 1, "the connection must be reused across toggles");
	});
}
