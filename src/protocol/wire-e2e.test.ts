/**
 * 四协议出口的**端到端**测试 —— 从 `outboundSink` 到真实字节。
 *
 * `protocol.test.ts` 守的是编解码器两两往返（纯函数、无 IO）；这里守的是接线：
 * Router 只会写 OpenAI 形态，客户端说的是别的协议，中间那层中继必须把
 * **状态行、content-type、内容、收尾**四件事同时搬对。
 *
 * 每一条都对应一个真实会坏的点：
 *   - 流式：客户端逐帧解析，缺 `message_start` / `message_stop` 就是「流格式错误」
 *   - 非流式：方向反了会返回 200 + 空内容（静默错，最难发现）
 *   - 工具调用：名字只在上游第一帧给，后续增量只带参数 —— 名字丢了等于工具没了
 *   - 空流：上游刚连上就断，要给协议合法的空流而不是裸断连接
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { outboundSink } from './entry.ts'
import type { ProtocolId } from './types.ts'

const enc = new TextEncoder()

/** 假的 ServerResponse：收集状态行/头/body，够 sink 用。 */
function captureRes(): {
  res: Record<string, unknown>
  status: () => number
  headers: () => Record<string, string>
  body: () => string
} {
  const chunks: string[] = []
  let status = 0
  let headers: Record<string, string> = {}
  const text = (b: unknown): string =>
    typeof b === 'string' ? b : b instanceof Uint8Array ? new TextDecoder().decode(b) : String(b)
  const self: Record<string, unknown> = {
    writeHead(code: number, h?: Record<string, string>) {
      status = code
      headers = h ?? {}
      return self
    },
    flushHeaders(): void {},
    write(b: unknown): boolean {
      chunks.push(text(b))
      return true
    },
    end(b?: unknown): void {
      if (b !== undefined) chunks.push(text(b))
    },
    on() { return self },
    once() { return self },
    removeListener(): void {},
    destroy(): void {},
  }
  return { res: self, status: () => status, headers: () => headers, body: () => chunks.join('') }
}

/** 按 SSE 规则切帧（`event:` + `data:`）。 */
function sseFrames(body: string): Array<{ event: string; data: string }> {
  return body
    .split(/\r?\n\r?\n/)
    .filter((raw) => raw.trim() !== '')
    .map((raw) => {
      let event = ''
      const dataLines: string[] = []
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
      }
      return { event, data: dataLines.join('\n') }
    })
}

/** 喂一段 OpenAI SSE 给 sink，返回客户端看到的 body。 */
function runStream(protocol: ProtocolId, upstream: string): string {
  const cap = captureRes()
  const sink = outboundSink(protocol, 'test-model', cap.res as never)
  sink.head?.(200, { 'content-type': 'text/event-stream' })
  // 故意切成两段：验证跨 chunk 的分帧缓冲
  const bytes = enc.encode(upstream)
  const cut = Math.floor(bytes.length / 2)
  sink.write(bytes.slice(0, cut))
  sink.write(bytes.slice(cut))
  sink.end()
  return cap.body()
}

const UPSTREAM_TEXT =
  'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n' +
  'data: {"choices":[{"delta":{"content":"世界"}}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: [DONE]\n\n'

test('端到端 · Anthropic：流式帧序列完整（message_start -> text_delta -> stop_reason -> message_stop）', () => {
  const frames = sseFrames(runStream('anthropic', UPSTREAM_TEXT))
  const names = frames.map((f) => f.event)

  assert.equal(names[0], 'message_start', '第一帧必须是 message_start')
  assert.equal(names.at(-1), 'message_stop', '最后一帧必须是 message_stop')
  assert.equal(names.filter((n) => n === 'message_stop').length, 1, 'message_stop 只能有一个')

  const text = frames
    .map((f) => { try { return JSON.parse(f.data) as Record<string, unknown> } catch { return undefined } })
    .filter((o): o is Record<string, unknown> => o !== undefined)
    .map((o) => {
      const d = o.delta as { type?: string; text?: string } | undefined
      return d?.type === 'text_delta' ? (d.text ?? '') : ''
    })
    .join('')
  assert.equal(text, '你好世界', '文本增量被吞了或者顺序乱了')

  const stop = frames
    .map((f) => { try { return JSON.parse(f.data) as { delta?: { stop_reason?: string } } } catch { return {} } })
    .find((o) => o.delta?.stop_reason !== undefined)
  assert.equal(stop?.delta?.stop_reason, 'end_turn', 'stop_reason 没落到 text 块上')
})

