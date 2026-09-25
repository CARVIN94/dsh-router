/**
 * 扩展详情页 —— 从设置 → 路由 → 扩展 的卡片点进来。
 *
 * **只读：开关不在这一层。** 启停的唯一入口是官方插件页（设置 → 插件 →
 * dsh-router-core 详情页的「路由组件」一节），那里直接调核心的
 * `PATCH /router/api/ext`，自检与持久化都由核心裁决。同一件事只留一个开关，
 * 否则两处状态各说各话。
 *
 * 列表页只列**已启用**的扩展（关闭的连卡片都不出现），所以这里也不必再显示
 * 「已启用/未启用」——那行字只能是常量。布局同供应商详情：返回链接 + 图标 +
 * 名称/副行，下面跟扩展说明卡与未就绪横幅。有 `api()` 支持的自定义扩展可在未来
 * 按需加独立面板，此处不内置任何具体扩展的专属视图。
 */
import type { RouterExtItem } from '../shared.ts'
import { extPanel } from './ext-panels.ts'

function Icon({ d, size = 18 }: { d: string; size?: number }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

const I = {
  back: 'M19 12H5M12 19l-7-7 7-7',
  bolt: 'M13 2L4 14h6l-1 8 9-12h-6z',
}

interface ExtDetailProps {
  item: RouterExtItem
  onBack: () => void
}

export function ExtDetail({ item, onBack }: ExtDetailProps): JSX.Element {
  // 扩展**自带**详情面板时用它（连接自检就是这么做的：选供应商/模型/连接 + 跑测试）。
  // 没有就退回下面这张通用只读页 —— 保留返回链接与标题，导航形状与有没有自定义
  // 面板无关，用户点进去的预期是稳定的。
  const Custom = extPanel(item.id)
  return (
    <div className="dshr-tabBody">
      {/* Header（同供应商详情：返回链接 + 图标 + 名称/副行） */}
      <div className="dshr-providerHead">
        <button type="button" className="dshr-backLink" onClick={onBack}>
          <Icon d={I.back} size={16} />
          返回
        </button>
        <div className="dshr-providerTitleRow">
          <div className="dshr-providerIcon" style={{ color: 'var(--rs-faint)', background: 'var(--rs-layer-2)' }}>
            {item.icon !== undefined
              ? (
                <img
                  className="dshr-providerImg"
                  src={item.icon}
                  alt=""
                  // 同上：失败就藏，露出备用图标位置（不显示碎图）
                  onError={(e) => { e.currentTarget.style.display = 'none' }}
                />
              )
              : <Icon d={I.bolt} size={22} />}
          </div>
          <div className="dshr-providerMeta">
            <h1 className="dshr-providerName">{item.name}</h1>
            <p className="dshr-providerCount">
              <span className="dshr-mono">{item.id}</span>
              {item.ready === false ? ' · 未就绪' : ''}
            </p>
          </div>
        </div>
      </div>

      {/* 扩展自带的面板（注册表里没有就落回下面这两块通用内容） */}
      {Custom !== undefined ? <Custom /> : (
        <>
      {/* 扩展说明 */}
      {item.description !== undefined && item.description !== '' && (
        <section className="dshr-card">
          <div className="dshr-muted" style={{ padding: '12px 14px' }}>{item.description}</div>
        </section>
      )}

      {/* 未就绪警示（同供应商详情的出错横幅） */}
      {item.ready === false && (
        <div className="dshr-alert">
          <strong>未就绪</strong>
          <span>{item.detail !== undefined && item.detail !== '' ? item.detail : '当前不可用'}</span>
        </div>
      )}
        </>
      )}
    </div>
  )
}
