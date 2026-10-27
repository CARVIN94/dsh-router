/**
 * 扩展详情页 controls 的**分组**纯逻辑（客户端，可单测）。
 *
 * 分组是**归属信息**，不是样式：一条扩展同时管两类东西时（分层提示词 =
 * 准则分类 + 宿主系统提示词段落），平铺成一长列无从分辨哪条是谁的。
 *
 * 两条规则：
 *   ① **无组节恒排最前** —— 没用 `group` 字段的扩展拿到的
 *      分组结果就是原来的平铺列表（一个无名节），面板行为一个像素不变；
 *   ② 组的先后 = 组名在 `rows` 里的**首次出现序**，组内保持原顺序 ——
 *      不按字母重排：`rows` 的顺序来自服务端（段落按 prompt 序），重排
 *      就会把"面板顺序 ≈ 模型看到的顺序"这条对应关系打断。
 */
import type { ExtControlItem } from '../shared.ts'

/** 一个分组：`label === undefined` 表示"无组节"（平铺条目）。 */
export interface ControlGroup {
  label?: string
  items: ExtControlItem[]
}

/** 按 `group` 分组；空输入返回空数组（不产出空的无组节）。 */
export function groupControlRows(rows: readonly ExtControlItem[]): ControlGroup[] {
  const plain: ExtControlItem[] = []
  const groups: ControlGroup[] = []
  const byLabel = new Map<string, ExtControlItem[]>()
  for (const c of rows) {
    if (c.group === undefined) {
      plain.push(c)
      continue
    }
    let items = byLabel.get(c.group)
    if (!items) {
      items = []
      byLabel.set(c.group, items)
      groups.push({ label: c.group, items })
    }
    items.push(c)
  }
  const out: ControlGroup[] = []
  if (plain.length > 0) out.push({ items: plain })
  return [...out, ...groups]
}
