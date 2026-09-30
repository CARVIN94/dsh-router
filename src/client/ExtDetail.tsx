/**
 * 扩展详情页 —— 从设置 → 路由 → 扩展 的卡片点进来。
 *
 * **总开关不在这一层。** 启停的唯一入口是官方插件页（设置 → 插件 →
 * dsh-router-core 详情页的「路由组件」一节），那里直接调核心的
 * `PATCH /router/api/ext`，自检与持久化都由核心裁决。同一件事只留一个开关，
 * 否则两处状态各说各话。
 *
 * **但扩展自带的子开关在这一层**（`item.controls`，如准则的每一条）：它管的是
 * 扩展自己的**行为细节**，没有第二处地方可放 —— 插件页那一行只有宿主管的
 * 总开关。走**同一个** PATCH 端点、同一个 `data` 落盘，不存在"两处状态各说
 * 各话"的问题（那正是总开关要单点的原因）。
 *
 * 列表页只列**已启用**的扩展（关闭的连卡片都不出现），所以这里也不必再显示
 * 「已启用/未启用」——那行字只能是常量。布局同供应商详情：返回链接 + 图标 +
 * 名称/副行，下面跟扩展说明卡与未就绪横幅。有 `api()` 支持的自定义扩展可在未来
 * 按需加独立面板，此处不内置任何具体扩展的专属视图。
 */
import { useEffect, useState } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { ROUTER_API_BASE, type ExtControlItem, type RouterExtItem, type RouterExtResponse } from '../shared.ts'
import { extPanel } from './ext-panels.ts'
import { Modal } from './Modal.tsx'

/**
 * 服务端的 `error` 是**给调试看的**（`'controlId must be a non-empty string'`、
 * `'reorder failed'`…），直接摆到页面上等于把 API 内部话漏给用户。
 *
 * 做法：**先认自己那几个已知中文错误**（核心对"为什么拒"给的是中文），其余一律
 * 回落到调用方给的兜底文案。宁可少说一句，也不要给一句看不懂的。
 */
function friendly(serverError: string | undefined, fallback: string): string {
  if (serverError === undefined || serverError === '') return fallback
  // 服务端已经写了中文（面向用户的拒绝理由）⇒ 原样透出。
  if (/[\u4e00-\u9fa5]/.test(serverError)) return serverError
  return fallback
}

