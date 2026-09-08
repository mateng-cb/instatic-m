export type PathMode = 'basePath' | 'relative'

export interface StaticExportOptions {
  pathMode: PathMode
  /** 仅 pathMode==='basePath'；规范化为 '' 或 '/repo'（无尾斜杠） */
  basePath: string
  /** 导出根目录（绝对路径） */
  outDir: string
}

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
