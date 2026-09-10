/**
 * Local push kit — the GitHub Pages deliverable for operators behind
 * restricted / high-latency egress (e.g. mainland-China servers, where the
 * per-file Git Data API upload is not viable).
 *
 * Instead of the server pushing to GitHub itself, the server packages a
 * self-contained ZIP the operator runs locally:
 *
 *   site/            Phase A static export (basePath-rewritten) + .nojekyll
 *   push.cmd         Windows: double-click → git init/add/commit/push
 *   push.sh          macOS / Linux equivalent
 *   README.txt       Chinese operator instructions
 *
 * The push script force-pushes the export as a full tree replacement onto the
 * configured branch, so repeated runs never conflict with the remote tip.
 * Optionally the stored PAT is embedded into the push remote URL for a
 * zero-interaction push; then the ZIP is a repository credential and the
 * README says so. The script strips the remote (and with it the embedded
 * token) from the local clone after the push, success or failure.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExportReportItem } from '@core/static-export/types'
import type { DbClient } from '../db/client'
import {
  decryptGithubPublishToken,
  getGithubPublishSettingsView,
} from '../repositories/githubPublishSettings'
import { exportPublishedSiteStatic } from './staticExport'
import { createStaticExportHoleHooks } from './staticExportHoles'

/** Git ref names and GitHub PATs are limited to shell-safe characters; the
 * allowlist keeps the generated scripts free of injection surface. */
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const TOKEN_PATTERN = /^[A-Za-z0-9_]+$/
const OWNER_REPO_PATTERN = /^[A-Za-z0-9._-]+$/

export class LocalPushKitError extends Error {
  readonly status: number

  constructor(message: string, status = 400, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LocalPushKitError'
    this.status = status
  }
}

export type BuildLocalPushKitInput = {
  db: DbClient
  uploadsDir: string
  /** Caller-managed temp root; `site/` + scripts are created inside. */
  kitDir: string
  /** Embed the stored PAT into the push remote URL (zero-interaction push). */
  embedToken: boolean
}

export type BuildLocalPushKitResult = {
  repoUrl: string
  owner: string
  repo: string
  branch: string
  tokenEmbedded: boolean
  pageCount: number
}

function timestamp(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

function assertShellSafe(value: string, label: string): void {
  if (!BRANCH_PATTERN.test(value)) {
    throw new LocalPushKitError(`Configured ${label} contains unsupported characters: ${JSON.stringify(value)}`)
  }
}

function buildRemoteUrl(owner: string, repo: string, token: string | null): string {
  const baseUrl = `https://github.com/${owner}/${repo}.git`
  return token ? `https://${token}@${baseUrl.slice('https://'.length)}` : baseUrl
}

function cmdScript(remoteUrl: string, branch: string, commitMessage: string): string {
  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    'cd /d "%~dp0"',
    'where git >nul 2>nul',
    'if errorlevel 1 (',
    '  echo [错误] 未检测到 git。请先安装 Git for Windows: https://git-scm.com/download/win',
    '  echo 安装完成后重新双击本文件。',
    '  pause',
    '  exit /b 1',
    ')',
    'cd site',
    `git init -b ${branch} .`,
    'git config user.name "Instatic Publish"',
    'git config user.email "publish@instatic.local"',
    'git remote remove origin >nul 2>nul',
    `git remote add origin ${remoteUrl}`,
    'git add -A',
    `git commit -m "${commitMessage}" >nul`,
    'if errorlevel 1 (',
    '  echo [失败] 创建提交失败。请把本窗口内容截图反馈给管理员。',
    '  pause',
    '  exit /b 1',
    ')',
    `git push -f origin ${branch}`,
    'if errorlevel 1 (',
    '  echo.',
    '  echo [失败] 推送未完成。请把上方错误截图反馈给管理员。',
    '  git remote remove origin >nul 2>nul',
    '  pause',
    '  exit /b 1',
    ')',
    'git remote remove origin >nul 2>nul',
    'echo.',
    'echo [成功] 已推送到 GitHub。GitHub Pages 通常 1-2 分钟内生效。',
    'pause',
    '',
  ]
  // .cmd files parse reliably with CRLF; UTF-8 without BOM (a BOM breaks the
  // leading @echo off).
  return lines.join('\r\n')
}

function shScript(remoteUrl: string, branch: string, commitMessage: string): string {
  return [
    '#!/usr/bin/env bash',
    '# 本地推送脚本 — 在解压目录内运行: bash push.sh',
    'set -u',
    'cd "$(dirname "$0")"',
    'if ! command -v git >/dev/null 2>&1; then',
    '  echo "[错误] 未检测到 git，请先安装: https://git-scm.com/downloads"',
    '  exit 1',
    'fi',
    'cd site',
    `git init -b ${branch} .`,
    'git config user.name "Instatic Publish"',
    'git config user.email "publish@instatic.local"',
    'git remote remove origin >/dev/null 2>&1 || true',
    `git remote add origin ${remoteUrl}`,
    'git add -A',
    `git commit -m "${commitMessage}" >/dev/null`,
    `if ! git push -f origin ${branch}; then`,
    '  git remote remove origin >/dev/null 2>&1 || true',
    '  echo',
    '  echo "[失败] 推送未完成，请把上方错误反馈给管理员。"',
    '  exit 1',
    'fi',
    'git remote remove origin >/dev/null 2>&1 || true',
    'echo',
    'echo "[成功] 已推送到 GitHub。GitHub Pages 通常 1-2 分钟内生效。"',
    '',
  ].join('\n')
}

