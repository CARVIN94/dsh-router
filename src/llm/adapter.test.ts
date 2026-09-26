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
import { AssistantStreamAccumulator, EMPTY_RESPONSE_CODE } from '@deepseek-ai/dsh-llm'
import { toTokenUsage } from '../router/usage-tokens.ts'
import { RouterAdapter, translateSse } from './adapter.ts'

/**
 * 本文件大量用例把 `globalThis.fetch` 打桩成假上游，且**从不还原**（沿既有惯例：
 * 每个用例自己设桩）。所以「要打真实网络」的用例必须自己把真 fetch 放回去 ——
 * 否则会静默拿到上一个用例残留的桩（曾导致「停摆测试 0ms 就 ended」的假结果）。
 */
const realFetch: typeof fetch = globalThis.fetch

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

test('工具调用：后续 delta 把 id/name 重发成 null 时，不能冲掉首帧也不许发 null', async () => {
  // 真实事故（2026-09-22，OpenCode/Zen）：上游首帧给 id+name，后续分片帧把
  // 它们**显式重发成 null**（不是省略、不是空串）。用对象构造、交给 frame() 序列化，
  // 免得在字符串字面量里跟引号打架。
  const tcDelta = (tc: unknown): string => frame({ choices: [{ delta: { tool_calls: [tc] } }] })
  const payloads = [
    tcDelta({ index: 0, id: 'call_abc', type: 'function', function: { name: 'bash', arguments: '' } }),
    tcDelta({ index: 0, id: null, type: 'function', function: { name: null, arguments: '{' } }),
    tcDelta({ index: 0, id: null, type: 'function', function: { name: null, arguments: '"command": "ls"}' } }),
    frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    '[DONE]',
  ]

  // 旧判据是 `!== undefined`，null 通不过它却被当成真值：既把 "bash" 冲成 null，
  // 又把 `name: null` 发进 StreamChunk。而真实运行路径
  // （dsh-llm 的 AssistantStreamAccumulator.push）判据是
  // `Object.hasOwn(chunk,'name') && typeof chunk.name !== 'string'` → 抛
  // `TypeError: tool-call-delta name must be a string`（用户看到的
  // 「本轮运行失败 tool-call-delta name must be a string」）。
  //
  // 用**真实的那个累加器**验收，而不是自己复述规则：它就是运行时会抛的那一段。
  const acc = new AssistantStreamAccumulator()
  let n = 0
  for await (const chunk of translateSse(payloads)) {
    acc.push({ time: n++, chunk }) // 这里就是线上抛错的那一步
  }

  // 逐条再按原判据过一遍，失败时能直接指向违规的那条 delta
  for await (const chunk of translateSse(payloads)) {
    if (chunk.type !== 'tool-call-delta') continue
    if (Object.hasOwn(chunk, 'name')) assert.equal(typeof chunk.name, 'string', 'name 一旦出现就必须是字符串')
    assert.equal(typeof chunk.id, 'string', 'id 必须是字符串')
    assert.equal(typeof chunk.argumentsDelta, 'string', 'argumentsDelta 必须是字符串')
  }

  // 首帧给的 name/id 必须在后续 null 帧里**保持**
  const deltas: Array<Record<string, unknown>> = []
  for await (const chunk of translateSse(payloads)) {
    if (chunk.type === 'tool-call-delta') deltas.push(chunk as unknown as Record<string, unknown>)
  }
  assert.ok(deltas.length >= 3, '三个分片帧都该产出 delta')
  for (const d of deltas) {
    assert.equal(d.name, 'bash', 'name 被后续 null 帧冲掉了（工具名会变成空）')
    assert.equal(d.id, 'call_abc', 'id 被后续 null 帧冲掉了')
  }

  // 收尾后的完整调用也要正确
  const calls = await toolCallsOf(...payloads)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.name, 'bash', '工具名必须保住')
  assert.equal(calls[0]?.arguments, '{"command": "ls"}')
})

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

test('工具调用：参数残缺时不产出可执行的调用（补发空收尾覆盖半成品）', async () => {
  // 真实故障形态：首片开块，[DONE] 就来了，参数停在 `{"command": "cd`
  const calls = await toolCallsOf(
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'bash', arguments: '{"command": "cd' } }] } }] }),
    '[DONE]',
  )
  // 注意：产出的是**占位收尾**（空名 + `{}`），不是「不产出」。
  // 只跳过 block-end 是拦不住的 —— BlockAssembler 会用累积 delta 重建出
  // 半成品（见下面那条 BlockAssembler 级别的用例）。必须主动覆盖。
  const dangerous = calls.filter((c) => {
    try { JSON.parse(c.arguments ?? ''); return false } catch { return true }
  })
  assert.equal(dangerous.length, 0, `不能产出参数残缺的调用：${JSON.stringify(calls)}`)
  assert.equal(calls[0]?.arguments, '{}', '残缺调用应被覆盖成空参数')
  assert.equal(calls[0]?.name, '', '名字也要清空，避免被当成真调用')
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

