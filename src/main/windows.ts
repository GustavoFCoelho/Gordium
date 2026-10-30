import koffi from 'koffi'
import { screen, type Display } from 'electron'
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

let user32: { getRect(hwnd: number): Rect | null; isMinimized(hwnd: number): boolean } | null = null

function load(): NonNullable<typeof user32> {
  if (user32) return user32
  const lib = koffi.load(systemFile('user32.dll'))
  koffi.struct('GORDIUM_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
  const IsWindow = lib.func('bool __stdcall IsWindow(intptr_t hWnd)')
  const IsIconic = lib.func('bool __stdcall IsIconic(intptr_t hWnd)')
  const GetWindowRect = lib.func('bool __stdcall GetWindowRect(intptr_t hWnd, _Out_ GORDIUM_RECT *lpRect)')
  user32 = {
    getRect: (hwnd) => {
      const rect = {} as Rect
      return IsWindow(hwnd) && GetWindowRect(hwnd, rect) ? rect : null
    },
    isMinimized: (hwnd) => IsWindow(hwnd) && IsIconic(hwnd)
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
    const r = api.getRect(hwnd)
    if (!r) return null
    // GetWindowRect devolve pixels físicos; os monitores do Electron estão em DIP (escala do Windows).
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
