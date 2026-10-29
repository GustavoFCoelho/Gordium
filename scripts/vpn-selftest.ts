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
// Uso: npm run test:vpn   (num terminal aberto como administrador)

import { join } from 'node:path'
import { VpnManager } from '../src/main/vpn/manager'
import { openLocalTunnel } from '../src/main/vpn/tunnel'
import { isProcessAdmin } from '../src/main/vpn/wintun'
import { bindUdp, icmpEchoRequest, ipStr, isEchoReply, isUdpTo } from './packets'

const SELF = '100.88.250.1'
const PEER = '100.88.250.2'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('A VPN do Gordium só funciona no Windows.')
  if (!isProcessAdmin()) throw new Error('Rode este teste num terminal aberto como administrador.')

  const dllPath = join(process.cwd(), 'resources', 'wintun', process.arch, 'wintun.dll')
  // Mesmo roteamento do app, mas com o adaptador aberto neste processo (que já é administrador).
  const vpn = new VpnManager({
    ip: SELF,
    open: (ip, handlers) => openLocalTunnel({ dllPath, adapterName: 'Gordium-selftest', ip }, handlers)
  })
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
    const sock = await bindUdp(SELF)
    let outbound: Buffer | undefined
    for (let i = 0; i < 20 && !outbound; i++) {
      sock.send('ola-peer', 40000, PEER)
      await sleep(250)
      outbound = packets.find((p) => isUdpTo(p, PEER))
    }
    sock.close()
    if (!outbound) throw new Error('o pacote UDP para o peer não passou pelo adaptador')
    console.log(`✓ Windows → túnel → peer: UDP ${ipStr(outbound, 12)} → ${ipStr(outbound, 16)} (${outbound.length} bytes)`)

    // 2) peer → túnel → Windows → peer
    let reply: Buffer | undefined
    for (let seq = 1; seq <= 10 && !reply; seq++) {
      vpn.fromPeer(PEER, icmpEchoRequest(PEER, SELF, 0xc0c0, seq))
      await sleep(300)
      reply = packets.find((p) => isEchoReply(p, PEER, 0xc0c0))
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
    if (packets.some((p) => isEchoReply(p, PEER, 0x0bad))) throw new Error('pacote com IP de origem forjado foi aceito')
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
