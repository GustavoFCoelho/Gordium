import type { WindowTrack } from '../../../shared/types'

const api = window.gordium

/*
 * Transmissão de janela. A captura da própria janela (GDI do Chromium, sem a
 * borda amarela do Windows 10) já mostra o conteúdo dela mesmo com outros apps
 * por cima. O que falta é a janela minimizada: o Windows para de desenhá-la e
 * nenhum método de captura recebe imagem nova. Aqui os quadros passam direto
 * enquanto ela está visível; minimizada, quem assiste vê a última imagem
 * escurecida com um aviso, e a transmissão volta sozinha quando ela é aberta.
 */

// APIs de vídeo do Chromium (Insertable Streams), ainda fora do lib.dom do TypeScript.
interface TrackProcessor {
  readonly readable: ReadableStream<VideoFrame>
}
interface TrackGenerator extends MediaStreamTrack {
  readonly writable: WritableStream<VideoFrame>
}
const chromium = globalThis as unknown as {
  MediaStreamTrackProcessor?: new (init: { track: MediaStreamTrack }) => TrackProcessor
  MediaStreamTrackGenerator?: new (init: { kind: 'video' }) => TrackGenerator
}

export const canProcessVideo =
  typeof chromium.MediaStreamTrackProcessor === 'function' && typeof chromium.MediaStreamTrackGenerator === 'function'

const PAUSED_FRAME_MS = 500
/** Janela fechada: mostra o aviso um tempinho e encerra a transmissão. */
const GONE_STOP_MS = 3000

/** Guarda o último estado da janela; começa a ouvir antes de a captura existir. */
export interface WindowFollower {
  latest(): WindowTrack | null
  stop(): void
}

export function followWindow(): WindowFollower {
  let last: WindowTrack | null = null
  const off = api.onWindowTrack((track) => (last = track))
  return { latest: () => last, stop: off }
}

export interface WindowCapture {
  track: MediaStreamTrack
  stop(): void
}

export function windowCapture(raw: MediaStreamTrack, follow: WindowFollower, onGone: () => void): WindowCapture {
  const processor = new chromium.MediaStreamTrackProcessor!({ track: raw })
  const generator = new chromium.MediaStreamTrackGenerator!({ kind: 'video' })
  const reader = processor.readable.getReader()
  const writer = generator.writable.getWriter()
  const canvas = new OffscreenCanvas(2, 2)
  const ctx = canvas.getContext('2d', { alpha: false })!
  let last: VideoFrame | null = null
  let running = true
  let goneSince = 0

  // Um relógio só para todos os quadros (os de "pausado" são gerados aqui).
  const now = (): number => Math.round(performance.now() * 1000)

  void (async () => {
    while (running) {
      const { value: frame, done } = await reader.read()
      if (done || !frame) break
      if (follow.latest()?.state === 'gone') {
        frame.close()
        continue
      }
      last?.close()
      last = frame.clone()
      // Mesmo conteúdo, sem cópia: só ganha o carimbo de tempo do nosso relógio.
      const out = new VideoFrame(frame, { timestamp: now() })
      frame.close()
      await writer.write(out).catch(() => out.close())
    }
  })().catch(() => {})

  const paused = setInterval(() => {
    const state = follow.latest()?.state
    if (!running || !state || state === 'visible') {
      goneSince = 0
      return
    }
    const w = last?.displayWidth ?? 1280
    const h = last?.displayHeight ?? 720
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    if (last) ctx.drawImage(last, 0, 0, w, h)
    ctx.fillStyle = last ? 'rgba(0, 0, 0, 0.55)' : '#1e1f22'
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#f2f3f5'
    ctx.font = `600 ${Math.max(14, Math.round(h / 20))}px "Segoe UI", sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(state === 'minimized' ? 'Janela minimizada · volta quando ela for aberta' : 'A janela transmitida foi fechada', w / 2, h / 2)
    void writer.write(new VideoFrame(canvas, { timestamp: now() })).catch(() => {})
    if (state === 'gone') {
      goneSince ||= Date.now()
      if (Date.now() - goneSince > GONE_STOP_MS) onGone()
    }
  }, PAUSED_FRAME_MS)

  return {
    track: generator,
    stop: () => {
      if (!running) return
      running = false
      clearInterval(paused)
      follow.stop()
      void api.stopWindowTracking()
      void reader.cancel().catch(() => {})
      last?.close()
      last = null
      raw.stop()
      generator.stop()
    }
  }
}