test('端到端 · Anthropic：工具调用跨帧保留名字（Claude Code 靠它调工具）', () => {
  // 上游：名字在第一帧，参数分两段增量
  const upstream =
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"Read","arguments":""}}]}}]}\n\n' +
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"file_path\\":"}}]}}]}\n\n' +
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"/tmp/a\\"}"}}]}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
    'data: [DONE]\n\n'
  const frames = sseFrames(runStream('anthropic', upstream))
  const objs = frames
    .map((f) => { try { return JSON.parse(f.data) as Record<string, unknown> } catch { return undefined } })
    .filter((o): o is Record<string, unknown> => o !== undefined)

  const start = objs.find((o) => o.type === 'content_block_start')
  assert.ok(start !== undefined, '缺 content_block_start（工具起点）')
  const block = start.content_block as { type?: string; name?: string; id?: string }
  assert.equal(block.type, 'tool_use')
  assert.equal(block.name, 'Read', '工具名丢了 —— 客户端会收到一个没名字的工具')
  assert.equal(block.id, 'c1')

  const partial = objs
    .map((o) => o.delta as { type?: string; partial_json?: string } | undefined)
    .filter((d): d is { type: 'input_json_delta'; partial_json: string } => d?.type === 'input_json_delta')
    .map((d) => d.partial_json)
    .join('')
  assert.deepEqual(JSON.parse(partial), { file_path: '/tmp/a' })

  const stop = objs.find((o) => (o.delta as { stop_reason?: string } | undefined)?.stop_reason !== undefined)
  assert.equal((stop?.delta as { stop_reason?: string }).stop_reason, 'tool_use', '工具轮的 stop_reason 必须是 tool_use')
})

test('端到端 · Responses：流有 response.created 与带 status/usage 的 response.completed', () => {
  const upstream =
    'data: {"choices":[{"delta":{"content":"hi"}}],"usage":{"prompt_tokens":9,"completion_tokens":4}}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
    'data: [DONE]\n\n'
  const frames = sseFrames(runStream('responses', upstream))
  const names = frames.map((f) => f.event)
  assert.equal(names[0], 'response.created', '缺 response.created')
  assert.equal(names.at(-1), 'response.completed', '缺 response.completed（Codex 靠它判结束）')

  const done = JSON.parse(frames.at(-1)!.data) as { response: { status?: string; usage?: Record<string, number> } }
  assert.equal(done.response.status, 'completed')
  assert.equal(done.response.usage?.input_tokens, 9, '输入用量丢了')
  assert.equal(done.response.usage?.output_tokens, 4, '输出用量丢了')
})

test('端到端 · Gemini：流是裸 data: 帧，finishReason 与 usageMetadata 都在', () => {
  const upstream =
    'data: {"choices":[{"delta":{"content":"hi"}}],"usage":{"prompt_tokens":6,"completion_tokens":2}}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n' +
    'data: [DONE]\n\n'
  const frames = sseFrames(runStream('gemini', upstream))
  assert.ok(frames.every((f) => f.event === ''), 'Gemini 不该有 event: 行')
  const body = frames.map((f) => f.data).join('\n')
  assert.ok(body.includes('"text":"hi"'), '文本丢了')
  assert.ok(body.includes('"finishReason":"MAX_TOKENS"'), 'length -> MAX_TOKENS 没翻对')
  assert.ok(body.includes('"promptTokenCount":6'), '用量丢了')
})

test('端到端 · chat 客户端拿到原生 OpenAI SSE（含 [DONE]）', () => {
  const body = runStream('chat', UPSTREAM_TEXT)
  assert.ok(body.includes('"content":"你好"'))
  assert.ok(body.includes('data: [DONE]'), '缺 [DONE] 终帧')
})

test('端到端 · 空流：每种协议都给出形状合法的收尾，而不是裸断', () => {
  for (const protocol of ['anthropic', 'responses', 'gemini', 'chat'] as ProtocolId[]) {
    const cap = captureRes()
    const sink = outboundSink(protocol, 'test-model', cap.res as never)
    sink.head?.(200, { 'content-type': 'text/event-stream' })
    sink.end()
    const body = cap.body()
    assert.equal(cap.status(), 200, `${protocol}: 状态行该是 200`)
    assert.notEqual(body, '', `${protocol}: 空流不能一个字节都不给（客户端会当成网络故障重试）`)
    if (protocol === 'anthropic') {
      assert.ok(body.includes('message_start') && body.includes('message_stop'), 'anthropic 空流形状不完整')
    }
    if (protocol === 'responses') {
      assert.ok(body.includes('response.completed'), 'responses 空流缺收尾')
    }
  }
})

test('端到端 · 上游 503：错误形状按客户端协议给（不是 OpenAI 的 error）', () => {
  const cap = captureRes()
  const sink = outboundSink('anthropic', 'test-model', cap.res as never)
  sink.head?.(503, { 'content-type': 'application/json' })
  sink.write(enc.encode(JSON.stringify({ error: { message: 'all models unavailable', type: 'api_error' } })))
  sink.end()
  const body = cap.body()
  assert.equal(cap.status(), 503, '状态码要透传')
  assert.ok(body.includes('"type":"error"'), `Anthropic 客户端要的是 {type:'error'} 形状，实际：${body}`)
})
