# -*- coding: utf-8 -*-
"""mumu-phone MCP 工具实现：复用 astrbot_plugin_mumu_vm 的 vm/ 模块（adb、MuMu 控制、UI 树、截图）。"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import time
from pathlib import Path

from vm.phone import Phone
from vm.state import SessionState

HERE = Path(__file__).resolve().parent

DEFAULTS = {
    "mumu_manager_path": "",
    "adb_path": "",
    "ffmpeg_path": "",
    "vm_index": 0,
    "keep_window_hidden": True,
    "start_timeout_sec": 180,
    "close_mumu_app_on_exit": False,
    "shutdown_on_exit": False,
    "auto_install_adb_keyboard": True,
    "text_input_ime": "com.android.adbkeyboard/.AdbIME",
    "enable_shell_tool": False,
    "shell_output_max_chars": 6000,
    "single_frame_max_width": 1280,
    "burst_max_frames": 20,
    "frames_max_count": 24,
    "frames_max_duration_sec": 20,
    "frames_max_images": 8,
    "frames_image_width": 768,
    "frames_sheet_tile_width": 480,
    "grid_max_width": 2000,
    "grid_label_frames": True,
    "daily_play_limit_minutes": 0,
    "mode_default_minutes": 10, # 默认玩 10 分钟（2026-10-23 主人定的）
    "tool_call_timeout_sec": 180,
    "control_port": 8791,
    "dsh_http_url": "http://127.0.0.1:3080",
    "qq_say_path": "/dsh-qq-bridge-mumu/say",
    "qq_turn_path": "/dsh-qq-bridge-mumu/turn",
    "qq_agent_state_path": "/dsh-qq-bridge-mumu/agent-state",
    "autoplay_enable": False,
    "autoplay_goals": "刷一刷,玩游戏,看抖音,逛taptap",
    "autoplay_session_minutes": 20,
    "autoplay_daily_budget_minutes": 90,
    "autoplay_runs_per_day": 3,
    "autoplay_idle_minutes": 30,
    "autoplay_active_hours": "09:00-23:30",
    "autoplay_check_sec": 60,
    "pending_max_age_hours": 3,
}

ENV_MAP = {
    "MUMU_MANAGER_PATH": ("mumu_manager_path", str),
    "MUMU_ADB_PATH": ("adb_path", str),
    "MUMU_FFMPEG_PATH": ("ffmpeg_path", str),
    "MUMU_VM_INDEX": ("vm_index", int),
    "MUMU_KEEP_WINDOW_HIDDEN": ("keep_window_hidden", bool),
    "MUMU_START_TIMEOUT_SEC": ("start_timeout_sec", int),
    "MUMU_CLOSE_APP_ON_EXIT": ("close_mumu_app_on_exit", bool),
    "MUMU_SHUTDOWN_ON_EXIT": ("shutdown_on_exit", bool),
    "MUMU_ENABLE_SHELL_TOOL": ("enable_shell_tool", bool),
    "MUMU_DAILY_LIMIT_MINUTES": ("daily_play_limit_minutes", int),
    "MUMU_DATA_DIR": (None, str),
    "MUMU_CONTROL_PORT": ("control_port", int),
    "MUMU_DSH_HTTP_URL": ("dsh_http_url", str),
    "MUMU_AUTOPLAY_ENABLE": ("autoplay_enable", bool),
    "MUMU_AUTOPLAY_GOALS": ("autoplay_goals", str),
    "MUMU_AUTOPLAY_IDLE_MINUTES": ("autoplay_idle_minutes", int),
    "MUMU_AUTOPLAY_BUDGET_MINUTES": ("autoplay_daily_budget_minutes", int),
}


def _as_bool(value) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def _log(msg) -> None:
    try:
        import sys

        sys.stderr.write("[mumu-mcp] " + str(msg) + "\n")
        sys.stderr.flush()
    except Exception:
        pass


class _Logger:
    """把模块级 _log 函数包装成带 .info/.warning/.error/.debug 的 logger 对象。"""

    def info(self, msg):
        _log(msg)

    def warning(self, msg):
        _log(msg)

    def error(self, msg):
        _log(msg)

    def debug(self, msg):
        _log(msg)


def load_config():
    data_dir = Path(
        os.environ.get("MUMU_MCP_DATA_DIR") or (Path.home() / ".dsh" / "mumu-mcp")
    )
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    cfg = dict(DEFAULTS)
    cfg_file = data_dir / "config.json"
    if cfg_file.exists():
        try:
            user = json.loads(cfg_file.read_text(encoding="utf-8"))
            if isinstance(user, dict):
                cfg.update(user)
        except Exception as exc:
            _log("config.json 读取失败: " + repr(exc))
    for env_key, (cfg_key, cast) in ENV_MAP.items():
        raw = os.environ.get(env_key)
        if raw is None or raw == "" or cfg_key is None:
            continue
        try:
            cfg[cfg_key] = cast(raw) if cast is not bool else _as_bool(raw)
        except Exception:
            pass
    cfg["mumu_manager_path"] = str(cfg.get("mumu_manager_path") or "")
    cfg["adb_path"] = str(cfg.get("adb_path") or "")
    return cfg, data_dir


def _t(text) -> dict:
    return {"type": "text", "text": str(text)}


def _img(png: bytes, mime: str = "image/png") -> dict:
    return {
        "type": "image",
        "data": base64.b64encode(png).decode("ascii"),
        "mimeType": mime,
    }


class Service:
    """全局单例：管理 Phone、状态与并发锁。"""

    def __init__(self):
        self.cfg, self.data_dir = load_config()
        self.phone = Phone(
            self.cfg,
            data_dir=self.data_dir,
            shot_dir=self.data_dir / "shots",
            logger=_Logger(),
            assets_dir=HERE / "assets",
        )
        self.state = SessionState(self.data_dir, logger=_Logger())
        self.lock = asyncio.Lock()
        self.loop = None  # 主事件循环；控制口线程靠它调度异步收尾

    def _int(self, args, key, default, lo=None, hi=None):
        raw = args.get(key, None)
        if raw is None or raw == "":
            value = default
        else:
            try:
                value = int(float(raw))
            except Exception:
                value = default
        if lo is not None:
            value = max(lo, value)
        if hi is not None:
            value = min(hi, value)
        return value

    def _float(self, args, key, default, lo=None, hi=None):
        raw = args.get(key, None)
        if raw is None or raw == "":
            value = default
        else:
            try:
                value = float(raw)
            except Exception:
                value = default
        if lo is not None:
            value = max(lo, value)
        if hi is not None:
            value = min(hi, value)
        return value

    def _bool(self, args, key, default):
        raw = args.get(key, None)
        if raw is None:
            return default
        return _as_bool(raw)

    async def ensure(self):
        await self.phone.ensure_started()


_SVC = None


def service() -> Service:
    global _SVC
    if _SVC is None:
        _SVC = Service()
    return _SVC


async def h_status(args, svc: Service):
    boot_error = ''
    mode0 = svc.state.snapshot().get("mode") or {}
    # 只有手机模式开着的时候才去连/开模拟器；收手之后手机已经关了，
    # 这里再连一次会把刚关掉的模拟器重新开机，那就白关了。
    if mode0.get("active"):
        try:
            await svc.ensure()
        except Exception as exc:
            boot_error = repr(exc)
    st = await svc.phone.status()
    lines = [
        "模拟器：" + ("运行中" if st.get("android_started") else "未启动") + "（" + str(st.get("player_state") or "—") + "）",
        "窗口：" + ("已隐藏（只有你能看到画面）" if st.get("window_hidden") else "可见/未运行"),
        "adb：" + str(st.get("device_state") or "—") + "  屏幕：" + str(st.get("screen") or "—"),
        "前台应用：" + str(st.get("focus") or "—"),
        "中文输入法：" + ("已就绪" if st.get("ime_ready") else "未就绪"),
        "MuMuManager：" + str(st.get("manager") or "未找到"),
    ]
    if st.get("vm_error"):
        lines.append("⚠️ " + str(st["vm_error"]))
    if st.get("adb_error"):
        lines.append("⚠️ " + str(st["adb_error"]))
    if boot_error:
        lines.append("⚠️ 连接模拟器失败：" + boot_error)
    mode = svc.state.snapshot().get("mode") or {}
    if mode.get("active"):
        lines.append("当前在玩手机：" + str(mode.get("goal") or "") + "，剩余 " + svc.state.remaining_text())
    limit = svc.cfg.get("daily_play_limit_minutes") or 0
    lines.append("今日已玩 " + str(svc.state.daily_minutes()) + " 分钟" + ("（上限 " + str(limit) + "）" if limit else ""))
    return [_t("\n".join(lines))]


async def h_screen(args, svc: Service):
    await svc.ensure()
    delay = svc._float(args, "delay_sec", 0.0, 0.0, 10.0)
    max_width = svc._int(args, "max_width", 0, 0, 4096) or None
    region = str(args.get("region") or "")
    annotate = svc._bool(args, "annotate", False)
    shot = await svc.phone.screenshot(
        max_width=max_width, region=region, delay=delay, annotate=annotate
    )
    svc.state.touch_tool("screen")
    head = "截图 " + str(shot.width) + "x" + str(shot.height) + "（坐标与本图同尺度）"
    return [_t(head), _img(shot.png)]


async def h_frames(args, svc: Service):
    await svc.ensure()
    cfg = svc.cfg
    duration = svc._float(args, "duration", 3.0, 0.5, float(cfg.get("frames_max_duration_sec") or 20))
    count = svc._int(args, "count", 0, 0, int(cfg.get("frames_max_count") or 24))
    fps = svc._float(args, "fps", 0.0, 0.0, 10.0)
    every = svc._float(args, "every", 0.0, 0.0, 60.0)
    mode = str(args.get("mode") or "frames")
    max_images = svc._int(args, "max_images", 0, 0, int(cfg.get("frames_max_images") or 8))
    width = svc._int(args, "width", 0, 0, 4096)
    dedupe = svc._bool(args, "dedupe", True)
    annotate = svc._bool(args, "annotate", True)
    region = str(args.get("region") or "")
    result = await svc.phone.sample(
        duration=duration,
        every=every,
        fps=fps,
        count=count,
        mode=mode,
        width=width,
        max_images=max_images,
        dedupe=dedupe,
        annotate=annotate,
        region=region,
    )
    svc.state.touch_tool("frames")
    head = (
        "连续采样 " + str(result.frames_total) + " 帧，用时 " + str(round(result.duration, 1))
        + " 秒，间隔 " + str(round(result.interval, 2)) + " 秒，返回 " + str(len(result.images)) + " 张图"
    )
    contents = [_t(head)]
    for img in result.images:
        contents.append(_img(img.png, img.mime or "image/png"))
        if img.label:
            contents.append(_t(img.label))
    return contents


async def h_ui(args, svc: Service):
    await svc.ensure()
    only_interactive = svc._bool(args, "only_interactive", True)
    max_items = svc._int(args, "max_items", 60, 1, 200)
    text_contains = str(args.get("text_contains") or "")
    data = await svc.phone.ui_summary(
        only_interactive=only_interactive, max_items=max_items, text_contains=text_contains
    )
    svc.state.touch_tool("ui")
    lines = [
        "屏幕 " + str(data.get("screen")) + "  前台 " + str(data.get("package")) + "  元素 " + str(data.get("count")) + " 个",
        "格式：i=序号 c=类型 t=文字 id=资源 id b=边界 p=中心点 f=可点等标记",
    ]
    for item in data.get("elements") or []:
        lines.append(
            "i=" + str(item.get("i"))
            + " c=" + str(item.get("c"))
            + (" t=" + str(item.get("t")) if item.get("t") else "")
            + (" id=" + str(item.get("id")) if item.get("id") else "")
            + " b=" + str(item.get("b"))
            + " p=" + str(item.get("p"))
            + (" f=" + ",".join(item.get("f") or []) if item.get("f") else "")
        )
    return [_t("\n".join(lines))]


from vm.adb import KEYCODE_MAP


async def _observe(svc: Service, note: str):
    try:
        shot = await svc.phone.screenshot(max_width=svc.cfg.get("single_frame_max_width") or 1280)
        return [_t(note), _img(shot.png)]
    except Exception as exc:
        return [_t(note + "（截图失败：" + repr(exc) + "）")]


async def h_tap(args, svc: Service):
    await svc.ensure()
    x = svc._int(args, "x", 0, 0, 100000)
    y = svc._int(args, "y", 0, 0, 100000)
    text = str(args.get("text") or "")
    index = args.get("index", None)
    index_val = None if index in (None, "") else svc._int({"v": index}, "v", 0, 0, 100000)
    long_press = svc._bool(args, "long_press", False)
    duration_ms = svc._int(args, "duration_ms", 800, 100, 10000)
    observe = svc._bool(args, "observe", True)
    has_xy = x > 0 and y > 0
    if not has_xy and not text and index_val is None:
        return [_t("需要 x,y 或 text 或 index 之一（可用 mumu_phone_ui 看可点元素）")]
    async with svc.lock:
        result = await svc.phone.tap(
            x=x if has_xy else None,
            y=y if has_xy else None,
            text=text,
            index=index_val,
            long_press=long_press,
            duration_ms=duration_ms,
        )
        svc.state.touch_tool("tap")
        svc.state.add_activity("tap", str(result.get("target") or ""))
    if not result.get("ok"):
        return [_t("点不到：" + str(result.get("error")) + "。提示：" + str(result.get("hint") or ""))]
    note = str(result.get("action")) + " 于 " + str(result.get("at")) + (
        "（" + str(result.get("target")) + "）" if result.get("target") else ""
    )
    if observe:
        return await _observe(svc, note)
    return [_t(note)]


async def h_swipe(args, svc: Service):
    await svc.ensure()
    x1 = svc._int(args, "start_x", 0, 0, 100000)
    y1 = svc._int(args, "start_y", 0, 0, 100000)
    x2 = svc._int(args, "end_x", 0, 0, 100000)
    y2 = svc._int(args, "end_y", 0, 0, 100000)
    duration_ms = svc._int(args, "duration_ms", 300, 50, 5000)
    observe = svc._bool(args, "observe", False)
    if not all([x1, y1, x2, y2]):
        return [_t("需要 start_x,start_y,end_x,end_y 四个坐标")]
    async with svc.lock:
        result = await svc.phone.swipe(x1, y1, x2, y2, duration_ms)
        svc.state.touch_tool("swipe")
    note = "滑动 " + str(result.get("from")) + " → " + str(result.get("to"))
    if observe:
        return await _observe(svc, note)
    return [_t(note)]


async def h_scroll(args, svc: Service):
    await svc.ensure()
    direction = str(args.get("direction") or "down")
    amount = svc._float(args, "amount", 0.6, 0.05, 0.95)
    observe = svc._bool(args, "observe", False)
    async with svc.lock:
        result = await svc.phone.scroll(direction, amount)
        svc.state.touch_tool("scroll")
    note = "向" + str(direction) + "滚动 " + str(result.get("distance") or "")
    if observe:
        return await _observe(svc, note)
    return [_t(note)]


async def h_text(args, svc: Service):
    await svc.ensure()
    text = str(args.get("text") or "")
    if not text:
        return [_t("text 参数不能为空")]
    submit = svc._bool(args, "submit", False)
    clear = svc._bool(args, "clear", True)
    async with svc.lock:
        result = await svc.phone.input_text(text, submit=submit, clear=clear)
        svc.state.touch_tool("text")
    return [_t("已输入（" + str(result.get("method")) + "）：" + str(result.get("text")))]


async def h_key(args, svc: Service):
    await svc.ensure()
    name = str(args.get("name") or "").strip()
    if not name:
        return [_t("需要 name（例如 home/back/enter）")]
    if name.isdigit():
        code = int(name)
    else:
        code = KEYCODE_MAP.get(name.lower())
        if code is None:
            return [_t("未知按键：" + name + "。可用：" + ", ".join(sorted(KEYCODE_MAP)))]
    async with svc.lock:
        await svc.phone.adb.shell("input keyevent " + str(code), timeout=15)
        svc.state.touch_tool("key")
    return [_t("已按下按键 " + name)]


async def h_app(args, svc: Service):
    await svc.ensure()
    action = str(args.get("action") or "current")
    package = str(args.get("package") or "")
    async with svc.lock:
        result = await svc.phone.app(action, package)
        svc.state.touch_tool("app")
    return [_t(json.dumps(result, ensure_ascii=False)[:4000])]


async def h_system(args, svc: Service):
    await svc.ensure()
    action = str(args.get("action") or "info")
    value = str(args.get("value") or "")
    async with svc.lock:
        result = await svc.phone.system(action, value)
        svc.state.touch_tool("system")
    return [_t(json.dumps(result, ensure_ascii=False)[:3000])]


async def h_notifications(args, svc: Service):
    await svc.ensure()
    limit = svc._int(args, "limit", 15, 1, 50)
    items = await svc.phone.notifications(limit)
    svc.state.touch_tool("notifications")
    if not items:
        return [_t("通知栏是空的。")]
    lines = ["通知 " + str(len(items)) + " 条："]
    for item in items:
        lines.append(
            "- [" + str(item.get("package", "")) + "] "
            + str(item.get("title", "")) + " / " + str(item.get("text", ""))
        )
    return [_t("\n".join(lines))]


async def h_shell(args, svc: Service):
    if not svc.cfg.get("enable_shell_tool"):
        return [_t("shell 工具默认关闭（需要主人自己在配置里打开 enable_shell_tool）。")]
    command = str(args.get("command") or "").strip()
    if not command:
        return [_t("需要 command")]
    timeout = svc._float(args, "timeout", 60, 1, 300)
    out = await svc.phone.shell(command, timeout)
    limit = int(svc.cfg.get("shell_output_max_chars") or 6000)
    return [_t(out[:limit])]


async def h_play(args, svc: Service):
    goal = str(args.get("goal") or "").strip()
    if not goal:
        goal = 选目标(svc)
    minutes = svc._float(args, "minutes", svc.cfg.get("mode_default_minutes") or 10, 1, 180)
    limit = int(svc.cfg.get("daily_play_limit_minutes") or 0)
    used = svc.state.daily_minutes()
    if limit and used >= limit:
        return [_t("今天的玩手机额度用完了（已玩 " + str(used) + "/" + str(limit) + " 分钟），歇一会儿吧。")]
    await svc.ensure()
    svc.state.begin(goal, "agent", minutes, svc._bool(args, "auto_continue", True))
    svc.state.add_activity("play", goal)
    return [
        _t(
            "开始玩手机：" + goal + "（限时 " + str(minutes) + " 分钟）。"
            "先 mumu_phone_screen 看画面，再 mumu_phone_ui 找可点的元素，然后 tap。"
            "想收手时调 mumu_phone_exit（会顺手把手机关掉）；只是先放下、待会儿再玩就 pause=true。"
        )
    ]


async def h_exit(args, svc: Service):
    summary = str(args.get("summary") or "").strip()
    snap = svc.state.snapshot().get("mode") or {}
    started = float(snap.get("started_ts") or 0)
    elapsed = max(0.0, (time.time() - started) / 60.0) if started else 0.0
    if summary:
        svc.state.add_diary(summary, "note")
    if elapsed > 0:
        svc.state.add_play_minutes(elapsed)
    # 收手 = 顺手把手机（模拟器）关掉；暂停 = 只把手机放下，模拟器留着不关。
    暂停 = svc._bool(args, "pause", False)
    关手机 = (not 暂停) and svc._bool(args, "stop_vm", True)
    svc.state.end(force=not 暂停)
    svc.state.last_play_ts = 0  # 手机已经放下，不再算「还在玩」
    svc.state.save()
    if 关手机:
        try:
            await svc.phone.stop()
        except Exception as exc:
            return [_t("手机收起来了，但关闭模拟器失败：" + repr(exc))]
    parts = ["手机收起来了"]
    if 暂停:
        parts.append("，我先放着没关，想玩再叫我")
    elif 关手机:
        parts.append("，手机也关上了")
    if summary:
        parts.append("，总结已记下")
    parts.append("。")
    return [_t("".join(parts))]


async def h_diary(args, svc: Service):
    action = str(args.get("action") or "read")
    if action == "add":
        text = str(args.get("text") or "").strip()
        if not text:
            return [_t("需要 text")]
        kind = str(args.get("kind") or "note")
        svc.state.add_diary(text, kind)
        return [_t("记下了。")]
    limit = svc._int(args, "limit", 6, 1, 40)
    return [_t(svc.state.diary_text(limit) or "还没有日记。")]


async def h_recent(args, svc: Service):
    minutes = svc._float(args, "minutes", 60, 1, 1440)
    limit = svc._int(args, "limit", 30, 1, 100)
    items = svc.state.recent_activity(minutes, limit)
    if not items:
        return [_t("最近没有动作记录。")]
    lines = ["最近 " + str(minutes) + " 分钟的动作："]
    for item in items:
        lines.append(
            "- " + str(item.get("tool", "")) + (": " + str(item.get("detail", "")) if item.get("detail") else "")
        )
    return [_t("\n".join(lines))]


def _parse_run_at(raw: str) -> float:
    text = (raw or "").strip()
    if not text:
        return time.time() + 300
    if text.isdigit():
        return float(text)
    now = time.localtime()
    if ":" in text and "-" not in text:
        hh, mm = text.split(":")[:2]
        target = time.mktime((now.tm_year, now.tm_mon, now.tm_mday, int(hh), int(mm), 0, 0, 0, -1))
        if target <= time.time():
            target += 86400
        return target
    if " " in text:
        date_part, time_part = text.split(" ", 1)
        try:
            y, mo, d = [int(x) for x in date_part.split("-")]
            hh, mm = [int(x) for x in time_part.split(":")[:2]]
            return time.mktime((y, mo, d, hh, mm, 0, 0, 0, -1))
        except Exception:
            pass
    return time.time() + 300


async def h_autoplay(args, svc: Service):
    action = str(args.get("action") or "list")
    if action == "schedule":
        goal = str(args.get("goal") or "玩手机").strip()
        minutes = svc._float(args, "minutes", 30, 1, 180)
        run_at = _parse_run_at(str(args.get("run_at") or ""))
        item = svc.state.add_scheduled(run_at, minutes, goal)
        svc.state.save()
        when = time.strftime("%Y-%m-%d %H:%M", time.localtime(run_at))
        return [_t("已登记：" + when + " 玩 " + str(minutes) + " 分钟（" + goal + "）。到点后由你（Agent）自己开始。")]
    if action == "cancel":
        target_id = str(args.get("id") or "")
        kept = []
        removed = 0
        for item in svc.state.scheduled:
            if target_id and item.get("id") == target_id:
                removed += 1
                continue
            kept.append(item)
        svc.state.scheduled = kept
        svc.state.save()
        return [_t("取消了 " + str(removed) + " 个计划。")]
    lines = ["计划中的自主玩手机："]
    for item in svc.state.scheduled:
        when = time.strftime("%Y-%m-%d %H:%M", time.localtime(float(item.get("run_at") or 0)))
        lines.append("- " + str(item.get("id")) + " " + when + " " + str(item.get("goal") or "") + " " + str(item.get("minutes") or ""))
    due = svc.state.due_scheduled()
    if due:
        lines.append("已到点：" + ", ".join(str(d.get("goal") or "") for d in due))
    return [_t("\n".join(lines))]


def _p(kind: str, desc: str, **extra) -> dict:
    data = {"type": kind, "description": desc}
    data.update(extra)
    return data


def _spec(name: str, desc: str, props: dict, required=None) -> dict:
    return {
        "name": name,
        "description": desc,
        "inputSchema": {
            "type": "object",
            "properties": props,
            "required": list(required or []),
        },
    }


TOOL_SPECS = [
    _spec(
        "mumu_phone_status",
        "查看 MuMu 模拟器状态：是否运行、adb、前台应用、屏幕尺寸、中文输入法、今天已玩多久。",
        {},
    ),
    _spec(
        "mumu_phone_screen",
        "截手机屏幕，返回一张图片（坐标与图片同尺度）。先看画面再操作。",
        {
            "delay_sec": _p("number", "截图前等待秒数（让动画停下来）", default=0.0),
            "max_width": _p("number", "图片最大宽度，0=用默认 1280", default=0),
            "region": _p("string", "裁剪区域，形如 0,0,1080,1920", default=""),
            "annotate": _p("boolean", "是否标注坐标轴", default=False),
        },
    ),
    _spec(
        "mumu_phone_frames",
        "连续采样多帧（看视频/动态用）。先粗看 duration=3~5，再定点细看。",
        {
            "duration": _p("number", "采样总时长（秒），上限 20", default=3.0),
            "count": _p("number", "采样帧数（与 fps/every 三选一优先）", default=0),
            "fps": _p("number", "每秒帧数", default=0),
            "every": _p("number", "每隔几秒取一帧", default=0),
            "mode": _p("string", "frames=一帧一张图；sheet=拼成一张图", default="frames"),
            "width": _p("number", "每张图宽度", default=0),
            "max_images": _p("number", "最多返回几张图", default=0),
            "dedupe": _p("boolean", "去掉重复帧", default=True),
            "annotate": _p("boolean", "给每帧标注时间", default=True),
            "region": _p("string", "裁剪区域", default=""),
        },
    ),
    _spec(
        "mumu_phone_ui",
        "读当前界面 UI 树，列出可点的元素（i=序号 c=类型 t=文字 b=边界 p=中心点 f=标记）。",
        {
            "only_interactive": _p("boolean", "只列可点/可输入/有文字的元素", default=True),
            "max_items": _p("number", "最多列多少个", default=60),
            "text_contains": _p("string", "只保留包含该文字的元素", default=""),
        },
    ),
    _spec(
        "mumu_phone_tap",
        "点击屏幕：给坐标 x,y，或给文字 text，或给元素序号 index（先 mumu_phone_ui 看序号）。",
        {
            "x": _p("number", "横坐标", default=0),
            "y": _p("number", "纵坐标", default=0),
            "text": _p("string", "按文字找元素再点", default=""),
            "index": _p("number", "按 UI 树序号点", default=0),
            "long_press": _p("boolean", "是否长按", default=False),
            "duration_ms": _p("number", "长按时长（毫秒）", default=800),
            "observe": _p("boolean", "点完是否回一张截图确认", default=True),
        },
    ),
    _spec(
        "mumu_phone_swipe",
        "滑动：从 (start_x,start_y) 滑到 (end_x,end_y)。",
        {
            "start_x": _p("number", "起点横坐标", default=0),
            "start_y": _p("number", "起点纵坐标", default=0),
            "end_x": _p("number", "终点横坐标", default=0),
            "end_y": _p("number", "终点纵坐标", default=0),
            "duration_ms": _p("number", "滑动时长（毫秒）", default=300),
            "observe": _p("boolean", "滑完是否回截图", default=False),
        },
    ),
    _spec(
        "mumu_phone_scroll",
        "按方向滚动页面（up/down/left/right）。",
        {
            "direction": _p("string", "滚动方向 up/down/left/right", default="down"),
            "amount": _p("number", "滚动幅度 0.05~0.95", default=0.6),
            "observe": _p("boolean", "滚完是否回截图", default=False),
        },
    ),
    _spec(
        "mumu_phone_text",
        "输入文字（支持中文，自动使用 ADBKeyboard）。",
        {
            "text": _p("string", "要输入的文字", default=""),
            "submit": _p("boolean", "输入后是否回车", default=False),
            "clear": _p("boolean", "输入前先清空输入框", default=True),
        },
    ),
]

TOOL_SPECS += [
    _spec(
        "mumu_phone_key",
        "按系统键：home/back/enter/delete/power 等。",
        {"name": _p("string", "按键名，如 home、back、enter、power", default="")},
        ["name"],
    ),
    _spec(
        "mumu_phone_app",
        "应用控制：action=current（前台）/launch（启动）/stop（停止）/info（信息）/list（已装列表）/search（按名字找）。",
        {
            "action": _p("string", "current/launch/stop/info/list/list_all/search", default="current"),
            "package": _p("string", "包名（launch/stop/info 时必填）", default=""),
        },
    ),
    _spec(
        "mumu_phone_system",
        "系统操作：action=info（状态）/battery（电量）/brightness（亮度 0-255）/volume（音量 0-100）/rotate（旋转）/ip（网络）/wake（唤醒屏幕）/screen（息屏）。",
        {
            "action": _p("string", "info/battery/brightness/volume/rotate/ip/wake/screen", default="info"),
            "value": _p("string", "参数值（亮度/音量/旋转方向）", default=""),
        },
    ),
    _spec(
        "mumu_phone_notifications",
        "看通知栏（@我的消息、未读通知）。",
        {"limit": _p("number", "最多返回几条", default=15)},
    ),
    _spec(
        "mumu_phone_shell",
        "在安卓里执行一条 adb shell 命令（默认关闭，需要主人在配置里打开 enable_shell_tool）。",
        {
            "command": _p("string", "要执行的命令", default=""),
            "timeout": _p("number", "超时秒数（1-300）", default=60),
        },
        ["command"],
    ),
    _spec(
        "mumu_phone_play",
        "开始玩手机：告诉模拟器这台机子接下来归你用（记目标、限时、每日额度）。",
        {
            "goal": _p("string", "这次想玩什么", default=""),
            "minutes": _p("number", "限时分钟（1-180）", default=30),
            "auto_continue": _p("boolean", "结束后是否继续玩", default=True),
        },
        ["goal"],
    ),
    _spec(
        "mumu_phone_exit",
        "收手：结束玩手机，把总结写进日记，顺手把手机（模拟器）关掉；只想先放下手机待会儿再玩就 pause=true，模拟器留着不关。想结束就必须调这个（只在文字里说结束不算）。",
        {
            "summary": _p("string", "这趟玩了什么、看到什么", default=""),
            "pause": _p("boolean", "只是先放下手机（模拟器留着不关）", default=False),
            "stop_vm": _p("boolean", "是否把手机（模拟器）关掉（pause=true 时忽略）", default=True),
        },
    ),
    _spec(
        "mumu_phone_diary",
        "手机日记：action=add 记一条（kind=note/mood/highlight）；action=read 读最近几条。",
        {
            "action": _p("string", "add/read", default="read"),
            "text": _p("string", "要记的内容（action=add 时必填）", default=""),
            "kind": _p("string", "note/mood/highlight", default="note"),
            "limit": _p("number", "读几条", default=6),
        },
    ),
    _spec(
        "mumu_phone_recent",
        "最近在手机上做了什么（动作流水）。",
        {
            "minutes": _p("number", "回看多少分钟", default=60),
            "limit": _p("number", "最多几条", default=30),
        },
    ),
    _spec(
        "mumu_phone_autoplay",
        "安排以后自主玩手机：action=schedule/list/cancel（只记账，到点由 Agent 自己开始）。",
        {
            "action": _p("string", "schedule/list/cancel", default="list"),
            "goal": _p("string", "想玩什么", default=""),
            "minutes": _p("number", "玩多久（分钟）", default=30),
            "run_at": _p("string", "什么时候开始：HH:MM 或 YYYY-MM-DD HH:MM", default=""),
            "id": _p("string", "要取消的计划 id（action=cancel）", default=""),
        },
    ),
    _spec(
        "mumu_phone_messages",
        "查看手机操作期间挂起的消息（对方在你玩手机时发来的话），也可以标记已处理。",
        {
            "action": _p("string", "list/handled", default="list"),
            "id": _p("string", "要标记已处理的消息 id（action=handled）", default=""),
            "mark_handled": _p("boolean", "true = 全部标记成已处理（不想回时用这个，队列清空就不再被提醒）", default=False),
        },
    ),
    _spec(
        "mumu_phone_say",
        "给对方直接发一条消息（马上发到 QQ，不用等这一轮结束）。回挂起消息时用它。",
        {
            "text": _p("string", "要发的话", default=""),
            "msg_id": _p("string", "对应挂起消息的 id（发完自动标记已处理）", default=""),
        },
    ),
    _spec(
        "mumu_phone_random_goal",
        "从目标池里轮转取一个「这次玩什么」（给 mumu_phone_play 不给 goal 时用）。",
        {},
    ),
]


# ---------------------------------------------------------------- 目标池 / 尾巴 / DSH 通道

def 目标池(svc) -> list:
    raw = str((svc.cfg or {}).get("autoplay_goals") or "")
    项 = [x.strip() for x in raw.replace(chr(10), ",").split(",") if x.strip()]
    return 项


def 选目标(svc) -> str:
    """从目标池轮转取一个目标（连着取不会重复）。"""
    池 = 目标池(svc)
    if not 池:
        return "刷一刷手机"
    try:
        i = int(svc.state.last_autoplay_goal_index or 0) % len(池)
    except Exception:
        i = 0
    try:
        svc.state.last_autoplay_goal_index = (i + 1) % len(池)
        svc.state.save()
    except Exception:
        pass
    return 池[i]


def 尾巴(svc) -> str:
    """每次工具返回都带上的小尾巴：挂着谁的消息 + 还剩多久 + 怎么收手。"""
    段 = []
    try:
        notice = svc.state.pending_notice_text()
    except Exception:
        notice = ""
    if notice:
        段.append(notice)
    try:
        if svc.state.is_active():
            段.append("手机模式还剩 " + str(svc.state.remaining_text()) + "；想收手就调 mumu_phone_exit。")
    except Exception:
        pass
    return chr(10).join(段)


def _dsh_base(svc) -> str:
    return str((svc.cfg or {}).get("dsh_http_url") or "http://127.0.0.1:3080").rstrip("/")


def dsh_post(path: str, payload: dict, timeout: float = 20.0) -> dict:
    """往 DSH 的 HTTP API 发一条 POST（拿 dsh-qq-bridge-mumu 的 /say /turn 用）。"""
    import urllib.request
    url = _dsh_base(service()) + str(path or "")
    data = json.dumps(payload or {}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", "replace")
    try:
        j = json.loads(raw or "{}")
    except Exception:
        j = {}
    return j if isinstance(j, dict) else {}


def dsh_get(path: str, timeout: float = 20.0) -> dict:
    import urllib.request
    url = _dsh_base(service()) + str(path or "")
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", "replace")
    try:
        j = json.loads(raw or "{}")
    except Exception:
        j = {}
    return j if isinstance(j, dict) else {}


async def h_messages(args, svc: Service):
    """看/标记挂起的消息。"""
    action = str(args.get("action") or "list")
    if action in ("handled", "mark", "done") or svc._bool(args, "mark_handled", False):
        mid = str(args.get("id") or "").strip()
        if mid:
            item = svc.state.mark_handled(mid)
            if not item:
                return [_t("没找到这条消息（可能已经处理过）。")]
            return [_t("标记好了：" + item.brief())]
        # 不给 id → 全部标记成已处理（她不想回的时候用这个，队列清空就不会再被提醒）
        items = svc.state.unhandled_pending()
        if not items:
            return [_t("没有等着回的消息。")]
        for item in items:
            svc.state.mark_handled(item.id)
        return [_t("全部标记成已处理了（" + str(len(items)) + " 条），不用再回了。")]
    items = svc.state.unhandled_pending()
    if not items:
        return [_t("没有等着回的消息。")]
    lines = ["等着你回的消息（" + str(len(items)) + " 条）："]
    for item in items:
        lines.append("- id=" + item.id + " " + item.brief())
    lines.append("想回哪条：mumu_phone_say(msg_id=..., text=...)；回完或不理：mumu_phone_messages(action=handled, id=...)。")
    return [_t(chr(10).join(lines))]


async def h_say(args, svc: Service):
    """给对方直接发一条（走 dsh-qq-bridge-mumu 的直发通道，立刻到 QQ）。"""
    text = str(args.get("text") or "").strip()
    if not text:
        return [_t("要说点什么？给 text。")]
    mid = str(args.get("msg_id") or "").strip()
    try:
        j = dsh_post(str(svc.cfg.get("qq_say_path") or "/dsh-qq-bridge-mumu/say"), {"text": text, "msg_id": mid})
    except Exception as exc:
        return [_t("发不出去：" + repr(exc))]
    if not j.get("ok"):
        return [_t("QQ 那头没接住：" + str(j.get("说") or j))]
    if mid:
        try:
            svc.state.mark_handled(mid)
        except Exception:
            pass
    return [_t("已经发过去了。" + ("（这条消息也标记成已处理了）" if mid else ""))]


async def h_random_goal(args, svc: Service):
    return [_t("这次玩：" + 选目标(svc))]

HANDLERS = {
    "mumu_phone_status": h_status,
    "mumu_phone_screen": h_screen,
    "mumu_phone_frames": h_frames,
    "mumu_phone_ui": h_ui,
    "mumu_phone_tap": h_tap,
    "mumu_phone_swipe": h_swipe,
    "mumu_phone_scroll": h_scroll,
    "mumu_phone_text": h_text,
    "mumu_phone_key": h_key,
    "mumu_phone_app": h_app,
    "mumu_phone_system": h_system,
    "mumu_phone_notifications": h_notifications,
    "mumu_phone_shell": h_shell,
    "mumu_phone_play": h_play,
    "mumu_phone_exit": h_exit,
    "mumu_phone_diary": h_diary,
    "mumu_phone_recent": h_recent,
    "mumu_phone_autoplay": h_autoplay,
    "mumu_phone_messages": h_messages,
    "mumu_phone_say": h_say,
    "mumu_phone_random_goal": h_random_goal,
}


def build_registry():
    svc = service()

    # 主人喊停之后（forced），玩手机这类操作先拒掉——她那一回合就该收手，
    # 不然主会话一直被占着，对方在 QQ 上说的话只能排队等。
    玩类 = {"screen", "frames", "ui", "tap", "swipe", "scroll", "text", "key", "app"}

    def _make(handler):
        async def _run(args):
            短名 = handler.__name__[2:] if handler.__name__.startswith("h_") else handler.__name__
            if 短名 in 玩类 and bool(getattr(svc.state, "forced", False)):
                return [_t("手机已经收起来了，别再玩啦。想玩的话先说一声，重新开始。")]
            out = await handler(args, svc)
            if not isinstance(out, list):
                out = [_t(str(out))]
            tail = 尾巴(svc)
            if tail:
                out = list(out) + [_t(tail)]
            return out

        return _run

    return {name: _make(handler) for name, handler in HANDLERS.items()}
