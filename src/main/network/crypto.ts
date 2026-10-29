import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { VPN_SUBNET } from '../../shared/types'

const INVITE_PREFIX = 'gordium1:'

/** Tudo que alguém precisa para entrar numa rede: a chave secreta e o nome. */
export interface NetworkSecret {
  key: Buffer
  name: string
}

export function newNetworkKey(): Buffer {
  return randomBytes(32)
}

export function encodeInvite({ key, name }: NetworkSecret): string {
  return INVITE_PREFIX + Buffer.concat([key, Buffer.from(name, 'utf8')]).toString('base64url')
}

export function decodeInvite(code: string): NetworkSecret {
  const trimmed = code.trim()
  if (!trimmed.startsWith(INVITE_PREFIX)) throw new Error('Código de convite inválido.')
  const raw = Buffer.from(trimmed.slice(INVITE_PREFIX.length), 'base64url')
  if (raw.length < 32) throw new Error('Código de convite incompleto.')
  const name = cleanName(raw.subarray(32).toString('utf8')) || 'Rede'
  return { key: Buffer.from(raw.subarray(0, 32)), name }
}

function tagged(tag: string, ...parts: Buffer[]): Buffer {
  const h = createHash('sha256').update(tag)
  for (const p of parts) h.update(p)
  return h.digest()
}

/** Identificador público e estável da rede (não revela a chave). */
export function networkId(key: Buffer): string {
  return tagged('gordium/network-id/v1', key).subarray(0, 12).toString('hex')
}

/** Tópico anunciado na DHT: só quem tem a chave consegue calculá-lo. */
export function networkTopic(key: Buffer): Buffer {
  return tagged('gordium/topic/v1', key)
}

/**
 * Prova de que o peer conhece a chave da rede, amarrada a esta conexão
 * (handshakeHash é único por handshake Noise) e a quem está provando.
 */
export function authProof(key: Buffer, handshakeHash: Buffer, publicKey: Buffer): Buffer {
  return createHmac('sha256', key).update('gordium/auth/v1').update(handshakeHash).update(publicKey).digest()
}

export function checkProof(expected: Buffer, hex: unknown): boolean {
  if (typeof hex !== 'string') return false
  const got = Buffer.from(hex, 'hex')
  return got.length === expected.length && timingSafeEqual(got, expected)
}

// --- IPs virtuais -----------------------------------------------------------

export function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => ((acc << 8) | Number(octet)) >>> 0, 0)
}

export function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.')
}

export const SUBNET = ipToInt(VPN_SUBNET)
export const SUBNET_MASK = 0xffff0000
export const SUBNET_BROADCAST = (SUBNET | ~SUBNET_MASK) >>> 0

export function inSubnet(ip: number): boolean {
  return ((ip & SUBNET_MASK) >>> 0) === SUBNET
}

/**
 * IP virtual derivado da chave pública: o mesmo usuário tem sempre o mesmo IP,
 * em qualquer rede, sem precisar de um servidor distribuindo endereços.
 */
export function virtualIp(publicKey: Buffer): string {
  const h = tagged('gordium/vip/v1', publicKey)
  const hi = h[0]
  let lo = h[1]
  if (lo === 0) lo = 1
  if (lo === 255) lo = 254
  return intToIp((SUBNET | (hi << 8) | lo) >>> 0)
}

export function cleanName(name: unknown): string {
  if (typeof name !== 'string') return ''
  // remove caracteres de controle e limita o tamanho
  return name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32)
}
