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

  await A.evaluate(listenCues)
  await B.evaluate(listenCues)
  await A.evaluate(click('.channel', 'Sala de voz'))
  await A.until('Alice sozinha na sala, com o som de entrada', `document.querySelector('.voice-panel-status')?.textContent === 'Voz conectada' && ${cuesAre([587, 880])}`)
  await B.evaluate(click('.channel', 'Sala de voz'))
  await A.until('chamada conectada (Alice)', `document.querySelector('.voice-panel-status')?.textContent === 'Voz conectada' && document.querySelectorAll('.tile').length === 2`)
  await B.until('chamada conectada (Bruno)', `document.querySelector('.voice-panel-status')?.textContent === 'Voz conectada'`)
  await A.until('Alice ouve o som de entrada do Bruno', cuesAre([587, 880, 587, 880]), 10000)
  await B.until('Bruno ouve só o próprio som de entrada', cuesAre([587, 880]), 5000)
  // o microfone falso emite um bipe: o indicador de fala do outro lado precisa acender
  await B.until('áudio da Alice chegando no Bruno', `!!document.querySelector('.tile.speaking')`, 20000)

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
