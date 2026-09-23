/**
 * 积分回灌（loader 层）测试 —— 锁住 2026-09-03 那个 bug：
 *
 * codebuddy 插件只在内存里缓存积分，重启后 status() 报 0（当时还没有 -1 哨兵），
 * 核心又没有持久化 → 面板每次重启都显示 0 积分，而 traework 因为自己落盘
 * state.json 所以有值。现在由核心统一持久化：插件报 -1 就顶上次的缓存。
 *
 * 这里测的是 wrapModule 包装后的 status()（面板真正读的那个）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wrapModule } from './loader.ts'
import { SupplierConfigStore } from '../supplier-config.ts'
import type { CredentialStore } from '../credential-store.ts'
import type { SupplierEnv, SupplierModule, SupplierAccountNow, ChatOnceResult } from './contract.ts'
import type { ChatRequest } from '../router/types.ts'

const UNKNOWN = -1

/** 造一个 env（真实 SupplierConfigStore 落临时目录，CredentialStore 用不着的空壳）。 */
function env(): { env: Parameters<typeof wrapModule>[1]; store: SupplierConfigStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dshr-hydrate-'))
  const stateFile = join(dir, 'state.json')
  const store = new SupplierConfigStore(stateFile)
  return {
    env: { dataDir: dir, log: () => {}, store, credentials: {} as CredentialStore },
    store,
    file: join(dir, 'supplier-config.json'),
  }
}

/**
 * 造一个插件：第 N 次 status() 报什么由脚本决定（模拟「重启后第一次拿不到，
 * 异步拉完才有值」）。
 */
function plugin(id: string, script: Array<SupplierAccountNow[]>): SupplierModule & { calls: () => number } {
  let n = 0
  return {
    calls: () => n,
    id,
    name: id,
    // 脚本放完就停在最后一帧（模拟「第一次还没拉到 → 异步拉完有值」）
    status: () => ({ id, name: id, accounts: script[Math.min(n++, script.length - 1)]! }),
    listModels: () => [],
    getAlias: () => id,
    chatOnce: async (_uid: string, _req: ChatRequest): Promise<ChatOnceResult> => ({ ok: true, status: 200, body: '{}' }),
    dispose: () => {},
  } as unknown as SupplierModule & { calls: () => number }
}

const acct = (uid: string, credits: number): SupplierAccountNow => ({ uid, credits, state: 'ok' })

test('插件报 -1（刚重启还没拉到）→ 顶上次缓存，面板不显示 0', () => {
  const { env: e, store } = env()
  // 先跑一轮拿到真值（模拟上次运行）
  const first = wrapModule(plugin('codebuddy', [[acct('cb-1', 1500)]]), e, 'test')
  assert.equal(first.supplier.status().accounts[0]?.credits, 1500)

  // 再换个实例（模拟重启）：插件报 -1，核心应该顶出 1500
  const restarted = wrapModule(plugin('codebuddy', [[acct('cb-1', UNKNOWN)]]), e, 'test')
  assert.equal(restarted.supplier.status().accounts[0]?.credits, 1500)
  assert.equal(store.getCredits('codebuddy', 'cb-1'), 1500)
})

test('插件报真值 → 缓存被刷新（不是一直吃旧值）', async () => {
  const { env: e, store } = env()
  store.putCredits('codebuddy', 'cb-1', 1500)
  const loaded = wrapModule(plugin('codebuddy', [[acct('cb-1', 900)]]), e, 'test')
  assert.equal(loaded.supplier.status().accounts[0]?.credits, 900)
  assert.equal(store.getCredits('codebuddy', 'cb-1'), 900)
})

test('插件报 0（真用完了）→ 缓存被冲成 0，不被当成未知', async () => {
  const { env: e, store } = env()
  store.putCredits('codebuddy', 'cb-1', 500)
  const loaded = wrapModule(plugin('codebuddy', [[acct('cb-1', 0)]]), e, 'test')
  assert.equal(loaded.supplier.status().accounts[0]?.credits, 0)
  assert.equal(store.getCredits('codebuddy', 'cb-1'), 0)
})

test('从没缓存过 + 插件报 -1 → 就是 -1（面板显示「积分未知」，不编 0）', async () => {
  const { env: e } = env()
  const loaded = wrapModule(plugin('codebuddy', [[acct('cb-1', UNKNOWN)]]), e, 'test')
  assert.equal(loaded.supplier.status().accounts[0]?.credits, UNKNOWN)
})

test('异步落地：第一帧 -1（顶旧值）→ 第二帧真值（覆盖）', async () => {
  const { env: e, store } = env()
  store.putCredits('codebuddy', 'cb-1', 800)
  // 模拟插件 fire-and-forget：第一次 status() 报 -1，异步拉完第二次报真值
  const loaded = wrapModule(plugin('codebuddy', [[acct('cb-1', UNKNOWN)], [acct('cb-1', 1234)]]), e, 'test')
  assert.equal(loaded.supplier.status().accounts[0]?.credits, 800)
  assert.equal(loaded.supplier.status().accounts[0]?.credits, 1234)
  assert.equal(store.getCredits('codebuddy', 'cb-1'), 1234)
})

