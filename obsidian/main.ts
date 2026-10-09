import { App, FileSystemAdapter, ItemView, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf } from 'obsidian'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { type AddressInfo } from 'node:net'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { BackendManager, API_PREFIX, PLUGIN_PREFIX, json } from '../src/backend.ts'
import { APP_PREFIX, handleStatic } from '../src/static.ts'
import { authorizedRequest } from '../src/local-security.ts'
import { checkForUpdate, downloadUpdate } from './update-check.ts'
import type { UpdateStatus, Updater } from '../src/local-api.ts'

const VIEW_TYPE_HEALTHPOCKET = 'healthpocket-view'
const SECRET_PREFIX = 'healthpocket-'
const LEGACY_SECRET_PREFIX = 'heathpocket-'
const GARMIN_TOKENS_SECRET = 'healthpocket-garmin-tokens'

/** The parts of Obsidian's internal plugin manager used to reload this plugin after an update. */
interface PluginManager {
  loadManifests(): Promise<void>
  disablePlugin(id: string): Promise<void>
  enablePlugin(id: string): Promise<boolean>
  plugins: Record<string, unknown>
}

interface HealthPocketSettings {
  /** Experimental, off by default: it drives Garmin's private mobile-app API. */
  garminEnabled: boolean
  /**
   * The port the local app last listened on. Reusing it keeps the iframe's
   * origin stable across restarts, so the web app's localStorage (the selected
   * profile) survives. A random port is picked when it is taken.
   */
  port: number | null
}

const DEFAULT_SETTINGS: HealthPocketSettings = { garminEnabled: false, port: null }

class HealthPocketView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private readonly plugin: HealthPocketPlugin) {
    super(leaf)
  }

  getViewType(): string {
    return VIEW_TYPE_HEALTHPOCKET
  }

  getDisplayText(): string {
    return '健康口袋'
  }

  getIcon(): string {
    return 'heart-pulse'
  }

  async onOpen(): Promise<void> {
    await this.render()
  }

  /** Rebuilds the iframe, e.g. after a setting that changes the app's navigation. */
  async render(): Promise<void> {
    this.contentEl.empty()
    this.contentEl.addClass('healthpocket-obsidian-view')

    let src: string
    try {
      src = await this.plugin.appUrl()
    } catch (error) {
      this.contentEl.createEl('p', { text: `健康口袋启动失败：${error instanceof Error ? error.message : String(error)}` })
      return
    }
    const iframe = this.contentEl.createEl('iframe', {
      attr: {
        title: '健康口袋',
        src,
        allow: 'clipboard-read; clipboard-write',
      },
    })
    iframe.addClass('healthpocket-obsidian-frame')
  }

  async onClose(): Promise<void> {
    this.contentEl.empty()
  }
}

class HealthPocketSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: HealthPocketPlugin) {
    super(app, plugin)
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()
    new Setting(containerEl)
      .setName('Garmin 同步（实验性）')
      .setDesc('开启后可在健康口袋中登录 Garmin 账号并手动同步睡眠、心率、压力、步数等数据。该功能模拟 Garmin Connect 手机 App 的非公开接口，不是 Garmin 官方产品，可能违反 Garmin 服务条款，接口也可能随时失效。默认关闭；关闭后不会连接 Garmin，已同步的数据仍保留在本地。')
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.garminEnabled)
        .onChange(async (value) => {
          this.plugin.settings.garminEnabled = value
          await this.plugin.saveSettings()
          await this.plugin.reloadViews()
        }))
  }
}

export default class HealthPocketPlugin extends Plugin {
  settings: HealthPocketSettings = { ...DEFAULT_SETTINGS }
  private packageRoot: string | null = null
  private backend: BackendManager | null = null
  private server: Server | null = null
  private origin: string | null = null
  private starting: Promise<void> | null = null
  private readonly accessToken = randomBytes(32).toString('hex')

