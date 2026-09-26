/**
 * 契约体检的判据测试。三条，缺一条这个功能就不该存在：
 *
 *  1. **清单跟契约一起长** —— 契约加了成员而清单没加，体检就静默漏检。编译期类型
 *     抓不到（清单是运行时数组，契约成员是类型），只能解析契约源码来钉。
 *  2. **会毁掉体检前提的成员绝不被调用** —— `dispose` 卸载自己、`addApiKey` 写凭证等，
 *     一律移出清单（见 PROBE_EXCLUDED_MEMBERS），既不出现也不被调。
 *  3. **必填成员缺失要报错**（fail），可选成员缺失只是 absent。
 *  4. **「全部启用/全部禁用」真跑**（并还原）—— 它是唯一能抓出「插件在 listModels
 *     里过滤已禁用模型」越权的路径：全部禁用之后违规插件把模型全藏起来，核心就再也
 *     拉不到列表、用户「全部启用」时没有 id 可传。
 */
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { probeSupplier, SUPPLIER_CONTRACT_MEMBERS, PROBE_EXCLUDED_MEMBERS } from './probe.ts'
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

test('清单覆盖契约的全部成员，除了有意排除的那几个（契约加了成员而清单没加 = 体检漏检）', () => {
  const declared = new Set([...SUPPLIER_CONTRACT_MEMBERS.map((m) => m.key), ...Object.keys(PROBE_EXCLUDED_MEMBERS)])
  const missing = contractMemberNames().filter((k) => !declared.has(k))
  assert.deepEqual(missing, [], `契约里有、清单里和排除名单里都没有的成员：${missing.join('、')}`)
})

test('有意排除的成员都写了排除理由（不能无声消失）', () => {
  for (const [key, why] of Object.entries(PROBE_EXCLUDED_MEMBERS)) {
    assert.ok(why.length > 0, `${key} 必须写清为什么不测`)
  }
})

test('不测的成员不出现在报告清单里（不占篇幅）', () => {
  const keys = new Set(SUPPLIER_CONTRACT_MEMBERS.map((m) => m.key))
  for (const key of Object.keys(PROBE_EXCLUDED_MEMBERS)) {
    assert.equal(keys.has(key), false, `${key} 说好不测，就不该出现在清单里`)
  }
})

