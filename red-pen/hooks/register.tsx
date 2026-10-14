import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PenBasketItem, PenBlock, PenDayStats, PenDictEntry, PenExplain, PenMark, PenReview, PenSettings } from '../types'
import {
  DEFAULT_RULES,
  EXPLAIN_PROMPT,
  REVIEW_SYSTEM,
  composeMessage,
  dayOf,
  emptyDay,
  hash,
  matchesAnswer,
  mergeDict,
  normalize,
  parseFindings,
  parseTerms,
  plainQuote,
  readerSection,
  reviewPrompt,
  splitUnits,
} from './text'
import type { Unit } from './text'

const PANE = 'red-pen'
const REVIEW_MODEL = 'haiku'
// 规矩文件：先找当前目录的，再找自己 home 下的；都没有就用内置的
const RULES_FILE = '.claude/red-pen-rules.md'

const EMPTY_BLOCK: PenBlock = { marks: {}, explains: {}, editing: '' }
const DEFAULT_SETTINGS: PenSettings = { enabled: true, autoReview: true, minChars: 300 }

const blocks = atom({ plugin: 'red-pen', key: 'blocks' } as const, EMPTY_BLOCK)
const basket = atom({ plugin: 'red-pen', key: 'basket' } as const, [] as PenBasketItem[])
const allAccept = atom({ plugin: 'red-pen', key: 'allAccept' } as const, false)
const reviews = atom({ plugin: 'red-pen', key: 'reviews' } as const, [] as PenReview[])
const settings = atom({ plugin: 'red-pen', key: 'settings' } as const, DEFAULT_SETTINGS)
const today = atom({ plugin: 'red-pen', key: 'today' } as const, emptyDay(''))
const dict = atom({ plugin: 'red-pen', key: 'dict' } as const, [] as PenDictEntry[])
const section = atom({ plugin: 'red-pen', key: 'section' } as const, '')
const rulesFrom = atom({ plugin: 'red-pen', key: 'rulesFrom' } as const, '内置 6 条')

type Counter = Exclude<keyof PenDayStats, 'date' | 'byRule'>

// 规矩全文只给红笔批改用，不进界面，放模块变量；重新加载时 session.start 会再读一次
let rules = DEFAULT_RULES

async function stored<T>($: EngineInterface, key: string, fallback: T): Promise<T> {
  const value = await $.store.get(key).catch(() => undefined)
  return value === undefined ? fallback : (value as T)
}

// 记一次使用：当天的数进会话状态（面板读），同时存 30 天到 $.store
async function count($: EngineInterface, field: Counter, n = 1, rule?: string): Promise<void> {
  const date = dayOf(await $.clock.now())
  const day = await update($, today, old => {
    const base = old.date === date ? old : emptyDay(date)
    const byRule = rule === undefined ? base.byRule : { ...base.byRule, [rule]: (base.byRule[rule] ?? 0) + n }
    return { ...base, [field]: base[field] + n, byRule }
  })
  const days = await stored<PenDayStats[]>($, 'days', [])
  await $.store.set('days', [day, ...days.filter(d => d.date !== day.date)].slice(0, 30))
}

async function loadRules($: EngineInterface, cwd: string): Promise<void> {
  const home = await $.env.get('HOME')
  const paths = [`${cwd}/${RULES_FILE}`, home === undefined ? '' : `${home}/${RULES_FILE}`]
  for (const path of paths) {
    if (path === '') continue
    const text = await $.fs.read(path).catch(() => undefined)
    if (typeof text === 'string' && text.trim() !== '') {
      rules = text.trim()
      await update($, rulesFrom, () => path)
      return
    }
  }
  rules = DEFAULT_RULES
  await update($, rulesFrom, () => '内置 6 条')
}

// 会话开始（含 /clear、/resume）：读回设置、词典、统计，算好写进系统提示的那一段
async function restore($: EngineInterface, cwd: string): Promise<void> {
  const saved = await stored<Partial<PenSettings>>($, 'settings', {})
  await update($, settings, () => ({ ...DEFAULT_SETTINGS, ...saved }))
  const words = await stored<PenDictEntry[]>($, 'dict', [])
  await update($, dict, () => words)
  const days = await stored<PenDayStats[]>($, 'days', [])
  const date = dayOf(await $.clock.now())
  await update($, today, () => days.find(d => d.date === date) ?? emptyDay(date))
  await update($, section, () => readerSection(words, days.slice(0, 7)))
  await loadRules($, cwd)
}

