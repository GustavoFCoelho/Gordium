import { execFile } from 'node:child_process'
import { release } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, desktopCapturer, ipcMain, session, shell, type DesktopCapturerSource } from 'electron'
import type { RtcSignal, ScreenSource } from '../shared/types'
import { Core } from './core'
import { Updater } from './updater'

// GORDIUM_PROFILE=b permite rodar uma segunda instância (outro usuário) na mesma máquina.
const profile = (process.env.GORDIUM_PROFILE ?? '').replace(/[^a-z0-9_-]/gi, '')
if (profile) app.setPath('userData', join(app.getPath('appData'), `Gordium-${profile}`))

// Sem isso o Chromium esconde os IPs locais (inclusive o da VPN) atrás de nomes mDNS,
// e o WebRTC não consegue usar o túnel do Gordium como caminho.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns')

if (!app.requestSingleInstanceLock()) app.exit(0)

let core: Core
let updater: Updater
let win: BrowserWindow | null = null
let quitting = false
const screenSources = new Map<string, DesktopCapturerSource>()
let pendingCapture: { source: DesktopCapturerSource; audio: boolean } | null = null

function wintunPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'wintun', 'wintun.dll')
    : join(app.getAppPath(), 'resources', 'wintun', process.arch, 'wintun.dll')
}

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

let stateTimer: NodeJS.Timeout | null = null
function pushState(): void {
  if (stateTimer) return
  stateTimer = setTimeout(() => {
    stateTimer = null
    send('state', core.state())
  }, 30)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#1e1f22',
    title: profile ? `Gordium (${profile})` : 'Gordium',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  // Mantém o perfil no título (o <title> da página o sobrescreveria).
  if (profile) win.on('page-title-updated', (e) => e.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

/**
 * Som do computador SEM o som do próprio Gordium. Com o 'loopback' comum, as
 * vozes da chamada (que o app está tocando) entravam na transmissão da tela e
 * todo mundo se ouvia em dobro. 'loopbackWithoutChrome' é um dispositivo do
 * Chromium que usa o process loopback do Windows (10 versão 2004+, build 19041)
 * para excluir a árvore de processos do app; o Electron ainda não o lista nos
 * tipos, mas o repassa. Em Windows mais antigo, fica o loopback comum.
 */
const SYSTEM_AUDIO = (process.platform === 'win32' && Number(release().split('.')[2]) >= 19041
  ? 'loopbackWithoutChrome'
  : 'loopback') as 'loopback'

function setupMedia(): void {
  const allowed = new Set(['media', 'display-capture', 'clipboard-sanitized-write', 'speaker-selection', 'fullscreen'])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))

  // getDisplayMedia() na interface cai aqui; a fonte foi escolhida antes no seletor do Gordium.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    const pick = pendingCapture
    pendingCapture = null
    if (!pick) return callback({})
    callback(pick.audio ? { video: pick.source, audio: SYSTEM_AUDIO } : { video: pick.source })
  })
}

function relaunchElevated(): void {
  const quote = (s: string): string => `'${s.replace(/'/g, "''")}'`
  const args = process.argv.slice(1)
  const argList = args.length ? ` -ArgumentList ${args.map(quote).join(',')}` : ''
  // Solta a trava de instância única para a cópia elevada conseguir abrir.
  app.releaseSingleInstanceLock()
  execFile(
    'powershell.exe',
    ['-NoProfile', '-Command', `Start-Process -FilePath ${quote(process.execPath)}${argList} -Verb RunAs`],
    { windowsHide: true },
    (err) => {
      if (err) app.requestSingleInstanceLock() // UAC cancelado: continua nesta instância
      else app.exit(0)
    }
  )
}

function setupIpc(): void {
  ipcMain.handle('state:get', () => core.state())
  ipcMain.handle('chat:list', (_e, network: string) => core.messages(network))
  ipcMain.handle('chat:send', (_e, network: string, text: string) => core.sendChat(network, text))
  ipcMain.handle('net:create', (_e, name: string) => core.createNetwork(name))
  ipcMain.handle('net:join', (_e, invite: string) => core.joinNetwork(invite))
  ipcMain.handle('net:leave', (_e, id: string) => core.leaveNetwork(id))
  ipcMain.handle('self:name', (_e, name: string) => core.setName(name))
  ipcMain.handle('voice:set', (_e, network: string, state: unknown) => core.setVoice(network, state))
  ipcMain.on('rtc:send', (_e, network: string, peer: string, signal: RtcSignal) => core.sendRtc(network, peer, signal))

  ipcMain.handle('screen:sources', async (): Promise<ScreenSource[]> => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 }
    })
    screenSources.clear()
    return sources.map((s) => {
      screenSources.set(s.id, s)
      return {
        id: s.id,
        name: s.name,
        thumbnail: s.thumbnail.toDataURL(),
        kind: s.id.startsWith('screen:') ? 'screen' : 'window'
      }
    })
  })
  ipcMain.handle('screen:select', (_e, id: string, audio: boolean) => {
    const source = screenSources.get(id)
    if (!source) throw new Error('Essa tela ou janela não está mais disponível.')
    pendingCapture = { source, audio: !!audio }
  })

  ipcMain.handle('vpn:start', () => core.vpn.start())
  ipcMain.handle('vpn:stop', () => core.vpn.stop())
  ipcMain.handle('vpn:elevate', () => relaunchElevated())

  ipcMain.handle('update:get', () => updater.state)
  ipcMain.handle('update:check', () => updater.check())
  ipcMain.handle('update:install', () => updater.install())
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.whenReady().then(() => {
  core = new Core(app.getPath('userData'), {
    dllPath: wintunPath(),
    adapterName: profile ? `Gordium-${profile}` : 'Gordium',
    canElevate: app.isPackaged
  })
  core.on('changed', pushState)
  core.on('chat', (network, messages) => send('chat', network, messages))
  core.on('rtc', (network, peer, signal) => send('rtc', network, peer, signal))
  updater = new Updater()
  updater.on('changed', () => send('update', updater.state))

  setupMedia()
  setupIpc()
  createWindow()
  core.init()
  updater.start()

  // Latência e contadores da VPN mudam sem eventos: atualiza a interface periodicamente.
  setInterval(pushState, 2000)
})

app.on('window-all-closed', () => app.quit())

app.on('before-quit', (e) => {
  if (quitting || !core) return
  e.preventDefault()
  quitting = true
  const timeout = new Promise((r) => setTimeout(r, 4000))
  // app.quit() (e não app.exit) para o evento 'quit' acontecer: é nele que o
  // electron-updater instala uma atualização baixada.
  void Promise.race([core.shutdown(), timeout]).finally(() => app.quit())
})
