/**
 * 官方插件页「路由组件」一节的分组 —— 纯函数，不碰 React。
 *
 * 为什么抽出来：这一节唯一有分支的地方就是「一条供应商/扩展归哪组、能不能
 * 就地开关」（见下两条判据）。留在组件里就只能靠真页面点出来验，抽出来单测，
 * 判据改错当场变红。
 *
 * 数据源是核心**已经在提供**的两个端点，本模块不新增任何 API：
 *   - `/health` 的 `suppliers[]` 带 `source`（builtin / user / external）
 *   - `/ext` 的 `enhancers[]` 是核心合并完开关与运行时事实的扩展表
 */
import type { RouterExtResponse, RouterHealthResponse } from '../shared.ts'

/** `/health` 里的一条供应商摘要（就地取型，不另抄一份形状）。 */
export type RouterSupplierSummary = NonNullable<RouterHealthResponse['suppliers']>[number]

/** 一行组件（三组共用同一种形状，渲染时才分叉）。 */
export interface RouterComponentRow {
  /** 组内唯一键：`supplier:<id>` / `ext:<id>`。 */
  key: string
  name: string
  icon?: string
  /** ext 报的就绪状态说明（如「本机未装 rtk」）。 */
  detail?: string
  enabled?: boolean
  ready?: boolean
  /**
   * 能否就地开关。**只有 ext 能**：扩展开关由核心持久化（`<dataDir>/ext.json`），
   * 走 `PATCH /router/api/ext`。供应商不是行也不是 bundle，在这一页没有可写的
   * 开关 —— 内置/本地那组只能只读，外部那组的启停在它们自己的插件页。
   */
  togglable: boolean
}

/** 三个来源组。 */
export interface RouterComponents {
  /** 随核心分发 + 投进 profile 目录的供应商（不是独立安装的 bundle）。 */
  local: RouterComponentRow[]
  /** 独立安装的供应商插件（各是独立 bundle，启停在它们自己的插件页）。 */
  external: RouterComponentRow[]
  /** 扩展插件（`router.ext`，开关归核心）。 */
  ext: RouterComponentRow[]
}

/** 空组：加载前与加载失败都用它，保证形状恒定。 */
export const EMPTY_COMPONENTS: RouterComponents = { local: [], external: [], ext: [] }

/** 一条供应商摘要 → 只读行。 */
function supplierRow(s: RouterSupplierSummary): RouterComponentRow {
  return {
    key: `supplier:${s.id}`,
    name: s.name,
    togglable: false,
    ...(s.icon === undefined ? {} : { icon: s.icon }),
  }
}

/**
 * 把两个端点的答复分成三组。
 *
 * `source` 判据取反而非取正：`external` 是唯一「用户另装的 bundle」，其余
 * （builtin / user / 将来新增的取值 / 字段缺失）都是核心自己加载的供应商。
 * 这样判据是全函数 —— 缺 `source` 的供应商会落到本地组，而不是被静默丢掉，
 * 也不会被误报成独立插件。
 */
export function groupRouterComponents(health: RouterHealthResponse, ext: RouterExtResponse): RouterComponents {
  const local: RouterComponentRow[] = []
  const external: RouterComponentRow[] = []
  for (const s of health.suppliers ?? []) {
    if (s.source === 'external') external.push(supplierRow(s))
    else local.push(supplierRow(s))
  }
  const extRows = (ext.enhancers ?? []).map((e): RouterComponentRow => ({
    key: `ext:${e.id}`,
    name: e.name,
    // 缺字段一律按「关 / 未就绪」读：没拿到的事实不当真，宁可显示成关着
    // 让用户自己去开，也不要谎报在跑（`ready` 是运行时事实，猜不得）。
    enabled: e.enabled === true,
    ready: e.ready === true,
    togglable: true,
    ...(e.icon === undefined ? {} : { icon: e.icon }),
    ...(e.detail === undefined ? {} : { detail: e.detail }),
  }))
  return { local, external, ext: extRows }
}

/** 这三组加起来一个都没有 → 这一节不渲染（不留空标题）。 */
export function isEmptyComponents(components: RouterComponents): boolean {
  return components.local.length === 0 && components.external.length === 0 && components.ext.length === 0
}
