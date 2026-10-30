# Gordium

Voz, vídeo, chat e uma **VPN estilo Hamachi** entre amigos, **sem servidor**. Cada rede existe só
entre os computadores de quem participa: ninguém precisa hospedar nada.

- **Canais**: quantos canais de texto e de voz a rede quiser (botão direito na lista de canais ou o
  "+" ao lado de cada categoria). Cada canal de voz é uma sala separada.
- **Sala de voz**: mute, ensurdecer, indicador de quem está falando, volume por pessoa e sons de
  entrada/saída.
- **Soundboard**: sons de até 6 s que qualquer membro adiciona e toca para todos da sala.
- **Câmera e compartilhamento de tela**: tela inteira ou uma janela, de 720p30 a 1080p60, com
  áudio do computador opcional.
- **Chat de texto**: mensagens assinadas por quem escreveu, histórico salvo em cada membro e
  sincronizado quando alguém volta a ficar online.
- **VPN**: cada membro ganha um IP `100.88.x.y`, e todos se enxergam como numa rede local. Dá
  para jogar em LAN, acessar servidores de jogo, compartilhar pastas e dar ping.

## Como funciona

```
 Interface (React)            Processo principal (usuário comum)        Rede
┌──────────────────┐ IPC ┌───────────────────────────────┐
│ chat, sala de voz│◄───►│ Core: identidade, redes, chat │
│ WebRTC (mídia) ──┼──┐  │ NetworkSession (1 por rede) ──┼──► Hyperswarm: DHT pública +
└──────────────────┘  │  │ VpnManager (rotas, filtros)   │    hole punching, conexões Noise
                      │  └──────────────┬────────────────┘    (pacotes IP vão nos datagramas
                      │      named pipe │                      cifrados do swarm)
                      │  ┌──────────────┴────────────────┐
                      │  │ Gordium.exe --vpn-helper      │ ← único processo como administrador
                      │  │ adaptador Wintun "Gordium"    │
                      │  └───────────────────────────────┘
                      └──► áudio/vídeo P2P (direto, ou pelo túnel da VPN)
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
- **Só a VPN roda como administrador.** Criar o adaptador exige elevação, mas um Chromium elevado
  não consegue capturar janelas de outros programas (compartilhar a janela de um jogo falhava).
  Por isso o app roda como usuário comum e, ao ligar a VPN, abre pelo UAC um processo auxiliar
  (o próprio `Gordium.exe --vpn-helper`) que cuida só do adaptador. Os dois conversam por um
  *named pipe* de nome aleatório, autenticado por token; se o app fechar, o auxiliar remove o
  adaptador e sai. O auxiliar escolhe o DLL e valida IP e nome do adaptador por conta própria.
- **Canais e soundboard sem servidor.** Criar, renomear ou excluir um canal ou som gera um
  registro assinado por quem fez; os membros trocam os registros ao se conectar e repassam os
  novos na hora, e em conflito vale a alteração mais recente. Os sons são comprimidos em Opus
  (até 6 s, ~70 KB) e cada um toca a própria cópia: tocar um som só manda um aviso pela rede.
- **Captura própria de janela.** O Chromium captura janelas de outros programas de forma frágil
  (falha sem foco, coberta ou minimizada) ou com a borda amarela do Windows 10. O Gordium captura
  o monitor em que a janela está (DXGI, o método confiável) e recorta cada quadro só na área dela,
  seguindo pela API do Windows a posição, o tamanho e as janelas por cima (que saem pretas, para
  não vazar nada; overlays transparentes como o do NVIDIA são ignorados). Medido no Master Duel:
  1080p a 57 fps.
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

O app roda como usuário comum, inclusive em desenvolvimento. Ao ligar a VPN (Configurações →
VPN → Ativar), o Windows pede permissão de administrador para o processo da VPN. Depois de
ativada, ela volta a ligar sozinha quando o app abre.

Para testar com dois usuários no mesmo computador, use perfis diferentes:

```powershell
$env:GORDIUM_PROFILE = "b"; npm run dev
```

## Instalação e atualizações

Quem vai usar baixa o `Gordium-Setup-x.y.z.exe` da
[página de Releases](https://github.com/GustavoFCoelho/Gordium/releases/latest) e instala. O
instalador não tem assinatura digital, então na primeira vez o Windows SmartScreen avisa: é só
clicar em **Mais informações → Executar assim mesmo**.

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
| `npm run test:vpn` | adaptador e roteamento da VPN com um peer simulado: Windows → túnel, ping injetado respondido pelo Windows e descarte de IP forjado | **terminal como administrador** |
| `npm run test:vpn-helper` | o caminho do app: roda como usuário comum, abre o processo auxiliar pelo UAC e testa os dois sentidos do túnel pelo pipe; ao fechar, confere que o adaptador sumiu | aceitar o UAC |
| `npm run typecheck` | tipos do processo principal, do preload e da interface | — |

## Segurança

Quem tem o convite é membro pleno da rede. As proteções valem contra quem não tem o convite e
limitam o que um membro mal-intencionado consegue fazer.

- **Entrada na rede.** Conexões cifradas (Noise); cada lado prova que tem a chave da rede e assina
  o handshake com a identidade. Conexões ainda não autenticadas têm 8 s e no máximo 8 ao mesmo tempo.
- **Autoria.** Mensagens, canais e sons são assinados por quem os criou; registros adulterados
  são recusados.
- **IP virtual.** Como gerar uma chave com o IP de outra pessoa leva menos de 1 s, o IP fica com a
  identidade vista primeiro. Quem aparece depois com o mesmo IP fica sem VPN conosco ("IP em
  conflito"). Pacotes com IP de origem que não é o do membro são descartados.
- **Processo elevado.** Só o processo da VPN roda como administrador. Ele fala com o app por um
  pipe com autenticação mútua (HMAC com desafio, sem o token trafegar), escolhe o próprio DLL,
  valida IP e nome do adaptador e chama programas e DLLs do sistema pelo caminho completo.
- **Executável.** Fuses do Electron desligam `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` e `--inspect`
  e conferem a integridade do `app.asar` pelo hash gravado no executável.
- **Dados da rede.** Limites de canais e sons (também para o que chega dos outros) e áudio do
  soundboard só em WebM/Opus.
- **Build.** O `wintun.dll` é conferido por SHA-256 e as GitHub Actions estão fixadas por commit.

Ainda em aberto: o app é instalado por usuário, numa pasta em que o próprio usuário pode escrever
(veja "Limitações"); identidade e chaves das redes ficam sem criptografia no disco; instalador e
atualizações não têm assinatura digital.

## Limitações conhecidas

- **NAT muito restritivo.** Se os dois lados estiverem atrás de NAT simétrico (alguns CGNATs e
  redes móveis), o hole punching pode falhar e eles não se conectam. O próximo passo natural é
  usar outro membro bem conectado como *relay* cego (o HyperDHT já tem suporte).
- **Tamanho dos grupos.** A mídia é em malha: cada pessoa envia uma cópia do vídeo para cada
  outra. Funciona bem até ~6–8 pessoas com vídeo e ~10–15 só com voz.
- **Convite não é revogável.** O convite é a chave da rede. Para tirar alguém, crie uma rede nova.
- **Sem cargos.** Não há dono da rede: qualquer membro pode criar, renomear e excluir canais e sons
  do soundboard.
- **VPN só no Windows e só IPv4.** O IP vem de um hash da identidade (65 mil endereços). Colisões
  são improváveis em grupos pequenos, mas não são tratadas.
- **Firewall.** O Windows trata o adaptador do Gordium como rede pública. O app libera só o ping
  dentro de `100.88.0.0/16`. Jogos e servidores precisam ser permitidos no firewall (o Windows
  costuma perguntar na primeira vez).
- **Transmitir uma janela: o que fica por cima dela sai preto.** A captura de janela é própria
  (veja "Como funciona"); se outra janela passar por cima da transmitida, aquela área aparece
  preta para quem assiste, e janela minimizada pausa a transmissão. Janelas minimizadas não
  aparecem na lista para escolher. Uma janela arrastada para outro monitor no meio da
  transmissão sai do recorte: pare e transmita de novo.
- **Áudio da tela em Windows antigo.** O som do computador é capturado sem o som do próprio
  Gordium (as vozes da chamada não voltam na transmissão), o que depende do Windows 10 versão 2004
  ou mais novo. Em versões anteriores, os outros podem ouvir eco da própria voz.
- **Instalação por usuário.** O app fica em `%LOCALAPPDATA%\Programs\Gordium`, onde o próprio
  usuário pode escrever, e é de lá que roda o processo elevado da VPN. Um malware rodando com a
  conta do usuário poderia trocar esses arquivos e ganhar administrador no próximo UAC aceito. A
  correção é instalar em `Program Files` (por máquina).
- **Dados locais.** A identidade, as chaves das redes e o histórico ficam em `%APPDATA%\Gordium`
  sem criptografia em disco.