  private backendOptions() {
    const storage = this.app.secretStorage
    return { garminEnabled: () => this.settings.garminEnabled, checkUpdate: () => checkForUpdate(this.manifest.version), appVersion: this.manifest.version, updater: this.updater, secretStore: {
      get: (id: string) => {
        const value = storage.getSecret(id)
        if (value || !id.startsWith(SECRET_PREFIX)) return value
        // Builds before 0.3.0 used the misspelled plugin id as the key prefix.
        // Move a saved secret over the first time it is asked for.
        const legacyId = `${LEGACY_SECRET_PREFIX}${id.slice(SECRET_PREFIX.length)}`
        const legacy = storage.getSecret(legacyId)
        if (!legacy) return value
        storage.setSecret(id, legacy)
        storage.setSecret(legacyId, '')
        return legacy
      },
      set: (id: string, value: string) => storage.setSecret(id, value),
    } }
  }

  private updateStatus: UpdateStatus = { phase: 'idle', version: null, received: 0, total: 0, error: null }

  /** Downloads in the background; the web app polls status() and asks for restart() when ready. */
  private readonly updater: Updater = {
    status: () => this.updateStatus,
    start: async () => {
      if (this.updateStatus.phase === 'downloading' || this.updateStatus.phase === 'ready') return this.updateStatus
      const { latest, hasUpdate } = await checkForUpdate(this.manifest.version)
      if (!hasUpdate) throw new Error(`已是最新版本 ${latest}`)
      if (this.packageRoot === null) this.packageRoot = this.resolvePackageRoot()
      const pluginDir = this.packageRoot
      this.updateStatus = { phase: 'downloading', version: latest, received: 0, total: 0, error: null }
      void downloadUpdate(latest, this.manifest.id, pluginDir, ({ received, total }) => {
        this.updateStatus = { ...this.updateStatus, received, total }
      }).then(
        () => { this.updateStatus = { ...this.updateStatus, phase: 'ready' } },
        (error: unknown) => { this.updateStatus = { ...this.updateStatus, phase: 'error', error: error instanceof Error ? error.message : String(error) } },
      )
      return this.updateStatus
    },
    // Wait for the API response to go out: the reload closes this server.
    restart: () => { window.setTimeout(() => void this.restart(), 300) },
  }

  private async restart(): Promise<void> {
    const plugins = (this.app as unknown as { plugins: PluginManager }).plugins
    const id = this.manifest.id
    const reopen = this.app.workspace.getLeavesOfType(VIEW_TYPE_HEALTHPOCKET).length > 0
    try {
      await plugins.disablePlugin(id)
      // Re-read manifest.json so the new instance reports the new version.
      await plugins.loadManifests()
      await plugins.enablePlugin(id)
      const next = plugins.plugins[id] as HealthPocketPlugin | undefined
      if (reopen) await next?.activateView()
      new Notice(`健康口袋已更新到 ${next?.manifest.version ?? '新版本'}`)
    } catch (error) {
      console.error('[HealthPocket] reload after update failed', error)
      new Notice('健康口袋已下载新版本，请重启 Obsidian 生效')
    }
  }

  async onload(): Promise<void> {
    await this.loadSettings()
    this.registerView(
      VIEW_TYPE_HEALTHPOCKET,
      (leaf) => new HealthPocketView(leaf, this),
    )

    this.addRibbonIcon('heart-pulse', '打开健康口袋', () => {
      void this.activateView()
    })
    this.addCommand({
      id: 'open-view',
      name: '打开主界面',
      callback: () => void this.activateView(),
    })
    this.addSettingTab(new HealthPocketSettingTab(this.app, this))
    // The local server and database start on first use (opening the view),
    // not here, so enabling the plugin costs nothing at Obsidian startup.
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData() ?? {}) as Partial<HealthPocketSettings>
    this.settings = { ...DEFAULT_SETTINGS, ...saved }
    // Garmin sync was always on before it became opt-in. Keep it on for anyone
    // who had already signed in, so upgrading does not silently hide their data.
    if (saved.garminEnabled === undefined) {
      const storage = this.app.secretStorage
      if (storage.getSecret(GARMIN_TOKENS_SECRET) || storage.getSecret(`${LEGACY_SECRET_PREFIX}garmin-tokens`)) {
        this.settings.garminEnabled = true
        await this.saveSettings()
      }
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }

