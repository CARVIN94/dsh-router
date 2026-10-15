/**
 * 自检面板的「模型」下拉该列哪些 —— 纯函数，不碰 React。
 *
 * 为什么不能把端点返回的模型全列出来：那个端点给的是**全部**模型（含用户在
 * 供应商详情里停用的）。实测某供应商 30 个模型里只有 3 个是启用的 —— 把 30 个都
 * 塞进下拉，用户会挑到一个自己明明关掉的模型去测，测通了也不代表配置是对的。
 * 所以只列**可用**的（用户没停用的），与路由实际会用的那批保持一致。
 *
 * 顺带把「没有可选模型」拆成两种，因为**用户该做的事不一样**：
 *   - `none`（一个模型都没有）→ 该去供应商详情拉取模型；
 *   - `all-disabled`（有模型但全被停用）→ 该去供应商详情把它们打开，
 *     去拉取是白跑一趟。
 * 两种共用一句「没有模型」就是把用户往错的方向指。
 *
 * `enabled` 缺省按**未停用**读（`!== false`）：这个字段是用户的配置，缺失时不该
 * 凭空把模型藏起来。
 */

/** `/suppliers/:id/models` 里的一条模型。 */
export interface ModelRow {
  id: string
  enabled?: boolean
}

export interface ModelChoice {
  /** 可用模型的 id，按端点返回的顺序（不重排 —— 端点已经按优先级排过了）。 */
  ids: string[]
  /** 没有可选模型时的原因；`undefined` = 有得选。 */
  empty?: 'none' | 'all-disabled'
}

/** 从端点答复里挑出可用的模型，并说明「空的」到底是哪一种空。 */
export function modelChoice(models: readonly ModelRow[]): ModelChoice {
  const ids = models.filter((m) => m.enabled !== false).map((m) => m.id)
  if (ids.length > 0) return { ids }
  return { ids, empty: models.length === 0 ? 'none' : 'all-disabled' }
}
