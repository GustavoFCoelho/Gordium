import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from 'react'
import { call } from '../rtc/call'
import { editSegment, MAX_SOUND_SECONDS, previewSegment, type Segment, type SegmentEdit } from '../rtc/soundboard'
import { PlayIcon, StopIcon } from './Icons'

/*
 * Escolha do trecho de um som: a forma de onda com o trecho marcado, alças nas
 * pontas para ajustar e o trecho inteiro arrastável. Em arquivos longos (uma
 * música inteira), a onda de cima mostra só a região em volta do trecho e uma
 * faixa embaixo mostra o arquivo todo: clicar nela leva o trecho até ali.
 */

/** Até essa duração, a onda principal mostra o arquivo inteiro. */
const FULL_VIEW_SECONDS = 20
const WAVE_HEIGHT = 84
const OVERVIEW_HEIGHT = 28
/** Distância (px) até a alça em que o clique pega a alça e não o trecho. */
const HANDLE_GRAB_PX = 8

/** Maior amplitude de cada coluna da onda, entre `from` e `to` segundos. */
function peaks(buffer: AudioBuffer, from: number, to: number, columns: number): Float32Array {
  const out = new Float32Array(columns)
  const rate = buffer.sampleRate
  const first = Math.floor(from * rate)
  const perColumn = Math.max(1, ((to - from) * rate) / columns)
  // Arquivo longo: amostra no máximo ~1500 pontos por coluna, o desenho fica igual.
  const stride = Math.max(1, Math.floor(perColumn / 1500))
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c)
    for (let x = 0; x < columns; x++) {
      const a = first + Math.floor(x * perColumn)
      const b = Math.min(data.length, first + Math.floor((x + 1) * perColumn))
      let peak = out[x]
      for (let i = a; i < b; i += stride) {
        const v = Math.abs(data[i])
        if (v > peak) peak = v
      }
      out[x] = peak
    }
  }
  let max = 0
  for (const v of out) max = Math.max(max, v)
  if (max > 0) for (let x = 0; x < columns; x++) out[x] /= max
  return out
}

function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth)
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return width
}

/** Redesenha o canvas a cada render, na resolução real da tela. */
function useCanvas(canvas: RefObject<HTMLCanvasElement | null>, width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void): void {
  useEffect(() => {
    const el = canvas.current
    if (!el || width === 0) return
    const dpr = window.devicePixelRatio || 1
    if (el.width !== Math.round(width * dpr)) el.width = Math.round(width * dpr)
    if (el.height !== Math.round(height * dpr)) el.height = Math.round(height * dpr)
    const ctx = el.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    draw(ctx)
  })
}

const cssVar = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

function drawWave(ctx: CanvasRenderingContext2D, wave: Float32Array, height: number, colorOf: (x: number) => string): void {
  const mid = height / 2
  for (let x = 0; x < wave.length; x++) {
    const h = Math.max(1, wave[x] * (height - 6))
    ctx.fillStyle = colorOf(x)
    ctx.fillRect(x, mid - h / 2, 1, h)
  }
}

/** Região mostrada na onda principal: o arquivo inteiro ou uma janela em volta do trecho. */
function viewAround([s, e]: Segment, duration: number): Segment {
  if (duration <= FULL_VIEW_SECONDS) return [0, duration]
  const start = Math.min(Math.max(0, (s + e) / 2 - FULL_VIEW_SECONDS / 2), duration - FULL_VIEW_SECONDS)
  return [start, start + FULL_VIEW_SECONDS]
}

/** 3,25 ou, em arquivos de um minuto ou mais, 1:03,25. */
function formatTime(t: number, minutes: boolean): string {
  const text = minutes ? `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}` : t.toFixed(2)
  return text.replace('.', ',')
}

function parseTime(text: string): number | null {
  const parts = text.trim().replace(',', '.').split(':')
  if (parts.length > 2 || parts.some((p) => !/^\d*\.?\d*$/.test(p) || p === '' || p === '.')) return null
  return parts.length === 2 ? Number(parts[0]) * 60 + Number(parts[1]) : Number(parts[0])
}

