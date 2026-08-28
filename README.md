# dsh-router

DSH 插件:9router 的简版。**dsh-router 本身就是路由器**——在 DSH web 服务
(`http://localhost:3080`)上暴露 OpenAI 兼容的 `/v1/*` 端点,并把请求路由到内部
供应商。内置 **opencode** 供应商对接 [OpenCode Free](https://opencode.ai) 公开免费通道
(参考 [9router](../9router) 的 open-sse 实现,无鉴权直连,模型列表从上游获取)。
**traework**(TRAE SOLO 免费通道,移植自 [traework2api](../traework2api))已迁移到
独立插件 [dsh-router-traework](../dsh-router-traework),通过 cordis service
`router.suppliers` 暴露给本插件加载(见下方「供应商加载」)。

左侧边栏「记忆系统」上方有 **路由系统** 入口,点击打开中心栏面板(参考 9router):

- **返回会话** — 左侧按钮,关闭面板回到聊天;
- **供应商** — 供应商卡片(`traework` / `opencode`),点击进入详情:
  - **账号池** — uid / 昵称 / 积分 / 冷却 / 禁用 / 连续错误(traework;opencode 为
    无账号免费直连,不显示账号池);
  - **加账号** — 面板内完成 traework2api `login.sh` 流程:生成登录链接 → 浏览器登录 →
    粘贴回调 → 换 token 落盘 SQLite 凭证库(traework);
  - **可用模型** — 模型列表,逐个启用/禁用 + 自定义模型(通用能力,持久化到
    `data/supplier-config.json`,`/v1/models` 与 chat 只接受启用的模型);opencode
    模型从上游 `zen/v1/models` 拉取免费模型(带缓存);
- **组合** — fallback 链(免费优先,当前默认组合 `traework`);
- **端点与密钥** — 9router endpoint 核心(无隧道/Tailscale):
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
| `/health` | GET | 供应商列表 |
| `/status` | GET | 全部账号(含供应商 id) |
| `/models` | GET | 合并模型列表(已过滤禁用) |
| `/combos` | GET | 组合 fallback 链 |
| `/keys` | GET/POST | 密钥列表(含完整 key)/ 创建 `{name}` → 返回明文一次 |
| `/keys/toggle` | POST | `{id, isActive}` |
| `/keys/delete` | POST | `{id}` |
| `/settings` | GET/PATCH | `{requireApiKey}` |
| `/suppliers/traework/login` | POST | 生成登录链接 |
| `/suppliers/traework/login/callback` | POST | `{callbackUrl}` → 加账号 |
| `/suppliers/traework/models` | GET | 模型 + 启用状态 |
| `/suppliers/traework/models/toggle` | POST | `{id, enabled}` |

## 架构

```
浏览器(client 半)
  └─ 侧边栏「路由系统」+ 中心栏面板(RouterView, 含返回会话按钮)
       ├─ RouterView        tab: 供应商 / 组合 / 端点与密钥
       ├─ SupplierDetail    供应商详情:账号池 + 加账号 + 可用模型
       ├─ EndpointTab       端点 URL + requireApiKey + 密钥管理
       └─ fetch /router/api/*            (同源,无 CORS)
            └─ host 半(src/index.ts)
                 ├─ /v1/models + /v1/chat/completions   (OpenAI 兼容, KeysStore 鉴权)
                 ├─ KeysStore(src/keys.ts)              密钥库 + requireApiKey
                 └─ Router(路由器) → suppliers[]
                      ├─ OpenCodeSupplier(lib/suppliers/opencode.js) 无账号免费直连
                      └─ TraeworkSupplier(dsh-router-traework 插件,经 router.suppliers service)
                           ├─ auth.ts    凭证解析(存 SQLite 凭证库)
                           ├─ pool.ts    账号池(积分挑选/冷却/禁用状态机)
                           ├─ upstream.ts TRAE SOLO 客户端 + SSE 转换 + OpenAI→SOLO 改写
                           ├─ scheduler.ts 每日签到 + token 预刷新
                           └─ login.ts    加账号流程(登录链接 + 回调解析)
```

- **供应商抽象**:可插拔 js 模块只提供**差异化能力**(`status/listModels/getAlias/chatCompletions`
  + 可选登录/签到/测模型);**通用能力**(连接池排序/策略、模型启用/自定义、别名、凭证)
  由核心统一管。
- **供应商加载**(三来源,见 [`docs/suppliers.md`](docs/suppliers.md)):
  1. 内置:`lib/suppliers/*.js`(随插件分发,如 opencode)
  2. 用户:`~/.dsh/profiles/web/suppliers/*.js`
  3. 外部插件:其他 DSH 插件通过 cordis service `router.suppliers`
     (值为 `{ [supplierId]: (env) => SupplierModule }`)暴露供应商,
     dsh-router `ctx.inject(['router.suppliers'])` 延迟加载——traework 即由
     `dsh-router-traework` 插件提供。
- **/v1/\* 鉴权**:由 `KeysStore.requireApiKey` 控制。关闭 → 不鉴权;
  开启 → Bearer 必须是「库内启用的 key」或 `TW2A_API_KEY` env。
- **traework 供应商**:多账号积分降序挑选,1005/429/401/404/5xx 自动冷却/禁用/轮转,
  每日签到解冻、token 过期前 24h 预刷新——完整移植 traework2api 的状态机。
  没有「在线/离线」概念:供应商始终渲染,账号为 0 就显示 0 账号,引导加账号。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `TW2A_AUTH_DIR` | `<dataDir>/auths` | 凭证目录(dsh-router 核心统一管,`credentials.sqlite` SQLite 库) |
| `TW2A_STATE_FILE` | `data/state.json` | 冷却/积分持久化(同目录放 keys.json / models.json) |
| `TW2A_API_KEY` | 空 | /v1 Bearer 鉴权(与库内 key 等效) |
| `TW2A_DEFAULT_MODEL` | `glm-5.2` | 默认模型 |
| `TW2A_CHECKIN_HOUR` | `9` | 每日签到小时 |
| `TW2A_REFRESH_HOURS` | `3` | token 预刷新小时 |
| `TW2A_SOLO_AGENT_HOST` / `UG_HOST` / `OAUTH_HOST` | 官方 | 覆盖上游(测试用) |

## 构建

```bash
pnpm install
pnpm build        # lib/index.js(host) + lib/client.js / lib/client-registry.js(browser)
pnpm typecheck
```

## 挂载

1. `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 加 `"dsh-router"`,
   `dependencies` 加 `"dsh-router": "link:/Users/carvin/Desktop/dsh-plugins/dsh-router"`;
2. `cd ~/.dsh/profiles/web && pnpm install`;
3. 重启 `dsh web`。

## 前提

- 凭证由 dsh-router 核心统一管(SQLite 库 `<dataDir>/auths/credentials.sqlite`)
  ——可以直接在面板「供应商 → traework → 加账号」里登录生成,也可以用 traework2api 的 `login.sh`;
- 重启 DSH 后 `/v1/*` 即生效;面板管理账号、模型与密钥。
