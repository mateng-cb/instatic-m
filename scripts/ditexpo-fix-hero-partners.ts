/**
 * 修复已发布页的 hero videoHeadBg 尺寸，以及合作伙伴 logo 白底卡片样式。
 *
 *   INSTATIC_EMAIL=… INSTATIC_PASSWORD=… bun run scripts/ditexpo-fix-hero-partners.ts \
 *     [--api http://localhost:3001]
 *
 * 端点与凭据见 scripts/lib/cmsClient.ts（--api/--email/--password 或
 * INSTATIC_API/INSTATIC_EMAIL/INSTATIC_PASSWORD 环境变量）。
 */
import { join } from 'node:path'
import type { SiteDocument } from '@core/page-tree'
import { CmsClient, takeEndpointArgs } from './lib/cmsClient'

const REPORT = join(
  import.meta.dir,
  '../../DITExpohtml/doc/instatic-import-pack/验证报告-hero-partners-fix.json',
)

function patchRules(site: SiteDocument, steps: string[]) {
  const rules = site.styleRules ?? {}

  const overlay = Object.values(rules).find((r) => r.name === 'overlay-content' && r.kind === 'class')
  if (overlay) {
    overlay.styles = {
      ...overlay.styles,
      width: '835px',
      maxWidth: 'min(835px, 92%)',
      color: '#fff',
      textAlign: 'center',
    }
    overlay.updatedAt = Date.now()
    steps.push('patched .overlay-content width:835px (src parity)')
  } else {
    steps.push('WARN missing overlay-content rule')
  }

  const heroAmbient = Object.values(rules).find(
    (r) => r.selector === '.carousel-overlay .video-head-bg',
  )
  if (heroAmbient) {
    heroAmbient.styles = {
      ...heroAmbient.styles,
      width: '80%',
      height: 'auto',
      maxWidth: '80%',
      display: 'block',
      marginTop: '0px',
      marginRight: 'auto',
      marginBottom: '0px',
      marginLeft: 'auto',
      objectFit: 'contain',
    }
    heroAmbient.contextStyles = {
      ...heroAmbient.contextStyles,
      tablet: {
        ...(heroAmbient.contextStyles?.tablet ?? {}),
        width: '80%',
        height: 'auto',
        display: 'block',
        marginTop: '0px',
        marginRight: 'auto',
        marginBottom: '0px',
        marginLeft: 'auto',
        objectFit: 'contain',
      },
    }
    heroAmbient.stylePriorities = {
      ...(heroAmbient.stylePriorities ?? {}),
      width: 'important',
      height: 'important',
      objectFit: 'important',
    }
    heroAmbient.contextStylePriorities = {
      ...(heroAmbient.contextStylePriorities ?? {}),
      tablet: {
        ...(heroAmbient.contextStylePriorities?.tablet ?? {}),
        width: 'important',
        height: 'important',
        objectFit: 'important',
      },
    }
    heroAmbient.updatedAt = Date.now()
    steps.push('patched .carousel-overlay .video-head-bg width:80% + object-fit:contain')
  } else {
    steps.push('WARN missing .carousel-overlay .video-head-bg rule')
  }

  const partnerLi = Object.values(rules).find(
    (r) => r.selector === '.exhibitorRecommendList li',
  )
  if (partnerLi) {
    partnerLi.styles = {
      ...partnerLi.styles,
      listStyle: 'none',
      flexGrow: '0',
      flexShrink: '0',
      flexBasis: 'auto',
      width: 'auto',
    }
    partnerLi.updatedAt = Date.now()
    steps.push('patched .exhibitorRecommendList li flex lock')
  }

  const partnerImg = Object.values(rules).find(
    (r) => r.selector === '.exhibitorRecommendList li img',
  )
  if (partnerImg) {
    partnerImg.styles = {
      ...partnerImg.styles,
      display: 'block',
      width: '195px',
      height: '85px',
      maxWidth: '195px',
      objectFit: 'contain',
      objectPosition: 'center',
      paddingTop: '15px',
      paddingRight: '15px',
      paddingBottom: '15px',
      paddingLeft: '15px',
      boxSizing: 'content-box',
      backgroundColor: '#fff',
      backgroundImage: 'none',
      borderTopLeftRadius: '8px',
      borderTopRightRadius: '8px',
      borderBottomRightRadius: '8px',
      borderBottomLeftRadius: '8px',
    }
    partnerImg.stylePriorities = {
      ...(partnerImg.stylePriorities ?? {}),
      width: 'important',
      height: 'important',
      maxWidth: 'important',
      objectFit: 'important',
      backgroundColor: 'important',
      backgroundImage: 'important',
    }
    partnerImg.updatedAt = Date.now()
    steps.push('patched partner img 195x85 + kill LQIP bg')
  } else {
    steps.push('WARN missing partner img rule')
  }
}

