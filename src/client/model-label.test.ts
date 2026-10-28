/**
 * 模型标签/搜索判据测试。
 *
 * 为什么要有：这两条判据错了都不会报错，只会让人在面板上做错事 ——
 * 标签退化成 key（用户还是看不懂），或搜索只认 key（记不清 key 的人搜不到）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { modelLabel, modelMatches } from './model-label.ts'

test('有可读名：名字在前，key 作为副标签', () => {
  const l = modelLabel({ id: 'qmodel_38max', name: 'Qwen3.8-Max' })
  assert.equal(l.label, 'Qwen3.8-Max')
  assert.equal(l.showId, true)
  assert.match(l.title, /qmodel_38max/)
})

test('没有可读名 / 名字与 key 相同：只显示 key，不重复', () => {
  assert.deepEqual(
    { ...modelLabel({ id: 'gpt-4o' }), title: undefined },
    { label: 'gpt-4o', showId: false, title: undefined },
  )
  assert.equal(modelLabel({ id: 'gpt-4o', name: 'gpt-4o' }).showId, false)
  assert.equal(modelLabel({ id: 'gpt-4o', name: '   ' }).label, 'gpt-4o')
})

test('搜索：可读名与 key 都能命中', () => {
  const m = { id: 'kmodel_latest', name: 'Kimi-K3.1-Pro' }
  assert.equal(modelMatches('kimi', m), true)
  assert.equal(modelMatches('KMODEL', m), true)
  assert.equal(modelMatches('  ', m), true)
  assert.equal(modelMatches('glm', m), false)
})
