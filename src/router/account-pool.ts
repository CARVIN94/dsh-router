/**
 * 账号池 —— dsh-router 核心策略：选号、冷却、遍历回退。
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
 *   - 凭证失效(session_dead) → 键 = uid 连接级冷却（登录态问题，该号所有模型都不可用）；
 *     **没有永久禁用**——403 分不清凭证死活与风控误伤，冷却到期自愈
 *   - 手动冷却(面板)         → 键 = uid（管理员整连接暂停）
 *
 * 为什么键里要带 supplierId：不同供应商**会有同名的模型 id**（如 traework 与
 * codebuddy 都有 `deepseek-v4-flash`），它们是不同的实体，单靠 (modelId, uid)
 * 会把跨供应商的同名模型串到一起。尽管本池实例当前是单供应商（loader 每供应商
 * 一个 AccountPool），键仍显式带 supplierId，语义自明且将来若池合并也安全。
 *
 * 天花板：冷却都是**内存态**，重启归零（与旧插件行为一致）。要跨重启保留
 * 得落盘，届时加 stateFile 即可，接口不用变。
 */
import type { AccountState, SupplierAccountNow } from '../suppliers/contract.ts'
import { sessionFingerprint } from './prefix-affinity.ts'

/** 各 AccountState 的处置：冷却策略 / 是否计入连续错误。 */
interface Rule {
  /**
   * 冷却策略：
   *  - `number` 固定时长（ms）
   *  - `'transient'` 瞬时短冷却（每次都冷，30s 量级）
   *  - `'backoff'` 指数退避（反复限流越退越久）
   *  - `0` 不冷却
   */
  cooldown: number | 'transient' | 'backoff'
  /** 是否计入连续错误（攒够阈值自动冷却）。 */
  counts: boolean
}

const MINUTE = 60_000

/**
 * 凭证失效（session_dead）的连接级冷却时长。
 * 403 = 凭证死 or 风控误伤，上游语义分不清——取「足够长、但不永久」的窗口：
 * 误伤号到点自愈（用户无需重启/重登），真死号每窗口只重试一次，不刷上游。
 */
const SESSION_DEAD_COOLDOWN_MS = 30 * MINUTE

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
  ok: { cooldown: 0, counts: false },
  rate_limit: { cooldown: 'backoff', counts: false },
  quota: { cooldown: 10 * MINUTE, counts: false },
  // 凭证失效也只做**连接级冷却**（跨该号所有模型），到期自愈：上游 403 常是
  // 风控/WAF 拦截，与凭证死活分不清（codebuddy 三号被 403 误禁的教训）。
  // 真死号损失 = 每窗口重试一次，可接受；误伤号到点自动回来，无需重启。
  session_dead: { cooldown: SESSION_DEAD_COOLDOWN_MS, counts: false },
  // 404/服务下线、传输中断、未知：每次都瞬时短冷却（见上方 9router 对齐说明）
  unavailable: { cooldown: 'transient', counts: false },
  transport: { cooldown: 'transient', counts: false },
  unknown: { cooldown: 'transient', counts: false },
  // 模型不属于本供应商：不是账号的错，不冷却也不计数（核心据此换下一个供应商）
  no_such_model: { cooldown: 0, counts: false },
  // 请求本身非法（上游拒收这个 payload）：同一个请求对池里每个号都会失败，
  // 冷号只会把「这条请求有问题」放大成「这个模型谁都别用」。不惩罚账号。
  bad_request: { cooldown: 0, counts: false },
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

/** 块轮询：命中率达标就放行（`留守 = 计数<N OR 命中率<M`）。见 stickyBlock 说明。 */
const BLOCK_HIT_RATIO = 0.85
/** 块轮询：最短驻留。新接到这个号的最少连续服务次数（防冷启动误切）。 */
const BLOCK_MIN = 16
/** 块轮询：绝对兜底。轮次过多(max)无论命中率如何都让位，防死守 + 保均衡下限。 */
const BLOCK_MAX = 48
/** 块轮询：判定「缓存无效」后的跳过时长。 */
const BLOCK_DEMOTE_MS = 10 * MINUTE

