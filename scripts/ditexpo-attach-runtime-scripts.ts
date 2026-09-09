/**
 * 为 DITExpo 页面挂载运行时脚本（共享 classic / 新闻 Swiper / 额外脚本），
 * 按需解析 swiper 依赖，保存 site-document、发布并校验。
 *
 *   bun run scripts/ditexpo-attach-runtime-scripts.ts --slug index
 *   bun run scripts/ditexpo-attach-runtime-scripts.ts --slug introduce
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import { pageFromRow } from '../src/core/data/pageFromRow'
import { visualComponentFromRow } from '../src/core/data/componentFromRow'
import { savedLayoutFromRow } from '../src/core/data/layoutFromRow'
import type { SiteDocument } from '../src/core/page-tree'
import {
  DEFAULT_SCRIPT_RUNTIME_CONFIG,
  type SiteScriptRuntimeConfig,
} from '../src/core/site-runtime'
import { runtimeNeedsForSlug } from './ditexpo-page-runtime-map'

const API = 'http://localhost:3001/admin/api/cms'
const EMAIL = 'admin@ditexpo.local'
const PASSWORD = 'DitexpoVerify1!'
const PACKS_ROOT = join(import.meta.dir, '../../DITExpohtml/doc/instatic-packs')
const LEGACY_PACK = join(import.meta.dir, '../../DITExpohtml/doc/instatic-import-pack')

const CLASSIC_PATH = 'src/scripts/ditexpo-shared-classic.js'
const LEGACY_CLASSIC_PATH = 'src/scripts/ditexpo-home-classic.js'
const SWIPER_PATH = 'src/scripts/ditexpo-news-swiper.js'

const CLASSIC_SOURCE = String.raw`/* ditexpo-shared-classic — 倒计时 + 汉堡菜单 + 侧栏菜单 + 同期活动 */
(function () {
  /** HTML 导入会去掉 button 内空 <span>；这里补回三条汉堡图标线。 */
  function ensureHamburgerBars(btn) {
    if (!btn) return;
    if (btn.querySelectorAll('span').length >= 3) return;
    btn.textContent = '';
    for (var i = 0; i < 3; i++) btn.appendChild(document.createElement('span'));
  }

  function initCountdown() {
    var targetDate = new Date('2026-12-10T09:00:00');

    function updateCountdown() {
      var now = new Date();
      var timeDiff = targetDate - now;

      if (timeDiff <= 0) {
        var mobileCountdownTimer = document.querySelector('.mobile-countdown-timer');
        var desktopCountdownTimer = document.querySelector('.desktop-countdown-timer');
        if (mobileCountdownTimer) {
          mobileCountdownTimer.innerHTML =
            '<div style="text-align: center; font-size: 18px; color: #fff;">展会已结束</div>';
        }
        if (desktopCountdownTimer) {
          desktopCountdownTimer.innerHTML =
            '<div style="text-align: center; font-size: 20px; color: #000;">展会已结束</div>';
        }
        return;
      }

      var days = Math.floor(timeDiff / (1000 * 60 * 60 * 24));
      var hours = Math.floor((timeDiff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      var minutes = Math.floor((timeDiff % (1000 * 60 * 60)) / (1000 * 60));
      var seconds = Math.floor((timeDiff % (1000 * 60)) / 1000);

      var daysStr = days.toString().padStart(3, '0');
      var hoursStr = hours.toString().padStart(2, '0');
      var minutesStr = minutes.toString().padStart(2, '0');
      var secondsStr = seconds.toString().padStart(2, '0');
      var timeValues = [
        hoursStr[0], hoursStr[1],
        minutesStr[0], minutesStr[1],
        secondsStr[0], secondsStr[1],
      ];

      function flipDigits(nodes, values) {
        nodes.forEach(function (digit, index) {
          var newValue = values[index];
          if (newValue == null || digit.textContent === newValue) return;
          digit.classList.add('flip');
          setTimeout(function () {
            digit.textContent = newValue;
            digit.classList.remove('flip');
          }, 300);
        });
      }

      flipDigits(document.querySelectorAll('.desktop-days-digit'), daysStr);
      flipDigits(document.querySelectorAll('.desktop-time-digit'), timeValues);
      flipDigits(document.querySelectorAll('.mobile-days-digit'), daysStr);
      flipDigits(document.querySelectorAll('.mobile-time-digit'), timeValues);
    }

    updateCountdown();
    setInterval(updateCountdown, 1000);
  }

  function initMobileMenu() {
    var mobileMenuToggle = document.getElementById('mobileMenuToggle');
    var nav = document.querySelector('.nav');
    if (!mobileMenuToggle || !nav) return;

    ensureHamburgerBars(mobileMenuToggle);

    mobileMenuToggle.addEventListener('click', function () {
      nav.classList.toggle('active');
      mobileMenuToggle.classList.toggle('active');
      document.body.style.overflow = nav.classList.contains('active') ? 'hidden' : 'auto';
    });

    document.addEventListener('click', function (e) {
      var fixed = document.querySelector('.fixedewm');
      if (
        !nav.contains(e.target) &&
        !mobileMenuToggle.contains(e.target) &&
        nav.classList.contains('active') &&
        !(fixed && fixed.contains(e.target))
      ) {
        nav.classList.remove('active');
        mobileMenuToggle.classList.remove('active');
        document.body.style.overflow = 'auto';
      }
    });

    window.addEventListener('resize', function () {
      if (window.innerWidth > 768) {
        nav.classList.remove('active');
        mobileMenuToggle.classList.remove('active');
        document.body.style.overflow = 'auto';
      }
    });

    document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
      anchor.addEventListener('click', function () {
        if (nav.classList.contains('active')) {
          nav.classList.remove('active');
          mobileMenuToggle.classList.remove('active');
          document.body.style.overflow = 'auto';
        }
      });
    });
  }

  function initMobileFixedMenu() {
    var fixedMenu = document.querySelector('.fixedewm');
    if (!fixedMenu) return;

    var isInitialized = false;
    var outsideClickHandler = null;

    function isMobile() {
      return window.innerWidth <= 768;
    }
    function collapseMenu() {
      fixedMenu.classList.remove('mobile-expanded');
      fixedMenu.classList.add('mobile-collapsed');
    }
    function expandMenu() {
      fixedMenu.classList.remove('mobile-collapsed');
      fixedMenu.classList.add('mobile-expanded');
    }

    function setup() {
      if (outsideClickHandler) {
        document.removeEventListener('click', outsideClickHandler);
        outsideClickHandler = null;
      }

      if (isMobile()) {
        collapseMenu();
        if (!isInitialized) {
          fixedMenu.addEventListener('click', function (e) {
            if (e.target.tagName === 'A' || e.target.closest('a')) return;
            e.preventDefault();
            e.stopPropagation();
            if (fixedMenu.classList.contains('mobile-collapsed')) expandMenu();
            else collapseMenu();
          });
          fixedMenu.querySelectorAll('.menu-item a').forEach(function (item) {
            item.addEventListener('click', function () {
              setTimeout(collapseMenu, 200);
            });
          });
          isInitialized = true;
        }
        outsideClickHandler = function (e) {
          var nav = document.querySelector('.nav');
          var toggle = document.getElementById('mobileMenuToggle');
          if (
            !fixedMenu.contains(e.target) &&
            fixedMenu.classList.contains('mobile-expanded') &&
            !(nav && nav.contains(e.target)) &&
            !(toggle && toggle.contains(e.target))
          ) {
            collapseMenu();
          }
        };
        document.addEventListener('click', outsideClickHandler);
      } else {
        fixedMenu.classList.remove('mobile-collapsed', 'mobile-expanded');
        isInitialized = false;
      }
    }

    setup();
    window.addEventListener('resize', setup);
  }

  function initConferenceList() {
    var conferenceList = document.getElementById('conferenceList');
    var viewMoreBtn = document.getElementById('viewMoreBtn');
    if (!conferenceList || !viewMoreBtn) return;

    var titles = conferenceList.querySelectorAll('.conference-title');
    var allContentItems = conferenceList.querySelectorAll('.conference-content');
    if (allContentItems.length <= 6) {
      viewMoreBtn.classList.add('hidden');
      return;
    }

    var concurrentEventsTitle = null;
    titles.forEach(function (title) {
      if (title.textContent.trim() === '同期活动') concurrentEventsTitle = title;
    });
    if (!concurrentEventsTitle) {
      viewMoreBtn.classList.add('hidden');
      return;
    }

    var concurrentEventsItems = [];
    var foundConcurrentEvents = false;
    allContentItems.forEach(function (item) {
      if (foundConcurrentEvents) {
        if (
          item.previousElementSibling &&
          item.previousElementSibling.classList.contains('conference-title')
        ) {
          return;
        }
        concurrentEventsItems.push(item);
      } else {
        var currentItem = item;
        while (currentItem.previousElementSibling) {
          currentItem = currentItem.previousElementSibling;
          if (
            currentItem.classList.contains('conference-title') &&
            currentItem.textContent.trim() === '同期活动'
          ) {
            foundConcurrentEvents = true;
            concurrentEventsItems.push(item);
            break;
          }
        }
      }
    });

    if (concurrentEventsItems.length <= 6) {
      viewMoreBtn.classList.add('hidden');
      return;
    }

    concurrentEventsItems.forEach(function (item, index) {
      item.style.display = index >= 6 ? 'none' : 'block';
    });

    var isExpanded = false;
    viewMoreBtn.addEventListener('click', function () {
      isExpanded = !isExpanded;
      concurrentEventsItems.forEach(function (item, index) {
        if (index >= 6) item.style.display = isExpanded ? 'block' : 'none';
      });
      viewMoreBtn.textContent = isExpanded ? '收起《' : '查看全部》';
    });
  }

  initCountdown();
  initMobileMenu();
  initMobileFixedMenu();
  initConferenceList();
})();
`

const SWIPER_SOURCE = `import Swiper from 'swiper'
import { Autoplay, Pagination } from 'swiper/modules'

