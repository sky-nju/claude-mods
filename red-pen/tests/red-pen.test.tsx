import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  composeMessage,
  explainMarkdown,
  parseFindings,
  parseTerms,
  plainQuote,
  readerSection,
  splitUnits,
} from '../hooks/text'
import type { PenBasketItem } from '../types'

const REPLY = [
  '**结论**：周末团建改到下周六。',
  '',
  '理由有三条：',
  '- 本周六有 3 个人请假',
  '- 场地要提前两周订',
  '  - 子条目跟着上一条',
  '- 预算还差 800 元',
  '',
  '```',
  'a = 1',
  '',
  'b = 2',
  '```',
].join('\n')

const LONG = `这批 cohort 的留存在第 3 天掉得最多。${'后面是很长的分析，'.repeat(100)}`

const USAGE = { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

// /redpen 面板：停靠在对话旁边
const PANE_PROPS = {
  title: '红笔批阅',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

// 一次系统提示的组装：主模型、桌面端、没有工具
const COMPOSE = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: ['desktop'] as const,
  tools: [],
  outputStyle: null,
  traits: [],
}

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 11 },
  view: {},
}

// 插件下面的世界：时钟、存储、文件、模型、提交出去的话都记在 sent 里
// noHaiku：调不到小模型；noSubmit：消息发不出去；noFork：「啥意思」问不到；
// whileQueued：消息排队、还没发出去的那段时间里要做的事（像 Claude 正在回答时那样）
function world(
  on: On,
  store: Record<string, unknown> = {},
  opts: { noHaiku?: boolean; noSubmit?: boolean; noFork?: boolean; whileQueued?: () => Promise<void> } = {},
) {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 14, 2) })
  mock.store(on, store)
  const sent: string[] = []
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: undefined }))
  on('fs.read', () => ({ value: '' }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', async ($, e) => {
    if (opts.whileQueued !== undefined) await opts.whileQueued()
    if (opts.noSubmit) return { drop: '发不出去' }
    sent.push(e.text)
    return { text: e.text }
  })
  on('model.fork', () =>
    opts.noFork
      ? { deny: '不让问' }
      : { value: { isAnswered: true as const, text: 'cohort：同一天激活的一批用户', usage: USAGE } },
  )
  on('model.complete', () => (opts.noHaiku ? { deny: '这个环境没有 haiku' } : {
    value: {
      isAnswered: true as const,
      text: '[{"quote":"cohort","rule":"1 黑话","fix":"改成「同一天激活的一批用户」"},{"quote":"原文里没有的话","rule":"2 自造","fix":"x"}]',
      usage: USAGE,
    },
  }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: '引擎自己的开头', scope: 'shared' as const }] }))
  // 引擎自己画的样子（插件让出时用到）
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  return { clock, sent }
}

async function start($: Engine) {
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
}

function mountReply($: Engine, surface: 'terminal' | 'desktop', text: string, requestId = 'm1') {
  return $.ui.mount({
    plugin: 'red-pen',
    surface,
    component: 'AssistantMessage',
    props: { text, isFirstOfReply: true },
    requestId,
  })
}

type Reply = Awaited<ReturnType<typeof mountReply>>

// 先点段落右上角的「✎」展开工具栏，再点工具栏上的按钮
async function pick(ui: Reply, unitId: string | undefined, action: 'ok' | 'no' | 'ask' | 'note') {
  await ui.press({ key: `pen-${unitId}` })
  await ui.press({ key: `${action}-${unitId}` })
}

async function bandText($: Engine, surface: 'terminal' | 'desktop') {
  const ui = await $.ui.mount({ plugin: 'red-pen', surface, component: 'AbovePrompt', props: BAND_PROPS })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await ui.unmount()

  return texts.join(' ')
}

