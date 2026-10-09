import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { embeddedAssetsPlugin } from './build-obsidian.mjs'

const root = resolve(import.meta.dirname, '..')
const temporary = await mkdtemp(join(tmpdir(), 'healthpocket-tests-'))
try {
  const outfile = join(temporary, 'runtime.test.cjs')
  await build({ absWorkingDir: root, entryPoints: ['tests/runtime.test.ts'], outfile, bundle: true,
    platform: 'node', format: 'cjs', target: 'es2022', loader: { '.wasm': 'binary' }, plugins: [embeddedAssetsPlugin()], logLevel: 'warning' })
  const child = spawn(process.execPath, ['--test', outfile], { stdio: 'inherit', env: { ...process.env, HEALTHPOCKET_TEST_ROOT: root } })
  const code = await new Promise((done, fail) => { child.once('exit', done); child.once('error', fail) })
  process.exitCode = code ?? 1
} finally { await rm(temporary, { recursive: true, force: true }) }
