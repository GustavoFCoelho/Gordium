# Gordium

Voz, vídeo, chat e uma **VPN estilo Hamachi** entre amigos, **sem servidor**. Cada rede existe só
entre os computadores de quem participa: ninguém precisa hospedar nada.

- **Sala de voz**: mute, ensurdecer, indicador de quem está falando e volume por pessoa.
- **Câmera e compartilhamento de tela**: tela inteira ou uma janela, de 720p30 a 1080p60, com
  áudio do computador opcional.
- **Chat de texto**: mensagens assinadas por quem escreveu, histórico salvo em cada membro e
  sincronizado quando alguém volta a ficar online.
- **VPN**: cada membro ganha um IP `100.88.x.y`, e todos se enxergam como numa rede local. Dá
  para jogar em LAN, acessar servidores de jogo, compartilhar pastas e dar ping.

## Como funciona

```
 Interface (React)            Processo principal (Node)                 Rede
┌──────────────────┐ IPC ┌───────────────────────────────┐
│ chat, sala de voz│◄───►│ Core: identidade, redes, chat │
│ WebRTC (mídia) ──┼──┐  │ NetworkSession (1 por rede) ──┼──► Hyperswarm: DHT pública +
└──────────────────┘  │  │ VpnManager ◄─► TunDevice ─────┼─┐  hole punching, conexões Noise
                      │  └───────────────────────────────┘ │
                      │        adaptador Wintun "Gordium" ◄┘  (pacotes IP vão nos datagramas
                      └──► áudio/vídeo P2P (direto, ou pelo túnel da VPN)    cifrados do swarm)
```

- **Encontrar os outros sem servidor.** A chave da rede (que vai no convite) gera um tópico.
  Cada membro anuncia esse tópico na DHT pública do [Hyperswarm](https://github.com/holepunchto/hyperswarm),
  e os peers se conectam direto com *hole punching*. Os nós da DHT são públicos e mantidos pela
  comunidade Holepunch: o Gordium não tem servidor próprio.
- **Quem entra.** Toda conexão é cifrada (Noise). Antes de qualquer coisa, cada lado prova que
  conhece a chave da rede (HMAC amarrado ao handshake) e assina o handshake com a sua chave de
  identidade ed25519. A identidade é a mesma em todas as redes, e o IP virtual é derivado dela.
- **VPN.** O adaptador virtual é o [Wintun](https://www.wintun.net/) (o mesmo do WireGuard),
  chamado via FFI ([koffi](https://koffi.dev/)). Um pacote que o Windows manda para
  `100.88.a.b` é lido do adaptador e enviado como datagrama cifrado ao peer dono daquele IP.
  Broadcast e multicast vão para todos, que é como jogos em LAN se descobrem. Pacotes que chegam
  com IP de origem que não é o do peer são descartados.
- **Mídia.** WebRTC em malha (cada participante se conecta aos outros), com sinalização pelo
  próprio canal P2P. Cada par de participantes tem 4 trilhas fixas (microfone, câmera, tela e
  áudio da tela): ligar a câmera ou a tela é só um `replaceTrack`, sem renegociar. Com a VPN
  ligada, o WebRTC também usa o túnel do Gordium como caminho.

## Rodando

Requisitos: Windows 10/11 x64, Node.js 22+.

```powershell
npm install          # também baixa o wintun.dll oficial (SHA-256 conferido)
npm run dev          # abre o app em modo de desenvolvimento
```

A VPN precisa de **administrador** (é isso que permite criar o adaptador de rede). Em
desenvolvimento, abra o terminal como administrador antes do `npm run dev`. Sem admin, voz,
vídeo e chat funcionam normalmente e só a VPN fica desligada.

Para testar com dois usuários no mesmo computador, use perfis diferentes:

```powershell
$env:GORDIUM_PROFILE = "b"; npm run dev
```

## Instalação e atualizações

Quem vai usar baixa o `Gordium-Setup-x.y.z.exe` da
[página de Releases](https://github.com/GustavoFCoelho/Gordium/releases/latest) e instala. O app
pede elevação ao abrir (`requireAdministrator`), como o Hamachi e o Radmin VPN. O instalador não
tem assinatura digital, então na primeira vez o Windows SmartScreen avisa: é só clicar em
**Mais informações → Executar assim mesmo**.

Como uma alteração chega a quem já instalou:

1. **Push na `main`.** O workflow [`release.yml`](.github/workflows/release.yml) roda no GitHub
   Actions: checa os tipos, compila, gera o instalador e publica uma Release. A versão é numerada
   sozinha: `major.minor` do `package.json` + o número da execução (`0.1.1`, `0.1.2`…). As
   mensagens dos commits do push viram as notas da versão. Pushes que só mudam arquivos `.md`
   não geram versão, e se o build falhar nada é publicado.
2. **O app procura a versão nova** ao abrir e a cada 30 minutos
   ([`electron-updater`](https://www.electron.build/auto-update)), e baixa em segundo plano.
3. **Aparece um botão verde** no canto inferior esquerdo. Ele abre o que mudou e o botão
   "Reiniciar e atualizar": o app fecha, instala e reabre sozinho. Se a pessoa não clicar, a
   atualização é instalada quando ela fechar o app.

Para subir de `0.1.x` para `0.2.x`, mude a versão no `package.json` para `0.2.0`. Para gerar um
instalador local sem publicar nada: `npm run dist` (sai em `dist/`).

## Testes

| Comando | O que testa | Requisitos |
|---|---|---|
| `npm run test:net` | 3 identidades se acham pela DHT pública, autenticam, sincronizam o chat, rejeitam mensagem forjada, trocam estado de voz, sinalização e pacotes da VPN (datagrama e fallback); duas redes ao mesmo tempo; reconexão após reiniciar | internet |
| `npm run test:e2e` | duas instâncias reais do app controladas pelo DevTools: criar rede, convite, chat, sala de voz, áudio chegando, câmera, tela em 1080p, mute e saída da chamada | internet |
| `npm run test:vpn` | liga a VPN como o app liga e testa os dois sentidos do túnel com um peer simulado: Windows → túnel, ping injetado respondido pelo Windows e descarte de IP forjado | **terminal como administrador**, Gordium fechado |
| `npm run typecheck` | tipos do processo principal, do preload e da interface | — |

## Limitações conhecidas

- **NAT muito restritivo.** Se os dois lados estiverem atrás de NAT simétrico (alguns CGNATs e
  redes móveis), o hole punching pode falhar e eles não se conectam. O próximo passo natural é
  usar outro membro bem conectado como *relay* cego (o HyperDHT já tem suporte).
- **Tamanho dos grupos.** A mídia é em malha: cada pessoa envia uma cópia do vídeo para cada
  outra. Funciona bem até ~6–8 pessoas com vídeo e ~10–15 só com voz.
- **Convite não é revogável.** O convite é a chave da rede. Para tirar alguém, crie uma rede nova.
- **VPN só no Windows e só IPv4.** O IP vem de um hash da identidade (65 mil endereços). Colisões
  são improváveis em grupos pequenos, mas não são tratadas.
- **Firewall.** O Windows trata o adaptador do Gordium como rede pública. O app libera só o ping
  dentro de `100.88.0.0/16`. Jogos e servidores precisam ser permitidos no firewall (o Windows
  costuma perguntar na primeira vez).
- **Áudio da tela.** A captura do áudio do computador inclui o som da própria chamada, então os
  outros podem ouvir eco da própria voz.
- **Dados locais.** A identidade, as chaves das redes e o histórico ficam em `%APPDATA%\Gordium`
  sem criptografia em disco.