/* ---------------- wire 请求构造（对照 9router 查出的缺陷） ---------------- */

/**
 * 为什么要有这一组：dsh-router 是「从结构化 options 重建 wire body」，
 * 9router 是「客户端 body 原样透传」——前者的字段漏带不会报错，只会
 * 悄悄降级，所以必须逐条锁死。这几条都是对照 9router 查出来的。
 */

/** 拦下 stream() 发给上游的 body，返回解析后的对象。 */
async function captureBody(options: Record<string, unknown>): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> = {}
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    captured = JSON.parse(init?.body ?? '{}') as Record<string, unknown>
    return new Response('data: [DONE]\n\n', { status: 200 })
  }) as typeof fetch
  const adapter = new RouterAdapter('http://x', { comboModels: async () => [] })
  for await (const _c of adapter.stream({ model: 'm', messages: [], signal: AbortSignal.timeout(3000), ...options } as never)) {
    void _c
  }
  return captured
}

test('wire：options.system 必须发给上游（agent-loop 走 system 槽位，不放 messages）', async () => {
  // dsh-llm 契约：system 是**独立槽位**（types.d.ts "adapters map to the
  // provider's system slot"），agent-loop 把它放 options.system。不读它，
  // 模型每轮都拿不到身份/规则/工具用法约束，且不报错——最难查的一类。
  const body = await captureBody({ system: '你是一个助手', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
  const msgs = body.messages as Array<{ role: string; content: string }>
  assert.equal(msgs[0]?.role, 'system')
  assert.equal(msgs[0]?.content, '你是一个助手', 'system 必须是消息列表的第一条')
})

test('wire：没给 system 时不塞空的 system 消息', async () => {
  const body = await captureBody({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
  const msgs = body.messages as Array<{ role: string }>
  assert.equal(msgs.some((m) => m.role === 'system'), false)
})

test('wire：reasoningEffort 要补 reasoning_summary:auto（CodeBuddy 只在两者齐备时吐推理）', async () => {
  const body = await captureBody({ reasoningEffort: 'high', messages: [] })
  assert.equal(body.reasoning_effort, 'high')
  assert.equal(body.reasoning_summary, 'auto', '缺它 CodeBuddy 不吐推理内容')
})

test('wire：reasoningEffort 为 none/off 时删字段，且无请求时不硬加（否则触发内容过滤）', async () => {
  // 9router #2071：对普通请求强加 reasoning_effort+summary 会让 CodeBuddy
  // 触发内容过滤报错；"none" 网关不认，必须是删字段。
  const none = await captureBody({ reasoningEffort: 'none', messages: [] })
  assert.equal('reasoning_effort' in none, false, 'none 要删字段，不能传字符串')
  assert.equal('reasoning_summary' in none, false)
  const plain = await captureBody({ messages: [] })
  assert.equal('reasoning_effort' in plain, false, '没要推理就不能加')
})

test('wire：空工具结果发空串，不伪造 (no output) 字面量', async () => {
  // 模型会以为工具真打印了那句话 —— 对「bash 无输出」是误导。
  const body = await captureBody({
    messages: [{ role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [] }] }],
  })
  const tool = (body.messages as Array<{ role: string; content: string }>).find((m) => m.role === 'tool')
  assert.equal(tool?.content, '', '空结果就该是空串')
})

// 0.1.7+ 消息模型：tool 结果是**独立 role:"tool" 消息**、toolCallId 挂消息级，
// ContentBlockMap 已无 'tool-result' 块。必须原样发 role:"tool"，否则工具结果被
// 序列化成 role:"user"、夹在 assistant(tool_calls) 与 tool 之间，上游判定失配 → 400
// code=11148。下面几条锁死新分支；老的 'tool-result' 块路径（≤0.1.6）仍有各自的用例。
test('wire：0.1.7+ 独立 role:"tool" 消息序列化为 role:"tool"，正确带 tool_call_id', async () => {
  const body = await captureBody({
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: '' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'out' }] },
    ],
  })
  const messages = body.messages as Array<{ role: string; tool_call_id?: string; content: unknown }>
  const tool = messages.find((m) => m.role === 'tool')
  assert.ok(tool, '0.1.7 tool 消息必须原样发 role:"tool"')
  assert.equal(tool.tool_call_id, 'c1', 'tool_call_id 取自消息级 toolCallId')
  assert.equal(tool.content, 'out', '纯文本重组为字符串')
  assert.equal(messages.filter((m) => m.role === 'user').length, 0, '不容许被误序列化成 user 消息')
})

