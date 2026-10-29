// Teste do processo auxiliar da VPN, do jeito que o app usa: este processo roda
// como usuário comum e abre a VPN pelo Gordium --vpn-helper elevado (o Windows
// mostra o UAC). Confere os dois sentidos do túnel passando pelo pipe:
//
//   1. Windows → adaptador → auxiliar → app: um envio UDP para um "peer" 100.88.250.2.
//   2. app → auxiliar → adaptador → Windows → … → app: um ping injetado como se
//      viesse do peer; o Windows responde e a resposta volta pelo mesmo caminho.
//   3. Ao fechar o túnel, o auxiliar sai e o adaptador some.
//
// Roda dentro do Electron (veja scripts/vpn-helper-test.mjs). Uso: npm run test:vpn-helper

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { isVpnHelper, openHelperTunnel, runVpnHelper } from '../src/main/vpn/helper'
import { bindUdp, icmpEchoRequest, ipStr, isEchoReply, isUdpTo } from './packets'

const SELF = '100.88.250.1'
const PEER = '100.88.250.2'
const ADAPTER = 'Gordium-helpertest'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const log = (msg: string): void => appendFileSync(join(__dirname, 'result.log'), msg + '\n')

function adapterExists(): boolean {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-NetAdapter -Name '${ADAPTER}' -ErrorAction SilentlyContinue | Measure-Object).Count`], {
    encoding: 'utf8'
  })
  return out.trim() !== '0'
}

async function main(): Promise<void> {
  const packets: Buffer[] = []
  let closed: Error | null = null
  log('• abrindo a VPN pelo processo auxiliar (aceite o UAC)…')
  const tunnel = await openHelperTunnel(ADAPTER, SELF, {
    onPacket: (p) => packets.push(p),
    onClosed: (err) => (closed = err)
  })
  log(`✓ auxiliar elevado conectado pelo pipe; adaptador ${ADAPTER} com ${SELF}/16`)
  try {
    await sleep(2500)

    const sock = await bindUdp(SELF)
    let outbound: Buffer | undefined
    for (let i = 0; i < 20 && !outbound; i++) {
      sock.send('ola-peer', 40000, PEER)
      await sleep(250)
      outbound = packets.find((p) => isUdpTo(p, PEER))
    }
    sock.close()
    if (!outbound) throw new Error('o UDP para o peer não chegou do auxiliar ao app')
    log(`✓ Windows → adaptador → auxiliar → app: UDP ${ipStr(outbound, 12)} → ${ipStr(outbound, 16)}`)

    let reply: Buffer | undefined
    for (let seq = 1; seq <= 10 && !reply; seq++) {
      tunnel.write(icmpEchoRequest(PEER, SELF, 0xc0de, seq))
      await sleep(300)
      reply = packets.find((p) => isEchoReply(p, PEER, 0xc0de))
    }
    if (!reply) throw new Error('o ping injetado pelo app não foi respondido pelo Windows')
    log(`✓ app → auxiliar → adaptador → Windows → app: ping respondido por ${ipStr(reply, 12)}`)
    if (closed) throw closed
  } finally {
    await tunnel.close()
  }
  await sleep(1500)
  if (adapterExists()) throw new Error('o adaptador continuou existindo depois de fechar o túnel')
  log('✓ túnel fechado: auxiliar encerrado e adaptador removido')
  log('TUDO OK')
}

if (isVpnHelper(process.argv)) {
  runVpnHelper(process.argv)
} else {
  // Nunca fica preso: inclui o tempo para responder ao UAC.
  setTimeout(() => {
    log('✗ o teste passou de 4 minutos')
    app.exit(1)
  }, 240_000)
  app.whenReady().then(() =>
    main()
      .catch((err: Error) => log(`✗ ${err.message}`))
      .finally(() => app.exit(0))
  )
}
