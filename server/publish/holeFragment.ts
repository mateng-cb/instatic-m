/**
 * Request-time hole fragment renderer — shared by the Layer C hole HTTP
 * endpoint and static export (shared-hole inlining).
 */

import type { DbClient } from '../db/client'
import type { Page, PageNode, SiteDocument } from '@core/page-tree'
import type { SourceRequestContext } from '@core/loops/types'
import { registry } from '@core/module-engine'
import { loopSourceRegistry } from '@core/loops/registry'
import { renderNode, type RenderAccumulators, type RenderConfig } from '@core/publisher'
import { buildPageFrame, buildRouteFrame, buildSiteFrame } from '@core/templates/contextFrames'
import { prefetchLoopData } from './loopPrefetch'
import { stampFormPageTokens } from '../forms/formRuntime'

/**
 * Whether a hole must be rendered per visitor (bypass cache, read cookies).
 * Only `perVisitor` loop sources qualify — a module `render()` cannot read
 * cookies, so module holes are always shared-cacheable.
 */
export function isPerVisitorHole(node: PageNode): boolean {
  if (node.moduleId !== 'base.loop') return false
  const sourceId = typeof node.props.sourceId === 'string' ? node.props.sourceId : ''
  if (!sourceId) return false
  return loopSourceRegistry.get(sourceId)?.perVisitor === true
}

/**
 * Render one node subtree at request time. Builds the same named frames the
 * full-page publisher builds (route/page/site) plus pre-fetched loop data for
 * loops INSIDE this subtree, then renders fully (no `<instatic-hole>` recursion).
 */
export async function renderHoleFragment(
  nodeId: string,
  page: Page,
  site: SiteDocument,
  db: DbClient,
  pageUrl: URL,
  request: SourceRequestContext,
): Promise<string> {
  const route = buildRouteFrame(pageUrl.toString())
  const loopData = await prefetchLoopData(page, site, db, pageUrl, {
    request,
    rootNodeId: nodeId,
  })
  const config: RenderConfig = {
    page,
    site,
    registry,
    breakpointId: undefined,
    loopData,
    templateContext: {
      entryStack: [],
      page: buildPageFrame(page),
      site: buildSiteFrame(site),
      route,
    },
    // No dynamicNodeIds: inside a hole render we emit the full subtree.
  }
  const acc: RenderAccumulators = {
    cssMap: new Map(),
    jsMap: new Map(),
    infiniteLoopIds: new Set(),
    holeNodeIds: new Set(),
    cspSources: new Map(),
  }
  return stampFormPageTokens(renderNode(nodeId, config, acc), page.id)
}

/**
 * Render a shared (cacheable) hole for static export — empty query, no cookies.
 */
export async function renderSharedHoleFragment(
  nodeId: string,
  page: Page,
  site: SiteDocument,
  db: DbClient,
  pageUrl: URL,
): Promise<string> {
  const route = buildRouteFrame(pageUrl.toString())
  const request: SourceRequestContext = {
    query: Object.fromEntries(pageUrl.searchParams),
    path: route.path,
    slug: route.slug,
    cookies: {},
  }
  return renderHoleFragment(nodeId, page, site, db, pageUrl, request)
}