async function saveSettings($: EngineInterface, change: (old: PenSettings) => PenSettings): Promise<void> {
  const next = await update($, settings, change)
  await $.store.set('settings', next)
}

// 给一段定下批阅结论（null 是撤回），批阅篮跟着改
async function setMark(
  $: EngineInterface,
  requestId: string,
  unit: Unit,
  mark: PenMark | null,
): Promise<void> {
  await update($, memberOf(blocks, { requestId }), block => {
    const marks = { ...block.marks }
    if (mark === null) delete marks[unit.id]
    else marks[unit.id] = mark
    return { ...block, marks, editing: '', open: '' }
  })

  const key = `${requestId}:${unit.id}`
  const at = await $.clock.now()
  await update($, basket, list => {
    const rest = list.filter(item => item.key !== key)
    if (mark === null) return rest
    const old = list.find(item => item.key === key)
    const item: PenBasketItem = {
      key,
      requestId,
      unitId: unit.id,
      quote: plainQuote(unit.text),
      verdict: mark.verdict,
      note: mark.note,
      at: old?.at ?? at,
    }
    return [...rest, item]
  })
  if (mark !== null) await count($, 'marks')
}

async function toggleVerdict($: EngineInterface, requestId: string, unit: Unit, verdict: 'ok' | 'no') {
  const block = await read($, memberOf(blocks, { requestId }))
  const isSame = block.marks[unit.id]?.verdict === verdict
  await setMark($, requestId, unit, isSame ? null : { verdict, note: '' })
}

async function saveNote($: EngineInterface, requestId: string, unit: Unit, value: string) {
  const note = value.trim()
  await setMark($, requestId, unit, note === '' ? null : { verdict: 'note', note })
}

async function clearBasket($: EngineInterface): Promise<void> {
  const items = await read($, basket)
  for (const requestId of new Set(items.map(item => item.requestId))) {
    await update($, memberOf(blocks, { requestId }), block => ({ ...block, marks: {}, editing: '' }))
  }
  await update($, basket, () => [])
  await update($, allAccept, () => false)
}

// 拼成「原文……——批注」，以你自己的名义发出一轮，然后清空批阅篮
async function send($: EngineInterface): Promise<void> {
  const items = await read($, basket)
  if (items.length === 0) return
  const text = composeMessage(items, await read($, allAccept))
  await $.prompt.submit({ text, asUser: true })
  await clearBasket($)
  await count($, 'sent')
  await $.ui.close({ id: PANE }).catch(() => undefined)
}

// 「啥意思」：带着整段对话旁路问一句，答案只画在这段下面，不进主对话；问到的词进词典
async function ask($: EngineInterface, requestId: string, unit: Unit): Promise<void> {
  const member = memberOf(blocks, { requestId })
  const setExplain = (explain: PenExplain | null) =>
    update($, member, block => {
      const explains = { ...block.explains }
      if (explain === null) delete explains[unit.id]
      else explains[unit.id] = explain
      return { ...block, explains, open: '' }
    })

  const current = (await read($, member)).explains[unit.id]
  if (current?.status === 'asking') return
  if (current !== undefined) {
    await setExplain(null)
    return
  }

  await setExplain({ status: 'asking', text: '' })
  const reply = await $.model.fork({ prompt: EXPLAIN_PROMPT + unit.text })
  if (!reply.isAnswered) {
    const why = reply.reason === 'nothing-to-fork' ? '这个会话还没有可以旁路提问的内容' : `没问到（${reply.reason}）`
    await setExplain({ status: 'failed', text: why })
    return
  }

  await setExplain({ status: 'done', text: reply.text.trim() })
  const fresh = parseTerms(reply.text, await $.clock.now())
  if (fresh.length > 0) {
    const merged = mergeDict(await read($, dict), fresh)
    await update($, dict, () => merged)
    await $.store.set('dict', merged)
  }
  await count($, 'explains')
}

