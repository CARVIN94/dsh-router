# 供应商开发

供应商是可插拔 js 模块,只提供**差异化能力**。写好放到
`~/.dsh/profiles/web/suppliers/*.js`,重启后自动加载,出现在「路由系统 → 供应商」。

## 分工:策略归核心,js 只管单账户

这是整个契约的地基,写 js 前先认清边界:

| | 谁负责 |
|---|---|
| 组合回退、按策略选中模型 | 核心 |
| **账号池**:选号、冷却、禁用、连续错误累计、遍历回退 | 核心 |
| 响应写入(状态行、SSE 头、JSON body) | 核心 |
| 模型启用/禁用、自定义模型、别名 | 核心 |
| 凭证存储(`env.credentials`) | 核心 |
| **对单个账号调通上游**(协议、鉴权、SSE 解析/生成) | **js** |
| 列模型、登录、加 key、删链接、签到、拉积分 | **js** |

关键推论:**js 不遍历账号、不维护冷却表、不写 `res`**。
`chatOnce(uid, req)` 一次只服务一个账号,成败告诉核心,换不换号由核心决定。
这样「哪个账号坏了」「为什么坏」是核心的一等信息,组合回退才做得了判断。

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
| `status()` | 报账号**现在状态**:`{ id, name, accounts: [{ uid, nickname, credits, state }] }` |
| `listModels(force?)` | `[{ id, context_length? }]`;`force=true` 时强制刷新来源(「获取模型」按钮调用) |
| `getAlias()` | 默认前缀 = 供应商 id(模型全名 = alias/id,别名留空即用 id) |
| `chatOnce(uid, req)` | **对单个账号调一次上游**,见下 |
| `dispose()` | 停止时清理 |

### 可选(差异化)

| 方法 | 作用 |
|---|---|
| `generateLoginUrl()` / `completeLogin(callbackUrl)` | 添加链接(有它才显示连接池) |
| `addApiKey({ name, apiKey })` / `removeLink(uid)` | API key 账号:弹窗填名字 + key;删除链接清凭证 |
| `pollLogin()` | 轮询式登录:面板隐藏「粘贴回调链接」步骤,登录后直接点完成 |
| `checkinNow(uid)` | 单个链接签到(核心遍历所有链接 + 汇总),见下 |
| `lastError()` | 上次 `chatOnce` 的失败原因(诊断用) |

凭证(token)由核心统一存储,js 通过 `env.credentials`(list/get/save/remove)访问。

## `status()`:报「现在状态」,不报冷却

js 报告**此刻**观察到的账户状况,而不是把上游原始响应丢给核心解读:

```ts
{ uid, nickname?, credits: number, state: AccountState, message? }
```

`AccountState` 是 js **解读**上游信号后的语义值:

| state | 含义 |
|---|---|
| `ok` | 正常 |
| `rate_limit` | 限流(429 类) |
| `quota` | 额度/权益不足 |
| `session_dead` | 凭证彻底失效,必须重新登录才能恢复 |
| `unavailable` | 上游不可用(404 / 服务下线) |
| `transport` | 网络/连接层失败(没拿到 HTTP 状态) |
| `unknown` | 说不清是什么错 |
| `no_such_model` | **这个模型不属于本供应商**(不是账号的失败) |

**`no_such_model` 是必须的,不能拿 `unavailable` 顶替。** 后者在核心策略里
会计一次连续错误——组合里每有一个别人家的模型,就会给无关账号攒一次错误,
攒够 3 次把它冷却 10 分钟,表现为「组合越用越没号可用」。所以「这个模型不属于我」
一定要报 `no_such_model`,核心才知道该换供应商而不是换账号。

**js 只说「现在怎么了」,不说「该怎么办」。** 冷却多久、是否禁用、要不要换号
都是核心的策略(见下),js 不该自己记冷却表——那样每个插件都会长出一份
互相不一致的实现。

核心在 `status()` 之上叠加 `cooling` / `disabled` / `err_count` / `until` / `reason`
再给面板,所以 js 不用(也不该)填这些字段。`accounts` 为空数组 = 无账号供应商。

## `chatOnce(uid, req)`:一次只服务一个账号

