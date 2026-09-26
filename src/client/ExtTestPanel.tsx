/**
 * 插件自检面板 —— 扩展「插件自检」(`dsh-router-ext-test` / 扩展 id `test`) 的详情内容。
 *
 * **入口只有一处**：设置 → 路由 → 扩展 → 点开「插件自检」那张卡片（`ExtDetail` 查
 * `ext-panels.ts` 的注册表拿到本组件）。
 *
 * 刻意**不给插件页那一行也挂一个详情页**：那一行的宿主行开关已经能开/关它，再点进去
 * 看同一块面板就是同一个东西有两个入口 —— 与「内置扩展不在自绘节里重复列」同理。
 * 插件页那一行只负责开关。
 *
 * 视觉上照着宿主的插件页写（`--dsw-alias-*` 那套 token），**不复用设置页的
 * `dshr-*` 组件样式**：那些样式依赖 `--rs-*` 变量，而那套变量只定义在
 * `.dshr-settings` / `.dshr-shell` 下，插件页不在其祖先里（未定义的 `var()` 会让
 * 整条声明失效）。按钮直接用宿主的 `Button` 原语 —— 配色由原语自己的 token 家族
 * 决定，不必在这里猜「主色底上该配什么字色」。
 */
import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { ROUTER_API_BASE, type RouterAccount, type RouterHealthResponse } from '../shared.ts'
import { modelChoice, type ModelRow } from './model-choice.ts'
import type { ProbeReport } from '../suppliers/probe.ts'

/** 一次测试的结果。`ok` 为 false 时 `error` 是核心给的真实原因（上游响应 / chatOnce message）。 */
interface TestResult {
  ok: boolean
  error?: string
  /** 实际测的是哪个连接（空串 = 池内任选，与面板「测试」按钮同义）。 */
  uid: string
  /** 测的时候选的是哪三样，回显出来 —— 一条「通过」必须可归因。 */
  supplier: string
  model: string
}

/** 结果区的一个状态。`network` 是请求本身失败，与「上游拒了」分开。 */
type Notice =
  | { tone: 'ok'; result: TestResult }
  | { tone: 'fail'; result: TestResult }
  | { tone: 'network'; text: string }

/** 每个契约成员状态的字形（颜色由 data-state 给）。 */
const MEMBER_MARK: Record<ProbeReport['members'][number]['state'], string> = {
  ok: '✓',
  fail: '✕',
  absent: '–',
  unverified: '⊘',
}

const TONE_ICON: Record<Notice['tone'], string> = {
  ok: 'M20 6L9 17l-5-5',
  fail: 'M18 6L6 18M6 6l12 12',
  network: 'M12 9v4m0 4h.01M10.3 3.9L2 18a2 2 0 003 2h16a2 2 0 002-2L13.7 3.9a2 2 0 00-3.4 0z',
}

