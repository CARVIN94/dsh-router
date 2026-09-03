# 供应商开发

供应商是可插拔 js 模块,只提供**差异化能力**。写好放到
`~/.dsh/profiles/web/suppliers/*.js`,重启后自动加载,出现在「设置 → 路由 → 供应商」。

## 分工:策略归核心,js 只管单账户

这是整个契约的地基,写 js 前先认清边界:

| | 谁负责 |
|---|---|
| 组合回退、按策略选中模型 | 核心 |
| **账号池**:选号、冷却、禁用、遍历回退 | 核心 |
| 响应写入(状态行、SSE 头、JSON body) | 核心 |
| 模型启用/禁用、自定义模型、别名 | 核心 |
| 凭证存储(`env.credentials`) | 核心 |
| 积分**持久化**(`supplier-config.json` 的 `credits`) | 核心 |
| **对单个账号调通上游**(协议、鉴权、SSE 解析/生成) | **js** |
| 列模型、登录、加 key、删链接、签到、拉积分(只报值,不落盘) | **js** |

关键推论:**js 不遍历账号、不维护冷却表、不写 `res`、不落盘积分**。
`chatOnce(uid, req)` 一次只服务一个账号,成败告诉核心,换不换号由核心决定。
这样「哪个账号坏了」「为什么坏」是核心的一等信息,组合回退才做得了判断。
积分同理:js 报值,核心存。

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
// credits: 剩余额度。拿不到(含不支持积分)报 -1——0 是真值「用完了」,别拿它当未知
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

**`no_such_model` 是必须的,不能拿 `unavailable` 顶替。** 后者在核心策略里会
把**这个号 × 这个模型**冷掉——组合里每有一个别人家的模型,js 就会对每个账号
都报一次,于是一个都选不出来(表现为「组合越用越没号可用」)。所以「这个模型
不属于我」一定要报 `no_such_model`,核心才知道该换供应商而不是换账号。

**js 只说「现在怎么了」,不说「该怎么办」。** 冷却多久、是否禁用、要不要换号
都是核心的策略(见下),js 不该自己记冷却表——那样每个插件都会长出一份
互相不一致的实现。

核心在 `status()` 之上叠加 `cooling` / `disabled` / `err_count` / `until` / `reason`
再给面板,所以 js 不用(也不该)填这些字段。`accounts` 为空数组 = 无账号供应商。
注意 `err_count` 现在是**限流退避等级**(反复被限流的号等级递增),不是
「连续失败次数」——面板按等级展示,等级在成功后清零。

### 冷却颗粒度 = (供应商, 模型, 连接)

js 只要知道这一条:**报 `rate_limit`/`transport`/`unknown` 只影响「这个号 × 这个
模型」**,不会牵连该号上的其它模型。一个连接服务多个模型时,模型 A 被限流不该
让模型 B 也不可用。

例外是 `session_dead`:凭证失效是连接级问题,该号**所有模型**都停用。

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
| `rate_limit` | **指数退避**:首次 2s,每次翻倍,上限 5 分钟;成功后等级清零 |
| `quota` | 冷却 10 分钟 |
| `session_dead` | **永久禁用该号**(所有模型都停用,需重新登录才能恢复) |
| `unavailable` / `transport` / `unknown` | 瞬时短冷却 30s(**每次都冷**,不攒次数) |
| `no_such_model` | **不惩罚账号**,核心直接跳过整个供应商换下一个 |

- 非流式若聚合后发现**空响应**(无 content / reasoning / tool_calls),请返回
  `{ ok:false, state:'unknown' }` 而不是 `ok:true`——空响应交给核心换号/换模型回退,
  比当作成功更有用

所以 js 别报「保险」的状态:把瞬时抖动报成 `quota` 会让好号白躺 10 分钟,把
限流报成 `unknown` 则只冷 30s、等下个请求再撞一次。网关自带业务码的(如
「请求参数非法」「上游临时不可用」)建议归 `rate_limit`——瞬时/请求类的错,
短冷换号比长冷划算。

