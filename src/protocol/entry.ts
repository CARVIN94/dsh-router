/**
 * 入站协议的四个入口 —— 把四种协议的请求翻成规范请求、交给 Router，
 * 再把 Router 的响应翻回客户端说的协议。
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么 Router 不认识协议，翻译却全在这
 * ════════════════════════════════════════════════════════════════════
 * Router 的核心职责是「选号/冷却/回退/记账」，它不该知道世界上有几种协议。
 * 所以这里只做三件与协议有关的事：认路径、翻请求体、翻响应体。剩下全部
 * 委托给 `Router.chatCompletions` —— 于是四种协议**自动**获得账号池、
 * 组合回退、首字节预算、断流补帧、用量统计，一个都不用重写。
 *
 * 挂载点见 `src/index.ts` 的 `route(...)` 调用处；新增第五种协议只改
 * 这里 + `protocol/` 下加一个模块，`src/index.ts` 只多一行 route。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { codecOf } from './index.ts'
import { SseSplitter } from './sse.ts'
import { StreamState } from './stream.ts'
import type { ChatEvent, JsonObject, ProtocolId } from './types.ts'
import { str } from './types.ts'

/** 一次入站请求解析后的结果。 */
export interface InboundRequest {
  /** 规范请求体（Chat Completions 形状）。 */
  body: JsonObject
  /** 客户端要的流式。 */
  stream: boolean
  /** 模型名（已从路径或请求体取出）。 */
  model: string
  /** 推理等级；缺省 'auto'。 */
  lv: string
  /** 客户端协议。 */
  protocol: ProtocolId
}

/**
 * 读请求体 + 按协议翻成规范请求。
 *
 * 模型名从哪来因协议而异：Chat/Anthropic/Responses 在 body 的 `model`，
 * Gemini 在 URL 路径（`:generateContent` 之前那段）—— 由 `modelFromPath`
 * 调用方先解析好传进来。
 */
export async function parseInbound(
  req: IncomingMessage,
  protocol: ProtocolId,
  opts: { limitBytes: number; modelFromPath?: string; lvFromBody?: (body: JsonObject) => string },
): Promise<InboundRequest | { error: string; status: number }> {
  const raw = await readBody(req, opts.limitBytes)
  if (raw === undefined) return { error: 'request body too large', status: 413 }
  let body: JsonObject
  try {
    body = JSON.parse(raw) as JsonObject
  } catch {
    return { error: 'invalid JSON body', status: 400 }
  }
  const codec = codecOf(protocol)
  // 路径里的模型名优先：Gemini 只在路径里给，body 里没有 model 字段
  const model = opts.modelFromPath ?? str(body.model) ?? ''
  const stream = body.stream === true
  const canonical = codec.toChat(body, { model, stream })
  // 流式标志由客户端说了算，协议模块不擅自改
  canonical.stream = stream
  canonical.model = model
  const lv = opts.lvFromBody?.(body) ?? 'auto'
  return { body: canonical, stream, model, lv, protocol }
}

/**
 * 一段上游字节像不像 SSE。
 *
 * 只在 content-type **没有**任何提示时才用（流式路径的 `head` 可能一次都不来）。
 * 判据是「第一段非空白内容是否 SSE 行」，不是「包含 data:」—— 后者会让一个
 * 错误 JSON（`{"error":"data: bad"}`）被误判成流。
 */
function looksLikeSse(text: string): boolean {
  const head = text.replace(/^\s+/, '')
  return head.startsWith('data:') || head.startsWith('event:') || head.startsWith(':')
}

/** 上游字节 → 文本（逐字节流式解码，跨 chunk 的多字节字符不会被打断）。 */
const decoder = new TextDecoder()

/** 文本 → 字节。 */
const encoder = new TextEncoder()