function Glyph({ d }: { d: string }): JSX.Element {
  return (
    <svg className="dshr-compNoticeIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

/** 三个下拉里的一栏：标题行（可带右侧小注）+ 控件。`emptyHint` 在没得选时说明「为什么没有」。 */
function Picker(props: {
  label: string
  /** 标题右侧的小注（这一栏的用法要点，比塞进顶部那段长文字更容易被读到）。 */
  note?: string
  value: string
  options: Array<{ value: string; label: string }>
  emptyHint: string
  disabled?: boolean
  onChange: (value: string) => void
}): JSX.Element {
  const empty = props.options.length === 0
  return (
    <div className="dshr-compField">
      <div className="dshr-compFieldHead">
        <label className="dshr-compFieldLabel">{props.label}</label>
        {props.note !== undefined && <span className="dshr-compFieldNote">{props.note}</span>}
      </div>
      <select
        className="dshr-compSelect"
        value={props.value}
        disabled={props.disabled === true || empty}
        aria-label={props.label}
        onChange={(e) => { props.onChange(e.target.value) }}
      >
        {empty
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
  const [models, setModels] = useState<{ ids: string[]; empty?: 'none' | 'all-disabled' }>({ ids: [] })
  const [supplierId, setSupplierId] = useState('')
  const [modelId, setModelId] = useState('')
  const [uid, setUid] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [loaded, setLoaded] = useState(false)
  // 契约体检：只针对**外部供应商插件**（内置供应商随核心分发，没有独立插件可体检）
  const [pluginId, setPluginId] = useState('')
  const [probing, setProbing] = useState(false)
  const [report, setReport] = useState<ProbeReport | null>(null)
  const [probeError, setProbeError] = useState('')

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
        if (live) setNotice({ tone: 'network', text: (err as Error).message })
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
    setNotice(null)
    if (supplierId === '') { setModels({ ids: [] }); return }
    let live = true
    void (async () => {
      try {
        const data = await fetch(`${ROUTER_API_BASE}/suppliers/${encodeURIComponent(supplierId)}/models`, { cache: 'no-store' })
          .then((r) => r.json() as Promise<{ ok: boolean; models?: ModelRow[] }>)
        // 端点给的是**全部**模型（含用户停用的），这里只取可用的 —— 见 model-choice.ts
        if (live) setModels(data.ok ? modelChoice(data.models ?? []) : { ids: [] })
      } catch {
        if (live) setModels({ ids: [] })
      }
    })()
    return () => { live = false }
  }, [supplierId])

  // 外部供应商插件 = source 为 external 的那些（内置随核心分发，不进这个下拉）
  const pluginSuppliers = suppliers.filter((x) => x.source === 'external')

  const runProbe = async (): Promise<void> => {
    if (pluginId === '' || probing) return
    setProbing(true)
    setProbeError('')
    setReport(null)
    try {
      const response = await fetch(`${ROUTER_API_BASE}/suppliers/${encodeURIComponent(pluginId)}/probe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        cache: 'no-store',
      })
      const data = await response.json() as { ok: boolean; error?: string; report?: ProbeReport }
      if (data.ok && data.report !== undefined) setReport(data.report)
      else setProbeError(data.error ?? '体检失败')
    } catch (err) {
      setProbeError((err as Error).message)
    } finally {
      setProbing(false)
    }
  }

  const links = accounts.filter((a) => a.supplier === supplierId)
  const runnable = supplierId !== '' && modelId !== ''
  const supplierName = suppliers.find((s) => s.id === supplierId)?.name ?? supplierId

  const run = async (): Promise<void> => {
    if (!runnable || busy) return
    setBusy(true)
    setNotice(null)
    try {
      const response = await fetch(`${ROUTER_API_BASE}/suppliers/${encodeURIComponent(supplierId)}/models/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // uid 留空 = 池内任选可用号（与面板「测试」按钮同义）；选了 = 只测它。
        body: JSON.stringify({ id: modelId, uid }),
        cache: 'no-store',
      })
      const data = await response.json() as { ok: boolean; error?: string }
      const result: TestResult = {
        ok: data.ok,
        uid,
        supplier: supplierName,
        model: modelId,
        ...(data.error === undefined ? {} : { error: data.error }),
      }
      setNotice({ tone: data.ok ? 'ok' : 'fail', result })
    } catch (err) {
      setNotice({ tone: 'network', text: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dshr-tabBody dshr-comp">
      <p className="dshr-compIntro">选一个供应商、模型与连接，跑一次真实的访问测试。</p>

      <div className="dshr-compForm">
        <Picker
          label="供应商"
          value={supplierId}
          options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
          emptyHint={loaded ? '没有已启用的供应商' : '加载中…'}
          onChange={setSupplierId}
        />
        <Picker
          label="模型"
          note="仅可用"
          value={modelId}
          options={models.ids.map((id) => ({ value: id, label: id }))}
          emptyHint={supplierId === ''
            ? '先选供应商'
            : models.empty === 'all-disabled'
              ? '模型都被停用了（在供应商详情里开启）'
              : models.empty === 'none' ? '没有模型（可先在供应商详情里拉取）' : '请选择'}
          disabled={supplierId === ''}
          onChange={(v) => { setModelId(v); setNotice(null) }}
        />
        <Picker
          label="连接"
          note="留空 = 池内任选"
          value={uid}
          options={links.map((a) => ({
            value: a.uid,
            label: `${a.nickname ?? a.uid}${a.cooling ? '（冷却中）' : ''}`,
          }))}
          emptyHint={supplierId === '' ? '先选供应商' : '没有连接（留空则不指定）'}
          disabled={supplierId === ''}
          onChange={(v) => { setUid(v); setNotice(null) }}
        />
      </div>

      <div className="dshr-compActions dshr-compBtnRow">
        <Button
          variant="primary"
          size="md"
          disabled={!runnable || busy}
          onClick={() => { void run() }}
        >
          {busy ? '测试中…' : '跑一次访问测试'}
        </Button>
        {!runnable && <span className="dshr-compHint">先选供应商与模型</span>}
      </div>

      {notice !== null && (
        <div className="dshr-compNotice" data-tone={notice.tone} role="status">
          <Glyph d={TONE_ICON[notice.tone]} />
          <div className="dshr-compNoticeBody">
            {notice.tone === 'network' ? (
              <>
                <div className="dshr-compNoticeTitle">请求失败</div>
                <div className="dshr-compNoticeText">{notice.text}</div>
              </>
            ) : (
              <>
                <div className="dshr-compNoticeTitle">
                  {notice.tone === 'ok' ? '测试通过' : '测试失败'}
                </div>
                <div className="dshr-compNoticeText">
                  {notice.tone === 'ok'
                    ? '这个连接能正常访问该模型。'
                    : (notice.result.error ?? '上游没有给出原因')}
                </div>
                {/* 回显测的是哪三样：一条「通过」如果不带对象，就是没法归因的一串绿字。 */}
                <div className="dshr-compNoticeMeta">
                  {notice.result.supplier} · {notice.result.model} · {notice.result.uid === '' ? '池内任选' : notice.result.uid}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ---- 契约体检：外部供应商插件的每个契约成员 ---- */}
      <div className="dshr-compSection">
        <div className="dshr-compHead">
          <h4 className="dshr-compSectionTitle">插件契约体检</h4>
          <span className="dshr-compSectionNote">外部供应商插件</span>
        </div>
        <p className="dshr-compIntro">
          **全自动**：逐个成员实跑，能用探针输入试的就试（删连接传不存在的 id、登录回调
          传无效 URL），需要真实连接的就用连接池里的 token 真跑一次（调用上游、签到）。
          只有少数「任何输入都会破坏前提」的成员（`dispose` 卸载自己、`addApiKey` 要真 key）
          只报存在性 —— 报告里逐条写明谁验了、谁没验、为什么。
          <br />
          前提：连接池里要先有一个可用 token。
        </p>
        <div className="dshr-compProbeRow">
          <Picker
            label="供应商插件"
            value={pluginId}
            options={pluginSuppliers.map((x) => ({ value: x.id, label: x.name }))}
            emptyHint={pluginSuppliers.length === 0 ? '没有装外部供应商插件' : '请选择'}
            onChange={(v) => { setPluginId(v); setReport(null); setProbeError('') }}
          />
          <div className="dshr-compProbeBtn dshr-compBtnRow">
            <Button variant="primary" size="md" disabled={pluginId === '' || probing} onClick={() => { void runProbe() }}>
              {probing ? '体检中…' : '跑一次出厂体检'}
            </Button>
          </div>
        </div>

        {probeError !== '' && (
          <div className="dshr-compNotice" data-tone="network" role="status">
            <Glyph d={TONE_ICON.network} />
            <div className="dshr-compNoticeBody">
              <div className="dshr-compNoticeTitle">体检失败</div>
              <div className="dshr-compNoticeText">{probeError}</div>
            </div>
          </div>
        )}

        {report !== null && (
          <div className="dshr-compReport">
            <div className="dshr-compReportHead">
              <span className="dshr-compReportName">
                {report.name}
                <span className="dshr-compVerdict" data-verdict={report.verdict}>
                  {report.verdict === 'pass' ? '可以出厂' : report.verdict === 'warn' ? '有未验项' : '不合格'}
                </span>
              </span>
              <span className="dshr-compReportSum">
                共 {report.summary.total} 个 · 实现 {report.summary.implemented} · 实跑 {report.summary.ran} · 通过 {report.summary.ok} · 失败 {report.summary.fail} · 未实现 {report.summary.absent}
              </span>
            </div>
            {/* 核心侧：模型启用/禁用不是插件契约成员（核心代劳），但体检要报它的状态 */}
            <div className="dshr-compCore">
              <div className="dshr-compCoreHead">
                <span>模型启用状态（核心代劳）</span>
                <span>
                  {report.core.models.total === null
                    ? (report.core.models.note ?? '拿不到')
                    : `共 ${report.core.models.total} 个 · 启用 ${report.core.models.enabled} · 停用 ${report.core.models.disabled}`}
                </span>
              </div>
              <ul className="dshr-compCoreOps">
                {report.core.operations.map((o) => (
                  <li key={o.key}>
                    <span className="dshr-compCoreOpName">{o.label}</span>
                    <span className="dshr-compCoreOpState" data-ok={o.ok ?? false} data-ran={o.ran}>
                      {o.ran === false ? '未跑' : o.ok === true ? '实跑通过' : '实跑发现问题'} · {o.detail}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <ul className="dshr-compMembers">
              {report.members.map((m) => (
                <li key={m.key} className="dshr-compMember" data-state={m.state}>
                  <span className="dshr-compMemberState" aria-hidden="true">{MEMBER_MARK[m.state]}</span>
                  <span className="dshr-compMemberName">
                    {m.label}
                    <code className="dshr-compMemberKey">{m.key}</code>
                  </span>
                  <span className="dshr-compMemberDetail">{m.detail ?? ''}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