  async reloadViews(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_HEALTHPOCKET)) {
      if (leaf.view instanceof HealthPocketView) await leaf.view.render()
    }
  }

  onunload(): void {
    this.backend?.dispose()
    this.backend = null
    this.server?.close()
    this.server = null
    this.origin = null
    this.packageRoot = null
  }

  /** Starts the local server on first use and returns the app's address. */
  async appUrl(): Promise<string> {
    await this.startServer()
    return `${this.origin}${APP_PREFIX}/#healthpocket-token=${this.accessToken}`
  }

  async activateView(): Promise<void> {
    try {
      await this.startServer()
    } catch (error) {
      console.error('[HealthPocket] failed to start local server', error)
      new Notice(`健康口袋启动失败：${error instanceof Error ? error.message : String(error)}`)
      return
    }

    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_HEALTHPOCKET)[0]
    const leaf = existing ?? this.app.workspace.getLeaf('tab')
    await leaf.setViewState({ type: VIEW_TYPE_HEALTHPOCKET, active: true })
    await this.app.workspace.revealLeaf(leaf)
  }

  private startServer(): Promise<void> {
    if (this.server !== null && this.origin !== null) return Promise.resolve()
    // A restored view and the command can both ask at once; start only one server.
    this.starting ??= this.listenOnce().finally(() => { this.starting = null })
    return this.starting
  }

  private async listenOnce(): Promise<void> {
    if (this.packageRoot === null) this.packageRoot = this.resolvePackageRoot()
    if (this.backend === null) this.backend = new BackendManager(this.packageRoot, this.backendOptions())

    const server = createServer((req, res) => {
      void this.route(req, res).catch((error: unknown) => {
        console.error('[HealthPocket] request failed', error)
        if (!res.headersSent) {
          json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        } else {
          res.destroy()
        }
      })
    })

    const listen = (port: number) => new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      server.once('error', onError)
      server.listen(port, '127.0.0.1', () => { server.off('error', onError); resolve() })
    })
    const preferred = this.settings.port
    try {
      await listen(preferred ?? 0)
    } catch (error) {
      if (preferred === null) throw error
      // The remembered port is taken (another vault, another app): pick any.
      await listen(0)
    }
    server.unref()

    const address = server.address() as AddressInfo
    this.server = server
    this.origin = `http://127.0.0.1:${address.port}`
    if (address.port !== preferred) {
      this.settings.port = address.port
      await this.saveSettings()
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? '/', this.origin ?? 'http://127.0.0.1').pathname

    if (!this.origin || req.headers.host !== new URL(this.origin).host) {
      json(res, 403, { detail: '本地请求来源无效' }); return
    }
    if (!pathname.startsWith(`${APP_PREFIX}/`) && !['/', PLUGIN_PREFIX, APP_PREFIX].includes(pathname)
      && !authorizedRequest(req, this.origin, this.accessToken)) {
      json(res, 403, { detail: '请从 Obsidian 中打开健康口袋' }); return
    }

    if (pathname === '/' || pathname === PLUGIN_PREFIX || pathname === APP_PREFIX) {
      res.writeHead(302, { location: `${APP_PREFIX}/` })
      res.end()
      return
    }

    if (pathname === `${PLUGIN_PREFIX}/status`) {
      json(res, 200, { ok: true, ...this.backend?.status() })
      return
    }

    if (pathname === `${PLUGIN_PREFIX}/start`) {
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      const status = await this.backend?.ensureStarted()
      json(res, 200, { ok: status?.phase === 'running', ...status })
      return
    }

    if (pathname.startsWith(`${API_PREFIX}/`) || pathname === API_PREFIX) {
      await this.backend?.proxy(req, res)
      return
    }

    if (pathname.startsWith(`${APP_PREFIX}/`)) {
      await handleStatic(req, res)
      return
    }

    json(res, 404, { ok: false, error: 'not-found' })
  }

  private resolvePackageRoot(): string {
    const adapter = this.app.vault.adapter
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error('健康口袋仅支持桌面端本地 vault')
    }
    const pluginDir = this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`
    return realpathSync(join(adapter.getBasePath(), pluginDir))
  }
}
