import type { AppState, NetworkInfo, PeerInfo } from '../../../shared/types'
import { toast } from '../store'
import { copyText, formatAgo } from '../util'
import { Avatar } from './Avatar'
import { MicOffIcon, ScreenIcon, VideoIcon, VolumeIcon } from './Icons'

function copyIp(ip: string): void {
  void copyText(ip).then(() => toast(`IP ${ip} copiado`))
}

function Member({ peer }: { peer: PeerInfo }) {
  return (
    <div className={`member${peer.online ? '' : ' offline'}`} title={peer.remote ? `Conexão direta com ${peer.remote}` : undefined}>
      <Avatar id={peer.id} name={peer.name} size={32} status={peer.online ? 'online' : 'offline'} />
      <div className="member-info">
        <div className="member-name ellipsis">
          {peer.name}
          {peer.voice && (
            <span className="member-flags">
              <VolumeIcon size={13} />
              {peer.voice.muted && <MicOffIcon size={13} />}
              {peer.voice.camera && <VideoIcon size={13} />}
              {peer.voice.screen && <ScreenIcon size={13} />}
            </span>
          )}
        </div>
        <div className="member-sub">
          <button className="ip" onClick={() => copyIp(peer.vip)} title="Copiar IP da VPN">
            {peer.vip}
          </button>
          {peer.online ? peer.rtt !== null && <span className="rtt">{peer.rtt} ms</span> : <span>{formatAgo(peer.lastSeen)}</span>}
        </div>
      </div>
    </div>
  )
}

export function MemberList({ state, network }: { state: AppState; network: NetworkInfo }) {
  const online = network.peers.filter((p) => p.online).sort((a, b) => a.name.localeCompare(b.name))
  const offline = network.peers.filter((p) => !p.online).sort((a, b) => b.lastSeen - a.lastSeen)
  return (
    <aside className="members">
      <div className="members-group">Online — {online.length + 1}</div>
      <div className="member">
        <Avatar id={state.self.id} name={state.self.name} size={32} status="online" />
        <div className="member-info">
          <div className="member-name ellipsis">
            {state.self.name} <span className="you">você</span>
          </div>
          <div className="member-sub">
            <button className="ip" onClick={() => copyIp(state.self.vip)} title="Copiar seu IP da VPN">
              {state.self.vip}
            </button>
          </div>
        </div>
      </div>
      {online.map((p) => (
        <Member key={p.id} peer={p} />
      ))}
      {offline.length > 0 && <div className="members-group">Offline — {offline.length}</div>}
      {offline.map((p) => (
        <Member key={p.id} peer={p} />
      ))}
      {network.peers.length === 0 && (
        <div className="members-empty">
          {network.discovering ? 'Procurando membros na rede…' : 'Ninguém mais por aqui ainda. Use “Convidar pessoas” no menu da rede.'}
        </div>
      )}
    </aside>
  )
}
