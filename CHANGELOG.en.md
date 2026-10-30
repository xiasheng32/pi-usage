# Changelog

[简体中文](CHANGELOG.md) | [English](CHANGELOG.en.md)

## [1.1.0] - 2026-10-30

- Fast now decorates the host Codex provider, preserving its dynamic model catalog, cache restoration and later refreshes instead of replacing `/model` with a static list.
- Installation happens at `session_start`; ownership-aware shutdown/reload restores prior registrations. Repeated reloads do not accumulate wrappers or configuration layers, and cleanup respects later registrations by other extensions.
- Preserves OAuth, native SSE/WebSocket, request-bound credentials and `models.json` model additions/overrides and endpoints. Missing host providers or required APIs only produce a Fast installation warning, never a static catalog fallback.
- Fast capabilities remain queried on demand and cached: startup does not unconditionally fetch them, and they do not filter the models shown in `/model`.

### Verification

- `npm ci` completed; no dependency upgrades.
- Four focused test files: 62 tests passed, including dynamic-model startup, reload, both transports sending `default → priority → default`, and account switching.
- `npm run check`: type checking and all 252 offline tests passed.
- Installed Pi 1.4.0: 4 in-memory lifecycle checks passed, covering catalog preservation, newly refreshed models, prior native/legacy registration restoration and configuration overrides; no real credentials read or user caches/configuration written.

## [1.0.0] - 2026-10-25

First release: merges `pi-kimi`, `pi-deepseek` and `pi-codex` into one extension. The three old repositories are archived.

- A single footer key, `pi-usage`, whose content follows the active model's provider: `deepseek` shows the DeepSeek balance, `moonshotai-cn` shows the Kimi balance, the official `openai-codex` OAuth subscription shows Codex quota and reset cards, and any other provider clears the entry and stops polling.
- Only `/pi-usage` (force refresh plus the active provider's panel) and `/fast` (session-local Fast for the Codex subscription) are registered; `/pi-kimi`, `/pi-deepseek` and `/pi-codex` are gone.
- Kimi and DeepSeek share one balance controller (state machine, exponential backoff, 10 s timeout, 429 cooldown, staleness) while keeping their own payload validation, amount precision and display strings.
- Codex keeps quota windows, reset cards (`u` in the panel) and the Fast capability catalog, and keeps polling a failed login so the panel returns automatically.
- All previous offline tests were migrated and new dispatch tests cover the single status key, per-provider switching, clearing on unsupported providers, the fixed command set and `/fast` warnings on non-Codex models.
- Bilingual documentation with migration notes.

### Verification

- `tsc --noEmit` passed.
- `node --test tests/*.test.ts`: all 247 tests passed.
- Previous behaviour is covered by the migrated unit tests; the archived repositories are no longer maintained separately.
