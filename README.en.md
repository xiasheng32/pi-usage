# pi-usage

[简体中文](README.md) | [English](README.en.md)

> **中文：** 一个 [pi](https://pi.dev) 扩展：按当前模型显示 DeepSeek / Kimi 账户余额或 Codex 订阅额度，并提供会话内的 `/fast` 开关。
>
> **English:** A [pi](https://pi.dev) extension that shows DeepSeek or Kimi account balances—or Codex subscription quota—for the active model, and adds a session-local `/fast` switch.

`pi-usage` merges the former `pi-kimi`, `pi-deepseek` and `pi-codex` extensions into one package: a single footer status key (`pi-usage`) and a single detail entry point (`/pi-usage`) whose content follows the provider of the current model. The three old repositories are archived; their history and documentation remain on GitHub.

## Features

- **One footer entry that follows the model**: an account balance for `deepseek` and `moonshotai-cn`, quota plus reset cards for the official `openai-codex` OAuth subscription. Switching to any other provider clears the entry and stops polling that provider.
- **`/pi-usage` detail panel**: forces a refresh and opens the panel for the active provider. DeepSeek shows total / granted / topped-up balance, Kimi shows available / voucher / cash balance, Codex shows quota windows, reset cards (`u` to consume one) and the Fast state.
- **`/fast` (Codex subscription only)**: `/fast on` and `/fast off` only affect the current session; new sessions start off. Any other model just receives a warning and no state changes.
- **Automatic refresh**: query at session start, poll every 60 seconds, and throttle to 30 seconds on agent settlement; failures use exponential backoff, requests time out after 10 seconds and 429 responses honour `Retry-After`.
- **No hardcoded credentials**: keys and OAuth tokens are resolved from pi's model registry at request time.
- **Display-only by default**: nothing changes tool execution or request content (`/fast` is the explicit exception and rewrites the Codex `service_tier`).

## Supported panels

| Active model provider | Footer | Panel |
| --- | --- | --- |
| `deepseek` | `🐳 DeepSeek 余额：¥110.00` | total, granted and topped-up balance, availability |
| `moonshotai-cn` | `🌙 Kimi 余额：¥50.00` | available, voucher and cash balance (net when cash is negative) |
| `openai-codex` (OAuth subscription) | `🍧 Codex 额度：…` | quota windows, reset cards, Fast tier and cost |
| anything else | none | `/pi-usage` reports that the model has no usage panel |

## Install

Requires Node.js >=22.19 and a pi build with the extension API (full offline suite on **1.2.0**, plus dynamic-catalog and lifecycle checks on **1.4.0**). No runtime dependencies are installed; pi provides the host packages.

1.2.0 gives the Codex detail panel compact centered cards, bars up to 36 columns and minimal reset keys, with light/dark and small-terminal layouts. It continues to preserve the host dynamic model catalog and refresh capability. Fast decorates host provider requests; it does not determine `/model` contents. Fast capabilities are still queried on demand and cached, not fetched unconditionally at every startup or used to show only Fast-capable models. Missing required host APIs leave the catalog untouched and only produce a Fast installation warning.

```bash
pi install git:github.com/xiasheng32/pi-usage
pi update git:github.com/xiasheng32/pi-usage   # if already installed
```

Restart pi or run `/reload` in an existing session.

### Migrating from the old packages

The three old extensions are archived; remove them before installing this package so the footer and commands are not duplicated:

```bash
pi remove git:github.com/xiasheng32/pi-kimi
pi remove git:github.com/xiasheng32/pi-deepseek
pi remove git:github.com/xiasheng32/pi-codex
pi install git:github.com/xiasheng32/pi-usage
```

- `/pi-kimi`, `/pi-deepseek` and `/pi-codex` are no longer registered; use `/pi-usage`. `/fast` keeps its pi-codex semantics.
- The footer key is now `pi-usage`; custom footer settings that referenced the old keys need updating.
- The session-local Fast preference is restored per session as before and survives provider switches.

## Usage

- After `pi` starts, the footer shows exactly one usage entry, matching the active model.
- `/pi-usage` forces a refresh and opens the panel: `Enter` / `Esc` (or `q`) closes it, `↑` / `↓` scroll and `Home` / `End` jump. Press `u` in the Codex panel to consume a reset card.
- `/fast on` enables Codex Fast (priority routing, subscription quota consumed at 2.5×) and `/fast off` disables it; both apply to the current session only.
- Without credentials the footer reads `🐳 DeepSeek 未配置` / `🌙 Kimi 未配置` or reports an expired Codex login, and the panel explains how to fix it.

### Codex detail layout (1.2.0)

- Three lightweight cards for subscription quota, reset cards and Fast, with teal, purple and blue headings and just one blank row between sections.
- Quota content is centered as a group while labels, bars and reset countdowns stay aligned. At normal width both bars use 36 columns; each window shows its remaining percentage above a countdown and local date. Same-year dates omit the year; cross-year dates retain it.
- A single-line reset key remains visible: `[u 重置]` (ready), `[重置不可用]` (disabled) or `[重置中…]` (busy). Only `u` opens the existing selection/confirmation flow; cards are never consumed automatically. Reasons and results appear separately.
- Fast remains read-only in a two-line summary; use `/fast on` / `/fast off` to change it. The update time stays in a fixed footer and every card record remains scrollable.
- The panel is capped at 68 columns. Inner card borders disappear below 40 columns or 16 terminal rows, and bars shrink to the available width. Missing history, unknown counts, stale caches and request failures never masquerade as zero cards or healthy state.

### Credentials

- DeepSeek: `DEEPSEEK_API_KEY`, or `/login deepseek` inside pi.
- Kimi: `MOONSHOT_API_KEY`, or `/login moonshotai-cn`.
- Codex: the official `openai-codex` OAuth login (`/login openai-codex`). Non-OAuth models and non-`chatgpt.com` endpoints never show quota or enable Fast.

### Refresh and states

- Query immediately on session start, then poll every 60 seconds; each agent settlement triggers a throttled (30 s) refresh.
- Requests time out after 10 seconds; network/server failures retry with exponential backoff (1 / 2 / 4 / 5 min cap); 429 responses enter a cooldown and show the remaining time.
- A failed refresh keeps the last successful snapshot marked `[过期]` and never renders unvalidated response content.
- With `PI_OFFLINE=1` or `pi --offline` no credential is resolved and no request is made; the panel explains the offline state.

## Development

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm test            # node --test tests/*.test.ts
npm run check       # both
```

The suite is fully offline: transports and clocks are injected, so no real endpoint is contacted. Layout:

```text
extensions/index.ts     status key, provider dispatch, /pi-usage and /fast
src/registry.ts         active model → panel resolution
src/balance/core.ts     shared balance controller (state machine, backoff, timeout, staleness)
src/balance/deepseek.ts DeepSeek endpoint and rendering adapter
src/balance/kimi.ts     Kimi endpoint and rendering adapter
src/codex/              Codex quota, reset cards and Fast
src/panels.ts           balance panel and Codex panel
```

## License

[MIT](LICENSE)
