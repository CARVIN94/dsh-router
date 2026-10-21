/**
 * 协议矩阵的往返测试 —— 「四种协议双向互转」这件事的判据。
 *
 * 只测**能判定**的东西：给定一段真实形状的输入，翻译出来的东西必须能被
 * 反方向翻译回去、且关键语义不丢。不测「看起来对不对」。
 *
 * 每种协议两组：
 *   1. 请求侧往返：协议 A 的请求 → 规范 → 协议 A，关键字段必须原样回来
 *   2. 响应侧往返：协议 A 的响应帧 → 规范事件 → 协议 A 的帧，内容必须可读回
 *
 * 外加一条**跨协议**的：Anthropic 请求经规范转成 Gemini 请求，再转回
 * Anthropic —— 这是 4×3 路径里最有价值的那条（Claude Code → Gemini 上游）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { codecOf } from './index.ts'
import { PROTOCOL_IDS, type ChatEvent, type JsonObject } from './types.ts'
import { StreamState, translateStream } from './stream.ts'

/* ------------------------------------------------------------------ */
/* 工具                                                               */
/* ------------------------------------------------------------------ */

/** 把事件列表里的文本拼起来。 */
function textOf(events: ChatEvent[]): string {
  return events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')
}

/** 把事件列表里的工具调用拼成 [{name, args}]。 */
function toolsOf(events: ChatEvent[]): Array<{ name: string; args: string }> {
  const calls = new Map<number, { name: string; args: string }>()
  for (const e of events) {
    if (e.type === 'tool-start') calls.set(e.index, { name: e.name ?? '', args: '' })
    if (e.type === 'tool-args') {
      const c = calls.get(e.index) ?? { name: '', args: '' }
      c.args += e.delta
      calls.set(e.index, c)
    }
  }
  return [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c)
}

function usageOf(events: ChatEvent[]): { promptTokens: number; completionTokens: number } | undefined {
  const u = events.find((e) => e.type === 'usage')
  return u === undefined || u.type !== 'usage' ? undefined : { promptTokens: u.promptTokens, completionTokens: u.completionTokens }
}

function finishOf(events: ChatEvent[]): string | undefined {
  const f = events.find((e) => e.type === 'finish')
  return f === undefined || f.type !== 'finish' ? undefined : f.reason
}

/** 造一个规范的 Chat 请求体。 */
function chatRequest(over: JsonObject = {}): JsonObject {
  return {
    model: 'test-model',
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{"p":"/tmp"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'a.txt' },
    ],
    tools: [{ type: 'function', function: { name: 'ls', description: 'list', parameters: { type: 'object', properties: { p: { type: 'string' } } } } }],
    max_tokens: 100,
    ...over,
  }
}

/** 造一个 `stream:true` 的版本（协议模块据此决定输出形态）。 */
function streaming(body: JsonObject): JsonObject {
  return { ...body, stream: true }
}

const CTX = { model: 'test-model', stream: true }

/* ------------------------------------------------------------------ */
/* 1. 请求侧：每个协议 → 规范 → 自己，关键语义不丢                    */
/* ------------------------------------------------------------------ */

test('chat 请求：恒等（toChat 不改任何字段）', () => {
  const body = chatRequest()
  const codec = codecOf('chat')
  assert.deepEqual(codec.toChat(body, CTX), body)
  assert.deepEqual(codec.fromChat(body, CTX), body)
})

