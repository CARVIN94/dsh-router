/**
 * 输入框旁的「最近命中」指示器。
 *
 * 在宿主 composer 的上下文环（`.JObwrW_root`）之前插一个徽章：图标 + 模型名；
 * 点击展开一张小卡，显示账号显示别名与积分。样式与隔壁环对齐（同高、同 hover、
 * 图标同 14px / 同描边色），视觉上属于同一排原生控件。
 *
 * 数据源：核心的 `/router/api/last-hit`（全局最近一条，取 usage 明细环首项）。
 * 为什么不在前端直连 status：status 要遍历所有供应商拉积分（重），而这个
 * 徽章是跟随对话的高频刷新，必须走一个只读一条记录的轻端点。
 *
 * 认领手法沿袭 model-hint-copy.ts：宿主按需挂载 + React 重渲染会覆盖，
 * 用 MutationObserver 持续认领；已挂则跳过，不会重复插入。
 *
 * 升级路径：宿主若给 composer 长出官方 slot（把「当前路由」做成一级公民），
 * 删掉本文件。
 */

const DIGEST_API = '/router/api/last-hit'
/** 徽章容器类（认领自己的标记，避免重复插入）。 */
const BADGE_CLASS = 'dshr-lastHit'
/** 刷新间隔：命中信息跟着请求走，轮询取一个不打扰的频率。 */
const POLL_MS = 3000

/** 一次命中的快照（后端 `/last-hit` 的 `hit` 字段，只声明用到的）。 */
interface LastHit {
  supplier: string
  model: string
  uid: string
  account?: string
  credits?: number
  ok: boolean
}

/**
 * 路由字形（与设置导航同一枚，纯 currentColor 描边）。
 * 与隔壁上下文环的圆钮同尺寸同底色，一眼是同一排的原生控件。
 */
const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="5" r="2.4"/><circle cx="19" cy="5" r="2.4"/><circle cx="12" cy="19" r="2.4"/><path d="M7.4 5h9.2"/><path d="M5 7.4v6.2c0 2.6 3 3.4 4.6 3.8"/><path d="M19 7.4v6.2c0 2.6-3 3.4-4.6 3.8"/></svg>'

/** 账号展示文案：别名 → uid；积分 -1（未知）不显示数字。 */
function accountLine(hit: LastHit): string {
  const name = hit.account !== undefined && hit.account !== '' ? hit.account : hit.uid
  if (name === '') return '无账号'
  if (hit.credits === undefined || hit.credits < 0) return name
  return `${name} · ${Math.round(hit.credits)} 积分`
}

/** 模型全名（服务商/模型）—— 徽章上用。 */
function modelLine(hit: LastHit): string {
  return hit.model === '' ? hit.supplier : hit.model
}

/** 模型短名 —— 卡片里用（去掉 `prefix/`，前缀在「服务商」行已单独列出）。 */
function modelShort(hit: LastHit): string {
  const full = hit.model === '' ? hit.supplier : hit.model
  const slash = full.lastIndexOf('/')
  return slash > 0 ? full.slice(slash + 1) : full
}

/**
 * 持续把「最近命中」徽章挂到输入框旁。
 * @returns 清理函数：断开观察、停止轮询、移除节点
 */
export function mountLastHitBadge(): () => void {
  let latest: LastHit | null = null
  let badge: HTMLElement | null = null
  let label: HTMLElement | null = null
  let card: HTMLElement | null = null
  let cardOpen = false

  const renderBadge = (): void => {
    if (badge === null || label === null) return
    // 按钮 = 图标 + 模型名；完整信息（含账号/积分）走 title 与弹卡
    label.textContent = latest === null ? '—' : modelLine(latest)
    badge.title = latest === null ? '暂无命中记录' : `${modelLine(latest)} · ${accountLine(latest)}`
    badge.classList.toggle(BADGE_CLASS + '-fail', latest !== null && !latest.ok)
  }

  const renderCard = (): void => {
    if (card === null) return
    if (latest === null) {
      card.textContent = '暂无命中记录'
      return
    }
    card.replaceChildren()
    const head = document.createElement('div')
    head.className = BADGE_CLASS + '-head'
    head.textContent = '本次命中'
    card.appendChild(head)
    const rows: Array<[string, string]> = [
      ['模型', modelShort(latest)],
      ['服务商', latest.supplier],
      ['账号', accountLine(latest)],
    ]
    for (const [k, v] of rows) {
      const row = document.createElement('div')
      row.className = BADGE_CLASS + '-row'
      const key = document.createElement('span')
      key.className = BADGE_CLASS + '-key'
      key.textContent = k
      const val = document.createElement('span')
      val.className = BADGE_CLASS + '-val'
      val.textContent = v
      row.append(key, val)
      card.appendChild(row)
    }
  }

  const closeCard = (): void => {
    cardOpen = false
    if (card !== null) card.style.display = 'none'
  }

  const ensureMounted = (): void => {
    // 宿主已挂载且我们还没插 → 插到上下文环之前
    const anchor = document.querySelector<HTMLElement>('[class*="JObwrW_root"]')
    if (anchor === null || anchor.parentElement === null) return
    if (badge !== null && badge.isConnected) return

    const wrapper = document.createElement('div')
    wrapper.className = BADGE_CLASS

    const button = document.createElement('button')
    button.type = 'button'
    button.className = BADGE_CLASS + '-btn'
    button.setAttribute('aria-label', '最近一次命中')
    const icon = document.createElement('span')
    icon.innerHTML = ICON
    const text = document.createElement('span')
    text.className = BADGE_CLASS + '-label'
    button.append(icon.firstElementChild as Element, text)
    button.addEventListener('click', (e) => {
      e.stopPropagation()
      cardOpen = !cardOpen
      if (card !== null) card.style.display = cardOpen ? 'block' : 'none'
      if (cardOpen) renderCard()
    })

    const panel = document.createElement('div')
    panel.className = BADGE_CLASS + '-card'
    panel.style.display = 'none'

    wrapper.append(button, panel)
    anchor.parentElement.insertBefore(wrapper, anchor)
    badge = button
    label = text
    card = panel
    renderBadge()
    if (cardOpen) renderCard()
  }

  const refresh = async (): Promise<void> => {
    try {
      const res = await fetch(DIGEST_API, { cache: 'no-store' })
      const data = await res.json() as { ok: boolean; hit?: LastHit | null }
      latest = data.ok && data.hit ? data.hit : null
    } catch {
      // 网络抖动不该清空徽章（保留上次值）
    }
    ensureMounted()
    renderBadge()
    if (cardOpen) renderCard()
  }

  // 点击别处收起卡片（capture 阶段，避免与宿主事件打架）
  const onDocClick = (e: MouseEvent): void => {
    if (!cardOpen) return
    const t = e.target as Node | null
    if (badge !== null && badge.parentElement !== null && t !== null && badge.parentElement.contains(t)) return
    closeCard()
  }

  void refresh()
  const timer = window.setInterval(() => void refresh(), POLL_MS)
  const observer = new MutationObserver(ensureMounted)
  observer.observe(document.body, { childList: true, subtree: true })
  document.addEventListener('click', onDocClick, true)

  return () => {
    window.clearInterval(timer)
    observer.disconnect()
    document.removeEventListener('click', onDocClick, true)
    badge?.parentElement?.remove()
    badge = null
    label = null
    card = null
  }
}