/** Campo de tempo: aceita o que for digitado e só aplica ao sair do campo ou com Enter. */
function TimeInput({ label, value, minutes, onCommit }: { label: string; value: number; minutes: boolean; onCommit(t: number): void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (): void => {
    const t = draft === null ? null : parseTime(draft)
    setDraft(null)
    if (t !== null) onCommit(t)
  }
  return (
    <label className="trimmer-time">
      {label}
      <input
        inputMode="decimal"
        value={draft ?? formatTime(value, minutes)}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault() // não envia o formulário
          commit()
        }}
      />
    </label>
  )
}

export function AudioTrimmer({ buffer, segment, onChange }: { buffer: AudioBuffer; segment: Segment; onChange(segment: Segment): void }) {
  const waveCanvas = useRef<HTMLCanvasElement>(null)
  const overviewCanvas = useRef<HTMLCanvasElement>(null)
  // As duas ondas têm a largura da caixa (sem o padding): mede a de cima.
  const width = useWidth(waveCanvas)
  const duration = buffer.duration
  const long = duration > FULL_VIEW_SECONDS
  const [view, setView] = useState<Segment>(() => viewAround(segment, duration))
  const [playhead, setPlayhead] = useState<number | null>(null)
  const preview = useRef<{ stop(): void } | null>(null)
  const dragging = useRef(false)
  const [s, e] = segment

  // O trecho saiu da região mostrada (digitado ou levado pela faixa de baixo): a região vai atrás.
  useEffect(() => {
    if (!dragging.current && (s < view[0] || e > view[1])) setView(viewAround([s, e], duration))
  }, [s, e, view, duration])

  const stopPreview = (): void => {
    preview.current?.stop()
    preview.current = null
    setPlayhead(null)
  }
  // Mudou o trecho ou fechou o modal: a prévia para.
  useEffect(() => stopPreview, [s, e, buffer])

  const togglePreview = (): void => {
    if (preview.current) return stopPreview()
    let frame = 0
    const playing = previewSegment(buffer, s, e, call.settings.soundboardVolume, call.settings.outputId, () => {
      cancelAnimationFrame(frame)
      preview.current = null
      setPlayhead(null)
    })
    const tick = (): void => {
      setPlayhead(playing.position())
      frame = requestAnimationFrame(tick)
    }
    tick()
    preview.current = {
      stop: () => {
        cancelAnimationFrame(frame)
        playing.stop()
      }
    }
  }

  const wave = useMemo(() => (width ? peaks(buffer, view[0], view[1], width) : null), [buffer, view, width])
  const overview = useMemo(() => (long && width ? peaks(buffer, 0, duration, width) : null), [buffer, long, duration, width])

  const viewLength = view[1] - view[0]
  const xOf = (t: number): number => ((t - view[0]) / viewLength) * width
  const timeOf = (x: number): number => view[0] + (x / width) * viewLength

  useCanvas(waveCanvas, width, WAVE_HEIGHT, (ctx) => {
    if (!wave) return
    const x0 = xOf(s)
    const x1 = xOf(e)
    const accent = cssVar('--accent')
    const faint = cssVar('--text-faint')
    ctx.fillStyle = 'rgba(88, 101, 242, 0.16)'
    ctx.fillRect(x0, 0, x1 - x0, WAVE_HEIGHT)
    drawWave(ctx, wave, WAVE_HEIGHT, (x) => (x >= x0 && x <= x1 ? accent : faint))
    ctx.fillStyle = cssVar('--text-strong')
    for (const x of [x0, x1]) {
      ctx.fillRect(Math.round(x) - 1, 0, 2, WAVE_HEIGHT)
      ctx.beginPath()
      ctx.roundRect(Math.round(x) - 4, WAVE_HEIGHT / 2 - 12, 8, 24, 3)
      ctx.fill()
    }
    if (playhead !== null && playhead >= view[0] && playhead <= view[1]) {
      ctx.fillStyle = cssVar('--yellow')
      ctx.fillRect(Math.round(xOf(playhead)) - 1, 0, 2, WAVE_HEIGHT)
    }
  })

  useCanvas(overviewCanvas, width, OVERVIEW_HEIGHT, (ctx) => {
    if (!overview) return
    const at = (t: number): number => (t / duration) * width
    ctx.fillStyle = 'rgba(255, 255, 255, 0.06)'
    ctx.fillRect(at(view[0]), 0, at(view[1]) - at(view[0]), OVERVIEW_HEIGHT)
    const accent = cssVar('--accent')
    const faint = cssVar('--text-faint')
    drawWave(ctx, overview, OVERVIEW_HEIGHT, (x) => (x >= at(s) - 1 && x <= at(e) + 1 ? accent : faint))
    ctx.strokeStyle = cssVar('--text-muted')
    ctx.strokeRect(at(view[0]) + 0.5, 0.5, at(view[1]) - at(view[0]) - 1, OVERVIEW_HEIGHT - 1)
  })

  /** O que um clique nesse ponto da onda pega: uma das alças ou o trecho. */
  const grabAt = (x: number): SegmentEdit => {
    const ds = Math.abs(xOf(s) - x)
    const de = Math.abs(xOf(e) - x)
    if (Math.min(ds, de) > HANDLE_GRAB_PX) return 'move'
    return de < ds || (de === ds && x > xOf(e)) ? 'end' : 'start'
  }

  /** Arrasto com o mouse: segue o ponteiro na janela toda até soltar. */
  const drag = (event: ReactPointerEvent, move: (clientX: number) => void): void => {
    event.preventDefault()
    dragging.current = true
    move(event.clientX)
    const onMove = (ev: PointerEvent): void => move(ev.clientX)
    const onUp = (): void => {
      dragging.current = false
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setView((v) => [v[0], v[1]]) // a região vai atrás do trecho, se ele saiu dela
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const onWaveDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const left = event.currentTarget.getBoundingClientRect().left
    const x = event.clientX - left
    const edit = grabAt(x)
    // Dentro do trecho, arrasta a partir do ponto clicado; fora, o trecho começa ali.
    const t = timeOf(x)
    const grab = edit === 'move' && t >= s && t <= e ? t - s : 0
    let current = segment
    drag(event, (clientX) => {
      const at = timeOf(clientX - left)
      // Arrastando, a alça para na outra ponta (só o campo digitado empurra o trecho).
      const value = edit === 'start' ? Math.min(at, current[1]) : edit === 'end' ? Math.max(at, current[0]) : at - grab
      current = editSegment(current, duration, edit, value)
      onChange(current)
    })
  }

  const onWaveHover = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (dragging.current) return
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left
    const t = timeOf(x)
    const edit = grabAt(x)
    event.currentTarget.style.cursor = edit !== 'move' ? 'ew-resize' : t >= s && t <= e ? 'grab' : 'pointer'
  }

  const onOverviewDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const left = event.currentTarget.getBoundingClientRect().left
    let current = segment
    drag(event, (clientX) => {
      const t = ((clientX - left) / width) * duration
      current = editSegment(current, duration, 'move', t - (current[1] - current[0]) / 2)
      setView(viewAround(current, duration))
      onChange(current)
    })
  }

  const minutes = duration >= 60
  return (
    <div className="trimmer">
      <div className="trimmer-box">
        <canvas
          ref={waveCanvas}
          className="trimmer-wave"
          style={{ height: WAVE_HEIGHT }}
          onPointerDown={onWaveDown}
          onPointerMove={onWaveHover}
          title={`Arraste as pontas para escolher o trecho (até ${MAX_SOUND_SECONDS} s) ou o meio para movê-lo`}
        />
        {long && (
          <canvas
            ref={overviewCanvas}
            className="trimmer-overview"
            style={{ height: OVERVIEW_HEIGHT }}
            onPointerDown={onOverviewDown}
            title="O arquivo inteiro: clique ou arraste para levar o trecho até outra parte"
          />
        )}
      </div>
      <div className="trimmer-controls">
        <button type="button" className="button secondary trimmer-play" onClick={togglePreview}>
          {playhead !== null ? <StopIcon size={14} /> : <PlayIcon size={14} />}
          {playhead !== null ? 'Parar' : 'Ouvir trecho'}
        </button>
        <TimeInput label="Início" value={s} minutes={minutes} onCommit={(t) => onChange(editSegment(segment, duration, 'start', t))} />
        <TimeInput label="Fim" value={e} minutes={minutes} onCommit={(t) => onChange(editSegment(segment, duration, 'end', t))} />
        <span className="trimmer-length">
          {formatTime(e - s, false)} s<small>de {formatTime(duration, minutes)}</small>
        </span>
      </div>
    </div>
  )
}
