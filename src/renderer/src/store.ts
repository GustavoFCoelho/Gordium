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
const unread = new Map<string, number>()
const chatListeners = new Set<() => void>()
let reading: string | null = null
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
  const others = incoming.filter((m) => m.author !== selfId).length
  if (others > 0 && network !== reading) unread.set(network, (unread.get(network) ?? 0) + others)
  notifyChat()
})

/** Qual rede está com o chat aberto (zera e para de contar as não lidas). */
export function setReading(network: string | null): void {
  reading = network
  if (network && unread.get(network)) {
    unread.delete(network)
    notifyChat()
  }
}

export function useUnread(network: string): number {
  useSyncExternalStore(subscribeChat, () => chatVersion)
  return unread.get(network) ?? 0
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
