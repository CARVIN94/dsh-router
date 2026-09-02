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

test('处置：未知错误第一次就冷却（坏号不留在池里等下一次撞）', () => {
  const p = new AccountPool()
  const list = accs(['a', 'b'])
  p.noteFailure('a', 'unknown', 'e1')
  // 立刻换到健康的号，而不是继续选 a
  assert.equal(p.pick(list, [], 'fallback'), 'b')
  assert.equal(p.pick(list.filter((x) => x.uid === 'a'), [], 'fallback'), undefined)
})

test('处置：成功清零限流退避等级（好号不背历史惩罚）', () => {
  const p = new AccountPool()
  const list = accs(['a'])
  p.noteFailure('a', 'rate_limit', '429')
  p.noteFailure('a', 'rate_limit', '429')
  assert.equal(p.decorate(list)[0]?.err_count, 2)
  p.noteSuccess('a')
  assert.equal(p.decorate(list)[0]?.err_count, 0, '成功后退避等级归零')
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
  // rate_limit 退避冷却；quota 长冷却；session_dead 禁用；
  // unavailable 瞬时短冷却（每次都冷，不再攒次数）
  const by = new Map(p.decorate(list).map((a) => [a.uid, a]))
  assert.equal(by.get('rate')?.cooling, true)
  assert.equal(by.get('quota')?.cooling, true)
  assert.equal(by.get('dead')?.disabled, true)
  assert.equal(by.get('unavail')?.cooling, true, '瞬时错误第一次就冷却')
  assert.equal(p.pick(list, [], 'fallback'), undefined, '四个号都不可服务')
})

/**
 * 为什么要有这一组：对齐 9router 的错误处置策略。
 *
 * 差异一（冷却起点）：未知/瞬时错误，9router **每次**都给 30s 冷却
 * （checkFallbackError 默认返回 shouldFallback + TRANSIENT_COOLDOWN_MS），
 * 坏号立刻冻结、错误不会在同一账号上累积；dsh-router 原为「计一次错误，
 * 攒够 3 次才冷却」，前两次**完全不冷却** —— 坏号仍在池里，下一个请求
 * 照样被选中，直到攒够 3 次。整池被拖垮正是这条路径。
 *
 * 差异二（限流退避）：429 限流，9router 用指数退避 2s→4s→8s…（上限 5min），
 * 反复被限流时越退越久；dsh-router 原为固定 1 分钟 —— 对瞬时限流过重，
 * 对持续限流又不够。
 */
test('处置：未知/瞬时错误第一次就短冷却（不再攒够 3 次，对齐 9router 瞬时冷却）', () => {
  const p = new AccountPool()
  const list = accs(['a'])
  p.noteFailure('a', 'unknown', 'e1')
  assert.equal(p.pick(list, [], 'fallback'), undefined, '第一次失败就该冻结，不该留在池里')
  const d = p.decorate(list)[0]
  assert.equal(d?.cooling, true)
  assert.equal(d?.err_count, 0, '不再靠累计错误触发，计数归零')
})

test('处置：瞬时冷却是短冷却（30s 量级），不是攒够后的 5 分钟', () => {
  const p = new AccountPool()
  const list = accs(['a'])
  p.noteFailure('a', 'transport', 'boom')
  const d = p.decorate(list)[0]
  const until = d?.until === undefined ? 0 : new Date(d.until).getTime()
  const span = until - Date.now()
  assert.ok(span > 0 && span <= 60_000, `瞬时冷却应在 60s 内，实际 ${span}ms`)
})

test('处置：限流越频繁冷却越久（指数退避，对齐 9router backoff）', () => {
  const p = new AccountPool()
  const list = accs(['a'])
  const spanOf = (): number => {
    const d = p.decorate(list)[0]
    const until = d?.until === undefined ? 0 : new Date(d.until).getTime()
    return until - Date.now()
  }
  p.noteFailure('a', 'rate_limit', '429-1')
  const first = spanOf()
  assert.ok(first > 0 && first <= 60_000, `首次限流应短冷（≤60s），实际 ${first}ms`)
  assert.equal(p.decorate(list)[0]?.err_count, 1, '退避等级 1')

  // 连着再限流：等级递进 → 冷却变长。这里**不能**用 cooldown() 解冻——
  // 那个接口会清零退避等级（面板「手动冷却」的语义），会把递进抹平。
  p.noteFailure('a', 'rate_limit', '429-2')
  const second = spanOf()
  assert.equal(p.decorate(list)[0]?.err_count, 2, '退避等级 2')
  assert.ok(second > first, `第二次限流冷却应更久：${second}ms 应 > ${first}ms`)
  p.noteFailure('a', 'rate_limit', '429-3')
  assert.ok(spanOf() > second, '第三次更久')
})

test('处置：成功后限流退避等级归零（好号不再背历史惩罚）', () => {
  const p = new AccountPool()
  const list = accs(['a'])
  p.noteFailure('a', 'rate_limit', '429')
  p.noteSuccess('a')
  const first = p.decorate(list)[0]?.until
  p.cooldown('a', -1, 'reset')
  p.noteFailure('a', 'rate_limit', '429')
  const after = p.decorate(list)[0]
  const until = after?.until === undefined ? 0 : new Date(after.until).getTime()
  void first
  assert.ok(until - Date.now() <= 60_000, '成功清零后应从最短退避重新开始')
})
