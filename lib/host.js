// DSH「通到 QQ」· 宿主半边
//
// 这一半只做一件事（先只做 DSH → QQ）：
//   伙伴在「目标会话」里说完一句话（一整轮的最后一句），就自动把它发到 QQ（私聊 / 群）。
//   发 QQ 走 NapCat 的 OneBot HTTP 接口（127.0.0.1:3000），走标准的 OneBot 11 HTTP。
//
// 反过来（QQ → DSH）是下一半，放到另一个插件/进程里做，不在这里混。
//
// ⚠ 安全默认：总开关 = false、试运行 = true —— 不手动打开，一句都不会真的发到 QQ。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createSelfUpdate } from './selfupdate.mjs'

export const name = 'qq-bridge-mumu'

/** 需要宿主提供：webServer（路由）+ sessions/sessionTitle（目标会话清单 + 标题）+ agents（followup）+ timer（轮询收消息）+ attachments（图片）。 */
export const inject = ['agents', 'sessions', 'sessionTitle', 'webServer', 'timer', 'workspaceRegistry', 'attachments']

// ---------- 常量 ----------

const 目录 = process.env.DSH_HOME || join(homedir(), '.dsh')
const 配置文件 = join(目录, 'qq-bridge-config.json')
const 路由前缀 = '/dsh-qq-bridge'
const 旧路由前缀 = '/dsh-qq-bridge-mumu'   // 0.4.5 前的老前缀；设置页 UI 仍在用，两条都注册
const 日志上限 = 60

const 默认配置 = {
  总开关: false, // 关着 = 一句都不发（安全默认）
  试运行: true, // 开着 = 只记账、不真发到 QQ
  目标会话: '', // 盯哪个 DSH 会话（在设置页下拉里选，一般是你平时聊天的那一间）
  私聊QQ: '', // 发到哪个私聊（QQ 号，字符串）
  群号: '', // 发到哪个群（可空）
  转私聊: true,
  转群: false,
  NapCat: 'http://127.0.0.1:3000', // OneBot HTTP 接口（无 token）
  口令: '', // 2026-10-23：OneBot HTTP 的 access_token（后端开了口令就填；留空 = 不带认证头）
  WS直连: true, // ⭐ 默认开：连 OneBot WS 服务端（默认 ws://127.0.0.1:3001）收实时推送，消息一进来立刻进防抖缓冲；WS 直连快而且防抖兼容性好，HTTP 轮询防抖效果很差，只作兜底
  WS地址: 'ws://127.0.0.1:3001', // OneBot WS 服务端地址（默认 ws://127.0.0.1:3001；跟 HTTP 同一个后端，口令共用）
  // ⭐ 2026-10-22：图片两个方向
  收图: true, // QQ → DSH：她发的图片也转进来
  收图最多: 4, // 一条消息最多转几张
  发图: true, // DSH → QQ：伙伴发的图片也发过去
  图上限MB: 5, // 单张最大多少 MB（两个方向共用）
  图片根目录: '', // 正文里 `![名字](相对路径)` 按哪个目录去找（留空 = 自动猜）
  称呼: '对方', // ⭐ 跟它说话的那个人怎么称呼（写进转给它的文案里，比如「小明发来了图片」）
  // ⭐ 2026-10-23：玩手机模式（配合 mumu-mcp 的本地控制口）
  忙时入队: true, // 她在玩手机时，对方发来的话先挂起，不硬塞进回合
  忙时强制回话: false, // 挂起的同时 steer 一下，让她马上回话（默认关）
  停手关键词: '别玩了,不玩了,退出玩手机,停止玩手机,停止操作,手机收起来,收手,回来吧,别玩手机了,结束玩手机,停,停一下,够了,回来', // 对方说这些就立刻收手
  暂停关键词: '暂停,先暂停,暂停一下,歇会儿,歇一下,放一下,待会儿再玩,等会儿再玩', // 对方说这些就先把手机放下（模拟器不关）
  挂起回执: '诶我在玩手机呢～等我一下下就好，你这条我记着了，忙完这阵儿我再回你哈。', // 挂起时回对方一句（她自己的口气）
  挂起回执冷却秒: 60, // 同一个人连着发，别每条都回执
  挂起过期小时: 3, // 挂起超过多久就算过期
  MuMu控制口: 'http://127.0.0.1:8791', // mumu-mcp 的本地控制口（查手机模式 / 入队 / 收手）
}

/** 版本从 package.json 读。 */
const 版本 = (() => {
  try {
    const p = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
    return String(p.version || '?')
  } catch (error) {
    return '?'
  }
})()

// ---------- 配置读写 ----------

function 布(值, 兜) {
  if (值 === true || 值 === 'true' || 值 === 1 || 值 === '1') return true
  if (值 === false || 值 === 'false' || 值 === 0 || 值 === '0') return false
  return 兜
}

function 归一化(原始) {
  const 是对象 = 原始 && typeof 原始 === 'object' && !Array.isArray(原始)
  const 混 = 是对象 ? { ...默认配置, ...原始 } : { ...默认配置 }
  const 字 = (v) => (typeof v === 'string' ? v.trim() : '')
  const 数 = (v, 兜, 低, 高) => {
    const n = Math.round(Number(v))
    if (!Number.isFinite(n)) return 兜
    return Math.max(低, Math.min(n, 高))
  }
  return {
    总开关: 布(混.总开关, 默认配置.总开关),
    试运行: 布(混.试运行, 默认配置.试运行),
    目标会话: 字(混.目标会话),
    私聊QQ: 字(混.私聊QQ),
    群号: 字(混.群号),
    转私聊: 布(混.转私聊, 默认配置.转私聊),
    转群: 布(混.转群, 默认配置.转群),
    NapCat: 字(混.NapCat) || 默认配置.NapCat,
    口令: 字(混.口令),
    WS直连: 布(混.WS直连, 默认配置.WS直连),
    WS地址: 字(混.WS地址) || 默认配置.WS地址,
    收图: 布(混.收图, 默认配置.收图),
    发图: 布(混.发图, 默认配置.发图),
    收图最多: 数(混.收图最多, 默认配置.收图最多, 1, 10),
    图上限MB: 数(混.图上限MB, 默认配置.图上限MB, 1, 30),
    图片根目录: 字(混.图片根目录),
    称呼: 字(混.称呼) || 默认配置.称呼,
    忙时入队: 布(混.忙时入队, 默认配置.忙时入队),
    忙时强制回话: 布(混.忙时强制回话, 默认配置.忙时强制回话),
    停手关键词: 字(混.停手关键词) || 默认配置.停手关键词,
    暂停关键词: 字(混.暂停关键词) || 默认配置.暂停关键词,
    挂起回执: typeof 混.挂起回执 === 'string' ? 混.挂起回执 : 默认配置.挂起回执,
    挂起回执冷却秒: 数(混.挂起回执冷却秒, 默认配置.挂起回执冷却秒, 0, 3600),
    挂起过期小时: 数(混.挂起过期小时, 默认配置.挂起过期小时, 1, 72),
    MuMu控制口: 字(混.MuMu控制口) || 默认配置.MuMu控制口,
  }
}

// ---------- 图片小工具（两个方向共用）----------
// ⭐ 2026-10-22 加：QQ 的图片段（OneBot）可能给 http url、本地路径、base64 三种形态，
//    这里统一成字节；大小和类型都在收的时候判，判不了就当 jpeg。

/** 收进来的图存一份到这儿（纯文本模型看不见图，至少能从文字里找到路径） */

/**
 * ⭐ 会话 id 有两种写法（`xxx` / `session-xxx`）：事件过滤、归档判断、设置页高亮
 *    原来都是**字面比较** ⇒ 存的是裸 id 时对不上。统一去掉 `session-` 前缀再比。
 */
const 会话键 = (v) => {
  const s = String(v == null ? '' : v).trim()
  return s.startsWith('session-') ? s.slice('session-'.length) : s
}

const 收图目录 = join(目录, 'qq-bridge-inbox')

/**
 * ⭐ 2026-10-22：DSH 存图时会留一份「归一化副本」（官方文档原话：may be resized or re-encoded），
 *    GIF 到这一步就变成静态 webp 了 —— 所以回发时必须用**我们自己留的原图**。
 *    这张表记「附件 id → 我们存的原图路径」，回发时先查它。
 */
const 收图表 = join(目录, 'qq-bridge-received.json')

function 读收图表() {
  try {
    const j = JSON.parse(readFileSync(收图表, 'utf8'))
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {}
  } catch (error) {
    return {}
  }
}