test('wire：0.1.7+ 独立 role:"tool" 消息不带图时不在其后插 user(图)', async () => {
  // 图片才攒批补 user(图)；纯文本 tool 后面绝不能冒出 user，配对接续必须完整。
  const body = await captureBody({
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: '' }, { type: 'tool-call', id: 'a', name: 'bash', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'a', content: [{ type: 'text', text: 'x' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ],
  })
  const messages = body.messages as Array<{ role: string }>
  // 没有任何位置允许 user 夹在 tool 与下一 assistant 之间。
  for (let i = 1; i < messages.length; i++) {
    const m = messages[i]
    assert.ok(m, `第 ${i} 条缺失`)
    assert.notEqual(m.role, 'user', `第 ${i} 条不应该是 user（tool 配对接续被插断）`)
  }
})

test('wire：0.1.7+ 空 tool 结果发空串（不伪造字面量）', async () => {
  const body = await captureBody({
    messages: [{ role: 'tool', toolCallId: 'c2', content: [] }],
  })
  const tool = (body.messages as Array<{ role: string; content: string }>).find((m) => m.role === 'tool')
  assert.equal(tool?.content, '', '空结果该是空串')
})

/**
 * tool 结果的两种形态**都必须序列化成 role:'tool'**，且分派只看消息形状、与宿主版本无关。
 *
 * 背景（实测）：同一宿主内两种形态都合法 —— 0.1.7 loop-built 走新形态
 * （独立 role:'tool' 消息），而老会话历史经 session-format 迁移/重放时仍是旧形态
 * （user 消息里的 'tool-result' 块）。所以 adapter 不能按版本号判形态对错，
 * 只能按形状分派；这条锁死两种形状在**同一份 adapter**下产物一致。
 */
test('wire：tool-result 新/旧两种形态都序列化为 role:"tool"（按形状分派，与版本无关）', async () => {
  const newShapeMsgs = [
    { role: 'assistant', content: [{ type: 'text', text: '' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'out' }] },
  ]
  const oldShapeMsgs = [
    { role: 'assistant', content: [{ type: 'text', text: '' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'out' }] }] },
  ]
  // 新形态：原样发 role:'tool'
  const n = await captureBody({ messages: newShapeMsgs })
  const nt = (n.messages as Array<{ role: string; tool_call_id?: string }>).find((m) => m.role === 'tool')
  assert.ok(nt, '新形态应发 role:"tool"')
  assert.equal(nt.tool_call_id, 'c1')
  // 旧形态：由 'tool-result' 块转出 role:'tool'（同样带 tool_call_id）
  const o = await captureBody({ messages: oldShapeMsgs })
  const ot = (o.messages as Array<{ role: string; tool_call_id?: string }>).find((m) => m.role === 'tool')
  assert.ok(ot, '旧形态也应转出 role:"tool"')
  assert.equal(ot.tool_call_id, 'c1')
})

/**
 * 为什么要有这一条：只不发 `block-end` **并不能**拦住残缺调用。
 *
 * dsh-llm 的 BlockAssembler 对没有 block-end 的 index 会用累积的 delta
 * **兜底重建**（lib/types/assembler.js）。实测：我们跳过了 block-end，
 * 它照样组装出 `{"type":"tool-call","name":"bash","arguments":"{\"command\": \"rm -rf /"}`。
 * 而 assembled() 只在 finish.kind === 'max-tokens' 时过滤 tool-call ——
 * EMPTY_RESPONSE 的 error finish 不在过滤之列。
 *
 * 所以要拦住，必须**主动补发一个安全的 block-end**（空名 + `{}`），
 * 让它覆盖掉 delta 累积出来的半成品。
 */
test('工具调用：残缺调用必须被 BlockAssembler 也判定为不可执行', async () => {
  const { BlockAssembler } = await import('@deepseek-ai/dsh-llm')
  const frames = [
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'bash', arguments: '{"command": "rm -rf /' } }] } }] }),
    '[DONE]',
  ]
  const asm = new BlockAssembler()
  for await (const c of translateSse(frames)) asm.push(c)
  const assembled = (asm as unknown as { assembled: () => { blocks: Array<Record<string, unknown>> } }).assembled()
  const blocks = assembled.blocks ?? []
  const dangerous = blocks.filter((b) => {
    if (b.type !== 'tool-call') return false
    const args = typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments)
    try { JSON.parse(args); return false } catch { return true } // 解析不了 = 半成品
  })
  assert.equal(dangerous.length, 0, `不能组装出参数残缺的调用：${JSON.stringify(blocks)}`)
})

