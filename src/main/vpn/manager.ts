import { EventEmitter } from 'node:events'
import type { VpnStatus } from '../../shared/types'
import { inSubnet, ipToInt, SUBNET_BROADCAST } from '../network/crypto'
import type { Tunnel, TunnelOpener } from './tunnel'

const LIMITED_BROADCAST = 0xffffffff

type SendFn = (packet: Buffer) => boolean

function isBroadcastOrMulticast(dst: number): boolean {
  return dst === SUBNET_BROADCAST || dst === LIMITED_BROADCAST || dst >>> 28 === 0xe
}

export interface VpnOptions {
  ip: string
  open: TunnelOpener
}

/**
 * Liga o adaptador virtual às conexões P2P: cada IP 100.88.x.y pertence a um
 * peer, e os pacotes viajam encapsulados nos datagramas cifrados do Hyperswarm.
 */
export class VpnManager extends EventEmitter<{ changed: [] }> {
  readonly status: VpnStatus
  private tunnel: Tunnel | null = null
  private readonly selfIp: number
  /** IP virtual → rotas. O mesmo peer pode estar em mais de uma rede em comum. */
  private readonly routes = new Map<number, Map<string, SendFn>>()

  constructor(private readonly opts: VpnOptions) {
    super()
    this.selfIp = ipToInt(opts.ip)
    const supported = process.platform === 'win32'
    this.status = {
      state: supported ? 'off' : 'unsupported',
      ip: null,
      error: supported ? null : 'Por enquanto a VPN só funciona no Windows.',
      sentBytes: 0,
      receivedBytes: 0
    }
  }

  snapshot(): VpnStatus {
    return { ...this.status }
  }

  async start(): Promise<void> {
    const s = this.status
    if (s.state === 'on' || s.state === 'starting' || s.state === 'unsupported') return
    s.state = 'starting'
    s.error = null
    this.emit('changed')
    try {
      const tunnel = await this.opts.open(this.opts.ip, {
        onPacket: (packet) => this.fromTun(packet),
        onClosed: (err) => {
          if (this.tunnel !== tunnel) return
          this.tunnel = null
          this.setError(err.message)
        }
      })
      this.tunnel = tunnel
      s.state = 'on'
      s.ip = this.opts.ip
      this.emit('changed')
    } catch (err) {
      this.setError((err as Error).message)
    }
  }

  async stop(): Promise<void> {
    const tunnel = this.tunnel
    this.tunnel = null
    if (tunnel) await tunnel.close()
    if (this.status.state !== 'unsupported') {
      this.status.state = 'off'
      this.status.ip = null
      this.status.error = null
    }
    this.emit('changed')
  }

  addRoute(ip: string, key: string, send: SendFn): void {
    const n = ipToInt(ip)
    let set = this.routes.get(n)
    if (!set) this.routes.set(n, (set = new Map()))
    set.set(key, send)
  }

  removeRoute(ip: string, key: string): void {
    const n = ipToInt(ip)
    const set = this.routes.get(n)
    if (!set) return
    set.delete(key)
    if (set.size === 0) this.routes.delete(n)
  }

  /** Pacote que um peer mandou → entrega ao Windows, se for mesmo dele e para nós. */
  fromPeer(peerIp: string, packet: Buffer): void {
    if (!this.tunnel || packet.length < 20 || packet[0] >> 4 !== 4) return
    const src = packet.readUInt32BE(12)
    const dst = packet.readUInt32BE(16)
    if (src !== ipToInt(peerIp)) return // anti-spoofing: cada peer só fala pelo próprio IP
    if (dst !== this.selfIp && !isBroadcastOrMulticast(dst)) return
    this.tunnel.write(packet)
    this.status.receivedBytes += packet.length
  }

  /** Pacote que o Windows mandou pelo adaptador → peer dono do IP de destino. */
  private fromTun(packet: Buffer): void {
    if (packet.length < 20 || packet[0] >> 4 !== 4) return // só IPv4
    this.status.sentBytes += packet.length
    const dst = packet.readUInt32BE(16)
    if (isBroadcastOrMulticast(dst)) {
      // Broadcast/multicast vai para todos: é assim que jogos em LAN se descobrem.
      for (const set of this.routes.values()) {
        for (const send of set.values()) if (send(packet)) break
      }
      return
    }
    if (!inSubnet(dst)) return
    const set = this.routes.get(dst)
    if (!set) return
    for (const send of set.values()) if (send(packet)) break
  }

  private setError(message: string): void {
    this.status.state = this.status.state === 'unsupported' ? 'unsupported' : 'error'
    this.status.error = message
    this.status.ip = null
    this.emit('changed')
  }
}
