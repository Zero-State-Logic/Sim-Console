'use strict'

/* ============================================================
   DESKTOP DEV LAUNCHER (npm run desktop:dev): runs the desktop
   shell against the Vite dev server, so edits hot-reload in the
   app window. Start `npm run dev` in another terminal first.
   Sets SIM_CONSOLE_DEV_URL (default http://localhost:5173) in a
   way that also works in the Windows shell.
   ============================================================ */

const { spawn } = require('node:child_process')
const path = require('node:path')

const DEFAULT_DEV_URL = 'http://localhost:5173'
const devUrl = process.env.SIM_CONSOLE_DEV_URL || DEFAULT_DEV_URL

async function main() {
  try {
    await fetch(devUrl, { method: 'HEAD' })
  } catch {
    process.stderr.write(`Nothing answers at ${devUrl}. Start the dev server first: npm run dev\n`)
    process.exit(1)
  }
  const electron = require('electron')
  // some editor terminals export ELECTRON_RUN_AS_NODE, which would start Electron as plain Node
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
  const child = spawn(electron, [path.join(__dirname, '..'), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...env, SIM_CONSOLE_DEV_URL: devUrl },
  })
  child.on('close', (code) => process.exit(code ?? 1))
}

main()