// 一轮结束后，长回答用小模型按规矩批一遍
async function reviewAnswer($: EngineInterface, answer: string): Promise<void> {
  const conf = await read($, settings)
  if (!conf.autoReview || answer.length < conf.minChars) return

  const id = hash(answer)
  const at = await $.clock.now()
  const fresh: PenReview = { id, norm: normalize(answer), status: 'checking', findings: [], at }
  await update($, reviews, list => [fresh, ...list.filter(review => review.id !== id)].slice(0, 20))

  const dismissed = await stored<string[]>($, 'dismissed', [])
  // 小模型调不到（比如接了别的模型网关、没有 haiku）时调用会直接报错：当作没批，不让「正在批」一直挂着
  const reply = await $.model
    .complete({
      model: REVIEW_MODEL,
      system: REVIEW_SYSTEM,
      prompt: [{ text: `规矩：\n${rules}`, cache: true }, { text: reviewPrompt(answer, dismissed) }],
      maxTokens: 800,
      effort: 'low',
      timeoutMs: 30_000,
    })
    .catch(() => undefined)
  const isAnswered = reply !== undefined && reply.isAnswered
  const findings = isAnswered ? parseFindings(reply.text, answer) : []
  const status: PenReview['status'] = isAnswered ? 'done' : 'failed'
  await update($, reviews, list =>
    list.map(review => (review.id === id ? { ...review, status, findings } : review)),
  )
  await count($, 'reviews')
  for (const finding of findings) await count($, 'findings', 1, finding.rule)
}

async function applyFindings($: EngineInterface, reviewId: string, indexes: readonly number[]) {
  const review = (await read($, reviews)).find(one => one.id === reviewId)
  if (review === undefined) return
  const picked = indexes.filter(i => review.findings[i]?.state === 'open')
  if (picked.length === 0) return

  const lines = picked.map(i => {
    const finding = review.findings[i]
    return finding === undefined ? '' : `- 「${finding.quote}」：${finding.rule}，${finding.fix}`
  })
  await $.prompt.submit({ text: ['按红笔改一下上面这条回答：', ...lines].join('\n'), asUser: true })
  await update($, reviews, list =>
    list.map(one =>
      one.id !== reviewId
        ? one
        : { ...one, findings: one.findings.map((f, i) => (picked.includes(i) ? { ...f, state: 'applied' as const } : f)) },
    ),
  )
  await count($, 'applied', picked.length)
}

