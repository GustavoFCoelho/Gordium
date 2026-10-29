// Declarações mínimas para as bibliotecas da Holepunch, que não publicam tipos.

declare module 'hyperswarm' {
  import { EventEmitter } from 'node:events'

  export interface KeyPair {
    publicKey: Buffer
    secretKey: Buffer
  }

  export interface PeerDiscovery {
    flushed(): Promise<void>
    refresh(): Promise<void>
    destroy(): Promise<void>
  }

  /** Conexão criptografada (Noise) devolvida pelo swarm: um @hyperswarm/secret-stream. */
  export interface SwarmConnection extends EventEmitter {
    remotePublicKey: Buffer
    publicKey: Buffer
    handshakeHash: Buffer
    rawStream: {
      remoteHost?: string
      remotePort?: number
      rtt?: number
      mtu?: number
    } | null
    write(data: Buffer): boolean
    trySend(data: Buffer): void
    destroy(err?: Error): void
    destroyed: boolean
  }

  export default class Hyperswarm extends EventEmitter {
    constructor(opts?: { keyPair?: KeyPair; maxPeers?: number; firewall?: (remotePublicKey: Buffer) => boolean })
    keyPair: KeyPair
    connections: Set<SwarmConnection>
    join(topic: Buffer, opts?: { server?: boolean; client?: boolean }): PeerDiscovery
    leave(topic: Buffer): Promise<void>
    joinPeer(publicKey: Buffer): void
    leavePeer(publicKey: Buffer): void
    flush(): Promise<void>
    destroy(): Promise<void>
    on(event: 'connection', listener: (conn: SwarmConnection, info: unknown) => void): this
  }
}

declare module 'hypercore-crypto' {
  export function keyPair(seed?: Buffer): { publicKey: Buffer; secretKey: Buffer }
  export function sign(message: Buffer, secretKey: Buffer): Buffer
  export function verify(message: Buffer, signature: Buffer, publicKey: Buffer): boolean
  export function randomBytes(n: number): Buffer
}
