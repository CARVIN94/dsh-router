/**
 * 分层提示词扩展（`router.ext` 侧的实现）—— 声明与状态都在这里。
 *
 * 与 `ext-test`（插件自检）同款：**不挂任何监听、不改写任何东西**，
 * 唯一作用是让用户在官方插件页里看到一张卡片、能开关它，并把协作准则
 * 注册成一段 system prompt。
 *
 * 与 `rtk` / `jev` 那类扩展的区别要写清楚：那两家挂 `tools/execute`
 * 改写**工具调用**；本扩展只往 **system prompt** 加一段。名字同族是因为
 * 都在 `router.ext` 这张表里，拦截面不重叠。
 *
 * 复用 `router.ext` 通道只为拿到**发现 + 开关**两件事（见 ext-test 的同款说明），
 * 真正的注入在 `mount.ts`。
 */
import type { RouterExt } from '../ext/contract.ts'
import { PROMPT_CATEGORIES } from './content.ts'

/** 扩展开关表里的注册键。 */
export const EXT_PROMPT_ID = 'prompt'

/**
 * 构造这个扩展器。
 *
 * `getState()` 报**唯一的真实就绪条件**：`ctx.systemPrompt` 不可用时无处注入
 * （section 是唯一的注入通道），此时必须红字报出，而不是静默不生效 ——
 * 判据能变红比"看起来一直开着"有用。
 */
export function createPromptExt(deps: { isSystemPromptReady: () => boolean }): RouterExt {
  return {
    id: EXT_PROMPT_ID,
    name: '分层提示词',
    description:
      `把协作准则拆成 ${PROMPT_CATEGORIES.length} 个可独立开关的分类，注入 system prompt；` +
      '关闭的分类不产出任何 prompt 文本',
    // 随核心分发 -> 插件页的原生「包含的组件」里有它一行，自绘节里不再重复列。
    source: 'builtin' as const,
    getState: () =>
      deps.isSystemPromptReady()
        ? { ready: true }
        : { ready: false, detail: 'ctx.systemPrompt 不可用 —— 本扩展无处注入' },
  }
}
