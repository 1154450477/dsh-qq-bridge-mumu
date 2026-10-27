import { readFileSync } from "node:fs"
const src = readFileSync("D:/EX/dsh/大肥鱼项目/.tmp-dshlaoshi/host.patched.js", "utf8")
const 名字 = "export function 滤系统痕迹"
const 起点 = src.indexOf(名字)
if (起点 < 0) { console.log("EXTRACT_FAIL"); process.exit(1) }
const 尾 = src.indexOf(String.fromCharCode(10) + "}", 起点)
const 段 = src.slice(起点, 尾 + 3).replace("export ", "")
const 原 = new Function("return (" + 段 + ")")()
const NUL = String.fromCharCode(0)
const 剥 = (v) => v === null ? null : String(v).replace(new RegExp(NUL + "F" + String.fromCharCode(92) + "d+" + NUL, "g"), "")
const 滤系统痕迹 = (x) => 剥(原(x))
let 挂 = 0
const 报 = (名, 过, 详) => { if (!过) 挂++; console.log((过 ? "PASS" : "FAIL") + "  " + 名 + (详 !== undefined ? "  :: " + JSON.stringify(详) : "")) }

报("图片注解整块 → null", 滤系统痕迹("（主人发了 1 张图：第1张 161KB，要发回去就用 C:\\Users\\aauv\\.dsh\\qq-bridge-inbox\\xxx.jpg）") === null)
报("正文+注解同一块：注解切掉正文留", 滤系统痕迹("阿水问了个好", String.fromCharCode(10) + "（主人发了 1 张图：第1张 161KB，要发回去就用 C:\\Users\\aauv\\.dsh\\qq-bridge-inbox\\xxx.jpg）") === "阿水问了个好")
报("image omitted 行切掉", 滤系统痕迹("看图", String.fromCharCode(10) + "[image omitted to fit request image limits; \"qq-xxx.jpg\" (sha256:abc)") === "看图")
报("Normalized copy 行切掉", 滤系统痕迹("好", String.fromCharCode(10) + "Normalized copy of qq-xxx.jpg may be resized or re-encoded") === "好")
报("(sha256: 行切掉", 滤系统痕迹("好", String.fromCharCode(10) + "(sha256:deadbeef)") === "好")
报("系统提示块切掉", 滤系统痕迹("在查，稍等", String.fromCharCode(10) + "系统提示：这一轮已经想了一分多钟，还没给主人任何回复。请先立刻用 mumu_phone_say 给主人发一句 10 字以内的简短汇报") === "在查，稍等")
报("（发了1张图）切掉", 滤系统痕迹("接图", String.fromCharCode(10) + "（发了 1 张图：qq.jpg）") === "接图")
报("[bili] 行切掉", 滤系统痕迹("看这个", String.fromCharCode(10) + "[bili] 来源短视频") === "看这个")
报("整条只剩痕迹 → null", 滤系统痕迹("系统提示：这一轮已经想了一分多钟，还没给主人任何回复。请先立刻用 mumu_phone_say 给主人发一句 10 字以内的简短汇报") === null)
报("防误伤：正文提到图片", 滤系统痕迹("你给我发的图片我看到了，好看") === "你给我发的图片我看到了，好看")
报("防误伤：sha256 不在行首", 滤系统痕迹("密码学里 sha256 是哈希算法") === "密码学里 sha256 是哈希算法")
报("防误伤：系统提示不在行首", 滤系统痕迹("那个系统提示好烦啊") === "那个系统提示好烦啊")
报("防误伤：行首单个方括号引用不碰", 滤系统痕迹("[1] 这是引用") === "[1] 这是引用")
报("围栏内不动", 滤系统痕迹("看这段：" + String.fromCharCode(10) + String.fromCharCode(96,96,96) + String.fromCharCode(10) + "（主人发了 1 张图：xxx）" + String.fromCharCode(10) + String.fromCharCode(96,96,96) + String.fromCharCode(10) + "完了") === "看这段：" + String.fromCharCode(10) + String.fromCharCode(96,96,96) + String.fromCharCode(10) + "（主人发了 1 张图：xxx）" + String.fromCharCode(10) + String.fromCharCode(96,96,96) + String.fromCharCode(10) + "完了")
报("空串原样", 滤系统痕迹("") === "")
报("普通文本原样", 滤系统痕迹("今天天气不错，去钓鱼吗？") === "今天天气不错，去钓鱼吗？")
报("痕迹行删后多空行压1空行", 滤系统痕迹("第一段" + String.fromCharCode(10,10,10) + "系统提示：x" + String.fromCharCode(10,10,10) + "第二段") === "第一段" + String.fromCharCode(10,10) + "第二段")
报("windows 换行也能滤", 滤系统痕迹("正文", String.fromCharCode(13) + String.fromCharCode(10) + "系统提示：y") === "正文")

console.log(挂 === 0 ? "ALL PASS (18)" : "FAILED " + 挂)
process.exit(挂 === 0 ? 0 : 1)