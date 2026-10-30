import { createHash, createHmac, randomBytes } from 'node:crypto'
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram'
import { networkInterfaces } from 'node:os'

/*
 * Relay das chamadas pela conexão P2P da rede. Em redes com NAT "simétrico"
 * (CGNAT de operadora, 4G, redes de empresa) o WebRTC não consegue conexão
 * direta e precisaria de um servidor TURN na internet, que o Gordium não tem.
 * Mas a conexão do Hyperswarm entre os membros já existe (é por ela que o chat
 * e a VPN passam). Então cada Gordium roda um servidor TURN mínimo só para o
 * próprio WebRTC, na própria máquina: o endereço de relay de cada pessoa é o IP
 * virtual dela (100.88.x.y, o mesmo da VPN, mas sem precisar ligar a VPN), e
 * o que o WebRTC manda para o relay de alguém segue pela conexão P2P até o
 * Gordium dessa pessoa, que entrega ao WebRTC dela.
 *
 * O servidor não pode ficar em 127.0.0.1: o WebRTC manda de sockets presos ao
 * IP de cada placa de rede, e o Windows só entrega de um IP para ele mesmo
 * (de 192.168.0.5 para 127.0.0.1 dá EADDRNOTAVAIL). Ele escuta em todas as
 * placas, o WebRTC o acha pelo IP da placa com a rota para a internet, e só
 * pacotes vindos de um IP desta máquina são atendidos.
 *
 * Implementa o necessário do TURN (RFC 8656) para o WebRTC do Chromium:
 * Allocate, Refresh, CreatePermission, ChannelBind, Send/Data e ChannelData,
 * com credencial de longo prazo (usuário e senha aleatórios a cada execução).
 */

const MAGIC = 0x2112a442
const REALM = 'gordium'
const DEFAULT_LIFETIME_S = 600
const MAX_LIFETIME_S = 3600
const PERMISSION_S = 300
const CHANNEL_S = 600
/** Portas dos endereços de relay (só existem dentro do Gordium, não no sistema). */
const FIRST_RELAY_PORT = 49152
const MAX_ALLOCATIONS = 64
/** Maior pacote que repassamos (RTP fica abaixo de 1500). */
const MAX_DATA = 4096
const LOCAL_IPS_TTL_MS = 10_000

const METHOD = { binding: 0x001, allocate: 0x003, refresh: 0x004, send: 0x006, data: 0x007, permission: 0x008, channelBind: 0x009 }
const CLASS = { request: 0, indication: 1, success: 2, error: 3 }
const ATTR = {
  username: 0x0006,
  integrity: 0x0008,
  errorCode: 0x0009,
  channelNumber: 0x000c,
  lifetime: 0x000d,
  xorPeer: 0x0012,
  data: 0x0013,
  realm: 0x0014,
  nonce: 0x0015,
  xorRelayed: 0x0016,
  requestedTransport: 0x0019,
  xorMapped: 0x0020,
  software: 0x8022,
  fingerprint: 0x8028
}

// --- STUN ---------------------------------------------------------------------

interface Message {
  method: number
  cls: number
  tid: Buffer
  attrs: Map<number, Buffer>
  raw: Buffer
  /** Onde começa o MESSAGE-INTEGRITY (para conferir), ou -1. */
  integrityAt: number
}

function parseMessage(buf: Buffer): Message | null {
  if (buf.length < 20 || (buf[0] & 0xc0) !== 0 || buf.readUInt32BE(4) !== MAGIC) return null
  const length = buf.readUInt16BE(2)
  if (length % 4 !== 0 || 20 + length > buf.length) return null
  const type = buf.readUInt16BE(0)
  const method = (type & 0x000f) | ((type & 0x00e0) >> 1) | ((type & 0x3e00) >> 2)
  const cls = ((type >> 4) & 1) | ((type >> 7) & 2)
  const attrs = new Map<number, Buffer>()
  let integrityAt = -1
  let at = 20
  while (at + 4 <= 20 + length) {
    const t = buf.readUInt16BE(at)
    const len = buf.readUInt16BE(at + 2)
    if (at + 4 + len > 20 + length) return null
    if (t === ATTR.integrity) integrityAt = at
    // Depois do MESSAGE-INTEGRITY só vale o FINGERPRINT.
    if (integrityAt === -1 || t === ATTR.integrity) {
      // XOR-PEER-ADDRESS pode vir repetido (CreatePermission): guarda todos em sequência.
      const prev = attrs.get(t)
      const value = buf.subarray(at + 4, at + 4 + len)
      attrs.set(t, t === ATTR.xorPeer && prev ? Buffer.concat([prev, value]) : value)
    }
    at += 4 + len + ((4 - (len % 4)) % 4)
  }
  return { method, cls, tid: buf.subarray(8, 20), attrs, raw: buf.subarray(0, 20 + length), integrityAt }
}

