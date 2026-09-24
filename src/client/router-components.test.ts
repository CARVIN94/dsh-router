/**
 * 「路由组件」分组判据测试 —— 锁住三条会静默出错的规则。
 *
 * 1. `source` 判据取反：只有 external 是独立安装的 bundle，其余归本地组。
 * 2. 缺 `source` 的供应商不许被静默丢掉，也不许被误报成独立插件。
 * 3. 只有 ext 那组 `togglable` —— 供应商在这一页没有可写的开关。
 *
 * 这三条错了都不会抛异常，只会显示成「少了一组 / 多了个开关」，所以必须有闸门。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { groupRouterComponents, isEmptyComponents, EMPTY_COMPONENTS } from './router-components.ts'
import type { RouterExtResponse, RouterHealthResponse } from '../shared.ts'

const health = (suppliers: NonNullable<RouterHealthResponse['suppliers']>): RouterHealthResponse => ({ ok: true, suppliers })
const noExt: RouterExtResponse = { ok: true, enhancers: [] }

test('三个内置供应商都落在本地组，且只读', () => {
  const out = groupRouterComponents(health([
    { id: 'opencode', name: 'OpenCode', source: 'builtin' },
    { id: 'openrouter', name: 'OpenRouter', source: 'builtin' },
    { id: 'nvidia', name: 'NVIDIA NIM', source: 'builtin' },
  ]), noExt)
  assert.deepEqual(out.local.map((r) => r.key), ['supplier:opencode', 'supplier:openrouter', 'supplier:nvidia'])
  assert.deepEqual(out.external, [])
  assert.equal(out.local.every((r) => r.togglable === false), true)
})

test('外部供应商插件进 external 组（各是独立 bundle，启停在它自己页面）', () => {
  const out = groupRouterComponents(health([
    { id: 'codebuddy', name: 'CodeBuddy', source: 'external' },
    { id: 'traework', name: 'TRAE SOLO', source: 'external' },
  ]), noExt)
  assert.deepEqual(out.local, [])
  assert.deepEqual(out.external.map((r) => r.key), ['supplier:codebuddy', 'supplier:traework'])
  assert.equal(out.external.every((r) => r.togglable === false), true)
})

test('缺 source 的供应商落到本地组，不静默丢、不误报成独立插件', () => {
  const out = groupRouterComponents(health([{ id: 'mystery', name: 'Mystery' }]), noExt)
  assert.deepEqual(out.local.map((r) => r.key), ['supplier:mystery'])
  assert.deepEqual(out.external, [])
})

test('user 目录投放的供应商与内置同组（都不是独立安装的 bundle）', () => {
  const out = groupRouterComponents(health([
    { id: 'opencode', name: 'OpenCode', source: 'builtin' },
    { id: 'mine', name: 'My Supplier', source: 'user' },
  ]), noExt)
  assert.deepEqual(out.local.map((r) => r.key), ['supplier:opencode', 'supplier:mine'])
})

test('扩展插件进 ext 组且唯一可开关；状态按「宁可关着」读', () => {
  const out = groupRouterComponents(health([]), {
    ok: true,
    enhancers: [
      { id: 'rtk', name: 'RTK', enabled: true, ready: true },
      { id: 'jev', name: 'JEV' },
    ],
  })
  assert.equal(out.ext.length, 2)
  assert.equal(out.ext.every((r) => r.togglable), true)
  assert.deepEqual(out.ext.map((r) => r.enabled), [true, false])
  assert.deepEqual(out.ext.map((r) => r.ready), [true, false])
})

test('图标与说明只在该有的时候带上（不塞 undefined 键）', () => {
  const out = groupRouterComponents(health([{ id: 'nvidia', name: 'NVIDIA NIM', icon: 'data:image/png;base64,x', source: 'builtin' }]), {
    ok: true,
    enhancers: [{ id: 'rtk', name: 'RTK', detail: '本机未装 rtk' }],
  })
  const localRow = out.local.at(0)
  const extRow = out.ext.at(0)
  assert.ok(localRow !== undefined && extRow !== undefined)
  assert.equal('icon' in localRow, true)
  assert.equal('detail' in extRow, true)
  assert.equal('icon' in extRow, false)
})

test('两个端点都没有内容时不渲染这一节（不留空标题）', () => {
  assert.equal(isEmptyComponents(EMPTY_COMPONENTS), true)
  assert.equal(isEmptyComponents(groupRouterComponents({ ok: true }, { ok: true })), true)
  assert.equal(isEmptyComponents(groupRouterComponents({ ok: true }, { ok: true, enhancers: [{ id: 'rtk', name: 'RTK' }] })), false)
})

test('端点报错/缺字段时分组仍是空组，不抛（形状恒定）', () => {
  const out = groupRouterComponents({ ok: false, error: 'boom' }, { ok: false, error: 'boom' })
  assert.deepEqual(out, EMPTY_COMPONENTS)
})
