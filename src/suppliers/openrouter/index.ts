/**
 * OpenRouter 的 **cordis 行** —— 官方插件页（设置 → 插件 → dsh-router-core）详情页
 * 「包含的组件」里的那一行。
 *
 * 为什么多一层壳：`plugin.ts` 已经把 `name` 用作**面板显示名**（供应商契约的
 * 字段，所有供应商插件都这么写），而 cordis 的插件身份也要一个 `name`，两者
 * 抢同一个名字。所以行 = 这一层壳（cordis 身份 + 登记），实现 = `plugin.ts`。
 *
 * 这一行只做一件事：把供应商工厂登记进核心的 `router.suppliers` 表。**通道和
 * 契约与独立安装的供应商插件完全一样**（core 不区分内外，只看工厂上的
 * `source: 'builtin'` 标签），因此这一行在插件页能拿到宿主管的开关：关掉它 =
 *  loader 不 import 这个模块 = 供应商压根没注册 = 路由不会落到它。
 */
import type { Context } from '@deepseek-ai/cordis'
import { registerSupplierRow, type SupplierEnv, type SupplierFactory } from '../contract.ts'
import factory, { id } from './plugin.ts'

/** cordis 插件身份（配置树里这一行的技术名；显示名走同目录的 locale）。 */
export const name = 'dsh-router-supplier-openrouter'

/** 登记本供应商。幂等：同一个 id 已在表里就直接返回，不顶掉别人的登记。 */
export function apply(ctx: Context): void {
  // `source: 'builtin'` 让 /health 如实报出「内置」，面板的「内置 / 插件」
  // 两组才不会把随核心分发的供应商误标成插件提供的。
  const row: SupplierFactory = Object.assign((env: SupplierEnv) => factory(env), { source: 'builtin' as const })
  registerSupplierRow(ctx, id, row)
}
