/**
 * 组合 — 布局交互贴近 9router combos 页。
 * 组合 = 命名的一组模型（完整名 alias/id），请求 model 传组合名时，
 * 按策略（回退/轮询）命中其中一个。可创建/编辑/删除。
 */
import { useEffect, useRef, useState } from 'react'
import {
  ROUTER_API_BASE,
  type RouterCombo,
  type RouterComboAlias,
  type RouterComboStrategy,
  type RouterComboSupplierGroup,
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
  layers: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17l9 5 9-5',
  add: 'M12 5v14M5 12h14',
  copy: 'M9 9h11v11H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  check: 'M4 12.5l5 5L20 6.5',
  edit: 'M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3zM13.5 6.5l3 3',
  delete: 'M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M10 11v6M14 11v6',
  grip: 'M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01',
  search: 'M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM21 21l-4.35-4.35',
}

interface CombosTabProps {
  /** 当前组合列表（models 为裸模型 id）。 */
  combos: RouterCombo[]
  /** 供应商前缀信息（展示时拼全名 alias/id）。 */
  aliases: RouterComboAlias[]
  onRefresh: () => void
}

interface ComboForm {
  name: string
  strategy: RouterComboStrategy
  models: string[]
}

export function CombosTab({ combos, aliases, onRefresh }: CombosTabProps): JSX.Element {
  /**
   * 存储值 → 展示全名 alias/model。
   * 存储格式 = `supplierId,modelId`：精准，同名模型不会串台。
   * 兼容旧数据的裸 modelId：查不到归属就显示裸名——不能兜底套第一个供应商的
   * 前缀，那样前缀是假的。
   */
  const displayName = (stored: string): string => {
    const comma = stored.indexOf(',')
    if (comma > 0) {
      const sid = stored.slice(0, comma)
      const mid = stored.slice(comma + 1)
      const g = groups.find(x => x.supplier.id === sid)
      const alias = g?.supplier.alias ?? aliases.find(a => a.id === sid)?.alias ?? ''
      return alias === '' ? mid : `${alias}/${mid}`
    }
    // 旧数据裸 id：按分组找归属（优先已启用的），找不到显示裸名
    const hit = groups.find(g => g.models.some(m => m.id === stored && m.enabled))
      ?? groups.find(g => g.models.some(m => m.id === stored))
    return hit === undefined ? stored : `${hit.supplier.alias}/${stored}`
  }
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<RouterCombo | null>(null)
  const [form, setForm] = useState<ComboForm>({ name: '', strategy: 'fallback', models: [] })
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<RouterCombo | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [modelQuery, setModelQuery] = useState('')
  const [groups, setGroups] = useState<RouterComboSupplierGroup[]>([])
  const [loadingGroups, setLoadingGroups] = useState(false)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    void loadGroups()
    return () => { mounted.current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 打开弹窗时才拉取可用模型（按供应商分组）。 */
  const loadGroups = async (): Promise<void> => {
    setLoadingGroups(true)
    try {
      const response = await fetch(`${ROUTER_API_BASE}/combos`, { cache: 'no-store' })
      const data = await response.json() as { ok: boolean; groups?: RouterComboSupplierGroup[] }
      if (mounted.current) setGroups(data.groups ?? [])
    } catch {
      if (mounted.current) setGroups([])
    } finally {
      if (mounted.current) setLoadingGroups(false)
    }
  }

  const showToast = (msg: string): void => {
    setToast(msg)
    window.setTimeout(() => {
      if (mounted.current) setToast(null)
    }, 2500)
  }

  const openCreate = (): void => {
    setForm({
      name: '',
      strategy: 'fallback',
      models: [],
    })
    setModelQuery('')
    setFormError('')
    setEditing(null)
    setShowForm(true)
    void loadGroups()
  }

  const openEdit = (combo: RouterCombo): void => {
    setForm({
      name: combo.name,
      strategy: combo.strategy,
      models: [...combo.models],
    })
    setModelQuery('')
    setFormError('')
    setEditing(combo)
    setShowForm(true)
    void loadGroups()
  }

  const patchForm = (patch: Partial<ComboForm>): void => {
    setForm(prev => ({ ...prev, ...patch }))
  }

  /** 勾选：存 `supplierId,modelId`（精准归属，展示时才拼 alias）。 */
  const toggleModel = (supplierId: string, id: string): void => {
    const stored = `${supplierId},${id}`
    patchForm({
      models: form.models.includes(stored)
        ? form.models.filter(m => m !== stored)
        : [...form.models, stored],
    })
  }

  const handleDragStart = (index: number): void => {
    setDragIndex(index)
  }

  const handleDragOver = (e: React.DragEvent, index: number): void => {
    e.preventDefault()
    if (dragOverIndex !== index) setDragOverIndex(index)
  }

  const handleDrop = (index: number): void => {
    if (dragIndex === null || dragIndex === index) {
      setDragIndex(null)
      setDragOverIndex(null)
      return
    }
    const next = [...form.models]
    const [moved] = next.splice(dragIndex, 1)
    if (moved === undefined) { setDragIndex(null); setDragOverIndex(null); return }
    next.splice(index, 0, moved)
    patchForm({ models: next })
    setDragIndex(null)
    setDragOverIndex(null)
  }

  const removeModel = (index: number): void => {
    patchForm({ models: form.models.filter((_, i) => i !== index) })
  }

  const save = async (): Promise<void> => {
    if (form.name.trim() === '') { setFormError('组合名不能为空'); return }
    if (form.models.length === 0) { setFormError('至少需要一个模型'); return }
    setSaving(true)
    setFormError('')
    try {
      const isEdit = editing !== null
      const response = await fetch(`${ROUTER_API_BASE}/combos/${isEdit ? 'update' : 'create'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isEdit
          ? { id: editing!.id, name: form.name.trim(), strategy: form.strategy, models: form.models }
          : { name: form.name.trim(), strategy: form.strategy, models: form.models }),
        cache: 'no-store',
      })
      const data = await response.json() as { ok: boolean; error?: string }
      if (data.ok) {
        setShowForm(false)
        onRefresh()
        showToast(isEdit ? '组合已更新' : '组合已创建')
      } else {
        setFormError(data.error ?? '保存失败')
      }
    } catch (err) {
      setFormError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const doDelete = async (id: string): Promise<void> => {
    const response = await fetch(`${ROUTER_API_BASE}/combos/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
      cache: 'no-store',
    })
    const data = await response.json() as { ok: boolean; error?: string }
    setDeleteTarget(null)
    if (data.ok) {
      onRefresh()
      showToast('组合已删除')
    } else {
      showToast(data.error ?? '删除失败')
    }
  }

  const copyName = async (name: string, id: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(name)
      setCopied(id)
      window.setTimeout(() => setCopied(null), 1500)
    } catch {
      // ignore
    }
  }

  const updateStrategy = async (id: string, strategy: RouterComboStrategy): Promise<void> => {
    const combo = combos.find(c => c.id === id)
    if (!combo) return
    const response = await fetch(`${ROUTER_API_BASE}/combos/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name: combo.name, strategy, models: combo.models }),
      cache: 'no-store',
    })
    const data = await response.json() as { ok: boolean; error?: string }
    if (data.ok) {
      onRefresh()
      showToast(`策略已切换为${strategy === 'round-robin' ? '轮询' : '回退'}`)
    } else {
      showToast(data.error ?? '更新失败')
    }
  }

  return (
    <div className="dshr-tabBody">
      {/* Header */}
      <section className="dshr-card dshr-comboIntro">
        <div className="dshr-cardHead">
          <span className="dshr-cardIcon"><Icon d={I.layers} size={16} /></span>
          <div className="dshr-cardTitle">组合</div>
          <span className="dshr-muted dshr-comboIntroDesc">请求传组合名,在一组模型中按策略命中</span>
          <button type="button" className="dshr-primaryButton dshr-cardAction" onClick={openCreate}>
            <Icon d={I.add} size={14} />
            创建组合
          </button>
        </div>
        <div className="dshr-comboIntroBody">
          <span className="dshr-comboHeaderKey">回退</span> 按顺序尝试,前面失败时用下一个
          <span className="dshr-comboHeaderKey dshr-comboHeaderKey-2">轮询</span> 在模型间轮转分配请求
        </div>
      </section>

      {/* 列表 / 空状态 */}
      {combos.length === 0 ? (
        <div className="dshr-keyEmpty">
          <span className="dshr-keyEmptyIcon"><Icon d={I.layers} size={30} /></span>
          <p className="dshr-keyEmptyTitle">暂无组合</p>
          <p className="dshr-keyEmptyDesc">创建组合,在一组模型中按策略命中</p>
          <button type="button" className="dshr-primaryButton" onClick={openCreate}>
            <Icon d={I.add} size={14} />
            创建组合
          </button>
        </div>
      ) : (
        <div className="dshr-comboList">
          {combos.map(combo => (
            <section key={combo.id} className="dshr-card dshr-comboCard">
              <div className="dshr-cardHead">
                <span className="dshr-cardIcon"><Icon d={I.layers} size={16} /></span>
                <code className="dshr-comboName">{combo.name}</code>
                <span className="dshr-muted dshr-cardMeta">{combo.models.length} 模型</span>
                <div className="dshr-comboOps">
                  <select
                    className="dshr-input dshr-comboStrategySelect"
                    value={combo.strategy}
                    title="组合策略"
                    onChange={(e) => void updateStrategy(combo.id, e.target.value as RouterComboStrategy)}
                  >
                    <option value="fallback">回退</option>
                    <option value="round-robin">轮询</option>
                  </select>
                  <button type="button" className="dshr-iconBtn dshr-iconBtn-sm" title="复制组合名" onClick={() => void copyName(combo.name, combo.id)}>
                    <Icon d={copied === combo.id ? I.check : I.copy} size={15} />
                  </button>
                  <button type="button" className="dshr-iconBtn dshr-iconBtn-sm" title="编辑" onClick={() => openEdit(combo)}>
                    <Icon d={I.edit} size={15} />
                  </button>
                  <button type="button" className="dshr-iconBtn dshr-iconBtn-sm dshr-comboOpBtn-danger" title="删除" onClick={() => setDeleteTarget(combo)}>
                    <Icon d={I.delete} size={15} />
                  </button>
                </div>
              </div>
              <div className="dshr-comboCardBody">
                <div className="dshr-comboChips">
                  {combo.models.length === 0
                    ? <span className="dshr-muted dshr-comboEmptySteps">无模型</span>
                    : (
                      <>
                        {combo.models.slice(0, 4).map((model, i) => (
                          <span key={`${model}-${i}`} className="dshr-comboChip">
                            <span className="dshr-comboChipNum">{i + 1}</span>
                            <span className="dshr-comboChipSupplier">{displayName(model)}</span>
                          </span>
                        ))}
                        {combo.models.length > 4 && (
                          <span className="dshr-comboMore">+{combo.models.length - 4} more</span>
                        )}
                      </>
                    )}
                </div>
                <div className="dshr-muted dshr-reason">
                  {combo.strategy === 'fallback'
                    ? '按此顺序尝试模型;当前模型不可用时换下一个。'
                    : '请求在模型间轮转分配。'}
                </div>
              </div>
            </section>
          ))}
        </div>
      )}

      {/* ---- 创建/编辑弹窗 ---- */}
      {showForm && (
        <Modal title={editing !== null ? '编辑组合' : '创建组合'} onClose={() => setShowForm(false)} className="dshr-modal-wide">
          <div className="dshr-modalForm">
            <div className="dshr-comboFormSplit">
              <div className="dshr-comboFormDivider" aria-hidden="true" />
              {/* 左：组合名 + 策略 + 已选模型 */}
              <div className="dshr-comboFormLeft">
                <div>
                  <p className="dshr-formLabel">组合名</p>
                  <input
                    className="dshr-input dshr-mono"
                    placeholder="my-combo"
                    value={form.name}
                    onChange={(e) => patchForm({ name: e.target.value })}
                    autoFocus
                  />
                  <p className="dshr-formHint">只能含字母、数字、-、_ 和 .</p>
                </div>
                <div>
                  <p className="dshr-formLabel">策略</p>
                  <select
                    className="dshr-input"
                    value={form.strategy}
                    onChange={(e) => patchForm({ strategy: e.target.value as RouterComboStrategy })}
                  >
                    <option value="fallback">回退 — 按顺序尝试,失败换下一个</option>
                    <option value="round-robin">轮询 — 在模型间轮转分配</option>
                  </select>
                </div>
                <div>
                  <p className="dshr-formLabel">模型（已选 {form.models.length}）</p>
                  {form.models.length === 0 ? (
                    <div className="dshr-comboEmptyStepsBox">
                      <Icon d={I.layers} size={20} />
                      <p className="dshr-muted">还没有模型</p>
                    </div>
                  ) : (
                    <div className="dshr-comboStepList">
                      {form.models.map((model, index) => (
                        <div
                          key={`${model}-${index}`}
                          className={`dshr-comboStepRow${dragIndex === index ? ' dshr-comboStepRow-dragging' : ''}${dragOverIndex === index && dragIndex !== null && dragIndex !== index ? ' dshr-comboStepRow-over' : ''}`}
                          draggable
                          onDragStart={() => handleDragStart(index)}
                          onDragOver={(e) => handleDragOver(e, index)}
                          onDrop={() => handleDrop(index)}
                          onDragEnd={() => { setDragIndex(null); setDragOverIndex(null) }}
                        >
                          <span className="dshr-comboGrip" title="拖拽排序"><Icon d={I.grip} size={14} /></span>
                          <span className="dshr-comboStepNum">{index + 1}</span>
                          <code className="dshr-comboSelectedModel">{displayName(model)}</code>
                          <button type="button" className="dshr-iconBtn dshr-iconBtn-sm dshr-comboStepRemove" title="移除" onClick={() => removeModel(index)}>
                            <Icon d={I.delete} size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              {/* 右：添加模型 */}
              <div className="dshr-comboFormRight">
                <p className="dshr-formLabel">添加模型</p>
                <div className="dshr-modelSearch dshr-comboModelSearch">
                  <span className="dshr-modelSearchIcon"><Icon d={I.search} size={13} /></span>
                  <input
                    className="dshr-input"
                    placeholder="搜索模型…"
                    value={modelQuery}
                    onChange={(e) => setModelQuery(e.target.value)}
                  />
                </div>
                <div className="dshr-comboPickList">
                  {loadingGroups
                    ? <p className="dshr-muted dshr-comboPickEmpty">加载中…</p>
                    : groups.length === 0
                      ? <p className="dshr-muted dshr-comboPickEmpty">没有可添加的模型</p>
                      : groups.map(g => {
                        const items = g.models.filter(m =>
                          !form.models.includes(`${g.supplier.id},${m.id}`) &&
                          (modelQuery === '' || m.id.toLowerCase().includes(modelQuery.toLowerCase())))
                        if (items.length === 0) return null
                        return (
                          <div key={g.supplier.id} className="dshr-comboPickGroup">
                            <p className="dshr-comboPickGroupTitle">{g.supplier.name} · {g.supplier.alias}</p>
                            {items.map(m => (
                              <button key={m.id} type="button" className="dshr-comboPickItem" onClick={() => toggleModel(g.supplier.id, m.id)}>
                                <span className="dshr-comboPickName">{m.id}</span>
                              </button>
                            ))}
                          </div>
                        )
                      })}
                </div>
              </div>
            </div>
            {formError !== '' && <div className="dshr-alert"><strong>出错了</strong><span>{formError}</span></div>}
            <div className="dshr-modalActions">
              <button type="button" className="dshr-miniButton" onClick={() => setShowForm(false)}>取消</button>
              <button type="button" className="dshr-primaryButton" onClick={() => void save()} disabled={saving || form.name.trim() === '' || form.models.length === 0}>
                {saving ? '保存中…' : editing !== null ? '保存' : '创建'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ---- 删除确认 ---- */}
      {deleteTarget !== null && (
        <Modal title="删除组合" onClose={() => setDeleteTarget(null)}>
          <div className="dshr-modalForm">
            <p className="dshr-muted">确定删除组合「{deleteTarget.name}」吗？</p>
            <div className="dshr-modalActions">
              <button type="button" className="dshr-miniButton" onClick={() => setDeleteTarget(null)}>取消</button>
              <button type="button" className="dshr-dangerButton" onClick={() => void doDelete(deleteTarget.id)}>删除</button>
            </div>
          </div>
        </Modal>
      )}

      {toast !== null && <div className="dshr-toast">{toast}</div>}
    </div>
  )
}
