// Autoteste da VPN (precisa de administrador): liga a VPN do jeito que o app liga
// (VpnManager: adaptador Wintun, IP, MTU, regra de ping no firewall) e confere os
// dois sentidos do túnel com um "peer" simulado, sem precisar de outro computador.
//
//   1. Windows → túnel → rota do peer: um socket UDP manda para 100.88.250.2 e o
//      pacote precisa chegar na rota que o app usaria para enviar ao peer.
//   2. Peer → túnel → Windows → peer: injeta um ping (ICMP echo) como se viesse do
//      peer; o Windows precisa responder, e a resposta voltar pela rota do peer.
//   3. Um pacote com IP de origem forjado precisa ser descartado.
//
// Uso: npm run test:vpn   (num terminal aberto como administrador, com o Gordium fechado)

import { createSocket } from 'node:dgram'
import { join } from 'node:path'
import { VpnManager } from '../src/main/vpn/manager'
import { isProcessAdmin } from '../src/main/vpn/wintun'

const SELF = '100.88.250.1'
const PEER = '100.88.250.2'

const ip = (s: string): Buffer => Buffer.from(s.split('.').map(Number))
const ipStr = (b: Buffer, off: number): string => `${b[off]}.${b[off + 1]}.${b[off + 2]}.${b[off + 3]}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function checksum(buf: Buffer): number {
  let sum = 0
  for (let i = 0; i < buf.length; i += 2) sum += (buf[i] << 8) | (buf[i + 1] ?? 0)
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16)
  return ~sum & 0xffff
}

function icmpEchoRequest(src: string, dst: string, id: number, seq: number): Buffer {
  const payload = Buffer.from('gordium-selftest')
  const icmp = Buffer.alloc(8 + payload.length)
  icmp[0] = 8 // echo request
  icmp.writeUInt16BE(id, 4)
  icmp.writeUInt16BE(seq, 6)
  payload.copy(icmp, 8)
  icmp.writeUInt16BE(checksum(icmp), 2)

  const hdr = Buffer.alloc(20)
  hdr[0] = 0x45
  hdr.writeUInt16BE(20 + icmp.length, 2)
  hdr.writeUInt16BE(0x1234, 4)
  hdr[8] = 64 // TTL
  hdr[9] = 1 // ICMP
  ip(src).copy(hdr, 12)
  ip(dst).copy(hdr, 16)
  hdr.writeUInt16BE(checksum(hdr), 10)
  return Buffer.concat([hdr, icmp])
}

const isEchoReply = (p: Buffer, id: number): boolean =>
  p[0] >> 4 === 4 && p[9] === 1 && p[20] === 0 && ipStr(p, 16) === PEER && p.readUInt16BE(24) === id

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('A VPN do Gordium só funciona no Windows.')
  if (!isProcessAdmin()) throw new Error('Rode este teste num terminal aberto como administrador.')

  const dllPath = join(process.cwd(), 'resources', 'wintun', process.arch, 'wintun.dll')
  const vpn = new VpnManager({ dllPath, adapterName: 'Gordium-selftest', ip: SELF, canElevate: false })
  // O "peer" simulado: tudo que o app mandaria para ele cai aqui.
  const packets: Buffer[] = []
  vpn.addRoute(PEER, 'selftest', (p) => {
    packets.push(p)
    return true
  })

  console.log('• ligando a VPN…')
  await vpn.start()
  if (vpn.status.state !== 'on') throw new Error(`a VPN não ligou: ${vpn.status.error}`)
  console.log(`✓ adaptador criado e IP ${SELF}/16 configurado`)
  try {
    await sleep(2500) // o Windows precisa de um instante para ativar o endereço

    // 1) Windows → túnel → peer
    const sock = createSocket('udp4')
    await new Promise<void>((r) => sock.bind(0, SELF, () => r()))
    let outbound: Buffer | undefined
    for (let i = 0; i < 20 && !outbound; i++) {
      sock.send('ola-peer', 40000, PEER)
      await sleep(250)
      outbound = packets.find((p) => p[0] >> 4 === 4 && p[9] === 17 && ipStr(p, 16) === PEER)
    }
    sock.close()
    if (!outbound) throw new Error('o pacote UDP para o peer não passou pelo adaptador')
    console.log(`✓ Windows → túnel → peer: UDP ${ipStr(outbound, 12)} → ${ipStr(outbound, 16)} (${outbound.length} bytes)`)

    // 2) peer → túnel → Windows → peer
    let reply: Buffer | undefined
    for (let seq = 1; seq <= 10 && !reply; seq++) {
      vpn.fromPeer(PEER, icmpEchoRequest(PEER, SELF, 0xc0c0, seq))
      await sleep(300)
      reply = packets.find((p) => isEchoReply(p, 0xc0c0))
    }
    if (!reply) {
      throw new Error(
        'o Windows não respondeu ao ping injetado. Se o passo anterior passou, o firewall pode estar ' +
          'bloqueando ICMP: confira a regra "Gordium-VPN-Ping" no Firewall do Windows.'
      )
    }
    console.log(`✓ peer → túnel → Windows → peer: ping de ${PEER} respondido por ${ipStr(reply, 12)}`)

    // 3) anti-spoofing: o pacote diz vir de PEER, mas chega pela conexão de outro peer
    vpn.fromPeer('100.88.250.3', icmpEchoRequest(PEER, SELF, 0x0bad, 1))
    await sleep(800)
    if (packets.some((p) => isEchoReply(p, 0x0bad))) throw new Error('pacote com IP de origem forjado foi aceito')
    console.log('✓ pacote com IP de origem forjado descartado')

    const s = vpn.snapshot()
    console.log(`\nTudo certo. Enviado ${s.sentBytes} bytes · recebido ${s.receivedBytes} bytes pelo túnel.`)
  } finally {
    await vpn.stop()
    console.log('• VPN desligada, adaptador removido')
  }
}

main().catch((err) => {
  console.error('✗', (err as Error).message)
  process.exit(1)
})
