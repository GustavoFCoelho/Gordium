// Pacotes IPv4 e sockets de teste para os autotestes da VPN.

import { createSocket, type Socket } from 'node:dgram'

/**
 * Socket UDP preso ao IP da VPN. Logo depois de configurado, o Windows ainda
 * está verificando o endereço e o bind falha: tenta de novo até liberar.
 */
export async function bindUdp(ip: string, timeoutMs = 20_000): Promise<Socket> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const sock = createSocket('udp4')
    const err = await new Promise<Error | null>((resolve) => {
      sock.once('error', resolve)
      sock.bind(0, ip, () => resolve(null))
    })
    if (!err) return sock
    sock.close()
    if (Date.now() > deadline) throw new Error(`não foi possível usar o IP ${ip}: ${err.message}`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

export const ipStr = (b: Buffer, off: number): string => `${b[off]}.${b[off + 1]}.${b[off + 2]}.${b[off + 3]}`

const ipBytes = (s: string): Buffer => Buffer.from(s.split('.').map(Number))

function checksum(buf: Buffer): number {
  let sum = 0
  for (let i = 0; i < buf.length; i += 2) sum += (buf[i] << 8) | (buf[i + 1] ?? 0)
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16)
  return ~sum & 0xffff
}

/** Ping (ICMP echo request) de src para dst. */
export function icmpEchoRequest(src: string, dst: string, id: number, seq: number): Buffer {
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
  ipBytes(src).copy(hdr, 12)
  ipBytes(dst).copy(hdr, 16)
  hdr.writeUInt16BE(checksum(hdr), 10)
  return Buffer.concat([hdr, icmp])
}

/** Resposta de ping (echo reply) com o id dado, endereçada a `to`. */
export function isEchoReply(p: Buffer, to: string, id: number): boolean {
  return p[0] >> 4 === 4 && p[9] === 1 && p[20] === 0 && ipStr(p, 16) === to && p.readUInt16BE(24) === id
}

/** Pacote UDP endereçado a `to`. */
export function isUdpTo(p: Buffer, to: string): boolean {
  return p[0] >> 4 === 4 && p[9] === 17 && ipStr(p, 16) === to
}
