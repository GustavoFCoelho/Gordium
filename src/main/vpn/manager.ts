import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { VPN_PREFIX, VPN_SUBNET, type VpnStatus } from '../../shared/types'
import { inSubnet, intToIp, ipToInt, SUBNET_BROADCAST, SUBNET_MASK } from '../network/crypto'
import { TunDevice } from './device'
import { isProcessAdmin, loadWintun } from './wintun'

const run = promisify(execFile)
const LIMITED_BROADCAST = 0xffffffff
const PING_RULE = 'Gordium-VPN-Ping'

type SendFn = (packet: Buffer) => boolean

function isBroadcastOrMulticast(dst: number): boolean {
  return dst === SUBNET_BROADCAST || dst === LIMITED_BROADCAST || dst >>> 28 === 0xe
}

export interface VpnOptions {
  dllPath: string
  adapterName: string
  ip: string
  canElevate: boolean
}

/**
 * Liga o adaptador virtual às conexões P2P: cada IP 100.88.x.y pertence a um
 * peer, e os pacotes viajam encapsulados nos datagramas cifrados do Hyperswarm.
 */
export class VpnManager extends EventEmitter<{ changed: [] }> {
  readonly status: VpnStatus
  private device: TunDevice | null = null
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
      isAdmin: isProcessAdmin(),
      canElevate: opts.canElevate,
      error: supported ? null : 'Por enquanto a VPN só funciona no Windows.',
      sentBytes: 0,
      receivedBytes: 0
    }
  }

  snapshot(): VpnStatus {
    if (this.device) {
      // O que o adaptador "lê" saiu deste computador; o que ele "escreve" chegou dos peers.
      this.status.sentBytes = this.device.rxBytes
      this.status.receivedBytes = this.device.txBytes
    }
    return { ...this.status }
  }

  async start(): Promise<void> {
    const s = this.status
    if (s.state === 'on' || s.state === 'starting' || s.state === 'unsupported') return
    if (!s.isAdmin) return this.setError('Para ativar a VPN, o Gordium precisa rodar como administrador.')
    if (!existsSync(this.opts.dllPath)) return this.setError(`wintun.dll não encontrado em ${this.opts.dllPath}. Rode "npm run postinstall".`)

    s.state = 'starting'
    s.error = null
    this.emit('changed')
    try {
      const api = loadWintun(this.opts.dllPath)
      const device = new TunDevice(
        api,
        this.opts.adapterName,
        (packet) => this.fromTun(packet),
        (err) => {
          void this.stop().then(() => this.setError(err.message))
        }
      )
      device.open()
      this.device = device
      await device.configure(this.opts.ip, intToIp(SUBNET_MASK))
      await this.allowPing()
      s.state = 'on'
      s.ip = this.opts.ip
      this.emit('changed')
    } catch (err) {
      await this.device?.close()
      this.device = null
      this.setError((err as Error).message)
    }
  }

  async stop(): Promise<void> {
    const device = this.device
    this.device = null
    if (device) await device.close()
    if (this.status.state !== 'unsupported') {
      this.status.state = 'off'
      this.status.ip = null
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
    if (!this.device || packet.length < 20 || packet[0] >> 4 !== 4) return
    const src = packet.readUInt32BE(12)
    const dst = packet.readUInt32BE(16)
    if (src !== ipToInt(peerIp)) return // anti-spoofing: cada peer só fala pelo próprio IP
    if (dst !== this.selfIp && !isBroadcastOrMulticast(dst)) return
    this.device.write(packet)
  }

  /** Pacote que o Windows mandou pelo adaptador → peer dono do IP de destino. */
  private fromTun(packet: Buffer): void {
    if (packet.length < 20 || packet[0] >> 4 !== 4) return // só IPv4
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

  /** Libera ping (ICMP echo) só dentro da faixa da VPN, como o Hamachi faz. */
  private async allowPing(): Promise<void> {
    try {
      await run('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${PING_RULE}`], { windowsHide: true })
      return
    } catch {
      // regra ainda não existe
    }
    const subnet = `${VPN_SUBNET}/${VPN_PREFIX}`
    await run(
      'netsh',
      [
        'advfirewall', 'firewall', 'add', 'rule', `name=${PING_RULE}`, 'dir=in', 'action=allow',
        'protocol=icmpv4:8,any', `localip=${subnet}`, `remoteip=${subnet}`
      ],
      { windowsHide: true }
    ).catch((err) => console.warn('[vpn] não foi possível liberar ping no firewall:', err.message))
  }

  private setError(message: string): void {
    this.status.state = this.status.state === 'unsupported' ? 'unsupported' : 'error'
    this.status.error = message
    this.status.ip = null
    this.emit('changed')
  }
}
