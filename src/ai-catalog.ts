import type { LanguageModel } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { Models, type Provider, type ProviderMap } from '@opencode-ai/models'

/**
 * Providers and models come from Models.dev (https://models.dev), the open
 * catalog OpenCode uses: each entry names its endpoint, the AI SDK package that
 * speaks its API, and per-model capabilities. Two entries are not in it: a local
 * Ollama and any OpenAI-compatible endpoint the user names.
 */
export const OLLAMA = 'ollama'
export const CUSTOM = 'custom'
export const OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1'

/**
 * Shown first, in this order, under Chinese names. Each one was checked to accept
 * requests from Obsidian's renderer, which enforces browser CORS.
 */
const FEATURED: Record<string, string> = {
  deepseek: 'DeepSeek',
  'siliconflow-cn': '硅基流动',
  'alibaba-cn': '阿里云百炼',
  'moonshotai-cn': 'Moonshot AI（Kimi）',
  zhipuai: '智谱 AI',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic（Claude）',
  google: 'Google Gemini',
}

/** Provider ids saved before the switch to Models.dev ids. */
export const RENAMED_PROVIDERS: Record<string, string> = { siliconflow: 'siliconflow-cn', moonshot: 'moonshotai-cn', dashscope: 'alibaba-cn' }

export type AiAdapter = 'openai' | 'openai-compatible' | 'anthropic' | 'google' | 'openrouter' | 'deepseek'

/** The AI SDK packages bundled with the plugin; providers needing any other are left out. */
const ADAPTERS: Record<string, AiAdapter> = {
  '@ai-sdk/openai': 'openai',
  '@ai-sdk/openai-compatible': 'openai-compatible',
  '@ai-sdk/anthropic': 'anthropic',
  '@ai-sdk/google': 'google',
  '@openrouter/ai-sdk-provider': 'openrouter',
}

export interface AiProviderInfo {
  id: string
  name: string
  base_url: string
  requires_api_key: boolean
  featured: boolean
  custom_base_url: boolean
}

export interface AiConnection {
  provider: string
  base_url: string
  model: string
}

export interface ResolvedModel {
  model: LanguageModel
  adapter: AiAdapter
  supportsTools: boolean
}

const REFRESH_MS = 12 * 60 * 60 * 1000
const RETRY_MS = 10 * 60 * 1000

export const isLocal = (url: string | undefined) => !!url && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/i.test(url)
// Some entries need an account id or host spliced into the URL first.
const usable = (provider: Provider) => Boolean(ADAPTERS[provider.npm]) && !provider.api?.includes('${')
// Bundled with the package and at most a day behind Models.dev; loaded only when needed.
const snapshot = async () => (await import('@opencode-ai/models/snapshot')).providers

export class AiCatalog {
  private live: ProviderMap | null = null
  private nextCheck = 0
  private loading: Promise<ProviderMap> | null = null

  constructor(private readonly fetchProviders = () => Models.make().providers({ signal: AbortSignal.timeout(8_000) })) {}

  /** The live catalog, refreshed every 12 hours; the bundled snapshot while Models.dev is out of reach. */
  async providers(): Promise<ProviderMap> {
    if (Date.now() < this.nextCheck) return this.live ?? snapshot()
    this.loading ??= this.fetchProviders()
      .then((providers) => { this.live = providers; this.nextCheck = Date.now() + REFRESH_MS; return providers })
      .catch(() => { this.nextCheck = Date.now() + RETRY_MS; return this.live ?? snapshot() })
      .finally(() => { this.loading = null })
    return this.loading
  }

  /** What is on hand without waiting on the network; a due refresh runs in the background. */
  private async current(): Promise<ProviderMap> {
    if (Date.now() >= this.nextCheck) void this.providers()
    return this.live ?? snapshot()
  }

