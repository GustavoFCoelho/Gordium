/*
 * Atalho global de mutar/desmutar. A interface monta o atalho a partir da tecla
 * pressionada e o processo principal o registra no Windows (globalShortcut),
 * por isso funciona com o Gordium em segundo plano, dentro de um jogo. O
 * Windows reserva a combinação para o Gordium: ela deixa de chegar aos outros
 * programas. Por isso letras, números e teclas de edição só valem com Ctrl,
 * Alt ou Shift; sozinhas, só teclas que quase nenhum programa usa.
 */

interface KeyDef {
  /** Nome no acelerador do Electron. */
  accel: string
  /** Nome mostrado na interface. */
  label: string
  /** Código virtual do Windows (para saber quando a tecla foi solta). */
  vk: number
  /** Pode ser usada sem Ctrl/Alt/Shift. */
  alone: boolean
}

const KEYS = new Map<string, KeyDef>()
const add = (code: string, accel: string, label: string, vk: number, alone: boolean): void => {
  KEYS.set(code, { accel, label, vk, alone })
}

for (let i = 0; i < 26; i++) {
  const letter = String.fromCharCode(65 + i)
  add(`Key${letter}`, letter, letter, 0x41 + i, false)
}
for (let i = 0; i <= 9; i++) add(`Digit${i}`, String(i), String(i), 0x30 + i, false)
for (let i = 1; i <= 24; i++) add(`F${i}`, `F${i}`, `F${i}`, 0x70 + i - 1, true)
for (let i = 0; i <= 9; i++) add(`Numpad${i}`, `num${i}`, `Num ${i}`, 0x60 + i, true)
add('NumpadAdd', 'numadd', 'Num +', 0x6b, true)
add('NumpadSubtract', 'numsub', 'Num -', 0x6d, true)
add('NumpadMultiply', 'nummult', 'Num *', 0x6a, true)
add('NumpadDivide', 'numdiv', 'Num /', 0x6f, true)
add('NumpadDecimal', 'numdec', 'Num ,', 0x6e, true)
add('Insert', 'Insert', 'Insert', 0x2d, true)
add('ScrollLock', 'Scrolllock', 'Scroll Lock', 0x91, true)
add('Delete', 'Delete', 'Delete', 0x2e, false)
add('Home', 'Home', 'Home', 0x24, false)
add('End', 'End', 'End', 0x23, false)
add('PageUp', 'PageUp', 'Page Up', 0x21, false)
add('PageDown', 'PageDown', 'Page Down', 0x22, false)
add('ArrowUp', 'Up', '↑', 0x26, false)
add('ArrowDown', 'Down', '↓', 0x28, false)
add('ArrowLeft', 'Left', '←', 0x25, false)
add('ArrowRight', 'Right', '→', 0x27, false)
add('Space', 'Space', 'Espaço', 0x20, false)

const MODIFIERS = [
  ['Ctrl', 'Ctrl'],
  ['Alt', 'Alt'],
  ['Shift', 'Shift'],
  ['Super', 'Win']
] as const

/** Atalhos que atrapalhariam o próprio Windows. */
const RESERVED = new Set(['Alt+F4', 'Ctrl+Alt+Delete', 'Super+L'])

const byAccel = new Map([...KEYS.values()].map((k) => [k.accel, k]))

export interface ParsedHotkey {
  modifiers: string[]
  key: KeyDef
}

/** Lê um acelerador gerado por `hotkeyFromEvent`; null se não for um atalho aceito. */
export function parseHotkey(accelerator: string): ParsedHotkey | null {
  if (typeof accelerator !== 'string' || accelerator.length > 64 || RESERVED.has(accelerator)) return null
  const parts = accelerator.split('+')
  const key = byAccel.get(parts.pop() ?? '')
  if (!key) return null
  const order = MODIFIERS.map(([accel]) => accel as string)
  // Modificadores sem repetição e na ordem de sempre: um atalho tem uma escrita só.
  if (parts.some((p, i) => !order.includes(p) || (i > 0 && order.indexOf(p) <= order.indexOf(parts[i - 1])))) return null
  if (parts.length === 0 && !key.alone) return null
  return { modifiers: parts, key }
}

/** "Ctrl + Shift + M" */
export function hotkeyLabel(accelerator: string): string {
  const parsed = parseHotkey(accelerator)
  if (!parsed) return accelerator
  const names = new Map<string, string>(MODIFIERS)
  return [...parsed.modifiers.map((m) => names.get(m) ?? m), parsed.key.label].join(' + ')
}

/** Só as teclas modificadoras, para mostrar enquanto a pessoa ainda monta a combinação. */
export function modifiersLabel(e: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string {
  const held = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Win'].filter(Boolean)
  return held.join(' + ')
}

export type HotkeyResult = { ok: true; accelerator: string } | { ok: false; error: string | null }

/** Monta o atalho a partir de uma tecla pressionada. `error: null` = só modificadores, ainda esperando a tecla. */
export function hotkeyFromEvent(e: { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): HotkeyResult {
  if (/^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(e.code)) return { ok: false, error: null }
  const key = KEYS.get(e.code)
  if (!key) return { ok: false, error: 'Essa tecla não pode ser usada. Tente uma tecla F, do teclado numérico ou uma letra com Ctrl/Alt/Shift.' }
  const flags = [e.ctrlKey, e.altKey, e.shiftKey, e.metaKey]
  const modifiers = MODIFIERS.filter((_, i) => flags[i]).map(([accel]) => accel)
  if (modifiers.length === 0 && !key.alone) {
    return { ok: false, error: `Use ${key.label} junto com Ctrl, Alt ou Shift: sozinha, ela deixaria de funcionar nos outros programas.` }
  }
  const accelerator = [...modifiers, key.accel].join('+')
  if (RESERVED.has(accelerator)) return { ok: false, error: 'Esse atalho é do Windows. Escolha outro.' }
  return { ok: true, accelerator }
}
