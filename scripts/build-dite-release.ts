/**
 * Build the DITE release bundle: a Docker image pre-seeded with the current
 * local site (SQLite snapshot + uploads), plus everything the backend team
 * needs to run it (compose file, .env with the master key, deploy notes).
 *
 * Usage:
 *   bun run scripts/build-dite-release.ts               # full build (needs Docker)
 *   bun run scripts/build-dite-release.ts --seed-only   # assemble the seed build context only
 *   bun run scripts/build-dite-release.ts --skip-base   # reuse the existing instatic-m:local image
 *
 * Layout:
 *   .tmp/dite-seed/            docker build context for the seed layer
 *   dite-release-<date>/       the folder to hand to the backend team
 *
 * The master key resolution mirrors server/secrets/masterKey.ts: the
 * INSTATIC_SECRET_KEY env var wins, then .tmp/secret.key. The seeded database
 * carries secrets (GitHub publish PAT, …) encrypted with the LOCAL key, so the
 * release .env must ship that exact key or those secrets won't decrypt.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
// NOTE: write the snapshot with the *sync* fs API — Bun.write() is async and a
// missing await silently truncates the file to 0 bytes.
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

const SEED_DIR = '.tmp/dite-seed'
const DEV_DB = '.tmp/dev.db'
const DEV_KEY = '.tmp/secret.key'
const UPLOADS_DIR = 'uploads'
const BASE_IMAGE = 'instatic-m:local'
const SEED_IMAGE = 'instatic-dite:latest'
const SEED_DOCKERFILE = 'deploy/dite/Dockerfile.seed'

const seedOnly = process.argv.includes('--seed-only')
const skipBase = process.argv.includes('--skip-base')
const releaseDate = new Date().toISOString().slice(0, 10)
const releaseDir = `dite-release-${releaseDate}`

function fail(message: string): never {
  console.error(`[dite-release] ${message}`)
  process.exit(1)
}

function log(message: string): void {
  console.log(`[dite-release] ${message}`)
}

function humanSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}

function dirSize(path: string): number {
  let total = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    total += entry.isDirectory() ? dirSize(child) : statSync(child).size
  }
  return total
}

/** Resolve the master key exactly like server/secrets/masterKey.ts does. */
function resolveMasterKey(): string {
  const fromEnv = process.env.INSTATIC_SECRET_KEY
  if (fromEnv) return fromEnv.trim()
  if (existsSync(DEV_KEY)) return readFileSync(DEV_KEY, 'utf8').trim()
  // No key anywhere: the local DB cannot hold encrypted secrets yet, so
  // generating one now is safe — and it becomes the local key going forward.
  const generated = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')
  writeFileSync(DEV_KEY, `${generated}\n`)
  log(`no master key found — generated a new one at ${DEV_KEY} (will be used from now on)`)
  return generated
}

/** Run a docker command, streaming output; abort the script on failure. */
function docker(args: string[], label: string): void {
  log(`${label}: docker ${args.join(' ')}`)
  const proc = Bun.spawnSync(['docker', ...args], { stdio: ['inherit', 'inherit', 'inherit'] })
  if (proc.exitCode !== 0) fail(`${label} failed (exit ${proc.exitCode})`)
}

// --- 1) Assemble the seed build context -------------------------------------

if (!existsSync(DEV_DB)) fail(`local database not found at ${DEV_DB} — start the dev server once first`)
if (!existsSync(UPLOADS_DIR)) fail(`uploads directory not found at ${UPLOADS_DIR}`)

const masterKey = resolveMasterKey()

rmSync(SEED_DIR, { recursive: true, force: true })
mkdirSync(join(SEED_DIR, 'data'), { recursive: true })

log(`snapshotting ${DEV_DB} (consistent copy, safe while the dev server runs)…`)
const db = new Database(DEV_DB)
try {
  writeFileSync(join(SEED_DIR, 'data', 'cms.db'), db.serialize())
} finally {
  db.close()
}
log(`  database snapshot: ${humanSize(statSync(join(SEED_DIR, 'data', 'cms.db')).size)}`)

log(`copying ${UPLOADS_DIR}/ into the build context (this can take a minute for large media libraries)…`)
cpSync(UPLOADS_DIR, join(SEED_DIR, 'uploads'), { recursive: true })
log(`  uploads: ${humanSize(dirSize(join(SEED_DIR, 'uploads')))}`)

if (seedOnly) {
  log(`seed context ready at ${SEED_DIR}/`)
  log('next steps (run once Docker is available):')
  log(`  docker build -t ${BASE_IMAGE} .`)
  log(`  docker build -f ${SEED_DOCKERFILE} --build-arg DITE_RELEASE=${releaseDate} -t ${SEED_IMAGE} ${SEED_DIR}`)
  log(`  docker save -o ${releaseDir}/instatic-dite.tar ${SEED_IMAGE}`)
  process.exit(0)
}

// --- 2) Build the images -----------------------------------------------------

const version = Bun.spawnSync(['docker', 'version', '--format', '{{.Server.Version}}'])
if (version.exitCode !== 0) {
  fail('docker is not available. Install Docker Desktop (https://www.docker.com/products/docker-desktop/), ' +
    'start it, and re-run. Or re-run with --seed-only to prepare the build context.')
}

if (!skipBase) docker(['build', '-t', BASE_IMAGE, '.'], 'building the product image')
else log(`--skip-base: reusing existing ${BASE_IMAGE}`)

docker(
  ['build', '-f', SEED_DOCKERFILE, '--build-arg', `DITE_RELEASE=${releaseDate}`, '-t', SEED_IMAGE, SEED_DIR],
  'building the seeded DITE image',
)

// --- 3) Assemble the release folder -------------------------------------------

mkdirSync(releaseDir, { recursive: true })
docker(['save', '-o', join(releaseDir, 'instatic-dite.tar'), SEED_IMAGE], `exporting ${SEED_IMAGE} to tar`)
cpSync('deploy/dite/compose.dite.yml', join(releaseDir, 'compose.dite.yml'))
cpSync('deploy/dite/DEPLOY.md', join(releaseDir, 'DEPLOY.md'))
writeFileSync(join(releaseDir, '.env'), `INSTATIC_SECRET_KEY=${masterKey}\n`)

log('release bundle ready:')
for (const name of readdirSync(releaseDir)) {
  log(`  ${join(releaseDir, name)} (${humanSize(statSync(join(releaseDir, name)).size)})`)
}
log(`hand the whole ${releaseDir}/ folder to the backend team — see DEPLOY.md inside.`)
