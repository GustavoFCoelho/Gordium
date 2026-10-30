import { useEffect, useRef, useState } from 'react'
import type { AppState, NetworkInfo, VoiceState } from '../../../shared/types'
import { useCall } from '../rtc/call'
import { Avatar } from './Avatar'
import {
  HeadphonesIcon,
  HeadphonesOffIcon,
  MaximizeIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  ScreenIcon,
  VideoIcon,
  VideoOffIcon,
  MusicIcon
} from './Icons'
import { toggleCamera } from './Sidebar'

interface Tile {
  key: string
  id: string
  name: string
  kind: 'user' | 'screen'
  self: boolean
  track: MediaStreamTrack | null
  voice: VoiceState | null
  state: RTCPeerConnectionState | null
}

function Video({ track, mirror, contain }: { track: MediaStreamTrack; mirror: boolean; contain: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    v.srcObject = new MediaStream([track])
    void v.play().catch(() => {})
    return () => {
      v.srcObject = null
    }
  }, [track])
  return <video ref={ref} autoPlay playsInline muted className={`${mirror ? 'mirror' : ''} ${contain ? 'contain' : ''}`} />
}

function TileView({ tile, focused, onFocus }: { tile: Tile; focused: boolean; onFocus(): void }) {
  const c = useCall()
  const ref = useRef<HTMLDivElement>(null)
  const speaking = tile.kind === 'user' && c.speaking.has(tile.id)
  const connecting = !tile.self && tile.state !== 'connected'
  return (
    <div
      ref={ref}
      className={`tile tile-${tile.kind}${speaking ? ' speaking' : ''}${focused ? ' focused' : ''}`}
      onClick={onFocus}
      title={tile.kind === 'screen' ? 'Clique para destacar · tela cheia no canto' : undefined}
    >
      {tile.track ? (
        <Video track={tile.track} mirror={tile.self && tile.kind === 'user'} contain={tile.kind === 'screen'} />
      ) : (
        <div className="tile-avatar">
          <Avatar id={tile.id} name={tile.name} size={88} speaking={speaking} />
        </div>
      )}
      <div className="tile-label">
        {tile.kind === 'user' && tile.voice?.deafened && <HeadphonesOffIcon size={14} />}
        {tile.kind === 'user' && !tile.voice?.deafened && tile.voice?.muted && <MicOffIcon size={14} />}
        {tile.kind === 'screen' && <ScreenIcon size={14} />}
        <span className="ellipsis">
          {tile.name}
          {tile.kind === 'screen' ? ' · tela' : ''}
        </span>
      </div>
      {connecting && <div className="tile-status">{tile.state === 'failed' ? 'Sem conexão, tentando de novo…' : 'Conectando…'}</div>}
      <div className="tile-actions" onClick={(e) => e.stopPropagation()}>
        {!tile.self && tile.kind === 'user' && (
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={c.getVolume(tile.id)}
            onChange={(e) => c.setVolume(tile.id, Number(e.target.value))}
            title={`Volume de ${tile.name}`}
          />
        )}
        <button className="icon-button" title="Tela cheia" onClick={() => void ref.current?.requestFullscreen()}>
          <MaximizeIcon size={16} />
        </button>
      </div>
    </div>
  )
}

export function CallView({
  state,
  network,
  onScreen,
  onSoundboard
}: {
  state: AppState
  network: NetworkInfo
  onScreen(): void
  onSoundboard(): void
}) {
  const c = useCall()
  const [focus, setFocus] = useState<string | null>(null)

  const selfVoice: VoiceState = {
    channel: c.channel ?? '',
    muted: c.muted || !c.local.mic,
    deafened: c.deafened,
    camera: !!c.local.camera,
    screen: !!c.local.screen
  }
  const people = [
    { id: state.self.id, name: state.self.name, voice: selfVoice, self: true },
    ...network.peers
      .filter((p) => p.online && p.voice?.channel === c.channel)
      .map((p) => ({ id: p.id, name: p.name, voice: p.voice, self: false }))
  ]

  const tiles: Tile[] = []
  for (const p of people) {
    const linkState = p.self ? null : c.linkState(p.id)
    if (p.voice?.screen) {
      tiles.push({
        key: `${p.id}:screen`,
        id: p.id,
        name: p.name,
        kind: 'screen',
        self: p.self,
        track: p.self ? c.local.screen : c.remoteTrack(p.id, 'screen'),
        voice: p.voice,
        state: linkState
      })
    }
    tiles.push({
      key: `${p.id}:user`,
      id: p.id,
      name: p.name,
      kind: 'user',
      self: p.self,
      track: p.voice?.camera ? (p.self ? c.local.camera : c.remoteTrack(p.id, 'camera')) : null,
      voice: p.voice,
      state: linkState
    })
  }

  const focused = tiles.find((t) => t.key === focus) ?? null
  const others = focused ? tiles.filter((t) => t !== focused) : tiles

  return (
    <div className="call">
      <div className={`call-stage${focused ? ' has-focus' : ''}`}>
        {focused && (
          <div className="call-focus">
            <TileView tile={focused} focused onFocus={() => setFocus(null)} />
          </div>
        )}
        <div className={focused ? 'call-strip' : `call-grid n${Math.min(others.length, 9)}`}>
          {others.map((t) => (
            <TileView key={t.key} tile={t} focused={false} onFocus={() => setFocus(t.key)} />
          ))}
        </div>
      </div>
      <div className="call-controls">
        <button
          className={`round-button${c.muted || c.deafened ? ' off' : ''}`}
          onClick={() => c.setMuted(!c.muted)}
          title={c.muteTitle}
        >
          {c.muted || c.deafened ? <MicOffIcon /> : <MicIcon />}
        </button>
        <button
          className={`round-button${c.deafened ? ' off' : ''}`}
          onClick={() => c.setDeafened(!c.deafened)}
          title={c.deafened ? 'Ativar áudio' : 'Ensurdecer'}
        >
          {c.deafened ? <HeadphonesOffIcon /> : <HeadphonesIcon />}
        </button>
        <button className={`round-button${c.local.camera ? ' on' : ''}`} onClick={() => void toggleCamera()} title="Câmera">
          {c.local.camera ? <VideoIcon /> : <VideoOffIcon />}
        </button>
        <button
          className={`round-button${c.local.screen ? ' on' : ''}`}
          onClick={() => (c.local.screen ? void c.stopScreen() : onScreen())}
          title={c.local.screen ? 'Parar transmissão' : 'Compartilhar tela'}
        >
          <ScreenIcon />
        </button>
        <button className="round-button" onClick={onSoundboard} title="Soundboard">
          <MusicIcon />
        </button>
        <button className="round-button hangup" onClick={() => void c.leave()} title="Desconectar">
          <PhoneOffIcon />
        </button>
      </div>
    </div>
  )
}
