/**
 * 官方插件页（设置 → 插件）里 dsh-router-core 详情页的「路由组件」一节。
 *
 * 为什么在这里而不是官方那个「包含的组件」：那一节的行由宿主从**本 bundle 自己
 * 的 cordis.patch.yml** 算出来（plugin-manager `declaredRows`），跨 bundle 没有
 * 注入通道；而子插件（dsh-router-codebuddy / -ext-rtk …）各自是独立 bundle，
 * 必须保持独立安装。官方给的位置就是本节用的 `plugins.detail.section` 槽位
 * （渲染在原生行列表**之后**，自带 chrome）。
 *
 * 数据全部来自核心**已经在提供**的两个端点，不新增任何 API：
 *   - `GET /router/api/health` → `suppliers[]`（带 `source` 分内置/外部）
 *   - `GET /router/api/ext` → `enhancers[]`（核心已把开关与就绪状态合并好）
 *
 * 交互按各组真实能力给，不假装能开关：只有 ext 走 `PATCH /router/api/ext`
 * （核心持久化到 `<dataDir>/ext.json`）；供应商在这一页没有可写的开关 —— 内置/
 * 本地那组是随核心分发的一部分，外部那组的启停在它们自己的插件页。
 */
import { useEffect, useRef, useState } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { ROUTER_API_BASE, type RouterExtResponse, type RouterHealthResponse } from '../shared.ts'
import {
  EMPTY_COMPONENTS,
  groupRouterComponents,
  isEmptyComponents,
  type RouterComponentRow,
  type RouterComponents,
} from './router-components.ts'

/** 只在自己的 bundle 页渲染。 */
const BUNDLE_NAME = 'dsh-router-core'

/** 三组的标题与组级说明（顺序即渲染顺序）。 */
const GROUPS: ReadonlyArray<{ key: keyof RouterComponents; title: string; hint: string }> = [
  { key: 'local', title: '内置与本地供应商', hint: '' },
  { key: 'external', title: '外部供应商插件', hint: '各是独立安装的插件，启停在它自己的插件页' },
  { key: 'ext', title: '扩展', hint: '开关由路由核心保存' },
]

/** 宿主 slot 注入的 owner props（本地声明，不 import 宿主的 slot-contract 类型）。 */
interface Subject {
  kind?: string
  pkg?: { name?: string }
}

/** 读一个 GET 端点；失败当空答复，形状恒定。 */
async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    const response = await fetch(`${ROUTER_API_BASE}${path}`, { cache: 'no-store' })
    const data = await response.json() as T & { ok?: boolean; error?: string }
    if (data.ok === false) return undefined
    return data
  } catch {
    return undefined
  }
}

/** 写扩展开关；答复带回合并后的整张扩展表（核心 PATCH 后会重发一次列表）。 */
async function writeExt(id: string, enabled: boolean): Promise<RouterExtResponse | undefined> {
  try {
    const response = await fetch(`${ROUTER_API_BASE}/ext`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, enabled }),
      cache: 'no-store',
    })
    return await response.json() as RouterExtResponse
  } catch {
    return undefined
  }
}

function RowIcon({ row }: { row: RouterComponentRow }): JSX.Element {
  if (row.icon === undefined) {
    return <span className="dshr-compRowIcon" aria-hidden="true">◇</span>
  }
  return (
    <span className="dshr-compRowIcon">
      <img src={row.icon} alt="" onError={(e) => { e.currentTarget.style.display = 'none' }} />
    </span>
  )
}

/**
 * 一行：图标 + 名称 + 状态说明。
 *
 * 状态说明只给 ext 行（它的启停与就绪是运行时事实，值得逐条说）；供应商行
 * 在这一页没有可写的开关，含义由组标题承载，不编一句假状态给它。
 */
function Row({ row, busy, onToggle }: {
  row: RouterComponentRow
  busy: boolean
  onToggle: (row: RouterComponentRow, next: boolean) => void
}): JSX.Element {
  return (
    <li className="dshr-compRow">
      <RowIcon row={row} />
      <div className="dshr-compRowMain">
        <span className="dshr-compRowName">{row.name}</span>
        {row.togglable && (
          <span className="dshr-compRowState">{row.detail ?? (row.enabled === true ? '已启用' : '已关闭')}</span>
        )}
      </div>
      {row.togglable && (
        <Switch
          checked={row.enabled === true}
          // 自检未通过的扩展不给开（核心 PATCH 也会 409 拒，这里先不让点）。
          // 约定写在 docs/ext.md：不可用时开关禁用，而不是点了再报错。
          disabled={busy || (!row.enabled && row.ready !== true)}
          label={`${row.name} 开关`}
          title={!row.enabled && row.ready !== true
            ? (row.detail ?? '当前不可用,无法开启')
            : row.enabled === true ? `关闭 ${row.name}` : `开启 ${row.name}`}
          onChange={(next) => { onToggle(row, next) }}
        />
      )}
    </li>
  )
}

export function RouterComponentsSection({ subject }: { subject?: Subject }): JSX.Element | null {
  const [components, setComponents] = useState<RouterComponents>(EMPTY_COMPONENTS)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState('')
  const live = useRef(true)

  const mine = subject?.kind === 'bundle' && subject?.pkg?.name === BUNDLE_NAME

  const load = async (): Promise<void> => {
    const [health, ext] = await Promise.all([
      readJson<RouterHealthResponse>('/health'),
      readJson<RouterExtResponse>('/ext'),
    ])
    if (!live.current) return
    setError(health === undefined && ext === undefined ? '读取路由组件失败' : '')
    setComponents(groupRouterComponents(health ?? { ok: false }, ext ?? { ok: false }))
    setLoaded(true)
  }

  useEffect(() => {
    if (!mine) return
    live.current = true
    void load()
    return () => { live.current = false }
  }, [mine])

  if (!mine) return null

  const toggle = async (row: RouterComponentRow, next: boolean): Promise<void> => {
    const id = row.key.slice('ext:'.length)
    setBusy(id)
    setError('')
    const data = await writeExt(id, next)
    if (!live.current) return
    setBusy('')
    if (data?.ok === true) {
      setComponents(groupRouterComponents({ ok: true }, data))
      return
    }
    // 核心拒了（未就绪 / 不存在）或网络失败：回读真值，不留乐观假象。
    setError(data?.error ?? '切换扩展失败')
    await load()
  }

  const groups = GROUPS
    .map(({ key, title, hint }) => ({ title, hint, rows: components[key] }))
    .filter((g) => g.rows.length > 0)
  // 加载中或三组全空都不渲染：宿主那一节是「有内容才有一节标题」的形状。
  if (!loaded || isEmptyComponents(components)) return null

  return (
    <section className="dshr-comp" data-router-components>
      {error !== '' && <p className="dshr-compError" role="status">{error}</p>}
      {groups.map((group) => (
        <div key={group.title} className="dshr-compGroup">
          <div className="dshr-compHead">
            <h4 className="dshr-compTitle">{group.title}</h4>
            <span className="dshr-compCount">共 {group.rows.length} 个</span>
          </div>
          {group.hint !== '' && <p className="dshr-compHint">{group.hint}</p>}
          <ul className="dshr-compRows">
            {group.rows.map((row) => (
              <Row key={row.key} row={row} busy={busy === row.key.slice('ext:'.length)} onToggle={toggle} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
}
