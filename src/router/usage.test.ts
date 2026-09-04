/**
 * 用量统计测试 —— token 提取口径 + 落盘聚合 + 请求路径接线。
 * 用 node --test 跑（Node 原生 TS 剥离，零新依赖）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeUsage,
  mergeUsage,
  extractFrameUsage,
  usageFromJsonBody,
  tapStreamUsage,
  withEstimates,
  estimateTokens,
} from './usage-tokens.ts'
import { UsageStore, localDateKey } from './usage-store.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { Router } from './index.ts'
import { AccountPool } from './account-pool.ts'
import type { ServerResponse } from 'node:http'
import type { ModelInfo } from './types.ts'
import type { ChatOnceResult, SupplierAccountNow, SupplierStatusNow } from '../suppliers/contract.ts'
import type { AccountPool as Pool } from './account-pool.ts'

/* ---------------- token 提取 ---------------- */

test('归一化：OpenAI 形态的 cached_tokens 已含在 prompt 里，不重复加', () => {
  const u = normalizeUsage({ prompt_tokens: 100, completion_tokens: 20, cached_tokens: 30 })
  assert.deepEqual(u, { promptTokens: 100, completionTokens: 20, cachedTokens: 30 })
})

test('归一化：Claude 形态的 prompt 不含缓存，cache_read 要折进输入', () => {
  // 照 9router canonicalizeUsage：Claude 报的 input 排除 cache，得加回来
  const u = normalizeUsage({ input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 80 })
  assert.deepEqual(u, { promptTokens: 130, completionTokens: 10, cachedTokens: 80 })
})

test('归一化：Gemini 形态（promptTokenCount / usageMetadata）', () => {
  const u = normalizeUsage({ promptTokenCount: 7, candidatesTokenCount: 3, cachedContentTokenCount: 2 })
  assert.deepEqual(u, { promptTokens: 7, completionTokens: 3, cachedTokens: 2 })
})

test('归一化：垃圾输入返回 null，不产生 NaN', () => {
  assert.equal(normalizeUsage(null), null)
  assert.equal(normalizeUsage('x'), null)
  assert.equal(normalizeUsage([]), null)
  assert.equal(normalizeUsage({}), null)
  // 全 0 视为「没拿到 usage」
  assert.equal(normalizeUsage({ prompt_tokens: 0, completion_tokens: 0 }), null)
  // 非有限数当 0，不能毒穿累加
  assert.deepEqual(normalizeUsage({ prompt_tokens: Number.NaN, completion_tokens: 5 }), {
    promptTokens: 0, completionTokens: 5, cachedTokens: 0,
  })
})

test('合并：字段级取 max（Claude 把 usage 拆在两个事件里）', () => {
  // message_start 给输入+缓存，输出是占位的 1；message_delta 给真实输出，输入缺失
  const a = extractFrameUsage({ type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 40 } } })
  const b = extractFrameUsage({ type: 'message_delta', usage: { output_tokens: 55 } })
  const merged = mergeUsage(a, b)
  assert.deepEqual(merged, { promptTokens: 140, completionTokens: 55, cachedTokens: 40 })
  // 反过来合并（事件顺序颠倒）结果一致
  assert.deepEqual(mergeUsage(b, a), merged)
})

test('合并：一侧为 null 时取另一侧', () => {
  const u = { promptTokens: 1, completionTokens: 2, cachedTokens: 0 }
  assert.deepEqual(mergeUsage(null, u), u)
  assert.deepEqual(mergeUsage(u, null), u)
  assert.equal(mergeUsage(null, null), null)
})

test('帧提取：OpenAI 最后一帧的 usage + Responses API 的 response.usage', () => {
  assert.deepEqual(extractFrameUsage({ usage: { prompt_tokens: 9, completion_tokens: 1 } }), {
    promptTokens: 9, completionTokens: 1, cachedTokens: 0,
  })
  assert.deepEqual(
    extractFrameUsage({ type: 'response.completed', response: { usage: { input_tokens: 4, output_tokens: 6 } } }),
    { promptTokens: 4, completionTokens: 6, cachedTokens: 0 },
  )
  // 坏帧（非 JSON / null / 数组）不炸
  assert.equal(extractFrameUsage(null), null)
  assert.equal(extractFrameUsage([]), null)
  assert.equal(extractFrameUsage('x'), null)
})

