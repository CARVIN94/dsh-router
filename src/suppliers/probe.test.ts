/**
 * 契约体检的判据测试。三条，缺一条这个功能就不该存在：
 *
 *  1. **清单跟契约一起长** —— 契约加了成员而清单没加，体检就静默漏检。编译期类型
 *     抓不到（清单是运行时数组，契约成员是类型），只能解析契约源码来钉。
 *  2. **skip 成员绝不被调用** —— 「把所有功能跑一遍」里有一半成员有副作用
 *     （dispose 卸载供应商、addApiKey/removeLink 动凭证、generateLoginUrl 触发
 *     登录流、checkinNow 替用户签到）。探针一个都不能碰。
 *  3. **必填成员缺失要报错**（fail），可选成员缺失只是 absent。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { probeSupplier, SUPPLIER_CONTRACT_MEMBERS } from './probe.ts'
import type { LoadedSupplier } from './loader.ts'

// 本文件在 src/suppliers/ 下，所以 '../..' 才是仓库根
const root = fileURLToPath(new URL('../..', import.meta.url))

/** 从契约源码里抠出 `SupplierModule` 的成员名（编译期不存在的形状，只能这么拿）。 */
function contractMemberNames(): string[] {
  const src = readFileSync(join(root, 'src', 'suppliers', 'contract.ts'), 'utf8')
  const body = src.slice(src.indexOf('export interface SupplierModule'), src.indexOf('\n}', src.indexOf('export interface SupplierModule')))
  const names = new Set<string>()
  for (const m of body.matchAll(/^\s{2}(?:readonly\s+)?([a-zA-Z][a-zA-Z0-9]*)\??\s*[(:]/gm)) names.add(m[1]!)
  return [...names]
}

test('清单覆盖契约的全部成员（契约加了成员而清单没加 = 体检漏检）', () => {
  const declared = new Set(SUPPLIER_CONTRACT_MEMBERS.map((m) => m.key))
  const missing = contractMemberNames().filter((k) => !declared.has(k))
  assert.deepEqual(missing, [], `契约里有、清单里没有的成员：${missing.join('、')}`)
})

test('清单里没有契约里不存在的成员（写错名字 = 永远探不到，且不报错）', () => {
  const inContract = new Set(contractMemberNames())
  const extra = SUPPLIER_CONTRACT_MEMBERS.map((m) => m.key).filter((k) => !inContract.has(k))
  assert.deepEqual(extra, [], `清单里写了契约中不存在的成员：${extra.join('、')}`)
})

test('有副作用的成员一律标 skip，且都写了不自动执行的理由', () => {
  for (const key of ['dispose', 'addApiKey', 'removeLink', 'generateLoginUrl', 'completeLogin', 'checkinNow']) {
    const m = SUPPLIER_CONTRACT_MEMBERS.find((x) => x.key === key)
    assert.ok(m !== undefined, `清单里没有 ${key}`)
    assert.equal(m.probe, 'skip', `${key} 有副作用，不能自动跑`)
    assert.ok((m.skipReason ?? '').length > 0, `${key} 必须写清为什么不自动执行`)
  }
})

/** 会记账的假模块：任何被调用的成员都会被记下来。 */
function spyModule(implemented: readonly string[]): { m: Record<string, unknown>; called: string[] } {
  const called: string[] = []
  const record = <T>(key: string, value: T) => (): T => { called.push(key); return value }
  const m: Record<string, unknown> = { id: record('id', 'spy'), name: record('name', 'Spy') }
  for (const key of implemented) {
    if (key === 'status') m.status = record('status', { id: 'spy', name: 'Spy', accounts: [{ uid: 'u1', credits: 0, state: 'ok' }] })
    else if (key === 'listModels') m.listModels = record('listModels', [{ id: 'mm' }])
    else if (key === 'chatOnce') m.chatOnce = record('chatOnce', { ok: true })
    else if (key === 'dispose') m.dispose = record('dispose', undefined)
    else if (key === 'generateLoginUrl') m.generateLoginUrl = record('generateLoginUrl', 'https://x')
    else if (key === 'completeLogin') m.completeLogin = record('completeLogin', { uid: 'u', nickname: 'n' })
    else if (key === 'addApiKey') m.addApiKey = record('addApiKey', { ok: true })
    else if (key === 'removeLink') m.removeLink = record('removeLink', true)
    else if (key === 'pollLogin') m.pollLogin = record('pollLogin', true)
    else if (key === 'checkinNow') m.checkinNow = record('checkinNow', { ok: true, status: 'ok' })
    else m[key] = record(key, 'v')
  }
  return { m, called }
}

function loaded(m: Record<string, unknown>): LoadedSupplier {
  return {
    supplier: { id: 'spy', name: 'Spy', __module: m },
    capabilities: new Set<string>(),
    source: 'external',
  } as unknown as LoadedSupplier
}

test('skip 成员一个都不会被调用（探针只跑 safe 的）', async () => {
  const { m, called } = spyModule(SUPPLIER_CONTRACT_MEMBERS.map((x) => x.key))
  const report = await probeSupplier(loaded(m))
  for (const key of ['dispose', 'addApiKey', 'removeLink', 'generateLoginUrl', 'completeLogin', 'checkinNow']) {
    assert.equal(called.includes(key), false, `探针调用了 ${key} —— 这会造成真实副作用`)
  }
  assert.ok(report.members.some((x) => x.key === 'status' && x.state === 'ok'), 'safe 成员确实跑了')
})

test('skip 成员报「已实现 · 不自动执行」并带上理由', async () => {
  const { m } = spyModule(SUPPLIER_CONTRACT_MEMBERS.map((x) => x.key))
  const report = await probeSupplier(loaded(m))
  const dispose = report.members.find((x) => x.key === 'dispose')
  assert.equal(dispose?.present, true)
  assert.equal(dispose?.state, 'skipped')
  assert.match(dispose?.detail ?? '', /卸载/)
})

test('必填成员缺失 = fail（插件不完整），可选成员缺失 = absent', async () => {
  const { m } = spyModule(['status', 'listModels'])  // 缺 chatOnce/dispose，也缺全部可选
  const report = await probeSupplier(loaded(m))
  const chatOnce = report.members.find((x) => x.key === 'chatOnce')
  const addApiKey = report.members.find((x) => x.key === 'addApiKey')
  assert.equal(chatOnce?.state, 'fail', '必填成员缺失要报 fail')
  assert.equal(addApiKey?.state, 'absent', '可选成员缺失只是 absent')
})

test('safe 成员抛错只让那一条 fail，不连坐', async () => {
  const { m } = spyModule(['status', 'listModels'])
  m.listModels = () => { throw new Error('boom') }
  const report = await probeSupplier(loaded(m))
  const listModels = report.members.find((x) => x.key === 'listModels')
  const status = report.members.find((x) => x.key === 'status')
  assert.equal(listModels?.state, 'fail')
  assert.match(listModels?.detail ?? '', /boom/)
  assert.equal(status?.state, 'ok')
  assert.equal(report.summary.fail, report.members.filter((x) => x.state === 'fail').length, 'summary 与明细一致')
})
