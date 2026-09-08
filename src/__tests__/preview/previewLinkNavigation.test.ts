/**
 * classifyPreviewLink / anchorForClickTarget — the preview link router.
 *
 * The contract that matters: in-site permalinks resolve to the page whose
 * `pagePublicPath` matches (one source of truth with the publisher), anchors
 * and external URLs are told apart, and inert hrefs report "no action".
 */
import { describe, expect, it } from 'bun:test'
import type { Page } from '@core/page-tree'
import { anchorForClickTarget, classifyPreviewLink } from '@site/preview/previewLinkNavigation'

function page(id: string, slug: string): Page {
  return {
    id,
    slug,
    title: slug,
    rootNodeId: 'root',
    nodes: {
      root: {
        id: 'root',
        moduleId: 'base.body',
        props: {},
        children: [],
        breakpointOverrides: {},
        locked: false,
        hidden: false,
      },
    },
  }
}

const PAGES = [
  page('home', 'index'),
  page('conf', 'conference'),
  page('nested', 'a/b'),
]

describe('classifyPreviewLink', () => {
  it('resolves the home permalink to the index page', () => {
    expect(classifyPreviewLink('/', PAGES)).toEqual({ kind: 'internal', pageId: 'home' })
  })

  it('resolves root-relative permalinks to their pages', () => {
    expect(classifyPreviewLink('/conference', PAGES)).toEqual({ kind: 'internal', pageId: 'conf' })
    expect(classifyPreviewLink('/a/b', PAGES)).toEqual({ kind: 'internal', pageId: 'nested' })
  })

  it('strips query and hash before matching, and trailing slashes', () => {
    expect(classifyPreviewLink('/conference?utm=1', PAGES)).toEqual({ kind: 'internal', pageId: 'conf' })
    expect(classifyPreviewLink('/conference#speakers', PAGES)).toEqual({
      kind: 'internal', pageId: 'conf',
    })
    expect(classifyPreviewLink('/conference/', PAGES)).toEqual({ kind: 'internal', pageId: 'conf' })
  })

  it('treats bare relative hrefs as site paths (srcDoc has no usable base)', () => {
    expect(classifyPreviewLink('conference', PAGES)).toEqual({ kind: 'internal', pageId: 'conf' })
  })

  it('reports root-relative paths no page answers to as dead links', () => {
    expect(classifyPreviewLink('/nope', PAGES)).toEqual({ kind: 'internal-missing', path: '/nope' })
  })

  it('lets same-document fragments through as anchors', () => {
    expect(classifyPreviewLink('#speakers', PAGES)).toEqual({ kind: 'anchor' })
    expect(classifyPreviewLink('#', PAGES)).toEqual({ kind: 'anchor' })
  })

  it('classifies absolute, scheme-relative, and other-scheme URLs as external', () => {
    expect(classifyPreviewLink('https://example.com/x', PAGES)).toEqual({
      kind: 'external', url: 'https://example.com/x',
    })
    expect(classifyPreviewLink('//cdn.example.com/lib.js', PAGES)).toEqual({
      kind: 'external', url: '//cdn.example.com/lib.js',
    })
    expect(classifyPreviewLink('mailto:team@expo.example', PAGES)).toEqual({
      kind: 'external', url: 'mailto:team@expo.example',
    })
  })

  it('ignores javascript: hrefs and empty hrefs — no preview action', () => {
    expect(classifyPreviewLink('javascript:void(0)', PAGES)).toBeNull()
    expect(classifyPreviewLink('', PAGES)).toBeNull()
    expect(classifyPreviewLink('   ', PAGES)).toBeNull()
  })
})

describe('anchorForClickTarget', () => {
  it('finds the anchor from the clicked element', () => {
    const a = document.createElement('a')
    a.setAttribute('href', '/conference')
    const span = document.createElement('span')
    a.appendChild(span)
    expect(anchorForClickTarget(span)).toBe(a)
  })

  it('returns the anchor itself when it is the target', () => {
    const a = document.createElement('a')
    a.setAttribute('href', '/conference')
    expect(anchorForClickTarget(a)).toBe(a)
  })

  it('returns null for non-element targets and anchors without href', () => {
    expect(anchorForClickTarget(null)).toBeNull()
    expect(anchorForClickTarget(document.createTextNode('text'))).toBeNull()
    const bare = document.createElement('a')
    expect(anchorForClickTarget(bare)).toBeNull()
  })
})
