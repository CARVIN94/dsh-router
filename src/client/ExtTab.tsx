/**
 * 扩展 (Ext) 页 —— 列出**已启用**的扩展插件，只读。
 *
 * 数据来自 `/router/api/ext`：核心把自己存的开关（`ext.json`）+ 扩展器报的
 * 运行时事实（`ready` / `detail`）合并后给面板。扩展器只实现具体能力（如 RTK）。
 *
 * 两个刻意的形状（与「开关在官方插件页」这一决定配套）：
 *   1. **只列已启用的** —— 关闭的扩展连卡片都不出现。这里是「正在生效的东西」的
 *      展台，不是配置页；要去改开关，去设置 → 插件 → dsh-router-core 详情页的
 *      「路由组件」一节。
 *   2. **本页不发 PATCH** —— 启停只有一个入口，避免两处状态各说各话。
 *
 * 未装任何扩展，或装了但都没启用 → 同一条空状态提示。
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
  bolt: 'M13 2L4 14h6l-1 8 9-12h-6z',
  puzzle: 'M4 7h3a2 2 0 0 1 4 0h5a2 2 0 0 1 2 1v4a2 2 0 0 0 0 4v4H8v-3a2 2 0 0 1 0-4H4V7z',
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

  // 只展已启用的。`enabled` 缺失按未启用读（与插件页同一口径：没拿到的事实不当真）。
  const shown = items.filter(item => item.enabled === true)

  // 打开详情视图：用 live item（详情里显示的是加载那一刻的运行时事实）。
  const selected = selectedId !== null ? shown.find((i) => i.id === selectedId) ?? null : null
  if (selected !== null) {
    return <ExtDetail item={selected} onBack={() => setSelectedId(null)} />
  }

  return (
    <div className="dshr-tabBody">
      {error !== '' && (
        <div className="dshr-alert"><strong>出错了</strong><span>{error}</span></div>
      )}

      {!loaded ? (
        <div className="dshr-empty">加载中…</div>
      ) : shown.length === 0 ? (
        <div className="dshr-keyEmpty">
          <span className="dshr-keyEmptyIcon"><Icon d={I.puzzle} size={30} /></span>
          <p className="dshr-keyEmptyTitle">暂无启用的扩展</p>
          <p className="dshr-keyEmptyDesc">
            开关在 <strong>设置 → 插件 → dsh-router-core</strong> 的「路由组件」一节；
            启用后这里会列出它
          </p>
        </div>
      ) : (
        <div className="dshr-supplierGrid">
          {shown.map(item => {
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
                  {/* 描述留在详情页（卡片放不下）；这一行放稳定的 id，够短不会撑破布局 */}
                  <span className="dshr-mono dshr-muted">{item.id}</span>
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
