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
import { useEffect, useState } from 'react'
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
  sessionId: string
}

/**
 * 输入框上方的「最近命中」徽章：图标 + 模型短名；点击展开连接/积分卡片。
 *
 * @param props 宿主注入的会话身份
 */
export function LastHitDock({ sessionId }: LastHitDockProps): JSX.Element | null {
  const [hit, setHit] = useState<LastHit | null>(() => getLastHit(sessionId))
  const [open, setOpen] = useState(false)

  useEffect(() => {
    // 订阅共享轮询的结果（每个会话各自订阅，键为 sessionId）
    return subscribeLastHit(sessionId, setHit)
  }, [sessionId])

  if (hit === null) return null

  const rows: Array<[string, string]> = [
    ['服务商', hit.supplier],
    ['模型', modelShort(hit)],
    ['连接', connectionName(hit)],
    ['积分', creditsText(hit)],
  ]

  return (
    <div className="dshr-lastHit">
      <button
        type="button"
        className={`dshr-lastHit-btn${hit.ok ? '' : ' dshr-lastHit-fail'}`}
        aria-label="最近一次命中"
        aria-expanded={open}
        title={`${hit.model === '' ? hit.supplier : hit.model} · ${connectionName(hit)}`}
        onClick={() => setOpen((v) => !v)}
      >
        {ICON}
        <span className="dshr-lastHit-label">{modelShort(hit)}</span>
      </button>
      {open && (
        <div className="dshr-lastHit-card">
          <div className="dshr-lastHit-title">
            <span className="dshr-lastHit-titleLabel">
              {ICON}
              <span>路由</span>
            </span>
            <span className="dshr-lastHit-titleValue" title={hit.requested}>
              {hit.requested === '' ? '—' : hit.requested}
            </span>
          </div>
          <div className="dshr-lastHit-titleRule" />
          {rows.map(([k, v]) => (
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
