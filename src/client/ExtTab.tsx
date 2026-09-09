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
            安装扩展插件(如 <code>dsh-router-ext-rtk</code>)后,这里会出现开关
          </p>
        </div>
      ) : (
        items.map(item => {
          const notReady = item.ready === false
          return (
            <section key={item.id} className="dshr-card">
              <div className="dshr-cardHead">
                <span className="dshr-cardIcon"><Icon d={I.bolt} /></span>
                <div className="dshr-cardTitle">{item.name}</div>
                {/* 开关放标题行最右端:.dshr-cardAction 是现成的
                    margin-left:auto(EndpointTab 的「创建 Key」就靠它),复用不新增。
                    不可用时禁开——禁了就无从开启成功。 */}
                <button
                  type="button"
                  className={`dshr-toggle dshr-cardAction ${item.enabled ? 'dshr-toggle-on' : ''}`}
                  role="switch"
                  aria-checked={!!item.enabled}
                  disabled={notReady && !item.enabled}
                  onClick={() => void toggle(item, !item.enabled)}
                  title={notReady && !item.enabled
                    ? '当前不可用,无法开启'
                    : item.enabled ? `关闭 ${item.name}` : `开启 ${item.name}`}
                >
                  <span className="dshr-toggleKnob" />
                </button>
              </div>

              {/* 内容区：说明 + 未就绪红字（左对齐、与卡片图标对齐） */}
              <div className="dshr-extBody">
                {item.description !== undefined && item.description !== '' && (
                  <div className="dshr-muted">{item.description}</div>
                )}
                {notReady && (
                  <div className="dshr-ext-error">
                    {item.detail !== undefined && item.detail !== ''
                      ? item.detail
                      : '未就绪,无法开启'}
                  </div>
                )}
              </div>
            </section>
          )
        })
      )}
    </div>
  )
}