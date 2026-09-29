/**
 * 分层提示词扩展的 **cordis 行** —— 官方插件页（设置 → 插件 → dsh-router-core）详情页
 * 原生「包含的组件」里的那一行。
 *
 * 壳的形状与 `ext-test` 同款（cordis 身份 + 登记，实现 = `plugin.ts`），
 * 但**多一件执行面的事**：挂 system prompt 段落。ext-test 不做拦截、只登记；
 * 本扩展要把准则真注入，所以额外等 `systemPrompt` service 就绪后挂 section。
 *
 * **默认关闭**（patch 里 `disabled: true`）：行关闭时 loader 根本不 import 这个模块，
 * 扩展也就没进 `router.ext` 表 —— 「打开才出现这张卡片」是天然的，不需要额外的
 * 状态位。
 *
 * 登记时把扩展开关置为开：本扩展**没有独立的运行期开关**，它的开关就是这一行
 * （宿主管的那个）。不置上的话，用户开了行还要再点一次，两级开关说同一件事。
 */
import type { Context } from '@deepseek-ai/cordis'
import { currentExts, currentExtStore } from '../ext/contract.ts'
import { createPromptExt, EXT_PROMPT_ID } from './plugin.ts'
import { mountPromptSection, type MountPromptDeps, type SystemPromptFace } from './mount.ts'
import type { PromptExtData } from './render.ts'

/** cordis 插件身份（配置树里这一行的技术名；显示名走同目录的 locale）。 */
export const name = 'dsh-router-ext-prompt'

/** `ctx.systemPrompt` 的最小可见面（见 mount.ts）。 */
function systemPromptOf(sctx: Context): SystemPromptFace | undefined {
  const c = sctx as unknown as {
    get?: (k: string) => unknown
    systemPrompt?: SystemPromptFace
  }
  const sp = (c.get?.('systemPrompt') ?? c.systemPrompt) as SystemPromptFace | undefined
  return sp && typeof sp.section === 'function' ? sp : undefined
}

/** 登记本扩展**并**挂载准则段落。幂等：同一个 id 已在表里就直接返回。 */
export function apply(ctx: Context): void {
  // ① 准则段落：等 systemPrompt 就绪就挂。与加载顺序解耦（谁后到都能补挂）。
  //
  // ⚠️ **不在这里判就绪**：段落挂不上时 `getState()` 会红字报 not ready，
  //    面板上看得见。一个"卡片亮着但准则没进 prompt"的静默失败比报错难查得多。
  ctx.inject(['systemPrompt'], (sctx) => {
    const store = currentExtStore(sctx)
    const deps: MountPromptDeps = {
      getSystemPrompt: () => systemPromptOf(sctx),
      isEnabled: () => store?.isEnabled(EXT_PROMPT_ID) === true,
      readData: () => store?.readData<PromptExtData>(EXT_PROMPT_ID),
    }
    return mountPromptSection(deps)
  })

  // ② 面板登记：等 router.ext 就绪就登记（同 ext-test）。
  ctx.inject(['router.ext'], (sctx) => {
    const table = currentExts(sctx)
    if (table === undefined) return undefined
    if (table[EXT_PROMPT_ID] !== undefined) return undefined
    table[EXT_PROMPT_ID] = createPromptExt({ isSystemPromptReady: () => !!systemPromptOf(sctx) })
    currentExtStore(sctx)?.setEnabled(EXT_PROMPT_ID, true)
    // 核心持有的是**同一个 live 对象**（它 provide 的空表），且 `/ext` 每次请求都
    // 现读这张表 —— 所以往里 append 就够了，不需要（也不存在）广播事件。
  })
}
