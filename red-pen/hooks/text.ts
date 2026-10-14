import type { PenBasketItem, PenDayStats, PenDictEntry, PenFinding } from '../types'

// 回答里能单独批阅的一段：空行隔开的一块；列表按顶层条目再拆开；代码块整块算一段
export type Unit = { id: string; text: string }

const FENCE = /^\s*(```|~~~)/
const TOP_ITEM = /^ {0,1}([-*+]|\d+[.)])\s+/

// 32 位 FNV-1a，够给段落起一个稳定的短 id
export function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }

  return (h >>> 0).toString(36)
}

function splitBlocks(markdown: string): string[] {
  const blocks: string[] = []
  let current: string[] = []
  let inFence = false
  const flush = () => {
    if (current.some(line => line.trim() !== '')) blocks.push(current.join('\n'))
    current = []
  }

  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence
      current.push(line)
      continue
    }
    if (!inFence && line.trim() === '') {
      flush()
      continue
    }
    current.push(line)
  }
  flush()

  return blocks
}

// 一块里有顶层列表条目，就按条目拆：条目前的引导句单独一段，缩进的子条目跟着上一条。
// 逐行看是不是在代码块里：代码块里的「- xxx」（yaml 列表、diff 的删除行）不拆
function splitItems(block: string): string[] {
  const parts: string[] = []
  let current: string[] = []
  let inFence = false
  for (const line of block.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence
    } else if (!inFence && TOP_ITEM.test(line) && current.length > 0) {
      parts.push(current.join('\n'))
      current = []
    }
    current.push(line)
  }
  if (current.length > 0) parts.push(current.join('\n'))

  return parts
}

export function splitUnits(markdown: string): Unit[] {
  const seen = new Map<string, number>()

  return splitBlocks(markdown)
    .flatMap(splitItems)
    .map(text => {
      const base = hash(text)
      const count = seen.get(base) ?? 0
      seen.set(base, count + 1)

      return { id: count === 0 ? base : `${base}-${count}`, text }
    })
}

// 把一段 markdown 压成一行引文：去掉标记，超长截断加「……」。
// 代码块引第一行代码、表格引第一行内容，批了好几个代码块时 Claude 也分得清是哪个
export function plainQuote(markdown: string, max = 36): string {
  const cut = (text: string) => (text.length > max ? `${text.slice(0, max)}……` : text)
  const lines = markdown.split('\n').filter(line => line.trim() !== '')
  const first = lines[0] ?? ''
  if (FENCE.test(first)) {
    const code = lines.slice(1).find(line => !FENCE.test(line)) ?? ''
    return cut(`代码：${code.trim()}`)
  }
  if (/^\s*\|/.test(first)) {
    const cells = first.split('|').map(cell => cell.replace(/[*_`]/g, '').trim()).filter(cell => cell !== '')
    return cut(`表格：${cells.join(' / ')}`)
  }

  const plain = markdown
    .replace(/\s*```[^\n]*\n\s*([^\n]*)[\s\S]*?(```|$)/g, (_, code: string) => `（代码：${code.trim()}）`)
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*#+\s*/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  return cut(plain)
}

// 回答里去掉代码块剩下的正文：红笔只批正文，按正文字数判断够不够长、是不是以代码为主
export function proseOf(answer: string): string {
  return answer.replace(/^\s*(```|~~~)[\s\S]*?^\s*(```|~~~)\s*$/gm, '（代码块略）')
}

// 批阅篮拼成平时手打批注的格式：一行一条「原文……——批注」
export function composeMessage(items: readonly PenBasketItem[], allAccept: boolean): string {
  const lines = [...items]
    .sort((a, b) => a.at - b.at)
    .map(item => {
      const say = item.verdict === 'ok' ? '采纳' : item.verdict === 'no' ? '不要' : item.note
      return `${item.quote}——${say}`
    })
  if (allAccept) lines.push('其余都采纳')

  return lines.join('\n')
}

export function normalize(text: string): string {
  return text.replace(/\s+/g, '')
}

// 红笔结果对上画面里的哪条回答：全文一致，或者这条是回答的最后一块
export function matchesAnswer(answerNorm: string, blockText: string): boolean {
  const block = normalize(blockText)
  if (block.length < 20) return false

  return answerNorm === block || (block.length >= 40 && answerNorm.endsWith(block))
}

// 内置的说人话规矩：同事装上没配规矩文件时用这一套
export const DEFAULT_RULES = [
  '1. 不用没解释的英文词、缩写和代号；团队常识（DAU、PRD、PM、AI、API、Bug）不算',
  '2. 不自造标签和简称（比如「线A」「三件套」），直接用大白话说',
  '3. 结论先行：第一句就给结论或答案，不先铺垫背景',
  '4. 数字多时放进表格或列表，一句话里不堆 3 个以上数字',
  '5. 不写过程话和元评论（「下面我来…」「总结一下」「好问题」）',
  '6. 同一个意思不说两遍，能删的就删',
].join('\n')

