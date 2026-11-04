'use strict'

/* ============================================================
   SIM CONSOLE DESKTOP: the Electron main process. Serves the
   built app (dist/) from a loopback HTTP server and opens it in
   a sandboxed window, with native choosers for Web Serial and
   Web Bluetooth so USB, BLE and WiFi boards all work offline.

     npm run desktop        build, then run the app from dist/
     npm run desktop:dev    load SIM_CONSOLE_DEV_URL (npm run dev)
     <app> --smoke-test     load, check the page, print SMOKE OK
   ============================================================ */

const path = require('node:path')
const { app, BrowserWindow, Menu, dialog, screen, session, shell } = require('electron')
const lib = require('./lib.cjs')
const { startStaticServer } = require('./server.cjs')

const APP_NAME = 'SIM CONSOLE'
const DIST_DIR = path.join(__dirname, '..', 'dist')
const ICON_PATH = path.join(__dirname, '..', 'build', 'icon.png')
// an installed app always shows its own files; the dev server is for `electron .` only
const DEV_URL = app.isPackaged ? undefined : process.env.SIM_CONSOLE_DEV_URL
const IS_SMOKE = process.argv.includes('--smoke-test')
const IS_MAC = process.platform === 'darwin'
const SMOKE_TIMEOUT_MS = 30000
const SMOKE_POLL_MS = 250

let mainWindow = null
let stopServer = null
let isQuitting = false

/* ---------- window ---------- */

function createWindow() {
  const area = screen.getPrimaryDisplay().workAreaSize
  const win = new BrowserWindow({
    width: Math.min(1440, area.width),
    height: Math.min(900, area.height),
    minWidth: Math.min(960, area.width),
    minHeight: Math.min(600, area.height),
    backgroundColor: '#ECEEF0',
    title: APP_NAME,
    icon: ICON_PATH,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      // Chromium ships Web Bluetooth on Linux behind a flag
      ...(process.platform === 'linux' ? { enableBlinkFeatures: 'WebBluetooth' } : {}),
    },
  })
  win.on('page-title-updated', (event) => event.preventDefault())
  if (!IS_SMOKE) win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  attachBluetoothChooser(win)
  return win
}

/* ---------- security: navigation, popups, permissions ---------- */

/** Hand an https link to the default browser (failures, e.g. no browser, are ignored). */
function openInBrowser(url) {
  if (lib.isExternalHttpsUrl(url)) shell.openExternal(url).catch(() => undefined)
}

function guardContents(contents, appUrl) {
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.on('will-navigate', (event) => {
    if (lib.sameOrigin(event.url, appUrl)) return
    event.preventDefault()
    openInBrowser(event.url)
  })
  contents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url)
    return { action: 'deny' }
  })
}

function configureSession(ses, appUrl) {
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) =>
    lib.isPermissionAllowed(permission, requestingOrigin || details.securityOrigin || details.requestingUrl, appUrl),
  )
  ses.setPermissionRequestHandler((_contents, permission, callback, details) =>
    callback(lib.isPermissionAllowed(permission, details.requestingUrl, appUrl)),
  )
  ses.setDevicePermissionHandler((details) => details.deviceType === 'serial' && lib.sameOrigin(details.origin, appUrl))
  ses.on('select-serial-port', (event, ports, contents, callback) => {
    event.preventDefault()
    const reply = lib.once(callback)
    chooseSerialPort(BrowserWindow.fromWebContents(contents), ports).then(reply, () => reply(''))
  })
  // macOS pairs on its own; Windows and Linux cancel pairing that needs a prompt unless handled
  if (!IS_MAC) ses.setBluetoothPairingHandler((details, callback) => confirmPairing(details).then(callback))
}

/* ---------- native choosers ---------- */

function showBox(win, options) {
  const opts = { title: APP_NAME, noLink: false, ...options }
  return win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)
}

