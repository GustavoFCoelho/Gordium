// Teste de integração da rede P2P: três identidades se encontram pela DHT pública
// (sem servidor), autenticam, sincronizam o chat, trocam estado de voz, sinalização
// WebRTC e pacotes da VPN; depois testa duas redes ao mesmo tempo e reconexão.
// Precisa de internet. Uso: npm run test:net

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Core } from '../src/main/core'

const dirs: string[] = []
// O teste de rede não liga a VPN (isso é o test:vpn, como administrador).
const noVpn = async (): Promise<never> => {
  throw new Error('VPN desativada no teste')
}
function mkCore(label: string): Core {
  const dir = mkdtempSync(join(tmpdir(), `gordium-${label}-`))
  dirs.push(dir)
  const c = new Core(dir, noVpn)
  c.init()
  return c
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(label: string, fn: () => boolean, ms = 60000) {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`)
    await wait(200)
  }
  console.log(`  ok: ${label} (${Date.now() - t0} ms)`)
}

async function main() {
  const a = mkCore('a'), b = mkCore('b')
  a.setName('Alice'); b.setName('Bruno')
  console.log('A', a.vip, a.selfId.slice(0, 8), '| B', b.vip, b.selfId.slice(0, 8))
  console.log('VPN (desativada neste teste):', a.state().vpn.state)

  const net = a.createNetwork('Rede de Teste')
  const invite = a.state().networks[0].invite
  console.log('convite:', invite)
  // histórico antes de B entrar, para testar a sincronização
  a.sendChat(net, 'mensagem antiga')
  if (b.joinNetwork(invite) !== net) throw new Error('id de rede diferente')

  const online = (c: Core, id: string) => !!c.state().networks[0]?.peers.find((p) => p.id === id && p.online)
  await until('A e B conectados e autenticados', () => online(a, b.selfId) && online(b, a.selfId))
  const pb = a.state().networks[0].peers[0]
  console.log('  peer visto por A:', pb.name, pb.vip, 'rtt', pb.rtt, 'remoto', pb.remote)

  const gotB: string[] = []
  b.on('chat', (_n, msgs) => gotB.push(...msgs.map((m) => m.text)))
  await until('sincronização do histórico', () => b.messages(net).some((m) => m.text === 'mensagem antiga'))
  a.sendChat(net, 'olá do A 👋')
  await until('chat ao vivo A→B', () => gotB.includes('olá do A 👋'))

  b.setVoice(net, { muted: true, deafened: false, camera: false, screen: true })
  await until('estado de voz B→A', () => a.state().networks[0].peers[0].voice?.screen === true)

  let sig: unknown = null
  b.on('rtc', (_n, peer, s) => { if (peer === a.selfId) sig = s })
  a.sendRtc(net, b.selfId, { cid: 'teste', description: { type: 'offer', sdp: 'v=0' } })
  await until('sinalização WebRTC A→B', () => (sig as any)?.cid === 'teste')

  // datagrama da VPN: pacote IPv4 cru pelo canal não confiável
  const sb = (b as any).networks.get(net).session
  const sa = (a as any).networks.get(net).session
  const pkts: Buffer[] = []
  sb.on('packet', (_p: unknown, pkt: Buffer) => pkts.push(pkt))
  const fake = Buffer.alloc(1100, 7); fake[0] = 0x45
  for (let i = 0; i < 20; i++) sa.sendPacket(b.selfId, fake)
  const big = Buffer.alloc(1500, 9); big[0] = 0x45
  sa.sendPacket(b.selfId, big)
  await until('pacotes da VPN chegando (datagrama + fallback)', () => pkts.some((p) => p.length === 1100) && pkts.some((p) => p.length === 1500))
  console.log(`  ${pkts.filter((p) => p.length === 1100).length}/20 datagramas de 1100 bytes`)
  console.log('  mtu udx:', sa.getPeer(b.selfId).conn.rawStream?.mtu)

  // forjar mensagem: assinatura inválida deve ser descartada
  const forged = { ...a.messages(net)[0], text: 'adulterada' }
  ;(b as any).receive(net, [forged])
  if (b.messages(net).some((m) => m.text === 'adulterada')) throw new Error('aceitou mensagem forjada!')
  console.log('  ok: mensagem com assinatura inválida rejeitada')

  // terceiro membro entra depois e recebe tudo
  const c = mkCore('c'); c.setName('Carla')
  c.joinNetwork(invite)
  await until('C recebe histórico completo', () => c.messages(net).length === 2)
  b.setName('Bruno Renomeado')
  await until('renomear propaga', () => a.state().networks[0].peers.some((p) => p.name === 'Bruno Renomeado'))

  // A participa de uma segunda rede, só com C: as duas precisam funcionar juntas
  const net2 = a.createNetwork('Segunda rede')
  const invite2 = a.state().networks.find((n) => n.id === net2)!.invite
  c.joinNetwork(invite2)
  const online2 = (x: Core, id: string) => !!x.state().networks.find((n) => n.id === net2)?.peers.find((p) => p.id === id && p.online)
  await until('A e C conectados na segunda rede', () => online2(a, c.selfId) && online2(c, a.selfId))
  if (!online(a, b.selfId)) throw new Error('A perdeu B na primeira rede')
  const vipC1 = a.state().networks[0].peers.find((p) => p.id === c.selfId)!.vip
  const vipC2 = a.state().networks.find((n) => n.id === net2)!.peers[0].vip
  if (vipC1 !== vipC2) throw new Error('IP virtual mudou entre redes')
  console.log('  ok: mesma identidade e IP virtual de C nas duas redes:', vipC1)

  // B reinicia: deve reconectar direto pela chave conhecida
  const dirB = dirs[1]
  await b.shutdown()
  await until('A percebe B offline', () => !online(a, b.selfId), 30000)
  const b2 = new Core(dirB, noVpn)
  b2.init()
  await until('B reconecta após reiniciar', () => online(a, b2.selfId) && online(b2, a.selfId), 90000)

  await Promise.all([a.shutdown(), b2.shutdown(), c.shutdown()])
  console.log('TUDO OK')
}

main()
  .catch((e) => { console.error('FALHOU:', e); process.exitCode = 1 })
  .finally(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); setTimeout(() => process.exit(), 500) })