test('流式：消费者提前退出必须 cancel 上游（releaseLock 不关 socket）', async () => {
  // releaseLock() 只解除 JS 侧 reader 绑定，不通知传输层 —— 上游那条连接
  // 会一直挂着。dsh-llm 在消费者提前退出时必走 iterator.return()，长会话
  // 下每条中断泄漏一个 fd。
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')) },
    cancel() { cancelled = true },
  })
  const { RouterAdapter: RA } = await import('./adapter.ts')
  globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch
  const adapter = new RA('http://x', { comboModels: async () => [] })
  for await (const _c of adapter.stream({ model: 'm', messages: [], signal: AbortSignal.timeout(3000) } as never)) {
    void _c
    break // 提前退出
  }
  await new Promise((r) => setTimeout(r, 50)) // 等 finally 里的 cancel 落地
  assert.equal(cancelled, true, '必须 cancel 上游，否则 socket 泄漏')
})

test('流式：单个坏帧跳过，不毁掉整轮（对齐 9router 的容错）', async () => {
  const enc = new TextEncoder()
  const sse = `data: {"choices":[{"delta":{"content":"good"}}]}\n\ndata: {broken json\n\ndata: [DONE]\n\n`
  globalThis.fetch = (async () => new Response(enc.encode(sse), { status: 200 })) as typeof fetch
  const { RouterAdapter: RA } = await import('./adapter.ts')
  const adapter = new RA('http://x', { comboModels: async () => [] })
  const texts: string[] = []
  for await (const c of adapter.stream({ model: 'm', messages: [], signal: AbortSignal.timeout(3000) } as never)) {
    if (c.type === 'text-delta') texts.push((c as { text: string }).text)
  }
  assert.equal(texts.join(''), 'good', '好帧必须保住，不能因为一个坏帧全废')
})

test('流式：只有坏帧时才按断流处理，且 code 可重试', async () => {
  const enc = new TextEncoder()
  globalThis.fetch = (async () => new Response(enc.encode('data: {broken\n\n'), { status: 200 })) as typeof fetch
  const { RouterAdapter: RA } = await import('./adapter.ts')
  const adapter = new RA('http://x', { comboModels: async () => [] })
  let code = ''
  try {
    for await (const _c of adapter.stream({ model: 'm', messages: [], signal: AbortSignal.timeout(3000) } as never)) void _c
  } catch (e) { code = (e as { code?: string }).code ?? '' }
  assert.ok(RETRYABLE_CODES.includes(code), `code ${JSON.stringify(code)} 必须可重试`)
})

test('流式：上游不发空行分隔时也要能分帧（前瞻完整 JSON）', async () => {
  // 部分上游/中间件只发 \n 不发 \n\n。两帧会被拼成 `{...}\n{...}` 而 parse
  // 失败。9router 逐行取天然没这问题，我们按空行分帧，就得补前瞻回退。
  const enc = new TextEncoder()
  const a = 'data: {"choices":[{"delta":{"content":"A"}}]}\n'
  const b = 'data: {"choices":[{"delta":{"content":"B"}}]}\n\ndata: [DONE]\n\n'
  globalThis.fetch = (async () => new Response(enc.encode(a + b), { status: 200 })) as typeof fetch
  const { RouterAdapter: RA } = await import('./adapter.ts')
  const adapter = new RA('http://x', { comboModels: async () => [] })
  const texts: string[] = []
  for await (const c of adapter.stream({ model: 'm', messages: [], signal: AbortSignal.timeout(3000) } as never)) {
    if (c.type === 'text-delta') texts.push((c as { text: string }).text)
  }
  assert.equal(texts.join(''), 'AB', '两帧都要收到')
})

test('模型目录：resolveModel 对每个组合声明推理等级（off/low/high/max，默认 high）', async () => {
  const adapter = new RouterAdapter('http://x', { comboModels: async () => [
    { id: 'c-a', name: '组合A' },
    { id: 'c-b' },
  ] })
  const a = await adapter.resolveModel('router', 'c-a')
  assert.equal(a.provider, 'router')
  assert.equal(a.id, 'c-a')
  assert.equal(a.name, '组合A')
  // 图文模态：必须声明含 image，否则 runtime/subagent 的模态门禁会抛
  // `MODEL_DOES_NOT_SUPPORT_IMAGES`（界面「当前模型不支持图片」）。
  assert.deepEqual(a.inputModalities, ['text', 'image'], 'adapter 必须声明 image 模态，否则图片被门禁拦截')
  assert.ok(a.reasoning, '组合应声明推理等级，DSH 才允许显式 effort')
  assert.deepEqual(a.reasoning!.efforts.map((e) => e.id), ['off', 'low', 'high', 'max'])
  assert.equal(a.reasoning!.defaultEffort, 'high', '默认 High：调用方不指定时物化为 high')
  // 无显示名时用模型 id 兜底，保证 name 非空（dsh-llm normalizeModelInfo 要求）
  const b = await adapter.resolveModel('router', 'c-b')
  assert.equal(b.name, 'c-b')
})

