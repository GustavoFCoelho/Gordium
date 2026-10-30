import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { AppState, ChannelInfo, ChannelKind, NetworkInfo, VoiceState } from '../../../shared/types'
import { call, useCall } from '../rtc/call'
import { toast, useUnread } from '../store'
import { errorText } from '../util'
import { Avatar } from './Avatar'
import type { MenuItem, MenuState } from './ContextMenu'
import {
  ChevronDownIcon,
  HashIcon,
  HeadphonesIcon,
  HeadphonesOffIcon,
  LogOutIcon,
  MicIcon,
  MicOffIcon,
  MusicIcon,
  PencilIcon,
  PhoneOffIcon,
  PlusIcon,
  ScreenIcon,
  SettingsIcon,
  TrashIcon,
  UserPlusIcon,
  VideoIcon,
  VideoOffIcon,
  VolumeIcon
} from './Icons'

export type View = 'chat' | 'call'

/** Pedidos de criar/renomear/excluir canal: o App abre o modal certo. */
export type ChannelAction =
  | { type: 'create'; kind: ChannelKind }
  | { type: 'rename'; channel: ChannelInfo }
  | { type: 'delete'; channel: ChannelInfo }

interface Props {
  state: AppState
  network: NetworkInfo
  view: View
  textChannel: string
  onOpenText(channel: string): void
  onOpenCall(): void
  onChannelAction(action: ChannelAction): void
  onContextMenu(menu: MenuState): void
  onInvite(): void
  onLeave(): void
  onSettings(): void
  onScreen(): void
  onSoundboard(): void
}

