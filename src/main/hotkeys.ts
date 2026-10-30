import koffi from 'koffi'
import { isHotkey, isModifierKey, type Hotkey } from '../shared/hotkeys'
import { systemFile } from './system'

/*
 * Atalho global de mutar. Em vez de registrar o atalho no Windows (que tira a
 * tecla dos outros programas), olha o estado da tecla de tanto em tanto: o
 * Gordium só observa, a tecla continua funcionando em qualquer lugar, e por
 * isso uma tecla sozinha (ou um botão lateral do mouse) serve de atalho.
 */

/** Um toque rápido numa tecla dura uns 50 ms: olhando a cada 15 ms, nenhum escapa. */
const POLL_MS = 15

const VK_SHIFT = 0x10
const VK_CONTROL = 0x11
const VK_MENU = 0x12
const VK_LWIN = 0x5b
const VK_RWIN = 0x5c

let getAsyncKeyState: ((vk: number) => number) | null = null
let timer: NodeJS.Timeout | null = null

function isDown(vk: number): boolean {
  getAsyncKeyState ??= koffi.load(systemFile('user32.dll')).func('int16_t __stdcall GetAsyncKeyState(int vKey)')
  return (getAsyncKeyState(vk) & 0x8000) !== 0
}

/**
 * Ctrl/Alt/Shift/Win exatamente como no atalho: "F9" não dispara com Ctrl+F9
 * (que pode ser de outro programa). Um modificador sozinho como atalho vale
 * com qualquer combinação.
 */
function modifiersMatch(hotkey: Hotkey): boolean {
  if (isModifierKey(hotkey.vk)) return true
  return (
    isDown(VK_CONTROL) === hotkey.ctrl &&
    isDown(VK_MENU) === hotkey.alt &&
    isDown(VK_SHIFT) === hotkey.shift &&
    (isDown(VK_LWIN) || isDown(VK_RWIN)) === hotkey.win
  )
}

/** Liga o atalho de mutar (null desliga). `onPress` roda uma vez a cada vez que a tecla é apertada. */
export function setMuteHotkey(hotkey: unknown, onPress: () => void): void {
  if (timer) clearInterval(timer)
  timer = null
  if (hotkey === null) return
  if (!isHotkey(hotkey)) throw new Error('Atalho inválido.')
  isDown(hotkey.vk) // carrega a user32 agora: se falhar, o erro chega na interface
  // Começa como "apertada": a tecla que a pessoa acabou de gravar só conta depois de solta.
  let wasDown = true
  timer = setInterval(() => {
    const down = isDown(hotkey.vk)
    // Segurar a tecla não fica alternando: só conta quando ela passa de solta para apertada.
    if (down && !wasDown && modifiersMatch(hotkey)) onPress()
    wasDown = down
  }, POLL_MS)
}