/** 行内图标按钮里的图标（照 `CombosTab` 的同款路径与线宽，1.8px 描边）。 */
function RowIcon({ d, size = 15 }: { d: string; size?: number }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

/** 铅笔图标 —— 与 `CombosTab.tsx` / `SupplierDetail.tsx` 的 `I.edit` **逐字相同**。 */
const I_EDIT = 'M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3zM13.5 6.5l3 3'

function Icon({ d, size = 18 }: { d: string; size?: number }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

const I = {
  back: 'M19 12H5M12 19l-7-7 7-7',
  bolt: 'M13 2L4 14h6l-1 8 9-12h-6z',
}

/** 「+ 添加准则」弹窗 —— 标题 + 正文，必填。 */
function AddControlModal({
  onClose,
  onSave,
  busy,
}: {
  onClose: () => void
  onSave: (title: string, body: string) => void
  busy: boolean
}): JSX.Element {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const valid = title.trim() !== '' && body.trim() !== ''
  return (
    <Modal title="添加准则" onClose={onClose}>
      <div className="dshr-modalForm">
        <label className="dshr-requireTitle" htmlFor="dshr-add-title">标题</label>
        <input
          id="dshr-add-title"
          className="dshr-input"
          value={title}
          onChange={(e) => { setTitle(e.target.value) }}
          autoFocus
        />
        <label className="dshr-requireTitle" htmlFor="dshr-add-body">内容</label>
        <textarea
          id="dshr-add-body"
          className="dshr-input"
          style={{ minHeight: 140, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6 }}
          value={body}
          onChange={(e) => { setBody(e.target.value) }}
        />
        <div className="dshr-modalActions">
          <button type="button" className="dshr-miniButton" onClick={onClose} disabled={busy}>取消</button>
          <button
            type="button"
            className="dshr-primaryButton"
            disabled={busy || !valid}
            title={valid ? '添加' : '标题与内容都不能为空'}
            onClick={() => { onSave(title.trim(), body.trim()) }}
          >
            {busy ? '添加中…' : '添加'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * 「修改」弹窗 —— 改一个子开关的标题与正文（2026-09-29）。
 *
 * ⚠️ **改完必须真的进 prompt**，否则这就是"只改了显示"的假编辑
 * （服务端 `setControlText` + 渲染层的 `effectiveText` 是这件事的另一半）。
 *
 * ⚠️ **空标题 / 空正文不允许提交**（按钮禁用 + 服务端也拒）：空标题让这一行没
 *   名字，空正文让这条规则凭空消失 —— 两者都像"被关了"而不是"被改坏了"。
 */
function EditControlModal({
  control,
  onClose,
  onSave,
  onReset,
  onRemove,
  busy,
}: {
  control: ExtControlItem
  onClose: () => void
  onSave: (patch: { title?: string; body?: string }) => void
  /** 还原成内置内容（仅内置且被改过时可调）。 */
  onReset: () => void
  /** 删除这条自定义准则（仅自建条目可调）。 */
  onRemove: () => void
  busy: boolean
}): JSX.Element {
  const [title, setTitle] = useState(control.title)
  const [body, setBody] = useState(control.body ?? '')
  const trimmedTitle = title.trim()
  const trimmedBody = body.trim()
  const valid = trimmedTitle !== '' && trimmedBody !== ''

  return (
    <Modal title={`修改：${control.title}`} onClose={onClose}>
      <div className="dshr-modalForm">
        <label className="dshr-requireTitle" htmlFor={`dshr-ctl-title-${control.id}`}>标题</label>
        <input
          id={`dshr-ctl-title-${control.id}`}
          className="dshr-input"
          value={title}
          onChange={(e) => { setTitle(e.target.value) }}
          autoFocus
        />
        <label className="dshr-requireTitle" htmlFor={`dshr-ctl-body-${control.id}`}>内容</label>
        {/* 正文用 textarea：`input` 单行，长准则（收口/底线）没法编辑。 */}
        <textarea
          id={`dshr-ctl-body-${control.id}`}
          className="dshr-input"
          style={{ minHeight: 160, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6 }}
          value={body}
          onChange={(e) => { setBody(e.target.value) }}
        />
        <p className="dshr-compHint">
          改完立刻生效于 system prompt。此处只存**改过的部分**；未改的分类仍随内置版本更新。
        </p>
        {/* ⚠️ `dshr-modalActions` + `dshr-miniButton` —— 与 `CombosTab` 的
            创建/删除弹窗**同一套**（2026-09-29 用户指出）。原先是内联
            `display:flex` 手搓的按钮排布。 */}
        {/* ⚠️ 左：这一条**特有**的动作（自建⇒删除 / 内置被改过⇒还原）；
            右：通用的取消与保存。2026-09-29 把删/还原从行内挪到这里 ——
            它们是"次要且有破坏性"的动作，不该和「修改」挤在标题旁边
            （14 行 × 3 个常驻按钮 = 42 个按钮压过内容）。 */}
        <div className="dshr-modalActions">
          {control.custom === true
            ? (
              <button
                type="button"
                className="dshr-dangerButton"
                disabled={busy}
                onClick={onRemove}
              >
                删除这条
              </button>
            )
            : (
              <button
                type="button"
                className="dshr-miniButton"
                disabled={busy || control.overridden !== true}
                title={control.overridden === true ? '还原成内置内容' : '这条没被改过，无需还原'}
                onClick={onReset}
              >
                还原成内置
              </button>
            )}
          <span style={{ flex: 1 }} />
          <button type="button" className="dshr-miniButton" onClick={onClose} disabled={busy}>取消</button>
          <button
            type="button"
            className="dshr-primaryButton"
            disabled={busy || !valid}
            title={valid ? '保存' : '标题与内容都不能为空'}
            onClick={() => {
              // 只提交**真的变了**的字段：省一次写盘，也让"部分更新"这条契约在
              // UI 侧也成立（服务端是 `patch` 合并，不是整条替换）。
              const patch: { title?: string; body?: string } = {}
              if (trimmedTitle !== control.title) patch.title = trimmedTitle
              if (trimmedBody !== control.body) patch.body = trimmedBody
              onSave(patch)
            }}
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * 扩展自带的子开关（如准则的每一条）。
 *
 * ⚠️ **失败时回读真值，不留乐观假象**（与 `RouterComponentsSection.toggle` 同款
 * 纪律）：乐观更新看着顺，但核心拒了（扩展未就绪 / 未知 controlId / 网络失败）
 * 时，开关会停在一个「看起来成功了」的状态，而 prompt 里其实没变。
 *
 * ⚠️ **总开关关时显示为禁用而不是隐藏**：隐藏会让用户以为这些分类不存在。
 *   它们的值也没被清掉（总开关只叠加失效），所以重新打开总开关就恢复原样。
 */
function ExtControls({ item }: { item: RouterExtItem }): JSX.Element {
  // ⚠️ `rows` 存**当前的显示列表**（含顺序）：拖动与新增/删除要立刻反映在界面上，
  //   而它们只改服务端、只回一张新的 `controls`。用 props 直接渲染的话，
  //   拖动后要等下一次 GET 才会重排 —— 手上还抓着就跳回去了。
  const [rows, setRows] = useState<ExtControlItem[]>(() => [...(item.controls ?? [])])
  const controls = rows
  const [state, setState] = useState<Record<string, boolean>>(() => Object.fromEntries(controls.map((c) => [c.id, c.on])))
  const [busy, setBusy] = useState('')
  // ⚠️ 错误走**浮动提示**（`dshr-toast`，与 `SupplierDetail` 同款），不再是列表
  //   上方常驻的一行 —— 失败是**瞬时**事件，常驻行会一直占着位置。
  const [error, setError] = useState('')

  // 扩展重算 controls 后（例如用户在别处改了总开关）同步过来。
  useEffect(() => {
    setRows([...(item.controls ?? [])])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, item.enabled, (item.controls ?? []).length])

  useEffect(() => {
    setState(Object.fromEntries(controls.map((c) => [c.id, c.on])))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, item.enabled, controls.length])

  const toggle = async (id: string, next: boolean): Promise<void> => {
    setBusy(id)
    setError('')
    setState((s) => ({ ...s, [id]: next }))
    try {
      const response = await fetch(`${ROUTER_API_BASE}/ext`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, controlId: id, on: next }),
        cache: 'no-store',
      })
      const data = await response.json() as RouterExtResponse
      if (data.ok === true) {
        // 核心 PATCH 后会回发整张表 —— 直接用它对齐，省一次往返。
        const self = data.enhancers?.find((e) => e.id === item.id)
        if (self?.controls) setState(Object.fromEntries(self.controls.map((c) => [c.id, c.on])))
        return
      }
      setError(data.error ?? '切换失败')
    } catch {
      setError('切换失败（网络）')
    } finally {
      // ⚠️ 无论成败都**回读真值**：上面那条乐观更新必须被覆盖，否则失败时
      // 开关停在一个假的成功状态（这正是本仓反复栽过的「假绿」）。
      try {
        const res = await fetch(`${ROUTER_API_BASE}/ext`, { cache: 'no-store' })
        const data = await res.json() as RouterExtResponse
        const self = data.enhancers?.find((e) => e.id === item.id)
        if (self?.controls) setState(Object.fromEntries(self.controls.map((c) => [c.id, c.on])))
      } catch { /* 回读也失败就保留乐观值，错误已经显示 */ }
      setBusy('')
    }
  }

  const disabled = busy !== ''
  const withBody = controls.filter((c) => typeof c.body === 'string' && c.body !== '')
  // 正在编辑的分类 id（null = 没开弹窗）。
  const [editing, setEditing] = useState<string | null>(null)
  // 正在删除确认的分类 id（null = 没开弹窗）。
  const [removing, setRemoving] = useState<string | null>(null)
  // 「+ 添加准则」弹窗开关。
  const [adding, setAdding] = useState(false)
  // 拖动排序：正在被拖的那一项的下标。
  const [dragIndex, setDragIndex] = useState<number | null>(null)

  // 浮动提示 2.5s 后自动消失（同 `SupplierDetail.showToast` 的时长）。
  // ⚠️ 不自动消失就会**一直浮在页面上**遮内容 —— 失败是瞬时事件，提示也是。
  useEffect(() => {
    if (error === '') return undefined
    const t = window.setTimeout(() => { setError('') }, 2500)
    return () => { window.clearTimeout(t) }
  }, [error])
  // 标题单独存一份：开关的 `state` 只记 on/off，改标题后列表要立刻跟着变。
  const [titles, setTitles] = useState<Record<string, string>>(() =>
    Object.fromEntries((item.controls ?? []).map((c) => [c.id, c.title])))
  /**
   * 发一个 `op` 动作并**回读真值**。
   *
   * ⚠️ 成功与失败都回读：乐观更新看着顺，但服务端拒了（删内置条目 / 还原没改过的）
   * 时，面板会停在「以为改了却没生效」的状态。
   */
  const act = async (payload: Record<string, unknown>, onDone?: () => void): Promise<void> => {
    setBusy('op')
    setError('')
    try {
      const response = await fetch(`${ROUTER_API_BASE}/ext`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, ...payload }),
        cache: 'no-store',
      })
      const data = await response.json() as RouterExtResponse
      if (data.ok !== true) {
        setError(friendly(data.error, '操作失败'))
        return
      }
      const self = data.enhancers?.find((e) => e.id === item.id)
      if (self?.controls) {
        setState(Object.fromEntries(self.controls.map((c) => [c.id, c.on])))
        setTitles(Object.fromEntries(self.controls.map((c) => [c.id, c.title])))
        setRows(self.controls)
      }
      onDone?.()
    } catch {
      setError('操作失败（网络）')
    } finally {
      setBusy('')
    }
  }

  /** 拖动后落盘顺序；失败回读真值。 */
  const persist = async (ids: string[]): Promise<void> => {
    setError('')
    try {
      const response = await fetch(`${ROUTER_API_BASE}/ext`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, op: 'reorder', ids }),
        cache: 'no-store',
      })
      const data = await response.json() as RouterExtResponse
      if (data.ok !== true) {
        setError(friendly(data.error, '排序保存失败'))
      }
      const self = data.enhancers?.find((e) => e.id === item.id)
      if (self?.controls) setRows(self.controls)
    } catch {
      setError('排序保存失败（网络）')
      // ⚠️ 失败**必须回读真值**：否则行还停在拖出来的顺序上，而落盘是旧的
      // ⇒ 刷新一下就跳回去，用户以为没存上。
      try {
        const res = await fetch(`${ROUTER_API_BASE}/ext`, { cache: 'no-store' })
        const data = await res.json() as RouterExtResponse
        const self = data.enhancers?.find((e) => e.id === item.id)
        if (self?.controls) setRows(self.controls)
      } catch { /* 回读也失败就保留当前，错误已显示 */ }
    }
  }

  // 保存编辑。**成功与失败都回读真值**（同 `toggle` 的纪律）：乐观更新看着顺，
  // 但服务端拒了（未知 id / 空串）时面板会停在"改了却没生效"的状态。
  const save = async (controlId: string, patch: { title?: string; body?: string }): Promise<void> => {
    setBusy(controlId)
    setError('')
    try {
      const response = await fetch(`${ROUTER_API_BASE}/ext`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, controlId, ...patch }),
        cache: 'no-store',
      })
      const data = await response.json() as RouterExtResponse
      if (data.ok !== true) {
        setError(friendly(data.error, '保存失败'))
        return
      }
      // 核心 PATCH 后会回发整张表 —— 直接用它对齐，省一次往返。
      const self = data.enhancers?.find((e) => e.id === item.id)
      if (self?.controls) setState(Object.fromEntries(self.controls.map((c) => [c.id, c.on])))
      if (self?.controls) setTitles(Object.fromEntries(self.controls.map((c) => [c.id, c.title])))
      setEditing(null)
    } catch {
      setError('保存失败（网络）')
    } finally {
      setBusy('')
    }
  }

  return (
    // ⚠️ **类名全用 DSH 原生的**（`dshr-comp*`，见 `router.css` 与
    //   `RouterComponentsSection` 的同款用法）：内联 style 会跟着主题走丢
    //   （颜色/间距/字号在本仓有 CSS 变量，深浅色两套值），而这一页是设置里
    //   唯一的详情页，不该长成另一个样子。
    <section className="dshr-card">
      <div className="dshr-compGroup">
        {/* ⚠️ 页头 = `description`（[准则 v5]）+ 右侧「+ 添加准则」（2026-09-29）。
            **不再单独占一块区域** —— 之前标题自己一个卡、列表另一个卡，
            进来第一眼是"这块是什么"而不是准则本身。
            「添加」放在这里而不是页面外层：它与这列表是同一件事
            （增删改条目），而外层拿不到 `adding` 这个状态。 */}
        {item.description !== undefined && item.description !== '' && (
          <div className="dshr-compHeadPad">
            <h4 className="dshr-compTitle">{item.description}</h4>
            <button
              type="button"
              className="dshr-primaryButton"
              onClick={() => { setAdding(true) }}
              style={{ marginLeft: 'auto' }}
            >
              + 添加准则
            </button>
          </div>
        )}
        {/* ⚠️ **连「子开关」这个标题一起去掉了**（2026-09-29）。上一轮去掉计数后
            它只剩两个字，却仍占一行 —— 页面进来第一眼是「子开关」这三个字而不是
            那些规则本身。列表自带每条的标题与开关，不需要再套一层说明。 */}
        <ul className="dshr-compRows">
          {controls.map((c, index) => (
            <li
              key={c.id}
              className={`dshr-compRow${dragIndex === index ? ' dshr-linkRowDragging' : ''}`}
              draggable
              onDragStart={(e) => { setDragIndex(index); e.dataTransfer.effectAllowed = 'move' }}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
              onDrop={(e) => {
                e.preventDefault()
                if (dragIndex === null || dragIndex === index) { setDragIndex(null); return }
                const next = [...controls]
                const [moved] = next.splice(dragIndex, 1)
                if (moved !== undefined) next.splice(index, 0, moved)
                setDragIndex(null)
                void persist(next.map((x) => x.id))
              }}
              onDragEnd={() => { setDragIndex(null) }}
            >
              {/* 拖把 —— 与 `SupplierDetail` 连接池那一套**同一套**（2026-09-29）。 */}
              <span className="dshr-linkGrip" title="拖动排序" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                  <circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" />
                  <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
                  <circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
                </svg>
              </span>
              <div className="dshr-compRowMain">
                {/* ⚠️ 标题与「修改」按钮**必须包在同一个 flex 行里**（2026-09-29）。
                    `.dshr-compRowMain` 是 `flex-direction: column`，而
                    `.dshr-compRowName` 是**行内**元素、标题一长就换行 ⇒ 直接把
                    按钮放在 span 后面会掉到**下一行**，看着像"标题下面挂了个东西"。
                    ⇒ 用一个 `display:flex` 的行把两者并在一起，且 `min-width:0`
                    让长标题在**这一行内**省略号，而不是把按钮顶下去。 */}
                <div className="dshr-compRowTitleLine">
                  <span className="dshr-compRowName">{titles[c.id] ?? c.title}</span>
                  {/* ⚠️ 行内**只留「修改」**，且**hover 这一行才出现**（2026-09-29）。
                      14 行都常驻三个图标按钮 = 42 个按钮压过内容；它们绝大多数时候
                      不该被看见。`opacity: 0` + `:focus-within`（见 CSS）保证
                      **键盘聚焦时也会显形** —— 纯 `:hover` 会让键盘用户永远够不到。
                      删/还原已挪进修改弹窗（2026-09-29），它们是"次要且有破坏性"的动作，
                      不该和「修改」挤在标题旁边。 */}
                  {c.editable === true && (
                    <button
                      type="button"
                      className="dshr-iconBtn dshr-iconBtn-sm dshr-compRowAct"
                      aria-label={`修改「${titles[c.id] ?? c.title}」`}
                      title={`修改「${titles[c.id] ?? c.title}」的标题与内容`}
                      onClick={() => { setEditing(c.id) }}
                    >
                      <RowIcon d={I_EDIT} />
                    </button>
                  )}
                </div>
                {/* ⚠️ **原文直接全文展示，不折叠也不限高**（2026-09-29）。
                    中间那版是 `<details>` + `line-clamp: 2`（默认两行、点击展开），
                    理由是"14 条全展开太长" —— 但那是在**替用户决定什么算长**。
                    折叠 + 限高叠在一起还带来两个真问题：
                    ① 要看全文得**多点一次**，而"照着原文决定开不开"这个动作
                       被这一步打断；② 同一个 `body` 要渲染**两份**（summary 里
                       一份、展开区一份），两份可能不同步。
                    ⇒ 直接一个 `<span>`，内容即所见。 */}
                {typeof c.body === 'string' && c.body !== '' && (
                  <span className="dshr-compRowState">{c.body}</span>
                )}
              </div>
              <Switch
                checked={state[c.id] === true}
                disabled={disabled || item.enabled !== true}
                label={`${c.title} 开关`}
                title={item.enabled !== true
                  ? '扩展总开关已关闭，子开关暂不生效'
                  : (state[c.id] === true ? `关闭 ${c.title}` : `开启 ${c.title}`)}
                onChange={(next) => { void toggle(c.id, next) }}
              />
            </li>
          ))}
        </ul>
        {withBody.length === 0 && (
          <p className="dshr-compHint">本扩展没有提供原文。</p>
        )}
        {/* 添加自定义准则 */}
        {adding && (
          <AddControlModal
            busy={busy === 'add'}
            onClose={() => { setAdding(false) }}
            onSave={(t, b) => {
              void act({ op: 'add', title: t, body: b }, () => { setAdding(false) })
            }}
          />
        )}

        {/* 删除确认 —— 删除不可撤销，且清掉开关/覆盖/顺序里的关联数据 */}
        {removing !== null && (() => {
          const target = controls.find((c) => c.id === removing)
          if (target === undefined) return null
          return (
            <Modal title="删除自定义准则" onClose={() => { setRemoving(null) }}>
              <div className="dshr-modalForm">
                <p className="dshr-muted">确定删除「{titles[target.id] ?? target.title}」吗？此操作不可撤销。</p>
                <div className="dshr-modalActions">
                  <button type="button" className="dshr-miniButton" onClick={() => { setRemoving(null) }}>取消</button>
                  <button
                    type="button"
                    className="dshr-dangerButton"
                    disabled={busy !== ''}
                    onClick={() => { void act({ op: 'remove', controlId: target.id }, () => { setRemoving(null) }) }}
                  >
                    删除
                  </button>
                </div>
              </div>
            </Modal>
          )
        })()}

        {/* 编辑弹窗（在列表之外，避免嵌在 <li> 里影响排版） */}
        {editing !== null && (() => {
          const target = controls.find((c) => c.id === editing)
          if (target === undefined) return null
          return (
            <EditControlModal
              control={{ ...target, title: titles[target.id] ?? target.title }}
              busy={busy === editing}
              onClose={() => { setEditing(null) }}
              onSave={(patch) => { void save(editing, patch) }}
              // 还原/删除后**关掉弹窗**：状态已经变了，再开着会让人以为还能改。
              onReset={() => { void act({ op: 'reset', controlId: editing }, () => { setEditing(null) }) }}
              onRemove={() => { setEditing(null); setRemoving(editing) }}
            />
          )
        })()}
      </div>
      {error !== '' && <div className="dshr-toastWrap" role="status">{error}</div>}
    </section>
  )
}

