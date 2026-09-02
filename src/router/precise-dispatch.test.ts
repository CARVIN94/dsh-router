/**
 * 精准调度测试 —— 组合调用不该挨个问供应商「这是不是你的模型」。
 * 存储格式 = `supplierId,modelId`，对外展示/调用 = `alias/model`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ServerResponse } from 'node:http'
import { Router } from './index.ts'
import type { ModelInfo } from './types.ts'
import { AccountPool } from './account-pool.ts'
import { SupplierConfigStore } from '../supplier-config.ts'
import type { AccountPool as Pool } from './account-pool.ts'
import type { ChatOnceResult, SupplierAccountNow, SupplierStatusNow } from '../suppliers/contract.ts'

interface Spy {
  /** chatOnce 被调用的次数 */
  calls: number
  /** 每次被调用的模型名 */
  seen: string[]
  s: {
    id: string
    name: string
    priority: number
    pool: Pool
    status: () => SupplierStatusNow
    listModels: () => Promise<ModelInfo[]>
    modelsWithEnabled: () => Promise<Array<ModelInfo & { enabled: boolean }>>
    getAlias: () => string
    accounts: () => SupplierAccountNow[]
    chatOnce: (uid: string, req: { rawBody: string }) => Promise<ChatOnceResult>
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
      getAlias: () => alias,
      accounts: () => [{ uid: `${id}-u1`, credits: 0, state: 'ok' }],
      chatOnce: async (_uid, req) => {
        calls.n += 1
        const m = (JSON.parse(req.rawBody) as { model?: string }).model ?? ''
        seen.push(m) // 记核心传来的**原样**全名，剥前缀是插件内部的事
        // 真实插件会先剥掉自己的 alias 再认模型（各 suppliers/*/plugin.ts
        // 都有一份 stripAlias）；这里照做，否则直接调用路径永远匹配不上。
        const base = m.startsWith(`${alias}/`) ? m.slice(alias.length + 1) : m
        if (base !== modelId) return { ok: false, state: 'no_such_model', message: `unknown model ${m}` }
        return { ok: true, status: 200, body: '{"ok":1}' }
      },
      dispose: () => {},
    },
  }
}

/** 走真实注册路径（router.add 内部会 sync 已知 id，别名校验才能生效）。 */
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

test('组合只调目标供应商，其它供应商一次都不会被问', async () => {
  const router = new Router('')
  const a = spy('supA', 'a-model')
  const b = spy('supB', 'b-model')
  const c = spy('supC', 'c-model')
  add(router, a.s); add(router, b.s); add(router, c.s)
  assert.equal(router.createCombo('my-combo', 'fallback', ['supB,b-model']).ok, true, '组合必须创建成功')

  await router.chatCompletions(reqWith('my-combo'), fakeRes())

  assert.equal(b.calls, 1, '目标供应商被调用')
  assert.equal(a.calls, 0, '无关供应商不该被问')
  assert.equal(c.calls, 0, '无关供应商不该被问')
  assert.deepEqual(b.seen, ['b-model'], '插件收到的是自己的模型 id')
})

test('直接调 alias/model：用别名反查供应商，精准命中', async () => {
  const router = new Router('')
  const a = spy('supA', 'a-model', 'aaa')
  const b = spy('supB', 'b-model', 'bbb')
  add(router, a.s); add(router, b.s)

  await router.chatCompletions(reqWith('bbb/b-model'), fakeRes())

  assert.equal(b.calls, 1)
  assert.equal(a.calls, 0, '别名唯一，不该误命中别的供应商')
  assert.deepEqual(b.seen, ['bbb/b-model'], '核心原样传全名，剥前缀是插件自己的事')
})

test('同名模型不串台：两个供应商都有 gpt，各调各的', async () => {
  const router = new Router('')
  const a = spy('supA', 'gpt', 'aaa')
  const b = spy('supB', 'gpt', 'bbb')
  add(router, a.s); add(router, b.s)

  await router.chatCompletions(reqWith('bbb/gpt'), fakeRes())

  assert.equal(b.calls, 1)
  assert.equal(a.calls, 0, 'supA 也有 gpt，但别名没指向它就不该被调用')
})

test('模型 id 含斜杠时不被吃掉（如 deepseek-ai/xxx）', async () => {
  const router = new Router('')
  const a = spy('supA', 'deepseek-ai/deepseek-v3', 'aaa')
  add(router, a.s)

  await router.chatCompletions(reqWith('aaa/deepseek-ai/deepseek-v3'), fakeRes())

  assert.equal(a.calls, 1)
  // 核心原样传，插件只剥第一段（别名），命名空间保留
  assert.deepEqual(a.seen, ['aaa/deepseek-ai/deepseek-v3'])
})

