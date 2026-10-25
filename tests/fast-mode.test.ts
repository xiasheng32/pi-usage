import assert from "node:assert/strict";
import { test } from "node:test";
import { FAST_ENTRY, FastModeController, isCodexSubscription, restoreFastMode } from "../src/codex/fast-mode.ts";
import type { FastModel } from "../src/codex/fast-mode.ts";

const model: FastModel = { id: "gpt-6.1-sol", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" };
const request = () => ({ model: model.id, input: [{ role: "user", content: "synthetic prompt" }],
	service_tier: "default", reasoning: { effort: "high" }, tools: [{ type: "function", name: "synthetic_tool" }],
	prompt_cache_key: "synthetic-cache", stream: true });
const entry = (enabled: boolean, sessionId = "session-A") => ({ type: "custom", customType: FAST_ENTRY, data: { enabled, sessionId } });
function event(tier: unknown, options: { type?: string; id?: string; model?: string; provider?: string; api?: string } = {}) {
	return { provider: options.provider ?? model.provider, api: options.api ?? model.api, model: options.model ?? model.id,
		data: { type: options.type ?? "response.completed", response: { id: options.id ?? "synthetic-response-A", service_tier: tier } } };
}

test("summary separates the session switch, applicable cost and idle response without changing state", () => {
	for (const enabled of [false, true]) {
		for (const kind of ["supported", "unknown", "unsupported"] as const) {
			const fast = new FastModeController();
			fast.setCapability({ kind, reason: "synthetic capability" });
			fast.setEnabled(enabled);
			const before = structuredClone(fast);
			const unavailable = enabled && kind !== "supported";
			assert.deepEqual(fast.summary(model, true), {
				switchLabel: `${enabled ? "已开启" : "已关闭"}${unavailable ? kind === "unknown" ? "·能力未知" : "·不可用" : ""}`,
				costLabel: enabled && kind === "supported" ? "×2.5" : "标准",
				responseLabel: "等待响应", warning: unavailable,
			});
			assert.deepEqual(structuredClone(fast), before, "presentation must preserve preference and response state");
			assert.deepEqual(fast.transform(request(), model, true), {
				...request(), service_tier: enabled && kind === "supported" ? "priority" : "default",
			});
			assert.equal(fast.enabled, enabled, "unsupported/unknown capability must not discard the preference");
		}
	}
});

test("summary marks non-applicable models and authentication with no cost or response claim", () => {
	for (const enabled of [false, true]) {
		const fast = new FastModeController();
		fast.setEnabled(enabled);
		fast.setCapability({ kind: "supported" });
		fast.transform(request(), model, true);
		fast.observe(event("fast"));
		for (const [candidate, oauth] of [[undefined, true], [{ ...model, provider: "openai" }, true],
			[{ ...model, api: "other-api" }, true], [{ ...model, baseUrl: "https://proxy.invalid" }, true], [model, false]] as const) {
			const before = structuredClone(fast);
			assert.deepEqual(fast.summary(candidate, oauth), {
				switchLabel: enabled ? "已开启" : "已关闭", costLabel: "—", responseLabel: "当前模型不适用", warning: true,
			});
			assert.deepEqual(structuredClone(fast), before);
		}
	}
});

test("summary distinguishes pending requests, confirmed Fast/default and missing server tiers", () => {
	for (const enabled of [false, true]) {
		for (const type of ["response.completed", "response.done"]) {
			for (const tier of ["fast", "priority", "default", undefined, "auto"]) {
				const fast = new FastModeController();
				fast.setCapability({ kind: "supported" });
				fast.setEnabled(enabled);
				fast.transform(request(), model, true);
				const base = { switchLabel: enabled ? "已开启" : "已关闭", costLabel: enabled ? "×2.5" : "标准" };
				const pending = structuredClone(fast);
				assert.deepEqual(fast.summary(model, true), { ...base, responseLabel: "响应待确认", warning: false });
				assert.deepEqual(structuredClone(fast), pending);
				fast.observe(event(tier, { type }));
				const confirmedFast = tier === "fast" || tier === "priority";
				const standard = tier === "default";
				const settled = structuredClone(fast);
				assert.deepEqual(fast.summary(model, true), {
					...base, responseLabel: confirmedFast ? "服务端 Fast" : standard ? "服务端标准" : "档位未返回",
					warning: !confirmedFast && (!standard || enabled),
				});
				assert.deepEqual(structuredClone(fast), settled);
				fast.settle();
				assert.deepEqual(structuredClone(fast), settled, "reading a summary must not leave a request pending");
			}
		}
	}
});

test("summary never confirms failed, incomplete, unfinished or ambiguously overlapping responses", () => {
	for (const scenario of ["response.failed", "response.incomplete", "settle", "overlap"]) {
		const fast = new FastModeController();
		fast.setCapability({ kind: "supported" });
		fast.setEnabled(true);
		fast.transform(request(), model, true);
		if (scenario === "overlap") fast.transform(request(), model, true);
		else if (scenario === "settle") fast.settle();
		else fast.observe(event("priority", { type: scenario }));
		const expected = { switchLabel: "已开启", costLabel: "×2.5", responseLabel: "响应无法确认", warning: true };
		const before = structuredClone(fast);
		assert.deepEqual(fast.summary(model, true), expected);
		assert.deepEqual(fast.summary(model, true), expected);
		assert.deepEqual(structuredClone(fast), before);
		fast.observe(event("fast"));
		assert.deepEqual(fast.summary(model, true), expected, "late/overlapping confirmation remains conservative");
		fast.resetSession(true);
		fast.setCapability({ kind: "supported" });
		assert.deepEqual(fast.summary(model, true), { ...expected, responseLabel: "等待响应", warning: false });
		fast.transform(request(), model, true);
		fast.observe(event("fast"));
		assert.deepEqual(fast.summary(model, true), { ...expected, responseLabel: "服务端 Fast", warning: false });
	}
});

test("only the Codex subscription provider, responses API and OAuth qualify", () => {
	assert.equal(isCodexSubscription(model, true), true);
	for (const candidate of [undefined, { ...model, provider: "openai" }, { ...model, provider: "anthropic" },
		{ ...model, provider: "google" }, { ...model, api: "openai-responses" }]) {
		assert.equal(isCodexSubscription(candidate, true), false);
	}
	assert.equal(isCodexSubscription(model, false), false);
	for (const baseUrl of [undefined, "", "not-a-url", "https://chatgpt.com.example.invalid/backend-api", "http://chatgpt.com/backend-api",
		"https://api.openai.com/v1", "https://proxy.example.invalid/backend-api"]) {
		assert.equal(isCodexSubscription({ ...model, baseUrl } as unknown as FastModel, true), false, `unexpected official subscription: ${baseUrl}`);
	}
	assert.equal(isCodexSubscription({ ...model, baseUrl: "https://chatgpt.com/backend-api/codex" }, true), true);
});

test("restoration uses the latest valid choice in this session and never inherits a fork", () => {
	const entries = [entry(true), entry(false), entry(true, "session-B")];
	assert.equal(restoreFastMode(entries, "session-A"), false);
	assert.equal(restoreFastMode([...entries, entry(true)], "session-A"), true);
	assert.equal(restoreFastMode(entries, "session-B"), true);
	assert.equal(restoreFastMode(entries, "fork-C"), false);
	assert.equal(restoreFastMode([], "session-A"), false);
});

test("malformed and unrelated custom entries cannot enable Fast", () => {
	const invalid = [null, [], 1, {}, { type: "message", customType: FAST_ENTRY, data: { enabled: true, sessionId: "session-A" } },
		{ ...entry(true), customType: "other-extension" }, { ...entry(true), data: { enabled: "true", sessionId: "session-A" } },
		{ ...entry(true), data: { enabled: true } }, { ...entry(true), data: [] }];
	assert.equal(restoreFastMode(invalid, "session-A"), false);
	assert.equal(restoreFastMode([entry(true), ...invalid], "session-A"), true);
});

test("Fast starts off and explicitly chooses the default request tier", () => {
	const fast = new FastModeController();
	const payload = request();
	assert.equal(fast.enabled, false);
	assert.deepEqual(fast.transform(payload, model, true), { ...payload, service_tier: "default" });
	assert.equal(payload.service_tier, "default");
	assert.equal(fast.suffix(), "");
});

test("priority requires both an enabled preference and an explicitly supported catalog capability", () => {
	for (const enabled of [false, true]) {
		for (const kind of ["supported", "unsupported", "unknown"] as const) {
			const fast = new FastModeController();
			fast.setCapability({ kind });
			fast.setEnabled(enabled);
			const payload = { ...request(), service_tier: "priority" };
			const tier = enabled && kind === "supported" ? "priority" : "default";
			assert.deepEqual(fast.transform(payload, model, true), { ...payload, service_tier: tier });
			assert.equal(payload.service_tier, "priority", "original payload remains untouched");
			assert.equal(fast.suffix(), !enabled ? "" : kind === "supported" ? " · Fast"
				: kind === "unknown" ? " · Fast能力未知" : " · Fast不可用");
		}
	}
});

test("an unknown initial capability cannot send priority even with the session preference enabled", () => {
	const fast = new FastModeController();
	fast.setEnabled(true);
	assert.equal(fast.capability.kind, "unknown");
	assert.deepEqual(fast.transform(request(), model, true), { ...request(), service_tier: "default" });
	assert.equal(fast.suffix(), " · Fast能力未知");
	fast.setCapability({ kind: "supported" });
	assert.equal(fast.suffix(), " · Fast");
	fast.setCapability({ kind: "unsupported", reason: "Synthetic unsupported model" });
	assert.equal(fast.suffix(), " · Fast不可用");
	fast.resetSession(true);
	assert.equal(fast.enabled, true);
	assert.equal(fast.capability.kind, "unknown");
	assert.equal(fast.phase, "idle");
});

test("server diagnostics cannot override a supported Fast preference in the footer", () => {
	for (const tier of ["default", "fast", "priority", undefined, "auto"]) {
		const fast = new FastModeController();
		fast.setCapability({ kind: "supported" });
		fast.setEnabled(true);
		fast.transform(request(), model, true);
		fast.observe(event(tier));
		assert.equal(fast.suffix(), " · Fast");
		if (tier === "default") assert.equal(fast.phase, "standard");
	}
});

test("details separate catalog capability, requested route and the server's actual reported tier", () => {
	const fast = new FastModeController();
	fast.setCapability({ kind: "supported" });
	fast.setEnabled(true);
	fast.transform(request(), model, true);
	fast.observe(event("default"));
	let output = fast.details(model, true).join("\n");
	assert.match(output, /模型能力：支持 Fast/);
	assert.match(output, /请求档位：priority/);
	assert.match(output, /最近服务端档位：.*default/);
	assert.equal(fast.suffix(), " · Fast");
	fast.setEnabled(false);
	fast.transform(request(), model, true);
	fast.observe(event("default"));
	output = fast.details(model, true).join("\n");
	assert.match(output, /请求档位：default/);
	assert.match(output, /最近服务端档位：.*default/);
	assert.equal(fast.suffix(), "");
	fast.setEnabled(true);
	fast.transform(request(), model, true);
	fast.observe(event(undefined));
	assert.match(fast.details(model, true).join("\n"), /最近服务端档位：未返回/);
});

test("Fast replaces only service_tier while preserving model, reasoning, tools, cache and input", () => {
	const fast = new FastModeController();
	fast.setCapability({ kind: "supported" });
	fast.setEnabled(true);
	const payload = request();
	const before = structuredClone(payload);
	const transformed = fast.transform(payload, model, true);
	assert.deepEqual(transformed, { ...before, service_tier: "priority" });
	assert.deepEqual(payload, before, "the original provider payload is never mutated");
	assert.notEqual(transformed, payload);
	assert.equal(fast.phase, "requested");
	assert.equal(fast.suffix(), " · Fast");
});

test("non-subscription models, absent OAuth and unrelated payload shapes stay unchanged", () => {
	const fast = new FastModeController();
	fast.setCapability({ kind: "supported" });
	fast.setEnabled(true);
	for (const candidate of [{ ...model, provider: "openai" }, { ...model, provider: "anthropic" }, { ...model, api: "other-api" }, undefined]) {
		assert.equal(fast.transform(request(), candidate, true), undefined);
	}
	assert.equal(fast.transform(request(), model, false), undefined);
	for (const payload of [null, [], "text", {}, { ...request(), model: "other-model" }, { ...request(), input: "invalid" }, { model: model.id }]) {
		assert.equal(fast.transform(payload, model, true), undefined);
	}
	assert.equal(fast.phase, "idle");
});

test("Fast confirmation, standard fallback and missing or unknown tiers are distinguished", () => {
	for (const [tier, phase, suffix] of [["fast", "fast", " · Fast"], ["priority", "fast", " · Fast"],
		["default", "standard", " · Fast"], [undefined, "unknown", " · Fast"], ["auto", "unknown", " · Fast"]]) {
		const fast = new FastModeController();
		fast.setCapability({ kind: "supported" });
		fast.setEnabled(true);
		fast.transform(request(), model, true);
		fast.observe(event(tier));
		assert.equal(fast.phase, phase);
		assert.equal(fast.suffix(), suffix);
	}
});

test("response identity and provider/model filtering prevent unrelated completion from confirming Fast", () => {
	const fast = new FastModeController();
	fast.setCapability({ kind: "supported" });
	fast.setEnabled(true);
	fast.transform(request(), model, true);
	fast.observe(event("fast", { type: "response.created" }));
	assert.equal(fast.phase, "requested", "an early tier is not a completed response confirmation");
	for (const options of [{ id: "synthetic-response-B" }, { provider: "openai" }, { api: "other-api" }, { model: "other-model" }]) {
		fast.observe(event("fast", options));
		assert.equal(fast.phase, "requested");
	}
	fast.observe(event("default"));
	assert.equal(fast.phase, "standard");
	fast.observe(event("fast"));
	assert.equal(fast.phase, "standard", "a settled request cannot be overwritten by a late event");
});

test("invalid stream data and unfinished requests never claim acceleration", () => {
	const fast = new FastModeController();
	fast.setCapability({ kind: "supported" });
	fast.setEnabled(true);
	fast.transform(request(), model, true);
	for (const data of [undefined, null, [], {}, { type: "response.completed", response: [] }]) {
		fast.observe({ ...event("fast"), data });
	}
	assert.equal(fast.phase, "requested");
	fast.settle();
	assert.equal(fast.phase, "unknown");
	fast.observe(event("fast"));
	assert.equal(fast.phase, "unknown");
});

test("overlapping cache-warming and foreground responses remain unconfirmed across turns until session reset", () => {
	const fast = new FastModeController();
	fast.setCapability({ kind: "supported" });
	fast.setEnabled(true);
	assert.deepEqual(fast.transform(request(), model, true), { ...request(), service_tier: "priority" });
	assert.deepEqual(fast.transform(request(), model, true), { ...request(), service_tier: "priority" });
	fast.observe(event("fast", { id: "cache-response" }));
	assert.equal(fast.phase, "unknown");
	fast.observe(event("priority", { id: "foreground-response" }));
	assert.equal(fast.phase, "unknown");
	fast.transform(request(), model, true);
	fast.observe(event("fast", { id: "third-response" }));
	assert.equal(fast.phase, "unknown", "the ambiguous turn must remain conservative for later streams too");
	fast.settle();
	fast.transform(request(), model, true);
	fast.observe(event("fast", { id: "next-turn-response" }));
	assert.equal(fast.phase, "unknown", "agent settlement cannot establish that a background stream has ended");
	fast.resetSession(true);
	fast.setCapability({ kind: "supported" });
	fast.transform(request(), model, true);
	fast.observe(event("fast", { id: "new-runtime-response" }));
	assert.equal(fast.phase, "fast", "a fresh session runtime can confirm Fast again");
});

test("a late background completion cannot confirm a later turn after settle, toggles or model changes", () => {
	const fast = new FastModeController();
	fast.setCapability({ kind: "supported" });
	fast.setEnabled(true);
	fast.transform(request(), model, true); // Foreground A.
	fast.transform(request(), model, true); // Background cache warming W.
	assert.equal(fast.phase, "unknown", "overlap is unconfirmed immediately, before either stream completes");
	fast.observe(event("fast", { id: "foreground-A" }));
	fast.settle();
	fast.transform(request(), model, true); // Foreground B.
	fast.observe(event("fast", { id: "late-background-W" }));
	assert.equal(fast.phase, "unknown", "W must not be mistaken for B after agent settlement");
	for (const reset of [() => fast.settle(), () => { fast.setEnabled(false); fast.setEnabled(true); }, () => fast.resetResponse()]) {
		reset();
		assert.equal(fast.phase, "unknown");
		fast.transform(request(), model, true);
		assert.equal(fast.phase, "unknown");
		fast.observe(event("fast", { id: "another-late-background" }));
		assert.equal(fast.phase, "unknown");
	}
	fast.resetSession(false);
	assert.equal(fast.enabled, false);
	assert.equal(fast.phase, "idle");
	fast.setCapability({ kind: "supported" });
	fast.setEnabled(true);
	fast.transform(request(), model, true);
	fast.observe(event("fast", { id: "new-session-foreground" }));
	assert.equal(fast.phase, "fast");
});

test("failed and incomplete responses remain unconfirmed even when a Fast tier is present", () => {
	for (const type of ["response.failed", "response.incomplete"]) {
		const fast = new FastModeController();
		fast.setCapability({ kind: "supported" });
		fast.setEnabled(true);
		fast.transform(request(), model, true);
		fast.observe(event("fast", { type }));
		assert.equal(fast.phase, "unknown");
		assert.equal(fast.suffix(), " · Fast");
		assert.match(fast.details(model, true).join("\n"), /请求失败/);
	}
});

test("clearing a pending request retains ambiguity even when no requests previously overlapped", () => {
	for (const reset of ["off/on", "resetResponse", "settle", "on-again"]) {
		const fast = new FastModeController();
		fast.setCapability({ kind: "supported" });
		fast.setEnabled(true);
		fast.transform(request(), model, true); // A is the only request so far.
		assert.equal(fast.phase, "requested");
		if (reset === "off/on") { fast.setEnabled(false); fast.setEnabled(true); }
		else if (reset === "on-again") fast.setEnabled(true);
		else if (reset === "resetResponse") fast.resetResponse();
		else fast.settle();
		assert.equal(fast.phase, "unknown", `${reset} cannot prove A has finished`);
		fast.transform(request(), model, true); // B starts after A was forgotten.
		fast.observe(event("fast", { id: "late-response-A" }));
		assert.equal(fast.phase, "unknown", `${reset} must not attribute late A to B`);
		fast.transform(request(), model, true); // Keep another pending request at runtime reset.
		fast.resetSession(true);
		fast.setCapability({ kind: "supported" });
		assert.equal(fast.phase, "idle", "session reset clears pending evidence without latching it again");
		fast.transform(request(), model, true);
		fast.observe(event("fast", { id: "fresh-runtime-response" }));
		assert.equal(fast.phase, "fast");
	}
});

test("turn settlement retains confirmed tiers but toggles and model changes clear old response state", () => {
	const fast = new FastModeController();
	fast.setCapability({ kind: "supported" });
	fast.setEnabled(true);
	fast.transform(request(), model, true);
	fast.observe(event("fast"));
	fast.settle();
	assert.equal(fast.phase, "fast");
	fast.resetResponse();
	assert.equal(fast.enabled, true);
	assert.equal(fast.phase, "idle");
	fast.observe(event("fast"));
	assert.equal(fast.phase, "idle");
	fast.setEnabled(false);
	assert.equal(fast.suffix(), "");
	fast.observe(event("fast"));
	assert.equal(fast.phase, "idle");
});

test("details describe the session-only switch and sanitize terminal-control model names", () => {
	const fast = new FastModeController();
	assert.match(fast.details(model, true).join("\n"), /关闭（仅当前会话）/);
	fast.setCapability({ kind: "supported" });
	fast.setEnabled(true);
	assert.match(fast.details(model, true).join("\n"), /2\.5 倍/);
	assert.match(fast.details(model, true).join("\n"), /\/fast on 或 \/fast off；新会话默认关闭/);
	assert.match(fast.details(model, false).join("\n"), /当前模型未应用/);
	const detail = fast.details({ ...model, id: "bad\x1b[31m\r\nmodel" }, true).join("\n");
	assert.match(detail, /未知模型/);
	assert.ok(!detail.includes("\x1b"));
});
