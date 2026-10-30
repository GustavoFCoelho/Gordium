import { useSyncExternalStore } from 'react'
import { hotkeyFromAccelerator, isHotkey, type Hotkey } from '../../../shared/hotkeys'
import type { AppState, PeerInfo, RtcSignal, ScreenChoice } from '../../../shared/types'
import { toast } from '../store'
import { playSoundboard } from './soundboard'
import { canProcessVideo, followWindow, windowCapture } from './windowCapture'
import { playCue, type Cue } from './sounds'

const api = window.gordium

/**
 * Cada conexão entre dois participantes tem 4 transceivers fixos, sempre nesta
 * ordem. Ligar/desligar câmera ou tela só troca a trilha (replaceTrack), sem
 * renegociar: quem oferta (menor id) cria os 4, quem responde reaproveita.
 */
export type MediaKind = 'mic' | 'camera' | 'screen' | 'screenAudio'
const KINDS: MediaKind[] = ['mic', 'camera', 'screen', 'screenAudio']
const TRACK_TYPE: Record<MediaKind, 'audio' | 'video'> = {
  mic: 'audio',
  camera: 'video',
  screen: 'video',
  screenAudio: 'audio'
}

/**
 * STUN público só para descobrir o próprio endereço. Com a VPN ligada, o
 * WebRTC também enxerga o IP 100.88.x.y e pode usar o túnel do Gordium, o
 * que cobre redes em que a conexão direta falha.
 */
const ICE_SERVERS: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }]

export interface ScreenQuality {
  label: string
  width: number
  height: number
  fps: number
  bitrate: number
}

export const SCREEN_QUALITIES: ScreenQuality[] = [
  { label: '720p · 30 fps', width: 1280, height: 720, fps: 30, bitrate: 2_500_000 },
  { label: '1080p · 30 fps', width: 1920, height: 1080, fps: 30, bitrate: 4_500_000 },
  { label: '1080p · 60 fps', width: 1920, height: 1080, fps: 60, bitrate: 8_000_000 }
]
const CAMERA_BITRATE = 1_200_000
const SPEAKING_THRESHOLD = 0.035
const SPEAKING_HOLD_MS = 300

export interface DeviceSettings {
  micId: string
  camId: string
  outputId: string
  noiseSuppression: boolean
  /** Sons quando alguém entra ou sai da sala de voz. */
  sounds: boolean
  /** Volume do soundboard, 0–1. */
  soundboardVolume: number
  /** Atalho global de mutar/desmutar ligado (vem desligado; a pessoa ativa nas configurações). */
  muteHotkeyEnabled: boolean
  /** A tecla do atalho; null = nenhuma escolhida ainda. */
  muteKey: Hotkey | null
}

/** Um som do soundboard por pessoa a cada tanto, para ninguém metralhar a sala. */
const SOUNDBOARD_COOLDOWN_MS = 800

interface Link {
  peer: string
  cid: string
  offerer: boolean
  pc: RTCPeerConnection
  transceivers: RTCRtpTransceiver[] | null
  pending: RTCIceCandidateInit[]
  queue: Promise<void>
  audio: HTMLAudioElement
  screenAudio: HTMLAudioElement
}

interface Meter {
  source: MediaStreamAudioSourceNode
  analyser: AnalyserNode
  data: Uint8Array<ArrayBuffer>
  last: number
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback
  } catch {
    return fallback
  }
}

class CallManager {
  network: string | null = null
  /** Canal de voz em que estou (dentro de `network`). */
  channel: string | null = null
  selfId = ''
  muted = false
  deafened = false
  error: string | null = null
  readonly local: Record<MediaKind, MediaStreamTrack | null> = { mic: null, camera: null, screen: null, screenAudio: null }
  readonly speaking = new Set<string>()
  settings: DeviceSettings = loadJson('gordium.devices', {
    micId: '',
    camId: '',
    outputId: '',
    noiseSuppression: true,
    sounds: true,
    soundboardVolume: 0.6,
    muteHotkeyEnabled: false,
    muteKey: null
  })
  /** O atalho de mutar não pôde ser ligado. */
  hotkeyError: string | null = null
  private hotkeyPaused = false

