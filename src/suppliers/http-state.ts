/**
 * HTTP 状态码 → AccountState 的公共映射（内置三家供应商共用）。
 *
 * 为什么收敛成一处：opencode / openrouter / nvidia 本来各写一份逐字相同的
 * 三元表达式，于是「哪个状态算谁的错」这件事有三份实现，改一处就漏两处
 * （bad_request 就是这么差点只补了 codebuddy）。
 *
 * 关键判据：**这个错误换一个账号会不会好？**
 *  - 会好（限流/额度/凭证）→ 是账号的错，交给核心冷却/换号
 *  - 不会好（请求参数、模型不存在）→ 不是账号的错，绝不能冷号
 *    否则一次坏请求会把整个池冷掉（2026-09-15 codebuddy 读图事故的同型：
 *    组合两条腿同时被冷，之后连正常文本请求也全灭 503）
 */
import type { AccountState } from './contract.ts'

/**
 * 非 2xx 上游响应 → 语义状态。
 *
 * 4xx 里除了「限流/凭证/不存在」这三种明确归属账号的，剩下的都是**请求本身
 * 有问题**（400 参数错、413 太大、422 语义错…）——同一个请求对池里每个号结果
 * 都相同，归 `bad_request`（核心不惩罚账号，直接换下一个模型）。
 * 5xx / 说不清的仍归 `unknown`（上游故障侧，瞬冷换号是对的）。
 */
export function stateFromHttpStatus(status: number): AccountState {
  if (status === 429) return 'rate_limit'
  if (status === 401 || status === 403) return 'session_dead'
  if (status === 404) return 'unavailable'
  if (status === 402) return 'quota'
  if (status >= 400 && status < 500) return 'bad_request'
  return 'unknown'
}
