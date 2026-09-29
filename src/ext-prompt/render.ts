/**
 * 纯逻辑层 —— 分类开关的读取、校验与 prompt 文本渲染。
 *
 * 为什么单独成文件：**不 import cordis / 任何 DSH 包**，所以能被 `node --test`
 * 直接跑。DSH 侧的注册/挂载（ext.ts / inject.ts）只是薄壳；所有会出错的判断
 * 都在这里，且这里能注入违规用例证明它们会变红。
 */
import { PROMPT_CATEGORIES, PROMPT_TITLE, type PromptCategory } from './content.ts'

/** 落盘在 `router.extStore` 数据块里的形状。 */
export interface PromptExtData {
  /** 分类开关：`{ [categoryId]: boolean }`。缺项走 `defaultOn`。 */
  categories?: Record<string, boolean>
  /**
   * 用户在面板里改过的文本：`{ [categoryId]: { title?, body? } }`。
   *
   * ⚠️ **与 `categories` 分开两个键**：开关是"开不开"、文本是"写成什么样"。
   *   挤在一个键里，改标题会顺手碰到开关状态（`writeData` 是**整块替换**，
   *   少一个键就是少一份数据）。
   *
   * ⚠️ **只存覆盖值，不存全文**：没改过的分类不出现在这里 ⇒ 内置内容仍是唯一
   *   事实源，升级内置文案时没改过的那几条会跟着更新。存全文 = 用户改一个字
   *   就永久冻结了整段，之后内置更新对它们完全失效。
   */
  text?: Record<string, PromptCategoryOverride>
  /**
   * 用户自建的准则条目。**与内置的 `PROMPT_CATEGORIES` 分开存** ——
   * 内置那 14 条是**代码常量**（发版即定），混在一起就会出现"代码里有一条、
   * 落盘里又有一条"的归属问题：升级时新加的内置条目会和用户的旧数据打架。
   *
   * 存的是**完整条目**（不是覆盖值）：自建的东西没有"内置版本"可回退。
   */
  custom?: PromptCategory[]
  /**
   * 展示顺序：`[id, …]`，含内置与自建。
   *
   * ⚠️ **只存 id 顺序，不重排内置数组本身**：内置 14 条的次序是 `content.ts`
   *   里的代码顺序，它同时是"准则作为一份文档的阅读顺序"；让用户拖动去改它，
   *   等于让代码顺序随某个用户的操作漂移 —— 别人拿到新版本看到的次序就变了。
   *   落盘只记"这次会话里按什么顺序显示"，代码顺序永远是兜底。
   */
  order?: string[]
}

/** 一条分类上用户改过的字段（只记改了的那些）。 */
export interface PromptCategoryOverride {
  title?: string
  body?: string
}

/** 解出某分类**生效用**的文本：用户覆盖优先，否则用内置的。 */
export function effectiveText(
  id: string,
  override: PromptCategoryOverride | undefined,
  base: PromptCategory,
): { title: string; body: string } {
  return {
    // ⚠️ 空串是**非法**覆盖（写入端已挡），万一脏数据进来了也不能让它把
    //   分类"变成空的" —— 那会让那条规则凭空消失，看起来像被关了。
    title: override?.title !== undefined && override.title !== '' ? override.title : base.title,
    body: override?.body !== undefined && override.body !== '' ? override.body : base.body,
  }
}

/** 分类 id 的全集（校验用）。 */
export function knownCategoryIds(): string[] {
  return PROMPT_CATEGORIES.map((c) => c.id)
}

/**
 * 解出「哪些分类要渲染」。
 *
 * 三层语义，**顺序不可换**：
 *   ① 总开关关 ⇒ 一条都不渲染（不是"渲染但没内容"——那样面板显示已开启、实际无效果）；
 *   ② 数据块里显式写了的分类，用**用户存的值**（含显式 `false`）；
 *   ③ 没写过的分类，用 `defaultOn`。
 *
 * ⚠️ 为什么 ② 要区别于「没写」：`false` 与 `undefined` 语义完全不同 ——
 * 前者是用户主动关掉，后者是"没碰过"。把两者当同一件事，用户第一次关掉某分类
 * 后升级插件、新增同名分类，那条就永远是关的（用户没要求过）。
 */
export function resolveEnabledCategories(
  masterOn: boolean,
  data: PromptExtData | undefined,
): Set<string> {
  const out = new Set<string>()
  if (!masterOn) return out
  const saved = data?.categories
  // ⚠️ 遍历的是**合成后的列表**（内置 + 自建），不是内置常量 ——
  //   否则自建条目的开关永远算不出来（它不在 PROMPT_CATEGORIES 里）。
  for (const c of resolveCategories(data)) {
    const v = saved ? saved[c.id] : undefined
    if (v === undefined) {
      if (c.defaultOn) out.add(c.id)
    } else if (v === true) {
      out.add(c.id)
    }
  }
  return out
}

/**
 * 渲染成**一个**段落文本（多分类拼一起）。
 *
 * 为什么要拼成一段而不是一段一个：面板开关是"分类"粒度，而 prompt 读起来
 * 是一段连续的准则 —— 分成 14 个 section 会让 KV cache 每个分类各占一段、
 * 增删任意一个分类都让其后全部位移。这里**注册一个 section，文本由开关拼装**。
 *
 * @returns 关闭的分类不进结果；全关 ⇒ 空串（上游 `renderPrompt` 会丢弃空段）。
 */