interface ExtDetailProps {
  item: RouterExtItem
  onBack: () => void
}

export function ExtDetail({ item, onBack }: ExtDetailProps): JSX.Element {
  // 扩展**自带**详情面板时用它（插件自检就是这么做的：选供应商/模型/连接 + 跑测试）。
  // 没有就退回下面这张通用只读页 —— 保留返回链接与标题，导航形状与有没有自定义
  // 面板无关，用户点进去的预期是稳定的。
  const Custom = extPanel(item.id)
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
            {item.icon !== undefined
              ? (
                <img
                  className="dshr-providerImg"
                  src={item.icon}
                  alt=""
                  // 同上：失败就藏，露出备用图标位置（不显示碎图）
                  onError={(e) => { e.currentTarget.style.display = 'none' }}
                />
              )
              : <Icon d={I.bolt} size={22} />}
          </div>
          <div className="dshr-providerMeta">
            <h1 className="dshr-providerName">{item.name}</h1>
            <p className="dshr-providerCount">
              <span className="dshr-mono">{item.id}</span>
              {item.ready === false ? ' · 未就绪' : ''}
            </p>
          </div>
        </div>
      </div>

      {/* 扩展自带的面板优先（注册表命中时下面几块都不渲染） */}
      {Custom !== undefined ? <Custom /> : (
        <>
      {/* 子开关（扩展自己的行为细节；没有 controls 就不渲染这一块） */}
      {item.controls !== undefined && item.controls.length > 0 && <ExtControls item={item} />}

      {/* 实际生效的提示词（只读预览；回答「关掉的真的没进去吗」） */}
      {/* 未就绪警示（同供应商详情的出错横幅） */}
      {item.ready === false && (
        <div className="dshr-alert">
          <strong>未就绪</strong>
          <span>{item.detail !== undefined && item.detail !== '' ? item.detail : '当前不可用'}</span>
        </div>
      )}
        </>
      )}
    </div>
  )
}
