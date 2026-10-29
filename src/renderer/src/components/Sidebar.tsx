import { useEffect, useRef, useState } from 'react'
import type { AppState, NetworkInfo } from '../../../shared/types'
import { call, useCall } from '../rtc/call'
import { toast, useUnread } from '../store'
import { errorText } from '../util'
import { Avatar } from './Avatar'
import {
  ChevronDownIcon,
  HashIcon,
  HeadphonesIcon,
  HeadphonesOffIcon,
  LogOutIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  ScreenIcon,
  SettingsIcon,
  UserPlusIcon,
  VideoIcon,
  VideoOffIcon,
  VolumeIcon
} from './Icons'

export type View = 'chat' | 'call'

interface Props {
  state: AppState
  network: NetworkInfo
  view: View
  onView(view: View): void
  onInvite(): void
  onLeave(): void
  onSettings(): void
  onScreen(): void
}

export async function joinVoice(network: string, selfId: string): Promise<boolean> {
  try {
    await call.join(network, selfId)
    if (call.error) toast(call.error, 'error')
    return true
  } catch (err) {
    toast(`Não foi possível entrar na sala: ${errorText(err)}`, 'error')
    return false
  }
}

export async function toggleCamera(): Promise<void> {
  try {
    await call.toggleCamera()
  } catch (err) {
    toast(`Câmera indisponível: ${errorText(err)}`, 'error')
  }
}

export function Sidebar({ state, network, view, onView, onInvite, onLeave, onSettings, onScreen }: Props) {
  const c = useCall()
  const unread = useUnread(network.id)
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const inThisCall = c.network === network.id

  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  const voiceUsers = [
    ...(inThisCall
      ? [
          {
            id: state.self.id,
            name: state.self.name,
            voice: { muted: c.muted || !c.local.mic, deafened: c.deafened, camera: !!c.local.camera, screen: !!c.local.screen }
          }
        ]
      : []),
    ...network.peers.filter((p) => p.online && p.voice)
  ]

  const enterVoice = async () => {
    if (!inThisCall && !(await joinVoice(network.id, state.self.id))) return
    onView('call')
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header-wrap" ref={menuRef}>
        <button className="sidebar-header" onClick={() => setMenu((m) => !m)}>
          <span className="ellipsis">{network.name}</span>
          <ChevronDownIcon size={18} />
        </button>
        {menu && (
          <div className="menu">
            <button
              onClick={() => {
                setMenu(false)
                onInvite()
              }}
            >
              <UserPlusIcon size={16} /> Convidar pessoas
            </button>
            <button
              className="danger"
              onClick={() => {
                setMenu(false)
                onLeave()
              }}
            >
              <LogOutIcon size={16} /> Sair da rede
            </button>
          </div>
        )}
      </div>

      <div className="channels">
        <div className="channel-group">Canais de texto</div>
        <button className={`channel${view === 'chat' ? ' active' : ''}${unread ? ' unread' : ''}`} onClick={() => onView('chat')}>
          <HashIcon size={18} /> <span className="ellipsis">geral</span>
          {unread > 0 && <span className="channel-badge">{unread}</span>}
        </button>

        <div className="channel-group">Canais de voz</div>
        <button className={`channel${view === 'call' && inThisCall ? ' active' : ''}`} onClick={enterVoice}>
          <VolumeIcon size={18} /> <span className="ellipsis">Sala de voz</span>
        </button>
        <div className="voice-users">
          {voiceUsers.map((u) => (
            <div key={u.id} className="voice-user">
              <Avatar id={u.id} name={u.name} size={24} speaking={inThisCall && c.speaking.has(u.id)} />
              <span className="ellipsis">{u.name}</span>
              <span className="voice-flags">
                {u.voice?.screen && <span className="live-tag">AO VIVO</span>}
                {u.voice?.camera && <VideoIcon size={14} />}
                {u.voice?.deafened ? <HeadphonesOffIcon size={14} /> : u.voice?.muted ? <MicOffIcon size={14} /> : null}
              </span>
            </div>
          ))}
        </div>
      </div>

      {c.network && <VoicePanel state={state} onScreen={onScreen} />}
      <UserPanel state={state} onSettings={onSettings} />
    </aside>
  )
}

function VoicePanel({ state, onScreen }: { state: AppState; onScreen(): void }) {
  const c = useCall()
  const network = state.networks.find((n) => n.id === c.network)
  const peersInCall = network?.peers.filter((p) => p.online && p.voice) ?? []
  const connecting = peersInCall.some((p) => {
    const s = c.linkState(p.id)
    return s !== 'connected'
  })
  return (
    <div className="voice-panel">
      <div className="voice-panel-info">
        <div className={`voice-panel-status${connecting ? ' connecting' : ''}`}>
          {connecting ? 'Conectando…' : 'Voz conectada'}
        </div>
        <div className="voice-panel-net ellipsis">Sala de voz / {network?.name}</div>
      </div>
      <div className="voice-panel-buttons">
        <button className={`icon-button${c.local.camera ? ' on' : ''}`} onClick={() => void toggleCamera()} title="Câmera">
          {c.local.camera ? <VideoIcon size={18} /> : <VideoOffIcon size={18} />}
        </button>
        <button
          className={`icon-button${c.local.screen ? ' on' : ''}`}
          onClick={() => (c.local.screen ? void c.stopScreen() : onScreen())}
          title={c.local.screen ? 'Parar transmissão' : 'Compartilhar tela'}
        >
          <ScreenIcon size={18} />
        </button>
        <button className="icon-button hangup" onClick={() => void c.leave()} title="Desconectar">
          <PhoneOffIcon size={18} />
        </button>
      </div>
    </div>
  )
}

function UserPanel({ state, onSettings }: { state: AppState; onSettings(): void }) {
  const c = useCall()
  const vpn = state.vpn
  return (
    <div className="user-panel">
      <Avatar id={state.self.id} name={state.self.name} size={32} speaking={c.speaking.has(state.self.id)} status="online" />
      <div className="user-panel-info">
        <div className="ellipsis user-panel-name">{state.self.name}</div>
        <div className={`ellipsis user-panel-sub vpn-${vpn.state}`}>
          {vpn.state === 'on' ? `VPN ${vpn.ip}` : vpn.state === 'starting' ? 'VPN iniciando…' : 'VPN desligada'}
        </div>
      </div>
      <button className={`icon-button${c.muted ? ' off' : ''}`} onClick={() => c.setMuted(!c.muted)} title={c.muted ? 'Ativar microfone' : 'Silenciar'}>
        {c.muted || c.deafened ? <MicOffIcon size={18} /> : <MicIcon size={18} />}
      </button>
      <button
        className={`icon-button${c.deafened ? ' off' : ''}`}
        onClick={() => c.setDeafened(!c.deafened)}
        title={c.deafened ? 'Ativar áudio' : 'Ensurdecer'}
      >
        {c.deafened ? <HeadphonesOffIcon size={18} /> : <HeadphonesIcon size={18} />}
      </button>
      <button className="icon-button" onClick={onSettings} title="Configurações">
        <SettingsIcon size={18} />
      </button>
    </div>
  )
}
