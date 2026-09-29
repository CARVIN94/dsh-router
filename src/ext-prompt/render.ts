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
  for (const c of PROMPT_CATEGORIES) {
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
): string {
  const lines: string[] = []
  for (const c of categories) {
    if (!enabled.has(c.id)) continue
    lines.push(c.body)
  }
  // ⚠️ **标题放在最后 join 之前**：它不属于任何分类（见 PROMPT_TITLE 的注释），
  //   且只在**至少有一条规则开启**时才出现 —— 全关时整段返回空串被平台丢弃，
  //   留着标题就变成"有一套叫准则 v5 的东西"却一条规则都没有。
  //   标题放在**前面**：它要解释后面这些规则是什么。
  // ⚠️ **只对默认分类表加标题**：传外部分类表（可扩展性用例）时调用者有自己的一组
  //   规则，硬塞本扩展的标题是错的 —— 「不加」比「加错」对。
  if (lines.length === 0) return ''
  return categories === PROMPT_CATEGORIES
    ? [PROMPT_TITLE, ...lines].join('\n')
    : lines.join('\n')
}

/**
 * 渲染当前应注入的完整 prompt 文本（总开关 + 分类开关都算进去）。
 *
 * 总开关关 ⇒ 空串，让上游 `renderPrompt` 丢弃该段 —— **不是**注入一段空白。
 */
export function renderPromptText(masterOn: boolean, data: PromptExtData | undefined): string {
  if (!masterOn) return ''
  return renderCategories(resolveEnabledCategories(masterOn, data))
}
