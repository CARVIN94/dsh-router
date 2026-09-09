/**
 * 账号池（核心策略）测试 —— 选号/冷却/禁用/遍历回退。
 *
 * 关键语义（v2）：
 *   - 冷却单元 = (supplierId, modelId, uid)。某连接在模型 A 上失败，只冷
 *     (A, 该连接)，该连接调模型 B 不受影响。
 *   - 禁用(session_dead) = 连接级(uid)：该号所有模型都不可用。
 *   - no_such_model 不惩罚账号（模型不属于本供应商不是号的错）。
 * 用 node --test 跑（Node 原生 TS 剥离，零新依赖）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AccountPool } from './account-pool.ts'
import type { SupplierAccountNow } from '../suppliers/contract.ts'

const accs = (uids: string[]): SupplierAccountNow[] => uids.map((uid) => ({ uid, credits: 0, state: 'ok' }))

/** 构造带供应商的池，与 loader 一致（真实使用会传 supplierId）。 */
const pool = (sid = 'supA'): AccountPool => new AccountPool(sid)

test('选号：无冷却时按 poolOrder 优先，未配置的追加在后（带 model）', () => {
  const p = pool()
  const list = accs(['a', 'b', 'c'])
  assert.equal(p.pick(list, ['c', 'a'], 'fallback', 'm1'), 'c')
  assert.equal(p.pick(list, ['b'], 'fallback', 'm1'), 'b')
  // 未配置顺序的按自然顺序补上
  assert.equal(p.pick(list, [], 'fallback', 'm1'), 'a')
})

test('选号：某模型冷却中的号对该模型跳过，全冷却返回 undefined', () => {
  const p = pool()
  const list = accs(['a', 'b'])
  p.noteFailure('a', 'm1', 'rate_limit', '429')
  assert.equal(p.pick(list, [], 'fallback', 'm1'), 'b')
  p.noteFailure('b', 'm1', 'rate_limit', '429')
  assert.equal(p.pick(list, [], 'fallback', 'm1'), undefined)
})

test('round-robin 是块轮询：块内粘住不换号（带 model）', () => {
  const p = pool()
  const list = accs(['a', 'b'])
  // 块没满 → 一直粘在 a（这就是缓存命中的来源）
  assert.equal(p.pick(list, [], 'round-robin', 'm1'), 'a')
  assert.equal(p.pick(list, [], 'round-robin', 'm1'), 'a')
  assert.equal(p.pick(list, [], 'round-robin', 'm1'), 'a')
})

// ============ 块轮询（docs/pool-sticky-block.md） ============

/** 连打 n 次成功请求，全部命中缓存。 */
const serveHits = (p: AccountPool, uid: string, n: number, model = 'm1'): void => {
  for (let i = 0; i < n; i++) p.noteCache(uid, model, 1000)
}
/** 连打 n 次成功请求，全部未命中（cold miss）。 */
const serveMiss = (p: AccountPool, uid: string, n: number, model = 'm1'): void => {
  for (let i = 0; i < n; i++) p.noteCache(uid, model, 0)
}

test('【块】OR：计数<N(最短驻留)且没达标 → 留守，哪怕缓存已热', () => {
  const p = pool()
  const list = accs(['a', 'b'])
  assert.equal(p.pick(list, [], 'round-robin', 'm1'), 'a')
  // 计数 15 < N(16)，命中率 100% >= M → 留守（最短驻留没走完，不因热度提前跳）
  serveHits(p, 'a', 15)
  assert.equal(p.pick(list, [], 'round-robin', 'm1'), 'a')
})

test('【块】OR：计数到 N 且命中率达标 → 换号（下一号也冷启动，让位均衡）', () => {
  const p = pool()
  const list = accs(['a', 'b'])
  assert.equal(p.pick(list, [], 'round-robin', 'm1'), 'a')
  // 计数 16 >= N 且命中率 100% >= 85% → 换号
  serveHits(p, 'a', 16)
  assert.equal(p.pick(list, [], 'round-robin', 'm1'), 'b')
})

test('【块】OR：命中率没达标 → 计数到 N 仍留守（继续热，不急换）', () => {
  const p = pool()
  const list = accs(['a', 'b'])
  assert.equal(p.pick(list, [], 'round-robin', 'm1'), 'a')
  // 计数 20 全 miss → 命中率 0% < 85% → 留守（OR 语义：ratio<M 时留守）
  serveMiss(p, 'a', 20)
  assert.equal(p.pick(list, [], 'round-robin', 'm1'), 'a')
})