test('清单里没有契约里不存在的成员（写错名字 = 永远探不到，且不报错）', () => {
  const inContract = new Set(contractMemberNames())
  const extra = SUPPLIER_CONTRACT_MEMBERS.map((m) => m.key).filter((k) => !inContract.has(k))
  assert.deepEqual(extra, [], `清单里写了契约中不存在的成员：${extra.join('、')}`)
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

test('留在清单里的成员都有明确的 probe 方式', () => {
  for (const m of SUPPLIER_CONTRACT_MEMBERS) {
    assert.ok(m.probe === 'safe' || m.probe === 'skip', `${m.key} 的 probe 类型不明确`)
    if (m.probe === 'skip') {
      assert.ok((m.skipReason ?? '').length > 0, `${m.key} 标了 skip 必须写清为什么不自动跑`)
    }
  }
})

test('probe 输入的成员会实跑（单档全自动：能安全试的就是要试）', async () => {
  const { m, called } = spyModule(SUPPLIER_CONTRACT_MEMBERS.map((x) => x.key))
  await probeSupplier(loaded(m), { models: [{ id: 'm1', enabled: true }] })
  // 清单里的成员该跑的都要跑（需要真实连接的用连接池的 token）
  assert.equal(called.includes('checkinNow'), true, 'checkinNow 该对真实连接实跑')
  assert.ok(called.includes('status'), 'safe 成员确实跑了')
})

test('dispose 不出现在报告里（调用它就是卸载自己，体检没法在自己身上验自己）', async () => {
  const { m } = spyModule([...SUPPLIER_CONTRACT_MEMBERS.map((x) => x.key), 'dispose'])
  const report = await probeSupplier(loaded(m), { models: [{ id: 'a', enabled: true }] })
  assert.equal(
    report.members.some((x) => x.key === 'dispose'), false,
    'dispose 已移出清单：占一行只为说「没验」，是用篇幅淹掉真问题',
  )
  assert.ok(PROBE_EXCLUDED_MEMBERS.dispose, '要留在「有意不测」名单里，并写清理由')
})

test('必填成员缺失 = fail（插件不完整），可选成员缺失 = absent', async () => {
  const { m } = spyModule(['status', 'listModels'])  // 缺 chatOnce/dispose，也缺全部可选
  const report = await probeSupplier(loaded(m))
  const chatOnce = report.members.find((x) => x.key === 'chatOnce')
  assert.equal(chatOnce?.state, 'fail', '必填成员缺失要报 fail')
  assert.equal(report.members.find((x) => x.key === 'checkinNow')?.state, 'absent', '可选成员缺失只是 absent')
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

/* ---------------- 核心侧：模型启用/禁用只「报」不「改」 ---------------- */

test('核心区：「全部启用/全部禁用」实跑，并如实写「拿不到」而不是冒充 0', async () => {
  const { m } = spyModule(SUPPLIER_CONTRACT_MEMBERS.map((x) => x.key))
  const withModels = await probeSupplier(loaded(m), { models: [
    { id: 'a', enabled: true }, { id: 'b', enabled: true }, { id: 'c', enabled: false },
  ] })
  assert.deepEqual(withModels.core.models, { total: 3, enabled: 2, disabled: 1 })

  const without = await probeSupplier(loaded(m))
  assert.equal(without.core.models.total, null, '拿不到就是 null，不能当成 0 个模型')
  assert.match(without.core.models.note ?? '', /拿不到|不可用/)
  assert.equal(without.core.operations[0]?.ran, false, '拿不到模型时这一项不跑')
})

test('核心区：全部启用/禁用是真跑的（不是只报可用性）', async () => {
  const { m } = spyModule(SUPPLIER_CONTRACT_MEMBERS.map((x) => x.key))
  const calls: string[] = []
  const report = await probeSupplier(loaded(m), {
    models: [{ id: 'a', enabled: true }, { id: 'b', enabled: true }],
    runBulkToggleRoundTrip: async () => { calls.push('bulk'); return { ok: true, detail: '全部禁用后 2 个模型都在' } },
  })
  assert.deepEqual(calls, ['bulk'], '这条必须真跑 —— 它是唯一能抓出越权的路径')
  const bulk = report.core.operations.find((o) => o.key === 'models.bulk')
  assert.equal(bulk?.ran, true)
  assert.equal(bulk?.ok, true)
})

test('核心区：全部启用/禁用实跑发现问题 = 报出来（Loomy 那种）', async () => {
  const { m } = spyModule(SUPPLIER_CONTRACT_MEMBERS.map((x) => x.key))
  const report = await probeSupplier(loaded(m), {
    models: [{ id: 'a', enabled: true }],
    runBulkToggleRoundTrip: async () => ({ ok: false, detail: '全部禁用之后只剩 0/1 个模型 —— 插件把已禁用的藏起来了' }),
  })
  const bulk = report.core.operations.find((o) => o.key === 'models.bulk')
  assert.equal(bulk?.ok, false, '必须报出问题')
  assert.match(bulk?.detail ?? '', /藏起来了/)
  assert.equal(report.summary.bulk, 'fail', '核心区实跑失败要能被数字看见（不是只藏在 detail 里）')
})

test('status 的账号摘要给真实数量与状态分布（链接全过期正是要靠它看出来）', async () => {
  const { m } = spyModule(['status'])
  m.status = () => ({ id: 'spy', name: 'Spy', accounts: [
    { uid: 'a', credits: 0, state: 'ok' },
    { uid: 'b', credits: 0, state: 'ok' },
    { uid: 'c', credits: 0, state: 'session_dead' },
  ] })
  const report = await probeSupplier(loaded(m))
  const status = report.members.find((x) => x.key === 'status')
  assert.equal(status?.state, 'ok')
  assert.match(status?.detail ?? '', /3 个账号/, '要给真实数量，不是「≥1」')
  assert.match(status?.detail ?? '', /session_dead 1/, '要把失效的号点出来')
})

/* ---------------- 单档全自动：能跑的都跑，跑不了的写清为什么 ---------------- */

test('不测的成员不会被调用（就算插件实现了）', async () => {
  const { m, called } = spyModule([...SUPPLIER_CONTRACT_MEMBERS.map((x) => x.key), ...Object.keys(PROBE_EXCLUDED_MEMBERS)])
  await probeSupplier(loaded(m), { models: [{ id: 'a', enabled: true }] })
  for (const key of Object.keys(PROBE_EXCLUDED_MEMBERS)) {
    assert.equal(called.includes(key), false, `${key} 说好不测，就不该被调用`)
  }
})

test('单档全自动：chatOnce 真跑一次（前提是调用方给了 runChatOnce）', async () => {
  const { m, called } = spyModule(SUPPLIER_CONTRACT_MEMBERS.map((x) => x.key))
  const tried: string[] = []
  const report = await probeSupplier(loaded(m), {
    models: [{ id: 'm1', enabled: true }, { id: 'm2', enabled: true }],
    runChatOnce: async (model) => { tried.push(model); return { ok: true, detail: '通了' } },
  })
  assert.deepEqual(tried, ['m1'], '用第一个已启用的模型真跑')
  const chat = report.members.find((x) => x.key === 'chatOnce')
  assert.equal(chat?.executed, 'ran')
  assert.equal(chat?.state, 'ok')
  assert.match(chat?.detail ?? '', /真实调用 m1/)
  assert.equal(called.includes('chatOnce'), false, '走的是核心 testModel 那条真实路径，不该直调插件的 chatOnce')
})

test('chatOnce 跑不通就是 fail（出厂体检最该抓住的就是这个）', async () => {
  const { m } = spyModule(SUPPLIER_CONTRACT_MEMBERS.map((x) => x.key))
  const report = await probeSupplier(loaded(m), {
    models: [{ id: 'm1', enabled: true }],
    runChatOnce: async () => ({ ok: false, detail: '401 unauthorized' }),
  })
  const chat = report.members.find((x) => x.key === 'chatOnce')
  assert.equal(chat?.state, 'fail')
  assert.ok(report.summary.fail > 0, 'listModels 越权要计入失败数')
})

test('单档全自动：checkinNow 对连接池里的真实连接真签到', async () => {
  const seen: string[] = []
  const { m } = spyModule(SUPPLIER_CONTRACT_MEMBERS.map((x) => x.key))
  m.status = () => ({ id: 'spy', name: 'Spy', accounts: [{ uid: 'u1', credits: 0, state: 'ok' }] })
  m.checkinNow = (uid: string) => { seen.push(uid); return Promise.resolve({ ok: true, status: 'ok' }) }
  const report = await probeSupplier(loaded(m), { models: [{ id: 'm1', enabled: true }] })
  assert.deepEqual(seen, ['u1'], '用连接池里第一个真实连接')
  assert.equal(report.members.find((x) => x.key === 'checkinNow')?.executed, 'ran')
})

test('dispose 一次都不被调用（哪怕它实现了）', async () => {
  const { m, called } = spyModule([...SUPPLIER_CONTRACT_MEMBERS.map((x) => x.key), 'dispose'])
  await probeSupplier(loaded(m), { models: [{ id: 'a', enabled: true }] })
  assert.equal(called.includes('dispose'), false, '调用 dispose 就是把这个供应商卸载掉')
})

test('没有 token / 没有模型时，数字要如实说「未验」而不是「通过」', async () => {
  const full = spyModule(SUPPLIER_CONTRACT_MEMBERS.map((x) => x.key))
  full.m.checkinNow = (uid: string) => Promise.resolve({ ok: true, status: 'ok' })
  // 假模块没有 runChatOnce → chatOnce 无法验证 → 记 unverified
  const noAccount = await probeSupplier(loaded(full.m), { models: [{ id: 'm1', enabled: true }] })
  assert.equal(noAccount.summary.unverified, 1, '没条件验就是未验，不能混进通过里')
  assert.equal(noAccount.members.find((x) => x.key === 'chatOnce')?.state, 'unverified')

  const withToken = await probeSupplier(loaded(full.m), {
    models: [{ id: 'm1', enabled: true }],
    runChatOnce: async () => ({ ok: true, detail: '通了' }),
  })
  assert.equal(withToken.summary.unverified, 0, '有 token 且全跑通 → 没有未验项')
  assert.equal(withToken.summary.fail, 0)

  const missing = spyModule(['status', 'listModels'])
  const m = await probeSupplier(loaded(missing.m), { models: [] })
  assert.ok(m.summary.fail > 0, '必填成员缺失要体现在失败数里')
})

test('summary.ran 只数真的跑过的成员（清单里全部实跑）', async () => {
  const { m } = spyModule(SUPPLIER_CONTRACT_MEMBERS.map((x) => x.key))
  const report = await probeSupplier(loaded(m), { models: [{ id: 'a', enabled: true }] })
  assert.equal(report.summary.ran, report.summary.total,
    '清单里的成员一律实跑（会毁掉前提的早已移出清单），所以 ran 应等于 total')
})

