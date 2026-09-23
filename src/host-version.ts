/**
 * 宿主 DSH 版本探测 —— **0.1.5 / 0.1.7 兼容分叉的唯一判据来源**。
 *
 * 原先三处兼容都靠「能力检测」（看方法/属性在不在），语义上是同一个问题
 * ——「这是 0.1.7 还是更老」——却各检各的、还容易误判（插件自己 node_modules
 * 里的依赖版本与宿主实际加载的版本并不一致：实测插件解析到 schemastery 3.18.4，
 * profile 里却是 3.18.3、全局是 3.18.2）。所以统一改成**读宿主版本号**判定：
 *
 *   1. 「最近命中」徽章：composer.dock 在 0.1.5 渲染位置不对 → >= 0.1.7 才挂。
 *   2. 设置命名空间：0.1.5 用 `settings.installSection` 注册；0.1.7 改由导出的
 *      Config 驱动（无此方法）→ 按版本走对应注册路径。
 *   3. adapter 的 tool-result 消息形态：0.1.5/0.1.6 = user 里的 'tool-result'
 *      块；0.1.7+ = 独立 role:'tool' 消息。
 *
 * 读法：宿主把 profile 目录挂在 `ctx.baseUrl`（见 data-dir.ts）。本插件跑在宿主
 * 进程内，`require.resolve('@deepseek-ai/dsh/package.json', { paths: [profile] })`
 * 会沿 profile 的 node_modules 向上解析到全局安装根（实测命中 bun 全局目录）。
 * 拿不到就回落直接拼路径，再不行就返回 undefined（按「不支持/老版本」处理，不抛）。
 *
 * 注意：**只能在 `apply(ctx)` 里用**（那时才有 baseUrl）。模块顶层（如 Config 导出）
 * 解析到的是插件自己的依赖，不能代表宿主——那处保留能力检测，见 index.ts 注释。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { profileDirOf } from './data-dir.ts'

/** 各兼容分叉的版本门槛。 */
/** composer.dock 徽章 / 独立 role:'tool' 消息形态：0.1.7 起。 */
const V0_1_7: readonly number[] = [0, 1, 7]

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

/** 宿主版本是否 >= 门槛。读不到版本 → false（按老版本处理）。 */
function atLeast(baseUrl: string | undefined, min: readonly number[]): boolean {
  const v = detectHostVersion(baseUrl)
  if (v === undefined) return false
  const parsed = parseVersion(v)
  if (parsed === null) return false
  return compareVersion(parsed, min) >= 0
}

/**
 * 宿主是否 >= 0.1.7。三处兼容分叉共用这一个判据：
 *   - 「最近命中」徽章（composer.dock 位置正确）
 *   - 设置命名空间（Config 驱动而非 installSection）
 *   - adapter 的独立 role:'tool' 消息形态
 */
export function isHost017Plus(baseUrl?: string): boolean {
  return atLeast(baseUrl, V0_1_7)
}

/** 「最近命中」徽章是否可用（= 宿主 >= 0.1.7）。 */
export function supportsLastHitDock(baseUrl?: string): boolean {
  return isHost017Plus(baseUrl)
}
