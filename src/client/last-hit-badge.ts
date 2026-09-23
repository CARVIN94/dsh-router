/**
 * 输入框旁的「最近命中」指示器。
 *
 * 在宿主 composer 的上下文环（`.JObwrW_root`）之前插一个小徽章，显示当前
 * 请求命中的服务商/模型；点击展开一张小卡，显示账号显示别名与积分。
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

/** 一次命中的快照（后端 `/last-hit` 的 `hit` 字段）。 */
interface LastHit {
  supplier: string
  model: string
  requested: string
  uid: string
  account?: string
  credits?: number
  ok: boolean
  ts: number
}

/** 账号展示文案：别名 → uid；积分 -1（未知）不显示数字。 */
function accountLine(hit: LastHit): string {
  const name = hit.account !== undefined && hit.account !== '' ? hit.account : hit.uid
  if (name === '') return '无账号'
  if (hit.credits === undefined || hit.credits < 0) return name
  return `${name} · ${Math.round(hit.credits)} 积分`
}

/** 徽章上的主文案：模型全名（服务商/模型）。 */
function modelLine(hit: LastHit): string {
  return hit.model === '' ? hit.supplier : hit.model
}

/**
 * 持续把「最近命中」徽章挂到输入框旁。
 * @returns 清理函数：断开观察、停止轮询、移除节点
 */
export function mountLastHitBadge(): () => void {
  let latest: LastHit | null = null
  let badge: HTMLElement | null = null
  let card: HTMLElement | null = null
  let cardOpen = false

  const renderBadge = (): void => {
    if (badge === null) return
    badge.textContent = latest === null ? '—' : modelLine(latest)
    badge.classList.toggle(BADGE_CLASS + '-fail', latest !== null && !latest.ok)
  }

  const renderCard = (): void => {
    if (card === null) return
    if (latest === null) {
      card.textContent = '暂无命中记录'
      return
    }
    card.replaceChildren()
    const rows: Array<[string, string]> = [
      ['模型', modelLine(latest)],
      ['服务商', latest.supplier],
      ['账号', accountLine(latest)],
      ['请求', latest.requested],
      ['结果', latest.ok ? '成功' : '失败'],
      ['时间', new Date(latest.ts).toLocaleTimeString()],
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
    wrapper.title = '最近一次命中（点击查看账号/积分）'

    const button = document.createElement('button')
    button.type = 'button'
    button.className = BADGE_CLASS + '-btn'
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
    card = null
  }
}
