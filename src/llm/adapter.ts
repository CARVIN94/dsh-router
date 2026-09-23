/**
 * DSH llm adapter for dsh-router（provider 固定卡片，名字 Router）。
 *
 * 模型目录 = 组合（自动带出，不可改）。对话转发到本插件 /v1/chat/completions，
 * 由现有路由按组合策略命中供应商模型。
 *
 * 图文流：adapter 声明图片 modal（`inputModalities` 含 `image`），把 user 消息里的
 * `image` 块序列化成 OpenAI 标准的 `image_url` base64 part，经 /v1 原样透传给
 * 命中的上游供应商。最终能否看图取决于**命中的那个上游模型**——组合里是异构
 * 供应商，可能在网关端声明了图片能力、某条上游却只收文本（此时由上游自行拒收）。
 * 图片字节从 `ctx.attachments` 读取（读不到的按稳定占位文本降级，绝不静默丢图）。
 */
import {
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  ToolCallId,
  attributionHeaders,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmReasoningEffortInfo,
  type LlmResolvedModelInfo,
  type ModelModality,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { mergeUsage, normalizeUsage, toTokenUsage, type UsageTokens } from '../router/usage-tokens.ts'

/**
 * dsh-attachment 的最小本地切面：adapter 只依赖「读一张图片的请求版本」
 * 这一行为，不引入对 dsh-attachment 包编译期/运行期的依赖（它是宿主注入的
 * devDependency）。本地声明与原包 `AttachmentStore.readImageRequest` 形状一致，
 * 宿主注入真实 store 时天然满足。
 */
export interface RouterAttachmentStore {
  readImageRequest(
    ref: { attachmentId: string; mediaType: string; bytes: number; width: number; height: number },
    policy: { maxPixels: number; maxBytes: number },
    signal?: AbortSignal,
  ): Promise<{ mediaType: string; data: Uint8Array }>
}

/** 一张 image 块的 attachment ref 的最小形状（value 类型，够用即可）。 */
interface RouterImgLike {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
}

/** 模型目录来源：组合。 */
export interface RouterAdapterSource {
  /**
   * 组合列表。`contextWindow` 可选，但**必须尽量给**——自动压缩靠它算阈值
   * （`dsh-compaction-basic` 在 `context` 缺失时直接抛错并静默关闭自动压缩，
   * 于是上下文会一路涨到模型硬上限才炸）。
   * 组合背后是异构供应商时给**最小的那个**（保守，宁可早压缩）。
   */
  comboModels: () => Promise<Array<{ id: string; name?: string; contextWindow?: number }>>
}

/**
 * 把 DSH 消息序列化成 openai 兼容 wire 消息（文本 + 图片 + tool）。
 *
 * `system` 必须由调用方从 `options.system` 传进来：one-shot 调用方把系统提示词
 * 放在 **options.system 这个独立槽位**，不放进 messages。不读这个槽位，
 * one-shot 调用方（如 compaction / session-title）的模型每一轮都拿不到身份/
 * 规则/工具用法约束，且**不会报错**，只是行为悄悄降级。
 *
 * 0.1.5 起 loop-built 请求反过来：`options.system` 为 undefined，系统提示词作为
 * **messages 里的 system-role 消息**下发（dsh-agent-loop 的 SystemProjection，
 * 可出现在任意位置以支持提示词热更新）。两条路径都必须支持 —— 与官方
 * dsh-llm-deepseek 一致（serializeRequest 前置 options.system，再按位置序列化
 * messages 里的 system 消息）。
 *
 * 图片：`image` 块被序列化成 OpenAI `content` 数组里的 `image_url` part（data URI
 * base64）。图片字节经 `resolveAttachments` 读取；读不到时回退为稳定的占位文本，
 * **绝不静默丢图**（丢图 = 模型看到一条没有图的消息却毫无提示）。
 *
 * 工具结果双模型兼容：0.1.5/0.1.6 里 tool result 是 user 消息里的 'tool-result' 块
 * （旧路径）；0.1.7+ 改成了独立 role:'tool' 消息、toolCallId 挂消息级（新分支）。
 * 两者在 wire 上统一序列化为 role:'tool'，产物一致。见主循环里的 role==='tool' 分支。
 */
/** tool-result 里图片挂到 user 消息时用的说明文字（与官方适配器一致）。 */
const TOOL_RESULT_IMAGE_TEXT = 'Tool result images'

/**
 * 流空闲超时：上游连上后这么久没吐**任何**字节就判失败（抛 TIMEOUT，可重试）。
 *
 * 对齐 `dsh-llm-pi-ai` 的 `DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000`：同一个
 * dsh-router `/v1`，走自定义供应商（pi-ai）时有这个兜底、走内置 adapter 时没有
 * —— 差异导致「上游停摆」在内置路径上永久挂住。
 *
 * 只守空闲、不封总时长：长生成只要持续吐块就不该被打断。
 */
const STREAM_IDLE_TIMEOUT_MS = 300_000

async function wireMessages(options: GenerateOptions, system: string | undefined, attachments: RouterAttachmentStore | undefined): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  /**
   * 攒着「tool-result 里带出来的图片」，等这一串 tool 消息**发完**再合并成一条
   * user 消息补在后面。
   *
   * 为什么必须跨消息攒、而不是各消息各发一条：harness 把**每个 tool 结果放
   * 自己的 user-role 消息**里（读两张图 = 两条消息）。若每条消息各发一个
   * `user(图)`，wire 就成 `assistant → tool → user(图) → tool → user(图)`——
   * 中间那条 user 又把 tool_call/tool_result 配对接断了，上游照样 400/11148
   * （实测：tool,user,tool,user = 400；tool,tool,user(两图) = 200）。
   * 官方 dsh-llm-deepseek 的 serializeMessagesWithImages 同样这么做。
   */
  let pendingToolImages: Array<Record<string, unknown>> = []
  const flushToolImages = (): void => {
    if (pendingToolImages.length === 0) return
    out.push({ role: 'user', content: [{ type: 'text', text: TOOL_RESULT_IMAGE_TEXT }, ...pendingToolImages] })
    pendingToolImages = []
  }
  if (typeof system === 'string' && system !== '') {
    out.push({ role: 'system', content: system })
  }
  for (const message of options.messages) {
    if (message.role === 'system') {
      // 手写调用也可能把 system 塞进 messages（one-shot 场景），照旧支持
      flushToolImages()
      out.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      flushToolImages()
      const text = flattenText(message.content)
      const toolCalls = message.content
        .filter((b) => b.type === 'tool-call')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.arguments } }))
      const reasoning = message.content
        .filter((b) => b.type === 'reasoning')
        .map((b) => b.text)
        .join('')
      out.push({
        role: 'assistant',
        content: text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
      })
      continue
    }
    // DSH 0.1.7+（0.1.7-alpha.x 及以后）：tool 结果是独立 role:'tool' 消息，toolCallId 挂在
    // 消息级——dsh-llm 的 ContentBlockMap 已移除 'tool-result' 块。0.1.5/0.1.6 仍是 user
    // 消息里的 'tool-result' 块，走下面旧路径。同一份 adapter 同时兼容 DSH 0.1.5 与 0.1.7：
    // 0.1.7 宿主触发本分支，0.1.5 宿主走旧块路径，互不影响。
    if ((message.role as string) === 'tool') {
      // tool 消息必须紧跟 assistant(tool_calls)：中间插进任何 user 消息，上游都会判定
      // tool_call 与 tool_result 失配 → codebuddy 直接 400 网关码 11148（bad_request
      // 按核心设计不罚账号，面板上看不到异常，易误判成额度/风控）。
      // 图片不能放进 tool 消息（实测模型会把两张不同图认成同一张），也不能插在两条 tool
      // 之间（同样 400），所以先攒进 pending，等整串 tool 发完再补一条 user(图)。
      const toolCallId = (message as { toolCallId?: unknown }).toolCallId
      const parts = await contentParts(message.content, attachments, options.signal)
      const imageParts = parts.filter((p) => p.type !== 'text')
      const text = parts
        .filter((p) => p.type === 'text')
        .map((p) => (p as { text?: string }).text ?? '')
        .join('')
      // 空结果就发空串：不要替换成 '(no output)' 之类字面量——模型会以为工具真的打印了
      // 那句话。上游接受 content:""（0.1.7 探测矩阵第 6 项确认）。
      out.push({ role: 'tool', tool_call_id: String(toolCallId ?? ''), content: text })
      pendingToolImages.push(...imageParts)
      continue
    }
    // user / tool-result
    const toolResults = message.content.filter((b) => b.type === 'tool-result')
    // 这条消息自己的（非 tool-result 的）user 部分：文本 + 图片。
    const ownParts = await contentParts(
      message.content.filter((b) => b.type !== 'tool-result'),
      attachments,
      options.signal,
    )
    // 有实质 user 内容（或压根没有 tool 结果）就先发这条 user 消息；
    // 只有 tool 结果的「纯工具」消息不发空 user，图片留到 pending 里合并。
    if (ownParts.length > 0 || toolResults.length === 0) {
      flushToolImages()
      out.push({ role: 'user', content: compactUserContent(ownParts) })
    }
    for (const result of toolResults) {
      // **tool 消息必须紧跟 assistant(tool_calls)**：中间插进任何 user 消息，
      // 上游都会判定 tool_call 与 tool_result 失配 —— codebuddy 直接 400 网关码
      // 11148「tool calls and tool results do not match」。
      // 图片不能放进 tool 消息（实测模型会把两张不同的图认成同一张），
      // 也不能插在两条 tool 之间（同样 400），所以先攒起来、发完整串再补一条 user。
      const parts = await contentParts(result.content, attachments, options.signal)
      const imageParts = parts.filter((p) => p.type !== 'text')
      const text = parts.filter((p) => p.type === 'text').map((p) => (p as { text?: string }).text ?? '').join('')
      // 空结果就发空串，不要替换成 '(no output)' 之类的字面量 —— 模型会
      // 以为工具真的打印了那句话（9router 也是补 content: ""）。
      out.push({ role: 'tool', tool_call_id: result.toolCallId, content: text })
      pendingToolImages.push(...imageParts)
    }
  }
  flushToolImages()
  return out
}

