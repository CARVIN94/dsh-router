/**
 * 协议矩阵的**规范形态**（canonical form）与编解码契约。
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么内部只留一种形态
 * ════════════════════════════════════════════════════════════════════
 * 四种协议两两互转是 4×3 = 12 条路径，逐条实现必然长出一打互相不一致的
 * 实现。收敛成「全部先转成同一个规范形态、再从规范形态转出去」之后：
 *
 *     外来请求 ──decode──┐                ┌──encode── 外来响应
 *                        ├─ 规范形态 ────┤
 *     供应商请求 ◀─encode─┘                └─decode──▶ 供应商响应
 *
 * 只需要 N 个协议模块（N=4），而不是 N² 条翻译路径；新增第五种协议只是再加
 * 一个模块，已有路径一行不改。
 *
 * 规范形态选 **OpenAI Chat Completions**（请求体）与**一组扁平事件**（响应流），
 * 不是随便挑的：供应商契约（`suppliers/contract.ts` 的 `chatOnce`）今天就是
 * 「吃 Chat Completions 请求体、吐 OpenAI SSE」，选别的形态等于把每个已装
 * 供应商插件都改一遍。
 *
 * 天花板：规范形态只覆盖**能表达的部分**。各家私有的、没有对应概念的东西
 * （Anthropic 的 `cache_control`、Responses 的 `previous_response_id`、
 * Gemini 的 `safetySettings`）在跨协议时会被**丢掉**，不是被翻译。每条丢弃
 * 在对应模块的注释里点名。
 */

/** 四种协议。`chat` 是规范形态本身，因此它的编解码是恒等变换。 */
export type ProtocolId = 'chat' | 'anthropic' | 'responses' | 'gemini'

/** 所有协议 id（顺序 = 文档与面板展示顺序）。 */
export const PROTOCOL_IDS: readonly ProtocolId[] = ['chat', 'anthropic', 'responses', 'gemini']

/** 宽松 JSON 对象（外来请求体一律不可信，逐字段校验）。 */
export type JsonObject = Record<string, unknown>

/** 编解码时需要知道的上下文。 */
export interface CodecContext {
  /**
   * 请求里声明的模型名（已剥掉本插件的 `alias/` 前缀）。
   *
   * 有些协议把模型名放在 URL 路径里（Gemini 的
   * `/v1beta/models/<model>:generateContent`），有些放在请求体里；模块统一从
   * 这里取，不各自去猜。
   */
  model: string
  /** 客户端是否要流式。 */
  stream: boolean
  /**
   * 收尾原因（仅 `endFrames` 会读）。
   *
   * 有些协议的收尾帧要**同时**带状态与用量（Responses 的 `response.completed`
   * 里 `status: 'completed' | 'incomplete'` 决定 Codex 是否认为被截断），
   * 而 `finish` 事件本身在这些协议里没有独立帧可发 —— 于是原因必须通过
   * 上下文传进 `endFrames`，不能只靠「收到过 finish 事件」这个事实。
   */
  finish?: FinishReason
  /** 累计用量（仅 `endFrames` 会读，同上：Responses 只在收尾帧给 usage）。 */
  usage?: { promptTokens: number; completionTokens: number; cachedTokens: number }
}

/**
 * 规范形态的**流式事件**。
 *
 * 刻意做得很小：只要四家能无损落进来的都在这，落不进来的都不在。工具调用用
 * `tool-start` + `tool-args` 两段表达（各家都是「先给名字、再给参数增量」，
 * 只有 Gemini 把参数整块给一次 —— 它在 decode 时拆成一段即可）。
 */
export type ChatEvent =
  /** 可见文本增量。 */
  | { type: 'text'; text: string }
  /** 推理过程增量（`reasoning_content` / `thinking` / `thought`）。 */
  | { type: 'reasoning'; text: string }
  /** 一个工具调用的开始（名字先到，参数随后）。同一 index 只发一次。 */
  | { type: 'tool-start'; index: number; id?: string; name?: string }
  /** 工具调用的参数**增量**（JSON 片段，逐段拼接后才是完整参数）。 */
  | { type: 'tool-args'; index: number; delta: string }
  /** 收尾原因。一条流最多一个，且必须是最后一个内容事件。 */
  | { type: 'finish'; reason: FinishReason }
  /** 用量。多数上游在最后一帧才给。 */
  | { type: 'usage'; promptTokens: number; completionTokens: number; cachedTokens: number }
  /** 上游在流内报的错（HTTP 200 + 流内 error 是真实存在的形态）。 */
  | { type: 'error'; message: string }

/** 收尾原因（规范形态）。 */
export type FinishReason = 'stop' | 'length' | 'tool-calls' | 'content-filter' | 'error'

/**
 * 一条流里的编解码会话状态。
 *
 * 刻意做成**不透明的空接口 + 可选**：绝大多数协议（chat / Anthropic /
 * Responses）逐帧无状态，不需要它；只有 Gemini 这类「用名字而非 index 指代
 * 工具」的协议需要跨帧记住名字↔index。让它可选，是为了不给无状态协议强加
 * 一个空对象参数。
 */
export interface CodecSession {
  /** 会话内的临时槽位（各协议自己的形状，核心不解读）。 */
  readonly state?: unknown
  /**
   * 本流已累计的用量。
   *
   * 为什么编码器需要它：有的协议把「收尾原因」与「输出用量」绑在**同一帧**
   * （Anthropic 的 `message_delta`），而 finish 事件本身不带 usage。不给这个
   * 槽位，收尾帧只能写 `output_tokens: 0` 或者再多发一帧 —— 后者会让客户端
   * 取到第一个（占位）值，把用量读成 0（2026-10-21 在 3080 实测到）。
   */
  readonly usage?: { promptTokens: number; completionTokens: number; cachedTokens: number }
}