describe('切段和拼格式', () => {
  test('空行分段，列表按顶层条目拆，代码块整块', () => {
    const units = splitUnits(REPLY).map(u => u.text)
    expect(units).toEqual([
      '**结论**：周末团建改到下周六。',
      '理由有三条：',
      '- 本周六有 3 个人请假',
      '- 场地要提前两周订\n  - 子条目跟着上一条',
      '- 预算还差 800 元',
      '```\na = 1\n\nb = 2\n```',
    ])
    const ids = splitUnits('一样\n\n一样').map(u => u.id)
    expect(new Set(ids).size).toBe(2)
  })

  test('引文去掉标记，超长截断加省略号', () => {
    expect(plainQuote('- **常用的人少**，[看板](https://x.y)')).toBe('常用的人少，看板')
    expect(plainQuote('一'.repeat(50), 10)).toBe(`${'一'.repeat(10)}……`)
  })

  test('拼成「原文——批注」，按批的先后排，可加「其余都采纳」', () => {
    const items: PenBasketItem[] = [
      { key: 'b', requestId: 'm', unitId: 'b', quote: '方案二、预算……', verdict: 'note', note: '不用写这么细', at: 2 },
      { key: 'a', requestId: 'm', unitId: 'a', quote: '方案 1.1 加一句……', verdict: 'no', note: '', at: 1 },
    ]
    expect(composeMessage(items, true)).toBe(
      '方案 1.1 加一句……——不要\n方案二、预算……——不用写这么细\n其余都采纳',
    )
  })

  test('红笔结果只留原文里找得到的片段；坏 JSON 当没挑出', () => {
    const found = parseFindings('好的：[{"quote":"cohort","rule":"1 黑话","fix":"说人话"},{"quote":"不存在","rule":"x","fix":"y"}]', LONG)
    expect(found).toEqual([{ quote: 'cohort', rule: '1 黑话', fix: '说人话', state: 'open' }])
    expect(parseFindings('[{oops', LONG)).toEqual([])
  })

  test('「词：解释」抽进词典；读者档案带上问过的词和最常犯的问题', () => {
    const terms = parseTerms('**cohort**：同一天激活的一批用户\n- R1-R6: 六个评测轮次\n随便一句话', 5)
    expect(terms.map(t => t.term)).toEqual(['cohort', 'R1-R6'])
    const text = readerSection(terms, [
      { date: 'd', marks: 0, sent: 0, explains: 0, reviews: 0, findings: 3, applied: 0, dismissed: 0, byRule: { '1 黑话': 2, '4 数字': 1 } },
    ])
    expect(text).toContain('- cohort：同一天激活的一批用户')
    expect(text).toContain('1 黑话（2 次）')
    expect(readerSection([], [])).toBe('')
  })
})

