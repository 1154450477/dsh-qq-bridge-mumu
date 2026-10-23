"""模拟 DSH dsh-mcp-client 的 spawn：清洗过的环境 + 指定 command/args。"""
import json, pathlib
import os
import subprocess

MUMU_MANAGER = "D:/Program Files/Netease/MuMu/nx_main/MuMuManager.exe"
DATA_DIR = "C:/Users/aauv/.dsh/mumu-mcp"

CLEAN = {
    "PATH": os.environ.get("PATH", ""),
    "SYSTEMROOT": os.environ.get("SYSTEMROOT", ""),
    "TEMP": os.environ.get("TEMP", ""),
    "TMP": os.environ.get("TMP", ""),
    "USERPROFILE": os.environ.get("USERPROFILE", ""),
    "HOMEDRIVE": os.environ.get("HOMEDRIVE", ""),
    "HOMEPATH": os.environ.get("HOMEPATH", ""),
    "COMSPEC": os.environ.get("COMSPEC", ""),
    "MUMU_MANAGER_PATH": MUMU_MANAGER,
    "MUMU_DATA_DIR": DATA_DIR,
}

proc = subprocess.Popen(
    ["C:/Python315/python.exe", str(pathlib.Path(__file__).resolve().parent.parent / "server.py")],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    env=CLEAN, text=True, encoding="utf-8", bufsize=1,
)


def send(msg):
    proc.stdin.write(json.dumps(msg, ensure_ascii=False) + "\n")
    proc.stdin.flush()
    return json.loads(proc.stdout.readline())


init = send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
             "params": {"protocolVersion": "2026-07-28", "capabilities": {},
                        "clientInfo": {"name": "dsh-mcp-client", "version": "0.2.1"}}})
print("negotiated protocol:", init["result"]["protocolVersion"])
note = {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}
proc.stdin.write(json.dumps(note) + chr(10))
proc.stdin.flush()
listing = send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
names = [t["name"] for t in listing["result"]["tools"]]
print("tools:", len(names), names[:4], "...")
call = send({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
             "params": {"name": "mumu_phone_status", "arguments": {}}})
print("status isError:", call["result"].get("isError"))
print(call["result"]["content"][0]["text"][:300])
proc.terminate()
