import { useState } from 'react'
import { call, MAX_VOLUME, type VolumeKind } from '../rtc/call'
import type { MenuItem } from './ContextMenu'

/** Volume de 0 a 200%; acima de 100% fica destacado. Duplo clique volta a 100%. */
export function VolumeSlider({ value, label, onChange }: { value: number; label: string; onChange(volume: number): void }) {
  const pct = Math.round(value * 100)
  return (
    <span className="volume-slider" title={`${label} · duplo clique volta a 100%`}>
      <input
        type="range"
        min={0}
        max={MAX_VOLUME * 100}
        step={5}
        value={pct}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        onDoubleClick={() => onChange(1)}
      />
      <span className={`volume-value${pct > 100 ? ' boost' : ''}`}>{pct}%</span>
    </span>
  )
}

/** Controle de volume dentro do menu do botão direito (o menu não re-renderiza sozinho). */
export function MenuVolume({ label, get, set }: { label: string; get(): number; set(volume: number): void }) {
  const [value, setValue] = useState(get)
  return (
    <div className="menu-volume">
      <span>{label}</span>
      <VolumeSlider
        value={value}
        label={label}
        onChange={(v) => {
          setValue(v)
          set(v)
        }}
      />
    </div>
  )
}

const slider = (label: string, peer: string, kind: VolumeKind): MenuItem => ({
  label,
  slider: { get: () => call.getVolume(peer, kind), set: (v) => call.setVolume(peer, v, kind) }
})

/** Itens de volume de uma pessoa: a voz e, se ela estiver transmitindo, o áudio da tela. */
export function volumeMenuItems(peer: string, streaming: boolean): MenuItem[] {
  const items: MenuItem[] = [slider('Volume da voz', peer, 'voice')]
  if (streaming) items.push(slider('Volume da transmissão', peer, 'screen'))
  items.push('separator', {
    label: 'Voltar os volumes para 100%',
    onClick: () => {
      call.setVolume(peer, 1, 'voice')
      call.setVolume(peer, 1, 'screen')
    }
  })
  return items
}