  private volumes: Record<string, number> = loadJson('gordium.volumes', {})
  private screenQuality = SCREEN_QUALITIES[0]
  /** Encerra a captura em andamento (monitor bruto e, se houver, o recorte da janela). */
  private screenCapture: { stop(): void } | null = null
  private peers: PeerInfo[] = []
  private readonly links = new Map<string, Link>()
  private readonly listeners = new Set<() => void>()
  private version = 0
  private audioCtx: AudioContext | null = null
  private readonly meters = new Map<string, Meter>()
  private meterTimer: number | null = null
  /** Quem está na sala (fora eu), para os sons de entrada/saída; null = ainda não sabe. */
  private roomMembers: Set<string> | null = null

  private lastSfx = new Map<string, number>()

  constructor() {
    api.onSignal((network, peer, signal) => this.onSignal(network, peer, signal))
    api.onSfx((network, peer, sound, channel) => {
      if (network === this.network && channel === this.channel && this.allowSfx(peer)) this.playSfx(sound)
    })
    this.migrateHotkey()
    api.onMuteHotkey(() => this.toggleMuteByHotkey())
    void this.applyHotkey()
  }

  // --- integração com React -----------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.version

  private changed(): void {
    this.version++
    for (const l of this.listeners) l()
  }

  // --- leitura -------------------------------------------------------------

  remoteTrack(peer: string, kind: MediaKind): MediaStreamTrack | null {
    return this.links.get(peer)?.transceivers?.[KINDS.indexOf(kind)]?.receiver.track ?? null
  }

  linkState(peer: string): RTCPeerConnectionState | null {
    return this.links.get(peer)?.pc.connectionState ?? null
  }

  getVolume(peer: string): number {
    return this.volumes[peer] ?? 1
  }

  // --- entrar / sair ---------------------------------------------------------

  async join(network: string, channel: string, selfId: string): Promise<void> {
    if (this.network === network && this.channel === channel) return
    if (this.network) await this.leave()
    this.channel = channel
    this.selfId = selfId
    this.error = null
    this.peers = [] // chegam no próximo syncState, já desta rede
    this.roomMembers = null
    this.audioCtx = new AudioContext()
    void this.audioCtx.resume()
    try {
      this.local.mic = await this.openMic()
    } catch (err) {
      this.error = `Microfone indisponível: ${(err as Error).message}`
    }
    this.network = network
    this.applyMute()
    if (this.local.mic) this.watch(selfId, this.local.mic)
    this.meterTimer = window.setInterval(() => this.tickMeters(), 100)
    this.cue('join')
    await this.publish()
    this.syncLinks()
  }

  async leave(): Promise<void> {
    const network = this.network
    if (!network) return
    for (const link of [...this.links.values()]) this.closeLink(link, true)
    this.cue('leave')
    this.network = null
    this.channel = null
    this.roomMembers = null
    this.screenCapture?.stop()
    this.screenCapture = null
    for (const k of KINDS) {
      this.local[k]?.stop()
      this.local[k] = null
    }
    if (this.meterTimer !== null) clearInterval(this.meterTimer)
    this.meterTimer = null
    for (const key of [...this.meters.keys()]) this.unwatch(key)
    this.speaking.clear()
    void this.audioCtx?.close()
    this.audioCtx = null
    await api.setVoice(network, null)
    this.changed()
  }

  /** Chamado a cada estado novo do processo principal: cria/fecha conexões conforme quem está na sala. */
  syncState(state: AppState): void {
    if (!this.network) return
    const net = state.networks.find((n) => n.id === this.network)
    // Rede abandonada ou canal de voz excluído: sai da chamada.
    if (!net || !net.channels.some((c) => c.id === this.channel && c.kind === 'voice')) {
      void this.leave()
      return
    }
    this.peers = net.peers
    this.roomSounds()
    this.syncLinks()
  }

  /** Som quando alguém entra ou sai da sala em que eu estou (cair da conexão conta como sair). */
  private roomSounds(): void {
    const now = new Set(this.roomPeers().map((p) => p.id))
    const before = this.roomMembers
    this.roomMembers = now
    if (!before) return // primeira visão da sala: quem já estava não "entrou"
    if ([...now].some((id) => !before.has(id))) this.cue('join')
    else if ([...before].some((id) => !now.has(id))) this.cue('leave')
  }

