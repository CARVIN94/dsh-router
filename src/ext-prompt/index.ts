/**
 * 分层提示词扩展的 **cordis 行** —— 官方插件页（设置 → 插件 → dsh-router-core）详情页
 * 原生「包含的组件」里的那一行。
 *
 * 壳的形状 = cordis 身份 + 登记，实现 = `plugin.ts`；**执行面的事**是挂
 * system prompt 段落 —— 所以额外等 `systemPrompt` service 就绪后挂 section。
 *
 * **默认关闭**（patch 里 `disabled: true`）：开不开由用户决定。行关闭时 loader
 * 根本不 import 本模块，扩展就不在 `router.ext` 表里 ——「打开才出现这张卡片」
 * 是天然的，不需要额外状态位。
 *
 * 登记时把扩展开关置为开：本扩展**没有独立的运行期开关**，它的开关就是这一行
 * （宿主管的那个）。不置上的话，用户开了行还要再点一次，两级开关说同一件事。
 */
import type { Context } from '@deepseek-ai/cordis'
// ⚠️ **只为一个目的而 import type**：让 cordis 的 `Events` 增强
//   （`system-prompt/assemble` / `system-prompt/change`）进入本文件所在的编译单元。
//   不 import 的话，`ctx.on('system-prompt/assemble', …)` 的参数不是
//   `keyof Events` ⇒ **声明构建（tsconfig.build.json，host 半边）直接报错**，
//   而主 tsconfig 因为 include 了 `assembly.test.ts`（它 import 了同一个包）
//   恰好把增强带进来 ⇒ `tsc --noEmit` 全绿、`npm run build` 才红。
//   这类"两种配置下结论不同"的坑，靠显式依赖修，不靠碰巧。
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  currentExts,
  currentExtStore,
  type ExtStoreService,
  type RouterExtService,
} from '../ext/contract.ts'
import { createPromptExt, EXT_PROMPT_ID } from './plugin.ts'
import { mountPromptSection, type SystemPromptFace } from './mount.ts'
import type { PromptExtData } from './render.ts'
import { createSectionCache, disabledSectionNames, filterSections } from './sections.ts'

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
 * prompt**：面板上卡片、开关、原文全都正常（`GET /router/api/ext` 里 controls 一条
 * 不少），但模型看到的 system prompt 里没有它。
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

  // ① 准则段落。`section()` 注册一个 **provider 函数**作为 text ——
  //    每次装配现算，所以改开关立即生效，无需重注册。
  const dispose = mountPromptSection({
    getSystemPrompt: () => systemPromptOf(ctx),
    isEnabled: () => store?.isEnabled(EXT_PROMPT_ID) === true,
    readData: () => store?.readData<PromptExtData>(EXT_PROMPT_ID),
  })

  // ② 段落总控：挂 `system-prompt/assemble` waterfall —— 每轮装配时
  //    ⑴ 先把**未过滤的全量段落**喂给清单缓存（面板的事实源，在过滤前取 ⇒
  //    关掉的段仍列在面板上，不会"关了就消失、开不回来"）；
  //    ⑵ 再按落盘的关段表删掉关闭的段（宿主以监听器返回值为权威结果
  //    —— `assemble()` 的 `return transformed`，删掉的段不会被恢复）。
  //
  //    ⚠️ 总开关关 ⇒ 原样放行：扩展关 = 本扩展什么都不做，宿主段落恢复
  //    自然注入（与准则段"关总开关 ⇒ 段文本空 ⇒ 整段被丢"同一语义）。
  //    ⚠️ 监听器注册在**无 scope 标签**的 ctx 上，而派发走
  //    `scopeTarget`（dsh-scope）：无标签监听器收一切 scope 的装配
  //    —— 这正是宿主"全局注册、参与所有 agent 装配"的通道，与准则
  //    section 进 prompt 同一条 scope 规则。
  const cache = createSectionCache()
  let disposeAssemble: (() => boolean) | undefined
  let disposeChange: (() => boolean) | undefined
  const sp = systemPromptOf(ctx)
  if (sp) {
    disposeAssemble = ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const result = await next()
      cache.update(result.sections)
      if (store?.isEnabled(EXT_PROMPT_ID) !== true) return result
      const off = disabledSectionNames(store.readData<PromptExtData>(EXT_PROMPT_ID))
      if (off.size === 0) return result
      return { ...result, sections: filterSections(result.sections, off) }
    })
    // 段在**没有新装配时**增删（插件开关变化等）⇒ 面板清单不会自己更新，
    // 主动跑一次 assemble 刷新（它会再走上面的 waterfall ⇒ 缓存唯一写入点）。
    disposeChange = ctx.on('system-prompt/change', () => {
      void sp.assemble().catch(() => { /* 预热失败不致命：下次装配自然补上 */ })
    })
    // 预热：一次对话都还没发生时，面板也要有清单（无 scope 的 global 近似）。
    void sp.assemble().catch(() => { /* 同上 */ })
  }

  // ③ 面板登记。幂等：同一个 id 已在表里就不顶掉别人的登记。
  if (table !== undefined && table[EXT_PROMPT_ID] === undefined) {
    table[EXT_PROMPT_ID] = createPromptExt({
      isSystemPromptReady: () => !!systemPromptOf(ctx),
      // ⚠️ **store 必须在这时就能拿到**：拿不到的话面板上的分类开关显示可点、
      //   点了 400 —— 「看起来能用但不能用」比「不显示」更难查。
      store,
      // 段清单来自 waterfall 缓存（若 ② 没挂上 ⇒ 空清单 ⇒ 段组不显示，
      // 但不许这里给缺省 —— 见 createPromptExt 的 deps 注释）。
      getSections: () => cache.list(),
    })
    store?.setEnabled(EXT_PROMPT_ID, true)
    // 核心持有的是**同一个 live 对象**（它 provide 的空表），且 `/ext` 每次请求都
    // 现读这张表 —— 所以往里 append 就够了，不需要（也不存在）广播事件。
  }

  ctx.effect(() => () => {
    dispose()
    disposeAssemble?.()
    disposeChange?.()
    if (table !== undefined) delete table[EXT_PROMPT_ID]
  })
}
