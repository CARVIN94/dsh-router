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

/** 一行组件（两组共用同一种形状，渲染时才分叉）。 */
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
   * 能否就地开关。**两组都能**：扩展走 `PATCH /router/api/ext`（核心持久化到
   * `<dataDir>/ext.json`），供应商走 `PATCH /router/api/suppliers/:id/enabled`
   * （落到 `supplier-config.json`）。两组都是核心持久化的用户开关，核心都据此
   * 真的停止路由 —— 不是一个只把卡片藏起来的假开关。
   */
  togglable: boolean
}

/**
 * 这一节要列的两组。
 *
 * **为什么没有「内置与本地供应商」组**：内置供应商是 dsh-router-core 自己 patch
 * 里的**行**（`cordis.patch.yml` insert 了三个子路径模块），已经在宿主的原生
 * 「包含的组件」里，带着宿主管的开关。在这里再列一遍就是同一个东西显示两处。
 */
export interface RouterComponents {
  /** 独立安装的供应商插件（各是独立 bundle，启停在它们自己的插件页）。 */
  external: RouterComponentRow[]
  /** 扩展插件（`router.ext`，开关归核心）。 */
  ext: RouterComponentRow[]
}

/** 空组：加载前与加载失败都用它，保证形状恒定。 */
export const EMPTY_COMPONENTS: RouterComponents = { external: [], ext: [] }

/** 一条外部供应商摘要 → 只读行。 */
function supplierRow(s: RouterSupplierSummary): RouterComponentRow {
  return {
    key: `supplier:${s.id}`,
    name: s.name,
    // 缺 `enabled` 按开着读（老核心没这个字段）。关掉的供应商**仍列出来** ——
    // 面板「扩展」页的形状是「关掉就不出现」，但供应商关掉后如果也消失，这里就
    // 少了一个可点的开关、再也开不回来。两组刻意不同。
    enabled: s.enabled !== false,
    togglable: true,
    ...(s.icon === undefined ? {} : { icon: s.icon }),
  }
}

/**
 * 把两个端点的答复分成两组。
 *
 * 供应商这边只收 `source === 'external'`（独立安装的供应商插件）。`builtin`
 * 的那三个已经作为**原生行**在宿主的「包含的组件」里显示了（core 自己 patch
 * insert 的子路径模块，开关是宿主管的那个行开关），`user` 的是用户目录里投放的
 * js —— 两者都不该在这里出现第二次。`source` 缺失按「不是 external」处理：
 * 不显示总比把内置的错标成独立插件强。
 *
 * 两组都在这一页开关，指向核心的同两个端点（`PATCH /suppliers/:id/enabled` 与
 * `PATCH /ext`），所以「在哪开关」是一致的：**设置 → 插件 → dsh-router-core**。
 * 供应商的开关关掉是真的不参与路由（见 Router 的活跃集合），不是只隐藏卡片。
 */
export function groupRouterComponents(health: RouterHealthResponse, ext: RouterExtResponse): RouterComponents {
  const external = (health.suppliers ?? [])
    .filter((s) => s.source === 'external')
    .map(supplierRow)
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
  return { external, ext: extRows }
}

/** 两组加起来一个都没有 → 这一节不渲染（不留空标题）。 */
export function isEmptyComponents(components: RouterComponents): boolean {
  return components.external.length === 0 && components.ext.length === 0
}
