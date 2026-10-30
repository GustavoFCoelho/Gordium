import { execFile } from 'node:child_process'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { app } from 'electron'
import { inSubnet, ipToInt } from '../network/crypto'
import { systemFile } from '../system'
import { openLocalTunnel, type Tunnel, type TunnelHandlers } from './tunnel'

/*
 * Processo auxiliar da VPN. O Gordium roda como usuário comum: rodando como
 * administrador, o Chromium não consegue capturar janelas de outros programas
 * (compartilhar a janela de um jogo falhava). Só este processo, que cria o
 * adaptador de rede, é elevado.
 *
 *   app (usuário comum) ──named pipe── Gordium.exe --vpn-helper (administrador)
 *
 * O app cria o pipe com nome aleatório e abre o auxiliar pelo UAC, passando um
 * token. Os dois lados provam que conhecem o token por desafio e resposta (HMAC
 * sobre números aleatórios), sem o token passar pelo pipe: outro programa não
 * consegue se passar pelo app (criando outra instância do pipe) nem pelo
 * auxiliar. Só depois disso o auxiliar aceita comandos. Pelo pipe passam
 * comandos (JSON) e os pacotes IP do adaptador. Se o pipe cair (app fechado),
 * o auxiliar remove o adaptador e sai.
 */

const FRAME_JSON = 1
const FRAME_PACKET = 2
const HEADER_BYTES = 5
const MAX_FRAME_BYTES = 256 * 1024
/** Com o pipe congestionado o pacote é descartado, como uma placa de rede faria. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024
/** Tempo para a pessoa responder ao UAC e o auxiliar se conectar. */
const HELPER_TIMEOUT_MS = 120_000
const PIPE_RE = /^\\\\\.\\pipe\\gordium-vpn-[0-9a-f]{32}$/
const ADAPTER_RE = /^Gordium(-[A-Za-z0-9_-]{1,32})?$/

type Message =
  /** auxiliar → app: desafio */
  | { t: 'hello'; nonce: string }
  /** app → auxiliar: resposta ao desafio + desafio de volta */
  | { t: 'challenge'; proof: string; nonce: string }
  /** auxiliar → app: resposta */
  | { t: 'auth'; proof: string }
  | { t: 'start'; ip: string; adapterName: string }
  | { t: 'ready' }
  | { t: 'error'; message: string }
  | { t: 'stop' }

/** Frames [tipo u8][tamanho u32][dados] sobre o pipe. */
class Channel {
  onJson: (msg: Message) => void = () => {}
  onPacket: (packet: Buffer) => void = () => {}

  constructor(readonly sock: Socket) {
    sock.on('error', () => {})
    let buf: Buffer = Buffer.alloc(0)
    sock.on('data', (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
      while (buf.length >= HEADER_BYTES) {
        const len = buf.readUInt32BE(1)
        if (len > MAX_FRAME_BYTES) return sock.destroy()
        if (buf.length < HEADER_BYTES + len) break
        const type = buf[0]
        const payload = buf.subarray(HEADER_BYTES, HEADER_BYTES + len)
        buf = buf.subarray(HEADER_BYTES + len)
        if (type === FRAME_PACKET) this.onPacket(payload)
        else if (type === FRAME_JSON) {
          try {
            this.onJson(JSON.parse(payload.toString('utf8')))
          } catch {
            sock.destroy()
          }
        }
      }
    })
  }

  json(msg: Message): void {
    this.write(FRAME_JSON, Buffer.from(JSON.stringify(msg)))
  }

  packet(packet: Buffer): void {
    if (this.sock.writableLength < MAX_BUFFERED_BYTES) this.write(FRAME_PACKET, packet)
  }

  private write(type: number, payload: Buffer): void {
    if (this.sock.destroyed) return
    const header = Buffer.allocUnsafe(HEADER_BYTES)
    header[0] = type
    header.writeUInt32BE(payload.length, 1)
    this.sock.write(Buffer.concat([header, payload]))
  }
}

/** O DLL é escolhido pelo auxiliar, nunca recebido pelo pipe (ele roda como administrador). */
function wintunPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'wintun', 'wintun.dll')
    : join(app.getAppPath(), 'resources', 'wintun', process.arch, 'wintun.dll')
}

const nonce = (): string => randomBytes(32).toString('hex')

/** Prova de que conhece o token, ligada a um desafio e a um papel (app ou auxiliar). */
function proofOf(token: string, role: 'app' | 'helper', challenge: string): string {
  return createHmac('sha256', token).update(`gordium-vpn-pipe/${role}`).update(challenge).digest('hex')
}

function checkProof(token: string, role: 'app' | 'helper', challenge: string, proof: unknown): boolean {
  if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) return false
  return timingSafeEqual(Buffer.from(proofOf(token, role, challenge), 'hex'), Buffer.from(proof, 'hex'))
}

function validIp(ip: unknown): ip is string {
  if (typeof ip !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false
  return ip.split('.').every((o) => Number(o) <= 255) && inSubnet(ipToInt(ip))
}

// --- lado do app (usuário comum) ---------------------------------------------

/** Abre o UAC para rodar o auxiliar; rejeita se a pessoa negar. */
function launchElevated(args: string[]): Promise<void> {
  const quote = (s: string): string => `'${s.replace(/'/g, "''")}'`
  // Start-Process junta os argumentos com espaço: cada um vai entre aspas duplas.
  const argList = args.map((a) => quote(`"${a}"`)).join(',')
  const command = `Start-Process -FilePath ${quote(process.execPath)} -ArgumentList ${argList} -Verb RunAs -WindowStyle Hidden`
  return new Promise((resolve, reject) => {
    const powershell = systemFile('WindowsPowerShell\\v1.0\\powershell.exe')
    execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true }, (err) => {
      if (err) reject(new Error('A permissão de administrador foi negada. A VPN precisa dela para criar o adaptador de rede.'))
      else resolve()
    })
  })
}

