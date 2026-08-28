/**
 * 通用供应商契约 —— 供应商 js 只需 export 一个满足本契约的对象/类实例。
 *
 * 分工：
 *   - 通用能力（连接池排序/策略、模型启用/自定义、别名）由 dsh-router 核心
 *     SupplierConfigStore 统一管理，供应商 js 不需要实现。
 *   - 可插拔 js 模块只提供**差异化能力**：如何列模型/调上游/登录/签到等。
 *
 * 用户自定义供应商 js 放到 `~/.dsh/profiles/web/suppliers/*.js`，重启后自动加载。
 * 内置供应商与用户 js 同构（差异化能力驱动）。
 */
import type { ServerResponse } from 'node:http'
import type { ChatRequest, ModelInfo, SupplierAccount, SupplierStatus } from '../router/types.ts'
import type { SupplierConfigStore } from '../supplier-config.ts'
import type { CredentialStore } from '../credential-store.ts'

/** 供应商配置：loader 注入的运行时环境。 */
export interface SupplierEnv {
  /** 数据目录（state.json / keys.json 所在目录）。 */
  dataDir: string
  /** 日志。 */
  log: (msg: string) => void
  /** 通用配置存储（连接池/模型管理/别名/签到规则，核心统一管）。 */
  store: SupplierConfigStore
  /** 通用凭证存储（账号凭证，核心统一管）。 */
  credentials: CredentialStore
}

/** 通用供应商工厂：一个 js 模块 export 它（或 default export 它），loader 调用得到实例。 */
export type SupplierFactory = (env: SupplierEnv) => SupplierModule

/** 供应商模块 —— 契约（核心必须，差异化可选）。 */
export interface SupplierModule {
  /** 供应商唯一 id（小写字母数字 - _）。 */
  readonly id: string
  /** 显示名。 */
  readonly name: string
  /** 优先级：数字越小越优先（免费通道优先）。 */
  readonly priority?: number
  /** 图标（URL 或 SVG data URI），面板供应商卡片显示。可选。 */
  readonly icon?: string

  // ---- 核心（必须） ----
  status(): SupplierStatus
  /** 模型来源。`force=true` 时强制刷新来源（核心「获取模型」按钮调用）。 */
  listModels(force?: boolean): Promise<ModelInfo[]> | ModelInfo[]
  /** 默认前缀（可被通用层 alias 覆盖）。 */
  getAlias(): string
  chatCompletions(req: ChatRequest, res: ServerResponse): Promise<boolean>
  dispose(): void

  // ---- 差异化能力（可选，按存在性暴露端点/UI） ----

  /** 上次 chatCompletions 失败的原因（诊断用）。
   *  测试模型由 dsh-router 核心统一走 chatCompletions 路径（账号池回退/冷却自动生效），
   *  插件只需把失败原因暴露出来供核心汇总；不实现则测试失败时只有通用提示。 */
  lastError?(): string | undefined

  // ---- 差异化能力（可选，按存在性暴露端点/UI） ----

  /** 生成登录链接（加账号）。有它才显示连接池（账号池）。 */
  generateLoginUrl?(): string | { ok: boolean; error?: string; loginUrl?: string } | Promise<string | { ok: boolean; error?: string; loginUrl?: string }>
  /** 回调完成登录。 */
  completeLogin?(callbackUrl: string): Promise<{ uid: string; nickname: string }>

  /** 添加 API key 账号（弹窗填名字+key，而非 URL 登录）。有它同样显示连接池。 */
  addApiKey?(input: { name: string; apiKey: string }): Promise<{ ok: boolean; error?: string; account?: { uid: string; nickname: string } }>
  /** 删除链接（清理凭证；内部能力）。 */
  removeLink?(uid: string): Promise<boolean>
  /** 轮询式登录标记：有它 → 面板隐藏「粘贴回调链接」步骤，登录后直接点完成（后台轮询）。 */
  pollLogin?(): boolean

  /** 触发签到。签到规则(all/first)是 dsh-router 通用策略,不在此列。 */
  checkinNow?(): Promise<{ ok: boolean; total: number; succeeded: number; already?: number; error?: string; results?: Array<{ uid: string; ok: boolean; status?: string; message?: string }> }>
}

/** 供应商账号（复用 router 类型，供 loader 包装）。 */
export type { SupplierAccount }
