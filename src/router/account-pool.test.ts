/**
 * 账号池（核心策略）测试 —— 选号/冷却/禁用/错误累计/遍历回退。
 * 用 node --test 跑（Node 原生 TS 剥离，零新依赖）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AccountPool } from './account-pool.ts'
import type { SupplierAccountNow } from '../suppliers/contract.ts'

const accs = (uids: string[]): SupplierAccountNow[] => uids.map((uid) => ({ uid, credits: 0, state: 'ok' }))

test('选号：无冷却时按 poolOrder 优先，未配置的追加在后', () => {
  const p = new AccountPool()
  const list = accs(['a', 'b', 'c'])
  assert.equal(p.pick(list, ['c', 'a'], 'fallback'), 'c')
  assert.equal(p.pick(list, ['b'], 'fallback'), 'b')
  // 未配置顺序的按自然顺序补上
  assert.equal(p.pick(list, [], 'fallback'), 'a')
})

test('选号：冷却中的号跳过，全冷却返回 undefined', () => {
  const p = new AccountPool()
  const list = accs(['a', 'b'])
  p.noteFailure('a', 'rate_limit', '429')
  assert.equal(p.pick(list, [], 'fallback'), 'b')
  p.noteFailure('b', 'rate_limit', '429')
  assert.equal(p.pick(list, [], 'fallback'), undefined)
})

test('选号：round-robin 在健康号间轮转', () => {
  const p = new AccountPool()
  const list = accs(['a', 'b'])
  assert.equal(p.pick(list, [], 'round-robin'), 'a')
  assert.equal(p.pick(list, [], 'round-robin'), 'b')
  assert.equal(p.pick(list, [], 'round-robin'), 'a')
})

test('处置：session_dead 永久禁用（不再被选中）', () => {
  const p = new AccountPool()
  const list = accs(['a'])
  p.noteFailure('a', 'session_dead', '凭证失效')
  assert.equal(p.pick(list, [], 'fallback'), undefined)
  assert.equal(p.decorate(list)[0]?.disabled, true)
})

test('处置：连续错误攒够阈值才冷却（前两次仍可服务）', () => {
  const p = new AccountPool()
  const list = accs(['a'])
  p.noteFailure('a', 'unknown', 'e1')
  assert.equal(p.pick(list, [], 'fallback'), 'a')
  p.noteFailure('a', 'unknown', 'e2')
  assert.equal(p.pick(list, [], 'fallback'), 'a')
  // 第三次触发冷却
  p.noteFailure('a', 'unknown', 'e3')
  assert.equal(p.pick(list, [], 'fallback'), undefined)
})

test('处置：成功清零连续错误，避免之前累积的错误把好号冷却掉', () => {
  const p = new AccountPool()
  const list = accs(['a'])
  p.noteFailure('a', 'unknown', 'e1')
  p.noteFailure('a', 'unknown', 'e2')
  p.noteSuccess('a')
  p.noteFailure('a', 'unknown', 'e3')
  assert.equal(p.pick(list, [], 'fallback'), 'a')
})

test('decorate：把冷却/禁用/错误累计叠加到插件报的「现在状态」上', () => {
  const p = new AccountPool()
  const list: SupplierAccountNow[] = [
    { uid: 'ok', credits: 5, state: 'ok' },
    { uid: 'cool', credits: 5, state: 'ok' },
    { uid: 'dead', credits: 5, state: 'ok' },
  ]
  p.noteFailure('cool', 'rate_limit', '429')
  p.noteFailure('dead', 'session_dead', '凭证失效')
  const out = p.decorate(list)
  const by = new Map(out.map((a) => [a.uid, a]))
  assert.equal(by.get('ok')?.cooling, false)
  assert.equal(by.get('ok')?.disabled, false)
  assert.equal(by.get('cool')?.cooling, true)
  assert.equal(by.get('cool')?.until !== undefined, true)
  assert.equal(by.get('cool')?.reason, '429')
  assert.equal(by.get('dead')?.disabled, true)
  // 插件报的字段要原样透出（不能被 decorate 吃掉）
  assert.equal(by.get('ok')?.credits, 5)
})

test('no_such_model 不惩罚账号：不冷却、不计数', () => {
  const p = new AccountPool()
  const list = accs(['a'])
  // 攒够阈值次也不该冷却——模型不属于本供应商不是账号的错
  for (let i = 0; i < 10; i++) p.noteFailure('a', 'no_such_model', 'unknown model "x"')
  assert.equal(p.pick(list, [], 'fallback'), 'a')
  const out = p.decorate(list)[0]
  assert.equal(out?.cooling, false)
  assert.equal(out?.disabled, false)
  assert.equal(out?.err_count, 0)
})

test('状态表：各 AccountState 的处置符合预期', () => {
  const p = new AccountPool()
  const list = accs(['rate', 'quota', 'dead', 'unavail'])
  p.noteFailure('rate', 'rate_limit', 'x')
  p.noteFailure('quota', 'quota', 'x')
  p.noteFailure('dead', 'session_dead', 'x')
  p.noteFailure('unavail', 'unavailable', 'x')
  // rate_limit/quota 立刻冷却；session_dead 禁用；unavailable 只计错误不冷却
  assert.equal(p.pick(list, [], 'fallback'), 'unavail')
  const by = new Map(p.decorate(list).map((a) => [a.uid, a]))
  assert.equal(by.get('rate')?.cooling, true)
  assert.equal(by.get('quota')?.cooling, true)
  assert.equal(by.get('dead')?.disabled, true)
  assert.equal(by.get('unavail')?.cooling, false)
  assert.equal(by.get('unavail')?.err_count, 1)
  // 攒够阈值后才冷却（与 unknown/transport 同一条路径）
  p.noteFailure('unavail', 'unavailable', 'x')
  p.noteFailure('unavail', 'unavailable', 'x')
  assert.equal(p.pick(list, [], 'fallback'), undefined)
})