function waitForHelper(server: Server, token: string, launched: Promise<void>): Promise<Channel> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('O processo da VPN não respondeu.')), HELPER_TIMEOUT_MS)
    launched.catch((err) => {
      clearTimeout(timer)
      reject(err)
    })
    server.on('connection', (sock) => {
      const ch = new Channel(sock)
      const kick = setTimeout(() => sock.destroy(), 10_000)
      const ours = nonce()
      ch.onJson = (msg) => {
        if (msg.t === 'hello' && typeof msg.nonce === 'string' && /^[0-9a-f]{64}$/.test(msg.nonce)) {
          ch.json({ t: 'challenge', proof: proofOf(token, 'app', msg.nonce), nonce: ours })
        } else if (msg.t === 'auth' && checkProof(token, 'helper', ours, msg.proof)) {
          clearTimeout(kick)
          clearTimeout(timer)
          resolve(ch)
        } else {
          sock.destroy()
        }
      }
    })
  })
}

function startTunnel(ch: Channel, adapterName: string, ip: string, handlers: TunnelHandlers): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    let open = false
    let ended = false
    const end = (error: Error): void => {
      if (ended) return
      ended = true
      if (open) handlers.onClosed(error)
      else reject(error)
      ch.sock.destroy()
    }
    const tunnel: Tunnel = {
      write: (packet) => ch.packet(packet),
      close: () =>
        new Promise<void>((done) => {
          ended = true
          if (ch.sock.destroyed) return done()
          ch.sock.once('close', () => done())
          ch.json({ t: 'stop' })
          setTimeout(() => {
            ch.sock.destroy()
            done()
          }, 5000)
        })
    }
    ch.onPacket = (packet) => {
      if (open) handlers.onPacket(packet)
    }
    ch.onJson = (msg) => {
      if (msg.t === 'ready' && !open) {
        open = true
        resolve(tunnel)
      } else if (msg.t === 'error') {
        end(new Error(msg.message))
      }
    }
    ch.sock.on('close', () => end(new Error('O processo da VPN foi encerrado.')))
    ch.json({ t: 'start', ip, adapterName })
  })
}

/** Abre a VPN pelo processo auxiliar elevado (o Windows mostra o UAC). */
export async function openHelperTunnel(adapterName: string, ip: string, handlers: TunnelHandlers): Promise<Tunnel> {
  const pipe = `\\\\.\\pipe\\gordium-vpn-${randomBytes(16).toString('hex')}`
  const token = randomBytes(32).toString('hex')
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(pipe, () => resolve())
  })
  try {
    // Em desenvolvimento o executável é o electron.exe e o app é a pasta do projeto.
    const args = [...(app.isPackaged ? [] : [app.getAppPath()]), '--vpn-helper', pipe, token]
    const ch = await waitForHelper(server, token, launchElevated(args))
    return await startTunnel(ch, adapterName, ip, handlers)
  } finally {
    server.close() // a conexão aceita continua; só não aceita outras
  }
}

// --- lado do auxiliar (administrador) ------------------------------------------

export function isVpnHelper(argv: string[]): boolean {
  return argv.includes('--vpn-helper')
}

export function runVpnHelper(argv: string[]): void {
  const i = argv.indexOf('--vpn-helper')
  const pipe = argv[i + 1] ?? ''
  const token = argv[i + 2] ?? ''
  app.disableHardwareAcceleration()
  app.setPath('userData', join(app.getPath('temp'), 'gordium-vpn-helper'))
  if (!PIPE_RE.test(pipe) || !/^[0-9a-f]{64}$/.test(token)) return app.exit(1)

  let tunnel: Tunnel | null = null
  let exiting = false
  const exit = async (): Promise<void> => {
    if (exiting) return
    exiting = true
    const t = tunnel
    tunnel = null
    await t?.close().catch(() => {})
    sock.end()
    setTimeout(() => app.exit(0), 300)
  }

  const sock = connect(pipe)
  const ch = new Channel(sock)
  const ours = nonce()
  let trusted = false
  sock.on('connect', () => ch.json({ t: 'hello', nonce: ours }))
  sock.on('close', () => void exit())
  // Nada do que chega é usado antes de o outro lado provar que é o app.
  ch.onPacket = (packet) => {
    if (trusted) tunnel?.write(packet)
  }
  ch.onJson = (msg) => {
    if (!trusted) {
      const ok = msg.t === 'challenge' && checkProof(token, 'app', ours, msg.proof) && typeof msg.nonce === 'string' && /^[0-9a-f]{64}$/.test(msg.nonce)
      if (!ok) return void exit()
      trusted = true
      ch.json({ t: 'auth', proof: proofOf(token, 'helper', msg.nonce) })
      return
    }
    if (msg.t === 'stop') return void exit()
    if (msg.t !== 'start' || tunnel || exiting) return
    if (!validIp(msg.ip) || typeof msg.adapterName !== 'string' || !ADAPTER_RE.test(msg.adapterName)) {
      ch.json({ t: 'error', message: 'Parâmetros inválidos para a VPN.' })
      return void exit()
    }
    openLocalTunnel(
      { dllPath: wintunPath(), adapterName: msg.adapterName, ip: msg.ip },
      {
        onPacket: (packet) => ch.packet(packet),
        onClosed: (err) => {
          ch.json({ t: 'error', message: err.message })
          void exit()
        }
      }
    ).then(
      (t) => {
        tunnel = t
        ch.json({ t: 'ready' })
      },
      (err: Error) => {
        ch.json({ t: 'error', message: err.message })
        void exit()
      }
    )
  }
}
