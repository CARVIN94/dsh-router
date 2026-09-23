/**
 * 扩展详情页 —— 从设置 → 路由 → 扩展 的卡片点进来。
 *
 * 布局同供应商详情：返回链接 + 图标 + 名称/副行，头部右侧是启用开关；下面跟扩展说明
 * 卡与未就绪横幅。有 `api`() 支持的自定义扩展可在未来按需加独立面板，此处不内置任何
 * 具体扩展的专属视图。
 */
import type { RouterExtItem } from '../shared.ts'

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
  /** 开关切换（由列表页持有状态与 PATCH；这里只做触发）。 */
  onToggle: (item: RouterExtItem, value: boolean) => void
}

export function ExtDetail({ item, onBack, onToggle }: ExtDetailProps): JSX.Element {
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
              {item.enabled ? ' · 已启用' : ' · 未启用'}
              {item.ready === false ? ' · 未就绪' : ''}
            </p>
          </div>
          {/* 开关放在标题行右侧（同供应商详情的编辑按钮位） */}
          <button
            type="button"
            className={`dshr-toggle dshr-extDetailToggle ${item.enabled ? 'dshr-toggle-on' : ''}`}
            role="switch"
            aria-checked={!!item.enabled}
            disabled={item.ready === false && !item.enabled}
            onClick={() => void onToggle(item, !item.enabled)}
            title={item.ready === false && !item.enabled
              ? '当前不可用,无法开启'
              : item.enabled ? `关闭 ${item.name}` : `开启 ${item.name}`}
          >
            <span className="dshr-toggleKnob" />
          </button>
        </div>
      </div>

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
    </div>
  )
}