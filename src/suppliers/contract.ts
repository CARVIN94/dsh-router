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
import type { ChatRequest, ModelInfo, SupplierAccount } from '../router/types.ts'
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

/**
 * 账户此刻的状态 —— 插件**解读**上游信号后的语义状态。
 *
 * 插件只报「现在怎么了」，不说「该怎么办」：冷却多久、是否禁用、要不要换号
 * 都是核心的策略，见 `AccountState` 各值的处置表（docs/suppliers.md）。
 *
 * 天花板：目前是固定枚举。若将来某供应商需要更细的语义，再加值而不是放宽成
 * 字符串——核心的策略表要能穷举。
 */
export type AccountState =
  | 'ok'            // 正常
  | 'rate_limit'    // 限流（429 类）
  | 'quota'         // 额度/权益不足
  | 'session_dead'  // 凭证彻底失效，必须重新登录才能恢复
  | 'unavailable'   // 上游不可用（404 / 服务下线）
  | 'transport'     // 网络/连接层失败（没拿到 HTTP 状态）
  | 'unknown'       // 说不清是什么错
  /**
   * 这个模型不属于本供应商（不是账号的失败，也不是上游故障）。
   * 核心据此**跳过整个供应商**换下一个，而不是记在账号头上——
   * 否则组合里每有一个别人家的模型，就会给无关账号攒一次错误，攒够阈值
   * 把它冷却掉（历史上正是这个坑）。
   */
  | 'no_such_model'

/** 面板展示的账号此刻状态（插件只报它观察到的部分，冷却/禁用由核心叠加）。 */
export interface SupplierAccountNow {
  uid: string
  nickname?: string
  /**
   * 剩余额度。**拿不到就报 `-1`**，不是 0：
   * 插件刚重启（内存缓存空）、积分拉取失败、或压根不支持积分时都是 `-1`。
   * 核心据此保留上一次持久化下来的值 —— 报 0 会把缓存冲成 0（0 是真值
   * 「用完了」，核心分不清「拿到 0」和「没拿到」）。
   */
  credits: number
  /** 插件观察到的上游状态。 */
  state: AccountState
  /** 状态的人类可读补充（如上游错误串），可选。 */
  message?: string
}

/** 插件报的供应商状态（accounts 是「现在状态」，非核心加工后的面板态）。 */
export interface SupplierStatusNow {
  id: string
  name: string
  accounts: SupplierAccountNow[]
}

/** 一次上游调用的结果。 */
export type ChatOnceResult =
  /** 流式：插件已把上游协议转成 OpenAI SSE，核心只负责 pipe 到 res。 */
  | { ok: true; stream: ReadableStream<Uint8Array> }
  /** 非流式：核心写 JSON。 */
  | { ok: true; status: number; body: string }
  /** 失败：核心据此做冷却/禁用/换号。 */
  | { ok: false; state: AccountState; message: string }

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
  /** 报账号「现在状态」。冷却/禁用/错误累计由核心叠加，插件不算这些。 */
  status(): SupplierStatusNow
  /** 模型来源。`force=true` 时强制刷新来源（核心「获取模型」按钮调用）。 */
  listModels(force?: boolean): Promise<ModelInfo[]> | ModelInfo[]
  /**
   * 对**单个账号**调一次上游。插件不遍历账号、不管冷却、不写 res——
   * 选号/回退/健康判定全是核心的活。
   * 无账号供应商（如 opencode）传空 uid，忽略即可。
   *
   * 失败原因通过返回值的 `message` 报（核心在测试模型时直接用它做诊断提示），
   * 插件不必自己存一份「上次失败」的状态。
   */
  chatOnce(uid: string, req: ChatRequest): Promise<ChatOnceResult>
  dispose(): void

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

  /** 单个链接签到。遍历所有链接 + 结果汇总是 dsh-router 核心的活,插件只管一个 uid。
   *  status: 'ok'(签到成功) / 'already'(今日已签到) / 'error'(失败)。 */
  checkinNow?(uid: string): Promise<{ ok: boolean; status: string; message?: string }>
}

/** 供应商账号（复用 router 类型，供 loader 包装）。 */
export type { SupplierAccount }
