import { EventEmitter } from 'node:events'
import * as hcrypto from 'hypercore-crypto'
import Hyperswarm, { type KeyPair, type PeerDiscovery, type SwarmConnection } from 'hyperswarm'
import { DEFAULT_VOICE_CHANNEL, type ChatMessage, type RtcSignal, type VoiceState } from '../../shared/types'
import { isRecordId, type NetRecord } from '../records'
import { authProof, checkProof, cleanName, networkId, networkTopic, virtualIp, type NetworkSecret } from './crypto'

const PROTOCOL_VERSION = 1
/**
 * O Hyperswarm só refaz a busca na DHT a cada 10 min. Se dois membros entram
 * ao mesmo tempo, a busca embutida no anúncio de cada um não acha o outro.
 * Reanúncios extras (que também buscam), contados a partir do fim do anterior.
 */
const LOOKUP_SCHEDULE_MS = [4_000, 10_000, 20_000, 40_000]
const LOOKUP_INTERVAL_MS = 5 * 60_000
/**
 * Quem acha o nosso endereço na DHT consegue abrir conexões mesmo sem a chave da
 * rede; elas só ocupam vaga até a autenticação. Pouco tempo e poucas ao mesmo tempo.
 */
const AUTH_TIMEOUT_MS = 8_000
const MAX_PENDING_AUTH = 8
const MAX_FRAME_BYTES = 512 * 1024

/** Primeiro byte de um pacote IP encapsulado (datagrama ou frame binário). */
const PACKET_IPV4 = 0x04
/** Cabeçalho UDX (20) + envelope do secret-stream (24) + margem. */
const DATAGRAM_OVERHEAD = 64
/** Pacote do relay das chamadas (ver turn.ts) e pedaço de um que não coube num datagrama. */
const PACKET_RELAY = 0x05
const PACKET_RELAY_PART = 0x06
const MAX_RELAY_PARTS = 4
/** Pacotes em pedaços esperando o resto, por conexão (os incompletos vão saindo). */
const MAX_PENDING_RELAY = 32

export type Frame =
  | { t: 'hello'; v: number; proof: string; id: string; isig: string; name: string; voice: VoiceState | null }
  | { t: 'profile'; name: string }
  | { t: 'voice'; voice: VoiceState | null }
  | { t: 'chat'; msg: ChatMessage }
  | { t: 'sync-req'; have: string[] }
  | { t: 'sync-res'; msgs: ChatMessage[] }
  | { t: 'rtc'; data: RtcSignal }
  /** Resumo dos registros (canais/sons) que tenho: [chave, revisão]. */
  | { t: 'rec-sum'; items: [string, number][] }
  | { t: 'rec'; rec: NetRecord }
  /** Tocar um som do soundboard no canal de voz. */
  | { t: 'sfx'; id: string; channel: string }

export interface Peer {
  /** Chave de identidade (hex): a mesma em todas as redes. */
  id: string
  /** Chave de transporte desta rede (a usada pelo Hyperswarm). */
  transport: Buffer
  vip: string
  name: string
  voice: VoiceState | null
  conn: SwarmConnection
  authed: boolean
  /** Libera a vaga de conexão pendente de autenticação. */
  settle?: () => void
  /** Pedaços de pacotes do relay chegando: id → partes. */
  relayParts?: Map<number, { parts: (Buffer | undefined)[]; got: number }>
}

export interface LocalProfile {
  name: string
  voice: VoiceState | null
}

export interface SessionEvents {
  'peer-up': [Peer]
  'peer-down': [Peer]
  'peer-update': [Peer]
  chat: [Peer, unknown]
  'sync-req': [Peer, unknown]
  'sync-res': [Peer, unknown]
  rtc: [Peer, unknown]
  'rec-sum': [Peer, unknown]
  rec: [Peer, unknown]
  sfx: [Peer, unknown, unknown]
  packet: [Peer, Buffer]
  relay: [Peer, Buffer]
  changed: []
}