  /** Quem está na mesma sala de voz que eu. */
  private roomPeers(): PeerInfo[] {
    return this.peers.filter((p) => p.online && p.voice?.channel === this.channel)
  }

  // --- soundboard --------------------------------------------------------------

  /** Toca um som para todo mundo da sala (cada um toca a própria cópia). */
  async playSound(id: string): Promise<void> {
    if (!this.network || !this.channel) throw new Error('Entre numa sala de voz para tocar sons.')
    if (!this.allowSfx(this.selfId)) return
    await api.playSound(this.network, this.channel, id)
    this.playSfx(id)
  }

  /** Ouvir só para mim, sem tocar na sala. */
  previewSound(network: string, id: string): void {
    void playSoundboard(network, id, this.settings.soundboardVolume, this.settings.outputId).catch(() => {})
  }

  private allowSfx(who: string): boolean {
    const now = Date.now()
    if (now - (this.lastSfx.get(who) ?? 0) < SOUNDBOARD_COOLDOWN_MS) return false
    this.lastSfx.set(who, now)
    return true
  }

  private playSfx(id: string): void {
    if (this.deafened || !this.network) return
    void playSoundboard(this.network, id, this.settings.soundboardVolume, this.settings.outputId).catch(() => {})
  }

  private cue(cue: Cue): void {
    if (this.settings.sounds && !this.deafened) playCue(cue, this.settings.outputId)
  }

  private syncLinks(): void {
    if (!this.network) return
    const inVoice = new Set(this.roomPeers().map((p) => p.id))
    for (const link of [...this.links.values()]) {
      if (!inVoice.has(link.peer)) this.closeLink(link, false)
    }
    for (const id of inVoice) {
      if (!this.links.has(id) && this.isOfferer(id)) this.createLink(id, crypto.randomUUID(), true)
    }
    this.changed()
  }

  private isOfferer(peer: string): boolean {
    return this.selfId < peer
  }

  // --- controles -----------------------------------------------------------

  setMuted(muted: boolean): void {
    this.muted = muted
    if (!muted) this.deafened = false
    this.applyMute()
    this.applyVolumes()
    void this.publish()
    this.changed()
  }

  /** Atalho de mutar: alterna o microfone (e sai do modo surdo, se estiver) e avisa com um som, já que a pessoa pode estar dentro de um jogo. */
  private toggleMuteByHotkey(): void {
    const silenced = this.muted || this.deafened
    this.setMuted(!silenced)
    if (this.settings.sounds) playCue(silenced ? 'unmute' : 'mute', this.settings.outputId)
  }

  /** A 0.1.10 guardava o atalho como texto ("Ctrl+Alt+Shift+F9"); converte para o formato novo. */
  private migrateHotkey(): void {
    const saved = this.settings as DeviceSettings & { muteHotkey?: unknown }
    if (!('muteHotkey' in saved) && (saved.muteKey === null || isHotkey(saved.muteKey))) return
    const { muteHotkey, ...rest } = saved
    const muteKey = isHotkey(rest.muteKey) ? rest.muteKey : typeof muteHotkey === 'string' ? hotkeyFromAccelerator(muteHotkey) : null
    this.settings = { ...rest, muteKey }
    localStorage.setItem('gordium.devices', JSON.stringify(this.settings))
  }

  /** Liga (ou desliga) o atalho global de mutar conforme as configurações. */
  private async applyHotkey(): Promise<void> {
    const { muteHotkeyEnabled, muteKey } = this.settings
    let error: string | null = null
    try {
      await api.setMuteHotkey(muteHotkeyEnabled && muteKey && !this.hotkeyPaused ? muteKey : null)
    } catch (err) {
      error = `Não consegui ligar o atalho: ${(err as Error).message}`
    }
    this.hotkeyError = error
    this.changed()
  }

  /** Dica do botão de mutar, com o atalho quando ele está ativo. */
  get muteTitle(): string {
    const base = this.muted ? 'Ativar microfone' : 'Silenciar'
    const { muteHotkeyEnabled, muteKey } = this.settings
    return muteHotkeyEnabled && muteKey ? `${base} (${muteKey.label})` : base
  }

