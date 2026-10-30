import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_TEXT_CHANNEL, type ChannelInfo, type NetworkInfo, type SoundInfo } from '../../shared/types'
import logo from './assets/logo.png'
import { CallView } from './components/CallView'
import { ChatView } from './components/ChatView'
import { ContextMenu, type MenuState } from './components/ContextMenu'
import { HashIcon, ShieldIcon, UsersIcon, VolumeIcon } from './components/Icons'
import { MemberList } from './components/MemberList'
import {
  AddNetworkModal,
  AddSoundModal,
  ChannelModal,
  ConfirmModal,
  InviteModal,
  ScreenPickerModal,
  SettingsModal,
  UpdateModal,
  type ChannelModalMode
} from './components/Modals'
import { ServerRail } from './components/ServerRail'
import { Sidebar, type ChannelAction, type View } from './components/Sidebar'
import { Soundboard } from './components/Soundboard'
import { call, useCall } from './rtc/call'
import { setReading, toast, useAppState, useToasts, useUpdate } from './store'
import { errorText } from './util'

type ModalState =
  | { type: 'add'; tab: 'create' | 'join' }
  | { type: 'invite'; network: string }
  | { type: 'leave'; network: string }
  | { type: 'settings' }
  | { type: 'screen' }
  | { type: 'update' }
  | { type: 'channel'; network: string; mode: ChannelModalMode }
  | { type: 'delete-channel'; network: string; channel: ChannelInfo }
  | { type: 'add-sound'; network: string }
  | { type: 'delete-sound'; network: string; sound: SoundInfo }
  | null

function Toasts() {
  const toasts = useToasts()
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  )
}

function Welcome({ onAdd }: { onAdd(tab: 'create' | 'join'): void }) {
  return (
    <div className="welcome">
      <img className="welcome-logo" src={logo} alt="" draggable={false} />
      <h1>Bem-vindo ao Gordium</h1>
      <p>
        Voz, vídeo, chat e uma VPN entre amigos, sem servidor: cada rede existe só entre os computadores de quem participa.
      </p>
      <div className="welcome-actions">
        <button className="button big" onClick={() => onAdd('create')}>
          Criar uma rede
        </button>
        <button className="button big secondary" onClick={() => onAdd('join')}>
          Entrar com convite
        </button>
      </div>
    </div>
  )
}

function TopBar({ network, title, voice, onSettings }: { network: NetworkInfo; title: string; voice: boolean; onSettings(): void }) {
  const state = useAppState()!
  const vpn = state.vpn
  const online = network.peers.filter((p) => p.online).length + 1
  return (
    <header className="topbar">
      <div className="topbar-title">
        {voice ? <VolumeIcon size={20} /> : <HashIcon size={20} />}
        <span>{title}</span>
      </div>
      <div className="topbar-meta">
        <UsersIcon size={16} /> {online} online
      </div>
      <button className={`vpn-chip vpn-${vpn.state}`} onClick={onSettings} title={vpn.error ?? 'Status da VPN'}>
        <ShieldIcon size={14} />
        {vpn.state === 'on' ? `VPN ${vpn.ip}` : vpn.state === 'starting' ? 'VPN iniciando' : vpn.state === 'unsupported' ? 'Sem VPN' : 'VPN desligada'}
      </button>
    </header>
  )
}

