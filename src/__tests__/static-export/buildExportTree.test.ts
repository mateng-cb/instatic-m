import { describe, expect, test } from 'bun:test'
import {
  buildExportTree,
  collectInstaticAssetRefs,
  StaticExportError,
  type ExportFsAdapter,
} from '../../../src/core/static-export/buildExportTree'

class RecordingFs implements ExportFsAdapter {
  readonly files = new Map<string, string>()
  readonly assets = new Map<string, Uint8Array>()
  readonly readCalls: string[] = []

  async readPublicAsset(publicPath: string): Promise<Uint8Array | null> {
    this.readCalls.push(publicPath)
    return this.assets.get(publicPath) ?? null
  }

  async writeFile(relPath: string, data: Uint8Array | string): Promise<void> {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
    this.files.set(relPath, text)
  }
}

describe('collectInstaticAssetRefs', () => {
  test('collects css/js and skips hole/form/loop API paths', () => {
    const html = `<link href="/_instatic/css/x.css">
<script src="/_instatic/assets/v1/app.js"></script>
<a href="/_instatic/hole/n1">hole</a>
<form action="/_instatic/form/submit"></form>
<img src="/_instatic/loop/items">`
    expect(collectInstaticAssetRefs(html).sort()).toEqual([
      '/_instatic/assets/v1/app.js',
      '/_instatic/css/x.css',
    ])
  })
})

describe('buildExportTree', () => {
  test('relative export rewrites and copies assets', async () => {
    const fs = new RecordingFs()
    fs.assets.set('/_instatic/css/x.css', new TextEncoder().encode('body{color:red}'))
    fs.assets.set('/uploads/hi.png', new Uint8Array([1, 2, 3]))

    const result = await buildExportTree({
      outDir: '/tmp/export',
      pathMode: 'relative',
      layout: 'directory',
      basePath: '',
      pages: [
        {
          url: '/',
          html: '<link href="/_instatic/css/x.css"><img src="/uploads/hi.png">',
        },
        {
          url: '/about',
          html: '<link href="/_instatic/css/x.css">',
        },
      ],
      fs,
      expandHoles: {
        classify: async () => 'shared',
        renderShared: async () => '',
      },
    })

    expect(result.pageCount).toBe(2)
    expect(result.outDir).toBe('/tmp/export')
    expect(fs.files.get('index.html')).toContain('href="_instatic/css/x.css"')
    expect(fs.files.get('about/index.html')).toContain('href="../_instatic/css/x.css"')
    expect(fs.files.get('_instatic/css/x.css')).toBe('body{color:red}')
    expect(fs.files.get('uploads/hi.png')).toBe('\x01\x02\x03')
    expect(fs.readCalls).toContain('/_instatic/css/x.css')
    expect(fs.readCalls).toContain('/uploads/hi.png')

    const manifest = JSON.parse(fs.files.get('manifest.json') ?? '{}') as {
      pathMode: string
      pages: string[]
    }
    expect(manifest.pathMode).toBe('relative')
    expect(manifest.pages).toEqual(['/', '/about'])
  })

  test('aborts on per-visitor hole', async () => {
    const fs = new RecordingFs()
    const html = '<instatic-hole data-instatic-hole="v1"></instatic-hole>'

    await expect(
      buildExportTree({
        outDir: '/tmp/export',
        pathMode: 'relative',
        layout: 'directory',
        basePath: '',
        pages: [{ url: '/', html }],
        fs,
        expandHoles: {
          classify: async () => 'per-visitor',
          renderShared: async () => '',
        },
      }),
    ).rejects.toMatchObject({
      name: 'StaticExportError',
      code: 'per-visitor-hole',
    } satisfies Partial<StaticExportError>)

    expect(fs.files.size).toBe(0)
  })

  test('records missing-asset warning without aborting', async () => {
    const fs = new RecordingFs()

    const result = await buildExportTree({
      outDir: '/tmp/export',
      pathMode: 'relative',
      layout: 'directory',
      basePath: '',
      pages: [{ url: '/', html: '<img src="/uploads/missing.png">' }],
      fs,
      expandHoles: {
        classify: async () => 'shared',
        renderShared: async () => '',
      },
    })

    expect(result.report.some((item) => item.code === 'missing-asset')).toBe(true)
    expect(fs.files.has('uploads/missing.png')).toBe(false)
  })

  test('collects and rewrites background uploads referenced only in linked css', async () => {
    const fs = new RecordingFs()
    const css = `footer{background-image:url(/uploads/footer-bg.webp);background-image:image-set(url(/uploads/footer-w64.webp) 0.5x)}`
    fs.assets.set('/_instatic/css/site.css', new TextEncoder().encode(css))
    fs.assets.set('/uploads/footer-bg.webp', new Uint8Array([9, 8, 7]))
    fs.assets.set('/uploads/footer-w64.webp', new Uint8Array([6, 5, 4]))

    await buildExportTree({
      outDir: '/tmp/export',
      pathMode: 'relative',
      layout: 'directory',
      basePath: '',
      pages: [{ url: '/', html: '<link href="/_instatic/css/site.css">' }],
      fs,
      expandHoles: {
        classify: async () => 'shared',
        renderShared: async () => '',
      },
    })

    expect(fs.files.get('_instatic/css/site.css')).toContain("url('../../uploads/footer-bg.webp')")
    expect(fs.files.get('_instatic/css/site.css')).toContain("url('../../uploads/footer-w64.webp')")
    expect(fs.files.get('uploads/footer-bg.webp')).toBe('\x09\x08\x07')
    expect(fs.files.get('uploads/footer-w64.webp')).toBe('\x06\x05\x04')
  })

  test('flat layout writes one .html per page beside index.html and cross-links them', async () => {
    const fs = new RecordingFs()

    await buildExportTree({
      outDir: '/tmp/export',
      pathMode: 'relative',
      layout: 'flat',
      basePath: '',
      pages: [
        {
          url: '/',
          html: '<a href="/about">About</a><img src="/uploads/hi.png">',
        },
        {
          url: '/about',
          html: '<a href="/">Home</a><a href="/about">Self</a>',
        },
      ],
      fs,
      expandHoles: {
        classify: async () => 'shared',
        renderShared: async () => '',
      },
    })

    // One flat file per page — no per-route directories.
    expect(fs.files.has('index.html')).toBe(true)
    expect(fs.files.has('about.html')).toBe(true)
    expect(fs.files.has('about/index.html')).toBe(false)

    // Cross-links target the sibling files, never a directory form.
    expect(fs.files.get('index.html')).toContain('href="about.html"')
    expect(fs.files.get('about.html')).toContain('href="index.html"')
    // Self-link resolves to the page file itself, not './'.
    expect(fs.files.get('about.html')).toContain('href="about.html"')

    const manifest = JSON.parse(fs.files.get('manifest.json') ?? '{}') as {
      layout: string
    }
    expect(manifest.layout).toBe('flat')
  })
})
