// Regression test for the Garmin transport (src/garmin.ts).
//
// Obsidian executes plugins inside Electron's renderer, where the bare globals
// `setTimeout`/`setInterval` are Chromium's DOM timers: they return numeric ids
// and have no `.unref()`. Undici - the Node transport src/garmin.ts uses to get
// around Garmin's browser-CORS-protected SSO pages - assumes Node timer objects,
// so without the build-time binding every request dies with
// `fastNowTimeout?.unref is not a function` before a byte is sent. In the shipped
// bundle that reads as `Fc?.unref is not a function`, because `Fc` is the
// minified `fastNowTimeout`.
//
// The bug cannot reproduce under plain Node, so this test bundles the real
// `garminFetch` twice - once without the build plugin (control) and once with it
// (the fix) - and runs both inside a child process whose timer globals mimic the
// renderer.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { undiciNodeTimersPlugin } from './build-obsidian.mjs'

const root = resolve(import.meta.dirname, '..')

const RUNNER = `import { createServer } from 'node:http'
import {
  setTimeout as nodeSetTimeout, clearTimeout as nodeClearTimeout,
  setInterval as nodeSetInterval, clearInterval as nodeClearInterval,
} from 'node:timers'

// Chromium semantics: numeric ids, callbacks still fire, no .unref()/.refresh().
const pending = new Map()
let nextId = 1
globalThis.setTimeout = (fn, ms, ...args) => { const id = nextId++; pending.set(id, nodeSetTimeout(() => { pending.delete(id); fn(...args) }, ms)); return id }
globalThis.clearTimeout = (id) => { const timer = pending.get(id); if (timer !== undefined) { nodeClearTimeout(timer); pending.delete(id) } }
globalThis.setInterval = (fn, ms, ...args) => { const id = nextId++; pending.set(id, nodeSetInterval(fn, ms, ...args)); return id }
globalThis.clearInterval = (id) => { const timer = pending.get(id); if (timer !== undefined) { nodeClearInterval(timer); pending.delete(id) } }

const domLikeTimer = typeof globalThis.setTimeout(() => {}, 5) === 'number'
const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"consumer_key":"k","consumer_secret":"s"}') })
await new Promise((done) => server.listen(0, '127.0.0.1', done))

let result
try {
  const { garminFetch } = await import(process.argv[2])
  const response = await garminFetch(\`http://127.0.0.1:\${server.address().port}/oauth_consumer.json\`)
  result = { ok: response.ok, status: response.status, body: await response.text() }
} catch (error) {
  const causes = []
  for (let cause = error?.cause; cause; cause = cause.cause) causes.push(String(cause.message ?? cause))
  result = { ok: false, status: 0, error: String(error?.message ?? error), causes }
} finally {
  server.close()
}
console.log('RESULT ' + JSON.stringify({ domLikeTimer, ...result }))
process.exit(0)
`

async function bundleGarminFetch(outfile, plugins) {
  await build({
    absWorkingDir: root,
    stdin: { contents: "export { garminFetch } from './src/garmin.ts'", resolveDir: root, loader: 'ts' },
    outfile, bundle: true, format: 'cjs', platform: 'node', target: 'es2022', plugins, logLevel: 'silent',
  })
}

function run(runnerPath, bundlePath) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [runnerPath, bundlePath], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', fail)
    child.on('close', (code) => {
      const line = stdout.split('\n').find((entry) => entry.startsWith('RESULT '))
      if (code !== 0 || !line) fail(new Error(`Garmin transport probe failed (exit ${code}): ${stdout}${stderr}`))
      else done(JSON.parse(line.slice('RESULT '.length)))
    })
  })
}

const dir = await mkdtemp(join(tmpdir(), 'healthpocket-garmin-transport-'))
try {
  const runnerPath = join(dir, 'runner.mjs')
  await writeFile(runnerPath, RUNNER)
  const control = join(dir, 'garmin-transport-default.cjs')
  const patched = join(dir, 'garmin-transport-node-timers.cjs')
  await bundleGarminFetch(control, [])
  await bundleGarminFetch(patched, [undiciNodeTimersPlugin()])

  const controlResult = await run(runnerPath, pathToFileURL(control).href)
  assert.equal(controlResult.domLikeTimer, true, 'the probe must install DOM-like timer globals')
  assert.equal(controlResult.ok, false, 'the Garmin transport must fail in the renderer environment without the timer patch')
  assert.match(controlResult.causes.join(' | '), /unref is not a function/, 'the control failure must be the missing .unref()')

  const patchedResult = await run(runnerPath, pathToFileURL(patched).href)
  assert.equal(patchedResult.domLikeTimer, true, 'the probe must install DOM-like timer globals')
  assert.equal(patchedResult.ok, true, `the Garmin transport must work under renderer timers: ${JSON.stringify(patchedResult)}`)
  assert.equal(patchedResult.status, 200)
  assert.match(patchedResult.body, /consumer_key/)

  console.log('garmin transport ok: fails on DOM timers without the node:timers binding, succeeds with it')
} finally {
  await rm(dir, { recursive: true, force: true })
}
