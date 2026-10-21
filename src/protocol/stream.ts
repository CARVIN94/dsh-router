/**
 * 流的协议转码 —— 把「一种协议的 SSE 字节流」翻译成「另一种协议的 SSE 字节流」。
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么拆成 transform + state 两层
 * ════════════════════════════════════════════════════════════════════
 * 逐帧翻译需要一个**有状态**的累加器（usage 分散在多帧、工具名要先于参数、
 * 收尾帧要在流末补），直接写成一个 200 行的 async generator 会把「状态」和
 * 「翻译」搅在一起。所以：
 *   - `StreamState`：一次流的有状态累加（纯内存，可单测，无 IO）。
 *   - `translateStream`：把它接到字节流上（只管分帧/拼帧/生命周期）。
 *
 * 同一条流里**同时只有一个转码器**（上游协议固定），但出站协议由客户端决定 ——
 * 所以是「一个 decode + 一个 encode」，而不是各自独立的两趟。
 *
 * ⚠️ **不缓冲、不聚合**：每个事件到立刻吐对应帧。首字节延迟与上游一致，
 * 不会因为转码多等一个 chunk（Gemini 的工具调用除外：它的参数是一次性整块，
 * 天然没有增量可言）。
 */
import type { ChatEvent, CodecSession, ProtocolId } from './types.ts'
import { codecOf } from './index.ts'
import { SseSplitter, framesToBytes } from './sse.ts'

/** 一次流式转码的有状态累加。 */
export class StreamState {
  /** 上游协议（解码用）。 */
  readonly from: ProtocolId
  /** 客户端协议（编码用）。 */
  readonly to: ProtocolId
  /** 上游 usage（跨帧合并，字段级 max —— 见 mergeUsage 的注释）。 */
  private usage: { promptTokens: number; completionTokens: number; cachedTokens: number } = {
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
  }
  /** 已经吐过起始帧没有（起始帧只能在流最前发一次）。 */
  private started = false
  /** 收尾原因（用于补 endFrames；缺省 stop）。 */
  private finish: Extract<ChatEvent, { type: 'finish' }> | undefined
  /** 模型名（回显进 startFrames/endFrames，如 Anthropic 的 message_start）。 */
  private model = ''
  /**
   * 解码侧会话与编码侧会话，各一份。
   *
   * **必须每帧复用同一个**：Gemini 的工具名↔index 映射就存在这里；每帧新建
   * 会让 `tool-args` 找不到 `tool-start` 给的名字（参数被丢），而放模块级会
   * 跨请求串名。会话在 `StreamState` 构造时建、随流结束丢弃 —— 生命周期与
   * 「一条流」严格对齐。
   */
  private readonly decodeSession: CodecSession | undefined
  private readonly encodeSession: CodecSession | undefined

  constructor(from: ProtocolId, to: ProtocolId, model = '') {
    this.from = from
    this.to = to
    this.model = model
    this.decodeSession = codecOf(from).createSession?.()
    this.encodeSession = codecOf(to).createSession?.()
  }

  /** 当前累计的用量。 */
  currentUsage(): { promptTokens: number; completionTokens: number; cachedTokens: number } {
    return { ...this.usage }
  }

  /** 把上游一帧原文（`data:` 载荷）翻成出站帧原文列表。 */
  translateFrame(frame: string, event?: string): string[] {
    const events = codecOf(this.from).decodeFrame(frame, event, this.decodeSession)
    const out: string[] = []
    if (!this.started) {
      this.started = true
      out.push(...codecOf(this.to).startFrames({ model: this.model, stream: true }))
    }
    for (const ev of events) {
      if (ev.type === 'usage') this.mergeUsage(ev)
      if (ev.type === 'finish') this.finish = ev
      // finish / usage 在出站侧的帧要等流末一起发（见 finish()），
      // 因为它们的位置在协议里是固定的（Anthropic 的 message_delta 在
      // message_stop 前、Responses 的 completed 是最后一件）。
      if (ev.type === 'finish' || ev.type === 'usage') continue
      out.push(...codecOf(this.to).encodeFrame(ev, this.encodeSession))
    }
    return out
  }