  /** Suspende o atalho enquanto a pessoa grava uma tecla nova (senão apertar a tecla atual alternaria o microfone). */
  pauseHotkey(paused: boolean): void {
    this.hotkeyPaused = paused
    void this.applyHotkey()
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened
    this.applyMute()
    this.applyVolumes()
    void this.publish()
    this.changed()
  }

  setVolume(peer: string, volume: number): void {
    this.volumes[peer] = volume
    localStorage.setItem('gordium.volumes', JSON.stringify(this.volumes))
    this.applyVolumes()
    this.changed()
  }

  async setSettings(next: Partial<DeviceSettings>): Promise<void> {
    const prev = this.settings
    this.settings = { ...prev, ...next }
    localStorage.setItem('gordium.devices', JSON.stringify(this.settings))
    if (this.network && (prev.micId !== this.settings.micId || prev.noiseSuppression !== this.settings.noiseSuppression)) {
      try {
        const mic = await this.openMic()
        this.local.mic?.stop()
        this.setLocal('mic', mic)
        this.applyMute()
        this.watch(this.selfId, mic)
        this.error = null
      } catch (err) {
        this.error = `Microfone indisponível: ${(err as Error).message}`
      }
    }
    if (prev.outputId !== this.settings.outputId) this.applyVolumes()
    if (prev.muteHotkeyEnabled !== this.settings.muteHotkeyEnabled || prev.muteKey !== this.settings.muteKey) void this.applyHotkey()
    if (this.network && this.local.camera && prev.camId !== this.settings.camId) {
      await this.toggleCamera()
      await this.toggleCamera()
    }
    this.changed()
  }

