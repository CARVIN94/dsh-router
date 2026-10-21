/**
 * SSE 帧的编解码小工具 —— 四种协议共用。
 *
 * 只做三件事：把字节流按 SSE 规则切成「一帧」、把一帧拆成 `event:`/`data:`
 * 两部分、把若干帧拼回字节流。**不**知道任何协议语义 —— 那在各协议的
 * `ProtocolCodec` 里。
 *
 * 为什么不用现成库：宿主没有 SSE 依赖，而我们要的能力只有「分帧」这一件，
 * 引入一个包换三十行代码不值；且分帧必须跨 chunk 边界缓冲（上游一帧被拆在
 * 两个 TCP 段里是常态），现成库普遍假设整帧到达。
 */

/** 一帧 SSE。 */
export interface SseFrame {
  /** `event:` 行的值（没有该行时为空串）。 */
  event: string
  /** `data:` 各行的拼接（多行 `data:` 用 `\n` 连接，SSE 规范如此）。 */
  data: string
}

/**
 * 增量分帧器：喂字节进去，吐出完整帧。
 *
 * 用类而不是纯函数，是因为「半个帧」必须留在实例里 —— 每次调用都是无状态的
 * 函数做不到这件事，而每个流都要一个独立缓冲。
 */
export class SseSplitter {
  private buf = ''

  /** 喂入一块字节，返回其中包含的完整帧（可能 0..n 个）。 */
  push(bytes: Uint8Array): SseFrame[] {
    this.buf += new TextDecoder().decode(bytes, { stream: true })
    return this.drain()
  }

  /** 流结束时冲刷：把残留的、不以空行结尾的尾帧也吐出来（上游不发尾空行是有的）。 */
  end(): SseFrame[] {
    // 收掉 decoder 里可能残留的替换序列
    this.buf += new TextDecoder().decode()
    const out = this.drain()
    if (this.buf.trim() !== '') {
      const frame = parseFrame(this.buf)
      this.buf = ''
      if (frame.data !== '') out.push(frame)
    }
    return out
  }

  /** 把已缓冲的完整帧全部切出来。 */
  private drain(): SseFrame[] {
    const out: SseFrame[] = []
    // SSE 以空行分帧。容错 `\r\n\r\n` / `\n\r\n` 等变体：统一按行解析后
    // 用「连续空行」判定边界，见 parseFrame 的调用方。
    let sep: number
    while ((sep = this.buf.search(/\r?\n\r?\n/)) >= 0) {
      const match = /\r?\n\r?\n/.exec(this.buf)
      const raw = this.buf.slice(0, sep)
      this.buf = this.buf.slice(sep + (match?.[0].length ?? 2))
      if (raw.trim() !== '') out.push(parseFrame(raw))
    }
    return out
  }
}

/** 把一帧原文拆成 `event` + `data`。空 data 的帧（注释/keep-alive）返回空 data。 */
export function parseFrame(raw: string): SseFrame {
  let event = ''
  const dataLines: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) continue // 空行 / 注释行
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') dataLines.push(value)
  }
  return { event, data: dataLines.join('\n') }
}

/** 拼一帧字节（`data:` 帧；不带 `event:`）。 */
export function dataFrame(data: string): string {
  return `data: ${data}\n\n`
}

/** 拼一帧字节（带 `event:`）。 */
export function eventFrame(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

/** 把若干帧原文拼成字节。 */
export function framesToBytes(frames: string[]): Uint8Array {
  return new TextEncoder().encode(frames.join(''))
}
