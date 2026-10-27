/**
 * 供应商开关测试 —— 锁住「关掉 = 真的不参与路由」，而且是**全部入口**都拦。
 *
 * 为什么要有这个文件：这个开关的唯一实现是 `Router` 里的活跃集合
 * （`active` = 装载清单里开关为开的那一份）。而路由有 15 处读供应商清单，
 * 少收一处就出现「面板显示已关闭、请求照样打过去」——那是最坏的一种：开关说了
 * 假话，用户以为断了流量其实在烧额度。所以这里逐个入口钉住：
 *
 *   1. 组合腿（`supplierId,modelId` 形态）
 *   2. 直调（`alias/model` 形态）
 *   3. 模型目录 / 别名前缀（关掉的不能留下「前缀存在但必然 503」的死前缀）
 *   4. status() 仍带出关掉的（否则关掉后就没法再开，开关失去对象）
 *   5. 关掉不能连带卸载（`removeSupplier` 是插件卸载用的另一码事）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { ServerResponse } from 'node:http'
import { Router } from './index.ts'
import type { ModelInfo } from './types.ts'
import { AccountPool } from './account-pool.ts'
import { SupplierConfigStore } from '../supplier-config.ts'
import type { AccountPool as Pool } from './account-pool.ts'
import type { ChatOnceResult, SupplierAccountNow, SupplierStatusNow } from '../suppliers/contract.ts'

interface Spy {
  calls: number
  seen: string[]
  s: {
    id: string
    name: string
    priority: number
    pool: Pool
    status: () => SupplierStatusNow
    listModels: () => Promise<ModelInfo[]>
    modelsWithEnabled: () => Promise<Array<ModelInfo & { enabled: boolean }>>
    customModelIds: () => string[]
    getAlias: () => string
    accounts: () => SupplierAccountNow[]
    chatOnce: (uid: string, lv: string, req: { rawBody: string }) => Promise<ChatOnceResult>
    dispose: () => void
  }
}

/** 带探针的供应商：只服务自己的模型，记录被问过什么。 */
function spy(id: string, modelId: string, alias = id): Spy {
  const calls = { n: 0 }
  const seen: string[] = []
  return {
    get calls() { return calls.n },
    seen,
    s: {
      id, name: id, priority: 0, pool: new AccountPool(),
      status: () => ({ id, name: id, accounts: [{ uid: `${id}-u1`, credits: 0, state: 'ok' }] }),
      listModels: async () => [{ id: modelId }],
      modelsWithEnabled: async () => [{ id: modelId, enabled: true }],
      customModelIds: () => [`${id}-custom`],
      getAlias: () => alias,
      accounts: () => [{ uid: `${id}-u1`, credits: 0, state: 'ok' }],
      chatOnce: async (_uid, _lv, req) => {
        calls.n += 1
        const m = (JSON.parse(req.rawBody) as { model?: string }).model ?? ''
        seen.push(m)
        const base = m.startsWith(`${alias}/`) ? m.slice(alias.length + 1) : m
        if (base !== modelId) return { ok: false, state: 'no_such_model', message: `unknown model ${m}` }
        return { ok: true, status: 200, body: '{"ok":1}' }
      },
      dispose: () => {},
    },
  }
}

function add(router: Router, s: unknown): void {
  router.add(s as Parameters<Router['add']>[0])
}

function fakeRes(): ServerResponse {
  return {
    writeHead: (): unknown => undefined,
    end: (): unknown => undefined,
    write: (): boolean => true,
    once: (): unknown => undefined,
    removeListener: (): unknown => undefined,
    destroy: (): unknown => undefined,
  } as unknown as ServerResponse
}

function reqWith(model: string) {
  return { model, stream: false, rawBody: JSON.stringify({ model, messages: [] }) }
}

/** 路由器 + 共享 store（开关要能从 store 落盘/读回，所以显式传同一个实例）。 */
function rig() {
  const store = new SupplierConfigStore('')
  return { router: new Router('', store, () => {}), store }
}

test('关掉的供应商：组合腿不会打到它（唯一的路由入口之一）', async () => {
  const { router, store } = rig()
  const a = spy('supA', 'a-model')
  const b = spy('supB', 'b-model')
  add(router, a.s); add(router, b.s)
  assert.equal(router.createCombo('c', ['supA,a-model', 'supB,b-model']).ok, true)

  store.setEnabled('supA', false)
  await router.chatCompletions(reqWith('c'), fakeRes())

  assert.equal(a.calls, 0, '已关闭的供应商不该被组合腿问到')
  assert.equal(b.calls, 1, '开着的供应商照常服务')
})

