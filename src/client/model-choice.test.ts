/**
 * 「只列可用模型」这条判据的测试。
 *
 * 为什么要有：错了不会抛异常、不会白屏，只是下拉里多了几个用户明明关掉的模型 ——
 * 挑中一个去测，测通了也不代表配置是对的，而用户看不出自己挑错了。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { modelChoice } from './model-choice.ts'

test('只列用户没停用的模型（端点给的是全部模型）', () => {
  const c = modelChoice([
    { id: 'a', enabled: true },
    { id: 'b', enabled: false },
    { id: 'c', enabled: true },
    { id: 'd', enabled: false },
  ])
  assert.deepEqual(c.ids, ['a', 'c'])
  assert.equal(c.empty, undefined)
})

test('保持端点给的顺序（端点已按优先级排好，重排会毁掉它）', () => {
  const c = modelChoice([{ id: 'z', enabled: true }, { id: 'a', enabled: true }])
  assert.deepEqual(c.ids, ['z', 'a'])
})

test('缺 enabled 按「未停用」读 —— 不凭空把模型藏起来', () => {
  const c = modelChoice([{ id: 'a' }, { id: 'b', enabled: false }])
  assert.deepEqual(c.ids, ['a'])
})

test('一个模型都没有 vs 全被停用：两种空得指去不同的地方', () => {
  assert.equal(modelChoice([]).empty, 'none', '没模型 → 该去拉取')
  assert.equal(modelChoice([{ id: 'a', enabled: false }]).empty, 'all-disabled', '有模型但全关 → 该去开启')
})

test('全停用时 ids 为空，不会把停用的模型漏进下拉', () => {
  const c = modelChoice([{ id: 'a', enabled: false }, { id: 'b', enabled: false }])
  assert.deepEqual(c.ids, [])
  assert.equal(c.empty, 'all-disabled')
})
