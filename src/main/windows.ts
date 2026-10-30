import koffi from 'koffi'
import { screen, type Display } from 'electron'
import type { WindowTrack } from '../shared/types'
import { systemFile } from './system'

/** Onde uma janela está: em qual monitor, se o ocupa inteiro e se está minimizada. */
export interface WindowPlacement {
  minimized: boolean
  display: Display | null
  /** Cobre o monitor inteiro: jogo em tela cheia ou janela sem borda. */
  fullscreen: boolean
}

interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

const DWMWA_EXTENDED_FRAME_BOUNDS = 9

interface User32 {
  exists(hwnd: number): boolean
  isMinimized(hwnd: number): boolean
  /** Retângulo visível (sem as bordas invisíveis de redimensionar do Windows 10). */
  frame(hwnd: number): Rect | null
}

let user32: User32 | null = null

function load(): User32 {
  if (user32) return user32
  const lib = koffi.load(systemFile('user32.dll'))
  const dwm = koffi.load(systemFile('dwmapi.dll'))
  koffi.struct('GORDIUM_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
  const IsWindow = lib.func('bool __stdcall IsWindow(intptr_t hWnd)')
  const IsIconic = lib.func('bool __stdcall IsIconic(intptr_t hWnd)')
  const GetWindowRect = lib.func('bool __stdcall GetWindowRect(intptr_t hWnd, _Out_ GORDIUM_RECT *lpRect)')
  const DwmGetWindowAttribute = dwm.func('int32_t __stdcall DwmGetWindowAttribute(intptr_t hWnd, uint32_t attr, void *value, uint32_t size)')

  user32 = {
    exists: (hwnd) => IsWindow(hwnd),
    isMinimized: (hwnd) => IsWindow(hwnd) && IsIconic(hwnd),
    frame: (hwnd) => {
      const buf = Buffer.alloc(16)
      if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, buf, 16) === 0) {
        return { left: buf.readInt32LE(0), top: buf.readInt32LE(4), right: buf.readInt32LE(8), bottom: buf.readInt32LE(12) }
      }
      const rect = {} as Rect
      return GetWindowRect(hwnd, rect) ? rect : null
    }
  }
  return user32
}

/** Fonte de janela do desktopCapturer: "window:<HWND>:0". */
function hwndOf(sourceId: string): number | null {
  const m = /^window:(\d+):/.exec(sourceId)
  return m ? Number(m[1]) : null
}

export function windowPlacement(sourceId: string): WindowPlacement | null {
  const hwnd = hwndOf(sourceId)
  if (process.platform !== 'win32' || hwnd === null) return null
  try {
    const api = load()
    if (api.isMinimized(hwnd)) return { minimized: true, display: null, fullscreen: false }
    const r = api.frame(hwnd)
    if (!r) return null
    // As coordenadas do Windows são pixels físicos; os monitores do Electron estão em DIP (escala do Windows).
    const dip = screen.screenToDipRect(null, { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top })
    const display = screen.getDisplayMatching(dip)
    const b = display.bounds
    const fullscreen =
      dip.x <= b.x + 1 && dip.y <= b.y + 1 && dip.x + dip.width >= b.x + b.width - 1 && dip.y + dip.height >= b.y + b.height - 1
    return { minimized: false, display, fullscreen }
  } catch {
    return null
  }
}

/** Se a janela transmitida está visível, minimizada ou já foi fechada. */
export function windowTrack(sourceId: string): WindowTrack {
  const hwnd = hwndOf(sourceId)
  if (hwnd === null) return { state: 'gone' }
  const api = load()
  if (!api.exists(hwnd)) return { state: 'gone' }
  return { state: api.isMinimized(hwnd) ? 'minimized' : 'visible' }
}
