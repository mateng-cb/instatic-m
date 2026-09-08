/**
 * Regression: static export must copy media from `{uploadsDir}/file`
 * (not `{uploadsDir}/uploads/file`) into the export tree as `uploads/file`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  diskRelPathForUploadsPublicUrl,
  exportPublishedSiteStatic,
} from '../../../server/publish/staticExport'
import {
  prepareInactiveSlot,
  swapSlot,
  writeArtefact,
} from '../../../server/publish/staticArtefact'

describe('diskRelPathForUploadsPublicUrl', () => {
  it('strips the /uploads/ HTTP mount prefix', () => {
    expect(diskRelPathForUploadsPublicUrl('/uploads/a.png')).toBe('a.png')
    expect(diskRelPathForUploadsPublicUrl('/uploads/fonts/x.woff2')).toBe('fonts/x.woff2')
    expect(diskRelPathForUploadsPublicUrl('/uploads/')).toBeNull()
    expect(diskRelPathForUploadsPublicUrl('/_instatic/x.css')).toBeNull()
  })
})

describe('exportPublishedSiteStatic media copy', () => {
  let uploadsDir: string
  let outDir: string

  beforeEach(async () => {
    uploadsDir = await mkdtemp(join(tmpdir(), 'static-export-media-up-'))
    outDir = await mkdtemp(join(tmpdir(), 'static-export-media-out-'))
  })

  afterEach(async () => {
    await rm(uploadsDir, { recursive: true, force: true })
    await rm(outDir, { recursive: true, force: true })
  })

  it('copies /uploads assets from uploadsDir root into export uploads/', async () => {
    const mediaName = 'hero-v1.png'
    const mediaBytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3])
    await writeFile(join(uploadsDir, mediaName), mediaBytes)

    const { slot, slotDir } = await prepareInactiveSlot(uploadsDir)
    await writeArtefact(
      slotDir,
      '/',
      `<!DOCTYPE html><html><body><img src="/uploads/${mediaName}" alt=""></body></html>`,
    )
    await swapSlot(uploadsDir, slot)

    const result = await exportPublishedSiteStatic({
      uploadsDir,
      outDir,
      pathMode: 'relative',
      layout: 'directory',
      basePath: '',
      expandHoles: {
        classify: async () => 'shared',
        renderShared: async () => '',
      },
    })

    expect(result.pageCount).toBe(1)
    const missing = result.report.filter((item) => item.code === 'missing-asset')
    expect(missing).toEqual([])

    const exported = await readFile(join(outDir, 'uploads', mediaName))
    expect([...exported]).toEqual([...mediaBytes])

    const html = await readFile(join(outDir, 'index.html'), 'utf8')
    expect(html).toContain(`src="uploads/${mediaName}"`)
  })
})
