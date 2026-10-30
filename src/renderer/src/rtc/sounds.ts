/**
 * Saída de áudio dos efeitos do app: sons curtos da sala de voz (sintetizados,
 * duas notas subindo quando alguém entra, descendo quando alguém sai; mais
 * graves para o atalho de mutar/desmutar) e os sons do soundboard.
 */
export type Cue = 'join' | 'leave' | 'mute' | 'unmute'

const NOTES: Record<Cue, number[]> = {
  join: [587.33, 880], // ré → lá
  leave: [880, 587.33], // lá → ré
  mute: [523.25, 392], // dó → sol
  unmute: [392, 523.25] // sol → dó
}
const VOLUME = 0.16
const NOTE_GAP_S = 0.09
const NOTE_LENGTH_S = 0.22

let ctx: AudioContext | null = null
let ctxSink = ''

/** Contexto de áudio compartilhado, tocando na saída escolhida nas configurações. */
export function audioOut(sinkId = ''): AudioContext {
  ctx ??= new AudioContext()
  const ac = ctx
  if (sinkId !== ctxSink && 'setSinkId' in ac) {
    ctxSink = sinkId
    void (ac as AudioContext & { setSinkId(id: string): Promise<void> }).setSinkId(sinkId).catch(() => {})
  }
  void ac.resume()
  return ac
}

export function playCue(cue: Cue, sinkId = ''): void {
  const ac = audioOut(sinkId)
  const t0 = ac.currentTime + 0.02
  NOTES[cue].forEach((freq, i) => {
    const start = t0 + i * NOTE_GAP_S
    const gain = ac.createGain()
    gain.gain.setValueAtTime(0, start)
    gain.gain.linearRampToValueAtTime(VOLUME, start + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + NOTE_LENGTH_S)
    gain.connect(ac.destination)
    // Uma oitava acima, bem baixinha, deixa o som com cara de "sino" em vez de bipe.
    for (const [mult, level] of [
      [1, 1],
      [2, 0.18]
    ]) {
      const osc = ac.createOscillator()
      const g = ac.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq * mult
      g.gain.value = level
      osc.connect(g).connect(gain)
      osc.start(start)
      osc.stop(start + NOTE_LENGTH_S + 0.02)
    }
  })
}
