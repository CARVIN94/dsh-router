/**
 * 概览 —— 仿 9router `Dashboard → Usage → Overview` 的统计看板。
 *
 * 布局/交互跟其它 tab 一致（同一套 `.dshr-card` / `.dshr-tabBody`）：
 * 周期切换 → 汇总卡 → 趋势柱图 → Top 榜 → 最近请求。
 *
 * 两个 9router 有而我们刻意不做的（天花板，非遗漏）：
 *   - 成本估算：9router 有 pricingRepo 全表，dsh-router 没有价格数据，
 *     硬造一个只会显示假钱。宁可不显示。
 *   - 实时推送：9router 有 `/api/usage/stream` 的 SSE 看板。这里刷新才更新
 *     （面板本身有刷新按钮）。要实时就加一条 SSE 路由，看板不用改。
 *
 * token 口径见 `router/usage-tokens.ts`：上游不发 usage 时按字符数估算，
 * 估算过的字段标 `~`，鼠标悬停会说明。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ROUTER_API_BASE,
  type RouterChartBucket,
  type RouterChartResponse,
  type RouterPeriod,
  type RouterRankRow,
  type RouterStatsResponse,
  type RouterUsageRecord,
} from '../shared.ts'

/* ---------------- SVG 图标 ---------------- */

