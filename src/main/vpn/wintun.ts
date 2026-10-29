import koffi from 'koffi'

/** Ponteiros e handles nativos chegam do koffi como BigInt (ou null). */
type Ptr = bigint | null

export interface Guid {
  Data1: number
  Data2: number
  Data3: number
  Data4: number[]
}

export interface WintunApi {
  createAdapter(name: string, tunnelType: string, guid: Guid): Ptr
  closeAdapter(adapter: Ptr): void
  getAdapterLuid(adapter: Ptr, out: [bigint | number]): void
  driverVersion(): number
  startSession(adapter: Ptr, capacity: number): Ptr
  endSession(session: Ptr): void
  readWaitEvent(session: Ptr): Ptr
  receivePacket(session: Ptr, size: [number]): Ptr
  releaseReceivePacket(session: Ptr, packet: Ptr): void
  allocateSendPacket(session: Ptr, size: number): Ptr
  sendPacket(session: Ptr, packet: Ptr): void
  /** Copia memória: aceita Buffer ou ponteiro nativo nos dois lados. */
  copy(dst: Buffer | Ptr, src: Buffer | Ptr, len: number): void
  lastError(): number
  /** Espera o evento numa thread de trabalho do koffi, sem travar o event loop. */
  wait(handle: Ptr, ms: number): Promise<number>
  luidToIndex(luid: bigint | number): number | null
}

export const ERROR_NO_MORE_ITEMS = 259
export const ERROR_HANDLE_EOF = 38

let api: WintunApi | null = null

/** Carrega o wintun.dll uma vez só (o koffi não permite redefinir tipos com o mesmo nome). */
export function loadWintun(dllPath: string): WintunApi {
  if (api) return api

  const lib = koffi.load(dllPath)
  const k32 = koffi.load('kernel32.dll')
  const iphlp = koffi.load('iphlpapi.dll')

  koffi.struct('GORDIUM_GUID', {
    Data1: 'uint32_t',
    Data2: 'uint16_t',
    Data3: 'uint16_t',
    Data4: koffi.array('uint8_t', 8)
  })

  const CreateAdapter = lib.func(
    'void * __stdcall WintunCreateAdapter(const char16_t *Name, const char16_t *TunnelType, const GORDIUM_GUID *RequestedGUID)'
  )
  const CloseAdapter = lib.func('void __stdcall WintunCloseAdapter(void *Adapter)')
  const GetAdapterLUID = lib.func('void __stdcall WintunGetAdapterLUID(void *Adapter, _Out_ uint64_t *Luid)')
  const GetRunningDriverVersion = lib.func('uint32_t __stdcall WintunGetRunningDriverVersion()')
  const StartSession = lib.func('void * __stdcall WintunStartSession(void *Adapter, uint32_t Capacity)')
  const EndSession = lib.func('void __stdcall WintunEndSession(void *Session)')
  const GetReadWaitEvent = lib.func('void * __stdcall WintunGetReadWaitEvent(void *Session)')
  const ReceivePacket = lib.func('void * __stdcall WintunReceivePacket(void *Session, _Out_ uint32_t *PacketSize)')
  const ReleaseReceivePacket = lib.func('void __stdcall WintunReleaseReceivePacket(void *Session, void *Packet)')
  const AllocateSendPacket = lib.func('void * __stdcall WintunAllocateSendPacket(void *Session, uint32_t PacketSize)')
  const SendPacket = lib.func('void __stdcall WintunSendPacket(void *Session, void *Packet)')

  const RtlMoveMemory = k32.func('void __stdcall RtlMoveMemory(void *Destination, const void *Source, size_t Length)')
  const GetLastError = k32.func('uint32_t __stdcall GetLastError()')
  const WaitForSingleObject = k32.func('uint32_t __stdcall WaitForSingleObject(void *Handle, uint32_t Milliseconds)')
  const ConvertInterfaceLuidToIndex = iphlp.func(
    'uint32_t __stdcall ConvertInterfaceLuidToIndex(const uint64_t *InterfaceLuid, _Out_ uint32_t *InterfaceIndex)'
  )

  api = {
    createAdapter: (name, type, guid) => CreateAdapter(name, type, guid),
    closeAdapter: (a) => CloseAdapter(a),
    getAdapterLuid: (a, out) => GetAdapterLUID(a, out),
    driverVersion: () => GetRunningDriverVersion(),
    startSession: (a, cap) => StartSession(a, cap),
    endSession: (s) => EndSession(s),
    readWaitEvent: (s) => GetReadWaitEvent(s),
    receivePacket: (s, size) => ReceivePacket(s, size),
    releaseReceivePacket: (s, p) => ReleaseReceivePacket(s, p),
    allocateSendPacket: (s, size) => AllocateSendPacket(s, size),
    sendPacket: (s, p) => SendPacket(s, p),
    copy: (dst, src, len) => RtlMoveMemory(dst, src, len),
    lastError: () => GetLastError(),
    wait: (handle, ms) =>
      new Promise((resolve) => {
        WaitForSingleObject.async(handle, ms, (err: unknown, res: number) => resolve(err ? 0xffffffff : res))
      }),
    luidToIndex: (luid) => {
      const out: [number] = [0]
      return ConvertInterfaceLuidToIndex([luid], out) === 0 ? out[0] : null
    }
  }
  return api
}

/** Verifica privilégio de administrador sem precisar do wintun.dll. */
export function isProcessAdmin(): boolean {
  if (process.platform !== 'win32') return false
  try {
    const shell32 = koffi.load('shell32.dll')
    return shell32.func('bool __stdcall IsUserAnAdmin()')()
  } catch {
    return false
  }
}
