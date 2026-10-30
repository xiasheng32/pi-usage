# Changelog

[简体中文](CHANGELOG.md) | [English](CHANGELOG.en.md)

## [1.2.0] - 2026-10-30

- Redesigned the Codex detail panel as three compact centered cards, using teal, purple and blue for subscription quota, reset cards and Fast, with one blank row between sections.
- Lengthened the 5h / 7d bars to 36 columns at normal sizes, shrinking them together to fit available width while preserving label, bar and countdown alignment. Remaining percentages take priority; same-year dates omit the year while cross-year and unknown reset times remain explicit.
- Replaced the boxed reset action with a centered single-line `[u 重置]` / `[重置不可用]` / `[重置中…]` key. Simplified zero-card states without hiding the separate key, essential failure reasons, operation outcomes or any card records.
- Compressed the read-only Fast summary to two lines and kept the update footer fixed. Small terminals drop inner borders and wrap content; light/dark colors, low-quota warnings, scrolling and shortcuts remain supported.
- No changes to quota queries, reset consumption, Fast request semantics, other provider panels or default non-TUI details; no new runtime dependencies.

### Verification

- `npm run check`: type checking and all 258 offline tests passed, covering centering and column alignment, adaptive bars, all three key states, light/dark themes, ANSI, narrow/short terminals, long warnings, scrolling through every card and shortcuts.
- Actual `QuotaPanel` rendering with fixed data at 68 columns × 32 rows passed: two 36-column bars, a separate disabled key and a fixed footer remain visible, without real credential access or endpoint requests. Package and lockfile versions both match `1.2.0`.

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