/**
 * 纯文本 parts 收成紧凑字符串 wire 形式（无图时不回归成数组）。
 * 与官方适配器的 userContent 同义：只要有非 text part 就保持数组，否则 join。
 */
function compactUserContent(parts: Array<Record<string, unknown>>): string | Array<Record<string, unknown>> {
  const texts: string[] = []
  for (const p of parts) {
    if (p.type !== 'text') return parts
    texts.push((p as { text?: string }).text ?? '')
  }
  return texts.join('')
}

/**
 * 一块 DSH user/tool-result 内容序列化成 OpenAI content parts（text + image_url）。
 * 纯文本时返回空数组（上层走紧凑字符串路径）。图片转 base64 data URI；
 * attachments 缺失或读取失败时回退稳定占位文本（绝不静默丢图）。
 */
async function contentParts(
  blocks: ReadonlyArray<{ type: string }>,
  attachments: RouterAttachmentStore | undefined,
  signal: AbortSignal | undefined,
): Promise<Array<Record<string, unknown>>> {
  const parts: Array<Record<string, unknown>> = []
  for (const block of blocks) {
    if (block.type === 'text') {
      const text = (block as { text?: string }).text ?? ''
      if (text.length > 0) parts.push({ type: 'text', text })
      continue
    }
    if (block.type === 'image') {
      const ref = (block as unknown as { attachment: RouterImgLike }).attachment
      parts.push(...(await imageParts(ref, attachments, signal)))
      continue
    }
    if (block.type === 'tool-result') {
      parts.push(...(await contentParts((block as unknown as { content: ReadonlyArray<{ type: string }> }).content, attachments, signal)))
    }
    // 其它块（reasoning/tool-call）不属于 user content，忽略
  }
  return parts
}