/** Ask the user to pick one item; resolves to its id, or '' when cancelled. */
async function choose(win, { message, items, toLabel, toId, noun }) {
  const chooser = lib.buildChooser(items, toLabel, toId)
  const more = chooser.hidden > 0 ? `\n${chooser.hidden} more ${noun} not shown.` : ''
  try {
    const { response } = await showBox(win, {
      type: 'question',
      message,
      detail: `${items.length} found.${more}`,
      buttons: [...chooser.buttons],
      cancelId: chooser.cancelId,
      defaultId: 0,
    })
    return lib.chosenId(chooser, response)
  } catch {
    return ''
  }
}

async function chooseSerialPort(win, ports) {
  if (ports.length === 0) {
    await showBox(win, {
      type: 'info',
      message: 'No serial ports found.',
      detail: 'Plug the board in over USB (a data cable, not a charge-only one) and press CONNECT again.',
      buttons: ['OK'],
    }).catch(() => undefined)
    return ''
  }
  return choose(win, { message: 'Choose a serial port', items: ports, toLabel: lib.serialPortLabel, toId: (p) => p.portId, noun: 'ports' })
}

async function chooseBluetoothDevice(win, devices) {
  if (devices.length === 0) {
    await showBox(win, {
      type: 'info',
      message: 'No Bluetooth devices found.',
      detail: 'Check that the board is powered, running the BLE firmware and close by, then press CONNECT again.',
      buttons: ['OK'],
    }).catch(() => undefined)
    return ''
  }
  return choose(win, { message: 'Choose a Bluetooth device', items: devices, toLabel: lib.bluetoothDeviceLabel, toId: (d) => d.deviceId, noun: 'devices' })
}

async function confirmPairing(details) {
  const prompt = lib.pairingPrompt(details)
  if (prompt === null) return { confirmed: false }
  try {
    const { response } = await showBox(mainWindow, { type: 'question', ...prompt, buttons: ['Pair', 'Cancel'], cancelId: 1, defaultId: 0 })
    return { confirmed: response === 0 }
  } catch {
    return { confirmed: false }
  }
}

/**
 * 'select-bluetooth-device' fires again for every device the scan finds. Collect them
 * (lib.bluetoothScanStep decides when), show one chooser, answer the request exactly once.
 */
function attachBluetoothChooser(win) {
  let scan = lib.SCAN_IDLE
  let reply = null
  let timer = null
  const reset = () => {
    clearTimeout(timer)
    timer = null
    reply = null
    scan = lib.SCAN_IDLE
  }
  const step = (event) => {
    const out = lib.bluetoothScanStep(scan, event)
    scan = out.state
    if (out.effect === 'wait') {
      clearTimeout(timer)
      timer = setTimeout(() => step({ type: 'tick', now: Date.now() }), out.delayMs)
    } else if (out.effect === 'prompt') {
      const answer = reply
      // a reset in the meantime (page gone) means the request no longer exists
      const settle = (id) => {
        if (answer === null || reply !== answer) return
        reset()
        answer(id)
      }
      chooseBluetoothDevice(win, out.state.devices).then(settle, () => settle(''))
    }
  }
  win.webContents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault()
    if (scan.phase === 'idle') reply = lib.once(callback)
    step({ type: 'devices', devices, now: Date.now() })
  })
  // a new document (reload, crash) ends any open request
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) reset()
  })
  win.webContents.on('render-process-gone', reset)
  win.webContents.on('destroyed', reset)
}

/* ---------- menu ---------- */

function showAbout() {
  return showBox(mainWindow, {
    type: 'info',
    title: `About ${APP_NAME}`,
    message: `${APP_NAME} ${app.getVersion()}`,
    detail: lib.aboutDetail(process.versions),
    buttons: ['OK'],
    icon: ICON_PATH,
  }).catch(() => undefined)
}

