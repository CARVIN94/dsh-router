/**
 * 积分缓存（核心统一持久化）测试 —— node --test 直接跑。
 *
 * 锁定的契约（2026-09-03 修的 bug：codebuddy 重启后面板永久显示 0 积分）：
 *   - 插件报真值 → 落盘，重启后还在
 *   - 插件报 -1（没拉到）→ 顶上次的缓存，不能显示 0
 *   - 插件报 0（真用完了）→ 缓存被冲成 0，不能被当成「未知」保住旧值
 *   - 删链接 → 缓存一起清
 *   - 坏数据（负数/NaN/缺字段）读盘时不炸，当没缓存过
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SupplierConfigStore } from './supplier-config.ts'

/** 每个用例一个独立数据目录（stateFile 推导出 supplier-config.json 的位置）。 */
function tempStore(preload?: unknown): { store: SupplierConfigStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dshr-credits-'))
  const stateFile = join(dir, 'state.json')
  if (preload !== undefined) {
    writeFileSync(join(dir, 'supplier-config.json'), JSON.stringify(preload))
  }
  return { store: new SupplierConfigStore(stateFile), file: join(dir, 'supplier-config.json') }
}

const UNKNOWN = -1

test('报真值 → 落盘，重开还在', () => {
  const { store, file } = tempStore()
  assert.equal(store.putCredits('codebuddy', 'cb-1', 1234.5), 1234.5)
  const raw = JSON.parse(readFileSync(file, 'utf8')) as {
    suppliers: Record<string, { credits: Record<string, number> }>
  }
  assert.equal(raw.suppliers.codebuddy?.credits['cb-1'], 1234.5)
  // 新实例 = 模拟重启
  assert.equal(new SupplierConfigStore(join(file, '..', 'state.json')).getCredits('codebuddy', 'cb-1'), 1234.5)
})

test('报 -1（没拉到）→ 顶上次缓存，不是 0', () => {
  const { store } = tempStore()
  store.putCredits('codebuddy', 'cb-1', 900)
  // 插件重启后内存缓存空 → 报 -1
  assert.equal(store.putCredits('codebuddy', 'cb-1', UNKNOWN), 900)
  assert.equal(store.getCredits('codebuddy', 'cb-1'), 900)
})

test('从来没拿到过 → 就是 -1（读不到就别编 0）', () => {
  const { store } = tempStore()
  assert.equal(store.getCredits('codebuddy', 'cb-1'), UNKNOWN)
  assert.equal(store.putCredits('codebuddy', 'cb-1', UNKNOWN), UNKNOWN)
})

test('报 0（真用完了）→ 缓存被冲成 0', () => {
  const { store } = tempStore()
  store.putCredits('codebuddy', 'cb-1', 500)
  assert.equal(store.putCredits('codebuddy', 'cb-1', 0), 0)
  assert.equal(store.getCredits('codebuddy', 'cb-1'), 0)
})

test('删链接 → 积分缓存一起清', () => {
  const { store } = tempStore()
  store.putCredits('codebuddy', 'cb-1', 700)
  store.clearCredits('codebuddy', 'cb-1')
  assert.equal(store.getCredits('codebuddy', 'cb-1'), UNKNOWN)
})

test('同值重复写入不落盘（status() 是高频调用）', () => {
  const { store, file } = tempStore()
  store.putCredits('codebuddy', 'cb-1', 42)
  const before = readFileSync(file, 'utf8')
  store.putCredits('codebuddy', 'cb-1', 42)
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('坏数据读盘不炸：负数/NaN/非数字当没缓存过', () => {
  const { store } = tempStore({
    suppliers: { codebuddy: { credits: { 'cb-bad': -5, 'cb-nan': null, 'cb-ok': 300 } } },
  })
  assert.equal(store.getCredits('codebuddy', 'cb-bad'), UNKNOWN)
  assert.equal(store.getCredits('codebuddy', 'cb-nan'), UNKNOWN)
  assert.equal(store.getCredits('codebuddy', 'cb-ok'), 300)
})

test('旧配置文件（无 credits 字段）能读，不炸', () => {
  const { store } = tempStore({ suppliers: { codebuddy: { alias: 'cb', poolOrder: ['cb-1'] } } })
  assert.equal(store.getCredits('codebuddy', 'cb-1'), UNKNOWN)
  assert.deepEqual(store.get('codebuddy').poolOrder, ['cb-1'])
})

test('按供应商隔离：同 uid 不同供应商互不干扰', () => {
  const { store } = tempStore()
  store.putCredits('codebuddy', 'key-1', 100)
  store.putCredits('traework', 'key-1', 200)
  assert.equal(store.getCredits('codebuddy', 'key-1'), 100)
  assert.equal(store.getCredits('traework', 'key-1'), 200)
})

test('连接显示别名：set 落盘重开还在；空名删除别名回原始', () => {
  const { store, file } = tempStore()
  assert.equal(store.getAccountName('traework', 't1'), undefined, '没设过就是 undefined')
  store.setAccountName('traework', 't1', '主号')
  assert.equal(store.getAccountName('traework', 't1'), '主号')
  store.setAccountName('traework', 't2', '') // 空名不建别名
  assert.equal(store.getAccountName('traework', 't2'), undefined)
  // 落盘：重开还在
  const reopened = new SupplierConfigStore(join(file, '..', 'state.json'))
  assert.equal(reopened.getAccountName('traework', 't1'), '主号')
  // 空串清空：回到供应商原始昵称
  store.setAccountName('traework', 't1', '   ')
  assert.equal(new SupplierConfigStore(join(file, '..', 'state.json')).getAccountName('traework', 't1'), undefined)
})