// 「这条不算」：记下来，以后批改时把同类例子告诉小模型
async function dismissFinding($: EngineInterface, reviewId: string, index: number) {
  const review = (await read($, reviews)).find(one => one.id === reviewId)
  const finding = review?.findings[index]
  if (finding === undefined || finding.state !== 'open') return

  await update($, reviews, list =>
    list.map(one =>
      one.id !== reviewId
        ? one
        : { ...one, findings: one.findings.map((f, i) => (i === index ? { ...f, state: 'dismissed' as const } : f)) },
    ),
  )
  const dismissed = await stored<string[]>($, 'dismissed', [])
  await $.store.set('dismissed', [`「${finding.quote}」被当成「${finding.rule}」`, ...dismissed].slice(0, 30))
  await count($, 'dismissed')
}

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: '红笔批阅' })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command
      .register({
        name: 'redpen',
        description: '红笔批阅：打开面板，看批阅篮、今天的次数、看不懂词典，开关段落按钮和自动红笔',
      })
      .catch(() => undefined)
    await restore($, e.cwd).catch(() => undefined)

    return next(e)
  })

  // /clear、/resume、/branch 不会再触发 session.start，这里补读一次
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await restore($, e.cwd).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'redpen' }, async $ => {
    await openPane($)

    return { text: '红笔批阅面板已打开：批阅篮、今天的次数、开关和看不懂词典都在里面。' }
  })

  // 读者档案只在会话开始时算一次，整段会话不变，不让系统提示的缓存反复失效
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const text = await read($, section)
    if (text === '') return result

    return { ...result, sections: [...result.sections, { id: 'red-pen:reader', text, scope: 'session' as const }] }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.reason === 'answer') {
      const answer = e.answer
      $.clock.after(10, () => void reviewAnswer($, answer).catch(() => undefined))
    }

    return result
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface === 'mobile' || e.props.isSummary === true || e.props.text.trim() === '') return next(e)

    const conf = await read($, settings)
    const review = conf.autoReview
      ? (await read($, reviews)).find(one => matchesAnswer(one.norm, e.props.text))
      : undefined
    if (!conf.enabled && review === undefined) return next(e)

    const { Box, Text, Button, Input, Markdown } = $.ui.resolve(e)
    const requestId = e.requestId
    const member = memberOf(blocks, e)
    const block = conf.enabled ? await read($, member) : EMPTY_BLOCK
    const units = conf.enabled ? splitUnits(e.props.text) : [{ id: 'all', text: e.props.text }]

    const say = (mark: PenMark) =>
      mark.verdict === 'ok' ? '采纳' : mark.verdict === 'no' ? '不要' : `批注：${mark.note}`

    const toggleOpen = (unit: Unit) =>
      void update($, member, old => ({ ...old, open: old.open === unit.id ? '' : unit.id }))

    // 每段右边留一条固定宽的窄边，「✎」放在里面、和段落最后一行对齐：
    // 窄边一直占着，「✎」悬停才出现，所以既不盖字、也不让文字重新换行；点了才展开工具栏
    const unitRow = (unit: Unit) => {
      const mark = block.marks[unit.id]
      const explain = block.explains[unit.id]
      const isEditing = block.editing === unit.id
      const isOpen = block.open === unit.id

      return (
        <Box key={`u-${unit.id}`} flexDirection="column">
          <Box flexDirection="row">
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Markdown text={unit.text} />
            </Box>
            <Box width={3} flexShrink={0} alignSelf="flex-end" justifyContent="flex-end">
              {isOpen ? (
                <Button key={`pen-${unit.id}`} label="✎" plain onPress={() => toggleOpen(unit)} />
              ) : (
                <Box display="none" hover={{ display: 'flex' }}>
                  <Button key={`pen-${unit.id}`} label="✎" plain dimColor onPress={() => toggleOpen(unit)} />
                </Box>
              )}
            </Box>
          </Box>
          {mark !== undefined && <Text color="error">{`  ✎ ${say(mark)}`}</Text>}
          {explain !== undefined && (
            <Box flexDirection="column" paddingLeft={2}>
              <Text dimColor>{explain.status === 'asking' ? '啥意思：正在问…' : '啥意思：'}</Text>
              {explain.status !== 'asking' && <Markdown text={explain.text} dimColor />}
            </Box>
          )}
          {isEditing && (
            <Input
              key={`in-${unit.id}`}
              placeholder="写批注，回车放进批阅篮；清空再回车就是撤回"
              value={mark?.verdict === 'note' ? mark.note : ''}
              submitLabel="放进批阅篮"
              autoFocus
              onSubmit={value => void saveNote($, requestId, unit, value)}
            />
          )}
          {isOpen && (
            <Box gap={1}>
              <Button
                key={`ok-${unit.id}`}
                label={mark?.verdict === 'ok' ? '✓ 采纳' : '采纳'}
                dimColor
                onPress={() => void toggleVerdict($, requestId, unit, 'ok')}
              />
              <Button
                key={`no-${unit.id}`}
                label={mark?.verdict === 'no' ? '✓ 不要' : '不要'}
                dimColor
                onPress={() => void toggleVerdict($, requestId, unit, 'no')}
              />
              <Button
                key={`ask-${unit.id}`}
                label={explain === undefined ? '啥意思' : '收起解释'}
                dimColor
                onPress={() => void ask($, requestId, unit)}
              />
              <Button
                key={`note-${unit.id}`}
                label={mark?.verdict === 'note' ? '改批注' : '批注'}
                dimColor
                onPress={() =>
                  void update($, member, old => ({
                    ...old,
                    editing: old.editing === unit.id ? '' : unit.id,
                    open: '',
                  }))
                }
              />
              <Button key={`close-${unit.id}`} label="收起" dimColor onPress={() => toggleOpen(unit)} />
            </Box>
          )}
        </Box>
      )
    }

    const reviewBox = (one: PenReview) => {
      if (one.status === 'checking') return <Text dimColor>红笔正在批这条回答…</Text>
      const open = one.findings.map((f, i) => ({ f, i })).filter(({ f }) => f.state === 'open')
      if (open.length === 0) return null

      return (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="error" paddingX={1}>
          <Text color="error" bold>
            红笔 {open.length} 处
          </Text>
          {open.map(({ f, i }) => (
            <Box key={`f-${i}`} flexDirection="column">
              <Box gap={1}>
                <Text>「{f.quote}」</Text>
                <Text dimColor>{f.rule}</Text>
              </Box>
              <Text dimColor>{`  建议：${f.fix}`}</Text>
              <Box gap={1}>
                <Button key={`fix-${i}`} label="照改" onPress={() => void applyFindings($, one.id, [i])} />
                <Button key={`skip-${i}`} label="这条不算" dimColor onPress={() => void dismissFinding($, one.id, i)} />
              </Box>
            </Box>
          ))}
          {open.length > 1 && (
            <Button
              key="fix-all"
              label="全部照改"
              variant="primary"
              onPress={() => void applyFindings($, one.id, open.map(({ i }) => i))}
            />
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {units.map(unit => (conf.enabled ? unitRow(unit) : <Markdown text={unit.text} />))}
        {review !== undefined && reviewBox(review)}
      </Box>
    )
  })

  // 批阅篮有东西时才占输入框上方那一条，空了就让给别的插件
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const items = await read($, basket)
    if (items.length === 0) return next(e)

    const accept = await read($, allAccept)
    const n = (verdict: string) => items.filter(item => item.verdict === verdict).length
    const { Box, Text, Button } = $.ui.resolve(e)

    return (
      <Box gap={1} flexWrap="wrap">
        <Text color="error" bold>
          红笔
        </Text>
        <Text>已批 {items.length} 条</Text>
        <Text dimColor>
          （采纳 {n('ok')} · 不要 {n('no')} · 批注 {n('note')}）
        </Text>
        <Button
          key="accept"
          label={accept ? '✓ 其余都采纳' : '其余都采纳'}
          dimColor={!accept}
          onPress={() => void update($, allAccept, value => !value)}
        />
        <Button key="preview" label="预览" onPress={() => void openPane($)} />
        <Button key="send" label="发出" variant="primary" onPress={() => void send($)} />
        <Button key="clear" label="清空" dimColor onPress={() => void clearBasket($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const items = await read($, basket)
    const accept = await read($, allAccept)
    const conf = await read($, settings)
    const stats = await read($, today)
    const words = await read($, dict)
    const from = await read($, rulesFrom)
    const date = dayOf(await $.clock.now())
    const day = stats.date === date ? stats : emptyDay(date)
    const say = (item: PenBasketItem) =>
      item.verdict === 'ok' ? '采纳' : item.verdict === 'no' ? '不要' : item.note

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>批阅篮 · {items.length} 条</Text>
          {items.length === 0 && (
            <Text dimColor>还没批。鼠标停在 Claude 回答的某一段上，点「采纳 / 不要 / 啥意思 / 批注」。</Text>
          )}
          {items.map(item => (
            <Box key={`b-${item.key}`} gap={1}>
              <Text wrap="truncate-end">
                {item.quote}——{say(item)}
              </Text>
              <Button
                key={`del-${item.key}`}
                label="删掉"
                dimColor
                onPress={() => void setMark($, item.requestId, { id: item.unitId, text: '' }, null)}
              />
            </Box>
          ))}
          {items.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>发出去会是这样：</Text>
              <Markdown text={'```\n' + composeMessage(items, accept) + '\n```'} />
              <Box gap={1}>
                <Button
                  key="p-accept"
                  label={accept ? '✓ 其余都采纳' : '其余都采纳'}
                  dimColor={!accept}
                  onPress={() => void update($, allAccept, value => !value)}
                />
                <Button key="p-send" label="发出" variant="primary" onPress={() => void send($)} />
                <Button key="p-clear" label="清空" dimColor onPress={() => void clearBasket($)} />
              </Box>
            </Box>
          )}
        </Box>

        <Box flexDirection="column">
          <Text bold>今天</Text>
          <Text>
            批了 {day.marks} 段 · 发出 {day.sent} 次 · 问「啥意思」{day.explains} 次
          </Text>
          <Text>
            红笔批了 {day.reviews} 条回答，挑出 {day.findings} 处（照改 {day.applied} · 不算 {day.dismissed}）
          </Text>
        </Box>

        <Box flexDirection="column">
          <Text bold>开关</Text>
          <Box gap={1}>
            <Button
              key="t-enabled"
              label={conf.enabled ? '段落按钮：开' : '段落按钮：关'}
              onPress={() => void saveSettings($, old => ({ ...old, enabled: !old.enabled }))}
            />
            <Button
              key="t-review"
              label={conf.autoReview ? '自动红笔：开' : '自动红笔：关'}
              onPress={() => void saveSettings($, old => ({ ...old, autoReview: !old.autoReview }))}
            />
          </Box>
          <Text dimColor wrap="truncate-end">
            规矩来自：{from} · 超过 {conf.minChars} 字的回答才批
          </Text>
        </Box>

        <Box flexDirection="column">
          <Text bold>看不懂词典 · {words.length} 个</Text>
          {words.length === 0 && (
            <Text dimColor>点过「啥意思」的词会记在这里，下次开会话时提醒 Claude 少用，或者先解释。</Text>
          )}
          {words.slice(0, 12).map(word => (
            <Text wrap="truncate-end">
              {word.term}：{word.explain}
            </Text>
          ))}
        </Box>
      </Box>
    )
  })
}