describe('在回答上批阅', () => {
  test('点「采纳」「不要」进批阅篮，提示条点「发出」以你的名义发出', async ($, on) => {
    const { sent } = world(on)
    await start($)
    const [lead, why] = splitUnits(REPLY)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await mountReply($, surface, REPLY)
      await pick(ui, lead?.id, 'ok')
      await pick(ui, why?.id, 'no')
      expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join(' ')).toContain('✎ 采纳')
      await ui.unmount()

      expect(await bandText($, surface)).toContain('已批 2 条')
      const band = await $.ui.mount({ plugin: 'red-pen', surface, component: 'AbovePrompt', props: BAND_PROPS })
      await band.press({ key: 'accept' })
      await band.press({ key: 'send' })
      await band.unmount()

      expect(sent.at(-1)).toBe('结论：周末团建改到下周六。——采纳\n理由有三条：——不要\n其余都采纳')
      expect(await bandText($, surface)).not.toContain('已批')
    }
  })

  test('没点「✎」之前没有工具栏；点了展开，选完自动收起', async ($, on) => {
    world(on)
    await start($)
    const [lead] = splitUnits(REPLY)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await mountReply($, surface, REPLY, `h-${surface}`)
      expect(await ui.find({ key: `pen-${lead?.id}` })).toBeDefined()
      expect(await ui.find({ key: `ok-${lead?.id}` })).toBeUndefined()
      await ui.press({ key: `pen-${lead?.id}` })
      expect(await ui.find({ key: `ok-${lead?.id}` })).toBeDefined()
      await ui.press({ key: `ok-${lead?.id}` })
      expect(await ui.find({ key: `ok-${lead?.id}` })).toBeUndefined()
      await ui.press({ key: `pen-${lead?.id}` })
      await ui.press({ key: `close-${lead?.id}` })
      expect(await ui.find({ key: `ok-${lead?.id}` })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('再点一次同一个结论就撤回', async ($, on) => {
    world(on)
    await start($)
    const [lead] = splitUnits(REPLY)
    const ui = await mountReply($, 'desktop', REPLY)
    await pick(ui, lead?.id, 'ok')
    await pick(ui, lead?.id, 'ok')
    await ui.unmount()
    expect(await bandText($, 'desktop')).not.toContain('已批')
  })

  test('写批注：点「批注」出输入框，回车放进批阅篮', async ($, on) => {
    const { sent } = world(on)
    await start($)
    const units = splitUnits(REPLY)
    const item = units[2]
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await mountReply($, surface, REPLY, `m-${surface}`)
      await pick(ui, item?.id, 'note')
      await ui.input({ key: `in-${item?.id}`, text: '  这条数字要标出处  ' })
      expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join(' ')).toContain('批注：这条数字要标出处')
      await ui.unmount()

      const band = await $.ui.mount({ plugin: 'red-pen', surface, component: 'AbovePrompt', props: BAND_PROPS })
      await band.press({ key: 'send' })
      await band.unmount()
      expect(sent.at(-1)).toBe('本周六有 3 个人请假——这条数字要标出处')
    }
  })

  test('「啥意思」把解释画在这段下面，并记进看不懂词典', async ($, on) => {
    world(on)
    await start($)
    const [first] = splitUnits(LONG)
    const ui = await mountReply($, 'desktop', LONG)
    await pick(ui, first?.id, 'ask')
    expect((await ui.findAll({ type: 'Markdown' })).map(t => t.text).join(' ')).toContain('同一天激活的一批用户')
    await ui.unmount()

    const pane = await $.ui.mount({
      plugin: 'red-pen',
      surface: 'desktop',
      component: 'Pane',
      requestId: 'red-pen',
      props: PANE_PROPS,
    })
    const texts = (await pane.findAll({ type: 'Text' })).map(t => t.text).join(' ')
    expect(texts).toContain('看不懂词典 · 1 个')
    expect(texts).toContain('问「啥意思」1 次')
    await pane.unmount()
  })
})

describe('红笔自动批改', () => {
  test('长回答结束后批一遍，回答下面列出红笔，点「照改」发出修改要求', async ($, on) => {
    const { clock, sent } = world(on)
    await start($)
    await $.turn.complete({ answer: LONG, durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.advance(50)
    await clock.settle()

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await mountReply($, surface, LONG, `r-${surface}`)
      const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' ')
      expect(texts).toContain('红笔 1 处')
      expect(texts).toContain('「cohort」')
      expect(texts).not.toContain('原文里没有的话')
      await ui.unmount()
    }

    const ui = await mountReply($, 'desktop', LONG, 'r-fix')
    await ui.press({ key: 'fix-0' })
    expect(sent.at(-1)).toBe(
      `按红笔改一下你之前那条回答（开头是「${plainQuote(LONG, 20)}」）：\n- 「cohort」：1 黑话，改成「同一天激活的一批用户」`,
    )
    expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join(' ')).not.toContain('红笔 1 处')
    await ui.unmount()
  })

  test('调不到小模型时安静跳过，不会一直显示「正在批」', async ($, on) => {
    const { clock } = world(on, {}, { noHaiku: true })
    await start($)
    await $.turn.complete({ answer: LONG, durationMs: 1000, isAborted: false, turnId: 't3', reason: 'answer' })
    await clock.advance(50)
    await clock.settle()
    const ui = await mountReply($, 'desktop', LONG, 'r-none')
    expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join(' ')).not.toContain('红笔')
    await ui.unmount()
  })

  test('短回答不批', async ($, on) => {
    const { clock } = world(on)
    await start($)
    await $.turn.complete({ answer: '短回答 cohort。', durationMs: 1000, isAborted: false, turnId: 't2', reason: 'answer' })
    await clock.advance(50)
    await clock.settle()
    const ui = await mountReply($, 'desktop', '短回答 cohort。这里再补一点字凑够二十个字。')
    expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join(' ')).not.toContain('红笔')
    await ui.unmount()
  })
})

