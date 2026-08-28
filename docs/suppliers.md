# 供应商开发

供应商是可插拔 js 模块,只提供**差异化能力**。写好放到
`~/.dsh/profiles/web/suppliers/*.js`,重启后自动加载,出现在「路由系统 → 供应商」。

通用能力(连接池/模型管理/别名/签到规则/凭证存储等)由 dsh-router 核心统一管,js 不用写。

## 契约

ESM 模块,export 一个对象(或 default export):

```js
export const id = 'myprovider'    // 唯一 id(小写字母数字 - _)
export const name = 'My Provider' // 显示名
export const priority = 10        // 数字越小越优先(免费优先)
```

### 必须

| 方法 | 说明 |
|---|---|
| `status()` | `{ id, name, accounts: [{ uid, nickname, credits, cooling, until, reason, disabled, err_count }] }` |
| `listModels(force?)` | `[{ id, context_length? }]`,模型来源;`force=true` 时强制刷新来源(「获取模型」按钮调用) |
| `getAlias()` | 默认前缀(模型全名 = alias/id) |
| `testModel(id)` | `{ ok, error? }`,验证上游可用(缺它加载失败) |
| `chatCompletions(req, res)` | 处理 `/v1/chat/completions`,写 res 后返回 `true`;无健康账号返回 `false` 让路由器轮换 |
| `dispose()` | 停止时清理 |

### 可选(差异化)

| 方法 | 作用 |
|---|---|
| `generateLoginUrl()` / `completeLogin(callbackUrl)` | 添加链接(有它才显示连接池) |
| `checkinNow()` | 触发签到(规则由 dsh-router 通用层指定) |

删除链接、获取模型、签到规则不需要 js 实现:它们是 dsh-router 的通用数据/策略能力
(获取模型 = 调 `listModels(true)` + 核心数据操作)。
凭证(token)由 dsh-router 核心统一存储,js 通过 `env.credentials`(list/get/save/remove)访问。

## 示例

```js
// ~/.dsh/profiles/web/suppliers/echo.js
export const id = 'echo'
export const name = 'Echo'
export const priority = 10

const accounts = [{ uid: 'echo-1', nickname: 'Echo 1', credits: 100, cooling: false, disabled: false }]

export function status() { return { id, name, accounts } }
export function listModels() { return [{ id: 'echo-model' }] }
export function getAlias() { return 'echo' }
export async function testModel(id) { return { ok: true } }

export function chatCompletions(req, res) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'echo reply' } }] }))
  return Promise.resolve(true)
}

export function dispose() {}
```

## 加载顺序

1. 内置:`<plugin>/lib/suppliers/*.js`(随插件分发,含 `opencode.js`、`openrouter.js`)
2. 用户:`~/.dsh/profiles/web/suppliers/*.js`(**覆盖**内置同 id)
3. 外部插件:其他 DSH 插件通过 cordis service `router.suppliers`
   (值为 `{ [supplierId]: (env) => SupplierModule }`)暴露供应商,dsh-router
   `ctx.inject(['router.suppliers'])` 延迟加载(service 可用即注册)。
   cordis 的 `provide` 每个 service name 只允许一个插件提供,多个供应商插件采用
   **共享表模式**:先 provide 的插件持有聚合表对象,
   其余插件 **`inject` 后把工厂追加进同一对象**并广播一次
   `internal/service`,dsh-router 的处理器按 live 表读取且幂等,追加即可增量加载。

加载失败(如缺 `testModel`)不阻断其他供应商,错误记入 DSH 日志。

**模型统一策略**:所有供应商(内置 + 外部插件)的模型列表**都不内置、不自行缓存**——
`listModels` 每次都从上游拉取(失败回退上次成功结果避免面板空模型),**缓存由
dsh-router 核心统一管**:`/suppliers/:id/models` 端点(registry)按 60s TTL 缓存
`listModels` 结果,模型增删改后失效缓存。`/v1/models`(LLM 侧)保持实时。

内置 `opencode.js` 是**无账号免费直连**供应商的参考实现:无账号/凭证/连接池/签到
(capabilities 为空),`listModels` 从上游拉取并过滤免费模型,
`chatCompletions` 直接透传上游(SSE 流式透传 + 非流式 JSON)。

内置 `openrouter.js` 是 **API key 账号**供应商:走「添加链接 + 连接池」模型,
添加链接弹窗填**名字 + API key**(而非 URL 登录),一个供应商可有多个命名 key。
凭证存通用 CredentialStore(SQLite:`{authDir}/credentials.sqlite`,表 `credentials(supplier, uid, data)`,凭证为不透明 JSON blob,`{ name, apiKey }`),
添加时用 `GET /api/v1/key` 验证 key 有效性(无效 401 拒绝)。
`listModels` 从上游拉取并过滤免费模型(`pricing` 全 0 且 context ≥ 200k),
`chatCompletions` 按连接池顺序尝试健康 key(失败冷却 60s,全失败返回 false 触发路由器 fallback)。

内置 `nvidia.js` 是 **API key 账号**供应商(同 openrouter 模式):「添加链接 + 连接池」,
添加链接弹窗填**名字 + API key**,凭证存通用 CredentialStore(SQLite,同 openrouter,`{ name, apiKey }`)。
`listModels` 从上游 `/v1/models` **全量拉取**(公开无鉴权,不过滤),
key 有效性用 chat 探测(无 key → 400,无效 → 401,有效 → 200),
`chatCompletions` 按连接池顺序尝试健康 key(失败冷却 60s,全失败返回 false 触发 fallback)。