test('非流式响应体：纯 JSON 取 usage；SSE 形态扫尾部帧', () => {
  assert.deepEqual(usageFromJsonBody('{"usage":{"prompt_tokens":11,"completion_tokens":2}}'), {
    promptTokens: 11, completionTokens: 2, cachedTokens: 0,
  })
  // 客户端要 JSON 但拿到 SSE（核心聚合前的形态）
  const sse = [
    'data: {"choices":[{"delta":{"content":"hi"}}]}',
    '',
    'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":4}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')
  assert.deepEqual(usageFromJsonBody(sse), { promptTokens: 3, completionTokens: 4, cachedTokens: 0 })
  // 既不是 JSON 也没有 usage → null
  assert.equal(usageFromJsonBody('not json at all'), null)
})

test('估算：~4 字符/token；上游给了就不覆盖', () => {
  assert.equal(estimateTokens(0), 0)
  assert.equal(estimateTokens(-5), 0)
  assert.equal(estimateTokens(100), 25)

  // 全缺 → 输入输出都估算
  const all = withEstimates(null, 400, 80)
  assert.deepEqual(all, {
    promptTokens: 100, completionTokens: 20, cachedTokens: 0,
    inputEstimated: true, outputEstimated: true,
  })
  // 只缺输出 → 只估输出（输入用真值，标记 false）
  const partial = withEstimates({ promptTokens: 7, completionTokens: 0, cachedTokens: 1 }, 400, 80)
  assert.deepEqual(partial, {
    promptTokens: 7, completionTokens: 20, cachedTokens: 1,
    inputEstimated: false, outputEstimated: true,
  })
})

/* ---------------- 流式：边透传边统计 ---------------- */

/** 用若干 chunk 造一条 SSE 流。 */
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (i >= chunks.length) {
        ctrl.close()
        return
      }
      ctrl.enqueue(enc.encode(chunks[i] ?? ''))
      i += 1
    },
  })
}

/** 读干一条流（模拟客户端消费）。 */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const dec = new TextDecoder()
  let out = ''
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += dec.decode(value as Uint8Array, { stream: true })
  }
  return out
}

test('tapStreamUsage：原样透传每个字节，统计在旁路做', async () => {
  const chunks = ['data: {"choices":[{"delta":{"content":"he"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"llo"}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n', 'data: [DONE]\n\n']
  const { stream, done } = tapStreamUsage(sseStream(chunks), Date.now())

  // 客户端拿到的字节必须与上游一字不差
  assert.equal(await drain(stream), chunks.join(''))

  const got = await done()
  assert.deepEqual(got.usage, { promptTokens: 10, completionTokens: 5, cachedTokens: 0 })
  assert.equal(got.outputChars, 5) // "he" + "llo"
  assert.ok(got.ttfbMs >= 0)
})

test('tapStreamUsage：帧被切在 chunk 边界上也能拼回来', async () => {
  // 一帧从中间劈成两半——跨边界的帧必须留在 buffer 里等下一块
  const [a, b] = ['data: {"usage":{"prompt_tokens":1', '2,"completion_tokens":3}}\n\n']
  const { stream, done } = tapStreamUsage(sseStream([a ?? '', b ?? '']), Date.now())
  await drain(stream)
  const got = await done()
  assert.deepEqual(got.usage, { promptTokens: 12, completionTokens: 3, cachedTokens: 0 })
})

test('tapStreamUsage：usage 分散在多帧时取 max 合并', async () => {
  const chunks = [
    'data: {"usage":{"prompt_tokens":100,"completion_tokens":1}}\n\n',
    'data: {"usage":{"completion_tokens":42}}\n\n',
  ]
  const { stream, done } = tapStreamUsage(sseStream(chunks), Date.now())
  await drain(stream)
  // 第二帧的 completion 更大 → 取它；第一帧的 prompt 保留
  assert.deepEqual((await done()).usage, { promptTokens: 100, completionTokens: 42, cachedTokens: 0 })
})

