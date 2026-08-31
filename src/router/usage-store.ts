/**
 * 用量落盘与聚合 —— 概览看板的数据源。
 *
 * 结构照 9router `usageRepo` 的双表思路（按天聚合 + 最近明细），但用 **JSON
 * 落盘**而不是 SQLite：dsh-router 现有持久化全是 JSON（supplier-config.json /
 * keys.json），不为一个看板引入数据库依赖。
 *
 * 统计口径（不再走明细环 —— 见下面「天花板」）：
 *   - `today`      → 走**天桶**（今天这一桶就是答案，天然精确）
 *   - `24h`        → 走**小时桶**（滚动窗口，天桶是自然日，对不上）
 *   - `7d` / `30d` → 走**天桶**（长期精确）
 *
 * 天花板（JSON 的代价，刻意接受）：
 *   - 明细环 `recent[]` 只留最近 `RING_CAP` 条，**只服务「最近请求列表」**，
 *     不参与任何统计。历史上 today/24h 直接扫它，单日超 500 条就被静默截断，
 *     于是出现「今日 500 / 7 天 1621」这种自相矛盾的数字——现在不会了。
 *   - **小时桶只从新数据开始累积**：升级前落的盘没有小时粒度，而明细环只剩
 *     最近 500 条、回溯不回去，所以那段历史的**天内分布是永久缺失的**。
 *     影响面：①`24h` 遇到「小时粒度不齐」的自然日 → 整桶计入（宁可多算，
 *     也不显示一个比「今日」还小的荒唐数字）；②`today`/`24h` 的小时柱状图
 *     那几格是空的（不编数据）。天桶口径（today/7d/30d）完全不受影响，
 *     新数据立刻就有小时粒度，隔天起图表全正常。
 *   - 天桶保留 30 天（9router 有 SQLite 不 prune，JSON 撑不住，得自己限）
 *   - 落盘防抖 2s：进程被 kill 最多丢 2s 的计数。看板不是账本，可接受；
 *     要严格就改成立即写，代价是每个请求一次磁盘写。
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Usage } from './usage-tokens.ts'

/** 一条明细（最近请求的环）。 */
export interface UsageRecord {
  ts: number
  supplier: string
  model: string
  /** 客户端原始请求的 model（组合场景下就是组合名）。 */
  requested: string
  ok: boolean
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  inputEstimated: boolean
  outputEstimated: boolean
  durationMs: number
  /** 首字节延迟（ms）；非流式为 0。 */
  ttfbMs: number
  /** 失败原因（ok=false 时）。 */
  error?: string
}

/** 按某个维度（供应商/模型/请求名）聚合的小计。 */
interface Entry {
  requests: number
  ok: number
  failed: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  lastTs: number
}

/** 小时桶（today/24h 的统计口径，下标 = 本地小时 0..23）。 */
interface HourBucket {
  requests: number
  ok: number
  failed: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  durationMs: number
  ttfbMs: number
  ttfbCount: number
  estimatedInputs: number
  estimatedOutputs: number
}

/** 一天一桶。 */
interface DayBucket {
  requests: number
  ok: number
  failed: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  durationMs: number
  ttfbMs: number
  /** 有 TTFB 记录的请求数（非流式为 0，不能拿 requests 当分母）。 */
  ttfbCount: number
  /** 输入是估算的请求数（面板据此提示「部分数据为估算」）。 */
  estimatedInputs: number
  estimatedOutputs: number
  /** 24 个小时桶，定长（天桶本身才 1.5KB，加这个可忽略）。 */
  hours: HourBucket[]
  bySupplier: Record<string, Entry>
  byModel: Record<string, Entry>
  byRequested: Record<string, Entry>
}

interface UsageFile {
  days: Record<string, DayBucket>
  recent: UsageRecord[]
  lifetime: number
}

export type Period = 'today' | '24h' | '7d' | '30d'

/** 明细环容量：只喂「最近请求列表」，跟统计口径无关了。 */
const RING_CAP = 500
/** 一天几格（小时桶定长；要更细的精度就把这个值放大）。 */
const HOURS = 24
/** 天桶保留天数。 */
const KEEP_DAYS = 30
/** 落盘防抖。 */
const SAVE_DEBOUNCE_MS = 2000

