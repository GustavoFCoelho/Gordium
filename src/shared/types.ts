// Tipos compartilhados entre o processo principal (rede/VPN) e a interface.

/** Faixa de IPs da VPN do Gordium: 100.88.0.0/16 (dentro do bloco CGNAT 100.64.0.0/10). */
export const VPN_SUBNET = '100.88.0.0'
export const VPN_PREFIX = 16

export interface VoiceState {
  muted: boolean
  deafened: boolean
  camera: boolean
  screen: boolean
}

export interface PeerInfo {
  /** Chave pública ed25519 em hex: identidade única do usuário. */
  id: string
  name: string
  /** IP virtual na VPN. */
  vip: string
  online: boolean
  lastSeen: number
  /** Latência da conexão P2P em ms, quando conectado. */
  rtt: number | null
  /** Endereço público do peer, quando conectado. */
  remote: string | null
  /** Estado no canal de voz; null = fora da chamada. */
  voice: VoiceState | null
}

export interface NetworkInfo {
  id: string
  name: string
  invite: string
  joinedAt: number
  /** Ainda anunciando a rede na DHT pela primeira vez. */
  discovering: boolean
  peers: PeerInfo[]
}

export interface ChatMessage {
  id: string
  network: string
  author: string
  name: string
  ts: number
  text: string
  sig: string
}

export type VpnState = 'off' | 'starting' | 'on' | 'error' | 'unsupported'

export interface VpnStatus {
  state: VpnState
  ip: string | null
  error: string | null
  /** Bytes que este computador mandou pela VPN. */
  sentBytes: number
  /** Bytes que chegaram dos outros membros pela VPN. */
  receivedBytes: number
}

export interface SelfInfo {
  id: string
  name: string
  vip: string
}

export interface AppState {
  self: SelfInfo
  networks: NetworkInfo[]
  vpn: VpnStatus
}

export interface ScreenSource {
  id: string
  name: string
  thumbnail: string
  kind: 'screen' | 'window'
}

/** unsupported = rodando fora do instalador (modo de desenvolvimento). */
export type UpdateStatus = 'unsupported' | 'idle' | 'checking' | 'downloading' | 'ready' | 'error'

export interface UpdateState {
  status: UpdateStatus
  /** Versão instalada. */
  current: string
  /** Versão nova encontrada nas Releases do GitHub. */
  next: string | null
  /** O que mudou (texto da release). */
  notes: string | null
  /** Progresso do download, 0–100. */
  progress: number
  error: string | null
  checkedAt: number | null
}

/** Sinalização WebRTC trocada pelos canais P2P do Gordium. */
export interface RtcSignal {
  /** Identificador da sessão de mídia entre os dois peers. */
  cid: string
  description?: { type: 'offer' | 'answer'; sdp: string }
  candidate?: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
  bye?: true
}
