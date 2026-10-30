import type { WindowTrack } from '../../../shared/types'

const api = window.gordium

/*
 * Captura própria de janela. O Chromium captura janelas de outros programas de
 * um jeito frágil (falha sem foco, coberta ou minimizada) ou desenhando a borda
 * amarela do Windows 10. Aqui o app captura o monitor em que a janela está, o
 * método confiável, e recorta cada quadro só na área dela, seguindo a posição que
 * o processo principal manda. O que estiver por cima da janela sai preto, para
 * não vazar outras janelas; minimizada, vai um quadro de "pausado".
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

export const canCropWindows =
  typeof chromium.MediaStreamTrackProcessor === 'function' && typeof chromium.MediaStreamTrackGenerator === 'function'

const PAUSED_FRAME_MS = 500
/** Janela fechada: mostra o aviso um tempinho e encerra a transmissão. */
const GONE_STOP_MS = 3000

/** Guarda a última posição da janela; começa a ouvir antes de a captura existir. */
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

export function cropWindow(raw: MediaStreamTrack, follow: WindowFollower, maxWidth: number, maxHeight: number, onGone: () => void): WindowCapture {
  const processor = new chromium.MediaStreamTrackProcessor!({ track: raw })
  const generator = new chromium.MediaStreamTrackGenerator!({ kind: 'video' })
  const reader = processor.readable.getReader()
  const writer = generator.writable.getWriter()
  const canvas = new OffscreenCanvas(2, 2)
  const ctx = canvas.getContext('2d', { alpha: false })!
  let running = true
  let goneSince = 0

  const emit = (): void => {
    void writer.write(new VideoFrame(canvas, { timestamp: Math.round(performance.now() * 1000) })).catch(() => {})
  }

  /** Tamanho de saída: cabe na qualidade escolhida, mantendo a proporção, em números pares. */
  const sizeFor = (w: number, h: number): void => {
    const k = Math.min(1, maxWidth / w, maxHeight / h)
    const ow = Math.max(2, Math.round((w * k) / 2) * 2)
    const oh = Math.max(2, Math.round((h * k) / 2) * 2)
    if (canvas.width !== ow || canvas.height !== oh) {
      canvas.width = ow
      canvas.height = oh
    }
  }

  void (async () => {
    while (running) {
      const { value: frame, done } = await reader.read()
      if (done || !frame) break
      try {
        const t = follow.latest()
        if (!t || t.state !== 'visible') continue // o quadro de "pausado" cuida disso
        // Recorte preso aos limites do monitor (janela parcialmente fora dele).
        const x0 = Math.max(0, t.x)
        const y0 = Math.max(0, t.y)
        const x1 = Math.min(t.monitorWidth, t.x + t.width)
        const y1 = Math.min(t.monitorHeight, t.y + t.height)
        if (x1 <= x0 || y1 <= y0) continue
        // O quadro pode vir em escala diferente dos pixels físicos do monitor.
        const fx = frame.displayWidth / t.monitorWidth
        const fy = frame.displayHeight / t.monitorHeight
        sizeFor(x1 - x0, y1 - y0)
        ctx.drawImage(frame, x0 * fx, y0 * fy, (x1 - x0) * fx, (y1 - y0) * fy, 0, 0, canvas.width, canvas.height)
        const kx = canvas.width / (x1 - x0)
        const ky = canvas.height / (y1 - y0)
        ctx.fillStyle = '#000'
        for (const c of t.covered) ctx.fillRect((t.x + c.x - x0) * kx, (t.y + c.y - y0) * ky, c.width * kx, c.height * ky)
        emit()
      } finally {
        frame.close()
      }
    }
  })().catch(() => {})

  const paused = setInterval(() => {
    const t = follow.latest()
    if (!running || !t || t.state === 'visible') {
      goneSince = 0
      return
    }
    if (canvas.width < 64) sizeFor(Math.min(1280, maxWidth), Math.min(720, maxHeight))
    ctx.fillStyle = '#1e1f22'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#dbdee1'
    ctx.font = `600 ${Math.max(14, Math.round(canvas.height / 20))}px "Segoe UI", sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(
      t.state === 'minimized' ? 'Janela minimizada · transmissão pausada' : 'A janela transmitida foi fechada',
      canvas.width / 2,
      canvas.height / 2
    )
    emit()
    if (t.state === 'gone') {
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
      raw.stop()
      generator.stop()
    }
  }
}