冷却/禁用/退避等级都是**内存态**,重启归零(与凭证、积分的持久化不同)。
重启后所有号都会重新被选中一次,所以**上游确实挂了的号会各撞一次**,属预期。
要跨重启保留,届时给账号池加一个落盘 state 文件即可,接口不用变。

### 流式一旦写出第一个字节才绑死

核心**推迟到第一个字节才写响应头**,所以:

- 「上游刚连上就断」(一个字节都没吐)还能换账号/换模型重试
- 一旦写出第一个字节就绑死了——HTTP 语义如此,换任何实现都一样
  (9router 同样如此)。之后流中途出错只能作用于**后续**请求
- 要让「上游吐到一半才断」也能回退,必须在写响应头前缓冲判定,代价是
  首字节延迟,目前没做

### 终止帧 `[DONE]` 由核心兜底

客户端(dsh-llm adapter)严格等 `data: [DONE]` 才认为流正常结束;缺了就抛
`SSE payload stream ended without [DONE]`,整轮判失败——已经流式吐出去的内容
**全部作废**。

核心是 SSE 的唯一写入方,所以这个兜底由核心做,不要求 js 合成:

- 上游流结束时**没发过** `[DONE]` → 核心补发一个(降级为「拿到截断内容并
  正常收尾」,而不是整轮白干)
- 上游**已经发了** → 不再重复发(重复 `[DONE]` 同样坑客户端)
- **一个字节都没写出就断** → **不补**,留给换号/换模型回退(补了就把这次
  失败坐实成一个空响应,组合回退就没了)

js 因此不必自己合成终止帧(合成也不算错,核心会认)。

所以 js 的流转换要**尽早产出第一个字节**,别攒着。攒着不仅延迟高,还会把
自己的失败伪装成「可回退」,让组合以为没成功而反复重试别的模型。

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

`credits`(`status().accounts[].credits`)用于面板显示积分/额度。**填「剩余额度」
而不是「已消耗」**——额度类接口两者常常都有,填反了面板数字会越用越多。

### 积分归核心持久化,js 只报值

积分的持久化由核心统一管(存 `supplier-config.json` 的 `credits` 字段),js **不要
自己落盘**——一份数据两处存,两边都可能过期。js 只管两件事:内存 TTL、报真值。

报值的规矩(见上「`status()`」一节):**拿不到就报 `-1`,不是 `0`**。核心靠这个
区分「没拿到」和「拿到了 0」,报 0 会把缓存冲成 0(`0` 是真值「用完了」)。
不支持积分的供应商也报 `-1`,面板显示「积分未知」。

天花板:核心存的是「最后一次拿到的值」,不带时间戳。所以插件重启后短暂显示
上次的值,真值等异步拉完自动覆盖(面板下一次刷新即可见)。要消掉这个窗口,
得让核心存时间戳并在过期时标旧,目前没做。

上游幂等要处理好:有的上游「今日已签到」返回 **HTTP 400 + 业务 code**,
所以要先解析 body 的 code 再判 HTTP 状态,否则幂等情况会被误报成失败。

## 用量统计(核心通用,js 不实现)

面板「概览」看板的数字全由核心采集,js 不用做任何事。但**流式 js 有一件事
要注意:别吞掉上游的 `usage` 帧**。

- 核心在流式路径上旁路统计:原字节原样转给客户端,统计在旁边读同一份流。
  所以**统计不会增加首字节延迟**,js 也不必为统计做任何适配。
- 若上游把 `usage` 拆在多个事件里(如先给输入、后给输出),核心按**字段取
  最大值**合并——不是取最后一帧。所以 js 不必为了「凑一份完整 usage」而缓存
  或改写帧,**原样透传即可**。
- 上游压根不发 `usage` 时,核心按 ~4 字符/token 估算,面板上标 `~`。
  想让看板显示真值,就在流的最后一帧把上游的 `usage` 原样带上。
