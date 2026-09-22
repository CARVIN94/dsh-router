/**
 * 扩展 (Ext) 页 —— 列出所有注册进 `router.ext` 的扩展插件,每个一个开关。
 *
 * 数据来自 `/router/api/ext`:核心把自己存的开关(`ext.json`)+ 扩展器报的
 * 运行时事实(`ready` / `detail`)合并后给面板。扩展器只实现具体能力(如 RTK),
 * 开关与渲染都在核心。
 *
 * 布局贴近 EndpointTab 的「Require API key」开关行:每个扩展器一张卡片。
 * 未装任何扩展 → 空状态提示。
 */
import { useEffect, useRef, useState } from 'react'
import { ROUTER_API_BASE, type RouterExtItem, type RouterExtResponse } from '../shared.ts'
import { ExtDetail } from './ExtDetail.tsx'

function Icon({ d, size = 18 }: { d: string; size?: number }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

const I = {
  bolt: 'M13 2L4 14h6l-1 8 9-12h-6l1-8z',
  puzzle: 'M4 7h3a2 2 0 0 1 4 0h5a1 1 0 0 1 1 1v4a2 2 0 0 0 0 4v4H8v-3a2 2 0 0 1 0-4H4V7z',
}

export function ExtTab(): JSX.Element {
  const [items, setItems] = useState<RouterExtItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    void load()
    return () => { mounted.current = false }
  }, [])

  const load = async (): Promise<void> => {
    try {
      const response = await fetch(`${ROUTER_API_BASE}/ext`, { cache: 'no-store' })
      const data = await response.json() as RouterExtResponse
      if (mounted.current) {
        setError(data.ok ? '' : (data.error ?? '加载扩展失败'))
        setItems(data.enhancers ?? [])
        setLoaded(true)
      }
    } catch (err) {
      if (mounted.current) {
        setError((err as Error).message)
        setLoaded(true)
      }
    }
  }

  const toggle = async (item: RouterExtItem, value: boolean): Promise<void> => {
    // 乐观更新
    setItems(prev => prev.map(i => i.id === item.id ? { ...i, enabled: value } : i))
    setError('')
    try {
      const response = await fetch(`${ROUTER_API_BASE}/ext`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, enabled: value }),
        cache: 'no-store',
      })
      const data = await response.json() as RouterExtResponse
      if (mounted.current && data.enhancers) {
        setItems(data.enhancers)
      } else if (mounted.current && !data.ok) {
        setError(data.error ?? '切换失败')
        setItems(prev => prev.map(i => i.id === item.id ? { ...i, enabled: !value } : i))
      }
    } catch (err) {
      if (mounted.current) {
        setError((err as Error).message)
        setItems(prev => prev.map(i => i.id === item.id ? { ...i, enabled: !value } : i))
      }
    }
  }

  // 打开详情视图：用 live item（否则详情里的开关状态不会随列表更新）。
  const selected = selectedId !== null ? items.find((i) => i.id === selectedId) ?? null : null
  if (selected !== null) {
    return <ExtDetail item={selected} onBack={() => setSelectedId(null)} onToggle={toggle} />
  }

  return (
    <div className="dshr-tabBody">
      {error !== '' && (
        <div className="dshr-alert"><strong>出错了</strong><span>{error}</span></div>
      )}

      {!loaded ? (
        <div className="dshr-empty">加载中…</div>
      ) : items.length === 0 ? (
        <div className="dshr-keyEmpty">
          <span className="dshr-keyEmptyIcon"><Icon d={I.puzzle} size={30} /></span>
          <p className="dshr-keyEmptyTitle">暂无扩展</p>
          <p className="dshr-keyEmptyDesc">
            安装扩展插件(如 <code>dsh-router-ext-watch</code>)后,这里会出现开关
          </p>
        </div>
      ) : (
        <div className="dshr-supplierGrid">
          {items.map(item => {
            const notReady = item.ready === false
            return (
              <section key={item.id} className="dshr-supplierCard" onClick={() => setSelectedId(item.id)}>
                <div className="dshr-supplierRow">
                  {item.icon !== undefined ? (
                    <img
                      className="dshr-supplierIcon dshr-extLogo"
                      src={item.icon}
                      alt=""
                      onError={(e) => { e.currentTarget.style.display = 'none' }}
                    />
                  ) : (
                    <span className="dshr-supplierIcon"><Icon d={I.bolt} size={24} /></span>
                  )}
                  <div className="dshr-supplierName">{item.name}</div>
                </div>

                {notReady && (
                  <div className="dshr-extCardError">
                    {item.detail !== undefined && item.detail !== '' ? item.detail : '未就绪'}
                  </div>
                )}

                <div className="dshr-supplierMeta">
                  <span className="dshr-muted">{item.enabled ? '已启用' : '未启用'}</span>
                  <span className="dshr-chevron">›</span>
                </div>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}