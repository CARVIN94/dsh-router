/**
 * 连接自检面板 —— 扩展「连接自检」(`dsh-router-ext-test` / 扩展 id `test`) 的详情内容。
 *
 * **入口只有一处**：设置 → 路由 → 扩展 → 点开「连接自检」那张卡片（`ExtDetail` 查
 * `ext-panels.ts` 的注册表拿到本组件）。
 *
 * 刻意**不给插件页那一行也挂一个详情页**：那一行的宿主行开关已经能开/关它，再点进去
 * 看同一块面板就是同一个东西有两个入口 —— 与「内置扩展不在自绘节里重复列」同理。
 * 插件页那一行只负责开关。
 */
import { useEffect, useState } from 'react'
import { ROUTER_API_BASE, type RouterAccount, type RouterHealthResponse } from '../shared.ts'

/** 一次测试的结果。`ok` 为 false 时 `error` 是核心给的真实原因（上游响应 / chatOnce message）。 */
interface TestResult {
  ok: boolean
  error?: string
  /** 实际测的是哪个连接（空串 = 池内任选，与面板「测试」按钮同义）。 */
  uid: string
}

function Label({ children }: { children: string }): JSX.Element {
  return <div className="dshr-fieldLabel">{children}</div>
}

/** 三个下拉里的一栏。`hint` 在没得选时说明「为什么没有」，而不是留个空白。 */
function Picker(props: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  emptyHint: string
  disabled?: boolean
  onChange: (value: string) => void
}): JSX.Element {
  return (
    <div>
      <Label>{props.label}</Label>
      <select
        className="dshr-select"
        value={props.value}
        disabled={props.disabled === true || props.options.length === 0}
        onChange={(e) => { props.onChange(e.target.value) }}
      >
        {props.options.length === 0
          ? <option value="">{props.emptyHint}</option>
          : <>
            <option value="">请选择</option>
            {props.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </>}
      </select>
    </div>
  )
}

export function ExtTestPanel(): JSX.Element {
  const [suppliers, setSuppliers] = useState<NonNullable<RouterHealthResponse['suppliers']>>([])
  const [accounts, setAccounts] = useState<RouterAccount[]>([])
  const [models, setModels] = useState<string[]>([])
  const [supplierId, setSupplierId] = useState('')
  const [modelId, setModelId] = useState('')
  const [uid, setUid] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)

  // 供应商与连接各读一次：/health 给供应商（开着的那批，与面板一致），
  // /status 给账号（uid + 昵称 + 冷却状态）。
  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const [health, status] = await Promise.all([
          fetch(`${ROUTER_API_BASE}/health`, { cache: 'no-store' }).then((r) => r.json() as Promise<RouterHealthResponse>),
          fetch(`${ROUTER_API_BASE}/status`, { cache: 'no-store' }).then((r) => r.json() as Promise<{ ok: boolean; accounts?: RouterAccount[] }>),
        ])
        if (!live) return
        setSuppliers((health.suppliers ?? []).filter((s) => s.enabled !== false))
        setAccounts(status.ok ? (status.accounts ?? []) : [])
      } catch (err) {
        if (live) setError((err as Error).message)
      } finally {
        if (live) setLoaded(true)
      }
    })()
    return () => { live = false }
  }, [])

  // 换供应商 → 重拉模型、清掉模型/连接选择与旧结果（旧结果对新选择没有意义，
  // 留着会被误读成「刚测过这个」）。
  useEffect(() => {
    setModelId('')
    setUid('')
    setResult(null)
    if (supplierId === '') { setModels([]); return }
    let live = true
    void (async () => {
      try {
        const data = await fetch(`${ROUTER_API_BASE}/suppliers/${encodeURIComponent(supplierId)}/models`, { cache: 'no-store' })
          .then((r) => r.json() as Promise<{ ok: boolean; models?: Array<{ id: string }> }>)
        if (live) setModels((data.ok ? (data.models ?? []) : []).map((m) => m.id))
      } catch {
        if (live) setModels([])
      }
    })()
    return () => { live = false }
  }, [supplierId])

  const links = accounts.filter((a) => a.supplier === supplierId)
  const runnable = supplierId !== '' && modelId !== ''


  const run = async (): Promise<void> => {
    if (!runnable || busy) return
    setBusy(true)
    setError('')
    setResult(null)
    try {
      const response = await fetch(`${ROUTER_API_BASE}/suppliers/${encodeURIComponent(supplierId)}/models/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // uid 留空 = 池内任选可用号（与面板「测试」按钮同义）；选了 = 只测它。
        body: JSON.stringify({ id: modelId, uid }),
        cache: 'no-store',
      })
      const data = await response.json() as { ok: boolean; error?: string }
      setResult({ ok: data.ok, uid, ...(data.error === undefined ? {} : { error: data.error }) })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dshr-tabBody dshr-extTest">
      <p className="dshr-muted">
        选一个供应商、模型和连接，跑一次真实访问测试。留空「连接」表示由账号池任选一个可用号
        （与供应商详情里的「测试」按钮同义）；指定连接则**只测它**，失败不会换号。
      </p>

      <div className="dshr-extTestGrid">
        <Picker
          label="供应商"
          value={supplierId}
          options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
          emptyHint={loaded ? '没有已启用的供应商' : '加载中…'}
          onChange={setSupplierId}
        />
        <Picker
          label="模型"
          value={modelId}
          options={models.map((m) => ({ value: m, label: m }))}
          emptyHint={supplierId === '' ? '先选供应商' : (models.length === 0 ? '该供应商没有模型（可先在供应商详情里拉取）' : '请选择')}
          disabled={supplierId === ''}
          onChange={(v) => { setModelId(v); setResult(null) }}
        />
        <Picker
          label="连接"
          value={uid}
          options={links.map((a) => ({
            value: a.uid,
            label: `${a.nickname ?? a.uid}${a.cooling ? '（冷却中）' : ''}`,
          }))}
          emptyHint={supplierId === '' ? '先选供应商' : '该供应商没有连接（留空=池内任选）'}
          disabled={supplierId === ''}
          onChange={(v) => { setUid(v); setResult(null) }}
        />
      </div>

      <div>
        <button
          type="button"
          className="dshr-primaryButton"
          disabled={!runnable || busy}
          onClick={() => { void run() }}
        >
          {busy ? '测试中…' : '跑一次访问测试'}
        </button>
        {!runnable && <span className="dshr-muted"> 先选供应商与模型</span>}
      </div>

      {error !== '' && <div className="dshr-alert"><strong>出错了</strong><span>{error}</span></div>}

      {result !== null && (
        <div className={result.ok ? 'dshr-okBox' : 'dshr-warnBox'}>
          <strong>{result.ok ? '测试通过' : '测试失败'}</strong>
          <div>
            {result.ok
              ? `连接 ${result.uid === '' ? '（池内任选）' : result.uid} 可以正常访问该模型`
              : (result.error ?? '上游没有给出原因')}
          </div>
        </div>
      )}
    </div>
  )
}
