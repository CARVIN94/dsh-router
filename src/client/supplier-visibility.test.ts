/**
 * 面板供应商可见性判据测试 —— 锁住三件事：
 *   1. 关掉的卡片不出现（与扩展页同一形状）
 *   2. 缺 `enabled` 按开着读（老核心没这个字段，不能让它们集体消失）
 *   3. 空状态分「没装」与「全关掉」两种（装了却说暂无 = 说假话）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { supplierVisibility, type SupplierSummary } from './supplier-visibility.ts'

const s = (id: string, source: SupplierSummary['source'], enabled?: boolean): SupplierSummary => ({
  id,
  name: id,
  ...(source === undefined ? {} : { source }),
  ...(enabled === undefined ? {} : { enabled }),
})

test('关掉的供应商不出现在面板（卡片不出现）', () => {
  const v = supplierVisibility([
    s('codebuddy', 'external', true),
    s('traework', 'external', false),
    s('opencode', 'builtin', false),
  ])
  assert.deepEqual(v.external.map((x) => x.id), ['codebuddy'])
  assert.deepEqual(v.builtin, [])
  assert.equal(v.hidden, 2)
})

test('缺 enabled 按开着读 —— 老核心没有这个字段，不能让供应商集体消失', () => {
  const v = supplierVisibility([s('codebuddy', 'external'), s('opencode', 'builtin')])
  assert.deepEqual(v.external.map((x) => x.id), ['codebuddy'])
  assert.deepEqual(v.builtin.map((x) => x.id), ['opencode'])
  assert.equal(v.hidden, 0)
  assert.equal(v.empty, undefined, '有卡片可列时不该有空状态')
})

test('按来源分组不串（内置 / 插件两组互不吞）', () => {
  const v = supplierVisibility([
    s('opencode', 'builtin', true),
    s('codebuddy', 'external', true),
    s('nvidia', 'builtin', true),
  ])
  assert.deepEqual(v.builtin.map((x) => x.id), ['opencode', 'nvidia'])
  assert.deepEqual(v.external.map((x) => x.id), ['codebuddy'])
})

test('全关掉 ≠ 暂无：空状态必须说清去哪开回来', () => {
  const v = supplierVisibility([s('codebuddy', 'external', false)])
  assert.equal(v.empty?.reason, 'disabled')
  assert.match(v.empty?.desc ?? '', /设置 → 插件 → dsh-router-core/,
    '空状态要把用户指到开关所在处，否则用户以为插件坏了')
})

test('一个都没装才是「暂无供应商」', () => {
  assert.equal(supplierVisibility([]).empty?.reason, 'none')
  assert.equal(supplierVisibility([s('x', 'external', false), s('y', 'builtin', false)]).empty?.reason, 'disabled')
})
