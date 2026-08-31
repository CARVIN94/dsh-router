/**
 * 概览的「签到」汇总卡：一键签到所有支持签到的供应商 + 显示今天点过没。
 *
 * **「今日已签到」的口径（天花板，刻意不撒谎）**：这里只知道「今天在这个浏览器
 * 点过这个按钮没」，存在 localStorage，**不知道上游是不是真的签上了**。真凭据是
 * 上游的 `checked_in`，但那得逐个链接查（traywork 侧实测：积分不可信、
 * 只有 checked_in 算数），而当前契约里没有「查签到状态」这个能力。
 * 所以卡片文案是「今日已点」而不是「已签到」，悬停说明里写清这一点。
 *
 * 要真状态的升级路径：给 supplier 契约加 `checkinStatus?()`，核心加一条
 * `/suppliers/:id/checkin/status` 汇总路由，这里改成读它即可（卡片不用改）。
 */
import { useEffect, useState } from 'react'
import {
  ROUTER_API_BASE,
  type RouterCheckinResponse,
  type RouterHealthResponse,
} from '../shared.ts'

/** localStorage key：值 = 本地日期 YYYY-MM-DD。 */
const CHECKIN_STAMP_KEY = 'dsh-router:checkin-stamp'

/** 本地日切（跟用量统计的 localDateKey 同口径，别用 UTC）。 */
function todayKey(ts = Date.now()): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function readStamp(): string | null {
  try {
    return localStorage.getItem(CHECKIN_STAMP_KEY)
  } catch {
    // 隐私模式 / 存储被禁：退化为「不记得」，不影响签到本身能用
    return null
  }
}

function writeStamp(): void {
  try {
    localStorage.setItem(CHECKIN_STAMP_KEY, todayKey())
  } catch { /* 存不了就只影响这个提示，签到照常 */ }
}

interface CheckinCardProps {
  /** 供应商健康快照（用来筛出支持 checkinNow 的）。 */
  health: RouterHealthResponse | null
  /** 签完回调，让概览刷新快照（积分会变）。 */
  onRefresh: () => void
}

/** 可签到的供应商（能力 checkinNow）。 */
function checkinable(health: RouterHealthResponse | null): Array<{ id: string; name: string }> {
  return (health?.suppliers ?? [])
    .filter((s) => (s.capabilities ?? []).includes('checkinNow'))
    .map((s) => ({ id: s.id, name: s.name }))
}

export function CheckinCard({ health, onRefresh }: CheckinCardProps): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [stamp, setStamp] = useState<string | null>(null)
  const [result, setResult] = useState<string>('')
  const [error, setError] = useState<string>('')

  // 挂载时读一次；跨天自动失效因为存的是日期串
  useEffect(() => { setStamp(readStamp()) }, [])

  const targets = checkinable(health)
  const clickedToday = stamp === todayKey()

  const run = async (): Promise<void> => {
    if (busy || targets.length === 0) return
    setBusy(true)
    setError('')
    setResult('')
    let okCount = 0
    let alreadyCount = 0
    let totalCount = 0
    const failures: string[] = []
    // 顺序发：签到是有副作用的上游调用，并发会把上游风控招来（见 traework 9074）
    for (const t of targets) {
      try {
        const res = await fetch(`${ROUTER_API_BASE}/suppliers/${t.id}/checkin`, { method: 'POST', cache: 'no-store' })
        const data = await res.json() as RouterCheckinResponse
        if (data.error !== undefined) {
          failures.push(`${t.name}：${data.error}`)
          continue
        }
        okCount += data.succeeded
        alreadyCount += data.already
        totalCount += data.total
        if (!data.ok) {
          const first = (data.results ?? []).find((r) => r.status !== 'ok' && r.status !== 'already')
          failures.push(`${t.name}：${first?.message ?? '有链接签到失败'}`)
        }
      } catch (err) {
        failures.push(`${t.name}：${(err as Error).message}`)
      }
    }
    // 只要发出去过就记「今日已点」——点过就是点过，成败另说（文案也这么说）
    writeStamp()
    setStamp(todayKey())
    const parts = [`${okCount}/${totalCount} 成功`]
    if (alreadyCount > 0) parts.push(`${alreadyCount} 今日已签`)
    setResult(parts.join(' · '))
    if (failures.length > 0) setError(failures.join('；'))
    onRefresh()
    setBusy(false)
  }

  return (
    <div
      className={`dshr-statCard dshr-statCard-checkin${clickedToday ? ' dshr-statCard-done' : ''}`}
      title={clickedToday ? '今天在这个浏览器点过签到（不代表上游一定签上了）' : '对所有支持签到的供应商逐个签到'}
    >
      <span className="dshr-statLabel">签到</span>
      {targets.length === 0
        ? (
          <span className="dshr-statValue">—</span>
        )
        : (
          <button
            type="button"
            className="dshr-checkinButton"
            onClick={() => { void run() }}
            disabled={busy}
          >
            {busy ? <span className="dshr-spin">↻</span> : <span aria-hidden="true">✓</span>}
            {busy ? '签到中…' : '一键签到'}
          </button>
        )}
      <span className="dshr-statHint">
        {targets.length === 0
          ? '没有支持签到的供应商'
          : clickedToday
            ? `今日已点 · ${targets.length} 个供应商`
            : `${targets.length} 个供应商`}
      </span>
      {result !== '' && <span className="dshr-checkinOk">{result}</span>}
      {error !== '' && <span className="dshr-checkinErr" title={error}>{error}</span>}
    </div>
  )
}
