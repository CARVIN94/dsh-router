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
import { ROUTER_API_BASE, type RouterExtItem, type RouterExtResponse } from '../shared.ts'
import { extPanel } from './ext-panels.ts'

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

/**
 * 「查看真实装配结果」—— 面板上直接读 `GET /ext/prompt`。
 *
 * 为什么不看轨迹（2026-09-29 用户提的）：准则经 `ctx.systemPrompt.section()`
 * 进的是 **system message 本身**，轨迹里不会单列；而若改成像 mnemon 那样发一条
 * 真 user 消息，它就从「系统规定」降级成「有人说的一句话」，**权威性被改变**，
 * 还会污染输入历史与 fork 分支。⇒ 可见性用**只读端点**解决，不动注入通道。
 *
 * ⚠️ 它给的是 `assemble()` 的**真实结果**（含 Harness 身份、工具说明、以及
 *   其它插件贡献的段落），不是本扩展自己拼的字符串 —— 后者只是「我以为我发了
 *   什么」，两者可能不同。关掉某条分类后能不能确认「它真的没进去」，只有这里
 *   能回答。
 */
function PromptPreview(): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [data, setData] = useState<{ chars: number; sections: { name: string; chars: number }[]; text: string } | null>(null)
  const [error, setError] = useState('')

  const load = async (): Promise<void> => {
    setBusy(true); setError('')
    try {
      const res = await fetch(`${ROUTER_API_BASE}/ext/prompt`, { cache: 'no-store' })
      const body = await res.json() as { ok: boolean; error?: string } & Record<string, unknown>
      if (body.ok === true) setData(body as never)
      else setError(body.error ?? `读取失败（HTTP ${res.status}）`)
    } catch {
      setError('读取失败（网络）')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="dshr-compFoot">
        <span className="dshr-compRowState">实际生效的提示词</span>
        <span className="dshr-compCount">
          {data === null ? '未读取' : `${data.chars} 字 · ${data.sections.length} 段`}
        </span>
        {/* ⚠️ **这一整块默认收起，且不再常驻说明文字**（2026-09-29 用户两次嫌
             「布局太多」「太丑」）。它是**低频核对面**（「我关掉的真的没进去吗」），
             不是每次都要看的东西 —— 摆在主视图里只是噪音。摘要行自带
             「多少字 / 多少段」，够判断要不要展开。
             ⚠️ 也**删掉了原来的「段落来源列表」**：它列的段落与上面那 14 条控制
             **是同一批东西**，两个列表挨着是纯粹的重复占位。 */}
        {data === null
          ? (
            <button type="button" className="dshr-backLink" disabled={busy} onClick={() => { void load() }}>
              {busy ? '读取中…' : '读取'}
            </button>
          )
          : (
            <details>
              <summary className="dshr-compRowName" style={{ cursor: 'pointer', padding: '8px 0 2px' }}>
                展开全文
              </summary>
              {/* 提示词是代码不是散文 ⇒ 等宽字体 + 保留换行，与散文行区分开。 */}
              <pre className="dshr-promptDump">{data.text}</pre>
            </details>
          )}
        {error !== '' && <p className="dshr-compError" role="status">{error}</p>}
      </div>
    </>
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
  const controls = item.controls ?? []
  const [state, setState] = useState<Record<string, boolean>>(() => Object.fromEntries(controls.map((c) => [c.id, c.on])))
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  // 扩展重算 controls 后（例如用户在别处改了总开关）同步过来。
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
  return (
    // ⚠️ **类名全用 DSH 原生的**（`dshr-comp*`，见 `router.css` 与
    //   `RouterComponentsSection` 的同款用法）：内联 style 会跟着主题走丢
    //   （颜色/间距/字号在本仓有 CSS 变量，深浅色两套值），而这一页是设置里
    //   唯一的详情页，不该长成另一个样子。
    <section className="dshr-card">
      <div className="dshr-compGroup">
        <div className="dshr-compHead">
          <h4 className="dshr-compTitle">子开关</h4>
          <span className="dshr-compCount">
            {Object.values(state).filter(Boolean).length} / {controls.length} 生效
          </span>
        </div>
        {error !== '' && <p className="dshr-compError" role="status">{error}</p>}
        <ul className="dshr-compRows">
          {controls.map((c) => (
            <li key={c.id} className="dshr-compRow">
              <div className="dshr-compRowMain">
                {/* 标题与开关**同一行**（`.dshr-compRow` 本来就是 flex 行），
                    原文接在下面缩进 —— 这样一个开关占一行、一眼扫完 14 条。 */}
                <span className="dshr-compRowName">{c.title}</span>
                {/* ⚠️ 原文**默认显示、限两行**，点它才展开全文。
                    用户 2026-09-29 先要「直接展示不折叠」、随后嫌「布局太多」——
                    两个诉求的交汇点就是**给原文一个上限**：默认看得见（不折叠），
                    但不无限撑高（`line-clamp`）。特别长的（收口 / 底线 / 交付）
                    点一下看全。
                    ⚠️ 限高必须落在 **summary** 上、展开内容另放一份：整个正文塞进
                    summary 的话点击不会展开任何东西（`<summary>` 的内容一直显示）。 */}
                {typeof c.body === 'string' && c.body !== '' && (
                  <details className="dshr-compRowBodyWrap">
                    <summary className="dshr-compRowBody dshr-clamp2">{c.body}</summary>
                    <div className="dshr-compRowBody">{c.body}</div>
                  </details>
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
        {/* 脚注，不另起一张卡：它是「核对面」而不是第二个功能区。 */}
        <PromptPreview />
      </div>
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
      {/* 扩展说明 */}
      {item.description !== undefined && item.description !== '' && (
        <section className="dshr-card">
          <div className="dshr-muted" style={{ padding: '12px 14px' }}>{item.description}</div>
        </section>
      )}

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
