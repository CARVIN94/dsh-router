/**
 * 供应商（supplier）抽象 —— dsh-router 路由器本体对接的外部通道。
 * 每个供应商提供 OpenAI 兼容的 chat/models，并暴露面板状态。
 * 仿 9router：供应商 = 一种"免费/付费"通道；dsh-router 在其上做路由。
 */
import type { ChatOnceResult, SupplierAccountNow } from '../suppliers/contract.ts'
import type { AccountPool } from './account-pool.ts'

/** 面板展示的账号状态（脱敏）。 */
export interface SupplierAccount {
  uid: string
  nickname?: string
  credits: number
  cooling: boolean
  until?: string
  reason?: string
  disabled: boolean
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
  id: string
  context_length?: number
}

/** 面板展示的模型（含启用状态）。 */
export interface ModelWithEnabled extends ModelInfo {
  enabled: boolean
  /** 是否为自定义模型（可删除）。 */
  custom?: boolean
}

/** 组合策略：fallback = 按顺序尝试；round-robin = 轮转。 */
export type ComboStrategy = 'fallback' | 'round-robin'

/** 组合：命名的一组模型，路由时按策略（回退/轮询）命中其中一个。 */
export interface Combo {
  id: string
  name: string
  strategy: ComboStrategy
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
  /** 删除链接（清理凭证；内部能力，js 契约不要求实现）。 */
  removeLink?(uid: string): Promise<boolean>
  dispose(): void
  /** 该供应商的账号池（核心持有：选号/冷却/禁用/错误累计）。 */
  readonly pool: AccountPool
}
