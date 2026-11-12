# 🎵 My Music — Servidor de Música Pessoal

Servidor de streaming e gerenciamento de biblioteca musical em Node.js com interface dark/glassmorphic moderna (`My Music` & `Now Playing`), suporte a upload de faixas e edição completa de metadados e capas via `ffmpeg`/`ffprobe`.

## ✨ Funcionalidades

- **Player Integrado (`Now Playing`)**:
  - Progresso circular interativo em SVG + barra linear de progresso.
  - Exibição de letras sincronizadas (formato `.lrc` `[mm:ss.xx]`) ou em texto livre com destaque de 3 linhas.
  - Favoritos (*Liked Songs*), modo aleatório (*Shuffle*), download direto e brilho ambiente adaptativo à capa do álbum.
- **Editor de Metadados e Capas (`FFmpeg` / `FFprobe`)**:
  - Edição por faixa individual (título, artista, álbum, artista do álbum, ano, nº da faixa/disco, BPM, gênero, compositor, comentário, compilação, letra `USLT`/`LYRICS` e capa `JPG`/`PNG`).
  - Edição de álbum em lote com barra de progresso em tempo real.
- **Upload de Músicas**:
  - Suporte para `.mp3`, `.flac`, `.m4a`, `.ogg`, `.wav` e `.opus` (até 1 GB por envio).
  - Organização automática em pastas `MUSIC_DIR/<Artista>/<Álbum>/`.

## 🚀 Pré-requisitos

- **Node.js** 18+ (recomendado Node 22)
- **FFmpeg** e **FFprobe** instalados e disponíveis no `PATH` do sistema

## ⚙️ Configuração

1. Copie o arquivo de exemplo de variáveis de ambiente:
   ```bash
   cp .env.example .env
   ```
2. Edite o arquivo `.env` com suas credenciais e o diretório onde suas músicas ficarão salvas:
   ```env
   PORT=3000
   MUSIC_DIR=/media/music
   MUSIC_USER=seu_usuario
   MUSIC_PASS=sua_senha_segura
   SESSION_SECRET=chave_secreta_aleatoria
   ```

## ▶️ Executando Localmente

```bash
npm install
npm start
```

Acesse em `http://localhost:3000`.

## 🐳 Executando com Docker

```bash
docker build -t music-server .
docker run -d \
  --name music-server \
  -p 3000:3000 \
  -e MUSIC_USER=seu_usuario \
  -e MUSIC_PASS=sua_senha_segura \
  -v /caminho/das/suas/musicas:/media/music \
  --restart unless-stopped \
  music-server
```
