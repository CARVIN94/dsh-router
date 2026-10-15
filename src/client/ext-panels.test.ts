/**
 * 扩展开放详情面板的注册表测试。
 *
 * 为什么要测：注册表错了**不报任何错** —— 详情页只是安静地退回通用只读页，
 * 用户看到的是「面板没出来」，没有任何线索指向「面板没被登记」。所以「登记 →
 * 取用 → 清理」这条链要钉住。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerExtPanel, hasExtPanel, extPanel } from './ext-panels.ts'

const A = (): null => null
const B = (): null => null

test('登记后能按扩展 id 取到同一个组件', () => {
  const dispose = registerExtPanel('t-a', A)
  assert.equal(hasExtPanel('t-a'), true)
  assert.equal(extPanel('t-a'), A, '取到的必须就是登记进去的那个（两处详情页共用同一份）')
  dispose()
})

test('没登记的扩展取不到（调用方据此走通用只读页）', () => {
  assert.equal(hasExtPanel('t-missing'), false)
  assert.equal(extPanel('t-missing'), undefined)
})

test('重复登记同 id：后者顶掉前者（apply 可能跑多次）', () => {
  const first = registerExtPanel('t-b', A)
  const second = registerExtPanel('t-b', B)
  assert.equal(extPanel('t-b'), B)
  first()
  assert.equal(extPanel('t-b'), B, '清理旧的那次不该把新登记的也删掉')
  second()
  assert.equal(extPanel('t-b'), undefined)
})

test('清理只删自己那次登记', () => {
  const first = registerExtPanel('t-c', A)
  const disposeB = registerExtPanel('t-c', B)
  first()
  assert.equal(extPanel('t-c'), B, '旧登记被顶掉后，它的清理不该误删新登记')
  disposeB()
  assert.equal(hasExtPanel('t-c'), false)
})
