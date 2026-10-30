import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import * as hcrypto from 'hypercore-crypto'
import {
  DEFAULT_TEXT_CHANNEL,
  DEFAULT_VOICE_CHANNEL,
  type AppState,
  type ChannelInfo,
  type ChannelKind,
  type ChatMessage,
  type NetworkInfo,
  type NewSound,
  type PeerInfo,
  type RtcSignal,
  type SoundInfo,
  type VoiceState
} from '../shared/types'
import { ChatStore, createMessage, verifyMessage } from './chat'
import { cleanName, decodeInvite, encodeInvite, networkId, newNetworkKey, virtualIp, type NetworkSecret } from './network/crypto'
import { cleanVoice, NetworkSession, type Peer } from './network/session'
import {
  cleanChannelName,
  isRecordId,
  MAX_SOUNDS,
  RecordStore,
  signRecord,
  verifyRecord,
  type ChannelData,
  type NetRecord,
  type SoundData
} from './records'
import { readJson, writeJsonAtomic } from './storage'
import { TurnRelay, type RelayServer } from './turn'
import { VpnManager } from './vpn/manager'
import type { TunnelOpener } from './vpn/tunnel'

interface Settings {
  /** Liga a VPN ao abrir o app (a pessoa a ligou da última vez). */
  vpnAutoStart: boolean
}

interface StoredIdentity {
  seed: string
  name: string
}

interface Member {
  name: string
  lastSeen: number
  /** Quando esta identidade apareceu pela primeira vez (decide de quem é o IP virtual). */
  firstSeen?: number
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
  /** Alguém tocou um som do soundboard num canal de voz. */
  sfx: [network: string, peer: string, sound: string, channel: string]
}

/** Canais que toda rede tem; um registro com o mesmo id só os renomeia. */
const BUILTIN_CHANNELS: ChannelInfo[] = [
  { id: DEFAULT_TEXT_CHANNEL, kind: 'text', name: 'geral', createdAt: 0, builtin: true },
  { id: DEFAULT_VOICE_CHANNEL, kind: 'voice', name: 'Sala de voz', createdAt: 0, builtin: true }
]

export class Core extends EventEmitter<CoreEvents> {
  readonly selfId: string
  readonly vip: string
  readonly vpn: VpnManager
  /** Relay das chamadas pela conexão P2P, para quando o WebRTC não conecta direto. */
  private readonly relay: TurnRelay

  private readonly identity: StoredIdentity
  private readonly keyPair: { publicKey: Buffer; secretKey: Buffer }
  private readonly networks = new Map<string, NetworkEntry>()
  private readonly chat: ChatStore
  private readonly records: RecordStore
  private readonly vipCache = new Map<string, string>()
  private voice: { network: string; state: VoiceState } | null = null
  private saveTimer: NodeJS.Timeout | null = null
  private readonly settings: Settings

  constructor(
    private readonly dataDir: string,
    openTunnel: TunnelOpener
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
    this.records = new RecordStore(join(dataDir, 'records'))
    this.settings = { vpnAutoStart: false, ...readJson<Partial<Settings>>(this.file('settings.json'), {}) }
    this.vpn = new VpnManager({ ip: this.vip, open: openTunnel })
    this.vpn.on('changed', () => this.emit('changed'))
    this.relay = new TurnRelay(this.vip)
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
    if (this.settings.vpnAutoStart) void this.startVpn(true)
    this.relay.start().catch((err) => console.warn('[relay] não subiu:', (err as Error).message))
  }

  /** Servidor TURN local para o WebRTC da interface (null se não subiu). */
  relayServer(): Promise<RelayServer | null> {
    return this.relay.server()
  }

  /**
   * Liga a VPN (o Windows pede permissão de administrador para o processo da VPN).
   * Se ligou, ela volta a ligar sozinha ao abrir o app. Se falhar ao abrir o app
   * (por exemplo, UAC negado), para de tentar até a pessoa ligar de novo.
   */
  async startVpn(automatic = false): Promise<void> {
    await this.vpn.start()
    const on = this.vpn.status.state === 'on'
    if (on || automatic) this.saveSettings({ vpnAutoStart: on })
  }

