# -*- coding: utf-8 -*-
"""mumu-mcp 本地控制口：给 dsh-qq-bridge-mumu（DSH 插件）用的小 HTTP 接口。

只做四件事：查状态 / 入队一条消息 / 标记已处理 / 结束手机模式。
vm/state.py 里这些方法都是同步的，所以可以直接在 HTTP 线程里跑，不用碰事件循环。
"""
from __future__ import annotations

import asyncio
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from tools import service, _log


def _状态(svc) -> dict:
    snap = svc.state.snapshot()
    return {
        "ok": True,
        "mode": snap.get("mode") or {},
        "pending": snap.get("pending") or [],
        "daily": snap.get("daily") or {},
        "scheduled": snap.get("scheduled") or [],
        "playing": bool(svc.state.is_playing_recently(180)),
        "forced": bool(getattr(svc.state, "forced", False)),
        "last_play_ts": float(snap.get("last_play_ts") or 0),
        # ⚠ 她最后一次玩的时间（收手也不清）—— dsh-mumu-up 的「手机冷却/时机因子」靠它
        "last_played_ts": float(snap.get("last_played_ts") or 0),
    }


class 处理(BaseHTTPRequestHandler):
    server_version = "mumu-control/1.0"

    def log_message(self, fmt, *args):  # 不往 stderr 刷屏
        return

    def _回(self, code: int, obj: dict) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(code)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception:
            pass

    def _体(self) -> dict:
        try:
            n = int(self.headers.get("content-length") or 0)
        except Exception:
            n = 0
        raw = self.rfile.read(n) if n > 0 else b""
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def do_GET(self) -> None:
        try:
            svc = service()
            path = self.path.split("?")[0].rstrip("/") or "/"
            if path == "/state":
                return self._回(200, _状态(svc))
            if path == "/pending":
                items = [m.to_dict() for m in svc.state.unhandled_pending()]
                return self._回(200, {"ok": True, "items": items})
            return self._回(404, {"ok": False, "说": "没有这条路由"})
        except Exception as exc:
            return self._回(500, {"ok": False, "说": repr(exc)})

    def do_POST(self) -> None:
        try:
            svc = service()
            path = self.path.split("?")[0].rstrip("/") or "/"
            body = self._体()
            if path == "/pending":
                text = str(body.get("text") or "").strip()
                if not text:
                    return self._回(400, {"ok": False, "说": "没有文字"})
                item = svc.state.add_pending(
                    umo=str(body.get("umo") or "qq"),
                    sender_id=str(body.get("sender_id") or "qq-owner"),
                    sender_name=str(body.get("sender_name") or "对方"),
                    text=text,
                    platform="qq",
                )
                _log("控制口：挂起一条消息 id=" + str(item.id))
                return self._回(200, {"ok": True, "id": item.id, "条数": len(svc.state.unhandled_pending())})
            if path == "/pending/handled":
                mid = str(body.get("id") or "")
                item = svc.state.mark_handled(mid)
                return self._回(200, {"ok": bool(item), "id": mid})
            if path == "/exit":
                reason = str(body.get("reason") or "主人喊停")
                summary = str(body.get("summary") or "")
                暂停 = bool(body.get("pause"))
                snap = svc.state.snapshot().get("mode") or {}
                started = float(snap.get("started_ts") or 0)
                elapsed = max(0.0, (time.time() - started) / 60.0) if started else 0.0
                if summary:
                    svc.state.add_diary(summary, "note")
                if elapsed > 0:
                    svc.state.add_play_minutes(elapsed)
                svc.state.end(force=not 暂停)
                svc.state.last_play_ts = 0
                svc.state.save()
                关手机 = not 暂停
                if 关手机:
                    try:
                        loop = getattr(svc, "loop", None)
                        if loop is not None:
                            asyncio.run_coroutine_threadsafe(svc.phone.stop(), loop).result(timeout=120)
                        else:
                            asyncio.run(svc.phone.stop())
                    except Exception as exc:
                        _log("控制口：关模拟器失败：" + repr(exc))
                        关手机 = False
                _log("控制口：结束手机模式（" + reason + "，暂停=" + str(暂停) + "，关手机=" + str(关手机) + "）")
                return self._回(200, {"ok": True, "说": "手机模式已结束", "minutes": round(elapsed, 1), "关了手机": 关手机})
            return self._回(404, {"ok": False, "说": "没有这条路由"})
        except Exception as exc:
            return self._回(500, {"ok": False, "说": repr(exc)})


def 启动(port: int):
    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", int(port)), 处理)
    except Exception as exc:
        _log("控制口起不来（端口 " + str(port) + "）：" + repr(exc))
        return None
    threading.Thread(target=httpd.serve_forever, name="mumu-control", daemon=True).start()
    _log("控制口已开：http://127.0.0.1:" + str(port))
    return httpd
