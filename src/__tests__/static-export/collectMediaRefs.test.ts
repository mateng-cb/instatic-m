import { describe, expect, test } from 'bun:test'
import { collectMediaRefs } from '../../../src/core/static-export/collectMediaRefs'

describe('collectMediaRefs', () => {
  test('collects /uploads paths from img src and css url', () => {
    const html = `<img src="/uploads/a.png"><style>x{background:url("/uploads/b.webp")}</style>`
    const refs = collectMediaRefs(html)
    expect(refs.sort()).toEqual(['/uploads/a.png', '/uploads/b.webp'])
  })

  test('collects from srcset tokens', () => {
    const html = `<img srcset="/uploads/a.png 1x, /uploads/a@2x.png 2x">`
    expect(collectMediaRefs(html).sort()).toEqual(['/uploads/a.png', '/uploads/a@2x.png'])
  })

  test('dedupes and ignores non-uploads', () => {
    const html = `<img src="/uploads/a.png"><img src="/uploads/a.png"><img src="/_instatic/x.png"><a href="/about">`
    expect(collectMediaRefs(html)).toEqual(['/uploads/a.png'])
  })
})
