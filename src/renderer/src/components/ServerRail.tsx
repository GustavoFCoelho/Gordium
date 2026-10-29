import type { NetworkInfo } from '../../../shared/types'
import logo from '../assets/logo.png'
import { useCall } from '../rtc/call'
import { useUnread, useUpdate } from '../store'
import { colorFor, initials } from '../util'
import { DownloadIcon, PlusIcon, VolumeIcon } from './Icons'

interface Props {
  networks: NetworkInfo[]
  active: string | null
  onSelect(id: string): void
  onAdd(): void
  onUpdate(): void
}

function RailItem({ network, active, onSelect }: { network: NetworkInfo; active: boolean; onSelect(): void }) {
  const unread = useUnread(network.id)
  const call = useCall()
  const online = network.peers.filter((p) => p.online).length
  return (
    <div className={`rail-item${active ? ' active' : ''}`}>
      <span className="rail-pill" />
      <button
        className="rail-button"
        style={{ background: active ? colorFor(network.id) : undefined }}
        onClick={onSelect}
        title={`${network.name} · ${online} online`}
      >
        {initials(network.name)}
      </button>
      {unread > 0 && <span className="rail-badge">{unread > 99 ? '99+' : unread}</span>}
      {call.network === network.id && (
        <span className="rail-voice" title="Você está na sala de voz desta rede">
          <VolumeIcon size={10} />
        </span>
      )}
    </div>
  )
}

export function ServerRail({ networks, active, onSelect, onAdd, onUpdate }: Props) {
  const update = useUpdate()
  return (
    <nav className="rail">
      <img className="rail-logo" src={logo} alt="Gordium" title="Gordium" draggable={false} />
      <div className="rail-sep" />
      {networks.map((n) => (
        <RailItem key={n.id} network={n} active={n.id === active} onSelect={() => onSelect(n.id)} />
      ))}
      <button className="rail-button rail-add" onClick={onAdd} title="Criar ou entrar em uma rede">
        <PlusIcon />
      </button>
      {update?.status === 'ready' && (
        <button className="rail-button rail-update" onClick={onUpdate} title={`Atualizar para a versão ${update.next}`}>
          <DownloadIcon />
        </button>
      )}
    </nav>
  )
}
