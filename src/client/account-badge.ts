/**
 * 账号行的状态徽章判据 —— 面板必须和路由说同一句话。
 *
 * 核心选号会跳过插件报 `quota`（额度/积分用完）和 `session_dead`（凭证失效）的号
 * （见 `account-pool.servableByReport`）。如果面板把这些号显示成「健康」，用户
 * 就会看到「界面说没问题、可是请求永远不走它」——查不出原因，只能去删链接重登，
 * 而真正的解法是充值。
 *
 * 判据顺序（先冷却后状态）的理由：冷却带 `until` 和 `reason`，比静态状态更具体，
 * 用户更需要先看到「什么时候会好」。
 */
import type { RouterAccount } from '../shared.ts'

export interface AccountBadge {
  text: string
  cls: string
}

export function statusBadge(account: RouterAccount): AccountBadge {
  if (account.cooling) return { text: '冷却中', cls: 'dshr-badge-warn' }
  if (account.state === 'quota') return { text: '额度用完', cls: 'dshr-badge-warn' }
  if (account.state === 'session_dead') return { text: '凭证失效', cls: 'dshr-badge-warn' }
  return { text: '健康', cls: 'dshr-badge-ok' }
}
