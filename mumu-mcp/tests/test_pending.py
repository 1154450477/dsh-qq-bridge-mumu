# -*- coding: utf-8 -*-
"""专测挂起队列：入队 → 列表 → mark_handled=true 全部忽略 → 队列清空。"""
import json
import os
import shutil
import sys
import time
import urllib.request

sys.path.insert(0, r"D:\EX\dsh\mumu-mcp")
from test_client import Client  # noqa: E402

DATA = r"D:\EX\dsh\mumu-mcp\_t_pending"
PORT = "8799"
CTRL = "http://127.0.0.1:" + PORT

if os.path.isdir(DATA):
    shutil.rmtree(DATA, ignore_errors=True)

os.environ["MUMU_MCP_DATA_DIR"] = DATA
os.environ["MUMU_CONTROL_PORT"] = PORT

import server as srv  # noqa: E402
srv.DATA_DIR = DATA  # type: ignore


def post(path, obj):
    req = urllib.request.Request(
        CTRL + path, data=json.dumps(obj).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode("utf-8"))


def get(path):
    with urllib.request.urlopen(CTRL + path, timeout=10) as r:
        return json.loads(r.read().decode("utf-8"))


def 文本(res):
    out = []
    for b in (res.get("result") or {}).get("content") or []:
        if b.get("type") == "text":
            out.append(b.get("text") or "")
    return "\n".join(out)


失败 = 0


def 报(名字, 条件, 细节=""):
    global 失败
    if 条件:
        print("  ok  " + 名字)
    else:
        失败 += 1
        print("  FAIL " + 名字 + "  " + 细节)


client = Client()
client.send("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                           "clientInfo": {"name": "pending-test", "version": "1.0"}})
client.send("notifications/initialized", {}, notify=True)
time.sleep(1.0)

print("== 入队两条 ==")
post("/pending", {"text": "在吗", "sender_name": "阿水"})
post("/pending", {"text": "你干嘛呢", "sender_name": "阿水"})
pend = get("/pending")
报("控制口能看到 2 条挂起", len(pend.get("items") or []) == 2, json.dumps(pend, ensure_ascii=False))

print("== tools/call mumu_phone_messages(list) ==")
res = client.send("tools/call", {"name": "mumu_phone_messages", "arguments": {"action": "list"}})
报("list 列出 2 条", "2" in 文本(res) and "在吗" in 文本(res), 文本(res)[:300])

print("== tools/call mumu_phone_messages(mark_handled=true) ==")
res = client.send("tools/call", {"name": "mumu_phone_messages", "arguments": {"mark_handled": True}})
报("全部忽略成功", "全部标记成已处理" in 文本(res), 文本(res)[:300])

pend2 = get("/pending")
报("控制口队列已清空", len(pend2.get("items") or []) == 0, json.dumps(pend2, ensure_ascii=False))

print("== 再来一条，只标记单条 ==")
post("/pending", {"text": "第三条", "sender_name": "阿水"})
pend3 = get("/pending")
mid = (pend3.get("items") or [{}])[0].get("id")
res = client.send("tools/call", {"name": "mumu_phone_messages", "arguments": {"action": "handled", "id": mid}})
报("标记单条成功", "标记好了" in 文本(res), 文本(res)[:200])
pend4 = get("/pending")
报("单条标记后队列空", len(pend4.get("items") or []) == 0, json.dumps(pend4, ensure_ascii=False))

client.close()
shutil.rmtree(DATA, ignore_errors=True)
print("\n" + ("全部通过 ✅" if 失败 == 0 else ("有 " + str(失败) + " 条没过 ❌")))
sys.exit(1 if 失败 else 0)
