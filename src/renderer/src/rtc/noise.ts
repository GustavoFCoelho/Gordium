import { GtcrnWorkletNode, loadGtcrn } from '@sapphi-red/web-noise-suppressor'
import gtcrnWorklet from '@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url'
import gtcrnWasm from '@sapphi-red/web-noise-suppressor/gtcrn.wasm?url'

/*
 * Supressão de ruído do microfone.
 * - 'ai': GTCRN, uma rede neural pequena de melhoria de fala, rodando aqui
 *   mesmo num AudioWorklet (nada sai do computador para ser processado).
 *   Medido com fala em português misturada a ruído (+5 dB de voz sobre o
 *   ruído), a qualidade da voz (SI-SDR) foi de 4,8 dB para 12–20 dB; com voz
 *   limpa, ela passa praticamente intacta (31 dB). O RNNoise, mais conhecido,
 *   deu 9–11 dB e distorce até voz limpa (12 dB). Custa ~4% de um núcleo e
 *   atrasa ~30 ms.
 * - 'browser': a supressão do próprio WebRTC, que só tira chiado constante.
 * - 'off': o microfone como vem.
 */
export type NoiseMode = 'ai' | 'browser' | 'off'

export const NOISE_MODES: { value: NoiseMode; label: string; hint: string }[] = [
  { value: 'ai', label: 'Forte (IA)', hint: 'Tira teclado, ventilador, barulho de rua e de casa.' },
  { value: 'browser', label: 'Leve', hint: 'Tira só chiado constante, como o de ventilador.' },
  { value: 'off', label: 'Desligada', hint: 'O microfone como ele é.' }
]

export const isNoiseMode = (v: unknown): v is NoiseMode => v === 'ai' || v === 'browser' || v === 'off'

/** 48 kHz: a voz inteira, sem cortar os agudos (o GTCRN tem um modo próprio para 48 kHz). */
const SAMPLE_RATE = 48000

let wasm: Promise<ArrayBuffer> | null = null

export interface Denoised {
  track: MediaStreamTrack
  /** Para tudo: o processamento e o microfone. */
  close(): void
}

/** Passa o microfone pela supressão por IA e devolve a trilha já limpa. */
export async function denoise(raw: MediaStreamTrack): Promise<Denoised> {
  wasm ??= loadGtcrn({ url: gtcrnWasm }).catch((err) => {
    wasm = null
    throw err
  })
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
  try {
    const [wasmBinary] = await Promise.all([wasm, ctx.audioWorklet.addModule(gtcrnWorklet)])
    const source = ctx.createMediaStreamSource(new MediaStream([raw]))
    const node = new GtcrnWorkletNode(ctx, { wasmBinary, maxChannels: 1 })
    // Voz é mono: microfone estéreo é misturado antes, para não processar dois canais.
    node.channelCount = 1
    node.channelCountMode = 'explicit'
    const out = ctx.createMediaStreamDestination()
    out.channelCount = 1
    source.connect(node).connect(out)
    await ctx.resume()
    const track = out.stream.getAudioTracks()[0]
    return {
      track,
      close: () => {
        track.stop()
        raw.stop()
        source.disconnect()
        node.destroy()
        void ctx.close()
      }
    }
  } catch (err) {
    void ctx.close()
    throw err
  }
}
