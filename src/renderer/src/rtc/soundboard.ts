import type { NewSound } from '../../../shared/types'
import { audioOut } from './sounds'

const api = window.gordium

export const MAX_SOUND_SECONDS = 6
const MAX_FILE_BYTES = 20 * 1024 * 1024
/** Pico em -1 dBFS: todos os sons com volume parecido, sem estourar. */
const TARGET_PEAK = 0.89
const FADE_OUT_S = 0.03

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/**
 * Prepara um arquivo de áudio para o soundboard: mono, até 6 s (com fade se for
 * cortado), volume normalizado e comprimido em Opus. A compressão roda em tempo
 * real (um som de 3 s leva 3 s), mas deixa o som com dezenas de KB.
 */
export async function prepareSound(file: File, name: string, emoji: string): Promise<NewSound> {
  if (file.size > MAX_FILE_BYTES) throw new Error('Arquivo grande demais (máximo 20 MB).')
  const ctx = new AudioContext({ sampleRate: 48000 })
  try {
    let decoded: AudioBuffer
    try {
      decoded = await ctx.decodeAudioData(await file.arrayBuffer())
    } catch {
      throw new Error('Não consegui ler esse arquivo de áudio. Tente MP3, WAV ou OGG.')
    }
    const duration = Math.min(decoded.duration, MAX_SOUND_SECONDS)
    const length = Math.max(1, Math.floor(duration * decoded.sampleRate))
    const mono = new Float32Array(length)
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const data = decoded.getChannelData(c)
      for (let i = 0; i < length; i++) mono[i] += data[i] / decoded.numberOfChannels
    }
    let peak = 0
    for (const v of mono) peak = Math.max(peak, Math.abs(v))
    if (peak < 0.001) throw new Error('Esse arquivo está em silêncio.')
    const gain = TARGET_PEAK / peak
    const fadeFrom = decoded.duration > MAX_SOUND_SECONDS ? length - Math.floor(FADE_OUT_S * decoded.sampleRate) : length
    for (let i = 0; i < length; i++) mono[i] *= i >= fadeFrom ? gain * ((length - i) / (length - fadeFrom)) : gain

    const buffer = ctx.createBuffer(1, length, decoded.sampleRate)
    buffer.copyToChannel(mono, 0)
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
      duration: Math.round(duration * 10) / 10,
      mime: 'audio/webm',
      audio: await toBase64(new Blob(chunks, { type: 'audio/webm' }))
    }
  } finally {
    void ctx.close()
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
