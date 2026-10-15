/**
 * 账号徽章闸门 —— 面板不许和路由说反话。
 *
 * 核心 `pick()` 会跳过插件报 `quota`/`session_dead` 的号。面板若把它们显示成
 * 「健康」，用户看到的就是「一切正常但请求永远不走这个号」——没有线索可查。
 * 这类不一致不会抛异常，只会让人误判，所以要有闸门。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { statusBadge } from './account-badge.ts'
import type { RouterAccount } from '../shared.ts'

const acc = (over: Partial<RouterAccount> = {}): RouterAccount => ({
  uid: 'u1', credits: 100, cooling: false, ...over,
})

test('额度用完的号显示「额度用完」，不是「健康」', () => {
  const b = statusBadge(acc({ credits: 0, state: 'quota' }))
  assert.equal(b.text, '额度用完')
  assert.notEqual(b.cls, 'dshr-badge-ok', '不能用健康色')
})

test('凭证失效显示「凭证失效」', () => {
  assert.equal(statusBadge(acc({ state: 'session_dead' })).text, '凭证失效')
})

test('冷却优先于状态：冷却带 until/reason，用户更需要先看到', () => {
  const b = statusBadge(acc({ state: 'quota', cooling: true, reason: 'quota: exceeded' }))
  assert.equal(b.text, '冷却中')
})

test('正常号仍显示「健康」（不误伤 openrouter/nvidia 那种 credits: 0 的号）', () => {
  // 这两家没有积分概念，报的是 credits: 0 + state: 'ok' —— 不能因为 0 就报警。
  assert.equal(statusBadge(acc({ credits: 0, state: 'ok' })).text, '健康')
  assert.equal(statusBadge(acc({ credits: 0 })).text, '健康', 'state 缺省（老插件）也不报警')
  assert.equal(statusBadge(acc({ credits: 500, state: 'ok' })).text, '健康')
})
