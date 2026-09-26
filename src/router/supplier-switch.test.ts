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

// ---- 指定连接自检（插件自检面板的连接测试用它） ----
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