test('关掉的供应商：alias 直调也进不去（第二条入口）', async () => {
  const { router, store } = rig()
  const a = spy('supA', 'a-model', 'aaa')
  add(router, a.s)

  store.setEnabled('supA', false)
  await router.chatCompletions(reqWith('aaa/a-model'), fakeRes())

  assert.equal(a.calls, 0, '已关闭的供应商不该被直调命中')
  assert.equal(router.supplierByAlias('aaa'), undefined, '别名反查也不该命中')
})

test('关掉再打开，路由立刻恢复（开关不是卸载）', async () => {
  const { router, store } = rig()
  const a = spy('supA', 'a-model', 'aaa')
  add(router, a.s)

  store.setEnabled('supA', false)
  assert.equal(a.calls, 0)
  store.setEnabled('supA', true)
  await router.chatCompletions(reqWith('aaa/a-model'), fakeRes())
  assert.equal(a.calls, 1, '重新打开后应当照常服务')
})

test('关掉的供应商仍出现在 status()（关掉后要能再开）且带 enabled=false', () => {
  const { router, store } = rig()
  add(router, spy('supA', 'a-model').s)
  store.setEnabled('supA', false)

  const { suppliers } = router.status()
  assert.equal(suppliers.length, 1, '关掉不等于卸载，列表里还得有它')
  assert.equal(suppliers[0]?.enabled, false)
  assert.equal(router.isEnabled('supA'), false)
})

test('关掉的供应商不留死前缀、不进模型目录（否则是「存在但必然 503」）', async () => {
  const { router, store } = rig()
  add(router, spy('supA', 'a-model', 'aaa').s)
  store.setEnabled('supA', false)

  assert.deepEqual(router.aliases(), [], '关掉的供应商不该再提供模型前缀')
  assert.deepEqual(await router.modelsOf('supA'), [], '关掉的供应商不该还能拉模型')
  const models = await router.listModels()
  assert.equal(
    models.some((m) => m.id.includes('supA-custom')),
    false,
    '关掉的供应商的自定义模型不该进模型目录',
  )
})

test('没记录过的供应商默认开着（升级不把全灭变成全开）', () => {
  const { router } = rig()
  add(router, spy('supA', 'a-model').s)
  assert.equal(router.isEnabled('supA'), true)
})

// ---- 指定连接自检（诊断单个链接到底通不通） ----
// 面板「供应商」详情里的「测试」按钮走账号池（任选可用号、失败自动换号）；
// 面板的连接测试可以**钉死一个连接**，用来诊断单个链接到底通不通。关键性质：
// 指定了连接就**不回退**到别的号，否则「测这个连接」测出来的是另一个号的结果。

test('指定连接：只试这一个连接', async () => {
  const { router } = rig()
  const a = spy('supA', 'a-model')
  a.s.accounts = () => [
    { uid: 'u1', credits: 0, state: 'ok' },
    { uid: 'u2', credits: 0, state: 'ok' },
  ]
  a.s.status = () => ({ id: 'supA', name: 'supA', accounts: a.s.accounts() })
  add(router, a.s)

  const r = await router.testModel('supA', 'a-model', 'u1')
  assert.equal(r.ok, true)
  assert.equal(a.calls, 1, '只该试一次')
})

test('指定连接失败时不回退到别的号（否则诊断结论是假的）', async () => {
  const { router } = rig()
  const a = spy('supA', 'a-model')
  a.s.accounts = () => [
    { uid: 'u1', credits: 0, state: 'ok' },
    { uid: 'u2', credits: 0, state: 'ok' },
  ]
  a.s.status = () => ({ id: 'supA', name: 'supA', accounts: a.s.accounts() })
  // 自己记账：spy 的 calls 计数封在原 chatOnce 里，换掉实现就得自己数。
  const seen: string[] = []
  a.s.chatOnce = async (uid) => {
    seen.push(uid)
    return { ok: false, state: 'transport', message: `link ${uid} down` }
  }
  add(router, a.s)

  const r = await router.testModel('supA', 'a-model', 'u1')
  assert.equal(r.ok, false)
  assert.deepEqual(seen, ['u1'], '失败也不该换号重试')
  assert.match(r.error ?? '', /u1/, '错误信息要点名是哪个连接挂了')
})

test('指定不存在的连接：明确报「连接不存在」，而不是静默测了别的号', async () => {
  const { router } = rig()
  const a = spy('supA', 'a-model')
  a.s.accounts = () => [{ uid: 'u1', credits: 0, state: 'ok' }]
  a.s.status = () => ({ id: 'supA', name: 'supA', accounts: a.s.accounts() })
  add(router, a.s)

  const r = await router.testModel('supA', 'a-model', 'gone')
  assert.equal(r.ok, false)
  assert.equal(a.calls, 0, '一个号都不该被试')
  assert.match(r.error ?? '', /不存在/)
})

