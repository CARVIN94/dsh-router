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

test('内置供应商一个都不进这一节（它们是原生「包含的组件」里的行）', () => {
  const out = groupRouterComponents(health([
    { id: 'opencode', name: 'OpenCode', source: 'builtin' },
    { id: 'openrouter', name: 'OpenRouter', source: 'builtin' },
    { id: 'nvidia', name: 'NVIDIA NIM', source: 'builtin' },
  ]), noExt)
  // 重复显示两处 = 用户看到同一个东西两次，且有一处没有开关。
  assert.deepEqual(out.external, [])
  assert.deepEqual(out.ext, [])
})

test('外部供应商插件进「供应商」组（各是独立 bundle，这一页有开关）', () => {
  const out = groupRouterComponents(health([
    { id: 'codebuddy', name: 'CodeBuddy', source: 'external' },
    { id: 'traework', name: 'TRAE SOLO', source: 'external' },
  ]), noExt)
  assert.deepEqual(out.external.map((r) => r.key), ['supplier:codebuddy', 'supplier:traework'])
  assert.equal(out.external.every((r) => r.togglable), true, '供应商在这一页有开关（写 PATCH /suppliers/:id/enabled）')
})

test('缺 source 的供应商不显示，也不被误报成独立插件', () => {
  const out = groupRouterComponents(health([{ id: 'mystery', name: 'Mystery' }]), noExt)
  assert.deepEqual(out.external, [])
})

test('user 目录投放的供应商也不进这一节（它的对应物是行的覆盖或外部插件）', () => {
  const out = groupRouterComponents(health([{ id: 'mine', name: 'My Supplier', source: 'user' }]), noExt)
  assert.deepEqual(out.external, [])
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
  const out = groupRouterComponents(health([{ id: 'loomy', name: 'Loomy', icon: 'data:image/png;base64,x', source: 'external' }]), {
    ok: true,
    enhancers: [{ id: 'rtk', name: 'RTK', detail: '本机未装 rtk' }],
  })
  const supplier = out.external.at(0)
  const extRow = out.ext.at(0)
  assert.ok(supplier !== undefined && extRow !== undefined)
  assert.equal('icon' in supplier, true)
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

test('供应商的开关状态：缺 enabled 按开着读，关掉的仍列出来（关掉后要能再开）', () => {
  const out = groupRouterComponents(health([
    { id: 'codebuddy', name: 'CodeBuddy', source: 'external' },
    { id: 'traework', name: 'TRAE SOLO', source: 'external', enabled: false },
  ]), noExt)
  assert.deepEqual(out.external.map((r) => r.key), ['supplier:codebuddy', 'supplier:traework'],
    '关掉的供应商不能从列表消失 —— 消失了就再没有可点的开关把它开回来')
  assert.deepEqual(out.external.map((r) => r.enabled), [true, false])
})

test('供应商行没有 ready（那是扩展的运行时事实）—— 缺失不得让它变成点不开', () => {
  const out = groupRouterComponents(health([{ id: 'codebuddy', name: 'CodeBuddy', source: 'external' }]), noExt)
  const row = out.external.at(0)
  assert.ok(row !== undefined)
  assert.equal('ready' in row, false, '供应商不报就绪，别塞一个 undefined 键进去')
  assert.equal(row.togglable, true)
})

test('内置扩展不进这一节（它已经是原生「包含的组件」里的一行）', () => {
  const out = groupRouterComponents({ ok: true }, {
    ok: true,
    enhancers: [
      { id: 'test', name: '插件自检', source: 'builtin' },
      { id: 'rtk', name: 'RTK' },
    ],
  })
  // 重复显示两处 = 用户看到同一个东西两次，且有一处没有开关。
  assert.deepEqual(out.ext.map((r) => r.key), ['ext:rtk'])
})