/** 小时格：一个整点 + 它落在哪个自然日 + 那天的数据/该小时桶（无数据则 undefined）。 */
interface HourSlot {
  dayKey: string
  start: number
  day: DayBucket | undefined
  b: HourBucket | undefined
}

const emptyHour = (): HourBucket => ({
  requests: 0, ok: 0, failed: 0,
  promptTokens: 0, completionTokens: 0, cachedTokens: 0,
  durationMs: 0, ttfbMs: 0, ttfbCount: 0,
  estimatedInputs: 0, estimatedOutputs: 0,
})

const emptyDay = (): DayBucket => ({
  requests: 0,
  ok: 0,
  failed: 0,
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  durationMs: 0,
  ttfbMs: 0,
  ttfbCount: 0,
  estimatedInputs: 0,
  estimatedOutputs: 0,
  hours: Array.from({ length: HOURS }, () => emptyHour()),
  bySupplier: {},
  byModel: {},
  byRequested: {},
})

const emptyEntry = (): Entry => ({
  requests: 0, ok: 0, failed: 0,
  promptTokens: 0, completionTokens: 0, cachedTokens: 0,
  lastTs: 0,
})

/** 本地日期键 `YYYY-MM-DD`（照 9router getLocalDateKey，不按 UTC 切天）。 */
export function localDateKey(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 用量存储。stateFile 为空时纯内存（测试用），不落盘。 */
export class UsageStore {
  private fp = ''
  private days = new Map<string, DayBucket>()
  private recent: UsageRecord[] = []
  private lifetime = 0
  private timer: NodeJS.Timeout | null = null

  constructor(stateFile: string) {
    this.fp = stateFile ? join(dirname(stateFile), 'usage.json') : ''
    this.load()
  }

  /**
   * 记一次请求。
   *
   * **成功的零 token 请求不记**（照 9router `saveUsageStats` 的闸门：
   * `in === 0 && out === 0` 直接 return，空请求混进来只会稀释统计）。
   * **失败请求一定记** —— 不管有没有 token。成功率全靠它，挡掉的话
   * 失败永远是 0 条，面板会显示 100% 成功，这个数字是骗人的。
   */
  record(r: Omit<UsageRecord, 'ts' | 'promptTokens' | 'completionTokens' | 'cachedTokens' | 'inputEstimated' | 'outputEstimated'> & { ts?: number }, usage: Usage): void {
    const promptTokens = usage.promptTokens
    const completionTokens = usage.completionTokens
    if (r.ok && promptTokens === 0 && completionTokens === 0) return

    const ts = r.ts ?? Date.now()
    const rec: UsageRecord = {
      ...r,
      ts,
      promptTokens,
      completionTokens,
      cachedTokens: usage.cachedTokens,
      inputEstimated: usage.inputEstimated,
      outputEstimated: usage.outputEstimated,
    }
    const key = localDateKey(ts)
    let day = this.days.get(key)
    if (day === undefined) {
      day = emptyDay()
      this.days.set(key, day)
    }

    day.requests += 1
    if (rec.ok) day.ok += 1
    else day.failed += 1
    day.promptTokens += promptTokens
    day.completionTokens += completionTokens
    day.cachedTokens += rec.cachedTokens
    day.durationMs += rec.durationMs
    if (rec.ttfbMs > 0) {
      day.ttfbMs += rec.ttfbMs
      day.ttfbCount += 1
    }
    if (rec.inputEstimated) day.estimatedInputs += 1
    if (rec.outputEstimated) day.estimatedOutputs += 1

    const h = day.hours[new Date(ts).getHours()]
    if (h !== undefined) {
      h.requests += 1
      if (rec.ok) h.ok += 1
      else h.failed += 1
      h.promptTokens += promptTokens
      h.completionTokens += completionTokens
      h.cachedTokens += rec.cachedTokens
      h.durationMs += rec.durationMs
      if (rec.ttfbMs > 0) {
        h.ttfbMs += rec.ttfbMs
        h.ttfbCount += 1
      }
      if (rec.inputEstimated) h.estimatedInputs += 1
      if (rec.outputEstimated) h.estimatedOutputs += 1
    }

    this.bump(day.bySupplier, rec.supplier, rec)
    this.bump(day.byModel, rec.model, rec)
    this.bump(day.byRequested, rec.requested, rec)

    this.recent.unshift(rec)
    if (this.recent.length > RING_CAP) this.recent.length = RING_CAP
    this.lifetime += 1

    this.scheduleSave()
  }

  private bump(map: Record<string, Entry>, key: string, rec: UsageRecord): void {
    if (key === '') return
    const e = map[key] ?? emptyEntry()
    e.requests += 1
    if (rec.ok) e.ok += 1
    else e.failed += 1
    e.promptTokens += rec.promptTokens
    e.completionTokens += rec.completionTokens
    e.cachedTokens += rec.cachedTokens
    e.lastTs = Math.max(e.lastTs, rec.ts)
    map[key] = e
  }

  /**
   * 从 `first` 起的 24 个小时格：每格带整点时间戳、所属自然日、那天的数据。
   *
   * `today` 传今天 00:00，`24h` 传「当前整点往前 23 格」。
   * 跨天一律靠 `localDateKey(start)` 现算，不用「减 N 小时」去猜天数：
   * 本地时区（尤其 DST）下小时偏移和自然日不是一回事，算错就漏一整天。
   */
  private hourSlots(first: number): HourSlot[] {
    const out: HourSlot[] = []
    for (let i = 0; i < HOURS; i += 1) {
      const start = first + i * 3600000
      const dayKey = localDateKey(start)
      const day = this.days.get(dayKey)
      out.push({ dayKey, start, day, b: day?.hours[new Date(start).getHours()] })
    }
    return out
  }

  /** 今天的小时格起点（自然日零点）。 */
  private static dayStartOf(now: number): number {
    return new Date(now).setHours(0, 0, 0, 0)
  }

  /** 24h 滚动窗口的小时格起点（当前整点往前 23 格）。 */
  private static rollingStartOf(now: number): number {
    const c = new Date(now)
    c.setMinutes(0, 0, 0)
    return c.getTime() - (HOURS - 1) * 3600000
  }

  /**
   * 一整天的小时桶是否齐（各格之和 >= 天桶计数）。
   *
   * 不齐 = 这天是升级前落的盘（没有小时粒度）→ 24h 窗口踩到它就只能整桶计入。
   * 宁可多算窗口外那截，也不能报一个比「今日」还小的数。
   */
  private static hoursComplete(d: DayBucket): boolean {
    return d.hours.reduce((n, h) => n + h.requests, 0) >= d.requests
  }

  /** 汇总 + Top 榜。 */
  stats(period: Period, now = Date.now()): StatsResult {
    // today 走天桶（今天这一桶就是答案）；24h 走小时桶；7d/30d 走天桶
    if (period === 'today') {
      const d = this.days.get(localDateKey(now))
      const acc = emptyAcc()
      if (d === undefined) return finish(acc, {}, {}, {}, this.lifetime)
      addDay(acc, d)
      // 天桶的维度表就是 today 的 Top 榜，不用另算
      return finish(acc, d.bySupplier, d.byModel, d.byRequested, this.lifetime)
    }

    if (period === '24h') {
      const slots = this.hourSlots(UsageStore.rollingStartOf(now))
      const acc = emptyAcc()
      const bySupplier: Record<string, Entry> = {}
      const byModel: Record<string, Entry> = {}
      const byRequested: Record<string, Entry> = {}
      for (const key of new Set(slots.map((s) => s.dayKey))) {
        const d = this.days.get(key)
        if (d === undefined) continue
        if (UsageStore.hoursComplete(d)) {
          // 小时粒度齐：只算窗口内踩到的格
          for (const s of slots) {
            if (s.dayKey === key && s.b !== undefined) addHour(acc, s.b)
          }
        } else {
          // 老数据（升级前落的盘）：整桶计入，宁可多算也不漏算
          addDay(acc, d)
        }
        // Top 榜只能走天桶的维度表（小时桶不拆维度）
        mergeInto(bySupplier, d.bySupplier)
        mergeInto(byModel, d.byModel)
        mergeInto(byRequested, d.byRequested)
      }
      return finish(acc, bySupplier, byModel, byRequested, this.lifetime)
    }

    const days = period === '7d' ? 7 : 30
    const acc = emptyAcc()
    const bySupplier: Record<string, Entry> = {}
    const byModel: Record<string, Entry> = {}
    const byRequested: Record<string, Entry> = {}
    for (let i = days - 1; i >= 0; i -= 1) {
      const d = this.days.get(localDateKey(now - i * 86400000))
      if (d === undefined) continue
      addDay(acc, d)
      mergeInto(bySupplier, d.bySupplier)
      mergeInto(byModel, d.byModel)
      mergeInto(byRequested, d.byRequested)
    }
    return finish(acc, bySupplier, byModel, byRequested, this.lifetime)
  }

  /** 柱状图数据：today/24h = 24 个小时桶，7d/30d = 天桶。 */
  chart(period: Period, now = Date.now()): ChartBucket[] {
    if (period === 'today' || period === '24h') {
      const p = (n: number): string => String(n).padStart(2, '0')
      const first = period === 'today' ? UsageStore.dayStartOf(now) : UsageStore.rollingStartOf(now)
      return this.hourSlots(first).map((s) => ({
        label: `${p(new Date(s.start).getHours())}:00`,
        requests: s.b?.requests ?? 0,
        tokens: (s.b?.promptTokens ?? 0) + (s.b?.completionTokens ?? 0),
      }))
    }
    const days = period === '7d' ? 7 : 30
    const out: ChartBucket[] = []
    for (let i = days - 1; i >= 0; i -= 1) {
      const ts = now - i * 86400000
      const d = this.days.get(localDateKey(ts))
      out.push({
        label: localDateKey(ts).slice(5),
        requests: d?.requests ?? 0,
        tokens: (d?.promptTokens ?? 0) + (d?.completionTokens ?? 0),
      })
    }
    return out
  }

  /** 最近请求明细。 */
  recentList(limit = 20): UsageRecord[] {
    return this.recent.slice(0, limit)
  }

  clear(): void {
    this.days.clear()
    this.recent = []
    this.lifetime = 0
    this.save()
  }

  /** 进程退出前把防抖中的写入落盘。 */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.save()
  }

  private scheduleSave(): void {
    if (this.fp === '' || this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.save()
    }, SAVE_DEBOUNCE_MS)
    this.timer.unref?.()
  }

  private load(): void {
    if (this.fp === '') return
    try {
      const f = JSON.parse(readFileSync(this.fp, 'utf8')) as Partial<UsageFile>
      this.days = new Map(Object.entries(f.days ?? {}))
      this.recent = Array.isArray(f.recent) ? f.recent.slice(0, RING_CAP) : []
      this.lifetime = typeof f.lifetime === 'number' ? f.lifetime : 0
      // 逐字段兜底：旧文件缺后加的字段（ttfb*/estimated*/hours）不能让整个桶变 NaN。
      // hours 额外修长度/补空：老文件没有它，且 spread 会整段覆盖成短数组或带洞。
      for (const [k, d] of this.days) {
        const day: DayBucket = { ...emptyDay(), ...d }
        const hours = Array.from({ length: HOURS }, (_, i) => ({ ...emptyHour(), ...d.hours?.[i] }))
        day.hours = hours
        this.days.set(k, day)
      }
    } catch {
      // 首次运行/文件损坏：从空开始，不阻断启动
    }
  }

  private save(): void {
    if (this.fp === '') return
    // prune 超过保留期的天桶（JSON 不能无限长）
    const cutoff = localDateKey(Date.now() - KEEP_DAYS * 86400000)
    for (const k of [...this.days.keys()]) {
      if (k < cutoff) this.days.delete(k)
    }
    const f: UsageFile = {
      days: Object.fromEntries(this.days),
      recent: this.recent,
      lifetime: this.lifetime,
    }
    try {
      const dir = dirname(this.fp)
      if (dir !== '' && dir !== '.') mkdirSync(dir, { recursive: true })
      const tmp = `${this.fp}.tmp`
      writeFileSync(tmp, JSON.stringify(f), { mode: 0o600 })
      renameSync(tmp, this.fp)
    } catch {
      // 持久化失败不阻断运行
    }
  }
}

