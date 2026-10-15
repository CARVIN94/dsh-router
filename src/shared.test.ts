/**
 * 外部 OpenAI 客户端归因标签（clientIdentityOf）的闸门。
 *
 * 2026-10-15 事故反查暴露的盲区：`/v1` 没有宿主内部头的请求全落成匿名
 * usage 记录（296 条对不上任何会话）。这里锁住三级兜底的优先级与边界。
 * 用 node --test 跑（Node 原生 TS 剥离，零新依赖）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clientIdentityOf } from './shared.ts'

test('归因优先级：user > prompt_cache_key > User-Agent', () => {
  assert.equal(clientIdentityOf({ user: 'zed-thread-1', prompt_cache_key: 'k' }, 'Zed/0.2'), 'ext/user:zed-thread-1')
  assert.equal(clientIdentityOf({ prompt_cache_key: 'k1' }, 'Zed/0.2'), 'ext/cache:k1')
  assert.equal(clientIdentityOf({}, 'Zed/0.2'), 'ext/ua:Zed/0.2')
  assert.equal(clientIdentityOf({}, undefined), undefined, '什么都没有 → 保持匿名')
})

test('空串/非字符串的 user 与 prompt_cache_key 当没有，落 UA 兜底', () => {
  assert.equal(clientIdentityOf({ user: '' }, 'Zed/0.2'), 'ext/ua:Zed/0.2')
  assert.equal(clientIdentityOf({ user: 123 }, 'Zed/0.2'), 'ext/ua:Zed/0.2')
  assert.equal(clientIdentityOf({ user: '', prompt_cache_key: '' }, ''), undefined)
})

test('值截断到 64 字符（防超长标识灌进 usage 记录）', () => {
  const long = 'x'.repeat(100)
  assert.equal(clientIdentityOf({ user: long }, undefined), `ext/user:${'x'.repeat(64)}`)
  assert.equal(clientIdentityOf({}, long), `ext/ua:${'x'.repeat(64)}`)
})

test('宿主会话 id 形态与外部标签形态不撞（lastHit 过滤互不误命中）', () => {
  const host = 'session-72847baa-e309-42ad-aa6b-15107cdc6518'
  const ext = clientIdentityOf({ user: '72847baa-e309-42ad-aa6b-15107cdc6518' }, undefined)
  assert.notEqual(ext, host, '前缀区分宿主/外部，精确匹配过滤不会串')
})
