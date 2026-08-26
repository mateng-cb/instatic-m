import { describe, expect, test } from 'bun:test'
import { applyHoleExpansion } from '../../../src/core/static-export/expandHoles'

describe('applyHoleExpansion', () => {
  test('fails on per-visitor hole', async () => {
    const html = `<instatic-hole data-instatic-hole="v1"></instatic-hole>`
    const result = await applyHoleExpansion(html, {
      pageUrl: '/',
      classify: async () => 'per-visitor',
      renderShared: async () => '',
    })
    expect(result.ok).toBe(false)
    expect(result.report[0]?.code).toBe('per-visitor-hole')
    expect(result.report[0]?.severity).toBe('error')
  })

  test('treats unknown like per-visitor (fail)', async () => {
    const html = `<instatic-hole data-instatic-hole="u1"></instatic-hole>`
    const result = await applyHoleExpansion(html, {
      pageUrl: '/',
      classify: async () => 'unknown',
      renderShared: async () => '',
    })
    expect(result.ok).toBe(false)
    expect(result.report[0]?.code).toBe('per-visitor-hole')
  })

  test('inlines shared hole HTML and records info', async () => {
    const html = `<p>before</p><instatic-hole data-instatic-hole="s1"></instatic-hole><p>after</p>`
    const result = await applyHoleExpansion(html, {
      pageUrl: '/',
      classify: async () => 'shared',
      renderShared: async (id) => `<p data-x="${id}">frozen</p>`,
    })
    expect(result.ok).toBe(true)
    expect(result.html).toContain('frozen')
    expect(result.html).toContain('before')
    expect(result.html).not.toContain('instatic-hole')
    expect(result.report.some((i) => i.code === 'shared-hole-frozen' && i.severity === 'info')).toBe(
      true,
    )
  })

  test('removes hole-runtime script when no holes remain', async () => {
    const html = `<head><script type="module" src="/_instatic/hole-runtime.js?v=1" defer></script></head><body><instatic-hole data-instatic-hole="s1"></instatic-hole></body>`
    const result = await applyHoleExpansion(html, {
      pageUrl: '/',
      classify: async () => 'shared',
      renderShared: async () => `<span>ok</span>`,
    })
    expect(result.ok).toBe(true)
    expect(result.html).not.toMatch(/hole-runtime\.js/)
  })
})
