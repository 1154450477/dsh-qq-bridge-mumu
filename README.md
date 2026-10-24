# 通到 QQ（附带 MuMu 手机 MCP）

DSH 插件 **「通到 QQ」** ＋ 配套的 **mumu-mcp**（把 MuMu 模拟器里那台安卓，变成伙伴能用的 MCP 工具）。

这是两半，能分开用，也能凑一起用：

| 部分 | 干什么 | 怎么装 |
| --- | --- | --- |
| 根目录 `lib/`（DSH 插件） | 伙伴在 DSH 里说完话，自动发到 QQ；你在 QQ 里发的话，自动转进 DSH | DSH 插件，装完**重启一次 DSH** |
| `mumu-mcp/`（MCP server） | 让伙伴能看见并操作 MuMu 里那台手机：截图、点、按、看界面、装中文输入法 | 一个独立的 python 进程，DSH 用 MCP 挂上 |

**凑一起才有「她一边玩手机，一边还能回你消息」这个效果** —— 只装插件是普通聊天；加上 mumu-mcp，她能真的拿着手机玩。

---

## 一、装插件（通到 QQ）

```bash
dsh plugin --profile web remove dsh-qq-bridge-mumu
dsh plugin --profile web add github:1154450477/dsh-qq-bridge-mumu
```

> `--profile` 照你平时那个写（网页端 `web`，桌面端 `desktop`）。
> ⚠️ **先卸再装**，直接装可能拿到缓存里的旧副本。装完**重启一次 DSH**。

装完去 **设置 → 通到 QQ** 填几样东西就行：

- **目标会话**：选你平时跟她聊天那一间（设置页里能直接下拉挑，不用手填 id）
- **QQ 后端**：NapCat 或 SnowLuma 的地址，默认 `http://127.0.0.1:3000`
- **私聊 QQ**：她该发到哪个号
- **后端口令**：后端开了 access_token 才填，留空 = 不带认证头

设置存在 `~/.dsh/qq-bridge-mumu-config.json`，**不在插件代码里** —— 卸载重装不会丢。

## 收消息走哪条路：WS 推送优先，HTTP 轮询兜底

**推荐 WS（WebSocket 直连），快而且防抖兼容性好；HTTP 轮询防抖效果很差，只作兜底** —— 消息从 QQ 到插件是**推送**，一到就进防抖缓冲（实测 ~0.1 秒）；
HTTP 轮询要等后端的历史接口「看得见」那条消息（SnowLuma 实测滞后 6~7 秒），天生慢一截。

| | WS 直连（推荐） | HTTP 轮询（兜底） |
| --- | --- | --- |
| 延迟 | ~0.1 秒（事件一到就到） | 轮询间隔 + 后端历史可见性滞后（SnowLuma ~6 秒） |
| 依赖 | 后端开一个 WS 服务端口 | 只要 HTTP 接口在 |
| 断了怎么办 | 5 秒自动重连，重连期间轮询自动补 | 天生就在 |

**怎么开**：设置 → 通到 QQ → 打开「WS 直连」，地址填后端的 WS 服务端口（SnowLuma 默认 `ws://127.0.0.1:3001`，NapCat 在网页后台里加一个「正向 WebSocket 服务」）。
认证和 HTTP 共用同一个**后端口令**。

> 两个都开着也不冲突：WS 负责实时推送，轮询只在 WS 断线或漏推送时把漏掉的消息补进来（按消息 id 去重，不会重复转）。
> WS 实在连不上（老版本后端没开 WS）就只用 HTTP 轮询，功能一样，只是慢一截。

## 二、装 mumu-mcp（手机那半边）

要三样东西：

1. **MuMu 模拟器**（装在 D 盘也行，路径写在配置里）
2. **Python 3.11+**，外加一个 Pillow（截图裁剪/标注/拼图要用）
   ```bash
   pip install pillow
   ```
3. **配置**：把 `mumu-mcp/config.example.json` 复制成 `~/.dsh/mumu-mcp/config.json`，改 `mumu_manager_path`（MuMuManager.exe 的位置）

然后让 DSH 挂上这个 MCP server。**设置 → 插件 → MCP 页**新增一条：

| 填什么 | 值 |
| --- | --- |
| serverName | `mumu` |
| transport | `stdio` |
| command | 你的 python 路径（例：`C:\Python315\python.exe`） |
| args | `['<这个仓库>/mumu-mcp/server.py']` |
| cwd | `<这个仓库>/mumu-mcp` |
| toolCallTimeoutMs | `180000` |

挂上以后，工具名在模型侧是 `mcp__mumu__mumu_phone_*` 这类（`serverName` 改了就跟着变）。

---

## 三、她在玩手机的时候，你发消息她能接上吗

