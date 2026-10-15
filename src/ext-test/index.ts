/**
 * 插件自检扩展的 **cordis 行** —— 官方插件页（设置 → 插件 → dsh-router-core）详情页
 * 原生「包含的组件」里的那一行。
 *
 * 壳存在的理由与内置供应商那三层一样：`plugin.ts` 已经把 `name` 用作**面板显示名**
 * （扩展契约的字段，所有扩展都这么写），而 cordis 的插件身份也要一个 `name`，两者抢
 * 同一个名字。所以行 = 这一层壳（cordis 身份 + 登记），实现 = `plugin.ts`。
 *
 * **默认关闭**（patch 里 `disabled: true`）：行关闭时 loader 根本不 import 这个模块，
 * 扩展也就没进 `router.ext` 表 —— 所以「打开才出现这张卡片」是天然的，不需要额外的
 * 状态位。用户在这一行打开后，卡片出现在插件页的「路由组件 → 扩展」组与面板的
 * 「扩展」页。
 *
 * 登记时把扩展开关置为开：本扩展**没有独立的运行期开关**，它的开关就是这一行
 * （宿主管的那个）。不置上的话，用户开了行还要再点一次，两级开关说同一件事。
 */
import type { Context } from '@deepseek-ai/cordis'
import { currentExts, currentExtStore } from '../ext/contract.ts'
import { createTestExt, EXT_TEST_ID } from './plugin.ts'

/** cordis 插件身份（配置树里这一行的技术名；显示名走同目录的 locale）。 */
export const name = 'dsh-router-ext-test'

/** 登记本扩展。幂等：同一个 id 已在表里就直接返回，不顶掉别人的登记。 */
export function apply(ctx: Context): void {
  ctx.inject(['router.ext'], (sctx) => {
    const table = currentExts(sctx)
    if (table === undefined) return
    if (table[EXT_TEST_ID] !== undefined) return
    table[EXT_TEST_ID] = createTestExt()
    currentExtStore(sctx)?.setEnabled(EXT_TEST_ID, true)
    // 核心持有的是**同一个 live 对象**（它 provide 的空表），且 `/ext` 每次请求都
    // 现读这张表 —— 所以往里 append 就够了，不需要（也不存在）广播事件。
  })
}
