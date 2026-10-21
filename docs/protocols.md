# 协议矩阵

dsh-router 的对外面不止 OpenAI Chat Completions。四种协议**双向互转**:

| 协议 | 入口 | 客户端 |
| --- | --- | --- |
| `chat` | `POST /v1/chat/completions` | OpenAI SDK / Cline / DSH 设置-模型 |
| `anthropic` | `POST /v1/messages` | Claude Code |
| `responses` | `POST /v1/responses` | Codex |
| `gemini` | `POST /v1beta/models/<model>:generateContent`<br>`POST /v1beta/models/<model>:streamGenerateContent` | Gemini CLI |

## 为什么是「一个规范形态」而不是 12 条翻译路径

四种协议两两互转是 4×3 = 12 条路径,逐条实现必然长出一打互相不一致的版本。
收敛成「全部先转成规范形态、再从规范形态转出去」之后:

```
外来请求 ──decode──┐                ┌──encode── 外来响应
                   ├─ 规范形态 ────┤
供应商请求 ◀─encode─┘                └─decode──▶ 供应商响应
```

只需要 N 个协议模块(N=4),而不是 N² 条路径;加第五种协议只是再加一个模块,
已有路径一行不改。

**规范形态选 OpenAI Chat Completions(请求体)+ 一组扁平事件(响应流)**,
不是随便挑的:供应商契约(`suppliers/contract.ts` 的 `chatOnce`)今天就是
「吃 Chat Completions 请求体、吐 OpenAI SSE」。选别的形态等于把每个已装供应商
插件都改一遍。

## 模块

| 文件 | 职责 |
| --- | --- |
| `types.ts` | `ProtocolId`、`ChatEvent`、`ProtocolCodec` 契约、`finishOf` 对照表、不可信 JSON 取值工具 |
| `sse.ts` | 只做分帧(跨 chunk 缓冲)/拆 `event:`+`data:`/拼帧,**不懂任何协议语义** |
| `chat.ts` | 规范形态本身:编解码是恒等变换,外加事件映射(四种协议的共享脊柱) |
| `anthropic.ts` | `message_start` / `content_block_*` / `message_delta` / `message_stop` |
| `responses.ts` | `response.created` / `output_item.added` / `function_call_arguments.delta` / `response.completed` |
| `gemini.ts` | `contents` / `parts` / `functionDeclarations` / `usageMetadata` |
| `index.ts` | **静态**注册表(刻意不做运行时发现:四种协议是编译期就知道的集合) |
| `stream.ts` | `StreamState`(一次流的有状态累加)+ `translateStream`(接字节流) |
| `entry.ts` | 四个入站入口的薄壳:认路径、翻请求体、套响应流 |

## 三条设计约束

### 1. 核心不认识协议

`Router` 的职责是「选号/冷却/回退/记账」,它不该知道世界上有几种协议。
`protocol/entry.ts` 只做三件与协议有关的事:认路径、翻请求体、翻响应体,剩下
全部委托给 `Router.chatCompletions` —— 于是四种协议**自动**获得账号池、组合
回退、首字节预算、断流补帧、用量统计,一个都不用重写。

响应侧因为 `chatCompletions` 直接往 `res` 写 SSE,所以传一个 `ResponseSink`
进去:非 chat 协议用 `outboundSink` 中继翻译,而它只是转发器 —— Router 那套
「客户端断开就取消上游流」的逻辑监听的是**真实 res 的 close**,照旧生效。

### 2. 翻译层是纯函数,分帧状态按请求隔离

`toChat` / `fromChat` / `decodeFrame` / `encodeFrame` / `encodeJson` /
`decodeJson` 都不碰账号池、不碰 `res`,可以单测。

需要跨帧记忆的部分(usage 分散在多帧、工具名先于参数、收尾帧要在流末补)
放在 **`StreamState` / `ChunkTranslator`**,一个请求一个实例。早先 Gemini 的
工具名映射放在模块级 Map 上靠「记得调 reset」来防串名 —— 那是错的:并发两条流
各自的 `ls` 会抢同一个 index。现在由 `ProtocolCodec.createSession()` 在请求
边界建一份,随流结束丢弃。

### 3. 丢东西要写明,不要猜

规范形态只覆盖**能表达的部分**。各家私有的、没有对应概念的东西在跨协议时
会被**丢掉**,不是被翻译 —— 每条丢弃都在对应模块注释里点名:

- Anthropic 的 `cache_control`(Chat 的缓存是上游自动的,硬造一个 `prompt_cache_key` 是猜)
- Anthropic 的 `thinking.budget_tokens`(只保留为 reasoning 增量)
- Anthropic 的 `mcp_servers` / `container` / `context_management`(客户端侧特性)
- Responses 的 `previous_response_id` / `store`(我们的供应商契约是无状态的)
- Responses 的 `include` / `text.format`(跨协议没有对应物)
- Gemini 的 `safetySettings`

## 各协议的坑

### 工具调用:三种编码

| 协议 | 工具调用形态 |
| --- | --- |
| Chat | `tool_calls[].function.arguments` 是 **JSON 字符串增量** |
| Anthropic | `content_block_start` 给 `name`,后续 `input_json_delta.partial_json` 给增量 |
| Responses | `output_item.added` 给 `name`,后续 `function_call_arguments.delta` 给增量 |
| Gemini | `functionCall` 的 `args` 是**整块对象**,没有增量形态 |

Gemini 是唯一「名字和参数不同帧、参数还不可分」的:名字在 `functionCall.name`
里,而规范形态的 `tool-args` 不带名字。所以 `gemini.ts` 需要 index↔name 映射,
靠 `createSession()` 保证只在一条流内有效。

### 收尾:四种词汇

| 协议 | 「说完了」怎么表达 |
| --- | --- |
| Chat | `finish_reason: "stop"` + `data: [DONE]` |
| Anthropic | `message_delta.stop_reason` + 独立的 `message_stop` **事件** |
| Responses | `response.completed`,里面 `status: "completed" | "incomplete"` |
| Gemini | 同帧的 `finishReason: "STOP" | "MAX_TOKENS"` |

`encodeFrame(finish)` 只发**原因那一帧**,`endFrames()` 发**终止帧**。
两处都发会出现两个 `message_stop`,Anthropic 客户端会把后一个当成新一轮开始。

### 用量:分散在不同帧

Anthropic 把输入用量放 `message_start`、输出放 `message_delta`;其余协议
最后一帧才给。`StreamState` 的 `mergeUsage` 用**字段级 max**合并(与
`router/usage-tokens.ts` 的 `mergeUsage` 同规则)—— 覆盖会让后一帧把前面的
输入清零。

## 测试

两条线,缺一不可:

- **`protocol.test.ts`** —— 编解码器两两往返(纯函数、无 IO)。16 条基础 +
  7 条回归,每条对应一个真实修掉的 bug。
- **`wire-e2e.test.ts`** —— 从 `outboundSink` 到真实字节。守的是接线:状态行、
  content-type、内容、收尾四件事同时搬对。

为什么两条都要:编解码器正确 ≠ 接线正确。`finishJson` 曾经把 Router 写的
**Chat 形态**用**客户端 codec** 去解(`choices` 字段根本不存在)—— 编解码器
各自都是对的,但客户端拿到 200 + 空内容。静默错,只有端到端能抓到。
