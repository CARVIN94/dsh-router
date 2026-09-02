/**
 * 账号池 —— dsh-router 核心策略：选号、冷却、禁用、错误累计、遍历回退。
 *
 * 供应商插件只管「对单个账号调通上游」，账号层面的策略全在这里：
 *   - 按 poolOrder 排序（未配置的按插件报告顺序追加）
 *   - 按 poolStrategy 选号：fallback = 取第一个健康；round-robin = 轮转健康号
 *   - 失败按插件报的 AccountState 处置（冷却/禁用/错误累计），攒够阈值自动冷却
 *
 * 天花板：冷却/禁用/错误计数都是**内存态**，重启归零（与旧插件行为一致，
 * 插件的持久化只存凭证与积分，不存健康）。要跨重启保留得落盘，届时加一个
 * stateFile 即可，接口不用变。
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
 *    每次失败都冻结，坏号不会留在池里被下一个请求再选中。原「计错误攒够
 *    3 次才冷却」前两次完全不冷却，整池正是被这条路径拖垮的。
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

interface Entry {
  until: number
  disabled: boolean
  backoffLevel: number
  reason: string
}

/** 指数退避：等级 1 = BACKOFF_BASE_MS，每级翻倍，封顶 BACKOFF_MAX_MS。 */
function backoffMs(level: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, level - 1), BACKOFF_MAX_MS)
}

export class AccountPool {
  private entries = new Map<string, Entry>()
  private rrCursor = 0

  private entry(uid: string): Entry {
    let e = this.entries.get(uid)
    if (!e) {
      e = { until: 0, disabled: false, backoffLevel: 0, reason: '' }
      this.entries.set(uid, e)
    }
    return e
  }

  /** 是否可服务：未禁用且不在冷却中。 */
  private healthy(uid: string, now: number): boolean {
    const e = this.entries.get(uid)
    if (!e) return true
    if (e.disabled) return false
    return e.until <= now
  }

  /**
   * 按策略选一个健康账号。
   * @param accounts 插件报告的「现在状态」（顺序即插件的自然顺序）
   * @param poolOrder 用户在面板拖出来的顺序（核心管）
   * @returns 选中的 uid；无健康账号返回 undefined
   */
  pick(accounts: SupplierAccountNow[], poolOrder: string[], strategy: string): string | undefined {
    const now = Date.now()
    const byUid = new Map(accounts.map((a) => [a.uid, a]))
    // 池顺序优先，未配置的按插件自然顺序追加
    const ordered = [
      ...poolOrder.filter((uid) => byUid.has(uid)),
      ...accounts.map((a) => a.uid).filter((uid) => !poolOrder.includes(uid)),
    ]
    const healthy = ordered.filter((uid) => this.healthy(uid, now))
    if (healthy.length === 0) return undefined
    if (strategy !== 'round-robin') return healthy[0]
    const uid = healthy[this.rrCursor % healthy.length]
    this.rrCursor = (this.rrCursor + 1) % healthy.length
    return uid
  }

  /** 记录一次失败：按状态处置（冷却/禁用/退避）。 */
  noteFailure(uid: string, state: AccountState, message: string): void {
    const rule = RULES[state]
    const e = this.entry(uid)
    e.reason = message
    if (rule.disable) {
      e.disabled = true
      return
    }
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
    if (rule.cooldown > 0) {
      e.until = Math.max(e.until, Date.now() + rule.cooldown)
    }
  }

  /** 记录一次成功：清零限流退避等级（好号不背历史惩罚）。 */
  noteSuccess(uid: string): void {
    const e = this.entries.get(uid)
    if (e) e.backoffLevel = 0
  }

  /** 手动冷却（面板/管理用途）。 */
  cooldown(uid: string, ms: number, reason: string): void {
    const e = this.entry(uid)
    e.until = Date.now() + ms
    e.reason = reason
    e.backoffLevel = 0
  }

  /** 把核心的冷却/禁用/错误累计叠加到插件报告的「现在状态」上，产出面板态。 */
  decorate(accounts: SupplierAccountNow[]): Array<SupplierAccountNow & {
    cooling: boolean
    disabled: boolean
    err_count: number
    until?: string
    reason?: string
  }> {
    const now = Date.now()
    return accounts.map((a) => {
      const e = this.entries.get(a.uid)
      const cooling = e !== undefined && !e.disabled && e.until > now
      return {
        ...a,
        cooling,
        disabled: e?.disabled ?? false,
        // 面板展示为「连续错误」：现在承载的是限流退避等级（退避取代了原累计制）
        err_count: e?.backoffLevel ?? 0,
        until: cooling && e ? new Date(e.until).toISOString() : undefined,
        reason: e?.reason !== '' ? e?.reason : undefined,
      }
    })
  }
}
