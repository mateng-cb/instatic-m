/**
 * Page-internal `<style>` blocks keep their per-document scope on import.
 *
 * In the source site a page's inline `<style>` applies to that document only —
 * a page-level override (download.html's 42vh swiper height) must never leak
 * into the site-wide cascade and suppress the shared sheet's rule on every
 * other page. Default import therefore keeps each page's inline CSS as a
 * page-scoped stylesheet file (same shape as `mode: 'file'` linked sheets,
 * loaded after every linked sheet so it keeps its override position);
 * `inlineStyleMode: 'convert'` opts back into the legacy global-rules parse.
 *
 * Re-importing the same page must update that stylesheet file in place —
 * not append a `-2` twin on every run.
 */

import { describe, it, expect } from 'bun:test'
import '@modules/base'
import { buildImportPlan } from '@core/siteImport'
import type { FileMap } from '@core/siteImport'
import { addImportedStylesheets } from '@admin/pages/site/store/slices/site/importedSiteFiles'
import { makeSite } from '../fixtures'

const enc = new TextEncoder()

const pageHtml = (inline: string) => `<!doctype html><html><head>
    <link rel="stylesheet" href="css/shared.css">
    <style>${inline}</style>
  </head><body><div class="swiper-container">Hero</div></body></html>`

function fileMap(inlineIndex: string, inlineDownload: string): FileMap {
  return {
    files: {
      'index.html': { bytes: enc.encode(pageHtml(inlineIndex)), mimeType: 'text/html' },
      'download.html': { bytes: enc.encode(pageHtml(inlineDownload)), mimeType: 'text/html' },
      'css/shared.css': {
        bytes: enc.encode('.swiper-container { color: red; }'),
        mimeType: 'text/css',
      },
    },
  }
}

const INDEX_INLINE = '.swiper-container { height: 100vh !important; position: relative; }'
const DOWNLOAD_INLINE = '.swiper-container { height: 42vh !important; }'

describe('inline `<style>` import scope', () => {
  it("keeps each page's inline CSS as a page-scoped stylesheet file by default", () => {
    const plan = buildImportPlan({
      fileMap: fileMap(INDEX_INLINE, DOWNLOAD_INLINE),
      currentSite: makeSite(),
    })

    // Inline CSS never enters the site-wide rules cascade…
    expect(plan.styleRules.some((r) => JSON.stringify(r.styles).includes('42vh'))).toBe(false)
    expect(plan.styleRules.some((r) => JSON.stringify(r.styles).includes('100vh'))).toBe(false)
    // …while the shared converted sheet still does.
    expect(plan.styleRules.some((r) => r.kind === 'class' && r.name === 'swiper-container')).toBe(true)
    // The page cascades no longer carry the synthetic inline source.
    expect(plan.pages.every((p) => p.linkedCssPaths.every((c) => !c.endsWith('::inline')))).toBe(true)

    // Each page's inline CSS becomes a page-scoped stylesheet file.
    expect(plan.stylesheets).toHaveLength(2)
    const byPath = new Map(plan.stylesheets.map((s) => [s.path, s]))
    expect(byPath.get('index.html::inline')).toMatchObject({ pageSources: ['index.html'] })
    expect(byPath.get('index.html::inline')!.content).toContain('100vh')
    expect(byPath.get('download.html::inline')).toMatchObject({ pageSources: ['download.html'] })
    expect(byPath.get('download.html::inline')!.content).toContain('42vh')
  })

  it('loads inline sheets after every kept linked sheet', () => {
    const plan = buildImportPlan({
      fileMap: fileMap(INDEX_INLINE, DOWNLOAD_INLINE),
      currentSite: makeSite(),
      options: { stylesheetModes: { 'css/shared.css': 'file' } },
    })

    const shared = plan.stylesheets.find((s) => s.path === 'css/shared.css')!
    expect(shared).toBeDefined()
    const inlines = plan.stylesheets.filter((s) => s.path.endsWith('::inline'))
    expect(inlines).toHaveLength(2)
    for (const sheet of inlines) {
      expect(sheet.priority).toBeGreaterThan(shared.priority)
    }
  })

  it("still harvests Google fonts from a page's kept inline CSS", () => {
    const downloadInline =
      '@import url("https://fonts.googleapis.com/css2?family=Manrope:wght@400&display=swap");\n'
      + '.swiper-container { height: 42vh !important; }'
    const plan = buildImportPlan({
      fileMap: fileMap('', downloadInline),
      currentSite: makeSite(),
    })

    expect(plan.stylesheets).toHaveLength(1) // the empty index inline never registers
    expect(plan.googleFonts.map((f) => f.family)).toEqual(['Manrope'])
    expect(plan.stylesheets[0]!.content).not.toContain('@import')
    expect(plan.stylesheets[0]!.content).toContain('42vh')
  })

  it("parses inline CSS into global style rules with inlineStyleMode: 'convert'", () => {
    const plan = buildImportPlan({
      fileMap: fileMap(INDEX_INLINE, DOWNLOAD_INLINE),
      currentSite: makeSite(),
      options: { inlineStyleMode: 'convert' },
    })

    expect(plan.stylesheets).toHaveLength(0)
    const heights = plan.styleRules.filter((r) => JSON.stringify(r.styles).includes('vh'))
    expect(heights.map((r) => r.origin?.source).sort()).toEqual([
      'download.html::inline',
      'index.html::inline',
    ])
    expect(plan.pages.every((p) => p.linkedCssPaths.includes(`${p.source}::inline`))).toBe(true)
  })
})

describe('re-importing a page-scoped stylesheet file', () => {
  it('updates the same-path file in place instead of appending a -2 twin', () => {
    const site = makeSite()
    const commit = (content: string, pageIds: string[]) =>
      addImportedStylesheets(site, undefined, [
        {
          path: 'download.html::inline',
          content,
          pageSources: ['download.html'],
          priority: 100,
          pageIds,
        },
      ])

    const first = commit('.a { color: red }', ['p1'])
    const second = commit('.a { color: navy }', ['p2'])

    expect(site.files).toHaveLength(1)
    expect(second[0]!.id).toBe(first[0]!.id)
    expect(site.files[0]!.content).toBe('.a { color: navy }')
    expect(site.runtime?.styles?.[first[0]!.id]).toMatchObject({
      priority: 100,
      scope: { type: 'pages', pageIds: ['p2'] },
    })
  })
})
