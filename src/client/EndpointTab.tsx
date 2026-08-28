/**
 * 端点与密钥 — 布局交互贴近 9router endpoint 页（无隧道/Tailscale）。
 * API Endpoint 卡片 + API Keys 卡片（Require API key + flex 行 key 列表 +
 * Create/暂停确认/Created 弹窗）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ROUTER_API_BASE,
  type RouterKey,
  type RouterKeysResponse,
  type RouterSettingsResponse,
} from '../shared.ts'
import { Modal } from './Modal.tsx'

/* ---------------- SVG 图标（material 风格线条） ---------------- */

function Icon({ d, size = 18 }: { d: string; size?: number }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

const I = {
  api: 'M4 4h16v16H4zM9 9h6v6H9zM12 9V7M12 17v-2M9 12H7M17 12h-2',
  key: 'M14 7a4 4 0 1 1-1.4 7.6L9 18H6v-3l4.4-4.4A4 4 0 0 1 14 7zM18 7h.01',
  visibility: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  visibilityOff: 'M4 4l16 16M10.6 5.2A10 10 0 0 1 12 5c6.5 0 10 6 10 6a17 17 0 0 1-3.3 4M6.1 6.6A17 17 0 0 0 2 12s3.5 6 10 6a9.6 9.6 0 0 0 4-.8M9.9 9.9a3 3 0 0 0 4.2 4.2',
  copy: 'M9 9h11v11H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  check: 'M4 12.5l5 5L20 6.5',
  add: 'M12 5v14M5 12h14',
  delete: 'M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M10 11v6M14 11v6',
}

function maskKey(full: string): string {
  if (!full || full.length <= 10) return full
  return `${full.slice(0, 6)}${'•'.repeat(Math.min(full.length - 10, 12))}${full.slice(-4)}`
}

export function EndpointTab(): JSX.Element {
  const [keys, setKeys] = useState<RouterKey[] | null>(null)
  const [requireApiKey, setRequireApiKey] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [pauseTarget, setPauseTarget] = useState<RouterKey | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<RouterKey | null>(null)
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(() => new Set())
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  const endpointBase = `${window.location.origin}/v1`

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const load = useCallback(async (): Promise<void> => {
    try {
      const [keysRes, settingsRes] = await Promise.all([
        fetch(`${ROUTER_API_BASE}/keys`, { cache: 'no-store' }),
        fetch(`${ROUTER_API_BASE}/settings`, { cache: 'no-store' }),
      ])
      const keysData = await keysRes.json() as RouterKeysResponse
      const settingsData = await settingsRes.json() as RouterSettingsResponse
      if (mounted.current) {
        if (keysData.ok && keysData.keys) setKeys(keysData.keys)
        else setError(keysData.error ?? '加载密钥失败')
        if (settingsData.ok && settingsData.requireApiKey !== undefined) setRequireApiKey(settingsData.requireApiKey)
      }
    } catch (err) {
      if (mounted.current) setError((err as Error).message)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const openCreate = (): void => {
    setNewKeyName('')
    setError('')
    setShowCreate(true)
  }

  const createKey = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`${ROUTER_API_BASE}/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newKeyName }),
        cache: 'no-store',
      })
      const data = await response.json() as { ok: boolean; error?: string; key?: string }
      if (data.ok && data.key) {
        setShowCreate(false)
        setNewKeyName('')
        setCreatedKey(data.key)
        await load()
      } else {
        setError(data.error ?? '创建失败')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const doDelete = async (id: string): Promise<void> => {
    const response = await fetch(`${ROUTER_API_BASE}/keys/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
      cache: 'no-store',
    })
    const data = await response.json() as { ok: boolean }
    if (data.ok) {
      setKeys(prev => prev ? prev.filter(k => k.id !== id) : prev)
      setVisibleKeys(prev => { const next = new Set(prev); next.delete(id); return next })
    }
    setDeleteTarget(null)
  }

  const toggleKey = async (id: string, isActive: boolean): Promise<void> => {
    const response = await fetch(`${ROUTER_API_BASE}/keys/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, isActive }),
      cache: 'no-store',
    })
    const data = await response.json() as { ok: boolean }
    if (data.ok) {
      setKeys(prev => prev ? prev.map(k => k.id === id ? { ...k, isActive } : k) : prev)
    }
  }

  const toggleRequire = async (value: boolean): Promise<void> => {
    setRequireApiKey(value)
    const response = await fetch(`${ROUTER_API_BASE}/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requireApiKey: value }),
      cache: 'no-store',
    })
    const data = await response.json() as { ok: boolean }
    if (!data.ok) setRequireApiKey(!value)
  }

  const copyText = async (text: string, id: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedKeyId(id)
      window.setTimeout(() => setCopiedKeyId(null), 1500)
    } catch {
      // ignore
    }
  }

  const toggleVisible = (id: string): void => {
    setVisibleKeys(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // key 开关：开→关需要确认（9router 行为）
  const onKeySwitch = (key: RouterKey, next: boolean): void => {
    if (key.isActive && !next) setPauseTarget(key)
    else void toggleKey(key.id, next)
  }

  return (
    <div className="dshr-tabBody">
      {error !== '' && <div className="dshr-alert"><strong>出错了</strong><span>{error}</span></div>}

      {/* ---------------- API Endpoint ---------------- */}
      <section className="dshr-card">
        <div className="dshr-cardHead">
          <span className="dshr-cardIcon"><Icon d={I.api} /></span>
          <div className="dshr-cardTitle">API Endpoint</div>
        </div>
        <div className="dshr-endpointList">
          <div className="dshr-endpointRow">
            <span className="dshr-endpointLabel">Local</span>
            <input className="dshr-input dshr-mono" value={endpointBase} readOnly />
            <button
              type="button"
              className="dshr-iconBtn"
              title="复制"
              onClick={() => void copyText(endpointBase, '__endpoint')}
            >
              <Icon d={copiedKeyId === '__endpoint' ? I.check : I.copy} size={16} />
            </button>
          </div>
          <div className="dshr-muted dshr-reason dshr-endpointNote">OpenAI 兼容。任何工具把 baseURL 指向它即可使用。鉴权由下方「Require API key」控制。</div>
        </div>
      </section>

      {/* ---------------- API Keys ---------------- */}
      <section className="dshr-card" id="require-api-key">
        <div className="dshr-cardHead">
          <span className="dshr-cardIcon"><Icon d={I.key} /></span>
          <div className="dshr-cardTitle">API Keys</div>
          <button type="button" className="dshr-primaryButton dshr-cardAction" onClick={openCreate}>
            <Icon d={I.add} size={14} />
            创建 Key
          </button>
        </div>

        {/* Require API key 行 */}
        <div className="dshr-requireRow">
          <div className="dshr-requireInfo">
            <p className="dshr-requireTitle">Require API key</p>
            <p className="dshr-requireDesc">不带有效 key 的请求将被拒绝</p>
          </div>
          <button
            type="button"
            className={`dshr-toggle ${requireApiKey ? 'dshr-toggle-on' : ''}`}
            role="switch"
            aria-checked={requireApiKey}
            onClick={() => void toggleRequire(!requireApiKey)}
            title={requireApiKey ? '关闭鉴权' : '开启鉴权'}
          >
            <span className="dshr-toggleKnob" />
          </button>
        </div>

        {/* key 列表 / 空状态 */}
        {keys === null
          ? <div className="dshr-empty">加载中…</div>
          : keys.length === 0
            ? (
              <div className="dshr-keyEmpty">
                <span className="dshr-keyEmptyIcon"><Icon d={I.key} size={30} /></span>
                <p className="dshr-keyEmptyTitle">还没有 API Key</p>
                <p className="dshr-keyEmptyDesc">创建第一个 key 开始使用</p>
                <button type="button" className="dshr-primaryButton" onClick={openCreate}>
                  <Icon d={I.add} size={14} />
                  创建 Key
                </button>
              </div>
            )
            : (
              <div className="dshr-keyList">
                {keys.map(key => (
                  <div key={key.id} className={`dshr-keyRow${key.isActive ? '' : ' dshr-keyRow-paused'}`}>
                    <div className="dshr-keyInfo">
                      <div className="dshr-keyNameRow">
                        <p className="dshr-keyName">{key.name}</p>
                        <button type="button" className="dshr-iconBtn dshr-iconBtn-sm dshr-keyDelete" title="删除" onClick={() => setDeleteTarget(key)}>
                          <Icon d={I.delete} size={14} />
                        </button>
                      </div>
                      <div className="dshr-keyValue">
                        <code className="dshr-mono">{visibleKeys.has(key.id) ? key.key : maskKey(key.key)}</code>
                        <button type="button" className="dshr-iconBtn dshr-iconBtn-sm" title={visibleKeys.has(key.id) ? '隐藏' : '显示'} onClick={() => toggleVisible(key.id)}>
                          <Icon d={visibleKeys.has(key.id) ? I.visibilityOff : I.visibility} size={14} />
                        </button>
                        <button type="button" className="dshr-iconBtn dshr-iconBtn-sm" title="复制" onClick={() => void copyText(key.key, key.id)}>
                          <Icon d={copiedKeyId === key.id ? I.check : I.copy} size={14} />
                        </button>
                      </div>
                      <p className="dshr-keyCreated">
                        创建于 {new Date(key.createdAt).toLocaleDateString()}
                        {key.isActive === false && <span className="dshr-keyPaused"> · 已暂停</span>}
                      </p>
                    </div>
                    <div className="dshr-keyOps">
                      <button
                        type="button"
                        className={`dshr-toggle ${key.isActive ? 'dshr-toggle-on' : ''}`}
                        role="switch"
                        aria-checked={key.isActive}
                        title={key.isActive ? '暂停 key' : '恢复 key'}
                        onClick={() => onKeySwitch(key, !key.isActive)}
                      >
                        <span className="dshr-toggleKnob" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
      </section>

      {/* ---------------- Create Key 弹窗 ---------------- */}
      {showCreate && (
        <Modal title="创建 API Key" onClose={() => setShowCreate(false)}>
          <div className="dshr-modalForm">
            <input
              className="dshr-input"
              placeholder="Key 名称（如 生产环境）"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              autoFocus
            />
            {error !== '' && <div className="dshr-alert"><strong>出错了</strong><span>{error}</span></div>}
            <div className="dshr-modalActions">
              <button type="button" className="dshr-miniButton" onClick={() => setShowCreate(false)}>取消</button>
              <button type="button" className="dshr-primaryButton" onClick={() => void createKey()} disabled={busy || newKeyName.trim() === ''}>
                {busy ? '创建中…' : '创建'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ---------------- Created Key 弹窗 ---------------- */}
      {createdKey !== null && (
        <Modal title="API Key 已创建" onClose={() => setCreatedKey(null)}>
          <div className="dshr-modalForm">
            <div className="dshr-warnBox">
              <p className="dshr-warnTitle">立即保存这个 key!</p>
              <p className="dshr-warnDesc">这是你唯一一次看到完整 key,请妥善保管。</p>
            </div>
            <div className="dshr-endpointRow dshr-createdRow">
              <input className="dshr-input dshr-mono" value={createdKey} readOnly />
              <button type="button" className="dshr-miniButton" onClick={() => void copyText(createdKey, '__created')}>
                {copiedKeyId === '__created' ? '已复制' : '复制'}
              </button>
            </div>
            <button type="button" className="dshr-primaryButton dshr-fullButton" onClick={() => setCreatedKey(null)}>完成</button>
          </div>
        </Modal>
      )}

      {/* ---------------- 暂停确认弹窗 ---------------- */}
      {pauseTarget !== null && (
        <Modal title="暂停 API Key" onClose={() => setPauseTarget(null)}>
          <div className="dshr-modalForm">
            <p className="dshr-muted">暂停 Key「{pauseTarget.name}」?此 key 将立即失效,之后可以恢复。</p>
            <div className="dshr-modalActions">
              <button type="button" className="dshr-miniButton" onClick={() => setPauseTarget(null)}>取消</button>
              <button type="button" className="dshr-dangerButton" onClick={() => { const t = pauseTarget; setPauseTarget(null); void toggleKey(t.id, false) }}>暂停</button>
            </div>
          </div>
        </Modal>
      )}

      {/* ---------------- 删除确认弹窗 ---------------- */}
      {deleteTarget !== null && (
        <Modal title="删除 API Key" onClose={() => setDeleteTarget(null)}>
          <div className="dshr-modalForm">
            <p className="dshr-muted">确定删除 Key「{deleteTarget.name}」吗?使用它的客户端将立即失效,无法恢复。</p>
            <div className="dshr-modalActions">
              <button type="button" className="dshr-miniButton" onClick={() => setDeleteTarget(null)}>取消</button>
              <button type="button" className="dshr-dangerButton" onClick={() => void doDelete(deleteTarget.id)}>删除</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
