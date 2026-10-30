import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { VPN_PREFIX, VPN_SUBNET } from '../../shared/types'
import { intToIp, SUBNET_MASK } from '../network/crypto'
import { systemFile } from '../system'
import { TunDevice } from './device'
import { loadWintun } from './wintun'

const run = promisify(execFile)
const PING_RULE = 'Gordium-VPN-Ping'

/** O adaptador virtual visto de fora: pacotes IP entram e saem. */
export interface Tunnel {
  write(packet: Buffer): void
  close(): Promise<void>
}

export interface TunnelHandlers {
  /** Pacote que o Windows mandou pelo adaptador. */
  onPacket(packet: Buffer): void
  /** O túnel caiu sozinho (adaptador removido, processo da VPN encerrado…). */
  onClosed(error: Error): void
}

/** Como o app obtém um túnel: no Gordium, por um processo auxiliar elevado. */
export type TunnelOpener = (ip: string, handlers: TunnelHandlers) => Promise<Tunnel>

export interface LocalTunnelOptions {
  dllPath: string
  adapterName: string
  ip: string
}

/**
 * Cria o adaptador Wintun neste processo, configura IP/MTU e libera o ping.
 * Precisa de administrador: roda no processo auxiliar da VPN (ou no test:vpn).
 */
export async function openLocalTunnel(opts: LocalTunnelOptions, handlers: TunnelHandlers): Promise<Tunnel> {
  if (!existsSync(opts.dllPath)) throw new Error(`wintun.dll não encontrado em ${opts.dllPath}.`)
  const device = new TunDevice(loadWintun(opts.dllPath), opts.adapterName, handlers.onPacket, handlers.onClosed)
  device.open()
  try {
    await device.configure(opts.ip, intToIp(SUBNET_MASK))
    await allowPing()
  } catch (err) {
    await device.close()
    throw err
  }
  return { write: (packet) => device.write(packet), close: () => device.close() }
}

/** Libera ping (ICMP echo) só dentro da faixa da VPN, como o Hamachi faz. */
async function allowPing(): Promise<void> {
  try {
    await run(systemFile('netsh.exe'), ['advfirewall', 'firewall', 'show', 'rule', `name=${PING_RULE}`], { windowsHide: true })
    return
  } catch {
    // regra ainda não existe
  }
  const subnet = `${VPN_SUBNET}/${VPN_PREFIX}`
  await run(
    systemFile('netsh.exe'),
    [
      'advfirewall', 'firewall', 'add', 'rule', `name=${PING_RULE}`, 'dir=in', 'action=allow',
      'protocol=icmpv4:8,any', `localip=${subnet}`, `remoteip=${subnet}`
    ],
    { windowsHide: true }
  ).catch((err) => console.warn('[vpn] não foi possível liberar ping no firewall:', err.message))
}
