# 通到 QQ（dsh-qq-bridge）

让 DSH 里的**大肥鱼**和 QQ 连起来：她在 DSH 里说完话，自动发到 QQ。

> ⚠ 现在只有**上半场**：`DSH → QQ`（大肥鱼说话 → 发到 QQ 私聊/群）。
> 反过来（`QQ → DSH`，你在 QQ 里回、转进 DSH 让她接着想）是下一半，还没做。

## 现在的行为

- 盯一个「目标会话」（就是「大肥鱼 × 小鱿鱼」那个 DSH 会话）。
- 大肥鱼在某**一整轮的最后一句**说完，就把这句原文发到 QQ。
- 发 QQ 走 **NapCat 的 OneBot HTTP**（`127.0.0.1:3000`），**不经过 Estrella（BOT鱼）**。
- 安全默认：**总开关 = 关、试运行 = 开** —— 不手动打开，一句都不会真的发到 QQ。

## 配置（现在得改文件，设置页在做了）

`%USERPROFILE%\.dsh\qq-bridge-config.json`：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| 总开关 | false | 关着 = 一句都不发 |
| 试运行 | true | 开着只记账，不真发 |
| 目标会话 | '' | 盯哪个会话（填 `session-…` 那串完整 id） |
| 私聊QQ | '' | 发到哪个私聊（QQ 号） |
| 群号 | '' | 发到哪个群（可空） |
| 转私聊 | true | 往私聊发 |
| 转群 | false | 往群发 |
| NapCat | `http://127.0.0.1:3000` | OneBot HTTP 接口（无 token） |

## 现在就能用的接口（还没有页面，先命令行试）

- `GET /dsh-qq-bridge/state` —— 看配置、日志、以及「连着的 QQ 是哪个号/昵称」。
- `POST /dsh-qq-bridge/save` —— 存配置（body 里给要改的键）。
- `POST /dsh-qq-bridge/test-send` —— **真发**一条测试句到已填的私聊/群（绕过试运行）。

## 自测（不装插件也能跑）

```bash
node tests/宿主半边.mjs
```

## 改动记录

**0.1.0** — 上半场 `DSH → QQ`：盯目标会话，大肥鱼一轮说完自动发 QQ（私聊/群），
带总开关 / 试运行 / `test-send` 探路，走 NapCat OneBot HTTP、不碰 BOT。