/**
 * 给 Router 的**非 chat 出口**：收集 OpenAI 形态的响应，翻译成客户端协议。
 *
 * ════════════════════════════════════════════════════════════════════
 * 两条路径分开处理，因为时序完全不同
 * ════════════════════════════════════════════════════════════════════
 *  非流式：Router 一次 `head(200) + end(json)`。整份 JSON 已在手里，
 *          `decodeJson` → `encodeJson` 一个来回就完。
 *  流式：  Router 分很多次 `write(bytes)`，且**第一个字节前可能失败换号**。
 *          不能等收齐再翻（那就没有流式了）；每收到一段就翻一段。
 *
 * 流式那条为什么插一层 sink 而不是让 Router 直接写翻译后的字节：Router 的
 * `writeChatResult` 里有一整套「客户端断开就取消上游流」「断流补 `[DONE]`」
 * 的逻辑，那些必须继续对真实的 `res` 生效。sink 只是**转发的中继**：
 * 它翻译字节、写给真正的 res；断开时调用方取消本层（见 index.ts 挂载处），
 * Router 那侧的取消链路原样传到上游。
 */
export function outboundSink(protocol: ProtocolId, model: string, res: ServerResponse): ResponseSinkLike {
  const codec = codecOf(protocol)
  let headSent = false
  /** 流式：转码器（收到第一段 SSE 时初始化，跨 write 保持分帧状态）。 */
  let translator: ChunkTranslator | undefined
  /** 非流式：攒起来的 JSON（`undefined` = 还没收到过 body）。 */
  let jsonBuf: string | undefined
  let status = 200
  /**
   * 上游给的 content-type —— **判断流还是 JSON 只看它**，不看内容。
   *
   * 早先靠 `text.startsWith('data:')` 猜：那是错的。非流式 JSON body 里如果
   * 有以 `data:` 开头的字符串值（错误信息里带 "data: ..."）、或者上游先发一段
   * 空白，就会被误判成 SSE，然后 JSON 被当帧喂给翻译器 —— 客户端拿到一个
   * 空流而不是错误信息。content-type 是 Router/上游**明确给出的**事实。
   */
  let contentType = ''

  const sendHead = (code: number, contentType: string): void => {
    if (headSent) return
    headSent = true
    res.writeHead(code, { 'Content-Type': contentType, 'Cache-Control': 'no-store' })
    if (typeof (res as { flushHeaders?: () => void }).flushHeaders === 'function') {
      ;(res as { flushHeaders: () => void }).flushHeaders()
    }
  }

  return {
    head(code, headers) {
      status = code
      const ct = headers['content-type'] ?? headers['Content-Type'] ?? ''
      if (ct !== '') contentType = ct.toLowerCase()
      // 错误响应（503/400）的形状是协议无关的 OpenAI error，而每种协议的
      // error 形状不同。只把 Content-Type 记住，真正的形状翻译在 end() 里做
      // （那时才知道是流内 error 还是 HTTP 错误）。
      if (code !== 200) {
        // 立刻提交：错误没有 body 可等（Router 的错误路径是 head + end 一起）
        sendHead(code, ct !== '' ? ct : 'application/json; charset=utf-8')
      }
    },
    write(bytes) {
      const text = decoder.decode(bytes, { stream: true })
      if (text === '') return
      // 判定顺序：
      //   1. content-type 说是 SSE → 流
      //   2. content-type 说是 JSON → 攒着
      //   3. 两者都没说（流式路径 head 可能一次都不来）→ 看首字节
      if (translator === undefined && (contentType.includes('text/event-stream') || (contentType === '' && looksLikeSse(text)))) {
        translator = new ChunkTranslator(new StreamState('chat', protocol, model))
      }
      if (translator !== undefined) {
        const frames = translator.push(text)
        if (frames.length > 0) {
          sendHead(200, 'text/event-stream')
          res.write(encoder.encode(frames.join('')))
        }
        return
      }
      jsonBuf = (jsonBuf ?? '') + text
    },
    end() {
      const tailChunk = decoder.decode()
      if (tailChunk !== '') {
        if (translator !== undefined) {
          const frames = translator.push(tailChunk)
          if (frames.length > 0) res.write(encoder.encode(frames.join('')))
        } else {
          jsonBuf = (jsonBuf ?? '') + tailChunk
        }
      }
      if (jsonBuf !== undefined && jsonBuf !== '') {
        finishJson(codec, protocol, model, res, sendHead, status, jsonBuf)
        return
      }
      if (translator !== undefined) {
        // 流式收尾：finish + usage + endFrames
        const tail = translator.end()
        if (tail.length > 0) res.write(encoder.encode(tail.join('')))
        if (headSent) res.end()
        else finishEmptyStream(codec, protocol, model, res, sendHead)
        return
      }
      finishEmptyStream(codec, protocol, model, res, sendHead)
    },
  }
}

