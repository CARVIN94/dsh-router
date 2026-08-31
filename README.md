# dsh-router

**插件版的 9router** —— 不是另开一个网关服务,而是直接作为 DSH 插件嵌进
DSH web(和「记忆系统」同侧边栏),在 `http://localhost:3080/v1` 上原生暴露
OpenAI 兼容端点,把请求路由到内部供应商。装好即用,不用多开一个 9router、
不用维护第二个端口、不用在网关和 DSH 之间搬配置。

## 为什么更优雅

- **零额外进程**:dsh-router 就是 DSH 插件,随 `dsh web` 启停,天然同源
  (`/router/api/*` 无 CORS、面板内嵌侧边栏),不像 9router 要独立跑一个
  Next.js 服务再对接;
- **供应商即插即拔**:内置供应商(如 opencode / openrouter / nvidia)随插件分发;
  更多供应商 = 装一个 DSH 插件(`dsh-router-*`)经 cordis service
  `router.suppliers` 注册,面板自动出现、热加载/卸载;也可以放一个自定义
  js 文件到 `~/.dsh/profiles/web/suppliers/` 就注册一个新供应商——
  无需改核心代码、无需重编译;
- **模型不内置**:供应商只实现差异化能力(列模型/调上游/登录),模型拉取与
  缓存由核心统一管,不写死、不过时;
- **策略只写一次**:组合回退、账号池(选号/冷却/禁用/连续错误累计)、响应写入、
  凭证存储、模型管理都由核心提供。供应商 js 只对**单个账号**调一次上游并报告
  成败,不自己遍历账号、不维护冷却表——否则每个插件都会长出一份互相不一致的
  实现,而核心也就无从判断「该不该换号」;
- **凭证 SQLite 单库**:`auths/credentials.sqlite`,供应商凭证不透明 blob,
  核心统一生命周期,干净可备份;
- **复用 9router 思路**:面板布局、组合 fallback、连接池/账号池、API key
  管理都贴近 9router,但按 DSH「一切皆插件」的方式重组得更轻。

> 供应商开发与接入规范见 [`docs/suppliers.md`](docs/suppliers.md)
> （契约 / 加载顺序 / 模型统一策略 / 内置供应商参考实现）。

左侧边栏「记忆系统」上方有 **路由系统** 入口,点击打开中心栏面板:

- **返回会话** — 左侧按钮,关闭面板回到聊天;
- **概览** — 用量看板(默认页):
  - 周期切换 **今日 / 24 小时 / 7 天 / 30 天**;
  - 汇总卡:总请求(含成功率)、输入 Tokens、输出 Tokens、缓存 Tokens、平均耗时(含首字节);
  - Token 趋势折线图:鼠标悬停 / 触摸点选 / 键盘 `←` `→`(`Home` `End` 到两端,`Esc` 取消)
    看每个时段;读数和峰值用 K/M 缩写,精确值在悬停提示里;
  - Top 榜:按供应商 / 按模型(请求数带失败计数);
  - 最近请求:时间 / 模型 / 供应商 / in↑ out↓ / 耗时,显示最近 10 条;
  - **清空** — 清掉全部用量统计(不影响供应商、账号、组合配置);
  - 数据落盘 `data/usage.json`(按天聚合 + 最近 500 条明细 + 累计计数)。
    token 口径:上游返回 `usage` 就用真值(分散在多帧时按字段取最大值合并);
    上游不发时按 ~4 字符/token 估算,面板上标 `~`。**失败请求不估算**——
    它没到上游,编造输入 token 只会把总量灌水;
    缓存口径:OpenAI 系 `prompt_tokens` **含**缓存,Claude 系不含(单报
    `cache_read_input_tokens`),归一时统一折成「prompt 含缓存」,
    所以「缓存 Tokens」是「输入 Tokens」的**子集**,不是并列的第三种;
