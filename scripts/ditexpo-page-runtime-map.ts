export type PageRuntimeNeeds = {
  /** 汉堡菜单 + 侧栏 fixedewm + 倒计时/同期活动（DOM 匹配时由 sharedClassic 覆盖） */
  sharedClassic: boolean
  newsSwiper: boolean
  extraScripts: { path: string; format: 'classic' | 'module'; source: string; priority?: number }[]
}

export function runtimeNeedsForSlug(slug: string): PageRuntimeNeeds {
  const base: PageRuntimeNeeds = {
    sharedClassic: true,
    newsSwiper: false,
    extraScripts: [],
  }
  if (slug === 'index' || slug === 'en-index' || slug === 'news') base.newsSwiper = true
  // Batch3（live/map/floor-plan/surroundings/transportation/pdf）：
  // 源站页面只初始化移动端菜单（已由 sharedClassic 覆盖）。
  // map.html 是静态楼层图，无 mapModal；弹层/缩放在首页 JS 里。
  // pdf.html 是直接 PDF 链接，无阅读器脚本；上传后的 href 需另行修正。
  return base
}