/** Router 的 ResponseSink 形状（本地声明，避免 protocol → router 的循环依赖）。 */
export interface ResponseSinkLike {
  head?: (status: number, headers: Record<string, string>) => void
  write: (bytes: Uint8Array) => void
  end: () => void
}

/* ------------------------------------------------------------------ */
/* 收尾的三种情形                                                     */
/* ------------------------------------------------------------------ */

/**
 * 非流式：整份 JSON 翻译后写出。
 *
 * ⚠️ 方向在这里：Router 吐的是 **OpenAI Chat** 形态（`choices[0].message`），
 * 而客户端要的是 `protocol` 说的形态。所以**解码用 chat codec、编码用客户端
 * codec** —— 曾经两处都用客户端的 codec，于是 Chat JSON 被当成 Anthropic
 * body 解（`choices` 字段根本不存在），客户端拿到一个 content 为空的回复。
 */
function finishJson(
  clientCodec: ReturnType<typeof codecOf>,
  protocol: ProtocolId,
  model: string,
  res: ServerResponse,
  sendHead: (code: number, contentType: string) => void,
  status: number,
  jsonBuf: string,
): void {
  let events: ChatEvent[]
  try {
    events = codecOf('chat').decodeJson(JSON.parse(jsonBuf) as JsonObject)
  } catch {
    // 上游给的不是 JSON（罕见的纯文本错误）→ 原样透传，别把它翻成 200
    sendHead(status, 'application/json; charset=utf-8')
    res.end(jsonBuf)
    return
  }
  const err = events.find((e) => e.type === 'error')
  if (err !== undefined && err.type === 'error') {
    sendHead(502, 'application/json; charset=utf-8')
    res.end(JSON.stringify(errBody(protocol, err.message)))
    return
  }
  const body = clientCodec.encodeJson(events, { model, stream: false })
  sendHead(status, 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/**
 * 流式但一个内容帧都没翻译出来（上游刚连上就断 / 首字节超时前就失败）。
 *
 * 给客户端一个**协议合法的空流**，别让 HTTP 连接裸断：客户端会把「没有响应」
 * 当成网络故障重试，而「上游没答」才是事实——用协议的 error 收尾说出来。
 */
function finishEmptyStream(
  codec: ReturnType<typeof codecOf>,
  protocol: ProtocolId,
  model: string,
  res: ServerResponse,
  sendHead: (code: number, contentType: string) => void,
): void {
  const ctx = { model, stream: true, finish: 'error' as const }
  const frames = [
    ...codec.startFrames(ctx),
    ...codec.encodeFrame({ type: 'error', message: 'upstream closed before any content' }),
    ...codec.encodeFrame({ type: 'finish', reason: 'error' }),
    ...codec.endFrames(ctx),
  ]
  sendHead(200, 'text/event-stream')
  res.end(new TextEncoder().encode(frames.join('')))
}

/** 每种协议的 error body 形状。 */
function errBody(protocol: ProtocolId, message: string): unknown {
  if (protocol === 'anthropic') {
    return { type: 'error', error: { type: 'api_error', message } }
  }
  if (protocol === 'gemini') {
    return { error: { code: 502, message, status: 'UNAVAILABLE' } }
  }
  return { error: { message, type: 'api_error', code: 'upstream_error' } }
}

/* ------------------------------------------------------------------ */
/* 分帧（字符串版）                                                   */
/* ------------------------------------------------------------------ */

/**
 * 一段上游 OpenAI SSE 文本的转码器 —— **有状态**。
 *
 * 上游一帧被拆在两个 TCP 段里是常态（Router 按拿到的字节原样转交），所以
 * 分帧缓冲必须跨 `write()` 调用存活。这里用 `sse.ts` 的 `SseSplitter`（它内部
 * 留着半个帧）而不是每次现切 —— 早先每次现切会把不完整帧当完整帧解析，
 * 表现是「文本丢一半、工具参数截断」，而 HTTP 200，客户端看不到任何错误。
 *
 * 生命周期与 sink 一致：一个请求一个实例。
 */
export class ChunkTranslator {
  private readonly splitter = new SseSplitter()
  private readonly state: StreamState

  constructor(state: StreamState) {
    this.state = state
  }

  /** 喂一段文本，返回可写给客户端的帧。 */
  push(text: string): string[] {
    return this.emit(this.splitter.push(new TextEncoder().encode(text)))
  }

  /** 流结束：冲刷残留帧（上游不发尾空行是有的），返回收尾帧。 */
  end(): string[] {
    return [...this.emit(this.splitter.end()), ...this.state.finishStream()]
  }

  private emit(frames: Array<{ event: string; data: string }>): string[] {
    const out: string[] = []
    for (const f of frames) {
      if (f.data === '' || f.data === '[DONE]') continue
      out.push(...this.state.translateFrame(f.data, f.event))
    }
    return out
  }
}

/**
 * 单次调用版：把一段**完整**的 SSE 文本转成客户端帧。
 *
 * 只适合「手里已经有一整段完整数据」的场合（测试、非流式上游误发了 SSE）。
 * 真正的流式路径必须用 `ChunkTranslator` 保持跨段状态。
 */
export function translateChunk(state: StreamState, text: string): string[] {
  const t = new ChunkTranslator(state)
  return [...t.push(text), ...t.end()]
}

/* ------------------------------------------------------------------ */
/* 小工具                                                             */
/* ------------------------------------------------------------------ */

/** 读请求体（带大小上限）。超限返回 undefined。 */
function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        resolve(undefined)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(undefined))
  })
}