test('tapStreamUsage：上游不发 usage 也能统计输出字符数（供估算）', async () => {
  const { stream, done } = tapStreamUsage(
    sseStream(['data: {"choices":[{"delta":{"content":"12345678"}}]}\n\n']),
    Date.now(),
  )
  await drain(stream)
  const got = await done()
  assert.equal(got.usage, null)
  assert.equal(got.outputChars, 8)
  // 交给 withEstimates 补：输出 = ceil(8/4) = 2
  assert.equal(withEstimates(got.usage, 40, got.outputChars).completionTokens, 2)
})

test('tapStreamUsage：一个字节都没有 → ttfb 为 0 而不是负数或 NaN', async () => {
  const { stream, done } = tapStreamUsage(sseStream([]), Date.now())
  await drain(stream)
  assert.equal((await done()).ttfbMs, 0)
})

/* ---------------- 落盘聚合 ---------------- */

/** 造一条记录并记进去。 */
function rec(store: UsageStore, over: Partial<Parameters<UsageStore['record']>[0]> = {}, tokens = { promptTokens: 10, completionTokens: 5, cachedTokens: 0, inputEstimated: false, outputEstimated: false }): void {
  store.record({
    supplier: 'openai',
    model: 'gpt-4',
    requested: 'gpt-4',
    ok: true,
    durationMs: 100,
    ttfbMs: 0,
    ...over,
  }, tokens)
}

test('落账：成功请求入天桶 + 明细环 + lifetime', () => {
  const s = new UsageStore('')
  rec(s)
  const st = s.stats('today')
  assert.equal(st.requests, 1)
  assert.equal(st.ok, 1)
  assert.equal(st.failed, 0)
  assert.equal(st.promptTokens, 10)
  assert.equal(st.completionTokens, 5)
  assert.equal(st.lifetime, 1)
  assert.equal(s.recentList(10).length, 1)
})

test('落账：成功的零 token 请求不记（照 9router 的闸门）', () => {
  const s = new UsageStore('')
  rec(s, {}, { promptTokens: 0, completionTokens: 0, cachedTokens: 0, inputEstimated: false, outputEstimated: false })
  assert.equal(s.stats('today').requests, 0)
  assert.equal(s.stats('today').lifetime, 0)
})

test('落账：失败请求必须记（否则成功率永远是假的 100%）', () => {
  const s = new UsageStore('')
  rec(s, { ok: false, error: 'boom' }, { promptTokens: 0, completionTokens: 0, cachedTokens: 0, inputEstimated: false, outputEstimated: false })
  const st = s.stats('today')
  assert.equal(st.requests, 1)
  assert.equal(st.failed, 1)
  assert.equal(st.ok, 0)
  assert.equal(s.recentList(1)[0]?.error, 'boom')
})

test('周期：today 用自然日零点切窗，24h 用滚动 24 小时', () => {
  const s = new UsageStore('')
  // 固定基准：今天 12:00。绝不能用「距今 N 小时」写死偏移——真实挂钟一过
  // 23:00，「23 小时前」就落回今天，断言翻车（这个坑真踩过：本地 23:18 跑
  // 测试红了，代码没问题，是测试依赖了挂钟）。基准取正午，两头都留够余量。
  const base = new Date()
  base.setHours(12, 0, 0, 0)
  const now = base.getTime()
  const dayStart = new Date(now).setHours(0, 0, 0, 0)

  const yesterday = dayStart - 13 * 3600000 // 昨天 11:00（距今 25 小时）
  const thisMorning = dayStart + 3600000 // 今天 01:00

  rec(s, { ts: yesterday })
  assert.equal(s.stats('today', now).requests, 0, '昨天的请求不该进 today')
  assert.equal(s.stats('24h', now).requests, 0, '距今 25 小时不该进 24h')

  rec(s, { ts: thisMorning })
  assert.equal(s.stats('today', now).requests, 1, '今天 01:00 该进 today')
  assert.equal(s.stats('24h', now).requests, 1, '今天 01:00 该进 24h')

  rec(s, { ts: now })
  assert.equal(s.stats('today', now).requests, 2)
  assert.equal(s.stats('24h', now).requests, 2)

  // 7d/30d 走天桶：昨天的那条算得进来（today/24h 算不进来）
  assert.equal(s.stats('7d', now).requests, 3)
})

