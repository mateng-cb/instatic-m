/**
 * scripts/ 下 CMS 维护脚本共享的 API 客户端。
 *
 * 四个 ditexpo/verify 脚本此前各自复制同一套 CookieJar + api() + 登录 →
 * 加载站点 → PUT site-document → step-up → 发布流程，并把端点与本地种子
 * 账号硬编码在脚本里。生产快照工作流（.sites/<site>/ + dev-site.sh，见
 * docs/deployment/local-workspaces.md）里实例仍跑在 localhost:3001，但
 * 用户表来自生产快照——登录必须是快照里的真实账号，本地种子凭据按
 * CLAUDE.md 的规矩也不得写进脚本。端点与凭据因此统一显式提供：
 *
 *   --api http://localhost:3001    （或 INSTATIC_API，默认 localhost:3001）
 *   --email a@b.c                  （或 INSTATIC_EMAIL）
 *   --password …                   （或 INSTATIC_PASSWORD）
 *
 * 凭据没有默认值：参数与环境变量都不给时启动即报错，而不是发出一个
 * 注定 401 的请求。密码优先走环境变量，避免留在 shell 历史里。
 */
import { pageFromRow } from '../../src/core/data/pageFromRow'
import { visualComponentFromRow } from '../../src/core/data/componentFromRow'
import { savedLayoutFromRow } from '../../src/core/data/layoutFromRow'
import type { SiteDocument } from '@core/page-tree'

export const DEFAULT_CMS_ORIGIN = 'http://localhost:3001'

export interface CmsEndpoint {
  /** 站点根 origin，如 `http://localhost:3001`（无尾斜杠）。 */
  origin: string
  email: string
  password: string
}

/**
 * 从参数表吸收 `--api/--email/--password`（环境变量兜底），返回端点与
 * 剩余参数，供脚本继续解析自己的参数。
 */
export function takeEndpointArgs(argv: string[]): { endpoint: CmsEndpoint; rest: string[] } {
  const rest: string[] = []
  let origin = process.env.INSTATIC_API ?? DEFAULT_CMS_ORIGIN
  let email = process.env.INSTATIC_EMAIL
  let password = process.env.INSTATIC_PASSWORD
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--api') origin = argv[++i] ?? origin
    else if (a === '--email') email = argv[++i] ?? email
    else if (a === '--password') password = argv[++i] ?? password
    else rest.push(a)
  }
  origin = origin.replace(/\/+$/, '')
  if (!email || !password) {
    throw new Error('缺少登录凭据：传 --email/--password 或设置 INSTATIC_EMAIL/INSTATIC_PASSWORD')
  }
  return { endpoint: { origin, email, password }, rest }
}

export class CookieJar {
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

export class CmsClient {
  private readonly jar = new CookieJar()
  constructor(readonly endpoint: CmsEndpoint) {}

  /** 站点根 origin（公开页与静态资源用）。 */
  get origin(): string {
    return this.endpoint.origin
  }

  /** 公开页 / 静态资源绝对地址。 */
  publicUrl(path: string): string {
    return `${this.endpoint.origin}${path.startsWith('/') ? path : `/${path}`}`
  }

  /** 带会话 cookie 的 CMS API 请求。 */
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    const cookie = this.jar.header()
    if (cookie) headers.set('cookie', cookie)
    const res = await fetch(`${this.endpoint.origin}/admin/api/cms${path}`, { ...init, headers })
    this.jar.absorb(res)
    return res
  }

  async login(): Promise<void> {
    const res = await this.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: this.endpoint.email, password: this.endpoint.password }),
    })
    if (!res.ok) throw new Error(`login failed ${res.status} ${await res.text()}`)
  }

  /**
   * 登录并加载完整站点文档：shell（GET /site）+ 页面 / Visual Components /
   * 布局（GET /pages 等，components/layouts 拉取失败时容忍为空）。
   */
  async loadSite(): Promise<{ site: SiteDocument; seq: number }> {
    const [shellRes, pagesRes, componentsRes, layoutsRes] = await Promise.all([
      this.request('/site'),
      this.request('/pages'),
      this.request('/components'),
      this.request('/layouts'),
    ])
    if (!shellRes.ok || !pagesRes.ok) {
      throw new Error(`load site failed shell=${shellRes.status} pages=${pagesRes.status}`)
    }
    const shellBody = await shellRes.json() as {
      site: Omit<SiteDocument, 'pages' | 'visualComponents' | 'layouts'>
      seq: number
    }
    const pagesBody = await pagesRes.json() as { rows: unknown[] }
    const componentsBody = componentsRes.ok ? await componentsRes.json() as { rows: unknown[] } : { rows: [] }
    const layoutsBody = layoutsRes.ok ? await layoutsRes.json() as { rows: unknown[] } : { rows: [] }

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
    return { site, seq: shellBody.seq ?? 0 }
  }

  /** PUT /site-document（mode: 'replace'，changedPages 携带全部页）。 */
  async saveSite(site: SiteDocument, seq: number): Promise<void> {
    const { pages, visualComponents, layouts, ...shell } = site
    const res = await this.request('/site-document', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'replace',
        site: shell,
        changedPages: pages,
        deletedPageIds: [],
        changedComponents: visualComponents,
        deletedComponentIds: [],
        changedLayouts: layouts,
        deletedLayoutIds: [],
        baseSeqs: {},
        shellBaseSeq: seq,
      }),
    })
    if (!res.ok) {
      throw new Error(`site-document save failed ${res.status} ${await res.text()}`)
    }
  }

  /** step-up 提权（发布前必需）。 */
  async stepUp(): Promise<void> {
    const res = await this.request('/auth/step-up', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: this.endpoint.password }),
    })
    if (!res.ok) throw new Error(`step-up failed ${res.status} ${await res.text()}`)
  }

  /** 发布全站，返回发布端点的 JSON 响应。 */
  async publish(): Promise<unknown> {
    const res = await this.request('/publish', { method: 'POST' })
    if (!res.ok) throw new Error(`publish failed ${res.status} ${await res.text()}`)
    return res.json()
  }
}
