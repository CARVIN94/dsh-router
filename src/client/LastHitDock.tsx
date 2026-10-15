/**
 * 输入框上方的「最近命中」徽章 —— 走 DSH 官方 `conversation.input.dock` 座位
 * （scope: session，见 dsh-client-ui-conversation 的 slots 契约）。
 *
 * 为什么用 slot 而不是认领 DOM：
 *   - slot 的 session scope 会**注入 `sessionId`**（SessionStandardProps），
 *     于是能按当前会话取「最近命中」—— team 多会话下不会显示别的成员；
 *   - slot 是稳定契约，宿主 hash 类名（如之前的 `.JObwrW_root`）随版本会变。
 * 参照实现：@deepseek-ai/dsh-client-ui-goal 的 GoalDock 同挂这个座位，
 * 组件 props 由宿主注入，`inject(sessionId)` 拿会话身份。
 *
 * 数据源：核心 `/router/api/last-hit?session=`（按会话取一条轻记录）。
 */
import { useEffect, useRef, useState } from 'react'
import { ROUTER_API_BASE } from '../shared.ts'
import { getLastHit, subscribeLastHit, type LastHit } from './last-hit-store.ts'

/** 路由字形（纯 currentColor 描边，14px 与相邻控件对齐）。 */
const ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="5" cy="5" r="2.4" />
    <circle cx="19" cy="5" r="2.4" />
    <circle cx="12" cy="19" r="2.4" />
    <path d="M7.4 5h9.2" />
    <path d="M5 7.4v6.2c0 2.6 3 3.4 4.6 3.8" />
    <path d="M19 7.4v6.2c0 2.6-3 3.4-4.6 3.8" />
  </svg>
)

/** 账号名：别名 → uid → 「无连接」。 */
function connectionName(hit: LastHit): string {
  const name = hit.account !== undefined && hit.account !== '' ? hit.account : hit.uid
  return name === '' ? '无连接' : name
}

/**
 * 积分展示。**未知就是未知**：`-1` / 缺省一律显示「未知」，
 * 绝不编一个 0 —— 沿用 store 那条「不用 0 冒充未知」的纪律。
 */
function creditsText(hit: LastHit): string {
  return hit.credits === undefined || hit.credits < 0 ? '未知' : `${Math.round(hit.credits)}`
}

/** 模型短名（去掉 `prefix/`；前缀在「服务商」行已单独列出）。 */
function modelShort(hit: LastHit): string {
  const full = hit.model === '' ? hit.supplier : hit.model
  const slash = full.lastIndexOf('/')
  return slash > 0 ? full.slice(slash + 1) : full
}

/** 宿主注入的 props（只声明用到的）。 */
interface LastHitDockProps {
  /** 宿主注入的会话身份；宿主未注入时为 undefined。 */
  sessionId?: string
}

/**
 * 输入框上方的「最近命中」徽章：图标 + 模型短名；点击展开连接/积分卡片。
 *
 * @param props 宿主注入的会话身份
 */
export function LastHitDock({ sessionId }: LastHitDockProps): JSX.Element {
  const [hit, setHit] = useState<LastHit | null>(() => getLastHit(sessionId))
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // 诊断：确认 slot 真挂上了、以及宿主是否注入了 sessionId
    console.info('[dsh-router] last-hit dock mounted, sessionId =', sessionId)
    return subscribeLastHit(sessionId, setHit)
  }, [sessionId])

  // 点外部收起：对齐宿主原生 popover 的关闭语义（primitives.Menu /
  // useDismissOnOutsidePointer）——document 级 `pointerdown` 冒泡相位（早于
  // click，避免"先选中后关闭"）、根节点含自身则忽略；另补 Escape 关闭。
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent): void => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target) === true) return
      setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // 无数据时**仍渲染占位**（不返回 null）：否则「挂载成功但暂无记录」看起来
  // 就像"整个控件不见了"，无法与"根本没挂上"区分。
  const rows: Array<[string, string]> = hit === null
    ? []
    : [
        ['服务商', hit.supplier],
        ['模型', modelShort(hit)],
        ['连接', connectionName(hit)],
        ['积分', creditsText(hit)],
      ]

  return (
    <div className="dshr-lastHit" ref={rootRef}>
      <button
        type="button"
        className={`dshr-lastHit-btn${hit !== null && !hit.ok ? ' dshr-lastHit-fail' : ''}`}
        aria-label="最近一次命中"
        aria-expanded={open}
        title={hit === null ? '暂无命中记录' : `${hit.model === '' ? hit.supplier : hit.model} · ${connectionName(hit)}`}
        onClick={() => setOpen((v) => !v)}
      >
        {ICON}
        <span className="dshr-lastHit-label">{hit === null ? '暂无' : modelShort(hit)}</span>
      </button>
      {open && (
        <div className="dshr-lastHit-card">
          <div className="dshr-lastHit-title">
            <span className="dshr-lastHit-titleLabel">
              {ICON}
              <span>路由</span>
            </span>
            <span className="dshr-lastHit-titleValue" title={hit?.requested}>
              {hit === null || hit.requested === '' ? '—' : hit.requested}
            </span>
          </div>
          <div className="dshr-lastHit-titleRule" />
          {rows.length === 0
            ? <div className="dshr-lastHit-row"><span className="dshr-lastHit-key">暂无命中记录</span></div>
            : rows.map(([k, v]) => (
                <div key={k} className="dshr-lastHit-row">
                  <span className="dshr-lastHit-key">{k}</span>
                  <span className="dshr-lastHit-val">{v}</span>
                </div>
              ))}
        </div>
      )}
    </div>
  )
}