test('指定连接失败：报上游真实原因，不许说成「连接不存在」', async () => {
  // 2026-10-14 实测：0 积分号（uid 在池里、面板上看得见）测出来是
  // 「连接 "4135677434275728" 不存在（可能已被删除）」——真话是额度用完。
  // 机制：失败后 `continue`，下一轮 onlyUid 被 `tried` 挡掉 → uid undefined，
  // 旧代码在那里无条件覆盖 lastError，把上游原因冲掉。假诊断比没有诊断更坏：
  // 用户会去删链接、重新登录，而正解是充值。
  const { router } = rig()
  const a = spy('supA', 'a-model')
  a.s.accounts = () => [
    { uid: 'broke', credits: 0, state: 'ok' },
    { uid: 'rich', credits: 100, state: 'ok' },
  ]
  a.s.status = () => ({ id: 'supA', name: 'supA', accounts: a.s.accounts() })
  const seen: string[] = []
  a.s.chatOnce = async (uid) => {
    seen.push(uid)
    return { ok: false, state: 'quota', message: 'Your requests have exceeded the quota.' }
  }
  add(router, a.s)

  const r = await router.testModel('supA', 'a-model', 'broke')
  assert.equal(r.ok, false)
  assert.deepEqual(seen, ['broke'], '钉死单连接，失败也不换号')
  assert.match(r.error ?? '', /quota|exceeded/, `要报上游真因，实际: ${r.error}`)
  assert.doesNotMatch(r.error ?? '', /不存在/, 'uid 在池里，绝不是「不存在」')
})

// ---- 积分用完的号必须退出路由（插件报 quota → 核心不选它） ----
// 端到端串起来：traework 的 pool.list() 在 credits===0 时报 quota，核心 pick()
// 据此跳过该号。这条走真实入口 chatCompletions，钉住「报出的事实真的改变了路由」，
// 而不只是「状态字符串好看」。

test('插件报 quota 的号：请求直接落到还有额度的号，不去撞死号', async () => {
  const { router } = rig()
  const a = spy('supA', 'a-model')
  const tried: string[] = []
  a.s.accounts = () => [
    { uid: 'broke', credits: 0, state: 'quota' },
    { uid: 'rich', credits: 500, state: 'ok' },
  ]
  a.s.status = () => ({ id: 'supA', name: 'supA', accounts: a.s.accounts() })
  a.s.chatOnce = async (uid) => {
    tried.push(uid)
    return { ok: true, status: 200, body: '{"ok":1}' }
  }
  add(router, a.s)

  await router.chatCompletions(reqWith('supA/a-model'), fakeRes())

  assert.deepEqual(tried, ['rich'], '一次都不该撞到积分用完的号')
})

test('积分用完的号恢复（充值后报 ok）：立刻重新参与路由，无需重启', async () => {
  const { router } = rig()
  const a = spy('supA', 'a-model')
  let broke = true
  const tried: string[] = []
  a.s.accounts = () => (broke
    ? [{ uid: 'was-broke', credits: 0, state: 'quota' }, { uid: 'other', credits: 10, state: 'ok' }]
    : [{ uid: 'was-broke', credits: 900, state: 'ok' }])
  a.s.status = () => ({ id: 'supA', name: 'supA', accounts: a.s.accounts() })
  a.s.chatOnce = async (uid) => {
    tried.push(uid)
    return { ok: true, status: 200, body: '{"ok":1}' }
  }
  add(router, a.s)

  await router.chatCompletions(reqWith('supA/a-model'), fakeRes())
  assert.deepEqual(tried, ['other'], '没额度时不选它')

  broke = false
  await router.chatCompletions(reqWith('supA/a-model'), fakeRes())
  assert.equal(tried[1], 'was-broke', '充值后立刻回到候选')
})

test('全池都没额度：如实失败，不假装成功也不无限转圈', async () => {
  const { router } = rig()
  const a = spy('supA', 'a-model')
  a.s.accounts = () => [
    { uid: 'b1', credits: 0, state: 'quota' },
    { uid: 'b2', credits: 0, state: 'quota' },
  ]
  a.s.status = () => ({ id: 'supA', name: 'supA', accounts: a.s.accounts() })
  a.s.chatOnce = async () => ({ ok: true, status: 200, body: '{"ok":1}' })
  add(router, a.s)

  const r = await router.testModel('supA', 'a-model')
  assert.equal(r.ok, false, '没号可选就是失败')
  assert.equal(a.calls, 0, '不该去撞任何一个已知没额度的号')
})
