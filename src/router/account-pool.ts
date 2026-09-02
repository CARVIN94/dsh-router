/**
 * 账号池 —— dsh-router 核心策略：选号、冷却、禁用、遍历回退。
 *
 * 供应商插件只管「对单个账号调通上游」，账号层面的策略全在这里。
 *
 * ## 冷却颗粒度 = (供应商, 模型, 连接) 三元组
 *
 * 冷却**不按连接整体记**，而是按「哪家供应商 × 哪个模型 × 哪个连接」单独记。
 * 理由：一个连接可以服务多个模型。若某连接调模型 A 时被限流/瞬时抖动而把
 * **整个连接**冷掉，那它调模型 B 也被殃及——一个付费连接会因一个模型的瞬时
 * 失败而对其它模型也不可用，这是错的。
 *
 *   - 冷却/限流退避/瞬时 → 键 = (supplierId, modelId, uid)，只冷「这个号 × 这个模型」
 *   - 禁用(session_dead)     → 键 = uid（登录态问题，该号所有模型都不可用）
 *   - 手动冷却(面板)         → 键 = uid（管理员整连接暂停）
 *
 * 为什么键里要带 supplierId：不同供应商**会有同名的模型 id**（如 traework 与
 * codebuddy 都有 `deepseek-v4-flash`），它们是不同的实体，单靠 (modelId, uid)
 * 会把跨供应商的同名模型串到一起。尽管本池实例当前是单供应商（loader 每供应商
 * 一个 AccountPool），键仍显式带 supplierId，语义自明且将来若池合并也安全。
 *
 * 天花板：冷却/禁用都是**内存态**，重启归零（与旧插件行为一致）。要跨重启保留
 * 得落盘，届时加 stateFile 即可，接口不用变。
 */
import type { AccountState, SupplierAccountNow } from '../suppliers/contract.ts'

/** 各 AccountState 的处置：冷却策略 / 是否禁用 / 是否计入连续错误。 */
interface Rule {
  /**
   * 冷却策略：
   *  - `number` 固定时长（ms）
   *  - `'transient'` 瞬时短冷却（每次都冷，30s 量级）
   *  - `'backoff'` 指数退避（反复限流越退越久）
   *  - `0` 不冷却
   */
  cooldown: number | 'transient' | 'backoff'
  /** 是否永久禁用（需重新登录才能恢复）。 */
  disable: boolean
  /** 是否计入连续错误（攒够阈值自动冷却）。 */
  counts: boolean
}

const MINUTE = 60_000

/**
 * 状态 → 处置表。**核心策略就在这一张表里**，插件只报状态不做决策。
 *
 * 冷却策略对齐 9router 的 accountFallback / errorConfig：
 *  - `rate_limit` 用**指数退避**（9router 的 `backoff: true`）：偶发限流只
 *    短冷，持续限流越退越久，比固定 1 分钟两头不讨好要准。
 *  - 未知/瞬时错误用**瞬时短冷却**（9router 默认分支 TRANSIENT_COOLDOWN_MS）：
 *    每次失败都冻结，坏号不会留在池里被下一个请求再选中。
 *
 * 与 9router 的差别：9router 按错误文本/HTTP 状态匹配，这里按插件解读后的
 * 语义状态匹配 —— 插件已经把 11133/11134 这类网关噪声归成 `rate_limit`，
 * 核心不必再猜文本，更准。
 */
const RULES: Record<AccountState, Rule> = {
  ok: { cooldown: 0, disable: false, counts: false },
  rate_limit: { cooldown: 'backoff', disable: false, counts: false },
  quota: { cooldown: 10 * MINUTE, disable: false, counts: false },
  session_dead: { cooldown: 0, disable: true, counts: false },
  // 404/服务下线、传输中断、未知：每次都瞬时短冷却（见上方 9router 对齐说明）
  unavailable: { cooldown: 'transient', disable: false, counts: false },
  transport: { cooldown: 'transient', disable: false, counts: false },
  unknown: { cooldown: 'transient', disable: false, counts: false },
  // 模型不属于本供应商：不是账号的错，不冷却也不计数（核心据此换下一个供应商）
  no_such_model: { cooldown: 0, disable: false, counts: false },
}

/**
 * 瞬时/未知错误的冷却时长 —— 对齐 9router 的 TRANSIENT_COOLDOWN_MS。
 * 取短值：这类错误大多是偶发的上游抖动，冷太久会把好号白白关掉；
 * 但**必须冷**，否则坏号留在池里，每个请求都要先撞一次才知道它坏了。
 * （现在按 (模型, 号) 记，只关这一个号在这个模型上的可用性。）
 */
