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
import type { ExtStoreService, RouterExt } from '../ext/contract.ts'
import { PROMPT_CATEGORIES } from './content.ts'
import { resolveEnabledCategories, type PromptExtData } from './render.ts'

/** 扩展开关表里的注册键。 */
export const EXT_PROMPT_ID = 'prompt'

/**
 * 构造这个扩展器。
 *
 * `getState()` 报**唯一的真实就绪条件**：`ctx.systemPrompt` 不可用时无处注入
 * （section 是唯一的注入通道），此时必须红字报出，而不是静默不生效 ——
 * 判据能变红比"看起来一直开着"有用。
 *
 * @param deps.store - `router.extStore`（读写分类开关的落盘数据块）。缺省时
 *   `controls` 报全部默认、`setControl` 恒 false —— 那样面板显示可点但点了
 *   没反应，**比不显示更坏**。
 */
export function createPromptExt(deps: {
  isSystemPromptReady: () => boolean
  store?: ExtStoreService
}): RouterExt {
  const store = deps.store
  const readData = (): PromptExtData | undefined => store?.readData<PromptExtData>(EXT_PROMPT_ID)
  return {
    id: EXT_PROMPT_ID,
    name: '分层提示词',
    // ⚠️ **故意不设 `description`**（2026-09-29 用户指出后删的）：
    //   详情页现在逐条列出每个分类的标题、开关与原文，上面再写一句
    //   「把协作准则拆成 14 个可独立开关的分类」是**纯冗余**——数字与清单
    //   就摆在下面，写死一个 `PROMPT_CATEGORIES.length` 还会与真实数量漂移
    //   （加减分类后文案不跟着变，正是「两份事实」）。
    //
    //   插件页「包含的组件」那一行**仍然有说明**（来自 `locale/zh.json`，宿主读的），
    //   那一句是必要的：不开这一行，用户无从知道它是干什么的。
    //
    // 随核心分发 -> 插件页的原生「包含的组件」里有它一行，自绘节里不再重复列。
    source: 'builtin' as const,
    // ⚠️ 每次 `controls` 被读都现算（不缓存）：用户在面板点一下立刻要看到新状态，
    //   而核心每次 GET /ext 都重新取一次。缓存会显示"点了没反应"。
    controls: PROMPT_CATEGORIES.map((c) => ({
      id: c.id,
      title: c.title,
      // ⚠️ **带上原文**：不给出原文的话用户是在**盲切** —— 只看到「结构」「交付」
      //   这样的名字，不知道这一条到底写了什么，也无从判断该不该关掉它。
      //   「看内容 → 决定开关」这个动作必须能在一处完成。
      body: c.body,
      on: resolveEnabledCategories(true, readData()).has(c.id),
    })),
    setControl: (controlId, on) => {
      if (!store) return false
      // ⚠️ **只改这一个键，不重写整块**：整块重写会顺手把 data 抽屉里的其它字段
      //   抹掉（`store.test.ts` 有一条「置开关不能把 data 冲掉」的同款纪律）。
      const data = readData()
      if (data === undefined) return false
      const known = PROMPT_CATEGORIES.some((c) => c.id === controlId)
      if (!known) return false
      store.writeData(EXT_PROMPT_ID, { ...data, categories: { ...data.categories, [controlId]: on } })
      return true
    },
    getState: () =>
      deps.isSystemPromptReady()
        ? { ready: true }
        : { ready: false, detail: 'ctx.systemPrompt 不可用 —— 本扩展无处注入' },
  }
}
