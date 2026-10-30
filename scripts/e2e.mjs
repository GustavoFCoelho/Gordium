// Teste ponta a ponta: abre duas instâncias do Gordium (dois usuários, perfis
// separados) e as controla pelo DevTools Protocol, como uma pessoa faria:
// criar rede, entrar com o convite, conversar, entrar na sala de voz, ligar a
// câmera, compartilhar a tela, mutar e sair. Câmera/microfone são os falsos do
// Chromium. Capturas de tela vão para out/e2e/.
//
// Uso: npm run test:e2e   (faz o build antes; precisa de internet)

import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const ROOT = process.cwd()
const SHOTS = join(ROOT, 'out', 'e2e')
mkdirSync(SHOTS, { recursive: true })
const electron = createRequire(import.meta.url)('electron')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a)

function launch(profile, port) {
  rmSync(join(process.env.APPDATA ?? '', `Gordium-${profile}`), { recursive: true, force: true })
  return spawn(electron, ['.', `--remote-debugging-port=${port}`, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], {
    cwd: ROOT,
    env: { ...process.env, GORDIUM_PROFILE: profile },
    stdio: 'ignore'
  })
}

async function connect(name, port) {
  let target
  for (let i = 0; i < 60 && !target; i++) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page')
    } catch {}
    if (!target) await sleep(500)
  }
  if (!target) throw new Error(`${name}: janela não abriu`)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)))
  let seq = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id) {
      pending.get(msg.id)?.(msg)
      pending.delete(msg.id)
    } else if (msg.method === 'Runtime.exceptionThrown') {
      console.log(`  [${name}] exceção:`, msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text)
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
  await send('Runtime.enable')
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? 'erro no evaluate')
    return res.result?.result?.value
  }
  return {
    evaluate,
    /** Escolhe um arquivo num <input type=file>, como o diálogo do Windows faria. */
    setFile: async (selector, path) => {
      const doc = await send('DOM.getDocument', { depth: -1 })
      const found = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector })
      if (!found.result?.nodeId) throw new Error(`não achei ${selector}`)
      await send('DOM.setFileInputFiles', { nodeId: found.result.nodeId, files: [path] })
    },
    shot: async (file) => {
      const res = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(SHOTS, `${file}.png`), Buffer.from(res.result.data, 'base64'))
    },
    until: async (label, expr, ms = 60000) => {
      const start = Date.now()
      while (!(await evaluate(expr).catch(() => false))) {
        if (Date.now() - start > ms) throw new Error(`timeout: ${label}`)
        await sleep(300)
      }
      log(`ok: ${label} (${Date.now() - start} ms)`)
    },
    close: () => ws.close()
  }
}

// --- ações na interface -------------------------------------------------------

const click = (selector, text) =>
  `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => ${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'}); if (!el) throw new Error('não achei ' + ${JSON.stringify(`${selector} ${text ?? ''}`)}); el.click(); return true })()`

/** Preenche um input/textarea controlado pelo React (precisa do setter nativo). */
const fill = (selector, value, enter = false) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('não achei ${selector}'); const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); ${enter ? "el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));" : ''} return true })()`

/**
 * Escuta os sons da sala: registra a nota base (< 1 kHz) de cada oscilador tocado.
 * Entrada = [587, 880] (subindo); saída = [880, 587] (descendo).
 */
const listenCues = `(() => {
  window.__cues = []
  const start = OscillatorNode.prototype.start
  OscillatorNode.prototype.start = function (...args) {
    if (this.frequency.value < 1000) window.__cues.push(Math.round(this.frequency.value))
    return start.apply(this, args)
  }
  return true
})()`
const cuesAre = (list) => `JSON.stringify(window.__cues) === ${JSON.stringify(JSON.stringify(list))}`

const hasText = (selector, text) => `[...document.querySelectorAll(${JSON.stringify(selector)})].some(e => e.textContent.includes(${JSON.stringify(text)}))`

// --- roteiro ------------------------------------------------------------------

/** Clique com o botão direito no elemento (abre o menu de contexto do app). */
const rightClick = (selector, text) =>
  `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => ${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'}); if (!el) throw new Error('não achei ' + ${JSON.stringify(`${selector} ${text ?? ''}`)}); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 10, clientY: r.bottom - 5 })); return true })()`

/** Escuta os sons do soundboard tocados: duração (s) e frequência (Hz, pelos cruzamentos de zero no meio do som). */
const listenSoundboard = `(() => {
  window.__sfx = []
  const start = AudioBufferSourceNode.prototype.start
  AudioBufferSourceNode.prototype.start = function (...args) {
    const b = this.buffer
    let hz = 0
    if (b) {
      const data = b.getChannelData(0)
      const a = Math.floor(data.length * 0.25), z = Math.floor(data.length * 0.75)
      let crossings = 0
      for (let i = a + 1; i < z; i++) if ((data[i - 1] < 0) !== (data[i] < 0)) crossings++
      hz = crossings / 2 / ((z - a) / b.sampleRate)
    }
    window.__sfx.push({ d: b?.duration ?? 0, hz })
    return start.apply(this, args)
  }
  return true
})()`

/** WAV de 10 s para o soundboard: lá 440 Hz nos primeiros 5 s e lá 880 Hz nos últimos 5 s. */
function writeBeep(path) {
  const rate = 48000
  const n = rate * 10
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const hz = i < rate * 5 ? 440 : 880
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 12000), 44 + i * 2)
  }
  writeFileSync(path, buf)
}
const BEEP = join(SHOTS, 'buzina.wav')
writeBeep(BEEP)

