import { readFileSync } from 'node:fs'
const src = readFileSync('D:/AX/Documents/GitHub/dsh-qq-bridge-mumu/lib/host.js', 'utf8')
const 起点 = src.indexOf('export function 清洗标签泄漏')
if (起点 < 0) { console.log('EXTRACT_FAIL'); process.exit(1) }
let 段 = src.slice(起点)
const 结束 = 段.indexOf('\n}\n')
段 = 段.slice(0, 结束 + 3).replace(/^export /, '')
// eslint-disable-next-line no-new-func
const 清洗标签泄漏 = new Function('return (' + 段.replace('function 清洗标签泄漏', 'function 清洗标签泄漏') + ')')()

let 挂 = 0
const 报 = (名, 过, 详情) => { if (!过) 挂++; console.log((过 ? 'PASS' : 'FAIL') + '  ' + 名 + (详情 !== undefined ? '  :: ' + JSON.stringify(详情) : '')) }

报('turn348 </ap>+运行时上下文', 清洗标签泄漏('</ap>\n运行时上下文……') === '运行时上下文……')
报('turn350 前置空行+</br>', 清洗标签泄漏('\n</br>\n正文来了') === '正文来了')
报('turn427 </cp>+5空行+正文', 清洗标签泄漏('</cp>\n\n\n\n\n\n拿着个锄头站那儿，然后扭头走了。') === '拿着个锄头站那儿，然后扭头走了。')
报('turn455 </ap>+正文', 清洗标签泄漏('</ap>\n\n第二张什么故事') === '第二张什么故事')
报('turn509 </atom>+多空行', 清洗标签泄漏('</atom>\n\n\n\n那个『允许访问文件网址』不在网页里……') === '那个『允许访问文件网址』不在网页里……')
报('turn574 整条就是<K-12> → null', 清洗标签泄漏('<K-12>') === null)
报('行内标签不剥', 清洗标签泄漏('这个写法是 <b>加粗</b> 的意思') === '这个写法是 <b>加粗</b> 的意思')
报('代码围栏内不动', 清洗标签泄漏('看这段：\n```\n</ap>\n<xml>hello</xml>\n```\n完了') === '看这段：\n```\n</ap>\n<xml>hello</xml>\n```\n完了')
报('普通文本原样', 清洗标签泄漏('今天天气不错，去钓鱼吗？') === '今天天气不错，去钓鱼吗？')
报('开头开标签+正文同行剥壳', 清洗标签泄漏('<ap>正文直接跟在后面') === '正文直接跟在后面')
报('开头多标签连剥', 清洗标签泄漏('</ap></cp></atom> 三连剥') === '三连剥')
报('空串原样返回', 清洗标签泄漏('') === '')
报('≥3空行压成1空行', 清洗标签泄漏('第一段\n\n\n\n\n第二段') === '第一段\n\n第二段')
报('K-12 混在开头空行里', 清洗标签泄漏('\n\n<K-12>\n\n后面正经话') === '后面正经话')
报('中文尖括号不剥', 清洗标签泄漏('〈书名〉这种不碰') === '〈书名〉这种不碰')
报('围栏+标签混合', 清洗标签泄漏('</ap>\n```\nconst x = 1\n```\n正文') === '```\nconst x = 1\n```\n正文')
报('windows换行也能洗', 清洗标签泄漏('</ap>\r\n正文') === '正文')

console.log(挂 === 0 ? '\nALL PASS (17)' : '\nFAILED ' + 挂)
process.exit(挂 === 0 ? 0 : 1)
