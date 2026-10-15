/**
 * 面板「供应商」页的可见性规则 —— 纯函数，不碰 React。
 *
 * 形状与插件页**刻意相反**：
 *   - 面板（设置 → 路由 → 供应商）= **在用什么**的工作面，只列**开着**的；
 *     关掉的卡片不出现（与「扩展」页同一形状）。
 *   - 插件页（设置 → 插件 → dsh-router-core → 路由组件）= **控制面**，供应商组
 *     列全部（含关掉的），否则关掉之后就再没有可点的开关能开回来。
 *
 * 为什么空状态要分两种：「暂无供应商」说的是**一个都没装**，而「都关掉了」是
 * 装了但用户自己关的。两者共用一句「暂无供应商」就是说假话 —— 用户进面板发现
 * 自己装的东西不见了，而真正的原因（开关在另一个页面关着）无处可寻。
 *
 * 抽出来是为了让「哪些卡片该出现」这条判据能被单测钉住：它一行就能写错，
 * 而写错的表现是「面板说关了、请求照样打过去」或者「用户以为没装」。
 */
import type { RouterHealthResponse } from '../shared.ts'

/** `/health` 里的一条供应商摘要（就地取型，不另抄一份形状）。 */
export type SupplierSummary = NonNullable<RouterHealthResponse['suppliers']>[number]

/** 面板要渲染的分组。 */
export interface SupplierVisibility {
  /** 随核心分发、且开着的。 */
  builtin: SupplierSummary[]
  /** 独立安装、且开着的。 */
  external: SupplierSummary[]
  /** 装过但被开关关掉的个数（不列卡片，但空状态要用它说明去哪开回来）。 */
  hidden: number
  /**
   * 空状态文案。`undefined` = 不该显示空状态（有卡片可列）。
   * `reason: 'none'` 是一个都没装；`reason: 'disabled'` 是装了但全被关掉。
   */
  empty?: { reason: 'none' | 'disabled'; title: string; desc: string }
}

/** 开关在插件页的固定位置 —— 空状态要把用户指过去，不然就断在这里了。 */
const SWITCH_HOME = '设置 → 插件 → dsh-router-core'

/**
 * 按「开着与否 + 来源」把供应商分成面板要渲染的两组，并给出空状态该说什么。
 *
 * `enabled` 缺省按**开着**读（老核心没有这个字段）；只有明确的 `false` 才算关。
 */
export function supplierVisibility(suppliers: readonly SupplierSummary[]): SupplierVisibility {
  const on = suppliers.filter((s) => s.enabled !== false)
  const builtin = on.filter((s) => s.source !== 'external')
  const external = on.filter((s) => s.source === 'external')
  const hidden = suppliers.length - on.length
  if (on.length > 0) return { builtin, external, hidden }
  return {
    builtin,
    external,
    hidden,
    empty: hidden > 0
      ? {
        reason: 'disabled',
        title: '供应商都已关闭',
        desc: `开关在 ${SWITCH_HOME} 的「路由组件」一节；打开后会重新参与路由`,
      }
      : { reason: 'none', title: '暂无供应商', desc: '' },
  }
}
