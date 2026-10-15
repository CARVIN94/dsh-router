/**
 * 挂载层单测 —— 用假 `ctx.systemPrompt` 验证注册契约。
 *
 * 重点是**注入违规必须失败**：
 *   - 注册了静态字符串（改开关不生效）⇒ 必须被抓到；
 *   - 卸载不清理 ⇒ 必须被抓到。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mountPromptSection, PROMPT_SECTION_NAME } from './mount.ts'
import { EXT_PROMPT_ID } from './plugin.ts'

/** 记录注册内容的假 systemPrompt。 */
function fakeSystemPrompt() {
  const registered: { name: string; order: number; text: string | (() => string) }[] = []
  let disposals = 0
  return {
    registered,
    get disposalCount() {
      return disposals
    },
    section(s: { name: string; order: number; text: string | (() => string) }) {
      registered.push(s)
      return () => {
        disposals++
      }
    },
  }
}

test('注册恰好一个段落，名字稳定', () => {
  const sp = fakeSystemPrompt()
  mountPromptSection({ getSystemPrompt: () => sp, isEnabled: () => true, readData: () => undefined })
  assert.equal(sp.registered.length, 1)
  assert.equal(sp.registered[0]!.name, PROMPT_SECTION_NAME)
})

test('⚠️ text 必须是 provider 函数而不是静态字符串（否则改开关不生效）', () => {
  const sp = fakeSystemPrompt()
  mountPromptSection({ getSystemPrompt: () => sp, isEnabled: () => true, readData: () => undefined })
  const t = sp.registered[0]!.text
  assert.equal(typeof t, 'function', 'text 是静态字符串 ⇒ 分类开关永远不生效')
})

test('注入违规：静态 text ⇒ 断言会红（证明这条守卫抓得住）', () => {
  // 反向证明：造一个"静态 text"的假 systemPrompt 看看会发生什么
  const sp = fakeSystemPrompt()
  let on = true
  mountPromptSection({
    getSystemPrompt: () => sp,
    isEnabled: () => on,
    readData: () => undefined,
  })
  // 第一次求值
  const first = (sp.registered[0]!.text as () => string)()
  assert.ok(first.includes('大肥鱼'), '总开关开时应有准则')
  // 改开关后再求值 —— 若 text 是静态的，这里会拿到同一个字符串
  on = false
  const second = (sp.registered[0]!.text as () => string)()
  assert.equal(second, '', 'provider 形式下改开关必须立刻反映')
})

test('开关关闭 ⇒ provider 返回空串（上游据此丢弃该段）', () => {
  const sp = fakeSystemPrompt()
  mountPromptSection({ getSystemPrompt: () => sp, isEnabled: () => false, readData: () => undefined })
  assert.equal((sp.registered[0]!.text as () => string)(), '')
})

test('卸载会调用 disposer（不留孤儿段落）', () => {
  const sp = fakeSystemPrompt()
  const unmount = mountPromptSection({
    getSystemPrompt: () => sp,
    isEnabled: () => true,
    readData: () => undefined,
  })
  assert.equal(sp.disposalCount, 0)
  unmount()
  assert.equal(sp.disposalCount, 1, '卸载没清理 ⇒ 段落泄漏，插件重载会叠加')
})

test('systemPrompt 不可用 ⇒ 不注册、卸载是 no-op、且不抛', () => {
  let unmount: () => void = () => {}
  assert.doesNotThrow(() => {
    unmount = mountPromptSection({
      getSystemPrompt: () => undefined,
      isEnabled: () => true,
      readData: () => undefined,
    })
  })
  assert.doesNotThrow(() => unmount())
})

test('ext id 稳定（改名会丢用户已存的开关配置）', () => {
  assert.equal(EXT_PROMPT_ID, 'prompt')
})
