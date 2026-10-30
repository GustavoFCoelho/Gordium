/*
 * Atalho global de mutar/desmutar. A interface grava a tecla (ou um botão
 * lateral do mouse) e o processo principal fica olhando o estado dela no
 * Windows, por isso funciona com o Gordium em segundo plano, dentro de um jogo.
 * O Gordium só observa: a tecla continua chegando aos outros programas, então
 * qualquer tecla serve sozinha, sem precisar de Ctrl, Alt ou Shift.
 */

export interface Hotkey {
  /** Código virtual do Windows da tecla (ou botão do mouse). */
  vk: number
  ctrl: boolean
  alt: boolean
  shift: boolean
  win: boolean
  /** Como aparece na interface: "F9", "M", "Ctrl + M", "Ctrl direito", "Mouse 4". */
  label: string
}

/** Códigos virtuais de cada lado dos modificadores (para usar um deles sozinho como atalho). */
const SIDE_VK: Record<string, number> = {
  ShiftLeft: 0xa0,
  ShiftRight: 0xa1,
  ControlLeft: 0xa2,
  ControlRight: 0xa3,
  AltLeft: 0xa4,
  AltRight: 0xa5,
  MetaLeft: 0x5b,
  MetaRight: 0x5c
}
const MODIFIER_VKS = new Set([0x10, 0x11, 0x12, ...Object.values(SIDE_VK)])

/** A tecla do atalho é um modificador (ex.: "Ctrl direito" sozinho). */
export const isModifierKey = (vk: number): boolean => MODIFIER_VKS.has(vk)

/** Mouse: botões laterais ("voltar" e "avançar"), comuns como tecla de microfone. */
const MOUSE_BUTTONS: Record<number, { vk: number; label: string }> = {
  3: { vk: 0x05, label: 'Mouse 4' },
  4: { vk: 0x06, label: 'Mouse 5' }
}

const NAMES: Record<string, string> = {
  ShiftLeft: 'Shift esquerdo',
  ShiftRight: 'Shift direito',
  ControlLeft: 'Ctrl esquerdo',
  ControlRight: 'Ctrl direito',
  AltLeft: 'Alt',
  AltRight: 'Alt direito',
  MetaLeft: 'Win',
  MetaRight: 'Win direito',
  Space: 'Espaço',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  CapsLock: 'Caps Lock',
  NumLock: 'Num Lock',
  ScrollLock: 'Scroll Lock',
  PrintScreen: 'Print Screen',
  ContextMenu: 'Menu',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num -',
  NumpadMultiply: 'Num *',
  NumpadDivide: 'Num /',
  NumpadDecimal: 'Num ,',
  NumpadEnter: 'Num Enter'
}

function keyName(e: { code: string; key: string }): string {
  if (NAMES[e.code]) return NAMES[e.code]
  const numpad = /^Numpad(\d)$/.exec(e.code)
  if (numpad) return `Num ${numpad[1]}`
  if (e.key.length === 1) return e.key.toUpperCase()
  return e.key && e.key !== 'Dead' && e.key !== 'Unidentified' ? e.key : e.code
}

interface Mods {
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

function build(vk: number, name: string, e: Mods): Hotkey {
  const hotkey = { vk, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, win: e.metaKey, label: '' }
  hotkey.label = [hotkey.ctrl && 'Ctrl', hotkey.alt && 'Alt', hotkey.shift && 'Shift', hotkey.win && 'Win', name].filter(Boolean).join(' + ')
  return hotkey
}

/** Os modificadores apertados agora, para mostrar enquanto a pessoa monta a combinação. */
export function modifiersLabel(e: Mods): string {
  return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Win'].filter(Boolean).join(' + ')
}

export type HotkeyResult = { ok: true; hotkey: Hotkey } | { ok: false; error: string | null }

/**
 * Atalho a partir de uma tecla apertada. Modificadores dão `error: null`: a
 * pessoa ainda pode completar a combinação (ou soltar, ver `hotkeyFromRelease`).
 */
export function hotkeyFromKeyDown(e: Mods & { code: string; key: string; keyCode: number }): HotkeyResult {
  if (SIDE_VK[e.code] || isModifierKey(e.keyCode)) return { ok: false, error: null }
  // 229: tecla indo para um editor de texto (IME), sem código próprio.
  if (!Number.isInteger(e.keyCode) || e.keyCode <= 0 || e.keyCode > 254 || e.keyCode === 229) {
    return { ok: false, error: 'Essa tecla não pode ser usada. Tente outra.' }
  }
  return { ok: true, hotkey: build(e.keyCode, keyName(e), e) }
}

/** Soltou um modificador sem apertar outra tecla: ele sozinho vira o atalho (ex.: Ctrl direito). */
export function hotkeyFromRelease(code: string): Hotkey | null {
  const vk = SIDE_VK[code]
  return vk ? build(vk, NAMES[code], { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }) : null
}

/** Botão lateral do mouse; null para os outros botões. */
export function hotkeyFromMouse(e: Mods & { button: number }): Hotkey | null {
  const button = MOUSE_BUTTONS[e.button]
  return button ? build(button.vk, button.label, e) : null
}

/** Confere um atalho vindo da interface ou das configurações salvas. */
export function isHotkey(x: unknown): x is Hotkey {
  if (typeof x !== 'object' || x === null) return false
  const h = x as Record<string, unknown>
  return (
    Number.isInteger(h.vk) &&
    (h.vk as number) > 0 &&
    (h.vk as number) <= 254 &&
    ['ctrl', 'alt', 'shift', 'win'].every((k) => typeof h[k] === 'boolean') &&
    typeof h.label === 'string' &&
    h.label.length <= 64
  )
}

/** A versão 0.1.10 guardava o atalho como acelerador do Electron ("Ctrl+Alt+Shift+F9"). */
export function hotkeyFromAccelerator(accelerator: string): Hotkey | null {
  const parts = accelerator.split('+')
  const key = parts.pop() ?? ''
  let vk = 0
  if (/^[A-Z0-9]$/.test(key)) vk = key.charCodeAt(0)
  else if (/^F([1-9]|1\d|2[0-4])$/.test(key)) vk = 0x6f + Number(key.slice(1))
  else if (/^num\d$/.test(key)) vk = 0x60 + Number(key.slice(3))
  if (!vk) return null
  const name = key.startsWith('num') ? `Num ${key.slice(3)}` : key
  return build(vk, name, { ctrlKey: parts.includes('Ctrl'), altKey: parts.includes('Alt'), shiftKey: parts.includes('Shift'), metaKey: parts.includes('Super') })
}