/**
 * 一个协议的编解码器。
 *
 * 四个方法分成两组，两组都必须实现 —— 少了任何一组就只能单向，而「双向互转」
 * 正是这个模块存在的理由：
 *   - `toChat*`：**入站**用。客户端说这个协议，我们得听懂它、并用它回答。
 *   - `fromChat*`：**出站**用。供应商说这个协议，我们得用它的语言请求、并把
 *     它的回答翻回规范形态。
 */
export interface ProtocolCodec {
  readonly id: ProtocolId

  /**
   * 一条流的编解码会话。
   *
   * 部分协议是**有状态**的：Gemini 的 `functionCall` 靠工具名认，而规范形态
   * 靠 index，跨帧必须有映射；映射若放模块级就会串请求（并发两条流各自的
   * `ls` 抢同一个 index，或上一条流的残留映射漏到下一条）。
   *
   * 所以状态由调用方在**请求边界**建一次、在整条流里传给每一帧：
   *   - `translateStream` / `StreamState` 在一次转码里建一个；
   *   - 单帧转换（测试、非流式一次性）可以不传，此时每帧各建一份 —— 结果
   *     等价于无状态，代价只有一次 Map 分配。
   */
  createSession?(): CodecSession

  /** 外来请求体 → 规范请求体。`chat` 是恒等。 */
  toChat(body: JsonObject, ctx: CodecContext): JsonObject

  /** 规范请求体 → 外来请求体。`chat` 是恒等。 */
  fromChat(body: JsonObject, ctx: CodecContext): JsonObject

  /**
   * 外来响应流的**单帧**解码：一帧 SSE 载荷（已剥掉 `data:` 前缀）→ 0..n 个
   * 规范事件。`[DONE]` 与无法识别的帧返回空数组，**不抛**：一条坏帧不该让
   * 整轮响应作废（上游发半截 JSON 是常态，见 `llm/adapter.ts` 的同类处理）。
   *
   * @param frame SSE 的 `data:` 载荷原文；`[DONE]` 由调用方过滤，不会传进来。
   * @param event 该帧的 `event:` 名（Anthropic 用它区分事件类型；其余协议为空）。
   */
  decodeFrame(frame: string, event?: string, session?: CodecSession): ChatEvent[]

  /**
   * 规范事件 → 0..n 个外来 SSE 帧。
   *
   * 返回的是**完整帧**（含 `event:`/`data:` 行与结尾空行），调用方只管拼字节。
   * 做成整帧而不是载荷，是因为 Anthropic 这类协议每个事件都要带 `event:` 行，
   * 让编码器自己拼比让调用方猜事件名干净。
   */
  encodeFrame(event: ChatEvent, session?: CodecSession): string[]

  /**
   * 非流式响应体的解码：整个 JSON body → 规范事件列表。
   *
   * 与 `decodeFrame` 同构（同样返回事件列表），区别只在输入是**一个完整的
   * 响应对象**而不是一帧增量。两种都必须实现：客户端可能发 `stream:false`，
   * 供应商也可能只给 JSON（有些上游对短请求直接回非流式）。
   */
  decodeJson(body: JsonObject): ChatEvent[]

  /**
   * 规范事件 → 非流式响应体。
   *
   * 与 `encodeFrame` 同构：把攒起来的事件折成一个完整响应对象。
   * `events` 里最多一个 `finish`、一个 `usage`，其余是内容。
   */
  encodeJson(events: ChatEvent[], ctx: CodecContext): JsonObject

  /**
   * 流开始时的一次性帧（Anthropic 的 `message_start`、Responses 的
   * `response.created`）。恒等协议返回空数组。
   */
  startFrames(ctx: CodecContext): string[]

  /**
   * 流结束时的一次性帧（`message_stop`、`response.completed`、`[DONE]`）。
   * 与 `startFrames` 对称；`finish` 事件本身走 `encodeFrame`。
   *
   * 带上 `session` 是因为有的协议**必须**在流末才发得出东西：Gemini 的
   * `functionCall` 是「名字+完整参数」一个 part，而上游逐帧发参数增量，
   * 只能攒到流末（见 gemini.ts 的 endFrames）。
   */
  endFrames(ctx: CodecContext, session?: CodecSession): string[]
}

/** 是否为已知协议 id。 */
export function isProtocolId(v: unknown): v is ProtocolId {
  return typeof v === 'string' && (PROTOCOL_IDS as readonly string[]).includes(v)
}

/* ------------------------------------------------------------------ */
/* 小工具：外来 JSON 一律不可信，取字段全部走这里                       */
/* ------------------------------------------------------------------ */

/** 取对象字段（不是对象则 undefined）。 */
export function obj(v: unknown): JsonObject | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as JsonObject) : undefined
}

/** 取数组字段（不是数组则 undefined）。 */
export function arr(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined
}

/** 取非空字符串字段。 */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/** 取有限数字字段。 */
export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** 取布尔字段。 */
export function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

/** 把 `finish` 原因在各协议间对齐（各家词汇不同，这里是唯一的对照表）。 */
export function finishOf(v: unknown): FinishReason {
  switch (v) {
    case 'length':
    case 'max_tokens':
    case 'MAX_TOKENS':
      return 'length'
    case 'tool_calls':
    case 'tool_use':
    case 'function_call':
      return 'tool-calls'
    case 'content_filter':
    case 'SAFETY':
    case 'safety':
      return 'content-filter'
    case 'error':
      return 'error'
    default:
      return 'stop'
  }
}
