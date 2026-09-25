/**
 * 扩展自带详情面板的注册表 —— 客户端，按扩展 id 索引。
 *
 * 为什么要有这个：`router.ext` 契约里只有 `id / name / description / icon /
 * getState`，**没有「自带详情内容」的口子**。于是扩展详情页（设置 → 路由 → 扩展 →
 * 点开卡片）只能是一张写死的只读页：名字、id、状态、一段说明，扩展自己想放的
 * 东西（要选的模型、要跑的测试、要看的诊断）**没地方放**。
 *
 * 本表就是那个口子：扩展（按扩展 id）登记一个组件，详情页优先渲染它。
 *
 * 两处详情页共用它，两处都以扩展 id 为键，所以**同一个面板注册一次**：
 *   - 设置 → 路由 → 扩展：卡片点开的详情页（`ExtDetail`）
 *   - 设置 → 插件 → dsh-router-core：「包含的组件」里那一行的详情页
 *     （宿主的 `plugins.row.config` 座位，key 是 `<包名>#<行 id>`，与扩展 id 不同，
 *     所以那一处由注册处用一个薄适配器转接，不在这里登记第二份）
 *
 * 这是**客户端**注册表（不是 cordis service）：扩展的服务端对象活在宿主进程里，
 * 面板是浏览器里的组件，两边不在一个地址空间。模块级 Map 够用 —— 面板在单个
 * client bundle 里，模块只有一份实例。
 */
import type { FC } from 'react'

/** 扩展 id → 它的详情面板。 */
const panels = new Map<string, FC>()

/**
 * 给某个扩展登记详情面板。同 id 后登记的**顶掉**先登记的（热重载/重复 apply
 * 时的常见情形）；返回清理函数。
 *
 * @param extId - 扩展 id（`router.ext` 表里的键）
 * @param panel - 详情面板组件。**不收 props**：面板的渲染点只有详情页一处
 *   （`ExtDetail`），没有第二种调用形状。
 */
export function registerExtPanel(extId: string, panel: FC): () => void {
  panels.set(extId, panel)
  return () => {
    if (panels.get(extId) === panel) panels.delete(extId)
  }
}

/** 某个扩展是否自带详情面板。 */
export function hasExtPanel(extId: string): boolean {
  return panels.has(extId)
}

/** 取某个扩展的详情面板；没登记返回 undefined（调用方据此走通用只读页）。 */
export function extPanel(extId: string): FC | undefined {
  return panels.get(extId)
}
