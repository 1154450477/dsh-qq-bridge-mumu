import { readFileSync } from "node:fs"
// 0.5.6：改成读线上装载本体，测的是真在跑的那份（原来读冻结快照，测不到新代码）
const src = readFileSync("C:/Users/aauv/.dsh/profiles/web/node_modules/dsh-qq-bridge-mumu/lib/host.js", "utf8")
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

// ---- 0.5.6：运行时提醒标记（超时汇报 / QQ 留言）----
const S = String.fromCharCode(0x2063)
const 标 = S + "[[桥提醒]] "
const NL = String.fromCharCode(10)
报("带标记整条复述 -> null", 滤系统痕迹(标 + "系统提示：这一轮已经想了一分多钟") === null)
报("正文 + 标记行 -> 只留正文", 滤系统痕迹("她在查了" + NL + 标 + "系统提示：这一轮") === "她在查了")
报("只剩标记 -> null", 滤系统痕迹(标) === null)
报("纯不可见符行 -> null", 滤系统痕迹(S) === null)
报("防误伤：说「系统提示」四个字", 滤系统痕迹("主人说系统提示这四个字挺好笑") === "主人说系统提示这四个字挺好笑")


// ---- 0.5.7：真样例回归（阿水 2026-10-27 收到的原样）+ 反斜杠判据自检 ----
const U = String.fromCharCode
const 真样例 = U(0x2063) + "[[桥提醒]] 系统提示：这一轮已经想了一分多钟，还没给主人任何回复。请先立刻用 mumu_phone_say 给主人发一句 10 字以内的简短汇报"
报("真样例原样 -> null", 滤系统痕迹(真样例) === null)
报("真样例带前后空格 -> null", 滤系统痕迹("  " + 真样例 + "  ") === null)
报("真样例前多零宽空格 -> null", 滤系统痕迹(U(0x200b) + 真样例) === null)
报("正文+真样例 -> 只留正文", 滤系统痕迹("她在查了" + U(10) + 真样例) === "她在查了")
报("真 [image omitted -> 切掉", 滤系统痕迹("看图" + U(10) + "[image omitted to fit request image limits; \"qq-1.jpg\" (sha256:abc)") === "看图")
报("真 [bili] 行 -> 切掉", 滤系统痕迹("看这个" + U(10) + "[bili] 来源") === "看这个")
报("真 (sha256: 行 -> 切掉", 滤系统痕迹("好" + U(10) + "(sha256:deadbeef)") === "好")
报("防误伤：[[注]] 不是提醒标记", 滤系统痕迹("书上说 [[注]] 是古籍标记") === "书上说 [[注]] 是古籍标记")


// ---- 0.5.8（小鱼方案 2）：先洗零宽字符，再看判据 ----
const U2 = String.fromCharCode
报("零宽洗掉：U+2063 夹在正文里", 滤系统痕迹("在" + U2(0x2063) + "查了") === "在查了")
报("零宽洗掉：U+200B", 滤系统痕迹("在" + U2(0x200b) + "查了") === "在查了")
报("零宽洗掉：BOM", 滤系统痕迹("在" + U2(0xfeff) + "查了") === "在查了")
报("全角空格 + 标记 -> null", 滤系统痕迹(U2(0x3000) + "[[桥提醒]] 系统提示：x") === null)
报("无方括号的桥提醒 -> null", 滤系统痕迹(U2(0x2063) + "桥提醒 系统提示：x") === null)
报("单方括号 [桥提醒] -> null", 滤系统痕迹(U2(0x2063) + "[桥提醒] 系统提示：x") === null)
报("markdown 粗体包裹 -> null", 滤系统痕迹("**" + U2(0x2063) + "[[桥提醒]] 系统提示：x**") === null)
报("正文提到系统提示四字 -> 保留", 滤系统痕迹("那个系统提示好烦啊") === "那个系统提示好烦啊")

console.log(挂 === 0 ? "ALL PASS (39)" : "FAILED " + 挂)
