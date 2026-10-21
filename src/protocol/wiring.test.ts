/**
 * 协议接线的**接线事实**判据 —— 守「四种协议真的挂上去了」这件事。
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么需要这一组（而不是只测编解码器）
 * ════════════════════════════════════════════════════════════════════
 * 编解码器全绿、端点却是 404/405 —— 这是 2026-10-21 真实发生的状态：
 *   - `/v1beta/models/` 的 prefix 带了尾斜杠，宿主匹配规则是
 *     `pathname.startsWith(prefix + '/')`，于是永远比不上 → GET 404 / POST 405；
 *   - `chatCompletions` 里造了 `out`（sink 包装）却没用它，所有写入仍走 `res`
 *     → 非 chat 协议拿到的仍是 OpenAI 形态。
 * 两条都在**单元测试全绿**的前提下发生。所以这里测的是接线本身：
 * 路径前缀、以及「写入方到底写到谁」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { geminiModelFromPath, geminiStreamFromPath } from './entry.ts'
import { StreamState, translateStream } from './stream.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')

function source(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

/* ------------------------------------------------------------------ */
/* 1. Gemini 的 prefix 不能带尾斜杠                                    */
/* ------------------------------------------------------------------ */

test('★ Gemini 路由注册的 prefix 不带尾斜杠（否则宿主永不匹配 → 404/405）', () => {
  // 判据直接读源码：这是**接线**的正确性，不是某个函数的正确性。
  // 为什么要钉这一条：宿主 `Table.match()` 的规则是
  //   `pathname === prefix || pathname.startsWith(prefix + '/')`
  // 带尾斜杠时它去比 `'/v1beta/models//'`，实际请求永远比不过。404/405 的
  // 症状离根因太远（看起来像「端点没实现」），必须在这里拦住。
  const src = source('src/index.ts')
  const m = /kind:\s*'prefix',\s*\n\s*path:\s*'([^']+)'/.exec(src)
  assert.ok(m !== null, '没找到 prefix 路由注册 —— 路由被删了？')
  const path = m[1]!
  assert.ok(
    !path.endsWith('/'),
    `prefix 尾斜杠会让宿主匹配成 '${path}/'，实际请求永不命中（2026-10-21 实测 404/405）`,
  )
  assert.equal(path, '/v1beta/models')
})

test('Gemini 路径解析：模型名从 URL 取，streamGenerateContent 也能认', () => {
  assert.equal(geminiModelFromPath('/v1beta/models/gemini-2.5-pro:generateContent'), 'gemini-2.5-pro')
  assert.equal(geminiModelFromPath('/v1beta/models/x:streamGenerateContent'), 'x')
  // 带 query（Gemini 的 ?key= 形态）也能取
  assert.equal(geminiModelFromPath('/v1beta/models/m:generateContent?key=abc'), 'm')
  // 命名空间带斜杠的模型 id
  assert.equal(geminiModelFromPath('/v1beta/models/publishers/google/models/gemini:generateContent'), 'publishers/google/models/gemini')
  // 不认识的路径返回 undefined（不能瞎猜一个模型名）
  assert.equal(geminiModelFromPath('/v1/models'), undefined)
})

/* ------------------------------------------------------------------ */
/* 2. 非 chat 协议的响应必须真的经过 sink                              */
/* ------------------------------------------------------------------ */

test('★ chatCompletions 内部一律写 out（sink 包装），不许再写 res', () => {
  // 这条守的是「协议翻译是否真的接上」：造了 `out` 却仍写 `res` = 翻译层
  // 形同虚设，非 chat 客户端会收到 OpenAI 形态（2026-10-21 实测状态）。
  const src = source('src/router/index.ts')
  const start = src.indexOf('async chatCompletions(')
  assert.ok(start > 0, '找不到 chatCompletions')
  const end = src.indexOf('/** 调指定供应商。', start)
  assert.ok(end > start, '找不到 chatCompletions 的结尾')
  const body = src.slice(start, end)

  // 允许出现 res 的地方：签名行 + out 的定义行
  const allowed = [
    'async chatCompletions(req: ChatRequest, res: ServerResponse, sink?: ResponseSink): Promise<void> {',
    'const out = sink === undefined ? res : sinkRes(sink)',
  ]
  let scanned = body
  for (const a of allowed) scanned = scanned.replace(a, '')

  const hits = [...scanned.matchAll(/\bres\b/g)]
  assert.equal(
    hits.length,
    0,
    `chatCompletions 方法体内还有 ${hits.length} 处直接使用 res —— `
    + '响应绕过了 sink，非 chat 协议会收到 OpenAI 形态',
  )
})

