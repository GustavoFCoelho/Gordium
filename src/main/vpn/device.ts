import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { systemFile } from '../system'
import { ERROR_HANDLE_EOF, type Guid, type WintunApi } from './wintun'

const run = promisify(execFile)

/** Capacidade do anel de pacotes do Wintun (potência de 2 entre 128 KiB e 64 MiB). */
const RING_CAPACITY = 0x400000
/** Pacotes drenados por rodada antes de devolver o controle ao event loop. */
const DRAIN_BATCH = 256
/** MTU do adaptador: pacote + overhead UDX/criptografia precisa caber em 1200 bytes. */
export const TUN_MTU = 1100

/** GUID estável por nome de adaptador: o Windows reaproveita o mesmo perfil de rede. */
function stableGuid(name: string): Guid {
  const h = createHash('sha256').update(`gordium/adapter/${name}`).digest()
  return {
    Data1: h.readUInt32LE(0),
    Data2: h.readUInt16LE(4),
    Data3: (h.readUInt16LE(6) & 0x0fff) | 0x4000,
    Data4: [...h.subarray(8, 16)]
  }
}

/** Adaptador de rede virtual (Wintun): pacotes IP entram e saem como Buffers. */
export class TunDevice {
  rxBytes = 0
  txBytes = 0
  ifIndex: number | null = null

  private adapter: bigint | null = null
  private session: bigint | null = null
  private readEvent: bigint | null = null
  private running = false
  private loop: Promise<void> | null = null

  constructor(
    private readonly api: WintunApi,
    readonly name: string,
    private readonly onPacket: (packet: Buffer) => void,
    private readonly onFatal: (err: Error) => void
  ) {}

  open(): void {
    const { api } = this
    this.adapter = api.createAdapter(this.name, 'Gordium', stableGuid(this.name))
    if (!this.adapter) throw new Error(`Não foi possível criar o adaptador virtual (erro ${api.lastError()}).`)

    const luid: [bigint | number] = [0]
    api.getAdapterLuid(this.adapter, luid)
    this.ifIndex = api.luidToIndex(luid[0])

    this.session = api.startSession(this.adapter, RING_CAPACITY)
    if (!this.session) {
      const code = api.lastError()
      this.close()
      throw new Error(`Não foi possível iniciar a sessão do adaptador (erro ${code}).`)
    }
    this.readEvent = api.readWaitEvent(this.session)
    this.running = true
    this.loop = this.readLoop()
  }

  /** Define IP/máscara/MTU via netsh. O nome do adaptador também serve de fallback. */
  async configure(ip: string, mask: string): Promise<void> {
    const iface = this.ifIndex !== null ? String(this.ifIndex) : this.name
    let lastErr: unknown
    // O Windows às vezes demora alguns instantes para expor a interface recém-criada.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await run(systemFile('netsh.exe'), ['interface', 'ipv4', 'set', 'address', `name=${iface}`, 'source=static', `address=${ip}`, `mask=${mask}`, 'gateway=none'], {
          windowsHide: true
        })
        await run(systemFile('netsh.exe'), ['interface', 'ipv4', 'set', 'subinterface', iface, `mtu=${TUN_MTU}`, 'store=active'], { windowsHide: true })
        return
      } catch (err) {
        lastErr = err
        await new Promise((r) => setTimeout(r, 300))
      }
    }
    throw new Error(`Falha ao configurar o IP do adaptador: ${(lastErr as Error)?.message ?? lastErr}`)
  }

  write(packet: Buffer): void {
    if (!this.session) return
    const p = this.api.allocateSendPacket(this.session, packet.length)
    if (!p) return // anel cheio: descarta, como uma placa de rede faria
    this.api.copy(p, packet, packet.length)
    this.api.sendPacket(this.session, p)
    this.txBytes += packet.length
  }

  async close(): Promise<void> {
    this.running = false
    if (this.loop) await this.loop.catch(() => {})
    this.loop = null
    if (this.session) this.api.endSession(this.session)
    this.session = null
    this.readEvent = null
    if (this.adapter) this.api.closeAdapter(this.adapter)
    this.adapter = null
  }

  private async readLoop(): Promise<void> {
    const { api } = this
    const size: [number] = [0]
    while (this.running && this.session) {
      let drained = false
      for (let i = 0; i < DRAIN_BATCH; i++) {
        const p = api.receivePacket(this.session, size)
        if (!p) {
          const code = api.lastError()
          if (code === ERROR_HANDLE_EOF) {
            this.running = false
            this.onFatal(new Error('O adaptador virtual foi removido.'))
            return
          }
          // ERROR_NO_MORE_ITEMS é o normal; qualquer outro código também espera
          // o evento (com timeout) em vez de girar em falso.
          drained = true
          break
        }
        const len = size[0]
        const buf = Buffer.allocUnsafe(len)
        api.copy(buf, p, len)
        api.releaseReceivePacket(this.session, p)
        this.rxBytes += len
        try {
          this.onPacket(buf)
        } catch {
          // um pacote ruim não derruba a VPN
        }
      }
      if (!this.running) break
      if (drained) await api.wait(this.readEvent, 250)
      else await new Promise((r) => setImmediate(r))
    }
  }
}
