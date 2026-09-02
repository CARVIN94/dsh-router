/**
 * RouterAdapter 的 usage 契约测试。
 *
 * 这些用例存在的原因：adapter 曾把上游 OpenAI 形态的 usage 原样透传给
 * dsh-llm，导致会话日志里的 usage 全是 `prompt_tokens`（没有 `inputTokens`）。
 * 下游 token-meter 读 `usage.inputTokens` 得 `undefined`，累加出 `NaN`，
 * 投影 schema（`z.number().int().nonnegative()`）校验一抛，整条
 * `session.history` RPC 失败 —— 用户看到的就是「历史加载失败」。
 *
 * 所以这里锁死两条：字段名对、口径对（DISJOINT）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toTokenUsage } from '../router/usage-tokens.ts'
import { translateSse } from './adapter.ts'

/** 跑一遍 SSE 载荷序列，返回产出的 usage chunk（没有则 undefined）。 */
async function usageOf(...payloads: string[]): Promise<Record<string, unknown> | undefined> {
  for await (const chunk of translateSse(payloads)) {
    if (chunk.type === 'usage') return chunk.usage as unknown as Record<string, unknown>
  }
  return undefined
}

/** 一帧 SSE 的 data 载荷（translateSse 吃的是已剥掉 `data:` 前缀的载荷）。 */
const frame = (obj: unknown): string => JSON.stringify(obj)

/* ---------------- 契约转换 ---------------- */

test('转换：OpenAI 形态的 prompt_tokens → inputTokens，且扣掉缓存（DISJOINT）', () => {
  // prompt_tokens 是含缓存的总量；DISJOINT 要求 inputTokens 只算未缓存部分
  const u = toTokenUsage({ promptTokens: 1000, completionTokens: 50, cachedTokens: 300 })
  assert.deepEqual(u, { inputTokens: 700, outputTokens: 50, cacheReadTokens: 300 })
})

test('转换：无缓存时不带 cacheReadTokens 字段（不写无意义的 0）', () => {
  const u = toTokenUsage({ promptTokens: 100, completionTokens: 20, cachedTokens: 0 })
  assert.deepEqual(u, { inputTokens: 100, outputTokens: 20 })
})

test('转换：全 0 返回 null（这一帧没真数据，整个省略 usage）', () => {
  assert.equal(toTokenUsage({ promptTokens: 0, completionTokens: 0, cachedTokens: 0 }), null)
  assert.equal(toTokenUsage(null), null)
})

test('转换：NaN / Infinity / 负数一律归零 —— 绝不把 NaN 写进会话日志', () => {
  const u = toTokenUsage({
    promptTokens: Number.NaN,
    completionTokens: Number.POSITIVE_INFINITY,
    cachedTokens: -5,
  })
  assert.equal(u, null) // 全归零 → 视为无数据
  const partial = toTokenUsage({ promptTokens: Number.NaN, completionTokens: 42, cachedTokens: 0 })
  assert.deepEqual(partial, { inputTokens: 0, outputTokens: 42 })
  for (const v of Object.values(partial ?? {})) assert.ok(Number.isFinite(v), `出现非有限数: ${v}`)
})

test('转换：缓存比总输入还大时 inputTokens 不为负（上游口径打架也要自洽）', () => {
  const u = toTokenUsage({ promptTokens: 100, completionTokens: 1, cachedTokens: 500 })
  assert.equal(u?.inputTokens, 0)
})

/* ---------------- adapter 出口 ---------------- */

test('出口：流式 SSE 的 usage 必须是 DSH 契约，不是上游原样', async () => {
  const usage = await usageOf(
    frame({ choices: [{ delta: { content: 'hi' } }] }),
    frame({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 236655, completion_tokens: 548, prompt_tokens_details: { cached_tokens: 1024 } },
    }),
    '[DONE]',
  )
  assert.ok(usage !== undefined, '应当产出 usage chunk')
  // 字段名对
  assert.equal(usage.prompt_tokens, undefined, '不能把上游字段原样透传')
  assert.equal(usage.inputTokens, 235631) // 236655 - 1024
  assert.equal(usage.outputTokens, 548)
  assert.equal(usage.cacheReadTokens, 1024)
  // 每个字段都是有限非负整数（投影 schema 的硬要求）
  for (const [k, v] of Object.entries(usage)) {
    assert.ok(Number.isInteger(v) && (v as number) >= 0, `${k} 非法: ${v}`)
  }
})

test('出口：上游把 usage 拆在多帧时字段级合并（不是被后一帧覆盖）', async () => {
  // Claude 系：message_start 给输入，message_delta 只给输出
  const usage = await usageOf(
    frame({ choices: [{ delta: { content: 'x' } }], usage: { input_tokens: 100, cache_read_input_tokens: 40 } }),
    frame({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { output_tokens: 55 } }),
    '[DONE]',
  )
  assert.equal(usage?.inputTokens, 100, '后一帧没有输入，不能把前一帧的输入冲掉')
  assert.equal(usage?.outputTokens, 55)
  assert.equal(usage?.cacheReadTokens, 40)
})

test('出口：上游发全 0 或垃圾 usage 时省略整个 usage chunk', async () => {
  const zero = frame({ choices: [{ delta: { content: 'x' } }], usage: { prompt_tokens: 0, completion_tokens: 0 } })
  assert.equal(await usageOf(zero, '[DONE]'), undefined)
  const junk = frame({ choices: [{ delta: { content: 'x' } }], usage: { prompt_tokens: 'abc', completion_tokens: null } })
  assert.equal(await usageOf(junk, '[DONE]'), undefined)
})

