/**
 * HIG P3(RFC §2.7)内置线性 icon 集 —— 自绘 SVG,零新依赖。
 * 风格:24 viewBox、1.5px 线性描边、圆角端点、fill=none、stroke=currentColor
 * (随文字色,hover/danger 变色自动跟随)。不复制 Apple 资产 / SF Symbols。
 * 尺寸走 token(app.css):.hmh-icon = inline 16 / .hmh-icon.status = 20。
 * icon-only button 的 accessible name 由调用方 aria-label 提供(i18n L.*)。
 */
import type { ReactNode } from 'react';

export type IconName =
  | 'menu' | 'chevron-down' | 'folder' | 'file'
  | 'panel-collapse' | 'panel-expand'
  | 'cog' | 'sliders' | 'x'
  | 'shield' | 'package' | 'paperclip'
  | 'star' | 'star-filled' | 'download' | 'archive' | 'trash';

const PATHS: Record<IconName, ReactNode> = {
  /* ☰ 主菜单 */
  menu: (<><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /></>),
  /* ▾ 下拉/展开指示 */
  'chevron-down': <path d="M6.5 9.5 12 15l5.5-5.5" />,
  /* 📁 工作区/目录 */
  folder: <path d="M3.5 17V7a2 2 0 0 1 2-2h3.8l2 2.3h7.2a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />,
  /* 📄 文件 */
  file: (<><path d="M6.5 3.5H14l4 4v13H6.5z" /><path d="M14 3.5v4h4" /></>),
  /* ⇤ 收起侧栏(箭头射向左竖条) */
  'panel-collapse': (<><path d="M4.5 5v14" /><path d="M20 12H8.5" /><path d="M12.5 8l-4 4 4 4" /></>),
  /* ⇥ 展开侧栏(箭头自左竖条向右) */
  'panel-expand': (<><path d="M4.5 5v14" /><path d="M8.5 12H20" /><path d="M16 8l4 4-4 4" /></>),
  /* ⚙ 工具状态(齿轮简形) */
  cog: (<><circle cx="12" cy="12" r="3.2" /><path d="M12 3.5v2.4" /><path d="M12 18.1v2.4" /><path d="M3.5 12h2.4" /><path d="M18.1 12h2.4" /><path d="M6.1 6.1l1.7 1.7" /><path d="M16.2 16.2l1.7 1.7" /><path d="M17.9 6.1l-1.7 1.7" /><path d="M7.8 16.2l-1.7 1.7" /></>),
  /* 设置(滑杆) */
  sliders: (<><path d="M4 7h7.5" /><circle cx="14.5" cy="7" r="2.5" /><path d="M17 7h3" /><path d="M4 17h5.5" /><circle cx="11" cy="17" r="2.5" /><path d="M13.5 17H20" /></>),
  /* ✕ 关闭/错误 */
  x: (<><path d="M6.5 6.5l11 11" /><path d="M17.5 6.5l-11 11" /></>),
  /* 🛡 审批 */
  shield: <path d="M12 3.5 5.5 5.8v5.4c0 4.3 2.7 7.3 6.5 8.8 3.8-1.5 6.5-4.5 6.5-8.8V5.8z" />,
  /* 📦 交付物 */
  package: (<><path d="M12 3.5 20 8v8l-8 4.5L4 16V8z" /><path d="M4 8l8 4.5L20 8" /><path d="M12 12.5v8" /></>),
  /* 📎 附件 */
  paperclip: <path d="M17 6.5l-9 9a4 4 0 0 0 5.7 5.7l9-9a2.6 2.6 0 0 0-3.7-3.7l-8.5 8.5a1.2 1.2 0 0 0 1.7 1.7L20 11" />,
  /* ☆ 未收藏 */
  star: <path d="M12 3.5 14.4 9l5.9.6-4.4 4 1.3 5.8L12 16.3 6.8 19.4l1.3-5.8-4.4-4L9.6 9z" />,
  /* ★ 已收藏(实心) */
  'star-filled': <path fill="currentColor" d="M12 3.5 14.4 9l5.9.6-4.4 4 1.3 5.8L12 16.3 6.8 19.4l1.3-5.8-4.4-4L9.6 9z" />,
  /* ⤓ 导出 */
  download: (<><path d="M12 4v11" /><path d="M7.5 10.5 12 15l4.5-4.5" /><path d="M5 19.5h14" /></>),
  /* 🗄 归档 */
  archive: (<><path d="M3.5 7.5h17" /><path d="M5 7.5V18a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 18V7.5" /><path d="M3.5 7.5 5 4.5h14l1.5 3" /><path d="M10 11.5h4" /></>),
  /* 🗑 删除 */
  trash: (<><path d="M4.5 7h15" /><path d="M9.5 7V5.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7" /><path d="M6.5 7l.7 12.1a1.5 1.5 0 0 0 1.5 1.4h6.6a1.5 1.5 0 0 0 1.5-1.4L17.5 7" /><path d="M10 11v5.5" /><path d="M14 11v5.5" /></>),
};

export function Icon({ name, className }: { name: IconName; className?: string }): React.ReactElement {
  return (
    <svg
      className={`hmh-icon${className !== undefined ? ` ${className}` : ''}`}
      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
    >{PATHS[name]}</svg>
  );
}
