/**
 * `router.ext` 工具委派的纯逻辑测试 —— node --test 直接跑。
 *
 * 锁定的契约:
 *   - 只在「核心已开启 + 插件 ready」的扩展器里找能改写的
 *   - 开关归核心(isEnabled 回调),就绪归插件(getState().ready)
 *   - 取第一个命中的;无改写/全跳过 → undefined
 *   - 扩展器 rewrite / getState 抛错都不影响后续(跳过继续找)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { firstRewrite } from './proxy.ts'
import type { RouterExt, RouterExtService } from './contract.ts'

function ext(partial: Partial<RouterExt>, id = 'x'): RouterExt {
  return {
    id,
    name: id,
    rewrite: () => ({ rewritten: null }),
    getState: () => ({ ready: true }),
    ...partial,
  }
}

function service(...exts: RouterExt[]): RouterExtService {
  const s: RouterExtService = {}
  for (const e of exts) s[e.id] = e
  return s
}

/** 全开(核心一律允许)。 */
const allOn = (): boolean => true
/** 全关。 */
const allOff = (): boolean => false

test('已开启 + ready 且能改写 → 返回改写', () => {
  const s = service(ext({ rewrite: () => ({ rewritten: 'rtk git status' }) }))
  assert.deepEqual(firstRewrite(s, 'git status', allOn), { rewritten: 'rtk git status' })
})

test('无改写 → undefined', () => {
  const s = service(ext({ rewrite: () => ({ rewritten: null }) }))
  assert.equal(firstRewrite(s, 'ls', allOn), undefined)
})

test('核心未开启 → 被跳过(即使插件 ready)', () => {
  const s = service(ext({
    getState: () => ({ ready: true }),
    rewrite: () => ({ rewritten: 'SHOULD NOT' }),
  }))
  assert.equal(firstRewrite(s, 'ls', allOff), undefined)
})

test('插件未就绪(ready=false)被跳过', () => {
  const s = service(ext({
    getState: () => ({ ready: false, detail: '本机未装 rtk' }),
    rewrite: () => ({ rewritten: 'SHOULD NOT' }),
  }))
  assert.equal(firstRewrite(s, 'ls', allOn), undefined)
})

test('取第一个命中的扩展器', () => {
  const s = service(
    ext({ id: 'a', rewrite: () => ({ rewritten: null }) }),
    ext({ id: 'b', rewrite: () => ({ rewritten: 'rtk git log' }) }),
    ext({ id: 'c', rewrite: () => ({ rewritten: 'SHOULD NOT' }) }),
  )
  assert.deepEqual(firstRewrite(s, 'git log', allOn), { rewritten: 'rtk git log' })
})

test('rewrite 抛错 → 跳过继续找下一个', () => {
  const s = service(
    ext({ id: 'a', rewrite: () => { throw new Error('boom') } }),
    ext({ id: 'b', rewrite: () => ({ rewritten: 'rtk pwd' }) }),
  )
  assert.deepEqual(firstRewrite(s, 'pwd', allOn), { rewritten: 'rtk pwd' })
})

test('getState 抛错 → 跳过继续找下一个', () => {
  const s = service(
    ext({ id: 'a', getState: () => { throw new Error('boom') } }),
    ext({ id: 'b', rewrite: () => ({ rewritten: 'rtk pwd' }) }),
  )
  assert.deepEqual(firstRewrite(s, 'pwd', allOn), { rewritten: 'rtk pwd' })
})

test('只按 id 问开关:第二个开着就命中第二个', () => {
  const s = service(
    ext({ id: 'a', rewrite: () => ({ rewritten: 'A' }) }),
    ext({ id: 'b', rewrite: () => ({ rewritten: 'B' }) }),
  )
  assert.deepEqual(firstRewrite(s, 'ls', (id) => id === 'b'), { rewritten: 'B' })
})

test('空的表 → undefined', () => {
  assert.equal(firstRewrite(service(), 'ls', allOn), undefined)
})