const el = document.querySelector('.news-swiper')
if (el) {
  new Swiper('.news-swiper', {
    modules: [Autoplay, Pagination],
    loop: true,
    autoplay: {
      delay: 5000,
      disableOnInteraction: false,
    },
    speed: 800,
    pagination: {
      el: '.swiper-pagination',
      clickable: true,
      bulletClass: 'swiper-pagination-bullet',
      bulletActiveClass: 'swiper-pagination-bullet-active',
    },
    effect: 'slide',
    allowTouchMove: true,
    grabCursor: true,
    breakpoints: {
      320: { slidesPerView: 1, spaceBetween: 20 },
      768: { slidesPerView: 1, spaceBetween: 30 },
      1024: { slidesPerView: 1, spaceBetween: 30 },
    },
  })
}
`

function parseArgs(argv: string[]) {
  let slug = 'index'
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--slug') slug = argv[++i] ?? slug
  }
  return { slug, report: reportPathForSlug(slug) }
}

function reportPathForSlug(slug: string): string {
  const packDir = join(PACKS_ROOT, slug)
  if (existsSync(packDir)) {
    return join(packDir, `验证报告-runtime-scripts-${slug}.json`)
  }
  if (slug === 'index') {
    return join(LEGACY_PACK, '验证报告-runtime-scripts.json')
  }
  return join(LEGACY_PACK, `验证报告-runtime-scripts-${slug}.json`)
}

function publicUrlForSlug(slug: string): string {
  return slug === 'index' ? 'http://localhost:3001/' : `http://localhost:3001/${slug}`
}

