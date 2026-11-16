# pi-subagents-lean

属于 [pi-kit](https://github.com/MinarKotonoha/pi-kit) 的一部分：一次装齐四个扩展和四份配置模板，并且从零验证过。只想要这一个扩展时，按下面的步骤单独装。

延迟暴露（deferred）的子代理工具组：**默认零 token 占用**，用 `tool_search` 搜到才会进请求。

零占用是它和 `@thoth-agents/pi-subagents` 的唯一设计差异：那个包用 `exposure: "model-only"` 注册，
装到 `settings.json` 里就常驻 9 个工具声明（实测每次请求 +700 token）。本包把同一组能力注册为
`deferred`，未加载前系统提示里只有一句约 50 token 的发现提示。

## 能力

| 能力 | 本包 | 说明 |
| --- | --- | --- |
| markdown 定义代理 | ✅ | 全局 `<agent-dir>/agents/*.md`、项目 `.pi/agents/*.md`、`agents_dirs` 配置目录 |
| 内置 `general` | ✅ | 没有任何 markdown 定义时 `subagent_run` 依然可用 |
| 前台等待（task） | ✅ | 拿到子代理最终输出，带 15s 进度回调 |
| 后台运行 + 唤醒 | ✅ | 结束时以 followUp 消息把结果送回本会话 |
| 状态 / 结果 / 历史 | ✅ | `subagent_status`、`subagent_result`（可 `wait_seconds`）、`subagent_list_tasks` |
| 取消 | ✅ | 杀整棵进程树，`taskkill /T /F` 或 `kill(-pid)` |
| per-agent model / effort | ✅ | frontmatter `model:`、`effort:`，调用参数可覆盖 |
| 工具白名单 | ✅ | frontmatter `tools:`，默认 `read,bash,edit,write` |
| 续跑 | ⚙️ | `enable_continue: true` 才注册 `subagent_continue`，复用子会话 |
| 中断注入（`send_message`） | ❌ | 需要拦截子代理问答，本包不做 |
| 界面面板 | ❌ | 只提供 `/subagents` 文本列表 |

## 安装

```sh
pi install <克隆目录>/pi-subagents-lean
```

或用相对路径写进 `settings.json` 的 `packages`（和 `pi-act-first` 同样的写法）：

```json
"packages": ["..\\..\\dsh-plugins\\pi-subagents-lean"]
```

装好后新会话里可以：

- 让模型自己用 `tool_search` 搜 `delegate subagent`，然后 `subagent_run`；
- 或人工用 `/subagents` 看历史。

## 代理定义

`<agent-dir>/agents/reviewer.md`：

```markdown
---
name: reviewer
description: Reviews a diff and reports defects only.
tools: read,bash
model: open-design-responses/deepseek-v4.1-flash-eco
effort: low
---
You review one diff. Report only defects that would change behaviour, each with file, line and the failing case.
Never edit files. Reply with a numbered list or the single line "no defects found".
```

规则：

- 文件名必须与 `name` 一致，否则该代理被列为 `UNUSABLE` 并拒绝运行；
- 正文为空同样不可用（没有系统提示的代理没有意义）；
- 项目目录 `.pi/agents` 只在本项目被信任（`isProjectTrusted()`）时加载；
- 同名时优先级：项目 > `agents_dirs` > 全局 > 内置。

## 配置

全局 `<agent-dir>/subagents.json`，项目 `<cwd>/.pi/subagents.json`（后者覆盖前者同名键）：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `default_agent` | `general` | `subagent_run` 未给 `agent` 时使用 |
| `default_model` | 父会话模型 | `provider/id` 形式 |
| `default_effort` | 父会话 thinking 级别 | `off`…`max` |
| `default_tools` | `read,bash,edit,write` | 代理未声明 `tools` 且调用未给 `tools` 时使用 |
| `timeout_ms` | `900000` | 超时后杀整棵进程树 |
| `max_concurrency` | `4` | 同时运行的子代理数上限 |
| `enable_continue` | `false` | 是否注册 `subagent_continue` |
| `agents_dirs` | `[]` | 额外的代理目录（相对调用时的 cwd 解析） |

环境变量：`PI_SUBAGENT_DEPTH`（子进程内部记录嵌套深度，上限 2）、`PI_SUBAGENT_MAX_CAPTURE`（输出捕获上限，默认 48KB）、`PI_SUBAGENT_CLI`（指定子进程入口）。

## 状态与日志

每次任务写 `<agent-dir>/subagents/<id>.json`（代理、模式、模型、effort、工具、pid、起止时间、退出码）和 `<id>.log`（子进程的 stdout+stderr，尾部截断到 48KB）；子会话在 `<agent-dir>/subagents/sessions/<id>/`，可直接 `pi --resume` 打开。

## 与 npm 包的取舍

- 本包不给模型注入“何时使用子代理”的用法说明（那 9 条 schema 本身就常驻成本）；发现提示只说“用 `tool_search` 找”。
- 不实现 `subagent_send_message` / `subagent_extend` / `subagent_reply`：中断注入需要拦截子代理的问答回合，代价大于收益。
- 没有 TUI 面板，只有 `/subagents` 文本列表。

## 实测：`default_effort` 降档省不省钱

在同一台机器、同一网关（deepseek-v4.1-flash-eco）上用同一任务（子代理读 `src/` 全部文件并写出 `docs/API.md`）各跑 3 次，只改 `default_effort`：

| 子代理档位 | 输出 token（3 次） | 子代理消息数 | 缓存读 | 主会话墙钟 |
| --- | --- | --- | --- | --- |
| `high` | 1,832 / 2,248 / 1,771（中位 1,832） | 8 / 10 / 10 | 62K | 57 / 62 / 60 s |
| `medium` | 3,156 / 1,467 / 1,781（中位 1,781） | 9 / 6 / 8 | 51K | 72 / 46 / 60 s |

结论：输出 token 只降 3%（落在任务方差里），墙钟不变，唯一稳定的一项是缓存读降约 19%——子代理每轮都要重放上下文，档位低一点，重放的思考块就短一点。所以 `default_effort` 应当当作"长任务（10 轮以上）减少重放"的旋钮，**不要当作省钱开关**；短任务上它只改变噪声。

真正决定子代理成本的是任务切分：一个子代理 8–10 轮、每轮 5–7K 输入，等于父会话付了一次完整前缀；把它拆成"每个文件一个子代理"会让输入涨到三倍。只在**并行、独立、规格明确**的活上派子代理。

## 已知限制

- 子代理是另一个 `pi` 进程，冷启动约 6-8s；只在单次任务超过这个启动开销时才划算。
- 后台模式靠 `sendUserMessage(..., { deliverAs: 'followUp' })` 唤醒父会话；父会话已经退出（例如 `-p` 一次性运行）时唤醒会失败，只能事后用 `subagent_result` 取结果。
- 父会话被杀死时，运行中的子进程变成孤儿；用 `subagent_cancel` 或重启前先 `taskkill` 清理。

## 从 GitHub 安装

```bash
git clone https://github.com/MinarKotonoha/pi-subagents-lean.git <克隆目录>/pi-subagents-lean
```

克隆后把这个目录加进 `~/.pi/agent/settings.json` 的 `packages` 里（即上文的路径写法），重启 pi 生效。插件走 `pi.extensions` 声明，不需要编译。