export function renderCategories(
  enabled: ReadonlySet<string>,
  categories: readonly PromptCategory[] = PROMPT_CATEGORIES,
  overrides?: PromptExtData['text'],
  /** 有没有加整段标题。默认 true；传**外部分类表**时传 false（见下方注释）。 */
  withTitle = true,
): string {
  const lines: string[] = []
  for (const c of categories) {
    if (!enabled.has(c.id)) continue
    // ⚠️ **这里用覆盖后的 body** —— 面板改的内容必须真的进 prompt。
    //   漏了这一行，编辑就只是改了**显示**（用户会以为改了却没生效，
    //   而 prompt 里还是旧的 ⇒ 最坏的一种"看起来成功了"）。
    //   自建条目没有覆盖（`text` 里不会有它的键），`effectiveText` 走原值。
    lines.push(effectiveText(c.id, overrides?.[c.id], c).body)
  }
  // ⚠️ **标题放在最后 join 之前**：它不属于任何分类（见 PROMPT_TITLE 的注释），
  //   且只在**至少有一条规则开启**时才出现 —— 全关时整段返回空串被平台丢弃，
  //   留着标题就变成"有一套叫准则 v5 的东西"却一条规则都没有。
  //   标题放在**前面**：它要解释后面这些规则是什么。
  // ⚠️ **分类之间空一行**（2026-09-29 用户拍板）。单 `\n` 时 15 条规则在窄栏里
  //   密排成一块，肉眼看不出是 15 条独立的规则 —— 那正是"全都跑成一行"的观感
  //   来源（实测系统提示词里 `\n` 一直都在，是**排版**问题不是**内容**问题）。
  //   空行让每条规则成为独立段落。代价是 13 个换行符（~13 token，可忽略），
  //   且不改变前缀位置 ⇒ KV cache 行为不变。
  // ⚠️ 标题由**显式参数**决定，**不靠 `categories === PROMPT_CATEGORIES` 这种
  //   引用相等**（2026-09-29 实测踩过）：接入自建条目后调用方传的是
  //   `resolveCategories(data)` 合成列表，引用永远不相等 ⇒ 标题静默消失
  //   （测试当场抓到）。「是不是默认那张表」是个**语义问题**，不该由
  //   「是不是同一个对象」这种实现细节决定。
  if (lines.length === 0) return ''
  return withTitle ? [PROMPT_TITLE, ...lines].join('\n\n') : lines.join('\n\n')
}

/**
 * 渲染当前应注入的完整 prompt 文本（总开关 + 分类开关都算进去）。
 *
 * 总开关关 ⇒ 空串，让上游 `renderPrompt` 丢弃该段 —— **不是**注入一段空白。
 */
export function renderPromptText(masterOn: boolean, data: PromptExtData | undefined): string {
  if (!masterOn) return ''
  // ⚠️ 传入 `resolveCategories(data)`（含自建 + 排序）而不是常量
  //   `PROMPT_CATEGORIES` —— 否则拖动排序和自建条目都只停在面板上，不进 prompt。
  return renderCategories(
    resolveEnabledCategories(masterOn, data),
    resolveCategories(data),
    data?.text,
    true, // 合成列表也是本扩展的条目集，照样加标题
  )
}

/**
 * 合成后的**一条**准则条目：内置或自建，已应用标题/正文覆盖。
 * `builtin` 用来决定按钮（内置没有「删除」，只有「还原」）。
 */
export interface ResolvedCategory extends PromptCategory {
  /** 自建（用户加的）——可删除；内置的不可删除。 */
  readonly custom: boolean
  /** 文本被用户改过（决定「还原」按钮是否可点）。 */
  readonly overridden: boolean
}

/**
 * 内置 + 自建 + 排序 ⇒ 有序的最终条目列表。
 *
 * ⚠️ 三条规则（顺序不可换）：
 *  1. **内置在前、自建在后**，除非 `order` 显式给了别的次序。代码顺序是
 *     "准则作为一份文档的阅读顺序"，不该被用户拖动改掉（见 `PromptExtData.order`）。
 *  2. `order` 里**不认识的 id 一律忽略**，落盘不可信（手改的 ext.json、上一版的残渣）。
 *  3. `order` **没提到的条目按原序补在后面** —— 丢了某条 ≠ 它消失了。
 */
export function resolveCategories(data: PromptExtData | undefined): ResolvedCategory[] {
  const custom = Array.isArray(data?.custom) ? data.custom : []
  // 自建条目也要过滤：脏数据里的空 id / 空正文会让渲染产出空白段落。
  const validCustom = custom.filter(
    (c) => !!c && typeof c.id === 'string' && c.id !== '' && typeof c.body === 'string' && c.body !== '',
  )
  const base: ResolvedCategory[] = [
    ...PROMPT_CATEGORIES.map((c) => ({
      ...c,
      custom: false,
      overridden: data?.text?.[c.id] !== undefined,
    })),
    ...validCustom.map((c) => ({
      ...c,
      title: c.title,
      defaultOn: c.defaultOn !== false,
      custom: true,
      overridden: false, // 自建条目没有"内置版本"，改了就回不去
    })),
  ]
  const order = Array.isArray(data?.order) ? data.order : []
  if (order.length === 0) return base
  const byId = new Map(base.map((c) => [c.id, c]))
  const out: ResolvedCategory[] = []
  for (const id of order) {
    const hit = byId.get(id)
    if (hit === undefined) continue // 规则 2
    out.push(hit)
    byId.delete(id)
  }
  for (const c of base) {
    if (byId.has(c.id)) out.push(c) // 规则 3
  }
  return out
}
