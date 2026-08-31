/**
 * Token 用量提取 —— 口径照 9router 的 `open-sse/utils/usageTracking.js`。
 *
 * 三件事：
 *   1. **归一化**：上游字段名各不相同（prompt_tokens / input_tokens /
 *      promptTokenCount …），统一到 OpenAI 口径。
 *   2. **合并**：流式里 usage 常被拆在多个事件里（Claude 系：
 *      message_start 给输入+缓存，message_delta 给输出）。所以是
 *      **字段级 max 合并**，不是覆盖——照 9router 的 `mergeUsage`。
 *   3. **回退估算**：上游压根不发 usage 时，按字符数/4 估算（照 9router 的
 *      `estimateInputTokens`/`estimateOutputTokens`），并**分别**标记输入/输出
 *      哪个是估算的——9router 只有一个 `estimated` 布尔，这里拆开更准，
 *      面板才知道该给哪个数打「~」。
 *
 * 天花板（刻意不做）：
 *   - 估算就是估算，~4 字符/token 是跨 tokenizer 的粗略平均。
 *     要准得上真 tokenizer，代价是引入依赖，不值。
 *   - 不注入 `stream_options.include_usage`：那要改写客户端的请求体，
 *     个别上游不认这个字段。上游不发我们就估算，不动请求语义。
 */
import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/** 归一化后的用量（不含估算标记）。 */
export interface UsageTokens {
  promptTokens: number
  completionTokens: number
  cachedTokens: number
}

/** 最终用量：token 数 + 哪些字段是估算的。 */
export interface Usage extends UsageTokens {
  /** 输入是估算的（上游没给）。 */
  inputEstimated: boolean
  /** 输出是估算的（上游没给）。 */
  outputEstimated: boolean
}

/** 一帧 SSE 里可能带 usage 的形状（上游各不相同，全是可选）。 */
interface RawUsage {
  prompt_tokens?: number
  completion_tokens?: number
  cached_tokens?: number
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  promptTokenCount?: number
  candidatesTokenCount?: number
  cachedContentTokenCount?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

/** 取有限数，其余当 0（NaN 会毒穿整个累加：`Math.max(x, NaN) === NaN`）。 */
function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * 从上游任意形态的 usage 对象提取归一用量。
 *
 * `cached_tokens` 口径照 9router 的 `canonicalizeUsage`：OpenAI 系报的
 * prompt_tokens **已含**缓存，直接透传；Claude 系报的是**不含**缓存的
 * prompt + 单独的 cache_read，要折进来，否则总输入偏小。
 * 判别式就是「有没有 cache_read_input_tokens」。
 *
 * @returns 归一用量；一个非零字段都没有时返回 null（= 没拿到 usage）
 */
export function normalizeUsage(raw: unknown): UsageTokens | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const u = raw as RawUsage

  const cached =
    num(u.cached_tokens) +
    num(u.cache_read_input_tokens) +
    num(u.cachedContentTokenCount) +
    num(u.prompt_tokens_details?.cached_tokens)

  // promptTokenCount 是 Gemini 形态；input_tokens 是 Claude 形态
  let prompt = num(u.prompt_tokens) + num(u.input_tokens) + num(u.promptTokenCount)
  if (u.cache_read_input_tokens !== undefined) prompt += num(u.cache_read_input_tokens)

  const completion = num(u.completion_tokens) + num(u.output_tokens) + num(u.candidatesTokenCount)

  if (prompt === 0 && completion === 0 && cached === 0) return null
  return { promptTokens: prompt, completionTokens: completion, cachedTokens: cached }
}

/** 字段级 max 合并：后来的同名字段取大者（Claude 把 usage 拆在多个事件里）。 */
export function mergeUsage(prev: UsageTokens | null, next: UsageTokens | null): UsageTokens | null {
  if (prev === null) return next
  if (next === null) return prev
  return {
    promptTokens: Math.max(prev.promptTokens, next.promptTokens),
    completionTokens: Math.max(prev.completionTokens, next.completionTokens),
    cachedTokens: Math.max(prev.cachedTokens, next.cachedTokens),
  }
}

/**
 * 从流式上游的一帧 JSON 里取 usage。
 * 覆盖 OpenAI(Chat/Responses)、Claude、Gemini 三种事件形状，照 9router
 * `extractUsage` 的形态判断（dsh-router 的上游多是 OpenAI SSE，但供应商
 * 插件可能有直通的原生流，多认几种不亏）。
 */