/** O que a assinatura de identidade cobre: esta conexão e esta chave de transporte. */
function identityBinding(handshakeHash: Buffer, transport: Buffer): Buffer {
  return Buffer.concat([Buffer.from('gordium/identity/v1'), handshakeHash, transport])
}

/** Estado de voz vindo de fora (peer ou interface). Versões antigas não mandam canal: é a Sala de voz. */
export function cleanVoice(v: unknown): VoiceState | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  return {
    channel: isRecordId(o.channel) ? o.channel : DEFAULT_VOICE_CHANNEL,
    muted: !!o.muted,
    deafened: !!o.deafened,
    camera: !!o.camera,
    screen: !!o.screen
  }
}

/**
 * Uma rede do Gordium: um swarm Hyperswarm no tópico derivado da chave.
 * Os peers se acham pela DHT pública e fazem hole punching entre si; não há
 * servidor do Gordium no caminho. Toda conexão é cifrada (Noise) e só é aceita
 * depois que o outro lado prova conhecer a chave da rede e assina o handshake
 * com a sua chave de identidade.
 *
 * Cada rede usa uma chave de transporte própria: se todas usassem a mesma, os
 * swarms de redes diferentes do mesmo usuário disputariam o mesmo endereço na DHT.
 */
export class NetworkSession extends EventEmitter<SessionEvents> {
  readonly id: string
  readonly name: string
  readonly key: Buffer
  discovering = true

  private swarm: Hyperswarm | null = null
  private discovery: PeerDiscovery | null = null
  private lookupTimer: NodeJS.Timeout | null = null
  private lookups = 0
  private readonly peers = new Map<string, Peer>()
  private pendingAuth = 0
  private relayId = 0

  constructor(
    secret: NetworkSecret,
    private readonly identity: KeyPair,
    private readonly transport: KeyPair,
    private readonly local: () => LocalProfile
  ) {
    super()
    this.key = secret.key
    this.name = secret.name
    this.id = networkId(secret.key)
  }

  /** @param known chaves de transporte de membros já vistos, para reconectar direto. */
  start(known: Buffer[] = []): void {
    const swarm = new Hyperswarm({ keyPair: this.transport })
    this.swarm = swarm
    swarm.on('connection', (conn) => this.onConnection(conn))
    const discovery = swarm.join(networkTopic(this.key), { server: true, client: true })
    this.discovery = discovery
    discovery
      .flushed()
      .then(() => {
        this.discovering = false
        this.emit('changed')
        this.scheduleLookup()
      })
      .catch(() => {})
    for (const t of known) this.rememberPeer(t)
  }

  /** Mantém uma conexão direta (pela chave) com um membro conhecido, com retentativas. */
  rememberPeer(transport: Buffer): void {
    if (this.swarm && transport.length === 32 && !transport.equals(this.transport.publicKey)) {
      this.swarm.joinPeer(transport)
    }
  }

  private scheduleLookup(): void {
    const delay = LOOKUP_SCHEDULE_MS[this.lookups++] ?? LOOKUP_INTERVAL_MS
    this.lookupTimer = setTimeout(async () => {
      if (!this.discovery) return
      // Sem opções: mantém cliente+servidor (reanuncia e busca). Passar server:false
      // faria o Hyperswarm remover o anúncio da DHT.
      await this.discovery.refresh().catch(() => {})
      if (this.discovery) this.scheduleLookup()
    }, delay)
  }

  async stop(): Promise<void> {
    const swarm = this.swarm
    this.swarm = null
    this.discovery = null
    if (this.lookupTimer) clearTimeout(this.lookupTimer)
    for (const p of this.peers.values()) p.conn.destroy()
    this.peers.clear()
    if (swarm) await swarm.destroy().catch(() => {})
  }

  connectedPeers(): Peer[] {
    return [...this.peers.values()]
  }

  getPeer(id: string): Peer | undefined {
    return this.peers.get(id)
  }