/**
 * 上下文窗口透传 —— dsh 的自动压缩靠 `resolveModel().context.contextWindow`
 * 算阈值（默认用到 80% 触发）。缺失时 dsh-compaction-basic 抛错并静默关闭
 * 自动压缩，上下文会一路涨到模型硬上限才炸。
 */
test('resolveModel 透传组合的 contextWindow（自动压缩才能算阈值）', async () => {
  const adapter = new RouterAdapter('http://x', { comboModels: async () => [
    { id: 'c-a', contextWindow: 1_000_000 },
    { id: 'c-b' }, // 没拿到窗口
  ] })
  const a = await adapter.resolveModel('router', 'c-a')
  assert.deepEqual(a.context, { contextWindow: 1_000_000 }, '有就报')

  const b = await adapter.resolveModel('router', 'c-b')
  assert.equal(b.context, undefined, '没拿到就不声明 context，绝不填一个假窗口')
})

/* ---------------- 图片序列化：图片必须真正到上游（不静默丢图） ---------------- */

/**
 * 假附件 store：**按宿主的方式校验请求目标**，返回指定 mediaType + bytes 的请求版本。
 *
 * 为什么必须校验：宿主 0.1.6 起把请求目标从 `ImageRequestPolicy`（maxPixels +
 * maxBytes）换成 `ImageRequestTarget`（width + height + maxBytes），字段不匹配就在
 * `validateTarget()` 抛错。之前这个假 store **两个参数都不看**（`async () => ({...})`），
 * 于是插件侧传错字段没有任何测试会发现 —— 生产里图片静默降级成占位文本，跨两个
 * 内测版本没人察觉（issue #8）。现在假 store 照宿主那样校验，字段写错会当场红。
 */
function fakeAttachments(mediaType = 'image/png', data = new TextEncoder().encode('<png-bytes>')): {
  readImageRequest: (
    ref: { attachmentId: string; mediaType: string; bytes: number; width: number; height: number },
    target: { width: number; height: number; maxBytes: number },
  ) => Promise<{ mediaType: string; data: Uint8Array }>
  /** 最近一次收到的请求目标，供断言检查。 */
  lastTarget?: { width: number; height: number; maxBytes: number }
} {
  // 用闭包记录而不是 `this`：对象字面量里的箭头函数拿不到宿主对象。
  // 显式标注类型，否则 `store.lastTarget = …` 会被推断出的窄类型挡下。
  const store: {
    readImageRequest: (
      ref: { attachmentId: string; mediaType: string; bytes: number; width: number; height: number },
      target: { width: number; height: number; maxBytes: number },
    ) => Promise<{ mediaType: string; data: Uint8Array }>
    lastTarget?: { width: number; height: number; maxBytes: number }
  } = {
    readImageRequest: async (_ref: unknown, target: { width: number; height: number; maxBytes: number }) => {
      // 与宿主 validateTarget **逐字同规则**：它查的是 width/height/maxBytes 这三个
      // 键**存在且为正整数**。注意不能写成「遍历传进来的键校验」——那样漏掉整个
      // 键（0.1.5 的 maxPixels）反而能过，闸门就成了摆设（实测：这么写时把实现改回
      // maxPixels，45 条测试全绿）。
      for (const key of ['width', 'height', 'maxBytes']) {
        const value = (target as unknown as Record<string, unknown>)[key]
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
          throw new Error(`Image request ${key} must be a positive integer.`)
        }
      }
      store.lastTarget = target
      return { mediaType, data }
    },
  }
  return store
}

/** 用给定 attachments 跑一次 stream()，返回上游收到的 body。 */
async function captureBodyWith(options: Record<string, unknown>, attachments?: unknown): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> = {}
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    captured = JSON.parse(init?.body ?? '{}') as Record<string, unknown>
    return new Response('data: [DONE]\n\n', { status: 200 })
  }) as typeof fetch
  const adapter = new RouterAdapter(
    'http://x',
    { comboModels: async () => [] },
    () => attachments as never,
  )
  for await (const _c of adapter.stream({ model: 'm', messages: [], signal: AbortSignal.timeout(3000), ...options } as never)) {
    void _c
  }
  return captured
}

/* ---------------- 请求目标：形状与像素预算（issue #8 的回归闸门） ---------------- */

test('目标：请求目标是 0.1.6+ 的 target 形状（width/height/maxBytes），没有 0.1.5 的 maxPixels', async () => {
  const attachments = fakeAttachments()
  await captureBodyWith({
    messages: [{ role: 'user', content: [
      { type: 'image', attachment: { attachmentId: 'sha256:aa', mediaType: 'image/png', bytes: 11, width: 1000, height: 338 } },
    ] }],
  }, attachments)
  const target = attachments.lastTarget
  assert.ok(target !== undefined, '必须真的调过 readImageRequest')
  assert.deepEqual(Object.keys(target).sort(), ['height', 'maxBytes', 'width'],
    '键就是宿主 validateTarget 查的那三个；多一个少一个都会被宿主拒')
  assert.equal('maxPixels' in (target as unknown as Record<string, unknown>), false,
    '0.1.5 时代的 maxPixels 不再被宿主接受，带上它等于没传 width/height')
})

