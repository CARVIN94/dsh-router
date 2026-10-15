/**
 * 网关端点地址（`http://127.0.0.1:<宿主端口>/v1`）的解析。
 *
 * ## 为什么端口不能写死
 *
 * dsh-router **自己不开端口**：`/v1/*` 是注册在**宿主** web server 上的路由
 * （见 `index.ts` 的 `ctx.webServer.register`）。所以端点地址里的端口由启动通道
 * 决定，而不是插件决定 —— `dsh web` 默认 3080，桌面端官方通道、以及配置
 * `port: 0`（让 OS 分配）时都**不是** 3080。之前 adapter 把
 * `http://localhost:3080/v1` 写死在构造参数里，于是非 3080 的宿主上 Router
 * 的每一轮对话都是 `dsh-router upstream call failed: fetch failed`（issue #9）。
 *
 * ## 为什么返回函数而不是字符串
 *
 * `webServer.port` 是**监听之后**才有值的 getter（listen 前是 `undefined`），
 * 且宿主重启/换端口后它会变。所以这里返回函数、**每次请求现算**，不在注册时
 * 算一次 —— 注册发生在启动早期，那时算只会把「拿不到端口」固化成常量。
 *
 * ## 拿不到端口时为什么抛，而不是回退 3080
 *
 * 回退等于把同一个 bug 换种写法：端口读不到时宿主的路由也没在服务，回退到 3080
 * 只会重新得到一句无从查证的 `fetch failed`。这里抛明确的话，让它出现在
 * `LlmError` 消息里（adapter 在 fetch 同一个 try 里调它），报错自带原因。
 */

/** 回环地址：宿主即使监听 `0.0.0.0`（LAN 模式），走 127.0.0.1 也通。 */
const LOOPBACK_HOST = '127.0.0.1'

/**
 * 造一个「每次调用现读宿主端口」的端点解析器。
 *
 * @param readPort 读宿主监听端口（`webServer.port`）。取不到时抛错而不是猜。
 * @param path 端点路径前缀，默认 `/v1`。
 */
export function loopbackBaseURL(readPort: () => number | undefined, path: string = '/v1'): () => string {
  return () => {
    const port = readPort()
    if (port === undefined) {
      throw new Error('dsh-router: 宿主 webServer 端口未就绪（webServer.port 读不到），无法定位 /v1 端点')
    }
    return `http://${LOOPBACK_HOST}:${String(port)}${path}`
  }
}