  async stopVpn(): Promise<void> {
    this.saveSettings({ vpnAutoStart: false })
    await this.vpn.stop()
    this.relay.stop()
  }

  private saveSettings(patch: Partial<Settings>): void {
    Object.assign(this.settings, patch)
    writeJsonAtomic(this.file('settings.json'), this.settings)
  }

  async shutdown(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.save()
    this.chat.flush()
    this.records.flush()
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
        vip: live?.vip ?? this.vipOf(id),
        online: !!live,
        lastSeen: live ? Date.now() : member.lastSeen,
        rtt: live && typeof raw?.rtt === 'number' ? raw.rtt : null,
        remote: live && raw?.remoteHost ? `${raw.remoteHost}:${raw.remotePort}` : null,
        voice: live?.voice ?? null,
        vipConflict: this.vipConflict(id)
      })
    }
    return {
      id: e.session.id,
      name: e.secret.name,
      invite: encodeInvite(e.secret),
      joinedAt: e.joinedAt,
      discovering: e.session.discovering,
      peers,
      channels: this.channels(e.session.id),
      sounds: this.sounds(e.session.id)
    }
  }

  channels(network: string): ChannelInfo[] {
    const list = BUILTIN_CHANNELS.map((c) => ({ ...c }))
    for (const r of this.records.all(network)) {
      if (r.kind !== 'channel') continue
      const builtin = list.find((c) => c.id === r.id && c.builtin)
      const data = r.data as ChannelData | null
      if (builtin) {
        if (data) builtin.name = data.name // canal padrão renomeado
      } else if (data) {
        list.push({ id: r.id, kind: data.kind, name: data.name, createdAt: data.createdAt, builtin: false })
      }
    }
    return list.sort((a, b) => a.createdAt - b.createdAt)
  }

  sounds(network: string): SoundInfo[] {
    const list: SoundInfo[] = []
    for (const r of this.records.all(network)) {
      const d = r.data as SoundData | null
      if (r.kind === 'sound' && d) {
        list.push({ id: r.id, name: d.name, emoji: d.emoji, duration: d.duration, author: r.author, createdAt: d.createdAt })
      }
    }
    return list.sort((a, b) => a.createdAt - b.createdAt)
  }

  soundAudio(network: string, id: string): { mime: string; audio: string } | null {
    const d = this.records.get(network, 'sound', id)?.data as SoundData | null | undefined
    return d ? { mime: d.mime, audio: d.audio } : null
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
    for (const peer of entry.session.connectedPeers()) {
      this.vpn.removeRoute(peer.vip, this.routeKey(id, peer))
      this.relay.removeRoute(peer.vip, this.routeKey(id, peer))
    }
    this.networks.delete(id)
    await entry.session.stop()
    this.chat.remove(id)
    this.records.remove(id)
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

  sendChat(network: string, channel: string, text: string): ChatMessage | null {
    const entry = this.networks.get(network)
    const body = typeof text === 'string' ? text.trim() : ''
    if (!entry || !body) return null
    const target = this.channels(network).find((c) => c.id === channel && c.kind === 'text')
    if (!target) throw new Error('Esse canal não existe mais.')
    const msg = createMessage(network, target.id, this.keyPair, this.identity.name, body)
    this.chat.add(network, [msg])
    entry.session.broadcast({ t: 'chat', msg })
    this.emit('chat', network, [msg])
    return msg
  }

  // --- canais e soundboard -------------------------------------------------------

  createChannel(network: string, kind: ChannelKind, name: string): string {
    if (kind !== 'text' && kind !== 'voice') throw new Error('Tipo de canal inválido.')
    const clean = cleanChannelName(kind, name)
    if (!clean) throw new Error('Dê um nome ao canal.')
    const id = randomBytes(8).toString('hex')
    this.publish(network, { kind: 'channel', id, rev: Date.now(), data: { kind, name: clean, createdAt: Date.now() } })
    return id
  }

  renameChannel(network: string, id: string, name: string): void {
    const current = this.channels(network).find((c) => c.id === id)
    if (!current) throw new Error('Esse canal não existe mais.')
    const clean = cleanChannelName(current.kind, name)
    if (!clean) throw new Error('Dê um nome ao canal.')
    this.publish(network, { kind: 'channel', id, rev: this.nextRev(network, 'channel', id), data: { kind: current.kind, name: clean, createdAt: current.createdAt } })
  }

  deleteChannel(network: string, id: string): void {
    if (id === DEFAULT_TEXT_CHANNEL || id === DEFAULT_VOICE_CHANNEL) throw new Error('Os canais padrão não podem ser excluídos.')
    if (!isRecordId(id)) return
    this.publish(network, { kind: 'channel', id, rev: this.nextRev(network, 'channel', id), data: null })
  }

  addSound(network: string, sound: NewSound): string {
    if (this.sounds(network).length >= MAX_SOUNDS) throw new Error(`O soundboard já tem o máximo de ${MAX_SOUNDS} sons.`)
    const id = randomBytes(8).toString('hex')
    const name = cleanName(sound?.name).slice(0, 24)
    if (!name) throw new Error('Dê um nome ao som.')
    const data: SoundData = {
      name,
      emoji: typeof sound.emoji === 'string' ? sound.emoji.trim().slice(0, 16) : '',
      duration: Number(sound.duration),
      mime: String(sound.mime),
      audio: String(sound.audio),
      createdAt: Date.now()
    }
    // Mesma validação aplicada ao que chega dos outros: o que sai daqui também tem que passar.
    const rec = signRecord(network, { kind: 'sound', id, rev: Date.now(), data }, this.keyPair)
    if (!verifyRecord(rec, network)) throw new Error('Som inválido: precisa ter até 6 s e no máximo ~200 KB.')
    this.publishSigned(network, rec)
    return id
  }

  deleteSound(network: string, id: string): void {
    if (!isRecordId(id)) return
    this.publish(network, { kind: 'sound', id, rev: this.nextRev(network, 'sound', id), data: null })
  }

  /** Avisa quem está no canal de voz para tocar o som (cada um toca a sua cópia). */
  playSound(network: string, channel: string, id: string): void {
    const entry = this.networks.get(network)
    if (!entry || !this.soundAudio(network, id) || !isRecordId(channel)) return
    entry.session.broadcast({ t: 'sfx', id, channel })
  }

  private nextRev(network: string, kind: NetRecord['kind'], id: string): number {
    return Math.max(Date.now(), (this.records.get(network, kind, id)?.rev ?? 0) + 1)
  }

  private publish(network: string, record: Omit<NetRecord, 'sig' | 'author'>): void {
    this.publishSigned(network, signRecord(network, record, this.keyPair))
  }

  private publishSigned(network: string, rec: NetRecord): void {
    const entry = this.networks.get(network)
    if (!entry) throw new Error('Rede não encontrada.')
    if (!this.records.apply(network, rec)) throw new Error('A rede atingiu o limite de canais ou sons.')
    entry.session.broadcast({ t: 'rec', rec })
    this.emit('changed')
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
      if (this.vipConflict(peer.id)) console.warn(`[vpn] ${peer.name}: IP virtual ${peer.vip} em conflito, sem rota`)
      else {
        this.vpn.addRoute(peer.vip, this.routeKey(net, peer), (packet) => session.sendPacket(peer.id, packet))
        this.relay.addRoute(peer.vip, this.routeKey(net, peer), (frame) => session.sendRelay(peer.id, frame))
      }
      session.send(peer.id, { t: 'sync-req', have: this.chat.recentIds(net) })
      session.send(peer.id, { t: 'rec-sum', items: this.records.summary(net) })
      this.emit('changed')
    })
    session.on('peer-down', (peer) => {
      this.remember(entry, peer)
      this.vpn.removeRoute(peer.vip, this.routeKey(net, peer))
      this.relay.removeRoute(peer.vip, this.routeKey(net, peer))
      this.emit('changed')
    })
    session.on('peer-update', (peer) => {
      this.remember(entry, peer)
      this.emit('changed')
    })
    session.on('changed', () => this.emit('changed'))
    session.on('packet', (peer, packet) => {
      if (!this.vipConflict(peer.id)) this.vpn.fromPeer(peer.vip, packet)
    })
    session.on('relay', (peer, frame) => {
      if (!this.vipConflict(peer.id)) this.relay.fromPeer(peer.vip, frame)
    })

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

    // Registros (canais, sons): ao conectar cada lado manda o resumo; o outro
    // responde com o que for mais novo. Um registro por frame (sons são grandes).
    session.on('rec-sum', (peer, items) => {
      if (!Array.isArray(items)) return
      const theirs = new Map<string, number>()
      for (const it of items) {
        if (Array.isArray(it) && typeof it[0] === 'string' && typeof it[1] === 'number') theirs.set(it[0], it[1])
      }
      for (const rec of this.records.newerThan(net, theirs)) session.send(peer.id, { t: 'rec', rec })
    })
    session.on('rec', (_peer, raw) => {
      const rec = verifyRecord(raw, net)
      if (rec && this.records.apply(net, rec)) this.emit('changed')
    })
    session.on('sfx', (peer, id, channel) => {
      if (isRecordId(id) && isRecordId(channel) && this.soundAudio(net, id)) this.emit('sfx', net, peer.id, id, channel)
    })
  }

  private receive(network: string, raws: unknown[]): void {
    const valid = raws.map((r) => verifyMessage(r, network)).filter((m): m is ChatMessage => m !== null)
    const fresh = this.chat.add(network, valid)
    if (fresh.length > 0) this.emit('chat', network, fresh)
  }

  /** IP virtual de uma identidade (fixo; guardado porque a checagem roda a cada pacote). */
  private vipOf(id: string): string {
    let vip = this.vipCache.get(id)
    if (!vip) this.vipCache.set(id, (vip = virtualIp(Buffer.from(id, 'hex'))))
    return vip
  }

  private firstSeenAnywhere(id: string): number | undefined {
    let first: number | undefined
    for (const e of this.networks.values()) {
      const m = e.members.get(id)
      // Membros gravados antes desta regra existir contam como os mais antigos.
      if (m) first = Math.min(first ?? Infinity, m.firstSeen ?? 0)
    }
    return first
  }

  /**
   * O IP virtual vem de um hash da chave, num espaço de 65 mil endereços: dá
   * para gerar em menos de 1 s uma chave com o IP de outra pessoa. O IP fica
   * com a identidade vista primeiro; quem aparece depois com o mesmo IP fica
   * sem VPN conosco (empate: ninguém usa). O nosso próprio IP nunca é de outro.
   */
  vipConflict(id: string): boolean {
    const vip = this.vipOf(id)
    if (vip === this.vip) return true
    const mine = this.firstSeenAnywhere(id) ?? Infinity
    for (const e of this.networks.values()) {
      for (const [other, m] of e.members) {
        if (other !== id && (m.firstSeen ?? 0) <= mine && this.vipOf(other) === vip) return true
      }
    }
    return false
  }

  private remember(entry: NetworkEntry, peer: Peer): void {
    const firstSeen = entry.members.get(peer.id)?.firstSeen ?? this.firstSeenAnywhere(peer.id) ?? Date.now()
    entry.members.set(peer.id, { name: peer.name, lastSeen: Date.now(), firstSeen, transport: peer.transport.toString('hex') })
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
