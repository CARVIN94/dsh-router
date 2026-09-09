/**
 * 扩展开关存储 —— **开关状态归核心持久化**,插件只负责做事。
 *
 * 落盘 `<dataDir>/ext.json`,按扩展器 id 存:
 *   `{ "rtk": { enabled: true } }`
 *
 * 为什么归核心:跟 `supplier-config.json` 一个道理——开关是用户对**核心面板**的操作,
 * 不该由扩展插件各自决定存哪、怎么存(否则每个插件长一份互相不一致的实现,核心也
 * 无从统一裁决「能不能开」)。插件变薄:只报自己是否可用(`ready`)。
 *
 * 写法与核心其他存储一致:先写 `.tmp` 再 `rename` 原子覆盖(避免写一半崩掉留坏文件),
 * 权限 600;持久化失败不阻断。
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

interface ExtFile {
  [extId: string]: { enabled: boolean }
}

/** 扩展开关存储。 */
export class ExtStore {
  private fp = ''
  private byId: Record<string, boolean> = {}

  constructor(stateFile: string) {
    this.fp = stateFile ? join(dirname(stateFile), 'ext.json') : ''
    this.load()
    // 一次性迁移:开关早期由扩展插件自己写在 `enhance.json`(单文件、无法按 id 区分),
    // 现在归核心按 id 存 `ext.json`。把旧值搬过来,避免用户已开的开关掉回关。
    // 旧文件保留不删(不可逆操作留给人工),迁移只发生在新文件还没有时。
    this.migrateLegacy()
  }

  private migrateLegacy(): void {
    if (this.fp === '') return
    if (Object.keys(this.byId).length > 0) return // 已有新配置,不覆盖
    const legacy = join(dirname(this.fp), 'enhance.json')
    let enabled = false
    try {
      const f = JSON.parse(readFileSync(legacy, 'utf8')) as { enabled?: unknown }
      enabled = f.enabled === true
    } catch {
      return // 没有旧文件 / 读不了 → 无需迁移
    }
    if (!enabled) return
    // 旧格式只有一个开关,当时唯一的扩展器就是 rtk。
    this.byId.rtk = true
    this.save()
  }

  private load(): void {
    if (this.fp === '') return
    let raw: string
    try {
      raw = readFileSync(this.fp, 'utf8')
    } catch {
      return
    }
    try {
      const f = JSON.parse(raw) as ExtFile
      for (const [id, v] of Object.entries(f)) {
        if (id !== '' && typeof v?.enabled === 'boolean') this.byId[id] = v.enabled
      }
    } catch {
      // 损坏则用默认关
    }
  }

  private save(): void {
    if (this.fp === '') return
    try {
      const dir = dirname(this.fp)
      if (dir !== '' && dir !== '.') mkdirSync(dir, { recursive: true })
      const out: ExtFile = {}
      for (const [id, enabled] of Object.entries(this.byId)) out[id] = { enabled }
      const raw = JSON.stringify(out, null, 2)
      const tmp = this.fp + '.tmp'
      writeFileSync(tmp, raw, { mode: 0o600 })
      renameSync(tmp, this.fp)
    } catch {
      // 持久化失败不阻断
    }
  }

  /** 是否开启(未记录过 = 默认关)。 */
  isEnabled(id: string): boolean {
    return this.byId[id] === true
  }

  setEnabled(id: string, enabled: boolean): void {
    if (id === '') return
    if (this.byId[id] === enabled) return
    this.byId[id] = enabled
    this.save()
  }
}