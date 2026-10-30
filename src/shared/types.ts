// Tipos compartilhados entre o processo principal (rede/VPN) e a interface.

/** Faixa de IPs da VPN do Gordium: 100.88.0.0/16 (dentro do bloco CGNAT 100.64.0.0/10). */
export const VPN_SUBNET = '100.88.0.0'
export const VPN_PREFIX = 16

/** Canais que toda rede tem desde o início (podem ser renomeados, não excluídos). */
export const DEFAULT_TEXT_CHANNEL = 'geral'
export const DEFAULT_VOICE_CHANNEL = 'voz'

export interface VoiceState {
  /** Canal de voz em que a pessoa está. */
  channel: string
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
  channels: ChannelInfo[]
  sounds: SoundInfo[]
}

export type ChannelKind = 'text' | 'voice'

export interface ChannelInfo {
  id: string
  kind: ChannelKind
  name: string
  createdAt: number
  /** #geral e Sala de voz: existem em toda rede e não podem ser excluídos. */
  builtin: boolean
}

/** Som do soundboard (o áudio em si é buscado à parte, só quando vai tocar). */
export interface SoundInfo {
  id: string
  name: string
  emoji: string
  /** Segundos. */
  duration: number
  author: string
  createdAt: number
}

/** Som pronto para guardar: áudio comprimido em base64. */
export interface NewSound {
  name: string
  emoji: string
  duration: number
  mime: string
  audio: string
}

export interface ChatMessage {
  id: string
  network: string
  /** Canal de texto (mensagens antigas, sem canal, são do #geral). */
  channel: string
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
  /** Janela que ocupa o monitor inteiro (jogo em tela cheia): é transmitida pelo monitor. */
  fullscreen: boolean
  /** Fonte do monitor onde a janela está. */
  screenId: string | null
}

/** O que vai ser transmitido depois de escolher uma fonte. */
export interface ScreenChoice {
  surface: 'screen' | 'window'
  /** A janela escolhida estava em tela cheia e virou captura do monitor dela. */
  viaMonitor: boolean
  name: string
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