- **供应商** — 供应商卡片(内置 / 插件分组),点击进入详情:
  - **链接池** — 账号列表(冷却/禁用/健康数/积分),支持删除;
  - **加链接** — 按供应商能力弹出不同流程:URL 登录(生成链接 → 浏览器登录 → 回调)、
    API key 弹窗(填名字 + key)、轮询登录(登录后自动取凭证);
  - **签到** — 供应商实现了签到的才显示(如 codebuddy:每日 100 积分,连续第 7 天
    1000)。核心遍历所有链接逐个签,汇总「N/M 成功 · X 今日已签」;上游「今日已
    签到」按成功处理(幂等),账号额度或凭证失效会单独标出;
  - **刷新** — 刷所有链接的积分,并跑一次最简会话探测该供应商是否还有活着的链接
    (走真实对话路径 + 账号池回退,能分清是账号额度没了还是供应商真挂了);
  - **可用模型** — 模型列表,逐个启用/禁用 + 自定义模型(通用能力,持久化到
    `data/supplier-config.json`,`/v1/models` 与 chat 只接受启用的模型);单个模型可
    「测试」,走真实对话路径并按账号池依次回退,所以能分清是这个账号额度没了还是
    该模型真的不支持;
- **组合** — fallback 链(免费优先),可自定义。**组合即模型**:建好的组合会**自动带出**
  为 DSH 模型目录里的 `router` provider 选项(设置 → 模型直接选组合名即可用),请求
  按组合策略命中其中一个供应商模型;
- **端点与密钥** — 端点核心(无隧道/Tailscale):
  - API 端点 URL(`http://localhost:3080/v1`,可复制);
  - 鉴权设置 `requireApiKey` 开关;
  - API Keys 管理:创建 / 启用切换 / 显示 / 复制 / 删除(持久化到 `data/keys.json`)。

## API 端点(OpenAI 兼容,`:3080/v1`)

```bash
# 模型列表
curl http://localhost:3080/v1/models

# 对话(流式/非流式)
curl -X POST http://localhost:3080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.2","messages":[{"role":"user","content":"你好"}],"stream":false}'
```

任何支持 OpenAI 兼容 API 的工具(Claude Code、Cline、DSH 设置-模型 等)都可以把
`baseURL` 指向 `http://localhost:3080/v1`。

**鉴权**:默认 `requireApiKey=false`,`/v1/*` 不要求鉴权(本地使用,与 9router 一致)。
在「端点与密钥」页开启「要求 API Key」后,请求必须带
`Authorization: Bearer <库内启用的 Key 或 TW2A_API_KEY>`。

## 面板 API(`/router/api/*`,同源)

| 端点 | 方法 | 说明 |
|---|---|---|
| `/health` | GET | 供应商列表(含来源/能力) |
| `/status` | GET | 全部账号(含供应商 id) |
| `/models` | GET | 合并模型列表(已过滤禁用) |
| `/combos` | GET | 组合 fallback 链 |
| `/keys` | GET/POST | 密钥列表(含完整 key)/ 创建 `{name}` → 返回明文一次 |
| `/keys/toggle` | POST | `{id, isActive}` |
| `/keys/delete` | POST | `{id}` |
| `/settings` | GET/PATCH | `{requireApiKey}` |
| `/stats` | GET | 用量统计 `?period=today\|24h\|7d\|30d`(汇总 + Top 榜 + 最近请求 20 条) |
| `/stats/chart` | GET | 趋势图数据 `?period=…`(today/24h = 24 小时桶,7d/30d = 天桶) |
| `/stats/clear` | POST | 清空全部用量统计 |
| `/suppliers/:id/login` | POST | 生成登录链接 |
| `/suppliers/:id/login/callback` | POST | `{callbackUrl}` → 加账号 |
| `/suppliers/:id/models` | GET | 模型 + 启用状态 |
| `/suppliers/:id/models/toggle` | POST | `{id, enabled}` |

## 架构

```
浏览器(client 半)
  └─ 侧边栏「路由系统」+ 中心栏面板(RouterView, 含返回会话按钮)
       ├─ StatsTab          概览:用量看板(周期切换 + 汇总卡 + 折线趋势 + Top 榜 + 最近请求)
       ├─ RouterView        tab: 概览 / 供应商 / 组合 / 端点与密钥
       ├─ SupplierDetail    供应商详情:链接池 + 加链接 + 可用模型
       ├─ EndpointTab       端点 URL + requireApiKey + 密钥管理
       └─ fetch /router/api/*            (同源,无 CORS)
            └─ host 半(src/index.ts)
                 ├─ /v1/models + /v1/chat/completions   (OpenAI 兼容, KeysStore 鉴权)
                 │    └─ RouterAdapter(src/llm/adapter.ts)  OpenAI SSE → DSH StreamChunk
                 │         (usage 经 toTokenUsage 转 DSH 契约,见 docs/suppliers.md)
                 ├─ KeysStore(src/keys.ts)              密钥库 + requireApiKey
                 └─ Router(路由器) → suppliers[]
                      ├─ OpenCodeSupplier(lib/suppliers/opencode.js) 无账号免费直连
                      ├─ OpenRouterSupplier(lib/suppliers/openrouter.js) API key 账号
                      └─ NvidiaSupplier(lib/suppliers/nvidia.js)       API key 账号
                      └─ 外部插件供应商(经 router.suppliers service 注册)
```