/** 一张图片 → 一个 OpenAI image_url part（或读不到附件时的占位文本）。 */
async function imageParts(
  ref: { attachmentId: string; mediaType: string; bytes: number; width: number; height: number },
  attachments: RouterAttachmentStore | undefined,
  signal: AbortSignal | undefined,
): Promise<Array<Record<string, unknown>>> {
  if (attachments === undefined) return [{ type: 'text', text: imagePlaceholder(ref.attachmentId) }]
  try {
    const img = await attachments.readImageRequest(
      { attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height },
      { maxPixels: 64e4, maxBytes: 1024 * 1024 },
      signal,
    )
    return [{ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${bytesToBase64(img.data)}` } }]
  } catch {
    return [{ type: 'text', text: imagePlaceholder(ref.attachmentId) }]
  }
}

/** Uint8Array → base64（browser + node 双环境安全，不依赖 Buffer 全局）。 */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

/** 读不到图片字节时的稳定占位文本。 */
function imagePlaceholder(attachmentId: string): string {
  return `[image omitted because the attached bytes could not be read; attachment ${attachmentId}]`
}

/** 组装 wire 请求体。图片序列化需要读 attachments，故为异步。 */
async function wireRequest(options: GenerateOptions, attachments: RouterAttachmentStore | undefined): Promise<Record<string, unknown>> {
  const messages = await wireMessages(options, options.system, attachments)
  const body: Record<string, unknown> = {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }
  const tools = options.tools?.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
  if (tools !== undefined && tools.length > 0) body.tools = tools
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
  if (options.stop !== undefined) body.stop = options.stop
  applyReasoning(body, options.reasoningEffort)
  return body
}

/**
 * 推理强度 → CodeBuddy 的 OpenAI 风格参数。
 *
 * 照 9router `executors/codebuddy-cn.js` 的处理：CodeBuddy 只有同时收到
 * `reasoning_effort` + `reasoning_summary:"auto"` 才吐推理内容，而 harness
 * 只给 `reasoning_effort`，从不下发 `reasoning_summary`。
 *
 * 关键陷阱（9router 注释里的 #2071）：**不能无条件加**。对没要推理的普通
 * 请求强行加 `reasoning_effort:"medium"` + `reasoning_summary`，会让
 * CodeBuddy 触发内容过滤直接报错。`none`/`off` 也必须是**删字段**而不是传
 * `"none"` —— 网关没有这个值。
 */
function applyReasoning(body: Record<string, unknown>, effort: string | undefined): void {
  if (effort === undefined || effort === '') return
  if (effort === 'none' || effort === 'off') {
    delete body.reasoning_effort
    delete body.reasoning_summary
    return
  }
  body.reasoning_effort = effort
  body.reasoning_summary = 'auto'
}

function flattenText(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
}

interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  callId?: string
  name?: string
}

/** openai SSE payload → DSH StreamChunk 流。导出以便单测锁死 usage 契约。 */
/**
 * 把上游 SSE 的 `data:` 载荷流翻译成 DSH 的 StreamChunk 事件流。
 *
 * 吃 `AsyncIterable`（真流式：边收边吐）或 `Iterable`（测试用数组）。
 * 用 `for await` 是因为它天然兼容两者 —— 不必为流式再写一份。
 */
export async function* translateSse(payloads: AsyncIterable<string> | Iterable<string>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const toolBlocks = new Map<number, OpenBlock>()
  const order: OpenBlock[] = []
  let pendingFinish: { kind: string; failure?: unknown } | undefined
  /** 攒上游各帧的 usage（归一形态），[DONE] 时统一转成 DSH 契约。 */
  let accumulated: UsageTokens | null = null
  /** 解析失败的帧数（坏帧跳过，不硬抛；全是坏帧才当断流处理）。 */
  let malformed = 0
  /** 有没有产出过任何内容块（content/reasoning/tool-call）。 */
  let produced = false

  const open = (kind: OpenBlock['kind']): OpenBlock => {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' }
    order.push(block)
    produced = true
    return block
  }

  for await (const payload of payloads) {
    if (payload === '[DONE]') {
      // 收尾前先筛掉参数没发完的工具调用。
      //
      // 为什么必须筛：上游（CodeBuddy 网关）在长上下文/高压时会在 tool_call
      // 的 arguments **分片没发完**就直接发 `[DONE]`。无条件收尾会把半成品
      // JSON（如 `{"command": "cd`）当完整参数交给 harness，工具侧校验报
      // `missing required property "command"` / `"arguments" must be an object`，
      // 表现为「bash 调用大面积失败」。实测一次会话 29 次工具调用里 27 次
      // 参数残缺。残缺的调用**不能执行**——拿半条命令去跑比报错危险得多。
      const complete = order.filter((block) => block.kind !== 'tool-call' || completeJson(block.text))
      const dropped = order.length - complete.length
      for (const block of complete) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      }
      // 残缺的块**必须补发一个安全的 block-end**，光不发是不够的：
      // dsh-llm 的 BlockAssembler 对缺 block-end 的 index 会用累积的 delta
      // 兜底重建（lib/types/assembler.js），照样组装出 `{"command": "rm -rf /`
      // 这种半成品；而 assembled() 只在 finish.kind === 'max-tokens' 时过滤
      // tool-call —— EMPTY_RESPONSE 的 error finish 不过滤。
      // 补一个空名 + `{}` 的收尾，让它**覆盖**掉 delta 累积值。
      for (const block of order) {
        if (block.kind !== 'tool-call' || completeJson(block.text)) continue
        yield {
          type: 'block-end',
          index: block.index,
          block: { type: 'tool-call', id: ToolCallId(block.callId ?? ''), name: '', arguments: '{}' },
        }
      }
      if (dropped > 0) {
        // 整轮判 error：让 agent-loop 重试（拿残参执行是错的，静默装作成功更错）
        //
        // code 必须用 EMPTY_RESPONSE：只有 dsh-llm 默认可重试码白名单里的
        // 码才会触发重试（["EMPTY_RESPONSE","RATE_LIMIT","SERVER","TIMEOUT",
        // "TRANSPORT"]，maxRetries 5）。造一个新码（如 INCOMPLETE_TOOL_ARGS）
        // 看着更精确，但不在白名单里 → **一次都不重试**，直接抛给用户，
        // 正好毁掉这里重试的本意。语义也对得上：上游没产出可用的调用。
        pendingFinish = {
          kind: 'error',
          failure: {
            message: `upstream closed the stream before ${dropped} tool call argument${dropped > 1 ? 's were' : ' was'} complete`,
            code: EMPTY_RESPONSE_CODE,
          },
        }
      }
      if (accumulated !== null) {
        // 转成 DSH 的 TokenUsage：**必须**转，不能把上游的 OpenAI 形态
        // （prompt_tokens，且含缓存）原样透传。字段名和 DISJOINT 口径都
        // 对不上，下游 token-meter 读到 undefined 会累加出 NaN，投影
        // schema 校验一抛就是整条 session.history 失败（「历史加载失败」）。
        // 转换结果为 null（三个数全 0）则整个省略 usage。见 toTokenUsage。
        const usage = toTokenUsage(accumulated)
        if (usage !== null) yield { type: 'usage', usage }
      }
      const reason = pendingFinish ?? { kind: 'stop' }
      yield {
        type: 'finish',
        reason:
          reason.kind === 'stop' && order.length === 0
            ? { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } }
            : (reason as never),
      }
      return
    }
    let chunk: { choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string }>; usage?: unknown }
    try {
      chunk = JSON.parse(payload) as typeof chunk
    } catch {
      // 坏帧**跳过**，不要抛：一帧坏 JSON 毁掉整轮，已流式吐出的内容全废
      // （9router 也是 catch 后继续，见 mitm/handlers/base.js 的
      // "Skip unparseable lines"）。上游断流时最后一帧常常就是半截的，
      // 硬抛等于把可恢复的失败变成必失败 —— 而且 MALFORMED_RESPONSE 不在
      // dsh-llm 的可重试白名单里，抛了也一次都不重试。
      // 真的一帧都没解析成功时，流末按断流处理（见下方）。
      malformed += 1
      continue
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {}
      const reasoning = delta.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }
      const content = delta.content
      if (typeof content === 'string' && content.length > 0) {
        if (!textBlock) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }
      const toolCalls = delta.tool_calls as Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> | undefined
      for (const call of toolCalls ?? []) {
        const key = call.index ?? 0
        let block = toolBlocks.get(key)
        if (!block) {
          block = open('tool-call')
          toolBlocks.set(key, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        // 身份字段只认**非空字符串**。上游（OpenCode/Zen）在后续 delta 里会把
        // 首帧已给过的 id/name 显式重发成 `null`（不是省略、也不是空串）——
        // 实测帧形状：
        //   {"index":0,"id":"call_abc","function":{"name":"bash","arguments":""}}
        //   {"index":0,"id":null,   "function":{"name":null,  "arguments":"{"}}
        // 用 `!== undefined` 挡不住 null：它既会把首帧的 "bash"/"call_abc" **冲成
        // null**（工具名丢失），又会把 `name: null` 原样发进 StreamChunk，而
        // dsh-llm 的校验是 `typeof chunk.name !== 'string'`（Object.hasOwn 先判存在）
        // → 抛 `TypeError: tool-call-delta name must be a string` →「本轮运行失败」。
        // 判据与核心 aggregateSSE（非流式聚合路径）保持一致，两条路不能有分歧。
        if (typeof call.id === 'string' && call.id !== '') block.callId = call.id
        if (typeof call.function?.name === 'string' && call.function.name !== '') block.name = call.function.name
        // arguments 同理只认字符串：`?? ''` 挡得住 null/undefined，但挡不住
        // 上游偶发把参数发成对象/数字——那会撞 dsh-llm 的同一条校验。
        const fragment = typeof call.function?.arguments === 'string' ? call.function.arguments : ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: ToolCallId(block.callId ?? ''),
          ...(block.name !== undefined ? { name: block.name } : {}),
          argumentsDelta: fragment,
        }
      }
      if (typeof choice.finish_reason === 'string') {
        // 只认真的终止原因：上游（CodeBuddy）会在中间帧发 `finish_reason: ""`，
        // 它是「还没结束」而不是「以空原因结束」。当真原因收进来会被 mapFinishReason
        // 的 default 分支变成 code:"" 的 error finish，agent-loop 拿它重建
        // LlmError 时 dsh-llm 直接抛 `LlmError code must be a non-empty string`
        // —— 界面就是「本轮运行失败 … UNKNOWN」。空的不收，也不许它冲掉真原因。
        const mapped = mapFinishReason(choice.finish_reason)
        if (mapped !== undefined) pendingFinish = mapped
      }
    }
    // 上游可能把 usage 拆在多个帧里（Claude 系：先给输入、后给输出），
    // 所以是字段级 max 合并，不是覆盖。攒着，[DONE] 时统一转契约。
    if (chunk.usage !== undefined) accumulated = mergeUsage(accumulated, normalizeUsage(chunk.usage))
  }
  // 码必须是 TRANSPORT（不是自造的 STREAM_CLOSED / MALFORMED_RESPONSE）：
  // 只有 dsh-llm 默认可重试白名单里的码才会被重试（EMPTY_RESPONSE /
  // RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT）。自造码一次都不重试，
  // 断流就直接抛给用户 —— 而断流恰恰是**最该重试**的一类故障。
  const detail = malformed > 0 ? ` (${malformed} frame(s) unparseable)` : ''
  throw new LlmError(`SSE payload stream ended without [DONE]${detail}`, 'TRANSPORT')
}