  async toggleCamera(): Promise<void> {
    if (!this.network) return
    if (this.local.camera) {
      this.local.camera.stop()
      this.setLocal('camera', null)
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: this.settings.camId ? { exact: this.settings.camId } : undefined,
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
        }
      })
      this.setLocal('camera', stream.getVideoTracks()[0])
    }
    await this.publish()
  }

  async startScreen(sourceId: string, audio: boolean, quality: ScreenQuality): Promise<ScreenChoice | null> {
    if (!this.network) return null
    // Começa a ouvir o estado da janela antes de pedir a captura, para não perder o primeiro.
    const follow = canProcessVideo ? followWindow() : null
    let choice: ScreenChoice
    let stream: MediaStream
    try {
      choice = await api.selectScreenSource(sourceId, audio)
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { max: quality.width }, height: { max: quality.height }, frameRate: { max: quality.fps } },
        // O som do computador vai como é: os filtros de voz (eco, ruído, ganho
        // automático) vêm ligados por padrão e estragam música e som de jogo.
        audio: audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false
      })
    } catch (err) {
      follow?.stop()
      void api.stopWindowTracking()
      throw err
    }
    this.screenCapture?.stop()
    this.local.screenAudio?.stop()
    const raw = stream.getVideoTracks()[0]
    let video = raw
    if (choice.follow && follow) {
      const capture = windowCapture(raw, follow, () => {
        toast('A janela transmitida foi fechada.', 'error')
        void this.stopScreen()
      })
      this.screenCapture = capture
      video = capture.track
    } else {
      follow?.stop()
      this.screenCapture = { stop: () => raw.stop() }
    }
    // 60 fps: prioriza fluidez (jogos); 30 fps: prioriza nitidez (texto, código).
    video.contentHint = quality.fps >= 60 ? 'motion' : 'detail'
    // 'ended' só dispara quando a fonte acaba sozinha (monitor desligado, captura revogada).
    raw.addEventListener('ended', () => {
      toast('A transmissão parou: a janela ou tela deixou de estar disponível.', 'error')
      void this.stopScreen()
    })
    this.screenQuality = quality
    this.setLocal('screen', video)
    this.setLocal('screenAudio', stream.getAudioTracks()[0] ?? null)
    for (const link of this.links.values()) this.applyEncodings(link)
    await this.publish()
    return choice
  }

  async stopScreen(): Promise<void> {
    if (!this.local.screen && !this.local.screenAudio) return
    this.screenCapture?.stop()
    this.screenCapture = null
    this.local.screenAudio?.stop()
    this.setLocal('screen', null)
    this.setLocal('screenAudio', null)
    await this.publish()
  }

  // --- mídia local -----------------------------------------------------------

  private async openMic(): Promise<MediaStreamTrack> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: this.settings.micId ? { exact: this.settings.micId } : undefined,
        echoCancellation: true,
        noiseSuppression: this.settings.noiseSuppression,
        autoGainControl: true
      }
    })
    return stream.getAudioTracks()[0]
  }

  private setLocal(kind: MediaKind, track: MediaStreamTrack | null): void {
    this.local[kind] = track
    const i = KINDS.indexOf(kind)
    for (const link of this.links.values()) {
      void link.transceivers?.[i].sender.replaceTrack(track).catch(() => {})
    }
    this.changed()
  }

  private applyMute(): void {
    if (this.local.mic) this.local.mic.enabled = !(this.muted || this.deafened)
  }

  private applyVolumes(): void {
    for (const link of this.links.values()) this.applyVolume(link)
  }

  private applyVolume(link: Link): void {
    const volume = Math.min(1, Math.max(0, this.getVolume(link.peer)))
    for (const el of [link.audio, link.screenAudio]) {
      el.volume = volume
      el.muted = this.deafened
      if (this.settings.outputId && 'setSinkId' in el) void el.setSinkId(this.settings.outputId).catch(() => {})
    }
  }

  private applyEncodings(link: Link): void {
    const t = link.transceivers
    if (!t) return
    setMaxBitrate(t[KINDS.indexOf('camera')].sender, CAMERA_BITRATE)
    setMaxBitrate(t[KINDS.indexOf('screen')].sender, this.screenQuality.bitrate)
  }

  private async publish(): Promise<void> {
    if (!this.network) return
    await api.setVoice(this.network, {
      channel: this.channel ?? '',
      muted: this.muted || this.deafened || !this.local.mic,
      deafened: this.deafened,
      camera: !!this.local.camera,
      screen: !!this.local.screen
    })
  }

  // --- conexões WebRTC -------------------------------------------------------

  private createLink(peer: string, cid: string, offerer: boolean): Link {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, bundlePolicy: 'max-bundle' })
    const link: Link = {
      peer,
      cid,
      offerer,
      pc,
      transceivers: null,
      pending: [],
      queue: Promise.resolve(),
      audio: new Audio(),
      screenAudio: new Audio()
    }
    link.audio.autoplay = true
    link.screenAudio.autoplay = true
    this.links.set(peer, link)

    pc.onicecandidate = (e) => {
      if (e.candidate) this.signal(link, { candidate: e.candidate.toJSON() as RtcSignal['candidate'] })
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') this.applyEncodings(link)
      if (pc.connectionState === 'failed' && link.offerer && this.links.get(peer) === link) {
        // Recomeça do zero com outro cid; o outro lado troca a sessão ao ver a oferta nova.
        this.closeLink(link, true)
        setTimeout(() => this.syncLinks(), 2000)
      }
      this.changed()
    }

    if (offerer) {
      link.transceivers = KINDS.map((k) => pc.addTransceiver(TRACK_TYPE[k], { direction: 'sendrecv' }))
      this.attach(link)
      pc.onnegotiationneeded = () => {
        this.enqueue(link, async () => {
          await pc.setLocalDescription()
          this.signal(link, { description: pc.localDescription!.toJSON() as RtcSignal['description'] })
        })
      }
    }
    return link
  }

  /** Liga as trilhas locais aos transceivers e as remotas aos elementos de áudio. */
  private attach(link: Link): void {
    const t = link.transceivers!
    KINDS.forEach((k, i) => void t[i].sender.replaceTrack(this.local[k]).catch(() => {}))
    link.audio.srcObject = new MediaStream([t[KINDS.indexOf('mic')].receiver.track])
    link.screenAudio.srcObject = new MediaStream([t[KINDS.indexOf('screenAudio')].receiver.track])
    void link.audio.play().catch(() => {})
    void link.screenAudio.play().catch(() => {})
    this.applyVolume(link)
    this.watch(link.peer, t[KINDS.indexOf('mic')].receiver.track)
  }

  private closeLink(link: Link, sendBye: boolean): void {
    if (sendBye && this.network) this.signal(link, { bye: true })
    link.pc.close()
    link.audio.srcObject = null
    link.screenAudio.srcObject = null
    if (this.links.get(link.peer) === link) {
      this.links.delete(link.peer)
      this.unwatch(link.peer)
    }
  }

  private signal(link: Link, data: Omit<RtcSignal, 'cid'>): void {
    if (this.network) api.sendSignal(this.network, link.peer, { cid: link.cid, ...data })
  }

  private enqueue(link: Link, task: () => Promise<void>): void {
    link.queue = link.queue.then(task).catch((err) => console.warn('[rtc]', link.peer.slice(0, 8), err))
  }

  private async flushCandidates(link: Link): Promise<void> {
    for (const c of link.pending.splice(0)) await link.pc.addIceCandidate(c).catch(() => {})
  }

  private onSignal(network: string, peer: string, sig: RtcSignal): void {
    if (network !== this.network) return
    let link = this.links.get(peer)

    if (sig.bye) {
      if (link && link.cid === sig.cid) {
        this.closeLink(link, false)
        this.changed()
      }
      return
    }

    if (sig.description?.type === 'offer') {
      if (this.isOfferer(peer)) return // só um lado oferta, então não há colisão
      if (link && link.cid !== sig.cid) {
        this.closeLink(link, false)
        link = undefined
      }
      const l = link ?? this.createLink(peer, sig.cid, false)
      const offer = sig.description
      this.enqueue(l, async () => {
        await l.pc.setRemoteDescription(offer)
        if (!l.transceivers) {
          const ts = l.pc.getTransceivers()
          if (ts.length < KINDS.length) throw new Error('oferta incompatível')
          l.transceivers = ts.slice(0, KINDS.length)
          for (const t of l.transceivers) t.direction = 'sendrecv'
          this.attach(l)
        }
        await l.pc.setLocalDescription()
        this.signal(l, { description: l.pc.localDescription!.toJSON() as RtcSignal['description'] })
        await this.flushCandidates(l)
        this.changed()
      })
      return
    }

    if (!link || link.cid !== sig.cid) return
    const l = link
    if (sig.description?.type === 'answer') {
      const answer = sig.description
      this.enqueue(l, async () => {
        if (l.pc.signalingState !== 'have-local-offer') return
        await l.pc.setRemoteDescription(answer)
        await this.flushCandidates(l)
      })
    } else if (sig.candidate) {
      const candidate = sig.candidate
      this.enqueue(l, async () => {
        if (l.pc.remoteDescription) await l.pc.addIceCandidate(candidate).catch(() => {})
        else l.pending.push(candidate)
      })
    }
  }

  // --- indicador de quem está falando --------------------------------------

  private watch(key: string, track: MediaStreamTrack): void {
    if (!this.audioCtx) return
    this.unwatch(key)
    const source = this.audioCtx.createMediaStreamSource(new MediaStream([track]))
    const analyser = this.audioCtx.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    this.meters.set(key, { source, analyser, data: new Uint8Array(analyser.fftSize), last: 0 })
  }

  private unwatch(key: string): void {
    const m = this.meters.get(key)
    if (!m) return
    m.source.disconnect()
    this.meters.delete(key)
    this.speaking.delete(key)
  }

  private tickMeters(): void {
    const now = performance.now()
    let changed = false
    for (const [key, m] of this.meters) {
      m.analyser.getByteTimeDomainData(m.data)
      let sum = 0
      for (const v of m.data) {
        const x = (v - 128) / 128
        sum += x * x
      }
      const rms = Math.sqrt(sum / m.data.length)
      const audible = key === this.selfId ? !(this.muted || this.deafened) : true
      if (audible && rms > SPEAKING_THRESHOLD) m.last = now
      const speaking = now - m.last < SPEAKING_HOLD_MS
      if (speaking !== this.speaking.has(key)) {
        if (speaking) this.speaking.add(key)
        else this.speaking.delete(key)
        changed = true
      }
    }
    if (changed) this.changed()
  }
}

function setMaxBitrate(sender: RTCRtpSender, bps: number): void {
  const params = sender.getParameters()
  if (!params.encodings?.length) return
  params.encodings[0].maxBitrate = bps
  void sender.setParameters(params).catch(() => {})
}

export const call = new CallManager()

/** Re-renderiza o componente quando algo na chamada muda. */
export function useCall(): CallManager {
  useSyncExternalStore(call.subscribe, call.getVersion)
  return call
}
