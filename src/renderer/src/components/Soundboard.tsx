import { useEffect, useRef } from 'react'
import type { NetworkInfo, SoundInfo } from '../../../shared/types'
import { useCall } from '../rtc/call'
import { toast } from '../store'
import { errorText } from '../util'
import type { MenuState } from './ContextMenu'
import { CloseIcon, HeadphonesIcon, MusicIcon, PlusIcon, TrashIcon } from './Icons'

interface Props {
  network: NetworkInfo
  onClose(): void
  onAdd(): void
  onDelete(sound: SoundInfo): void
  onContextMenu(menu: MenuState): void
}

/** Painel do soundboard: clicar toca para todos na sala; botão direito para ouvir só ou excluir. */
export function Soundboard({ network, onClose, onAdd, onDelete, onContextMenu }: Props) {
  const c = useCall()
  const ref = useRef<HTMLDivElement>(null)
  const inRoom = c.network === network.id

  useEffect(() => {
    const close = (e: MouseEvent) => {
      const target = e.target as Element
      // Cliques no menu do botão direito ou num modal aberto por cima não fecham o painel.
      if (ref.current?.contains(target) || target.closest?.('.context-menu, .modal-backdrop')) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const play = (sound: SoundInfo) => {
    if (!inRoom) return c.previewSound(network.id, sound.id)
    c.playSound(sound.id).catch((err) => toast(errorText(err), 'error'))
  }

  return (
    <div ref={ref} className="soundboard">
      <div className="soundboard-head">
        <MusicIcon size={18} />
        <span className="soundboard-title">Soundboard</span>
        <span className="hint small ellipsis">
          {inRoom ? 'Clique para tocar para todos na sala' : 'Fora de uma sala de voz, você ouve só para você'}
        </span>
        <button className="icon-button" onClick={onClose} title="Fechar">
          <CloseIcon size={16} />
        </button>
      </div>
      <div className="soundboard-grid">
        {network.sounds.map((s) => (
          <button
            key={s.id}
            className="sound"
            title={`${s.name} · ${s.duration.toFixed(1)} s`}
            onClick={() => play(s)}
            onContextMenu={(e) => {
              e.preventDefault()
              onContextMenu({
                x: e.clientX,
                y: e.clientY,
                items: [
                  { label: 'Ouvir só para mim', icon: <HeadphonesIcon size={16} />, onClick: () => c.previewSound(network.id, s.id) },
                  'separator',
                  { label: 'Excluir som', icon: <TrashIcon size={16} />, danger: true, onClick: () => onDelete(s) }
                ]
              })
            }}
          >
            <span className="sound-emoji">{s.emoji || '🔊'}</span>
            <span className="ellipsis">{s.name}</span>
          </button>
        ))}
        <button className="sound add" onClick={onAdd} title="Adicionar som ao soundboard">
          <PlusIcon size={18} />
          <span>Adicionar</span>
        </button>
      </div>
      <label className="soundboard-volume">
        Volume
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={c.settings.soundboardVolume}
          onChange={(e) => void c.setSettings({ soundboardVolume: Number(e.target.value) })}
        />
      </label>
    </div>
  )
}