class CookieJar {
  private cookies = new Map<string, string>()
  absorb(res: Response) {
    const raw = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : []
    const list = raw.length ? raw : ([res.headers.get('set-cookie')].filter(Boolean) as string[])
    for (const line of list) {
      const part = line.split(';')[0]!
      const eq = part.indexOf('=')
      if (eq > 0) this.cookies.set(part.slice(0, eq), part.slice(eq + 1))
    }
  }
  header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }
}

async function api(jar: CookieJar, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const cookie = jar.header()
  if (cookie) headers.set('cookie', cookie)
  const res = await fetch(`${API}${path}`, { ...init, headers })
  jar.absorb(res)
  return res
}

function upsertScriptFile(
  site: SiteDocument,
  path: string,
  content: string,
  config: SiteScriptRuntimeConfig,
): { id: string; path: string; created: boolean } {
  site.files ??= []
  site.runtime ??= { dependencyLock: { version: 1, packages: {}, updatedAt: 0 }, scripts: {}, styles: {} }
  site.runtime.scripts ??= {}

  const existing = site.files.find((f) => f.path === path)
  const now = Date.now()
  if (existing) {
    existing.content = content
    existing.updatedAt = now
    existing.type = 'script'
    site.runtime.scripts[existing.id] = config
    return { id: existing.id, path, created: false }
  }

  const id = nanoid()
  site.files.push({
    id,
    path,
    type: 'script',
    content,
    createdAt: now,
    updatedAt: now,
  })
  site.runtime.scripts[id] = config
  return { id, path, created: true }
}