test('【块】N_max 兜底：命中率一直不达标 → 到 N_max(48) 必换', () => {
  const p = pool()
  const list = accs(['a', 'b'])
  assert.equal(p.pick(list, [], 'round-robin', 'm1'), 'a')
  // 一直 miss，命中率 0% 永不达标 → 不靠 N 换，靠 N_max 兜底
  serveMiss(p, 'a', 48)
  // 47 次后仍在 a；第 48 次触发 noteCache 的降权，随后 pick 跳过 a
  assert.equal(p.pick(list, [], 'round-robin', 'm1'), 'b')
})

test('【块】驻留满 N_max 仍不达标 → 该号降权，后续轮转跳过', () => {
  const p = pool()
  const list = accs(['a', 'b', 'c'])
  assert.equal(p.pick(list, [], 'round-robin', 'm1'), 'a')
  serveMiss(p, 'a', 48) // a 判定缓存无效（降权）
  assert.equal(p.pick(list, [], 'round-robin', 'm1'), 'b') // 跳过 a
  // b 正常服务并达标 → 切走后轮转也应跳过 a
  serveHits(p, 'b', 16)
  assert.equal(p.pick(list, [], 'round-robin', 'm1'), 'c')
})

test('【块】降权不是永久判决：全池都降权时退回健康池兜底', () => {
  const p = pool()
  const list = accs(['a', 'b'])
  assert.equal(p.pick(list, [], 'round-robin', 'm1'), 'a')
  serveMiss(p, 'a', 48)
  assert.equal(p.pick(list, [], 'round-robin', 'm1'), 'b')
  serveMiss(p, 'b', 48)
  // 两个都降权 → 不能返回 undefined（那等于服务挂了），退回健康池
  const uid = p.pick(list, [], 'round-robin', 'm1')
  assert.equal(uid !== undefined, true)
})

test('【块】故障切走作废块：dropBlock 后重新选号', () => {
  const p = pool()
  const list = accs(['a', 'b'])
  assert.equal(p.pick(list, [], 'round-robin', 'm1'), 'a')
  serveHits(p, 'a', 3) // 块才 3 次，本来会留守
  p.dropBlock('m1')
  // 块作废 → 从 a 之后前进，选到 b（而不是带着旧计数继续粘 a）
  assert.equal(p.pick(list, [], 'round-robin', 'm1'), 'b')
})

test('【块】失败请求不入块统计（失败没产生缓存，计入会污染命中率）', () => {
  const p = pool()
  const list = accs(['a', 'b'])
  assert.equal(p.pick(list, [], 'round-robin', 'm1'), 'a')
  // 16 次全命中 → 达标切走（失败不算，否则比例被稀释永不达标）
  serveHits(p, 'a', 16)
  assert.equal(p.pick(list, [], 'round-robin', 'm1'), 'b')
})

test('【块】块状态按模型隔离：m1 的驻留不影响 m2', () => {
  const p = pool()
  const list = accs(['a', 'b'])
  assert.equal(p.pick(list, [], 'round-robin', 'm1'), 'a')
  serveHits(p, 'a', 16) // m1 上 a 已达标
  assert.equal(p.pick(list, [], 'round-robin', 'm1'), 'b')
  // m2 是独立的块 → 从头开始，选 a
  assert.equal(p.pick(list, [], 'round-robin', 'm2'), 'a')
})

test('【块】多号间长期均衡：块大小有界 → 请求数均分', () => {
  const p = pool()
  const list = accs(['a', 'b', 'c'])
  const count: Record<string, number> = { a: 0, b: 0, c: 0 }
  // 每个块 16 次（全命中达标），跑 12 个块
  for (let block = 0; block < 12; block++) {
    const uid = p.pick(list, [], 'round-robin', 'm1')!
    count[uid]! += 1
    serveHits(p, uid, 16)
  }
  // 12 块 / 3 号 → 每号 4 块
  assert.equal(count['a'], 4)
  assert.equal(count['b'], 4)
  assert.equal(count['c'], 4)
})

// ============ 核心新语义：冷却按 (模型, 连接) 分号 ============

test('【颗粒度】连接在模型 A 失败，只冷 (A, 该连接)，不影响它调模型 B', () => {
  const p = pool()
  const list = accs(['a', 'b'])
  // a 在 m1 上限流失败 → 只冷 (m1, a)
  p.noteFailure('a', 'm1', 'rate_limit', '429')
  // m1 上 a 被冷 → 选 b
  assert.equal(p.pick(list, [], 'fallback', 'm1'), 'b')
  // m2 上 a 完全健康 → 应选 a（不被 m1 的失败殃及）
  assert.equal(p.pick(list, [], 'fallback', 'm2'), 'a')
  // m1 只剩 a 一个号 → undefined（a 在 m1 上被冷）
  assert.equal(p.pick(list.filter((x) => x.uid === 'a'), [], 'fallback', 'm1'), undefined)
})

