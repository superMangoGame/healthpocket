import assert from 'node:assert/strict'
import Module from 'node:module'
import { mkdtemp, copyFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Exercise the actual compiled entry in a folder containing only marketplace assets.
const root = resolve(import.meta.dirname, '..')
const folder = await mkdtemp(join(tmpdir(), 'healthpocket-three-files-'))
const previous = process.env.HEALTHPOCKET_DATA_DIR
const dataFolder = await mkdtemp(join(tmpdir(), 'healthpocket-smoke-data-'))
process.env.HEALTHPOCKET_DATA_DIR = dataFolder
const originalLoad = Module._load
let plugin
try {
  for (const name of ['main.js', 'manifest.json', 'styles.css']) await copyFile(join(root, name), join(folder, name))
  assert.deepEqual((await readdir(folder)).sort(), ['main.js', 'manifest.json', 'styles.css'])
  class FileSystemAdapter { getBasePath() { return folder } }
  class Plugin {
    manifest = { dir: '.' }
    secrets = new Map()
    app = { vault: { adapter: new FileSystemAdapter() }, workspace: { detachLeavesOfType() {} }, secretStorage: {
      getSecret: (id) => this.secrets.get(id) ?? null,
      setSecret: (id, value) => { this.secrets.set(id, value) },
    } }
    data = null
    registerView() {} addRibbonIcon() {} addCommand() {} addSettingTab() {}
    async loadData() { return this.data }
    async saveData(value) { this.data = value }
  }
  Module._load = function (request, parent, isMain) {
    if (request === 'obsidian') return { Plugin, ItemView: class {}, PluginSettingTab: class {}, Setting: class {}, FileSystemAdapter, Notice: class { constructor(message) { throw new Error(message) } } }
    return originalLoad.call(this, request, parent, isMain)
  }
  const modulePath = join(folder, 'main.js'); const compiled = new Module(modulePath)
  compiled.filename = modulePath
  compiled.paths = []
  compiled._compile(await readFile(modulePath, 'utf8'), modulePath)
  Module._load = originalLoad
  const HealthPocketPlugin = compiled.exports.default
  plugin = new HealthPocketPlugin()
  plugin.manifest = { ...JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8')), dir: '.' }
  await plugin.onload()
  assert.equal(plugin.server, null, 'the local server must start on first use, not on load')
  const appUrl = new URL(await plugin.appUrl())
  const token = new URLSearchParams(appUrl.hash.slice(1)).get('healthpocket-token')
  assert.ok(token)
  const api = `${appUrl.origin}/heathpocket/api`
  assert.equal((await fetch(`${api}/reports`)).status, 403)
  const health = await (await fetch(`${api}/health?token=${token}`)).json()
  assert.equal(health.runtime, 'typescript')
  const profiles = await (await fetch(`${api}/profiles?token=${token}`)).json()
  assert.equal(profiles.length, 1)
  const garmin = await (await fetch(`${api}/garmin/settings?token=${token}`)).json()
  assert.equal(garmin.feature_enabled, false, 'Garmin sync must be opt-in')
  assert.equal((await fetch(`${api}/garmin/sync?token=${token}`, { method: 'POST', body: '{}' })).status, 403)
  const html = await fetch(appUrl); assert.equal(html.status, 200); assert.match(await html.text(), /健康口袋/)
  const atlas = await (await fetch(`${appUrl.origin}/heathpocket/app/models/human-atlas/atlas.json`)).json()
  assert.equal(atlas.parts.length, 2234)
  console.log('Three-file smoke passed: compiled plugin starts, protected API responds, and all 2234 atlas parts are embedded.')
  if (process.argv.includes('--serve')) {
    plugin.server.ref()
    console.log(`Synthetic empty-vault preview: ${appUrl.href}`)
    await new Promise((done) => { process.once('SIGINT', done); process.once('SIGTERM', done) })
  }
} finally {
  Module._load = originalLoad
  if (plugin) {
    const backend = plugin.backend
    plugin.server?.closeAllConnections(); plugin.onunload()
    await backend?.api?.settled(); await backend?.database?.close()
  }
  if (previous === undefined) delete process.env.HEALTHPOCKET_DATA_DIR; else process.env.HEALTHPOCKET_DATA_DIR = previous
  await rm(folder, { recursive: true, force: true }); await rm(dataFolder, { recursive: true, force: true })
}
