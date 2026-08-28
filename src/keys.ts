/**
 * 密钥库 + 路由设置（requireApiKey）—— 9router「端点与密钥」核心。
 * 持久化到 data/keys.json（与 pool 的 stateFile 同目录）。
 *
 * /v1/* 鉴权规则：
 *   - requireApiKey=false（默认）→ 不鉴权
 *   - requireApiKey=true → Bearer 必须是「启用的库内 key」或 TW2A_API_KEY env
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { API_KEY_REF } from './shared.ts'

/** 库内一条 key。 */
export interface ApiKeyEntry {
  id: string
  name: string
  /** 完整 key（仅创建时返回一次明文；列表返回脱敏）。 */
  key: string
  isActive: boolean
  createdAt: string
}

interface KeysFile {
  keys: ApiKeyEntry[]
  requireApiKey: boolean
}

function newId(): string {
  return randomBytes(6).toString('hex')
}

export function generateKey(): string {
  return `dshr-${randomBytes(24).toString('hex')}`
}

function mask(k: string): string {
  if (k.length <= 10) return k
  return `${k.slice(0, 6)}${'•'.repeat(k.length - 10)}${k.slice(-4)}`
}

/** 密钥库。 */
export class KeysStore {
  private fp = ''
  private keys: ApiKeyEntry[] = []
  private require = false

  constructor(stateFile: string) {
    this.fp = stateFile ? join(dirname(stateFile), 'keys.json') : ''
    this.load()
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
      const f = JSON.parse(raw) as KeysFile
      this.keys = Array.isArray(f.keys) ? f.keys : []
      this.require = !!f.requireApiKey
    } catch {
      // 损坏则用空库
    }
  }

  private save(): void {
    if (this.fp === '') return
    try {
      const dir = dirname(this.fp)
      if (dir !== '' && dir !== '.') mkdirSync(dir, { recursive: true })
      const raw = JSON.stringify({ keys: this.keys, requireApiKey: this.require }, null, 2)
      const tmp = this.fp + '.tmp'
      writeFileSync(tmp, raw, { mode: 0o600 })
      renameSync(tmp, this.fp)
    } catch {
      // 持久化失败不阻断
    }
  }

  list(): Array<{ id: string; name: string; key: string; masked: string; isActive: boolean; createdAt: string }> {
    return this.keys.map((k) => ({
      id: k.id,
      name: k.name,
      key: k.key,
      masked: mask(k.key),
      isActive: k.isActive,
      createdAt: k.createdAt,
    }))
  }

  /** 创建 key，返回明文（仅此一次）。 */
  create(name: string): { entry: ApiKeyEntry; key: string } {
    const entry: ApiKeyEntry = {
      id: newId(),
      name: name.trim() !== '' ? name.trim() : `Key ${this.keys.length + 1}`,
      key: generateKey(),
      isActive: true,
      createdAt: new Date().toISOString(),
    }
    this.keys.push(entry)
    this.save()
    return { entry, key: entry.key }
  }

  remove(id: string): boolean {
    const before = this.keys.length
    this.keys = this.keys.filter((k) => k.id !== id)
    if (this.keys.length === before) return false
    this.save()
    return true
  }

  setActive(id: string, isActive: boolean): boolean {
    const k = this.keys.find((k) => k.id === id)
    if (!k) return false
    k.isActive = isActive
    this.save()
    return true
  }

  /** requireApiKey 开关。 */
  get requireApiKey(): boolean {
    return this.require
  }

  set requireApiKey(v: boolean) {
    this.require = v
    this.save()
  }

  /** 校验 Bearer key：requireApiKey 关 → 放行；开 → 库内启用 key 或 TW2A_API_KEY env。 */
  verify(bearer: string | undefined): boolean {
    if (!this.require) return true
    if (bearer === undefined || bearer === '') return false
    if (this.keys.some((k) => k.isActive && k.key === bearer)) return true
    const envKey = process.env[API_KEY_REF]
    return envKey !== undefined && envKey !== '' && envKey === bearer
  }
}
