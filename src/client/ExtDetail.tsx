/**
 * 扩展详情页 —— 从设置 → 路由 → 扩展 的卡片点进来。
 *
 * 通用：返回键 + 扩展名/说明/就绪态。`watch` 扩展再渲染进程监控面板：
 * 实时采样「agent 启动的进程」，每行 PID / 命令 / CPU% / 内存%，**只读**——不提供
 * kill（杀进程是大事，交由用户在 CLI 自己操作）。面板提供「复制 PID」和
 * 「复制 kill 命令」两个剪贴板动作方便用户去终端处理。
 * 进程数据走后端 `/router/api/ext/:id/processes`；`ps` 瞬时失败时保留上一帧，别刷成
 * 整屏错误。
 */
import { useEffect, useRef, useState } from 'react'
import {
  ROUTER_API_BASE,
  type RouterExtItem,
  type RouterWatchProcess,
  type RouterWatchResponse,
} from '../shared.ts'

function Icon({ d, size = 18 }: { d: string; size?: number }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

const I = {
  back: 'M19 12H5M12 19l-7-7 7-7',
  refresh: 'M20.5 12a8.5 8.5 0 1 1-2.6-6.1M20.5 4v5h-5',
  node: 'M8 5.5L12 3l4 2.5v5L12 13l-4-2.5v-5zM4 9v5l4 2.5M12 13v5l4-2.5M20 9v5l-4 2.5',
  bolt: 'M13 2L4 14h6l-1 8 9-12h-6z',
  copy: 'M8 8h11v11H8zM5 14H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  check: 'M4 12.5l5 5L20 6.5',
}

/** 刷新按钮（带禁用中旋转）。 */
function RefreshBtn({ onClick, busy }: { onClick: () => void; busy: boolean }): JSX.Element {
  return (
    <button
      type="button"
      className="dshr-iconButton"
      onClick={onClick}
      disabled={busy}
      title="刷新进程"
      aria-label="刷新进程"
    >
      <span className={busy ? 'dshr-spin' : undefined}><Icon d={I.refresh} size={16} /></span>
    </button>
  )
}

function fmtPct(v: number | undefined): string {
  const n = v ?? 0
  return `${n.toFixed(1)}%`
}

interface ExtDetailProps {
  item: RouterExtItem
  onBack: () => void
  /** 开关切换（由列表页持有状态与 PATCH；这里只做触发）。 */
  onToggle: (item: RouterExtItem, value: boolean) => void
}

export function ExtDetail({ item, onBack, onToggle }: ExtDetailProps): JSX.Element {
  return (
    <div className="dshr-tabBody">
      {/* Header（同供应商详情：返回链接 + 图标 + 名称/副行） */}
      <div className="dshr-providerHead">
        <button type="button" className="dshr-backLink" onClick={onBack}>
          <Icon d={I.back} size={16} />
          返回
        </button>
        <div className="dshr-providerTitleRow">
          <div className="dshr-providerIcon" style={{ color: 'var(--rs-faint)', background: 'var(--rs-layer-2)' }}>
            <Icon d={I.bolt} size={22} />
          </div>
          <div className="dshr-providerMeta">
            <h1 className="dshr-providerName">{item.name}</h1>
            <p className="dshr-providerCount">
              <span className="dshr-mono">{item.id}</span>
              {item.enabled ? ' · 已启用' : ' · 未启用'}
              {item.ready === false ? ' · 未就绪' : ''}
            </p>
          </div>
          {/* 开关放在标题行右侧（同供应商详情的编辑按钮位） */}
          <button
            type="button"
            className={`dshr-toggle dshr-extDetailToggle ${item.enabled ? 'dshr-toggle-on' : ''}`}
            role="switch"
            aria-checked={!!item.enabled}
            disabled={item.ready === false && !item.enabled}
            onClick={() => void onToggle(item, !item.enabled)}
            title={item.ready === false && !item.enabled
              ? '当前不可用,无法开启'
              : item.enabled ? `关闭 ${item.name}` : `开启 ${item.name}`}
          >
            <span className="dshr-toggleKnob" />
          </button>
        </div>
      </div>

      {/* 扩展说明 */}
      {item.description !== undefined && item.description !== '' && (
        <section className="dshr-card">
          <div className="dshr-muted" style={{ padding: '12px 14px' }}>{item.description}</div>
        </section>
      )}

      {/* 未就绪警示（同供应商详情的出错横幅） */}
      {item.ready === false && (
        <div className="dshr-alert">
          <strong>未就绪</strong>
          <span>{item.detail !== undefined && item.detail !== '' ? item.detail : '当前不可用'}</span>
        </div>
      )}

      {item.id === 'watch' ? <WatchPanel /> : null}
    </div>
  )
}

/** watch 的进程监控面板：轮询采样（只读）+ 复制 PID / 复制 kill 命令。 */
function WatchPanel(): JSX.Element {
  const [processes, setProcesses] = useState<RouterWatchProcess[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  // 刚复制成的那条（pid + 文本），显示「已复制」提示，1.2s 后清除。
  const [copied, setCopied] = useState<{ pid: number; text: string } | null>(null)
  const alive = useRef(true)
  const now = useRef(Date.now())

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const load = async (): Promise<void> => {
    try {
      const res = await fetch(`${ROUTER_API_BASE}/ext/watch/processes`, { cache: 'no-store' })
      if (!res.ok) {
        // 尽量把后端的原因露出来（如「extension not found」/「extension api not found」），
        // 别只剩 `HTTP 404`——它分不清是扩展没装、还是 api 没命中。
        let reason = ''
        try {
          const err = await res.json() as { error?: string }
          if (err.error) reason = ` — ${err.error}`
        } catch { /* 非 JSON 响应体,忽略 */ }
        if (alive.current) setError(`HTTP ${res.status}${reason}`)
        return
      }
      // 响应体非 JSON(历史上 404 空 body 会在这里抛 Unexpected end of JSON input)。
      // 分开 try,别把"非 JSON"混进网络错误的文案里。
      let data: RouterWatchResponse
      try {
        data = await res.json() as RouterWatchResponse
      } catch {
        if (alive.current) setError('响应不是 JSON')
        return
      }
      if (!alive.current) return
      setError(data.ok ? '' : (data.error ?? '加载进程失败'))
      if (data.ok && data.processes !== undefined) setProcesses(data.processes) // ?: 失败保留上一帧
    } catch (err) {
      if (alive.current) setError((err as Error).message) // 失败保留上一帧
    } finally {
      if (alive.current) setLoading(false)
    }
  }

  // 进入面板后轮询采样（3s；离开卸载）。
  useEffect(() => {
    void load()
    const timer = setInterval(() => { void load() }, 3000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const copy = (pid: number, text: string): void => {
    const stamp = Date.now()
    now.current = stamp
    void navigator.clipboard.writeText(text)
      .then(() => {
        if (alive.current && now.current === stamp) {
          setCopied({ pid, text })
          setTimeout(() => { if (alive.current) setCopied((c) => c?.pid === pid ? null : c) }, 1200)
        }
      })
      .catch(() => { if (alive.current) setError('复制失败') })
  }

  return (
    <section className="dshr-card">
      <div className="dshr-cardHead">
        <span className="dshr-cardIcon"><Icon d={I.node} /></span>
        <div className="dshr-cardTitle">运行进程</div>
        <span className="dshr-cardMeta">agent 启动 · 只读 · 3s 采样</span>
        <RefreshBtn onClick={() => void load()} busy={loading} />
      </div>

      {error !== '' && (
        <div className="dshr-alert"><strong>采样失败</strong><span>{error}（保留上一帧）</span></div>
      )}

      {!loading && processes.length === 0 ? (
        <div className="dshr-empty">
          暂无会话中 agent 启动的进程。运行诸如 <code>node server.js</code> 的长驻命令后
          会出现在这里。
        </div>
      ) : (
        <div className="dshr-rankList">
          <div className="dshr-rankRow dshr-rankHead">
            <span className="dshr-rankName">PID / 命令</span>
            <span className="dshr-rankNum">CPU</span>
            <span className="dshr-rankNum">内存</span>
            <span className="dshr-rankNum" />
          </div>
          {processes.map((p) => {
            const done = copied?.pid === p.pid
            return (
              <div key={p.pid} className="dshr-rankRow">
                <span className="dshr-rankName dshr-mono" title={p.command}>
                  <span className="dshr-muted">{p.pid}</span>&ensp;{p.command}
                </span>
                <span className="dshr-rankNum">{fmtPct(p.cpu)}</span>
                <span className="dshr-rankNum">{fmtPct(p.mem)}</span>
                <span className="dshr-rankNum dshr-procOps">
                  {done
                    ? <span className="dshr-muted"><Icon d={I.check} size={13} /> 已复制</span>
                    : (
                      <>
                        <button
                          type="button"
                          className="dshr-miniButton"
                          onClick={() => copy(p.pid, String(p.pid))}
                          title={`复制 PID ${p.pid}`}
                        >
                          <Icon d={I.copy} size={13} /> PID
                        </button>
                        <button
                          type="button"
                          className="dshr-miniButton"
                          onClick={() => copy(p.pid, `kill -TERM ${p.pid}`)}
                          title={`复制 kill -TERM ${p.pid}`}
                        >
                          <Icon d={I.copy} size={13} /> kill
                        </button>
                      </>
                    )}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}