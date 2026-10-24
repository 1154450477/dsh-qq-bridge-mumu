// 「通到 QQ」手机模式冒烟测试 —— 假 ctx / 假 fetch（含假的 MuMu 控制口）。
// 验的是：
//   1) 她玩手机 + 忙 → 对方来的话挂起（POST /pending）+ 回执发到 QQ + 不 followup
//   2) 停手关键词（别玩了 / 停 / 够了）→ 收手（POST /exit）+ 回「好，手机收起来了。」
//   3) /say 直发通道 / /turn 起回合 / /agent-state 忙闲 / /stop-phone 手动收手
//   4) 手机模式没开 → 照旧 followup；steer 开关开着 → 顺带 steer 一下
// 跑法： node tests/手机模式.mjs

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const 家 = mkdtempSync(join(tmpdir(), 'qq-bridge-手机-'))
process.env.DSH_HOME = 家

const 写配置 = (补丁) => {
  writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
    总开关: true, 试运行: false, 目标会话: 'session-X', 私聊QQ: '123', 群号: '', 转私聊: true, 转群: false,
    NapCat: 'http://127.0.0.1:3000', MuMu控制口: 'http://127.0.0.1:8791',
    忙时入队: true, 忙时强制回话: false,
    停手关键词: '别玩了,不玩了,退出玩手机,停止玩手机,手机收起来,收手,回来吧,结束玩手机,停,停一下,够了,回来',
    挂起回执: '诶我在玩手机呢～等我一下下就好，你这条我记着了，忙完这阵儿我再回你哈。',
    挂起回执冷却秒: 0, 挂起过期小时: 3,
    ...补丁,
  }, null, 2), 'utf8')
}
写配置({})

let 挂了 = 0
const 报 = (标签, 过, 详情) => { if (!过) 挂了++; console.log((过 ? 'PASS' : 'FAIL') + '  ' + 标签 + (详情 ? '  :: ' + 详情 : '')) }

let 在玩手机 = true
let 刚玩 = false
let 挂起条数 = 0
let 挂着的 = []
const 控口记录 = []
const 发了 = []
globalThis.fetch = async (url, 选项) => {
  const u = String(url)
  const 方式 = String((选项 && 选项.method) || 'GET')
  const 体 = JSON.parse((选项 && 选项.body) || '{}')
  if (u.includes('/state')) {
    return { json: async () => ({ ok: true, mode: 在玩手机 ? { active: true, goal: '刷抖音' } : { active: false }, playing: 在玩手机 || 刚玩, pending: [] }) }
  }
  if (u.includes('/pending/handled')) {
    控口记录.push({ 路径: '/pending/handled', 体 })
    挂着的 = 挂着的.filter((x) => String(x.id) !== String(体.id || ''))
    return { json: async () => ({ ok: true }) }
  }
  if (u.includes('/pending')) {
    if (方式 === 'GET') {
      return { json: async () => ({ ok: true, items: 挂着的 }) }
    }
    控口记录.push({ 路径: '/pending', 体 })
    挂起条数 += 1
    挂着的 = 挂着的.concat([{ id: 'm' + 挂起条数, text: String(体.text || '') }])
    return { json: async () => ({ ok: true, 条数: 挂起条数 }) }
  }
  if (u.includes('/exit')) {
    控口记录.push({ 路径: '/exit', 体 })
    在玩手机 = false
    return { json: async () => ({ ok: true }) }
  }
  if (u.includes('get_login_info')) {
    return { json: async () => ({ status: 'ok', retcode: 0, data: { user_id: 10001, nickname: '测试号' } }) }
  }
  if (u.includes('get_friend_msg_history')) {
    return { json: async () => ({ status: 'ok', retcode: 0, data: { messages: [] } }) }
  }
  发了.push({ url: u, 体 })
  return { json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) }
}

const 模 = await import(new URL('../lib/host.js', import.meta.url).href + '?v=' + Date.now())

const 转进的 = []
const steer的 = []
let 假状态 = 'running'
const 假agent = {
  session: { id: 'session-X' },
  get status() { return 假状态 },
  followup: (m) => { 转进的.push(m) },
  steer: (m) => { steer的.push(m) },
}
const 路由 = new Map()
let 轮询回调 = null
const ctx = {
  on: () => () => {},
  effect: (fn) => { const 摘 = fn(); return () => { try { 摘 && 摘() } catch {} } },
  webServer: { register: (o) => 路由.set(o.path, o.handler) },
  logger: { info: () => {} },
  agents: { get: (id) => (String(id) === 'session-X' ? 假agent : undefined) },
  sessions: { flush: async () => {} },
  interval: (fn) => { 轮询回调 = fn; return () => {} },
  get: () => undefined,
}
模.apply(ctx)

const 存储 = []
const fakeRes = { setHeader: () => {}, end: (s) => { 存储.push(JSON.parse(s)) } }
const 调 = async (路径, body) => {
  存储.length = 0
  await 路由.get(路径)([JSON.stringify(body || {})], fakeRes)
  return 存储[0]
}