/**
 * 从 Gemini 的 URL 路径里取模型名。
 *
 * 形如 `/v1beta/models/<model>:generateContent`（或 `:streamGenerateContent`），
 * `<model>` 本身可以含斜杠，所以取 `models/` 之后到最后一个 `:` 之前那段。
 *
 * **必须先切掉 query**：Gemini CLI 默认带 `?alt=sse`，不切的话 `$` 锚点匹配
 * 不上，模型名变空 —— 表现为「404 model not found」而不是参数错误，很难查。
 * 顺便支持 `/v1beta/models/<model>` 这种带版本号但无方法的形态（走 GET 列表时
 * 会撞上，这里取不到 `/` 就是取不到，返回 undefined 让上层报 400）。
 */
export function geminiModelFromPath(pathname: string): string | undefined {
  const path = pathname.split('?')[0] ?? ''
  const m = /\/models\/(.+?):(?:streamGenerateContent|generateContent|countTokens)$/.exec(path)
  return m?.[1]
}

/**
 * 从请求体取推理等级（各协议字段名不同）。
 *
 * 只认「明确说了要多少思考」的形态，其余一律 'auto'：把「有这个字段」当成
 * 「要高档推理」会让所有带 thinking 块的请求都按 high 走，费用与延迟都变。
 */
export function lvOf(body: JsonObject, protocol: ProtocolId): string {
  const direct = str(body.reasoning_effort)
  if (direct !== undefined) return direct
  const effort = str(body.reasoning) ?? str(body.effort)
  if (effort !== undefined) return effort
  // Gemini：generationConfig.thinkingConfig.thinkingBudget 是数字档位
  const budget = body.generationConfig
  if (budget !== undefined) {
    const tb = (budget as { thinkingConfig?: { thinkingBudget?: unknown } }).thinkingConfig?.thinkingBudget
    if (typeof tb === 'number' && tb > 0) return 'high'
  }
  // Anthropic：thinking.budget_tokens
  const thinking = body.thinking
  if (thinking !== undefined) {
    const tb = (thinking as { budget_tokens?: unknown }).budget_tokens
    if (typeof tb === 'number' && tb > 0) return 'high'
  }
  void protocol
  return 'auto'
}