test('目标：大图按 64e4 像素预算等比投影（不放大；小图原样）', async () => {
  const big = fakeAttachments()
  await captureBodyWith({
    messages: [{ role: 'user', content: [
      { type: 'image', attachment: { attachmentId: 'sha256:bb', mediaType: 'image/png', bytes: 11, width: 4000, height: 3000 } },
    ] }],
  }, big)
  const t = big.lastTarget
  assert.ok(t !== undefined)
  // 12MP 投影到 ~64e4 像素内，且不超过预算
  assert.ok(t.width * t.height <= 64e4, `投影后仍在预算内，实际 ${t.width}x${t.height}`)
  assert.ok(t.width < 4000 && t.height < 3000, '大图要缩')
  const small = fakeAttachments()
  await captureBodyWith({
    messages: [{ role: 'user', content: [
      { type: 'image', attachment: { attachmentId: 'sha256:cc', mediaType: 'image/png', bytes: 11, width: 4, height: 2 } },
    ] }],
  }, small)
  assert.deepEqual(small.lastTarget, { width: 4, height: 2, maxBytes: 1024 * 1024 }, '预算内的小图不放大')
})

test('降级留痕：读图失败会写一条 log，不再静默（issue #8 为什么能静默两个版本）', async () => {
  const lines: string[] = []
  const boom = {
    readImageRequest: async () => { throw new Error('Image request width must be a positive integer.') },
  }
  const adapter = new RouterAdapter(
    'http://x',
    { comboModels: async () => [] },
    () => boom as never,
    undefined,
    (msg) => lines.push(msg),
  )
  globalThis.fetch = (async () => new Response('data: [DONE]\n\n', { status: 200 })) as typeof fetch
  for await (const _c of adapter.stream({
    model: 'm',
    messages: [{ role: 'user', content: [
      { type: 'image', attachment: { attachmentId: 'sha256:dd', mediaType: 'image/png', bytes: 11, width: 4, height: 2 } },
    ] }],
    signal: AbortSignal.timeout(3000),
  } as never)) { void _c }
  assert.equal(lines.length, 1, '降级必须留一条痕，否则问题又会是「静默」')
  assert.match(lines[0] ?? '', /width must be a positive integer/, 'log 要带上真实原因')
})

test('wire：图片块被序列化成 OpenAI image_url base64 part（不再静默丢图）', async () => {
  const ref = {
    attachmentId: 'sha256:abcdef1234567890',
    mediaType: 'image/png',
    bytes: 11,
    width: 4,
    height: 2,
  }
  const body = await captureBodyWith({
    messages: [{ role: 'user', content: [
      { type: 'text', text: '看这张图' },
      { type: 'image', attachment: ref },
    ] }],
  }, fakeAttachments())
  const user = (body.messages as Array<{ role: string; content: unknown }>).find((m) => m.role === 'user')
  const parts = (user?.content ?? []) as Array<{ type: string; text?: string; image_url?: { url: string } }>
  assert.equal(parts.length, 2, 'text + image 两个 part')
  assert.equal(parts[0]?.type, 'text')
  assert.equal(parts[0]?.text, '看这张图')
  assert.equal(parts[1]?.type, 'image_url', '图片必须是 image_url part，不是占位文本')
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode('<png-bytes>')))
  assert.equal(parts[1]?.image_url?.url, `data:image/png;base64,${b64}`, 'data URI 必须是 base64 编码的真实字节')
})

test('wire：纯文本 user 消息仍是紧凑字符串（不回归 wire 形式）', async () => {
  const body = await captureBodyWith({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }, fakeAttachments())
  const user = (body.messages as Array<{ role: string; content: unknown }>).find((m) => m.role === 'user')
  assert.equal(user?.content, 'hi', '无图时必须保持字符串 content')
})

test('wire：无 attachments 时图片回退占位文本，绝不静默丢图', async () => {
  const ref = {
    attachmentId: 'sha256:abcdef1234567890',
    mediaType: 'image/png',
    bytes: 11,
    width: 4,
    height: 2,
  }
  const body = await captureBodyWith({
    messages: [{ role: 'user', content: [{ type: 'image', attachment: ref }] }],
  }, undefined)
  const user = (body.messages as Array<{ role: string; content: unknown }>).find((m) => m.role === 'user')
  // 读不到字节时 parts 只剩一个 text 占位 → 收成紧凑字符串（无图可发，别硬撑数组）
  const text = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content)
  assert.ok(text.includes('image omitted'), '读不到附件时必须给占位文本，图片不能无声消失')
  assert.ok(!text.includes('image_url'), '读不到字节时不能伪造图片 part')
})