/** Quantas pessoas aparecem embaixo de um canal de voz na barra lateral. */
const usersInVoice = (name) =>
  `([...document.querySelectorAll('.channels > div')].find(d => d.querySelector('.channel')?.textContent.includes(${JSON.stringify(name)}))?.querySelectorAll('.voice-user').length ?? -1)`

const procs = [launch('e2ea', 9301), launch('e2eb', 9302)]
let A, B
try {
  A = await connect('Alice', 9301)
  B = await connect('Bruno', 9302)
  await A.until('Alice abriu o app', `!!document.querySelector('.app')`)
  await B.until('Bruno abriu o app', `!!document.querySelector('.app')`)
  await A.evaluate(`window.gordium.setName('Alice')`)
  await B.evaluate(`window.gordium.setName('Bruno')`)
  await A.shot('01-boas-vindas')

  await A.evaluate(click('.button', 'Criar uma rede'))
  await sleep(300)
  await A.evaluate(fill('.modal input', 'Galera do Gordium'))
  await A.evaluate(click('.modal .button', 'Criar rede'))
  await A.until('Alice criou a rede e recebeu o convite', `!!document.querySelector('.copy-field input')`)
  const invite = await A.evaluate(`document.querySelector('.copy-field input').value`)
  await A.shot('02-convite')
  await A.evaluate(click('.modal .button', 'Pronto'))

  await B.evaluate(click('.button', 'Entrar com convite'))
  await sleep(300)
  await B.evaluate(fill('.modal textarea', invite))
  await B.evaluate(click('.modal .button', 'Entrar'))

  await A.until('Alice vê Bruno online', hasText('.member:not(.offline) .member-name', 'Bruno'), 90000)
  await B.until('Bruno vê Alice online', hasText('.member:not(.offline) .member-name', 'Alice'), 90000)

  await A.evaluate(fill('.composer textarea', 'Fala, Bruno! Bora jogar hoje? https://example.com', true))
  await B.until('Bruno recebe a mensagem', hasText('.msg-text', 'Bora jogar'))
  await B.evaluate(fill('.composer textarea', 'Bora! Entra na sala de voz 🎮', true))
  await A.until('Alice recebe a resposta', hasText('.msg-text', 'sala de voz'))
  await A.shot('03-chat')

  // canais criados pelo botão direito
  await A.evaluate(rightClick('.channels'))
  await A.evaluate(click('.context-menu button', 'Criar canal de texto'))
  await A.until('modal de canal aberto pelo botão direito', `!!document.querySelector('.channel-name-input input')`)
  await A.evaluate(fill('.channel-name-input input', 'jogos'))
  await A.evaluate(click('.modal .button', 'Criar canal'))
  await A.until('Alice está no #jogos', `document.querySelector('.topbar-title')?.textContent === 'jogos'`)
  await B.until('Bruno vê o #jogos na lista', hasText('.channel', 'jogos'))
  await B.evaluate(click('.channel', 'jogos'))
  await B.evaluate(fill('.composer textarea', 'Mensagem só no #jogos', true))
  await A.until('Alice recebe a mensagem no #jogos', hasText('.msg-text', 'Mensagem só no #jogos'))
  await A.evaluate(click('.channel', 'geral'))
  await A.until('o #geral não mostra a mensagem do #jogos', `document.querySelector('.topbar-title')?.textContent === 'geral' && !${hasText('.msg-text', 'Mensagem só no #jogos')}`)
  await A.evaluate(rightClick('.channel', 'Sala de voz'))
  await A.evaluate(click('.context-menu button', 'Criar canal de voz'))
  await A.until('modal de canal de voz aberto', `!!document.querySelector('.channel-name-input input')`)
  await A.evaluate(fill('.channel-name-input input', 'Duelo'))
  await A.evaluate(click('.modal .button', 'Criar canal'))
  await B.until('Bruno vê o canal de voz Duelo', hasText('.channel', 'Duelo'))
  await A.shot('03b-canais')

  await A.evaluate(listenCues)
  await B.evaluate(listenCues)
  await A.evaluate(click('.channel', 'Duelo'))
  await A.until('Alice sozinha na sala, com o som de entrada', `document.querySelector('.voice-panel-status')?.textContent === 'Voz conectada' && ${cuesAre([587, 880])}`)
  await B.evaluate(click('.channel', 'Duelo'))
  await A.until('chamada conectada (Alice)', `document.querySelector('.voice-panel-status')?.textContent === 'Voz conectada' && document.querySelectorAll('.tile').length === 2`)
  await B.until('chamada conectada (Bruno)', `document.querySelector('.voice-panel-status')?.textContent === 'Voz conectada'`)
  await A.until('Alice ouve o som de entrada do Bruno', cuesAre([587, 880, 587, 880]), 10000)
  await B.until('Bruno ouve só o próprio som de entrada', cuesAre([587, 880]), 5000)
  // o microfone falso emite um bipe: o indicador de fala do outro lado precisa acender
  await B.until('áudio da Alice chegando no Bruno', `!!document.querySelector('.tile.speaking')`, 20000)
  await A.until('os dois aparecem no Duelo e a Sala de voz está vazia', `${usersInVoice('Duelo')} === 2 && ${usersInVoice('Sala de voz')} === 0`)

  // soundboard: Alice escolhe um arquivo, adiciona e toca; o Bruno precisa ouvir
  await B.evaluate(listenSoundboard)
  await A.evaluate(click('.call-controls .round-button[title="Soundboard"]'))
  await A.until('soundboard aberto', `!!document.querySelector('.soundboard')`)
  await A.evaluate(click('.sound.add'))
  await A.until('modal de som aberto', `!!document.querySelector('.modal input[type=file]')`)
  await A.setFile('.modal input[type=file]', BEEP)
  await A.until('arquivo lido e trecho sugerido (0 a 6 s)', `document.querySelector('.trimmer-length')?.textContent.startsWith('6,00 s')`, 10000)
  // só o pedaço de 6 a 8 s (o tom de 880 Hz) deve virar o som
  await A.evaluate(fill('.trimmer-time:nth-of-type(1) input', '6', true))
  await A.evaluate(fill('.trimmer-time:nth-of-type(2) input', '8', true))
  await A.until('trecho de 6 a 8 s escolhido', `document.querySelector('.trimmer-length')?.textContent.startsWith('2,00 s')`, 5000)
  await A.evaluate(fill('.modal input[placeholder="Nome do som"]', 'Buzina'))
  await A.shot('03b-trecho-do-som')
  await A.evaluate(click('.modal .button', 'Adicionar'))
  await A.until('som preparado e no soundboard', `!document.querySelector('.modal') && ${hasText('.soundboard .sound', 'Buzina')}`, 20000)
  await B.until('o som chega no soundboard do Bruno', `window.gordium.getState().then(s => s.networks[0].sounds.some(x => x.name === 'Buzina'))`)
  await A.shot('04a-soundboard')
  await A.evaluate(click('.soundboard .sound', 'Buzina'))
  await B.until('Bruno ouve só o trecho escolhido (2 s de 880 Hz)', `window.__sfx.some(x => x.d > 1.9 && x.d < 2.6 && Math.abs(x.hz - 880) < 30)`, 10000)
  log('  som tocado no Bruno:', await B.evaluate(`window.__sfx.map(x => x.d.toFixed(2) + ' s, ' + Math.round(x.hz) + ' Hz').join(' | ')`))
  await A.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)

  await A.evaluate(click('.call-controls .round-button[title="Câmera"]'))
  await B.until('Bruno recebe a câmera da Alice', `[...document.querySelectorAll('.tile video')].some(v => v.videoWidth > 0 && !v.paused)`, 30000)

  await B.evaluate(click('.call-controls .round-button[title="Compartilhar tela"]'))
  await B.until('seletor de tela carregou', `document.querySelectorAll('.source').length > 0`, 20000)
  await B.evaluate(click('.modal .button', 'Transmitir'))
  await A.until('Alice recebe a tela do Bruno', `[...document.querySelectorAll('.tile-screen video')].some(v => v.videoWidth > 0)`, 30000)
  log('  resolução da tela recebida:', await A.evaluate(`[...document.querySelectorAll('.tile-screen video')].map(v => v.videoWidth + 'x' + v.videoHeight).join(',')`))
  await sleep(1500)
  await A.shot('04-chamada-alice')
  await B.shot('05-chamada-bruno')

  await B.evaluate(click('.call-controls .round-button[title="Silenciar"]'))
  await A.until('Alice vê o Bruno mutado', `[...document.querySelectorAll('.voice-user')].some(e => e.textContent.includes('Bruno') && e.querySelector('.voice-flags svg'))`, 10000)

  await A.evaluate(click('.call-controls .round-button.hangup'))
  await B.until('Bruno vê a Alice sair', `![...document.querySelectorAll('.tile')].some(t => t.textContent.includes('Alice'))`, 15000)
  await A.until('Alice ouve o próprio som de saída', `JSON.stringify(window.__cues.slice(-2)) === '[880,587]'`, 5000)
  await B.until('Bruno ouve o som de saída da Alice', cuesAre([587, 880, 880, 587]), 10000)
  log(`TUDO OK · capturas em ${SHOTS}`)
} catch (err) {
  console.error('FALHOU:', err.message)
  await A?.shot('erro-alice').catch(() => {})
  await B?.shot('erro-bruno').catch(() => {})
  process.exitCode = 1
} finally {
  A?.close()
  B?.close()
  for (const p of procs) p.kill()
  await sleep(1000)
  for (const profile of ['e2ea', 'e2eb']) rmSync(join(process.env.APPDATA ?? '', `Gordium-${profile}`), { recursive: true, force: true })
  process.exit()
}
