import type { AppState, ChatMessage, RtcSignal, ScreenSource, UpdateState, VoiceState } from '../shared/types'

/** API que o preload expõe para a interface em window.gordium. */
export interface GordiumApi {
  getState(): Promise<AppState>
  onState(cb: (state: AppState) => void): () => void

  getMessages(network: string): Promise<ChatMessage[]>
  sendChat(network: string, text: string): Promise<ChatMessage | null>
  onChat(cb: (network: string, messages: ChatMessage[]) => void): () => void

  createNetwork(name: string): Promise<string>
  joinNetwork(invite: string): Promise<string>
  leaveNetwork(id: string): Promise<void>
  setName(name: string): Promise<void>

  setVoice(network: string, state: VoiceState | null): Promise<void>
  sendSignal(network: string, peer: string, signal: RtcSignal): void
  onSignal(cb: (network: string, peer: string, signal: RtcSignal) => void): () => void

  getScreenSources(): Promise<ScreenSource[]>
  selectScreenSource(id: string, audio: boolean): Promise<void>

  vpnStart(): Promise<void>
  vpnStop(): Promise<void>
  vpnElevate(): Promise<void>

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