  send(peerId: string, frame: Frame): void {
    const p = this.peers.get(peerId)
    if (p) this.write(p.conn, frame)
  }

  broadcast(frame: Frame): void {
    const data = Buffer.from(JSON.stringify(frame))
    for (const p of this.peers.values()) p.conn.write(data)
  }

  /** Envia um pacote IP da VPN: datagrama não confiável quando cabe, stream quando não. */
  sendPacket(peerId: string, packet: Buffer): boolean {
    const p = this.peers.get(peerId)
    if (!p) return false
    const buf = Buffer.allocUnsafe(packet.length + 1)
    buf[0] = PACKET_IPV4
    packet.copy(buf, 1)
    const mtu = p.conn.rawStream?.mtu ?? 1200
    if (buf.length <= mtu - DATAGRAM_OVERHEAD) p.conn.trySend(buf)
    else p.conn.write(buf)
    return true
  }

  /**
   * Pacote do relay das chamadas: sempre datagrama (áudio e vídeo em tempo real
   * não esperam retransmissão). Se não couber em um, vai em até 4 pedaços.
   */
  sendRelay(peerId: string, frame: Buffer): void {
    const p = this.peers.get(peerId)
    if (!p) return
    const room = (p.conn.rawStream?.mtu ?? 1200) - DATAGRAM_OVERHEAD
    if (frame.length + 1 <= room) {
      p.conn.trySend(Buffer.concat([Buffer.of(PACKET_RELAY), frame]))
      return
    }
    const chunk = room - 5
    const count = Math.ceil(frame.length / chunk)
    if (count > MAX_RELAY_PARTS) return
    const id = (this.relayId = (this.relayId + 1) & 0xffff)
    for (let i = 0; i < count; i++) {
      const head = Buffer.of(PACKET_RELAY_PART, id >> 8, id & 0xff, i, count)
      p.conn.trySend(Buffer.concat([head, frame.subarray(i * chunk, (i + 1) * chunk)]))
    }
  }

  /** Junta os pedaços de um pacote do relay; se algum se perder, o pacote se perde (como no UDP). */
  private relayPart(peer: Peer, data: Buffer): void {
    if (data.length < 6) return
    const id = data.readUInt16BE(1)
    const index = data[3]
    const count = data[4]
    if (count < 2 || count > MAX_RELAY_PARTS || index >= count) return
    const pending = (peer.relayParts ??= new Map())
    let entry = pending.get(id)
    if (!entry || entry.parts.length !== count) {
      if (pending.size >= MAX_PENDING_RELAY) pending.delete(pending.keys().next().value!)
      entry = { parts: new Array<Buffer | undefined>(count), got: 0 }
      pending.set(id, entry)
    }
    if (entry.parts[index]) return
    entry.parts[index] = Buffer.from(data.subarray(5))
    if (++entry.got < count) return
    pending.delete(id)
    this.emit('relay', peer, Buffer.concat(entry.parts as Buffer[]))
  }

  private write(conn: SwarmConnection, frame: Frame): void {
    conn.write(Buffer.from(JSON.stringify(frame)))
  }