// ① 她在玩手机 + 忙 → 挂起 + 回执，不 followup
在玩手机 = true
假状态 = 'running'
写配置({ 挂起回执冷却秒: 0 })
const 转前 = 转进的.length
const 发前 = 发了.length
let 收 = await 调('/dsh-qq-bridge/receive', { text: '在干嘛呢' })
报('玩手机时来消息 → 已挂起（POST /pending）', 控口记录.some((x) => x.路径 === '/pending'), JSON.stringify(控口记录))
报('玩手机时来消息 → 不 followup（不插进她这一轮）', 转进的.length === 转前, '转进条数=' + 转进的.length)
报('玩手机时来消息 → 回执发到 QQ', 发了.length === 发前 + 1 && JSON.stringify(发了.at(-1).体.message[0].data.text).includes('我在玩手机'), JSON.stringify(发了.at(-1) && 发了.at(-1).体))
报('玩手机时来消息 → 路由回 ok', 收 && 收.ok === true, JSON.stringify(收))

// ② 停手关键词「别玩了」→ 收手 + 回「好，手机收起来了。」
const 控前 = 控口记录.length
const 发前2 = 发了.length
收 = await 调('/dsh-qq-bridge/receive', { text: '别玩了' })
报('说「别玩了」→ 调了 /exit 收手', 控口记录.slice(控前).some((x) => x.路径 === '/exit'), JSON.stringify(控口记录.slice(控前)))
报('说「别玩了」→ 回「好，手机收起来了。」', 发了.length === 发前2 + 1 && JSON.stringify(发了.at(-1).体.message[0].data.text).includes('手机收起来了'), JSON.stringify(发了.at(-1) && 发了.at(-1).体))

// ③ 短词整句命中「停」；不误伤「停下来」
在玩手机 = true
写配置({ 挂起回执冷却秒: 60 })
const 控前3 = 控口记录.length
await 调('/dsh-qq-bridge/receive', { text: '停' })
报('整句「停」→ 收手', 控口记录.slice(控前3).some((x) => x.路径 === '/exit'), JSON.stringify(控口记录.slice(控前3)))
const 控前4 = 控口记录.length
await 调('/dsh-qq-bridge/receive', { text: '停下来' })
报('「停下来」不算停手（不误伤）', !控口记录.slice(控前4).some((x) => x.路径 === '/exit'), JSON.stringify(控口记录.slice(控前4)))

// ④ steer 开关开着 → 顺带 steer 一下
在玩手机 = true
假状态 = 'running'
写配置({ 忙时强制回话: true })
const steer前 = steer的.length
await 调('/dsh-qq-bridge/receive', { text: '诶' })
报('强制回话开着 → steer 被调用', steer的.length === steer前 + 1, 'steer 条数=' + steer的.length)
写配置({ 忙时强制回话: false })

// ⑤ 手机模式没开 → 照旧 followup
在玩手机 = false
假状态 = 'idle'
写配置({})
const 转前5 = 转进的.length
收 = await 调('/dsh-qq-bridge/receive', { text: '在吗' })
报('没在玩手机 → 照旧 followup', 转进的.length === 转前5 + 1, '转进条数=' + 转进的.length)
报('没在玩手机 → 路由说转进去了', 收 && 收.ok === true && String(收.说).includes('转进'), JSON.stringify(收))

// ⑥ /say 直发通道
const 发前6 = 发了.length
收 = await 调('/dsh-qq-bridge/say', { text: '我玩完啦' })
报('/say → 真发到 QQ', 收 && 收.ok === true && 发了.length === 发前6 + 1, JSON.stringify(收))
报('/say → 内容对', JSON.stringify(发了.at(-1).体.message[0].data.text) === JSON.stringify('我玩完啦'), JSON.stringify(发了.at(-1).体))

// ⑦ /turn 起回合
const 转前7 = 转进的.length
收 = await 调('/dsh-qq-bridge/turn', { text: '去玩吧', mode: 'followup' })
报('/turn → 起了新回合', 收 && 收.ok === true && 转进的.length === 转前7 + 1, JSON.stringify(收))

// ⑧ /agent-state 忙闲 + 手机状态
在玩手机 = true
假状态 = 'running'
收 = await 调('/dsh-qq-bridge/agent-state', {})
报('/agent-state → 回忙闲 + 手机状态', 收 && 收.ok === true && 收.status === 'running' && 收.手机模式 === true, JSON.stringify(收))

// ⑨ /stop-phone 手动收手
收 = await 调('/dsh-qq-bridge/stop-phone', {})
报('/stop-phone → 收手成功', 收 && 收.ok === true, JSON.stringify(收))
报('/stop-phone → 之后控制口说没在玩了', 在玩手机 === false, '在玩手机=' + 在玩手机)

// ⑩ 忙时入队关着 → 照旧 followup（不挂起）
在玩手机 = true
假状态 = 'running'
写配置({ 忙时入队: false })
const 控前10 = 控口记录.length
const 转前10 = 转进的.length
await 调('/dsh-qq-bridge/receive', { text: '在吗' })
报('忙时入队关着 → 不挂起', !控口记录.slice(控前10).some((x) => x.路径 === '/pending'), JSON.stringify(控口记录.slice(控前10)))
报('忙时入队关着 → 照旧 followup', 转进的.length === 转前10 + 1, '转进条数=' + 转进的.length)

