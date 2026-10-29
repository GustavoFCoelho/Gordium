import { useEffect, useState } from 'react'
import type { NetworkInfo } from '../../shared/types'
import { CallView } from './components/CallView'
import { ChatView } from './components/ChatView'
import { HashIcon, ShieldIcon, UsersIcon, VolumeIcon } from './components/Icons'
import { MemberList } from './components/MemberList'
import { AddNetworkModal, ConfirmModal, InviteModal, ScreenPickerModal, SettingsModal, UpdateModal } from './components/Modals'
import { ServerRail } from './components/ServerRail'
import { Sidebar, type View } from './components/Sidebar'
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
      <div className="welcome-logo">G</div>
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

function TopBar({ network, view, onSettings }: { network: NetworkInfo; view: View; onSettings(): void }) {
  const state = useAppState()!
  const vpn = state.vpn
  const online = network.peers.filter((p) => p.online).length + 1
  return (
    <header className="topbar">
      <div className="topbar-title">
        {view === 'chat' ? <HashIcon size={20} /> : <VolumeIcon size={20} />}
        <span>{view === 'chat' ? 'geral' : 'Sala de voz'}</span>
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
  const [modal, setModal] = useState<ModalState>(null)
  const update = useUpdate()
  const readyVersion = update?.status === 'ready' ? update.next : null

  useEffect(() => {
    if (readyVersion) toast(`Versão ${readyVersion} pronta: clique no botão verde à esquerda para atualizar.`)
  }, [readyVersion])

  useEffect(() => {
    if (state) call.syncState(state)
  }, [state])

  const network = state?.networks.find((n) => n.id === activeId) ?? state?.networks[0] ?? null
  // Sem chamada nesta rede, a sala de voz não tem o que mostrar.
  const shownView: View = view === 'call' && c.network === network?.id ? 'call' : 'chat'

  useEffect(() => {
    setReading(shownView === 'chat' ? (network?.id ?? null) : null)
  }, [shownView, network?.id])

  if (!state) return <div className="loading">Iniciando o Gordium…</div>

  const select = (id: string) => {
    setActiveId(id)
    localStorage.setItem('gordium.active', id)
    setView(c.network === id ? view : 'chat')
  }

  const modalNetwork = (id: string) => state.networks.find((n) => n.id === id)

  return (
    <div className="app">
      <ServerRail networks={state.networks} active={network?.id ?? null} onSelect={select} onAdd={() => setModal({ type: 'add', tab: 'create' })}
        onUpdate={() => setModal({ type: 'update' })}
      />

      {network ? (
        <>
          <Sidebar
            state={state}
            network={network}
            view={shownView}
            onView={setView}
            onInvite={() => setModal({ type: 'invite', network: network.id })}
            onLeave={() => setModal({ type: 'leave', network: network.id })}
            onSettings={() => setModal({ type: 'settings' })}
            onScreen={() => setModal({ type: 'screen' })}
          />
          <main className="content">
            <TopBar network={network} view={shownView} onSettings={() => setModal({ type: 'settings' })} />
            <div className="content-body">
              {shownView === 'call' ? (
                <CallView state={state} network={network} onScreen={() => setModal({ type: 'screen' })} />
              ) : (
                <ChatView network={network} />
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
      {modal?.type === 'settings' && <SettingsModal state={state} onClose={() => setModal(null)} />}
      {modal?.type === 'screen' && <ScreenPickerModal onClose={() => setModal(null)} />}
      {modal?.type === 'update' && <UpdateModal inCall={c.network !== null} onClose={() => setModal(null)} />}
      <Toasts />
    </div>
  )
}
