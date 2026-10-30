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

const GW_HWNDNEXT = 2
const GWL_EXSTYLE = -20
const WS_EX_TRANSPARENT = 0x20
const WS_EX_LAYERED = 0x80000
const LWA_ALPHA = 0x2
const DWMWA_EXTENDED_FRAME_BOUNDS = 9
const DWMWA_CLOAKED = 14

interface User32 {
  exists(hwnd: number): boolean
  isMinimized(hwnd: number): boolean
  isVisible(hwnd: number): boolean
  /** Retângulo visível (sem as bordas invisíveis de redimensionar do Windows 10). */
  frame(hwnd: number): Rect | null
  /** Escondida pelo Windows (apps da Store suspensos, outra área de trabalho virtual). */
  cloaked(hwnd: number): boolean
  /** Não aparece por cima de nada: transparente a cliques ou com opacidade zero. */
  seeThrough(hwnd: number): boolean
  top(): number
  next(hwnd: number): number
}

let user32: User32 | null = null

function load(): User32 {
  if (user32) return user32
  const lib = koffi.load(systemFile('user32.dll'))
  const dwm = koffi.load(systemFile('dwmapi.dll'))
  koffi.struct('GORDIUM_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
  const IsWindow = lib.func('bool __stdcall IsWindow(intptr_t hWnd)')
  const IsIconic = lib.func('bool __stdcall IsIconic(intptr_t hWnd)')
  const IsWindowVisible = lib.func('bool __stdcall IsWindowVisible(intptr_t hWnd)')
  const GetWindowRect = lib.func('bool __stdcall GetWindowRect(intptr_t hWnd, _Out_ GORDIUM_RECT *lpRect)')
  const GetTopWindow = lib.func('intptr_t __stdcall GetTopWindow(intptr_t hWnd)')
  const GetWindow = lib.func('intptr_t __stdcall GetWindow(intptr_t hWnd, uint32_t uCmd)')
  const GetWindowLongPtrW = lib.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hWnd, int nIndex)')
  const GetLayeredWindowAttributes = lib.func(
    'bool __stdcall GetLayeredWindowAttributes(intptr_t hWnd, _Out_ uint32_t *key, _Out_ uint8_t *alpha, _Out_ uint32_t *flags)'
  )
  const DwmGetWindowAttribute = dwm.func('int32_t __stdcall DwmGetWindowAttribute(intptr_t hWnd, uint32_t attr, void *value, uint32_t size)')

  const rectOf = (hwnd: number): Rect | null => {
    const buf = Buffer.alloc(16)
    if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, buf, 16) === 0) {
      return { left: buf.readInt32LE(0), top: buf.readInt32LE(4), right: buf.readInt32LE(8), bottom: buf.readInt32LE(12) }
    }
    const rect = {} as Rect
    return GetWindowRect(hwnd, rect) ? rect : null
  }

  user32 = {
    exists: (hwnd) => IsWindow(hwnd),
    isMinimized: (hwnd) => IsWindow(hwnd) && IsIconic(hwnd),
    isVisible: (hwnd) => IsWindowVisible(hwnd),
    frame: rectOf,
    cloaked: (hwnd) => {
      const buf = Buffer.alloc(4)
      return DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, buf, 4) === 0 && buf.readUInt32LE(0) !== 0
    },
    seeThrough: (hwnd) => {
      const ex = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE))
      if (ex & WS_EX_TRANSPARENT) return true
      if (!(ex & WS_EX_LAYERED)) return false
      // Overlays como o do NVIDIA GeForce ficam por cima de tudo com opacidade 0.
      const key: [number] = [0]
      const alpha: [number] = [255]
      const flags: [number] = [0]
      return GetLayeredWindowAttributes(hwnd, key, alpha, flags) && (flags[0] & LWA_ALPHA) !== 0 && alpha[0] === 0
    },
    top: () => Number(GetTopWindow(0)),
    next: (hwnd) => Number(GetWindow(hwnd, GW_HWNDNEXT))
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

/** Monitor em pixels físicos (o tamanho real do quadro capturado). */
export function physicalBounds(display: Display): { x: number; y: number; width: number; height: number } {
  return screen.dipToScreenRect(null, display.bounds)
}

/**
 * Onde está a janela dentro do monitor capturado e quais partes dela estão
 * cobertas por outras janelas (de cima para baixo na pilha do Windows, até ela).
 */
export function windowTrack(sourceId: string, monitor: { x: number; y: number; width: number; height: number }): WindowTrack {
  const empty = { x: 0, y: 0, width: 0, height: 0, monitorWidth: monitor.width, monitorHeight: monitor.height, covered: [] }
  const hwnd = hwndOf(sourceId)
  if (hwnd === null) return { ...empty, state: 'gone' }
  const api = load()
  if (!api.exists(hwnd)) return { ...empty, state: 'gone' }
  if (api.isMinimized(hwnd)) return { ...empty, state: 'minimized' }
  const r = api.frame(hwnd)
  if (!r || r.right <= r.left || r.bottom <= r.top) return { ...empty, state: 'minimized' }

  const covered: WindowTrack['covered'] = []
  let h = api.top()
  for (let guard = 0; h && h !== hwnd && guard < 4000; guard++) {
    if (api.isVisible(h) && !api.isMinimized(h) && !api.cloaked(h) && !api.seeThrough(h)) {
      const o = api.frame(h)
      if (o) {
        const left = Math.max(o.left, r.left)
        const top = Math.max(o.top, r.top)
        const right = Math.min(o.right, r.right)
        const bottom = Math.min(o.bottom, r.bottom)
        if (right > left && bottom > top) covered.push({ x: left - r.left, y: top - r.top, width: right - left, height: bottom - top })
      }
    }
    h = api.next(h)
  }
  return {
    state: 'visible',
    x: r.left - monitor.x,
    y: r.top - monitor.y,
    width: r.right - r.left,
    height: r.bottom - r.top,
    monitorWidth: monitor.width,
    monitorHeight: monitor.height,
    covered
  }
}
