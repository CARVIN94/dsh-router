/**
 * 改写判据测试 —— 锁定「识别宿主提示」与「不自激」两条。
 *
 * 为什么要有：这个改写是按文案指纹认领宿主 DOM（见 model-hint-copy.ts）。
 * 判据写错有两种坏法：漏认（提示原样留着）和自激（改完又被自己判定为需要改，
 * 观察器反复触发）。两条都是纯函数可测的。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { routerHintRewrite, ROUTER_MODEL_HINT_COPY } from './model-hint-copy.ts'

test('认出宿主提示（中/英两种文案 + 命名空间指纹）', () => {
  const zh = '其余字段在 settings.yaml 中，请直接编辑对应段。 (dsh-router)'
  const en = 'Other fields live in settings.yaml; edit that section directly. (dsh-router)'
  assert.equal(routerHintRewrite(zh), ROUTER_MODEL_HINT_COPY)
  assert.equal(routerHintRewrite(en), ROUTER_MODEL_HINT_COPY)
})

test('别的 provider 的同类提示不动（指纹只属于 Router）', () => {
  const deepseek = '其余字段在 settings.yaml 中，请直接编辑对应段。 (llm-deepseek)'
  assert.equal(routerHintRewrite(deepseek), undefined)
})

test('旧命名空间指纹不再认领 —— 0.1.7 起宿主渲染的是行 id', () => {
  const legacy = '其余字段在 settings.yaml 中，请直接编辑对应段。 (llm-dsh-router)'
  assert.equal(routerHintRewrite(legacy), undefined)
})

test('已是目标文案时早退 —— 观察器不自激', () => {
  assert.equal(routerHintRewrite(ROUTER_MODEL_HINT_COPY), undefined)
})

test('无关段落一律不动', () => {
  assert.equal(routerHintRewrite(''), undefined)
  assert.equal(routerHintRewrite('配置 DeepSeek 官方模型，即可开始使用。'), undefined)
})
