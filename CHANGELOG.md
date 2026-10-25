# 更新日志

[简体中文](CHANGELOG.md) | [English](CHANGELOG.en.md)

## [1.0.0] - 2026-10-25

首个版本：合并 `pi-kimi`、`pi-deepseek` 与 `pi-codex` 为一个扩展，三个旧仓库已归档。

- 页脚只保留一个状态键 `pi-usage`，内容由当前模型所属 provider 决定：`deepseek` 显示 DeepSeek 余额，`moonshotai-cn` 显示 Kimi 余额，官方 `openai-codex` OAuth 订阅显示 Codex 额度与重置卡；其他 provider 清除状态并停止轮询。
- 命令只保留 `/pi-usage`（强制刷新并打开当前 provider 的面板）与 `/fast`（Codex 订阅的会话内 Fast 开关）；`/pi-kimi`、`/pi-deepseek`、`/pi-codex` 不再注册。
- Kimi 与 DeepSeek 共用同一套余额控制器（状态机、指数退避、10 秒超时、429 冷却、过期标记），各自保留原有的响应校验、金额精度与展示文案。
- Codex 保留额度窗口、重置卡（面板中 `u` 使用）与 Fast 能力目录，登录失效时继续轮询以自动恢复面板。
- 完整迁移原有离线测试并新增调度测试：状态键唯一、按 provider 切换、非用量 provider 清除、命令集合固定、`/fast` 在非 Codex 模型下只提示。
- 提供中英文文档与合并说明。

### 验证

- `tsc --noEmit` 通过。
- `node --test tests/*.test.ts`：247 项测试全部通过。
- 三个旧仓库的原有行为由迁移后的单元测试覆盖；旧仓库归档后不再单独维护。
