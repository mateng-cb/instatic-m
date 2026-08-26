/**
 * Hole expansion hooks for static export — classify dynamic nodes from the
 * published snapshot and inline shared holes at export time.
 */

import type { DbClient } from '../db/client'
import { registry } from '@core/module-engine'
import type { BuildExportTreeInput } from '@core/static-export/buildExportTree'
import { classifyHoleKind } from '@core/static-export/scanDynamic'
import { findDynamicNodesWithReasons } from '@core/publisher/dynamicDetection'
import { buildPageFrame } from '@core/templates/contextFrames'
import { getPublishedNodeIndexForVersion } from './publishedSnapshotCache'
import { getPublishVersion } from './publishState'
import { isPerVisitorHole, renderSharedHoleFragment } from './holeFragment'

function parseReasonNodeId(reason: string): string | null {
  const match = reason.match(/^node "([^"]+)"/)
  return match?.[1] ?? null
}

export function createStaticExportHoleHooks(
  db: DbClient,
): BuildExportTreeInput['expandHoles'] {
  let reasonByNodeId: Map<string, string> | null = null

  async function loadReasonMap(): Promise<Map<string, string>> {
    if (reasonByNodeId) return reasonByNodeId
    const map = new Map<string, string>()
    const snap = await getPublishedNodeIndexForVersion(db, getPublishVersion())
    if (snap) {
      for (const page of snap.site.pages) {
        const { reasons } = findDynamicNodesWithReasons(page, snap.site, registry)
        for (const reason of reasons) {
          const nodeId = parseReasonNodeId(reason)
          if (nodeId && !map.has(nodeId)) map.set(nodeId, reason)
        }
      }
    }
    reasonByNodeId = map
    return map
  }

  return {
    classify: async (nodeId, _pageUrl) => {
      const reasons = await loadReasonMap()
      const reason = reasons.get(nodeId)
      if (reason) return classifyHoleKind(reason)

      const snap = await getPublishedNodeIndexForVersion(db, getPublishVersion())
      const page = snap?.nodeIndex.get(nodeId)
      const node = page?.nodes[nodeId]
      if (node && isPerVisitorHole(node)) return 'per-visitor'

      return 'unknown'
    },
    renderShared: async (nodeId, pageUrl) => {
      const snap = await getPublishedNodeIndexForVersion(db, getPublishVersion())
      if (!snap) throw new Error('Site not published')
      const page = snap.nodeIndex.get(nodeId)
      if (!page) throw new Error(`Published page not found for hole node "${nodeId}"`)

      let resolvedUrl: URL
      try {
        resolvedUrl = new URL(pageUrl, 'http://static-export.local')
      } catch {
        resolvedUrl = new URL(buildPageFrame(page).permalink, 'http://static-export.local')
      }

      return renderSharedHoleFragment(nodeId, page, snap.site, db, resolvedUrl)
    },
  }
}