test('wire：一步两个 read_image（每条一个 user 消息，同现场）→ tool 消息紧跟 assistant，图片合并到末尾', async () => {
  const ref = {
    attachmentId: 'sha256:abcdef1234567890',
    mediaType: 'image/png',
    bytes: 11,
    width: 4,
    height: 2,
  }
  // **关键**：harness 把每个 tool 结果放**各自的** user-role 消息里（现场就是
  // 两条独立消息）。这是第一版修复漏掉的形态——按消息各发一条 user(图) 会得到
  // `tool,user,tool,user`，上游照样 400/11148。必须跨消息攒图、发完整串再补一条。
  const body = await captureBodyWith({
    messages: [
      { role: 'user', content: [{ type: 'text', text: '读这两张图' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', id: 'c1', name: 'read_image', arguments: '{}' },
          { type: 'tool-call', id: 'c2', name: 'read_image', arguments: '{}' },
        ],
      },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'tree_assembly.png' }, { type: 'image', attachment: ref }] }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'tree_part.png' }, { type: 'image', attachment: ref }] }] },
    ],
  }, fakeAttachments())
  const messages = body.messages as Array<{ role: string; tool_call_id?: string; tool_calls?: Array<{ id: string }>; content: unknown }>
  assertToolPairingIntact(messages)

  // 两条 tool 消息必须**连续**紧跟 assistant，各自的文本标签留在自己的 tool 里
  const ai = messages.findIndex((m) => m.role === 'assistant')
  assert.deepEqual(messages.slice(ai + 1, ai + 3).map((m) => m.role), ['tool', 'tool'], '两条 tool 必须连续，中间不得插 user')
  assert.equal(messages[ai + 1]?.content, 'tree_assembly.png', '第一条 tool 带自己的标签')
  assert.equal(messages[ai + 2]?.content, 'tree_part.png', '第二条 tool 带自己的标签')

  // 图片合并到全部 tool 之后的那**一条** user 消息里（两张都在，不静默丢图）
  const userWithImage = messages.find((m) => m.role === 'user' && Array.isArray(m.content))
  assert.ok(userWithImage !== undefined, '带图内容必须序列化成 user 消息的 content 数组')
  const parts = userWithImage.content as Array<{ type: string; text?: string }>
  assert.equal(parts.filter((p) => p.type === 'image_url').length, 2, '两张图都要发出去')
  const lastTool = messages.map((m) => m.role).lastIndexOf('tool')
  const imageAt = messages.indexOf(userWithImage)
  assert.ok(imageAt > lastTool, `带图 user 消息必须排在全部 tool 消息之后（实际 tool 末位 ${lastTool}，图在 ${imageAt}）`)
  // 整段 wire 里 user(带图) 只出现一次：插两次就会把 tool 串切断
  const imageUsers = messages.filter((m) => m.role === 'user' && Array.isArray(m.content))
  assert.equal(imageUsers.length, 1, '带图 user 消息只能有一条（多条 = 切断了 tool 配对）')
})

/**
 * 为什么要有这一组：`read_image` 的结果是**带图的 tool-result**。适配器曾把
 * 图片和文本一起提成一条 `user` 消息、排在 `tool` 消息**之前**，于是 wire 里
 * 出现 `assistant(tool_calls) → user(image) → tool`。上游判定 tool_call 与
 * tool_result 失配，回 400 网关码 11148「tool calls and tool results do not
 * match」（实测直连复现，把 tool 提前即 200）。
 *
 * 后果被池策略放大：11148 当时归 `unknown` → 瞬时冷却 30s；组合 money 两条腿
 * 都用同一份历史，一条带图请求就把它俩同时冷掉，之后**连纯文本请求**也全灭
 * 503（用户看到的现象）。所以这条不变式必须在 wire 层锁死：
 * **assistant 的每个 tool_call 后面必须紧跟配套 tool 消息，中间不得插任何
 * 其它角色**。
 */

/** 断言 wire 里 tool_call / tool_result 严格配对且不被插队。 */
function assertToolPairingIntact(messages: Array<{ role: string; tool_call_id?: string; tool_calls?: Array<{ id: string }> }>): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m?.role !== 'assistant' || (m.tool_calls ?? []).length === 0) continue
    const wanted = new Set((m.tool_calls ?? []).map((c) => c.id))
    // 紧随其后的必须**连续**是配套 tool 消息，中途混入任何别的角色都算失配
    // （现场踩的就是 user(图) 插在两条 tool 之间，wire 成 tool,user,tool,user）
    let j = i + 1
    const satisfied = new Set<string>()
    while (j < messages.length && messages[j]?.role === 'tool') {
      const id = messages[j]?.tool_call_id ?? ''
      assert.ok(wanted.has(id), `第 ${j} 条 tool 消息的 tool_call_id ${JSON.stringify(id)} 不在上一条 assistant 的 tool_calls 里`)
      satisfied.add(id)
      j += 1
    }
    assert.equal(
      satisfied.size,
      wanted.size,
      `assistant 的 tool_calls 未被紧邻的 tool 消息配齐`
        + `（中间插了别的角色：${messages.slice(i + 1, j).map((x) => x.role).join(',') || '—'}）`,
    )
    for (const id of wanted) {
      assert.ok(satisfied.has(id), `tool_call ${id} 没有配套 tool 消息（上游会回 11148）`)
    }
  }
}