- **供应商抽象**:可插拔 js 模块只提供**差异化能力**(`status/listModels/getAlias/chatOnce`
  + 可选登录/签到/加 key);**策略与通用能力**(组合回退、账号池选号/冷却/禁用、
  连接池排序、模型启用/自定义、别名、凭证、响应写入)由核心统一管。
  `chatOnce(uid, req)` 一次只服务一个账号,返回成功/失败 + 语义状态,换号由核心决定。
- **供应商加载**(三来源,见 [`docs/suppliers.md`](docs/suppliers.md)):
  1. 内置:`lib/suppliers/*.js`(随插件分发,如 opencode)
  2. 用户:`~/.dsh/profiles/web/suppliers/*.js`
  3. 外部插件:其他 DSH 插件通过 cordis service `router.suppliers`
     (值为 `{ [supplierId]: (env) => SupplierModule }`)暴露供应商,
     dsh-router `ctx.inject(['router.suppliers'])` 延迟加载。
- **模型统一策略**:插件不内置、不缓存模型;`listModels` 每次从上游拉取,
  缓存由核心按 60s TTL 统一管(`/suppliers/:id/models`),`/v1/models` 保持实时。
- **凭证存储**:SQLite 单库 `{authDir}/credentials.sqlite`(表 `credentials(supplier, uid, data)`,
  凭证为供应商不透明 JSON blob)。
- **/v1/\* 鉴权**:由 `KeysStore.requireApiKey` 控制。关闭 → 不鉴权;
  开启 → Bearer 必须是「库内启用的 key」或 `TW2A_API_KEY` env。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `TW2A_AUTH_DIR` | `<dataDir>/auths` | 凭证目录(dsh-router 核心统一管,`credentials.sqlite` SQLite 库) |
| `TW2A_STATE_FILE` | `data/state.json` | 状态持久化(同目录放 keys.json / combos.json / supplier-config.json) |
| `TW2A_API_KEY` | 空 | /v1 Bearer 鉴权(与库内 key 等效) |

## 构建

```bash
pnpm install
pnpm build        # lib/index.js(host) + lib/client.js / lib/client-registry.js(browser)
pnpm typecheck
```

## 安装(DSH)

用 dsh CLI 装到 profile(web 是 DSH 插件宿主):

```bash
dsh plugin --profile web add dsh-router-core
```

该命令会在 profile 里 `pnpm add`,并自动把 `dsh-router-core` 加入
`dsh.profile.bundles`(包声明了 `dsh.bundle.patch`,即 `cordis.patch.yml`)。

然后**重启 `dsh web`**。侧边栏出现「路由系统」入口,打开即面板。

> 更多供应商:DSH 插件形态的供应商各自发 npm 包,同样 `dsh plugin --profile web add <包名>`
> 即可;供应商接入与开发见 [`docs/suppliers.md`](docs/suppliers.md)。
>
> 本地开发版:不用 npm,直接 `dependencies` 加
> `"dsh-router-core": "link:/path/to/dsh-router"` 指向本地仓库。

## 前提

- 凭证由 dsh-router 核心统一管(SQLite 库 `<dataDir>/auths/credentials.sqlite`);
- 供应商接入与开发见 [`docs/suppliers.md`](docs/suppliers.md);
- 重启 DSH 后 `/v1/*` 即生效;面板管理账号、模型与密钥。

## 致谢

感谢以下项目给的灵感:

- [decolua/9router](https://github.com/decolua/9router) —— 本地 AI 路由网关,面板/组合/连接池/凭证等思路的来源;
- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) —— DSH「一切皆插件」的宿主框架;
- [omdsh-dev/dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon) —— DSH 插件形态与侧边栏入口的参考。