  async list(): Promise<AiProviderInfo[]> {
    const catalog = await this.providers()
    const info = (provider: Provider): AiProviderInfo => ({
      id: provider.id, name: FEATURED[provider.id] ?? provider.name, base_url: provider.api ?? '',
      requires_api_key: !isLocal(provider.api), featured: provider.id in FEATURED, custom_base_url: false,
    })
    const featured = Object.keys(FEATURED).map((id) => catalog[id]).filter((provider): provider is Provider => provider !== undefined && usable(provider)).map(info)
    const others = Object.values(catalog).filter((provider) => usable(provider) && !(provider.id in FEATURED)).map(info)
      .sort((a, b) => a.name.localeCompare(b.name))
    return [
      ...featured,
      { id: OLLAMA, name: 'Ollama（本机）', base_url: OLLAMA_BASE_URL, requires_api_key: false, featured: true, custom_base_url: true },
      { id: CUSTOM, name: '自定义 OpenAI 兼容接口', base_url: '', requires_api_key: false, featured: true, custom_base_url: true },
      ...others,
    ]
  }

  /** The provider's catalog entry, or null for Ollama and custom endpoints. */
  async provider(id: string): Promise<AiProviderInfo | null> {
    if (id === OLLAMA || id === CUSTOM) return null
    const found = (await this.list()).find((item) => item.id === id)
    if (!found) throw new Error('请选择有效的模型供应商')
    return found
  }

  /** Chat models the catalog lists for a provider, newest first. */
  async models(id: string): Promise<string[]> {
    const provider = (await this.providers())[id]
    if (!provider) return []
    return Object.values(provider.models)
      .filter((model) => model.status !== 'deprecated' && (model.type ?? 'chat') === 'chat' && model.modalities.output.includes('text'))
      .sort((a, b) => b.release_date.localeCompare(a.release_date) || a.id.localeCompare(b.id))
      .map((model) => model.id)
  }

  async resolve(connection: AiConnection, apiKey: string): Promise<ResolvedModel> {
    if (connection.provider === OLLAMA || connection.provider === CUSTOM) {
      return { model: compatible(connection.provider, connection.base_url, apiKey)(connection.model), adapter: 'openai-compatible', supportsTools: true }
    }
    const provider = (await this.current())[connection.provider]
    if (!provider || !usable(provider)) throw new Error('该模型供应商已不在 Models.dev 目录中，请重新选择')
    const entry = provider.models[connection.model]
    const npm = entry?.provider?.npm ?? provider.npm
    const baseURL = entry?.provider?.api ?? provider.api
    // DeepSeek keeps its own package: it returns reasoning to the API the way V4 tool calls require.
    const adapter = connection.provider === 'deepseek' ? 'deepseek' : ADAPTERS[npm]
    if (!adapter) throw new Error('该模型需要的接口暂不支持，请换一个模型')
    // Models the catalog does not list yet are assumed to call tools, as before.
    const supportsTools = entry ? entry.tool_call : true
    const id = connection.model
    if (adapter === 'deepseek') return { model: createDeepSeek({ apiKey, baseURL })(id), adapter, supportsTools }
    if (adapter === 'openai') {
      const openai = createOpenAI({ apiKey, baseURL })
      return { model: entry?.provider?.shape === 'completions' ? openai.chat(id) : openai.responses(id), adapter, supportsTools }
    }
    // Anthropic only answers a browser origin (Obsidian's renderer) when asked to.
    if (adapter === 'anthropic') return { model: createAnthropic({ apiKey, baseURL, headers: { 'anthropic-dangerous-direct-browser-access': 'true' } })(id), adapter, supportsTools }
    if (adapter === 'google') return { model: createGoogleGenerativeAI({ apiKey, baseURL })(id), adapter, supportsTools }
    if (adapter === 'openrouter') return { model: createOpenRouter({ apiKey, baseURL })(id), adapter, supportsTools }
    return { model: compatible(provider.id, baseURL ?? '', apiKey)(id), adapter, supportsTools }
  }
}

function compatible(name: string, baseURL: string, apiKey: string) {
  return createOpenAICompatible({ name, baseURL, apiKey: apiKey || undefined, supportsStructuredOutputs: false })
}