export function extractFrameUsage(chunk: unknown): UsageTokens | null {
  if (chunk === null || typeof chunk !== 'object' || Array.isArray(chunk)) return null
  const c = chunk as Record<string, unknown>

  // Responses API：response.completed / response.done 带 response.usage
  if (c.type === 'response.completed' || c.type === 'response.done') {
    const r = c.response as { usage?: unknown } | undefined
    if (r !== undefined) return normalizeUsage(r.usage)
  }
  // Claude：message_start 的 message.usage（输入+缓存）、message_delta 的 usage（输出）
  if (c.type === 'message_start') {
    const m = c.message as { usage?: unknown } | undefined
    if (m !== undefined) return normalizeUsage(m.usage)
  }
  if (c.type === 'message_delta') return normalizeUsage(c.usage)

  // OpenAI Chat：顶层 usage（多数供应商在最后一帧给）
  if (c.usage !== undefined) return normalizeUsage(c.usage)
  // Gemini：usageMetadata，可能被包在 response 里
  if (c.usageMetadata !== undefined) return normalizeUsage(c.usageMetadata)
  const wrapped = c.response as { usageMetadata?: unknown } | undefined
  if (wrapped?.usageMetadata !== undefined) return normalizeUsage(wrapped.usageMetadata)

  return null
}

/** 估算：~4 字符/token（照 9router 的 estimateInputTokens/estimateOutputTokens）。 */
export function estimateTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0
  return Math.ceil(chars / 4)
}

/**
 * 非流式响应体取 usage。
 *
 * 正常是纯 JSON；但个别供应商客户端要 JSON 却回 SSE（核心会聚合成一次响应，
 * 见 `aggregateSSE`），所以顺手扫尾部几帧——只扫尾部，不多做。
 */
export function usageFromJsonBody(body: string): UsageTokens | null {
  try {
    return normalizeUsage((JSON.parse(body) as { usage?: unknown }).usage)
  } catch {
    // 不是 JSON → 按 SSE 尾部扫
  }
  let merged: UsageTokens | null = null
  for (const frame of body.split('\n\n').slice(-3)) {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '' || payload === '[DONE]') continue
      let obj: unknown
      try { obj = JSON.parse(payload) } catch { continue }
      merged = mergeUsage(merged, extractFrameUsage(obj))
    }
  }
  return merged
}

/**
 * 归一用量 → DSH 的 `TokenUsage`（**必须**走这一步再交给 dsh-llm）。
 *
 * 为什么不能把上游 usage 原样透传：dsh-llm 的 `TokenUsage` 有两条硬性约定，
 * 上游的 OpenAI 形态两条都踩：
 *   1. 字段名是 `inputTokens` / `outputTokens`，不是 `prompt_tokens`；
 *      名字对不上 → 下游读 `usage.inputTokens` 得 `undefined` → 累加出 `NaN`。
 *   2. **DISJOINT 口径**：`inputTokens` 只算**未缓存**输入，缓存单列
 *      `cacheReadTokens`/`cacheWriteTokens`（计费输入 = 三者之和）。
 *      OpenAI 的 `prompt_tokens` 是**含**缓存的总量，直接当 inputTokens
 *      就是重复计费。
 *
 * 后果不只是「数字不好看」：token-meter 的投影 schema 是
 * `z.number().int().nonnegative()`，`NaN` 一进去校验就抛，整条
 * `session.history` RPC 失败 —— 表现为「历史加载失败：history unavailable
 * for session ... expected number, received NaN」。所以这里是**写入侧**
 * 的防线：宁可丢掉这一帧 usage，也不能往会话日志里写 NaN。
 *
 * 天花板（刻意不做）：不区分 cacheRead/cacheWrite。上游多数只报读不报写，
 * 拆不开的字段硬拆只会更错；哪天上游稳定给 `cache_creation_input_tokens`
 * 再补 `cacheWriteTokens`（升级路径就在这）。
 *
 * @returns DSH 契约用量；三个数全为 0 时返回 null（= 这一帧没真数据）
 */
export function toTokenUsage(tokens: UsageTokens | null): TokenUsage | null {
  if (tokens === null) return null
  // promptTokens 含缓存（normalizeUsage 的口径），DISJOINT 要求减掉
  const input = finiteInt(tokens.promptTokens - tokens.cachedTokens)
  const output = finiteInt(tokens.completionTokens)
  const cachedTokens = finiteInt(tokens.cachedTokens)
  if (input === 0 && output === 0 && cachedTokens === 0) return null
  return {
    inputTokens: input,
    outputTokens: output,
    ...(cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {}),
  }
}