export const REVIEW_SYSTEM =
  '你是中文写作的批改老师。按给定规矩检查一段 AI 写给读者的回答，只挑真正违反规矩、会让读者卡住的地方，最多 3 处；没有就输出 []。文件名、路径、命令、代码、链接和产品名不算黑话，不要挑。只输出 JSON，不要别的字。'

export function reviewPrompt(answer: string, dismissed: readonly string[]): string {
  const skip =
    dismissed.length === 0
      ? ''
      : `\n\n读者判过「这条不算」的例子，同类的不要再挑：\n${dismissed.map(d => `- ${d}`).join('\n')}`

  return `要检查的回答：\n<<<\n${answer}\n>>>${skip}\n\n输出 JSON 数组，每项是 {"quote": 回答里逐字出现的原文片段（不超过 30 字）, "rule": 违反的规矩，写编号和四个字以内的简称（如「1 黑话」）, "fix": 怎么改（不超过 30 字）}`
}

// 解析红笔结果：只留原文里真找得到的片段，最多 3 处
export function parseFindings(reply: string, answer: string): PenFinding[] {
  const start = reply.indexOf('[')
  const end = reply.lastIndexOf(']')
  if (start < 0 || end <= start) return []

  let raw: unknown
  try {
    raw = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []

  const haystack = normalize(answer)
  const findings: PenFinding[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const { quote, rule, fix } = item as Record<string, unknown>
    if (typeof quote !== 'string' || typeof rule !== 'string' || typeof fix !== 'string') continue
    if (quote.trim() === '' || !haystack.includes(normalize(quote))) continue
    findings.push({ quote: quote.trim(), rule: rule.trim(), fix: fix.trim(), state: 'open' })
    if (findings.length === 3) break
  }

  return findings
}

export const EXPLAIN_PROMPT =
  '（这是红笔批阅插件的旁路提问，你的回答不会进入对话。）读者看不懂下面这段里的一些说法。请结合上面的对话，用大白话解释这段里普通人可能看不懂的词、缩写、代号或编号，每个一行，格式「词：解释」，解释不超过 25 字，最多 5 个。没有就只回「没有难懂的词」。\n\n这段是：\n'

// 「词：解释」一行一个，抽出来进词典
export function parseTerms(reply: string, at: number): PenDictEntry[] {
  const entries: PenDictEntry[] = []
  for (const line of reply.split('\n')) {
    const found = /^\s*(?:[-*]\s*)?\**(.{1,30}?)\**\s*[：:]\s*(.{2,80})$/.exec(line)
    if (found === null) continue
    const term = (found[1] ?? '').replace(/[「」"“”]/g, '').trim()
    const explain = (found[2] ?? '').trim()
    if (term !== '' && explain !== '') entries.push({ term, explain, at })
  }

  return entries
}

// 新词放前面，同名的只留最新的
export function mergeDict(old: readonly PenDictEntry[], fresh: readonly PenDictEntry[], max = 200): PenDictEntry[] {
  const seen = new Set<string>()
  const merged: PenDictEntry[] = []
  for (const entry of [...fresh, ...old]) {
    if (seen.has(entry.term)) continue
    seen.add(entry.term)
    merged.push(entry)
  }

  return merged.slice(0, max)
}

// 写进系统提示的一段：问过的词 + 最常被红笔挑出的两类问题。会话开始时算一次，中途不变
export function readerSection(dict: readonly PenDictEntry[], days: readonly PenDayStats[]): string {
  const lines: string[] = []
  if (dict.length > 0) {
    lines.push('读者问过「啥意思」的词。写给这位读者时尽量不用；非用不可，就在第一次出现时用一句大白话解释：')
    for (const entry of dict.slice(0, 30)) lines.push(`- ${entry.term}：${entry.explain}`)
  }

  const counts = new Map<string, number>()
  for (const day of days) {
    for (const [rule, n] of Object.entries(day.byRule)) counts.set(rule, (counts.get(rule) ?? 0) + n)
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)
  if (top.length > 0) {
    lines.push(`最近最常被读者的红笔挑出的问题：${top.map(([rule, n]) => `${rule}（${n} 次）`).join('、')}。写的时候先避开这两类。`)
  }
  if (lines.length === 0) return ''

  return ['# 红笔批阅：这位读者的阅读习惯', ...lines].join('\n')
}

// 北京时间的日期，例如 2026-10-14
export function dayOf(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10)
}

export function emptyDay(date: string): PenDayStats {
  return { date, marks: 0, sent: 0, explains: 0, reviews: 0, findings: 0, applied: 0, dismissed: 0, byRule: {} }
}