- **失败请求不估算 token**:它没到上游,按请求体字符数编造输入 token 只会
  把总量灌水。请求数、成功率、耗时照常统计。

### `usage` 字段形态:归一由核心做,别自己改

上游 `usage` 字段名各家不同(`prompt_tokens` / `input_tokens` /
`promptTokenCount` / `cache_read_input_tokens` …, 还有 OpenAI 的
`prompt_tokens_details.cached_tokens`),核心的 `normalizeUsage` 已经全部认。
**js 原样透传就行,不要自己换算字段名。**

缓存口径特别注意(这是唯一需要 js 理解的语义差异):

- **OpenAI 系**:`prompt_tokens` **已含**缓存 → 归一后 prompt 含缓存
- **Claude 系**:`input_tokens` **不含**缓存,缓存单报
  `cache_read_input_tokens` → 核心把它折进来,统一成「prompt 含缓存」

所以下游两处口径都自洽:面板「缓存 Tokens」是「输入 Tokens」的**子集**
(不是并列的第三种),而交给 DSH 会话的 `TokenUsage` 走 **DISJOINT 口径**
(`inputTokens` 只算未缓存 + 单列 `cacheReadTokens`),由 `toTokenUsage`
在写入侧换算。这条换算不做会出真故障:DSH 的 token-meter 投影 schema 是
`z.number().int().nonnegative()`,NaN 一进去校验就抛,整条 `session.history`
RPC 失败,表现为「历史加载失败」。

## 刷新链接池(核心通用,js 不实现)

面板链接池的「刷新」按钮是核心的活,js 不用做任何事:

1. **积分**:核心连着调 `status()` 等它落地(最多 3s),只认
   `status().accounts[].credits` 这一个字段,并统一持久化
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

// 只报「现在状态」:冷却/禁用/退避等级由核心叠加,积分由核心持久化
// credits: -1 = 不支持/没拉到(别写 0,0 会被当成「用完了」存下来)
const accounts = [{ uid: 'echo-1', nickname: 'Echo 1', credits: -1, state: 'ok' }]

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

**模型统一策略**:模型列表**优先从上游拉取**,缓存由核心统一管
(`Router.modelsOf`,TTL 10 分钟),js **不要自己缓存**——自己缓存一份会和核心
那份一起过期两次,「获取模型」按钮就成了摆设。

核心缓存是 **stale-while-revalidate**:过期后**先返回旧值**让面板立刻有内容,
后台再重新拉。所以 `listModels` 被调用的时机是:

- **冷启动**(该供应商第一次被问,没有旧值)——**会同步等**,全程只有这一次
- **TTL 过期后的第一次**——返回旧值,`listModels` 在**后台**被调用
- **手动点「获取模型」**(`force=true`)——**会同步等**,用户要看到结果

因此:

- `listModels` 要**快**:别在里面做全量探测之类的重活。重活放到 `force=true`
  时做(如按模型探测可用性)
- 冷启动那次会拖慢面板首屏(实测 0.3~1.0s/供应商,组合页取最慢那家),
  **别在这条路上加重活**——这是唯一一次用户真会等到的调用
- 拉到空列表时核心会保住旧值不当成新结果,所以别用「返回空」表达
  「上游出错」;出错就抛,核心会退回旧值(首次则整个供应商剔除)

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

存裸 id 时,核心只能遍历所有供应商逐个试。插件用 `unavailable` 回答「不是我的」,
而这个状态在池策略里会把**这个号 × 这个模型**冷掉——组合里每有一个别人家的
模型,每个账号在那模型上就都被冷一次,表现为「组合越用越没号可用」。
(`no_such_model` 是为此专门加的状态:它不冷任何东西。)

存了供应商 id 就不需要问了:直接调那一个。查不到供应商(拼错/供应商没加载)
直接失败,**不兜底遍历**——兜底会让拼错的 id 静默落到别的供应商上,更难查。