/** 路径统一：去掉两头引号/空格，Windows 下大小写不敏感 */
const 清路径 = (p) => String(p || '').trim().replace(/^["']+|["']+$/g, '').trim()

/**
 * 记「附件 / DSH 那份只读副本 → 我们存的原图」。
 * ⚠ 两个键都要记：伙伴回发时可能用附件 id（附件块），也可能照抄 DSH 给的那条
 *   只读副本路径（正文里的 markdown 图）—— 后者是常见情况，第一次就漏了。
 */
function 记收图(附件id, 副本路径, 原图路径) {
  const 原 = String(原图路径 || '').trim()
  if (!原) return
  const id = String(附件id || '').trim()
  const 副 = 清路径(副本路径)
  if (!id && !副) return
  try {
    const 表 = 读收图表()
    const 记 = { p: 原, t: Date.now() }
    if (id) 表['id:' + id] = 记
    if (副) 表['p:' + 副.toLowerCase()] = 记
    // 只留最近 200 条，别让这个文件无限长
    const 留 = Object.entries(表).sort((a, b) => Number((b[1] && b[1].t) || 0) - Number((a[1] && a[1].t) || 0)).slice(0, 200)
    writeFileSync(收图表, JSON.stringify(Object.fromEntries(留)), 'utf8')
  } catch (error) {}
}

/** 这张图能不能换回原图？键可以是 `id:<附件id>`，也可以是 `p:<副本路径>` */
function 原图路径(键) {
  const k = String(键 || '').trim()
  if (!k) return ''
  const 表 = 读收图表()
  const 记 = 表[k] || 表[k.toLowerCase()] || 表[String(k).replace(/^id:/, '')]
  const p = 记 && typeof 记.p === 'string' ? 记.p : ''
  if (!p) return ''
  try { return existsSync(p) ? p : '' } catch (error) { return '' }
}

const 扩展 = (类) => (类 === 'image/png' ? 'png' : 类 === 'image/gif' ? 'gif' : 类 === 'image/webp' ? 'webp' : 'jpg')

function 看图类(字节) {
  try {
    if (字节[0] === 0x89 && 字节[1] === 0x50) return 'image/png'
    if (字节[0] === 0x47 && 字节[1] === 0x49) return 'image/gif'
    if (字节[0] === 0x52 && 字节[1] === 0x49 && 字节[8] === 0x57) return 'image/webp'
  } catch (error) {}
  return 'image/jpeg'
}

/** 从 OneBot 的图片段里把字节抠出来：url → file(本地/base64://) 依次试 */
async function 取图字节(数据) {
  const d = 数据 || {}
  const url = typeof d.url === 'string' ? d.url.trim() : ''
  if (url) {
    if (url.startsWith('file://')) {
      try { return readFileSync(new URL(url)) } catch (error) {}
    } else if (/^https?:/i.test(url)) {
      try {
        const r = await fetch(url)
        if (r.ok) return Buffer.from(await r.arrayBuffer())
      } catch (error) {}
    }
  }
  const f = typeof d.file === 'string' ? d.file.trim() : ''
  if (f.startsWith('base64://')) {
    try { return Buffer.from(f.slice('base64://'.length), 'base64') } catch (error) {}
  }
  if (f && (f.includes('\\') || f.includes('/'))) {
    try { return readFileSync(f) } catch (error) {}
  }
  return null
}

/** 存一份到收图目录，返回路径（存不下就返回空串，不影响转图） */
function 存一张(名字, 字节, 类) {
  try {
    mkdirSync(收图目录, { recursive: true })
    const p = join(收图目录, `${名字}.${扩展(类)}`)
    writeFileSync(p, 字节)
    return p
  } catch (error) {
    return ''
  }
}

function 读配置() {
  try {
    return 归一化(JSON.parse(readFileSync(配置文件, 'utf8')))
  } catch (error) {
    return 归一化(null)
  }
}

function 写配置(配置) {
  try {
    mkdirSync(目录, { recursive: true })
    writeFileSync(配置文件, JSON.stringify(配置, null, 2), 'utf8')
    return true
  } catch (error) {
    return false
  }
}

// ---------- 纯函数（导出给冒烟测试喂） ----------

/** 从一条 assistant 消息里只抽出正文（text 块拼起来；reasoning / image 都不要）。 */
export function 提取正文(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/** ⭐ 2026-10-23：DSH 写进 assistant 消息流的系统提示（供模型看的运行时元信息）不是她的发言，别转发 QQ。
 *    形如「Time sampled while preparing turn N, step M: …」「Elapsed since the preceding model-visible message: …」
 *    「Current runtime context. …」「Current working directory: …」「Current DSH file policy: …」等。
 *    判据：块首命中这些特征才算（她正文里引用这类句子不会出现在块首）。 */
export function 是系统提示文字(文字) {
  const s = String(文字 || '').trim()
  if (!s) return true // 空文本块本来就没内容
  return /^(Time sampled while preparing turn|Elapsed since the preceding|Current runtime context\.|Current working directory:|Current DSH file policy:|Approval policy:|Browser time zone for this request:|Interpret otherwise-unqualified dates|\[Compressed conversation section\]|<system-reminder>|<available_skills>|<compacted-summary>|<acp )/.test(s)
}

/** 抽正文时丢掉系统提示块：剩下的才真正发到 QQ。 */
export function 提取净正文(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string' && !是系统提示文字(b.text))
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/** 拼一个 OneBot「私聊 text 段」消息体。 */
export function 私人消息体(text) {
  return { user_id: 0, message: [{ type: 'text', data: { text } }] }
}

/** 拼一个 OneBot「群 text 段」消息体。 */
export function 群消息体(text) {
  return { group_id: 0, message: [{ type: 'text', data: { text } }] }
}

/** ⭐ 2026-10-22：从一条 assistant 消息里挑出图片块（要发到 QQ 的那几张）。 */
export function 提取图块(message) {
  if (!message || !Array.isArray(message.content)) return []
  return message.content.filter((b) => b && b.type === 'image' && b.attachment).slice(0, 10)
}

/** 拼一个 OneBot「图片段」（base64 直接塞，不依赖 QQ 那边能不能访问本地文件）。 */
export function 图片段(base64) {
  return { type: 'image', data: { file: 'base64://' + String(base64) } }
}

/**
 * ⭐ 2026-10-22：正文里那种 markdown 图片 `![名字](路径)` 也当图片发。
 *    伙伴发贴纸就是这么发的（`![小肥鱼](_stickers/feiyu-test.webp)`）——
 *    以前只认附件块，这种一律被当成普通文字发过去，QQ 那边看到的是一串 markdown。
 * @returns {净文字, 图: [{kind:'url'|'path', value}]}
 */
export function 抠正文图(文字) {
  const 图 = []
  const 净文字 = String(文字 || '')
    .replace(/!\[[^\]]*\]\(\s*([^)\s]+)\s*\)/g, (全, 路径) => {
      const p = String(路径 || '').trim()
      if (!p) return ''
      if (/^https?:\/\//i.test(p)) {
        if (!图.some((x) => x.value === p)) 图.push({ kind: 'url', value: p })
        return ''
      }
      if (!图.some((x) => x.value === p)) 图.push({ kind: 'path', value: p })
      return ''
    })
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { 净文字, 图 }
}

// 包根：用来读自己的 package.json（版本 + 仓库地址）
const 包根 = join(dirname(fileURLToPath(import.meta.url)), '..')

export function apply(ctx) {
  // ⭐ 设置页那个「检查更新」：查这个插件自己的仓库
  createSelfUpdate({ packageRoot: 包根, diag: 记账 }).register(ctx, 路由前缀)
  // ---------- 状态 ----------

  const 日志 = []
  let 上一轮 = { 轮号: -1, 文本: '', 图们: [] }
  // ⭐ 2026-10-23：手机模式要用「对方最后一次来消息」和「她最后一次有动静」的时间
  let 最后来消息时间 = 0
  let 最后活动时间 = 0
  let 上次回执时间 = 0
  let 上次问手机报错 = 0
  const 已发轮 = new Set()
  const 已转消息 = new Set() // 已经转发进 DSH 的 QQ 消息 id（防重复转）
  let 上次私聊时间 = Math.floor(Date.now() / 1000) // 从这一刻起只认新消息，不补旧的
  let 上次群时间 = Math.floor(Date.now() / 1000)

  function 记账(文本) {
    const d = new Date()
    const 补 = (n) => String(n).padStart(2, '0')
    const 时间 = `${补(d.getMonth() + 1)}-${补(d.getDate())} ${补(d.getHours())}:${补(d.getMinutes())}:${补(d.getSeconds())}`
    日志.push({ 时间, 文本 })
    if (日志.length > 日志上限) 日志.shift()
    try {
      ctx.logger?.info(`qq-bridge: ${文本}`)
    } catch (error) {}
  }

  // 2026-10-23：OneBot 11 的 access_token —— 后端开了口令就必须带（Authorization: Bearer），否则一律 401。
  function 认证头() {
    const t = String((读配置() || {}).口令 || '').trim()
    return t ? { authorization: 'Bearer ' + t } : {}
  }

  async function 发一个(base, action, 体) {
    try {
      const r = await fetch(`${base}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...认证头() },
        body: JSON.stringify(体),
      })
      const j = await r.json()
      return { action, ok: !!(j && j.status === 'ok' && j.retcode === 0), 数据: j }
    } catch (error) {
      return { action, ok: false, 数据: { 错: String((error && error.message) || error) } }
    }
  }

  /** 一条气泡最多这么多字，超了自动拆开（主人 2026-10-23 定：一条只说一件事）。 */
  const 气泡上限 = 40

  /** 按中文句末标点切句，标点跟着前一句走。 */
  function 切句(段, 标点们) {
    const 出 = []
    let 缓 = ''
    for (const 字 of 段) {
      缓 += 字
      if (标点们.indexOf(字) >= 0) {
        出.push(缓.trim())
        缓 = ''
      }
    }
    if (缓.trim()) 出.push(缓.trim())
    return 出.filter((s) => s.length > 0)
  }

  /** 一句还是太长（只有逗号没有句号），就按逗号再切一刀；实在不行硬切。 */
  function 再切细(句) {
    if (句.length <= 气泡上限) return [句]
    const 逗句 = 切句(句, '，、；,;')
    const 出 = []
    for (const c of 逗句) {
      if (c.length <= 气泡上限) { 出.push(c); continue }
      for (let i = 0; i < c.length; i += 气泡上限) 出.push(c.slice(i, i + 气泡上限))
    }
    return 出.filter((s) => s.length > 0)
  }

  /**
   * ⭐ 2026-10-23：把一段文字拆成一条条能单独发的短气泡。
   *   ① 先按换行拆（空行、单行都算换行）
   *   ② 哪段还是太长，就切句再按上限拼回去 —— 不许一条塞一大坨
   *   ③ 单句仍超长，按逗号再切，最后兜底硬切
   *   主人截图骂过「好几条很长堆一起」，所以这里是硬卡子，不靠自觉。
   */
  function 按段拆(文字) {
    const 段们 = String(文字 || '')
      .split(/\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    const 出 = []
    for (const 段 of 段们) {
      if (段.length <= 气泡上限) {
        出.push(段)
        continue
      }
      const 句们 = 切句(段, '。！？…～!?')
      let 缓 = ''
      const 收 = (x) => {
        if (!缓) { 缓 = x; return }
        if ((缓 + x).length <= 气泡上限) { 缓 += x; return }
        出.push(缓)
        缓 = x
      }
      for (const 句 of 句们) for (const 片 of 再切细(句)) 收(片)
      if (缓) 出.push(缓)
    }
    return 出
  }

  /** ⭐ 打字要时间：短句快、长句慢（主人 2026-10-23 定的节奏）。 */
  function 打字间隔(文本) {
    const n = String(文本 || '').length
    return Math.min(6000, 220 + n * 55)
  }

  /**
   * 相对路径的图按哪儿找：
   *   ① 设置里的「图片根目录」（填了就以它为准）
   *   ② **目标会话所在的那个工作区**（自动的，一般不用填）
   *   ③ 其它登记过的工作区
   *   ④ 进程当前目录 ⑤ <DSH_HOME>/workspace ⑥ 用户主目录
   * 找到就返回绝对路径。
   */
  function 找本地图(p, 配置) {
    const 原 = String(p || '').trim()
    if (!原) return ''
    const 试 = []
    if (/^[a-zA-Z]:[\\/]/.test(原) || 原.startsWith('\\\\') || 原.startsWith('/')) 试.push(原)
    else {
      const 根们 = []
      const 设 = String(配置.图片根目录 || '').trim()
      if (设) 根们.push(设)
      try {
        const 登记 = ctx.workspaceRegistry || ctx.get('workspaceRegistry')
        const 列表 = (登记 && typeof 登记.list === 'function' ? 登记.list() : []) || []
        const 目标 = String(配置.目标会话 || '')
        // ⭐ 先把「目标会话所在的工作区」排到前面 —— 这个才是它平时待的地方
        const 排 = 列表.slice().sort((a, b) => {
          const A = a && Array.isArray(a.sessionIds) && a.sessionIds.map(String).indexOf(目标) >= 0 ? 0 : 1
          const B = b && Array.isArray(b.sessionIds) && b.sessionIds.map(String).indexOf(目标) >= 0 ? 0 : 1
          return A - B
        })
        for (const w of 排) {
          const d = w && (typeof w.path === 'string' ? w.path : (w.directory || w.dir || w.root))
          if (typeof d === 'string' && d) 根们.push(d)
        }
      } catch (error) {}
      根们.push(process.cwd(), join(目录, 'workspace'), homedir())
      for (const r of 根们) 试.push(join(String(r), 原))
    }
    for (const 全 of 试) {
      try { if (existsSync(全)) return 全 } catch (error) {}
    }
    记账('找不到这张图：' + 原 + '（试过：' + 试.slice(0, 4).join(' ｜ ') + ' 等 ' + 试.length + ' 个位置；可在设置里填「图片根目录」）')
    return ''
  }

  /** 把一句正文发到该发的地方（私聊 / 群）；按空行拆段，一段一条连发。⭐ 末尾再加上图片。 */
  async function 发到QQ(配置, 原文字, 图们) {
    const 出 = []
    // ⭐ 正文里的 markdown 图（贴纸就是这么发的）也当图片发；抠掉之后正文更干净
    const 抠过 = 配置.发图 ? 抠正文图(原文字) : { 净文字: String(原文字 || ''), 图: [] }
    const 文字 = 抠过.净文字
    const 段们 = 按段拆(文字).length ? 按段拆(文字) : [String(文字 || '').trim()].filter((s) => s.length > 0)
    const 发段延迟 = 450 // 每段之间隔一下，像真人一条条发
    const 最大 = Math.max(1, Math.min(Number(配置.图上限MB) || 5, 30)) * 1024 * 1024
    // ⭐ 图片：base64 或网络地址，QQ 那边直接收，不用访问本机文件
    const 图数据 = []
    const 加图 = (源) => {
      if (!源 || 图数据.length >= 4) return
      if (源.kind === 'url') { 图数据.push({ url: 源.value }); return }
      let 值 = 源.value
      // ⭐ 伙伴回发时常常照抄 DSH 给的那条「只读副本」路径（webp）——
      //    先反查一次表，能换回我们存的原图就换（GIF 才是动的）
      const 换 = 原图路径('p:' + 清路径(值).toLowerCase())
      if (换) 值 = 换
      const 全 = 找本地图(值, 配置) || 值
      try {
        const buf = readFileSync(全)
        if (buf.length > 最大) { 记账(`这张图太大（${Math.round(buf.length / 1048576)}MB），跳过`); return }
        图数据.push({ b64: buf.toString('base64') })
      } catch (error) {
        记账('读图失败，跳过：' + String((error && error.message) || error))
      }
    }
    if (配置.发图) {
      for (const 源 of 抠过.图) 加图(源)
      if (Array.isArray(图们) && 图们.length) {
        const 附件 = ctx.attachments || ctx.get('attachments')
        for (const 块 of 图们) {
          try {
            // ⭐ 优先用我们收下来的**原图**（DSH 那份副本会被转码，GIF 会变静态）
            const 原 = 原图路径('id:' + String((块.attachment && 块.attachment.attachmentId) || ''))
            if (原) { 加图({ kind: 'path', value: 原 }); continue }
            const p = 附件 && typeof 附件.imageHostPath === 'function' ? 附件.imageHostPath(块.attachment) : undefined
            if (!p) { 记账('这张图拿不到本地文件，跳过'); continue }
            加图({ kind: 'path', value: p })
          } catch (error) {
            记账('读图失败，跳过：' + String((error && error.message) || error))
          }
        }
      }
    }
    // 一条 OneBot 图片段：本地图走 base64，网络图直接把 url 交给 QQ
    const 一段图 = (x) => (x.url ? { type: 'image', data: { file: x.url, url: x.url } } : 图片段(x.b64))

    if (配置.转私聊 && 配置.私聊QQ) {
      for (let i = 0; i < 段们.length; i++) {
        const 体 = 私人消息体(段们[i])
        体.user_id = Number(配置.私聊QQ)
        出.push(await 发一个(配置.NapCat, 'send_private_msg', 体))
        if (i < 段们.length - 1) await new Promise((r) => setTimeout(r, 打字间隔(段们[i])))
      }
      for (const x of 图数据) {
        出.push(await 发一个(配置.NapCat, 'send_private_msg', { user_id: Number(配置.私聊QQ), message: [一段图(x)] }))
        await new Promise((r) => setTimeout(r, 发段延迟))
      }
    }
    if (配置.转群 && 配置.群号) {
      for (let i = 0; i < 段们.length; i++) {
        const 体 = 群消息体(段们[i])
        体.group_id = Number(配置.群号)
        出.push(await 发一个(配置.NapCat, 'send_group_msg', 体))
        if (i < 段们.length - 1) await new Promise((r) => setTimeout(r, 打字间隔(段们[i])))
      }
      for (const x of 图数据) {
        出.push(await 发一个(配置.NapCat, 'send_group_msg', { group_id: Number(配置.群号), message: [一段图(x)] }))
        await new Promise((r) => setTimeout(r, 发段延迟))
      }
    }
    return 出
  }

  /** 一轮真正落地：总开关 / 试运行 在这儿把关。 */
  async function 落地一发(配置, 文字, 图们) {
    if (已发轮.size > 300) 已发轮.clear() // 防 Set 无限长
    if (!配置.目标会话) return 记账('还没填「目标会话」，不知道该盯哪个，这轮不转')
    // ⭐ 盯的会话已经归档了：别转（人已经不在这儿说话了）
    try {
      const 登记 = ctx.workspaceRegistry || ctx.get('workspaceRegistry')
      const 归档 = new Set((((登记 && 登记.archivedSessionIds) || [])).map(String))
      if (归档.has(会话键(配置.目标会话))) return 记账('「目标会话」已经归档了，这轮不转（去设置里重新挑一个）')
    } catch (error) {}
    if (!配置.总开关) return 记账('总开关关着，这轮该转但没转')
    const 抠过 = 配置.发图 ? 抠正文图(文字) : { 净文字: 文字, 图: [] }
    const 几张 = (Array.isArray(图们) ? 图们.length : 0) + 抠过.图.length
    const 图标 = 几张 ? `（还有 ${几张} 张图）` : ''
    const 净文 = String(抠过.净文字 || '')
    if (配置.试运行) {
      return 记账(`试运行：本来要发到 QQ →「${净文.slice(0, 40)}${净文.length > 40 ? '…' : ''}」${图标}`)
    }
    const 结果 = await 发到QQ(配置, 文字, 图们)
    const 全过 = 结果.length > 0 && 结果.every((r) => r.ok)
    if (结果.length === 0) {
      记账('转私聊 / 转群都没开，或没填 QQ 号 / 群号，或者这轮既没有文字也没有图（而且图都没转成）：没地方发')
      return
    }
    记账(`${全过 ? '✅ 已发到 QQ：' : '⚠ 发 QQ 有问题：'}「${净文.slice(0, 50)}${净文.length > 50 ? '…' : ''}」${图标}`)
    for (const r of 结果) {
      if (!r.ok) 记账(`   ${r.action} 失败：${JSON.stringify(r.数据).slice(0, 140)}`)
    }
  }

  // ---------- 手机模式（配合 mumu-mcp）：挂起 / 停手 / 直发 ----------

  const 控口 = (配置) => {
    let 口 = String((配置 && 配置.MuMu控制口) || '').trim()
    while (口.endsWith('/')) 口 = 口.slice(0, -1)
    return 口
  }

  /** 问 mumu-mcp 的控制口：手机模式开没开、挂着几条消息。 */
  async function 问手机(配置) {
    const 口 = 控口(配置)
    if (!口) return null
    try {
      const r = await fetch(口 + '/state', { method: 'GET' })
      const j = await r.json()
      return j && j.ok ? j : null
    } catch (error) {
      const 现在报 = Date.now()
      if (现在报 - 上次问手机报错 > 60000) {
        上次问手机报错 = 现在报
        记账('问不到 MuMu 控制口（' + 口 + '）：' + String((error && error.message) || error))
      }
      return null
    }
  }

  /** 她是不是在玩手机：手机模式开着，或者刚刚（3 分钟内）动过手机。
   *  只看 mode.active 会漏掉一种情况：主人喊停后模式关了，可她那一回合还在玩，
   *  这时候对方发来的话还是会排进 DSH 队列里等半天。 */
  function 手机在玩(手机态) {
    if (!手机态) return false
    if (手机态.mode && 手机态.mode.active) return true
    return !!手机态.playing
  }

  /** 把对方发来的一条话挂到 mumu-mcp 的 pending 队列。 */
  async function 挂起消息(配置, 文字) {
    const 口 = 控口(配置)
    if (!口 || !String(文字 || '').trim()) return null
    try {
      const r = await fetch(口 + '/pending', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: String(文字), sender_name: 配置.称呼 || '对方', platform: 'qq' }),
      })
      const j = await r.json()
      return j && j.ok ? j : null
    } catch (error) {
      记账('挂起失败：' + String((error && error.message) || error))
      return null
    }
  }

  /** 让 mumu-mcp 结束手机模式（对方喊停 / 手动收手）。 */
  async function 结束手机(配置, 原因, 暂停) {
    const 口 = 控口(配置)
    if (!口) return null
    try {
      const r = await fetch(口 + '/exit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: String(原因 || ''), pause: !!暂停 }),
      })
      const j = await r.json()
      return j && j.ok ? j : null
    } catch (error) {
      记账('结束手机模式失败：' + String((error && error.message) || error))
      return null
    }
  }

  /** 对方说的是不是「别玩了 / 收手 / 停 / 够了」这种收手话。 */
  function 命中停手(文字, 配置) {
    const 文 = String(文字 || '').trim()
    if (!文) return false
    const 词们 = []
    for (const 一 of String(配置.停手关键词 || '').split(/[,，、]+/)) {
      for (const 个 of String(一).split(' ')) {
        const 词 = String(个).trim()
        if (词) 词们.push(词)
      }
    }
    for (const 词 of 词们) {
      if (文 === 词) return true
      if (词.length >= 3 && 文.includes(词)) return true
    }
    return false
  }

  /** 对方说的是不是「暂停 / 歇会儿 / 等会儿再玩」这种先放下的。 */
  function 命中暂停(文字, 配置) {
    const 文 = String(文字 || '').trim()
    if (!文) return false
    const 词们 = []
    for (const 一 of String(配置.暂停关键词 || '').split(/[,，、]+/)) {
      for (const 个 of String(一).split(' ')) {
        const 词 = String(个).trim()
        if (词) 词们.push(词)
      }
    }
    for (const 词 of 词们) {
      if (文 === 词) return true
      if (文.includes(词)) return true
    }
    return false
  }

  /** 直接发一句到 QQ（不走回合）：总开关 / 试运行照样把关。 */
  async function 直接发QQ(配置, 文字) {
    const 文 = String(文字 || '').trim()
    if (!文) return { 状态: '空', 说: '没有文字' }
    if (!配置.总开关) return { 状态: '关', 说: '总开关关着' }
    if (配置.试运行) {
      记账('试运行：本来要发到 QQ →「' + 文.slice(0, 40) + (文.length > 40 ? '…' : '') + '」')
      return { 状态: '试', 说: '试运行：只记账，没真发' }
    }
    if (!配置.私聊QQ && !配置.群号) return { 状态: '无处', 说: '没填私聊 QQ 或群号' }
    const 结果 = await 发到QQ(配置, 文)
    const 全过 = 结果.length > 0 && 结果.every((r) => r.ok)
    记账((全过 ? '✅ 已发到 QQ：' : '⚠ 发 QQ 有问题：') + '「' + 文.slice(0, 50) + (文.length > 50 ? '…' : '') + '」')
    for (const r of 结果) if (!r.ok) 记账('   ' + r.action + ' 失败：' + JSON.stringify(r.数据).slice(0, 140))
    return 全过 ? { 状态: '发', 说: '发过去了' } : { 状态: '失败', 说: '没发出去' }
  }

  /** 挂起时回对方一句（她自己的口气），冷却时间内不重复回。 */
  async function 发挂起回执(配置) {
    const 文案 = String(配置.挂起回执 || '').trim()
    if (!文案) return false
    const 冷却 = Math.max(0, Number(配置.挂起回执冷却秒) || 0) * 1000
    const 现在 = Date.now()
    if (冷却 && 现在 - 上次回执时间 < 冷却) return false
    上次回执时间 = 现在
    const 结果 = await 直接发QQ(配置, 文案)
    记账('挂起回执（' + 结果.状态 + '）：' + 文案.slice(0, 40))
    return 结果.状态 === '发' || 结果.状态 === '试'
  }

  /** 盯会话事件：记住这一轮最后一句，在 turn/end 时落地。 */
  function 收到事件(session, event) {
    const 配置 = 读配置()
    if (!配置.目标会话) return
    if (会话键(session && session.id) !== 会话键(配置.目标会话)) return

    if (event && event.type === 'assistant/message') {
      const d = event.data || {}
      if (d.interrupted) {
        上一轮 = { 轮号: -1, 文本: '', 图们: [] }
        return
      }
      最后活动时间 = Date.now()
      // ⭐ 她在这轮吭声了 → 超时汇报提醒就别再发了
      if (d.turn === 本轮号) {
        本轮已吭声 = true
        if (回合汇报定时器) { clearTimeout(回合汇报定时器); 回合汇报定时器 = null }
      }
      const 文 = String(提取净正文(d.message) || '').trim()
      const 图们 = 提取图块(d.message)
      if (文) 上一轮 = { 轮号: d.turn, 文本: 文, 图们 }
      // ⭐ 有的回合是先出图、后出字（或只出图）：别把图丢了
      else if (图们.length) 上一轮 = { 轮号: d.turn, 文本: 上一轮.轮号 === d.turn ? 上一轮.文本 : '', 图们: (上一轮.轮号 === d.turn ? 上一轮.图们 : []).concat(图们).slice(0, 10) }
      return
    }

    if (event && event.type === 'turn/start') {
      // ⭐ 长回合保护：记下回合开始的时刻，她想得久（≥60 秒）时来新消息就不取消（见 转一批）
      本轮开始时间 = Date.now()
      本轮号 = Number((event.data || {}).turn) || -1
      本轮已吭声 = false
      // ⭐ 超时汇报提醒（0.5.0，主人定）：一轮超过 60 秒还没吭声，就往她回合里插一条
      //   系统提示，让她先用 mumu_phone_say 给主人报一句 10 字以内（「在查，稍等」这种）。
      //   只提醒一次/轮；她一吭声（assistant/message）就撤销。
      if (回合汇报定时器) { clearTimeout(回合汇报定时器); 回合汇报定时器 = null }
      回合汇报定时器 = setTimeout(() => {
        回合汇报定时器 = null
        void (async () => {
          try {
            const 配置 = 读配置()
            if (!配置.总开关 || !配置.目标会话) return
            const agent = 找agent(配置.目标会话)
            if (!agent || String(agent.status || '') !== 'running') return   // 回合已经完了
            if (本轮已吭声 || 本轮号 < 0) return                              // 她说过话了 / 不知道轮号
            if (typeof agent.steer !== 'function') return
            await agent.steer(手搓用户消息('系统提示：这一轮已经想了一分多钟，还没给主人任何回复。请先立刻用 mumu_phone_say 给主人发一句 10 字以内的简短汇报（比如「在查，稍等」「在看小黑盒呢」「在选图片」），让他知道你在干嘛，然后继续手头的事。'))
            记账('回合超时提醒 → 已 steer 系统提示（让她先 say 一句 10 字内）')
          } catch (error) {
            记账('回合超时提醒失败：' + String((error && error.message) || error))
          }
        })()
      }, 回合汇报阈值)
      return
    }

    if (event && event.type === 'turn/end') {
      最后活动时间 = Date.now()
      if (回合汇报定时器) { clearTimeout(回合汇报定时器); 回合汇报定时器 = null }
      const d = event.data || {}
      const 完成 = !!(d.reason && d.reason.kind === 'completed')
      const 有东西 = 上一轮.文本 || (上一轮.图们 && 上一轮.图们.length)
      if (完成 && 上一轮.轮号 === d.turn && 有东西 && !已发轮.has(d.turn)) {
        已发轮.add(d.turn)
        void 落地一发(配置, 上一轮.文本, 上一轮.图们)
      }
      上一轮 = { 轮号: -1, 文本: '', 图们: [] }
      本轮开始时间 = 0
      // ⭐ 长回合保护的冲刷口：她回合结束了，把她想的时候攒下来的消息转进去（走正常转一批）
      if (批缓冲.length && !批定时器) {
        批定时器 = setTimeout(() => {
          批定时器 = null
          void 转一批().catch((error) => {
            try { 记账(`回合结束转出失败：${String((error && error.message) || error)}`) } catch (e2) {}
          })
        }, 消息防抖窗口)
        记账(`她回合结束 → 攒着的 ${批缓冲.length} 条消息 ${Math.round(消息防抖窗口 / 1000)} 秒后转进`)
      }
    }
  }

  // ---------- 路由（将来给设置页用；现在也能用来手动试） ----------

  const 回 = (res, o) => {
    try {
      res.setHeader?.('content-type', 'application/json; charset=utf-8')
      res.end?.(JSON.stringify(o))
    } catch (error) {}
  }

  const 读体 = async (req) => {
    let body = ''
    try {
      for await (const chunk of req) body += chunk
    } catch (error) {}
    try {
      return JSON.parse(body || '{}')
    } catch (error) {
      return {}
    }
  }

  const 短id = (id) => {
    const s = String(id)
    return s.length <= 8 ? s : s.slice(-8)
  }

  /* 拿目标会话活着的 agent：带 / 不带 `session-` 前缀两个方向都试（照 speak-up 的写法）。 */
  const 找agent = (id) => {
    const 原 = String(id == null ? '' : id).trim()
    if (原 === '') return undefined
    const 候选 = [原]
    if (原.startsWith('session-')) 候选.push(原.slice('session-'.length))
    else 候选.push('session-' + 原)
    for (const 一个 of 候选) {
      try {
        const a = ctx.agents.get(一个)
        if (a !== undefined) return a
      } catch (error) {}
    }
    return undefined
  }

  const 新id = () => {
    try {
      return randomUUID()
    } catch (error) {
      return 'qq-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    }
  }

  /** 手搓一条 user 消息（跟 speak-up 一样：role=user，source.kind 标成 qq，不冒充她亲手打的）。 */
  const 手搓用户消息 = (文案) => ({
    id: 新id(),
    role: 'user',
    content: [{ type: 'text', text: String(文案) }],
    source: { kind: 'qq' },
  })

  /** 现在开着的会话清单（id + 标题），给设置页挑「目标会话」用 —— 不手填。 */
  const 会话清单 = () => {
    const 出 = []
    // ⭐ 归档的会话不列（归档只是藏起来，list() 里还在 —— 得单独查 workspaceRegistry 的名单）
    //   2026-10-20 修：以前完全不看归档，设置页里挑会话时混着一堆已经归档的
    const 归档 = new Set()
    try {
      const 登记 = ctx.workspaceRegistry || ctx.get('workspaceRegistry')
      for (const x of (登记 && 登记.archivedSessionIds) || []) 归档.add(String(x))
    } catch (error) {}
    try {
      const 会话服务 = ctx.get('sessions')
      const 标题服务 = ctx.get('sessionTitle')
      if (会话服务 && typeof 会话服务.list === 'function') {
        for (const s of 会话服务.list()) {
          if (归档.has(String(s.id))) continue
          let 标题 = ''
          try {
            const 快照 = 标题服务 && typeof 标题服务.get === 'function' ? 标题服务.get(s) : undefined
            标题 = 快照 && 快照.title ? String(快照.title) : ''
          } catch (error) {}
          出.push({ id: String(s.id), 标题 })
        }
      }
    } catch (error) {}
    return 出
  }

  const 概况 = async () => {
    const 配置 = 读配置()
    const 清单 = 会话清单()
    let NapCat状态 = null
    try {
      const r = await fetch(`${配置.NapCat}/get_login_info`, { method: 'POST', headers: { 'content-type': 'application/json', ...认证头() }, body: '{}' })
      const j = await r.json()
      if (j && j.status === 'ok') NapCat状态 = { 用户: j.data.user_id, 昵称: j.data.nickname }
    } catch (error) {
      NapCat状态 = { 错: String((error && error.message) || error) }
    }
    const 手机 = await 问手机(配置)
    return { ok: true, 版本, 配置, 配置文件, NapCat状态, 手机状态: 手机, 活着的会话: 清单, 目标情况: 配置.目标会话 && 清单.length ? 清单.filter((x) => 会话键(x.id) === 会话键(配置.目标会话)) : [], 日志 }
  }

  const 路线 = (路径, handler) => {
    if (路径.startsWith(路由前缀) && 旧路由前缀) {
      // ⭐ 0.5.1：设置页（client.js）全部请求走旧前缀 /dsh-qq-bridge-mumu/*，而 0.4.5 起 host
      //   实际注册的是 /dsh-qq-bridge/* —— 设置页因此一直「读取中…」。这里每条路由同时注册
      //   新旧两个前缀（比改 client.js 稳：已发布的设置页和文档里到处都是旧路径）。
      ctx.effect(() =>
        ctx.webServer.register({
          kind: 'exact',
          path: 旧路由前缀 + 路径.slice(路由前缀.length),
          handler: async (req, res) => {
            try {
              await handler(req, res)
            } catch (error) {
              回(res, { ok: false, 说: String((error && error.message) || error) })
            }
          },
        }),
      )
    }
    return ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: 路径,
        handler: async (req, res) => {
          try {
            await handler(req, res)
          } catch (error) {
            回(res, { ok: false, 说: String((error && error.message) || error) })
          }
        },
      }),
    )
  }

  路线(`${路由前缀}/state`, async (req, res) => {
    await 读体(req)
    回(res, await 概况())
  })

  路线(`${路由前缀}/save`, async (req, res) => {
    const 来 = await 读体(req)
    const 现在 = 读配置()
    const 新 = { ...现在, ...(来 && typeof 来 === 'object' ? 来 : {}) }
    const 洗好 = 归一化(新)
    if (!写配置(洗好)) return 回(res, { ok: false, 说: `写不进配置文件：${配置文件}` })
    const 状态 = 洗好.总开关 ? (洗好.试运行 ? '（只记账）' : '（真发）') : '（总开关关着）'
    记账(`设置已保存：目标会话 ${洗好.目标会话 || '（没填）'}｜私聊 ${洗好.私聊QQ || '（没填）'}｜群 ${洗好.群号 || '（没填）'}｜${状态}`)
    回(res, { ...(await 概况()), 说: '保存好了' })
  })

  // 收到 QQ 里你发来的话 → 喂进目标会话，让它照常开一轮。
  // ⚠ 这是「QQ → DSH」那半的**入口函数**：一句正文（+ 图）→ agent.followup 走 DSH 自己的回合。
  // ⭐ 2026-10-22：加了图片。图会先落一份到 `~/.dsh/qq-bridge-inbox/`，再把图交给 DSH 的
  //    attachments；模型能看图就直接看，纯文本模型拿到的是一句占位文字 —— 所以文字里也写上本地路径。
  async function 转入一条(文字, 图们, 消息id) {
    const 配置 = 读配置()
    if (!配置.目标会话) return { ok: false, 说: '还没选「目标会话」' }
    if (!配置.总开关) return { ok: false, 说: '总开关关着，先打开' }
    const agent = 找agent(配置.目标会话)
    if (!agent) return { ok: false, 说: `目标会话现在没活着（${短id(配置.目标会话)}），先把它打开` }

    // ── 收图：限量、限重，失败就跳过，不挡住文字 ──
    const 收下 = []
    if (配置.收图 && Array.isArray(图们) && 图们.length) {
      const 上限 = Math.max(1, Math.min(Number(配置.收图最多) || 4, 10))
      const 最大 = Math.max(1, Math.min(Number(配置.图上限MB) || 5, 30)) * 1024 * 1024
      let 序 = 0
      for (const 段 of 图们.slice(0, 上限)) {
        序 += 1
        const buf = await 取图字节(段 && 段.data ? 段.data : 段)
        if (!buf || !buf.length) { 记账(`第 ${序} 张图下载失败，跳过`); continue }
        if (buf.length > 最大) { 记账(`第 ${序} 张图太大（${Math.round(buf.length / 1048576)}MB），跳过`); continue }
        const 类 = 看图类(buf)
        收下.push({ 类, b64: buf.toString('base64'), 存: 存一张(`${消息id || 'qq'}-${序}`, buf, 类), 字节: buf.length })
      }
    }

    const 原话 = String(文字 || '').trim()
    const 谁 = String(配置.称呼 || '对方')
    const 说明 = 收下.length
      ? String.fromCharCode(10) + '（' + 谁 + '发了 ' + 收下.length + ' 张图：'
        + 收下.map((x, i) => `第${i + 1}张 ${Math.round(x.字节 / 1024)}KB` + (x.存 ? `，要发回去就用 ${x.存}` : '')).join('；')
        + '）'
      : ''
    const 文案 = (原话 || (收下.length ? '（' + 谁 + '发来了图片，没有配字）' : '')) + 说明
    if (!文案) return { ok: false, 说: '这条既没文字也没图，不转' }

    let content = [{ type: 'text', text: 文案 }]
    if (收下.length) {
      const 附件 = ctx.attachments || ctx.get('attachments')
      if (附件 && typeof 附件.admitPromptContent === 'function') {
        try {
          const 待 = content.concat(收下.map((x, i) => ({
            type: 'image', data: x.b64, mediaType: x.类, name: `qq-${消息id || 'x'}-${i + 1}.${扩展(x.类)}`,
          })))
          content = await 附件.admitPromptContent(待)
          // ⭐ 记下「附件 id / DSH 那份只读副本 → 我们存的原图」，回发时换回原图（GIF 不会变静态 webp）
          const 图块 = content.filter((x) => x && x.type === 'image' && x.attachment)
          for (let i = 0; i < 图块.length && i < 收下.length; i++) {
            let 副本 = ''
            try { 副本 = typeof 附件.imageHostPath === 'function' ? String(附件.imageHostPath(图块[i].attachment) || '') : '' } catch (error) {}
            记收图(图块[i].attachment && 图块[i].attachment.attachmentId, 副本, 收下[i].存)
          }
        } catch (error) {
          记账('图交给 DSH 没成功（这轮只转文字）：' + String((error && error.message) || error))
          content = [{ type: 'text', text: 文案 }]
        }
      } else {
        记账('宿主没有 attachments 服务，图只能存本地（文字里已经给了路径）')
      }
    }

    try {
    // ── 手机模式：她在玩手机时，对方发来的话先挂起，不硬塞进回合 ──
    最后来消息时间 = Date.now()
    const 手机态 = await 问手机(配置)
    const 在玩手机 = 手机在玩(手机态)
    if (在玩手机) {
      // 先判暂停：「暂停一下」里也含「停一下」，所以暂停要排在停手前面。
      if (命中暂停(原话, 配置)) {
        const 之前在玩 = !!(手机态 && 手机态.mode && 手机态.mode.active)
        await 结束手机(配置, '对方喊暂停', true)
        if (之前在玩) {
          const 收口 = await 直接发QQ(配置, '好，我先放下，手机留着，想玩再叫我。')
          记账('对方喊暂停 → 手机放下了，模拟器留着（回执：' + 收口.状态 + '）')
        } else {
          记账('对方喊暂停 → 手机已经放着了（不用再放一次）')
        }
        return { ok: true, 说: '手机先放下了（模拟器没关）' }
      }
      if (命中停手(原话, 配置)) {
        const 之前在玩 = !!(手机态 && 手机态.mode && 手机态.mode.active)
        await 结束手机(配置, '对方喊停')
        if (之前在玩) {
          const 收口 = await 直接发QQ(配置, '好，手机收起来了，模拟器也关上了。')
          记账('对方喊停 → 手机模式已结束、手机已关（回执：' + 收口.状态 + '）')
        } else {
          记账('对方喊停 → 手机已经收好了（不用再收一次）')
        }
        return { ok: true, 说: '手机收起来了（模拟器已关）' }
      }
      const 忙 = String((agent && agent.status) || '') === 'running'
      if (忙 && 配置.忙时入队) {
        const 挂 = await 挂起消息(配置, 原话)
        await 发挂起回执(配置)
        if (配置.忙时强制回话 && agent && typeof agent.steer === 'function') {
          try {
            await agent.steer(手搓用户消息(原话))
            记账('挂起的同时 steer 了一下（强制回话开着）')
          } catch (error) {
            记账('steer 失败：' + String((error && error.message) || error))
          }
        }
        记账('对方来消息了，她在玩手机 → 已挂起' + (挂 ? '（' + String(挂.条数) + ' 条等着）' : '（挂起失败）'))
        return { ok: true, 说: '她正在玩手机，这条先挂起了' }
      }
    }

      // ⚠⚠ 必须 await：followup 返回 Promise。不接住的话，它 reject 时（会话半死 / agent 已释放）
      //   catch 根本看不到（try 早就退出了）⇒ 未处理的 rejection ⇒ **整个 DSH 宿主退出**
      //   （2026-10-21：speak-up 同一个坑已经被用户报成"装了鱼就死了"，这里一并修）
      await agent.followup({ id: 新id(), role: 'user', content, source: { kind: 'qq' } })
      // 兜底记时：这轮多半刚被我们叫起；马上会有 turn/start 事件来覆盖成更准的时刻
      本轮开始时间 = Date.now()
      try {
        if (ctx.sessions && typeof ctx.sessions.flush === 'function') await ctx.sessions.flush(agent.session)
      } catch (error) {}
      const 图话 = 收下.length ? `（含 ${收下.length} 张图）` : ''
      记账(`收到 QQ 里的${收下.length ? '图片' : '话'}${图话} → 转进 DSH：「${(原话 || '（没配字）').slice(0, 50)}${原话.length > 50 ? '…' : ''}」`)
      return { ok: true, 说: '转进去了，它会照常开一轮' }
    } catch (error) {
      return { ok: false, 说: `followup 失败：${String((error && error.message) || error)}` }
    }
  }

  /** 只要文字的那条老入口（给 /receive 路由和测试用） */
  async function 转入文字(文字) {
    return 转入一条(文字, [], '')
  }

  /**
   * 轮询 NapCat 的 HTTP 历史接口，把「她新发的私聊 / 群消息」一条条转进 DSH。
   * ⚠ 纯 HTTP 轮询：不连 WebSocket、不依赖 BOT。
   * ⚠ 只认 `私聊QQ` 这个人发的（群也一样按这个号过滤），自己的回话不会自我繁殖。
   */
  async function 轮询收消息() {
    const 配置 = 读配置()
    // 总开关关 / 没选会话：只把「上次时间」推到此刻，别开的时候就补一大串旧的
    if (!配置.总开关 || !配置.目标会话) {
      上次私聊时间 = Math.floor(Date.now() / 1000)
      上次群时间 = Math.floor(Date.now() / 1000)
      return
    }
    const 她的号 = Number(配置.私聊QQ) || 0

    const 拉 = async (action, 体) => {
      try {
        const r = await fetch(`${配置.NapCat}/${action}`, {
          method: 'POST', headers: { 'content-type': 'application/json', ...认证头() }, body: JSON.stringify(体),
        })
        const j = await r.json()
        return j && j.status === 'ok' && Array.isArray(j.data && j.data.messages) ? j.data.messages : []
      } catch (error) {
        return []
      }
    }
    const 条转片段 = (条) => {
      const 段们 = Array.isArray(条.message) ? 条.message : []
      const 文字 = 段们.map((s) => (s && s.type === 'text' && s.data ? String(s.data.text) : '')).join('').trim()
      // ⭐ 图片 / 表情包都算图（表情包 mface 也带 url，能拿到字节）
      const 图们 = 段们.filter((s) => s && s.data && (s.type === 'image' || s.type === 'mface'))
      return { 文字, 图们 }
    }

    if (配置.转私聊 && 配置.私聊QQ) {
      const 列表 = await 拉('get_friend_msg_history', { user_id: 她的号, count: 10 })
      for (const 条 of 列表.sort((a, b) => (a.time || 0) - (b.time || 0))) {
        if (!条 || Number(条.user_id) !== 她的号) continue
        if ((条.time || 0) < 上次私聊时间) continue           // 旧的，跳过
        if (已转消息.has(条.message_id)) continue             // 转过了
        上次私聊时间 = 条.time || 上次私聊时间
        const { 文字, 图们 } = 条转片段(条)
        已转消息.add(条.message_id)
        // 纯表情（没图没字）就别转了，记掉别再反复拉
        if (!文字 && !图们.length) continue
        进批(文字, 图们, 条.message_id)
      }
    }

    if (配置.转群 && 配置.群号) {
      const 列表 = await 拉('get_group_msg_history', { group_id: Number(配置.群号), count: 30 })
      for (const 条 of 列表.sort((a, b) => (a.time || 0) - (b.time || 0))) {
        if (!条 || Number(条.user_id) !== 她的号) continue     // 群里只认她
        if ((条.time || 0) < 上次群时间) continue
        if (已转消息.has(条.message_id)) continue
        上次群时间 = 条.time || 上次群时间
        const { 文字, 图们 } = 条转片段(条)
        已转消息.add(条.message_id)
        if (!文字 && !图们.length) continue
        进批(文字, 图们, 条.message_id)
      }
    }

    if (已转消息.size > 300) 已转消息.clear()
  }

  // ── 3 秒消息防抖（新消息重置）：新消息先进缓冲，安静满 3 秒整批一次转进 DSH ──
  // 之前是逐条立即 followup：连发 3 条会拆成 3 次唤醒、3 个独立轮次，又慢又乱。
  const 消息防抖窗口 = 3000   // 静默窗口：最后一条之后安静满 3 秒才转出（新消息会重置）
  const 回合上限 = 30000  // 防饿死：从第一条算起最多攒 30 秒必转（期间新消息插进来就重置静默计时）
  // ⭐ 长回合保护（主人 2026-10-24 定，写死）：她这轮已经想了超过 60 秒就不取消 ——
  //   让她把想完的说完；消息留在缓冲里，等 turn/end 的冲刷口（见 收到事件）再转进。
  //   回合还年轻（<60 秒）才照老规矩取消旧回合、合并重开。
  const 长回合保护 = 60000
  const 回合汇报阈值 = 60000   // ⭐ 0.5.0：一轮超过这么久没吭声 → steer 系统提示让她先用 say 汇报一句
  let 回合汇报定时器 = null
  let 本轮号 = -1              // 当前回合号（turn/start 事件带）
  let 本轮已吭声 = false        // 她这轮出过 assistant/message 就算吭声过
  let 回合中 = false      // 目标 agent 是否正跑着回合（agent-loop 的 phase.kind !== "idle"）
  let 本轮开始时间 = 0    // 当前回合的开始时刻：turn/start 事件优先；桥自己转进成功时兜底（没盯上事件也能估）
  const 批缓冲 = []      // { 文字, 图们, 消息id, 时间 }
  let 批定时器 = null
  function 进批(文字, 图们, 消息id) {
    const 现在 = Date.now()
    批缓冲.push({ 文字, 图们, 消息id, 时间: 现在 })
    if (批定时器) clearTimeout(批定时器)     // 新消息插进缓冲，重置静默计时
    // 统一安静窗口（主人 2026-10-23 定的合并语义）：不管她闲着还是回合中，
    // 都等安静满 5 秒再整批转出。回合中转出时（见 转一批）先 cancel 旧回合再合并重开 ——
    // 所以她回合中连发的消息会先攒在缓冲里合成一条，而不是一条条排队进去。
    const 首条年龄 = 现在 - 批缓冲[0].时间
    const 等 = Math.max(0, Math.min(消息防抖窗口, 回合上限 - 首条年龄))
    批定时器 = setTimeout(() => {
      批定时器 = null
      void 转一批().catch((error) => {
        try { 记账(`防抖转出失败：${String((error && error.message) || error)}`) } catch (e2) {}
      })
    }, 等)
  }
  async function 转一批() {
    if (!批缓冲.length) return
    const agent = 找agent(读配置().目标会话 || '')
    回合中 = !!agent && agent.status === 'running'
    // ⭐ 手机模式检查（2026-10-24 补：WS 推送路径此前绕过了转入一条() 里的手机检查，
    //   她玩手机时主人的消息被照常转进/取消，她根本看不到 → 全走这个漏斗统一拦）：
    //   在玩 → 挂起（她玩完由 mumu-mcp 提醒）+ 回执；喊停/暂停 → 照旧结束手机模式。
    const 配置0 = 读配置()
    if (配置0.总开关) {
      const 手机态 = await 问手机(配置0)
      if (手机在玩(手机态)) {
        const 批0 = 批缓冲
        const 合并话 = 批0.map((x) => String(x.文字 || '').trim()).filter(Boolean).join(String.fromCharCode(10))
        if (命中暂停(合并话, 配置0)) {
          const 之前在玩 = !!(手机态 && 手机态.mode && 手机态.mode.active)
          await 结束手机(配置0, '对方喊暂停', true)
          批缓冲.splice(0, 批缓冲.length)
          if (之前在玩) {
            const 收口 = await 直接发QQ(配置0, '好，我先放下，手机留着，想玩再叫我。')
            记账('对方喊暂停 → 手机放下了，模拟器留着（回执：' + 收口.状态 + '）')
          } else {
            记账('对方喊暂停 → 手机已经放着了（不用再放一次）')
          }
          return { ok: true, 说: '手机先放下了（模拟器没关）' }
        }
        if (命中停手(合并话, 配置0)) {
          const 之前在玩 = !!(手机态 && 手机态.mode && 手机态.mode.active)
          await 结束手机(配置0, '对方喊停')
          批缓冲.splice(0, 批缓冲.length)
          // ⭐ 2026-10-25（0.4.9，主人定）：不取消她的回合——把主人的原话 steer 进她正在跑的回合里，
          //   让她自己判断「继续玩还是收手」。模拟器已经关了，她下一调手机工具会失败/发现没机子，
          //   自然会收口说「手机收起来了」；想赖着玩也没戏，机器不在了。
          if (回合中 && agent && typeof agent.steer === 'function') {
            try {
              await agent.steer(手搓用户消息(合并话))
              记账('对方喊停 → 已把原话插进她正在跑的回合（让她自己决定收不收）')
            } catch (error) {
              记账('steer 喊停失败（回合可能刚好结束）：' + String((error && error.message) || error))
            }
          }
          if (之前在玩) {
            const 收口 = await 直接发QQ(配置0, '好，手机收起来了，模拟器也关上了。')
            记账('对方喊停 → 手机模式已结束、手机已关（回执：' + 收口.状态 + '）')
          } else {
            记账('对方喊停 → 手机已经收好了（不用再收一次）')
          }
          return { ok: true, 说: '手机收起来了（模拟器已关）' }
        }
        const 挂 = await 挂起消息(配置0, 合并话)
        await 发挂起回执(配置0)
        批缓冲.splice(0, 批缓冲.length)
        记账('她在玩手机 → 批里的 ' + 批0.length + ' 条已挂起' + (挂 ? '（' + String(挂.条数 || 1) + ' 条等着）' : '（挂起失败）'))
        return { ok: true, 说: '她正在玩手机，这批先挂起了' }
      }
    }
    // ⭐ 长回合保护：她这轮已经想了 ≥60 秒就不取消 —— 让她把想完的说完，消息留在缓冲里，
    //   等 turn/end 的冲刷口（收到事件）再转进。不知道回合多老（本轮开始时间=0，
    //   比如刚重启、turn/start 没盯上）就按老规矩取消合并，不会误攒。
    if (回合中 && 本轮开始时间 > 0) {
      const 已跑 = Date.now() - 本轮开始时间
      if (已跑 >= 长回合保护) {
        记账(`消息防抖：${批缓冲.length} 条消息攒着（她这轮已经想了 ${Math.round(已跑 / 1000)} 秒，保护不取消，等回合结束再转进）`)
        return
      }
    }
    const 批 = 批缓冲.splice(0, 批缓冲.length)
    const 文字 = 批.map((x) => String(x.文字 || '').trim()).filter(Boolean).join(String.fromCharCode(10))
    const 图们 = 批.flatMap((x) => Array.isArray(x.图们) ? x.图们 : [])
    const 首个消息id = 批[0].消息id || ''
    记账(回合中
      ? `消息防抖：${批.length} 条消息（她回合中来新消息）→ 取消旧回合，合并重开`
      : `消息防抖：${批.length} 条消息（等了 3 秒没有新的）→ 一次转进`)
    // 回合中 → 取消她没发完的回合（keepInbox 保留排队项），新旧消息合成一批重开一轮。
    // 主人 2026-10-23 定：收到新消息就合并、抛弃旧回合 —— 与其让她照着旧语境说一半，
    // 不如让她拿着完整的新语境重新想。
    if (回合中) {
      const agent2 = 找agent(读配置().目标会话 || '')
      if (agent2 && typeof agent2.cancel === 'function') {
        try {
          agent2.cancel({ kind: 'user' }, { keepInbox: true })
          记账(`她回合中来新消息 → 已取消旧回合（保留排队项），新消息与缓冲合并后重开一轮`)
        } catch (error) {
          记账(`取消旧回合失败，改为排队转入：${String((error && error.message) || error)}`)
        }
      }
    }
    await 转入一条(文字, 图们, 首个消息id)
  }

  路线(`${路由前缀}/receive`, async (req, res) => {
    const 来 = await 读体(req)
    const 文字 = typeof 来.text === 'string' ? 来.text.trim() : ''
    if (!文字) return 回(res, { ok: false, 说: '没有文字（body 里给 text）' })
    回(res, await 转入文字(文字))
  })

  // ⭐ 直发通道：mumu_phone_say 走这里（不等回合，直接发到 QQ）
  路线(路由前缀 + '/say', async (req, res) => {
    const 来 = await 读体(req)
    const 文字 = String((来 && 来.text) || '').trim()
    if (!文字) return 回(res, { ok: false, 说: '没有文字（body 里给 text）' })
    const 配置 = 读配置()
    const 结果 = await 直接发QQ(配置, 文字)
    return 回(res, { ok: 结果.状态 === '发' || 结果.状态 === '试', 说: 结果.说, 状态: 结果.状态 })
  })

  // ⭐ 起一回合：自主玩调度器用它喊她起来玩
  路线(路由前缀 + '/turn', async (req, res) => {
    const 来 = await 读体(req)
    const 文字 = String((来 && 来.text) || '').trim()
    if (!文字) return 回(res, { ok: false, 说: '没有文字（body 里给 text）' })
    const 配置 = 读配置()
    if (!配置.总开关) return 回(res, { ok: false, 说: '总开关关着' })
    const agent = 找agent(配置.目标会话)
    if (!agent) return 回(res, { ok: false, 说: '目标会话没活着' })
    const 模式 = String((来 && 来.mode) || 'followup')
    try {
      if (模式 === 'steer' && typeof agent.steer === 'function') {
        await agent.steer(手搓用户消息(文字))
      } else {
        await agent.followup(手搓用户消息(文字))
      }
      记账('（回合通道）' + 模式 + '：' + 文字.slice(0, 60))
      return 回(res, { ok: true, 说: '轮次已发起' })
    } catch (error) {
      return 回(res, { ok: false, 说: String((error && error.message) || error) })
    }
  })

  // ⭐ 忙闲状态：自主玩调度器要看「她有没有在跑」「对方多久没来消息了」
  路线(路由前缀 + '/agent-state', async (req, res) => {
    await 读体(req)
    const 配置 = 读配置()
    const agent = 找agent(配置.目标会话)
    const 手机 = await 问手机(配置)
    return 回(res, {
      ok: true,
      status: agent ? String(agent.status || '') : '',
      alive: !!agent,
      last_user_msg_ts: 最后来消息时间,
      last_activity_ts: 最后活动时间,
      手机模式: !!(手机 && 手机.mode && 手机.mode.active),
      pending: 手机 && Array.isArray(手机.pending) ? 手机.pending.length : 0,
    })
  })

  // ⭐ 手动收手：设置页点一下就结束手机模式
  路线(路由前缀 + '/stop-phone', async (req, res) => {
    await 读体(req)
    const 配置 = 读配置()
    const 结果 = await 结束手机(配置, '手动收手')
    return 回(res, { ok: !!结果, 说: 结果 ? '手机模式已结束' : '结束不了（控制口没连上）' })
  })

  // ⭐ 挂起队列（调试用，看看她攒了多少话）
  路线(路由前缀 + '/pending', async (req, res) => {
    await 读体(req)
    const 配置 = 读配置()
    const 手机 = await 问手机(配置)
    return 回(res, { ok: true, 挂起: (手机 && 手机.pending) || [] })
  })

  // 手动试一发：**真发**（绕过试运行），只发一条固定测试句，动不了已发轮
  路线(`${路由前缀}/test-send`, async (req, res) => {
    await 读体(req)
    const 配置 = 读配置()
    if (!配置.私聊QQ && !配置.群号) return 回(res, { ok: false, 说: '私聊 QQ 和群号都是空的，先保存一个再试' })
    const 文字 = '（这是一条测试消息：DSH → QQ 通了）'
    const 结果 = await 发到QQ(配置, 文字)
    const 全过 = 结果.length > 0 && 结果.every((r) => r.ok)
    记账(`手动测试：${全过 ? '✅ 已发' : '⚠ 有问题'}「${文字}」`)
    for (const r of 结果) if (!r.ok) 记账(`   ${r.action} 失败：${JSON.stringify(r.数据).slice(0, 140)}`)
    回(res, { ok: 全过, 说: 全过 ? '测试句已经发到 QQ 了' : '有一步没发出去（看下面的记录）', 记录: 日志 })
  })

  // ---------- 挂监听 ----------

  ctx.effect(() => {
    const 摘 = ctx.on('session/event', (session, event) => {
      try {
        收到事件(session, event)
      } catch (error) {
        记账(`转发时出错：${String((error && error.message) || error)}`)
      }
    })
    return () => {
      try {
        if (typeof 摘 === 'function') 摘()
      } catch (error) {}
    }
  }, 'qq-bridge: 盯伙伴说话')

  // 轮询 NapCat 收「她新发的 QQ」→ 转进 DSH（QQ → DSH 这半，不赖 BOT）
  // ⭐ 2026-10-23：加了 WS 直连（见下）后，轮询从「主力」降级成「兜底」——WS 推送把消息
  //    一送到就进消息防抖（~0.1s），轮询只负责 WS 断线/漏推送时把历史里的新消息补进来。
  //    周期 2000ms → 1000ms（兜底相位延迟再砍一半；对 NapCat/SnowLuma 没有压力，就一个本地 HTTP 调用）。
  ctx.effect(() => {
    if (typeof ctx.interval !== 'function') {
      记账('拿不到 timer（ctx.interval 不在）—— QQ → DSH 的轮询收消息跑不起来，但 DSH → QQ 照常能用')
      return () => {}
    }
    const 停 = ctx.interval(() => {
      void 提醒挂起消息().catch((error) => { try { 记账('提醒挂起出错：' + String((error && error.message) || error)) } catch (e2) {} })
      void 轮询收消息().catch((error) => {
        try { ctx.logger?.info(`qq-bridge: 轮询出错：${String((error && error.message) || error)}`) } catch (e2) {}
      })
    }, 1000)
    return () => {
      try {
        if (typeof 停 === 'function') 停()
      } catch (error) {}
    }
  }, 'qq-bridge: 轮询收 QQ 消息')

  // 她闲下来了，但 QQ 上还有没回的挂起消息 → 提醒她处理（不然那些消息没人看）
  let 上次提醒挂起 = 0
  const 已提醒过的 = new Set()  // 已经提醒过哪几条，别同一批消息反复往回送
  async function 提醒挂起消息() {
    const 配置 = 读配置()
    if (!配置.总开关 || !配置.忙时入队) return
    const agent = 找agent(配置.目标会话)
    if (!agent) return
    if (String(agent.status || '') === 'running') return
    const 现在 = Date.now()
    const 口 = 控口(配置)
    if (!口) return
    let items = []
    try {
      const r = await fetch(口 + '/pending', { method: 'GET' })
      const j = await r.json()
      items = (j && j.ok && Array.isArray(j.items)) ? j.items : []
    } catch (error) {
      return
    }
    if (!items.length) return
    // 只提醒「新」的消息：同一批没回过的别每分钟往回送一次。
    const 在队的 = new Set(items.map((x) => String((x && x.id) || '')).filter(Boolean))
    for (const id of Array.from(已提醒过的)) {
      if (!在队的.has(id)) 已提醒过的.delete(id)  // 她已经处理掉了，忘掉
    }
    const 新的 = items.filter((x) => !已提醒过的.has(String((x && x.id) || '')))
    if (!新的.length) {
      // 没有新消息：最多 30 分钟再兜底提一次，别一分钟一回把她吵醒。
      if (现在 - 上次提醒挂起 < 1800000) return
    }
    // 有新消息就立刻提醒，不管冷却；冷却只管「老消息」的兜底提醒。
    上次提醒挂起 = 现在
    for (const x of 新的) 已提醒过的.add(String((x && x.id) || ''))
    const 要说的 = 新的.length ? 新的 : items
    const 摘要 = 要说的
      .map((x) => 'id=' + String((x && x.id) || '') + '「' + String((x && x.text) || '').slice(0, 60) + '」')
      .join(' / ')
      .slice(0, 300)
    try {
      await agent.followup(手搓用户消息('（QQ 上有人给你留了消息，还没回）' + 摘要 + '——想回就用 mumu_phone_say(msg_id=..., text=...) 直发；不想回就当没看见（提醒完我顺手把这批标掉，不会再一遍遍提醒你）。'))
      记账('提醒：她闲下来了，QQ 上有 ' + 要说的.length + ' 条挂起消息没回' + (新的.length ? '（新消息）' : '（老消息兜底）'))
    } catch (error) {
      记账('提醒挂起消息失败：' + String((error && error.message) || error))
      return
    }
    // 提醒完顺手把这批标掉（mumu-mcp 控制口 /pending/handled）——队列清空了就不会
    // 每分钟再往回送同一批消息。她要是想回，id 已经在提醒里给了，照样能回。
    for (const x of 要说的) {
      const id = String((x && x.id) || '')
      if (!id) continue
      try {
        await fetch(口 + '/pending/handled', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        })
      } catch (error) {
        记账('标记挂起消息失败：' + String((error && error.message) || error))
      }
    }
  }

  // ⭐ 2026-10-23：WS 直连 —— 连 OneBot WS 服务端（SnowLuma ws-1，默认 ws://127.0.0.1:3001），
  //    消息事件 post_type=message 一到就进消息防抖（实测 ~0.1s 送达，vs 历史轮询的 6~7s 可见性滞后）。
  //    事件字段和 HTTP 历史接口同构（message_id / user_id / time / message 段），所以直接复用
  //    轮询那套「过滤 + 去重 + 进批」逻辑；轮询降级为兜底（WS 断线或漏推送时补历史）。
  //    认证：isAuthorized 认 Authorization: Bearer <token> 或 ?access_token= —— 用配置里的 口令。
  let WS线 = null
  let WS重连定时器 = null
  let WS已连过 = false
  function WS摘要(段们) {
    const 段 = Array.isArray(段们) ? 段们 : []
    const 文字 = 段.map((s) => (s && s.type === 'text' && s.data ? String(s.data.text) : '')).join('').trim()
    const 图们 = 段.filter((s) => s && s.data && (s.type === 'image' || s.type === 'mface'))
    return { 文字, 图们 }
  }
  function 处理WS事件(原始) {
    let ev = null
    try { ev = JSON.parse(原始) } catch (error) { return }
    if (!ev || ev.post_type !== 'message') return          // 只认真消息（心跳/lifecycle/回执都不要）
    const 配置 = 读配置()
    if (!配置.总开关) return
    const 她的号 = Number(配置.私聊QQ) || 0
    const 是私聊 = ev.message_type === 'private'
    const 是群 = ev.message_type === 'group'
    if (是私聊 && 配置.转私聊 && 她的号 && Number(ev.user_id) === 她的号) {
      if (已转消息.has(ev.message_id)) return
      已转消息.add(ev.message_id)
      const { 文字, 图们 } = WS摘要(ev.message)
      if (!文字 && !图们.length) return
      上次私聊时间 = Math.max(上次私聊时间, ev.time || 0)   // 推送已处理，兜底轮询别再补这条
      最后来消息时间 = Date.now()
      进批(文字, 图们, ev.message_id)
      记账(`WS 推送收到私聊 → 进防抖：「${文字.slice(0, 40) || '（图片）'}」`)
    } else if (是群 && 配置.转群 && 她的号 && Number(ev.user_id) === 她的号) {
      if (已转消息.has(ev.message_id)) return
      已转消息.add(ev.message_id)
      const { 文字, 图们 } = WS摘要(ev.message)
      if (!文字 && !图们.length) return
      上次群时间 = Math.max(上次群时间, ev.time || 0)
      最后来消息时间 = Date.now()
      进批(文字, 图们, ev.message_id)
      记账(`WS 推送收到群消息 → 进防抖：「${文字.slice(0, 40) || '（图片）'}」`)
    }
  }
  function 连WS() {
    const 配置 = 读配置()
    if (!配置.WS直连 || !配置.总开关) return
    const 地址 = String(配置.WS地址 || '').trim()
    if (!地址) return
    try {
      if (WS线) { try { WS线.close() } catch (error) {} WS线 = null }
      const tok = String(配置.口令 || '').trim()
      const ws = new WebSocket(地址, tok ? { headers: { authorization: 'Bearer ' + tok } } : undefined)
      WS线 = ws
      ws.addEventListener('open', () => {
        WS已连过 = true
        记账(`WS 直连已连上 ${地址} —— 消息改走实时推送，轮询降为兜底`)
      })
      ws.addEventListener('message', (ev) => {
        try { 处理WS事件(String(ev.data)) } catch (error) {}
      })
      ws.addEventListener('close', () => {
        if (WS线 !== ws) return                        // 已经被新连接顶掉了
        WS线 = null
        if (WS已连过) 记账('WS 直连断了，靠 HTTP 轮询兜底；5 秒后重连')
        if (WS重连定时器) clearTimeout(WS重连定时器)
        WS重连定时器 = setTimeout(() => { WS重连定时器 = null; try { 连WS() } catch (error) {} }, 5000)
      })
      ws.addEventListener('error', () => { try { ws.close() } catch (error) {} })
    } catch (error) {
      记账('WS 直连连不上（' + String((error && error.message) || error) + '），靠 HTTP 轮询兜底')
    }
  }
  ctx.effect(() => {
    连WS()
    return () => {
      try { if (WS重连定时器) clearTimeout(WS重连定时器) } catch (error) {}
      try { if (WS线) { WS线.close(); WS线 = null } } catch (error) {}
    }
  }, 'qq-bridge: WS 直连收 QQ 消息')

  记账(`已装好 v${版本}：DSH↔QQ 两半都在｜总开关 ${读配置().总开关 ? '开' : '关'}｜试运行 ${读配置().试运行 ? '开（只记账）' : '关（真发）'}｜收消息 WS 直连${读配置().WS直连 ? '开' : '关'} + 1 秒轮询兜底`)

  return { 记账, 概况, 落地一发, 发到QQ, 收到事件, 日志 }
}