test('【颗粒度】多号里只有一冷在 m1，其它号在 m2 仍可用', () => {
  const p = pool()
  const list = accs(['a', 'b', 'c'])
  p.noteFailure('a', 'm1', 'transport', 'boom')
  p.noteFailure('b', 'm1', 'transport', 'boom')
  // m1：a、b 被冷 → 只剩 c
  assert.equal(p.pick(list, [], 'fallback', 'm1'), 'c')
  // m2：a、b 健康 → 应选 a（poolOrder 顺序第一个健康）
  assert.equal(p.pick(list, [], 'fallback', 'm2'), 'a')
})

test('【颗粒度】同一连接对不同模型的退避独立累加/清零', () => {
  const p = pool()
  const list = accs(['a'])
  p.noteFailure('a', 'm1', 'rate_limit', '429')
  p.noteFailure('a', 'm1', 'rate_limit', '429')
  // m1 退避等级 2
  assert.equal(p.decorate(list, 'm1')[0]?.err_count, 2)
  // m2 没被 m1 影响 → 等级 0
  assert.equal(p.decorate(list, 'm2')[0]?.err_count, 0)
  // m1 成功 → 清零 m1 的退避
  p.noteSuccess('a', 'm1')
  assert.equal(p.decorate(list, 'm1')[0]?.err_count, 0)
})

// ============ 连接级禁用(跨模型) ============

test('【颗粒度】session_dead 是连接级禁用：跨该号所有模型', () => {
  const p = pool()
  const list = accs(['a'])
  p.noteFailure('a', 'm1', 'session_dead', '凭证失效')
  // 该号在 m1、m2 上都不可用（登录态问题，不是模型问题）
  assert.equal(p.pick(list, [], 'fallback', 'm1'), undefined)
  assert.equal(p.pick(list, [], 'fallback', 'm2'), undefined)
  assert.equal(p.decorate(list)[0]?.disabled, true)
})

test('处置：未知错误第一次就冷却（坏号不留在池里等下一次撞）', () => {
  const p = pool()
  const list = accs(['a', 'b'])
  p.noteFailure('a', 'm1', 'unknown', 'e1')
  assert.equal(p.pick(list, [], 'fallback', 'm1'), 'b')
  assert.equal(p.pick(list.filter((x) => x.uid === 'a'), [], 'fallback', 'm1'), undefined)
})

test('decorate：把冷却/禁用叠加到插件报的「现在状态」上（聚合展示）', () => {
  const p = pool()
  const list: SupplierAccountNow[] = [
    { uid: 'ok', credits: 5, state: 'ok' },
    { uid: 'cool', credits: 5, state: 'ok' },
    { uid: 'dead', credits: 5, state: 'ok' },
  ]
  p.noteFailure('cool', 'm1', 'rate_limit', '429')
  p.noteFailure('dead', 'm1', 'session_dead', '凭证失效')
  const out = p.decorate(list)
  const by = new Map(out.map((a) => [a.uid, a]))
  assert.equal(by.get('ok')?.cooling, false)
  assert.equal(by.get('ok')?.disabled, false)
  assert.equal(by.get('cool')?.cooling, true)
  assert.equal(by.get('cool')?.until !== undefined, true)
  assert.equal(by.get('dead')?.disabled, true)
  // 插件报的字段要原样透出（不能被 decorate 吃掉）
  assert.equal(by.get('ok')?.credits, 5)
})

test('no_such_model 不惩罚账号：不冷却、不计数', () => {
  const p = pool()
  const list = accs(['a'])
  // 攒够阈值次也不该冷却——模型不属于本供应商不是账号的错
  for (let i = 0; i < 10; i++) p.noteFailure('a', 'm1', 'no_such_model', 'unknown model "x"')
  assert.equal(p.pick(list, [], 'fallback', 'm1'), 'a')
  const out = p.decorate(list, 'm1')[0]
  assert.equal(out?.cooling, false)
  assert.equal(out?.disabled, false)
  assert.equal(out?.err_count, 0)
})

