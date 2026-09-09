/**
 * 扩展 (Ext) 通用契约 —— dsh-router 的「扩展插件」扩展点（不是供应商）。
 *
 * 分工：
 *   - dsh-router 核心提供 `router.ext` 共享表（同 `router.suppliers` 模式），并
 *     在 `tools/execute` 拦截 bash 工具调用，把命令委派给表里 **enabled** 的
 *     扩展器改写；命中则短路，未命中/无扩展器走原样执行。锁定向。
 *   - 扩展插件（如 dsh-router-ext-rtk）把自己注册进共享表，实现命令改写 + 自管
 *     开关状态（何时 enabled、怎么探活）。核心不感知具体扩展器实现。
 *
 * 为什么单独一个 `rewrite` 而不是直接让插件自己 `ctx.on('tools/execute')`：
 *   多个扩展插件如果各自挂监听会互相踩/顺序不可控。收敛到核心这一处委派，
 *   让「工具调用 → 扩展器改写」的转发规则只有一个负责人，插件只做差异化能力。
 *
 * 契约要点：
 *   - `rewrite` 是同步纯函数（在工具派发热路径内联调用，不能做 IO/异步）。
 *   - `getState()` 只报**运行时事实**（ready 是否可用、detail 说明），不报开关。
 *   - **开关归核心持久化**（`ExtStore` → `<dataDir>/ext.json`），插件不存、不报
 *     `enabled`，也没有 `setEnabled` —— 插件是被调用方。
 *   - 扩展器不写 res、不遍历工具、只改命令字符串。改写失败/无改写返回
 *     `{ rewritten: null }`，核心以此原样执行。
 */
import type { Context } from '@deepseek-ai/cordis'

/** 扩展器唯一 id（注册键）。 */
export type ExtId = string

/**
 * 扩展器当前状态（**运行时事实**，由插件现算，不持久化）。
 *
 * 注意：`enabled` 不在这里 —— 开关状态归核心持久化（`<dataDir>/ext.json`），
 * 插件只负责做事 + 报自己是否可用。核心把两者合并后再给面板/裁决用。
 */
export interface ExtState {
  /** 运行时是否就绪（如 RTK 二进制是否可用）；false 时即使开启也不改写。 */
  ready: boolean
  /** 不就绪时的一句话说明（如「本机未装 rtk」），面板红字显示。 */
  detail?: string
}

/** `rewrite` 一次返回：改写后的命令，或 `{ rewritten: null }` 表示原样执行。 */
export type RewriteResult = { rewritten: string } | { rewritten: null }

/**
 * 注册到 `router.ext` 表的扩展器实现。核心调用方（面板/API/工具委派）只认
 * 这几个方法，插件可以携带更多内部状态。
 */
export interface RouterExt {
  /** 扩展器 id，也是 `router.ext` 表里的注册键。 */
  readonly id: ExtId
  /** 面板显示名（如「RTK」）。 */
  readonly name: string
  /** 面板副标题说明。 */
  readonly description?: string
  /**
   * 改写一条命令。在工具派发热路径内联调用——必须同步返回、不能抛、不能做
   * 网络/文件 IO。返回 `{ rewritten }` 时核心用改写后的命令执行并短路；否则原样。
   */
  rewrite(command: string): RewriteResult
  /** 当前运行时状态（ready + 不就绪时的说明）。 */
  getState(): ExtState
  /** 卸载清理（表删除时由 dsh-router 调用，可选）。 */
  dispose?(): void
}

/** 面板/API 用的一条扩展器信息 = 核心存的开关 + 插件报的运行时事实。 */
export interface ExtInfo {
  id: string
  name: string
  description?: string
  /** 核心持久化的开关（默认关）。 */
  enabled: boolean
  /** 插件报的运行时就绪状态。 */
  ready: boolean
  /** 不就绪时的说明（面板红字）。 */
  detail?: string
}

/** `router.ext` 共享聚合表：`{ [extId]: RouterExt }`（同一 live 对象可追加）。 */
export interface RouterExtService {
  [extId: string]: RouterExt
}

/** 读取当前 router.ext 表（同一 live 对象，可追加）——扩展插件用它注册自己。 */
export function currentExts(ctx: Context): RouterExtService | undefined {
  const c = ctx as unknown as {
    get?: (key: string) => unknown
    router?: { ext?: RouterExtService }
  }
  return (c.get?.('router.ext') ?? c.router?.ext) as RouterExtService | undefined
}