function Icon({ d, size = 18 }: { d: string; size?: number }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

const I = {
  chart: 'M3 3v18h18M7 15l4-5 3 3 5-7',
  bolt: 'M13 2L4 14h6l-1 8 9-12h-6z',
  refresh: 'M21 12a9 9 0 1 1-3-6.7M21 4v5h-5',
  empty: 'M4 4h16v16H4zM8 12h8M12 8v8',
}

/** 周期选项（9router 的 PERIODS）。 */
const PERIODS: Array<{ value: RouterPeriod; label: string }> = [
  { value: 'today', label: '今日' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7D' },
  { value: '30d', label: '30D' },
]

/** 千分位。 */
function fmt(n: number | undefined): string {
  return new Intl.NumberFormat().format(n ?? 0)
}

/** 大数缩写：1.2K / 3.4M（卡片和柱图上放不下完整数字时用）。 */
function fmtShort(n: number | undefined): string {
  const v = n ?? 0
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}K`
  return fmt(v)
}

function fmtDuration(ms: number | undefined): string {
  const v = ms ?? 0
  if (v <= 0) return '—'
  if (v < 1000) return `${v}ms`
  return `${(v / 1000).toFixed(1)}s`
}

function timeAgo(ts: number): string {
  const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diff < 60) return `${diff}秒前`
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`
  return `${Math.floor(diff / 86400)}天前`
}

function clockTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/* ---------------- 汇总卡 ---------------- */

interface StatCardProps {
  label: string
  value: string
  /** 右下角补充（如「估算」提示）。 */
  hint?: ReactNode
  /** 强调色（用现有语义色变量）。 */
  tone?: 'default' | 'primary' | 'ok' | 'warn' | 'danger'
  title?: string
}

function StatCard({ label, value, hint, tone = 'default', title }: StatCardProps): JSX.Element {
  return (
    <div className={`dshr-statCard dshr-statCard-${tone}`} title={title}>
      <span className="dshr-statLabel">{label}</span>
      <span className="dshr-statValue">{value}</span>
      {hint !== undefined && <span className="dshr-statHint">{hint}</span>}
    </div>
  )
}

/* ---------------- 趋势柱图（纯 SVG，不引图表库） ---------------- */

function BarChart({ buckets, busy }: { buckets: RouterChartBucket[]; busy: boolean }): JSX.Element {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(1, ...buckets.map((b) => b.tokens))
  const hasData = buckets.some((b) => b.requests > 0 || b.tokens > 0)
  const active = hover === null ? undefined : buckets[hover]

  return (
    <div className="dshr-barWrap">
      {busy && buckets.length > 0 && <div className="dshr-barBusy" aria-hidden="true" />}
      {!hasData
        ? (
          <div className="dshr-barEmpty">
            <span className="dshr-barEmptyIcon"><Icon d={I.empty} size={26} /></span>
            这个周期还没有请求
          </div>
        )
        : (
          <>
            <div className="dshr-barChart" onMouseLeave={() => setHover(null)}>
              {buckets.map((b, i) => {
                const pct = b.tokens === 0 ? 0 : Math.max(2, Math.round((b.tokens / max) * 100))
                return (
                  // 索引作 key：桶是按时间顺序固定位置的，本来就没有稳定 id
                  <div
                    key={i}
                    className={`dshr-barCol${hover === i ? ' dshr-barCol-hover' : ''}`}
                    onMouseEnter={() => setHover(i)}
                  >
                    <div className="dshr-barTrack">
                      <div className="dshr-barFill" style={{ height: `${pct}%` }} />
                    </div>
                    {/* 标签太密：7d/30d 隔一个显示，today/24h 每 4 小时一个 */}
                    {(buckets.length > 24 || i % 4 === 0 || i === buckets.length - 1) && (
                      <span className="dshr-barLabel">{b.label}</span>
                    )}
                  </div>
                )
              })}
            </div>
            <div className="dshr-barReadout">
              {active === undefined
                ? <span className="dshr-muted">悬停柱子看该时段明细</span>
                : (
                  <>
                    <strong>{active.label}</strong>
                    <span className="dshr-muted"> · {fmt(active.requests)} 请求</span>
                    <span className="dshr-muted"> · {fmt(active.tokens)} tokens</span>
                  </>
                )}
            </div>
          </>
        )}
    </div>
  )
}

/* ---------------- Top 榜 ---------------- */

function RankTable({ title, rows, empty }: { title: string; rows: RouterRankRow[]; empty: string }): JSX.Element {
  return (
    <section className="dshr-card">
      <div className="dshr-cardHead">
        <span className="dshr-cardIcon"><Icon d={I.chart} /></span>
        <div className="dshr-cardTitle">{title}</div>
        <span className="dshr-cardMeta">{rows.length > 0 ? `Top ${rows.length}` : ''}</span>
      </div>
      {rows.length === 0
        ? <div className="dshr-empty">{empty}</div>
        : (
          <div className="dshr-rankList">
            <div className="dshr-rankRow dshr-rankHead">
              <span className="dshr-rankName">名称</span>
              <span className="dshr-rankNum">请求</span>
              <span className="dshr-rankNum">输入</span>
              <span className="dshr-rankNum">输出</span>
              <span className="dshr-rankNum">最近</span>
            </div>
            {rows.map((r) => (
              <div key={r.name} className="dshr-rankRow">
                <span className="dshr-rankName dshr-mono" title={r.name}>{r.name}</span>
                <span className="dshr-rankNum">
                  {fmt(r.requests)}
                  {r.failed > 0 && <span className="dshr-rankFail" title={`${r.failed} 次失败`}> ({r.failed})</span>}
                </span>
                <span className="dshr-rankNum">{fmtShort(r.promptTokens)}</span>
                <span className="dshr-rankNum">{fmtShort(r.completionTokens)}</span>
                <span className="dshr-rankNum dshr-muted">{r.lastTs > 0 ? timeAgo(r.lastTs) : '—'}</span>
              </div>
            ))}
          </div>
        )}
    </section>
  )
}

/* ---------------- 最近请求 ---------------- */

function RecentTable({ rows }: { rows: RouterUsageRecord[] }): JSX.Element {
  return (
    <section className="dshr-card">
      <div className="dshr-cardHead">
        <span className="dshr-cardIcon"><Icon d={I.bolt} /></span>
        <div className="dshr-cardTitle">最近请求</div>
        <span className="dshr-cardMeta">最近 {rows.length} 条</span>
      </div>
      {rows.length === 0
        ? <div className="dshr-empty">还没有请求记录</div>
        : (
          <div className="dshr-recentList">
            <div className="dshr-recentRow dshr-rankHead">
              <span className="dshr-recentTime">时间</span>
              <span className="dshr-recentModel">模型</span>
              <span className="dshr-recentSupplier">供应商</span>
              <span className="dshr-rankNum">In / Out</span>
              <span className="dshr-rankNum">耗时</span>
            </div>
            {rows.map((r, i) => (
              // 明细没有 id；同毫秒两条请求是可能的，索引用 ts+模型+序号兜底
              <div key={`${r.ts}-${r.model}-${i}`} className={`dshr-recentRow${r.ok ? '' : ' dshr-recentRow-fail'}`}>
                <span className="dshr-recentTime" title={new Date(r.ts).toLocaleString()}>
                  <span className={`dshr-dot ${r.ok ? 'dshr-dot-ok' : 'dshr-dot-fail'}`} />
                  {clockTime(r.ts)}
                </span>
                <span className="dshr-recentModel dshr-mono" title={`请求 ${r.requested}${r.error === undefined ? '' : ` · ${r.error}`}`}>
                  {r.model === '' ? r.requested : r.model}
                </span>
                <span className="dshr-recentSupplier">{r.supplier === '' ? '—' : r.supplier}</span>
                <span className="dshr-rankNum">
                  <span className="dshr-tokenIn">{fmtShort(r.promptTokens)}{r.inputEstimated ? '~' : ''}</span>
                  {' / '}
                  <span className="dshr-tokenOut">{fmtShort(r.completionTokens)}{r.outputEstimated ? '~' : ''}</span>
                </span>
                <span className="dshr-rankNum dshr-muted">{fmtDuration(r.durationMs)}</span>
              </div>
            ))}
          </div>
        )}
    </section>
  )
}

/* ---------------- 主面板 ---------------- */

interface StatsTabProps {
  /** 顶部刷新按钮触发（父组件统一拉快照）。 */
  onRefresh: () => void
  refreshing: boolean
  /** 掩码：面板是否可见（不可见时不做周期轮询）。 */
  active: boolean
}

export function StatsTab({ onRefresh, refreshing, active }: StatsTabProps): JSX.Element {
  const [period, setPeriod] = useState<RouterPeriod>('today')
  const [stats, setStats] = useState<RouterStatsResponse | null>(null)
  const [chart, setChart] = useState<RouterChartBucket[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const load = async (p: RouterPeriod): Promise<void> => {
    try {
      const [sRes, cRes] = await Promise.all([
        fetch(`${ROUTER_API_BASE}/stats?period=${p}`, { cache: 'no-store' }),
        fetch(`${ROUTER_API_BASE}/stats/chart?period=${p}`, { cache: 'no-store' }),
      ])
      const s = await sRes.json() as RouterStatsResponse
      const c = await cRes.json() as RouterChartResponse
      if (!mounted.current) return
      setStats(s.ok ? s : null)
      setChart(c.ok ? c.chart ?? [] : [])
      setError(s.ok ? (c.ok ? '' : (c.error ?? '')) : (s.error ?? '加载统计失败'))
    } catch (err) {
      if (mounted.current) setError((err as Error).message)
    } finally {
      if (mounted.current) setLoading(false)
    }
  }

  // 切周期/变可见时重新拉。父组件的「刷新」走 refreshToken。
  useEffect(() => {
    if (!active) return
    setLoading(true)
    void load(period)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, active])

  const s = stats
  const successRate = s !== null && s.requests !== undefined && s.requests > 0
    ? Math.round(((s.okCount ?? 0) / s.requests) * 100)
    : null
  // 估算提示：只有真有估算时才显示，别没事吓唬人
  const estimated = s !== null && ((s.estimatedInputs ?? 0) > 0 || (s.estimatedOutputs ?? 0) > 0)

  return (
    <div className="dshr-tabBody">
      {/* 周期切换 + 刷新 */}
      <div className="dshr-statsBar">
        <div className="dshr-periods" role="tablist" aria-label="统计周期">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              type="button"
              role="tab"
              aria-selected={period === p.value}
              className={`dshr-period${period === p.value ? ' dshr-period-on' : ''}`}
              onClick={() => setPeriod(p.value)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="dshr-statsBarRight">
          {s?.lifetime !== undefined && s.lifetime > 0 && (
            <span className="dshr-muted dshr-lifetime" title="累计请求数（不受周期影响）">
              累计 {fmt(s.lifetime)}
            </span>
          )}
          {/* 纯图标：文字「刷新中…」在窄屏会把周期条挤换行。
              禁用态必须看得出来（见 .dshr-iconBtn:disabled 的注释）。 */}
          <button
            type="button"
            className="dshr-iconBtn"
            onClick={() => { void load(period); onRefresh() }}
            disabled={refreshing}
            title={refreshing ? '刷新中…' : '刷新统计'}
            aria-label={refreshing ? '刷新中' : '刷新统计'}
          >
            <span className={refreshing ? 'dshr-spin' : undefined}><Icon d={I.refresh} size={16} /></span>
          </button>
        </div>
      </div>

      {error !== '' && (
        <div className="dshr-alert">
          <strong>统计加载失败</strong>
          <span>{error}</span>
        </div>
      )}

      {loading && s === null
        ? <div className="dshr-empty">加载中…</div>
        : (
          <>
            {/* 汇总卡（照 9router OverviewCards 的五宫格） */}
            <div className="dshr-statGrid">
              <StatCard label="总请求" value={fmt(s?.requests)} hint={successRate === null ? undefined : `成功率 ${successRate}%`} tone="default" />
              <StatCard
                label="输入 Tokens"
                value={fmtShort(s?.promptTokens)}
                hint={(s?.estimatedInputs ?? 0) > 0 ? '~ 含估算' : undefined}
                tone="primary"
                title="包含缓存命中的输入"
              />
              <StatCard label="缓存 Tokens" value={fmtShort(s?.cachedTokens)} hint="命中缓存的输入部分" tone="ok" />
              <StatCard
                label="输出 Tokens"
                value={fmtShort(s?.completionTokens)}
                hint={(s?.estimatedOutputs ?? 0) > 0 ? '~ 含估算' : undefined}
                tone="ok"
              />
              <StatCard
                label="平均耗时"
                value={fmtDuration(s?.avgDurationMs)}
                hint={(s?.avgTtfbMs ?? 0) > 0 ? `首字节 ${fmtDuration(s?.avgTtfbMs)}` : undefined}
                tone="warn"
              />
            </div>

            {estimated && (
              <p className="dshr-estimateNote">
                带 <code>~</code> 的数字为估算：部分上游不返回用量，按 ~4 字符/token 推算。请求数与耗时不受影响。
              </p>
            )}

            {/* 趋势柱图 */}
            <section className="dshr-card">
              <div className="dshr-cardHead">
                <span className="dshr-cardIcon"><Icon d={I.chart} /></span>
                <div className="dshr-cardTitle">Token 趋势</div>
                <span className="dshr-cardMeta">{PERIODS.find((p) => p.value === period)?.label}</span>
              </div>
              <BarChart buckets={chart} busy={loading} />
            </section>

            {/* Top 榜 */}
            <div className="dshr-rankPair">
              <RankTable title="按供应商" rows={s?.bySupplier ?? []} empty="这个周期还没有请求" />
              <RankTable title="按模型 / 组合" rows={s?.byModel ?? []} empty="这个周期还没有请求" />
            </div>

            <RecentTable rows={s?.recent ?? []} />
          </>
        )}
    </div>
  )
}