test('wire：纯文本 tool-result 不因图片逻辑改变顺序（tool 紧跟 assistant）', async () => {
  const body = await captureBodyWith({
    messages: [
      { role: 'user', content: [{ type: 'text', text: '跑一下' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'out' }] }] },
    ],
  }, fakeAttachments())
  const messages = body.messages as Array<{ role: string; tool_call_id?: string; tool_calls?: Array<{ id: string }> }>
  assertToolPairingIntact(messages)
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool'], '纯文本 tool 结果仍紧跟 assistant')
})

/* ---------------- 流空闲超时：上游停摆不能永久挂住（issue #6） ---------------- */

/**
 * 为什么要有这一组：同一个 dsh-router `/v1`，走**自定义供应商**（llm-pi-ai 的
 * openai-completions adapter）时有 `idleWatchdog`（默认 300s）兜底，走**内置
 * Router adapter** 时此前没有任何超时 —— 上游连上后一停摆就永久挂着，连接和
 * in-flight 请求都收不回。这是 issue #6「内置 vs 自定义」差异的一半。
 *
 * **必须用真实 http server**：合成 `ReadableStream` 上 `AbortSignal` 是无效的
 * （实测合成流 + AbortSignal.timeout 永不收尾），拿它测只能得到假结论。
 */
test('流空闲超时：上游停摆 → adapter 自己中止（不依赖调用方给 signal）', async () => {
  const http = await import('node:http')
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.flushHeaders()          // 一个字节都不吐，也不结束
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  globalThis.fetch = realFetch   // 本文件前面的用例会留桩，必须装回真 fetch
  try {
    // 用可注入的短超时（默认 300s，测起来太慢）；不注入就退回生产值。
    const adapter = new RouterAdapter(base, { comboModels: async () => [] }, undefined, 400)
    const started = Date.now()
    const consume = (async () => {
      for await (const _c of adapter.stream({ model: 'm', messages: [] } as never)) void _c
    })()
    const outcome = await Promise.race([
      consume.then(() => 'ended', (e: Error) => `threw:${(e as Error & { code?: string }).code ?? e.message}`),
      new Promise<string>((r) => setTimeout(() => r('HANG'), 4000)),
    ])
    const ms = Date.now() - started
    console.log(`[gate] 无调用方 signal，停摆 → ${outcome} @${ms}ms`)
    assert.notEqual(outcome, 'HANG', 'adapter 必须自带空闲超时，不能永久挂住')
    assert.ok(String(outcome).includes('TIMEOUT'), `应抛 TIMEOUT（可重试码），实际 ${outcome}`)
  } finally {
    server.closeAllConnections?.()
    server.close()
  }
})

test('调用方取消必须能贯穿整条流（响应头到手后仍可中断，不永久挂住）', async () => {
  // 用**真实 http server**：合成 ReadableStream 会给出假象（abort 对非 undici 流
  // 无效）。这里上游发出响应头 + 一块数据后停摆，调用方给 1s 超时。
  // 修复前：adapter 在 fetch 返回时就 removeEventListener，body 读无人打断 →
  // 请求永久挂住（实测 6s 仍未收尾）。修复后：1s 左右被中止。
  const http = await import('node:http')
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')
    res.flushHeaders()          // 之后停摆：不吐数据也不结束
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  globalThis.fetch = realFetch   // 同上：必须先装回真 fetch
  try {
    const adapter = new RouterAdapter(base, { comboModels: async () => [] })
    const t0 = Date.now()
    const consume = (async () => {
      for await (const _c of adapter.stream({ model: 'm', messages: [], signal: AbortSignal.timeout(1000) } as never)) void _c
    })()
    const outcome = await Promise.race([
      consume.then(() => 'ended', (e: Error) => `threw:${e.message}`),
      new Promise((r) => setTimeout(() => r('HANG'), 5000)),
    ])
    const ms = Date.now() - t0
    console.log(`[gate] 停摆 + 1s 超时 → ${outcome} @${ms}ms`)
    assert.notEqual(outcome, 'HANG', '调用方取消后必须收尾，不能永久挂住')
    assert.ok(ms < 4000, `应在调用方超时附近收尾（实际 ${ms}ms）`)
  } finally {
    server.closeAllConnections?.()
    server.close()
  }
})