test('非 chat 入口确实把 sink 传给 chatCompletions（不是只 parse 不接出站）', () => {
  const src = source('src/index.ts')
  // enterProtocol 里必须：造 sink 并作为第三个参数传进去
  const m = /const sink = outboundSink\(protocol, parsed\.model, res\)/.exec(src)
  assert.ok(m !== null, '没造 outboundSink')
  const call = /await router\.chatCompletions\(\s*\{[\s\S]{0,400}?\},\s*res,\s*sink,\s*\)/.exec(src)
  assert.ok(call !== null, 'sink 没传给 chatCompletions —— 出站翻译不会生效')
})

/* ------------------------------------------------------------------ */
/* 3. 四条入站路由都注册了                                            */
/* ------------------------------------------------------------------ */

test('★ 四种协议的入站端点全部注册（少一条就是那种协议不可用）', () => {
  const src = source('src/index.ts')
  // 只认「route(...) 调用」与 prefix register，避免注释里提到也算命中
  const routes = [
    { name: 'chat', pattern: /route\('\/v1\/chat\/completions'/ },
    { name: 'anthropic', pattern: /route\('\/v1\/messages'/ },
    { name: 'responses', pattern: /route\('\/v1\/responses'/ },
    { name: 'gemini', pattern: /path: '\/v1beta\/models'/ },
  ]
  for (const r of routes) {
    assert.ok(r.pattern.test(src), `${r.name} 的入站路由没注册`)
  }
})

test('count_tokens 明确 501（不编 token 数）', () => {
  const src = source('src/index.ts')
  assert.ok(src.includes("route('/v1/messages/count_tokens'"), 'count_tokens 路由没注册')
  assert.ok(/writeJson\(res,\s*501/.test(src), 'count_tokens 应当 501，不该假装能数')
})

/* ------------------------------------------------------------------ */
/* 4. 供应商 wire 的读取点存在                                        */
/* ------------------------------------------------------------------ */

test('★ 供应商声明非 chat wire 时，chatOnce 调用被包翻译', () => {
  const src = source('src/router/index.ts')
  const start = src.indexOf('private async chatWithSupplier(')
  // 下一个方法（testModel）的文档注释起点作结束标记
  const end = src.indexOf('测试某供应商的某模型是否可用。', start)
  assert.ok(start > 0 && end > start, '找不到 chatWithSupplier')
  const body = src.slice(start, end)
  // chatWithSupplier 必须用包过的 chatOnce，而不是裸 s.chatOnce
  assert.ok(body.includes('const chatOnce = this.wireOf(s)'), 'chatWithSupplier 没取 wire 包装')
  assert.ok(!/await s\.chatOnce\(/.test(body), 'chatWithSupplier 里还在裸调 s.chatOnce，翻译被绕过')

  // wireChatOnce 本体：读 s.wire、非 chat 时包 translateStream
  const ws = src.indexOf('function wireChatOnce(')
  const we = src.indexOf('/** 从上游响应体提取错误信息', ws)
  assert.ok(ws > 0 && we > ws, '找不到 wireChatOnce')
  const impl = src.slice(ws, we)
  assert.ok(/s\.wire \?\? 'chat'/.test(impl), 'wireChatOnce 没读供应商的 wire 声明')
  assert.ok(impl.includes('translateStream(r.stream'), 'wireChatOnce 没给上游流套协议翻译')
  assert.ok(impl.includes('codec.fromChat('), 'wireChatOnce 没翻请求体')
})

test('★ Gemini 的流式意图来自 URL 路径（body 里没有 stream 字段）', () => {
  // 事故（2026-10-21 在 3080 实测）：`:streamGenerateContent` 请求被当成
  // 非流式，客户端拿到一整个 JSON 却按 SSE 解析 ⇒ 空响应。
  assert.equal(geminiStreamFromPath('/v1beta/models/m:streamGenerateContent'), true)
  assert.equal(geminiStreamFromPath('/v1beta/models/m:streamGenerateContent?alt=sse'), true)
  assert.equal(geminiStreamFromPath('/v1beta/models/m:generateContent'), false)
  // 路径没表态 → undefined（交给 body 的 stream 决定）
  assert.equal(geminiStreamFromPath('/v1/messages'), undefined)
})

test('★ 入口确实把 streamFromPath 传进 parseInbound（否则上面那条解析等于没接）', () => {
  const src = source('src/index.ts')
  assert.ok(
    /streamFromPath: protocol === 'gemini' \? geminiStreamFromPath\(req\.url \?\? ''\)/.test(src),
    'Gemini 的路径流式意图没接进 parseInbound',
  )
})

/* ------------------------------------------------------------------ */
/* 4. 流式收尾：用量必须进收尾帧，且不许重复 message_delta             */
/* ------------------------------------------------------------------ */

test('★ Anthropic 流式收尾：message_delta 只发一次，且带真实 output_tokens', async () => {
  // 事故（2026-10-21 在 3080 实测）：finish 与 usage 各发一帧 message_delta，
  // 第一帧是 stop_reason + output_tokens:0（占位）、第二帧才是真数。
  // Anthropic 客户端取第一个 ⇒ 用量永远读成 0。
  const upstream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(new TextEncoder().encode(
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
        + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":7}}\n\n'
        + 'data: [DONE]\n\n',
      ))
      ctrl.close()
    },
  })
  // 直接驱动 StreamState：translateStream 会自己建 state，这里要拿到它的收尾帧
  const state = new StreamState('chat', 'anthropic', 'm')
  const text = await new Response(translateStream(upstream, state)).text()

  const deltas = text.split('\n\n').filter((f) => f.includes('event: message_delta'))
  assert.equal(deltas.length, 1, `message_delta 应当只发一次，实际 ${deltas.length} 次`)

  const payload = JSON.parse(deltas[0]!.split('\ndata: ')[1]!) as {
    delta: { stop_reason?: string }
    usage: { output_tokens?: number }
  }
  assert.equal(payload.delta.stop_reason, 'end_turn')
  assert.equal(payload.usage.output_tokens, 7, '收尾帧的 output_tokens 必须是真数，不是占位 0')
})

test('★ Gemini 流式：functionCall 必须排在 finishReason 之前', async () => {
  // 事故（2026-10-22 在 3080 实测）：Gemini 的 functionCall 攒到流末才发，
  // 而 finishReason 由 encodeFrame(finish) 提前发出 —— 客户端看到 finishReason
  // 就收尾这一轮，随后到达的工具调用被丢掉。
  const state = new StreamState('chat', 'gemini', 'm')
  const upstream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(new TextEncoder().encode(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"get_weather","arguments":""}}]}}]}\n\n'
        + 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"Beijing\\"}"}}]}}]}\n\n'
        + 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'
        + 'data: [DONE]\n\n',
      ))
      ctrl.close()
    },
  })
  const text = await new Response(translateStream(upstream, state)).text()
  const callAt = text.indexOf('functionCall')
  const finishAt = text.indexOf('finishReason')
  assert.ok(callAt >= 0, 'functionCall 丢了')
  assert.ok(finishAt >= 0, 'finishReason 丢了')
  assert.ok(callAt < finishAt, `functionCall(idx ${callAt}) 必须排在 finishReason(idx ${finishAt}) 之前`)
  assert.ok(text.includes('Beijing'), '工具参数没攒完整')
})