```ts
type ChatOnceResult =
  | { ok: true; stream: ReadableStream<Uint8Array> }   // 流式
  | { ok: true; status: number; body: string }         // 非流式
  | { ok: false; state: AccountState; message: string } // 失败
```

要点:

- **不写 `res`**。响应写入归核心。流式时 js 把上游协议**转成 OpenAI SSE** 后把流
  交回来(格式转换是上游协议细节,归 js;写响应是策略,归核心)
- **不遍历账号、不 `continue` 换号**。核心按 `poolOrder` + `poolStrategy` 选号,
  拿到 `{ ok:false }` 自己决定下一个试谁
- 失败时给 `state`,核心按它处置:

| state | 核心处置 |
|---|---|
| `rate_limit` | 冷却 1 分钟 |
| `quota` | 冷却 10 分钟 |
| `session_dead` | **永久禁用**(需重新登录才能恢复) |
| `unavailable` / `transport` / `unknown` | 计一次连续错误,攒够 3 次冷却 10 分钟 |
| `no_such_model` | **不惩罚账号**,核心直接跳过整个供应商换下一个 |

- 非流式若聚合后发现**空响应**(无 content / reasoning / tool_calls),请返回
  `{ ok:false, state:'unknown' }` 而不是 `ok:true`——空响应交给核心换号/换模型回退,
  比当作成功更有用

冷却/禁用/错误累计目前是**内存态**,重启归零(与凭证/积分的持久化不同)。
要跨重启保留,届时给账号池加一个落盘 state 文件即可,接口不用变。

### 流式一旦开始就绑死

写了 SSE 响应头就没法再换号了——HTTP 语义如此,换任何实现都一样。
所以核心拿到 `ok:true` 的流即视为该账号成功,流中途出错只能作用于**后续**请求。
要让「上游吐空」也能回退,必须在写响应头前缓冲判定,代价是首字节延迟,
目前没做。**这条是组合在流式下无法回退空响应的根因。**

## 测试模型(核心通用,js 不实现)

面板「测试」由核心统一处理:构造最小 ping 请求,走**真实的 `chatOnce` 路径**
(账号池回退/冷却自动生效),响应写进丢弃用的 sink。js 不需要(也不应该)自己
实现一份测试逻辑——只跑第一个账号的那种实现会分不清「这个账号额度没了」和
「这个模型真的不支持」。

判定:`chatOnce` 成功**且** sink 里状态码 < 400 才算通过。失败时错误来源优先级:
sink 里的上游错误 → `lastError()`。

js 只需把失败原因记下来并通过 `lastError()` 暴露,核心就能给出「额度/限流问题」
还是「模型不支持」这类可诊断提示。前置校验(模型不属于本供应商)也建议写进
`lastError`(如 `unknown model "xxx"`),否则用户只看到模糊的通用提示。

## 签到与积分(可选)

有 `checkinNow(uid)` 时面板才显示「签到」按钮。**js 只签一个 uid**,遍历所有
链接 + 结果汇总是核心的活。单个 uid 返回:

```ts
{ ok, status, message? }
```

- `status`:`'ok'`(签到成功)/ `'already'`(今日已签到)/ `'error'`(失败)
- **禁用与否由 js 自己判定**:核心遍历**所有**链接(不替 js 筛),
  js 对不可用链接自己回一个非成功 status
- `message` 直接透给用户看;某个 uid 抛错由核心兜住记成 `error`,不会带垮其它链接
- 核心汇总后给面板:`{ ok, total, succeeded, already, results }`

`credits`(`status().accounts[].credits`)用于面板显示积分/额度;上游接口不实时时
建议缓存 + 签到后刷新。**填「剩余额度」而不是「已消耗」**——额度类接口两者常常
都有,填反了面板数字会越用越多。

上游幂等要处理好:有的上游「今日已签到」返回 **HTTP 400 + 业务 code**,
所以要先解析 body 的 code 再判 HTTP 状态,否则幂等情况会被误报成失败。

## 刷新链接池(核心通用,js 不实现)

面板链接池的「刷新」按钮是核心的活,js 不用做任何事:

1. **积分**:核心连着调 `status()` 等它落地;`status().accounts[].credits`
   该缓存就缓存,不该缓存就现拉,核心只认这个字段
