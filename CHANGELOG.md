# 更新日志

[简体中文](CHANGELOG.md) | [English](CHANGELOG.en.md)

## [1.1.0] - 2026-10-30

- Fast 改为包装宿主现有 Codex provider，保留动态模型目录、缓存恢复和后续刷新；不再用静态清单覆盖 `/model`。
- 在 `session_start` 安装，shutdown/reload 时按所有权撤销并恢复先前注册；重复 reload 不累积包装或配置层，不覆盖其他扩展的后续注册。
- 保留 OAuth、原生 SSE/WebSocket、请求凭据绑定、`models.json` 模型增补/覆盖与端点设置。缺少宿主 provider 或必要 API 时只提示 Fast 无法安装，不替换模型目录。
- Fast 能力目录仍按需查询并缓存，不是每次启动强制联网，也不用于筛选 `/model` 中的模型。

### 验证

- `npm ci` 完成；未升级依赖。
- 四个针对性测试文件：62 项通过，覆盖动态模型启动、reload、两种传输的 `default → priority → default` 和账号切换。
- `npm run check`：类型检查与全部 252 项离线测试通过。
- 本机 Pi 1.4.0：4 项纯内存生命周期检查通过，覆盖目录保留、刷新新增模型、先前 native/legacy 注册恢复及配置覆盖；不读取真实凭据或写入用户缓存/配置。

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
