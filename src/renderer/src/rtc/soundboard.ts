import type { NewSound } from '../../../shared/types'
import { audioOut } from './sounds'

const api = window.gordium

export const MAX_SOUND_SECONDS = 6
/** Trecho mínimo que dá para escolher. */
export const MIN_SOUND_SECONDS = 0.2
/** Dá para recortar de uma música inteira, mas não de um podcast: o áudio todo fica na memória. */
const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_SOURCE_SECONDS = 10 * 60
/** Pico em -1 dBFS: todos os sons com volume parecido, sem estourar. */
const TARGET_PEAK = 0.89
/** Fade nas pontas do trecho: corte no meio da onda dá estalo. */
const EDGE_FADE_S = 0.012

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/** Duração pelo cabeçalho do arquivo, sem decodificar; null se ele não disser. */
function probeDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const audio = new Audio()
    const done = (duration: number | null): void => {
      clearTimeout(timer)
      audio.removeAttribute('src')
      URL.revokeObjectURL(url)
      resolve(duration)
    }
    const timer = setTimeout(() => done(null), 3000)
    audio.preload = 'metadata'
    audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? audio.duration : null)
    audio.onerror = () => done(null)
    audio.src = url
  })
}

const tooLong = (): Error => new Error(`Áudio longo demais (máximo ${MAX_SOURCE_SECONDS / 60} min). Corte um pedaço menor antes.`)

/** Lê um arquivo de áudio (MP3, WAV, OGG…) inteiro, para escolher o trecho. */
export async function decodeAudioFile(file: File): Promise<AudioBuffer> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`Arquivo grande demais (máximo ${MAX_FILE_BYTES / 1024 / 1024} MB).`)
  // Decodificado, cada minuto ocupa ~23 MB: confere a duração antes.
  if (((await probeDuration(file)) ?? 0) > MAX_SOURCE_SECONDS) throw tooLong()
  const ctx = new AudioContext({ sampleRate: 48000 })
  let decoded: AudioBuffer
  try {
    decoded = await ctx.decodeAudioData(await file.arrayBuffer())
  } catch {
    throw new Error('Não consegui ler esse arquivo de áudio. Tente MP3, WAV ou OGG.')
  } finally {
    void ctx.close()
  }
  if (decoded.duration > MAX_SOURCE_SECONDS) throw tooLong()
  return decoded
}

export type Segment = [start: number, end: number]
/** O que mudou no trecho: o início, o fim ou o trecho inteiro (arrastado, com o mesmo tamanho). */
export type SegmentEdit = 'start' | 'end' | 'move'

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi)

/** Aplica uma mudança no trecho e o mantém dentro do áudio, entre 0,2 s e 6 s. */
export function editSegment([s, e]: Segment, duration: number, edit: SegmentEdit, t: number): Segment {
  const max = Math.min(MAX_SOUND_SECONDS, duration)
  const min = Math.min(MIN_SOUND_SECONDS, duration)
  const len = clamp(e - s, min, max)
  if (edit === 'move') {
    const start = clamp(t, 0, duration - len)
    return [start, start + len]
  }
  if (edit === 'start') {
    const start = clamp(t, 0, duration - min)
    // Início passou do fim: o trecho vai junto, com o mesmo tamanho.
    const end = e < start + min ? start + len : e
    return [start, clamp(end, start + min, Math.min(start + max, duration))]
  }
  const end = clamp(t, min, duration)
  const start = s > end - min ? end - len : s
  return [clamp(start, Math.max(0, end - max), end - min), end]
}

/** Trecho inicial: os primeiros 6 s a partir de onde o som começa (pula o silêncio do começo). */
export function suggestSegment(decoded: AudioBuffer): Segment {
  const data = decoded.getChannelData(0)
  const stride = Math.max(1, Math.floor(data.length / 2_000_000))
  let peak = 0
  for (let i = 0; i < data.length; i += stride) peak = Math.max(peak, Math.abs(data[i]))
  let first = 0
  while (first < data.length && Math.abs(data[first]) < peak * 0.05) first++
  const start = Math.max(0, first / decoded.sampleRate - 0.05)
  return editSegment([start, start + MAX_SOUND_SECONDS], decoded.duration, 'start', start)
}

