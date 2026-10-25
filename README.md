# pi-usage

[简体中文](README.md) | [English](README.en.md)

> **中文：** 一个 [pi](https://pi.dev) 扩展：按当前模型显示 DeepSeek / Kimi 账户余额或 Codex 订阅额度，并提供会话内的 `/fast` 开关。
>
> **English:** A [pi](https://pi.dev) extension that shows DeepSeek or Kimi account balances—or Codex subscription quota—for the active model, and adds a session-local `/fast` switch.

`pi-usage` 合并了原 `pi-kimi`、`pi-deepseek` 与 `pi-codex` 三个扩展：只保留**一个**页脚状态键 `pi-usage`、**一个**详情面板入口 `/pi-usage`，面板内容由当前模型所属的 provider 决定。三个旧仓库已归档，历史与文档仍可在 GitHub 查看。

## 功能特性

- **跟随当前模型的单一页脚**：当前模型属于 `deepseek` 或 `moonshotai-cn` 时显示账户余额，属于官方 `openai-codex` 订阅（OAuth）时显示额度与重置卡；切到其他 provider 立即清除状态并停止轮询该 provider。
- **`/pi-usage` 详情面板**：强制刷新并打开当前 provider 的面板。DeepSeek 展示总余额 / 赠送余额 / 充值余额，Kimi 展示可用余额 / 代金券余额 / 现金余额，Codex 展示订阅额度窗口、重置卡（`u` 使用）与 Fast 状态。
- **`/fast`（仅 Codex 订阅）**：`/fast on` / `/fast off` 只影响当前会话，新会话默认关闭；非 Codex 订阅模型下只提示，不改变任何状态。
- **自动刷新**：会话启动时查询，之后每 60 秒轮询，并在每次 Agent 结束后按 30 秒节流刷新；失败按指数退避重试，单次请求 10 秒超时，429 遵循 `Retry-After`。
- **无硬编码密钥**：凭据统一从 pi 的模型注册表读取，仓库中不含任何 key。
- **不改变模型上下文**：全部为展示层逻辑，工具执行与请求内容不受影响（`/fast` 显式改写 Codex 的 `service_tier`）。

## 支持的面板

| 当前模型 provider | 页脚 | 面板内容 |
| --- | --- | --- |
| `deepseek` | `🐳 DeepSeek 余额：¥110.00` | 总余额、赠送余额、充值余额、可用状态 |
| `moonshotai-cn` | `🌙 Kimi 余额：¥50.00` | 可用余额、代金券余额、现金余额（现金为负时显示净额） |
| `openai-codex`（OAuth 订阅） | `🍧 Codex 额度：…` | 订阅额度窗口、重置卡、Fast 档位与消耗 |
| 其他 provider | 无 | `/pi-usage` 提示当前模型没有可用的用量面板 |

## 安装

需要 Node.js >=22.19 与提供扩展 API 的 pi（已验证 **1.2.0**）。运行时无需额外依赖，宿主包由 pi 提供。

```bash
pi install git:github.com/xiasheng32/pi-usage
pi update git:github.com/xiasheng32/pi-usage   # 已安装时更新
```

安装后重启 pi，或在已有会话中执行 `/reload`。

### 从旧包迁移

三个旧扩展已归档，请先移除再安装本包，避免重复的页脚与命令：

```bash
pi remove git:github.com/xiasheng32/pi-kimi
pi remove git:github.com/xiasheng32/pi-deepseek
pi remove git:github.com/xiasheng32/pi-codex
pi install git:github.com/xiasheng32/pi-usage
```

- 旧命令 `/pi-kimi`、`/pi-deepseek`、`/pi-codex` 不再注册，统一使用 `/pi-usage`；`/fast` 语义与 pi-codex 一致。
- 页脚状态键统一为 `pi-usage`，自定义 footer 配置中的旧键需要替换。
- 会话内的 Fast 偏好仍按原会话记录恢复，切换 provider 不会丢失。

## 使用

- 启动 `pi` 后，页脚只显示与当前模型匹配的那一条用量状态。
- 输入 `/pi-usage` 强制刷新并打开面板：`Enter` / `Esc`（或 `q`）关闭；内容超出时用 `↑` / `↓` 滚动，`Home` / `End` 跳至首尾。Codex 面板中按 `u` 使用一张重置卡。
- 输入 `/fast on` 开启 Codex Fast（priority 路由，订阅额度按标准 2.5 倍消耗），`/fast off` 关闭；两者都只作用于当前会话。
- 未配置凭据时页脚显示 `🐳 DeepSeek 未配置` / `🌙 Kimi 未配置` / Codex 登录失效，面板中给出具体修复提示。

### 凭据

- DeepSeek：`DEEPSEEK_API_KEY`，或在 pi 中执行 `/login deepseek`。
- Kimi：`MOONSHOT_API_KEY`，或在 pi 中执行 `/login moonshotai-cn`。
- Codex：使用 `openai-codex` 官方 OAuth 登录（`/login openai-codex`）。非 OAuth 或非 `chatgpt.com` 端点不会显示额度或启用 Fast。

### 刷新与状态

- 会话启动立即查询，之后每 60 秒轮询；每次 Agent 结束按 30 秒节流刷新一次。
- 请求 10 秒超时；网络或服务端失败按指数退避（1 / 2 / 4 / 5 分钟封顶）重试；429 期间进入冷却并展示剩余时间。
- 刷新失败时保留上一次成功快照并标记为 `[过期]`，不会展示未经校验的响应内容。
- `PI_OFFLINE=1` 或 `pi --offline` 下不解析凭据、不发起请求，面板显示离线说明。

## 开发与验证

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test tests/*.test.ts
npm run check       # 两者一起执行
```

测试全部离线：网络请求通过注入的 fetch/时钟完成，不会访问真实接口。目录结构：

```text
extensions/index.ts     状态键、provider 调度、/pi-usage 与 /fast
src/registry.ts         当前模型 → 面板的解析
src/balance/core.ts     共享余额控制器（状态机、退避、超时、过期标记）
src/balance/deepseek.ts DeepSeek 接口与展示适配
src/balance/kimi.ts     Kimi 接口与展示适配
src/codex/              Codex 额度、重置卡与 Fast 实现
src/panels.ts           余额面板与 Codex 面板
```

## 许可

[MIT](LICENSE)
