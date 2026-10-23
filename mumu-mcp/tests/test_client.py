"""Minimal MCP stdio client for smoke-testing server.py (no third-party deps)."""
import json, pathlib
import subprocess
import sys
import threading

PY = r"C:\Python315\python.exe"
HERE = pathlib.Path(__file__).resolve().parent.parent
SERVER = str(HERE / "server.py")


class Client:
    def __init__(self):
        self.proc = subprocess.Popen(
            [PY, SERVER],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self._id = 0
        self._lock = threading.Lock()
        threading.Thread(target=self._drain_err, daemon=True).start()

    def _drain_err(self):
        for line in self.proc.stderr:
            print("[stderr] " + line.rstrip(), flush=True)

    def send(self, method, params=None, notify=False):
        with self._lock:
            self._id += 1
            rid = self._id
        msg = {"jsonrpc": "2.0", "method": method}
        if not notify:
            msg["id"] = rid
        if params is not None:
            msg["params"] = params
        self.proc.stdin.write(json.dumps(msg, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        if notify:
            return None
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("server closed stdout")
            data = json.loads(line)
            if data.get("id") == rid:
                return data

    def close(self):
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        self.proc.terminate()


def main():
    client = Client()
    init = client.send("initialize", {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "smoke", "version": "1.0"},
    })
    print("== initialize ==")
    print(json.dumps(init, ensure_ascii=False)[:900])
    client.send("notifications/initialized", {}, notify=True)

    listing = client.send("tools/list", {})
    tools = listing.get("result", {}).get("tools", [])
    print("== tools/list: %d tools ==" % len(tools))
    for tool in tools:
        print("  - " + tool["name"] + " : " + tool["description"][:40])

    calls = [
        ("mumu_phone_status", {}),
        ("mumu_phone_screen", {"delay_sec": 1.0}),
        ("mumu_phone_frames", {"count": 2, "every": 1.0, "max_images": 2}),
        ("mumu_phone_ui", {"only_interactive": True, "max_items": 6}),
        ("mumu_phone_tap", {"text": "推荐", "observe": False}),
        ("mumu_phone_play", {"goal": "刷刷短视频", "minutes": 5}),
        ("mumu_phone_diary", {"action": "add", "text": "冒烟测试：看了首页，推荐页可点", "kind": "note"}),
        ("mumu_phone_recent", {"minutes": 30}),
        ("mumu_phone_autoplay", {"action": "list"}),
        ("mumu_phone_exit", {"summary": "冒烟测试结束"}),
    ]
    for name, args in calls:
        res = client.send("tools/call", {"name": name, "arguments": args})
        result = res.get("result", {})
        blocks = result.get("content", [])
        kinds = [b.get("type") for b in blocks]
        print("== call " + name + " isError=%s blocks=%s ==" % (result.get("isError"), kinds))
        for block in blocks:
            if block.get("type") == "text":
                print(block["text"][:600])
            elif block.get("type") == "image":
                print("[image %d bytes b64]" % len(block.get("data", "")))
        if result.get("isError"):
            print("ERROR DETAIL:", json.dumps(result, ensure_ascii=False)[:1200])

    client.close()


if __name__ == "__main__":
    main()
