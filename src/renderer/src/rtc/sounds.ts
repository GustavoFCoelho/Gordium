/**
 * Sons curtos da sala de voz, sintetizados na hora (sem arquivos de áudio):
 * duas notas subindo quando alguém entra, descendo quando alguém sai.
 */
export type Cue = 'join' | 'leave'

const NOTES: Record<Cue, number[]> = {
  join: [587.33, 880], // ré → lá
  leave: [880, 587.33] // lá → ré
}
const VOLUME = 0.16
const NOTE_GAP_S = 0.09
const NOTE_LENGTH_S = 0.22

let ctx: AudioContext | null = null
let ctxSink = ''

export function playCue(cue: Cue, sinkId = ''): void {
  ctx ??= new AudioContext()
  const ac = ctx
  if (sinkId !== ctxSink && 'setSinkId' in ac) {
    ctxSink = sinkId
    void (ac as AudioContext & { setSinkId(id: string): Promise<void> }).setSinkId(sinkId).catch(() => {})
  }
  void ac.resume()
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
