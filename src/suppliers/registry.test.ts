/**
 * 签到汇聚（POST /suppliers/:id/checkin）契约测试 —— node --test 直接跑（Node 24 原生剥 TS 类型）。
 *
 * 锁定的契约：checkinNow 是**单账号**能力，遍历所有链接 + 汇总是核心的活：
 *   - 禁用链接不签（不动它）
 *   - 某个链接抛错 → 记成 error，不带垮其它链接
 *   - succeeded / already / failed 按 status 统计
 *   - **ok = 全部链接都成功（含已签）**；有任一失败 → HTTP 400 + ok:false，
 *     让面板把失败如实亮出来（2026-09-02 修正：旧口径「有任一成功就算 ok」
 *     会把部分失败吞成整体成功，UI 谎报「签到完成」）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { supplierRoutes } from './registry.ts'
import type { SupplierConfigStore } from '../supplier-config.ts'

type CheckinResult = { uid: string; ok: boolean; status: string; message?: string }

/** 最小假 res：只接住 writeJson 写出的状态码与 JSON body。 */
function fakeRes(): { status: number; body: unknown; res: never } {
  const out = { status: 0, body: undefined as unknown }
  const res = {
    writeHead(status: number): void {
      out.status = status
    },
    end(payload: string): void {
      out.body = JSON.parse(payload)
    },
  }
  return { get status() { return out.status }, get body() { return out.body }, res: res as never }
}

type FakeAccount = { uid: string; disabled?: boolean; credits?: number }

/** 造一个只带 checkinNow 的假供应商：status() 返回账号列表，checkinNow 按 uid 应答。
 *  accounts 可传函数（每次 status() 重新求值，用来模拟插件后台异步刷积分）。 */
function fixture(
  accounts: FakeAccount[] | (() => FakeAccount[]),
  checkinNow: (uid: string) => Promise<{ ok: boolean; status: string; message?: string }>,
): never {
  const list = (): FakeAccount[] => (typeof accounts === 'function' ? accounts() : accounts)
  const supplier = {
    id: 'fake',
    name: 'fake',
    status: () => ({
      id: 'fake',
      name: 'fake',
      accounts: list().map((a) => ({
        uid: a.uid,
        nickname: a.uid,
        credits: a.credits ?? 0,
        cooling: false,
        disabled: a.disabled ?? false,
        err_count: 0,
      })),
    }),
    __module: { checkinNow },
  }
  return { supplier, capabilities: new Set(['checkinNow']), source: 'builtin' } as never
}

/** 打到某条路由上，返回 { status, body }。B 是期望的响应体形状（让 tsc 真检查）。 */
async function post<B>(loaded: never, path: string): Promise<{ status: number; body: B }> {
  const routes = supplierRoutes('/router/api', loaded, {} as SupplierConfigStore, {} as never)
  const route = routes.find((r) => r.path === `/router/api/suppliers/fake/${path}`)
  assert.ok(route, `${path} 路由应注册`)
  const sink = fakeRes() // getter 延迟读，不能解构
  await route!.handler({} as never, sink.res)
  return { status: sink.status, body: sink.body as B }
}

/** 跑到 /checkin 路由上，返回 { status, body }。 */
async function postCheckin(loaded: never): Promise<{ status: number; body: CheckinPayload }> {
  return await post<CheckinPayload>(loaded, 'checkin')
}

/** POST /links/refresh 的响应体。 */
interface RefreshPayload {
  ok: boolean
  changed: boolean
  accounts: Array<{ uid: string; credits: number }>
  error?: string
}

interface CheckinPayload {
  ok: boolean
  total: number
  succeeded: number
  already: number
  failed: number
  results?: CheckinResult[]
  error?: string
}

test('签到：遍历所有链接，逐个调 checkinNow(uid)', async () => {
  const seen: string[] = []
  const { status, body } = await postCheckin(
    fixture([{ uid: 'a' }, { uid: 'b' }], async (uid) => {
      seen.push(uid)
      return { ok: true, status: 'ok', message: '+100 积分' }
    }),
  )
  assert.deepEqual(seen, ['a', 'b'])
  assert.equal(status, 200)
  assert.deepEqual(
    { ok: body.ok, total: body.total, succeeded: body.succeeded, already: body.already },
    { ok: true, total: 2, succeeded: 2, already: 0 },
  )
  assert.deepEqual(body.results?.map((r) => r.uid), ['a', 'b'])
})