test('anthropic 请求往返：system / tools / tool_use / tool_result 都不丢', () => {
  const codec = codecOf('anthropic')
  // 规范的 Chat 请求 → Anthropic → 规范
  const anth = codec.fromChat(chatRequest(), CTX)
  // system 被提到顶层，不再占 messages[0]
  assert.equal(anth.system, 'be brief')
  const msgs = anth.messages as JsonObject[]
  assert.equal(msgs.length, 3, 'user / assistant(tool_use) / user(tool_result)')
  // 工具声明：input_schema 而非 parameters
  const tools = anth.tools as JsonObject[]
  assert.equal(tools[0]?.name, 'ls')
  assert.ok((tools[0]?.input_schema as JsonObject)?.properties !== undefined)

  // 再翻回规范：内容与工具调用必须回来
  const back = codec.toChat(anth, CTX)
  const backMsgs = back.messages as JsonObject[]
  assert.equal(backMsgs[0]?.role, 'system')
  assert.equal(backMsgs[0]?.content, 'be brief')
  assert.equal(backMsgs[1]?.content, 'hello')
  const assistant = backMsgs.find((m) => m.role === 'assistant')
  assert.equal((assistant?.tool_calls as JsonObject[])?.[0]?.function && ((assistant?.tool_calls as JsonObject[])[0]!.function as JsonObject).name, 'ls')
  const toolMsg = backMsgs.find((m) => m.role === 'tool')
  assert.equal(toolMsg?.content, 'a.txt')
})

test('anthropic 请求往返：纯文本 user 消息保持字符串形态（不为它造块）', () => {
  const codec = codecOf('anthropic')
  const back = codec.toChat({ messages: [{ role: 'user', content: 'hi' }] }, CTX)
  assert.deepEqual((back.messages as JsonObject[])[0], { role: 'user', content: 'hi' })
})

test('responses 请求往返：instructions / 扁平 tools / max_output_tokens', () => {
  const codec = codecOf('responses')
  const resp = codec.fromChat(chatRequest(), CTX)
  assert.equal(resp.instructions, 'be brief')
  assert.equal(resp.max_output_tokens, 100)
  const tools = resp.tools as JsonObject[]
  assert.equal(tools[0]?.type, 'function')
  assert.equal(tools[0]?.name, 'ls', 'Responses 的 tools 是扁平形态，没有 function 包装')

  const back = codec.toChat(resp, CTX)
  const backTools = back.tools as JsonObject[]
  assert.equal((backTools[0]?.function as JsonObject).name, 'ls', '翻回来必须还原 function 包装')
  assert.equal(back.max_tokens, 100)
})

test('gemini 请求往返：role=model / parts / functionDeclarations', () => {
  const codec = codecOf('gemini')
  const gem = codec.fromChat(chatRequest(), CTX)
  assert.deepEqual((gem.systemInstruction as JsonObject).parts, [{ text: 'be brief' }])
  const contents = gem.contents as JsonObject[]
  // user / model(tool call) / user(functionResponse)
  assert.equal(contents[0]?.role, 'user')
  assert.equal(contents[1]?.role, 'model', 'Gemini 的 assistant 叫 model')
  const decls = (gem.tools as JsonObject[])[0]?.functionDeclarations as JsonObject[]
  assert.equal(decls[0]?.name, 'ls')

  const back = codec.toChat(gem, CTX)
  const backMsgs = back.messages as JsonObject[]
  assert.equal(backMsgs[0]?.role, 'system')
  const assistant = backMsgs.find((m) => m.role === 'assistant')
  assert.equal(((assistant?.tool_calls as JsonObject[])?.[0]?.function as JsonObject).name, 'ls')
})

/* ------------------------------------------------------------------ */
/* 2. 跨协议：Anthropic 请求 → Gemini 上游（4×3 里最有价值的那条）     */
/* ------------------------------------------------------------------ */

test('★ 跨协议：Anthropic 请求 → 规范 → Gemini 请求，语义可读', () => {
  const anthReq = {
    model: 'm',
    system: 'be brief',
    max_tokens: 100,
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'ls', input: { p: '/' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ],
  }
  const canonical = codecOf('anthropic').toChat(anthReq, CTX)
  const gem = codecOf('gemini').fromChat(canonical, CTX)
  const contents = gem.contents as JsonObject[]
  assert.deepEqual((gem.systemInstruction as JsonObject).parts, [{ text: 'be brief' }])
  assert.equal(contents[0]?.role, 'user')
  assert.equal(contents[1]?.role, 'model')
  const parts = contents[1]?.parts as JsonObject[]
  assert.equal((parts[0]?.functionCall as JsonObject).name, 'ls')
  // 工具结果回到 user 侧、形态是 functionResponse
  assert.equal(contents[2]?.role, 'user')
  assert.ok(((contents[2]?.parts as JsonObject[])[0]?.functionResponse as JsonObject) !== undefined)
})

