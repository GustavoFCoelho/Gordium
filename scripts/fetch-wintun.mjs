// Baixa o wintun.dll (driver de adaptador TUN assinado pela WireGuard LLC)
// e confere o SHA-256 do pacote oficial antes de extrair.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const VERSION = '0.14.1'
const URL = `https://www.wintun.net/builds/wintun-${VERSION}.zip`
const SHA256 = '07c256185d6ee3652e09fa55c0b673e2624b565e02c4b9091c79ca7d2f24ef51'
// pasta no zip oficial -> nome usado pelo Node/electron-builder (process.arch)
const ARCHS = { amd64: 'x64', arm64: 'arm64', x86: 'ia32' }

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'resources', 'wintun')

if (process.platform !== 'win32') {
  console.log('[wintun] plataforma não é Windows, pulando.')
  process.exit(0)
}
if (Object.values(ARCHS).every((a) => existsSync(join(outDir, a, 'wintun.dll')))) {
  console.log('[wintun] já presente.')
  process.exit(0)
}

console.log(`[wintun] baixando ${URL}`)
const res = await fetch(URL)
if (!res.ok) throw new Error(`[wintun] download falhou: HTTP ${res.status}`)
const zip = Buffer.from(await res.arrayBuffer())
const digest = createHash('sha256').update(zip).digest('hex')
if (digest !== SHA256) throw new Error(`[wintun] SHA-256 inesperado: ${digest}`)

const work = mkdtempSync(join(tmpdir(), 'gordium-wintun-'))
try {
  const zipPath = join(work, 'wintun.zip')
  const extractDir = join(work, 'x')
  writeFileSync(zipPath, zip)
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`
  ])
  for (const [zipArch, arch] of Object.entries(ARCHS)) {
    mkdirSync(join(outDir, arch), { recursive: true })
    copyFileSync(join(extractDir, 'wintun', 'bin', zipArch, 'wintun.dll'), join(outDir, arch, 'wintun.dll'))
  }
  copyFileSync(join(extractDir, 'wintun', 'LICENSE.txt'), join(outDir, 'LICENSE.txt'))
  console.log(`[wintun] ${VERSION} extraído em resources/wintun`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
