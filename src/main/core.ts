import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import * as hcrypto from 'hypercore-crypto'
import type { AppState, ChatMessage, NetworkInfo, PeerInfo, RtcSignal, VoiceState } from '../shared/types'
import { ChatStore, createMessage, verifyMessage } from './chat'
import { cleanName, decodeInvite, encodeInvite, networkId, newNetworkKey, virtualIp, type NetworkSecret } from './network/crypto'
import { NetworkSession, type Peer } from './network/session'
import { readJson, writeJsonAtomic } from './storage'
import { VpnManager, type VpnOptions } from './vpn/manager'

interface StoredIdentity {
  seed: string
  name: string
}

interface Member {
  name: string
  lastSeen: number
  /** Chave de transporte do membro nesta rede (hex), para reconectar direto. */
  transport?: string
}

interface StoredNetwork {
  key: string
  name: string
  joinedAt: number
  members: Record<string, Member>
}

interface NetworkEntry {
  secret: NetworkSecret
  session: NetworkSession
  joinedAt: number
  members: Map<string, Member>
}

export interface CoreEvents {
  changed: []
  chat: [network: string, messages: ChatMessage[]]
  rtc: [network: string, peer: string, signal: RtcSignal]
}

function cleanVoice(v: unknown): VoiceState | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  return { muted: !!o.muted, deafened: !!o.deafened, camera: !!o.camera, screen: !!o.screen }
}

export class Core extends EventEmitter<CoreEvents> {
  readonly selfId: string
  readonly vip: string
  readonly vpn: VpnManager