test('周期：7d/30d 走天桶，明细环撑爆也不影响', () => {
  const s = new UsageStore('')
  const now = Date.now()
  // 塞 600 条（> RING_CAP 500），全在今天
  for (let i = 0; i < 600; i += 1) rec(s, { ts: now })
  const week = s.stats('7d', now)
  assert.equal(week.requests, 600) // 天桶是精确累加，不受环容量限制
  assert.equal(s.recentList(1000).length, 500) // 明细环只留 500
})

test('周期：today/24h 走小时桶，明细环撑爆也不影响（回归：今日曾被截断成 500）', () => {
  const s = new UsageStore('')
  const now = Date.now()
  // 塞 600 条（> RING_CAP 500），全在今天
  for (let i = 0; i < 600; i += 1) rec(s, { ts: now })
  assert.equal(s.stats('today', now).requests, 600, 'today 必须精确，不能受明细环容量限制')
  assert.equal(s.stats('24h', now).requests, 600)
  assert.equal(s.stats('7d', now).requests, 600)
  assert.equal(s.stats('30d', now).requests, 600)
  assert.equal(s.recentList(1000).length, 500, '明细环仍然只留 500（它只服务最近列表）')
})

test('周期：today 精确，不会把昨天算进来', () => {
  const s = new UsageStore('')
  // 基准取正午：两头都留够余量，免得真实挂钟一过 23 点测试就翻车（踩过）
  const base = new Date()
  base.setHours(12, 0, 0, 0)
  const now = base.getTime()
  const dayStart = new Date(now).setHours(0, 0, 0, 0)

  // 昨天 22:00 一批、今天 08/09 点各一批 —— 每批都逼近 RING_CAP
  for (let i = 0; i < 300; i += 1) rec(s, { ts: dayStart - 2 * 3600000 })
  for (let i = 0; i < 300; i += 1) rec(s, { ts: dayStart + 8 * 3600000 })
  for (let i = 0; i < 300; i += 1) rec(s, { ts: dayStart + 9 * 3600000 })

  assert.equal(s.stats('today', now).requests, 600, 'today 只算今天')
  assert.equal(s.stats('7d', now).requests, 900)
  // 24h 从今天 12:00 往前滚：昨天 22:00 那批距今 14 小时，还在窗口内
  assert.equal(s.stats('24h', now).requests, 900)
})

test('图表：today 的小时桶按整点归位，不再靠明细环', () => {
  const s = new UsageStore('')
  const base = new Date()
  base.setHours(12, 0, 0, 0)
  const now = base.getTime()
  const dayStart = new Date(now).setHours(0, 0, 0, 0)

  for (let i = 0; i < 600; i += 1) rec(s, { ts: dayStart + 9 * 3600000 + 1000 }) // 今天 09:00 那格

  const ch = s.chart('today', now)
  assert.equal(ch.length, 24)
  assert.equal(ch[9]?.requests, 600, '全落 09:00 那格')
  assert.equal(ch[9]?.tokens, 600 * 15)
  assert.equal(ch[10]?.requests, 0)
  assert.equal(ch.reduce((n, b) => n + b.requests, 0), 600, '各格之和 = today 总数')
})

