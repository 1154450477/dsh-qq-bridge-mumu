#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MuMu 手机 MCP server —— stdio 传输，零第三方依赖。

由 DSH 的 dsh-mcp-client 以 stdio 方式拉起，暴露 mumu_phone_* 工具。
协议：JSON-RPC 2.0 over stdin/stdout（每行一条 JSON）。
"""
from __future__ import annotations

import asyncio
import json
import re
import sys
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from tools import TOOL_SPECS, build_registry  # noqa: E402

SERVER_NAME = "mumu-phone"
SERVER_VERSION = "1.0.1"
SUPPORTED_PROTOCOLS = (
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
)
DEFAULT_PROTOCOL = "2025-06-18"

INSTRUCTIONS = """你现在可以操作一台 MuMu 安卓手机（模拟器里的一台安卓机）。
- 先观察再动手：mumu_phone_screen 看一眼当前画面，mumu_phone_ui 看可点的元素，再用 mumu_phone_tap 按坐标或文字点。
- 中文输入用 mumu_phone_text（自动切 ADBKeyboard），按键用 mumu_phone_key，滑动用 mumu_phone_swipe / mumu_phone_scroll。
- 看视频/动态用 mumu_phone_frames 连续采样（先粗看再细看）。
- 像真人一样用：浏览、点击、滑动、输入都行；但不要支付/转账/输支付密码、不要改账号安全设置、不要点广告装未知应用。
- 遇到登录/验证码/付费墙就退出这个 App，换一个玩。
- 每次操作后看一眼结果；界面没变化就换个方式（截图确认、UI 树、返回键）。
- 玩够了调 mumu_phone_exit 收手（只在文字里说结束不算收手）：收手会把手机（模拟器）一起关掉；只想先放下手机、待会儿再玩，就调 mumu_phone_exit(pause=true)，手机会留着不关。收手前的收获写进 mumu_phone_diary。
- 工具返回里的图片就是手机屏幕当前画面，坐标与图片同尺度。
- 对方在你玩手机时发来的话会挂在队列里，工具返回的尾巴会提醒你；用 mumu_phone_messages 看，mumu_phone_say 直接回；不想回就 mumu_phone_messages(mark_handled=true) 全部忽略，别让它一直挂在队列里反复提醒你。
- 你这一轮最后那段话也会被发到 QQ：别长篇复述操作过程，一句话就行；要正式回对方的话用 mumu_phone_say。
- 对方说「别玩了 / 收手 / 停 / 够了 / 回来」就立刻调 mumu_phone_exit 收手。"""


def log(msg) -> None:
    try:
        sys.stderr.write("[mumu-mcp] " + str(msg) + "\n")
        sys.stderr.flush()
    except Exception:
        pass


def write_json(obj) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


class McpServer:
    def __init__(self):
        self.registry = build_registry()
        self.protocol = DEFAULT_PROTOCOL

    def _ok(self, mid, result):
        return {"jsonrpc": "2.0", "id": mid, "result": result}

    def _err(self, mid, code, message):
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": str(message)}}

    def _initialize(self, params):
        want = (params or {}).get("protocolVersion")
        want = str(want or "")
        if want in SUPPORTED_PROTOCOLS:
            self.protocol = want
        elif re.match(r"^20\d{2}-\d{2}-\d{2}$", want):
            # 服务器与版本无关的协议细节，回显客户端要的版本避免 SDK 断开
            self.protocol = want
        else:
            self.protocol = DEFAULT_PROTOCOL
        return {
            "protocolVersion": self.protocol,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            "instructions": INSTRUCTIONS,
        }

    async def _call_tool(self, params):
        params = params or {}
        name = str(params.get("name") or "")
        args = params.get("arguments") or {}
        if not isinstance(args, dict):
            args = {}
        handler = self.registry.get(name)
        if handler is None:
            return {
                "content": [{"type": "text", "text": "未知工具：" + name}],
                "isError": True,
            }
        try:
            contents = await handler(args)
            if not isinstance(contents, list):
                contents = [{"type": "text", "text": str(contents)}]
            return {"content": contents, "isError": False}
        except Exception as exc:
            detail = "".join(traceback.format_exception_only(type(exc), exc)).strip()
            log("tool " + name + " failed: " + detail)
            return {
                "content": [{"type": "text", "text": "工具执行失败：" + detail}],
                "isError": True,
            }

    async def dispatch(self, msg):
        method = msg.get("method")
        mid = msg.get("id")
        if method is None:
            return None
        if "result" in msg or "error" in msg:
            return None
        params = msg.get("params") or {}
        if method == "initialize":
            return self._ok(mid, self._initialize(params))
        if method in ("notifications/initialized", "initialized"):
            return None
        if method == "ping":
            return self._ok(mid, {})
        if method == "tools/list":
            return self._ok(mid, {"tools": list(TOOL_SPECS)})
        if method == "tools/call":
            return self._ok(mid, await self._call_tool(params))
        if method == "resources/list":
            return self._ok(mid, {"resources": []})
        if method == "resources/templates/list":
            return self._ok(mid, {"resourceTemplates": []})
        if method == "prompts/list":
            return self._ok(mid, {"prompts": []})
        if method == "logging/setLevel":
            return self._ok(mid, {})
        if mid is None:
            return None
        return self._err(mid, -32601, "Method not found: " + str(method))


def _stdin_reader_thread(loop, queue):
    """在后台线程里读 stdin（Windows 上 asyncio 不能直接接管道）。"""
    try:
        for line in sys.stdin:
            loop.call_soon_threadsafe(queue.put_nowait, line)
    except Exception as exc:
        log("stdin reader stopped: " + repr(exc))
    try:
        loop.call_soon_threadsafe(queue.put_nowait, None)
    except Exception:
        pass


async def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    server = McpServer()
    # 本地控制口（给 dsh-qq-bridge-mumu 查手机模式、入队消息、结束手机模式）+ 自主玩调度器
    try:
        from tools import service as _service
        import control as _control
        import autoplay as _autoplay
        _端口 = int((_service().cfg or {}).get("control_port") or 8791)
        _control.启动(_端口)
        _autoplay.启动()
    except Exception as exc:
        log("控制口/自主玩调度起不来: " + repr(exc))
    loop = asyncio.get_running_loop()
    try:
        from tools import service as _svc

        _svc().loop = loop
    except Exception:
        pass
    queue = asyncio.Queue()
    loop.run_in_executor(None, _stdin_reader_thread, loop, queue)
    log("mumu-mcp ready, tools=" + str(len(TOOL_SPECS)))
    while True:
        line = await queue.get()
        if line is None:
            break
        text = line.decode("utf-8", "replace").strip() if isinstance(line, bytes) else str(line).strip()
        if not text:
            continue
        try:
            msg = json.loads(text)
        except Exception:
            log("skip malformed json line")
            continue
        if not isinstance(msg, dict):
            continue
        try:
            resp = await server.dispatch(msg)
        except Exception as exc:
            mid = msg.get("id")
            resp = server._err(mid, -32603, "internal error: " + repr(exc)) if mid is not None else None
            log("dispatch error: " + repr(exc))
        if resp is not None:
            write_json(resp)
    log("mumu-mcp exiting")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    # 阻塞的 stdin 读取线程会让解释器退出时抢 stdout 锁，直接硬退干净
    try:
        import os
        sys.stdout.flush()
        os._exit(0)
    except Exception:
        pass