test('旧数据裸模型 id 仍能工作（降级为遍历）', async () => {
  const router = new Router('')
  const a = spy('supA', 'a-model')
  const b = spy('supB', 'b-model')
  add(router, a.s); add(router, b.s)
  // 模拟旧存储：裸 id，没有 supplierId 前缀
  ;(router as unknown as { customCombos: Array<{ id: string; name: string; strategy: 'fallback'; models: string[] }> })
    .customCombos.push({ id: 'legacy', name: 'legacy', strategy: 'fallback', models: ['b-model'] })

  await router.chatCompletions(reqWith('legacy'), fakeRes())

  assert.equal(a.calls, 1, '降级路径会先问 supA（它报 no_such_model）')
  assert.equal(b.calls, 1, '最终由 supB 服务')
})

test('组合存了不存在的供应商 id → 调用失败，不静默落到别的供应商', async () => {
  const router = new Router('')
  const a = spy('supA', 'a-model')
  add(router, a.s)
  assert.equal(router.createCombo('broken', 'fallback', ['ghost,a-model']).ok, true, '组合必须创建成功')

  const errs: unknown[] = []
  const res = { ...fakeRes(), end: (b?: string): unknown => { if (b) errs.push(b); return undefined } } as unknown as ServerResponse
  await router.chatCompletions(reqWith('broken'), res)

  assert.equal(a.calls, 0, '不该兜底落到 supA')
  assert.equal(errs.length, 1, '应返回失败响应')
})

test('别名唯一性：冲突拒绝，自己改自己不冲突', () => {
  const store = new SupplierConfigStore('')   // 不落盘
  const router = new Router('', store)
  const a = spy('supA', 'a-model')
  const b = spy('supB', 'b-model')
  add(router, a.s); add(router, b.s)          // add() 会 sync 已知 id

  assert.equal(store.setAlias('supA', 'taken').ok, true)
  assert.equal(store.setAlias('supB', 'taken').ok, false, '别名冲突应拒绝')
  assert.equal(store.setAlias('supA', 'taken').ok, true, '自己改自己不算冲突')
  // 空别名 = 用供应商 id（默认值），且同样参与唯一性
  assert.equal(store.setAlias('supB', '').ok, true)
  assert.equal(store.get('supB').alias, '')
})

test('别名冲突时返回占用者，便于面板提示', () => {
  const store = new SupplierConfigStore('')
  const router = new Router('', store)
  add(router, spy('supA', 'a-model').s)
  add(router, spy('supB', 'b-model').s)

  store.setAlias('supA', 'shared')
  const r = store.setAlias('supB', 'shared')
  assert.equal(r.ok, false)
  assert.equal(r.conflictWith, 'supA')
})

test('空别名 → 生效别名回落到供应商 id', () => {
  const store = new SupplierConfigStore('')
  const router = new Router('', store)
  add(router, spy('supA', 'a-model').s)

  assert.equal(store.effectiveAliases().get('supA'), 'supA', '没设别名时 = 供应商 id')
  store.setAlias('supA', 'custom')
  assert.equal(store.effectiveAliases().get('supA'), 'custom')
})

/**
 * 为什么要有这一组：用量统计记的 model 名曾把 alias 前缀套了两层
 * （`tx/tx/hy4-preview`、`trae/trae/DeepSeek-V4-Flash-Official`）。
 *
 * 成因：直接调 `alias/model` 时核心**原样**把全名传给插件（剥前缀是插件
 * 的活，见上面那条断言），但记 `probe.model` 时又拼了一次 `${alias}/`
 * ——于是统计里出现双前缀。功能不受影响（插件拿到的名字是对的），但
 * Top 榜会把同一个模型**分裂成两行**（`tx/hy4-preview` 和
 * `tx/tx/hy4-preview` 各占一行），看板数据失真。
 */
test('用量统计：直接调 alias/model 时 model 名不重复套前缀', async () => {
  const router = new Router('')
  const b = spy('supB', 'b-model', 'bbb')
  add(router, b.s)

  await router.chatCompletions(reqWith('bbb/b-model'), fakeRes())

  const rec = router.usage.recentList(1)[0]
  assert.equal(rec?.model, 'bbb/b-model', '统计名必须是 alias/model，不能是 alias/alias/model')
})

test('用量统计：组合里的裸 id 仍记成 alias/model（旧行为不变）', async () => {
  const router = new Router('')
  const b = spy('supB', 'b-model', 'bbb')
  add(router, b.s)

  await router.chatCompletions(reqWith('b-model'), fakeRes())

  const rec = router.usage.recentList(1)[0]
  assert.equal(rec?.model, 'bbb/b-model', '裸 id 要补上 alias 前缀，否则 Top 榜分裂')
})