/** 柱状图一桶。 */
export interface ChartBucket {
  label: string
  requests: number
  tokens: number
}

export interface StatsResult {
  requests: number
  ok: number
  failed: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  /** 平均耗时（ms）。 */
  avgDurationMs: number
  /** 平均首字节延迟（ms）；没有 TTFB 记录时为 0。 */
  avgTtfbMs: number
  /** 输入/输出为估算的请求数（面板提示用）。 */
  estimatedInputs: number
  estimatedOutputs: number
  /** 累计请求数（不受周期影响）。 */
  lifetime: number
  bySupplier: RankRow[]
  byModel: RankRow[]
  byRequested: RankRow[]
}

export interface RankRow {
  name: string
  requests: number
  ok: number
  failed: number
  promptTokens: number
  completionTokens: number
  lastTs: number
}

/** 累加器（stats 两条路径共用）。 */
interface Acc {
  requests: number
  ok: number
  failed: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  durationMs: number
  ttfbMs: number
  ttfbCount: number
  estimatedInputs: number
  estimatedOutputs: number
}

const emptyAcc = (): Acc => ({
  requests: 0, ok: 0, failed: 0,
  promptTokens: 0, completionTokens: 0, cachedTokens: 0,
  durationMs: 0, ttfbMs: 0, ttfbCount: 0,
  estimatedInputs: 0, estimatedOutputs: 0,
})

