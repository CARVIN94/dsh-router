/**
 * 宿主 DSH 版本探测 —— 只为一件事：**「最近命中」徽章只在 0.1.7+ 出现**。
 *
 * 为什么需要它：`conversation.composer.dock` 这个座位在 0.1.5 也存在，但渲染
 * 位置不同（0.1.5 里它是 composer 卡片内、InputBar 之后的独立块；0.1.7 才把它
 * 放进底部操作行、与原生上下文环并列）。座位名相同 → 没法靠 slot 契约区分，
 * 只能按宿主版本号判定。
 *
 * 读法：宿主把 profile 目录挂在 `ctx.baseUrl`（见 data-dir.ts）。本插件跑在宿主
 * 进程内，`require.resolve('@deepseek-ai/dsh/package.json', { paths: [profile] })`
 * 会沿 profile 的 node_modules 向上解析到全局安装根（实测命中 bun 全局目录）。
 * 拿不到就回落直接拼路径，再不行就返回 undefined（按「不支持」处理，不抛）。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { profileDirOf } from './data-dir.ts'

/** 徽章（composer.dock）要求的最低宿主版本。 */
const DOCK_MIN: readonly number[] = [0, 1, 7]

/**
 * 解析并比较 semver（只取前导数字段，预发布标识忽略）。
 * `0.1.7-alpha.2` → [0,1,7]，`0.1.5-rc.3` → [0,1,5]。
 * 返回负数/0/正数，语义同 `<`/`==`/`>`。
 */
function compareVersion(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x - y
  }
  return 0
}

/** `0.1.7-alpha.2` → [0,1,7]；解析失败返回 null。 */
function parseVersion(raw: string): number[] | null {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(raw.trim())
  if (m === null) return null
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)]
}

/**
 * 探测 profile 里安装的 DSH 宿主版本。
 * @param baseUrl 宿主注入的 profile 锚点（`ctx.baseUrl`）
 * @returns 形如 `0.1.7-alpha.2`；读不到返回 undefined（调用方按「不支持」处理）
 */
export function detectHostVersion(baseUrl?: string): string | undefined {
  const profile = profileDirOf(baseUrl)
  // 先走模块解析（能沿 node_modules 向上找到全局安装根），再回落直接拼路径。
  const candidates: string[] = []
  try {
    candidates.push(createRequire(join(profile, 'noop.js')).resolve('@deepseek-ai/dsh/package.json'))
  } catch {
    // 解析不到就走下面的直接路径
  }
  candidates.push(join(profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }
      if (typeof parsed.version === 'string' && parsed.version !== '') return parsed.version
    } catch {
      // 换下一个候选
    }
  }
  return undefined
}

/** 该宿主版本是否支持 composer.dock 徽章（>= 0.1.7）。读不到版本 → 不支持。 */
export function supportsLastHitDock(baseUrl?: string): boolean {
  const v = detectHostVersion(baseUrl)
  if (v === undefined) return false
  const parsed = parseVersion(v)
  if (parsed === null) return false
  return compareVersion(parsed, DOCK_MIN) >= 0
}
