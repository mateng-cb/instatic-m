export type {
  ExportReportItem,
  ExportSeverity,
  PathMode,
  StaticExportOptions,
  StaticExportResult,
} from './types'

export { depthOfExportPath, exportPathForUrl, hrefBetween } from './routeLayout'
export type { RewriteDocumentUrlsOptions, RewriteRootAbsolutePathContext } from './rewriteUrls'
export {
  isRootAbsoluteSitePath,
  normalizeBasePath,
  rewriteDocumentUrls,
  rewriteRootAbsolutePath,
} from './rewriteUrls'
export type { ExpandHolesHooks, ExpandHolesResult } from './expandHoles'
export { applyHoleExpansion } from './expandHoles'
export type { HoleKind, ScanHtmlOptions } from './scanDynamic'
export { classifyHoleKind, scanHtmlForStaticExportIssues } from './scanDynamic'
