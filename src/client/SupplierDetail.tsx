/**
 * 供应商详情 — 布局交互贴近 9router 供应商详情页。
 * Header（返回 + 图标 + 名称 + 链接数）+ 链接池卡片（空状态 / 行列表 + 删除）
 * + 可用模型卡片（flex-wrap chips，禁用模型单独列出可恢复）。
 * 加链接流程由供应商能力驱动（登录链接 / API key / 轮询登录）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ROUTER_API_BASE,
  type RouterAccount,
  type RouterLoginResponse,
  type RouterSupplierModel,
  type RouterSupplierModelsResponse,
} from '../shared.ts'
import { Modal } from './Modal.tsx'

/* ---------------- SVG 图标 ---------------- */

function Icon({ d, size = 18 }: { d: string; size?: number }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

const I = {
  back: 'M19 12H5M12 19l-7-7 7-7',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  add: 'M12 5v14M5 12h14',
  delete: 'M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M10 11v6M14 11v6',
  key: 'M14 7a4 4 0 1 1-1.4 7.6L9 18H6v-3l4.4-4.4A4 4 0 0 1 14 7zM18 7h.01',
  checkCircle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.5 12l2.5 2.5 4.5-5',
  cancel: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 9l6 6M15 9l-6 6',
  robot: 'M12 8V4M8 4h8M4 12a8 8 0 0 1 16 0v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6zM9 14h.01M15 14h.01',
  test: 'M9 3h6M10 3v6.3L4.7 18a2 2 0 0 0 1.8 3h11a2 2 0 0 0 1.8-3L14 9.3V3M7.5 15h9',
  copy: 'M9 9h11v11H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  check: 'M4 12.5l5 5L20 6.5',
  edit: 'M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3zM13.5 6.5l3 3',
  loading: 'M12 3a9 9 0 1 0 9 9M12 3a9 9 0 0 1 9 9',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  refresh: 'M20.5 12a8.5 8.5 0 1 1-2.6-6.1M20.5 4v5h-5',
}

interface SupplierDetailProps {
  supplier: { id: string; name: string; capabilities?: string[]; icon?: string }
  accounts: RouterAccount[]
  /** 状态是否还在加载。 */
  statusLoading: boolean
  onBack: () => void
  onRefresh: () => void
}

function untilLabel(account: RouterAccount): string {
  if (!account.cooling || account.until === undefined) return ''
  const remaining = new Date(account.until).getTime() - Date.now()
  if (remaining <= 0) return '即将恢复'
  const minutes = Math.ceil(remaining / 60000)
  if (minutes < 60) return `剩余 ${minutes} 分钟`
  const hours = Math.ceil(minutes / 60)
  return `剩余 ${hours} 小时`
}

function statusBadge(account: RouterAccount): { text: string; cls: string } {
  if (account.disabled) return { text: '已禁用', cls: 'dshr-badge-danger' }
  if (account.cooling) return { text: '冷却中', cls: 'dshr-badge-warn' }
  return { text: '健康', cls: 'dshr-badge-ok' }
}

export function SupplierDetail({ supplier, accounts, statusLoading, onBack, onRefresh }: SupplierDetailProps): JSX.Element {
  const hasCap = (name: string): boolean => supplier.capabilities?.includes(name) ?? false
  // 连接池（账号池）由「添加链接」能力控制显示——没有添加链接 = 无账号概念，不显示连接池
  // 添加链接有三种：URL 回调登录(generateLoginUrl) / API key 弹窗(addApiKey) / 轮询登录(pollLogin)
  const canLogin = hasCap('generateLoginUrl') || hasCap('addApiKey')
  const canApiKey = hasCap('addApiKey')
  const canPoll = hasCap('pollLogin')
  const canPool = canLogin
  // 签到是供应商特有功能（按能力受控）
  const canCheckin = hasCap('checkinNow')
  // 模型管理/别名是通用 UI；模型测试是必要差异化能力（所有供应商恒显示）
  const canModels = true
  const canEdit = true
  const [showLogin, setShowLogin] = useState(false)
  const [loginUrl, setLoginUrl] = useState<string | null>(null)
  const [callbackUrl, setCallbackUrl] = useState('')
  const [keyName, setKeyName] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [removeTarget, setRemoveTarget] = useState<RouterAccount | null>(null)
  const [models, setModels] = useState<RouterSupplierModel[] | null>(null)
  const [alias, setAlias] = useState('')
  const [modelsError, setModelsError] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [toggling, setToggling] = useState(false)
  const [showAddModel, setShowAddModel] = useState(false)
  const [newModelId, setNewModelId] = useState('')
  const [addModelError, setAddModelError] = useState('')
  const [addTesting, setAddTesting] = useState(false)
  const [addTestResult, setAddTestResult] = useState<{ ok: boolean; error?: string } | null>(null)
  const [showAlias, setShowAlias] = useState(false)
  const [aliasDraft, setAliasDraft] = useState('')
  const [aliasError, setAliasError] = useState('')
  const [testingIds, setTestingIds] = useState<Set<string>>(() => new Set())
  const [testResults, setTestResults] = useState<Record<string, 'ok' | 'error'>>({})
  const [copiedModel, setCopiedModel] = useState<string | null>(null)
  const [modelQuery, setModelQuery] = useState('')
  const [fetchingModels, setFetchingModels] = useState(false)
  const [removeModelTarget, setRemoveModelTarget] = useState<string | null>(null)
  const [poolStrategy, setPoolStrategy] = useState<'fallback' | 'round-robin'>('fallback')
  const [poolOrder, setPoolOrder] = useState<string[]>([])
  const [checkingIn, setCheckingIn] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const showToast = (msg: string): void => {
    setToast(msg)
    window.setTimeout(() => {
      if (mounted.current) setToast(null)
    }, 2500)
  }

  const loadModels = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`${ROUTER_API_BASE}/suppliers/${supplier.id}/models`, { cache: 'no-store' })
      const data = await response.json() as RouterSupplierModelsResponse
      if (mounted.current) {
        if (data.ok && data.models) {
          setModels(data.models)
          if (data.alias) setAlias(data.alias)
        } else setModelsError(data.error ?? '加载失败')
      }
    } catch (err) {
      if (mounted.current) setModelsError((err as Error).message)
    }
  }, [])

  useEffect(() => { void loadModels() }, [loadModels])

  const loadPoolConfig = useCallback(async (): Promise<void> => {
    try {
      const [strategyRes, orderRes] = await Promise.all([
        fetch(`${ROUTER_API_BASE}/suppliers/${supplier.id}/pool/strategy`, { cache: 'no-store' }),
        fetch(`${ROUTER_API_BASE}/suppliers/${supplier.id}/pool/order`, { cache: 'no-store' }),
      ])
      const [strategyData, orderData] = await Promise.all([strategyRes.json(), orderRes.json()]) as [
        { ok: boolean; strategy?: 'fallback' | 'round-robin' },
        { ok: boolean; order?: string[] },
      ]
      if (mounted.current) {
        if (strategyData.ok && strategyData.strategy) setPoolStrategy(strategyData.strategy)
        if (orderData.ok && Array.isArray(orderData.order)) setPoolOrder(orderData.order)
      }
    } catch {
      // 连接池配置加载失败不阻断
    }
  }, [])

  useEffect(() => { void loadPoolConfig() }, [loadPoolConfig])

  const savePoolOrder = async (uids: string[]): Promise<void> => {
    setPoolOrder(uids)
    try {
      await fetch(`${ROUTER_API_BASE}/suppliers/${supplier.id}/pool/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uids }),
        cache: 'no-store',
      })
      showToast('连接池顺序已保存')
    } catch {
      showToast('保存顺序失败')
    }
  }

  const runCheckin = async (): Promise<void> => {
    if (checkingIn) return
    setCheckingIn(true)
    try {
      const response = await fetch(`${ROUTER_API_BASE}/suppliers/${supplier.id}/checkin`, { method: 'POST', cache: 'no-store' })
      const data = await response.json() as { ok: boolean; total: number; succeeded: number; already?: number; failed?: number; error?: string; results?: Array<{ uid: string; ok: boolean; status?: string; message?: string }> }
      // 核心口径（2026-09-02 修正）：有任一链接失败 → ok:false + HTTP 400。
      // 别再用「签到完成」打头——部分失败会被 UI 吞成成功。
      if (data.ok && data.total > 0) {
        let msg = `签到完成：${data.succeeded}/${data.total} 成功`
        const already = data.already ?? 0
        if (already > 0) msg += ` · ${already} 今日已签`
        showToast(msg)
      } else {
        const firstFail = (data.results ?? []).find(r => r.status !== 'ok' && r.status !== 'already')
        const reason = firstFail ? `${firstFail.message ?? '有链接签到失败'}` : ''
        const already = data.already ?? 0
        const head = data.total > 0 ? `签到未完成：${data.succeeded}/${data.total} 成功` : '没有可签到的链接'
        showToast(data.error ?? [head, already > 0 ? `${already} 今日已签` : '', reason].filter(Boolean).join(' · '))
      }
      onRefresh()
    } catch (err) {
      showToast(`签到失败：${(err as Error).message}`)
    } finally {
      setCheckingIn(false)
    }
  }

  /** 刷新链接池：积分刷一遍 + 全供应商健康探测（最简会话，走真实 chatCompletions
   *  并按账号池回退，所以「这个供应商还有没有活着的链接」能回答；不按链接细分 —— 那需要
   *  按 uid 指定账号的管道，会给插件增负）。 */
  const runRefresh = async (): Promise<void> => {
    if (refreshing) return
    setRefreshing(true)
    let msg = ''
    try {
      const response = await fetch(`${ROUTER_API_BASE}/suppliers/${supplier.id}/links/refresh`, { method: 'POST', cache: 'no-store' })
      const data = await response.json() as { ok: boolean; changed?: boolean; accounts?: unknown[]; error?: string }
      if (!data.ok) {
        showToast(data.error ?? '刷新失败')
        return
      }
      // 健康探测：拿一个启用模型跑最简会话；没有启用模型就退回任意第一个
      const probe = models?.find(m => m.enabled) ?? models?.[0]
      if (probe === undefined) {
        msg = `已刷新 ${data.accounts?.length ?? 0} 链接 · 无模型可探测`
      } else {
        const probeRes = await fetch(`${ROUTER_API_BASE}/suppliers/${supplier.id}/models/test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: probe.id }),
          cache: 'no-store',
        })
        const probeData = await probeRes.json() as { ok: boolean; error?: string }
        msg = probeData.ok
          ? `已刷新 ${data.accounts?.length ?? 0} 链接 · 健康`
          : `已刷新 ${data.accounts?.length ?? 0} 链接 · 不可用：${probeData.error ?? '未知'}`
      }
      showToast(msg)
      onRefresh()
    } catch (err) {
      showToast(`刷新失败：${(err as Error).message}`)
    } finally {
      setRefreshing(false)
    }
  }

  const startLogin = async (): Promise<void> => {
    // API key 供应商：弹窗直接填名字+key，不走 URL 登录
    if (canApiKey) {
      setShowLogin(true)
      setBusy(false)
      setError('')
      setLoginUrl(null)
      setCallbackUrl('')
      setKeyName('')
      setApiKey('')
      return
    }
    setShowLogin(true)
    setBusy(true)
    setError('')
    setLoginUrl(null)
    setCallbackUrl('')
    try {
      const response = await fetch(`${ROUTER_API_BASE}/suppliers/${supplier.id}/login`, { method: 'POST', cache: 'no-store' })
      const data = await response.json() as RouterLoginResponse
      if (data.ok && data.loginUrl) setLoginUrl(data.loginUrl)
      else setError(data.error ?? '生成登录链接失败')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const completeLogin = async (poll = false): Promise<void> => {
    if (!poll && callbackUrl.trim() === '') return
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`${ROUTER_API_BASE}/suppliers/${supplier.id}/login/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callbackUrl: poll ? '' : callbackUrl.trim() }),
        cache: 'no-store',
      })
      const data = await response.json() as { ok: boolean; error?: string; account?: { uid: string; nickname: string } }
      if (data.ok && data.account) {
        showToast(`已添加链接 ${data.account.nickname || data.account.uid}`)
        setShowLogin(false)
        setLoginUrl(null)
        setCallbackUrl('')
        onRefresh()
      } else {
        setError(data.error ?? '添加失败')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const addApiKey = async (): Promise<void> => {
    if (apiKey.trim() === '') return
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`${ROUTER_API_BASE}/suppliers/${supplier.id}/links/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: keyName.trim(), apiKey: apiKey.trim() }),
        cache: 'no-store',
      })
      const data = await response.json() as { ok: boolean; error?: string; account?: { uid: string; nickname: string } }
      if (data.ok && data.account) {
        showToast(`已添加链接 ${data.account.nickname || data.account.uid}`)
        setShowLogin(false)
        setKeyName('')
        setApiKey('')
        onRefresh()
      } else {
        setError(data.error ?? '添加失败')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const doRemove = async (uid: string): Promise<void> => {
    const response = await fetch(`${ROUTER_API_BASE}/suppliers/${supplier.id}/links/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid }),
      cache: 'no-store',
    })
    const data = await response.json() as { ok: boolean }
    if (data.ok) onRefresh()
    setRemoveTarget(null)
  }

  const toggleModel = async (id: string, enabled: boolean): Promise<void> => {
    setToggling(true)
    try {
      const response = await fetch(`${ROUTER_API_BASE}/suppliers/${supplier.id}/models/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, enabled }),
        cache: 'no-store',
      })
      const data = await response.json() as { ok: boolean }
      if (data.ok) {
        setModels(prev => prev ? prev.map(m => m.id === id ? { ...m, enabled } : m) : prev)
        onRefresh()
      }
    } finally {
      setToggling(false)
    }
  }

  const testNewModel = async (): Promise<void> => {
    if (newModelId.trim() === '') return
    setAddTesting(true)
    setAddTestResult(null)
    setAddModelError('')
    try {
      const response = await fetch(`${ROUTER_API_BASE}/suppliers/${supplier.id}/models/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: newModelId.trim() }),
        cache: 'no-store',
      })
      const data = await response.json() as { ok: boolean; error?: string }
      setAddTestResult(data.ok ? { ok: true } : { ok: false, error: data.error ?? '测试失败' })
    } catch (err) {
      setAddTestResult({ ok: false, error: (err as Error).message })
    } finally {
      setAddTesting(false)
    }
  }

  const addCustomModel = async (): Promise<void> => {
    if (newModelId.trim() === '') return
    setBusy(true)
    setAddModelError('')
    try {
      const response = await fetch(`${ROUTER_API_BASE}/suppliers/${supplier.id}/models/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: newModelId.trim() }),
        cache: 'no-store',
      })
      const data = await response.json() as { ok: boolean; error?: string }
      if (data.ok) {
        setShowAddModel(false)
        setNewModelId('')
        await loadModels()
      } else {
        setAddModelError(data.error ?? '添加失败')
      }
    } catch (err) {
      setAddModelError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const bulkModels = async (enabled: boolean): Promise<void> => {
    setToggling(true)
    try {
      await fetch(`${ROUTER_API_BASE}/suppliers/${supplier.id}/models/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
        cache: 'no-store',
      })
      await loadModels()
    } finally {
      setToggling(false)
    }
  }

  const fetchModels = async (): Promise<void> => {
    setFetchingModels(true)
    setModelsError('')
    try {
      const response = await fetch(`${ROUTER_API_BASE}/suppliers/${supplier.id}/models/fetch`, { method: 'POST', cache: 'no-store' })
      const data = await response.json() as { ok: boolean; error?: string; added?: number; removed?: number }
      if (data.ok) {
        await loadModels()
        const added = data.added ?? 0
        const removed = data.removed ?? 0
        if (added === 0 && removed === 0) showToast('模型已是最新')
        else showToast(`已更新模型：+${added} 新增${removed > 0 ? `，${removed} 移除` : ''}`)
      } else {
        setModelsError(data.error ?? '获取失败')
      }
    } catch (err) {
      setModelsError((err as Error).message)
    } finally {
      setFetchingModels(false)
    }
  }

  const removeModel = async (id: string): Promise<void> => {
    setToggling(true)
    try {
      const response = await fetch(`${ROUTER_API_BASE}/suppliers/${supplier.id}/models/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
        cache: 'no-store',
      })
      const data = await response.json() as { ok: boolean; error?: string }
      if (data.ok) await loadModels()
      else setModelsError(data.error ?? '删除失败')
    } finally {
      setToggling(false)
    }
  }

  const testModel = async (id: string): Promise<void> => {
    if (testingIds.has(id)) return
    setTestingIds(prev => new Set(prev).add(id))
    try {
      const response = await fetch(`${ROUTER_API_BASE}/suppliers/${supplier.id}/models/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
        cache: 'no-store',
      })
      const data = await response.json() as { ok: boolean; error?: string }
      setTestResults(prev => ({ ...prev, [id]: data.ok ? 'ok' : 'error' }))
      if (!data.ok) setModelsError(data.error ?? '测试失败')
    } catch (err) {
      setTestResults(prev => ({ ...prev, [id]: 'error' }))
      setModelsError((err as Error).message)
    } finally {
      setTestingIds(prev => { const n = new Set(prev); n.delete(id); return n })
    }
  }

  const copyModel = async (id: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(`${alias}/${id}`)
      setCopiedModel(id)
      window.setTimeout(() => setCopiedModel(null), 1500)
    } catch {
      // ignore
    }
  }

  const saveAlias = async (): Promise<void> => {
    setBusy(true)
    setAliasError('')
    try {
      const response = await fetch(`${ROUTER_API_BASE}/suppliers/${supplier.id}/alias`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias: aliasDraft.trim() }),
        cache: 'no-store',
      })
      const data = await response.json() as { ok: boolean; error?: string }
      if (data.ok) {
        setAlias(aliasDraft.trim())
        // 同时保存连接池策略
        try {
          await fetch(`${ROUTER_API_BASE}/suppliers/${supplier.id}/pool/strategy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ strategy: poolStrategy }),
            cache: 'no-store',
          })
        } catch {
          // 策略保存失败不阻断前缀保存
        }
        setShowAlias(false)
      } else {
        setAliasError(data.error ?? '保存失败')
      }
    } catch (err) {
      setAliasError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const supplierAccounts = accounts.filter(a => a.supplier === supplier.id)
  // 连接池顺序：poolOrder 排前面，未在 order 的按原顺序追加
  const orderedAccounts = (() => {
    const byUid = new Map(supplierAccounts.map(a => [a.uid, a]))
    const out: RouterAccount[] = []
    const seen = new Set<string>()
    for (const uid of poolOrder) {
      const a = byUid.get(uid)
      if (a && !seen.has(uid)) { out.push(a); seen.add(uid) }
    }
    for (const a of supplierAccounts) {
      if (!seen.has(a.uid)) out.push(a)
    }
    return out
  })()
  const q = modelQuery.trim().toLowerCase()
  const matchQuery = (m: RouterSupplierModel): boolean => q === '' || m.id.toLowerCase().includes(q)
  const enabledModels = models?.filter(m => m.enabled && matchQuery(m)) ?? []
  const disabledModels = models?.filter(m => !m.enabled && matchQuery(m)) ?? []

  return (
    <div className="dshr-tabBody">
      {/* Header（9router 风格） */}
      <div className="dshr-providerHead">
        <button type="button" className="dshr-backLink" onClick={onBack}>
          <Icon d={I.back} size={16} />
          返回
        </button>
        <div className="dshr-providerTitleRow">
          <div className="dshr-providerIcon">
            {supplier.icon !== undefined
              ? (
                <img
                  className="dshr-providerImg"
                  src={supplier.icon}
                  alt=""
                  // 同上：失败就藏，露出备用图标位置（不显示碎图）
                  onError={(e) => { e.currentTarget.style.display = 'none' }}
                />
              )
              : <Icon d={I.link} size={22} />}
          </div>
          <div className="dshr-providerMeta">
            <h1 className="dshr-providerName">{supplier.name}</h1>
            <p className="dshr-providerCount">
              {supplierAccounts.length} 链接
              {canPool && ` · ${poolStrategy === 'round-robin' ? '轮询' : '回退'}`}
              {canEdit && ` · 前缀 ${alias}`}
            </p>
          </div>
          {canEdit && (
            <button type="button" className="dshr-iconBtn dshr-providerEdit" title="编辑供应商" onClick={() => { setAliasDraft(alias); setAliasError(''); setShowAlias(true) }}>
              <Icon d={I.edit} size={15} />
            </button>
          )}
        </div>
      </div>

      {error !== '' && <div className="dshr-alert"><strong>出错了</strong><span>{error}</span></div>}

{canPool ? (
      <section className="dshr-card">
        <div className="dshr-cardHead">
          <div className="dshr-cardTitle">链接池</div>
          <div className="dshr-cardActions">
            <button type="button" className="dshr-iconBtn dshr-iconBtn-sm" onClick={() => void runRefresh()} disabled={refreshing || supplierAccounts.length === 0} title="刷新积分并探测健康" aria-label="刷新积分并探测健康">
              <span className={refreshing ? 'dshr-spin' : undefined}>
                <Icon d={I.refresh} size={15} />
              </span>
            </button>
            {canCheckin && (
              <button type="button" className="dshr-iconBtn dshr-iconBtn-sm" onClick={() => void runCheckin()} disabled={checkingIn || supplierAccounts.length === 0} title="签到所有链接" aria-label="签到所有链接">
                <span className={checkingIn ? 'dshr-spin' : undefined}>
                  <Icon d={I.checkCircle} size={15} />
                </span>
              </button>
            )}
            {canLogin && (
              <button type="button" className="dshr-primaryButton" onClick={() => void startLogin()} disabled={busy}>
                <Icon d={I.add} size={14} />
                添加链接
              </button>
            )}
          </div>
        </div>

        {statusLoading
          ? <div className="dshr-empty">加载中…</div>
          : supplierAccounts.length === 0
            ? (
              <div className="dshr-linkEmpty">
                <span className="dshr-linkEmptyIcon"><Icon d={I.link} size={28} /></span>
                <div className="dshr-linkEmptyText">
                  <p className="dshr-linkEmptyTitle">暂无链接</p>
                  <p className="dshr-linkEmptyDesc">添加第一个登录链接开始使用</p>
                </div>
                {canLogin && (
                  <button type="button" className="dshr-primaryButton" onClick={() => void startLogin()} disabled={busy}>
                    <Icon d={I.add} size={14} />
                    添加链接
                  </button>
                )}
              </div>
            )
            : (
              <div className="dshr-linkList">
                {orderedAccounts.map((account, index) => {
                  const badge = statusBadge(account)
                  const coolingText = account.cooling || account.disabled
                    ? `${account.reason ?? ''}${untilLabel(account) !== '' ? ` · ${untilLabel(account)}` : ''}`
                    : ''
                  return (
                    <div
                      key={account.uid}
                      className={`dshr-linkRow${dragIndex === index ? ' dshr-linkRowDragging' : ''}`}
                      draggable
                      onDragStart={(e) => { setDragIndex(index); e.dataTransfer.effectAllowed = 'move' }}
                      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
                      onDrop={(e) => {
                        e.preventDefault()
                        if (dragIndex === null || dragIndex === index) { setDragIndex(null); return }
                        const next = [...orderedAccounts]
                        const [moved] = next.splice(dragIndex, 1)
                        if (moved) next.splice(index, 0, moved)
                        setDragIndex(null)
                        void savePoolOrder(next.map(a => a.uid))
                      }}
                      onDragEnd={() => setDragIndex(null)}
                    >
                      <div className="dshr-linkGrip" title="拖动排序">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                          <circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" />
                          <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
                          <circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
                        </svg>
                      </div>
                      <div className="dshr-linkMain">
                        <div className="dshr-linkTitleLine">
                          <span className="dshr-linkName">{account.nickname || account.uid}</span>
                          <span className={`dshr-badge ${badge.cls}`}>{badge.text}</span>
                        </div>
                        <div className="dshr-linkSub">
                          <span className="dshr-mono dshr-linkUid">{account.uid}</span>
                          <span className="dshr-linkDot">·</span>
                          {/* credits < 0 = 插件还没拉到过积分（缓存也没值），
                              别显示成「-1 积分」或直接吃掉整段 */}
                          <span className="dshr-mono dshr-linkCredits">
                            {account.credits < 0 ? '积分未知' : `${Math.ceil(account.credits)} 积分`}
                          </span>
                          {/* err_count 是限流退避等级（反复被限流的号递增，成功后清零） */}
                          {account.err_count !== undefined && account.err_count > 0 && (
                            <>
                              <span className="dshr-linkDot">·</span>
                              <span className="dshr-linkErr">退避 {account.err_count} 级</span>
                            </>
                          )}
                          {coolingText !== '' && <span className="dshr-reason dshr-linkCooling">{coolingText}</span>}
                        </div>
                      </div>
                      <div className="dshr-linkOps">
                        <button type="button" className="dshr-iconBtn dshr-iconBtn-sm dshr-linkDelete" title="删除链接" onClick={() => setRemoveTarget(account)}>
                          <Icon d={I.delete} size={15} />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
        </section>
      ) : null}

{canModels ? (
      <section className="dshr-card">
        <div className="dshr-cardHead">
          <div className="dshr-cardTitle">可用模型</div>
          <span className="dshr-muted dshr-cardMeta dshr-cardMetaAfter">{models ? `${enabledModels.length}/${models.length} 启用` : ''}</span>
          <div className="dshr-cardActions">
            <button type="button" className="dshr-miniButton" onClick={() => void fetchModels()} disabled={fetchingModels}>
              {fetchingModels ? '获取中…' : '获取模型'}
            </button>
            <button type="button" className="dshr-miniButton" onClick={() => { setAddModelError(''); setAddTestResult(null); setNewModelId(''); setShowAddModel(true) }} disabled={toggling}>
              <Icon d={I.add} size={13} />
              添加模型
            </button>
            <button type="button" className="dshr-miniButton" onClick={() => void bulkModels(true)} disabled={toggling}>全部启用</button>
            <button type="button" className="dshr-miniButton" onClick={() => void bulkModels(false)} disabled={toggling}>全部禁用</button>
          </div>
        </div>
        <div className="dshr-modelSearch">
          <span className="dshr-modelSearchIcon"><Icon d={I.search} size={13} /></span>
          <input
            className="dshr-input"
            placeholder="搜索模型…"
            value={modelQuery}
            onChange={(e) => setModelQuery(e.target.value)}
          />
        </div>
        {modelsError !== '' && <div className="dshr-alert"><strong>出错了</strong><span>{modelsError}</span></div>}
        {models === null && modelsError === ''
          ? <div className="dshr-empty">加载中…</div>
          : (
            <div className="dshr-modelChips">
              {enabledModels.map(model => {
                const status = testResults[model.id]
                const chipCls = status === 'ok' ? ' dshr-modelChip-ok' : status === 'error' ? ' dshr-modelChip-err' : ''
                return (
                  <div key={model.id} className={`dshr-modelChipWrap${chipCls}`}>
                    <button
                      type="button"
                      className="dshr-modelChip"
                      title="点击禁用"
                      disabled={toggling}
                      onClick={() => void toggleModel(model.id, false)}
                    >
                      <span className="dshr-modelChipStatus">
                        <Icon d={status === 'ok' ? I.checkCircle : status === 'error' ? I.cancel : I.robot} size={13} />
                      </span>
                      <span className="dshr-modelChipId">{model.id}</span>
                    </button>
                    <div className="dshr-modelChipOps">
                      <button
                        type="button"
                        className="dshr-iconBtn dshr-iconBtn-sm"
                        title={testingIds.has(model.id) ? '测试中…' : '测试'}
                        onClick={() => void testModel(model.id)}
                      >
                        <span className={testingIds.has(model.id) ? 'dshr-spin' : undefined}>
                          <Icon d={testingIds.has(model.id) ? I.loading : I.test} size={13} />
                        </span>
                      </button>
                      <button
                        type="button"
                        className="dshr-iconBtn dshr-iconBtn-sm"
                        title="复制模型名"
                        onClick={() => void copyModel(model.id)}
                      >
                        <Icon d={copiedModel === model.id ? I.check : I.copy} size={13} />
                      </button>
                      {model.custom && (
                        <button
                          type="button"
                          className="dshr-iconBtn dshr-iconBtn-sm dshr-modelDelete"
                          title="删除自定义模型"
                          onClick={() => setRemoveModelTarget(model.id)}
                        >
                          <Icon d={I.delete} size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
              {disabledModels.length > 0 && (
                <div className="dshr-disabledModels">
                  <p className="dshr-disabledLabel">已禁用（{disabledModels.length}）</p>
                  <div className="dshr-modelChips">
                    {disabledModels.map(model => (
                      <button
                        key={model.id}
                        type="button"
                        className="dshr-modelChip dshr-modelChip-off"
                        title="点击恢复"
                        disabled={toggling}
                        onClick={() => void toggleModel(model.id, true)}
                      >
                        <span className="dshr-modelChipId">{model.id}</span>
                        <span className="dshr-modelChipRestore">+ 恢复</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      ) : null}

      {/* ---- 添加模型弹窗 ---- */}
      {showAddModel && (
        <Modal title="添加模型" onClose={() => setShowAddModel(false)} dismissable={false}>
          <div className="dshr-modalForm">
            <p className="dshr-muted">输入模型 id，自定义模型会加入可用列表。</p>
            <input
              className="dshr-input"
              placeholder="模型 id"
              value={newModelId}
              onChange={(e) => setNewModelId(e.target.value)}
              autoFocus
            />
            {addTestResult !== null && (
              <div className={addTestResult.ok ? 'dshr-alert dshr-alert-ok' : 'dshr-alert'}>
                <strong>{addTestResult.ok ? '测试通过' : '测试失败'}</strong>
                <span>{addTestResult.ok ? '该模型可用。' : addTestResult.error}</span>
              </div>
            )}
            {addModelError !== '' && <div className="dshr-alert"><strong>出错了</strong><span>{addModelError}</span></div>}
            <div className="dshr-modalActions">
              <button type="button" className="dshr-miniButton" onClick={() => void testNewModel()} disabled={addTesting || newModelId.trim() === ''}>
                {addTesting ? '测试中…' : '测试'}
              </button>
              <button type="button" className="dshr-miniButton" onClick={() => setShowAddModel(false)}>取消</button>
              <button type="button" className="dshr-primaryButton" onClick={() => void addCustomModel()} disabled={busy || newModelId.trim() === ''}>
                {busy ? '添加中…' : '添加'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ---- 编辑供应商弹窗（前缀 + 连接池策略） ---- */}
      {showAlias && (
        <Modal title="编辑供应商" onClose={() => setShowAlias(false)}>
          <div className="dshr-modalForm">
            <>
              <label className="dshr-fieldLabel">前缀</label>
              <p className="dshr-muted">前缀用于模型全名（复制模型名时 = 前缀/模型id），只含字母、数字、- 和 _。</p>
              <input
                className="dshr-input dshr-mono"
                placeholder="如 oc、or、nv"
                value={aliasDraft}
                onChange={(e) => setAliasDraft(e.target.value)}
              />
            </>
            <>
              <label className="dshr-fieldLabel">连接池策略</label>
              <p className="dshr-muted">回退 = 按连接池顺序取第一个健康链接；轮询 = 轮流使用健康链接。</p>
              <select
                className="dshr-select dshr-input"
                value={poolStrategy}
                onChange={(e) => setPoolStrategy(e.target.value as 'fallback' | 'round-robin')}
              >
                <option value="fallback">回退</option>
                <option value="round-robin">轮询</option>
              </select>
            </>
            {aliasError !== '' && <div className="dshr-alert"><strong>出错了</strong><span>{aliasError}</span></div>}
            <div className="dshr-modalActions">
              <button type="button" className="dshr-miniButton" onClick={() => setShowAlias(false)}>取消</button>
              <button type="button" className="dshr-primaryButton" onClick={() => void saveAlias()} disabled={busy || aliasDraft.trim() === ''}>
                {busy ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ---- 删除自定义模型确认 ---- */}
      {removeModelTarget !== null && (
        <Modal title="删除自定义模型" onClose={() => setRemoveModelTarget(null)}>
          <div className="dshr-modalForm">
            <p className="dshr-muted">确定删除自定义模型「{removeModelTarget}」吗？将从可用列表移除。</p>
            <div className="dshr-modalActions">
              <button type="button" className="dshr-miniButton" onClick={() => setRemoveModelTarget(null)}>取消</button>
              <button type="button" className="dshr-dangerButton" onClick={() => { const id = removeModelTarget; setRemoveModelTarget(null); void removeModel(id) }}>删除</button>
            </div>
          </div>
        </Modal>
      )}

      {/* ---- 添加链接弹窗（URL 登录 / API key） ---- */}
      {showLogin && (
        <Modal title={`添加链接 · ${supplier.name}`} onClose={() => { if (!busy) { setShowLogin(false); setLoginUrl(null); setCallbackUrl(''); setKeyName(''); setApiKey('') } }}>
          {canApiKey
            ? (
              <div className="dshr-modalForm">
                <p className="dshr-muted">填入 OpenRouter API key（https://openrouter.ai/settings/keys），可起名字区分多个 key。</p>
                {error !== '' && <div className="dshr-alert"><strong>出错了</strong><span>{error}</span></div>}
                <input
                  className="dshr-input"
                  placeholder="名字（可选，如 主key）"
                  value={keyName}
                  onChange={(e) => setKeyName(e.target.value)}
                />
                <input
                  className="dshr-input"
                  placeholder="sk-or-v1-..."
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
                <div className="dshr-modalActions">
                  <button type="button" className="dshr-miniButton" onClick={() => setShowLogin(false)} disabled={busy}>取消</button>
                  <button type="button" className="dshr-primaryButton" onClick={() => void addApiKey()} disabled={busy || apiKey.trim() === ''}>
                    {busy ? '验证中…' : '添加'}
                  </button>
                </div>
              </div>
            )
            : busy && loginUrl === null && error === ''
              ? <div className="dshr-muted">正在生成登录链接…</div>
              : loginUrl === null
                ? <div className="dshr-empty">{error !== '' ? error : '登录链接生成失败'}</div>
                : (
                  <div className="dshr-loginBox">
                    <div className="dshr-loginStep"><span className="dshr-loginNum">1</span>在浏览器打开下面链接,完成登录</div>
                    <a className="dshr-loginUrl" href={loginUrl} target="_blank" rel="noreferrer">{loginUrl}</a>
                    {canPoll
                      ? (
                        <>
                          <div className="dshr-loginStep"><span className="dshr-loginNum">2</span>登录成功后点「完成添加」，自动获取凭证</div>
                          {error !== '' && <div className="dshr-alert"><strong>出错了</strong><span>{error}</span></div>}
                          <div className="dshr-modalActions">
                            <button type="button" className="dshr-primaryButton" onClick={() => void completeLogin(true)} disabled={busy}>
                              {busy ? '轮询中…' : '完成添加'}
                            </button>
                          </div>
                        </>
                      )
                      : (
                        <>
                          <div className="dshr-loginStep"><span className="dshr-loginNum">2</span>登录成功后浏览器会跳到打不开的 127.0.0.1 地址</div>
                          <div className="dshr-loginStep"><span className="dshr-loginNum">3</span>复制地址栏完整链接,粘贴到下面,点「完成添加」</div>
                          {error !== '' && <div className="dshr-alert"><strong>出错了</strong><span>{error}</span></div>}
                          <div className="dshr-endpointRow">
                            <input
                              className="dshr-input"
                              placeholder="粘贴回调链接 http://127.0.0.1:18080/authorize?..."
                              value={callbackUrl}
                              onChange={(e) => setCallbackUrl(e.target.value)}
                            />
                            <button type="button" className="dshr-primaryButton" onClick={() => void completeLogin()} disabled={busy || callbackUrl.trim() === ''}>
                              {busy ? '处理中…' : '完成添加'}
                            </button>
                          </div>
                        </>
                      )}
                  </div>
                )}
        </Modal>
      )}

      {/* ---- 删除链接确认 ---- */}
      {removeTarget !== null && (
        <Modal title="删除链接" onClose={() => setRemoveTarget(null)}>
          <div className="dshr-modalForm">
            <p className="dshr-muted">确定删除链接「{removeTarget.nickname || removeTarget.uid}」吗？该账号将立即从路由池移除。</p>
            <div className="dshr-modalActions">
              <button type="button" className="dshr-miniButton" onClick={() => setRemoveTarget(null)}>取消</button>
              <button type="button" className="dshr-dangerButton" onClick={() => void doRemove(removeTarget.uid)}>删除</button>
            </div>
          </div>
        </Modal>
      )}

      {toast !== null && <div className="dshr-toast">{toast}</div>}
    </div>
  )
}