test('落盘：旧文件没有 hours 字段也能读（没有迁移，补空即可）', () => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/dshr-usage-${Math.random().toString(36).slice(2)}`
  mkdirSync(dir, { recursive: true })
  const fp = `${dir}/state.json`
  // 手写一份「老格式」：天桶没有 hours（升级前落盘的就是这样）
  writeFileSync(
    `${dir}/usage.json`,
    JSON.stringify({
      days: { [localDateKey(Date.now())]: { requests: 3, ok: 3, failed: 0, bySupplier: {} } },
      recent: [],
      lifetime: 3,
    }),
  )
  const s = new UsageStore(fp)
  // 天桶口径照常：老数据一天都不会丢
  assert.equal(s.stats('7d').requests, 3)
  assert.equal(s.stats('today').requests, 3, 'today 走天桶，老数据照读')
  // 小时粒度是永久缺失的（明细环回溯不回去）→ 24h 整桶兜底，不编数据
  assert.equal(s.stats('24h').requests, 3, '小时桶不齐 → 整桶计入，不报比 today 更小的数')
  assert.equal(s.chart('today').length, 24, '图表格子数不变')
  assert.equal(s.chart('today').reduce((n, b) => n + b.requests, 0), 0, '没有小时粒度就不瞎填')
  // 新请求照常累加，补上的 hours 立刻生效
  rec(s, { ts: Date.now() })
  assert.equal(s.stats('today').requests, 4)
  assert.equal(s.chart('today').reduce((n, b) => n + b.requests, 0), 1)
})

test('周期：24h 跨天时，小时粒度齐的走小时格、不齐的整桶兜底', () => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/dshr-usage-${Math.random().toString(36).slice(2)}`
  mkdirSync(dir, { recursive: true })
  const fp = `${dir}/state.json`
  // 时钟固定当天 12:00，不用 Date.now()：24h 是当前整点往前 23 格，
  // 真实时钟在 23 点时窗口起点正好是今天 00:00，昨天整桶落在窗口外，
  // 这条用例就会从 700 变成 300 —— 测试挂不挂取决于跑的时刻，不能接受。
  const now = new Date().setHours(12, 30, 0, 0)
  const dayStart = new Date(now).setHours(0, 0, 0, 0)
  const yesterdayKey = localDateKey(dayStart - 12 * 3600000)

  // 昨天是「老数据」：天桶有 400 条但没有小时粒度
  writeFileSync(
    `${dir}/usage.json`,
    JSON.stringify({
      days: {
        [yesterdayKey]: { requests: 400, ok: 400, failed: 0, bySupplier: {}, byModel: {}, byRequested: {} },
      },
      recent: [],
      lifetime: 400,
    }),
  )
  const s = new UsageStore(fp)
  // 今天补 300 条（有小时粒度），全在当前小时，一定落在 24h 窗口内
  for (let i = 0; i < 300; i += 1) rec(s, { ts: now })

  assert.equal(s.stats('today', now).requests, 300, 'today 只算今天')
  // 窗口含昨天 12:00 之后那截 → 但昨天没小时粒度，只能整桶（400）计入
  const d24 = s.stats('24h', now).requests
  assert.ok(d24 >= 300, '24h 绝不能小于 today')
  assert.ok(d24 <= 700, '24h 也绝不能超总数')
  assert.equal(d24, 700, '昨天整桶 400 + 今天 300')

  // 反面对照：时钟移到 23 点，窗口不再含昨天，昨天那桶必须整桶退出
  // （不是被算一半，也不是漏掉今天的 300）。锁死「整桶进/整桶出」。
  const late = new Date().setHours(23, 30, 0, 0)
  assert.equal(s.stats('24h', late).requests, 300, '窗口不含昨天时只剩今天')
  assert.equal(s.stats('today', late).requests, 300, 'today 不受影响')
})

test('Top 榜：按请求数降序，且三个维度各自聚合', () => {
  const s = new UsageStore('')
  rec(s, { supplier: 'a', model: 'm1', requested: 'combo-x' })
  rec(s, { supplier: 'a', model: 'm1', requested: 'combo-x' })
  rec(s, { supplier: 'b', model: 'm2', requested: 'm2' })
  const st = s.stats('today')
  assert.deepEqual(st.bySupplier.map((r) => [r.name, r.requests]), [['a', 2], ['b', 1]])
  assert.deepEqual(st.byRequested.map((r) => [r.name, r.requests]), [['combo-x', 2], ['m2', 1]])
  assert.equal(st.byModel.length, 2)
})