/** 上游 finish_reason → DSH finish reason；空串（「未终止」）返回 undefined。 */
function mapFinishReason(reason: string): { kind: string; failure?: unknown } | undefined {
  switch (reason) {
    case '': return undefined
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    // 未知原因也要能过 dsh-llm 的 `code` 非空校验：万一上游给的是空白或
    // 纯符号（toUpperCase 后仍可能是怪东西），兜一个稳定码，别把空串交给
    // agent-loop —— 它拿 code 重建 LlmError，空码 = 抛「本轮运行失败」。
    default: {
      const code = reason.trim().toUpperCase()
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: code === '' ? 'UNKNOWN_FINISH_REASON' : code },
      }
    }
  }
}

function closeBlock(block: OpenBlock): never {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text } as never
    case 'reasoning': return { type: 'reasoning', text: block.text } as never
    case 'tool-call': return {
      type: 'tool-call',
      id: ToolCallId(block.callId ?? ''),
      name: block.name ?? '',
      // 空串 = 无参工具，合法（上游很多工具不吃参数）；补成 `{}` 让下游
      // 不必分支。能走到这里的必然是完整 JSON（残缺的已在 [DONE] 处拦掉）。
      arguments: block.text === '' ? '{}' : block.text,
    } as never
  }
}

/**
 * 工具调用的 arguments 是否已经收完整（能解析成一个 JSON 对象）。
 *
 * 判断口径刻意简单：只看能不能 `JSON.parse` 出对象。不校验 schema——
 * 那是工具自己的活，adapter 只负责「别把半成品交出去」。
 * 空串视为完整（无参工具），因为上游不发参数分片是合法的。
 */
