/**
 * Garmin login probe - one command, no Obsidian involved.
 *
 * The plugin's login runs inside Electron's renderer, behind a local HTTP
 * server, a serial queue and an iframe; when it "does nothing", all of those are
 * suspects. This script drives the *same* production code (`garminFetch` +
 * `createGarminAuthFlow`) straight from Node and prints one line per hop as it
 * happens, so the question "is the code wrong or is Garmin slow?" has an answer
 * that does not depend on anything in the UI.
 *
 *   node scripts/garmin-diagnose.mjs --live    # real Garmin, asks for the account
 *   node scripts/garmin-diagnose.mjs --stall   # local stub: headers, then silence
 *   node scripts/garmin-diagnose.mjs --slow    # local stub: every hop answers late
 *
 * `--live` prompts for the password without echoing it and keeps it in memory
 * only; nothing is written to disk, and neither email nor password is logged.
 * Set GARMIN_EMAIL / GARMIN_PASSWORD / GARMIN_DOMAIN to skip the prompts, or
 * GARMIN_MFA_CODE to answer the verification code non-interactively.
 *
 * The .ts sources use TypeScript parameter properties, which Node's type
 * stripping refuses, so the probe is bundled with esbuild first and the bundle is
 * what actually runs. `--stall` and `--slow` need no account at all.
 */
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const temporary = await mkdtemp(join(tmpdir(), 'healthpocket-garmin-probe-'))
const outfile = join(temporary, 'probe.mjs')

try {
  await build({
    absWorkingDir: root,
    entryPoints: ['scripts/garmin-diagnose-core.mjs'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    loader: { '.wasm': 'binary' },
    logLevel: 'warning',
    // Bundling CJS (undici, sql.js) into ESM needs a real `require`.
    banner: { js: "import { createRequire as __hpCreateRequire } from 'node:module'; const require = __hpCreateRequire(import.meta.url);" },
  })
  const child = spawn(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env })
  const code = await new Promise((done, fail) => { child.once('exit', done); child.once('error', fail) })
  process.exitCode = code ?? 1
} finally {
  await rm(temporary, { recursive: true, force: true })
}
