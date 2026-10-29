// Prepara e roda o teste do processo auxiliar da VPN (scripts/vpn-helper-test.ts).
// O teste vira um "app" Electron próprio em out/vpn-helper-test, com o wintun.dll
// ao lado, porque o auxiliar é aberto a partir da pasta do app. Uso: npm run test:vpn-helper

import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const root = process.cwd()
const dir = join(root, 'out', 'vpn-helper-test')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })

const externals = ['electron', 'koffi', 'hyperswarm', 'hypercore-crypto'].flatMap((e) => ['--external', e])
execFileSync(
  process.execPath,
  [join(root, 'node_modules', 'rolldown', 'bin', 'cli.mjs'), './scripts/vpn-helper-test.ts', '--format', 'cjs', '--platform', 'node', '--file', join(dir, 'index.cjs'), ...externals],
  { stdio: 'ignore' }
)
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'gordium-vpn-helper-test', main: 'index.cjs' }))
cpSync(join(root, 'resources', 'wintun'), join(dir, 'resources', 'wintun'), { recursive: true })

const electron = createRequire(import.meta.url)('electron')
spawnSync(electron, [dir], { stdio: 'ignore' })

const log = join(dir, 'result.log')
const result = existsSync(log) ? readFileSync(log, 'utf8') : '✗ o teste não produziu resultado\n'
process.stdout.write(result)
process.exitCode = result.includes('TUDO OK') ? 0 : 1