test('平均耗时 / 平均 TTFB：分母是各自有记录的条数，不是总请求数', () => {
  const s = new UsageStore('')
  rec(s, { durationMs: 100, ttfbMs: 0 }) // 非流式：没有 TTFB
  rec(s, { durationMs: 300, ttfbMs: 200 })
  const st = s.stats('today')
  assert.equal(st.avgDurationMs, 200) // (100+300)/2
  assert.equal(st.avgTtfbMs, 200) // 只有 1 条有 TTFB，不能除以 2
})

test('估算计数：面板据此提示「部分为估算」', () => {
  const s = new UsageStore('')
  rec(s, {}, { promptTokens: 10, completionTokens: 5, cachedTokens: 0, inputEstimated: true, outputEstimated: false })
  rec(s, {}, { promptTokens: 10, completionTokens: 5, cachedTokens: 0, inputEstimated: false, outputEstimated: false })
  const st = s.stats('7d')
  assert.equal(st.estimatedInputs, 1)
  assert.equal(st.estimatedOutputs, 0)
})

test('图表：today/24h = 24 个桶，7d/30d = 天桶', () => {
  const s = new UsageStore('')
  rec(s)
  assert.equal(s.chart('today').length, 24)
  assert.equal(s.chart('24h').length, 24)
  assert.equal(s.chart('7d').length, 7)
  assert.equal(s.chart('30d').length, 30)
  // 7d 天桶里今天那条被记上了
  const week = s.chart('7d')
  assert.equal(week[week.length - 1]?.requests, 1)
  assert.equal(week[week.length - 1]?.tokens, 15)
})

test('清空 + 落盘往返：数据持久化，重载后还在', () => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/dshr-usage-${Math.random().toString(36).slice(2)}`
  const fp = `${dir}/state.json`
  const s1 = new UsageStore(fp)
  rec(s1, { supplier: 'traework' })
  s1.flush()
  const s2 = new UsageStore(fp)
  assert.equal(s2.stats('today').requests, 1)
  assert.equal(s2.stats('today').bySupplier[0]?.name, 'traework')
  assert.equal(s2.stats('today').lifetime, 1)
  s2.clear()
  assert.equal(s2.stats('today').requests, 0)
  assert.equal(new UsageStore(fp).stats('today').requests, 0)
})

test('落盘：文件损坏不阻断启动（从空开始）', () => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/dshr-usage-${Math.random().toString(36).slice(2)}`
  const fp = `${dir}/state.json`
  mkdirSync(dir, { recursive: true })
  writeFileSync(fp, '{ this is not json')
  const s = new UsageStore(fp)
  assert.equal(s.stats('today').requests, 0)
})

test('localDateKey 按本地日切天，不是 UTC', () => {
  // 本地时间 00:30 —— UTC 可能还是前一天，但按本地算必须是今天
  const d = new Date(2026, 0, 15, 0, 30)
  assert.equal(localDateKey(d.getTime()), '2026-01-15')
})

/* ---------------- 请求路径接线 ---------------- */

interface Spy {
  calls: number
  s: {
    id: string
    name: string
    priority: number
    pool: Pool
    status: () => SupplierStatusNow
    listModels: () => Promise<ModelInfo[]>
    modelsWithEnabled: () => Promise<Array<ModelInfo & { enabled: boolean }>>
    getAlias: () => string
    accounts: () => SupplierAccountNow[]
    chatOnce: (uid: string, lv: string, req: { rawBody: string }) => Promise<ChatOnceResult>
    dispose: () => void
  }
}

