import { describe, expect, test } from 'bun:test'
import {
  classifyHoleKind,
  scanHtmlForStaticExportIssues,
} from '../../../src/core/static-export/scanDynamic'

describe('scanHtmlForStaticExportIssues', () => {
  test('flags instatic-hole placeholders', () => {
    const html = `<instatic-hole id="hole-n1" data-instatic-hole="n1" data-instatic-version="3"></instatic-hole>`
    const items = scanHtmlForStaticExportIssues(html, { pageUrl: '/about' })
    expect(items.some((i) => i.code === 'hole-present' && i.nodeId === 'n1')).toBe(true)
  })

  test('flags forms posting to instatic', () => {
    const html = `<form action="/_instatic/form/submit" method="post"></form>`
    const items = scanHtmlForStaticExportIssues(html, { pageUrl: '/' })
    expect(items.some((i) => i.code === 'form-static' && i.severity === 'warning')).toBe(true)
  })
})

describe('classifyHoleKind', () => {
  test('maps per-visitor reasons', () => {
    expect(classifyHoleKind('per-visitor')).toBe('per-visitor')
    expect(classifyHoleKind('node "n1": loop source "x" is per-visitor')).toBe('per-visitor')
    expect(classifyHoleKind('perVisitor')).toBe('per-visitor')
  })

  test('maps request-dependent and other reasons to shared', () => {
    expect(classifyHoleKind('request-dependent')).toBe('shared')
    expect(
      classifyHoleKind('node "n1": binding "title" source "route.query.x" is request-dependent'),
    ).toBe('shared')
    expect(classifyHoleKind('module is flagged dynamic')).toBe('shared')
  })

  test('maps missing reason to unknown', () => {
    expect(classifyHoleKind(undefined)).toBe('unknown')
    expect(classifyHoleKind(null)).toBe('unknown')
    expect(classifyHoleKind('')).toBe('unknown')
    expect(classifyHoleKind('   ')).toBe('unknown')
  })
})