const TRANSIENT_COOLDOWN_MS = 30_000

/** 限流退避：首次 2s，每次翻倍，上限 5 分钟（对齐 9router BACKOFF_CONFIG）。 */
const BACKOFF_BASE_MS = 2_000
const BACKOFF_MAX_MS = 5 * MINUTE
const BACKOFF_MAX_LEVEL = 15

/** 连续错误攒够这么多次就自动冷却（防止坏号被反复重试）。 */
const ERR_THRESHOLD = 3
/** 攒够后的冷却时长。 */
const ERR_COOLDOWN_MS = 5 * MINUTE

/** 冷却记录（键 = (supplier, model, uid)）。 */
interface CooldownEntry {
  until: number
  backoffLevel: number
  reason: string
}

/** 连接级禁用/手动暂停记录（键 = uid）。 */
interface UidEntry {
  until: number
  disabled: boolean
  reason: string
}

/** 指数退避：等级 1 = BACKOFF_BASE_MS，每级翻倍，封顶 BACKOFF_MAX_MS。 */
function backoffMs(level: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, level - 1), BACKOFF_MAX_MS)
}

/** 冷却键分隔符：模型 id 本身可含 `/` `,`，用不可见控制符隔离最稳。 */
const SEP = '\u0000'

export class AccountPool {
  /** 本池所属供应商（loader 每供应商一个实例；键里带上，跨供应商同名模型不串）。 */
  private supplierId: string
  /** (supplier, model, uid) → 冷却/退避。 */
  private cooldowns = new Map<string, CooldownEntry>()
  /** uid → 连接级禁用 / 手动暂停。 */
  private byUid = new Map<string, UidEntry>()
  private rrCursor = 0

  constructor(supplierId = '') {
    this.supplierId = supplierId
  }

  private key(model: string, uid: string): string {
    return `${this.supplierId}${SEP}${model}${SEP}${uid}`
  }

  private entry(model: string, uid: string): CooldownEntry {
    const k = this.key(model, uid)
    let e = this.cooldowns.get(k)
    if (!e) {
      e = { until: 0, backoffLevel: 0, reason: '' }
      this.cooldowns.set(k, e)
    }
    return e
  }

  /** 某连接整体状态（禁用/手动暂停）。 */
  private uidState(uid: string): UidEntry {
    let e = this.byUid.get(uid)
    if (!e) {
      e = { until: 0, disabled: false, reason: '' }
      this.byUid.set(uid, e)
    }
    return e
  }

  /** 该连接是否被禁用 / 手动整连接暂停中（跨模型生效）。 */
  private uidBlocked(uid: string, now: number): { blocked: boolean; disabled: boolean } {
    const e = this.byUid.get(uid)
    if (!e) return { blocked: false, disabled: false }
    if (e.disabled) return { blocked: true, disabled: true }
    if (e.until > now) return { blocked: true, disabled: false }
    return { blocked: false, disabled: false }
  }

  /**
   * 给定要试的模型，该连接是否可服务：
   *  - 未被连接级禁用/手动暂停（跨模型）；
   *  - 且此 (supplier, model, uid) 冷却单元不在冷却中。
   */
  private healthy(uid: string, model: string, now: number): boolean {
    const b = this.uidBlocked(uid, now)
    if (b.blocked) return false
    const c = this.cooldowns.get(this.key(model, uid))
    if (!c) return true
    return c.until <= now
  }

  /**
   * 按策略为「某个模型」选一个健康账号。
   * @param accounts 插件报告的「现在状态」（顺序即插件的自然顺序）
   * @param poolOrder 用户在面板拖出来的顺序（核心管）
   * @param strategy fallback 取第一个健康 / round-robin 轮转健康号
   * @param modelId 当前要路由的模型（决定查哪个 (model, uid) 冷却单元）
   * @returns 选中的 uid；无健康账号返回 undefined
   */
  pick(accounts: SupplierAccountNow[], poolOrder: string[], strategy: string, modelId: string): string | undefined {
    const now = Date.now()
    const byUid = new Map(accounts.map((a) => [a.uid, a]))
    // 池顺序优先，未配置的按插件自然顺序追加
    const ordered = [
      ...poolOrder.filter((uid) => byUid.has(uid)),
      ...accounts.map((a) => a.uid).filter((uid) => !poolOrder.includes(uid)),
    ]
    const healthy = ordered.filter((uid) => this.healthy(uid, modelId, now))
    if (healthy.length === 0) return undefined
    if (strategy !== 'round-robin') return healthy[0]
    const uid = healthy[this.rrCursor % healthy.length]
    this.rrCursor = (this.rrCursor + 1) % healthy.length
    return uid
  }