/** 带探针的供应商：返回固定响应体。 */
function spy(id: string, modelId: string, reply: ChatOnceResult): Spy {
  const calls = { n: 0 }
  return {
    get calls() { return calls.n },
    s: {
      id, name: id, priority: 0, pool: new AccountPool(),
      status: () => ({ id, name: id, accounts: [{ uid: `${id}-u1`, credits: 0, state: 'ok' }] }),
      listModels: async () => [{ id: modelId }],
      modelsWithEnabled: async () => [{ id: modelId, enabled: true }],
      getAlias: () => id,
      accounts: () => [{ uid: `${id}-u1`, credits: 0, state: 'ok' }],
      chatOnce: async (_uid, _lv, req) => {
        calls.n += 1
        let m = ''
        try {
          m = (JSON.parse(req.rawBody) as { model?: string }).model ?? ''
        } catch {
          m = ''
        }
        // 真实插件自己认得别名前缀并剥掉（核心不剥，见 chatWithTarget 注释）
        if (m.startsWith(`${id}/`)) m = m.slice(id.length + 1)
        if (m !== modelId) return { ok: false, state: 'no_such_model', message: `unknown model ${m}` }
        return reply
      },
      dispose: () => {},
    },
  }
}

/** 走真实注册路径（router.add 内部会 sync 已知 id）。先转 unknown：
 *  探针的 status() 报的是插件「现在状态」，与核心叠加后面板态类型不同。 */
function add(router: Router, s: unknown): void {
  router.add(s as Parameters<Router['add']>[0])
}

/** 丢弃响应的假 res（记录写入内容）。字节按 utf-8 解码。 */
function sinkRes(): ServerResponse & { status(): number; body(): string } {
  let status = 200
  const parts: Uint8Array[] = []
  const dec = new TextDecoder()
  const take = (chunk: unknown): void => {
    if (chunk instanceof Uint8Array) parts.push(chunk)
    else if (typeof chunk === 'string') parts.push(new TextEncoder().encode(chunk))
  }
  const self = {
    headersSent: false,
    writableEnded: false,
    writeHead: (code: number): unknown => { status = code; return self },
    write: (chunk?: unknown): boolean => { take(chunk); return true },
    end: (chunk?: unknown): unknown => { take(chunk); return self },
    once: (): unknown => self,
    removeListener: (): unknown => self,
    destroy: (): void => {},
    flushHeaders: (): void => {},
    status: (): number => status,
    body: (): string => parts.map((p) => dec.decode(p)).join(''),
  }
  return self as unknown as ServerResponse & { status(): number; body(): string }
}

test('请求路径：非流式成功 → 记一条 ok，token 来自响应体 usage', async () => {
  const router = new Router('')
  const a = spy('alpha', 'gpt-4', { ok: true, status: 200, body: '{"usage":{"prompt_tokens":100,"completion_tokens":20}}' })
  add(router, a.s)
  await router.chatCompletions(
    { model: 'alpha/gpt-4', stream: false, rawBody: JSON.stringify({ model: 'alpha/gpt-4', messages: [] }) },
    sinkRes(),
  )
  const st = router.usage.stats('today')
  assert.equal(st.requests, 1)
  assert.equal(st.ok, 1)
  assert.equal(st.promptTokens, 100)
  assert.equal(st.completionTokens, 20)
  assert.equal(st.bySupplier[0]?.name, 'alpha')
  assert.equal(st.byRequested[0]?.name, 'alpha/gpt-4')
})

test('请求路径：流式成功 → 统计透传的流，客户端字节不受影响', async () => {
  const router = new Router('')
  const enc = new TextEncoder()
  const chunks = [
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
    'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":50,"completion_tokens":7}}\n\n',
    'data: [DONE]\n\n',
  ]
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(enc.encode(c))
      ctrl.close()
    },
  })
  const a = spy('alpha', 'gpt-4', { ok: true, stream })
  add(router, a.s)
  const res = sinkRes()
  await router.chatCompletions(
    { model: 'alpha/gpt-4', stream: true, rawBody: JSON.stringify({ model: 'alpha/gpt-4', messages: [], stream: true }) },
    res,
  )
  // 客户端拿到的字节与上游一致（统计没有动过流）
  assert.equal(res.body(), chunks.join(''))
  const st = router.usage.stats('today')
  assert.equal(st.requests, 1)
  assert.equal(st.promptTokens, 50)
  assert.equal(st.completionTokens, 7)
})

