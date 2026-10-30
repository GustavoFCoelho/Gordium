import { dirname, join } from 'node:path'
import koffi from 'koffi'

let systemDirectory: string | null = null

/**
 * Pasta de sistema do Windows (System32) pela API, e não por variável de
 * ambiente nem pelo PATH: o processo da VPN roda como administrador e não pode
 * executar um "netsh.exe" ou carregar uma DLL que o usuário comum plantou.
 */
export function systemDir(): string {
  if (systemDirectory) return systemDirectory
  try {
    // kernel32 é uma "KnownDLL": o Windows sempre a carrega do System32.
    const getSystemDirectory = koffi.load('kernel32.dll').func('uint32_t __stdcall GetSystemDirectoryW(void *buffer, uint32_t size)')
    const buf = Buffer.alloc(1040)
    const len = getSystemDirectory(buf, 520)
    if (len > 0 && len < 520) systemDirectory = buf.toString('utf16le', 0, len * 2)
  } catch {
    // sem koffi (fora do Windows): cai no padrão abaixo
  }
  return (systemDirectory ??= 'C:\\Windows\\System32')
}

/** Caminho completo de um executável ou DLL do System32. */
export function systemFile(name: string): string {
  return join(systemDir(), name)
}

/** Caminho completo de um arquivo da pasta do Windows (ex.: explorer.exe). */
export function windowsFile(name: string): string {
  return join(dirname(systemDir()), name)
}