test('出口：上游压根不发 usage 时不硬凑 usage chunk', async () => {
  const sse = frame({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] })
  assert.equal(await usageOf(sse, '[DONE]'), undefined)
})

/* ---------------- finish reason ---------------- */

/** 跑一遍 SSE 载荷序列，返回 finish chunk 的 reason。 */
async function finishOf(...payloads: string[]): Promise<Record<string, unknown> | undefined> {
  for await (const chunk of translateSse(payloads)) {
    if (chunk.type === 'finish') return chunk.reason as unknown as Record<string, unknown>
  }
  return undefined
}

test('出口：中间帧的 finish_reason:"" 不是终止原因，不能变成 error finish', async () => {
  // CodeBuddy 上游真实形态：首帧就带 finish_reason:""（意思是还没有终止原因）。
  // 当真原因收下会产出 code:"" 的 error finish，agent-loop 拿它重建 LlmError
  // 时 dsh-llm 直接抛 `LlmError code must be a non-empty string`，用户看到
  // 「本轮运行失败 … UNKNOWN」。空串必须被忽略，落到默认 stop。
  const reason = await finishOf(frame({ choices: [{ delta: { content: 'hi' }, finish_reason: '' }] }), '[DONE]')
  assert.deepEqual(reason, { kind: 'stop' })
})

test('出口：空的 finish_reason 不许冲掉后面那个真终止原因', async () => {
  // 同一条流里先 "" 后 "tool_calls"（models-cache.test.ts 里的真实帧序）
  const reason = await finishOf(
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'bash', arguments: '{}' } }] }, finish_reason: '' }] }),
    frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    '[DONE]',
  )
  assert.deepEqual(reason, { kind: 'tool-calls' })
})

test('出口：未知终止原因必须带非空 code（agent-loop 会拿它重建 LlmError）', async () => {
  const reason = await finishOf(frame({ choices: [{ delta: { content: 'x' }, finish_reason: 'content_filter' }] }), '[DONE]')
  assert.equal(reason?.kind, 'error')
  const failure = reason?.failure as { message: string; code: string }
  assert.equal(failure.code, 'CONTENT_FILTER')
  // 空白原因也必须有码 —— 空码会让 dsh-llm 抛「本轮运行失败」
  const blank = await finishOf(frame({ choices: [{ delta: { content: 'x' }, finish_reason: '   ' }] }), '[DONE]')
  const blankCode = (blank?.failure as { code: string }).code
  assert.ok(typeof blankCode === 'string' && blankCode.length > 0, `code 必须非空，实际 ${JSON.stringify(blankCode)}`)
})

/* ---------------- tool-call 参数完整性 ---------------- */

/**
 * 为什么要有这一组：上游（CodeBuddy 网关，长上下文/高压时）会在 tool_call
 * 的 arguments 分片**还没发完**就直接发 `[DONE]`。adapter 原本在 `[DONE]`
 * 时无条件收尾所有 block，把半成品 JSON（如 `{"command": "cd`）当完整参数
 * 交给 harness —— 工具侧校验报 `missing required property "command"` /
 * `"arguments" must be an object`，表现为「bash 调用大面积失败」。
 * 实测一次会话里 29 次工具调用有 27 次参数是残缺的。
 *
 * 所以这里锁死：**残缺参数绝不能当有效调用交出去**。
 */

/** 跑一遍 SSE，返回 finish chunk 的 reason。 */
async function toolCallsOf(...payloads: string[]): Promise<Array<{ name?: string; arguments?: string }>> {
  const out: Array<{ name?: string; arguments?: string }> = []
  for await (const chunk of translateSse(payloads)) {
    if (chunk.type === 'block-end' && (chunk.block as { type?: string }).type === 'tool-call') {
      out.push(chunk.block as { name?: string; arguments?: string })
    }
  }
  return out
}

test('工具调用：参数分片发完才收尾，完整 JSON 原样保留', async () => {
  const calls = await toolCallsOf(
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'bash', arguments: '' } }] } }] }),
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"command": "ls' } }] } }] }),
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ' -la"}' } }] } }] }),
    frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    '[DONE]',
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.arguments, '{"command": "ls -la"}')
})

test('工具调用：参数残缺时绝不产出该调用（不能把半成品 JSON 交给工具）', async () => {
  // 真实故障形态：首片开块，[DONE] 就来了，参数停在 `{"command": "cd`
  const calls = await toolCallsOf(
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'bash', arguments: '{"command": "cd' } }] } }] }),
    '[DONE]',
  )
  assert.equal(calls.length, 0, '残缺参数不能变成一次工具调用')
})

test('工具调用：参数残缺时整轮判 error（agent-loop 好重试，而不是拿着残参执行）', async () => {
  const reason = await finishOf(
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'bash', arguments: '{"command": "cd' } }] } }] }),
    '[DONE]',
  )
  assert.equal(reason?.kind, 'error')
  const failure = reason?.failure as { message: string; code: string }
  assert.ok(typeof failure.code === 'string' && failure.code.length > 0, 'error code 必须非空')
})

test('工具调用：整块没收到任何参数是空对象，不算残缺', async () => {
  // 无参工具（如 checkinNow）合法：arguments 为空串，应补成 {}
  const calls = await toolCallsOf(
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'ping', arguments: '' } }] } }] }),
    frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    '[DONE]',
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.arguments, '{}')
})
