/**
 * 扩展开关存储测试 —— 开关状态归核心持久化(`<dataDir>/ext.json`)。
 *
 * 锁定的契约:
 *   - 默认关(没记录过 = 关)
 *   - 开启 → 落盘,新实例(模拟重启)读到
 *   - 按 id 隔离,互不影响
 *   - 坏数据读盘不炸
 *   - 重复设同值不写盘
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExtStore } from './store.ts'

/** 每个用例一个独立数据目录(stateFile 推导出 ext.json)。 */
function tempStore(preload?: unknown): { store: ExtStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dshr-ext-'))
  const stateFile = join(dir, 'state.json')
  if (preload !== undefined) writeFileSync(join(dir, 'ext.json'), JSON.stringify(preload))
  return { store: new ExtStore(stateFile), file: join(dir, 'ext.json') }
}

test('默认关', () => {
  const { store } = tempStore()
  assert.equal(store.isEnabled('rtk'), false)
})

test('开启 → 落盘,重开还在', () => {
  const { store, file } = tempStore()
  store.setEnabled('rtk', true)
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { rtk?: { enabled: boolean } }
  assert.equal(raw.rtk?.enabled, true)
  // 新实例 = 模拟重启
  assert.equal(new ExtStore(join(file, '..', 'state.json')).isEnabled('rtk'), true)
})

test('关回去 → 落盘 false', () => {
  const { store, file } = tempStore()
  store.setEnabled('rtk', true)
  store.setEnabled('rtk', false)
  assert.equal(new ExtStore(join(file, '..', 'state.json')).isEnabled('rtk'), false)
})

test('按 id 隔离,互不影响', () => {
  const { store } = tempStore()
  store.setEnabled('rtk', true)
  assert.equal(store.isEnabled('rtk'), true)
  assert.equal(store.isEnabled('other'), false)
})

test('坏数据读盘不炸,当没配置过', () => {
  const { store: s1 } = tempStore({ rtk: { enabled: 'yes' } })
  assert.equal(s1.isEnabled('rtk'), false)
  const { store: s2 } = tempStore({ rtk: null })
  assert.equal(s2.isEnabled('rtk'), false)
  const { store: s3 } = tempStore([])
  assert.equal(s3.isEnabled('rtk'), false)
})

/** 造一个带旧 enhance.json 的目录(模拟升级前的状态)。 */
function legacyStore(enabled: boolean): { store: ExtStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dshr-ext-legacy-'))
  writeFileSync(join(dir, 'enhance.json'), JSON.stringify({ enabled }))
  const stateFile = join(dir, 'state.json')
  return { store: new ExtStore(stateFile), file: join(dir, 'ext.json') }
}

test('迁移:旧 enhance.json 开着 → 新 ext.json 里 rtk 开', () => {
  const { store, file } = legacyStore(true)
  assert.equal(store.isEnabled('rtk'), true)
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { rtk?: { enabled: boolean } }
  assert.equal(raw.rtk?.enabled, true)
})

test('迁移:旧文件关着 → 不迁移(保持默认关)', () => {
  const { store, file } = legacyStore(false)
  assert.equal(store.isEnabled('rtk'), false)
  assert.equal(existsSync(file), false)
})

test('迁移:已有新配置时不覆盖', () => {
  const { store: s1, file } = tempStore()
  s1.setEnabled('rtk', false)
  // 往同目录塞一个「开着」的旧文件,不应覆盖已经明确存过的新配置
  writeFileSync(join(file, '..', 'enhance.json'), JSON.stringify({ enabled: true }))
  const s2 = new ExtStore(join(file, '..', 'state.json'))
  assert.equal(s2.isEnabled('rtk'), false)
})

test('空 id 不落盘(连文件都不建)', () => {
  const { store, file } = tempStore()
  store.setEnabled('', true)
  assert.equal(store.isEnabled(''), false)
  assert.equal(existsSync(file), false, '空 id 应直接拒绝,不创建文件')
})

// ---- data 槽:给插件的通用抽屉(2026-09 加) ----

test('data:没存过 → undefined;写后能读回', () => {
  const { store } = tempStore()
  assert.equal(store.readData('rtk'), undefined)
  store.writeData('rtk', { hits: 3 })
  assert.deepEqual(store.readData('rtk'), { hits: 3 })
})

test('data:落盘 + 重启还在(与 enabled 同一文件)', () => {
  const { store, file } = tempStore()
  store.setEnabled('rtk', true)
  store.writeData('rtk', { hits: 3 })
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { rtk?: { enabled: boolean; data?: { hits: number } } }
  assert.equal(raw.rtk?.enabled, true)
  assert.deepEqual(raw.rtk?.data, { hits: 3 })
  const revived = new ExtStore(join(file, '..', 'state.json'))
  assert.equal(revived.isEnabled('rtk'), true)
  assert.deepEqual(revived.readData('rtk'), { hits: 3 })
})

test('data:写 data 不冲掉 enabled,置 enabled 不冲掉 data', () => {
  const { store, file } = tempStore()
  store.setEnabled('rtk', true)
  store.writeData('rtk', { hits: 1 })
  assert.equal(store.isEnabled('rtk'), true, '写 data 不能把开关冲掉')
  store.setEnabled('rtk', false)
  assert.deepEqual(store.readData('rtk'), { hits: 1 }, '置开关不能把 data 冲掉')
  const revived = new ExtStore(join(file, '..', 'state.json'))
  assert.equal(revived.isEnabled('rtk'), false)
  assert.deepEqual(revived.readData('rtk'), { hits: 1 })
})

test('data:按 id 隔离', () => {
  const { store } = tempStore()
  store.writeData('rtk', { hits: 1 })
  assert.deepEqual(store.readData('other'), undefined)
})

test('data:空 id 不落盘', () => {
  const { store, file } = tempStore()
  store.writeData('', { x: 1 })
  assert.equal(store.readData(''), undefined)
  assert.equal(existsSync(file), false)
})