  private onConnection(conn: SwarmConnection): void {
    if (this.pendingAuth >= MAX_PENDING_AUTH) {
      conn.on('error', () => {})
      conn.destroy()
      return
    }
    this.pendingAuth++
    let pending = true
    const settle = (): void => {
      if (pending) this.pendingAuth--
      pending = false
    }
    const peer: Peer = {
      id: '',
      transport: conn.remotePublicKey,
      vip: '',
      name: '',
      voice: null,
      conn,
      authed: false
    }
    const timer = setTimeout(() => {
      if (!peer.authed) conn.destroy()
    }, AUTH_TIMEOUT_MS)
    peer.settle = settle

    conn.on('error', () => {})
    conn.on('data', (data: Buffer) => this.onData(peer, data))
    conn.on('message', (data: Buffer) => {
      if (!peer.authed || data.length < 2) return
      if (data[0] === PACKET_IPV4) this.emit('packet', peer, data.subarray(1))
      else if (data[0] === PACKET_RELAY) this.emit('relay', peer, data.subarray(1))
      else if (data[0] === PACKET_RELAY_PART) this.relayPart(peer, data)
    })
    conn.on('close', () => {
      clearTimeout(timer)
      settle()
      if (peer.authed && this.peers.get(peer.id) === peer) {
        this.peers.delete(peer.id)
        this.emit('peer-down', peer)
      }
    })

    const me = this.local()
    this.write(conn, {
      t: 'hello',
      v: PROTOCOL_VERSION,
      proof: authProof(this.key, conn.handshakeHash, this.transport.publicKey).toString('hex'),
      id: this.identity.publicKey.toString('hex'),
      isig: hcrypto
        .sign(identityBinding(conn.handshakeHash, this.transport.publicKey), this.identity.secretKey)
        .toString('hex'),
      name: me.name,
      voice: me.voice
    })
  }

  /** Confere a assinatura de identidade e preenche id/IP virtual do peer. */
  private checkIdentity(peer: Peer, hello: { id?: unknown; isig?: unknown }): boolean {
    if (typeof hello.id !== 'string' || !/^[0-9a-f]{64}$/.test(hello.id)) return false
    if (typeof hello.isig !== 'string' || !/^[0-9a-f]{128}$/.test(hello.isig)) return false
    const idKey = Buffer.from(hello.id, 'hex')
    if (idKey.equals(this.identity.publicKey)) return false // nós mesmos, por outro caminho
    const sig = Buffer.from(hello.isig, 'hex')
    if (!hcrypto.verify(identityBinding(peer.conn.handshakeHash, peer.transport), sig, idKey)) return false
    peer.id = hello.id
    peer.vip = virtualIp(idKey)
    return true
  }

  private onData(peer: Peer, data: Buffer): void {
    if (data.length === 0) return // keep-alive
    if (data[0] === PACKET_IPV4) {
      if (peer.authed && data.length > 1) this.emit('packet', peer, data.subarray(1))
      return
    }
    if (data.length > MAX_FRAME_BYTES) return peer.conn.destroy()

    let frame: Frame
    try {
      frame = JSON.parse(data.toString('utf8'))
    } catch {
      return
    }
    if (!frame || typeof frame !== 'object') return

    if (!peer.authed) {
      if (frame.t !== 'hello') return
      const expected = authProof(this.key, peer.conn.handshakeHash, peer.transport)
      if (!checkProof(expected, frame.proof) || !this.checkIdentity(peer, frame)) {
        peer.conn.destroy()
        return
      }
      peer.authed = true
      peer.settle?.()
      peer.name = cleanName(frame.name) || 'Sem nome'
      peer.voice = cleanVoice(frame.voice)
      const previous = this.peers.get(peer.id)
      this.peers.set(peer.id, peer)
      // Conexão nova para o mesmo peer (reconexão): a antiga sai de cena.
      if (previous && previous !== peer) previous.conn.destroy()
      this.emit('peer-up', peer)
      return
    }

    switch (frame.t) {
      case 'profile':
        peer.name = cleanName(frame.name) || peer.name
        this.emit('peer-update', peer)
        break
      case 'voice':
        peer.voice = cleanVoice(frame.voice)
        this.emit('peer-update', peer)
        break
      case 'chat':
        this.emit('chat', peer, frame.msg)
        break
      case 'sync-req':
        this.emit('sync-req', peer, frame.have)
        break
      case 'sync-res':
        this.emit('sync-res', peer, frame.msgs)
        break
      case 'rtc':
        this.emit('rtc', peer, frame.data)
        break
      case 'rec-sum':
        this.emit('rec-sum', peer, frame.items)
        break
      case 'rec':
        this.emit('rec', peer, frame.rec)
        break
      case 'sfx':
        this.emit('sfx', peer, frame.id, frame.channel)
        break
    }
  }
}
