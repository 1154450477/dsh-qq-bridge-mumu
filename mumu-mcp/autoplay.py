# -*- coding: utf-8 -*-
"""自主玩手机调度器：定时计划到点、或闲下来的时候，喊 DSH 开一轮让她自己玩。

原版 astrbot_plugin_mumu_vm 把这件事放在插件自己的后台线程里（_maybe_start_autoplay）；
这里放在 MCP server 进程里（MCP 由 DSH 拉起，进程活多久 = DSH 活多久），
触发方式是 POST 到 qq-bridge 的 /dsh-qq-bridge/turn，让 DSH 开一轮新回合。
"""
from __future__ import annotations

import threading
import time

from tools import _log, dsh_get, dsh_post, 选目标, service

_上次触发 = 0.0
_触发冷却秒 = 600  # 十分钟内不重复喊


def _在活跃时段(区间: str) -> bool:
    """'09:00-23:30' 这种区间；解析不了就当一直可以。"""
    text = str(区间 or "").strip()
    if not text:
        return True
    if "-" not in text:
        return True
    起, 止 = text.split("-", 1)
    现在 = time.localtime()
    分 = 现在.tm_hour * 60 + 现在.tm_min

    def 拆(s: str) -> int:
        位 = s.strip().split(":")
        try:
            return int(位[0]) * 60 + int(位[1] if len(位) > 1 else 0)
        except Exception:
            return -1

    a = 拆(起)
    b = 拆(止)
    if a < 0 or b < 0:
        return True
    if a <= b:
        return a <= 分 <= b
    # 跨过午夜（比如 22:00-02:00）
    return 分 >= a or 分 <= b


def _问DSH状态(svc) -> dict:
    路径 = str(svc.cfg.get("qq_agent_state_path") or "/dsh-qq-bridge/agent-state")
    try:
        return dsh_get(路径, timeout=8.0)
    except Exception:
        return {}


def _发回合(svc, 目标: str, 分钟: int, 理由: str) -> bool:
    路径 = str(svc.cfg.get("qq_turn_path") or "/dsh-qq-bridge/turn")
    文案 = (
        "（自主玩手机：" + 理由 + "）现在没什么事，你玩一会儿「" + 目标 + "」，限时 " + str(分钟) + " 分钟。\n"
        "调 mumu_phone_play 开始（goal=「" + 目标 + "」，minutes=" + str(分钟) + "），"
        "中间看看画面和 UI 再点，玩完调 mumu_phone_exit 收手。"
    )
    try:
        j = dsh_post(路径, {"text": 文案, "mode": "followup", "source": "autoplay"}, timeout=20.0)
    except Exception as exc:
        _log("自主玩：回合没开起来（" + repr(exc) + "）")
        return False
    if not j.get("ok"):
        _log("自主玩：回合没开起来（" + str(j.get("说") or j) + "）")
        return False
    _log("自主玩：已开一轮 → " + 目标 + "（" + str(分钟) + " 分钟，" + 理由 + "）")
    return True


def _跑一轮() -> None:
    global _上次触发
    svc = service()
    cfg = svc.cfg or {}
    if not cfg.get("autoplay_enable"):
        return
    try:
        if svc.state.is_active():
            return  # 已经在玩了
    except Exception:
        return
    if time.time() - _上次触发 < _触发冷却秒:
        return

    # ① 定时计划到点
    try:
        到点 = svc.state.due_scheduled()
    except Exception:
        到点 = []
    if 到点:
        计划 = 到点[0]
        try:
            计划.done = True
            svc.state.save()
        except Exception:
            pass
        分钟 = int(float(计划.minutes or 20))
        if _发回合(svc, str(计划.goal or "刷一刷手机"), 分钟, "定时计划"):
            _上次触发 = time.time()
        return

    # ② 闲下来
    if not _在活跃时段(str(cfg.get("autoplay_active_hours") or "")):
        return
    额度 = int(cfg.get("autoplay_daily_budget_minutes") or 0)
    try:
        已用 = svc.state.daily_minutes()
    except Exception:
        已用 = 0.0
    if 额度 and 已用 >= 额度:
        return
    次数 = int(cfg.get("autoplay_runs_per_day") or 0)
    try:
        已玩次数 = svc.state.daily_runs()
    except Exception:
        已玩次数 = 0
    if 次数 and 已玩次数 >= 次数:
        return
    空闲分钟 = int(cfg.get("autoplay_idle_minutes") or 0)
    if 空闲分钟:
        状态 = _问DSH状态(svc)
        if not 状态:
            return  # 问不到 DSH 就先不自主（宁可不做也别乱开）
        if str(状态.get("status") or "") == "running":
            return
        最后消息 = float(状态.get("last_user_msg_ts") or 0)
        if 最后消息 and (time.time() - 最后消息) < 空闲分钟 * 60:
            return
    分钟 = int(cfg.get("autoplay_session_minutes") or 20)
    目标 = 选目标(svc)
    if _发回合(svc, 目标, 分钟, "闲着没事"):
        _上次触发 = time.time()


def 启动() -> None:
    """起后台调度线程（守护线程，进程退出即止）。"""
    def _循环():
        while True:
            try:
                间隔 = int(service().cfg.get("autoplay_check_sec") or 60)
            except Exception:
                间隔 = 60
            try:
                _跑一轮()
            except Exception as exc:
                _log("自主玩调度出错：" + repr(exc))
            time.sleep(max(15, min(600, 间隔)))

    线程 = threading.Thread(target=_循环, name="mumu-autoplay", daemon=True)
    线程.start()
    _log("自主玩调度器已启动")
    return 线程
