// Publishes the packaged build (run `npm run package` first) as a GitHub
// Release of superMangoGame/healthpocket with the plugin files attached.
//
// Auth: GITHUB_TOKEN, or the github.com credential git already has stored.
import { readFile, access } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join, resolve, basename } from 'node:path'

const OWNER = 'superMangoGame'
const REPO = 'healthpocket'
const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
const version = manifest.version
const notes = process.argv.slice(2).join(' ') || `健康口袋 ${version}`

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  const out = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' })
  const password = out.match(/^password=(.*)$/m)?.[1]
  if (!password) throw new Error('No GitHub token: set GITHUB_TOKEN')
  return password
}
const auth = { Authorization: `Bearer ${token()}`, Accept: 'application/vnd.github+json' }

async function api(path, init = {}) {
  const response = await fetch(path.startsWith('http') ? path : `https://api.github.com${path}`, { ...init, headers: { ...auth, ...init.headers } })
  if (!response.ok && response.status !== 404) throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`)
  return response.status === 404 ? null : response.json()
}

const assets = ['main.js', 'manifest.json', 'styles.css', 'SHA256SUMS.txt'].map((name) => join(root, 'dist', name))
const archive = join(root, `healthpocket-${version}.zip`)
for (const file of [...assets, archive]) await access(file)
const builtVersion = JSON.parse(await readFile(join(root, 'dist', 'manifest.json'), 'utf8')).version
if (builtVersion !== version) throw new Error(`dist/ holds ${builtVersion}, not ${version}: run npm run package`)

if (await api(`/repos/${OWNER}/${REPO}/releases/tags/${version}`)) throw new Error(`Release ${version} already exists`)

// The in-app update check reads manifest.json from main, so main must already
// carry this version before the release goes out.
const remoteManifest = await api(`/repos/${OWNER}/${REPO}/contents/manifest.json?ref=main`)
if (!remoteManifest || JSON.parse(Buffer.from(remoteManifest.content, 'base64').toString('utf8')).version !== version) throw new Error(`Push manifest.json ${version} to main first`)

const release = await api(`/repos/${OWNER}/${REPO}/releases`, { method: 'POST', body: JSON.stringify({
  tag_name: version, target_commitish: 'main', name: version, body: notes,
}) })
const uploadBase = release.upload_url.replace(/\{.*\}$/, '')
for (const file of [...assets, archive]) {
  const name = basename(file)
  process.stdout.write(`Uploading ${name}… `)
  await api(`${uploadBase}?name=${encodeURIComponent(name)}`, {
    method: 'POST', body: await readFile(file),
    headers: { 'Content-Type': name.endsWith('.zip') ? 'application/zip' : 'application/octet-stream' },
  })
  console.log('ok')
}
console.log(`Published ${release.html_url}`)
