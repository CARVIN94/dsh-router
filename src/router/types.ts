/**
 * 供应商（supplier）抽象 —— dsh-router 路由器本体对接的外部通道。
 * 每个供应商提供 OpenAI 兼容的 chat/models，并暴露面板状态。
 * 仿 9router：供应商 = 一种"免费/付费"通道；dsh-router 在其上做路由。
 */
import type { AccountState, ChatOnceResult, SupplierAccountNow } from '../suppliers/contract.ts'
import type { AccountPool } from './account-pool.ts'
import type { ProtocolId } from '../protocol/types.ts'

/** 面板展示的账号状态（脱敏）。 */
export interface SupplierAccount {
  uid: string
  nickname?: string
  credits: number
  /**
   * 插件解读上游信号后的语义状态（`quota` = 额度/积分用完，`session_dead` = 凭证失效）。
   *
   * `decorate()` 一直原样带出插件报的状态，核心选号也读它（`quota`/`session_dead`
   * 的号不进候选）——面板类型里缺了这一格就会自相矛盾：号明明已被排除在路由之外，
   * 界面上却只看得到「0 积分」，看不出它为什么不参与。
   */
  state?: AccountState
  cooling: boolean
  until?: string
  reason?: string
  err_count?: number
}

/** 供应商面板状态。 */
export interface SupplierStatus {
  id: string
  name: string
  accounts: SupplierAccount[]
}

/** OpenAI 模型条目。 */
export interface ModelInfo {
  /** 上游的模型 key（**唯一标识**：组合存它、路由认它、上游收它）。 */
  id: string
  /**
   * 可读名（上游自己写的，如 `Qwen3.8-Max`）。**只用于显示**，缺省 = `id`。
   *
   * 为什么需要它：有些上游的 key 是内部标识（Qoder 的 `qmodel_38max`、
   * `kmodel_latest`），面板上只剩一串猜不出含义的字母。既然上游在目录里
   * 同时下发了 `display_name`，丢掉它就是把可读信息换成噪声。
   * 反过来，**凡是"发给上游/存下来"的地方都得继续用 `id`**——用名字去请求
   * 上游只会拿到 404。
   */
  name?: string
  context_length?: number
}

/** 面板展示的模型（含启用状态）。 */
export interface ModelWithEnabled extends ModelInfo {
  enabled: boolean
  /** 是否为自定义模型（可删除）。 */
  custom?: boolean
}

/** 组合：命名的一组模型，路由时作为**降级链**按序尝试（无策略旋钮）。 */
export interface Combo {
  id: string
  name: string
  models: string[]
}

/** 一次 /v1/chat/completions 请求。 */
export interface ChatRequest {
  /** 原始请求体 JSON 字符串。 */
  rawBody: string
  stream: boolean
  model: string
  /** 推理等级（reasoning effort），供应商各自决定怎么映射到上游。缺省 = 'auto'。 */
  lv?: string
  /**
   * 调用方身份（归因键）。来源两种：
   *   1. 宿主会话身份（dsh-llm `GenerateOptions.sessionId`，adapter 转成内部头
   *      `x-dsh-router-session`）——形式 `session-<uuid>`；
   *   2. 外部 OpenAI 兼容客户端的 `user` 字段（Zed/IDE 等多客户端场景）——形式
   *      `ext:<user>`，前缀标明「这不是宿主会话」。
   * 用途：把用量记录**按调用方归因**（「最近命中」徽章按当前会话显示；出事时
   * 能反查是哪个客户端在打）。缺省 = 匿名外部客户端。
   */
  session?: string
  /**
   * 客户端说的协议（入站）。
   *
   * 缺省 `'chat'`（今天所有入口的现状）。四种协议（chat / anthropic /
   * responses / gemini）在入站路由上就被翻成规范形态，所以**核心与供应商
   * 只认 chat**；这个字段存在的理由是让用量记录与日志能说出「客户端原本
   * 说的哪种协议」，排查「Claude Code 打过来为什么不通」时省一次猜。
   */
  protocol?: ProtocolId
}

/**
 * 供应商接口。核心负责账号池（选号/冷却/禁用/错误累计/遍历回退），
 * 供应商只对**单个账号**调一次上游并报告结果，不碰 res。
 */
export interface Supplier {
  readonly id: string
  readonly name: string
  /** 优先级：数字越小越优先（免费通道优先）。 */
  readonly priority: number
  /** 图标（URL 或 SVG data URI），面板供应商卡片显示。可选。 */
  readonly icon?: string
  /** 「添加 API key」弹窗提示文案（缺省前端用通用文案）。可选。 */
  readonly apiKeyHint?: string
  status(): SupplierStatus
  listModels(force?: boolean): Promise<ModelInfo[]> | ModelInfo[]
  /** 面板展示的模型（含启用/自定义标记）。 */
  modelsWithEnabled(): Promise<ModelWithEnabled[]> | ModelWithEnabled[]
  /** 供应商前缀（模型完整名 = alias/id）。 */
  getAlias(): string
  /** 用户手动添加的模型 id（可选，/v1/models 用它聚合自定义模型）。 */
  customModelIds?(): string[]
  /** 账号「现在状态」（从 status() 派生，插件只报它观察到的）。空 = 无账号供应商。 */
  accounts(): SupplierAccountNow[]
  /** 对单个账号调一次上游。不遍历账号、不管冷却、不写 res。 */
  chatOnce(uid: string, lv: string, req: ChatRequest): Promise<ChatOnceResult>
  /**
   * 上游说哪种协议（缺省 `'chat'`）。
   *
   * 声明成别种时，核心在 `chatOnce` 前后各做一次翻译：请求体翻成该协议、
   * 响应流翻回 OpenAI SSE。于是**插件实现里永远只看见 OpenAI 形态**，
   * 契约不变 —— 一个只会说 Anthropic 的上游可以接一个只写了几行 fetch 的
   * 插件，路由/选号/冷却/用量全都照旧。
   */
  readonly wire?: ProtocolId
  /** 删除链接（清理凭证；内部能力，js 契约不要求实现）。 */
  removeLink?(uid: string): Promise<boolean>
  dispose(): void
  /** 该供应商的账号池（核心持有：选号/冷却/禁用/错误累计）。 */
  readonly pool: AccountPool
}