/* ------------------------------------------------------------------ */
/* 3. 响应侧：每个协议的事件 → 规范 → 自己的帧，内容可读回            */
/* ------------------------------------------------------------------ */

/**
 * 把规范事件编成某协议的帧、再解回来。
 *
 * 必须带上 `startFrames` / `endFrames`：Responses 的收尾原因与用量**只**存在
 * 于 `response.completed`（由 endFrames 发），漏了它往返就一定丢 finish。
 */
function roundTripEvents(protocol: (typeof PROTOCOL_IDS)[number], events: ChatEvent[]): ChatEvent[] {
  const codec = codecOf(protocol)
  const finishEv = events.find((e) => e.type === 'finish')
  const usageEv = events.find((e) => e.type === 'usage')
  const boundaryCtx = {
    model: 'm',
    stream: true,
    finish: finishEv?.type === 'finish' ? finishEv.reason : 'stop',
    usage: usageEv?.type === 'usage'
      ? { promptTokens: usageEv.promptTokens, completionTokens: usageEv.completionTokens, cachedTokens: usageEv.cachedTokens }
      : undefined,
  }
  // 一条流 = 一个会话：Gemini 的工具名↔index 映射跨帧存在这里
  const session = codec.createSession?.()
  const frames = [
    ...codec.startFrames(boundaryCtx),
    ...events.flatMap((e) => codec.encodeFrame(e, session)),
    ...codec.endFrames(boundaryCtx),
  ]
  const back: ChatEvent[] = []
  for (const frame of frames) {
    // 每帧自带 event: 行（Anthropic/Responses），要拆出来喂给 decodeFrame
    const m = /^event: (.+)\ndata: ([\s\S]*)\n\n$/.exec(frame)
    if (m === null) {
      const d = /^data: ([\s\S]*)\n\n$/.exec(frame)
      if (d !== null && d[1] !== '[DONE]') back.push(...codec.decodeFrame(d[1]!))
      continue
    }
    if (m[2] === '[DONE]') continue
    back.push(...codec.decodeFrame(m[2]!, m[1], session))
  }
  return back
}

test('chat 响应帧往返：text / tool / usage / finish', () => {
  const events: ChatEvent[] = [
    { type: 'text', text: 'hi ' },
    { type: 'text', text: 'there' },
    { type: 'tool-start', index: 0, id: 'c1', name: 'ls' },
    { type: 'tool-args', index: 0, delta: '{"p":' },
    { type: 'tool-args', index: 0, delta: '"/"}' },
    { type: 'usage', promptTokens: 10, completionTokens: 5, cachedTokens: 0 },
    { type: 'finish', reason: 'tool-calls' },
  ]
  const back = roundTripEvents('chat', events)
  assert.equal(textOf(back), 'hi there')
  assert.deepEqual(toolsOf(back), [{ name: 'ls', args: '{"p":"/"}' }])
  assert.deepEqual(usageOf(back), { promptTokens: 10, completionTokens: 5 })
  assert.equal(finishOf(back), 'tool-calls')
})

test('anthropic 响应帧往返：text / thinking / tool_use / finish', () => {
  const events: ChatEvent[] = [
    { type: 'reasoning', text: 'think' },
    { type: 'text', text: 'answer' },
    { type: 'tool-start', index: 0, id: 'tu1', name: 'ls' },
    { type: 'tool-args', index: 0, delta: '{"p":"/"}' },
    { type: 'usage', promptTokens: 7, completionTokens: 3, cachedTokens: 0 },
    { type: 'finish', reason: 'tool-calls' },
  ]
  const back = roundTripEvents('anthropic', events)
  assert.equal(textOf(back), 'answer')
  assert.equal(back.filter((e) => e.type === 'reasoning').length, 1)
  assert.deepEqual(toolsOf(back), [{ name: 'ls', args: '{"p":"/"}' }])
  assert.equal(finishOf(back), 'tool-calls', 'tool_use → tool-calls')
})