function completeJson(text: string): boolean {
  if (text.trim() === '') return true
  try {
    const v: unknown = JSON.parse(text)
    return typeof v === 'object' && v !== null && !Array.isArray(v)
  } catch {
    return false // 分片没发完，JSON 必然解析失败
  }
}

/**
 * DSH adapter：provider `router`。模型目录 = 组合；stream 转发到本插件
 * /v1/chat/completions（组合路由在 /v1 内完成）。
 */
/** Router provider 对外暴露的推理等级（对齐 dsh/DeepSeek：off/low/high/max）。 */
const ROUTER_REASONING_EFFORTS: readonly LlmReasoningEffortInfo[] = [
  { id: ReasoningEffortId('off'), name: 'Off' },
  { id: ReasoningEffortId('low'), name: 'Low' },
  { id: ReasoningEffortId('high'), name: 'High' },
  { id: ReasoningEffortId('max'), name: 'Max' },
]

export class RouterAdapter extends LlmAdapter {
  private readonly baseURL: string
  private readonly source: RouterAdapterSource
  private readonly resolveAttachments: () => RouterAttachmentStore | undefined
  /** 流空闲超时（ms）：上游这么久不吐字节就判 TIMEOUT。 */
  private readonly idleTimeoutMs: number

  /**
   * @param idleTimeoutMs 流空闲超时；缺省用生产值（300s，对齐 pi-ai）。
   *   可注入只为测试能压到几百毫秒，生产不传。
   */
  constructor(
    baseURL: string,
    source: RouterAdapterSource,
    resolveAttachments?: () => RouterAttachmentStore | undefined,
    idleTimeoutMs: number = STREAM_IDLE_TIMEOUT_MS,
  ) {
    super()
    this.baseURL = baseURL
    this.source = source
    this.resolveAttachments = resolveAttachments ?? (() => undefined)
    this.idleTimeoutMs = idleTimeoutMs
  }

  providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: 'Router' }
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    const combos = await this.source.comboModels()
    const seen = new Set<string>()
    const out: LlmModelInfo[] = []
    for (const m of combos) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      out.push({ provider: 'router', id: m.id, name: m.name ?? m.id })
    }
    return out
  }

  /**
   * 声明图文：`inputModalities` 必须同时含 `text` 与 `image`。
   * - 含 `image`：runtime/subagent 的模态门禁放行（不再抛
   *   `MODEL_DOES_NOT_SUPPORT_IMAGES` = 界面「当前模型不支持图片」），
   *   `projectImagesForTextModel` 也不会把图片块投影成占位文本。
   * - 组合背后是异构供应商，**统一声明图片能力**；真正能否看图取决于命中
   *   的某个上游模型（供应商各模型 capability 不同，网关端不能一刀切拦截）。
   */
  private static readonly INPUT_MODALITIES: readonly ModelModality[] = ['text', 'image']

  async resolveModel(_provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const combos = await this.source.comboModels()
    const found = combos.find((m) => m.id === model || m.name === model)
    const name = found?.name ?? found?.id ?? model
    // 组合背后是异构供应商，统一声明 dsh 推理等级；实际能否生效取决于
    // 命中的上游（供应商各有各自的映射/忽略规则，见 applyReasoning + chatOnce(lv)）。
    // 默认 High：调用方不指定 effort 时，runtime 会物化为 'high' 下发。
    return {
      provider: 'router',
      id: model,
      name,
      inputModalities: RouterAdapter.INPUT_MODALITIES,
      ...(found?.contextWindow !== undefined ? { context: { contextWindow: found.contextWindow } } : {}),
      reasoning: { efforts: ROUTER_REASONING_EFFORTS, defaultEffort: ReasoningEffortId('high') },
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const body = await wireRequest(options, this.resolveAttachments())
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    let resp: Response
    try {
      resp = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        // attributionHeaders() 是 dsh-llm 对 adapter 的硬契约：每个 provider
        // 请求都必须带（LlmAdapter 类注释原话）。它给出
        // `user-agent: deepseek-harness/<ver> (+url)`。
        headers: {
          ...attributionHeaders(),
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      options.signal?.removeEventListener('abort', onAbort)
      throw new LlmError(`dsh-router upstream call failed: ${(error as Error).message}`, 'TRANSPORT', { cause: error })
    }
    // **监听必须活到整条流结束**，不能在 fetch 返回时就摘：`controller.signal`
    // 已经把传入的 signal 与这次 fetch 绑在一起（含 body 流），响应头到手后
    // body 还在读，此时调用方取消（用户中断 / agent-loop 收敛 / 上游停摆被
    // 上层超时放弃）必须还能 abort 掉这次请求 —— 摘早了，body 读就无人打断，
    // 请求永久挂住、连接也收不回（issue #6「内置供应商才挂死」的另一半）。
    try {
      if (!resp.ok) {
        const detail = await resp.text().catch(() => '')
        throw new LlmError(`dsh-router /v1 returned ${resp.status}: ${detail.slice(0, 200)}`, 'TRANSPORT')
      }
      if (resp.body === null) return
      yield* translateSse(ssePayloads(resp.body, this.idleTimeoutMs))
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }
  }
}

/**
 * 已攒的 payload 是否已经是完整的（`[DONE]` 或一个能解析的 JSON 对象）。
 *
 * 只用于「缺空行分隔」时的前瞻回退，不校验业务结构 —— 那是 translateSse 的事。
 */
function looksComplete(payload: string): boolean {
  if (payload === '[DONE]') return true
  try {
    JSON.parse(payload)
    return true
  } catch {
    return false
  }
}

/**
 * 从上游响应体**增量**产出 SSE 的 `data:` 载荷。
 *
 * 为什么必须逐块读：曾经这里写 `await resp.text()` 攒完整串再解析，等于
 * 把流式降级成批处理 —— 首字节延迟等于整个响应耗时；更糟的是中途断流时
 * resp.text() 只拿到半截文本，最后一帧是半截 JSON（`{"command": "cd`），
 * 表现为「工具参数残缺」。短响应连接不断，所以本地抓包复现不了。
 *
 * 跨块边界：一个 `data:` 行可能横跨两次 read()，所以留 `buffer` 接住
 * 最后一段未完整的行（9router 的 pipeTransformedSSE 同样处理）。
 */
async function* ssePayloads(body: ReadableStream<Uint8Array>, idleTimeoutMs: number): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let buffer = ''
  /** 攒一帧内的多行 data（SSE 规范：多行用 \n 连起来）。**必须**是局部
   *  状态 —— 放模块级会让并发请求互相串数据。 */
  let payload = ''
  /**
   * 带**空闲超时**的读：上游连上后若长时间一个字节都不吐，就读穿不了 ——
   * 没有超时的话这里会永久挂着，连接和 in-flight 请求都收不回。
   *
   * 为什么必须有（issue #6 的另一半）：`dsh-llm-pi-ai`（自定义供应商走的那条
   * openai-completions adapter）有 `idleWatchdog`，默认 **300s** 空闲即
   * `LLM_STREAM_IDLE_TIMEOUT` 中止；而本 adapter 此前**没有任何超时**，只靠
   * 调用方的 `options.signal`。于是同一个组合，走内置 Router 时上游一停摆就
   * 永久挂住（占用连接、且该请求永不收尾），走自定义供应商时 300s 后被放弃
   * —— 放弃又会触发服务端那条「客户端断开不回收」的泄漏路径，两边叠加就是
   * 「用久了报 connection error」。
   *
   * 只守**空闲**、不设总时长：长生成可以跑很久，只要还在吐块就不该被打断
   * （总时长封顶会让长回答写到一半被砍）。
   */
  const readWithIdleTimeout = (): Promise<ReadableStreamReadResult<Uint8Array>> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new LlmError(`dsh-router upstream stream idle for ${idleTimeoutMs}ms`, 'TIMEOUT')),
        idleTimeoutMs,
      )
      reader.read().then(
        (r) => { clearTimeout(timer); resolve(r) },
        (e) => { clearTimeout(timer); reject(e) },
      )
    })
  try {
    for (;;) {
      const { done, value } = await readWithIdleTimeout()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? '' // 最后一段可能没换行，留给下一块
      for (const line of lines) {
        const t = line.trim()
        if (t.startsWith('data:')) {
          // 前瞻回退：部分上游不发空行分隔，直接连着发下一帧。这时若已攒的
          // payload 本身是个完整 JSON，就先把它交出去 —— 否则两帧会被拼成
          // `{...}\n{...}` 而 parse 失败，整轮报废（9router 逐行取，天然
          // 没这问题；我们按空行分帧，就得补这个回退）。
          if (payload.length > 0 && looksComplete(payload)) {
            yield payload
            payload = ''
          }
          payload += (payload.length > 0 ? '\n' : '') + t.slice(5).trimStart()
          continue
        }
        // 空行 = 一帧结束
        if (t === '' && payload.length > 0) {
          yield payload
          payload = ''
        }
      }
    }
    // 流正常结束：末尾没换行的内容也要收（可能有最后一帧）
    if (buffer.length > 0) {
      const t = buffer.trim()
      if (t.startsWith('data:')) payload += (payload.length > 0 ? '\n' : '') + t.slice(5).trimStart()
    }
    if (payload.length > 0) yield payload
  } finally {
    // 释放锁**之后还必须 cancel**：releaseLock() 只解除 JS 侧的 reader 绑定，
    // 不通知传输层 —— 上游那条 TCP 连接和 in-flight 请求会原样挂着。
    // dsh-llm 在消费者提前退出时必走 `iterator.return()`（用户取消 /
    // agent-loop 收敛 / 异常），于是每次中断泄漏一条到本地路由器的连接；
    // 长会话下 fd 耗尽 → ECONNRESET / 端口耗尽。
    // 顺序不能反：cancel() 要求没有活跃 reader，所以先 releaseLock。
    try { reader.releaseLock() } catch { /* 有待定 read 时会抛，忽略 */ }
    await body.cancel().catch(() => {})
  }
}