// ⑪ 模式关了但还在动手机（playing）→ 照样挂起，不排进 DSH 队列
在玩手机 = false
刚玩 = true
假状态 = 'running'
写配置({ 挂起回执冷却秒: 0 })
const 控前11 = 控口记录.length
const 转前11 = 转进的.length
await 调('/dsh-qq-bridge/receive', { text: '在吗' })
报('模式关了但还在玩（playing）→ 仍然挂起', 控口记录.slice(控前11).some((x) => x.路径 === '/pending'), JSON.stringify(控口记录.slice(控前11)))
报('模式关了但还在玩（playing）→ 不排进 DSH 队列', 转进的.length === 转前11, '转进条数=' + 转进的.length)
刚玩 = false

// ⑫ 她闲下来了 + QQ 上有没回的挂起消息 → followup 提醒她去看
在玩手机 = false
假状态 = 'idle'
挂着的 = [{ id: 'zz1', text: '刚才问你在干嘛' }]
const 转前12 = 转进的.length
await 轮询回调()
await new Promise((r) => setTimeout(r, 200))
报('闲下来有挂起消息 → 提醒她去处理', 转进的.length === 转前12 + 1 && JSON.stringify(转进的.at(-1).content[0].text).includes('还没回'), JSON.stringify(转进的.at(-1) && 转进的.at(-1).content[0].text))
挂着的 = []

// ⑬ 「暂停一下」→ 先放下手机，不关模拟器（/exit 带 pause=true）
在玩手机 = true
刚玩 = false
假状态 = 'running'
写配置({ 挂起回执冷却秒: 0 })
const 控前13 = 控口记录.length
const 发前13 = 发了.length
收 = await 调('/dsh-qq-bridge/receive', { text: '暂停一下' })
const 退13 = 控口记录.slice(控前13).find((x) => x.路径 === '/exit')
报('说「暂停一下」→ 调了 /exit', !!退13, JSON.stringify(控口记录.slice(控前13)))
报('说「暂停一下」→ 带 pause=true（手机不关）', !!退13 && 退13.体.pause === true, JSON.stringify(退13 && 退13.体))
报('说「暂停一下」→ 回「我先放下，手机留着」', 发了.length === 发前13 + 1 && JSON.stringify(发了.at(-1).体.message[0].data.text).includes('先放下'), JSON.stringify(发了.at(-1) && 发了.at(-1).体))

// ⑭ 「别玩了」→ 收手：/exit 不带 pause（关掉模拟器）+ 回执提一句关上了
在玩手机 = true
const 控前14 = 控口记录.length
const 发前14 = 发了.length
收 = await 调('/dsh-qq-bridge/receive', { text: '别玩了' })
const 退14 = 控口记录.slice(控前14).find((x) => x.路径 === '/exit')
报('说「别玩了」→ /exit 不带 pause（顺手关手机）', !!退14 && !退14.体.pause, JSON.stringify(退14 && 退14.体))
报('说「别玩了」→ 回执里说手机也关上了', 发了.length === 发前14 + 1 && JSON.stringify(发了.at(-1).体.message[0].data.text).includes('关上了'), JSON.stringify(发了.at(-1) && 发了.at(-1).体))

// ⑮ 同一批挂起消息不反复提醒；只有新消息才再提醒
在玩手机 = false
刚玩 = false
假状态 = 'idle'
挂着的 = [{ id: 'yy1', text: '第一条' }]
const 转前15 = 转进的.length
await 轮询回调()
await new Promise((r) => setTimeout(r, 200))
报('新挂起消息 → 提醒一次', 转进的.length === 转前15 + 1, '转进条数=' + 转进的.length)
await 轮询回调()
await new Promise((r) => setTimeout(r, 200))
报('同一批消息再扫一遍 → 不重复提醒', 转进的.length === 转前15 + 1, '转进条数=' + 转进的.length)
挂着的 = [{ id: 'yy1', text: '第一条' }, { id: 'yy2', text: '又来一条' }]
await 轮询回调()
await new Promise((r) => setTimeout(r, 200))
报('有新消息 → 再次提醒', 转进的.length === 转前15 + 2, '转进条数=' + 转进的.length)
报('提醒文案带着 id（她能直接回那条）', JSON.stringify(转进的.at(-1) && 转进的.at(-1).content[0].text).includes('id=yy2'), JSON.stringify(转进的.at(-1) && 转进的.at(-1).content[0].text))
报('提醒完顺手把这批标掉（POST /pending/handled）', 控口记录.filter((x) => x.路径 === '/pending/handled').length >= 2, JSON.stringify(控口记录.filter((x) => x.路径 === '/pending/handled')))
报('标掉之后队列里没有这批了', !挂着的.some((x) => x.id === 'yy2'), JSON.stringify(挂着的))
挂着的 = []

rmSync(家, { recursive: true, force: true })
console.log('\n' + (挂了 === 0 ? '全部通过 ✅' : '有 ' + 挂了 + ' 条没过 ❌'))
