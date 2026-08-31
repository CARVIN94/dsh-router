/**
 * 路由系统 (Routing System) panel — a simplified 9router.
 *
 * Four tabs fed by the host half (/router/api/*), mirroring 9router's
 * dashboard: 概览 (usage), 供应商 (supplier cards → detail: accounts +
 * add-account + models), 组合 (combo fallback chains),
 * 端点与密钥 (endpoint URL + API keys + auth).
 *
 * **挂载在「设置」里**（`settings.section` 座位），所以布局规则跟中心栏劫持时期不同：
 *   - 没有 masthead / 返回会话按钮 —— 设置面板自带标题栏和关闭
 *   - **滚动归外壳**（`.VOzbGW_options`，overflow-y:auto）—— 这里只管内容流，
 *     不设 height/overflow，否则会和外壳抢滚动、内容被裁
 *   - 根节点外面套了一层 `display: contents`，所以根节点没有自己的盒子，
 *     不能用 height:100% / flex:1 撑满那套写法
 *   - 内容宽度实测 564px（面板 612 − 左右 padding 24），卡片 grid 按这个宽度排
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ROUTER_API_BASE,
  type RouterCombosResponse,
  type RouterHealthResponse,
  type RouterStatusResponse,
} from '../shared.ts'
import { SupplierDetail } from './SupplierDetail.tsx'
import { EndpointTab } from './EndpointTab.tsx'
import { CombosTab } from './CombosTab.tsx'
import { StatsTab } from './StatsTab.tsx'

type TabId = 'overview' | 'suppliers' | 'combos' | 'endpoint'

interface Snapshot {
  health: RouterHealthResponse | null
  status: RouterStatusResponse | null
  combos: RouterCombosResponse | null
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${ROUTER_API_BASE}${path}`, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return response.json() as Promise<T>
}

interface RouterViewProps {
  /**
   * 设置页不提供「返回会话」（关闭由设置面板自己负责），所以这里是可选的：
   * 中心栏劫持那套老挂载方式还留着时会传。
   */
  onBack?: () => void
}

