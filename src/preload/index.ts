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
  sendChat: (network, channel, text) => ipcRenderer.invoke('chat:send', network, channel, text),
  onChat: (cb) => on('chat', cb),

  createChannel: (network, kind, name) => ipcRenderer.invoke('channel:create', network, kind, name),
  renameChannel: (network, id, name) => ipcRenderer.invoke('channel:rename', network, id, name),
  deleteChannel: (network, id) => ipcRenderer.invoke('channel:delete', network, id),

  addSound: (network, sound) => ipcRenderer.invoke('sound:add', network, sound),
  deleteSound: (network, id) => ipcRenderer.invoke('sound:delete', network, id),
  getSoundAudio: (network, id) => ipcRenderer.invoke('sound:audio', network, id),
  playSound: (network, channel, id) => ipcRenderer.invoke('sound:play', network, channel, id),
  onSfx: (cb) => on('sfx', cb),

  createNetwork: (name) => ipcRenderer.invoke('net:create', name),
  joinNetwork: (invite) => ipcRenderer.invoke('net:join', invite),
  leaveNetwork: (id) => ipcRenderer.invoke('net:leave', id),
  setName: (name) => ipcRenderer.invoke('self:name', name),

  setVoice: (network, state) => ipcRenderer.invoke('voice:set', network, state),
  sendSignal: (network, peer, signal) => ipcRenderer.send('rtc:send', network, peer, signal),
  onSignal: (cb) => on('rtc', cb),
  getRelay: () => ipcRenderer.invoke('rtc:relay'),

  getScreenSources: () => ipcRenderer.invoke('screen:sources'),
  selectScreenSource: (id, audio) => ipcRenderer.invoke('screen:select', id, audio),
  onWindowTrack: (cb) => on('screen:window', cb),
  stopWindowTracking: () => ipcRenderer.invoke('screen:stop-tracking'),

  setMuteHotkey: (hotkey) => ipcRenderer.invoke('hotkey:mute', hotkey),
  onMuteHotkey: (cb) => on('hotkey:mute', cb),

  vpnStart: () => ipcRenderer.invoke('vpn:start'),
  vpnStop: () => ipcRenderer.invoke('vpn:stop'),

  getUpdate: () => ipcRenderer.invoke('update:get'),
  onUpdate: (cb) => on('update', cb),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install')
}

contextBridge.exposeInMainWorld('gordium', api)