test('responses 响应帧往返：text / tool / finish', () => {
  const events: ChatEvent[] = [
    { type: 'text', text: 'hi' },
    { type: 'tool-start', index: 0, id: 'fc1', name: 'ls' },
    { type: 'tool-args', index: 0, delta: '{"p":"/"}' },
    { type: 'usage', promptTokens: 4, completionTokens: 2, cachedTokens: 0 },
    { type: 'finish', reason: 'stop' },
  ]
  const back = roundTripEvents('responses', events)
  assert.equal(textOf(back), 'hi')
  assert.deepEqual(toolsOf(back), [{ name: 'ls', args: '{"p":"/"}' }])
  assert.equal(finishOf(back), 'stop')
})

test('gemini 响应帧往返：text / functionCall / usage / finish', () => {
  const events: ChatEvent[] = [
    { type: 'text', text: 'hi' },
    { type: 'tool-start', index: 0, name: 'ls' },
    { type: 'tool-args', index: 0, delta: '{"p":"/"}' },
    { type: 'usage', promptTokens: 6, completionTokens: 2, cachedTokens: 0 },
    { type: 'finish', reason: 'length' },
  ]
  const back = roundTripEvents('gemini', events)
  assert.equal(textOf(back), 'hi')
  assert.deepEqual(toolsOf(back), [{ name: 'ls', args: '{"p":"/"}' }])
  assert.equal(finishOf(back), 'length', 'MAX_TOKENS → length')
})

/* ------------------------------------------------------------------ */
/* 4. 非流式往返                                                      */
/* ------------------------------------------------------------------ */

test('★ 非流式往返：每种协议 encodeJson → decodeJson，文本与工具不丢', () => {
  const events: ChatEvent[] = [
    { type: 'text', text: 'answer' },
    { type: 'tool-start', index: 0, id: 'c1', name: 'ls' },
    { type: 'tool-args', index: 0, delta: '{"p":"/"}' },
    { type: 'usage', promptTokens: 9, completionTokens: 4, cachedTokens: 0 },
    { type: 'finish', reason: 'tool-calls' },
  ]
  for (const protocol of PROTOCOL_IDS) {
    const codec = codecOf(protocol)
    const body = codec.encodeJson(events, { model: 'm', stream: false })
    const back = codec.decodeJson(body)
    assert.equal(textOf(back), 'answer', `${protocol}: 文本丢失`)
    assert.deepEqual(toolsOf(back), [{ name: 'ls', args: '{"p":"/"}' }], `${protocol}: 工具调用丢失`)
    assert.deepEqual(usageOf(back), { promptTokens: 9, completionTokens: 4 }, `${protocol}: 用量丢失`)
  }
})

/* ------------------------------------------------------------------ */
/* 5. 流式管道：字节进、字节出，且流能正常结束                        */
/* ------------------------------------------------------------------ */

test('★ 流式转码：chat 帧 → anthropic 帧，逐帧透传且收尾正确', async () => {
  // 上游给 OpenAI SSE（含分帧边界被切断的情形）
  const upstreamText =
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":" there"}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
    'data: [DONE]\n\n'
  // 故意在中间切断，验证跨 chunk 缓冲
  const bytes = new TextEncoder().encode(upstreamText)
  const cut = Math.floor(bytes.length / 2)
  const upstream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(bytes.slice(0, cut))
      ctrl.enqueue(bytes.slice(cut))
      ctrl.close()
    },
  })
  const out = translateStream(upstream, new StreamState('chat', 'anthropic'))
  const text = await new Response(out).text()
  // Anthropic 的帧：message_start → content_block_delta(text_delta) → message_delta/message_stop
  assert.ok(text.includes('event: message_start'), '缺 message_start')
  assert.ok(text.includes('"text_delta"'), '缺 text_delta')
  assert.ok(text.includes('hi'), '缺内容 hi')
  assert.ok(text.includes(' there'), '缺内容 there')
  assert.ok(text.includes('event: message_stop'), '缺 message_stop')
  assert.ok(text.includes('end_turn'), '缺 stop_reason')
})

