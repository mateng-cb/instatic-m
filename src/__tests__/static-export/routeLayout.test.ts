import { describe, expect, test } from 'bun:test'
import { exportPathForUrl, depthOfExportPath, hrefBetween } from '../../../src/core/static-export/routeLayout'

describe('routeLayout — directory (default)', () => {
  test('maps / to index.html', () => {
    expect(exportPathForUrl('/')).toBe('index.html')
  })
  test('maps /about to about/index.html', () => {
    expect(exportPathForUrl('/about')).toBe('about/index.html')
  })
  test('maps /a/b to a/b/index.html', () => {
    expect(exportPathForUrl('/a/b')).toBe('a/b/index.html')
  })
})

describe('routeLayout — flat', () => {
  test('maps / to index.html', () => {
    expect(exportPathForUrl('/', 'flat')).toBe('index.html')
  })
  test('maps /about to about.html (sibling of index.html)', () => {
    expect(exportPathForUrl('/about', 'flat')).toBe('about.html')
  })
  test('maps /a/b to a/b.html (nested path keeps its directory)', () => {
    expect(exportPathForUrl('/a/b', 'flat')).toBe('a/b.html')
  })
})

describe('routeLayout — depth and hrefs', () => {
  test('depthOfExportPath counts directories', () => {
    expect(depthOfExportPath('index.html')).toBe(0)
    expect(depthOfExportPath('about/index.html')).toBe(1)
    expect(depthOfExportPath('a/b/index.html')).toBe(2)
    expect(depthOfExportPath('about.html')).toBe(0)
    expect(depthOfExportPath('a/b.html')).toBe(1)
  })
  test('hrefBetween builds relative prefix', () => {
    expect(hrefBetween('about/index.html', '_instatic/css/x.css')).toBe('../_instatic/css/x.css')
    expect(hrefBetween('index.html', '_instatic/css/x.css')).toBe('_instatic/css/x.css')
  })
})
