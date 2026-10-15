/**
 * 分层提示词扩展的 **cordis 行** —— 官方插件页（设置 → 插件 → dsh-router-core）详情页
 * 原生「包含的组件」里的那一行。
 *
 * 壳的形状与 `ext-test` 同款（cordis 身份 + 登记，实现 = `plugin.ts`），
 * 但**多一件执行面的事**：挂 system prompt 段落。ext-test 不做拦截、只登记；
 * 本扩展要把准则真注入，所以额外等 `systemPrompt` service 就绪后挂 section。
 *
 * **默认开启**（patch 里不带 `disabled`，与三行内置供应商一致）：
 * 协作准则是每次协作都要的基础设施，不是可选增强。与 `ext-test` 的
 * `disabled: true` **刻意不同** —— 自检是「想跑才跑」的工具，准则不是；
 * 让准则默认缺席，会变成「用户不知道它存在 ⇒ 协作按另一套规则执行」。
 *
 * 登记时把扩展开关置为开：本扩展**没有独立的运行期开关**，它的开关就是这一行
 * （宿主管的那个）。不置上的话，用户开了行还要再点一次，两级开关说同一件事。
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  currentExts,
  currentExtStore,
  type ExtStoreService,
  type RouterExtService,
} from '../ext/contract.ts'
import { createPromptExt, EXT_PROMPT_ID } from './plugin.ts'
import { mountPromptSection, type SystemPromptFace } from './mount.ts'
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

/**
 * 声明本扩展依赖的 service。
 *
 * ⚠️⚠️ **必须导出这个数组，且 `apply` 里直接用 `ctx.systemPrompt`**（2026-09-29 修）
 * ——我原先写成「在 apply 里 `ctx.inject(['systemPrompt'], cb)`」，**准则一直不进
 * prompt**：面板上卡片、开关、原文全都正常（`GET /router/api/ext` 实测有 14 条
 * controls），但模型看到的 system prompt 里没有它。
 *
 * 根因（本机 cordis 4.0.4 实测）：`ctx.inject(deps, cb)` 的回调**不是同步触发** ——
 * provide 之后立刻 `inject`，回调要等到下一个异步点才跑。插件的 `apply` 是**同步
 * 函数**，返回时那次回调还没发生；而真实加载路径不保证之后还有机会去等它，
 * 于是 `mountPromptSection` 从没被执行 ⇒ **准则一次都没进过 prompt**。
 *
 * ⚠️ 我第一版把这个机制写成「要等 `ctx.start()`」——**那是错的**：`start` 根本不在
 *   Context 的公开面上（原型只有 extend/isolate/intercept）。准确说法是「下一个
 *   异步点」，具体机制随版本变。**结论不依赖这个细节**，只依赖「apply 里手动
 *   inject 不可靠」这一事实。
 *
 * 正确形状（对照 `dsh-client-ui-deliverables` 等真实使用者）：导出 `inject` 数组，
 * cordis 看到它就**把整个 apply 推迟到这些 service 就绪之后**再调用 ——
 * 于是 `ctx.systemPrompt` 一定是活的，`section()` 可以直接调。
 *
 * ⚠️ `router.ext` 也要列：那一半（面板登记）此前"碰巧"能用，是因为
 * `dsh-router` 核心先 provide 了它、`apply` 又跑在它之后。**那是时序上的运气，
 * 不是保证** —— 一并列进 `inject`，两种 service 都由 cordis 编排。
 */
export const inject = ['systemPrompt', 'router.ext', 'router.extStore']

/**
 * 登记本扩展**并**挂载准则段落。
 *
 * 此刻 `ctx.systemPrompt` / `ctx.router.ext` / `ctx.router.extStore` **必定已就绪**
 * （见上面 `inject` 的注释），所以下面**直接用**，不再做二次判空。
 */
export function apply(ctx: Context): void {
  const table = currentExts(ctx)
  const store = currentExtStore(ctx)

  // ① 准则段落。`section()` 注册一个**provider 函数**作为 text ——
  //    每次装配现算，所以改开关立即生效，无需重注册。
  const dispose = mountPromptSection({
    getSystemPrompt: () => systemPromptOf(ctx),
    isEnabled: () => store?.isEnabled(EXT_PROMPT_ID) === true,
    readData: () => store?.readData<PromptExtData>(EXT_PROMPT_ID),
  })

  // ② 面板登记。幂等：同一个 id 已在表里就不顶掉别人的登记。
  if (table !== undefined && table[EXT_PROMPT_ID] === undefined) {
    table[EXT_PROMPT_ID] = createPromptExt({
      isSystemPromptReady: () => !!systemPromptOf(ctx),
      // ⚠️ **store 必须在这时就能拿到**：拿不到的话面板上的分类开关显示可点、
      //   点了 400 —— 「看起来能用但不能用」比「不显示」更难查。
      store,
    })
    store?.setEnabled(EXT_PROMPT_ID, true)
    // 核心持有的是**同一个 live 对象**（它 provide 的空表），且 `/ext` 每次请求都
    // 现读这张表 —— 所以往里 append 就够了，不需要（也不存在）广播事件。
  }

  ctx.effect(() => () => {
    dispose()
    if (table !== undefined) delete table[EXT_PROMPT_ID]
  })
}