test('★ 流式转码：上游一个字节都不给，仍产出协议合法的空流', async () => {
  const upstream = new ReadableStream<Uint8Array>({
    start(ctrl) { ctrl.close() },
  })
  const out = translateStream(upstream, new StreamState('chat', 'anthropic'))
  const text = await new Response(out).text()
  // 至少要有 message_start，否则 Claude Code 会报「流格式错误」而不是「上游没答」
  assert.ok(text.includes('event: message_start'), '空流也要给 message_start')
  assert.ok(text.includes('event: message_stop'), '空流也要收尾')
})

/* ------------------------------------------------------------------ */
/* 6. 逆序：供应商说 Anthropic，客户端说 chat                          */
/* ------------------------------------------------------------------ */

test('★ 出站：Anthropic 上游的帧 → chat 客户端可读', async () => {
  const upstreamText =
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":0}}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  const upstream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(new TextEncoder().encode(upstreamText))
      ctrl.close()
    },
  })
  const out = translateStream(upstream, new StreamState('anthropic', 'chat'))
  const text = await new Response(out).text()
  // chat 客户端看到的是 OpenAI SSE
  assert.ok(text.includes('"content":"hello"'), '文本没翻出来')
  assert.ok(text.includes('[DONE]'), '缺终止帧')
  // usage：input 11 来自 message_start、output 5 来自 message_delta —— 必须都保住
  const frames = text.split('\n').filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]')
  const usageFrame = frames.map((l) => JSON.parse(l.slice(6)) as JsonObject).find((o) => o.usage !== undefined)
  assert.ok(usageFrame !== undefined, '缺 usage 帧')
  const usage = usageFrame.usage as JsonObject
  assert.equal(usage.prompt_tokens, 11, '输入用量丢了（message_start 那帧）')
  assert.equal(usage.completion_tokens, 5, '输出用量丢了（message_delta 那帧）')
})

/* ------------------------------------------------------------------ */
/* 7. 坏输入不抛异常（上游半截 JSON 是常态）                          */
/* ------------------------------------------------------------------ */

test('坏帧不抛：半截 JSON / 空帧 / 未知事件一律返回空数组', () => {
  for (const protocol of PROTOCOL_IDS) {
    const codec = codecOf(protocol)
    assert.deepEqual(codec.decodeFrame('{"half":'), [], `${protocol}: 半截 JSON 不该抛`)
    assert.deepEqual(codec.decodeFrame('{}'), [], `${protocol}: 空对象不该抛`)
    assert.deepEqual(codec.decodeFrame('not json at all'), [], `${protocol}: 纯文本不该抛`)
  }
})

test('每种协议都有 startFrames 与 endFrames（形状完整）', () => {
  for (const protocol of PROTOCOL_IDS) {
    const codec = codecOf(protocol)
    const start = codec.startFrames({ model: 'm', stream: true })
    const end = codec.endFrames({ model: 'm', stream: true })
    assert.ok(Array.isArray(start), `${protocol}: startFrames 必须是数组`)
    assert.ok(Array.isArray(end), `${protocol}: endFrames 必须是数组`)
    // chat 与 gemini 没有额外的开始/结束帧：
    //   - chat：[DONE] 由 finish 带，OpenAI SSE 没有信封事件
    //   - gemini：SSE 帧就是裸 `data:`，没有 message_start 这类信封
    // Anthropic（message_start/message_stop）与 Responses
    // （response.created/response.completed）必须有 —— 那两个客户端严格等它们。
    if (protocol === 'chat' || protocol === 'gemini') {
      assert.equal(start.length, 0)
      assert.equal(end.length, 0)
    } else {
      assert.ok(start.length > 0, `${protocol}: 流式必须有开始帧（客户端严格等）`)
      assert.ok(end.length > 0, `${protocol}: 流式必须有收尾帧（否则客户端报流被截断）`)
    }
  }
})

