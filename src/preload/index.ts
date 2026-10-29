import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { GordiumApi } from './api'

function on<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: GordiumApi = {
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (cb) => on('state', cb),

  getMessages: (network) => ipcRenderer.invoke('chat:list', network),
  sendChat: (network, text) => ipcRenderer.invoke('chat:send', network, text),
  onChat: (cb) => on('chat', cb),

  createNetwork: (name) => ipcRenderer.invoke('net:create', name),
  joinNetwork: (invite) => ipcRenderer.invoke('net:join', invite),
  leaveNetwork: (id) => ipcRenderer.invoke('net:leave', id),
  setName: (name) => ipcRenderer.invoke('self:name', name),

  setVoice: (network, state) => ipcRenderer.invoke('voice:set', network, state),
  sendSignal: (network, peer, signal) => ipcRenderer.send('rtc:send', network, peer, signal),
  onSignal: (cb) => on('rtc', cb),

  getScreenSources: () => ipcRenderer.invoke('screen:sources'),
  selectScreenSource: (id, audio) => ipcRenderer.invoke('screen:select', id, audio),

  vpnStart: () => ipcRenderer.invoke('vpn:start'),
  vpnStop: () => ipcRenderer.invoke('vpn:stop'),
  vpnElevate: () => ipcRenderer.invoke('vpn:elevate'),

  getUpdate: () => ipcRenderer.invoke('update:get'),
  onUpdate: (cb) => on('update', cb),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install')
}

contextBridge.exposeInMainWorld('gordium', api)