class MessageBuilder {
  private readonly parts: Buffer[] = []
  private length = 0

  constructor(
    private readonly method: number,
    private readonly cls: number,
    private readonly tid: Buffer
  ) {}

  attr(type: number, value: Buffer): this {
    const head = Buffer.alloc(4)
    head.writeUInt16BE(type, 0)
    head.writeUInt16BE(value.length, 2)
    const pad = Buffer.alloc((4 - (value.length % 4)) % 4)
    this.parts.push(head, value, pad)
    this.length += 4 + value.length + pad.length
    return this
  }

  private header(length: number): Buffer {
    const h = Buffer.alloc(20)
    const { method: m, cls: c } = this
    h.writeUInt16BE((m & 0x000f) | ((m & 0x0070) << 1) | ((m & 0x0f80) << 2) | ((c & 1) << 4) | ((c & 2) << 7), 0)
    h.writeUInt16BE(length, 2)
    h.writeUInt32BE(MAGIC, 4)
    this.tid.copy(h, 8)
    return h
  }

  /** Mensagem pronta; com `key`, leva MESSAGE-INTEGRITY. Sempre leva FINGERPRINT. */
  build(key?: Buffer): Buffer {
    let body = Buffer.concat(this.parts)
    if (key) {
      // O HMAC cobre o cabeçalho com o tamanho já contando o próprio MESSAGE-INTEGRITY.
      const mac = createHmac('sha1', key).update(this.header(body.length + 24)).update(body).digest()
      const attr = Buffer.alloc(24)
      attr.writeUInt16BE(ATTR.integrity, 0)
      attr.writeUInt16BE(20, 2)
      mac.copy(attr, 4)
      body = Buffer.concat([body, attr])
    }
    const withoutFp = Buffer.concat([this.header(body.length + 8), body])
    const fp = Buffer.alloc(8)
    fp.writeUInt16BE(ATTR.fingerprint, 0)
    fp.writeUInt16BE(4, 2)
    fp.writeUInt32BE((crc32(withoutFp) ^ 0x5354554e) >>> 0, 4)
    return Buffer.concat([withoutFp, fp])
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function encodeXorAddress(ip: string, port: number): Buffer {
  const b = Buffer.alloc(8)
  b[1] = 0x01
  b.writeUInt16BE(port ^ (MAGIC >>> 16), 2)
  b.writeUInt32BE((ipToInt(ip) ^ MAGIC) >>> 0, 4)
  return b
}

/** Endereços (IPv4) de um ou mais XOR-PEER-ADDRESS seguidos. */
function decodeXorAddresses(value: Buffer | undefined): { ip: string; port: number }[] {
  const out: { ip: string; port: number }[] = []
  for (let at = 0; value && at + 8 <= value.length; at += 8) {
    if (value[at + 1] !== 0x01) continue // IPv6: os IPs virtuais são IPv4
    out.push({ port: value.readUInt16BE(at + 2) ^ (MAGIC >>> 16), ip: intToIp((value.readUInt32BE(at + 4) ^ MAGIC) >>> 0) })
  }
  return out
}

/** IP desta máquina na placa com a rota para a internet (um "connect" UDP não manda nada). */
function primaryIp(): Promise<string | null> {
  return new Promise((resolve) => {
    const probe = createSocket('udp4')
    const done = (ip: string | null): void => {
      probe.close()
      resolve(ip)
    }
    probe.on('error', () => done(null))
    probe.connect(53, '1.1.1.1', () => done(probe.address().address))
  })
}

function ipToInt(ip: string): number {
  return ip.split('.').reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0)
}

function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
}

// --- relay ----------------------------------------------------------------------

/** Pacote entre dois Gordiums: porta de relay de destino, porta de relay de origem e o conteúdo. */
export function encodeRelayFrame(dstPort: number, srcPort: number, data: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(4 + data.length)
  frame.writeUInt16BE(dstPort, 0)
  frame.writeUInt16BE(srcPort, 2)
  data.copy(frame, 4)
  return frame
}

type SendFn = (frame: Buffer) => void

