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
import { PROMPT_CATEGORIES, PROMPT_TITLE } from './content.ts'
import { PROMPT_LOGO_URL } from './logo.ts'
import { effectiveText, resolveCategories, resolveEnabledCategories, type PromptExtData } from './render.ts'

/** 从对象里去掉某个键（不改原对象）。`writeData` 是整块替换 ⇒ 删一个键要重写。 */
function omit<T extends Record<string, unknown>>(obj: T, key: string): Partial<T> {
  const out = { ...obj } as Record<string, unknown>
  delete out[key]
  return out as Partial<T>
}

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
  /**
   * 读落盘数据。**没有记录时返回空对象而不是 undefined**。
   *
   * ⚠️ 2026-09-30 实测修的真 bug：`<dataDir>/ext.json` 里 `prompt` 只有
   * `{enabled:true}`（**用户没改过任何东西** ⇒ 没有 `data` 键），
   * 而我原先把 `data === undefined` 当成"存储不可用"直接 `return null/false`
   * ⇒ 「添加准则」永远报 `title and body are required`，
   * 而 title/body 明明都传了 —— 报错信息还指向错误的字段，排查成本极高。
   *
   * ⇒ 「没记录」与「记录为空」**必须同义**：都当作"从空白开始"。
   * 真正该拒的是 **store 本身不存在**（扩展没挂上），那个在下面单独判。
   */
  const readData = (): PromptExtData => store?.readData<PromptExtData>(EXT_PROMPT_ID) ?? {}
  return {
    id: EXT_PROMPT_ID,
    name: '分层提示词',
    // 图标（面板卡片 / 详情页头部的 44px 圆角位）。SVG base64 内联 ⇒ 离线可用、
    // 不依赖外链、不受 CSP 的 img-src 限制。源文件在 `logo.svg`，base64 由它生成。
    icon: PROMPT_LOGO_URL,
    description: PROMPT_TITLE,
    // ⚠️ `description` = 整段的**标题**（不是一句自我介绍）。2026-09-29 两次调整：
    //   先是删掉它（详情页逐条列清单，「拆成 14 个分类」是纯冗余）；
    //   后又加回来、但只放**标题** `[准则 v5]`，并让详情页把它渲染在**最上面** ——
    //   逐条清单之前先说清「这是什么」，比任何自我介绍都直接。
    //   ⚠️ **不再内插分类数量**（`${PROMPT_CATEGORIES.length}` 会与真实数量漂移）。
    //
    //   插件页「包含的组件」那一行仍然有**另一句**说明（来自 `locale/zh.json`，
    //   宿主读的）—— 两者不是同一处，别混：那一行回答「不开它行不行」，
    //   这里回答「它是什么」。
    //
    // 随核心分发 -> 插件页的原生「包含的组件」里有它一行，自绘节里不再重复列。
    source: 'builtin' as const,
    // ⚠️ 每次 `controls` 被读都现算（不缓存）：用户在面板点一下立刻要看到新状态，
    //   而核心每次 GET /ext 都重新取一次。缓存会显示"点了没反应"。
    /**
     * ⚠️ **用 getter，每次读都重算**（2026-09-29 实测修的 bug）。
     *   原来写的是 `PROMPT_CATEGORIES.map(...)` —— 那个 map 在
     *   `createPromptExt()` 调用时就跑完了，是个**快照**。于是编辑落盘后：
     *   prompt 变了（渲染层每次现算），但面板再读 `controls` 拿到的还是**旧标题**
     *   ⇒ 用户看到「保存了、又变回去了」。而我当时的注释还写着"现算不缓存"——
     *   **注释与事实不符，比没注释更坏**。
     *
     * getter 让「面板显示的」与「prompt 里的」永远来自同一次 `readData()`。
     */
    get controls() {
      const data = readData()
      const on = resolveEnabledCategories(true, data)
      // ⚠️ 走 `resolveCategories`（内置 + 自建 + 排序），不是内置常量 ——
      //   否则自建条目与拖动排序**只停在面板上**，不进 prompt。
      return resolveCategories(data).map((c) => {
        const t = effectiveText(c.id, data?.text?.[c.id], c)
        return {
          id: c.id,
          title: t.title,
          // ⚠️ **带上原文**：不给出原文的话用户是在**盲切** —— 只看到「结构」「交付」
          //   这样的名字，不知道这一条到底写了什么，也无从判断该不该关掉它。
          //   「看内容 → 决定开关」这个动作必须能一处完成。
          body: t.body,
          editable: true,
          // ⚠️ **显式布尔，不靠缺省**：面板要靠 `custom === true` 决定
          //   给「删除」还是「还原」，`undefined`（字段缺失）会让"内置"变成
          //   "不知道是哪种" ⇒ 落到错误的按钮上（2026-09-30 实测现象）。
          // `custom` ⇒ 可删（自建）；`overridden` ⇒ 「还原」可点（改过内置）。
          custom: c.custom,
          overridden: c.overridden,
          on: on.has(c.id),
        }
      })
    },
    setControl: (controlId, on) => {
      if (!store) return false
      // ⚠️ **只改这一个键，不重写整块**：整块重写会顺手把 data 抽屉里的其它字段
      //   抹掉（`store.test.ts` 有一条「置开关不能把 data 冲掉」的同款纪律）。
      const data = readData()
      // ⚠️ 用**合成列表**（内置 + 自建）而不是 `PROMPT_CATEGORIES`：
      //   自建条目的 id 根本不在内置常量里 ⇒ 切它的开关恒被拒，
      //   报 `unknown controlId`（2026-09-30 实测：用户看到"自定义的开关控制报错"）。
      const known = resolveCategories(data).some((c) => c.id === controlId)
      if (!known) return false
      store.writeData(EXT_PROMPT_ID, { ...data, categories: { ...data.categories, [controlId]: on } })
      return true
    },
    // ⚠️ **只存覆盖值，不存全文**（见 PromptExtData.text）：没改过的分类不出现在
    //   落盘里 ⇒ 内置内容仍是唯一事实源，升级内置文案时它们会跟着更新。
    //   存全文的话，用户改一个字就永久冻结整段，之后内置更新对它们完全失效。
    setControlText: (controlId, patch) => {
      if (!store) return false
      const data = readData()
      // ⚠️ 用**合成列表**（内置 + 自建）而不是 `PROMPT_CATEGORIES`：
      //   自建条目的 id 根本不在内置常量里 ⇒ 切它的开关恒被拒，
      //   报 `unknown controlId`（2026-09-30 实测：用户看到"自定义的开关控制报错"）。
      const known = resolveCategories(data).some((c) => c.id === controlId)
      if (!known) return false
      // ⚠️ **空串直接拒绝**（返回 false ⇒ 核心回 400）：空标题会让这一行没名字，
      //   空正文会让规则凭空消失 —— 两者都像"被关了"而不是"被改坏了"。
      if (patch.title !== undefined && patch.title.trim() === '') return false
      if (patch.body !== undefined && patch.body.trim() === '') return false
      // ⚠️ **只并这一个键**：writeData 是整块替换，漏一个键就是丢一份数据
      //   （`store.test.ts` 有同款纪律：置开关不能把 data 冲掉）。
      const prev = data.text?.[controlId] ?? {}
      store.writeData(EXT_PROMPT_ID, {
        ...data,
        text: { ...data.text, [controlId]: { ...prev, ...patch } },
      })
      return true
    },
    /** 改顺序（拖动）。落盘 id 列表；未知/重复 id 由 `resolveCategories` 兜住。 */
    setControlOrder: (ids) => {
      if (!store) return false
      const data = readData()
      const known = new Set(resolveCategories(data).map((c) => c.id))
      // ⚠️ 只接受**当前存在**的 id：脏数据（手改 ext.json / 别的扩展写的）会
      //   让顺序里出现幽灵条目，而渲染时会静默忽略它 ⇒ 面板上「存了但没生效」。
      const next = [...new Set(ids)].filter((id) => known.has(id))
      store.writeData(EXT_PROMPT_ID, { ...data, order: next })
      return true
    },
    /** 新增一条自定义准则。id 由**扩展**生成（`cu-<n>`），避免前端编 id 撞内置。 */
    addCustomControl: (title, body) => {
      if (!store) return null
      if (typeof title !== 'string' || title.trim() === '') return null
      if (typeof body !== 'string' || body.trim() === '') return null
      const data = readData()
      const custom = Array.isArray(data.custom) ? [...data.custom] : []
      // ⚠️ **id 必须避开内置**：撞了会让两条同 id，`resolveCategories` 的
      //   `byId` Map 只留一条 ⇒ 另一条凭空消失（且不报错）。
      const used = new Set([...PROMPT_CATEGORIES.map((c) => c.id), ...custom.map((c) => c.id)])
      let n = custom.length + 1
      while (used.has(`cu-${n}`)) n++
      const id = `cu-${n}`
      custom.push({ id, title: title.trim(), body: body.trim(), defaultOn: true })
      store.writeData(EXT_PROMPT_ID, { ...data, custom })
      return id // ⚠️ 返回新 id：面板据此高亮/滚到新条目
    },
    /**
     * 删一条 —— **只允许自定义**。
     *
     * ⚠️ 内置条目返回 false（→ 核心回 400）：它是**代码的一部分**，
     *   删掉就意味着下一次发版它又回来了；用户对内置的处置手段是**关开关**
     *   与**还原文本**，不是删除。
     */
    removeCustomControl: (controlId) => {
      if (!store) return false
      const data = readData()
      const custom = Array.isArray(data.custom) ? data.custom : []
      if (!custom.some((c) => c.id === controlId)) return false
      store.writeData(EXT_PROMPT_ID, {
        ...data,
        custom: custom.filter((c) => c.id !== controlId),
        // 顺带清掉它的开关与覆盖，否则留下孤儿数据
        ...(data.categories ? { categories: omit(data.categories, controlId) } : {}),
        ...(data.text ? { text: omit(data.text, controlId) } : {}),
        ...(data.order ? { order: data.order.filter((id) => id !== controlId) } : {}),
      })
      return true
    },
    /**
     * 还原一条的文本（丢掉覆盖，回到内置）。
     *
     * ⚠️ 自定义条目返回 false —— 它**没有"内置版本"**可回退；
     *   它的对应手段是「删除」。
     */
    resetControlText: (controlId) => {
      if (!store) return false
      const data = readData()
      // ⚠️ 这里**刻意只用内置常量**：还原的语义是"回到内置内容"，
      //   自建条目**没有内置版本**可回退（它的对应手段是删除）。
      if (!PROMPT_CATEGORIES.some((c) => c.id === controlId)) return false
      if (data.text?.[controlId] === undefined) return false // 没改过，无需写盘
      store.writeData(EXT_PROMPT_ID, { ...data, text: omit(data.text, controlId) })
      return true
    },
    getState: () =>
      deps.isSystemPromptReady()
        ? { ready: true }
        : { ready: false, detail: 'ctx.systemPrompt 不可用 —— 本扩展无处注入' },
  }
}
