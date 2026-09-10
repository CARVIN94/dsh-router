/**
 * 前缀指纹 —— 把一次请求的**消息前缀**压成一个短字符串，用于「同一个会话
 * 粘在同一个账号上」。
 *
 * ## 为什么要这个
 *
 * 上游 prompt cache 是 **per-account × per-conversation** 的命名空间。块轮询
 * 保证的是「单会话内连续驻留」，但多个会话被轮到同一个号时，各自十几万的大
 * 前缀会在该号的缓存里**互相驱逐**（实测 3 会话并发 → 命中 3.8%，单会话独占
 * → 82.5%，见 docs/pool-sticky-block.md §2.1）。
 *
 * 破法是让每个会话固定落到一个号：前缀指纹 → 选号。指纹相同的请求（= 同一
 * 会话的连续请求，前缀逐轮增长但开头不变）落在同一个号，各自有独立的缓存
 * 空间。
 *
 * ## 为什么按「前几条消息」而不是整个 body
 *
 * - 整个 body 每次都不一样（会话越跑越长）→ 指纹漂移 → 同一会话换号，正好
 *   是要避免的事。
 * - 请求体前 N 字节也不行：system prompt 动辄几 KB，同源会话（同一个 agent）
 *   在这 N 字节里完全一样，多个会话会撞到同一个号。
 * - 条数取 **2**（system + 首条用户消息）是刻意的：这两个槽位在会话整个
 *   生命周期里**永不变化**（新消息只往后追加），所以从第 1 个请求起指纹
 *   就稳定。取 3 条会在第一条 assistant 回复落进槽位 2 时变一次指纹 →
 *   会话开局多付一次全量重算。而「system + 首条消息逐字相同」的会话，
 *   缓存前缀本来就相同，共享一个号的缓存是收益不是冲突。
 *
 * 天花板：若某个客户端的前 3 条消息在所有会话里都逐字相同（无状态短请求），
 * 指纹会退化成一个值 → 全部压到一个号。此时退化行为 = fallback，可接受；
 * 真要区分得等 DSH 透传会话 id（不为此改契约）。
 */
import { createHash } from 'node:crypto'

/** 取前几条消息：system + 首条用户消息。会话里这两个槽位永不变化 → 指纹从第 1 个请求起稳定。 */
const FP_MSGS = 2
/** 每条消息取前多少字符。缓存前缀的区分度集中在开头，全量哈希只增成本。 */
const FP_CHARS = 512

/**
 * 消息 content 可能是字符串，也可能是多模态分片数组
 * （`[{ type: 'text', text: '...' }]`）。只取文本部分：图片是 base64，
 * 既大又不参与前缀匹配的语义（同一张图每轮都是同一串）。
 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let s = ''
  for (const part of content) {
    if (typeof part === 'string') {
      s += part
      continue
    }
    if (part !== null && typeof part === 'object') {
      const t = (part as { text?: unknown }).text
      if (typeof t === 'string') s += t
    }
  }
  return s
}

/**
 * 算请求的前缀指纹。
 * @param messages OpenAI 请求体的 `messages` 字段（未校验，来自外部输入）
 * @returns 指纹字符串；**空串 = 算不出来（无亲和，回退到块轮询）**
 */
export function prefixFingerprint(messages: unknown): string {
  if (!Array.isArray(messages) || messages.length === 0) return ''
  let buf = ''
  const n = Math.min(messages.length, FP_MSGS)
  for (let i = 0; i < n; i++) {
    const m = messages[i]
    if (m === null || typeof m !== 'object') continue
    const { role, content } = m as { role?: unknown; content?: unknown }
    const text = textOf(content)
    if (typeof role !== 'string' && text === '') continue
    buf += `${typeof role === 'string' ? role : ''}\u0000${text.slice(0, FP_CHARS)}\u0001`
  }
  if (buf === '') return ''
  return createHash('sha1').update(buf).digest('base64url').slice(0, 12)
}
