/**
 * 「最近命中」的会话级数据源。
 *
 * 为什么要有这层：徽章组件可能因宿主重渲染而卸载/重建，但**轮询不该跟着重建**
 * （每个会话一个轮询器，多会话各自独立；组件只订阅结果）。这里做两件事：
 *   - 按 sessionId 维护「最近一次命中」的最新值 + 订阅者集合；
 *   - 每个会话一个定时器，只在有订阅者时开、无订阅者时停。
 *
 * 数据源：核心 `/router/api/last-hit?session=`（轻端点，不打 status）。
 */

const DIGEST_API = '/router/api/last-hit'
/** 刷新间隔：命中信息跟着请求走，轮询取一个不打扰的频率。 */
const POLL_MS = 3000

/** 一次命中的快照（后端 `/last-hit` 的 `hit` 字段，只声明用到的）。 */
export interface LastHit {
  supplier: string
  model: string
  requested: string
  uid: string
  account?: string
  credits?: number
  ok: boolean
}

interface Entry {
  value: LastHit | null
  listeners: Set<(v: LastHit | null) => void>
  timer: number | null
}

const entries = new Map<string, Entry>()

function entryOf(key: string): Entry {
  let e = entries.get(key)
  if (e === undefined) {
    e = { value: null, listeners: new Set(), timer: null }
    entries.set(key, e)
  }
  return e
}

function emit(e: Entry): void {
  for (const fn of e.listeners) fn(e.value)
}

async function refresh(key: string): Promise<void> {
  const e = entryOf(key)
  try {
    const res = await fetch(`${DIGEST_API}?session=${encodeURIComponent(key)}`, { cache: 'no-store' })
    const data = await res.json() as { ok: boolean; hit?: LastHit | null }
    const next = data.ok && data.hit ? data.hit : null
    e.value = next
  } catch {
    // 网络抖动不该清空徽章（保留上次值）
  }
  emit(e)
}

/** 读该会话当前的最近命中（同步快照）。 */
export function getLastHit(sessionId: string): LastHit | null {
  return entryOf(sessionId).value
}

/**
 * 订阅该会话的最近命中。首次订阅即启动轮询，最后一个退订时停。
 * @param sessionId 宿主会话身份
 * @param listener 值变化回调
 * @returns 退订函数
 */
export function subscribeLastHit(sessionId: string, listener: (v: LastHit | null) => void): () => void {
  const e = entryOf(sessionId)
  e.listeners.add(listener)
  if (e.timer === null) {
    void refresh(sessionId)
    e.timer = window.setInterval(() => void refresh(sessionId), POLL_MS)
  }
  return () => {
    e.listeners.delete(listener)
    if (e.listeners.size === 0 && e.timer !== null) {
      window.clearInterval(e.timer)
      e.timer = null
    }
  }
}
