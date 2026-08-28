/**
 * 路由系统 (Routing System) panel — a simplified 9router.
 *
 * Three tabs fed by the host half (/router/api/*), mirroring 9router's
 * dashboard: 供应商 (supplier cards → detail: accounts + add-account + models),
 * 组合 (combo fallback chains), 端点与密钥 (endpoint URL + API keys + auth).
 *
 * Masthead: 返回会话 button on the LEFT, refresh on the right.
 * No online/offline concept — suppliers render whatever state they have.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ROUTER_API_BASE,
  ROUTER_TITLE,
  type RouterCombosResponse,
  type RouterHealthResponse,
  type RouterStatusResponse,
} from '../shared.ts'
import { SupplierDetail } from './SupplierDetail.tsx'
import { EndpointTab } from './EndpointTab.tsx'
import { CombosTab } from './CombosTab.tsx'

type TabId = 'suppliers' | 'combos' | 'endpoint'

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
  /** 关闭面板、返回会话。 */
  onBack: () => void
}

export function RouterView({ onBack }: RouterViewProps): JSX.Element {
  const [tab, setTab] = useState<TabId>('suppliers')
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
    <div className="dshr-shell">
      <header className="dshr-masthead">
        <button type="button" className="dshr-backButton" onClick={onBack} title="返回会话">
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10 3 5 8l5 5" />
          </svg>
          <span>返回会话</span>
        </button>
        <div className="dshr-brand">
          <div className="dshr-brandTitle">{ROUTER_TITLE}</div>
        </div>
      </header>

      <nav className="dshr-nav">
        <button type="button" aria-current={tab === 'suppliers' ? 'page' : undefined} onClick={() => setTab('suppliers')}>
          供应商 <span className="dshr-navCount">{suppliers.length}</span>
        </button>
        <button type="button" aria-current={tab === 'combos' ? 'page' : undefined} onClick={() => setTab('combos')}>
          组合 <span className="dshr-navCount">{combos.length}</span>
        </button>
        <button type="button" aria-current={tab === 'endpoint' ? 'page' : undefined} onClick={() => setTab('endpoint')}>
          端点与密钥
        </button>
      </nav>

      <div className="dshr-content">
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
