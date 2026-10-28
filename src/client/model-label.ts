/**
 * 模型 chip 的标签 —— 「可读名 + 上游 key」两段。
 *
 * 为什么需要：有些上游的模型 key 是内部标识（Qoder 的 `qmodel_38max`、
 * `kmodel_latest`、`mmodel`），面板上只剩一串猜不出含义的字母；而上游目录里
 * 其实同时下发了可读名（`Qwen3.8-Max`、`Kimi-K3.1-Pro`）。丢掉它，用户点
 * 「获取模型」之后仍然不知道自己勾的是什么。
 *
 * 但两段不能互相替代：**能发给上游的只有 key**。所以显示上可读名在前、key 在后
 * （两者相同时只显示一次），复制按钮复制 key，请求/组合存的也是 key。
 */

/** 一个模型在面板上的呈现。 */
export interface ModelLabel {
  /** 主标签：上游给的可读名，没有（或与 key 相同）就用 key。 */
  label: string
  /** 是否还要把 key 作为副标签显示 —— 与主标签相同就不重复。 */
  showId: boolean
  /** 悬停提示：两个都给出来，并点明请求要用哪个。 */
  title: string
}

/**
 * 算出模型的展示标签。
 * @param m 至少要有 `id`；`name` 是可读名（可缺、可空串）
 */
export function modelLabel(m: { id: string; name?: string }): ModelLabel {
  const name = (m.name ?? '').trim()
  const label = name === '' || name === m.id ? m.id : name
  const showId = label !== m.id
  return {
    label,
    showId,
    title: showId ? `${label}\n${m.id}（请求与组合里用这个）` : m.id,
  }
}

/**
 * 搜索匹配：可读名与 key **都**参与。
 *
 * 两种说法都要能搜到：记得模型叫什么的人搜 `kimi`，记得上游 key 的人搜
 * `kmodel`；只匹配一个等于把另一半人的搜索框作废。
 */
export function modelMatches(query: string, m: { id: string; name?: string }): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  return m.id.toLowerCase().includes(q) || (m.name ?? '').toLowerCase().includes(q)
}
