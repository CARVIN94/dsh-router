/**
 * 宿主 DSH 版本探测 —— 现在只剩两件事：**报版本**（日志 + `/router/api/health`）与
 * **守版本地板**。
 *
 * ## 为什么不再有兼容分叉
 *
 * 原来这里有三处 `>= 0.1.7` 的分叉（设置卡片注册路径、「最近命中」徽章座位、adapter
 * 的工具结果消息形态），彼此独立判断、还容易误判。本插件现已按 **0.2.0 单面**编写，
 * 三处的旧分支全部删除：
 *
 *   1. 设置卡片：0.1.5 走 `settings.installSection`，0.1.7+ 走导出的 volatile Config。
 *      0.2.0 只有后者 → installSection 分支删除。
 *   2. 「最近命中」徽章：0.1.5 渲染在 InputBar 之后的独立块（位置不对），0.1.7+ 才在
 *      composer 底部操作行。0.2.0 起无条件挂载，不再问支持位。
 *   3. adapter 工具结果形态：旧的「user 内嵌 tool-result 块」0.1.7 起退役；0.2.0 的
 *      v3→v4 会话迁移还主动拒绝该包装，所以它到不了 adapter → 分支删除。
 *
 * ## 为什么仍要读版本
 *
 * 因为**跑在老宿主上必须出声**。删掉分叉不等于「老宿主也能跑」：0.1.x 上本插件会
 * 静默走错路径（卡片不出、徽章错位、工具结果丢失），而用户看到的现象与「插件坏了」
 * 无法区分。所以这里只保留一个判据 `isHostSupported`（>= 0.2.0），仅用于 apply 时
 * 打一条醒目的警告 —— 不是兼容，是可诊断。
 *
 * 读法：宿主把 profile 目录挂在 `ctx.baseUrl`（见 data-dir.ts）。本插件跑在宿主
 * 进程内，`require.resolve('@deepseek-ai/dsh/package.json', { paths: [profile] })`
 * 会沿 profile 的 node_modules 向上解析到全局安装根。拿不到就回落直接拼路径，再不行
 * 返回 undefined（按「无法确认」处理，不抛）。
 *
 * 注意：**只能在 `apply(ctx)` 里用**（那时才有 baseUrl）。模块顶层解析到的是插件自己
 * 的依赖，不能代表宿主。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { profileDirOf } from './data-dir.ts'

/** 版本地板：低于此版本的宿主本插件不再兼容（0.1.5/0.1.6/0.1.7 全部落此下）。 */
const V0_2_0: readonly number[] = [0, 2, 0]

/**
 * 解析并比较 semver（只取前导数字段，预发布标识忽略）。
 * `0.2.0-rc.1` → [0,2,0]，`0.1.7-alpha.2` → [0,1,7]。
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

/** `0.2.0-rc.1` → [0,2,0]；解析失败返回 null。 */
function parseVersion(raw: string): number[] | null {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(raw.trim())
  if (m === null) return null
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)]
}

/**
 * 探测 profile 里安装的 DSH 宿主版本。
 * @param baseUrl 宿主注入的 profile 锚点（`ctx.baseUrl`）
 * @returns 形如 `0.2.0-rc.1`；读不到返回 undefined
 */
export function detectHostVersion(baseUrl?: string): string | undefined {
  const profile = profileDirOf(baseUrl)
  // 先走模块解析（能沿 node_modules 向上找到全局安装根），再回落直接路径。
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

/**
 * 宿主是否在本插件支持的地板之上（>= 0.2.0）。
 *
 * **只用于报警，不用于分流** —— 低于地板时插件照常加载，但要在日志里说清「这台宿主
 * 不再兼容、会出现什么症状」，把静默的错变成可查的错。读不到版本 → false（当作
 * 「无法确认」，同样值得说一句）。
 */
export function isHostSupported(baseUrl?: string): boolean {
  const v = detectHostVersion(baseUrl)
  if (v === undefined) return false
  const parsed = parseVersion(v)
  if (parsed === null) return false
  return compareVersion(parsed, V0_2_0) >= 0
}
