/**
 * 挂载层的测试 —— 注册了什么段、provider 返回什么、卸载是否干净。
 *
 * 用假的 `systemPrompt`，所以验的是「我们向宿主提出了什么要求」，
 * 不是「宿主照做之后长什么样」（后者只有真宿主能证）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mountSupplierPrompt, SUPPLIER_PROMPT_SECTION } from './mount.ts'
import { HARNESS_IDENTITY_ORDER, HARNESS_IDENTITY_TEXT } from './resolve.ts'

interface Registered {
  name: string
  order: number
  text: string | (() => string)
  disposed: boolean
}

function fakeSystemPrompt(): { registered: Registered[]; section: (s: { name: string; order: number; text: string | (() => string) }) => () => void } {
  const registered: Registered[] = []
  return {
    registered,
    section(s) {
      const entry: Registered = { ...s, disposed: false }
      registered.push(entry)
      return () => { entry.disposed = true }
    },
  }
}

test('注册段名 = 宿主的 harness:identity（同名才顶得掉）', () => {
  const sp = fakeSystemPrompt()
  mountSupplierPrompt({ getSystemPrompt: () => sp, currentPrompt: () => '' })
  assert.equal(sp.registered.length, 1)
  assert.equal(sp.registered[0]!.name, SUPPLIER_PROMPT_SECTION)
  assert.equal(sp.registered[0]!.name, 'harness:identity')
})

test('order 用宿主给这个位置的原值', () => {
  const sp = fakeSystemPrompt()
  mountSupplierPrompt({ getSystemPrompt: () => sp, currentPrompt: () => '' })
  assert.equal(sp.registered[0]!.order, HARNESS_IDENTITY_ORDER)
})

test('⚠️ text 必须是 provider 函数（值会定格在注册那一刻）', () => {
  const sp = fakeSystemPrompt()
  mountSupplierPrompt({ getSystemPrompt: () => sp, currentPrompt: () => '' })
  assert.equal(typeof sp.registered[0]!.text, 'function')
})

test('provider 每次调用都现算（改提示词无需重注册）', () => {
  const sp = fakeSystemPrompt()
  let current = '你是 Alpha。'
  mountSupplierPrompt({ getSystemPrompt: () => sp, currentPrompt: () => current })
  const text = sp.registered[0]!.text as () => string
  assert.equal(text(), '你是 Alpha。')
  current = '你是 Beta。'
  assert.equal(text(), '你是 Beta。', '改值没生效 ⇒ 提示词被定格了')
})

test('★ 没有提示词时回落成**宿主原句**，不是空串', () => {
  // 关键：我们占用了 harness:identity 这个名字，返回空串会把宿主的开场白
  // 一起摘掉（同名覆盖是整段替换）。空档期（首轮 / 刚清空）用户预期是
  // 「回到原样」，不是「身份行消失」。
  const sp = fakeSystemPrompt()
  mountSupplierPrompt({ getSystemPrompt: () => sp, currentPrompt: () => '' })
  const text = sp.registered[0]!.text as () => string
  assert.equal(text(), HARNESS_IDENTITY_TEXT)
})

test('只有空白也算没配 ⇒ 回落原句', () => {
  const sp = fakeSystemPrompt()
  mountSupplierPrompt({ getSystemPrompt: () => sp, currentPrompt: () => '   \n  ' })
  const text = sp.registered[0]!.text as () => string
  assert.equal(text(), HARNESS_IDENTITY_TEXT)
})

test('systemPrompt 不可用 ⇒ 不挂、不抛（返回 no-op）', () => {
  const dispose = mountSupplierPrompt({ getSystemPrompt: () => undefined, currentPrompt: () => 'x' })
  assert.equal(typeof dispose, 'function')
  dispose() // 不该抛
})

test('卸载会真的 dispose 掉注册', () => {
  const sp = fakeSystemPrompt()
  const dispose = mountSupplierPrompt({ getSystemPrompt: () => sp, currentPrompt: () => '' })
  assert.equal(sp.registered[0]!.disposed, false)
  dispose()
  assert.equal(sp.registered[0]!.disposed, true)
})
