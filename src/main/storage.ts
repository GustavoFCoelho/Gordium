import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** Grava num arquivo temporário e renomeia, para não corromper se o app fechar no meio. */
export function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data))
  renameSync(tmp, file)
}
