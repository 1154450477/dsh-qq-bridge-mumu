// DSH「通到 QQ」· 宿主半边
//
// 这一半只做一件事（先只做 DSH → QQ）：
//   大肥鱼在「目标会话」里说完一句话（一整轮的最后一句），就自动把它发到 QQ（私聊 / 群）。
//   发 QQ 走 NapCat 的 OneBot HTTP 接口（127.0.0.1:3000），**不经过 Estrella（BOT鱼）**。
//
// 反过来（QQ → DSH）是下一半，放到另一个插件/进程里做，不在这里混。
//
// ⚠ 安全默认：总开关 = false、试运行 = true —— 不手动打开，一句都不会真的发到 QQ。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'qq-bridge'

/** 需要宿主提供 webServer（注册 /dsh-qq-bridge/* 路由，将来给设置页用）。 */
export const inject = ['webServer']

// ---------- 常量 ----------

const 目录 = process.env.DSH_HOME || join(homedir(), '.dsh')
const 配置文件 = join(目录, 'qq-bridge-config.json')
const 路由前缀 = '/dsh-qq-bridge'
const 日志上限 = 60

const 默认配置 = {
  总开关: false, // 关着 = 一句都不发（安全默认）
  试运行: true, // 开着 = 只记账、不真发到 QQ
  目标会话: '', // 盯哪个 DSH 会话（填「大肥鱼 × 小鱿鱼」那个会话的 id）
  私聊QQ: '', // 发到哪个私聊（QQ 号，字符串）
  群号: '', // 发到哪个群（可空）
  转私聊: true,
  转群: false,
  NapCat: 'http://127.0.0.1:3000', // OneBot HTTP 接口（无 token）
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
  return {
    总开关: 布(混.总开关, 默认配置.总开关),
    试运行: 布(混.试运行, 默认配置.试运行),
    目标会话: 字(混.目标会话),
    私聊QQ: 字(混.私聊QQ),
    群号: 字(混.群号),
    转私聊: 布(混.转私聊, 默认配置.转私聊),
    转群: 布(混.转群, 默认配置.转群),
    NapCat: 字(混.NapCat) || 默认配置.NapCat,
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

/** 拼一个 OneBot「私聊 text 段」消息体。 */
export function 私人消息体(text) {
  return { user_id: 0, message: [{ type: 'text', data: { text } }] }
}

/** 拼一个 OneBot「群 text 段」消息体。 */
export function 群消息体(text) {
  return { group_id: 0, message: [{ type: 'text', data: { text } }] }
}

export function apply(ctx) {
  // ---------- 状态 ----------

  const 日志 = []
  let 上一轮 = { 轮号: -1, 文本: '' }
  const 已发轮 = new Set()

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

  async function 发一个(base, action, 体) {
    try {
      const r = await fetch(`${base}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(体),
      })
      const j = await r.json()
      return { action, ok: !!(j && j.status === 'ok' && j.retcode === 0), 数据: j }
    } catch (error) {
      return { action, ok: false, 数据: { 错: String((error && error.message) || error) } }
    }
  }

  /** 把一句正文发到该发的地方（私聊 / 群，按配置）。 */
  async function 发到QQ(配置, 文字) {
    const 出 = []
    if (配置.转私聊 && 配置.私聊QQ) {
      const 体 = 私人消息体(文字)
      体.user_id = Number(配置.私聊QQ)
      出.push(await 发一个(配置.NapCat, 'send_private_msg', 体))
    }
    if (配置.转群 && 配置.群号) {
      const 体 = 群消息体(文字)
      体.group_id = Number(配置.群号)
      出.push(await 发一个(配置.NapCat, 'send_group_msg', 体))
    }
    return 出
  }

  /** 一轮真正落地：总开关 / 试运行 在这儿把关。 */
  async function 落地一发(配置, 文字) {
    if (已发轮.size > 300) 已发轮.clear() // 防 Set 无限长
    if (!配置.目标会话) return 记账('还没填「目标会话」，不知道该盯哪个，这轮不转')
    if (!配置.总开关) return 记账('总开关关着，这轮该转但没转')
    if (配置.试运行) {
      return 记账(`试运行：本来要发到 QQ →「${文字.slice(0, 40)}${文字.length > 40 ? '…' : ''}」`)
    }
    const 结果 = await 发到QQ(配置, 文字)
    const 全过 = 结果.length > 0 && 结果.every((r) => r.ok)
    if (结果.length === 0) {
      记账('转私聊 / 转群都没开，或没填 QQ 号 / 群号：没地方发')
      return
    }
    记账(`${全过 ? '✅ 已发到 QQ：' : '⚠ 发 QQ 有问题：'}「${文字.slice(0, 50)}${文字.length > 50 ? '…' : ''}」`)
    for (const r of 结果) {
      if (!r.ok) 记账(`   ${r.action} 失败：${JSON.stringify(r.数据).slice(0, 140)}`)
    }
  }

  /** 盯会话事件：记住这一轮大肥鱼最后一句，在 turn/end 时落地。 */
  function 收到事件(session, event) {
    const 配置 = 读配置()
    if (!配置.目标会话) return
    if (String(session && session.id) !== String(配置.目标会话)) return

    if (event && event.type === 'assistant/message') {
      const d = event.data || {}
      if (d.interrupted) {
        上一轮 = { 轮号: -1, 文本: '' }
        return
      }
      const 文 = 提取正文(d.message)
      if (文) 上一轮 = { 轮号: d.turn, 文本: 文 }
      return
    }

    if (event && event.type === 'turn/end') {
      const d = event.data || {}
      const 完成 = !!(d.reason && d.reason.kind === 'completed')
      if (完成 && 上一轮.轮号 === d.turn && 上一轮.文本 && !已发轮.has(d.turn)) {
        已发轮.add(d.turn)
        void 落地一发(配置, 上一轮.文本)
      }
      上一轮 = { 轮号: -1, 文本: '' }
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

  const 概况 = async () => {
    const 配置 = 读配置()
    let NapCat状态 = null
    try {
      const r = await fetch(`${配置.NapCat}/get_login_info`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const j = await r.json()
      if (j && j.status === 'ok') NapCat状态 = { 用户: j.data.user_id, 昵称: j.data.nickname }
    } catch (error) {
      NapCat状态 = { 错: String((error && error.message) || error) }
    }
    return { ok: true, 版本, 配置, 配置文件, NapCat状态, 日志 }
  }

  const 路线 = (路径, handler) =>
    ctx.effect(() =>
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

  // 手动试一发：**真发**（绕过试运行），只发一条固定测试句，动不了已发轮
  路线(`${路由前缀}/test-send`, async (req, res) => {
    await 读体(req)
    const 配置 = 读配置()
    if (!配置.私聊QQ && !配置.群号) return 回(res, { ok: false, 说: '私聊 QQ 和群号都是空的，先保存一个再试' })
    const 文字 = '（小贝壳：DSH → QQ 这条桥通了）'
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
  }, 'qq-bridge: 盯大肥鱼说话')

  记账(`已装好 v${版本}：先做「DSH → QQ」这半｜总开关 ${读配置().总开关 ? '开' : '关'}｜试运行 ${读配置().试运行 ? '开（只记账）' : '关（真发）'}`)

  return { 记账, 概况, 落地一发, 发到QQ, 收到事件, 日志 }
}