/* ------------------------------------------------------------------ */
/* 8. 回归：本会话修掉的四个真 bug                                    */
/* ------------------------------------------------------------------ */

test('★ 回归：Chat 的 tools 带 function 包装，跨到各协议后工具不能被丢掉', () => {
  // 事故：chatToolToAnthropic / chatToolToResponses 直接读 tool.name，
  // 而 Chat 具名工具是 {type:'function', function:{name,...}} —— 于是全丢。
  for (const protocol of ['anthropic', 'responses', 'gemini'] as const) {
    const out = codecOf(protocol).fromChat(chatRequest(), CTX)
    const names = JSON.stringify(out)
    assert.ok(names.includes('"ls"'), `${protocol}: 工具声明丢失`)
  }
})

test('★ 回归：Gemini 的 tool-args 必须继承 tool-start 给的名字', () => {
  // 事故：tool-args 只有 index 没有 name，映射丢了就会发出 name:'' 的
  // functionCall —— 客户端多认出一个空名工具。
  const codec = codecOf('gemini')
  const session = codec.createSession?.()
  assert.deepEqual(codec.encodeFrame({ type: 'tool-args', index: 0, delta: '{"p":"/"}' }, session), [], '没有 tool-start 时不该凭空发 functionCall')
  const started = codec.encodeFrame({ type: 'tool-start', index: 0, name: 'ls' }, session)
  assert.ok(started.join('').includes('"ls"'))
  const args = codec.encodeFrame({ type: 'tool-args', index: 0, delta: '{"p":"/"}' }, session)
  assert.ok(args.join('').includes('"ls"'), '参数帧丢了工具名')
})

test('★ 回归：两条并发流的工具名映射不串（会话隔离）', () => {
  const codec = codecOf('gemini')
  const a = codec.createSession?.()
  const b = codec.createSession?.()
  codec.encodeFrame({ type: 'tool-start', index: 0, name: 'read' }, a)
  codec.encodeFrame({ type: 'tool-start', index: 0, name: 'write' }, b)
  // 同名 index、不同会话，各说各的名字
  assert.ok(codec.encodeFrame({ type: 'tool-args', index: 0, delta: '{}' }, a).join('').includes('"read"'))
  assert.ok(codec.encodeFrame({ type: 'tool-args', index: 0, delta: '{}' }, b).join('').includes('"write"'))
})

test('★ 回归：Responses 收尾帧必须带 status 与 usage（Codex 靠它判结束）', () => {
  const codec = codecOf('responses')
  const end = codec.endFrames({
    model: 'm',
    stream: true,
    finish: 'stop',
    usage: { promptTokens: 11, completionTokens: 5, cachedTokens: 0 },
  }).join('')
  assert.ok(end.includes('response.completed'), '缺 response.completed')
  assert.ok(end.includes('"status":"completed"'))
  assert.ok(end.includes('"input_tokens":11'), '输入用量丢了')
  assert.ok(end.includes('"output_tokens":5'), '输出用量丢了')

  // 截断 → incomplete
  const cut = codec.endFrames({ model: 'm', stream: true, finish: 'length' }).join('')
  assert.ok(cut.includes('"status":"incomplete"'), '截断必须是 incomplete')

  // 工具轮 → output 里要有 function_call，否则往返后认不出 tool-calls
  const tool = codec.endFrames({ model: 'm', stream: true, finish: 'tool-calls' }).join('')
  assert.ok(tool.includes('function_call'), '工具轮的 output 缺 function_call')
})

test('★ 回归：Anthropic 流尾只有一个 message_stop（finish 与 endFrames 不重复）', () => {
  const codec = codecOf('anthropic')
  const frames = [
    ...codec.encodeFrame({ type: 'finish', reason: 'stop' }),
    ...codec.endFrames({ model: 'm', stream: true }),
  ].join('')
  const stops = frames.split('event: message_stop').length - 1
  assert.equal(stops, 1, `message_stop 出现 ${stops} 次`)
})

