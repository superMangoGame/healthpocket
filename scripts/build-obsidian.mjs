import { build } from 'esbuild'
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, extname } from 'node:path'
import { gzipSync } from 'node:zlib'

const root = resolve(import.meta.dirname, '..')
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.gz': 'application/gzip', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' }

// Obsidian runs plugins inside Electron's renderer, where the bare globals
// `setTimeout`/`setInterval` are Chromium's DOM timers: they return numeric ids
// and expose neither `.unref()` nor `.refresh()`. Undici (the Garmin transport)
// assumes Node timer objects, so a plain `fetch` throws
// `fastNowTimeout?.unref is not a function` before a single byte is sent.
// Binding these modules to `node:timers` restores real Node timers without
// changing any other behaviour; in plain Node it is already a no-op.
const UNDICI_TIMER_MODULES = [
  { file: /undici[\\/]lib[\\/]util[\\/]timers\.js$/, bind: 'setTimeout, clearTimeout' },
  { file: /undici[\\/]lib[\\/]dispatcher[\\/]client-h1\.js$/, bind: 'setTimeout, clearTimeout' },
  { file: /undici[\\/]lib[\\/]dispatcher[\\/]client-h2\.js$/, bind: 'setInterval, clearInterval' },
]

export function undiciNodeTimersPlugin() {
  return { name: 'undici-node-timers', setup(builder) {
    builder.onLoad({ filter: /undici[\\/]lib[\\/].*\.js$/ }, async (args) => {
      const target = UNDICI_TIMER_MODULES.find((entry) => entry.file.test(args.path))
      if (!target) return null
      const source = await readFile(args.path, 'utf8')
      if (/require\(['"]node:timers['"]\)|from ['"]node:timers['"]/.test(source)) return { contents: source, loader: 'js' }
      if (!/module\.exports|require\(/.test(source)) throw new Error(`Expected a CommonJS module at ${args.path}`)
      const shim = `const { ${target.bind} } = require('node:timers')\n`
      if (!new RegExp(`(^|[^.\\w])(${target.bind.split(', ').join('|')})\\(`, 'm').test(source)) {
        throw new Error(`undici timer patch no longer applies to ${args.path}; re-check the renderer timer workaround`)
      }
      return { contents: shim + source, loader: 'js' }
    })
  } }
}

export function embeddedAssetsPlugin(appDir = resolve(root, 'lib/app')) {
  return { name: 'embedded-assets', setup(builder) {
    builder.onResolve({ filter: /^virtual:healthpocket-assets$/ }, () => ({ path: 'assets', namespace: 'healthpocket' }))
    builder.onLoad({ filter: /.*/, namespace: 'healthpocket' }, async () => {
      const entries = await readdir(appDir, { recursive: true, withFileTypes: true })
      const assets = {}
      let notices = '# Bundled software licenses\n\nHealthPocket includes the following third-party software. Anatomy attribution is provided separately in HUMAN_ATLAS_ATTRIBUTION.md.\n'
      const packageFolders = []
      for (const prefix of ['', 'web/']) {
        const lock = JSON.parse(await readFile(resolve(root, prefix, 'package-lock.json'), 'utf8'))
        for (const [folder, entry] of Object.entries(lock.packages)) {
          if (!folder || entry.dev || !existsSync(resolve(root, prefix, folder, 'package.json'))) continue
          packageFolders.push(resolve(root, prefix, folder))
        }
      }
      const seen = new Set()
      for (const packagePath of packageFolders) {
        const metadata = JSON.parse(await readFile(resolve(packagePath, 'package.json'), 'utf8'))
        const identity = `${metadata.name}@${metadata.version}`
        if (seen.has(identity)) continue
        seen.add(identity)
        const licenseNames = (await readdir(packagePath, { withFileTypes: true })).filter((entry) => entry.isFile() && /^(license|copying|notice)([.-]|$)/i.test(entry.name)).map((entry) => entry.name)
        notices += `\n## ${metadata.name} ${metadata.version} (${metadata.license ?? 'see license'})\n\n`
        for (const name of licenseNames) notices += `${await readFile(resolve(packagePath, name), 'utf8')}\n`
      }
      for (const entry of entries) {
        if (!entry.isFile() || entry.name.endsWith('.map')) continue
        const file = resolve(entry.parentPath, entry.name)
        const key = file.slice(appDir.length + 1).replaceAll('\\', '/')
        assets[key] = { contentType: mime[extname(key)] ?? 'application/octet-stream', encoding: 'gzip-base64',
          body: gzipSync(await readFile(file), { level: 9 }).toString('base64') }
      }
      if (!assets['index.html'] || !assets['models/human-atlas/atlas.json']) throw new Error('Run npm run build:app before bundling the plugin')
      const atlas = JSON.parse(await readFile(resolve(appDir, 'models/human-atlas/atlas.json'), 'utf8'))
      if (atlas.parts.length !== 2234 || atlas.parts.some((part) => !part.nameZh)) throw new Error('The complete Chinese atlas is required')
      for (const chunk of atlas.chunks) {
        const path = `models/human-atlas/${chunk.gzip.split('/').at(-1)}`
        if (!assets[path]) throw new Error(`Missing offline model chunk: ${path}`)
      }
      assets['licenses/THIRD_PARTY_NOTICES.txt'] = { contentType: 'text/plain; charset=utf-8', encoding: 'gzip-base64', body: gzipSync(notices).toString('base64') }
      return { contents: `export const STATIC_ASSETS=${JSON.stringify(assets)};`, loader: 'js' }
    })
    // PDF text extraction never renders a canvas; do not ship native addons.
    builder.onResolve({ filter: /^(canvas|path2d)$/ }, (args) => ({ path: args.path, namespace: 'no-canvas' }))
    builder.onLoad({ filter: /.*/, namespace: 'no-canvas' }, () => ({ contents: 'export default {}', loader: 'js' }))
  } }
}

export async function buildPlugin() { return build({
  absWorkingDir: root,
  entryPoints: ['obsidian/main.ts'],
  outfile: 'main.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2022',
  external: ['obsidian', 'electron'],
  loader: { '.wasm': 'binary' },
  plugins: [embeddedAssetsPlugin(), undiciNodeTimersPlugin()],
  minify: true,
  legalComments: 'inline',
  metafile: true,
  sourcemap: false,
  logOverride: { 'empty-import-meta': 'silent' },
  logLevel: 'info',
}) }

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await buildPlugin()
  console.log('main.js contains the application, SQLite runtime, PDF parser, and all atlas data')
}
