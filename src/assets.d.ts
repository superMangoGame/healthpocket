declare module '*.wasm' {
  const bytes: Uint8Array
  export default bytes
}

declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: { initializeFromPort(port: unknown): void }
}

declare module 'virtual:healthpocket-assets' {
  export interface EmbeddedAsset {
    contentType: string
    encoding: 'gzip-base64'
    body: string
  }
  export const STATIC_ASSETS: Record<string, EmbeddedAsset>
}
