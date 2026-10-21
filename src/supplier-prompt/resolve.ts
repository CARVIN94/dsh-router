/**
 * 纯逻辑层 —— 「这一轮该用哪个供应商的提示词」以及「这段提示词怎么放」。
 *
 * 不 import cordis / 任何 DSH 包，所以能被 `node --test` 直接跑。
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么要"猜"是哪个供应商 —— 时序上的一轮延迟
 * ════════════════════════════════════════════════════════════════════
 * 系统提示词在**请求发出前**装配，而「这轮命中哪个供应商」要等 Router 选完号
 * 才知道。两件事天然差一轮：本轮装配时能确定的只有**同一会话上一轮**命中了谁。
 *
 * 三条备选，为什么选第一条：
 *   - ✅ **按会话上一轮命中**：会话内稳定收敛（第 2 轮起就是对的），首轮用默认。
 *   - ❌ 按「组合里第一个带提示词的」：与本轮实际服务者无关，组合一改就错。
 *   - ❌ 按模型名前缀实时判：组合里一次请求会跨多个供应商回退，缀在模型上的
 *     名字只是**入口**，不是最后真正回答的那个。
 *
 * 延迟的代价被两件事抵消：会话内第二轮起就稳定；且提示词是"身份描述"，
 * 第一轮用默认身份并不会让模型答错第一句（用户看到的行为差异极小）。
 */

/** 宿主第一方开场白（`dsh-system-prompt` 的 `HARNESS_IDENTITY`）。 */
export const HARNESS_IDENTITY_TEXT = 'You are an AI agent powered by DeepSeek Harness.'

/**
 * 宿主 `harness:identity` 段名（**官方常量，不是我们起的**）。
 *
 * 注册同名 section = 覆盖宿主的全局 section —— 这是 `dsh-system-prompt` 明写
 * 的设计（"a scoped section shadows a global section with the same name"），
 * 它自己用同一手法让 agent preset 的 persona 顶掉部署 persona
 * （见 `PERSONA_PREFIX_SECTION` 的注释「both sides naming the same section is
 * what makes the replacement work rather than duplicate」）。
 *
 * 所以**不需要**去读宿主的 `includeHarnessIdentity` 配置（插件也读不到，
 * 那是 cordis.yml 里的静态项）：
 *   - 宿主开着 → 我们的同名段顶掉它 → 提示词替换那句话 ✅
 *   - 宿主关着 → 那句本来就没注册 → 我们的段照样在那个位置，提示词排在最前 ✅
 * 两种情形下用户看到的是同一件事：「用了这个供应商，AI 的身份就是这段」。
 */
export const HARNESS_IDENTITY_SECTION = 'harness:identity'

/** 宿主给 `harness:identity` 分配的位置（`SECTION_ORDERS.HARNESS_IDENTITY`）。 */
export const HARNESS_IDENTITY_ORDER = -1000

/** 一段提示词该怎么放。 */
export type PromptPlacement =
  /** 没有供应商提示词 ⇒ 什么都不注册（宿主原样）。 */
  | { kind: 'none' }
  /** 有提示词 ⇒ 注册到 `harness:identity` 的位置，替换/占位。 */
  | { kind: 'identity'; text: string }

/**
 * 决定这一轮要不要注入、注入什么。
 *
 * @param prompt 当前应生效的供应商提示词（已被 `pickPromptSupplier` 选出）
 */
export function placementOf(prompt: string | undefined): PromptPlacement {
  const text = (prompt ?? '').trim()
  if (text === '') return { kind: 'none' }
  return { kind: 'identity', text }
}

/** 一个候选供应商（只带判断需要的两个字段）。 */
export interface PromptSupplierCandidate {
  /** 供应商 id（Router 里的 id，不是别名）。 */
  id: string
  /** 该供应商配置的提示词（空 = 没配）。 */
  prompt: string
}

/**
 * 选出这一轮该用的提示词。
 *
 * 顺序：会话上一轮命中的供应商 → 它若没配提示词则退回默认（空）。
 *
 * **不退回「别的供应商的提示词」**：命中 A 却用 B 的身份描述，比用默认身份
 * 更糟 —— 模型会自称成另一个供应商的形态。宁可退回宿主的原样。
 *
 * @param lastHitSupplierId 同一会话上一轮命中的供应商 id（无则 undefined）
 * @param candidates 当前参与路由的供应商
 * @returns 该轮应生效的提示词文本（'' = 不注入）
 */
export function pickPrompt(
  lastHitSupplierId: string | undefined,
  candidates: readonly PromptSupplierCandidate[],
): string {
  if (lastHitSupplierId === undefined || lastHitSupplierId === '') return ''
  const hit = candidates.find((c) => c.id === lastHitSupplierId)
  if (hit === undefined) return ''
  return (hit.prompt ?? '').trim()
}