export function RouterView({ onBack }: RouterViewProps): JSX.Element {
  const [tab, setTab] = useState<TabId>('overview')
  const [detailSupplier, setDetailSupplier] = useState<{ id: string; name: string; icon?: string } | null>(null)
  const [snapshot, setSnapshot] = useState<Snapshot>({ health: null, status: null, combos: null })
  const [refreshing, setRefreshing] = useState(false)
  const mounted = useRef(true)

  const refresh = async (): Promise<void> => {
    if (refreshing) return
    setRefreshing(true)
    try {
      const [health, status, combos] = await Promise.all([
        getJson<RouterHealthResponse>('/health').catch(() => null),
        getJson<RouterStatusResponse>('/status').catch(() => null),
        getJson<RouterCombosResponse>('/combos').catch(() => null),
      ])
      if (mounted.current) {
        setSnapshot({ health, status, combos })
      }
    } finally {
      if (mounted.current) setRefreshing(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => { mounted.current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const suppliers = snapshot.health?.suppliers ?? []
  const accounts = snapshot.status?.accounts ?? []
  const combos = snapshot.combos?.combos ?? []
  const suppliersError = snapshot.status?.ok === false ? snapshot.status.error : undefined
  const combosError = snapshot.combos?.ok === false ? snapshot.combos.error : undefined

  /** 渲染一组供应商卡片（内置 / 插件分开）。 */
  const renderSupplierGroup = (title: string, group: Array<{ id: string; name: string; icon?: string; source?: string }>): ReactNode => {
    if (group.length === 0) return null
    return (
      <div className="dshr-supplierGroup">
        <div className="dshr-supplierGroupTitle">{title}</div>
        <div className="dshr-supplierGrid">
          {group.map(supplier => {
            const supplierAccounts = accounts.filter(a => a.supplier === supplier.id)
            const healthy = supplierAccounts.filter(a => !a.cooling && !a.disabled).length
            return (
              <section key={supplier.id} className="dshr-supplierCard" onClick={() => setDetailSupplier(supplier)}>
                <div className="dshr-supplierRow">
                  {supplier.icon !== undefined && (
                    <img className="dshr-supplierIcon" src={supplier.icon} alt="" />
                  )}
                  <div className="dshr-supplierName">{supplier.name}</div>
                </div>
                <div className="dshr-supplierMeta">
                  {supplierAccounts.length > 0 && (
                    <span className="dshr-muted">{supplierAccounts.length}/{healthy} 健康</span>
                  )}
                  <span className="dshr-chevron">›</span>
                </div>
              </section>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="dshr-settings">
      {/* tab 切换：设置页已有页面标题，这里只做二级切换 */}
      <nav className="dshr-tabs" role="tablist" aria-label="路由分区">
        <button type="button" role="tab" aria-selected={tab === 'overview'} className={`dshr-tab${tab === 'overview' ? ' dshr-tab-on' : ''}`} onClick={() => setTab('overview')}>
          概览
        </button>
        <button type="button" role="tab" aria-selected={tab === 'suppliers'} className={`dshr-tab${tab === 'suppliers' ? ' dshr-tab-on' : ''}`} onClick={() => setTab('suppliers')}>
          供应商 <span className="dshr-navCount">{suppliers.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'combos'} className={`dshr-tab${tab === 'combos' ? ' dshr-tab-on' : ''}`} onClick={() => setTab('combos')}>
          组合 <span className="dshr-navCount">{combos.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'endpoint'} className={`dshr-tab${tab === 'endpoint' ? ' dshr-tab-on' : ''}`} onClick={() => setTab('endpoint')}>
          端点与密钥
        </button>
        {/* 返回会话只在老的中心栏挂载方式下出现（设置页有关闭按钮） */}
        {onBack !== undefined && (
          <button type="button" className="dshr-tabBack" onClick={onBack}>返回会话</button>
        )}
      </nav>

      <div className="dshr-settingsBody">
        {/* ---------------- 概览（用量看板） ---------------- */}
        {tab === 'overview' && (
          <StatsTab
            active
            refreshing={refreshing}
            health={snapshot.health}
            onRefresh={() => void refresh()}
          />
        )}

        {/* ---------------- 供应商 ---------------- */}
        {tab === 'suppliers' && (
          detailSupplier !== null
            ? (
              <SupplierDetail
                supplier={detailSupplier}
                accounts={accounts}
                statusLoading={snapshot.status === null}
                onBack={() => setDetailSupplier(null)}
                onRefresh={() => void refresh()}
              />
            )
            : (
              <div className="dshr-tabBody">
                {suppliers.length === 0 && snapshot.health !== null && (
                  <div className="dshr-empty">暂无供应商</div>
                )}
                {renderSupplierGroup('内置', suppliers.filter(s => s.source !== 'external'))}
                {renderSupplierGroup('插件', suppliers.filter(s => s.source === 'external'))}
                {suppliersError !== undefined && (
                  <div className="dshr-empty">{suppliersError}</div>
                )}
              </div>
            )
        )}

        {/* ---------------- 组合 ---------------- */}
        {tab === 'combos' && (
          snapshot.combos === null
            ? <div className="dshr-tabBody"><div className="dshr-empty">加载中…</div></div>
            : combosError !== undefined
              ? <div className="dshr-tabBody"><div className="dshr-empty">{combosError}</div></div>
              : (
                <CombosTab
                  combos={combos}
                  aliases={snapshot.combos?.aliases ?? []}
                  onRefresh={() => void refresh()}
                />
              )
        )}

        {/* ---------------- 端点与密钥 ---------------- */}
        {tab === 'endpoint' && <EndpointTab />}
      </div>
    </div>
  )
}
