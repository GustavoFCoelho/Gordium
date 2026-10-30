import { globalShortcut } from 'electron'
import koffi from 'koffi'
import { parseHotkey } from '../shared/hotkeys'
import { systemFile } from './system'

/** Enquanto a tecla segue apertada, olha de tanto em tanto se já foi solta. */
const RELEASE_POLL_MS = 40
/** Se a leitura do teclado falhar, o atalho volta a valer depois disso. */
const MAX_HOLD_MS = 10_000

let current: string | null = null
let held: NodeJS.Timeout | null = null
let getAsyncKeyState: ((vk: number) => number) | null = null

function isDown(vk: number): boolean {
  try {
    getAsyncKeyState ??= koffi.load(systemFile('user32.dll')).func('int16_t __stdcall GetAsyncKeyState(int vKey)')
    return (getAsyncKeyState(vk) & 0x8000) !== 0
  } catch {
    return false
  }
}

/**
 * Registra o atalho global de mutar (null desliga). Devolve false se o Windows
 * recusar, normalmente porque outro programa já usa a mesma combinação.
 */
export function setMuteHotkey(accelerator: string | null, onPress: () => void): boolean {
  if (current) globalShortcut.unregister(current)
  current = null
  if (accelerator === null) return true
  const parsed = parseHotkey(accelerator)
  if (!parsed) throw new Error('Atalho inválido.')
  let ok = false
  try {
    ok = globalShortcut.register(accelerator, () => {
      // Segurar a tecla faz o Windows repetir o atalho: só vale de novo depois de soltá-la.
      if (held) return
      onPress()
      const since = Date.now()
      held = setInterval(() => {
        if (isDown(parsed.key.vk) && Date.now() - since < MAX_HOLD_MS) return
        clearInterval(held!)
        held = null
      }, RELEASE_POLL_MS)
    })
  } catch {
    ok = false
  }
  if (ok) current = accelerator
  return ok
}