test('签到：禁用链接照样签（禁用由插件自己判定，核心不筛）', async () => {
  const seen: string[] = []
  const { body } = await postCheckin(
    fixture([{ uid: 'a', disabled: true }, { uid: 'b' }], async (uid) => {
      seen.push(uid)
      // 插件（如 traework）自己会对禁用链接返回 status:'disabled'
      return uid === 'a' ? { ok: false, status: 'disabled', message: '链接已禁用' } : { ok: true, status: 'ok' }
    }),
  )
  assert.deepEqual(seen, ['a', 'b'])
  assert.equal(body.total, 2)
  assert.equal(body.succeeded, 1)
  assert.equal(body.results?.[0]?.status, 'disabled')
})

test('签到：单链接抛错记成 error 不连坐；有失败 → 400 不算整体成功', async () => {
  const { status, body } = await postCheckin(
    fixture([{ uid: 'a' }, { uid: 'b' }], async (uid) => {
      if (uid === 'a') throw new Error('boom')
      return { ok: true, status: 'ok' }
    }),
  )
  // 有任一失败整体就不是 ok（否则 UI 会谎报「签到完成」）——a 的错照记，不连坐 b
  assert.equal(status, 400)
  assert.equal(body.ok, false)
  assert.equal(body.succeeded, 1)
  assert.equal(body.failed, 1)
  assert.equal(body.results?.[0]?.status, 'error')
  assert.equal(body.results?.[0]?.message, 'boom')
  assert.equal(body.results?.[1]?.status, 'ok')
})

test('签到：全部成功（含 already）才算整体 ok', async () => {
  const { status, body } = await postCheckin(
    fixture([{ uid: 'a' }, { uid: 'b' }], async (uid) =>
      uid === 'a' ? { ok: true, status: 'ok', message: '+200' } : { ok: true, status: 'already', message: '今日已签到' },
    ),
  )
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.succeeded, 1)
  assert.equal(body.already, 1)
  assert.equal(body.failed, 0)
})

test('签到：今日已签（already）算成功，不计入 succeeded', async () => {
  const { status, body } = await postCheckin(
    fixture([{ uid: 'a' }], async () => ({ ok: true, status: 'already', message: '今日已签到' })),
  )
  assert.equal(status, 200)
  assert.deepEqual({ ok: body.ok, succeeded: body.succeeded, already: body.already }, { ok: true, succeeded: 0, already: 1 })
})

test('签到：全失败 → 400；无链接 → total 0 且 ok false', async () => {
  const fail = await postCheckin(fixture([{ uid: 'a' }], async () => ({ ok: false, status: 'error', message: '凭证失效 401' })))
  assert.equal(fail.status, 400)
  assert.equal(fail.body.ok, false)
  const empty = await postCheckin(fixture([], async () => ({ ok: true, status: 'ok' })))
  assert.equal(empty.status, 400)
  assert.equal(empty.body.total, 0)
})

test('刷新：等后台积分落地后返回最新快照（changed=true）', async () => {
  // 模拟插件 fire-and-forget 刷积分：第 2 次 status() 起才带上新值
  let ticks = 0
  const { status, body } = await post<RefreshPayload>(
    fixture(() => [{ uid: 'a', credits: ticks++ >= 2 ? 120 : 0 }], async () => ({ ok: true, status: 'ok' })),
    'links/refresh',
  )
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.changed, true)
  assert.equal(body.accounts[0]?.credits, 120)
})

test('刷新：快照稳定就早退，不死等超时', async () => {
  const started = Date.now()
  const { status, body } = await post<RefreshPayload>(
    fixture([{ uid: 'a', credits: 7 }], async () => ({ ok: true, status: 'ok' })),
    'links/refresh',
  )
  assert.equal(status, 200)
  assert.equal(body.changed, false)
  assert.equal(body.accounts[0]?.credits, 7)
  // settleStatus 稳定 2 次即 break（~600ms），远小于 3s 超时
  assert.ok(Date.now() - started < 2000, `刷新不该等满超时，实际 ${Date.now() - started}ms`)
})

test('刷新：status() 抛错 → 500 带错误信息', async () => {
  const supplier = {
    id: 'fake',
    name: 'fake',
    status: (): never => { throw new Error('status boom') },
    __module: { checkinNow: async () => ({ ok: true, status: 'ok' }) },
  }
  const { status, body } = await post<RefreshPayload>(
    { supplier, capabilities: new Set(['checkinNow']), source: 'builtin' } as never,
    'links/refresh',
  )
  assert.equal(status, 500)
  assert.equal(body.ok, false)
  assert.match(body.error ?? '', /status boom/)
})