能，但得两半配合。原理就一句话：

> **她玩手机的时候不回你 ≠ 她没看见，是消息被排在队列里等她那一回合结束。**

所以做了这几件事：

1. **你发的消息先挂起，不硬等** —— 她在玩的时候，你那条先记进挂起队列，同时按冷却时间回你一句（「诶我在玩手机呢～等我一下下」）。回执是她的口气，能改。
2. **她每轮都能看见挂起的东西** —— 工具返回的尾巴上会带一句「有 N 条没回的消息」，她想回就回，不想回就一条命令全部忽略（不然它会一直挂在那儿反复提醒她）。
3. **喊停立刻收手** —— 你说「别玩了 / 收手 / 停 / 够了」，她当场收手，手机（模拟器）一起关掉。想让她只是先放下、手机留着，说「暂停 / 歇会儿」——**暂停不关手机**。
4. **她闲下来还有挂起的，主动提醒她去看** —— 同一批只提醒一次，提醒完顺手把这批标记成已处理，不会隔一分钟再翻出来一遍。
5. **手机已经在玩，就不打扰** —— 唤醒器（见下）掷骰子掷中要叫她玩，她已经在玩就跳过这一轮。

### 唤醒器（她自己想玩就去玩）

`mumu-mcp` 里有个自主玩调度器（默认关），也可以配一个独立的 **dsh-mumu-up** 插件 —— 判定条件跟 dsh-speak-up 一模一样，掷骰子掷中就往会话里送一句「手机在桌上没人管，我玩会儿去——刷一刷」，**由她自己决定**要不要真去玩。

---

## 四、mumu-mcp 能干什么（21 个工具）

| 工具 | 干什么 |
| --- | --- |
| `mumu_phone_status` | 模拟器在不在跑、adb 通没通、前台哪个应用、屏幕多大、中文输入法装好没、今天玩了多久 |
| `mumu_phone_screen` | 截当前屏，给她看 |
| `mumu_phone_frames` | 连着截几帧（做视频/看动态用），可拼成一张图 |
| `mumu_phone_ui` | dump 界面元素（文字、按钮、坐标），她才知道该点哪儿 |
| `mumu_phone_tap` | 点一下 —— 可以按坐标、按元素序号、按文字 |
| `mumu_phone_swipe` / `mumu_phone_scroll` | 滑动 / 上下滚 |
| `mumu_phone_text` | 输入文字（中文靠 ADBKeyboard，自动装） |
| `mumu_phone_key` | 系统键：home / back / enter / 锁屏… |
| `mumu_phone_app` | 启动 / 停掉 / 看某个应用 |
| `mumu_phone_system` | 亮度、音量、旋转、电池、IP… |
| `mumu_phone_notifications` | 看通知栏 |
| `mumu_phone_shell` | 跑一条 adb shell 命令（**默认关**，要用自己在配置里开） |
| `mumu_phone_play` | **开始玩手机**：定个目标、给个时长（默认 30 分钟） |
| `mumu_phone_exit` | **收手**：默认连手机（模拟器）一起关；只想先放下就用 `pause=true`，手机留着 |
| `mumu_phone_diary` | 记/读手机日记 |
| `mumu_phone_recent` | 最近干了啥 |
| `mumu_phone_messages` | 看挂起的消息；`mark_handled=true` 全部忽略 |
| `mumu_phone_say` | 往 QQ 直接发一条（不走主对话回合） |
| `mumu_phone_random_goal` | 从目标池里挑一个「玩什么」 |
| `mumu_phone_autoplay` | 自主玩：开/停/看状态/排计划 |

**收手 vs 暂停**：

| 你说 | 她会 | 手机 |
| --- | --- | --- |
| 「别玩了」「收手」「停」「够了」 | 立刻收手 | **关掉** |
| 「暂停」「先歇会儿」「待会儿再玩」 | 只放下 | **留着，不关** |

### mumu-mcp 的配置（`~/.dsh/mumu-mcp/config.json`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `mumu_manager_path` | 空 | MuMuManager.exe 的位置；留空会自动去 C/D 盘常见位置找 |
| `adb_path` | 空 | adb.exe；留空 = 用 MuMuManager 同目录那个 |
| `vm_index` | `0` | 用第几个模拟器实例 |
| `keep_window_hidden` | `false` | **false = 窗口留在屏幕上**（你能看着她玩）；true = 藏起来 |
| `start_timeout_sec` | `180` | 开机等多久（冷启动慢就调大） |
| `close_mumu_app_on_exit` | `true` | 收手时连 MuMu 主程序一起收掉 |
| `enable_shell_tool` | `false` | 放行 `mumu_phone_shell` |
| `daily_play_limit_minutes` | `0` | 每天最多玩几分钟；0 = 不限 |
| `control_port` | `8791` | 本机控制口（QQ 桥靠它问「她在不在玩」） |
| `autoplay_*` | 多数 `false` | 自主玩那一套（目标池、每日预算、活跃时段…） |

