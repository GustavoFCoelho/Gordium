// Às vezes o npm pula o script de instalação do pacote "electron" e o binário
// não é baixado. Se faltar, roda o instalador oficial do próprio pacote.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const dir = dirname(require.resolve('electron/package.json'))
if (existsSync(join(dir, 'path.txt'))) {
  console.log('[electron] binário presente.')
} else {
  console.log('[electron] binário ausente, baixando…')
  execFileSync(process.execPath, [join(dir, 'install.js')], { stdio: 'inherit' })
}