  /** 记录一次失败：按状态处置（冷却/禁用/退避），落在「(模型, 连接)」这个冷却单元上。 */
  noteFailure(uid: string, modelId: string, state: AccountState, message: string): void {
    const rule = RULES[state]
    // 禁用 / 手动暂停是连接级（登录态问题，跨模型）——但这里只处理规则本身
    if (rule.disable) {
      // session_dead：整个连接禁用（跨该号所有模型）
      const e = this.uidState(uid)
      e.disabled = true
      e.reason = message
      return
    }
    if (rule.cooldown === 0) return // no_such_model 等：不冷不记
    // 冷却/退避：记在 (model, uid) 单元上，不动该号其它模型
    const e = this.entry(modelId, uid)
    e.reason = message
    if (rule.cooldown === 'backoff') {
      // 连续被限流 → 等级递进冷却；成功（noteSuccess）会清零等级
      e.backoffLevel = Math.min(e.backoffLevel + 1, BACKOFF_MAX_LEVEL)
      e.until = Math.max(e.until, Date.now() + backoffMs(e.backoffLevel))
      return
    }
    if (rule.cooldown === 'transient') {
      // 每次都冷（不再攒次数）：坏号不该留在池里等下一次撞
      e.until = Math.max(e.until, Date.now() + TRANSIENT_COOLDOWN_MS)
      return
    }
    e.until = Math.max(e.until, Date.now() + rule.cooldown)
  }

  /** 记录一次成功：清零「该模型」的限流退避等级（好号不背历史惩罚）。不解除禁用。 */
  noteSuccess(uid: string, modelId: string): void {
    const e = this.cooldowns.get(this.key(modelId, uid))
    if (e) e.backoffLevel = 0
  }

  /** 手动暂停整连接（面板/管理用途，跨模型）。ms<=0 表示解除。 */
  cooldown(uid: string, ms: number, reason: string): void {
    const e = this.uidState(uid)
    e.until = Date.now() + ms
    e.reason = reason
    // 手动暂停通常是想清掉这个号上的累积惩罚：把它的退避等级清零
    // （disabled 不可由此解除——需重新登录）
    for (const [k, ce] of this.cooldowns) {
      if (k.endsWith(`${SEP}${uid}`)) ce.backoffLevel = 0
    }
  }

  /** 把核心的冷却/禁用叠加到插件报的「现在状态」上，产出面板态。
   *
   * 冷却现在是 (模型, 连接) 粒度的，而面板状态没有「当前模型」上下文，
   * 这里默认**聚合**：只要该连接在任一模型上有活跃冷却，就显示 cooling=true
   * （reason 带上具体模型），并在 `until` 给最长者。真实路由用 `pick` 的
   * 模型级判定，不受此展示聚合影响。传 modelId 可只按该模型判定。
   */
  decorate(accounts: SupplierAccountNow[], modelId?: string): Array<SupplierAccountNow & {
    cooling: boolean
    disabled: boolean
    err_count: number
    until?: string
    reason?: string
  }> {
    const now = Date.now()
    return accounts.map((a) => {
      const u = this.byUid.get(a.uid)
      const disabled = u?.disabled ?? false
      // 连接级手动暂停或禁用也算不可服务；但 disabled 单列，冷却不算它
      const manualCooling = u !== undefined && !u.disabled && u.until > now

      let cooling = manualCooling
      let maxUntil = manualCooling ? u!.until : 0
      let reason = manualCooling ? u!.reason : undefined
      let err = 0
      // 遍历本连接在所有模型上的冷却单元（或仅指定模型）
      for (const [k, ce] of this.cooldowns) {
        if (!k.endsWith(`${SEP}${a.uid}`)) continue
        if (modelId !== undefined) {
          // 键形如 supplier\u0000model\u0000uid —— 只在键开头含该 model 时命中
          const prefix = `${this.supplierId}${SEP}${modelId}${SEP}`
          if (!k.startsWith(prefix)) continue
        }
        if (ce.until > now) {
          cooling = true
          if (ce.until > maxUntil) {
            maxUntil = ce.until
            reason = ce.reason
          }
        }
        if (ce.backoffLevel > err) err = ce.backoffLevel
      }
      return {
        ...a,
        cooling,
        disabled,
        err_count: err,
        until: cooling && maxUntil > 0 ? new Date(maxUntil).toISOString() : undefined,
        reason: reason !== undefined && reason !== '' ? reason : undefined,
      }
    })
  }
}
