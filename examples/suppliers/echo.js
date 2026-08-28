// 示例自定义供应商 —— 复制到 ~/.dsh/profiles/web/suppliers/echo.js 即可加载。
// 只写差异化核心(状态/模型/chat 转发/模型测试)。
// 连接池由「添加链接」(generateLoginUrl) 控制显示——本示例没有,所以面板不显示连接池;
// 模型启用/禁用、别名、签到规则、凭证存储是通用能力,由 dsh-router 核心统一管,js 不用写。
export const id = 'echo'
export const name = 'Echo'
export const priority = 10

const accounts = [{ uid: 'echo-1', nickname: 'Echo 1', credits: 100, cooling: false, disabled: false }]

export function status() { return { id, name, accounts } }
export function listModels() { return [{ id: 'echo-model' }] }
export function getAlias() { return 'echo' }

// testModel 是必要差异化能力(必须实现),用于验证上游真实可用
export async function testModel(id) { return { ok: true } }

export function chatCompletions(req, res) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'echo reply' } }] }))
  return Promise.resolve(true)
}

export function dispose() {}