test('多账号各自独立回灌', async () => {
  const { env: e, store } = env()
  store.putCredits('codebuddy', 'cb-1', 100)
  store.putCredits('codebuddy', 'cb-2', 200)
  const loaded = wrapModule(
    plugin('codebuddy', [[acct('cb-1', UNKNOWN), acct('cb-2', 250)]]),
    e,
    'test',
  )
  const by = new Map(loaded.supplier.status().accounts.map((a) => [a.uid, a.credits]))
  assert.equal(by.get('cb-1'), 100) // 顶缓存
  assert.equal(by.get('cb-2'), 250) // 用真值
})

test('不持久化（store fp 为空）时也不炸', async () => {
  const e = { dataDir: '', log: () => {}, store: new SupplierConfigStore(''), credentials: {} as CredentialStore }
  const loaded = wrapModule(plugin('codebuddy', [[acct('cb-1', 50)]]), e, 'test')
  assert.equal(loaded.supplier.status().accounts[0]?.credits, 50)
})

// ---------------------------------------------------------------------------
// onLateFailure：流式响应已提交后才发现的失败，要落回本供应商的池
// ---------------------------------------------------------------------------

/**
 * 造一个会调用 env.onLateFailure 的插件（模拟 traework 的流式 4008 上报）。
 * 记录它拿到的 env —— 用于验证「factory 先跑、回调后挂」这个顺序下插件仍能用。
 */
function latePlugin(id: string, seen: SupplierEnv[]): SupplierModule {
  let captured: SupplierEnv | undefined
  return {
    id,
    name: id,
    status: () => ({ id, name: id, accounts: [acct('u1', 0), acct('u2', 0)] }),
    listModels: () => [],
    getAlias: () => id,
    chatOnce: async (_uid: string, _req: ChatRequest): Promise<ChatOnceResult> => ({ ok: true, status: 200, body: '{}' }),
    dispose: () => {},
    // 真实插件（traework）在 factory 里存下 env，调用时才读 onLateFailure
    __capture: (env: SupplierEnv) => { captured = env; seen.push(env) },
    __report: (uid: string, model: string) => captured?.onLateFailure?.(uid, model, 'quota', 'boom'),
  } as unknown as SupplierModule
}

test('onLateFailure 挂到 env 上，且冷却作用于本供应商的池（坏号退出选号）', () => {
  const { env: e } = env()
  const seen: SupplierEnv[] = []
  const p = latePlugin('supA', seen)
  const loaded = wrapModule(p, e, 'test')
  assert.notEqual(e.onLateFailure, undefined, 'wrapModule 之后回调已挂上（插件必须调用时才读）')
  // 模拟插件在 factory 里存下 env —— 此刻再读 onLateFailure 才有值
  ;(p as unknown as { __capture(env: SupplierEnv): void }).__capture(e)

  // 上报前：两个号都健康
  const before = loaded.supplier.status().accounts.map((a) => a.cooling)
  assert.deepEqual(before, [false, false])
  // 上报 u1 在模型 m1 上的配额失败
  ;(p as unknown as { __report(uid: string, model: string): void }).__report('u1', 'm1')
  const after = new Map(loaded.supplier.status().accounts.map((a) => [a.uid, a.cooling]))
  assert.equal(after.get('u1'), true, '上报后该号应进入冷却')
  assert.equal(after.get('u2'), false, '冷却是 (模型,号) 粒度，不能连坐同供应商其它号')
  // 且真的退出选号：只剩 u2
  assert.equal(loaded.supplier.pool.pick(loaded.supplier.accounts(), [], 'm1'), 'u2')
  assert.equal(loaded.supplier.pool.pick(loaded.supplier.accounts(), [], 'm2'), 'u1', '换个模型不受影响')
})

test('onLateFailure 不串供应商：各自落到自己的池', () => {
  const { env: ea } = env()
  const { env: eb } = env()
  const loadedA = wrapModule(latePlugin('supA', []), ea, 'testA')
  const loadedB = wrapModule(latePlugin('supB', []), eb, 'testB')
  ea.onLateFailure?.('u1', 'm1', 'quota', 'boom')
  const coolA = new Map(loadedA.supplier.status().accounts.map((a) => [a.uid, a.cooling]))
  const coolB = new Map(loadedB.supplier.status().accounts.map((a) => [a.uid, a.cooling]))
  assert.equal(coolA.get('u1'), true)
  assert.equal(coolB.get('u1'), false, 'A 的失败不能冷到 B 的号')
})

test('onLateFailure 空 uid（无账号供应商）→ 不记，不炸', () => {
  const { env: e } = env()
  const loaded = wrapModule(latePlugin('supA', []), e, 'test')
  assert.doesNotThrow(() => e.onLateFailure?.('', 'm1', 'quota', 'boom'))
  assert.deepEqual(loaded.supplier.status().accounts.map((a) => a.cooling), [false, false])
})
