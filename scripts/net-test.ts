// Teste de integração da rede P2P: três identidades se encontram pela DHT pública
// (sem servidor), autenticam, sincronizam o chat, trocam estado de voz, sinalização
// WebRTC e pacotes da VPN; depois testa duas redes ao mesmo tempo e reconexão.
// Precisa de internet. Uso: npm run test:net

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyMessage } from '../src/main/chat'
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
  a.sendChat(net, 'geral', 'mensagem antiga')
  if (b.joinNetwork(invite) !== net) throw new Error('id de rede diferente')

  const online = (c: Core, id: string) => !!c.state().networks[0]?.peers.find((p) => p.id === id && p.online)
  await until('A e B conectados e autenticados', () => online(a, b.selfId) && online(b, a.selfId))
  const pb = a.state().networks[0].peers[0]
  console.log('  peer visto por A:', pb.name, pb.vip, 'rtt', pb.rtt, 'remoto', pb.remote)

  const gotB: string[] = []
  b.on('chat', (_n, msgs) => gotB.push(...msgs.map((m) => m.text)))
  await until('sincronização do histórico', () => b.messages(net).some((m) => m.text === 'mensagem antiga'))
  a.sendChat(net, 'geral', 'olá do A 👋')
  await until('chat ao vivo A→B', () => gotB.includes('olá do A 👋'))

  b.setVoice(net, { channel: 'voz', muted: true, deafened: false, camera: false, screen: true })
  await until('estado de voz B→A (com o canal)', () => {
    const v = a.state().networks[0].peers[0].voice
    return v?.screen === true && v.channel === 'voz'
  })

  // mensagem do #geral sem o campo "channel" (como manda uma versão antiga) continua válida
  const legacy: Record<string, unknown> = { ...a.messages(net)[0] }
  delete legacy.channel
  if (verifyMessage(legacy, net)?.channel !== 'geral') throw new Error('mensagem antiga do #geral recusada')
  console.log('  ok: mensagens do #geral compatíveis com a versão anterior')

  // canais e soundboard: registros assinados que a rede inteira compartilha
  const jogos = a.createChannel(net, 'text', 'Jogos de Hoje')
  await until('canal de texto criado por A aparece em B', () => b.channels(net).some((ch) => ch.id === jogos && ch.name === 'jogos-de-hoje'))
  b.sendChat(net, jogos, 'partida às 21h')
  await until('mensagem do canal novo chega no canal certo', () => a.messages(net).some((m) => m.channel === jogos && m.text === 'partida às 21h'))
  const duelo = b.createChannel(net, 'voice', 'Duelo')
  await until('canal de voz criado por B aparece em A', () => a.channels(net).some((ch) => ch.id === duelo && ch.kind === 'voice'))
  b.renameChannel(net, jogos, 'jogatina')
  await until('renomear canal propaga', () => a.channels(net).find((ch) => ch.id === jogos)?.name === 'jogatina')
  a.deleteChannel(net, duelo)
  await until('excluir canal propaga', () => !b.channels(net).some((ch) => ch.id === duelo))

  const fakeAudio = Buffer.alloc(3000, 1).toString('base64')
  const som = a.addSound(net, { name: 'Buzina', emoji: '📢', duration: 1.2, mime: 'audio/webm', audio: fakeAudio })
  await until('som do soundboard chega em B', () => b.sounds(net).some((x) => x.id === som) && b.soundAudio(net, som)?.audio === fakeAudio)
  let sfx: unknown[] = []
  b.on('sfx', (_n, peer, sound, channel) => (sfx = [peer, sound, channel]))
  a.playSound(net, 'voz', som)
  await until('tocar som avisa B', () => sfx[0] === a.selfId && sfx[1] === som && sfx[2] === 'voz')

  const rec = (a as any).records.get(net, 'channel', jogos)
  ;(b as any).networks.get(net).session.emit('rec', {}, { ...rec, rev: rec.rev + 1, data: { ...rec.data, name: 'hackeado' } })
  await wait(300)
  if (b.channels(net).find((ch) => ch.id === jogos)?.name !== 'jogatina') throw new Error('aceitou registro adulterado')
  console.log('  ok: registro de canal adulterado rejeitado')
  let rejected = false
  try {
    a.addSound(net, { name: 'Grande', emoji: '', duration: 2, mime: 'audio/webm', audio: Buffer.alloc(260_000).toString('base64') })
  } catch {
    rejected = true
  }
  if (!rejected) throw new Error('aceitou som grande demais')
  console.log('  ok: som acima do limite recusado')

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
  await until('C recebe histórico completo', () => c.messages(net).length === 3)
  await until('C recebe canais e sons ao entrar', () =>
    c.channels(net).some((ch) => ch.id === jogos && ch.name === 'jogatina') &&
    !c.channels(net).some((ch) => ch.id === duelo) &&
    c.sounds(net).some((x) => x.id === som)
  )
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