interface Allocation {
  client: RemoteInfo
  tid: string
  relayPort: number
  expires: number
  /** IP do outro lado → validade. */
  permissions: Map<string, number>
  /** Canal → "ip:porta" e o contrário. */
  channels: Map<number, { peer: string; expires: number }>
  channelOf: Map<string, number>
}

export interface RelayServer {
  urls: string
  username: string
  credential: string
}

export class TurnRelay {
  private socket: Socket | null = null
  private port = 0
  private readonly username = randomBytes(8).toString('hex')
  private readonly password = randomBytes(16).toString('hex')
  private readonly nonce = randomBytes(12).toString('hex')
  private readonly key = createHash('md5').update(`${this.username}:${REALM}:${this.password}`).digest()
  private readonly allocations = new Map<string, Allocation>()
  private readonly byPort = new Map<number, Allocation>()
  private nextPort = FIRST_RELAY_PORT
  /** IP virtual → conexões (uma por rede em comum) para mandar pacotes à pessoa. */
  private readonly routes = new Map<string, Map<string, SendFn>>()
  private sweep: NodeJS.Timeout | null = null
  private localIps = { list: new Set<string>(), at: 0 }

  constructor(private readonly selfVip: string) {}

  async start(): Promise<void> {
    if (this.socket) return
    const socket = createSocket('udp4')
    socket.on('message', (msg, rinfo) => this.fromClient(msg, rinfo))
    socket.on('error', () => {})
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.bind(0, '0.0.0.0', () => {
        socket.off('error', reject)
        resolve()
      })
    })
    this.socket = socket
    this.port = socket.address().port
    this.sweep = setInterval(() => this.expire(), 30_000)
  }

  stop(): void {
    if (this.sweep) clearInterval(this.sweep)
    this.socket?.close()
    this.socket = null
    this.allocations.clear()
    this.byPort.clear()
  }

  /** O que o WebRTC da interface usa como servidor TURN (null se não subiu ou se não há rede). */
  async server(): Promise<RelayServer | null> {
    const ip = this.socket ? await primaryIp() : null
    if (!ip || !this.socket) return null
    return { urls: `turn:${ip}:${this.port}?transport=udp`, username: this.username, credential: this.password }
  }

  /** Só atende pacotes que vêm desta máquina (o servidor escuta em todas as placas de rede). */
  private isLocal(ip: string): boolean {
    if (Date.now() - this.localIps.at > LOCAL_IPS_TTL_MS) {
      const list = Object.values(networkInterfaces()).flatMap((l) => (l ?? []).filter((i) => i.family === 'IPv4').map((i) => i.address))
      this.localIps = { list: new Set(list), at: Date.now() }
    }
    return this.localIps.list.has(ip)
  }

  addRoute(vip: string, key: string, send: SendFn): void {
    let set = this.routes.get(vip)
    if (!set) this.routes.set(vip, (set = new Map()))
    set.set(key, send)
  }

  removeRoute(vip: string, key: string): void {
    const set = this.routes.get(vip)
    set?.delete(key)
    if (set?.size === 0) this.routes.delete(vip)
  }

  /** Pacote que um membro (de IP virtual `vip`) mandou para um dos nossos endereços de relay. */
  fromPeer(vip: string, frame: Buffer): void {
    if (frame.length < 5 || !this.socket) return
    const alloc = this.byPort.get(frame.readUInt16BE(0))
    if (!alloc || (alloc.permissions.get(vip) ?? 0) < Date.now()) return
    const peer = `${vip}:${frame.readUInt16BE(2)}`
    const data = frame.subarray(4)
    const channel = alloc.channelOf.get(peer)
    if (channel !== undefined) {
      const head = Buffer.alloc(4)
      head.writeUInt16BE(channel, 0)
      head.writeUInt16BE(data.length, 2)
      this.toClient(alloc.client, Buffer.concat([head, data]))
    } else {
      const ind = new MessageBuilder(METHOD.data, CLASS.indication, randomBytes(12))
        .attr(ATTR.xorPeer, encodeXorAddress(vip, frame.readUInt16BE(2)))
        .attr(ATTR.data, data)
      this.toClient(alloc.client, ind.build())
    }
  }

  private toClient(client: RemoteInfo, buf: Buffer): void {
    this.socket?.send(buf, client.port, client.address)
  }

  /** Repassa o que o nosso WebRTC mandou para o relay de outra pessoa. */
  private forward(alloc: Allocation, ip: string, port: number, data: Buffer): void {
    if (data.length > MAX_DATA || (alloc.permissions.get(ip) ?? 0) < Date.now()) return
    const route = this.routes.get(ip)?.values().next().value
    route?.(encodeRelayFrame(port, alloc.relayPort, data))
  }

  private fromClient(buf: Buffer, client: RemoteInfo): void {
    if (!this.isLocal(client.address)) return
    const key = `${client.address}:${client.port}`
    // ChannelData: os 2 primeiros bits são 01.
    if (buf.length >= 4 && (buf[0] & 0xc0) === 0x40) {
      const alloc = this.allocations.get(key)
      const bound = alloc?.channels.get(buf.readUInt16BE(0))
      const length = buf.readUInt16BE(2)
      if (!alloc || !bound || bound.expires < Date.now() || 4 + length > buf.length) return
      const sep = bound.peer.lastIndexOf(':')
      this.forward(alloc, bound.peer.slice(0, sep), Number(bound.peer.slice(sep + 1)), buf.subarray(4, 4 + length))
      return
    }
    const msg = parseMessage(buf)
    if (!msg) return
    const alloc = this.allocations.get(key)

    if (msg.cls === CLASS.indication) {
      if (msg.method !== METHOD.send || !alloc) return
      const [peer] = decodeXorAddresses(msg.attrs.get(ATTR.xorPeer))
      const data = msg.attrs.get(ATTR.data)
      if (peer && data) this.forward(alloc, peer.ip, peer.port, data)
      return
    }
    if (msg.cls !== CLASS.request) return

    if (msg.method === METHOD.binding) {
      this.reply(client, new MessageBuilder(METHOD.binding, CLASS.success, msg.tid).attr(ATTR.xorMapped, encodeXorAddress(client.address, client.port)))
      return
    }
    if (!this.authenticated(msg, client)) return

    switch (msg.method) {
      case METHOD.allocate:
        return this.allocate(msg, client, key, alloc)
      case METHOD.refresh: {
        if (!alloc) return this.error(msg, client, 437, 'Allocation Mismatch')
        const lifetime = this.lifetime(msg)
        if (lifetime === 0) this.release(key, alloc)
        else alloc.expires = Date.now() + lifetime * 1000
        return this.reply(client, new MessageBuilder(msg.method, CLASS.success, msg.tid).attr(ATTR.lifetime, u32(lifetime)), true)
      }
      case METHOD.permission: {
        if (!alloc) return this.error(msg, client, 437, 'Allocation Mismatch')
        const peers = decodeXorAddresses(msg.attrs.get(ATTR.xorPeer))
        if (peers.length === 0) return this.error(msg, client, 400, 'Bad Request')
        for (const p of peers) alloc.permissions.set(p.ip, Date.now() + PERMISSION_S * 1000)
        return this.reply(client, new MessageBuilder(msg.method, CLASS.success, msg.tid), true)
      }
      case METHOD.channelBind: {
        if (!alloc) return this.error(msg, client, 437, 'Allocation Mismatch')
        const number = msg.attrs.get(ATTR.channelNumber)?.readUInt16BE(0) ?? 0
        const [peer] = decodeXorAddresses(msg.attrs.get(ATTR.xorPeer))
        if (!peer || number < 0x4000 || number > 0x7fff) return this.error(msg, client, 400, 'Bad Request')
        const target = `${peer.ip}:${peer.port}`
        const current = alloc.channels.get(number)
        const other = alloc.channelOf.get(target)
        if ((current && current.peer !== target) || (other !== undefined && other !== number)) return this.error(msg, client, 400, 'Bad Request')
        alloc.channels.set(number, { peer: target, expires: Date.now() + CHANNEL_S * 1000 })
        alloc.channelOf.set(target, number)
        alloc.permissions.set(peer.ip, Date.now() + PERMISSION_S * 1000)
        return this.reply(client, new MessageBuilder(msg.method, CLASS.success, msg.tid), true)
      }
      default:
        return this.error(msg, client, 400, 'Bad Request')
    }
  }

  private allocate(msg: Message, client: RemoteInfo, key: string, existing: Allocation | undefined): void {
    const tid = msg.tid.toString('hex')
    if (existing) {
      // Retransmissão do mesmo pedido: responde igual; outro pedido no mesmo endereço é erro.
      if (existing.tid !== tid) return this.error(msg, client, 437, 'Allocation Mismatch')
      return this.allocated(msg, client, existing)
    }
    if (msg.attrs.get(ATTR.requestedTransport)?.[0] !== 17) return this.error(msg, client, 442, 'Unsupported Transport Protocol')
    if (this.allocations.size >= MAX_ALLOCATIONS) return this.error(msg, client, 486, 'Allocation Quota Reached')
    let port = this.nextPort
    while (this.byPort.has(port)) port = port >= 65535 ? FIRST_RELAY_PORT : port + 1
    this.nextPort = port >= 65535 ? FIRST_RELAY_PORT : port + 1
    const alloc: Allocation = {
      client,
      tid,
      relayPort: port,
      expires: Date.now() + this.lifetime(msg) * 1000,
      permissions: new Map(),
      channels: new Map(),
      channelOf: new Map()
    }
    this.allocations.set(key, alloc)
    this.byPort.set(port, alloc)
    this.allocated(msg, client, alloc)
  }

  private allocated(msg: Message, client: RemoteInfo, alloc: Allocation): void {
    const res = new MessageBuilder(METHOD.allocate, CLASS.success, msg.tid)
      .attr(ATTR.xorRelayed, encodeXorAddress(this.selfVip, alloc.relayPort))
      .attr(ATTR.xorMapped, encodeXorAddress(client.address, client.port))
      .attr(ATTR.lifetime, u32(Math.round((alloc.expires - Date.now()) / 1000)))
    this.reply(client, res, true)
  }

  private lifetime(msg: Message): number {
    const requested = msg.attrs.get(ATTR.lifetime)?.readUInt32BE(0)
    if (requested === undefined) return DEFAULT_LIFETIME_S
    return requested === 0 ? 0 : Math.min(Math.max(requested, DEFAULT_LIFETIME_S), MAX_LIFETIME_S)
  }

  private release(key: string, alloc: Allocation): void {
    this.allocations.delete(key)
    this.byPort.delete(alloc.relayPort)
  }

  private expire(): void {
    const now = Date.now()
    for (const [key, alloc] of this.allocations) {
      if (alloc.expires < now) {
        this.release(key, alloc)
        continue
      }
      for (const [ip, until] of alloc.permissions) if (until < now) alloc.permissions.delete(ip)
      for (const [n, ch] of alloc.channels) {
        if (ch.expires < now) {
          alloc.channels.delete(n)
          alloc.channelOf.delete(ch.peer)
        }
      }
    }
  }

  /** Credencial de longo prazo: sem ela (ou errada), responde 401 com o realm e o nonce. */
  private authenticated(msg: Message, client: RemoteInfo): boolean {
    const username = msg.attrs.get(ATTR.username)?.toString('utf8')
    const realm = msg.attrs.get(ATTR.realm)?.toString('utf8')
    const nonce = msg.attrs.get(ATTR.nonce)?.toString('utf8')
    if (msg.integrityAt < 0 || username !== this.username || realm !== REALM) {
      this.challenge(msg, client, 401, 'Unauthorized')
      return false
    }
    if (nonce !== this.nonce) {
      this.challenge(msg, client, 438, 'Stale Nonce')
      return false
    }
    const header = Buffer.from(msg.raw.subarray(0, 20))
    header.writeUInt16BE(msg.integrityAt + 24 - 20, 2)
    const expected = createHmac('sha1', this.key).update(header).update(msg.raw.subarray(20, msg.integrityAt)).digest()
    const got = msg.raw.subarray(msg.integrityAt + 4, msg.integrityAt + 24)
    if (got.length !== 20 || !expected.equals(got)) {
      this.challenge(msg, client, 401, 'Unauthorized')
      return false
    }
    return true
  }

  private challenge(msg: Message, client: RemoteInfo, code: number, reason: string): void {
    const res = new MessageBuilder(msg.method, CLASS.error, msg.tid)
      .attr(ATTR.errorCode, errorCode(code, reason))
      .attr(ATTR.realm, Buffer.from(REALM))
      .attr(ATTR.nonce, Buffer.from(this.nonce))
    this.reply(client, res)
  }

  private error(msg: Message, client: RemoteInfo, code: number, reason: string): void {
    this.reply(client, new MessageBuilder(msg.method, CLASS.error, msg.tid).attr(ATTR.errorCode, errorCode(code, reason)), true)
  }

  private reply(client: RemoteInfo, res: MessageBuilder, signed = false): void {
    res.attr(ATTR.software, Buffer.from('Gordium'))
    this.toClient(client, res.build(signed ? this.key : undefined))
  }
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0, 0)
  return b
}

function errorCode(code: number, reason: string): Buffer {
  const text = Buffer.from(reason)
  const b = Buffer.alloc(4 + text.length)
  b[2] = Math.floor(code / 100)
  b[3] = code % 100
  text.copy(b, 4)
  return b
}
