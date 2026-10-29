import { EventEmitter } from 'node:events'
import { app } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import type { UpdateState } from '../shared/types'

const CHECK_INTERVAL_MS = 30 * 60_000

/** As notas vêm do feed de Releases do GitHub em HTML; a interface mostra texto simples. */
function notesText(notes: UpdateInfo['releaseNotes']): string | null {
  const raw = Array.isArray(notes) ? notes.map((n) => n.note ?? '').join('\n') : notes
  if (!raw) return null
  const text = raw
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/(li|p|h\d)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text || null
}

/**
 * Atualização pelas Releases do GitHub (electron-updater). A versão nova é
 * baixada em segundo plano; quando termina, a interface mostra o botão de
 * atualizar. Se a pessoa não clicar, ela é instalada ao fechar o app.
 */
export class Updater extends EventEmitter<{ changed: [] }> {
  readonly state: UpdateState = {
    status: app.isPackaged ? 'idle' : 'unsupported',
    current: app.getVersion(),
    next: null,
    notes: null,
    progress: 0,
    error: null,
    checkedAt: null
  }

  start(): void {
    if (!app.isPackaged) return
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true

    autoUpdater.on('checking-for-update', () => {
      if (this.state.status === 'idle' || this.state.status === 'error') this.set({ status: 'checking', error: null })
    })
    autoUpdater.on('update-not-available', () => {
      if (this.state.status === 'checking') this.set({ status: 'idle' })
      this.set({ checkedAt: Date.now() })
    })
    autoUpdater.on('update-available', (info) => {
      this.set({ status: 'downloading', next: info.version, notes: notesText(info.releaseNotes), progress: 0, checkedAt: Date.now() })
    })
    autoUpdater.on('download-progress', (p) => {
      this.set({ status: 'downloading', progress: Math.round(p.percent) })
    })
    autoUpdater.on('update-downloaded', (info) => {
      this.set({ status: 'ready', next: info.version, notes: notesText(info.releaseNotes) ?? this.state.notes, progress: 100 })
    })
    autoUpdater.on('error', (err) => {
      // Uma falha ao procurar de novo não apaga uma atualização que já está baixada.
      if (this.state.status !== 'ready') this.set({ status: 'error', error: err.message })
    })

    this.check()
    setInterval(() => this.check(), CHECK_INTERVAL_MS)
  }

  check(): void {
    if (!app.isPackaged || this.state.status === 'downloading') return
    autoUpdater.checkForUpdates().catch((err: Error) => {
      if (this.state.status !== 'ready') this.set({ status: 'error', error: err.message })
    })
  }

  /** Fecha o app, roda o instalador em modo silencioso e reabre já atualizado. */
  install(): void {
    if (this.state.status !== 'ready') return
    autoUpdater.quitAndInstall(true, true)
  }

  private set(patch: Partial<UpdateState>): void {
    Object.assign(this.state, patch)
    this.emit('changed')
  }
}
