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
import { EMPTY_RESPONSE_CODE } from '@deepseek-ai/dsh-llm'
import { toTokenUsage } from '../router/usage-tokens.ts'
import { RouterAdapter, translateSse } from './adapter.ts'

/**
 * dsh-llm 默认可重试的错误码白名单（DEFAULT_RETRYABLE_CODES）。
 *
 * 这里**故意写死一份**而不是从依赖导入：白名单是重试能不能生效的判据，
 * 从 dsh-llm 导入的话，依赖升级改了白名单，这条测试会跟着一起变绿，
 * 而我们真正要锁的是「线上那份 policyKey 里的码」。
 * 来源：线上会话日志 llm/retry 的 policyKey —— ["EMPTY_RESPONSE","RATE_LIMIT",
 * "SERVER","TIMEOUT","TRANSPORT"]。若将来确实变了，同步改这里，并确认
 * adapter 用的码还在新名单里。
 */
const RETRYABLE_CODES = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']

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

test('工具调用：残缺的 error code 必须在默认可重试白名单里', async () => {
  // 这是最容易踩的坑：造一个「看起来更精确」的新码（INCOMPLETE_TOOL_ARGS）
  // 不在 dsh-llm 的默认 retryableCodes 里，结果**一次都不重试**，直接抛给
  // 用户 —— 正好毁掉「判 error 好让 agent-loop 重试」的本意。
  // 白名单来自线上会话日志的 policyKey；产出为空/不完整 → EMPTY_RESPONSE 最贴。
  const reason = await finishOf(
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'bash', arguments: '{"command": "cd' } }] } }] }),
    '[DONE]',
  )
  const code = (reason?.failure as { code: string }).code
  assert.ok(RETRYABLE_CODES.includes(code), `code ${code} 不在可重试白名单 ${JSON.stringify(RETRYABLE_CODES)} 里，残缺参数将永不重试`)
  assert.equal(code, EMPTY_RESPONSE_CODE)
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

/* ---------------- 真流式：边收边吐，不攒完再放 ---------------- */

/**
 * 为什么要有这一组：stream() 曾用 `await resp.text()` 把整个响应**攒成
 * 一个字符串**再解析，等于把流式降级成批处理：
 *
 *   1. 首字节延迟 = 整个响应耗时（CodeBuddy 长响应几十秒），用户干等；
 *   2. 中途断流 → resp.text() 抛异常或只拿到半截文本，最后一帧是半截 JSON
 *      （`{"command": "cd`）——这正是「bash 参数残缺」的根因。本地抓包
 *      永远复现不了，因为短响应连接不断；长响应才会断。
 *
 * 9router 的 copilot 通道只做字节级透传（pipeSSE，23 行，不解析 SSE），
 * 上游发什么客户端收什么，天然没有这个问题。dsh-router 必须在中间做
 * 协议转换，所以**必须自己保证是增量的**。
 *
 * 这里锁死：上游还在慢慢发时，下游必须已经收到前面的块。
 */

/** 造一个「先发一帧、再等 signal、再发 [DONE]」的 SSE 响应体。 */
function slowBody(): { stream: ReadableStream<Uint8Array>; resume: () => void; sent: () => boolean } {
  const enc = new TextEncoder()
  let resume = (): void => {}
  const gate = new Promise<void>((r) => { resume = r })
  let sent = false
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sent) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'first' } }] })}\n\n`))
        sent = true
        return
      }
      await gate
      controller.enqueue(enc.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return { stream, resume, sent: () => sent }
}

test('流式：上游还没发完，下游必须已经拿到前面的块（不能攒完再放）', async () => {
  const { stream, resume } = slowBody()
  globalThis.fetch = (async () => new Response(stream, { status: 200 })) as typeof fetch

  const adapter = new RouterAdapter('http://x', { comboModels: async () => [] })
  const seen: Array<{ type: string }> = []
  const gen = adapter.stream({ model: 'm', messages: [], signal: AbortSignal.timeout(5000) } as never)
  // 只取第一块：如果实现是「await resp.text() 攒完再解析」，这里会一直
  // 挂到上游关闭（gate 永不放行）→ 超时。真流式则立刻拿到 'first'。
  for await (const chunk of gen) {
    seen.push(chunk as { type: string })
    if (seen.length >= 2) break // block-start + text-delta
  }
  resume()
  assert.ok(
    seen.some((c) => c.type === 'text-delta'),
    `上游未发完就应收到 text-delta，实际收到：${JSON.stringify(seen.map((c) => c.type))}`,
  )
})

test('流式：断流（无 [DONE]）抛的 code 必须在可重试白名单里', async () => {
  // 同上一条白名单约束的另一处踩坑点：断流是**最该重试**的故障（半截响应、
  // 连接被切），若用自造码（STREAM_CLOSED）不在白名单里就永不重试。
  const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: 'a' } }] })}\n\n`
  globalThis.fetch = (async () => new Response(new TextEncoder().encode(sse), { status: 200 })) as typeof fetch
  const adapter = new RouterAdapter('http://x', { comboModels: async () => [] })
  let code = ''
  try {
    for await (const _c of adapter.stream({ model: 'm', messages: [], signal: AbortSignal.timeout(3000) } as never)) void _c
  } catch (e) {
    code = (e as { code?: string }).code ?? ''
  }
  assert.ok(RETRYABLE_CODES.includes(code), `断流 code ${JSON.stringify(code)} 不在白名单 ${JSON.stringify(RETRYABLE_CODES)} 里`)
})

test('流式：CRLF 换行也能正确收尾（不能把 \\r 当成帧内容）', async () => {
  const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: 'a' } }] })}\r\n\r\ndata: [DONE]\r\n\r\n`
  globalThis.fetch = (async () => new Response(new TextEncoder().encode(sse), { status: 200 })) as typeof fetch
  const adapter = new RouterAdapter('http://x', { comboModels: async () => [] })
  const types: string[] = []
  for await (const c of adapter.stream({ model: 'm', messages: [], signal: AbortSignal.timeout(3000) } as never)) {
    types.push(c.type)
  }
  assert.ok(types.includes('finish'), `CRLF 流必须以 finish 收尾，实际 ${JSON.stringify(types)}`)
})

test('流式：一帧横跨两次 read() 也能拼回来（半包）', async () => {
  const enc = new TextEncoder()
  const half = 'data: {"choices":[{"delta":{"content":"hel'
  const rest = 'lo"}}]}\n\ndata: [DONE]\n\n'
  let sent = false
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(c) {
          if (!sent) { sent = true; c.enqueue(enc.encode(half)) }
          else { c.enqueue(enc.encode(rest)); c.close() }
        },
      }),
      { status: 200 },
    )) as typeof fetch
  const adapter = new RouterAdapter('http://x', { comboModels: async () => [] })
  const texts: string[] = []
  for await (const c of adapter.stream({ model: 'm', messages: [], signal: AbortSignal.timeout(3000) } as never)) {
    if (c.type === 'text-delta') texts.push((c as { text: string }).text)
  }
  assert.equal(texts.join(''), 'hello', '跨块的半帧必须拼成完整内容')
})