/** 天桶累加（today / 7d / 30d 路径，以及 24h 的「老数据整桶兜底」）。 */
function addDay(acc: Acc, d: DayBucket): void {
  acc.requests += d.requests
  acc.ok += d.ok
  acc.failed += d.failed
  acc.promptTokens += d.promptTokens
  acc.completionTokens += d.completionTokens
  acc.cachedTokens += d.cachedTokens
  acc.durationMs += d.durationMs
  acc.ttfbMs += d.ttfbMs
  acc.ttfbCount += d.ttfbCount
  acc.estimatedInputs += d.estimatedInputs
  acc.estimatedOutputs += d.estimatedOutputs
}

/** 小时桶累加（24h 路径）。 */
function addHour(acc: Acc, h: HourBucket): void {
  acc.requests += h.requests
  acc.ok += h.ok
  acc.failed += h.failed
  acc.promptTokens += h.promptTokens
  acc.completionTokens += h.completionTokens
  acc.cachedTokens += h.cachedTokens
  acc.durationMs += h.durationMs
  acc.ttfbMs += h.ttfbMs
  acc.ttfbCount += h.ttfbCount
  acc.estimatedInputs += h.estimatedInputs
  acc.estimatedOutputs += h.estimatedOutputs
}

function finish(
  acc: Acc,
  bySupplier: Record<string, Entry>,
  byModel: Record<string, Entry>,
  byRequested: Record<string, Entry>,
  lifetime: number,
): StatsResult {
  return {
    requests: acc.requests,
    ok: acc.ok,
    failed: acc.failed,
    promptTokens: acc.promptTokens,
    completionTokens: acc.completionTokens,
    cachedTokens: acc.cachedTokens,
    avgDurationMs: acc.requests > 0 ? Math.round(acc.durationMs / acc.requests) : 0,
    avgTtfbMs: acc.ttfbCount > 0 ? Math.round(acc.ttfbMs / acc.ttfbCount) : 0,
    estimatedInputs: acc.estimatedInputs,
    estimatedOutputs: acc.estimatedOutputs,
    lifetime,
    bySupplier: top(bySupplier),
    byModel: top(byModel),
    byRequested: top(byRequested),
  }
}

function mergeInto(target: Record<string, Entry>, src: Record<string, Entry>): void {
  for (const [k, v] of Object.entries(src)) {
    const t = target[k]
    if (t === undefined) {
      target[k] = { ...emptyEntry(), ...v }
      continue
    }
    t.requests += v.requests
    t.ok += v.ok
    t.failed += v.failed
    t.promptTokens += v.promptTokens
    t.completionTokens += v.completionTokens
    t.cachedTokens += v.cachedTokens
    t.lastTs = Math.max(t.lastTs, v.lastTs)
  }
}

/** Top 榜：按请求数降序，取前 10。 */
function top(map: Record<string, Entry>): RankRow[] {
  return Object.entries(map)
    .map(([name, e]) => ({
      name,
      requests: e.requests,
      ok: e.ok,
      failed: e.failed,
      promptTokens: e.promptTokens,
      completionTokens: e.completionTokens,
      lastTs: e.lastTs,
    }))
    .sort((a, b) => b.requests - a.requests || b.lastTs - a.lastTs)
    .slice(0, 10)
}