/** 取非负有限整数：NaN / Infinity / 负数一律归 0，小数取整。 */
function finiteInt(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.round(v))
}

/** 一帧 SSE 里的可见文本内容（用于输出字符数估算）。 */
function frameText(chunk: Record<string, unknown>): string {
  const choices = chunk.choices as Array<Record<string, unknown>> | undefined
  if (choices === undefined) return ''
  let out = ''
  for (const ch of choices) {
    const delta = ch.delta as Record<string, unknown> | undefined
    if (delta !== undefined) {
      if (typeof delta.content === 'string') out += delta.content
      if (typeof delta.reasoning_content === 'string') out += delta.reasoning_content
      continue
    }
    // 少数实现把内容直接放在 message 里（非 delta）
    const msg = ch.message as Record<string, unknown> | undefined
    if (msg !== undefined) {
      if (typeof msg.content === 'string') out += msg.content
      if (typeof msg.reasoning_content === 'string') out += msg.reasoning_content
    }
  }
  return out
}

/** 流结束后汇总出的东西。 */
export interface StreamUsage {
  usage: UsageTokens | null
  /** 输出内容字符数（上游没给 completion_tokens 时用来估算）。 */
  outputChars: number
  /** 首字节延迟（ms）；一个字节都没收到时为 0。 */
  ttfbMs: number
}

/**
 * 边透传边统计：原流**原样**出去，统计在旁边做。
 *
 * 为什么不用 `source.tee()`：tee 的两条分支互相牵制，慢的一边会把 buffer 憋住；
 * 而统计这条分支得读完整个流才出得了 usage，客户端那边却要尽快拿到首字节。
 * 手动转发是把上游 chunk **即刻**交给下游，统计只攒几个数字，零缓冲、
 * 首字节延迟不受影响。
 *
 * @param source 上游流（插件已转成 OpenAI SSE）
 * @param startedAt 请求开始时间（`Date.now()`），TTFB 以此为基准
 */
export function tapStreamUsage(
  source: ReadableStream<Uint8Array>,
  startedAt: number,
): { stream: ReadableStream<Uint8Array>; done: () => Promise<StreamUsage> } {
  const dec = new TextDecoder()
  let buf = ''
  let merged: UsageTokens | null = null
  let outputChars = 0
  let firstAt = 0

  const parseFrame = (frame: string): void => {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '' || payload === '[DONE]') continue
      let obj: unknown
      try { obj = JSON.parse(payload) } catch { continue }
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) continue
      merged = mergeUsage(merged, extractFrameUsage(obj))
      outputChars += frameText(obj as Record<string, unknown>).length
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start: async (ctrl) => {
      const reader = source.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (firstAt === 0) firstAt = Date.now()
          // 统计用 stream:true 解码（跨 chunk 边界的多字节字符不会被切断）；
          // 转发出去的是原始字节 value，解码与转发互不影响
          buf += dec.decode(value as Uint8Array, { stream: true })
          let sep: number
          while ((sep = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, sep + 2)
            buf = buf.slice(sep + 2)
            parseFrame(frame)
          }
          ctrl.enqueue(value as Uint8Array)
        }
        if (buf !== '') parseFrame(buf)
      } finally {
        reader.releaseLock()
      }
      ctrl.close()
    },
  })

  return {
    stream,
    done: async () => ({ usage: merged, outputChars, ttfbMs: firstAt === 0 ? 0 : firstAt - startedAt }),
  }
}

/**
 * 补齐估算：上游没给的字段用字符数估，并打标记。
 *
 * `requestChars` = 请求体字符数（估输入），`outputChars` = 输出字符数（估输出）。
 * 上游给了的字段**不覆盖**——估算只填空，不抢真数据。
 */
export function withEstimates(
  usage: UsageTokens | null,
  requestChars: number,
  outputChars: number,
): Usage {
  const prompt = usage?.promptTokens ?? 0
  const completion = usage?.completionTokens ?? 0
  const inputEstimated = prompt === 0
  const outputEstimated = completion === 0
  return {
    promptTokens: inputEstimated ? estimateTokens(requestChars) : prompt,
    completionTokens: outputEstimated ? estimateTokens(outputChars) : completion,
    cachedTokens: usage?.cachedTokens ?? 0,
    inputEstimated,
    outputEstimated,
  }
}
