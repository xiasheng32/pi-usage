/**
 * Detail overlays for the usage HUD.
 *
 * `BalancePanel` renders the DeepSeek/Kimi account balance through the provider
 * erased `BalanceRuntime`; `QuotaPanel` renders the Codex subscription quota,
 * reset cards and the session-local Fast state.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { matchesKey, rgbColor, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { BalanceRuntime } from "./balance/core.ts";
import { detailSections, isLowQuota, localTime, percentage, quotaBar, resetRemaining, statusLine, windowLabel } from "./codex/quota.ts";
import type { QuotaController } from "./codex/quota.ts";
import type { FastModeController } from "./codex/fast-mode.ts";
import { usesCodexSubscription } from "./registry.ts";

const LOW_QUOTA_DARK = rgbColor(240, 160, 160);
const LOW_QUOTA_LIGHT = rgbColor(176, 82, 92);
const HEADING_COLORS = {
	quota: { dark: rgbColor(94, 234, 212), light: rgbColor(15, 118, 110) },
	cards: { dark: rgbColor(196, 181, 253), light: rgbColor(109, 40, 217) },
	fast: { dark: rgbColor(56, 189, 248), light: rgbColor(2, 132, 199) },
};

export class BalancePanel {
	private readonly tui: TUI;
	private readonly ctx: ExtensionContext;
	private readonly runtime: BalanceRuntime;
	private readonly done: () => void;
	private offset = 0;
	private maxOffset = 0;

	constructor(tui: TUI, ctx: ExtensionContext, runtime: BalanceRuntime, done: () => void) {
		this.tui = tui;
		this.ctx = ctx;
		this.runtime = runtime;
		this.done = done;
	}

	invalidate(): void {} // Lines and theme are recomputed on every render.

	render(availableWidth: number): string[] {
		const width = Math.max(0, Math.min(availableWidth, 64));
		if (width === 0) return [];
		const now = Date.now();
		const theme = this.ctx.ui.theme;
		if (width < 6 || this.tui.terminal.rows < 8) {
			return [this.runtime.status(now).text, "Enter/Esc 关闭"].map((line) => truncateToWidth(line, width));
		}
		const inner = width - 2;
		const contentWidth = Math.max(1, inner - 2);
		const paint = (line: string) => {
			if (line.startsWith("正在刷新") || this.runtime.accent.test(line)) return theme.fg("accent", line);
			if (line.startsWith("状态")) return theme.fg(/不可用\s*$/.test(line) ? "error" : "success", line);
			if (/过期缓存|查询失败|查询限流|查询超时|格式异常|拒绝认证|未配置/.test(line)) return theme.fg("warning", line);
			if (/^更新：|本机时区|自动重试|限流冷却|^[A-Z0-9]{2,8}$/.test(line)) return theme.fg("dim", line);
			return line;
		};
		const content = this.runtime.details(now).flatMap((line) => wrapTextWithAnsi(paint(line), contentWidth));
		const bodyHeight = Math.max(1, Math.min(20, this.tui.terminal.rows - 7));
		this.maxOffset = Math.max(0, content.length - bodyHeight);
		this.offset = Math.min(this.offset, this.maxOffset);
		const row = (text: string) => {
			const value = truncateToWidth(` ${text}`, inner);
			return theme.fg("border", "│") + value + " ".repeat(Math.max(0, inner - visibleWidth(value))) + theme.fg("border", "│");
		};
		return [
			theme.fg("border", `╭${"─".repeat(inner)}╮`),
			row(theme.fg("accent", this.runtime.title)),
			theme.fg("border", `├${"─".repeat(inner)}┤`),
			...content.slice(this.offset, this.offset + bodyHeight).map((line) => row(line)),
			theme.fg("border", `╰${"─".repeat(inner)}╯`),
			theme.fg("dim", `${this.maxOffset ? ` ↑↓ 滚动 ${this.offset + 1}-${Math.min(content.length, this.offset + bodyHeight)}/${content.length} ·` : ""} Enter/Esc 关闭`),
		].map((line) => truncateToWidth(line, width));
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "return") || data === "q") {
			this.done();
		} else if (matchesKey(data, "up") || matchesKey(data, "down")) {
			this.offset = Math.max(0, Math.min(this.maxOffset, this.offset + (matchesKey(data, "up") ? -1 : 1)));
			this.tui.requestRender();
		} else if (matchesKey(data, "home") || matchesKey(data, "end")) {
			this.offset = matchesKey(data, "home") ? 0 : this.maxOffset;
			this.tui.requestRender();
		}
	}
}

export class QuotaPanel {
	private readonly tui: TUI;
	private readonly ctx: ExtensionContext;
	private readonly controller: QuotaController;
	private readonly done: (action?: "use") => void;
	private readonly fast: FastModeController;
	private finished = false;
	private offset = 0;
	private maxOffset = 0;

	constructor(tui: TUI, ctx: ExtensionContext, controller: QuotaController, done: (action?: "use") => void, fast: FastModeController) {
		this.tui = tui;
		this.ctx = ctx;
		this.controller = controller;
		this.done = done;
		this.fast = fast;
	}

	invalidate(): void {} // Lines and theme are recomputed on every render.

	render(availableWidth: number): string[] {
		const width = Math.max(0, Math.min(availableWidth, 68));
		const rows = Math.max(0, this.tui.terminal.rows);
		if (width === 0 || rows === 0) return [];
		// Leave room for the overlay's top and bottom margins when possible.
		const height = Math.max(1, rows - 2);
		const framed = width >= 24 && height >= 10;
		const contentWidth = framed ? width - 4 : width;
		const cards = width >= 40 && rows >= 16;
		const detailWidth = cards ? contentWidth - 4 : contentWidth;
		const state = this.controller.getState();
		const now = Date.now();
		const theme = this.ctx.ui.theme;
		const button = this.controller.getResetButton();
		const sections = detailSections(state, now, 36, undefined, { compact: true });
		const updated = theme.fg("dim", truncateToWidth(sections.updated, contentWidth));
		const center = (line: string, columns = contentWidth) => !line ? line
			: " ".repeat(Math.max(0, Math.floor((columns - visibleWidth(line)) / 2))) + line;
		if (height === 1) {
			this.offset = this.maxOffset = 0;
			return [center(updated)];
		}
		// Wrap first and position each content group as a unit. Continuations keep
		// their column relationships instead of drifting when centered separately.
		const group = (lines: string[], columns = detailWidth): string[] => {
			const wrapped = lines.flatMap((line) => wrapTextWithAnsi(line, columns));
			const widest = Math.max(0, ...wrapped.map(visibleWidth));
			const padding = " ".repeat(Math.max(0, Math.floor((columns - widest) / 2)));
			return wrapped.map((line) => line ? padding + line : line);
		};
		const heading = (title: string, colors: typeof HEADING_COLORS.quota) => theme.style(title,
			{ fg: theme.appearance === "light" ? colors.light : colors.dark, bold: true });
		const pair = (left: string, right: string, columns: number) => left + " ".repeat(Math.max(2, columns - visibleWidth(left) - visibleWidth(right))) + right;
		const paint = (line: string) => {
			if ((state.resetUse?.warning && line === state.resetUse.message)
				|| /过期缓存|查询失败|查询限流|查询超时|格式异常|已到期|结果不确定|未完成|被拒绝/.test(line)) return theme.fg("warning", line);
			if (line.startsWith("   ") || /不推断|未提供/.test(line)) return theme.fg("dim", line);
			return line;
		};
		const card = (lines: string[]): string[] => {
			if (!cards) return lines;
			return [
				theme.fg("dim", `╭${"─".repeat(contentWidth - 2)}╮`),
				...lines.map((line) => theme.fg("dim", "│") + ` ${line}${" ".repeat(Math.max(0, detailWidth - visibleWidth(line)))} ` + theme.fg("dim", "│")),
				theme.fg("dim", `╰${"─".repeat(contentWidth - 2)}╯`),
			];
		};
		const windows = sections.quota.length ? state.snapshot?.windows ?? [] : [];
		const labelWidth = Math.max(0, ...windows.map((window) => visibleWidth(windowLabel(window))));
		const percentWidth = Math.max(0, ...windows.map((window) => visibleWidth(`${percentage(window.remainingPercent)}%`)));
		const dates = windows.map((window) => {
			if (window.resetAt === null) return "重置时间未知";
			const date = localTime(window.resetAt);
			const formatted = new Date(window.resetAt).getFullYear() === new Date(now).getFullYear() ? date.slice(5) : date;
			return window.resetAt <= now ? `待刷新 ${formatted}` : formatted;
		});
		const dateWidth = Math.max(0, ...dates.map(visibleWidth));
		const tubeWidth = Math.min(20, detailWidth - labelWidth - percentWidth - dateWidth - 8);
		const useTubes = tubeWidth >= 8 && rows >= 24;
		const lowQuotaColor = theme.appearance === "light" ? LOW_QUOTA_LIGHT : LOW_QUOTA_DARK;
		let quota: string[];
		if (windows.length && useTubes) {
			quota = windows.flatMap((window, index) => {
				const label = windowLabel(window);
				const percent = `${percentage(window.remainingPercent)}%`;
				const bar = quotaBar(window.remainingPercent, tubeWidth, true);
				const color = statusLine({ ...state, snapshot: { ...state.snapshot!, windows: [window] } }, now).color;
				const painted = bar.split(/([█░]+)/).map((part) => isLowQuota(window.remainingPercent) && /[█░]/.test(part)
					? theme.style(part, { fg: lowQuotaColor }) : theme.fg(color, part)).join("");
				const gutter = " ".repeat(labelWidth + 2);
				const date = dates[index]!;
				const middle = label + " ".repeat(labelWidth - visibleWidth(label) + 2) + "│" + painted + "│  "
					+ " ".repeat(percentWidth - visibleWidth(percent)) + percent + "  "
					+ " ".repeat(dateWidth - visibleWidth(date)) + theme.fg(window.resetAt !== null && window.resetAt <= now ? "warning" : "dim", date);
				return [...(index ? [""] : []), gutter + `╭${"─".repeat(tubeWidth)}╮`, middle, gutter + `╰${"─".repeat(tubeWidth)}╯`];
			});
		} else {
			// Narrow screens retain the existing compact, wrapped presentation.
			quota = sections.quota.map((line, index) => {
				const window = windows[Math.floor(index / 2)];
				if (!window) return paint(line);
				if (index % 2) return theme.fg(window.resetAt !== null && window.resetAt <= now ? "warning" : "dim",
					" ".repeat(labelWidth + 2) + `重置 ${dates[Math.floor(index / 2)]}`);
				const label = windowLabel(window);
				return label + " ".repeat(labelWidth - visibleWidth(label)) + line.slice(label.length);
			});
			const overhead = Math.max(0, ...quota.filter((_line, index) => windows.length && index % 2 === 0).map((line) => visibleWidth(line) - 36));
			const barWidth = Math.max(1, Math.min(36, detailWidth - overhead));
			for (let index = 0; index < windows.length; index++) {
				const window = windows[index]!;
				const line = quota[index * 2]!.replace(/[█░]+/, quotaBar(window.remainingPercent, barWidth, true));
				const color = statusLine({ ...state, snapshot: { ...state.snapshot!, windows: [window] } }, now).color;
				quota[index * 2] = line.split(/([█░]+)/).map((part) => isLowQuota(window.remainingPercent) && /[█░]/.test(part)
					? theme.style(part, { fg: lowQuotaColor }) : theme.fg(color, part)).join("");
			}
		}
		const title = "🍧 Codex 额度";
		const summaryFits = framed && sections.summary !== null
			&& visibleWidth(title) + 2 + visibleWidth(sections.summary) <= contentWidth;
		const header = theme.fg("accent", title) + (summaryFits
			? " ".repeat(contentWidth - visibleWidth(title) - visibleWidth(sections.summary!)) + theme.fg("dim", sections.summary!) : "");
		const blocks: string[][] = [];
		if (!summaryFits && sections.summary) blocks.push(group([theme.fg("dim", sections.summary)], contentWidth));
		if (sections.status.length) blocks.push(group(sections.status.map((line) => theme.fg(state.error || state.stale ? "warning" : "dim", line)), contentWidth));
		if (quota.length) blocks.push(card(group([heading("订阅额度", HEADING_COLORS.quota), ...(useTubes && windows.length ? [""] : []), ...quota])));
		const reset = state.resetCredits;
		const resetColumns = Math.min(46, detailWidth);
		const resetPair = (left: string, right: string) => pair(left, right, resetColumns);
		const resetHeading = resetPair("🎟 " + heading("重置卡", HEADING_COLORS.cards), theme.fg("dim", sections.resetSummary));
		const notes = "仅显示接口返回记录，不推断完整历史。";
		const detail = sections.resets.slice();
		const records = state.phase === "offline" || state.phase === "not_logged_in" ? undefined : reset?.snapshot?.credits;
		if (records?.length) {
			// The source section places result/error notices before two lines per record.
			// Group only adjacent records of identical type and status, keeping original
			// indexes and the server's ordering for the subsequent selection dialog.
			const start = Number(!!state.resetUse) + Number(!!reset?.error);
			const labels = { available: "可用", used: "已使用", expired: "已过期", pending: "使用中", unknown: "状态未知" };
			const grouped: string[] = [];
			let previous = "";
			for (const [index, record] of records.entries()) {
				const key = `${record.fullReset}:${record.status}`;
				if (key !== previous) {
					if (grouped.length) grouped.push("");
					grouped.push(resetPair(`${record.fullReset ? "完全重置" : "重置卡"} · ${labels[record.status]}`,
						record.fullReset ? "7d + 5h" : ""));
					previous = key;
				}
				const time = record.status === "used" ? record.redeemedAt : record.expiresAt;
				const left = `#${index + 1} ${record.status === "used" ? "使用" : "到期"} ${localTime(time)}`;
				const right = record.status !== "available" ? "" : time === null ? "有效期未知"
					: time <= now ? "已到期，待刷新" : resetRemaining(time, now);
				grouped.push(right ? resetPair(left, right) : left);
			}
			detail.splice(start, records.length * 2, ...grouped);
		}
		const showNote = detail.includes(notes);
		const resets = [
			...group([resetHeading, ...(cards ? [""] : []), ...detail.filter((line) => line !== notes).map(paint)]),
		];
		const freshEmpty = button.reason === "no_usable_cards" && state.phase === "ready" && !state.stale && !state.error
			&& !reset?.stale && !reset?.error && reset?.snapshot?.availableCount === 0
			&& reset.snapshot.credits?.length === 0 && !state.resetUse?.warning;
		if (!button.enabled && !freshEmpty && !sections.resets.some((line) => line.trim() === button.hint)) {
			resets.push(...group([theme.fg(button.phase === "busy" ? "dim" : "warning", button.hint)]));
		}
		const label = button.enabled ? "[u 重置]" : button.phase === "busy" ? "[重置中…]" : "[重置不可用]";
		const styledButton = theme.style(truncateToWidth(label, detailWidth), button.enabled ? { fg: "accent", bold: true }
			: button.phase === "busy" ? { fg: "warning" } : { fg: "dim" });
		resets.push(center(styledButton, detailWidth));
		if (showNote) resets.push(...group([theme.fg("dim", notes)]));
		blocks.push(card(resets));
		const oauth = usesCodexSubscription(this.ctx);
		const fast = this.fast.summary(this.ctx.model, oauth);
		const metrics = this.fast.panelMetrics(this.ctx.model, oauth);
		const columns = Math.min(36, detailWidth);
		const fastPair = (left: string, right: string) => pair(left, right, columns);
		const unavailable = this.fast.enabled && this.fast.capability.kind !== "supported";
		blocks.push(card([
			...group([
				fastPair("⚡ " + heading("Fast", HEADING_COLORS.fast), theme.fg(unavailable ? "warning" : "text", fast.switchLabel)),
				...(cards ? [""] : []),
				fastPair("订阅额度消耗", metrics.quota),
				fastPair("模型速度", metrics.speed),
				...(cards ? [""] : []),
			]),
			center(theme.fg("dim", "仅当前会话"), detailWidth),
		]));
		const content = blocks.flatMap((block, index) => index ? ["", ...block] : block);
		const bodyHeight = height - (framed ? 6 : 1);
		this.maxOffset = Math.max(0, content.length - bodyHeight);
		this.offset = Math.min(this.offset, this.maxOffset);
		const body = content.slice(this.offset, this.offset + bodyHeight);
		if (!framed) return [...body, center(updated)].map((line) => truncateToWidth(line, width));
		const inner = width - 2;
		const row = (text: string) => {
			const value = truncateToWidth(` ${text}`, inner);
			return theme.fg("border", "│") + value + " ".repeat(Math.max(0, inner - visibleWidth(value))) + theme.fg("border", "│");
		};
		return [
			theme.fg("border", `╭${"─".repeat(inner)}╮`), row(header),
			theme.fg("border", `├${"─".repeat(inner)}┤`), ...body.map(row),
			theme.fg("border", `├${"─".repeat(inner)}┤`), row(center(updated)),
			theme.fg("border", `╰${"─".repeat(inner)}╯`),
		].map((line) => truncateToWidth(line, width));
	}

	handleInput(data: string): void {
		if (this.finished) return;
		if (data === "u" && !this.controller.getResetButton().enabled) {
			this.ctx.ui.notify(this.controller.getResetButton().hint, "warning");
			return;
		}
		if (data === "u" || matchesKey(data, "escape") || matchesKey(data, "return") || data === "q") {
			this.finished = true;
			this.done(data === "u" ? "use" : undefined);
		} else if (matchesKey(data, "up") || matchesKey(data, "down")) {
			this.offset = Math.max(0, Math.min(this.maxOffset, this.offset + (matchesKey(data, "up") ? -1 : 1)));
			this.tui.requestRender();
		} else if (matchesKey(data, "home") || matchesKey(data, "end")) {
			this.offset = matchesKey(data, "home") ? 0 : this.maxOffset;
			this.tui.requestRender();
		}
	}
}