function readmeText(input: {
  repoUrl: string
  branch: string
  tokenEmbedded: boolean
  pageCount: number
  packedAt: string
  warnings: ExportReportItem[]
}): string {
  const credentialNote = input.tokenEmbedded
    ? [
        '⚠️ 安全提示：本包内嵌了仓库访问凭证（token）——本 ZIP 等同于一把仓库钥匙，',
        '   请勿外传。如需作废凭证：GitHub → Settings → Developer settings →',
        '   Personal access tokens → 删除对应 token。',
      ].join('\r\n')
    : [
        '说明：本包未内嵌凭证。首次推送时 git 会弹出浏览器让你登录 GitHub 授权，',
        '   授权一次后本机后续推送免登录。',
      ].join('\r\n')

  const warningNote = input.warnings.length > 0
    ? `\r\n\r\n导出提示：\r\n${input.warnings.map((w) => `- [${w.severity}] ${w.message}`).join('\r\n')}`
    : ''

  const lines = [
    'Instatic 本地推送包',
    '==================',
    '',
    '用途：把已发布的站点内容推送到 GitHub Pages。',
    '',
    '使用步骤（Windows）：',
    '  1. 解压本 ZIP（右键 → 全部解压）',
    '  2. 打开解压后的文件夹，双击 push.cmd',
    '  3. 看到「[成功]」即完成，等 1-2 分钟 GitHub Pages 生效',
    '',
    '使用步骤（macOS / Linux）：',
    '  1. 解压本 ZIP',
    '  2. 在终端进入解压目录，运行:  bash push.sh',
    '',
    '前提：电脑已安装 git（https://git-scm.com/downloads）。',
    '',
    `目标仓库：${input.repoUrl}`,
    `目标分支：${input.branch}（脚本会整体替换该分支内容）`,
    `站点页面数：${input.pageCount}`,
    '',
    credentialNote,
    '',
    `打包时间：${input.packedAt}`,
  ]
  // UTF-8 BOM so Windows Notepad reliably detects the encoding.
  return `${String.fromCharCode(0xfeff)}${lines.join('\r\n')}${warningNote}\r\n`
}

export async function buildLocalPushKit(input: BuildLocalPushKitInput): Promise<BuildLocalPushKitResult> {
  const { db, uploadsDir, kitDir, embedToken } = input

  const settings = await getGithubPublishSettingsView(db)
  if (!settings.repoUrl || !settings.owner || !settings.repo) {
    throw new LocalPushKitError(
      'GitHub repository is not configured. Save it in the Publish to GitHub dialog first.',
    )
  }
  if (!OWNER_REPO_PATTERN.test(settings.owner) || !OWNER_REPO_PATTERN.test(settings.repo)) {
    throw new LocalPushKitError('Configured repository URL contains unsupported characters.')
  }
  assertShellSafe(settings.branch, 'branch')

  let token: string | null = null
  if (embedToken) {
    token = await decryptGithubPublishToken(db)
    if (!token) {
      throw new LocalPushKitError(
        'No usable stored token. Save a personal access token in the Publish to GitHub dialog first.',
      )
    }
    if (!TOKEN_PATTERN.test(token)) {
      throw new LocalPushKitError(
        'The stored token contains unsupported characters — re-enter it in the Publish to GitHub dialog.',
      )
    }
  }

  const siteDir = join(kitDir, 'site')
  await mkdir(siteDir, { recursive: true })

  // StaticExportError (not-published / per-visitor-hole) propagates to the
  // handler, which maps it to 409 / 422 like the plain export endpoint.
  const exportResult = await exportPublishedSiteStatic({
    uploadsDir,
    outDir: siteDir,
    pathMode: 'basePath',
    layout: 'directory',
    basePath: settings.basePath,
    expandHoles: createStaticExportHoleHooks(db),
  })

  // GitHub Pages runs Jekyll by default and silently drops `_`-prefixed
  // paths — every Instatic asset lives under `_instatic/`.
  await writeFile(join(siteDir, '.nojekyll'), '')

  const remoteUrl = buildRemoteUrl(settings.owner, settings.repo, token)
  const commitMessage = `Publish site from Instatic ${timestamp()}`

  const packedAt = timestamp()
  const warnings = exportResult.report.filter((item) => item.severity === 'warning')

  await writeFile(join(kitDir, 'push.cmd'), cmdScript(remoteUrl, settings.branch, commitMessage))
  await writeFile(join(kitDir, 'push.sh'), shScript(remoteUrl, settings.branch, commitMessage))
  await writeFile(
    join(kitDir, 'README.txt'),
    readmeText({
      repoUrl: settings.repoUrl,
      branch: settings.branch,
      tokenEmbedded: embedToken,
      pageCount: exportResult.pageCount,
      packedAt,
      warnings,
    }),
  )

  return {
    repoUrl: settings.repoUrl,
    owner: settings.owner,
    repo: settings.repo,
    branch: settings.branch,
    tokenEmbedded: embedToken,
    pageCount: exportResult.pageCount,
  }
}
