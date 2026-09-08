export type PathMode = 'basePath' | 'relative'

/**
 * 导出文件布局。`directory`：`/x` → `x/index.html`（默认）；
 * `flat`：`/x` → `x.html`（与 index.html 同级平铺，匹配多数源站的扁平路由）。
 */
export type ExportLayout = 'directory' | 'flat'

export type ExportSeverity = 'error' | 'warning' | 'info'

export interface ExportReportItem {
  severity: ExportSeverity
  code: 'per-visitor-hole' | 'shared-hole-frozen' | 'form-static' | 'missing-asset' | string
  message: string
  pageUrl?: string
  nodeId?: string
}

export interface StaticExportResult {
  outDir: string
  pageCount: number
  report: ExportReportItem[]
}
