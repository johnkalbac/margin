/** Electron half of scripts/perf.mjs — loads the built benchmark and reports. */
const { join } = require('node:path')
const { app, BrowserWindow } = require('electron')

app.commandLine.appendSwitch('disable-gpu-vsync')

async function main() {
  await app.whenReady()

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 840,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })

  await win.loadFile(join(__dirname, '..', 'out-perf', 'index.html'))
  const result = await win.webContents.executeJavaScript('window.runBench()')

  console.log(`BENCH_RESULT ${JSON.stringify(result)}`)
  app.exit(0)
}

main().catch((error) => {
  console.error(error)
  app.exit(1)
})
