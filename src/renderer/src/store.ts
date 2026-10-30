import { useEffect, useSyncExternalStore } from 'react'
import type { AppState, ChatMessage, UpdateState } from '../../shared/types'

const api = window.gordium

// --- estado geral (vem do processo principal) -------------------------------

let state: AppState | null = null
const stateListeners = new Set<() => void>()

function setState(next: AppState): void {
  state = next
  for (const l of stateListeners) l()
}

api.onState(setState)
void api.getState().then((s) => {
  if (!state) setState(s)
})

export function useAppState(): AppState | null {
  return useSyncExternalStore(
    (l) => {
      stateListeners.add(l)
      return () => stateListeners.delete(l)
    },
    () => state
  )
}

// --- mensagens e não lidas -------------------------------------------------

const EMPTY: ChatMessage[] = []
const messages = new Map<string, ChatMessage[]>()
/** Não lidas por "rede:canal". */
const unread = new Map<string, number>()
const chatListeners = new Set<() => void>()
/** "rede:canal" aberto agora (não conta como não lida). */
let reading: string | null = null
const unreadKey = (network: string, channel: string): string => `${network}:${channel}`
let chatVersion = 0

function notifyChat(): void {
  chatVersion++
  for (const l of chatListeners) l()
}

function merge(list: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const ids = new Set(list.map((m) => m.id))
  const fresh = incoming.filter((m) => !ids.has(m.id))
  if (fresh.length === 0) return list
  return [...list, ...fresh].sort((a, b) => a.ts - b.ts)
}

api.onChat((network, incoming) => {
  const list = messages.get(network)
  if (list) messages.set(network, merge(list, incoming))
  const selfId = state?.self.id
  for (const m of incoming) {
    const key = unreadKey(network, m.channel)
    if (m.author !== selfId && key !== reading) unread.set(key, (unread.get(key) ?? 0) + 1)
  }
  notifyChat()
})

/** Qual canal de texto está aberto (zera e para de contar as não lidas dele). */
export function setReading(network: string | null, channel: string | null): void {
  reading = network && channel ? unreadKey(network, channel) : null
  if (reading && unread.get(reading)) {
    unread.delete(reading)
    notifyChat()
  }
}

/** Não lidas de um canal, ou da rede inteira se o canal não for dado. */
export function useUnread(network: string, channel?: string): number {
  useSyncExternalStore(subscribeChat, () => chatVersion)
  if (channel) return unread.get(unreadKey(network, channel)) ?? 0
  let total = 0
  for (const [key, n] of unread) if (key.startsWith(`${network}:`)) total += n
  return total
}

function subscribeChat(l: () => void): () => void {
  chatListeners.add(l)
  return () => chatListeners.delete(l)
}

export function useMessages(network: string): ChatMessage[] {
  useEffect(() => {
    if (messages.has(network)) return
    void api.getMessages(network).then((list) => {
      messages.set(network, merge(messages.get(network) ?? [], list))
      notifyChat()
    })
  }, [network])
  return useSyncExternalStore(subscribeChat, () => messages.get(network) ?? EMPTY)
}

// --- atualização do app ---------------------------------------------------------

let update: UpdateState | null = null
const updateListeners = new Set<() => void>()

function setUpdate(next: UpdateState): void {
  update = { ...next }
  for (const l of updateListeners) l()
}

api.onUpdate(setUpdate)
void api.getUpdate().then((u) => {
  if (!update) setUpdate(u)
})

export function useUpdate(): UpdateState | null {
  return useSyncExternalStore(
    (l) => {
      updateListeners.add(l)
      return () => updateListeners.delete(l)
    },
    () => update
  )
}

// --- avisos rápidos (toasts) -----------------------------------------------

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
}

let toasts: Toast[] = []
let toastSeq = 0
const toastListeners = new Set<() => void>()

export function toast(text: string, kind: Toast['kind'] = 'info'): void {
  const t = { id: ++toastSeq, text, kind }
  toasts = [...toasts, t]
  for (const l of toastListeners) l()
  setTimeout(() => {
    toasts = toasts.filter((x) => x !== t)
    for (const l of toastListeners) l()
  }, 4000)
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (l) => {
      toastListeners.add(l)
      return () => toastListeners.delete(l)
    },
    () => toasts
  )
}
