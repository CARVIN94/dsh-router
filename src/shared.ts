/**
 * Shared constants and wire types for dsh-router.
 *
 * Pure values — no framework imports — so the host (tsdown ESM) and the
 * client (vite CJS browser bundle) can both inline them safely.
 */

/** The sidebar entry / panel dataset attribute family name. */
export const ROUTER_ENTRY_SELECTOR = '[data-dsh-router-entry]'

/** The center-column takeover panel attribute. */
export const ROUTER_VIEW_SELECTOR = '[data-dsh-router-view]'

/** Active-state attribute on <html> that shows the panel. */
export const ROUTER_ACTIVE_ATTR = 'data-dsh-router-active'

/** The panel's visible title (also the sidebar entry label). */
export const ROUTER_TITLE = '路由'

/** Same-origin API base the client panel fetches (host half serves it). */
export const ROUTER_API_BASE = '/router/api'

/** Bearer key env / credential reference protecting /v1/*. */
export const API_KEY_REF = 'TW2A_API_KEY'

/** One account row from `/router/api/status`. */
export interface RouterAccount {
  uid: string
  nickname?: string
  credits: number
  cooling: boolean
  until?: string
  reason?: string
  disabled: boolean
  err_count?: number
  /** 所属供应商 id。 */
  supplier?: string
}

/** `/router/api/status` response. */
export interface RouterStatusResponse {
  ok: boolean
  error?: string
  accounts?: RouterAccount[]
}

/** `/router/api/models` response. */
export interface RouterModelsResponse {
  ok: boolean
  error?: string
  models?: Array<{ id: string; context_length?: number }>
}

/** `/router/api/health` response. */
export interface RouterHealthResponse {
  ok: boolean
  suppliers?: Array<{
    id: string
    name: string
    /** 图标（URL 或 SVG data URI）。 */
    icon?: string
    /** 面板能力集合（登录/签到/连接池/模型管理等，按存在性）。 */
    capabilities?: string[]
    /** 来源：内置 / 用户目录 / 外部插件。 */
    source?: 'builtin' | 'user' | 'external'
  }>
  error?: string
}

/** 组合策略。 */
export type RouterComboStrategy = 'fallback' | 'round-robin'

/** 组合。models = 该组合命中的模型列表（裸模型 id，展示时动态拼前缀）。 */
export interface RouterCombo {
  id: string
  name: string
  strategy: RouterComboStrategy
  models: string[]
}

/** `/router/api/combos` response. */
export interface RouterCombosResponse {
  ok: boolean
  error?: string
  combos?: RouterCombo[]
  /** 可用模型（按供应商分组，仅启用），面板加模型用。 */
  groups?: RouterComboSupplierGroup[]
  /** 供应商前缀信息（组合模型全名 = alias/id，展示时动态拼接）。 */
  aliases?: RouterComboAlias[]
}

/** 组合页供应商前缀信息。 */
export interface RouterComboAlias {
  id: string
  name: string
  alias: string
}

/** 组合页可用模型分组（一个供应商一组）。 */
export interface RouterComboSupplierGroup {
  supplier: { id: string; name: string; alias: string }
  models: RouterSupplierModel[]
}

/** 库内一条 key（列表含完整 key，客户端脱敏显示）。 */
export interface RouterKey {
  id: string
  name: string
  key: string
  masked: string
  isActive: boolean
  createdAt: string
}

/** `/router/api/keys` response. */
export interface RouterKeysResponse {
  ok: boolean
  error?: string
  keys?: RouterKey[]
}

/** `/router/api/settings` response. */
export interface RouterSettingsResponse {
  ok: boolean
  error?: string
  requireApiKey?: boolean
}

/** 供应商模型（含启用状态）。 */
export interface RouterSupplierModel {
  id: string
  context_length?: number
  enabled: boolean
  /** 是否为自定义（手动添加 / 拉取）模型，可删除。 */
  custom?: boolean
}

/** `/router/api/suppliers/:id/models` response. */
export interface RouterSupplierModelsResponse {
  ok: boolean
  error?: string
  /** 供应商前缀（模型全名 = alias/id）。 */
  alias?: string
  models?: RouterSupplierModel[]
}

/** `/router/api/suppliers/:id/login` response. */
export interface RouterLoginResponse {
  ok: boolean
  error?: string
  loginUrl?: string
}

/* ---------------- 概览看板（用量统计） ---------------- */

/** 面板周期。 */
export type RouterPeriod = 'today' | '24h' | '7d' | '30d'

/** 一条请求明细（面板「最近请求」）。 */
export interface RouterUsageRecord {
  ts: number
  supplier: string
  model: string
  /** 客户端原始请求的 model（组合场景下就是组合名）。 */
  requested: string
  ok: boolean
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  /** 输入是估算的（上游没发 usage）。 */
  inputEstimated: boolean
  /** 输出是估算的。 */
  outputEstimated: boolean
  durationMs: number
  /** 首字节延迟（ms）；非流式为 0。 */
  ttfbMs: number
  error?: string
}

/** Top 榜一行。 */
export interface RouterRankRow {
  name: string
  requests: number
  ok: number
  failed: number
  promptTokens: number
  completionTokens: number
  lastTs: number
}

/** `/router/api/stats` response. */
export interface RouterStatsResponse {
  ok: boolean
  error?: string
  period?: RouterPeriod
  requests?: number
  okCount?: number
  failed?: number
  promptTokens?: number
  completionTokens?: number
  cachedTokens?: number
  /** 平均耗时（ms）。 */
  avgDurationMs?: number
  /** 平均首字节延迟（ms）。 */
  avgTtfbMs?: number
  /** 输入/输出为估算的请求数（面板据此提示）。 */
  estimatedInputs?: number
  estimatedOutputs?: number
  /** 累计请求数（不受周期影响）。 */
  lifetime?: number
  bySupplier?: RouterRankRow[]
  byModel?: RouterRankRow[]
  byRequested?: RouterRankRow[]
  recent?: RouterUsageRecord[]
}

/** `/router/api/stats/chart` 一桶。 */
export interface RouterChartBucket {
  label: string
  requests: number
  tokens: number
}

/** `/router/api/stats/chart` response. */
export interface RouterChartResponse {
  ok: boolean
  error?: string
  chart?: RouterChartBucket[]
}
