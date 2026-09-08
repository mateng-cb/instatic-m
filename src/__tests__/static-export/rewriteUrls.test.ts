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
      layout: 'directory',
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
      layout: 'directory',
      basePath: '',
      exportFilePath: 'about/index.html',
    })
    expect(out).toContain('href="../_instatic/css/style-abc.css"')
    expect(out).toContain('src="../uploads/img/a.png"')
    // Same-page link /about from about/index.html → ./
    expect(out).toMatch(/href="\.\/"/)
  })
})

describe('rewriteDocumentUrls relative — flat layout', () => {
  test('links target sibling .html files from the root page', () => {
    const out = rewriteDocumentUrls(sample, {
      pathMode: 'relative',
      layout: 'flat',
      basePath: '',
      exportFilePath: 'index.html',
    })
    expect(out).toContain('href="about.html"')
    // Assets stay layout-independent: depth 0 from index.html.
    expect(out).toContain('href="_instatic/css/style-abc.css"')
    expect(out).toContain('src="uploads/img/a.png"')
  })

  test('links back to the root page use index.html, not a directory form', () => {
    const out = rewriteDocumentUrls('<a href="/">Home</a>', {
      pathMode: 'relative',
      layout: 'flat',
      basePath: '',
      exportFilePath: 'about.html',
    })
    expect(out).toContain('href="index.html"')
  })

  test('same-page link resolves to the page file itself, never "./"', () => {
    // "./" would resolve to the parent directory of about.html — wrong file.
    const out = rewriteDocumentUrls('<a href="/about">Self</a>', {
      pathMode: 'relative',
      layout: 'flat',
      basePath: '',
      exportFilePath: 'about.html',
    })
    expect(out).toContain('href="about.html"')
  })

  test('nested flat pages climb out of their directory', () => {
    const out = rewriteDocumentUrls('<a href="/">Home</a><a href="/other">Other</a>', {
      pathMode: 'relative',
      layout: 'flat',
      basePath: '',
      exportFilePath: 'a/b.html',
    })
    expect(out).toContain('href="../index.html"')
    expect(out).toContain('href="../other.html"')
  })
})

describe('rewriteStylesheetUrls relative', () => {
  test('rewrites background-image and image-set uploads from css file depth', () => {
    const css = `footer{background-image:url(/uploads/footer-w1935.webp);background-image:image-set(url(/uploads/footer-w64.webp) 0.06x, url(/uploads/footer-w320.webp) 0.31x)}`
    const out = rewriteStylesheetUrls(css, {
      pathMode: 'relative',
      layout: 'directory',
      basePath: '',
      exportFilePath: '_instatic/css/style-abc.css',
    })
    expect(out).toContain("url('../../uploads/footer-w1935.webp')")
    expect(out).toContain("url('../../uploads/footer-w64.webp')")
    expect(out).toContain("url('../../uploads/footer-w320.webp')")
  })
})
