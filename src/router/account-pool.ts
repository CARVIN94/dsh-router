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

/** 各 AccountState 的处置：冷却时长 / 是否禁用 / 是否计入连续错误。 */
interface Rule {
  /** 冷却时长（ms）；0 = 不冷却。 */
  cooldownMs: number
  /** 是否永久禁用（需重新登录才能恢复）。 */
  disable: boolean
  /** 是否计入连续错误（攒够阈值自动冷却）。 */
  counts: boolean
}

const MINUTE = 60_000

/**
 * 状态 → 处置表。**核心策略就在这一张表里**，插件只报状态不做决策。
 * 时长参考 9router 的 errorConfig（限流类短冷却、额度类长冷却），
 * 但 9router 按文本/状态匹配，这里按插件解读后的语义状态匹配，更准。
 */
const RULES: Record<AccountState, Rule> = {
  ok: { cooldownMs: 0, disable: false, counts: false },
  rate_limit: { cooldownMs: 1 * MINUTE, disable: false, counts: false },
  quota: { cooldownMs: 10 * MINUTE, disable: false, counts: false },
  session_dead: { cooldownMs: 0, disable: true, counts: false },
  // 404/服务下线：只计错误不立刻冷却——偶发的自己恢复，真挂了攒够阈值再冷却
  unavailable: { cooldownMs: 0, disable: false, counts: true },
  transport: { cooldownMs: 0, disable: false, counts: true },
  unknown: { cooldownMs: 0, disable: false, counts: true },
  // 模型不属于本供应商：不是账号的错，不冷却也不计数（核心据此换下一个供应商）
  no_such_model: { cooldownMs: 0, disable: false, counts: false },
}

/** 连续错误攒够这么多次就自动冷却（防止坏号被反复重试）。 */
const ERR_THRESHOLD = 3
/** 攒够后的冷却时长。 */
const ERR_COOLDOWN_MS = 10 * MINUTE

interface Entry {
  until: number
  disabled: boolean
  errCount: number
  reason: string
}

export class AccountPool {
  private entries = new Map<string, Entry>()
  private rrCursor = 0

  private entry(uid: string): Entry {
    let e = this.entries.get(uid)
    if (!e) {
      e = { until: 0, disabled: false, errCount: 0, reason: '' }
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

  /** 记录一次失败：按状态处置（冷却/禁用/错误累计）。 */
  noteFailure(uid: string, state: AccountState, message: string): void {
    const rule = RULES[state]
    const e = this.entry(uid)
    if (rule.disable) {
      e.disabled = true
      e.reason = message
      return
    }
    if (rule.cooldownMs > 0) {
      e.until = Math.max(e.until, Date.now() + rule.cooldownMs)
      e.reason = message
      e.errCount = 0
      return
    }
    if (rule.counts) {
      e.errCount += 1
      e.reason = message
      if (e.errCount >= ERR_THRESHOLD) {
        e.until = Date.now() + ERR_COOLDOWN_MS
        e.errCount = 0
      }
    }
  }

  /** 记录一次成功：清零连续错误。 */
  noteSuccess(uid: string): void {
    const e = this.entries.get(uid)
    if (e) e.errCount = 0
  }

  /** 手动冷却（面板/管理用途）。 */
  cooldown(uid: string, ms: number, reason: string): void {
    const e = this.entry(uid)
    e.until = Date.now() + ms
    e.reason = reason
    e.errCount = 0
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
        err_count: e?.errCount ?? 0,
        until: cooling && e ? new Date(e.until).toISOString() : undefined,
        reason: e?.reason !== '' ? e?.reason : undefined,
      }
    })
  }
}
