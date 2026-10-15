// 示例自定义供应商 —— 复制到 ~/.dsh/profiles/web/suppliers/echo.js 即可加载。
// 只写差异化能力(状态/模型/单账号 chat)。
//
// 分工:dsh-router 核心管策略(组合回退、账号池选号、冷却、禁用、错误累计、
// 响应写入);js 只管「对**单个账号**调通上游」并报告结果。
// 模型启用/禁用、别名、凭证存储也是通用能力,js 不用写。
export const id = 'echo'
export const name = 'Echo'
export const priority = 10

// 账号「现在状态」:js 只报它观察到的(state 见契约的 AccountState),
// 冷却/禁用/错误累计由核心叠加,js 不算这些。
const accounts = [{ uid: 'echo-1', nickname: 'Echo 1', credits: 100, state: 'ok' }]

export function status() { return { id, name, accounts } }
export function listModels() { return [{ id: 'echo-model' }] }
export function getAlias() { return 'echo' }

/**
 * 对单个账号调一次上游(核心遍历账号后才调到这里)。
 * 成功返回 { ok:true, stream } 或 { ok:true, status, body };
 * 失败返回 { ok:false, state, message } —— 核心据此冷却/禁用/换号。
 * 注意:不要自己写 res,响应写入归核心。
 */
export async function chatOnce(uid, req) {
  if (req.stream) {
    const text = 'data: ' + JSON.stringify({
      id: 'echo', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
      model: req.model, choices: [{ index: 0, delta: { content: `echo reply (${uid})` } }],
    }) + '\n\ndata: [DONE]\n\n'
    return { ok: true, stream: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close() } }) }
  }
  return {
    ok: true,
    status: 200,
    body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: `echo reply (${uid})` } }] }),
  }
}

export function dispose() {}