  private readonly identity: StoredIdentity
  private readonly keyPair: { publicKey: Buffer; secretKey: Buffer }
  private readonly networks = new Map<string, NetworkEntry>()
  private readonly chat: ChatStore
  private voice: { network: string; state: VoiceState } | null = null
  private saveTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly dataDir: string,
    vpn: Omit<VpnOptions, 'ip'>
  ) {
    super()
    mkdirSync(dataDir, { recursive: true })

    const stored = readJson<StoredIdentity | null>(this.file('identity.json'), null)
    if (stored && /^[0-9a-f]{64}$/.test(stored.seed)) {
      this.identity = stored
    } else {
      this.identity = { seed: randomBytes(32).toString('hex'), name: cleanName(userInfo().username) || 'Usuário' }
      writeJsonAtomic(this.file('identity.json'), this.identity)
    }
    this.keyPair = hcrypto.keyPair(Buffer.from(this.identity.seed, 'hex'))
    this.selfId = this.keyPair.publicKey.toString('hex')
    this.vip = virtualIp(this.keyPair.publicKey)

    this.chat = new ChatStore(join(dataDir, 'chat'))
    this.vpn = new VpnManager({ ...vpn, ip: this.vip })
    this.vpn.on('changed', () => this.emit('changed'))
  }

  private file(name: string): string {
    return join(this.dataDir, name)
  }

  init(): void {
    for (const n of readJson<StoredNetwork[]>(this.file('networks.json'), [])) {
      try {
        this.open({ key: Buffer.from(n.key, 'hex'), name: n.name }, n.joinedAt, n.members)
      } catch (err) {
        console.warn('[core] rede inválida ignorada:', (err as Error).message)
      }
    }
    void this.vpn.start()
  }

  async shutdown(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.save()
    this.chat.flush()
    await Promise.allSettled([...this.networks.values()].map((e) => e.session.stop()))
    await this.vpn.stop()
  }

  // --- estado para a interface ---------------------------------------------

  state(): AppState {
    return {
      self: { id: this.selfId, name: this.identity.name, vip: this.vip },
      networks: [...this.networks.values()].map((e) => this.networkInfo(e)),
      vpn: this.vpn.snapshot()
    }
  }

  private networkInfo(e: NetworkEntry): NetworkInfo {
    const peers: PeerInfo[] = []
    for (const [id, member] of e.members) {
      if (id === this.selfId) continue
      const live = e.session.getPeer(id)
      const raw = live?.conn.rawStream
      peers.push({
        id,
        name: live?.name || member.name,
        vip: live?.vip ?? virtualIp(Buffer.from(id, 'hex')),
        online: !!live,
        lastSeen: live ? Date.now() : member.lastSeen,
        rtt: live && typeof raw?.rtt === 'number' ? raw.rtt : null,
        remote: live && raw?.remoteHost ? `${raw.remoteHost}:${raw.remotePort}` : null,
        voice: live?.voice ?? null
      })
    }
    return {
      id: e.session.id,
      name: e.secret.name,
      invite: encodeInvite(e.secret),
      joinedAt: e.joinedAt,
      discovering: e.session.discovering,
      peers
    }
  }

  messages(network: string): ChatMessage[] {
    return this.networks.has(network) ? this.chat.list(network) : []
  }

  // --- ações da interface ----------------------------------------------------

  createNetwork(name: string): string {
    const secret = { key: newNetworkKey(), name: cleanName(name) || 'Minha rede' }
    const entry = this.open(secret, Date.now(), {})
    this.save()
    this.emit('changed')
    return entry.session.id
  }

  joinNetwork(invite: string): string {
    const secret = decodeInvite(invite)
    const id = networkId(secret.key)
    if (!this.networks.has(id)) {
      this.open(secret, Date.now(), {})
      this.save()
      this.emit('changed')
    }
    return id
  }

  async leaveNetwork(id: string): Promise<void> {
    const entry = this.networks.get(id)
    if (!entry) return
    if (this.voice?.network === id) this.voice = null
    for (const peer of entry.session.connectedPeers()) this.vpn.removeRoute(peer.vip, this.routeKey(id, peer))
    this.networks.delete(id)
    await entry.session.stop()
    this.chat.remove(id)
    this.save()
    this.emit('changed')
  }

  setName(name: string): void {
    const clean = cleanName(name)
    if (!clean || clean === this.identity.name) return
    this.identity.name = clean
    writeJsonAtomic(this.file('identity.json'), this.identity)
    for (const e of this.networks.values()) e.session.broadcast({ t: 'profile', name: clean })
    this.emit('changed')
  }

  setVoice(network: string, state: unknown): void {
    const next = cleanVoice(state)
    const prev = this.voice
    if (prev && prev.network !== network) {
      this.networks.get(prev.network)?.session.broadcast({ t: 'voice', voice: null })
    }
    this.voice = next && this.networks.has(network) ? { network, state: next } : null
    this.networks.get(network)?.session.broadcast({ t: 'voice', voice: this.voice?.state ?? null })
    this.emit('changed')
  }

  sendChat(network: string, text: string): ChatMessage | null {
    const entry = this.networks.get(network)
    const body = typeof text === 'string' ? text.trim() : ''
    if (!entry || !body) return null
    const msg = createMessage(network, this.keyPair, this.identity.name, body)
    this.chat.add(network, [msg])
    entry.session.broadcast({ t: 'chat', msg })
    this.emit('chat', network, [msg])
    return msg
  }

  sendRtc(network: string, peer: string, signal: RtcSignal): void {
    this.networks.get(network)?.session.send(peer, { t: 'rtc', data: signal })
  }

  // --- internos ----------------------------------------------------------------

  private routeKey(network: string, peer: Peer): string {
    return `${network}:${peer.id}`
  }

  private open(secret: NetworkSecret, joinedAt: number, members: Record<string, Member>): NetworkEntry {
    if (secret.key.length !== 32) throw new Error('chave de rede inválida')
    const id = networkId(secret.key)
    const existing = this.networks.get(id)
    if (existing) return existing

    const session = new NetworkSession(secret, this.keyPair, this.transportKeyPair(secret.key), () => ({
      name: this.identity.name,
      voice: this.voice?.network === id ? this.voice.state : null
    }))
    const entry: NetworkEntry = { secret, session, joinedAt, members: new Map(Object.entries(members ?? {})) }
    this.networks.set(id, entry)
    this.wire(entry)
    const known: Buffer[] = []
    for (const m of entry.members.values()) {
      if (m.transport && /^[0-9a-f]{64}$/.test(m.transport)) known.push(Buffer.from(m.transport, 'hex'))
    }
    session.start(known)
    return entry
  }

  /** Chave de transporte própria de cada rede, derivada da identidade (estável entre execuções). */
  private transportKeyPair(networkKey: Buffer): { publicKey: Buffer; secretKey: Buffer } {
    const seed = createHash('sha256')
      .update('gordium/transport/v1')
      .update(Buffer.from(this.identity.seed, 'hex'))
      .update(networkKey)
      .digest()
    return hcrypto.keyPair(seed)
  }

  private wire(entry: NetworkEntry): void {
    const { session } = entry
    const net = session.id

    session.on('peer-up', (peer) => {
      this.remember(entry, peer)
      session.rememberPeer(peer.transport)
      this.vpn.addRoute(peer.vip, this.routeKey(net, peer), (packet) => session.sendPacket(peer.id, packet))
      session.send(peer.id, { t: 'sync-req', have: this.chat.recentIds(net) })
      this.emit('changed')
    })
    session.on('peer-down', (peer) => {
      this.remember(entry, peer)
      this.vpn.removeRoute(peer.vip, this.routeKey(net, peer))
      this.emit('changed')
    })
    session.on('peer-update', (peer) => {
      this.remember(entry, peer)
      this.emit('changed')
    })
    session.on('changed', () => this.emit('changed'))
    session.on('packet', (peer, packet) => this.vpn.fromPeer(peer.vip, packet))

    session.on('chat', (_peer, raw) => this.receive(net, [raw]))
    session.on('sync-res', (_peer, raw) => {
      if (Array.isArray(raw)) this.receive(net, raw)
    })
    session.on('sync-req', (peer, have) => {
      if (!Array.isArray(have)) return
      const missing = this.chat.missing(net, new Set(have.filter((x): x is string => typeof x === 'string')))
      for (let i = 0; i < missing.length; i += 100) {
        session.send(peer.id, { t: 'sync-res', msgs: missing.slice(i, i + 100) })
      }
    })
    session.on('rtc', (peer, data) => {
      if (data && typeof data === 'object' && typeof (data as RtcSignal).cid === 'string') {
        this.emit('rtc', net, peer.id, data as RtcSignal)
      }
    })
  }

  private receive(network: string, raws: unknown[]): void {
    const valid = raws.map((r) => verifyMessage(r, network)).filter((m): m is ChatMessage => m !== null)
    const fresh = this.chat.add(network, valid)
    if (fresh.length > 0) this.emit('chat', network, fresh)
  }

  private remember(entry: NetworkEntry, peer: Peer): void {
    entry.members.set(peer.id, { name: peer.name, lastSeen: Date.now(), transport: peer.transport.toString('hex') })
    this.scheduleSave()
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.save()
    }, 1000)
  }

  private save(): void {
    const list: StoredNetwork[] = [...this.networks.values()].map((e) => ({
      key: e.secret.key.toString('hex'),
      name: e.secret.name,
      joinedAt: e.joinedAt,
      members: Object.fromEntries(e.members)
    }))
    writeJsonAtomic(this.file('networks.json'), list)
  }
}