test('请求路径：上游不发 usage → 走估算（输入按请求体、输出按内容长度）', async () => {
  const router = new Router('')
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"12345678"}}]}\n\n'))
      ctrl.close()
    },
  })
  const a = spy('alpha', 'gpt-4', { ok: true, stream })
  add(router, a.s)
  // 请求体必须是合法 JSON（核心会改写 model 字段），长度凑到 40 字符 → 输入估 10
  const rawBody = JSON.stringify({ model: 'alpha/gpt-4', messages: [{ role: 'user', content: 'x'.repeat(8) }], stream: true })
  await router.chatCompletions({ model: 'alpha/gpt-4', stream: true, rawBody }, sinkRes())
  const st = router.usage.stats('today')
  assert.equal(st.promptTokens, Math.ceil(rawBody.length / 4))
  assert.equal(st.completionTokens, 2) // 输出 8 字符 → 估 2
  assert.equal(st.estimatedInputs, 1)
  assert.equal(st.estimatedOutputs, 1)
})

test('请求路径：全失败 → 记一条 failed，成功率才准', async () => {
  const router = new Router('')
  const a = spy('alpha', 'gpt-4', { ok: false, state: 'rate_limit', message: '429' })
  add(router, a.s)
  await router.chatCompletions(
    { model: 'alpha/gpt-4', stream: false, rawBody: JSON.stringify({ model: 'alpha/gpt-4', messages: [] }) },
    sinkRes(),
  )
  const st = router.usage.stats('today')
  assert.equal(st.requests, 1)
  assert.equal(st.failed, 1)
  assert.equal(st.ok, 0)
})

test('请求路径：失败请求不估算 token（没到上游就不该有输入 token）', async () => {
  const router = new Router('')
  add(router, spy('alpha', 'gpt-4', { ok: false, state: 'quota', message: 'no quota' }).s)
  await router.chatCompletions(
    { model: 'alpha/gpt-4', stream: false, rawBody: JSON.stringify({ model: 'alpha/gpt-4', messages: [{ role: 'user', content: 'x'.repeat(400) }] }) },
    sinkRes(),
  )
  const st = router.usage.stats('today')
  assert.equal(st.failed, 1)
  // 请求体 400+ 字符，若按字符数估算会有 ~100 输入 token——那是编造的
  assert.equal(st.promptTokens, 0)
  assert.equal(st.completionTokens, 0)
  assert.equal(st.estimatedInputs, 0)
  assert.equal(st.estimatedOutputs, 0)
})

test('请求路径：组合回退试了 3 个模型，只记 1 条（不是 3 条）', async () => {
  const router = new Router('')
  add(router, spy('s1', 'm1', { ok: false, state: 'quota', message: 'no quota' }).s)
  add(router, spy('s2', 'm2', { ok: false, state: 'quota', message: 'no quota' }).s)
  add(router, spy('s3', 'm3', { ok: true, status: 200, body: '{"usage":{"prompt_tokens":1,"completion_tokens":1}}' }).s)
  assert.equal(router.createCombo('c1', 'fallback', ['s1,m1', 's2,m2', 's3,m3']).ok, true)
  await router.chatCompletions(
    { model: 'c1', stream: false, rawBody: JSON.stringify({ model: 'c1', messages: [] }) },
    sinkRes(),
  )
  const st = router.usage.stats('today')
  // 一个客户端请求 = 一条记录，记的是**最终成功**的那个供应商/模型
  assert.equal(st.requests, 1)
  assert.equal(st.ok, 1)
  assert.deepEqual(st.bySupplier.map((r) => r.name), ['s3'])
  // 模型记对外全名 alias/model（与直接调用路径一致，Top 榜不会分裂成两行）
  assert.deepEqual(st.byModel.map((r) => r.name), ['s3/m3'])
  assert.equal(st.byRequested[0]?.name, 'c1')
})
