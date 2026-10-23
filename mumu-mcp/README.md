# mumu-mcp —— MuMu 手机 MCP Server（stdio，零第三方依赖）

> 本仓库是**独立版**（standalone）：只含 MCP server 本体，不绑 QQ 桥。
> 配套的 DSH 插件见 [dsh-qq-bridge-mumu](https://github.com/1154450477/dsh-qq-bridge-mumu)（QQ 桥 + 手机互通）、[dsh-mumu-up](https://github.com/1154450477/dsh-mumu-up)（手机唤醒器）。
> 挂进 DSH 后模型侧工具名：`mcp__mumu__mumu_phone_*`。

把 MuMu 模拟器里的一台安卓机，变成 MCP 工具集，交给 DSH（dsh-mcp-client）或其他 MCP 宿主使用。
模型侧工具名：`mcp__mumu__mumu_phone_*`。

## 组成

| 文件 | 作用 |
| --- | --- |
| `server.py` | 手写 MCP stdio server：JSON-RPC 2.0，每行一条 JSON；实现 initialize / tools/list / tools/call / ping 等 |
| `tools.py` | 18 个工具的定义与实现（TOOL_SPECS + HANDLERS + Service） |
| `vm/` | 复用 AstrBot 插件 astrbot_plugin_mumu_vm 的核心模块（adb / mumu / screen / phone / ui / state / util） |
| `assets/ADBKeyboard.apk` | 中文输入用的 ADBKeyboard（缺失时自动安装） |
| `tests/test_client.py` | 零依赖的 stdio 冒烟客户端（直接跑真机） |
| `config.example.json` | 配置样例；实际生效目录 `~/.dsh/mumu-mcp/config.json` |

## 运行

```bash
python server.py          # 走 stdin/stdout 的 JSON-RPC
python test_client.py     # 冒烟：真机跑一遍 10 个调用
```

依赖：Python 3.11+ + Pillow（截图裁剪/标注/拼图用，`pip install pillow`）。

## 在 DSH 里挂载

设置 → 插件 → MCP 页新增一条（或写进 profile 的 cordis.patch.yml）：

```yaml
- insert:
    - id: mcp-mumu
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: mumu
        transport: stdio
        command: <你的python路径>
        args: ['<这个仓库>/server.py']
        cwd: <这个仓库>
        env:
          MUMU_MANAGER_PATH: '<MuMuManager.exe 的位置>'
          MUMU_DATA_DIR: '~/.dsh/mumu-mcp'
        toolCallTimeoutMs: 180000
        failOnStartupError: false
        reconnect:
          enabled: true
```

> 宿主会清洗子进程环境（去掉 `*KEY|*PASSWORD|*SECRET|*TOKEN*` 与 `DSH_*`），再合并上面 `env` 里的变量。

## 配置

优先级：环境变量 > `~/.dsh/mumu-mcp/config.json` > 内置默认值。

| 键 | 环境变量 | 默认 | 说明 |
| --- | --- | --- | --- |
| mumu_manager_path | MUMU_MANAGER_PATH | 自动探测 C:/D 盘 | MuMuManager.exe 路径 |
| adb_path | MUMU_ADB_PATH | MuMuManager 同目录 adb.exe | adb 可执行文件 |
| vm_index | MUMU_VM_INDEX | 0 | 用哪个模拟器实例 |
| keep_window_hidden | MUMU_KEEP_WINDOW_HIDDEN | true | true=藏起模拟器窗口只让 Agent 看画面；**false=窗口留在屏幕上，主人可以盯着看**（本机现为 false） |
| start_timeout_sec | MUMU_START_TIMEOUT_SEC | 180 | 等安卓启动上限 |
| close_mumu_app_on_exit | MUMU_CLOSE_APP_ON_EXIT | true | 收手时结束 MuMu 进程 |
| enable_shell_tool | MUMU_ENABLE_SHELL_TOOL | false | 是否允许执行 adb shell |
| daily_play_limit_minutes | MUMU_DAILY_LIMIT_MINUTES | 0（不限） | 每日玩手机时长上限 |
| mode_default_minutes | — | 10 | mumu_phone_play 默认限时 |
| control_port | MUMU_CONTROL_PORT | 8791 | 本机控制口端口（给 QQ 桥用） |
| dsh_http_url | MUMU_DSH_HTTP_URL | http://127.0.0.1:3080 | DSH 的 HTTP 地址 |
| qq_say_path | — | /dsh-qq-bridge-mumu/say | 真发 QQ 的接口 |
| qq_turn_path | — | /dsh-qq-bridge-mumu/turn | 起一轮对话的接口 |
| pending_max_age_hours | — | 3 | 挂起消息留多久 |
| autoplay_enable | MUMU_AUTOPLAY_ENABLE | false | 自主玩手机总开关 |
| autoplay_goals | MUMU_AUTOPLAY_GOALS | 刷一刷,玩游戏,看抖音,逛taptap | 目标池（逗号分隔，轮转） |
| autoplay_session_minutes | — | 20 | 每轮玩多久 |
| autoplay_daily_budget_minutes | MUMU_AUTOPLAY_BUDGET_MINUTES | 90 | 每日自主玩时长上限 |
| autoplay_runs_per_day | — | 3 | 每日最多几轮 |
| autoplay_idle_minutes | MUMU_AUTOPLAY_IDLE_MINUTES | 30 | 你多久没找她才算是空闲 |
| autoplay_active_hours | — | 09:00-23:30 | 允许自主玩的时段 |

## 工具一览（21）

观察：`mumu_phone_status` / `mumu_phone_screen` / `mumu_phone_frames` / `mumu_phone_ui`
操作：`mumu_phone_tap` / `mumu_phone_swipe` / `mumu_phone_scroll` / `mumu_phone_text` / `mumu_phone_key`
系统：`mumu_phone_app` / `mumu_phone_system` / `mumu_phone_notifications` / `mumu_phone_shell`（默认关）
会话：`mumu_phone_play` / `mumu_phone_exit` / `mumu_phone_diary` / `mumu_phone_recent` / `mumu_phone_autoplay`
互通：`mumu_phone_messages`（看待回的消息）/ `mumu_phone_say`（真发 QQ）/ `mumu_phone_random_goal`（从目标池抽一个）

## 手机模式互通（和 dsh-qq-bridge-mumu 配对）

她玩手机时，你在 QQ 说的话不再石沉大海 —— 走 pending 队列：

1. **入队**：QQ 桥发现 MuMu 正在玩，就把你的消息 POST 到本机的控制口（`POST /pending`），并按冷却时间回你一句（她自己的口气）。队列存在 `state.json` 里，默认留 3 小时。
2. **她能看到**：每个工具的返回尾部都会带一段 pending 提示（`mumu_phone_messages` 可查，`action=handled` 可标记已读）。
3. **回你**：她要回你时用 `mumu_phone_say(text=..., msg_id=...)` —— 这条会经 QQ 桥的 `/dsh-qq-bridge-mumu/say` 真发到 QQ，并自动把那条挂起标记成已处理。
4. **收手**：QQ 桥命中停手关键词时 POST `/exit`，她立刻收手并回「好，手机收起来了。」

本机控制口（默认 127.0.0.1:8791）：

| 路径 | 作用 |
| --- | --- |
| GET /state | 模式 / pending / 每日额度 / 计划 |
| GET /pending | 挂起列表 |
| POST /pending | 加一条挂起 |
| POST /pending/handled | 标记已处理 |
| POST /exit | 收手（记日记、记时长） |

## 自主玩（随机玩手机）

`autoplay_enable` 默认 **关**。打开后 `autoplay.py` 会按活跃时段（默认 09:00-23:30）、每日时长上限、每日次数、以及「你多久没找她聊了」（默认 30 分钟没消息才算空闲）来决定要不要自己开一轮；目标从目标池里轮转取（默认：刷一刷 / 玩游戏 / 看抖音 / 逛taptap）。

> **可以被 [dsh-mumu-up](https://github.com/1154450477/dsh-mumu-up) 接管**：装了手机唤醒器的话，建议别开这里的 `autoplay_enable`——mumu-up 自己会掷骰决定什么时候叫她玩（峰谷命中线 / 没中加成 / 时机因子那套判定，比这里的定时轮询更像真人），两套同时开会重复叫她。定时计划（`mumu_phone_autoplay schedule`）不受影响，照常到点开。

## 数据落在哪

`~/.dsh/mumu-mcp/`：`config.json`（配置）、`state.json`（模式/日记/流水）、`shots/`（截图）、`mumu-mcp.log`（日志）。

## 已知限制

- `mumu_phone_autoplay` 只登记计划，不做后台常驻；到点由 Agent 自己决定要不要开始。
- `mumu_phone_shell` 默认关闭，需主人在配置里显式打开。
- 模拟器窗口默认隐藏，方便 Agent 独占画面；想自己看就 `keep_window_hidden: false`。


### 控制口多出来的两个字段（0.3.7）

- `playing`（bool）：她是不是还在玩手机——模式开着 **或** 3 分钟内动过手机（主人喊停后那一回合还没收手时也算）。
- `forced`（bool）：主人喊停之后为 true，此时 `mumu_phone_screen/tap/ui/...` 这些玩手机的工具会直接拒掉，她那一回合就会收尾，主会话空出来，排队等她的消息立刻能轮到。


### 收手 vs 暂停（手机关不关）

- **收手**：`mumu_phone_exit`（默认）→ 结束手机模式，并把 MuMu 模拟器关掉（`close_mumu_app_on_exit=true` 时连 MuMu 主程序一起收掉）。主人喊「别玩了 / 收手 / 停 / 够了」也走这条。
- **暂停**：`mumu_phone_exit(pause=true)` → 只结束手机模式，**模拟器留着不关**，待会儿想玩接着玩。主人说「暂停 / 歇会儿 / 等会儿再玩」走这条（由 QQ 桥转成控制口 `/exit` 带 `pause=true`）。
- 收手或暂停之后，`mumu_phone_status` 不会再把刚关掉的模拟器重新开机（只有手机模式开着时才会去连/开机）。

### 挂起消息队列（她玩手机时你在 QQ 说的话）

- 你在她玩手机时发的消息，QQ 桥会先 POST 到控制口 `/pending` 挂起来（不排进 DSH 队列），她那边在工具返回的尾巴里能看见。
- 她闲下来时，QQ 桥每 2 秒扫一次队列：**只提醒没提醒过的新消息**；提醒完顺手 POST `/pending/handled` 把这批标掉（`control.py:92`），所以同一批消息不会一遍遍往回送。
- 她想回就用 `mumu_phone_say(msg_id=..., text=...)` 直发 QQ（不用等这一轮结束）；不想回就 `mumu_phone_messages(mark_handled=true)` 全部忽略。提醒文案里带着每条的 id。
- 挂起消息 3 小时自动过期（`vm/state.py` 的 `unhandled_pending`），最多取最近 10 条。

### 窗口可见（主人盯着看）

- `keep_window_hidden: false` → 她玩手机时 MuMu 窗口**留在屏幕上**，不隐藏、不最小化（主人本机已这样配）。
- 窗口常常晚于安卓启动才建好，所以代码里 `show_window_retry()` 会连着叫几次（每 1.5 秒一次，共 3 次），确保窗口真的露出来而不是「叫了个寂寞」。
- 收手关手机时 MuMu 进程会被收掉，窗口随之消失；暂停（`pause=true`）不关，窗口继续留着。