export function App() {
  const state = useAppState()
  const c = useCall()
  const [activeId, setActiveId] = useState<string | null>(() => localStorage.getItem('gordium.active'))
  const [view, setView] = useState<View>('chat')
  /** Canal de texto aberto em cada rede. */
  const [textChannels, setTextChannels] = useState<Record<string, string>>({})
  const [modal, setModal] = useState<ModalState>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [soundboard, setSoundboard] = useState(false)
  const update = useUpdate()
  const readyVersion = update?.status === 'ready' ? update.next : null
  const closeMenu = useCallback(() => setMenu(null), [])
  const closeSoundboard = useCallback(() => setSoundboard(false), [])

  useEffect(() => {
    if (readyVersion) toast(`Versão ${readyVersion} pronta: clique no botão verde à esquerda para atualizar.`)
  }, [readyVersion])

  useEffect(() => {
    if (state) call.syncState(state)
  }, [state])

  const network = state?.networks.find((n) => n.id === activeId) ?? state?.networks[0] ?? null
  // Sem chamada nesta rede, a sala de voz não tem o que mostrar.
  const shownView: View = view === 'call' && c.network === network?.id ? 'call' : 'chat'
  // Canal de texto aberto; se ele foi excluído, volta para o #geral.
  const textChannel =
    network?.channels.find((ch) => ch.kind === 'text' && ch.id === textChannels[network.id]) ??
    network?.channels.find((ch) => ch.id === DEFAULT_TEXT_CHANNEL) ??
    null
  const voiceChannel = network?.channels.find((ch) => ch.id === c.channel)

  useEffect(() => {
    setReading(shownView === 'chat' ? (network?.id ?? null) : null, textChannel?.id ?? null)
  }, [shownView, network?.id, textChannel?.id])

  if (!state) return <div className="loading">Iniciando o Gordium…</div>

  const select = (id: string) => {
    setActiveId(id)
    localStorage.setItem('gordium.active', id)
    setView(c.network === id ? view : 'chat')
  }

  const openText = (channel: string) => {
    if (!network) return
    setTextChannels((prev) => ({ ...prev, [network.id]: channel }))
    setView('chat')
  }

  const onChannelAction = (action: ChannelAction) => {
    if (!network) return
    if (action.type === 'create') setModal({ type: 'channel', network: network.id, mode: { type: 'create', kind: action.kind } })
    else if (action.type === 'rename') setModal({ type: 'channel', network: network.id, mode: { type: 'rename', channel: action.channel } })
    else setModal({ type: 'delete-channel', network: network.id, channel: action.channel })
  }

  const modalNetwork = (id: string) => state.networks.find((n) => n.id === id)
  const soundboardNetwork = state.networks.find((n) => n.id === c.network) ?? network

  return (
    <div className="app">
      <ServerRail
        networks={state.networks}
        active={network?.id ?? null}
        onSelect={select}
        onAdd={() => setModal({ type: 'add', tab: 'create' })}
        onUpdate={() => setModal({ type: 'update' })}
      />

      {network && textChannel ? (
        <>
          <Sidebar
            state={state}
            network={network}
            view={shownView}
            textChannel={textChannel.id}
            onOpenText={openText}
            onOpenCall={() => setView('call')}
            onChannelAction={onChannelAction}
            onContextMenu={setMenu}
            onInvite={() => setModal({ type: 'invite', network: network.id })}
            onLeave={() => setModal({ type: 'leave', network: network.id })}
            onSettings={() => setModal({ type: 'settings' })}
            onScreen={() => setModal({ type: 'screen' })}
            onSoundboard={() => setSoundboard((open) => !open)}
          />
          <main className="content">
            <TopBar
              network={network}
              title={shownView === 'call' ? (voiceChannel?.name ?? 'Sala de voz') : textChannel.name}
              voice={shownView === 'call'}
              onSettings={() => setModal({ type: 'settings' })}
            />
            <div className="content-body">
              {shownView === 'call' ? (
                <CallView
                  state={state}
                  network={network}
                  onScreen={() => setModal({ type: 'screen' })}
                  onSoundboard={() => setSoundboard((open) => !open)}
                />
              ) : (
                <ChatView network={network} channel={textChannel} />
              )}
              <MemberList state={state} network={network} />
            </div>
          </main>
        </>
      ) : (
        <main className="content">
          <Welcome onAdd={(tab) => setModal({ type: 'add', tab })} />
        </main>
      )}

      {soundboard && soundboardNetwork && (
        <Soundboard
          network={soundboardNetwork}
          onClose={closeSoundboard}
          onAdd={() => setModal({ type: 'add-sound', network: soundboardNetwork.id })}
          onDelete={(sound) => setModal({ type: 'delete-sound', network: soundboardNetwork.id, sound })}
          onContextMenu={setMenu}
        />
      )}
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}

      {modal?.type === 'add' && (
        <AddNetworkModal
          initialTab={modal.tab}
          onClose={() => setModal(null)}
          onDone={(id, created) => {
            select(id)
            setModal(created ? { type: 'invite', network: id } : null)
            if (!created) toast('Entrou na rede. Procurando os outros membros…')
          }}
        />
      )}
      {modal?.type === 'invite' && modalNetwork(modal.network) && (
        <InviteModal network={modalNetwork(modal.network)!} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'leave' && modalNetwork(modal.network) && (
        <ConfirmModal
          title={`Sair de ${modalNetwork(modal.network)!.name}?`}
          text="O histórico do chat desta rede será apagado deste computador. Para voltar, você vai precisar de um convite de novo."
          confirm="Sair da rede"
          onClose={() => setModal(null)}
          onConfirm={() => {
            const id = modal.network
            if (c.network === id) void c.leave()
            window.gordium.leaveNetwork(id).catch((err) => toast(errorText(err), 'error'))
          }}
        />
      )}
      {modal?.type === 'channel' && modalNetwork(modal.network) && (
        <ChannelModal
          network={modalNetwork(modal.network)!}
          mode={modal.mode}
          onClose={() => setModal(null)}
          onDone={(id, kind) => {
            setModal(null)
            if (modal.mode.type === 'create' && kind === 'text') openText(id)
          }}
        />
      )}
      {modal?.type === 'delete-channel' && (
        <ConfirmModal
          title={`Excluir ${modal.channel.kind === 'text' ? '#' : ''}${modal.channel.name}?`}
          text={
            modal.channel.kind === 'text'
              ? 'O canal some para todos da rede, junto com as mensagens dele.'
              : 'O canal de voz some para todos da rede; quem estiver nele sai da chamada.'
          }
          confirm="Excluir canal"
          onClose={() => setModal(null)}
          onConfirm={() => window.gordium.deleteChannel(modal.network, modal.channel.id).catch((err) => toast(errorText(err), 'error'))}
        />
      )}
      {modal?.type === 'add-sound' && modalNetwork(modal.network) && (
        <AddSoundModal network={modalNetwork(modal.network)!} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'delete-sound' && (
        <ConfirmModal
          title={`Excluir o som "${modal.sound.name}"?`}
          text="O som sai do soundboard de todos da rede."
          confirm="Excluir som"
          onClose={() => setModal(null)}
          onConfirm={() => window.gordium.deleteSound(modal.network, modal.sound.id).catch((err) => toast(errorText(err), 'error'))}
        />
      )}
      {modal?.type === 'settings' && <SettingsModal state={state} onClose={() => setModal(null)} />}
      {modal?.type === 'screen' && <ScreenPickerModal onClose={() => setModal(null)} />}
      {modal?.type === 'update' && <UpdateModal inCall={c.network !== null} onClose={() => setModal(null)} />}
      <Toasts />
    </div>
  )
}
