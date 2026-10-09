import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { embeddedAssetsPlugin } from './build-obsidian.mjs'

const folder = await mkdtemp(join(tmpdir(), 'healthpocket-private-regression-'))
try {
  const outfile = join(folder, 'check.cjs')
  // Wrap top-level await while keeping dependencies statically bundled.
  await build({ absWorkingDir: resolve(import.meta.dirname, '..'), stdin: {
    contents: `import('./tests/private-regression.ts').catch(error => { console.error(error); process.exitCode=1 })`,
    resolveDir: resolve(import.meta.dirname, '..'), loader: 'ts',
  }, outfile, bundle: true, format: 'cjs', platform: 'node', target: 'es2022', loader: { '.wasm': 'binary' }, plugins: [embeddedAssetsPlugin()] })
  const child = spawn(process.execPath, [outfile], { stdio: 'inherit', env: process.env })
  process.exitCode = await new Promise((done, fail) => { child.once('exit', done); child.once('error', fail) }) ?? 1
} finally { await rm(folder, { recursive: true, force: true }) }