/**
 * 前缀亲和：指纹 → 号 的绑定记忆上限。
 *
 * 会话指纹是无限集合（每个新会话一个），不封顶就是内存泄漏。超过了就丢掉
 * **最久没用**的那条：活跃会话的指纹每请求都在刷新，不会被误删。
 * 单号池（<= 几十个会话）绰绰有余。
 */
const AFFINITY_MAX = 512

/** 冷却记录（键 = (supplier, model, uid)）。 */
interface CooldownEntry {
  until: number
  backoffLevel: number
  reason: string
}

/** 连接级冷却/手动暂停记录（键 = uid，跨该号所有模型）。 */
interface UidEntry {
  until: number
  reason: string
}

/**
 * 块轮询的驻留状态（键 = (supplier, model)，与冷却同粒度）。
 *
 * 为什么按 (供应商, 模型) 而不是按号：块是「当前这一轮由谁服务」的概念，
 * 一个模型上只有一个号在驻留；换模型意味着换前缀，块自然作废。
 */
interface BlockState {
  /** 当前驻留的号。 */
  uid: string
  /** 本块已服务的成功请求数。 */
  served: number
  /** 本块命中缓存（cachedTokens > 0）的请求数。 */
  hits: number
}

/**
 * 某号在某模型上的缓存质量样本（键 = (supplier, model, uid)）。
 *
 * 与「驻留」解耦：开启前缀亲和后多个会话各绑各的号交错服务，驻留概念只在
 * 无亲和的回退路径上存在；而「这个号的缓存到底热不热」是**号本身的属性**，
 * 必须跨驻留累计——否则每次换驻留就清零，永远攒不到 BLOCK_MAX 次判据。
 */
interface Sample {
  /** 已服务的成功请求数。 */
  served: number
  /** 命中缓存（cachedTokens > 0）的请求数。 */
  hits: number
}

/** 「缓存无效」降权记录（键 = (supplier, model, uid)）。 */
interface DemoteEntry {
  until: number
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
  /** uid → 连接级冷却 / 手动暂停。 */
  private byUid = new Map<string, UidEntry>()
  private rrCursor = 0
  /** (supplier, model) → 当前驻留的号（只有**无亲和**的回退路径用它）。 */
  private blocks = new Map<string, string>()
  /** (supplier, model, uid[, session]) → 该号在某会话下的缓存质量样本。 */
  private samples = new Map<string, Sample>()
  /** 同上键 → 缓存无效降权。 */
  private demoted = new Map<string, DemoteEntry>()
  /** (supplier, model) → Map<前缀指纹, uid>：前缀亲和的选号记忆（LRU 封顶）。 */
  private affinity = new Map<string, Map<string, string>>()

  constructor(supplierId = '') {
    this.supplierId = supplierId
  }

  private key(model: string, uid: string): string {
    return `${this.supplierId}${SEP}${model}${SEP}${uid}`
  }