  /**
   * 上游流结束：补发收尾帧。
   *
   * **顺序固定**：finish → usage → endFrames。各协议的收尾帧都要求这个次序
   * （Anthropic 的 message_delta 必须在 message_stop 前，Responses 的
   * `response.completed` 是最后一件且自带 usage）。
   *
   * `endFrames` 拿得到 finish 与 usage —— 有的协议（Responses）只有收尾帧
   * 里才有地方放 usage 与「是否被截断」。
   */
  finishStream(): string[] {
    const enc = codecOf(this.to)
    const ctx = { model: this.model, stream: true, finish: this.finish?.reason ?? 'stop', usage: { ...this.usage } }
    if (!this.started) {
      // 上游一个字节都没给：也要给客户端一个**完整形状**的流。只发
      // startFrames 是不够的 —— Anthropic 客户端等 message_stop、Codex 等
      // response.completed，缺收尾帧它们会报「流被截断」而不是「上游没答」。
      this.started = true
      return [...enc.startFrames(ctx), ...enc.endFrames(ctx)]
    }
    const out: string[] = []
    out.push(...enc.encodeFrame(this.finish ?? { type: 'finish', reason: 'stop' }, this.encodeSession))
    out.push(...enc.encodeFrame({ type: 'usage', ...this.usage }, this.encodeSession))
    out.push(...enc.endFrames(ctx))
    return out
  }

  /**
   * usage 合并：字段级 max。
   *
   * 与 `router/usage-tokens.ts` 的 `mergeUsage` 同规则（那里照 9router）：
   * Claude 把输入用量放 `message_start`、输出放 `message_delta`，两帧都给
   * `usage` 字段，**覆盖**会让后一帧把前面的输入清零。
   */
  private mergeUsage(ev: Extract<ChatEvent, { type: 'usage' }>): void {
    this.usage.promptTokens = Math.max(this.usage.promptTokens, ev.promptTokens)
    this.usage.completionTokens = Math.max(this.usage.completionTokens, ev.completionTokens)
    this.usage.cachedTokens = Math.max(this.usage.cachedTokens, ev.cachedTokens)
  }
}

/**
 * 把上游 SSE 字节流转成客户端协议的 SSE 字节流。
 *
 * 生命周期：上游正常读完 / 上游 error / 消费方取消，三条路径都要**释放上游
 * reader** 并把取消传下去 —— 否则上游 fetch body 永不 cancel，长跑会漏连接
 * （`router/index.ts` 的 `normalizeSSEStream` 里同一个坑，判据在
 * `router/disconnect-leak.test.ts`）。
 */
export function translateStream(
  upstream: ReadableStream<Uint8Array>,
  state: StreamState,
): ReadableStream<Uint8Array> {
  const splitter = new SseSplitter()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    try { reader?.releaseLock() } catch { /* 有待定 read 时会抛，忽略 */ }
  }
  return new ReadableStream<Uint8Array>({
    async start(ctrl) {
      reader = upstream.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          const frames = splitter.push(value)
          for (const f of frames) {
            if (f.data === '[DONE]' || f.data === '') continue
            const out = state.translateFrame(f.data, f.event)
            if (out.length > 0) ctrl.enqueue(framesToBytes(out))
          }
        }
        // 尾帧（上游不发结束空行时 SseSplitter.end() 才吐得出）
        for (const f of splitter.end()) {
          if (f.data === '[DONE]' || f.data === '') continue
          const out = state.translateFrame(f.data, f.event)
          if (out.length > 0) ctrl.enqueue(framesToBytes(out))
        }
        const tail = state.finishStream()
        if (tail.length > 0) ctrl.enqueue(framesToBytes(tail))
      } catch {
        // 上游断流/消费方取消：已吐出的内容留着（HTTP 语义，写出去收不回）
      } finally {
        release()
      }
      try { ctrl.close() } catch { /* 已取消 */ }
    },
    cancel: (reason) => reader?.cancel(reason),
  })
}
