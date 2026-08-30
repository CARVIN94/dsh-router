/**
 * 用量落盘与聚合 —— 概览看板的数据源。
 *
 * 结构照 9router `usageRepo` 的双表思路（按天聚合 + 最近明细），但用 **JSON
 * 落盘**而不是 SQLite：dsh-router 现有持久化全是 JSON（supplier-config.json /
 * keys.json），不为一个看板引入数据库依赖。
 *
 * 两条查询路径（照 9router `getUsageStats` 的 `useDailySummary` 分叉）：
 *   - `today` / `24h` → 走**明细环**（滚动窗口，天桶是自然日，对不上）
 *   - `7d` / `30d`   → 走**天桶**（长期精确，不受明细环容量限制）
 *
 * 天花板（JSON 的代价，刻意接受）：
 *   - 明细环只留最近 `RING_CAP` 条。超量时 today/24h 会**少算**（天桶不会，
 *     所以 7d/30d 永远准）。要彻底准就把明细也落盘成按小时的桶，届时
 *     `chart()` 的小时桶直接读它即可，接口不用变。
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

/** 明细环容量：够 today/24h 看，又不至于让 JSON 无限长。 */
const RING_CAP = 500
/** 天桶保留天数。 */
const KEEP_DAYS = 30
/** 落盘防抖。 */
const SAVE_DEBOUNCE_MS = 2000

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

  /** 窗口内的明细（today/24h 路径）。 */
  private inWindow(period: Period, now: number): UsageRecord[] {
    const cutoff = period === 'today' ? new Date(now).setHours(0, 0, 0, 0) : now - 86400000
    return this.recent.filter((r) => r.ts >= cutoff)
  }

  /** 汇总 + Top 榜。 */
  stats(period: Period, now = Date.now()): StatsResult {
    // today/24h 走明细环（滚动窗口）；7d/30d 走天桶
    if (period === 'today' || period === '24h') {
      const rows = this.inWindow(period, now)
      const acc = emptyAcc()
      const bySupplier: Record<string, Entry> = {}
      const byModel: Record<string, Entry> = {}
      const byRequested: Record<string, Entry> = {}
      for (const rec of rows) {
        addRec(acc, rec)
        bumpInto(bySupplier, rec.supplier, rec)
        bumpInto(byModel, rec.model, rec)
        bumpInto(byRequested, rec.requested, rec)
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
      mergeInto(bySupplier, d.bySupplier)
      mergeInto(byModel, d.byModel)
      mergeInto(byRequested, d.byRequested)
    }
    return finish(acc, bySupplier, byModel, byRequested, this.lifetime)
  }

  /** 柱状图数据：today/24h = 24 个小时桶（走明细环），7d/30d = 天桶。 */
  chart(period: Period, now = Date.now()): ChartBucket[] {
    if (period === 'today' || period === '24h') {
      const rows = this.inWindow(period, now)
      const start = period === 'today'
        ? Math.floor(new Date(now).setHours(0, 0, 0, 0) / 3600000) * 3600000
        : Math.floor((now - 23 * 3600000) / 3600000) * 3600000
      const buckets: ChartBucket[] = Array.from({ length: 24 }, (_, i) => ({
        label: `${String(new Date(start + i * 3600000).getHours()).padStart(2, '0')}:00`,
        requests: 0,
        tokens: 0,
      }))
      for (const rec of rows) {
        const idx = Math.floor((rec.ts - start) / 3600000)
        const b = buckets[idx]
        if (b === undefined) continue
        b.requests += 1
        b.tokens += rec.promptTokens + rec.completionTokens
      }
      return buckets
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
      // 逐字段兜底：旧文件缺后加的字段（ttfb*/estimated*）不能让整个桶变 NaN
      for (const [k, d] of this.days) this.days.set(k, { ...emptyDay(), ...d })
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

function addRec(acc: Acc, rec: UsageRecord): void {
  acc.requests += 1
  if (rec.ok) acc.ok += 1
  else acc.failed += 1
  acc.promptTokens += rec.promptTokens
  acc.completionTokens += rec.completionTokens
  acc.cachedTokens += rec.cachedTokens
  acc.durationMs += rec.durationMs
  if (rec.ttfbMs > 0) {
    acc.ttfbMs += rec.ttfbMs
    acc.ttfbCount += 1
  }
  if (rec.inputEstimated) acc.estimatedInputs += 1
  if (rec.outputEstimated) acc.estimatedOutputs += 1
}

function bumpInto(map: Record<string, Entry>, key: string, rec: UsageRecord): void {
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
