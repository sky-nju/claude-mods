// 一段的批阅结论：采纳、不要，或写了批注
export type PenVerdict = 'ok' | 'no' | 'note'
export type PenMark = { verdict: PenVerdict; note: string }

// 「啥意思」的解释，问的时候是 asking
export type PenExplain = { status: 'asking' | 'done' | 'failed'; text: string; ticket?: number }

// 一条回答（一个 requestId）上各段的批阅状态，键是段落 id；
// open 是点了「✎」展开工具栏的那一段，editing 是正在写批注的那一段
export type PenBlock = {
  marks: Record<string, PenMark>
  explains: Record<string, PenExplain>
  editing: string
  open?: string
}

// 批阅篮里的一条，key = requestId + 段落 id
export type PenBasketItem = {
  key: string
  requestId: string
  unitId: string
  quote: string
  verdict: PenVerdict
  note: string
  at: number
}

// 红笔挑出的一处
export type PenFinding = {
  quote: string
  rule: string
  fix: string
  state: 'open' | 'applied' | 'dismissed'
}

// 一条长回答的红笔结果，norm 是去掉空白的回答原文，用来对上画面里的那条回答
export type PenReview = {
  id: string
  head?: string
  norm: string
  status: 'checking' | 'done' | 'failed'
  findings: PenFinding[]
  at: number
}

export type PenSettings = { enabled: boolean; autoReview: boolean; minChars: number }

// 当天的使用次数，按北京时间日期
export type PenDayStats = {
  date: string
  marks: number
  sent: number
  explains: number
  reviews: number
  findings: number
  applied: number
  dismissed: number
  byRule: Record<string, number>
}

// 看不懂词典的一条
export type PenDictEntry = { term: string; explain: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'red-pen': {
      blocks: StateFamily<PenBlock>
      basket: PenBasketItem[]
      allAccept: boolean
      reviews: PenReview[]
      settings: PenSettings
      today: PenDayStats
      dict: PenDictEntry[]
      section: string
      rulesFrom: string
    }
  }
}
