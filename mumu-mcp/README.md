# mumu-mcp（MuMu 手机 MCP server）

把 MuMu 模拟器里那台安卓，变成 DSH 能用的 MCP 工具集。模型侧工具名：`mcp__mumu__mumu_phone_*`。

**详细的说明在上一级** —— [../README.md](../README.md) 里有完整的安装步骤、21 个工具的说明、配置项和常见问题。

## 快速上手

```bash
# 1. 配置：复制一份改 MuMu 路径
cp config.example.json ~/.dsh/mumu-mcp/config.json

# 2. 冒烟（连真机跑一遍）
python tests/test_client.py
```

依赖：Python 3.11+ 、Pillow（`pip install pillow`）、MuMu 模拟器。

## 文件

| 文件 | 作用 |
| --- | --- |
| `server.py` | 手写 MCP stdio server（JSON-RPC 2.0，每行一条 JSON） |
| `tools.py` | 21 个工具的定义与实现 |
| `control.py` | 本机控制口（默认 8791）：QQ 桥靠它问「她在不在玩」 |
| `autoplay.py` | 自主玩调度器（默认关） |
| `vm/` | adb / mumu / screen / phone / ui / state / util |
| `assets/ADBKeyboard.apk` | 中文输入用的 ADBKeyboard（缺了会自动装） |
| `tests/` | 零依赖的 stdio 冒烟客户端 |