2. **健康**:核心拿一个启用模型跑一次最简会话(复用「测试模型」的 `chatOnce`
   路径),回答「这个供应商还有没有活着的链接」——**不按链接细分**

天花板与升级路径:刷新积分目前是**轮询等落地**(js 缓存没过期时不会真拉上游,
此时按钮退化成「重读一次状态」)。哪天 js 愿意暴露可 `await` 的刷新能力,
这里就不用轮询了。

## 示例

```js
// ~/.dsh/profiles/web/suppliers/echo.js
export const id = 'echo'
export const name = 'Echo'
export const priority = 10

// 只报「现在状态」:冷却/禁用/错误累计由核心叠加
const accounts = [{ uid: 'echo-1', nickname: 'Echo 1', credits: 100, state: 'ok' }]

export function status() { return { id, name, accounts } }
export function listModels() { return [{ id: 'echo-model' }] }
export function getAlias() { return 'echo' }

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
```

## 加载顺序

1. 内置:`<plugin>/lib/suppliers/*.js`(随插件分发)
2. 用户:`~/.dsh/profiles/web/suppliers/*.js`(**覆盖**内置同 id)
3. 外部插件:其他 DSH 插件通过 cordis service `router.suppliers`
   (值为 `{ [supplierId]: (env) => SupplierModule }`)暴露供应商,dsh-router
   `ctx.inject(['router.suppliers'])` 延迟加载(service 可用即注册)。
   cordis 的 `provide` 每个 service name 只允许一个插件提供,多个供应商插件采用
   **共享表模式**:先 provide 的插件持有聚合表对象,
   其余插件 **`inject` 后把工厂追加进同一对象**并广播一次
   `internal/service`,dsh-router 的处理器按 live 表读取且幂等,追加即可增量加载。

单个供应商加载失败(缺 `id`/`name`、构造异常)不阻断其他供应商,错误记入 DSH 日志。

**模型统一策略**:供应商的模型列表**优先从上游拉取、不自行缓存**——
`listModels` 每次都从上游拉取(失败回退上次成功结果避免面板空模型),**缓存由
核心统一管**(`Router.modelsOf`,TTL 60s)。

这意味着 **js 的 `listModels` 会被核心频繁调用**,所以:

- 只有这两种场景会真的打到上游:**首次打开供应商详情**(缓存还没建)和
  **手动点「获取模型」**(`force=true`)。组合面板只**读缓存**,不触发拉取
- 因此 `listModels` 要**快**:别在里面做全量探测之类的重活。重活放到
  `force=true` 时做(如按模型探测可用性),别拖慢每次只读
- 失败时回退上次成功的结果,避免面板空模型

`/suppliers/:id/models` 与 `/combos` 共用这份缓存(模型增删改后失效),
`/v1/models`(LLM 侧)保持实时。

**例外**:上游没有公开 models 接口的供应商,`listModels` 直接返回一份内置列表
(取自官方客户端/实测记录),用户仍可在面板手动添加自定义模型。


## 模型全名与组合存储

**对外**(用户看到的、路由收到的)是 `alias/model`；**存储**是 `supplierId,modelId`。
两者由核心换算,js 和面板都不需要关心存储细节。

- **别名唯一**:改别名时核心拒绝与其它供应商冲突(含默认值)。别名是对外模型
  全名的前缀,请求时靠它反查供应商,重复就会指错人
- **别名留空** = 用供应商 id(默认值)。所以默认全名形如 `opencode/xxx`
- **组合存 `supplierId,modelId`**:路由时直接定位供应商,不再挨个问
  「这是不是你的模型」——既快,也避免同名模型串台(两个供应商都有 `gpt`)

### 为什么组合要存供应商 id 而不是裸模型 id

存裸 id 时,核心只能遍历所有供应商逐个试。插件用 `unavailable` 回答
「不是我的」,而这个状态在池策略里**计一次连续错误**——组合里每有一个别人家的
模型就给无关账号攒一次,攒够 3 次冷却 10 分钟,表现为「组合越用越没号可用」。

存了供应商 id 就不需要问了:直接调那一个。查不到供应商(拼错/供应商没加载)
直接失败,**不兜底遍历**——兜底会让拼错的 id 静默落到别的供应商上,更难查。
