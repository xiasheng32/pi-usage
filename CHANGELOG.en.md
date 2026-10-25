# Changelog

[简体中文](CHANGELOG.md) | [English](CHANGELOG.en.md)

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
