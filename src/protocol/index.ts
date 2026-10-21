/**
 * 协议注册表 —— 按 id 取编解码器。
 *
 * 刻意保持成一张**静态表**而不是注册机制：四种协议是编译期就知道的集合，
 * 加第五种就是改这个文件 + 加一个模块，不需要运行时发现。做成可注册会让
 * 「谁在什么时候注册了什么」变成运行时事实，而这里没有任何插件需要插进来
 * （供应商 wire 是另一回事，见 `suppliers/contract.ts` 的 `wire`）。
 */
import type { ProtocolCodec, ProtocolId } from './types.ts'
import { PROTOCOL_IDS } from './types.ts'
import { chatCodec } from './chat.ts'
import { anthropicCodec } from './anthropic.ts'
import { responsesCodec } from './responses.ts'
import { geminiCodec } from './gemini.ts'

const CODECS: Record<ProtocolId, ProtocolCodec> = {
  chat: chatCodec,
  anthropic: anthropicCodec,
  responses: responsesCodec,
  gemini: geminiCodec,
}

/** 取编解码器。id 已由 `isProtocolId` 校验过，这里不再兜底。 */
export function codecOf(id: ProtocolId): ProtocolCodec {
  return CODECS[id]
}

/** 全部编解码器（文档与测试用）。 */
export function allCodecs(): ProtocolCodec[] {
  return PROTOCOL_IDS.map((id) => CODECS[id])
}
