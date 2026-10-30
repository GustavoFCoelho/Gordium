import { Fragment, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { ChannelInfo, ChatMessage, NetworkInfo } from '../../../shared/types'
import { toast, useMessages } from '../store'
import { errorText, formatDay, formatTime } from '../util'
import { Avatar } from './Avatar'
import { HashIcon } from './Icons'

const GROUP_WINDOW_MS = 5 * 60_000
const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g

function linkify(text: string): ReactNode[] {
  return text.split(URL_RE).map((part, i) =>
    i % 2 === 1 ? (
      <a key={i} href={part} target="_blank" rel="noreferrer">
        {part}
      </a>
    ) : (
      part
    )
  )
}

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString()
}

export function ChatView({ network, channel }: { network: NetworkInfo; channel: ChannelInfo }) {
  const all = useMessages(network.id)
  const messages = useMemo(() => all.filter((m) => m.channel === channel.id), [all, channel.id])
  const [text, setText] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  useLayoutEffect(() => {
    const el = listRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [messages, network.id, channel.id])

  useLayoutEffect(() => {
    stickToBottom.current = true
  }, [network.id, channel.id])

  const send = () => {
    const body = text.trim()
    if (!body) return
    setText('')
    stickToBottom.current = true
    window.gordium.sendChat(network.id, channel.id, body).catch((err) => toast(errorText(err), 'error'))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="chat">
      <div
        className="chat-list"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        <div className="chat-intro">
          <div className="chat-intro-icon">
            <HashIcon size={36} />
          </div>
          <h2>Bem-vindo a #{channel.name}</h2>
          <p>
            Este é o começo do canal <b>#{channel.name}</b> na rede <b>{network.name}</b>. As mensagens vão direto de computador para computador,
            assinadas por quem escreveu, e ficam salvas só nos computadores dos membros.
          </p>
        </div>
        {messages.map((m, i) => {
          const prev: ChatMessage | undefined = messages[i - 1]
          const newDay = !prev || !sameDay(prev.ts, m.ts)
          const grouped = !newDay && prev && prev.author === m.author && m.ts - prev.ts < GROUP_WINDOW_MS
          return (
            <Fragment key={m.id}>
              {newDay && (
                <div className="day-sep">
                  <span>{formatDay(m.ts)}</span>
                </div>
              )}
              {grouped ? (
                <div className="msg grouped">
                  <span className="msg-hover-time">{formatTime(m.ts)}</span>
                  <div className="msg-text">{linkify(m.text)}</div>
                </div>
              ) : (
                <div className="msg">
                  <Avatar id={m.author} name={m.name} size={40} />
                  <div className="msg-body">
                    <div className="msg-head">
                      <span className="msg-author">{m.name}</span>
                      <span className="msg-time">{formatTime(m.ts)}</span>
                    </div>
                    <div className="msg-text">{linkify(m.text)}</div>
                  </div>
                </div>
              )}
            </Fragment>
          )
        })}
      </div>
      <div className="composer">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`Conversar em #${channel.name}`}
          rows={Math.min(8, text.split('\n').length)}
          maxLength={4000}
        />
      </div>
    </div>
  )
}