其余键在 `mumu-mcp/config.example.json` 里都有，默认值和说明都在那儿。

---

## 五、目录结构

```
dsh-qq-bridge-mumu/       ← DSH 插件（根目录就是插件本体）
├─ lib/
│  ├─ host.js             ← 主逻辑：收 QQ 消息、发 QQ 消息、手机模式、挂起队列
│  ├─ client.js           ← 设置页（React）
│  └─ selfupdate.mjs      ← 「检查更新」
├─ tests/                 ← 三个测试套件，不用装插件也能跑
│  ├─ 宿主半边.mjs
│  ├─ 网页半边.mjs
│  └─ 手机模式.mjs
└─ mumu-mcp/              ← MuMu 手机 MCP server
   ├─ server.py           ← 手写 MCP stdio server（JSON-RPC，每行一条）
   ├─ tools.py            ← 21 个工具的定义和实现
   ├─ control.py          ← 本机控制口（默认 8791）
   ├─ autoplay.py         ← 自主玩调度器
   ├─ vm/                 ← adb / mumu / screen / phone / ui / state / util
   ├─ assets/ADBKeyboard.apk
   └─ tests/              ← 零依赖冒烟客户端（直接跑真机）
```

## 六、自测

```bash
# 插件的三套测试（不需要装插件、不连 QQ）
node tests/宿主半边.mjs
node tests/网页半边.mjs
node tests/手机模式.mjs

# mumu-mcp：起真机跑一遍 10 个调用
cd mumu-mcp && python tests/test_client.py
```

## 七、常见问题

**装完插件没反应？** 忘了重启 DSH —— 插件是启动时加载的。

**QQ 那头一直 401 unauthorized？** 后端开了 access_token，设置里把「后端口令」填上。

**她说「目标会话没活着」？** 目标会话那间没打开，或被归档了。先去 DSH 打开那一间。

**她玩手机时窗口看不见？** `keep_window_hidden` 改成 `false`（默认就是 false）。

**MuMu 找不到？** `mumu_manager_path` 填 MuMuManager.exe 的完整路径。

**改了 `~/.dsh/` 里的配置不生效？** 插件每次读配置都是现读的，一般立即生效；MCP server 的配置要重启 DSH（它是被 DSH spawn 的）。

**她把「Time sampled…」「Elapsed since…」这种系统提示发到 QQ 了？** DSH 会把运行时元信息（时间采样、运行目录、文件策略等）作为文本块附在 assistant 消息里，插件在「盯回复」时会把这些块过滤掉（只认块首命中系统提示特征的文本，她正文里提到这些词不会被误杀）。如果你升级后还看到泄漏，确认装的是最新版并重启 DSH。

## 七点五、消息怎么变成「一次回复」（消息防抖机制）

她在 QQ 上收到你连发的几条消息时，**不会一条一条分开回**，而是凑成一批：

1. 消息进来先进缓冲，**等 3 秒**没有新消息（新消息会重置计时）才整批转进 DSH；
2. 防饿死：从第一条算起最多攒 30 秒必转；
3. 她正在回复时你又发消息：**取消旧回合，新旧消息合并重开一轮**——她看得到全部消息，不会照着旧语境说一半；
   但她这轮**已经想了超过 60 秒**就不取消了（长回合保护）：让她把想完的说完，你的消息先攒着，等她这轮结束自动转进；
4. 她这轮说的最后一句在回合结束时落回 QQ；DSH 附带的系统提示（时间采样等运行时元信息）会被过滤，不转发。

窗口数值在 `lib/host.js` 的 `防抖窗口`（默认 3000ms）、`回合上限`（默认 30000ms）、`长回合保护`（默认 60000ms）三个常量，改完要重启 DSH。

## 八、依赖

- DSH（插件 + MCP 宿主）
- 一个 OneBot 11 协议的 QQ 后端：SnowLuma 或 NapCat 都行
- 想玩手机那半边：MuMu 模拟器 + Python 3.11+ + Pillow

## 九、改动记录

见 [CHANGELOG.md](CHANGELOG.md)。

---

**原作**：[Yuuyuko-uu/dsh-qq-bridge](https://github.com/Yuuyuko-uu/dsh-qq-bridge)（插件部分，来自上游作者）
**手机那半边**：`mumu-mcp` 的内核来自 [AwayDAJIBA/astrbot_plugin_mumu_vm](https://github.com/AwayDAJIBA/astrbot_plugin_mumu_vm)，改成了 MCP 形态。
