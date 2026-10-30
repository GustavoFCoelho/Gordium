import type {
  AppState,
  ChannelKind,
  ChatMessage,
  NewSound,
  RtcSignal,
  ScreenChoice,
  ScreenSource,
  UpdateState,
  WindowTrack,
  VoiceState
} from '../shared/types'
import type { Hotkey } from '../shared/hotkeys'

/** API que o preload expõe para a interface em window.gordium. */
export interface GordiumApi {
  getState(): Promise<AppState>
  onState(cb: (state: AppState) => void): () => void

  getMessages(network: string): Promise<ChatMessage[]>
  sendChat(network: string, channel: string, text: string): Promise<ChatMessage | null>
  onChat(cb: (network: string, messages: ChatMessage[]) => void): () => void

  createChannel(network: string, kind: ChannelKind, name: string): Promise<string>
  renameChannel(network: string, id: string, name: string): Promise<void>
  deleteChannel(network: string, id: string): Promise<void>

  addSound(network: string, sound: NewSound): Promise<string>
  deleteSound(network: string, id: string): Promise<void>
  getSoundAudio(network: string, id: string): Promise<{ mime: string; audio: string } | null>
  playSound(network: string, channel: string, id: string): Promise<void>
  onSfx(cb: (network: string, peer: string, sound: string, channel: string) => void): () => void

  createNetwork(name: string): Promise<string>
  joinNetwork(invite: string): Promise<string>
  leaveNetwork(id: string): Promise<void>
  setName(name: string): Promise<void>

  setVoice(network: string, state: VoiceState | null): Promise<void>
  sendSignal(network: string, peer: string, signal: RtcSignal): void
  onSignal(cb: (network: string, peer: string, signal: RtcSignal) => void): () => void

  getScreenSources(): Promise<ScreenSource[]>
  selectScreenSource(id: string, audio: boolean): Promise<ScreenChoice>
  onWindowTrack(cb: (track: WindowTrack) => void): () => void
  stopWindowTracking(): Promise<void>

  /** Atalho global de mutar/desmutar (null desliga). */
  setMuteHotkey(hotkey: Hotkey | null): Promise<void>
  onMuteHotkey(cb: () => void): () => void

  vpnStart(): Promise<void>
  vpnStop(): Promise<void>

  getUpdate(): Promise<UpdateState>
  onUpdate(cb: (state: UpdateState) => void): () => void
  checkForUpdates(): Promise<void>
  installUpdate(): Promise<void>
}

declare global {
  interface Window {
    gordium: GordiumApi
  }
}