test('状态表：各 AccountState 的处置符合预期', () => {
  const p = pool()
  const list = accs(['rate', 'quota', 'dead', 'unavail'])
  p.noteFailure('rate', 'm1', 'rate_limit', 'x')
  p.noteFailure('quota', 'm1', 'quota', 'x')
  p.noteFailure('dead', 'm1', 'session_dead', 'x')
  p.noteFailure('unavail', 'm1', 'unavailable', 'x')
  const by = new Map(p.decorate(list).map((a) => [a.uid, a]))
  assert.equal(by.get('rate')?.cooling, true)
  assert.equal(by.get('quota')?.cooling, true)
  assert.equal(by.get('dead')?.disabled, true)
  assert.equal(by.get('unavail')?.cooling, true, '瞬时错误第一次就冷却')
  assert.equal(p.pick(list, [], 'fallback', 'm1'), undefined, '四个号都不可服务')
})

/**
 * 处置对齐 9router：未知/瞬时错误**每次**短冷却（不再攒够 3 次）。
 */
test('处置：未知/瞬时错误第一次就短冷却（对齐 9router 瞬时冷却）', () => {
  const p = pool()
  const list = accs(['a'])
  p.noteFailure('a', 'm1', 'unknown', 'e1')
  assert.equal(p.pick(list, [], 'fallback', 'm1'), undefined, '第一次失败就该冻结，不该留在池里')
  const d = p.decorate(list, 'm1')[0]
  assert.equal(d?.cooling, true)
  assert.equal(d?.err_count, 0)
})

test('处置：瞬时冷却是短冷却（30s 量级），不是攒够后的 5 分钟', () => {
  const p = pool()
  const list = accs(['a'])
  p.noteFailure('a', 'm1', 'transport', 'boom')
  const d = p.decorate(list, 'm1')[0]
  const until = d?.until === undefined ? 0 : new Date(d.until).getTime()
  const span = until - Date.now()
  assert.ok(span > 0 && span <= 60_000, `瞬时冷却应在 60s 内，实际 ${span}ms`)
})

test('处置：限流越频繁冷却越久（指数退避，对齐 9router backoff）', () => {
  const p = pool()
  const list = accs(['a'])
  const spanOf = (m: string): number => {
    const d = p.decorate(list, m)[0]
    const until = d?.until === undefined ? 0 : new Date(d.until).getTime()
    return until - Date.now()
  }
  p.noteFailure('a', 'm1', 'rate_limit', '429-1')
  const first = spanOf('m1')
  assert.ok(first > 0 && first <= 60_000, `首次限流应短冷（≤60s），实际 ${first}ms`)
  assert.equal(p.decorate(list, 'm1')[0]?.err_count, 1, '退避等级 1')

  // 连着再限流：等级递进 → 冷却变长。
  p.noteFailure('a', 'm1', 'rate_limit', '429-2')
  const second = spanOf('m1')
  assert.equal(p.decorate(list, 'm1')[0]?.err_count, 2, '退避等级 2')
  assert.ok(second > first, `第二次限流冷却应更久：${second}ms 应 > ${first}ms`)
  p.noteFailure('a', 'm1', 'rate_limit', '429-3')
  assert.ok(spanOf('m1') > second, '第三次更久')
})

test('处置：成功后限流退避等级归零（好号不再背历史惩罚）', () => {
  const p = pool()
  const list = accs(['a'])
  p.noteFailure('a', 'm1', 'rate_limit', '429')
  p.noteSuccess('a', 'm1')
  p.cooldown('a', -1, 'reset')
  p.noteFailure('a', 'm1', 'rate_limit', '429')
  const after = p.decorate(list, 'm1')[0]
  const until = after?.until === undefined ? 0 : new Date(after.until).getTime()
  assert.ok(until - Date.now() <= 60_000, '成功清零后应从最短退避重新开始')
})

// ============ 跨供应商同名模型不串（键带 supplierId） ============

test('【隔离】不同供应商的同名模型，各自独立冷却', () => {
  const pa = pool('supA') // 供应商 A
  const pb = pool('supB') // 供应商 B
  const list = accs(['acc']) // 同一 uid 名出现在两个供应商池里（真实是不同账号）
  // A 供应商的 acc 在 deepseek-v4-flash 上限流
  pa.noteFailure('acc', 'deepseek-v4-flash', 'rate_limit', '429')
  assert.equal(pa.pick(list, [], 'fallback', 'deepseek-v4-flash'), undefined, 'A 池该模型已冷')
  // B 供应商同名模型不受影响
  assert.equal(pb.pick(list, [], 'fallback', 'deepseek-v4-flash'), 'acc', 'B 池同名模型照常可用')
})
