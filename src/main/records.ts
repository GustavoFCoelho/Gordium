import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import * as hcrypto from 'hypercore-crypto'
import { DEFAULT_TEXT_CHANNEL, DEFAULT_VOICE_CHANNEL, type ChannelKind } from '../shared/types'
import { cleanName } from './network/crypto'
import { writeJsonAtomic } from './storage'

/*
 * Dados que a rede inteira compartilha sem servidor: canais e sons do soundboard.
 * Cada criação/alteração/exclusão é um registro assinado por quem a fez; os
 * membros trocam os registros ao se conectar e repassam os novos na hora.
 * Conflito: vale a revisão mais recente (rev). Excluir = registro com data null.
 */

export type RecordKind = 'channel' | 'sound'

export interface ChannelData {
  kind: ChannelKind
  name: string
  createdAt: number
}

export interface SoundData {
  name: string
  emoji: string
  duration: number
  mime: string
  /** Áudio comprimido, em base64. */
  audio: string
  createdAt: number
}

export interface NetRecord {
  kind: RecordKind
  id: string
  rev: number
  author: string
  data: ChannelData | SoundData | null
  sig: string
}

export const MAX_SOUND_SECONDS = 6
/** ~210 KB de áudio: cabe folgado num frame da rede (512 KB). */
export const MAX_SOUND_BASE64 = 280_000
export const MAX_SOUNDS = 64
const SOUND_MIMES = new Set(['audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/wav'])
/** Revisões no futuro travariam o registro para todos; tolera relógios um pouco adiantados. */
const MAX_CLOCK_SKEW_MS = 10 * 60_000

export function isRecordId(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9a-z]{1,32}$/.test(id)
}

export function cleanChannelName(kind: ChannelKind, name: unknown): string {
  const clean = cleanName(name)
  // Canais de texto no estilo do Discord: minúsculas e hífens no lugar de espaços.
  return kind === 'text' ? clean.toLowerCase().replace(/\s+/g, '-').replace(/-+/g, '-') : clean
}

function signable(network: string, r: Omit<NetRecord, 'sig'>): Buffer {
  return Buffer.from(JSON.stringify(['gordium-rec/v1', network, r.kind, r.id, r.rev, r.author, r.data]))
}

export function signRecord(
  network: string,
  record: Omit<NetRecord, 'sig' | 'author'>,
  keyPair: { publicKey: Buffer; secretKey: Buffer }
): NetRecord {
  const unsigned = { ...record, author: keyPair.publicKey.toString('hex') }
  return { ...unsigned, sig: hcrypto.sign(signable(network, unsigned), keyPair.secretKey).toString('hex') }
}

function validChannel(id: string, d: Record<string, unknown>): ChannelData | null {
  if (d.kind !== 'text' && d.kind !== 'voice') return null
  // Os canais padrão só podem ser renomeados, sem trocar de tipo.
  if (id === DEFAULT_TEXT_CHANNEL && d.kind !== 'text') return null
  if (id === DEFAULT_VOICE_CHANNEL && d.kind !== 'voice') return null
  const name = cleanChannelName(d.kind, d.name)
  if (!name || name !== d.name || typeof d.createdAt !== 'number' || !Number.isFinite(d.createdAt)) return null
  return { kind: d.kind, name, createdAt: d.createdAt }
}

function validSound(d: Record<string, unknown>): SoundData | null {
  const name = cleanName(d.name)
  if (!name || name !== d.name || name.length > 24) return null
  if (typeof d.emoji !== 'string' || d.emoji.length > 16 || /[\u0000-\u001f]/.test(d.emoji)) return null
  if (typeof d.duration !== 'number' || !(d.duration > 0) || d.duration > MAX_SOUND_SECONDS + 0.5) return null
  if (typeof d.mime !== 'string' || !SOUND_MIMES.has(d.mime)) return null
  if (typeof d.audio !== 'string' || d.audio.length > MAX_SOUND_BASE64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(d.audio)) return null
  if (typeof d.createdAt !== 'number' || !Number.isFinite(d.createdAt)) return null
  return { name, emoji: d.emoji, duration: d.duration, mime: d.mime, audio: d.audio, createdAt: d.createdAt }
}

