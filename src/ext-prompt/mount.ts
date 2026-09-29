/**
 * 挂载层 —— 把准则注册成 `ctx.systemPrompt` 的**一个**段落。
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么只注册一段，而不是 14 段
 * ════════════════════════════════════════════════════════════════════
 * 面板开关的粒度是「分类」，但 prompt 读起来应该是一段连续的准则。分成 14 段
 * 会让 KV cache 每个分类各占一段，且**增删任意一个分类都让它之后的全部分位**。
 * 一段 + 拼装 ⇒ 分类增删只改这一段内部，段的位置与前缀稳定。
 *
 * ⚠️ **空串即关闭，这是平台原生语义**（`renderPrompt` 的注释原文：
 * "drop empty sections"）⇒ "可开关"不需要任何自造机制：本函数返回 `''`，
 * 上游就把整段丢掉。**不要自己实现"删段落"的逻辑**，那会和平台重复且会漂移。
 *
 * ⚠️ 文本用 provider 函数（`(context) => string`）而不是静态字符串：
 *   分类开关随时可改，静态文本**注册那一刻就定死了**，改开关不生效。
 */
import { renderPromptText, type PromptExtData } from './render.ts'

/** `ctx.systemPrompt` 的最小可见面。 */
export interface SystemPromptFace {
  section(section: { name: string; order: number; text: string | (() => string) }): () => void
  getSectionOrder?(name: string): number
}

/** 段落名（**稳定**）：改名会让已注册的作用域 section 与旧名并存。 */
export const PROMPT_SECTION_NAME = 'dsh-router-ext-prompt:guideline'

/**
 * 段落 order：100。
 *
 * 官方分配的槽位（`dsh-system-prompt` 的 `SECTION_ORDERS`）：
 * `PERSONA_PREFIX: 0` · `PLAN_POLICY: 500` · `TEAM_POLICY: 600` …·
 * 取 100 = 紧随 persona、远早于任何工具段 ⇒ 准则出现在身份之后、工具说明之前，
 * 与用户看到的记忆快照位置一致。
 */
const SECTION_ORDER = 100

export interface MountPromptDeps {
  /** 取 `ctx.systemPrompt`（可能尚未就绪 ⇒ undefined）。 */
  getSystemPrompt: () => SystemPromptFace | undefined
  /** 总开关（问核心 `router.extStore`）。 */
  isEnabled: () => boolean
  /**
   * 读本扩展的数据块（分类开关）。
   *
   * 落盘 JSON 不可信 ⇒ 返回值**不保证**是合法 `PromptExtData`，
   * `renderPromptText` 负责容错（见 render.test.ts 的注入用例）。
   */
  readData: () => PromptExtData | undefined
}

/**
 * 挂载准则段落。返回卸载函数。
 *
 * ⚠️ `systemPrompt` 尚不可用时**不挂**（返回 no-op 清理），并由 `ext.getState()`
 *   报 `ready: false` 让面板红字显示。**不做轮询重试** —— 显式"没就绪"好过
 *   半开的注入：后者会让准则随机时有时无，而用户看不出为什么。
 *   `index.ts` 用 `ctx.inject(['systemPrompt'])` 保证挂载时机，本函数只管挂。
 */
export function mountPromptSection(deps: MountPromptDeps): () => void {
  const sp = deps.getSystemPrompt()
  if (!sp) return () => {}

  const dispose = sp.section({
    name: PROMPT_SECTION_NAME,
    order: SECTION_ORDER,
    // ⚠️ provider 每次装配都现算 ⇒ 改开关**立即生效**，无需重注册。
    text: () => renderCurrent(deps),
  })
  return () => {
    dispose()
  }
}

/** 算出当前应注入的文本（薄壳：真逻辑在 render.ts，可单测）。 */
function renderCurrent(deps: MountPromptDeps): string {
  return renderPromptText(deps.isEnabled(), deps.readData())
}