describe('读者档案进系统提示', () => {
  test('词典里有词时，系统提示末尾多一段；没有时不加', async ($, on) => {
    world(on, { dict: [{ term: 'cohort', explain: '同一天激活的一批用户', at: 1 }] })
    await start($)
    const result = await $.prompt.compose(COMPOSE)
    const mine = result.sections.find(s => s.id === 'red-pen:reader')
    expect(mine?.scope).toBe('session')
    expect(mine?.text).toContain('cohort：同一天激活的一批用户')
  })

  test('空词典不加', async ($, on) => {
    world(on)
    await start($)
    const result = await $.prompt.compose(COMPOSE)
    expect(result.sections.map(s => s.id)).toEqual(['intro'])
  })
})

describe('/clear 之后', () => {
  test('统计、词典接着用，不从 0 重来', async ($, on) => {
    // 每个测试开始时 $.state 都是默认值，和 /clear 之后一样；存档还在 $.store 里
    const day = { date: '2026-10-14', marks: 5, sent: 1, explains: 0, reviews: 0, findings: 0, applied: 0, dismissed: 0, byRule: {} }
    const { clock } = world(on, { days: [day], dict: [{ term: 'cohort', explain: '同一天激活的一批用户', at: 1 }] })
    on('session.end', ($, e) => ({ sessionId: e.sessionId }))
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    await clock.advance(1000)
    await clock.settle()

    const [lead] = splitUnits(REPLY)
    const ui = await mountReply($, 'desktop', REPLY, 'c1')
    await pick(ui, lead?.id, 'ok')
    await ui.unmount()

    const pane = await $.ui.mount({
      plugin: 'red-pen',
      surface: 'desktop',
      component: 'Pane',
      requestId: 'red-pen',
      props: PANE_PROPS,
    })
    const texts = (await pane.findAll({ type: 'Text' })).map(t => t.text).join(' ')
    expect(texts).toContain('批了 6 段')
    expect(texts).toContain('看不懂词典 · 1 个')
    await pane.unmount()
  })
})