function removeScriptFile(site: SiteDocument, path: string): boolean {
  site.files ??= []
  site.runtime ??= { dependencyLock: { version: 1, packages: {}, updatedAt: 0 }, scripts: {}, styles: {} }
  site.runtime.scripts ??= {}
  const idx = site.files.findIndex((f) => f.path === path)
  if (idx < 0) return false
  const id = site.files[idx]!.id
  site.files.splice(idx, 1)
  delete site.runtime.scripts[id]
  return true
}

type PageVerify = {
  url: string
  status: number
  scriptTagCount: number
  scriptTags: string[]
  hasClassic: boolean
  hasModule: boolean
  classicHasCountdown: boolean
  classicHasHamburgerBars: boolean
  cspAllowsSelf: boolean
  hasSwiperImportmap: boolean
}

async function verifyPublishedPage(url: string): Promise<PageVerify> {
  const res = await fetch(url)
  const html = await res.text()
  const scriptTags = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0])
  const hasClassic =
    /\/_instatic\/assets\/[^"']*ditexpo-shared-classic/i.test(html)
    || /\/_instatic\/assets\/[^"']*ditexpo-home-classic/i.test(html)
    || scriptTags.some((t) => /ditexpo-shared-classic|ditexpo-home-classic/i.test(t))
  const hasModule =
    /type=["']module["']/i.test(html)
    && /ditexpo-news-swiper|\/_instatic\/assets\//i.test(html)
  const cspAllowsSelf = /script-src[^;]*'self'/i.test(html)
  const hasSwiperImportmap = /"swiper"\s*:/i.test(html) || /importmap/i.test(html)

  const classicSrc =
    html.match(/src="(\/_instatic\/assets\/[^"]+ditexpo-shared-classic[^"]+)"/)?.[1]
    ?? html.match(/src="(\/_instatic\/assets\/[^"]+ditexpo-home-classic[^"]+)"/)?.[1]
  let classicHasCountdown = false
  let classicHasHamburgerBars = false
  if (classicSrc) {
    const classicJs = await (await fetch(`http://localhost:3001${classicSrc}`)).text()
    classicHasCountdown = /initCountdown|desktop-days-digit/.test(classicJs)
    classicHasHamburgerBars = /ensureHamburgerBars/.test(classicJs)
  }

  return {
    url,
    status: res.status,
    scriptTagCount: scriptTags.length,
    scriptTags: scriptTags.slice(0, 12),
    hasClassic,
    hasModule,
    classicHasCountdown,
    classicHasHamburgerBars,
    cspAllowsSelf,
    hasSwiperImportmap,
  }
}

async function main() {
  const { slug, report: REPORT } = parseArgs(process.argv.slice(2))
  const needs = runtimeNeedsForSlug(slug)
  const jar = new CookieJar()
  const steps: string[] = []
  const t0 = performance.now()
  steps.push(`slug=${slug}`)

  {
    const res = await api(jar, '/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    })
    if (!res.ok) throw new Error(`login failed ${res.status} ${await res.text()}`)
    steps.push('login-ok')
  }

  const [shellRes, pagesRes, componentsRes, layoutsRes] = await Promise.all([
    api(jar, '/site'),
    api(jar, '/pages'),
    api(jar, '/components'),
    api(jar, '/layouts'),
  ])
  if (!shellRes.ok || !pagesRes.ok) {
    throw new Error(`load site failed shell=${shellRes.status} pages=${pagesRes.status}`)
  }

  const shellBody = (await shellRes.json()) as {
    site: Omit<SiteDocument, 'pages' | 'visualComponents' | 'layouts'>
    seq: number
  }
  const pagesBody = (await pagesRes.json()) as { rows: unknown[] }
  const componentsBody = componentsRes.ok
    ? ((await componentsRes.json()) as { rows: unknown[] })
    : { rows: [] }
  const layoutsBody = layoutsRes.ok
    ? ((await layoutsRes.json()) as { rows: unknown[] })
    : { rows: [] }

  const pages = pagesBody.rows.map((row) => pageFromRow(row as never)).filter(Boolean)
  const visualComponents = componentsBody.rows
    .map((row) => visualComponentFromRow(row as never))
    .filter(Boolean)
  const layouts = layoutsBody.rows
    .map((row) => savedLayoutFromRow(row as never))
    .filter(Boolean)

  const site: SiteDocument = {
    ...(shellBody.site as SiteDocument),
    pages: pages as SiteDocument['pages'],
    visualComponents: visualComponents as SiteDocument['visualComponents'],
    layouts: layouts as SiteDocument['layouts'],
  }

  const targetPage = site.pages.find((p) => p.slug === slug)
  if (!targetPage) {
    throw new Error(`page slug "${slug}" not found; available: ${site.pages.map((p) => p.slug).join(', ')}`)
  }
  steps.push(`page=${targetPage.id}:${targetPage.slug}`)

  const legacyRemoved = removeScriptFile(site, LEGACY_CLASSIC_PATH)
  if (legacyRemoved) steps.push(`removed-legacy=${LEGACY_CLASSIC_PATH}`)

  const attached: string[] = []

  if (needs.sharedClassic) {
    const classic = upsertScriptFile(site, CLASSIC_PATH, CLASSIC_SOURCE, {
      ...DEFAULT_SCRIPT_RUNTIME_CONFIG,
      format: 'classic',
      placement: 'body-end',
      timing: 'dom-ready',
      scope: { type: 'all-pages' },
      priority: 10,
    })
    attached.push(`classic=${classic.id}:${classic.created ? 'new' : 'upd'}`)
  }

  const swiperPageIds = site.pages
    .filter((p) => runtimeNeedsForSlug(p.slug).newsSwiper)
    .map((p) => p.id)
  if (needs.newsSwiper && !swiperPageIds.includes(targetPage.id)) {
    swiperPageIds.push(targetPage.id)
  }
  if (swiperPageIds.length > 0) {
    const swiper = upsertScriptFile(site, SWIPER_PATH, SWIPER_SOURCE, {
      ...DEFAULT_SCRIPT_RUNTIME_CONFIG,
      format: 'module',
      placement: 'body-end',
      timing: 'dom-ready',
      scope: { type: 'pages', pageIds: swiperPageIds },
      priority: 20,
    })
    attached.push(`swiper=${swiper.id}:${swiper.created ? 'new' : 'upd'} scope=${swiperPageIds.join(',')}`)
  }

  for (const extra of needs.extraScripts) {
    const extraFile = upsertScriptFile(site, extra.path, extra.source, {
      ...DEFAULT_SCRIPT_RUNTIME_CONFIG,
      format: extra.format,
      placement: 'body-end',
      timing: 'dom-ready',
      scope: { type: 'pages', pageIds: [targetPage.id] },
      priority: extra.priority ?? 30,
    })
    attached.push(`extra:${extra.path}=${extraFile.id}:${extraFile.created ? 'new' : 'upd'}`)
  }

  steps.push(`scripts ${attached.join(' ')}`)

  const shouldResolveSwiper =
    needs.newsSwiper || Boolean(site.packageJson?.dependencies?.swiper) || swiperPageIds.length > 0

  if (shouldResolveSwiper) {
    site.packageJson ??= { dependencies: {}, devDependencies: {} }
    site.packageJson.dependencies ??= {}
    site.packageJson.devDependencies ??= {}
    if (!site.packageJson.dependencies.swiper) {
      site.packageJson.dependencies.swiper = '^11'
      delete site.packageJson.devDependencies.swiper
      steps.push('packageJson.dependencies.swiper=^11')
    } else {
      steps.push(`packageJson.dependencies.swiper=${site.packageJson.dependencies.swiper}`)
    }

    const resolveRes = await api(jar, '/runtime/dependencies/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ packageJson: site.packageJson }),
    })
    if (!resolveRes.ok) {
      throw new Error(`dependencies/resolve failed ${resolveRes.status} ${await resolveRes.text()}`)
    }
    const resolveJson = (await resolveRes.json()) as {
      dependencyLock: SiteDocument['runtime'] extends infer R
        ? R extends { dependencyLock: infer L }
          ? L
          : never
        : never
      packageImportmap?: { imports: Record<string, string>; lockHash: string }
    }
    site.runtime!.dependencyLock = resolveJson.dependencyLock as typeof site.runtime.dependencyLock
    const lockPkgCount = Object.keys(resolveJson.dependencyLock?.packages ?? {}).length
    const importCount = Object.keys(resolveJson.packageImportmap?.imports ?? {}).length
    steps.push(`deps-resolved packages=${lockPkgCount} importmap=${importCount}`)
  } else {
    steps.push('deps-skipped (no swiper need)')
  }

  const { pages: savedPages, visualComponents: vcs, layouts: savedLayouts, ...shell } = site
  const saveRes = await api(jar, '/site-document', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'replace',
      site: shell,
      changedPages: savedPages,
      deletedPageIds: [],
      changedComponents: vcs,
      deletedComponentIds: [],
      changedLayouts: savedLayouts,
      deletedLayoutIds: [],
      baseSeqs: {},
      shellBaseSeq: shellBody.seq ?? 0,
    }),
  })
  if (!saveRes.ok) {
    throw new Error(`site-document save failed ${saveRes.status} ${await saveRes.text()}`)
  }
  steps.push('site-document-saved')

  const stepUp = await api(jar, '/auth/step-up', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  if (!stepUp.ok) throw new Error(`step-up failed ${stepUp.status} ${await stepUp.text()}`)
  steps.push('step-up-ok')

  const pubRes = await api(jar, '/publish', { method: 'POST' })
  if (!pubRes.ok) throw new Error(`publish failed ${pubRes.status} ${await pubRes.text()}`)
  const pubJson = await pubRes.json()
  steps.push(`publish-ok ${JSON.stringify(pubJson)}`)

  const targetUrl = publicUrlForSlug(slug)
  const targetVerify = await verifyPublishedPage(targetUrl)
  const homeVerify = slug === 'index' ? targetVerify : await verifyPublishedPage('http://localhost:3001/')

  const targetOk =
    targetVerify.status === 200 &&
    targetVerify.scriptTagCount > 0 &&
    targetVerify.hasClassic &&
    targetVerify.classicHasCountdown &&
    targetVerify.classicHasHamburgerBars &&
    (!needs.newsSwiper || targetVerify.hasModule)

  const homeOk =
    homeVerify.status === 200 &&
    homeVerify.scriptTagCount > 0 &&
    homeVerify.hasClassic

  const report = {
    ok: targetOk && homeOk,
    slug,
    needs,
    target: targetVerify,
    home: homeVerify,
    durationMs: Math.round(performance.now() - t0),
    steps,
    at: new Date().toISOString(),
  }
  await Bun.write(REPORT, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exit(2)
}

main().catch(async (err) => {
  const { report: REPORT } = parseArgs(process.argv.slice(2))
  const report = {
    ok: false,
    error: err instanceof Error ? err.stack ?? err.message : String(err),
    at: new Date().toISOString(),
  }
  await Bun.write(REPORT, JSON.stringify(report, null, 2))
  console.error(JSON.stringify(report, null, 2))
  process.exit(1)
})
