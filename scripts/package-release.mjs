import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { zipSync } from 'fflate'

const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const versions = JSON.parse(await readFile(join(root, 'versions.json'), 'utf8'))
if (pkg.version !== manifest.version || versions[manifest.version] !== manifest.minAppVersion) throw new Error('Package, manifest and versions.json must agree')
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Use an x.y.z release version')
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== manifest.version) throw new Error('Release tag must exactly match manifest version (no v prefix)')
const destination = join(root, 'dist')
await mkdir(destination, { recursive: true })
const zip = {}; const hashes = []
for (const name of ['main.js', 'manifest.json', 'styles.css']) {
  const bytes = await readFile(join(root, name))
  await copyFile(join(root, name), join(destination, name))
  zip[`${manifest.id}/${name}`] = bytes
  hashes.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`)
}
const archivePath = join(root, `healthpocket-${manifest.version}.zip`)
await writeFile(archivePath, zipSync(zip, { level: 6 }))
await writeFile(join(destination, 'SHA256SUMS.txt'), `${hashes.join('\n')}\n`)
console.log(`Release ${manifest.version}: dist/main.js, dist/manifest.json, dist/styles.css`)
console.log(`Manual-install archive: ${archivePath}`)