describe('复查后补的几处', () => {
  test('代码块前面没空行时不拆开，代码里的「- xxx」不当列表', () => {
    const units = splitUnits('改成这样：\n```yaml\nsteps:\n- run: npm i\n- run: npm test\n```\n- 后面的列表照常拆')
    expect(units.map(u => u.text)).toEqual([
      '改成这样：\n```yaml\nsteps:\n- run: npm i\n- run: npm test\n```',
      '- 后面的列表照常拆',
    ])
    expect(splitUnits('```diff\n- old line\n+ new line\n```')).toHaveLength(1)
  })

  test('代码块引第一行代码，表格引第一行内容', () => {
    expect(plainQuote('```ts\n\nconst a = 1\nconst b = 2\n```')).toBe('代码：const a = 1')
    expect(plainQuote('| 方案 | **预算** |\n|---|---|\n| A | 1 |')).toBe('表格：方案 / 预算')
    expect(plainQuote('先看这段：\n```\nnpm test\n```')).toBe('先看这段：（代码：npm test）')
  })

  test('排队期间：批阅篮已清空，再点「发出」不会重复发，新批的段不会丢', async ($, on) => {
    const [lead, why] = splitUnits(REPLY)
    const seen: string[] = []
    let ui: Reply | undefined
    const { clock, sent } = world(on, {}, {
      whileQueued: async () => {
        if (seen.length > 0) return
        seen.push(await bandText($, 'desktop'))
        if (ui !== undefined) await pick(ui, why?.id, 'no')
      },
    })
    await start($)
    ui = await mountReply($, 'desktop', REPLY, 'q1')
    await pick(ui, lead?.id, 'ok')

    const band = await $.ui.mount({ plugin: 'red-pen', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    await band.press({ key: 'send' })
    for (let i = 0; i < 20 && sent.length === 0; i++) await clock.settle()
    await band.unmount()
    await ui.unmount()

    expect(seen[0]).not.toContain('已批')
    expect(sent).toEqual(['结论：周末团建改到下周六。——采纳'])
    expect(await bandText($, 'desktop')).toContain('已批 1 条')
  })

  test('消息发不出去时，批注放回批阅篮', async ($, on) => {
    const { sent } = world(on, {}, { noSubmit: true })
    await start($)
    const [lead, why] = splitUnits(REPLY)
    const ui = await mountReply($, 'desktop', REPLY, 'q2')
    await pick(ui, lead?.id, 'ok')
    await pick(ui, why?.id, 'no')
    await ui.unmount()

    const band = await $.ui.mount({ plugin: 'red-pen', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    await band.press({ key: 'send' })
    await band.unmount()
    expect(sent).toHaveLength(0)
    expect(await bandText($, 'desktop')).toContain('已批 2 条')
  })

  test('「啥意思」问不到时显示「没问到」，不会卡在「正在问」', async ($, on) => {
    world(on, {}, { noFork: true })
    await start($)
    const [first] = splitUnits(LONG)
    const ui = await mountReply($, 'desktop', LONG, 'a1')
    await pick(ui, first?.id, 'ask')
    const texts = [...(await ui.findAll({ type: 'Text' })), ...(await ui.findAll({ type: 'Markdown' }))]
      .map(t => t.text)
      .join(' ')
    expect(texts).toContain('没问到')
    expect(texts).not.toContain('正在问')
    await ui.unmount()
  })

  test('正文不到 800 字、或者以代码为主的回答不批', async ($, on) => {
    const { clock } = world(on)
    await start($)
    const codeHeavy = `先看代码。\n\n\`\`\`ts\n${'const value = compute(input)\n'.repeat(80)}\`\`\`\n\n${'说明文字，'.repeat(170)}`
    for (const [i, answer] of [`${'短一点的回答，'.repeat(60)}`, codeHeavy].entries()) {
      await $.turn.complete({ answer, durationMs: 1000, isAborted: false, turnId: `s${i}`, reason: 'answer' })
      await clock.advance(50)
      await clock.settle()
      const ui = await mountReply($, 'desktop', answer, `s-${i}`)
      expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join(' ')).not.toContain('红笔')
      await ui.unmount()
    }
  })

  test('看不懂词典里的词可以逐个删、可以清空', async ($, on) => {
    world(on, {
      dict: [
        { term: 'cohort', explain: '同一天激活的一批用户', at: 2 },
        { term: 'API', explain: '程序之间的接口', at: 1 },
      ],
    })
    await start($)
    const pane = await $.ui.mount({ plugin: 'red-pen', surface: 'desktop', component: 'Pane', requestId: 'red-pen', props: PANE_PROPS })
    await pane.press({ key: 'del-w-API' })
    let texts = (await pane.findAll({ type: 'Text' })).map(t => t.text).join(' ')
    expect(texts).toContain('看不懂词典 · 1 个')
    expect(texts).not.toContain('API：')
    await pane.press({ key: 'clear-dict' })
    texts = (await pane.findAll({ type: 'Text' })).map(t => t.text).join(' ')
    expect(texts).toContain('看不懂词典 · 0 个')
    await pane.unmount()
  })

  test('存档里只认两个开关；门槛跟着插件版本走', async ($, on) => {
    world(on, { settings: { enabled: true, autoReview: false, minChars: 300 } })
    await start($)
    const pane = await $.ui.mount({ plugin: 'red-pen', surface: 'desktop', component: 'Pane', requestId: 'red-pen', props: PANE_PROPS })
    const texts = (await pane.findAll({ type: 'Text' })).map(t => t.text).join(' ')
    expect(texts).toContain('超过 800 字')
    expect((await pane.find({ key: 't-review' }))?.text).toContain('自动红笔：关')
    await pane.unmount()
  })
})

describe('截图里看到的', () => {
  test('「啥意思」好几个词时排成列表，不挤成一段', () => {
    expect(explainMarkdown('Claude Code：写代码的 AI 助手\nnpm：装软件的公共下载站\n\n- 2.1.299：版本号')).toBe(
      '- Claude Code：写代码的 AI 助手\n- npm：装软件的公共下载站\n- 2.1.299：版本号',
    )
    expect(explainMarkdown('  没有难懂的词  ')).toBe('没有难懂的词')
  })
})
