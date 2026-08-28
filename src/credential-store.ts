/**
 * 通用凭证存储 —— dsh-router 核心统一管账号凭证（SQLite，参考 9router 的
 * providerConnections 表：凭证作为不透明 JSON blob 存单表 data 列）。
 *
 * 凭证是供应商特有的不透明数据（js 定义格式），核心只负责存储/增删/生命周期，
 * 不解析内容。库文件：`{authDir}/credentials.sqlite`，表：
 *   credentials(supplier TEXT, uid TEXT, data TEXT, PRIMARY KEY(supplier, uid))
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** 通用凭证存储。 */
export class CredentialStore {
  private db: DatabaseSync

  constructor(authDir: string) {
    if (authDir !== '' && authDir !== '.') mkdirSync(authDir, { recursive: true })
    const dbFile = join(authDir, 'credentials.sqlite')
    this.db = new DatabaseSync(dbFile)
    this.db.exec(`CREATE TABLE IF NOT EXISTS credentials (
      supplier TEXT NOT NULL,
      uid TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (supplier, uid)
    )`)
  }

  /** 某供应商的所有凭证 uid。 */
  list(supplierId: string): string[] {
    const rows = this.db.prepare('SELECT uid FROM credentials WHERE supplier = ? ORDER BY rowid').all(supplierId) as Array<{ uid: string }>
    return rows.map((r) => r.uid)
  }

  /** 读某凭证（不透明 blob）。不存在返回 undefined。 */
  get<T = unknown>(supplierId: string, uid: string): T | undefined {
    const row = this.db.prepare('SELECT data FROM credentials WHERE supplier = ? AND uid = ?').get(supplierId, uid) as { data: string } | undefined
    if (row === undefined) return undefined
    try {
      return JSON.parse(row.data) as T
    } catch {
      return undefined
    }
  }

  /** 存凭证（upsert）。 */
  save(supplierId: string, uid: string, data: unknown): void {
    this.db.prepare('INSERT INTO credentials (supplier, uid, data) VALUES (?, ?, ?) ON CONFLICT(supplier, uid) DO UPDATE SET data = excluded.data').run(
      supplierId,
      uid,
      JSON.stringify(data),
    )
  }

  /** 删凭证。 */
  remove(supplierId: string, uid: string): void {
    this.db.prepare('DELETE FROM credentials WHERE supplier = ? AND uid = ?').run(supplierId, uid)
  }

  /** 关闭连接（可选）。 */
  close(): void {
    this.db.close()
  }
}
