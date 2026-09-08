/**
 * 落盘路径解析 —— dsh-router 所有持久化路径的唯一来源。
 *
 * 以前写的是相对路径 `data/state.json`：**落盘位置跟着 `process.cwd()` 跑**。
 * 不在 `~/.dsh/profiles/web` 里 `dsh web` 启动，state.json / supplier-config.json
 * / keys.json / usage.json 就会静默写进另一个目录（面板显示空配置），切回原目录
 * 启动又「回来」——用户看到的是「配置丢了」。所以这里一律产出绝对路径。
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 本 profile 的目录。
 *
 * 宿主把配置树锚点 `ctx.baseUrl` 挂在每个插件的 context 上，它正是 profile
 * 目录（`cordis.yml` 所在处）——不用猜、也不用像 dsh-market 那样嗅探 argv。
 * 兜底只服务「宿主没给锚点」的冷启动（单测、非常规宿主）：沿用今天的事实
 * 标准 `web` profile。
 */
export function profileDirOf(baseUrl?: string): string {
  if (typeof baseUrl === 'string' && baseUrl !== '') {
    try {
      // 尾部斜杠留给 join 吸收是隐式的，这里显式归一：调用方拿到的是干净目录。
      return resolve(fileURLToPath(baseUrl))
    } catch {
      // 不是 file: URL（或不可解析）——落到兜底分支
    }
  }
  return join(dshHome(), 'profiles', 'web')
}

/** 数据目录：state.json / supplier-config.json / keys.json / auths/ 都在这里。 */
export function dataDirOf(baseUrl?: string): string {
  return join(profileDirOf(baseUrl), 'data')
}

/** `$DSH_HOME`（支持 `~` 前缀），缺省 `~/.dsh`。 */
function dshHome(): string {
  const raw = process.env.DSH_HOME
  if (raw === undefined || raw.trim() === '') return join(homedir(), '.dsh')
  const value = raw.trim()
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return resolve(homedir(), value.slice(2))
  return resolve(value)
}