function installMenu() {
  const template = lib.menuTemplate({ isMac: IS_MAC, openUrl: openInBrowser, showAbout })
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/* ---------- smoke test ---------- */

const PROBE = `(async () => {
  const root = document.getElementById('root')
  const head = await fetch('./index.html', { method: 'HEAD' }).catch(() => null)
  return {
    rendered: !!root && root.childElementCount > 0,
    secure: window.isSecureContext,
    serial: 'serial' in navigator,
    bluetooth: 'bluetooth' in navigator,
    html: head ? head.headers.get('content-type') : null,
  }
})()`

const finishSmoke = lib.once((code, line) => {
  const out = code === 0 ? process.stdout : process.stderr
  out.write(`${line}\n`, () => app.exit(code))
})

/** Wait for the page to load and React to render, then report and quit. */
function runSmokeTest(win, appUrl) {
  const deadline = setTimeout(() => finishSmoke(1, `SMOKE FAIL timeout ${appUrl}`), SMOKE_TIMEOUT_MS)
  const contents = win.webContents
  contents.on('console-message', (event) => {
    if (event.level === 'error') process.stderr.write(`renderer error: ${event.message}\n`)
  })
  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame) return
    clearTimeout(deadline)
    finishSmoke(1, `SMOKE FAIL ${code} ${description} ${url}`)
  })
  contents.once('did-finish-load', async () => {
    while (!contents.isDestroyed()) {
      const probe = await contents.executeJavaScript(PROBE).catch(() => null)
      if (probe && probe.rendered) {
        clearTimeout(deadline)
        process.stdout.write(`probe ${JSON.stringify(probe)}\n`)
        const ok = probe.secure && probe.serial && typeof probe.html === 'string' && probe.html.startsWith('text/html')
        return finishSmoke(ok ? 0 : 1, `${ok ? 'SMOKE OK' : 'SMOKE FAIL'} ${appUrl}`)
      }
      await new Promise((resolve) => setTimeout(resolve, SMOKE_POLL_MS))
    }
  })
}

/* ---------- startup ---------- */

async function resolveAppUrl() {
  if (DEV_URL) return new URL(DEV_URL).href
  const served = await startStaticServer({ root: DIST_DIR })
  stopServer = served.close
  return served.url
}

/** A crashed or killed page (GPU driver reset, out of memory) offers a reload instead of a blank window. */
function offerReload(win, details) {
  if (IS_SMOKE) return finishSmoke(1, `SMOKE FAIL renderer ${details.reason}`)
  if (isQuitting || details.reason === 'clean-exit' || win.isDestroyed()) return
  showBox(win, {
    type: 'warning',
    message: 'The simulator page stopped unexpectedly.',
    detail: `Reason: ${details.reason}. Unsaved changes in the page may be lost.`,
    buttons: ['Reload', 'Quit'],
    cancelId: 1,
    defaultId: 0,
  }).then(({ response }) => (response === 0 && !win.isDestroyed() ? win.reload() : app.quit()), () => app.quit())
}

function openMainWindow(appUrl) {
  const win = createWindow()
  mainWindow = win
  win.webContents.on('render-process-gone', (_event, details) => offerReload(win, details))
  if (IS_SMOKE) runSmokeTest(win, appUrl)
  // did-fail-load reports load errors in smoke mode; ERR_ABORTED only means a newer navigation won
  win.loadURL(appUrl).catch((err) => {
    if (IS_SMOKE || err.code === 'ERR_ABORTED' || win.isDestroyed()) return
    dialog.showErrorBox(APP_NAME, `Could not load ${appUrl}\n\n${err.message}`)
  })
}

async function start() {
  const appUrl = await resolveAppUrl()
  app.on('web-contents-created', (_event, contents) => guardContents(contents, appUrl))
  configureSession(session.defaultSession, appUrl)
  installMenu()
  openMainWindow(appUrl)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow(appUrl)
  })
}

function focusMainWindow() {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

// the smoke test may run next to an open copy of the app, so it skips the single-instance lock
if (!IS_SMOKE && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', focusMainWindow)
  app.on('window-all-closed', () => {
    if (!IS_MAC) app.quit()
  })
  app.on('before-quit', () => {
    isQuitting = true
  })
  app.on('will-quit', () => {
    if (stopServer) stopServer()
  })
  app.whenReady().then(start).catch((err) => {
    dialog.showErrorBox(APP_NAME, `The app could not start.\n\n${err && err.stack ? err.stack : err}`)
    app.exit(1)
  })
}