function patchHeroImageNode(site: SiteDocument, steps: string[]) {
  const page = site.pages.find((p) => p.slug === 'index')
  if (!page) {
    steps.push('WARN no index page')
    return
  }
  let patched = 0
  for (const [id, node] of Object.entries(page.nodes)) {
    const raw = JSON.stringify(node)
    if (!/videoHeadBg|video-head-bg/.test(raw)) continue
    const props = (node as { props?: Record<string, unknown> }).props
    if (!props) continue
    if (props.style && typeof props.style === 'object') {
      const st = props.style as Record<string, unknown>
      st.width = '80%'
      st.height = 'auto'
    } else if (typeof props.style === 'string') {
      props.style = props.style
        .replace(/width\s*:\s*100%/, 'width: 80%')
        .replace(/width\s*:\s*80%/, 'width: 80%')
      if (!/width\s*:/.test(props.style)) props.style = `width: 80%; height: auto; ${props.style}`
    } else {
      props.style = { width: '80%', height: 'auto' }
    }
    patched++
    steps.push(`patched node ${id} hero style → width:80%`)
  }
  steps.push(`hero image nodes patched=${patched}`)
}

async function main() {
  const { endpoint } = takeEndpointArgs(process.argv.slice(2))
  const client = new CmsClient(endpoint)
  const steps: string[] = []
  const t0 = performance.now()

  await client.login()
  steps.push('login-ok')
  const { site, seq } = await client.loadSite()

  patchRules(site, steps)
  patchHeroImageNode(site, steps)

  await client.saveSite(site, seq)
  steps.push('site-document-saved')

  await client.stepUp()
  steps.push('step-up-ok')

  const pubJson = await client.publish()
  steps.push(`publish-ok ${JSON.stringify(pubJson)}`)

  const html = await (await fetch(client.publicUrl('/'))).text()
  const cssHref = html.match(/href="(\/_instatic\/css\/style-[^"]+)"/)?.[1]
  let cssChecks = {
    overlayWidth835: false,
    heroWidth80: false,
    partnerWhite: false,
    partnerNoBgImage: false,
    partnerFixed195: false,
  }
  if (cssHref) {
    const css = await (await fetch(client.publicUrl(cssHref))).text()
    cssChecks = {
      overlayWidth835: /\.overlay-content\s*\{[^}]*width:\s*835px/s.test(css),
      heroWidth80: /\.carousel-overlay\s+\.video-head-bg\s*\{[^}]*width:\s*80%/s.test(css),
      partnerWhite:
        /\.exhibitorRecommendList\s+li\s+img\s*\{[^}]*background-color:\s*#fff/s.test(css),
      partnerNoBgImage:
        /\.exhibitorRecommendList\s+li\s+img\s*\{[^}]*background-image:\s*none/s.test(css),
      partnerFixed195:
        /\.exhibitorRecommendList\s+li\s+img\s*\{[^}]*width:\s*195px/s.test(css),
    }
  }

  const report = {
    ok: Object.values(cssChecks).every(Boolean),
    cssChecks,
    expectedHeroCssPx: '0.8 * min(835px, 92vw) ≈ 668px on desktop',
    cssHref,
    durationMs: Math.round(performance.now() - t0),
    steps,
    at: new Date().toISOString(),
  }
  await Bun.write(REPORT, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exit(2)
}

main().catch(async (err) => {
  const report = {
    ok: false,
    error: err instanceof Error ? err.stack ?? err.message : String(err),
    at: new Date().toISOString(),
  }
  await Bun.write(REPORT, JSON.stringify(report, null, 2))
  console.error(JSON.stringify(report, null, 2))
  process.exit(1)
})