test('★ 回归：Anthropic content_block_start(tool_use) 要还原 tool-start 的名字', () => {
  const codec = codecOf('anthropic')
  const evs = codec.decodeFrame(
    JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'ls', input: {} } }),
    'content_block_start',
  )
  assert.deepEqual(toolsOf(evs), [{ name: 'ls', args: '' }], 'tool_use 的名字丢了')
})

test('★ 回归：上游 message_delta 不带 usage 时不能补一个全 0 的 usage', () => {
  const codec = codecOf('anthropic')
  const evs = codec.decodeFrame(
    JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
    'message_delta',
  )
  assert.equal(evs.filter((e) => e.type === 'usage').length, 0, '不该凭空造全 0 usage')
})

test('★ 回归：出站非流式 —— 解码 Chat 形态、编码成客户端协议（方向不能反）', async () => {
  // 事故：finishJson 用客户端 codec 解 Chat JSON，`choices` 字段解不出来，
  // 客户端拿到一个 content 为空、却状态 200 的回复（最糟的一类 bug：静默）。
  const { outboundSink } = await import('./entry.ts')
  interface Fake { chunks: string[]; body: string }
  const makeRes = (): Fake & Record<string, unknown> => {
    const chunks: string[] = []
    return {
      chunks,
      get body() { return chunks.join('') },
      writeHead() { return this },
      flushHeaders() {},
      write(b: Uint8Array | string) { chunks.push(typeof b === 'string' ? b : new TextDecoder().decode(b)); return true },
      end(b?: Uint8Array | string) {
        if (b !== undefined) chunks.push(typeof b === 'string' ? b : new TextDecoder().decode(b))
      },
      on() { return this }, once() { return this }, removeListener() {}, destroy() {},
    }
  }
  const upstream = JSON.stringify({
    choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  })
  for (const protocol of ['anthropic', 'responses', 'gemini', 'chat'] as const) {
    const res = makeRes()
    const sink = outboundSink(protocol, 'm', res as never)
    sink.head?.(200, { 'content-type': 'application/json' })
    sink.write(new TextEncoder().encode(upstream))
    sink.end()
    assert.ok(res.body.includes('answer'), `${protocol}: 非流式内容丢了（方向反了？）`)
  }
})

test('★ 回归：出站按 content-type 判流/JSON，不靠内容猜', async () => {
  const { outboundSink } = await import('./entry.ts')
  const chunks: string[] = []
  const res: Record<string, unknown> = {
    writeHead() { return this }, flushHeaders() {},
    write(b: Uint8Array | string) { chunks.push(typeof b === 'string' ? b : new TextDecoder().decode(b)); return true },
    end(b?: Uint8Array | string) { if (b !== undefined) chunks.push(typeof b === 'string' ? b : new TextDecoder().decode(b)) },
    on() { return this }, once() { return this }, removeListener() {}, destroy() {},
  }
  const sink = outboundSink('anthropic', 'm', res as never)
  sink.head?.(200, { 'content-type': 'application/json' })
  // 内容里带 "data:" —— 旧实现会把它当 SSE 喂给翻译器，然后吐空流
  sink.write(new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: 'data: not sse' } }] })))
  sink.end()
  const body = chunks.join('')
  assert.ok(!body.includes('event: message_start'), '被误判成 SSE 了')
  assert.ok(body.includes('data: not sse'), '内容丢了')
})

test('★ 回归：Gemini 路径带 ?alt=sse（CLI 默认）时模型名解析得出来', async () => {
  const { geminiModelFromPath } = await import('./entry.ts')
  assert.equal(geminiModelFromPath('/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse'), 'gemini-2.5-pro')
  assert.equal(geminiModelFromPath('/v1beta/models/gemini-2.5-pro:generateContent'), 'gemini-2.5-pro')
  // 模型名可含斜杠（`models/` 前缀是 Gemini 的合法写法）
  assert.equal(geminiModelFromPath('/v1beta/models/models/gemini-pro:generateContent'), 'models/gemini-pro')
})
