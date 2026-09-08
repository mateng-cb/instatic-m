import { describe, expect, test } from 'bun:test'
import { rewriteDocumentUrls, rewriteStylesheetUrls } from '../../../src/core/static-export/rewriteUrls'

const sample = `<!doctype html><html><head>
<link rel="stylesheet" href="/_instatic/css/style-abc.css">
<script type="importmap">{"imports":{"x":"/_instatic/runtime/cache/h/x.js"}}</script>
</head><body>
<img src="/uploads/img/a.png" srcset="/uploads/img/a.png 1x">
<a href="/about">About</a>
<style>.h{background:url('/uploads/img/b.png')}</style>
</body></html>`

describe('rewriteDocumentUrls basePath', () => {
  test('prefixes root-absolute site assets', () => {
    const out = rewriteDocumentUrls(sample, {
      pathMode: 'basePath',
      basePath: '/my-repo',
      exportFilePath: 'index.html',
    })
    expect(out).toContain('href="/my-repo/_instatic/css/style-abc.css"')
    expect(out).toContain('src="/my-repo/uploads/img/a.png"')
    expect(out).toContain('href="/my-repo/about"')
    expect(out).toContain("url('/my-repo/uploads/img/b.png')")
    expect(out).toContain('"/my-repo/_instatic/runtime/cache/h/x.js"')
  })
})

describe('rewriteDocumentUrls relative', () => {
  test('rewrites from nested page', () => {
    const out = rewriteDocumentUrls(sample, {
      pathMode: 'relative',
      basePath: '',
      exportFilePath: 'about/index.html',
    })
    expect(out).toContain('href="../_instatic/css/style-abc.css"')
    expect(out).toContain('src="../uploads/img/a.png"')
    // Same-page link /about from about/index.html → ./
    expect(out).toMatch(/href="\.\/"/)
  })
})

describe('rewriteStylesheetUrls relative', () => {
  test('rewrites background-image and image-set uploads from css file depth', () => {
    const css = `footer{background-image:url(/uploads/footer-w1935.webp);background-image:image-set(url(/uploads/footer-w64.webp) 0.06x, url(/uploads/footer-w320.webp) 0.31x)}`
    const out = rewriteStylesheetUrls(css, {
      pathMode: 'relative',
      basePath: '',
      exportFilePath: '_instatic/css/style-abc.css',
    })
    expect(out).toContain("url('../../uploads/footer-w1935.webp')")
    expect(out).toContain("url('../../uploads/footer-w64.webp')")
    expect(out).toContain("url('../../uploads/footer-w320.webp')")
  })
})