export async function joinVoice(network: string, channel: string, selfId: string): Promise<boolean> {
  try {
    await call.join(network, channel, selfId)
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

function TextChannel({ network, channel, active, onOpen, onMenu }: { network: string; channel: ChannelInfo; active: boolean; onOpen(): void; onMenu(e: ReactMouseEvent): void }) {
  const unread = useUnread(network, channel.id)
  return (
    <button className={`channel${active ? ' active' : ''}${unread ? ' unread' : ''}`} onClick={onOpen} onContextMenu={onMenu}>
      <HashIcon size={18} /> <span className="ellipsis">{channel.name}</span>
      {unread > 0 && <span className="channel-badge">{unread}</span>}
    </button>
  )
}

interface VoiceUser {
  id: string
  name: string
  voice: VoiceState | null
}

export function Sidebar(props: Props) {
  const { state, network, view, textChannel, onOpenText, onOpenCall, onChannelAction, onContextMenu } = props
  const c = useCall()
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  const createItems: MenuItem[] = [
    { label: 'Criar canal de texto', icon: <HashIcon size={16} />, onClick: () => onChannelAction({ type: 'create', kind: 'text' }) },
    { label: 'Criar canal de voz', icon: <VolumeIcon size={16} />, onClick: () => onChannelAction({ type: 'create', kind: 'voice' }) }
  ]

  /** Botão direito: criar canais em qualquer ponto; renomear/excluir sobre um canal. */
  const openMenu = (e: ReactMouseEvent, channel: ChannelInfo | null) => {
    e.preventDefault()
    e.stopPropagation()
    const items: MenuItem[] = [...createItems]
    if (channel) {
      items.push('separator', { label: 'Renomear canal', icon: <PencilIcon size={16} />, onClick: () => onChannelAction({ type: 'rename', channel }) })
      if (!channel.builtin) {
        items.push({ label: 'Excluir canal', icon: <TrashIcon size={16} />, danger: true, onClick: () => onChannelAction({ type: 'delete', channel }) })
      }
    }
    onContextMenu({ x: e.clientX, y: e.clientY, items })
  }

  const usersIn = (channel: string): VoiceUser[] => [
    ...(c.network === network.id && c.channel === channel
      ? [
          {
            id: state.self.id,
            name: state.self.name,
            voice: { channel, muted: c.muted || !c.local.mic, deafened: c.deafened, camera: !!c.local.camera, screen: !!c.local.screen }
          }
        ]
      : []),
    ...network.peers.filter((p) => p.online && p.voice?.channel === channel)
  ]

  const enterVoice = async (channel: string) => {
    const already = c.network === network.id && c.channel === channel
    if (!already && !(await joinVoice(network.id, channel, state.self.id))) return
    onOpenCall()
  }

  const textChannels = network.channels.filter((ch) => ch.kind === 'text')
  const voiceChannels = network.channels.filter((ch) => ch.kind === 'voice')

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
                props.onInvite()
              }}
            >
              <UserPlusIcon size={16} /> Convidar pessoas
            </button>
            {createItems.map((item) =>
              item === 'separator' ? null : (
                <button
                  key={item.label}
                  onClick={() => {
                    setMenu(false)
                    item.onClick()
                  }}
                >
                  {item.icon} {item.label}
                </button>
              )
            )}
            <button
              className="danger"
              onClick={() => {
                setMenu(false)
                props.onLeave()
              }}
            >
              <LogOutIcon size={16} /> Sair da rede
            </button>
          </div>
        )}
      </div>

      <div className="channels" onContextMenu={(e) => openMenu(e, null)}>
        <div className="channel-group">
          <span>Canais de texto</span>
          <button className="group-add" title="Criar canal de texto" onClick={() => onChannelAction({ type: 'create', kind: 'text' })}>
            <PlusIcon size={16} />
          </button>
        </div>
        {textChannels.map((ch) => (
          <TextChannel
            key={ch.id}
            network={network.id}
            channel={ch}
            active={view === 'chat' && textChannel === ch.id}
            onOpen={() => onOpenText(ch.id)}
            onMenu={(e) => openMenu(e, ch)}
          />
        ))}

        <div className="channel-group">
          <span>Canais de voz</span>
          <button className="group-add" title="Criar canal de voz" onClick={() => onChannelAction({ type: 'create', kind: 'voice' })}>
            <PlusIcon size={16} />
          </button>
        </div>
        {voiceChannels.map((ch) => {
          const here = c.network === network.id && c.channel === ch.id
          return (
            <div key={ch.id}>
              <button
                className={`channel${view === 'call' && here ? ' active' : ''}`}
                onClick={() => void enterVoice(ch.id)}
                onContextMenu={(e) => openMenu(e, ch)}
              >
                <VolumeIcon size={18} /> <span className="ellipsis">{ch.name}</span>
              </button>
              <div className="voice-users">
                {usersIn(ch.id).map((u) => (
                  <div key={u.id} className="voice-user">
                    <Avatar id={u.id} name={u.name} size={24} speaking={here && c.speaking.has(u.id)} />
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
          )
        })}
      </div>

      {c.network && <VoicePanel state={state} onScreen={props.onScreen} onSoundboard={props.onSoundboard} />}
      <UserPanel state={state} onSettings={props.onSettings} />
    </aside>
  )
}

function VoicePanel({ state, onScreen, onSoundboard }: { state: AppState; onScreen(): void; onSoundboard(): void }) {
  const c = useCall()
  const network = state.networks.find((n) => n.id === c.network)
  const channel = network?.channels.find((ch) => ch.id === c.channel)
  const peersInCall = network?.peers.filter((p) => p.online && p.voice?.channel === c.channel) ?? []
  const connecting = peersInCall.some((p) => c.linkState(p.id) !== 'connected')
  return (
    <div className="voice-panel">
      <div className="voice-panel-info">
        <div className={`voice-panel-status${connecting ? ' connecting' : ''}`}>{connecting ? 'Conectando…' : 'Voz conectada'}</div>
        <div className="voice-panel-net ellipsis">
          {channel?.name ?? 'Sala de voz'} / {network?.name}
        </div>
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
        <button className="icon-button" onClick={onSoundboard} title="Soundboard">
          <MusicIcon size={18} />
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
