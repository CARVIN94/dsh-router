/**
 * 挂载层 —— 把「当前生效的供应商提示词」注册成 `ctx.systemPrompt` 的一段。
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么用 provider 函数而不是每次重注册
 * ════════════════════════════════════════════════════════════════════
 * 生效的供应商可能每轮都变（组合回退、用户切模型），而 `section()` 注册是一次
 * 性的。用 `text: () => string` 让宿主**每次装配都现算**：改供应商、改提示词、
 * 命中换人，下一轮就生效，无需 dispose + 重注册（重注册会撞
 * "prompt section already registered"）。
 *
 * ════════════════════════════════════════════════════════════════════
 * 空串即卸载 —— 平台原生语义
 * ════════════════════════════════════════════════════════════════════
 * 没配提示词（或该轮不该注入）时 provider 返回 `''`，宿主按"drop empty
 * sections"把整段丢掉。**所以这个 section 可以常驻注册**，不需要按供应商开关
 * 反复挂/摘 —— 那样会在切换瞬间留下半开状态。
 */
import {
  HARNESS_IDENTITY_ORDER,
  HARNESS_IDENTITY_SECTION,
  HARNESS_IDENTITY_TEXT,
  placementOf,
} from './resolve.ts'

/** `ctx.systemPrompt` 的最小可见面（与 `ext-prompt/mount.ts` 同形，各自独立）。 */
export interface SystemPromptFace {
  section(section: { name: string; order: number; text: string | (() => string) }): () => void
}

/** 本插件注册的段名 = 宿主的 `harness:identity`（同名才能顶掉它）。 */
export const SUPPLIER_PROMPT_SECTION = HARNESS_IDENTITY_SECTION

export interface MountSupplierPromptDeps {
  /** 取 `ctx.systemPrompt`（尚未就绪 ⇒ undefined）。 */
  getSystemPrompt: () => SystemPromptFace | undefined
  /**
   * 这一轮应生效的提示词文本（每次装配现调）。
   *
   * 传函数而不是值：生效者每轮都可能变，值会定格在注册那一刻。
   */
  currentPrompt: () => string
}

/**
 * 挂载供应商提示词段落，返回卸载函数。
 *
 * ⚠️ `systemPrompt` 不可用时不挂、返回 no-op —— 由调用方用
 * `ctx.inject(['systemPrompt'])` 保证时机，本函数不轮询重试（理由同
 * `ext-prompt/mount.ts`：显式"没就绪"好过半开的注入）。
 */
export function mountSupplierPrompt(deps: MountSupplierPromptDeps): () => void {
  const sp = deps.getSystemPrompt()
  if (!sp) return () => {}

  const dispose = sp.section({
    // 与宿主同名 ⇒ 覆盖它，而不是并排多出一段
    name: SUPPLIER_PROMPT_SECTION,
    // 用宿主给这个位置分配的原值：替换的是"同一句话"，位置不该变
    order: HARNESS_IDENTITY_ORDER,
    text: () => {
      const placement = placementOf(deps.currentPrompt())
      // ⚠️ 'none' 时返回**宿主原句**，而不是空串。
      //
      // 因为我们占用了 `harness:identity` 这个名字，返回空串 = 把宿主的开场白
      // 也一起摘掉（同名覆盖是整段替换，不是追加）。而在「挂了本段、但这轮
      // 命中的供应商没配提示词」的空档期（首轮、命中换人、用户刚清空），
      // 用户的预期是**回到原样**，不是「身份行消失」。
      //
      // 所以这里显式回落成宿主那句 —— 等于"这段没生效"，与没注册它的效果
      // 一致（只是位置由我们守住了，不会因为宿主开关变化而漂移）。
      return placement.kind === 'identity' ? placement.text : HARNESS_IDENTITY_TEXT
    },
  })
  return () => {
    dispose()
  }
}
