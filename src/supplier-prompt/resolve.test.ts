/**
 * 供应商提示词的纯逻辑测试 —— 「这一轮用谁的提示词」与「怎么放」。
 *
 * 这里能测的只有判断逻辑；`section()` 真被宿主如何装配、同名覆盖是否生效，
 * 只有真宿主能证（见本文件末尾的 ⚠️ 说明）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HARNESS_IDENTITY_ORDER,
  HARNESS_IDENTITY_SECTION,
  HARNESS_IDENTITY_TEXT,
  pickPrompt,
  placementOf,
  type PromptSupplierCandidate,
} from './resolve.ts'

const suppliers: PromptSupplierCandidate[] = [
  { id: 'alpha', prompt: '你是 Alpha。' },
  { id: 'beta', prompt: '' },
  { id: 'gamma', prompt: '  你是 Gamma。  ' },
]

test('取上一轮命中的供应商提示词', () => {
  assert.equal(pickPrompt('alpha', suppliers), '你是 Alpha。')
})

test('去掉首尾空白（面板里手滑拍的空格/换行不该进 system）', () => {
  assert.equal(pickPrompt('gamma', suppliers), '你是 Gamma。')
})

test('★ 命中没配提示词的供应商 ⇒ 返回空（回到宿主原样）', () => {
  assert.equal(pickPrompt('beta', suppliers), '')
})

test('★ 不退回「别的供应商的提示词」——命中 A 却用 B 的身份比用默认更糟', () => {
  // beta 没配，但列表里 alpha 配了。绝不能 fallback 到 alpha 的提示词：
  // 模型会自称成另一个供应商的形态。
  assert.equal(pickPrompt('beta', suppliers), '')
})

test('没有命中记录（首轮 / 刚启动）⇒ 空', () => {
  assert.equal(pickPrompt(undefined, suppliers), '')
  assert.equal(pickPrompt('', suppliers), '')
})

test('命中的供应商已不在活跃集合里（被关掉/卸载）⇒ 空', () => {
  assert.equal(pickPrompt('ghost', suppliers), '')
})

test('空提示词 ⇒ 不注册任何东西（none）', () => {
  assert.deepEqual(placementOf(''), { kind: 'none' })
  assert.deepEqual(placementOf(undefined), { kind: 'none' })
  assert.deepEqual(placementOf('   \n\t '), { kind: 'none' })
})

test('有提示词 ⇒ 放到 harness:identity 的位置', () => {
  assert.deepEqual(placementOf('你是 Alpha。'), { kind: 'identity', text: '你是 Alpha。' })
  // 首尾空白在这里也去掉，保证进 system 的是干净文本
  assert.deepEqual(placementOf('  你是 Alpha。  '), { kind: 'identity', text: '你是 Alpha。' })
})

test('★ 段名与 order 必须与宿主 harness:identity 完全一致（同名才顶得掉）', () => {
  // 这两个常量是"覆盖而不是并排"的全部依据：
  //   - 名字不同 ⇒ 宿主那句还在，我们变成第二段（用户看到两套身份）
  //   - order 不同 ⇒ 位置漂移，提示词跑到工具说明后面去了
  assert.equal(HARNESS_IDENTITY_SECTION, 'harness:identity')
  assert.equal(HARNESS_IDENTITY_ORDER, -1000)
  assert.equal(HARNESS_IDENTITY_TEXT, 'You are an AI agent powered by DeepSeek Harness.')
})

/* ------------------------------------------------------------------ */
/* ⚠️ 无法在这里验证的部分                                            */
/* ------------------------------------------------------------------ */
/*
 * 以下是本测试文件**证明不了**的，必须真宿主跑：
 *
 *   1. 同名 section 真的顶掉了宿主那段，而不是并排出两段。
 *      依据只有 `dsh-system-prompt` 的源码注释（"a scoped section shadows a
 *      global section with the same name"）+ 它自己用同一手法做 persona 替换。
 *      **没有实测**。
 *   2. `includeHarnessIdentity:false` 时我们的段仍出现在最前。
 *      （我们没读那个配置，靠"同名占位 + 回落原句"绕开，理论上两种开关都成立。）
 *   3. provider 函数在**多会话并发**下取到的是哪个会话的命中。
 *      当前实现用 `router.usage.lastHit()`（全局最近一条）——单会话精确，
 *      team 多会话下可能取到别的会话的供应商。这是**已知近似**，见 index.ts
 *      挂载处的注释。
 */