/** Mistura em mono só o trecho escolhido, com o volume normalizado e fade nas pontas. */
function renderSegment(decoded: AudioBuffer, start: number, end: number): Float32Array {
  const rate = decoded.sampleRate
  const from = Math.floor(start * rate)
  const length = Math.max(1, Math.floor((end - start) * rate))
  const mono = new Float32Array(length)
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const data = decoded.getChannelData(c)
    for (let i = 0; i < length; i++) mono[i] += (data[from + i] ?? 0) / decoded.numberOfChannels
  }
  let peak = 0
  for (const v of mono) peak = Math.max(peak, Math.abs(v))
  if (peak < 0.001) throw new Error('Esse trecho está em silêncio.')
  const gain = TARGET_PEAK / peak
  const fade = Math.min(Math.floor(EDGE_FADE_S * rate), Math.floor(length / 4))
  for (let i = 0; i < length; i++) {
    const edge = Math.min(i, length - 1 - i)
    mono[i] *= edge < fade ? gain * (edge / fade) : gain
  }
  return mono
}

/**
 * Prepara o trecho escolhido para o soundboard: mono, volume normalizado e
 * comprimido em Opus. A compressão roda em tempo real (um trecho de 3 s leva
 * 3 s), mas deixa o som com dezenas de KB.
 */
export async function encodeSound(decoded: AudioBuffer, start: number, end: number, name: string, emoji: string): Promise<NewSound> {
  ;[start, end] = editSegment([start, end], decoded.duration, 'start', start)
  const mono = renderSegment(decoded, start, end)
  const ctx = new AudioContext({ sampleRate: decoded.sampleRate })
  try {
    const buffer = ctx.createBuffer(1, mono.length, decoded.sampleRate)
    buffer.copyToChannel(mono as Float32Array<ArrayBuffer>, 0)
    const dest = ctx.createMediaStreamDestination()
    dest.channelCount = 1
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(dest)
    const recorder = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 96_000 })
    const chunks: Blob[] = []
    recorder.ondataavailable = (e) => chunks.push(e.data)
    const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()))
    await ctx.resume()
    recorder.start()
    source.start()
    source.onended = () => setTimeout(() => recorder.stop(), 150)
    await stopped
    return {
      name,
      emoji,
      duration: Math.round((end - start) * 10) / 10,
      mime: 'audio/webm',
      audio: await toBase64(new Blob(chunks, { type: 'audio/webm' }))
    }
  } finally {
    void ctx.close()
  }
}

/** Ouve o trecho antes de adicionar. Devolve como parar e onde está tocando. */
export function previewSegment(
  decoded: AudioBuffer,
  start: number,
  end: number,
  volume: number,
  sinkId: string,
  onEnd: () => void
): { stop(): void; position(): number } {
  const ac = audioOut(sinkId)
  const source = ac.createBufferSource()
  source.buffer = decoded
  const gain = ac.createGain()
  gain.gain.value = volume
  source.connect(gain).connect(ac.destination)
  const startedAt = ac.currentTime
  source.onended = onEnd
  source.start(0, start, end - start)
  return {
    stop: () => {
      source.onended = null
      try {
        source.stop()
      } catch {
        // já tinha acabado
      }
    },
    position: () => Math.min(end, start + (ac.currentTime - startedAt))
  }
}

const decoded = new Map<string, Promise<AudioBuffer>>()

/** Toca um som do soundboard (decodifica uma vez e guarda). */
export async function playSoundboard(network: string, id: string, volume: number, sinkId: string): Promise<void> {
  const ac = audioOut(sinkId)
  const key = `${network}:${id}`
  let buffer = decoded.get(key)
  if (!buffer) {
    buffer = api.getSoundAudio(network, id).then((sound) => {
      if (!sound) throw new Error('som não encontrado')
      const bytes = Uint8Array.from(atob(sound.audio), (c) => c.charCodeAt(0))
      return ac.decodeAudioData(bytes.buffer)
    })
    decoded.set(key, buffer)
    buffer.catch(() => decoded.delete(key))
  }
  const source = ac.createBufferSource()
  source.buffer = await buffer
  const gain = ac.createGain()
  gain.gain.value = volume
  source.connect(gain).connect(ac.destination)
  source.start()
}
