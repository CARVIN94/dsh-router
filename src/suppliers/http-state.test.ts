/**
 * HTTP 状态码 → AccountState 公共映射测试。
 *
 * 存在的原因：这条映射曾在内置三家供应商里各写一份，于是「哪个错误算账号的错」
 * 有三份实现——bad_request 加固差点只补上 codebuddy，三家内置仍是 4xx→unknown
 * →瞬冷 30s（同型事故）。收敛成一处后，这一份测试同时守住三家。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stateFromHttpStatus } from './http-state.ts'

test('映射：账号侧错误（换号会好的）归各自的冷却状态', () => {
  assert.equal(stateFromHttpStatus(429), 'rate_limit', '限流 = 换号有用')
  assert.equal(stateFromHttpStatus(401), 'session_dead', '凭证失效')
  assert.equal(stateFromHttpStatus(403), 'session_dead', '403 分不清死活与风控，按连接级冷却')
  assert.equal(stateFromHttpStatus(402), 'quota', '要钱/额度不足')
  assert.equal(stateFromHttpStatus(404), 'unavailable', '上游没有这个端点/服务下线')
})

test('映射：请求侧 4xx 归 bad_request —— 同一个请求对每个号都一样失败，不该冷号', () => {
  for (const status of [400, 405, 409, 413, 422, 499]) {
    assert.equal(stateFromHttpStatus(status), 'bad_request', `${status} 是请求形态问题，不是账号的错`)
  }
})

test('映射：5xx 与异常码仍归 unknown（上游故障侧，瞬冷换号是对的）', () => {
  for (const status of [500, 502, 503, 504, 599]) {
    assert.equal(stateFromHttpStatus(status), 'unknown', `${status} 是上游故障`)
  }
})

test('映射：绝不返回 ok —— 这个函数只在非 2xx 分支被调用', () => {
  for (const status of [400, 401, 402, 403, 404, 429, 500]) {
    assert.notEqual(stateFromHttpStatus(status), 'ok')
  }
})