/** Confere formato e assinatura de um registro que chegou de outro membro. */
export function verifyRecord(raw: unknown, network: string): NetRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.kind !== 'channel' && r.kind !== 'sound') return null
  if (!isRecordId(r.id)) return null
  if (typeof r.rev !== 'number' || !Number.isFinite(r.rev) || r.rev > Date.now() + MAX_CLOCK_SKEW_MS) return null
  if (typeof r.author !== 'string' || !/^[0-9a-f]{64}$/.test(r.author)) return null
  if (typeof r.sig !== 'string' || !/^[0-9a-f]{128}$/.test(r.sig)) return null
  let data: ChannelData | SoundData | null = null
  if (r.data !== null) {
    if (!r.data || typeof r.data !== 'object') return null
    const d = r.data as Record<string, unknown>
    data = r.kind === 'channel' ? validChannel(r.id, d) : validSound(d)
    if (!data) return null
  }
  const rec: NetRecord = { kind: r.kind, id: r.id, rev: r.rev, author: r.author, data, sig: r.sig }
  const ok = hcrypto.verify(signable(network, rec), Buffer.from(rec.sig, 'hex'), Buffer.from(rec.author, 'hex'))
  return ok ? rec : null
}

const keyOf = (r: Pick<NetRecord, 'kind' | 'id'>): string => `${r.kind}:${r.id}`

/** Mais nova vence; empate (mesmo milissegundo) decidido pela assinatura, igual em todos. */
function isNewer(a: NetRecord, b: NetRecord | undefined): boolean {
  return !b || a.rev > b.rev || (a.rev === b.rev && a.sig > b.sig)
}

/** Registros de cada rede, guardados localmente em JSON. */
export class RecordStore {
  private readonly cache = new Map<string, Map<string, NetRecord>>()
  private readonly saveTimers = new Map<string, NodeJS.Timeout>()

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  private file(network: string): string {
    return join(this.dir, `${network}.json`)
  }

  private map(network: string): Map<string, NetRecord> {
    let map = this.cache.get(network)
    if (!map) {
      map = new Map()
      const file = this.file(network)
      if (existsSync(file)) {
        try {
          const list = JSON.parse(readFileSync(file, 'utf8'))
          if (Array.isArray(list)) for (const r of list as NetRecord[]) map.set(keyOf(r), r)
        } catch {
          // arquivo corrompido: os registros voltam pela sincronização com os outros
        }
      }
      this.cache.set(network, map)
    }
    return map
  }

  all(network: string): NetRecord[] {
    return [...this.map(network).values()]
  }

  get(network: string, kind: RecordKind, id: string): NetRecord | undefined {
    return this.map(network).get(keyOf({ kind, id }))
  }

  /** Guarda o registro se ele for mais novo que o atual. Devolve se mudou algo. */
  apply(network: string, rec: NetRecord): boolean {
    const map = this.map(network)
    if (!isNewer(rec, map.get(keyOf(rec)))) return false
    map.set(keyOf(rec), rec)
    this.scheduleSave(network)
    return true
  }

  /** Resumo [chave, rev] para comparar com outro membro. */
  summary(network: string): [string, number][] {
    return this.all(network).map((r) => [keyOf(r), r.rev])
  }

  /** Registros que o outro lado não tem ou tem numa versão mais velha. */
  newerThan(network: string, theirs: Map<string, number>): NetRecord[] {
    return this.all(network).filter((r) => {
      const rev = theirs.get(keyOf(r))
      return rev === undefined || r.rev > rev
    })
  }

  remove(network: string): void {
    clearTimeout(this.saveTimers.get(network))
    this.saveTimers.delete(network)
    this.cache.delete(network)
    rmSync(this.file(network), { force: true })
  }

  flush(): void {
    for (const [network, timer] of this.saveTimers) {
      clearTimeout(timer)
      this.save(network)
    }
    this.saveTimers.clear()
  }

  private scheduleSave(network: string): void {
    if (this.saveTimers.has(network)) return
    this.saveTimers.set(
      network,
      setTimeout(() => {
        this.saveTimers.delete(network)
        this.save(network)
      }, 500)
    )
  }

  private save(network: string): void {
    const map = this.cache.get(network)
    if (map) writeJsonAtomic(this.file(network), [...map.values()])
  }
}
