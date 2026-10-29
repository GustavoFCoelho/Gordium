import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import * as hcrypto from 'hypercore-crypto'
import type { ChatMessage } from '../shared/types'
import { cleanName } from './network/crypto'
import { writeJsonAtomic } from './storage'

const MAX_TEXT = 4000
const MAX_STORED = 5000
/** Quantas mensagens recentes entram na comparação de histórico ao conectar. */
export const SYNC_WINDOW = 500

function signable(m: Pick<ChatMessage, 'network' | 'author' | 'name' | 'ts' | 'text'>): Buffer {
  return Buffer.from(JSON.stringify(['gordium-msg/v1', m.network, m.author, m.name, m.ts, m.text]))
}

function messageId(sig: Buffer): string {
  return createHash('sha256').update(sig).digest().subarray(0, 16).toString('hex')
}

export function createMessage(
  network: string,
  keyPair: { publicKey: Buffer; secretKey: Buffer },
  name: string,
  text: string
): ChatMessage {
  const base = { network, author: keyPair.publicKey.toString('hex'), name, ts: Date.now(), text: text.slice(0, MAX_TEXT) }
  const sig = hcrypto.sign(signable(base), keyPair.secretKey)
  return { ...base, id: messageId(sig), sig: sig.toString('hex') }
}

/**
 * Mensagens chegam de qualquer membro (inclusive repassadas na sincronização),
 * então só valem se a assinatura bater com a chave do autor.
 */
export function verifyMessage(raw: unknown, network: string): ChatMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  if (m.network !== network) return null
  if (typeof m.author !== 'string' || !/^[0-9a-f]{64}$/.test(m.author)) return null
  if (typeof m.sig !== 'string' || !/^[0-9a-f]{128}$/.test(m.sig)) return null
  if (typeof m.text !== 'string' || m.text.length === 0 || m.text.length > MAX_TEXT) return null
  if (typeof m.ts !== 'number' || !Number.isFinite(m.ts)) return null
  if (typeof m.name !== 'string' || cleanName(m.name) !== m.name) return null

  const msg: ChatMessage = {
    id: '',
    network,
    author: m.author,
    name: m.name,
    ts: m.ts,
    text: m.text,
    sig: m.sig
  }
  const sig = Buffer.from(msg.sig, 'hex')
  if (!hcrypto.verify(signable(msg), sig, Buffer.from(msg.author, 'hex'))) return null
  msg.id = messageId(sig)
  return msg
}

/** Histórico de cada rede, guardado localmente em JSON. */
export class ChatStore {
  private readonly cache = new Map<string, ChatMessage[]>()
  private readonly ids = new Map<string, Set<string>>()
  private readonly saveTimers = new Map<string, NodeJS.Timeout>()

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  private file(network: string): string {
    return join(this.dir, `${network}.json`)
  }

  list(network: string): ChatMessage[] {
    let list = this.cache.get(network)
    if (!list) {
      list = []
      const file = this.file(network)
      if (existsSync(file)) {
        try {
          const parsed = JSON.parse(readFileSync(file, 'utf8'))
          if (Array.isArray(parsed)) list = parsed
        } catch {
          // histórico corrompido: começa vazio em vez de travar o app
        }
      }
      this.cache.set(network, list)
      this.ids.set(network, new Set(list.map((m) => m.id)))
    }
    return list
  }

  /** Adiciona as mensagens novas, em ordem cronológica. Devolve só as que eram inéditas. */
  add(network: string, msgs: ChatMessage[]): ChatMessage[] {
    const list = this.list(network)
    const ids = this.ids.get(network)!
    const fresh = msgs.filter((m) => !ids.has(m.id))
    if (fresh.length === 0) return []
    for (const m of fresh) {
      ids.add(m.id)
      let i = list.length
      while (i > 0 && list[i - 1].ts > m.ts) i--
      list.splice(i, 0, m)
    }
    if (list.length > MAX_STORED) {
      for (const m of list.splice(0, list.length - MAX_STORED)) ids.delete(m.id)
    }
    this.scheduleSave(network)
    return fresh
  }

  recentIds(network: string): string[] {
    return this.list(network)
      .slice(-SYNC_WINDOW)
      .map((m) => m.id)
  }

  /** Mensagens recentes que o outro lado ainda não tem. */
  missing(network: string, have: Set<string>): ChatMessage[] {
    return this.list(network)
      .slice(-SYNC_WINDOW)
      .filter((m) => !have.has(m.id))
  }

  remove(network: string): void {
    clearTimeout(this.saveTimers.get(network))
    this.saveTimers.delete(network)
    this.cache.delete(network)
    this.ids.delete(network)
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
    const list = this.cache.get(network)
    if (list) writeJsonAtomic(this.file(network), list)
  }
}
