/**
 * Release image: build the production Docker image for linux/amd64 and push it
 * to Huawei Cloud SWR. Cross-platform by design — Mac (ARM) and Windows (x86)
 * operators run the exact same command and produce the exact same image.
 *
 *   bun run release            # tag = YYYYMMDD-<git short hash>
 *   bun run release v3         # explicit tag override
 *
 * Login: if Docker is not logged in to the registry, the script reads
 * deploy/.env.swr (git-ignored; see deploy/.env.swr.example) and runs
 * `docker login` itself. Without that file the operator must have logged in
 * manually beforehand.
 *
 * Scope: build + push ONLY. The VPS-side per-site upgrade stays a manual,
 * doc-driven step (docs/deployment/multi-site.md → "Upgrading"). A future
 * `--deploy` mode may drive it over SSH once the manual flow has stabilised.
 */

const REGISTRY = 'swr.ap-southeast-3.myhuaweicloud.com'
const IMAGE = `${REGISTRY}/idcnova/instatic`
const CREDS_FILE = 'deploy/.env.swr'

function fail(message: string, hint?: string): never {
	console.error(`[release] ${message}`)
	if (hint) console.error(`[release] hint: ${hint}`)
	process.exit(1)
}

async function sh(command: string[]) {
	const proc = Bun.spawn(command, { stdout: 'inherit', stderr: 'inherit' })
	const code = await proc.exited
	if (code !== 0) fail(`${command.join(' ')} exited with ${code}`)
}

function homeDir(): string {
	return process.env.HOME ?? process.env.USERPROFILE ?? fail('Cannot resolve the home directory.')
}

// --- Login state: logged in already, or credentials on disk to login with. --

function dockerConfigAuths(): string[] {
	try {
		const config = JSON.parse(Bun.file(`${homeDir()}/.docker/config.json`).text())
		return config.auths ? Object.keys(config.auths) : []
	} catch {
		return [] // No docker config at all — not logged in anywhere.
	}
}

function loggedIn(): boolean {
	return dockerConfigAuths().some((k) => k.includes(REGISTRY))
}

interface SwrCredentials {
	username: string
	password: string
}

async function readCredentials(): Promise<SwrCredentials | null> {
	const file = Bun.file(CREDS_FILE)
	if (!(await file.exists())) return null
	const vars = new Map<string, string>()
	for (const line of (await file.text()).split(/\r?\n/)) {
		const match = /^([A-Z_]+)=(.*)$/.exec(line.trim())
		if (match) vars.set(match[1], match[2])
	}
	const username = vars.get('SWR_USERNAME')
	const password = vars.get('SWR_PASSWORD')
	if (!username || !password) {
		fail(
			`${CREDS_FILE} exists but is missing SWR_USERNAME / SWR_PASSWORD.`,
			'See deploy/.env.swr.example for the expected shape.',
		)
	}
	return { username, password }
}

if (!loggedIn()) {
	console.log(`[release] not logged in to ${REGISTRY} — trying ${CREDS_FILE} …`)
	const creds = await readCredentials()
	if (!creds) {
		fail(
			`Not logged in to ${REGISTRY} and ${CREDS_FILE} not found.`,
			`Create ${CREDS_FILE} from deploy/.env.swr.example, or run the docker login command from docs/deployment/multi-site.md.`,
		)
	}
	// Password via stdin — never as a CLI argument (it would leak into `ps` output and logs).
	const login = Bun.spawn(['docker', 'login', '-u', creds.username, '--password-stdin', REGISTRY], {
		stdin: 'pipe',
		stdout: 'inherit',
		stderr: 'inherit',
	})
	login.stdin?.write(`${creds.password}\n`)
	login.stdin?.end()
	if ((await login.exited) !== 0) {
		fail(
			`docker login to ${REGISTRY} failed.`,
			'On macOS, if this is a Keychain Error, run docker login once by hand in your own terminal (accept the Keychain prompt), then retry.',
		)
	}
}

// --- Preflight: docker up, tag decided. -------------------------------------

const dockerOk = await Bun.$`docker info --format ok`.quiet().then(() => true, () => false)
if (!dockerOk) fail('Docker is not running.', 'Start Docker Desktop and retry.')

const explicitTag = process.argv[2]
let tag = explicitTag ?? ''
if (!tag) {
	const date = new Date().toISOString().slice(0, 10).replaceAll('-', '')
	const hash = await Bun.$`git rev-parse --short HEAD`.quiet().text().then((s) => s.trim(), () => fail('git rev-parse failed — run from a repo checkout.'))
	tag = `${date}-${hash}`
}

// --- Warn (do not block) on a dirty worktree. -------------------------------

const status = await Bun.$`git status --porcelain`.quiet().text()
if (status.trim()) {
	console.warn('[release] warning: the worktree is dirty — uncommitted changes WILL be baked into the image.')
	console.warn('[release] warning: the tag will not match any committed state. Consider committing first.')
}

// --- Build and push. --------------------------------------------------------

console.log(`[release] building ${IMAGE}:${tag} for linux/amd64 …`)
// --provenance=false / --sbom=false: buildx otherwise attaches OCI attestation
// manifests, which Huawei Cloud SWR rejects ("fail to parse 'manifest.json'").
await sh([
	'docker',
	'buildx',
	'build',
	'--platform',
	'linux/amd64',
	'--provenance=false',
	'--sbom=false',
	'-t',
	`${IMAGE}:${tag}`,
	'--push',
	'.',
])

console.log('[release] pushed. Next steps (on the VPS):')
console.log(`[release]   1. set INSTATIC_IMAGE=${IMAGE}:${tag} in deploy/.env`)
console.log('[release]   2. docker compose -f deploy/compose.multi-site.yml --env-file deploy/.env pull')
console.log('[release]   3. per site: docker compose -f deploy/compose.multi-site.yml --env-file deploy/.env up -d <site> && curl -fsS http://127.0.0.1:<port>/health')
