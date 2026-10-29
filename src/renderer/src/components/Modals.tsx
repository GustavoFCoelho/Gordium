import { useEffect, useState, type ReactNode } from 'react'
import type { AppState, NetworkInfo, ScreenSource, UpdateState } from '../../../shared/types'
import { call, SCREEN_QUALITIES, useCall } from '../rtc/call'
import { toast, useUpdate } from '../store'
import { copyText, errorText, formatBytes } from '../util'
import { CloseIcon, CopyIcon, ShieldIcon } from './Icons'

const api = window.gordium

function Modal({ title, onClose, children, wide = false }: { title: string; onClose(): void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={`modal${wide ? ' wide' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} title="Fechar">
            <CloseIcon />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

// --- criar / entrar ---------------------------------------------------------

export function AddNetworkModal({
  initialTab,
  onClose,
  onDone
}: {
  initialTab: 'create' | 'join'
  onClose(): void
  onDone(id: string, created: boolean): void
}) {
  const [tab, setTab] = useState(initialTab)
  const [name, setName] = useState('')
  const [invite, setInvite] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      if (tab === 'create') onDone(await api.createNetwork(name), true)
      else onDone(await api.joinNetwork(invite), false)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={tab === 'create' ? 'Criar uma rede' : 'Entrar em uma rede'} onClose={onClose}>
      <div className="tabs">
        <button className={tab === 'create' ? 'active' : ''} onClick={() => setTab('create')}>
          Criar
        </button>
        <button className={tab === 'join' ? 'active' : ''} onClick={() => setTab('join')}>
          Entrar com convite
        </button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        {tab === 'create' ? (
          <>
            <p className="hint">
              A rede existe só entre os computadores de quem participa: não há servidor. Quem tiver o convite entra, conversa,
              fala na sala de voz e ganha um IP na VPN da rede.
            </p>
            <label>
              Nome da rede
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Galera do fim de semana" maxLength={32} />
            </label>
          </>
        ) : (
          <>
            <p className="hint">Cole o convite que alguém da rede te mandou. Ele começa com “gordium1:”.</p>
            <label>
              Convite
              <textarea autoFocus value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="gordium1:…" rows={3} />
            </label>
          </>
        )}
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="button" disabled={busy || (tab === 'join' && !invite.trim())}>
            {tab === 'create' ? 'Criar rede' : 'Entrar'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function InviteModal({ network, onClose }: { network: NetworkInfo; onClose(): void }) {
  return (
    <Modal title={`Convidar para ${network.name}`} onClose={onClose}>
      <p className="hint">
        Mande este convite para quem você quer na rede. <b>Quem tiver o código entra</b>, então compartilhe só com quem você
        confia.
      </p>
      <div className="copy-field">
        <input readOnly value={network.invite} onFocus={(e) => e.currentTarget.select()} />
        <button className="button" onClick={() => void copyText(network.invite).then(() => toast('Convite copiado'))}>
          <CopyIcon size={16} /> Copiar
        </button>
      </div>
      <div className="modal-actions">
        <button className="button secondary" onClick={onClose}>
          Pronto
        </button>
      </div>
    </Modal>
  )
}

export function ConfirmModal({
  title,
  text,
  confirm,
  onConfirm,
  onClose
}: {
  title: string
  text: ReactNode
  confirm: string
  onConfirm(): void
  onClose(): void
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <p className="hint">{text}</p>
      <div className="modal-actions">
        <button className="button secondary" onClick={onClose}>
          Cancelar
        </button>
        <button
          className="button danger"
          onClick={() => {
            onConfirm()
            onClose()
          }}
        >
          {confirm}
        </button>
      </div>
    </Modal>
  )
}

// --- configurações ------------------------------------------------------------

function useDevices(): MediaDeviceInfo[] {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  useEffect(() => {
    const load = () => void navigator.mediaDevices.enumerateDevices().then(setDevices)
    load()
    navigator.mediaDevices.addEventListener('devicechange', load)
    return () => navigator.mediaDevices.removeEventListener('devicechange', load)
  }, [])
  return devices
}

function DeviceSelect({ kind, value, onChange, devices }: { kind: MediaDeviceKind; value: string; onChange(id: string): void; devices: MediaDeviceInfo[] }) {
  const list = devices.filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications')
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Padrão do sistema</option>
      {list.map((d, i) => (
        <option key={d.deviceId} value={d.deviceId}>
          {d.label || `Dispositivo ${i + 1}`}
        </option>
      ))}
    </select>
  )
}

export function SettingsModal({ state, onClose }: { state: AppState; onClose(): void }) {
  const c = useCall()
  const devices = useDevices()
  const [name, setName] = useState(state.self.name)
  const vpn = state.vpn

  const saveName = () => {
    if (name.trim() && name.trim() !== state.self.name) {
      api.setName(name).then(() => toast('Nome atualizado'), (err) => toast(errorText(err), 'error'))
    }
  }
  const setDevice = (next: Parameters<typeof call.setSettings>[0]) => {
    void c.setSettings(next).then(() => c.error && toast(c.error, 'error'))
  }

  return (
    <Modal title="Configurações" onClose={onClose} wide>
      <section className="settings-section">
        <h3>Perfil</h3>
        <label>
          Seu nome
          <div className="copy-field">
            <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveName()} maxLength={32} />
            <button className="button" onClick={saveName}>
              Salvar
            </button>
          </div>
        </label>
        <div className="hint small">
          Identidade: <code>{state.self.id.slice(0, 16)}…</code> · IP na VPN: <code>{state.self.vip}</code> (o mesmo em todas as redes)
        </div>
      </section>

      <section className="settings-section">
        <h3>Voz e vídeo</h3>
        <div className="settings-grid">
          <label>
            Microfone
            <DeviceSelect kind="audioinput" devices={devices} value={c.settings.micId} onChange={(micId) => setDevice({ micId })} />
          </label>
          <label>
            Saída de áudio
            <DeviceSelect kind="audiooutput" devices={devices} value={c.settings.outputId} onChange={(outputId) => setDevice({ outputId })} />
          </label>
          <label>
            Câmera
            <DeviceSelect kind="videoinput" devices={devices} value={c.settings.camId} onChange={(camId) => setDevice({ camId })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={c.settings.noiseSuppression} onChange={(e) => setDevice({ noiseSuppression: e.target.checked })} />
            Supressão de ruído
          </label>
        </div>
      </section>

      <section className="settings-section">
        <h3>
          <ShieldIcon size={16} /> VPN
        </h3>
        <div className={`vpn-card vpn-${vpn.state}`}>
          <div>
            <div className="vpn-title">
              {vpn.state === 'on' && `Ativa · ${vpn.ip}/16`}
              {vpn.state === 'starting' && 'Ativando… confirme a permissão do Windows'}
              {vpn.state === 'off' && 'Desligada'}
              {vpn.state === 'error' && 'Não foi possível ativar'}
              {vpn.state === 'unsupported' && 'Indisponível neste sistema'}
            </div>
            {vpn.state === 'on' && (
              <div className="hint small">
                Enviado {formatBytes(vpn.sentBytes)} · Recebido {formatBytes(vpn.receivedBytes)} · Os outros membros te acham em{' '}
                <code>{vpn.ip}</code>
              </div>
            )}
            {vpn.error && <div className="hint small">{vpn.error}</div>}
          </div>
          <div className="vpn-actions">
            {vpn.state === 'on' && (
              <button className="button secondary" onClick={() => void api.vpnStop()}>
                Desligar
              </button>
            )}
            {(vpn.state === 'off' || vpn.state === 'error') && (
              <button className="button" onClick={() => void api.vpnStart()}>
                Ativar
              </button>
            )}
          </div>
        </div>
        <p className="hint small">
          Com a VPN ativa, cada membro tem um IP 100.88.x.y e todos se enxergam como numa rede local: dá para jogar em LAN, acessar
          servidores de jogo e compartilhar pastas. O tráfego vai cifrado de ponta a ponta, direto entre os computadores.
        </p>
        <p className="hint small">
          Criar o adaptador de rede exige permissão de administrador, então o Windows pede confirmação ao ativar. Só o processo da
          VPN roda como administrador; o resto do Gordium roda como um programa comum. Depois de ativada, a VPN volta a ligar
          sozinha quando você abrir o app.
        </p>
      </section>

      <AboutSection />
    </Modal>
  )
}

function updateLine(u: UpdateState): string {
  switch (u.status) {
    case 'unsupported':
      return 'Atualizações automáticas só funcionam no app instalado.'
    case 'checking':
      return 'Procurando atualizações…'
    case 'downloading':
      return `Baixando a versão ${u.next}… ${u.progress}%`
    case 'ready':
      return `Versão ${u.next} pronta para instalar.`
    case 'error':
      return `Não foi possível procurar atualizações: ${u.error}`
    default:
      return u.checkedAt ? 'Você está na versão mais recente.' : 'Ainda não procurou atualizações.'
  }
}

function AboutSection() {
  const u = useUpdate()
  if (!u) return null
  return (
    <section className="settings-section">
      <h3>Sobre</h3>
      <div className="vpn-card">
        <div>
          <div className="vpn-title">Gordium {u.current}</div>
          <div className="hint small">{updateLine(u)}</div>
        </div>
        <div className="vpn-actions">
          {u.status === 'ready' ? (
            <button className="button" onClick={() => void api.installUpdate()}>
              Reiniciar e atualizar
            </button>
          ) : (
            <button
              className="button secondary"
              disabled={u.status === 'unsupported' || u.status === 'checking' || u.status === 'downloading'}
              onClick={() => void api.checkForUpdates()}
            >
              Procurar atualizações
            </button>
          )}
        </div>
      </div>
    </section>
  )
}

export function UpdateModal({ inCall, onClose }: { inCall: boolean; onClose(): void }) {
  const u = useUpdate()
  if (!u || u.status !== 'ready') return null
  return (
    <Modal title="Atualização disponível" onClose={onClose}>
      <p className="hint">
        A versão <b>{u.next}</b> já foi baixada (você está na {u.current}). O Gordium fecha, instala e abre de novo
        sozinho em alguns segundos.
      </p>
      {u.notes && (
        <div className="release-notes">
          <div className="release-notes-title">O que mudou</div>
          {u.notes}
        </div>
      )}
      {inCall && <p className="hint small">Você está numa chamada: ela vai cair durante a atualização.</p>}
      <p className="hint small">Se preferir deixar para depois, a atualização é instalada quando você fechar o app.</p>
      <div className="modal-actions">
        <button className="button secondary" onClick={onClose}>
          Depois
        </button>
        <button className="button" onClick={() => void api.installUpdate()}>
          Reiniciar e atualizar
        </button>
      </div>
    </Modal>
  )
}

// --- seletor de tela ------------------------------------------------------------

export function ScreenPickerModal({ onClose }: { onClose(): void }) {
  const [sources, setSources] = useState<ScreenSource[] | null>(null)
  const [kind, setKind] = useState<'screen' | 'window'>('screen')
  const [selected, setSelected] = useState<string | null>(null)
  const [quality, setQuality] = useState(1)
  const [audio, setAudio] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.getScreenSources().then(
      (list) => {
        setSources(list)
        setSelected(list.find((s) => s.kind === 'screen')?.id ?? list[0]?.id ?? null)
      },
      (err) => toast(errorText(err), 'error')
    )
  }, [])

  const start = async () => {
    if (!selected) return
    setBusy(true)
    try {
      await call.startScreen(selected, audio, SCREEN_QUALITIES[quality])
      onClose()
    } catch (err) {
      toast(`Não foi possível compartilhar: ${errorText(err)}`, 'error')
      setBusy(false)
    }
  }

  const list = sources?.filter((s) => s.kind === kind) ?? []
  return (
    <Modal title="Compartilhar tela" onClose={onClose} wide>
      <div className="tabs">
        <button className={kind === 'screen' ? 'active' : ''} onClick={() => setKind('screen')}>
          Telas
        </button>
        <button className={kind === 'window' ? 'active' : ''} onClick={() => setKind('window')}>
          Janelas
        </button>
      </div>
      <div className="source-grid">
        {!sources && <div className="hint">Carregando…</div>}
        {sources && list.length === 0 && <div className="hint">Nada para mostrar aqui.</div>}
        {list.map((s) => (
          <button key={s.id} className={`source${selected === s.id ? ' selected' : ''}`} onClick={() => setSelected(s.id)} onDoubleClick={() => void start()}>
            <img src={s.thumbnail} alt="" />
            <span className="ellipsis">{s.name}</span>
          </button>
        ))}
      </div>
      <div className="screen-options">
        <label>
          Qualidade
          <select value={quality} onChange={(e) => setQuality(Number(e.target.value))}>
            {SCREEN_QUALITIES.map((q, i) => (
              <option key={q.label} value={i}>
                {q.label}
              </option>
            ))}
          </select>
        </label>
        <label className="check" title="Transmite o som dos outros programas (jogo, música, vídeo). As vozes da chamada ficam de fora, então ninguém se ouve em dobro.">
          <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} />
          Transmitir áudio do computador
        </label>
      </div>
      <div className="modal-actions">
        <button className="button secondary" onClick={onClose}>
          Cancelar
        </button>
        <button className="button" disabled={!selected || busy} onClick={() => void start()}>
          Transmitir
        </button>
      </div>
    </Modal>
  )
}
