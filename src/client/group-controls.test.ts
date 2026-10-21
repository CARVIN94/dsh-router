/**
 * 详情页 controls 分组的判据（`group-controls.ts`）。
 *
 * 关键是**向后兼容不可退**：没用 `group` 字段的扩展（ext-test 等）必须
 * 拿到"一个无组节、顺序不变"的结果 —— 分组是新能力的**叠加**，不是重排。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { groupControlRows } from './group-controls.ts'
import type { ExtControlItem } from '../shared.ts'

function row(id: string, extra: Partial<ExtControlItem> = {}): ExtControlItem {
  return { id, title: id, on: true, custom: false, overridden: false, ...extra }
}

test('★ 全部无组 ⇒ 单一个无组节（旧扩展的面板展示与改动前一致）', () => {
  const groups = groupControlRows([row('a'), row('b')])
  assert.equal(groups.length, 1)
  assert.equal(groups[0]!.label, undefined)
  assert.deepEqual(groups[0]!.items.map((i) => i.id), ['a', 'b'], '无组条目顺序被改了')
})

test('★ 无组节恒排最前，且不产出空的无组节', () => {
  const groups = groupControlRows([row('a'), row('t1', { group: '工具说明' })])
  assert.deepEqual(groups.map((g) => g.label), [undefined, '工具说明'])
  const onlyGrouped = groupControlRows([row('t1', { group: '工具说明' })])
  assert.deepEqual(onlyGrouped.map((g) => g.label), ['工具说明'], '只有分组条目时不该冒出一个空的无组节')
})

test('组的先后 = 首次出现序（不按字母重排）', () => {
  const groups = groupControlRows([
    row('h', { group: '开场身份' }),
    row('w', { group: '工具说明' }),
    row('e', { group: '工具说明' }),
    row('p', { group: '计划模式' }),
  ])
  assert.deepEqual(groups.map((g) => g.label), ['开场身份', '工具说明', '计划模式'])
  assert.deepEqual(groups[1]!.items.map((i) => i.id), ['w', 'e'], '组内顺序被重排 ⇒ 面板序与 prompt 序脱钩')
})

test('同名组跨位置仍归一组（不因中间夹了别的组而拆开）', () => {
  const groups = groupControlRows([
    row('w1', { group: '工具说明' }),
    row('h', { group: '开场身份' }),
    row('w2', { group: '工具说明' }),
  ])
  const tool = groups.find((g) => g.label === '工具说明')!
  assert.deepEqual(tool.items.map((i) => i.id), ['w1', 'w2'])
})

test('空输入 ⇒ 空数组', () => {
  assert.deepEqual(groupControlRows([]), [])
})