  /**
   * 缓存质量样本/降权的键。
   *
   * **按会话隔离**（team 场景的关键）：同一个号被多个会话共用时，各会话的
   * 前缀会互相驱逐，把它们混在一起算命中率，会把「多会话互踩」误判成
   * 「这个号缓存坏了」→ 错误降权 → 只剩一个号 → 那个号又被打低 → 降权串。
   * 所以有会话身份时按 (model, uid, session) 记，降权只反映**该会话自己**
   * 在这个号上的真实缓存表现。
   *
   * 无会话身份（外部 OpenAI 客户端，走无指纹回退路径）→ 保持 (model, uid)，
   * 与块轮询的原语义一致（那时本就是单会话视角）。
   */
  private sampleKey(model: string, uid: string, session?: string): string {
    const base = this.key(model, uid)
    return session === undefined || session === '' ? base : `${base}${SEP}${session}`
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

  /** 某连接整体状态（连接级冷却/手动暂停）。 */
  private uidState(uid: string): UidEntry {
    let e = this.byUid.get(uid)
    if (!e) {
      e = { until: 0, reason: '' }
      this.byUid.set(uid, e)
    }
    return e
  }

  /** 该连接是否处于连接级冷却/手动暂停中（跨模型生效，到期自愈）。 */
  private uidBlocked(uid: string, now: number): boolean {
    const e = this.byUid.get(uid)
    return e !== undefined && e.until > now
  }

  /**
   * 给定要试的模型，该连接是否可服务：
   *  - 不处于连接级冷却/手动暂停（跨模型，到期自愈）；
   *  - 且此 (supplier, model, uid) 冷却单元不在冷却中。
   */
  private healthy(uid: string, model: string, now: number): boolean {
    if (this.uidBlocked(uid, now)) return false
    const c = this.cooldowns.get(this.key(model, uid))
    if (!c) return true
    return c.until <= now
  }

  /**
   * 为「某个模型」选一个健康账号 —— **会话亲和选号，无策略旋钮**。
   *
   * 旧的两策略（fallback 取第一个 / round-robin 轮转）都删了：前者让所有
   * 会话挤同一个号（team/多会话必互踩），后者的"轮转"与亲和"同会话永不换号"
   * 直接冲突。正确模型只有一条：
   *
   *  1. 算请求的前缀指纹（messages 前几条），查绑定表 → 命中且该号健康 → 用它。
   *     同一个会话的连续请求**永远落回同一个号**，前缀在该号缓存里只写一份。
   *  2. 新指纹（或绑定的号不健康）→ 按游标挑一个号并**记下绑定**，之后就固定。
   *     新会话用游标分发，所以不同会话天然散到不同号上（均衡）。
   *  3. 指纹算不出（拿不到 messages）→ **块轮询兜底**（§2 旧行为）。这不是
   *     "策略"，是无会话身份时的替身。
   *  4. 块统计不驱动轮转（亲和已保证驻留），只保留 `BLOCK_MAX` 次不达标 →
   *     降权该号（缓存无效，可恢复）。
   *
   * 天花板：号数 < 并发会话数时必然有会话共用号 → 互踩，无法用选号手法消除
   * （缓存空间是账号侧物理限制）。见 docs/pool-sticky-block.md §10。
   *
   * @param accounts 插件报告的「现在状态」（顺序即插件的自然顺序）
   * @param poolOrder 用户在面板拖出来的顺序（核心管）
   * @param modelId 当前要路由的模型（决定查哪个 (model, uid) 冷却单元）
   * @param messages 请求体的 messages（算亲和指纹的内容兜底）
   * @param session 宿主会话身份；给了就以它为主键（精确、零撞车）
   * @returns 选中的 uid；无健康账号返回 undefined
   */
  pick(accounts: SupplierAccountNow[], poolOrder: string[], modelId: string, messages?: unknown, session?: string): string | undefined {
    const now = Date.now()
    const byUid = new Map(accounts.map((a) => [a.uid, a]))
    // 池顺序优先，未配置的按插件自然顺序追加
    const ordered = [
      ...poolOrder.filter((uid) => byUid.has(uid)),
      ...accounts.map((a) => a.uid).filter((uid) => !poolOrder.includes(uid)),
    ]
    const healthy = ordered.filter((uid) => this.healthy(uid, modelId, now))
    if (healthy.length === 0) return undefined
    // 缓存无效降权：该号缓存质量样本长期不达标 → 跳过它（可到期恢复）
    const usable = healthy.filter((uid) => !this.isDemoted(uid, modelId, now, session))
    const pool = usable.length > 0 ? usable : healthy
    // 前缀亲和：指纹有绑定且该号仍可用 → 直接复用（不进驻留逻辑）
    const fp = sessionFingerprint(session, messages)
    if (fp !== '' && pool.includes(this.affinity.get(this.blockKey(modelId))?.get(fp) ?? '')) {
      return this.affinity.get(this.blockKey(modelId))!.get(fp)!
    }
    // 无指纹：沿用块轮询语义 —— 块内粘住（blockKeeps）则留守当前 block。
    const block = this.blocks.get(this.blockKey(modelId))
    if (fp === '' && block !== undefined && pool.includes(block) && this.blockKeeps(modelId, block)) {
      return block
    }
    // 分配一个号并记住绑定。
    //
    // 游标推进分两种情况，**不能混用**：
    //   - 有指纹（新会话）：按全局游标 rrCursor 分发，**不看 block**。
    //     block 是按 (supplier, model) 记的「无指纹驻留」，多会话共用同一
    //     model 时会被上一个会话反复改写；若新会话按 block 推进，多个会话
    //     交错到来就会反复指向同一位置 → 全挤一个号（team 实测过）。
    //   - 无指纹：从 block 之后前进（块轮询原语义）。
    const uid = fp !== ''
      ? pool[this.rrCursor % pool.length]!
      : pool[(block === undefined ? this.rrCursor : Math.max(0, pool.indexOf(block) + 1)) % pool.length]!
    this.rrCursor = (pool.indexOf(uid) + 1) % pool.length
    this.blocks.set(this.blockKey(modelId), uid)
    if (fp !== '') {
      this.bind(modelId, fp, uid)
    } else {
      // 新驻留 = 新观察窗口（旧行为：块计数从 0 开始）。样本是跨驻留累计的，
      // 不清的话上一个大样本会立刻把新驻留判走。
      this.samples.delete(this.key(modelId, uid))
    }
    return uid
  }

  /** 记下「前缀指纹 → 号」的绑定（LRU：超上限丢最久未用的）。 */
  private bind(modelId: string, fp: string, uid: string): void {
    const k = this.blockKey(modelId)
    let m = this.affinity.get(k)
    if (m === undefined) {
      m = new Map()
      this.affinity.set(k, m)
    }
    // 已存在则先删再 set：Map 的插入序即 LRU 序，重插等于刷新到最新
    m.delete(fp)
    m.set(fp, uid)
    if (m.size > AFFINITY_MAX) {
      const oldest = m.keys().next().value
      if (oldest !== undefined) m.delete(oldest)
    }
  }

  /**
   * 该号在**本会话**（有身份时）本模型上是否被判定「缓存无效」（降权中）。
   *
   * 判据按会话隔离（见 sampleKey）：降权只惩罚「这个会话在这个号上真的
   * 反复不命中」，不会因别的会话共用同号互踩而被牵连。
   */
  private isDemoted(uid: string, modelId: string, now: number, session?: string): boolean {
    const e = this.demoted.get(this.sampleKey(modelId, uid, session))
    return e !== undefined && e.until > now
  }

  /**
   * 驻留是否还应留在当前号上（**只用于无亲和的回退路径**）。
   *
   * OR 语义（用户拍板）：`留守 = 计数 < N OR 命中率 < M`。
   * 单一账号内部：一个号先被轮到（冷启动/热），然后
   *   - 命中率**爬上去**（>= M，缓存热了）→ 让位，轮到下一个号（均衡）
   *   - 命中率**没上去**（冷启动/短块）→ 留守，继续热（不急着跳）
   *   - 轮次**实在太多**（计数 >= N_max）→ 也换（防死守 + 保均衡下限）
   *
   * 关键：命中率是**留守**条件不是切号执行器（反接会正反馈死锁，
   * 见文档 §3）。换号由「命中达标 OR 份额用够」触发，都不是「命中率低」。
   */
  private blockKeeps(modelId: string, uid: string): boolean {
    const s = this.samples.get(this.key(modelId, uid))
    const served = s?.served ?? 0
    if (served >= BLOCK_MAX) return false // 轮次过多 → 让位（兜底）
    const ratio = served === 0 ? 0 : (s?.hits ?? 0) / served
    return served < BLOCK_MIN || ratio < BLOCK_HIT_RATIO // 计数<N OR 命中率<M
  }

  /**
   * 记录一次成功请求的缓存命中情况（降权判据的反馈信号）。
   *
   * 只有**成功**请求才计入：失败没产生缓存，计入会污染命中率并导致错降权。
   * 统计按 (model, uid[, session]) 记，**不管这个号是不是「当前驻留」**——
   * 亲和开启后多个会话各绑各的号交错服务，按驻留记会漏掉大部分真实反馈。
   * 按会话隔离（见 sampleKey）则保证「多会话共用同号互踩」不会误伤降权。
   * @param uid 实际服务的号
   * @param modelId 模型（块粒度）
   * @param cachedTokens 上游报的命中 token 数；0 = 全量重算
   * @param session 宿主会话身份；有则按会话隔离统计
   */
  noteCache(uid: string, modelId: string, cachedTokens: number, session?: string): void {
    const k = this.sampleKey(modelId, uid, session)
    const s = this.samples.get(k) ?? { served: 0, hits: 0 }
    s.served += 1
    if (cachedTokens > 0) s.hits += 1
    this.samples.set(k, s)
    // 累计满 N_max 仍不达标 → 判定缓存无效，降权一段时间（可恢复）
    if (s.served >= BLOCK_MAX && s.hits / s.served < BLOCK_HIT_RATIO) {
      this.demoted.set(k, { until: Date.now() + BLOCK_DEMOTE_MS })
      // 降权后样本重置：冷却结束重新观察，而不是带着旧判决立刻再降
      this.samples.delete(k)
    }
  }

  /** 故障切走时作废当前驻留：换号后前缀归属变了，驻留计数不能沿用。 */
  dropBlock(modelId: string): void {
    this.blocks.delete(this.blockKey(modelId))
  }

  /** 块状态键：与冷却同粒度 (supplier, model)，不含 uid。 */
  private blockKey(modelId: string): string {
    return `${this.supplierId}${SEP}${modelId}`
  }

  /** 记录一次失败：按状态处置（冷却/退避），落在「(模型, 连接)」这个冷却单元上。 */
  noteFailure(uid: string, modelId: string, state: AccountState, message: string): void {
    const rule = RULES[state]
    if (rule.cooldown === 0) return // no_such_model 等：不冷不记
    // session_dead 是连接级冷却（登录态问题，跨该号所有模型），到期自愈——
    // 不再有「永久禁用」：403 分不清凭证死活，误伤号不该被钉死
    if (state === 'session_dead') {
      const e = this.uidState(uid)
      const cd = rule.cooldown
      e.until = Math.max(e.until, Date.now() + (typeof cd === 'number' ? cd : 0))
      e.reason = message
      return
    }
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

  /** 记录一次成功：清零「该模型」的限流退避等级（好号不背历史惩罚）。 */
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
    for (const [k, ce] of this.cooldowns) {
      if (k.endsWith(`${SEP}${uid}`)) ce.backoffLevel = 0
    }
  }

  /** 把核心的冷却叠加到插件报的「现在状态」上，产出面板态。
   *
   * 冷却现在是 (模型, 连接) 粒度的，而面板状态没有「当前模型」上下文，
   * 这里默认**聚合**：只要该连接在任一模型上有活跃冷却，就显示 cooling=true
   * （reason 带上具体模型），并在 `until` 给最长者。真实路由用 `pick` 的
   * 模型级判定，不受此展示聚合影响。传 modelId 可只按该模型判定。
   */
  decorate(accounts: SupplierAccountNow[], modelId?: string): Array<SupplierAccountNow & {
    cooling: boolean
    err_count: number
    until?: string
    reason?: string
  }> {
    const now = Date.now()
    return accounts.map((a) => {
      const u = this.byUid.get(a.uid)
      // 连接级冷却（session_dead 处置 / 手动暂停）也算 cooling
      const uidCooling = u !== undefined && u.until > now

      let cooling = uidCooling
      let maxUntil = uidCooling ? u!.until : 0
      let reason = uidCooling ? u!.reason : undefined
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
        err_count: err,
        until: cooling && maxUntil > 0 ? new Date(maxUntil).toISOString() : undefined,
        reason: reason !== undefined && reason !== '' ? reason : undefined,
      }
    })
  }
}
