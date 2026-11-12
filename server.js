'use strict';
const express = require('express');
const multer = require('multer');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// Carrega variáveis do arquivo .env local (se existir) sem dependências externas
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
      }
    }
  }
} catch {}

const PORT = process.env.PORT || 3000;
const MUSIC_DIR = process.env.MUSIC_DIR || '/media/music';
const USER = process.env.MUSIC_USER || 'admin';
const PASS = process.env.MUSIC_PASS || 'changeme';
const EXTS = ['.mp3', '.flac', '.m4a', '.ogg', '.wav', '.opus'];
const MAX_BYTES = 1024 * 1024 * 1024; // 1GB para upload de músicas
const MAX_COVER_BYTES = 10 * 1024 * 1024; // 10MB para upload de capa

const app = express();
app.use(express.urlencoded({ extended: false, limit: '5mb' }));
app.use(express.json({ limit: '5mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 }
}));

// Cache em memória de metadados lidos/editados (chave: caminho absoluto)
const metaCache = new Map();
// Progresso de edições em lote (chave: jobId)
const batchJobs = new Map();

// ---------- Utilidades ----------
function sanitize(name) {
  return String(name || '')
    .normalize('NFC')
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
}
function cleanTagText(val, maxLen = 300, allowNewlines = false) {
  if (val === undefined || val === null) return '';
  let s = String(val).normalize('NFC');
  if (allowNewlines) {
    s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    return s.trim().slice(0, maxLen);
  }
  return s.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}
function isAudio(f) { return EXTS.includes(path.extname(f).toLowerCase()); }
function listDirs(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  } catch { return []; }
}
function getCachedMeta(fullPath, stat) {
  const entry = metaCache.get(fullPath);
  if (!entry) return null;
  if (stat && (entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size)) {
    metaCache.delete(fullPath);
    return null;
  }
  return entry.meta;
}
function setCachedMeta(fullPath, meta) {
  try {
    const st = fs.statSync(fullPath);
    const copy = Object.assign({}, meta);
    delete copy._rawTags;
    metaCache.set(fullPath, { mtimeMs: st.mtimeMs, size: st.size, meta: copy });
  } catch {}
}
function walkAudio(dir, base) {
  let out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walkAudio(full, base));
    else if (e.isFile() && isAudio(e.name)) {
      let size = 0, st = null;
      try { st = fs.statSync(full); size = st.size; } catch {}
      const item = { name: path.relative(base, full).split(path.sep).join('/'), size };
      const cached = getCachedMeta(full, st);
      if (cached) item.meta = cached;
      out.push(item);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true }));
}
function buildLibrary() {
  const artists = [];
  let albums = 0, tracks = 0;
  for (const a of listDirs(MUSIC_DIR)) {
    const aPath = path.join(MUSIC_DIR, a);
    const al = [];
    for (const b of listDirs(aPath)) {
      const bPath = path.join(aPath, b);
      const t = walkAudio(bPath, bPath);
      al.push({ name: b, tracks: t });
      albums++; tracks += t.length;
    }
    let loose = [];
    try {
      loose = fs.readdirSync(aPath, { withFileTypes: true })
        .filter(e => e.isFile() && !e.name.startsWith('.') && isAudio(e.name))
        .map(e => {
          const full = path.join(aPath, e.name);
          let st = null, size = 0;
          try { st = fs.statSync(full); size = st.size; } catch {}
          const item = { name: e.name, size };
          const cached = getCachedMeta(full, st);
          if (cached) item.meta = cached;
          return item;
        });
    } catch {}
    if (loose.length) { al.push({ name: '(Sem álbum)', tracks: loose, loose: true }); tracks += loose.length; }
    artists.push({ name: a, albums: al });
  }
  return { stats: { artists: artists.length, albums, tracks }, artists };
}
function safeJoin(...parts) {
  const cleaned = parts.filter(p => p !== undefined && p !== null && String(p) !== '').map(String);
  const p = path.resolve(MUSIC_DIR, ...cleaned);
  const root = path.resolve(MUSIC_DIR);
  if (p !== root && !p.startsWith(root + path.sep)) return null;
  return p;
}
function resolveAudioPath(artist, album, file) {
  if (!artist || !file) return null;
  const isLoose = !album || album === '(Sem álbum)';
  const p = isLoose ? safeJoin(artist, file) : safeJoin(artist, album, file);
  if (!p || !isAudio(p) || !fs.existsSync(p)) return null;
  try {
    if (!fs.statSync(p).isFile()) return null;
  } catch { return null; }
  return p;
}
function listAlbumTracks(artist, album) {
  if (!artist) return [];
  const isLoose = !album || album === '(Sem álbum)';
  if (isLoose) {
    const aPath = safeJoin(artist);
    if (!aPath || !fs.existsSync(aPath)) return [];
    try {
      return fs.readdirSync(aPath, { withFileTypes: true })
        .filter(e => e.isFile() && !e.name.startsWith('.') && isAudio(e.name))
        .map(e => ({ rel: e.name, full: path.join(aPath, e.name) }))
        .sort((a, b) => a.rel.localeCompare(b.rel, 'pt-BR', { numeric: true }));
    } catch { return []; }
  }
  const bPath = safeJoin(artist, album);
  if (!bPath || !fs.existsSync(bPath)) return [];
  return walkAudio(bPath, bPath).map(t => ({
    rel: t.name,
    full: path.join(bPath, ...t.name.split('/'))
  }));
}

// ---------- Leitura e Escrita de Metadados (FFprobe / FFmpeg) ----------
function getTag(rawTags, ...keys) {
  const entries = Object.entries(rawTags || {});
  for (const k of keys) {
    if (k.endsWith('*')) continue;
    const kl = k.toLowerCase();
    for (const [rk, rv] of entries) {
      if (rk.toLowerCase() === kl && rv !== undefined && rv !== null && String(rv).trim() !== '') {
        return String(rv);
      }
    }
  }
  for (const k of keys) {
    if (k.endsWith('*')) {
      const pref = k.slice(0, -1).toLowerCase();
      for (const [rk, rv] of entries) {
        if (rk.toLowerCase().startsWith(pref) && rv !== undefined && rv !== null && String(rv).trim() !== '') {
          return String(rv);
        }
      }
    }
  }
  return '';
}

async function readMetadata(filePath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath
  ], { maxBuffer: 10 * 1024 * 1024 });

  const probe = JSON.parse(stdout || '{}');
  const streams = probe.streams || [];
  const audioStream = streams.find(s => s.codec_type === 'audio') || {};
  const rawTags = Object.assign({}, audioStream.tags || {}, (probe.format && probe.format.tags) || {});

  const hasCover = streams.some(s =>
    s.codec_type === 'video' && (
      (s.disposition && s.disposition.attached_pic === 1) ||
      ['mjpeg', 'png', 'webp', 'bmp', 'gif'].includes(s.codec_name)
    )
  );

  const rawDate = getTag(rawTags, 'date', 'year', 'TYER', 'TDRC', 'ORIGINALDATE');
  const yearMatch = rawDate.match(/\b(\d{4})\b/);
  const year = yearMatch ? yearMatch[1] : (rawDate.match(/^\d+$/) ? rawDate : '');

  const compRaw = getTag(rawTags, 'compilation', 'COMPILATION', 'TCMP', 'cpil', 'CPIL', 'itunescompilation');
  const compilation = compRaw === '1' || compRaw.toLowerCase() === 'true' || compRaw.toLowerCase() === 'yes';

  const meta = {
    title: getTag(rawTags, 'title', 'TIT2'),
    artist: getTag(rawTags, 'artist', 'TPE1'),
    album: getTag(rawTags, 'album', 'TALB'),
    albumartist: getTag(rawTags, 'album_artist', 'albumartist', 'album artist', 'TPE2'),
    year,
    genre: getTag(rawTags, 'genre', 'TCON'),
    track: getTag(rawTags, 'track', 'tracknumber', 'TRCK'),
    disc: getTag(rawTags, 'disc', 'discnumber', 'TPOS'),
    composer: getTag(rawTags, 'composer', 'TCOM'),
    bpm: getTag(rawTags, 'TBPM', 'bpm', 'BPM', 'tmpo', 'TMPO'),
    comment: getTag(rawTags, 'comment', 'COMMENT', 'description', 'DESCRIPTION', 'COMM'),
    compilation,
    lyrics: getTag(rawTags, 'lyrics', 'LYRICS', 'USLT', 'unsyncedlyrics', 'UNSYNCEDLYRICS', 'lyrics-*'),
    hasCover,
    _rawTags: rawTags
  };
  setCachedMeta(filePath, meta);
  return meta;
}

async function extractCoverBuffer(filePath) {
  try {
    const { stdout } = await execFileAsync('ffmpeg', [
      '-loglevel', 'error',
      '-i', filePath,
      '-map', '0:v:0',
      '-c:v', 'copy',
      '-frames:v', '1',
      '-f', 'image2pipe',
      'pipe:1'
    ], { encoding: 'buffer', maxBuffer: 15 * 1024 * 1024 });
    return stdout && stdout.length ? stdout : null;
  } catch {
    return null;
  }
}

function detectImageMime(buf) {
  if (!buf || buf.length < 8) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
    buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A
  ) return 'image/png';
  return null;
}

function synchsafe32(n) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}
function makeId3v23Frame(id, payload) {
  const header = Buffer.alloc(10);
  header.write(id, 0, 4, 'ascii');
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}
function encodeUtf16LeBom(str) {
  return Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(String(str), 'utf16le')]);
}

// Injeta frames nativos ID3v2.3 (USLT para letra, COMM para comentário e TCMP para compilação)
function injectMp3NativeFrames(filePath, { lyrics, comment, compilation }) {
  const extra = [];
  if (comment) {
    const payload = Buffer.concat([
      Buffer.from([0x01]), // UTF-16 com BOM
      Buffer.from('por', 'ascii'),
      Buffer.from([0xFF, 0xFE, 0x00, 0x00]), // descrição vazia UTF-16 + null
      encodeUtf16LeBom(comment)
    ]);
    extra.push(makeId3v23Frame('COMM', payload));
  }
  if (compilation) {
    const payload = Buffer.concat([Buffer.from([0x00]), Buffer.from('1', 'ascii')]);
    extra.push(makeId3v23Frame('TCMP', payload));
  }
  if (lyrics) {
    const payload = Buffer.concat([
      Buffer.from([0x01]), // UTF-16 com BOM
      Buffer.from('por', 'ascii'),
      Buffer.from([0xFF, 0xFE, 0x00, 0x00]), // descrição vazia UTF-16 + null
      encodeUtf16LeBom(lyrics)
    ]);
    extra.push(makeId3v23Frame('USLT', payload));
  }
  if (!extra.length) return;

  const buf = fs.readFileSync(filePath);
  if (buf.length >= 10 && buf.subarray(0, 3).toString('ascii') === 'ID3') {
    const oldSize = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    const existingFrames = buf.subarray(10, 10 + oldSize);
    const audioRest = buf.subarray(10 + oldSize);
    const newFrames = Buffer.concat([...extra, existingFrames]);
    const newHeader = Buffer.concat([buf.subarray(0, 6), synchsafe32(newFrames.length)]);
    fs.writeFileSync(filePath, Buffer.concat([newHeader, newFrames, audioRest]));
  } else {
    const newFrames = Buffer.concat(extra);
    const newHeader = Buffer.concat([Buffer.from('ID3\x03\x00\x00', 'binary'), synchsafe32(newFrames.length)]);
    fs.writeFileSync(filePath, Buffer.concat([newHeader, newFrames, buf]));
  }
}

function makeFlacPictureBase64(imgBuf, mime) {
  const mimeBuf = Buffer.from(mime || 'image/jpeg', 'ascii');
  const descBuf = Buffer.from('Cover (front)', 'utf8');
  const header = Buffer.alloc(32 + mimeBuf.length + descBuf.length);
  let off = 0;
  header.writeUInt32BE(3, off); off += 4; // 3 = Cover (front)
  header.writeUInt32BE(mimeBuf.length, off); off += 4;
  mimeBuf.copy(header, off); off += mimeBuf.length;
  header.writeUInt32BE(descBuf.length, off); off += 4;
  descBuf.copy(header, off); off += descBuf.length;
  header.writeUInt32BE(imgBuf.length, off + 16);
  return Buffer.concat([header, imgBuf]).toString('base64');
}

const MANAGED_KEY_RE = /^(title|tit2|artist|tpe1|album|talb|album_artist|albumartist|album artist|tpe2|date|year|tyer|tdrc|originaldate|genre|tcon|track|tracknumber|trck|disc|discnumber|tpos|composer|tcom|bpm|tbpm|tmpo|comment|description|comm|compilation|tcmp|cpil|itunescompilation|lyrics|uslt|unsyncedlyrics|lyrics-.*)$/i;

function validateMetadataInput(fields, isAlbumBatch = false) {
  if (fields.year !== undefined && fields.year !== '') {
    const yStr = String(fields.year).trim();
    const yNum = Number(yStr);
    if (!/^\d{1,4}$/.test(yStr) || !Number.isInteger(yNum) || yNum < 1000 || yNum > 2999) {
      return 'Ano inválido. Informe um ano numérico de 4 dígitos (ex: 2024).';
    }
  }
  if (!isAlbumBatch) {
    if (fields.bpm !== undefined && fields.bpm !== '') {
      const bStr = String(fields.bpm).trim();
      const bNum = Number(bStr);
      if (!/^\d{1,3}(\.\d{1,2})?$/.test(bStr) || isNaN(bNum) || bNum < 1 || bNum > 999) {
        return 'BPM inválido. Informe um número entre 1 e 999.';
      }
    }
    if (fields.track !== undefined && fields.track !== '') {
      const tStr = String(fields.track).trim();
      if (!/^\d{1,4}(\/\d{1,4})?$/.test(tStr) || tStr.split('/').some(n => Number(n) < 1)) {
        return 'Nº da faixa inválido. Informe um número inteiro positivo (ex: 1 ou 1/12).';
      }
    }
    if (fields.disc !== undefined && fields.disc !== '') {
      const dStr = String(fields.disc).trim();
      if (!/^\d{1,4}(\/\d{1,4})?$/.test(dStr) || dStr.split('/').some(n => Number(n) < 1)) {
        return 'Nº do disco inválido. Informe um número inteiro positivo (ex: 1 ou 1/2).';
      }
    }
  }
  return null;
}

async function writeMetadata(filePath, inputFields, coverBuffer, isPartial = false) {
  const existing = await readMetadata(filePath);
  const m = isPartial ? {
    title: existing.title,
    artist: existing.artist,
    album: inputFields.album !== undefined ? inputFields.album : existing.album,
    albumartist: inputFields.albumartist !== undefined ? inputFields.albumartist : existing.albumartist,
    year: inputFields.year !== undefined ? inputFields.year : existing.year,
    genre: inputFields.genre !== undefined ? inputFields.genre : existing.genre,
    track: existing.track,
    disc: existing.disc,
    composer: existing.composer,
    bpm: existing.bpm,
    comment: existing.comment,
    compilation: existing.compilation,
    lyrics: existing.lyrics
  } : {
    title: inputFields.title || '',
    artist: inputFields.artist || '',
    album: inputFields.album || '',
    albumartist: inputFields.albumartist || '',
    year: inputFields.year || '',
    genre: inputFields.genre || '',
    track: inputFields.track || '',
    disc: inputFields.disc || '',
    composer: inputFields.composer || '',
    bpm: inputFields.bpm || '',
    comment: inputFields.comment || '',
    compilation: !!inputFields.compilation,
    lyrics: inputFields.lyrics || ''
  };

  const ext = path.extname(filePath).toLowerCase();
  const id = crypto.randomBytes(6).toString('hex');
  const dirName = path.dirname(filePath);
  const tempAudio = path.join(dirName, `.tmp_edit_${id}${ext}`);
  let tempCover = null;
  let tempMeta = null;

  try {
    const args = ['-loglevel', 'error', '-y', '-i', filePath];
    const isStreamTag = (ext === '.ogg' || ext === '.opus');
    const isPicStream = (ext === '.mp3' || ext === '.flac' || ext === '.m4a');

    if (coverBuffer && isPicStream) {
      const mime = detectImageMime(coverBuffer);
      if (!mime) throw new Error('A imagem da capa deve estar em formato JPG ou PNG válido.');
      const covExt = mime === 'image/png' ? '.png' : '.jpg';
      tempCover = path.join(dirName, `.tmp_cov_${id}${covExt}`);
      fs.writeFileSync(tempCover, coverBuffer);
      args.push('-i', tempCover);
    }

    let oggCoverBuf = coverBuffer;
    if (!oggCoverBuf && isStreamTag && existing.hasCover) {
      oggCoverBuf = await extractCoverBuffer(filePath);
    }
    if (oggCoverBuf && isStreamTag) {
      const mime = detectImageMime(oggCoverBuf) || 'image/jpeg';
      const b64 = makeFlacPictureBase64(oggCoverBuf, mime);
      tempMeta = path.join(dirName, `.tmp_meta_${id}.txt`);
      fs.writeFileSync(tempMeta, `;FFMETADATA1\nMETADATA_BLOCK_PICTURE=${b64}\n`);
      args.push('-f', 'ffmetadata', '-i', tempMeta);
    }

    args.push('-map', '0:a');
    if (isPicStream) {
      if (tempCover) {
        args.push('-map', '1:v');
      } else if (existing.hasCover) {
        args.push('-map', '0:v:0?');
      }
    }
    if (tempMeta && isStreamTag) {
      args.push('-map_metadata:s:a:0', '1:g');
    }

    args.push('-c', 'copy');
    if (ext === '.mp3') args.push('-id3v2_version', '3');
    if (ext === '.wav') args.push('-write_id3v2', '1', '-id3v2_version', '3');
    if (isPicStream && (tempCover || existing.hasCover)) {
      args.push(
        '-disposition:v:0', 'attached_pic',
        '-metadata:s:v', 'title=Album cover',
        '-metadata:s:v', 'comment=Cover (front)'
      );
    }

    // Limpa chaves gerenciadas anteriores para permitir apagar valores
    const keysToClear = new Set([
      'title', 'artist', 'album', 'album_artist', 'ALBUMARTIST', 'date', 'YEAR',
      'genre', 'track', 'TRACKNUMBER', 'disc', 'DISCNUMBER', 'composer',
      'TBPM', 'BPM', 'bpm', 'tmpo', 'comment', 'COMMENT', 'DESCRIPTION',
      'compilation', 'COMPILATION', 'TCMP', 'cpil', 'lyrics', 'LYRICS', 'USLT'
    ]);
    for (const k of Object.keys(existing._rawTags || {})) {
      if (MANAGED_KEY_RE.test(k)) keysToClear.add(k);
    }
    for (const k of keysToClear) {
      args.push('-metadata', `${k}=`);
      if (isStreamTag) args.push('-metadata:s:a:0', `${k}=`);
    }

    const addMeta = (k, v) => {
      if (v === undefined || v === null || String(v) === '') return;
      args.push('-metadata', `${k}=${String(v)}`);
      if (isStreamTag) args.push('-metadata:s:a:0', `${k}=${String(v)}`);
    };

    if (ext === '.mp3') {
      addMeta('title', m.title);
      addMeta('artist', m.artist);
      addMeta('album', m.album);
      addMeta('album_artist', m.albumartist);
      addMeta('date', m.year);
      addMeta('genre', m.genre);
      addMeta('track', m.track);
      addMeta('disc', m.disc);
      addMeta('composer', m.composer);
      addMeta('TBPM', m.bpm);
      // USLT (letra), COMM (comentário) e TCMP (compilação) são injetados como frames ID3v2.3 nativos
    } else if (ext === '.flac' || isStreamTag) {
      addMeta('TITLE', m.title);
      addMeta('ARTIST', m.artist);
      addMeta('ALBUM', m.album);
      addMeta('ALBUMARTIST', m.albumartist);
      addMeta('album_artist', m.albumartist);
      addMeta('DATE', m.year);
      addMeta('GENRE', m.genre);
      addMeta('TRACKNUMBER', m.track);
      addMeta('track', m.track);
      addMeta('DISCNUMBER', m.disc);
      addMeta('disc', m.disc);
      addMeta('COMPOSER', m.composer);
      addMeta('COMMENT', m.comment);
      addMeta('comment', m.comment);
      addMeta('BPM', m.bpm);
      if (m.compilation) addMeta('COMPILATION', '1');
      addMeta('LYRICS', m.lyrics);
    } else {
      addMeta('title', m.title);
      addMeta('artist', m.artist);
      addMeta('album', m.album);
      addMeta('album_artist', m.albumartist);
      addMeta('date', m.year);
      addMeta('genre', m.genre);
      addMeta('track', m.track);
      addMeta('disc', m.disc);
      addMeta('composer', m.composer);
      addMeta('comment', m.comment);
      addMeta('BPM', m.bpm);
      addMeta('TBPM', m.bpm);
      addMeta('tmpo', m.bpm);
      if (m.compilation) {
        addMeta('compilation', '1');
        addMeta('cpil', '1');
      }
      addMeta('lyrics', m.lyrics);
      addMeta('LYRICS', m.lyrics);
    }

    args.push(tempAudio);
    await execFileAsync('ffmpeg', args, { maxBuffer: 10 * 1024 * 1024 });

    if (ext === '.mp3') {
      injectMp3NativeFrames(tempAudio, {
        lyrics: m.lyrics,
        comment: m.comment,
        compilation: m.compilation
      });
    }

    const st = fs.statSync(tempAudio);
    if (!st || st.size === 0) {
      throw new Error('Falha ao gerar arquivo temporário com novos metadados.');
    }

    try {
      fs.renameSync(tempAudio, filePath);
    } catch {
      fs.copyFileSync(tempAudio, filePath);
      fs.unlinkSync(tempAudio);
    }

    const updatedMeta = Object.assign({}, m, {
      hasCover: !!(coverBuffer || existing.hasCover)
    });
    setCachedMeta(filePath, updatedMeta);
    return updatedMeta;
  } finally {
    for (const f of [tempAudio, tempCover, tempMeta]) {
      if (f && fs.existsSync(f)) {
        try { fs.unlinkSync(f); } catch {}
      }
    }
  }
}

// ---------- Autenticação ----------
function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
  return res.redirect('/login');
}

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.type('html').send(loginPage(req.query.erro ? 'Usuário ou senha inválidos.' : ''));
});
app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === USER && password === PASS) {
    return req.session.regenerate(err => {
      if (err) return res.redirect('/login?erro=1');
      req.session.user = USER;
      res.redirect('/');
    });
  }
  setTimeout(() => res.redirect('/login?erro=1'), 600);
});
app.post('/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie('connect.sid'); res.redirect('/login'); });
});

app.use(requireLogin);

// ---------- Páginas / API ----------
app.get('/', (req, res) => res.type('html').send(appPage()));
app.get('/api/library', (req, res) => res.json(buildLibrary()));
app.get('/api/artists', (req, res) => {
  res.json(listDirs(MUSIC_DIR).map(a => ({ name: a, albums: listDirs(path.join(MUSIC_DIR, a)) })));
});
app.get('/api/stream', (req, res) => {
  const artist = String(req.query.artist || '');
  const album = req.query.album ? String(req.query.album) : '';
  const file = String(req.query.file || '');
  const p = resolveAudioPath(artist, album, file);
  if (!p) return res.status(404).send('Arquivo não encontrado');
  res.sendFile(p);
});

// ---------- API de Metadados e Capa ----------
app.get('/api/metadata', async (req, res) => {
  try {
    const artist = String(req.query.artist || '');
    const album = req.query.album !== undefined ? String(req.query.album) : '';
    let file = req.query.file ? String(req.query.file) : '';
    let targetPath = null;

    if (file) {
      targetPath = resolveAudioPath(artist, album, file);
    } else {
      const tracks = listAlbumTracks(artist, album);
      if (tracks.length) {
        file = tracks[0].rel;
        targetPath = tracks[0].full;
      }
    }
    if (!targetPath) return res.status(404).json({ error: 'Arquivo de áudio não encontrado.' });

    const meta = await readMetadata(targetPath);
    const out = Object.assign({}, meta);
    delete out._rawTags;
    res.json({ ok: true, artist, album, file, metadata: out });
  } catch (err) {
    console.error('Erro ao ler metadados:', err);
    res.status(500).json({ error: 'Não foi possível ler os metadados do arquivo: ' + (err.message || 'erro interno') });
  }
});

app.get('/api/cover', async (req, res) => {
  try {
    const artist = String(req.query.artist || '');
    const album = req.query.album !== undefined ? String(req.query.album) : '';
    const file = req.query.file ? String(req.query.file) : '';
    let targetPath = null;

    if (file) {
      targetPath = resolveAudioPath(artist, album, file);
    } else {
      const tracks = listAlbumTracks(artist, album);
      if (tracks.length) targetPath = tracks[0].full;
    }
    if (!targetPath) return res.status(404).send('Arquivo não encontrado');

    const buf = await extractCoverBuffer(targetPath);
    if (!buf) return res.status(404).send('Sem capa embutida');

    const mime = detectImageMime(buf) || 'image/jpeg';
    res.set('Content-Type', mime);
    res.set('Cache-Control', 'no-store');
    res.send(buf);
  } catch {
    res.status(404).send('Erro ao extrair capa');
  }
});

const uploadCover = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_COVER_BYTES, files: 1, fieldSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mime = (file.mimetype || '').toLowerCase();
    const okMime = mime === 'image/jpeg' || mime === 'image/jpg' || mime === 'image/png';
    const okExt = ext === '.jpg' || ext === '.jpeg' || ext === '.png';
    if (!okMime && !okExt) {
      return cb(new Error('Formato de imagem inválido. Envie apenas arquivos JPG ou PNG.'));
    }
    cb(null, true);
  }
});

function handleCoverUpload(req, res, next) {
  uploadCover.single('cover')(req, res, err => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'A imagem da capa excede o limite máximo de 10 MB.' });
      }
      return res.status(400).json({ error: err.message || 'Erro no envio da imagem de capa.' });
    }
    if (req.file) {
      const mime = detectImageMime(req.file.buffer);
      if (!mime) {
        return res.status(400).json({ error: 'O arquivo enviado não é uma imagem JPG ou PNG válida.' });
      }
    }
    next();
  });
}

// Salvar metadados de uma faixa individual
app.post('/api/metadata', handleCoverUpload, async (req, res) => {
  try {
    const body = req.body || {};
    const srcArtist = String(req.query.artist || body.srcArtist || body.artist || '');
    const srcAlbum = req.query.album !== undefined
      ? String(req.query.album)
      : (body.srcAlbum !== undefined ? String(body.srcAlbum) : String(body.album || ''));
    const file = String(req.query.file || body.file || '');

    const targetPath = resolveAudioPath(srcArtist, srcAlbum, file);
    if (!targetPath) {
      return res.status(404).json({ error: 'Arquivo de música não encontrado na biblioteca.' });
    }

    const tagArtist = body.tagArtist !== undefined ? body.tagArtist : body.artist;
    const tagAlbum = body.tagAlbum !== undefined ? body.tagAlbum : body.album;
    const rawYear = body.year !== undefined ? body.year : body.date;
    const compVal = body.compilation;

    const fields = {
      title: cleanTagText(body.title, 300),
      artist: cleanTagText(tagArtist, 300),
      album: cleanTagText(tagAlbum, 300),
      albumartist: cleanTagText(body.albumartist, 300),
      year: cleanTagText(rawYear, 10),
      genre: cleanTagText(body.genre, 150),
      track: cleanTagText(body.track, 20),
      disc: cleanTagText(body.disc, 20),
      composer: cleanTagText(body.composer, 300),
      bpm: cleanTagText(body.bpm, 10),
      comment: cleanTagText(body.comment, 2000, true),
      compilation: compVal === '1' || compVal === 'true' || compVal === true || compVal === 'on',
      lyrics: cleanTagText(body.lyrics, 50000, true)
    };

    const validationError = validateMetadataInput(fields, false);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const coverBuffer = req.file ? req.file.buffer : null;
    const updated = await writeMetadata(targetPath, fields, coverBuffer, false);
    res.json({ ok: true, artist: srcArtist, album: srcAlbum, file, metadata: updated });
  } catch (err) {
    console.error('Erro ao salvar metadados da faixa:', err);
    res.status(500).json({ error: 'Falha ao gravar metadados no arquivo: ' + (err.message || 'erro no ffmpeg') });
  }
});

// Progresso da edição em lote do álbum
app.get('/api/metadata/progress', (req, res) => {
  const jobId = String(req.query.jobId || '');
  const job = batchJobs.get(jobId);
  res.json({ ok: true, ...(job || { done: 0, total: 0, current: '' }) });
});

// Salvar metadados em lote para todas as faixas de um álbum
app.post('/api/metadata/album', handleCoverUpload, async (req, res) => {
  const body = req.body || {};
  const jobId = String(req.query.jobId || body.jobId || '');
  try {
    const srcArtist = String(req.query.artist || body.srcArtist || body.artist || '');
    const srcAlbum = req.query.album !== undefined
      ? String(req.query.album)
      : (body.srcAlbum !== undefined ? String(body.srcAlbum) : '');

    const tracks = listAlbumTracks(srcArtist, srcAlbum);
    if (!tracks.length) {
      return res.status(404).json({ error: 'Nenhuma faixa encontrada neste álbum.' });
    }

    const tagAlbum = body.tagAlbum !== undefined ? body.tagAlbum : body.album;
    const rawYear = body.year !== undefined ? body.year : body.date;

    const batchFields = {
      albumartist: cleanTagText(body.albumartist, 300),
      album: cleanTagText(tagAlbum, 300),
      year: cleanTagText(rawYear, 10),
      genre: cleanTagText(body.genre, 150)
    };

    const validationError = validateMetadataInput(batchFields, true);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const coverBuffer = req.file ? req.file.buffer : null;
    if (jobId) {
      batchJobs.set(jobId, { done: 0, total: tracks.length, current: tracks[0].rel });
    }

    let updatedCount = 0;
    const errors = [];
    for (let i = 0; i < tracks.length; i++) {
      const tr = tracks[i];
      if (jobId) {
        batchJobs.set(jobId, { done: i, total: tracks.length, current: tr.rel });
      }
      try {
        await writeMetadata(tr.full, batchFields, coverBuffer, true);
        updatedCount++;
      } catch (e) {
        errors.push(`${tr.rel}: ${e.message}`);
      }
    }

    if (jobId) {
      batchJobs.set(jobId, { done: tracks.length, total: tracks.length, current: '' });
      setTimeout(() => batchJobs.delete(jobId), 30000);
    }

    if (updatedCount === 0 && errors.length) {
      return res.status(500).json({ error: 'Falha ao atualizar faixas do álbum: ' + errors[0] });
    }

    res.json({
      ok: true,
      artist: srcArtist,
      album: srcAlbum,
      updated: updatedCount,
      total: tracks.length,
      errors
    });
  } catch (err) {
    if (jobId) batchJobs.delete(jobId);
    console.error('Erro na edição em lote do álbum:', err);
    res.status(500).json({ error: 'Erro ao atualizar o álbum: ' + (err.message || 'erro interno') });
  }
});

// ---------- Upload de Músicas ----------
function origName(file) {
  // multer entrega latin1; converte para UTF-8 (acentos)
  return Buffer.from(file.originalname, 'latin1').toString('utf8');
}
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const artist = sanitize(req.body.artist);
    const album = sanitize(req.body.album);
    if (!artist || !album) return cb(new Error('Informe o nome do artista e do álbum.'));
    const dest = safeJoin(artist, album);
    if (!dest) return cb(new Error('Nome de pasta inválido.'));
    fs.mkdir(dest, { recursive: true }, err =>
      cb(err ? new Error('Não foi possível criar a pasta: ' + err.message) : null, dest));
  },
  filename(req, file, cb) {
    const orig = origName(file);
    const ext = path.extname(orig).toLowerCase();
    const base = sanitize(path.basename(orig, path.extname(orig))) || 'faixa';
    const dest = safeJoin(sanitize(req.body.artist), sanitize(req.body.album));
    let name = base + ext, i = 1;
    while (fs.existsSync(path.join(dest, name))) name = `${base} (${i++})${ext}`;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_BYTES, files: 500 },
  fileFilter(req, file, cb) {
    const orig = origName(file);
    if (!isAudio(orig)) return cb(new Error(`Formato não suportado: "${orig}". Aceitos: ${EXTS.join(', ')}`));
    cb(null, true);
  }
});

app.post('/api/upload', (req, res) => {
  const len = parseInt(req.headers['content-length'] || '0', 10);
  if (len > MAX_BYTES) {
    req.resume();
    return res.status(413).json({ error: 'O envio excede o limite de 1 GB por requisição.' });
  }
  upload.array('files')(req, res, err => {
    if (err) {
      let msg = err.message;
      if (err.code === 'LIMIT_FILE_SIZE') msg = 'Um dos arquivos excede o limite de 1 GB.';
      else if (err.code === 'LIMIT_FILE_COUNT') msg = 'Arquivos demais em um único envio (máx. 500).';
      else if (err.code === 'ENOSPC') msg = 'Sem espaço em disco no servidor.';
      else if (err.code === 'EACCES') msg = 'Sem permissão de escrita na pasta de músicas.';
      return res.status(400).json({ error: msg });
    }
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'Nenhum arquivo foi enviado.' });
    res.json({
      ok: true,
      artist: sanitize(req.body.artist),
      album: sanitize(req.body.album),
      files: req.files.map(f => f.filename)
    });
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

// ---------- HTML: estilos comuns ----------
const BASE_CSS = `
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#0b0b0f;
  --bg2:#121217;
  --bg3:#1b1b22;
  --bg4:#23232c;
  --glass:rgba(30,30,38,.72);
  --border:rgba(255,255,255,.08);
  --border2:rgba(255,255,255,.14);
  --txt:#ffffff;
  --mut:#858591;
  --mut2:#5c5c68;
  --acc:#c8f53b;
  --acc2:#d6ff52;
  --err:#ff5c6c;
}
html,body{background:var(--bg);color:var(--txt);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;min-height:100vh}
a{color:var(--acc);text-decoration:none}
button,input,select,textarea{font:inherit;color:inherit}
.btn{background:var(--acc);color:#09090c;border:0;border-radius:999px;padding:12px 26px;font-weight:700;cursor:pointer;transition:transform .15s,background .2s,box-shadow .2s;letter-spacing:.2px}
.btn:hover{background:var(--acc2);transform:translateY(-1px);box-shadow:0 8px 24px rgba(200,245,59,.22)}
.btn:disabled{opacity:.45;cursor:not-allowed;transform:none;box-shadow:none}
.btn.ghost{background:rgba(255,255,255,.06);color:var(--txt);border:1px solid var(--border2)}
.btn.ghost:hover{border-color:rgba(255,255,255,.32);background:rgba(255,255,255,.1);box-shadow:none}
.input{width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:12px;padding:12px 14px;outline:none;transition:border .2s,box-shadow .2s;color:var(--txt)}
.input:focus{border-color:var(--acc);box-shadow:0 0 0 2px rgba(200,245,59,.2)}
label{display:block;font-size:12.5px;font-weight:600;margin:0 0 6px;color:var(--mut)}
.logo{display:flex;align-items:center;gap:10px;font-weight:700;font-size:20px;letter-spacing:-.3px}
.logo svg{width:32px;height:32px}
`;
const LOGO_SVG = `<svg viewBox="0 0 24 24" fill="#c8f53b"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm4.6 14.4a.62.62 0 01-.86.2c-2.35-1.43-5.3-1.76-8.79-.96a.62.62 0 11-.28-1.21c3.81-.87 7.09-.5 9.73 1.12.3.18.39.56.2.85zm1.22-2.72a.78.78 0 01-1.07.26c-2.69-1.65-6.79-2.13-9.97-1.17a.78.78 0 11-.45-1.49c3.63-1.1 8.15-.57 11.24 1.33.36.22.48.7.25 1.07zm.1-2.83C14.7 8.94 9.38 8.76 6.3 9.7a.94.94 0 11-.54-1.8c3.53-1.07 9.4-.86 13.1 1.34a.94.94 0 01-.95 1.62z"/></svg>`;

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function loginPage(error) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Entrar · My Music</title>
<style>${BASE_CSS}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;
background:radial-gradient(circle at 50% 95%,rgba(195,126,82,.32) 0,transparent 50%),radial-gradient(circle at 20% 10%,rgba(200,245,59,.1) 0,transparent 40%),#09090d}
.card{width:100%;max-width:400px;background:rgba(16,16,21,.92);border:1px solid var(--border2);border-radius:32px;padding:42px 32px;box-shadow:0 30px 80px rgba(0,0,0,.75);backdrop-filter:blur(16px)}
.card .logo{justify-content:center;margin-bottom:6px}
h1{text-align:center;font-size:24px;font-weight:700;margin:14px 0 28px;letter-spacing:-.4px}
.field{margin-bottom:18px}
.err{background:rgba(255,92,108,.12);border:1px solid var(--err);color:var(--err);padding:10px 14px;border-radius:12px;margin-bottom:18px;font-size:13.5px;text-align:center}
.btn{width:100%;margin-top:10px;padding:14px}
.pw{position:relative}.pw button{position:absolute;right:12px;top:50%;transform:translateY(-50%);background:none;border:0;color:var(--mut);cursor:pointer;font-size:12.5px;font-weight:600}
.foot{text-align:center;color:var(--mut);font-size:12px;margin-top:24px}
</style></head><body>
<form class="card" method="post" action="/login" autocomplete="on">
  <div class="logo">${LOGO_SVG}<span>My Music</span></div>
  <h1>Entrar na sua biblioteca</h1>
  ${error ? `<div class="err">${esc(error)}</div>` : ''}
  <div class="field"><label for="u">Usuário</label>
    <input class="input" id="u" name="username" required autofocus autocapitalize="none" autocomplete="username" placeholder="Seu usuário"></div>
  <div class="field"><label for="p">Senha</label>
    <div class="pw"><input class="input" id="p" name="password" type="password" required autocomplete="current-password" placeholder="Sua senha">
    <button type="button" onclick="var i=document.getElementById('p');i.type=i.type==='password'?'text':'password';this.textContent=i.type==='password'?'Mostrar':'Ocultar'">Mostrar</button></div></div>
  <button class="btn" type="submit">Entrar</button>
  <div class="foot">Servidor de música pessoal</div>
</form></body></html>`;
}

const APP_CSS = `
body{
  min-height:100vh;
  background:
    radial-gradient(circle at 50% 98%, rgba(196, 126, 78, .38) 0%, rgba(110, 68, 56, .18) 34%, transparent 65%),
    radial-gradient(circle at 50% 20%, rgba(46, 38, 58, .55) 0%, #09090d 72%);
  background-attachment:fixed;
  display:flex;
  align-items:center;
  justify-content:center;
  padding:28px 20px;
  overflow-x:hidden;
}
.app-stage{
  width:100%;
  max-width:980px;
  display:grid;
  grid-template-columns:minmax(360px, 440px) minmax(360px, 440px);
  justify-content:center;
  gap:44px;
  align-items:stretch;
}
.screen-card{
  background:#0c0c10;
  border-radius:44px;
  border:1px solid rgba(255,255,255,.11);
  box-shadow:0 32px 80px rgba(0,0,0,.78), inset 0 1px 0 rgba(255,255,255,.12);
  height:820px;
  max-height:calc(100vh - 56px);
  min-height:660px;
  display:flex;
  flex-direction:column;
  position:relative;
  overflow:hidden;
}
.screen-glow-top{
  position:absolute;
  top:-60px;left:10%;right:10%;height:180px;
  background:radial-gradient(ellipse at center, rgba(255,220,185,.08) 0%, transparent 70%);
  pointer-events:none;
  z-index:0;
}

/* Top Navigation Bar inside screens */
.s-top{
  position:relative;
  z-index:10;
  display:flex;
  align-items:center;
  justify-content:space-between;
  padding:24px 22px 14px;
  flex-shrink:0;
}
.s-title{
  font-size:16.5px;
  font-weight:600;
  color:#f5f5f7;
  letter-spacing:-.2px;
  text-align:center;
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
  padding:0 10px;
}
.icon-circle{
  width:40px;
  height:40px;
  border-radius:50%;
  background:rgba(255,255,255,.07);
  border:1px solid rgba(255,255,255,.1);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.14);
  color:#e8e8ee;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  cursor:pointer;
  transition:all .16s ease;
  flex-shrink:0;
  backdrop-filter:blur(12px);
}
.icon-circle:hover{
  background:rgba(255,255,255,.13);
  border-color:rgba(255,255,255,.2);
  transform:scale(1.04);
}
.icon-circle.liked{
  color:var(--acc);
  border-color:rgba(200,245,59,.35);
  background:rgba(200,245,59,.12);
}
.icon-circle svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}

/* Popover menu (three dots) */
.menu-pop{
  position:absolute;
  top:70px;
  right:22px;
  z-index:45;
  width:230px;
  background:rgba(22,22,29,.96);
  backdrop-filter:blur(20px);
  border:1px solid rgba(255,255,255,.14);
  border-radius:18px;
  padding:8px;
  box-shadow:0 20px 50px rgba(0,0,0,.75);
  display:none;
}
.menu-pop.on{display:block}
.menu-item{
  width:100%;
  background:none;
  border:0;
  color:#eee;
  padding:10px 12px;
  border-radius:11px;
  font-size:13.5px;
  font-weight:500;
  display:flex;
  align-items:center;
  gap:10px;
  cursor:pointer;
  text-align:left;
  transition:background .15s;
}
.menu-item:hover{background:rgba(255,255,255,.08)}
.menu-item.danger{color:var(--err)}
.menu-sep{height:1px;background:rgba(255,255,255,.08);margin:6px 4px}
.menu-stats{
  display:flex;
  justify-content:space-around;
  padding:8px 6px 4px;
  font-size:11.5px;
  color:var(--mut);
  text-align:center;
}
.menu-stats b{display:block;font-size:14px;color:var(--acc);font-weight:700}

/* Filter Pills Bar */
.pills-wrap{
  position:relative;
  z-index:5;
  padding:6px 22px 14px;
  flex-shrink:0;
}
.pills{
  display:flex;
  gap:9px;
  overflow-x:auto;
  scrollbar-width:none;
  -ms-overflow-style:none;
  padding-bottom:2px;
}
.pills::-webkit-scrollbar{display:none}
.pill{
  background:#1b1b21;
  border:1px solid rgba(255,255,255,.06);
  color:#8f8f99;
  padding:9px 18px;
  border-radius:999px;
  font-size:13.5px;
  font-weight:600;
  white-space:nowrap;
  cursor:pointer;
  transition:all .18s ease;
  flex-shrink:0;
}
.pill:hover{color:#fff;background:#24242c}
.pill.on{
  background:var(--acc);
  color:#0a0a0e;
  border-color:var(--acc);
  font-weight:700;
  box-shadow:0 4px 18px rgba(200,245,59,.22);
}

/* Search Box */
.search-drawer{
  padding:0 22px 12px;
  flex-shrink:0;
  position:relative;
  z-index:5;
}
.search-box{
  position:relative;
  display:flex;
  align-items:center;
}
.search-box svg{
  position:absolute;
  left:13px;
  width:15px;
  height:15px;
  color:var(--mut);
  pointer-events:none;
}
.search-box .input{
  padding:9px 34px 9px 36px;
  font-size:13.5px;
  border-radius:999px;
  background:#17171d;
  border-color:rgba(255,255,255,.08);
}
.search-clear{
  position:absolute;
  right:10px;
  background:none;
  border:0;
  color:var(--mut);
  cursor:pointer;
  font-size:16px;
  line-height:1;
  padding:4px;
}

/* Scrollable Content Area inside Left Screen */
.s-scroll{
  flex:1;
  overflow-y:auto;
  padding:2px 22px 105px;
  position:relative;
  z-index:2;
  scrollbar-width:thin;
  scrollbar-color:#26262f transparent;
}
.s-scroll::-webkit-scrollbar{width:5px}
.s-scroll::-webkit-scrollbar-thumb{background:#26262f;border-radius:99px}

/* Album & Song List Rows (Matching Reference Image) */
.m-list{display:flex;flex-direction:column;gap:14px}
.m-card{
  border-radius:16px;
  transition:background .18s ease;
}
.m-card.open{
  background:#14141a;
  border:1px solid rgba(255,255,255,.07);
  padding:10px;
  margin:0 -6px;
}
.m-row{
  display:flex;
  align-items:center;
  gap:14px;
  cursor:pointer;
  padding:3px 2px;
  border-radius:14px;
  transition:background .15s;
}
.m-row:hover{background:rgba(255,255,255,.03)}
.m-thumb{
  width:56px;
  height:56px;
  border-radius:14px;
  flex-shrink:0;
  position:relative;
  overflow:hidden;
  display:flex;
  align-items:center;
  justify-content:center;
  font-size:22px;
  box-shadow:0 6px 16px rgba(0,0,0,.45);
  border:1px solid rgba(255,255,255,.08);
}
.m-thumb img{
  position:absolute;
  inset:0;
  width:100%;
  height:100%;
  object-fit:cover;
  display:block;
}
.m-info{
  flex:1;
  min-width:0;
}
.m-info b{
  display:block;
  font-size:15.5px;
  font-weight:600;
  color:#f5f5f7;
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
  margin-bottom:3px;
  letter-spacing:-.15px;
}
.m-info span{
  display:block;
  font-size:12.5px;
  color:var(--mut);
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
}
.m-actions{
  display:flex;
  align-items:center;
  gap:6px;
  flex-shrink:0;
}
.row-icon-btn{
  width:30px;
  height:30px;
  border-radius:50%;
  border:0;
  background:transparent;
  color:var(--mut);
  display:inline-flex;
  align-items:center;
  justify-content:center;
  cursor:pointer;
  opacity:.65;
  transition:all .15s;
  font-size:13px;
}
.row-icon-btn:hover{opacity:1;background:rgba(255,255,255,.09);color:#fff}
.play-dot{
  width:38px;
  height:38px;
  border-radius:50%;
  background:#1d1d24;
  border:1px solid rgba(255,255,255,.07);
  color:#fff;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  cursor:pointer;
  transition:all .16s ease;
  flex-shrink:0;
}
.play-dot:hover{
  background:#292933;
  transform:scale(1.06);
}
.play-dot.playing{
  background:var(--acc);
  color:#0a0a0e;
  border-color:var(--acc);
  box-shadow:0 4px 14px rgba(200,245,59,.28);
}
.play-dot svg{width:13px;height:13px;fill:currentColor}

/* Expanded Album Tracks Drawer */
.tracks{
  display:none;
  margin-top:10px;
  padding-top:8px;
  border-top:1px solid rgba(255,255,255,.07);
}
.m-card.open .tracks{display:block}
.album-bar{
  display:flex;
  align-items:center;
  justify-content:space-between;
  padding:2px 6px 8px;
  font-size:12px;
  color:var(--mut);
}
.track{
  display:flex;
  align-items:center;
  gap:10px;
  padding:8px 8px;
  border-radius:10px;
  cursor:pointer;
  transition:background .14s;
}
.track:hover{background:rgba(255,255,255,.05)}
.track.playing{background:rgba(200,245,59,.08)}
.track.playing .t, .track.playing .n{color:var(--acc);font-weight:600}
.track .n{width:22px;text-align:right;color:var(--mut);font-size:12.5px;flex-shrink:0}
.track .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px}
.track .t small{color:var(--mut);font-size:11.5px;margin-left:6px;font-weight:400}
.track .s{color:var(--mut);font-size:11.5px;flex-shrink:0}
.ext{font-size:9.5px;background:#23232c;border-radius:5px;padding:2px 5px;color:var(--mut);text-transform:uppercase;flex-shrink:0}
.btn-edit{
  background:#22222b;
  color:#d8d8e2;
  border:1px solid rgba(255,255,255,.1);
  border-radius:999px;
  padding:4px 10px;
  font-size:11.5px;
  font-weight:600;
  cursor:pointer;
  transition:all .15s;
  flex-shrink:0;
  display:inline-flex;
  align-items:center;
  gap:4px;
}
.btn-edit:hover{background:var(--acc);color:#09090c;border-color:var(--acc)}
.empty{text-align:center;color:var(--mut);padding:48px 18px;font-size:14px;line-height:1.5}

/* Floating Glass Mini-Player Pill at Bottom of Left Screen */
.mini-pill-wrap{
  position:absolute;
  left:0;right:0;bottom:0;
  height:92px;
  background:linear-gradient(to top, #0c0c10 25%, rgba(12,12,16,0));
  display:flex;
  flex-direction:column;
  align-items:center;
  justify-content:flex-end;
  padding-bottom:14px;
  pointer-events:none;
  z-index:20;
}
.mini-pill{
  pointer-events:auto;
  height:52px;
  min-width:168px;
  padding:0 18px;
  border-radius:999px;
  background:rgba(34, 34, 42, .76);
  backdrop-filter:blur(20px);
  -webkit-backdrop-filter:blur(20px);
  border:1px solid rgba(255,255,255,.13);
  box-shadow:0 14px 34px rgba(0,0,0,.65), inset 0 1px 0 rgba(255,255,255,.15);
  display:flex;
  align-items:center;
  justify-content:center;
  gap:20px;
}
.mp-btn{
  background:none;
  border:0;
  color:#f2f2f7;
  cursor:pointer;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  padding:6px;
  border-radius:50%;
  transition:transform .14s,color .14s;
}
.mp-btn:hover{transform:scale(1.12);color:var(--acc)}
.mp-btn.on{color:var(--acc)}
.mp-btn svg{width:18px;height:18px;fill:currentColor}
.home-bar{
  width:124px;
  height:4px;
  border-radius:99px;
  background:rgba(255,255,255,.82);
  margin-top:12px;
}
`;

const APP_CSS2 = `
/* ---------- Right Screen: Now Playing ---------- */
.np-ambient{
  position:absolute;
  top:-30px;left:-30px;right:-30px;
  height:56%;
  background:radial-gradient(circle at 50% 30%, rgba(196, 128, 86, .42), rgba(40, 32, 30, .2) 60%, transparent 80%);
  filter:blur(42px) saturate(1.35);
  opacity:.85;
  pointer-events:none;
  z-index:0;
  transition:background .5s ease;
}
.np-ambient-img{
  position:absolute;
  top:-20px;left:-20px;right:-20px;
  height:52%;
  background-size:cover;
  background-position:center;
  filter:blur(52px) saturate(1.4) brightness(.52);
  opacity:.72;
  pointer-events:none;
  z-index:0;
  transition:background-image .4s ease;
}
.np-body{
  position:relative;
  z-index:5;
  flex:1;
  display:flex;
  flex-direction:column;
  align-items:center;
  justify-content:space-between;
  padding:4px 28px 20px;
  overflow-y:auto;
}

/* Circular Turntable / Vinyl Artwork with Arc Progress */
.np-wheel-wrap{
  position:relative;
  width:266px;
  height:266px;
  display:flex;
  align-items:center;
  justify-content:center;
  margin:4px auto 6px;
  flex-shrink:0;
}
.np-outer-ring{
  position:absolute;
  inset:0;
  border-radius:50%;
  border:1px solid rgba(255,255,255,.08);
  background:radial-gradient(circle, rgba(25,25,32,.65) 58%, rgba(15,15,20,.92) 100%);
  box-shadow:0 20px 50px rgba(0,0,0,.65), inset 0 0 24px rgba(0,0,0,.6);
}
.np-ring-svg{
  position:absolute;
  inset:0;
  width:100%;
  height:100%;
  z-index:3;
  cursor:pointer;
}
.np-cover{
  width:186px;
  height:186px;
  border-radius:50%;
  overflow:hidden;
  position:relative;
  z-index:2;
  box-shadow:0 12px 34px rgba(0,0,0,.7);
  border:2px solid rgba(255,255,255,.1);
  display:flex;
  align-items:center;
  justify-content:center;
  font-size:52px;
  background:linear-gradient(135deg,#c27856,#2b3a42);
}
.np-cover img{
  width:100%;
  height:100%;
  object-fit:cover;
  display:block;
}
.np-ring-time{
  position:absolute;
  bottom:13px;
  left:50%;
  transform:translateX(-50%);
  z-index:4;
  font-size:11px;
  font-weight:500;
  color:rgba(255,255,255,.72);
  letter-spacing:.3px;
  background:rgba(15,15,20,.65);
  padding:2px 8px;
  border-radius:99px;
  backdrop-filter:blur(4px);
  white-space:nowrap;
}
.np-ring-time i{
  font-style:normal;
  color:rgba(255,255,255,.28);
  margin:0 4px;
}

/* Title & Artist in Now Playing */
.np-meta{
  text-align:center;
  width:100%;
  margin:4px 0;
}
.np-meta b{
  display:block;
  font-size:22px;
  font-weight:700;
  color:#ffffff;
  letter-spacing:-.3px;
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
  margin-bottom:5px;
}
.np-meta span{
  display:block;
  font-size:13.5px;
  color:rgba(255,255,255,.62);
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
}

/* 3-Line Spotlight Lyrics */
.np-lyrics{
  width:100%;
  text-align:center;
  padding:8px 6px;
  min-height:76px;
  display:flex;
  flex-direction:column;
  justify-content:center;
  gap:6px;
  cursor:pointer;
  border-radius:14px;
  transition:background .15s;
}
.np-lyrics:hover{background:rgba(255,255,255,.03)}
.np-lyrics p{
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
  transition:all .25s ease;
}
.np-lyrics .ly-dim{
  font-size:13px;
  color:rgba(255,255,255,.34);
  font-weight:400;
}
.np-lyrics .ly-act{
  font-size:14.5px;
  color:#ffffff;
  font-weight:500;
  letter-spacing:-.1px;
}

/* Linear Scrubber Bar */
.np-scrub{
  width:100%;
  margin:4px 0 2px;
}
.np-bar-hit{
  padding:8px 0;
  cursor:pointer;
}
.np-bar-track{
  height:4px;
  background:rgba(255,255,255,.13);
  border-radius:99px;
  position:relative;
}
.np-bar-fill{
  height:100%;
  width:0%;
  background:var(--acc);
  border-radius:99px;
  position:relative;
}
.np-bar-thumb{
  width:13px;
  height:13px;
  border-radius:50%;
  background:var(--acc);
  box-shadow:0 0 10px rgba(200,245,59,.7);
  position:absolute;
  right:-6.5px;
  top:50%;
  transform:translateY(-50%);
}
.np-times{
  display:flex;
  justify-content:space-between;
  font-size:11.5px;
  color:rgba(255,255,255,.45);
  margin-top:4px;
  font-variant-numeric:tabular-nums;
}

/* Bottom 5-Button Transport Controls */
.np-ctl{
  width:100%;
  display:flex;
  align-items:center;
  justify-content:space-between;
  padding:4px 4px 2px;
}
.ctl-ghost{
  width:38px;
  height:38px;
  border-radius:50%;
  border:0;
  background:transparent;
  color:rgba(255,255,255,.72);
  display:inline-flex;
  align-items:center;
  justify-content:center;
  cursor:pointer;
  transition:all .15s;
}
.ctl-ghost:hover{color:#fff;background:rgba(255,255,255,.07)}
.ctl-ghost.on{color:var(--acc)}
.ctl-ghost svg{width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.ctl-dark{
  width:46px;
  height:46px;
  border-radius:50%;
  background:#1b1b22;
  border:1px solid rgba(255,255,255,.07);
  color:#ffffff;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  cursor:pointer;
  transition:all .15s;
}
.ctl-dark:hover{background:#262630;transform:scale(1.05)}
.ctl-dark svg{width:18px;height:18px;fill:currentColor}
.ctl-lime{
  width:64px;
  height:64px;
  border-radius:50%;
  background:var(--acc);
  border:0;
  color:#0a0a0e;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  cursor:pointer;
  box-shadow:0 10px 28px rgba(200,245,59,.3);
  transition:transform .15s,background .15s,box-shadow .15s;
}
.ctl-lime:hover{background:var(--acc2);transform:scale(1.05);box-shadow:0 12px 32px rgba(200,245,59,.42)}
.ctl-lime svg{width:24px;height:24px;fill:currentColor}

/* Upload Panel inside Left Screen */
.panel{background:#14141b;border:1px solid var(--border);border-radius:20px;padding:18px}
.row{display:grid;grid-template-columns:1fr;gap:14px;margin-bottom:14px}
.mode{display:flex;gap:6px;margin-bottom:8px}
.mode button{flex:1;padding:7px;border-radius:99px;border:1px solid var(--border2);background:var(--bg3);color:var(--mut);cursor:pointer;font-size:12.5px;font-weight:600}
.mode button.on{border-color:var(--acc);color:var(--acc);background:rgba(200,245,59,.1)}
.drop{border:1.5px dashed rgba(255,255,255,.18);border-radius:16px;padding:26px 14px;text-align:center;cursor:pointer;transition:all .2s;margin-bottom:14px;background:rgba(255,255,255,.02)}
.drop.over{border-color:var(--acc);background:rgba(200,245,59,.08)}
.drop .ic{font-size:32px;margin-bottom:6px}
.drop p{color:var(--mut);font-size:12.5px;margin-top:4px}
.files{max-height:190px;overflow:auto;margin-bottom:14px}
.file{display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg3);border-radius:10px;margin-bottom:6px;font-size:13px}
.file .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.file .x{background:none;border:0;color:var(--mut);cursor:pointer;font-size:17px;line-height:1}
.file .x:hover{color:var(--err)}
.prog{display:none;margin-bottom:14px}
.prog .tr{height:8px;background:#262630;border-radius:99px;overflow:hidden}
.prog .fill{height:100%;width:0;background:linear-gradient(90deg,var(--acc),var(--acc2));transition:width .15s}
.prog .lbl{display:flex;justify-content:space-between;color:var(--mut);font-size:12px;margin-top:6px}
.msg{padding:11px 13px;border-radius:12px;margin-bottom:14px;font-size:13px;display:none}
.msg.ok{display:block;background:rgba(200,245,59,.12);border:1px solid var(--acc);color:#e2ff88}
.msg.bad{display:block;background:rgba(255,92,108,.12);border:1px solid var(--err);color:#ff9aa4}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.actions .btn{padding:10px 18px;font-size:13.5px}
.hidden{display:none!important}

/* Modals (Track & Album Metadata) */
.modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.78);backdrop-filter:blur(8px);z-index:100;display:flex;align-items:center;justify-content:center;padding:16px;opacity:0;pointer-events:none;transition:opacity .18s}
.modal-backdrop.on{opacity:1;pointer-events:auto}
.modal{background:#14141b;border:1px solid rgba(255,255,255,.12);border-radius:24px;width:100%;max-width:700px;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 28px 80px rgba(0,0,0,.85);overflow:hidden;transform:translateY(10px);transition:transform .18s}
.modal-backdrop.on .modal{transform:translateY(0)}
.modal.modal-sm{max-width:520px}
.m-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 22px;border-bottom:1px solid var(--border);background:#101016}
.m-head h3{font-size:18px;font-weight:700}
.m-head p{color:var(--mut);font-size:12px;margin-top:2px;word-break:break-all}
.m-close{background:rgba(255,255,255,.06);border:1px solid var(--border);color:var(--mut);font-size:22px;line-height:1;cursor:pointer;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.m-close:hover{background:rgba(255,255,255,.14);color:#fff}
.m-body{padding:20px 22px;overflow-y:auto;flex:1}
.m-foot{display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:14px 22px;border-top:1px solid var(--border);background:#101016}
.cov-box{display:flex;align-items:center;gap:18px;background:#0d0d12;border:1px solid var(--border);border-radius:16px;padding:14px;margin-bottom:18px}
.cov-thumb{width:92px;height:92px;border-radius:14px;background:var(--bg3);border:1px solid var(--border2);display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;position:relative;font-size:30px;color:var(--mut)}
.cov-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.cov-ctl{flex:1;min-width:0}
.cov-ctl b{display:block;font-size:14px;margin-bottom:4px}
.cov-ctl p{color:var(--mut);font-size:12px;margin-bottom:10px}
.cov-btns{display:flex;gap:8px;flex-wrap:wrap}
.btn.sm{padding:8px 15px;font-size:12.5px}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
.grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:14px}
.grid-4{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-bottom:14px}
.field-mb{margin-bottom:14px}
.chk-row{display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg3);border:1px solid var(--border2);border-radius:12px;margin-bottom:14px;cursor:pointer;user-select:none}
.chk-row input{width:18px;height:18px;accent-color:var(--acc);cursor:pointer}
.chk-row span{font-size:13.5px;font-weight:600;color:var(--txt)}
textarea.input{min-height:120px;resize:vertical;line-height:1.45;font-family:inherit}
.batch-prog{background:#0d0d12;border:1px solid var(--border);border-radius:12px;padding:14px;margin-top:12px;display:none}
.batch-prog.on{display:block}
.batch-prog-top{display:flex;align-items:center;gap:10px;margin-bottom:8px;font-size:13px;color:var(--txt)}
.spinner{width:18px;height:18px;border:2.5px solid #333;border-top-color:var(--acc);border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0}
@keyframes spin{to{transform:rotate(360deg)}}
.toast{position:fixed;right:24px;bottom:24px;z-index:200;background:#182210;border:1px solid var(--acc);color:#fff;padding:13px 18px;border-radius:14px;box-shadow:0 16px 40px rgba(0,0,0,.75);font-size:13.5px;font-weight:600;display:flex;align-items:center;gap:10px;transform:translateY(20px);opacity:0;pointer-events:none;transition:all .22s}
.toast.on{transform:translateY(0);opacity:1;pointer-events:auto}
.toast.bad{background:#2a1216;border-color:var(--err);color:#ffb3ba}

/* Responsive Mobile Layout */
@media(max-width:860px){
  body{padding:0;align-items:stretch}
  .app-stage{grid-template-columns:1fr;max-width:100%;gap:0}
  .screen-card{
    border-radius:0;
    border:0;
    height:100dvh;
    max-height:none;
    min-height:100dvh;
  }
  #scr-np{
    position:fixed;
    inset:0;
    z-index:50;
    transform:translateY(104%);
    transition:transform .32s cubic-bezier(.22,1,.36,1);
  }
  #scr-np.mob-open{
    transform:translateY(0);
  }
  .grid-2,.grid-3,.grid-4{grid-template-columns:1fr}
  .cov-box{flex-direction:column;align-items:flex-start}
}
`;

function appPage() {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0c0c10">
<title>My Music</title>
<style>${BASE_CSS}${APP_CSS}${APP_CSS2}</style></head><body>

<div class="app-stage">
  <!-- LEFT SCREEN: My Music Library & Upload -->
  <section class="screen-card" id="scr-lib">
    <div class="screen-glow-top"></div>

    <header class="s-top">
      <button type="button" class="icon-circle" id="nav-back" title="Voltar">
        <svg viewBox="0 0 24 24"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
      </button>
      <div class="s-title" id="nav-title">My Music</div>
      <button type="button" class="icon-circle" id="nav-menu-btn" title="Opções">
        <svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/></svg>
      </button>
    </header>

    <!-- Dropdown Menu -->
    <div class="menu-pop" id="nav-menu">
      <div class="menu-stats">
        <div><b id="s-art">0</b>Artistas</div>
        <div><b id="s-alb">0</b>Álbuns</div>
        <div><b id="s-trk">0</b>Faixas</div>
      </div>
      <div class="menu-sep"></div>
      <button type="button" class="menu-item" id="m-btn-search">🔍 Buscar na biblioteca</button>
      <button type="button" class="menu-item" id="m-btn-up">⬆️ Enviar músicas</button>
      <button type="button" class="menu-item" id="reload">🔄 Atualizar biblioteca</button>
      <div class="menu-sep"></div>
      <form method="post" action="/logout"><button class="menu-item danger" type="submit">🚪 Sair da conta</button></form>
    </div>

    <!-- Category Filter Pills -->
    <div class="pills-wrap">
      <div class="pills" id="pills">
        <button type="button" class="pill on" data-filter="all">All</button>
        <button type="button" class="pill" data-filter="playlists">Playlists</button>
        <button type="button" class="pill" data-filter="liked">Liked Songs</button>
        <button type="button" class="pill" data-filter="downloads">Downloads</button>
        <button type="button" class="pill" data-filter="up">+ Upload</button>
      </div>
    </div>

    <!-- Collapsible Search Bar -->
    <div class="search-drawer hidden" id="search-drawer">
      <div class="search-box">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <input class="input" id="q" type="search" placeholder="Buscar artista, álbum ou música...">
        <button type="button" class="search-clear" id="q-clear" title="Fechar busca">×</button>
      </div>
    </div>

    <!-- Library & Upload Scroll Container -->
    <div class="s-scroll">
      <div id="v-lib">
        <div id="lib"><div class="empty">Carregando biblioteca...</div></div>
      </div>

      <div id="v-up" class="hidden">
        <div class="panel">
          <div id="msg" class="msg"></div>
          <div class="row">
            <div>
              <label>Artista</label>
              <div class="mode" id="am"><button type="button" class="on" data-m="sel">Existente</button><button type="button" data-m="new">Novo</button></div>
              <select class="input" id="a-sel"></select>
              <input class="input hidden" id="a-new" placeholder="Nome do novo artista" maxlength="150">
            </div>
            <div>
              <label>Álbum</label>
              <div class="mode" id="bm"><button type="button" class="on" data-m="sel">Existente</button><button type="button" data-m="new">Novo</button></div>
              <select class="input" id="b-sel"></select>
              <input class="input hidden" id="b-new" placeholder="Nome do novo álbum" maxlength="150">
            </div>
          </div>
          <div class="drop" id="drop">
            <div class="ic">🎵</div>
            <b>Arraste os arquivos ou toque para selecionar</b>
            <p>Formatos: ${EXTS.join(', ')} · Até 1 GB</p>
            <input type="file" id="fi" multiple accept="${EXTS.join(',')},audio/*" hidden>
          </div>
          <div class="files" id="files"></div>
          <div class="prog" id="prog"><div class="tr"><div class="fill" id="fill"></div></div>
            <div class="lbl"><span id="plbl">Enviando...</span><span id="ppct">0%</span></div></div>
          <div class="actions">
            <button class="btn" id="send" disabled>Enviar</button>
            <button class="btn ghost" id="clear">Limpar</button>
            <button class="btn ghost hidden" id="cancel">Cancelar</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Floating Bottom Mini-Player Pill -->
    <div class="mini-pill-wrap">
      <div class="mini-pill" id="mini-pill" title="Abrir Now Playing">
        <button type="button" class="mp-btn" id="mp-prev" title="Anterior">
          <svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
        </button>
        <button type="button" class="mp-btn" id="mp-play" title="Reproduzir / Pausar">
          <svg id="mp-play-ic" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        </button>
        <button type="button" class="mp-btn" id="mp-shuf" title="Modo aleatório">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>
        </button>
      </div>
      <div class="home-bar"></div>
    </div>
  </section>

  <!-- RIGHT SCREEN: Now Playing -->
  <section class="screen-card" id="scr-np">
    <div class="np-ambient" id="np-ambient"></div>
    <div class="np-ambient-img" id="np-ambient-img"></div>

    <header class="s-top">
      <button type="button" class="icon-circle" id="np-back" title="Voltar para biblioteca">
        <svg viewBox="0 0 24 24"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
      </button>
      <div class="s-title">Now Playing</div>
      <button type="button" class="icon-circle" id="np-like" title="Curtir faixa">
        <svg id="np-like-svg" viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
      </button>
    </header>

    <div class="np-body" id="player">
      <!-- Circular Artwork + SVG Progress Ring -->
      <div class="np-wheel-wrap" id="np-wheel">
        <div class="np-outer-ring"></div>
        <svg class="np-ring-svg" id="np-ring-svg" viewBox="0 0 266 266">
          <circle cx="133" cy="133" r="113" fill="none" stroke="rgba(255,255,255,0.09)" stroke-width="2.5"/>
          <path id="np-arc" d="" fill="none" stroke="#c8f53b" stroke-width="3.5" stroke-linecap="round"/>
          <circle id="np-arc-dot" cx="20" cy="133" r="5.5" fill="#ffffff" style="filter:drop-shadow(0 0 6px rgba(255,255,255,0.9))"/>
        </svg>
        <div class="np-cover" id="np-cover">🎵</div>
        <div class="np-ring-time"><span id="np-rt-cur">0:00</span><i>|</i><span id="np-rt-dur">0:00</span></div>
      </div>

      <!-- Song Title & Artist -->
      <div class="np-meta">
        <b id="p-t">Selecione uma música</b>
        <span id="p-a">Sua biblioteca pessoal</span>
      </div>

      <!-- 3-Line Spotlight Lyrics -->
      <div class="np-lyrics" id="np-lyrics" title="Toque para ver/editar letra e metadados">
        <p class="ly-dim" id="ly-0">Whispers in the midnight breeze,</p>
        <p class="ly-act" id="ly-1">Carrying dreams across the seas,</p>
        <p class="ly-dim" id="ly-2">I close my eyes, let go, and drift away.</p>
      </div>

      <!-- Linear Progress Bar -->
      <div class="np-scrub">
        <div class="np-bar-hit" id="np-bar-hit">
          <div class="np-bar-track">
            <div class="np-bar-fill" id="np-bar-fill">
              <div class="np-bar-thumb"></div>
            </div>
          </div>
        </div>
        <div class="np-times">
          <span id="np-t-cur">0:00</span>
          <span id="np-t-rem">-0:00</span>
        </div>
      </div>

      <!-- Transport Buttons -->
      <div class="np-ctl">
        <button type="button" class="ctl-ghost" id="p-shuf" title="Aleatório">
          <svg viewBox="0 0 24 24"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>
        </button>
        <button type="button" class="ctl-dark" id="p-prev" title="Anterior">
          <svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
        </button>
        <button type="button" class="ctl-lime" id="p-play" title="Reproduzir / Pausar">
          <svg id="p-play-ic" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        </button>
        <button type="button" class="ctl-dark" id="p-next" title="Próxima">
          <svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
        </button>
        <button type="button" class="ctl-ghost" id="p-meta-btn" title="Editar metadados / Letra da faixa">
          <svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
        </button>
      </div>

      <div class="home-bar" style="margin-top:6px"></div>
    </div>
    <audio id="audio" preload="metadata" hidden></audio>
  </section>
</div>

<!-- Modal: Edição de Metadados da Faixa -->
<div class="modal-backdrop" id="m-track" role="dialog" aria-modal="true" aria-labelledby="mt-title">
  <div class="modal">
    <div class="m-head">
      <div>
        <h3 id="mt-title">✏️ Editar metadados da faixa</h3>
        <p id="mt-sub"></p>
      </div>
      <button type="button" class="m-close" data-close="m-track" title="Fechar (ESC)">×</button>
    </div>
    <form class="m-body" id="f-track" onsubmit="return false">
      <div id="mt-err" class="msg"></div>
      <div class="cov-box">
        <div class="cov-thumb" id="mt-cov-preview">🎵</div>
        <div class="cov-ctl">
          <b>Capa da música (attached_pic)</b>
          <p id="mt-cov-status">Formatos aceitos: JPG ou PNG · Tamanho máximo: 10 MB</p>
          <div class="cov-btns">
            <button type="button" class="btn sm ghost" id="mt-cov-btn">🖼️ Trocar capa...</button>
            <button type="button" class="btn sm ghost hidden" id="mt-cov-reset">Desfazer troca</button>
            <input type="file" id="mt-cov-input" accept=".jpg,.jpeg,.png,image/jpeg,image/png" hidden>
          </div>
        </div>
      </div>

      <div class="grid-2">
        <div>
          <label for="mt-f-title">Título</label>
          <input class="input" id="mt-f-title" name="title" maxlength="300" placeholder="Título da faixa">
        </div>
        <div>
          <label for="mt-f-artist">Artista</label>
          <input class="input" id="mt-f-artist" name="artist" maxlength="300" placeholder="Artista da faixa">
        </div>
      </div>

      <div class="grid-2">
        <div>
          <label for="mt-f-album">Álbum</label>
          <input class="input" id="mt-f-album" name="album" maxlength="300" placeholder="Nome do álbum">
        </div>
        <div>
          <label for="mt-f-albumartist">Artista do álbum (Album Artist)</label>
          <input class="input" id="mt-f-albumartist" name="albumartist" maxlength="300" placeholder="Artista principal do álbum">
        </div>
      </div>

      <div class="grid-4">
        <div>
          <label for="mt-f-year">Ano</label>
          <input class="input" id="mt-f-year" name="year" type="number" min="1000" max="2999" step="1" placeholder="Ex: 2024">
        </div>
        <div>
          <label for="mt-f-track">Nº da faixa</label>
          <input class="input" id="mt-f-track" name="track" inputmode="numeric" maxlength="20" placeholder="Ex: 1 ou 1/12">
        </div>
        <div>
          <label for="mt-f-disc">Nº do disco</label>
          <input class="input" id="mt-f-disc" name="disc" inputmode="numeric" maxlength="20" placeholder="Ex: 1 ou 1/2">
        </div>
        <div>
          <label for="mt-f-bpm">BPM</label>
          <input class="input" id="mt-f-bpm" name="bpm" type="number" min="1" max="999" step="1" placeholder="Ex: 120">
        </div>
      </div>

      <div class="grid-2">
        <div>
          <label for="mt-f-genre">Gênero</label>
          <input class="input" id="mt-f-genre" name="genre" maxlength="150" placeholder="Ex: Rock, MPB, Eletrônica">
        </div>
        <div>
          <label for="mt-f-composer">Compositor</label>
          <input class="input" id="mt-f-composer" name="composer" maxlength="300" placeholder="Nome do(s) compositor(es)">
        </div>
      </div>

      <div class="field-mb">
        <label for="mt-f-comment">Comentário</label>
        <input class="input" id="mt-f-comment" name="comment" maxlength="2000" placeholder="Observações ou notas sobre a faixa">
      </div>

      <label class="chk-row" for="mt-f-compilation">
        <input type="checkbox" id="mt-f-compilation" name="compilation">
        <span>Compilação / Vários artistas (Compilation)</span>
      </label>

      <div>
        <label for="mt-f-lyrics">Letra da música (USLT / LYRICS)</label>
        <textarea class="input" id="mt-f-lyrics" name="lyrics" placeholder="Cole ou digite a letra da música aqui..."></textarea>
      </div>
    </form>
    <div class="m-foot">
      <button type="button" class="btn ghost" id="mt-cancel" data-close="m-track">Cancelar</button>
      <button type="button" class="btn" id="mt-save">Salvar</button>
    </div>
  </div>
</div>

<!-- Modal: Edição em Lote do Álbum -->
<div class="modal-backdrop" id="m-album" role="dialog" aria-modal="true" aria-labelledby="ma-title">
  <div class="modal modal-sm">
    <div class="m-head">
      <div>
        <h3 id="ma-title">✏️ Editar álbum em lote</h3>
        <p id="ma-sub"></p>
      </div>
      <button type="button" class="m-close" data-close="m-album" title="Fechar (ESC)">×</button>
    </div>
    <form class="m-body" id="f-album" onsubmit="return false">
      <div id="ma-err" class="msg"></div>
      <div class="cov-box">
        <div class="cov-thumb" id="ma-cov-preview">💿</div>
        <div class="cov-ctl">
          <b>Capa do álbum (aplicada em todas as faixas)</b>
          <p id="ma-cov-status">Se não selecionar nova imagem, a capa atual de cada faixa será mantida.</p>
          <div class="cov-btns">
            <button type="button" class="btn sm ghost" id="ma-cov-btn">🖼️ Escolher capa (JPG/PNG)...</button>
            <button type="button" class="btn sm ghost hidden" id="ma-cov-reset">Desfazer troca</button>
            <input type="file" id="ma-cov-input" accept=".jpg,.jpeg,.png,image/jpeg,image/png" hidden>
          </div>
        </div>
      </div>

      <div class="field-mb">
        <label for="ma-f-albumartist">Artista do álbum (Album Artist)</label>
        <input class="input" id="ma-f-albumartist" name="albumartist" maxlength="300" placeholder="Nome do artista do álbum">
      </div>

      <div class="field-mb">
        <label for="ma-f-album">Álbum</label>
        <input class="input" id="ma-f-album" name="album" maxlength="300" placeholder="Título do álbum">
      </div>

      <div class="grid-2">
        <div>
          <label for="ma-f-year">Ano</label>
          <input class="input" id="ma-f-year" name="year" type="number" min="1000" max="2999" step="1" placeholder="Ex: 2024">
        </div>
        <div>
          <label for="ma-f-genre">Gênero</label>
          <input class="input" id="ma-f-genre" name="genre" maxlength="150" placeholder="Ex: Rock, Pop, MPB">
        </div>
      </div>

      <div class="batch-prog" id="ma-prog">
        <div class="batch-prog-top">
          <div class="spinner"></div>
          <span id="ma-prog-lbl">Aplicando metadados nas faixas...</span>
          <span id="ma-prog-pct" style="margin-left:auto;color:var(--acc);font-weight:700">0%</span>
        </div>
        <div class="tr" style="height:8px;background:#262630;border-radius:99px;overflow:hidden">
          <div class="fill" id="ma-prog-fill" style="height:100%;width:0;background:linear-gradient(90deg,var(--acc),var(--acc2));transition:width .2s"></div>
        </div>
      </div>
    </form>
    <div class="m-foot">
      <button type="button" class="btn ghost" id="ma-cancel" data-close="m-album">Cancelar</button>
      <button type="button" class="btn" id="ma-save">Salvar em todas as faixas</button>
    </div>
  </div>
</div>

<!-- Toast visual -->
<div class="toast" id="toast"></div>

<script>window.EXTS=${JSON.stringify(EXTS)};window.MAX=${MAX_BYTES};window.MAX_COVER=${MAX_COVER_BYTES};</script>
<script>${CLIENT_JS}</script>
</body></html>`;
}

// ---------- JS do navegador (serializado via toString) ----------
/* eslint-env browser */
function clientMain() {
  const $ = s => document.querySelector(s);
  const h = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = b => b < 1024 * 1024 ? (b / 1024).toFixed(0) + ' KB' : b < 1024 ** 3 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024 ** 3).toFixed(2) + ' GB';
  const hue = s => { let x = 0; for (const c of String(s || '')) x = (x * 31 + c.charCodeAt(0)) % 360; return x; };
  const grad = s => { const a = hue(s); return 'linear-gradient(135deg,hsl(' + a + ',62%,42%),hsl(' + ((a + 48) % 360) + ',58%,22%))'; };
  const extOf = n => (n.split('.').pop() || '').toLowerCase();
  const title = n => n.split('/').pop().replace(/\.[^.]+$/, '');
  const fmtTime = sec => {
    if (!sec || !isFinite(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  };

  const PLAY_SVG = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
  const PAUSE_SVG = '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';

  let toastTimer = null;
  function showToast(text, isBad) {
    const el = $('#toast');
    el.className = 'toast on' + (isBad ? ' bad' : '');
    el.innerHTML = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), 4200);
  }

  async function api(url, opt) {
    const r = await fetch(url, Object.assign({ credentials: 'same-origin' }, opt));
    if (r.status === 401) { location.href = '/login'; throw new Error('Sessão expirada'); }
    let data = null;
    try { data = await r.json(); } catch {}
    if (!r.ok) throw new Error((data && data.error) || ('Erro ' + r.status));
    return data;
  }

  // ---- Estado Global ----
  let LIB = null, queue = [], qi = -1, coverVer = Date.now();
  let curFilter = 'all'; // 'all' | 'playlists' | 'liked' | 'downloads' | 'up'
  let shuffleOn = false;
  let curLyrics = []; // array de { time: number|null, text: string }
  const openAlbums = new Set();
  const albumKey = (arName, alName) => arName + '\0' + alName;
  const trackKey = (arName, alName, file) => arName + '\0' + alName + '\0' + file;

  // ---- Favoritos (Liked Songs) em localStorage ----
  let likedSet = new Set();
  try {
    const raw = JSON.parse(localStorage.getItem('ms_liked_v1') || '[]');
    if (Array.isArray(raw)) likedSet = new Set(raw);
  } catch {}
  function saveLiked() {
    try { localStorage.setItem('ms_liked_v1', JSON.stringify([...likedSet])); } catch {}
  }
  function isTrackLiked(arName, alParam, file) {
    return likedSet.has(trackKey(arName, alParam, file));
  }
  function toggleTrackLike(arName, alParam, file) {
    const k = trackKey(arName, alParam, file);
    if (likedSet.has(k)) likedSet.delete(k);
    else likedSet.add(k);
    saveLiked();
    updateLikeButton();
    if (curFilter === 'liked') render();
  }

  // ---- Menu (•••) & Busca & Navegação ----
  const navMenu = $('#nav-menu');
  $('#nav-menu-btn').onclick = e => {
    e.stopPropagation();
    navMenu.classList.toggle('on');
  };
  document.addEventListener('click', e => {
    if (!navMenu.contains(e.target) && e.target !== $('#nav-menu-btn')) {
      navMenu.classList.remove('on');
    }
  });

  function toggleSearch(forceState) {
    const dr = $('#search-drawer');
    const show = forceState !== undefined ? forceState : dr.classList.contains('hidden');
    dr.classList.toggle('hidden', !show);
    if (show) {
      setViewFilter('all');
      setTimeout(() => $('#q').focus(), 40);
    } else if ($('#q').value) {
      $('#q').value = '';
      if (LIB) render();
    }
  }
  $('#m-btn-search').onclick = () => { navMenu.classList.remove('on'); toggleSearch(true); };
  $('#q-clear').onclick = () => toggleSearch(false);
  $('#m-btn-up').onclick = () => { navMenu.classList.remove('on'); setViewFilter('up'); };

  function setViewFilter(filter) {
    curFilter = filter;
    document.querySelectorAll('#pills .pill').forEach(p => p.classList.toggle('on', p.dataset.filter === filter));
    const isUp = filter === 'up';
    $('#v-lib').classList.toggle('hidden', isUp);
    $('#v-up').classList.toggle('hidden', !isUp);
    $('#nav-title').textContent = isUp ? 'Upload Music' : 'My Music';
    if (isUp) loadArtists();
    else if (LIB) render();
  }

  document.querySelectorAll('#pills .pill').forEach(p => {
    p.onclick = () => setViewFilter(p.dataset.filter);
  });

  $('#nav-back').onclick = () => {
    if (curFilter !== 'all') {
      setViewFilter('all');
      return;
    }
    if (!$('#search-drawer').classList.contains('hidden')) {
      toggleSearch(false);
      return;
    }
    if (openAlbums.size > 0) {
      openAlbums.clear();
      if (LIB) render();
    }
  };

  $('#np-back').onclick = () => {
    $('#scr-np').classList.remove('mob-open');
  };
  $('#mini-pill').onclick = e => {
    if (e.target.closest('button')) return;
    $('#scr-np').classList.add('mob-open');
  };

  // ---- Biblioteca ----
  async function loadLib(silent) {
    if (!silent) $('#lib').innerHTML = '<div class="empty">Carregando biblioteca...</div>';
    try {
      LIB = await api('/api/library');
      coverVer = Date.now();
      render();
      // Se nenhuma música estiver carregada no player, pré-exibe a primeira faixa disponível na UI
      if (qi < 0 && LIB && LIB.artists.length) {
        for (let ai = 0; ai < LIB.artists.length; ai++) {
          const ar = LIB.artists[ai];
          for (let bi = 0; bi < ar.albums.length; bi++) {
            const al = ar.albums[bi];
            if (al.tracks.length) {
              primeFirstTrack(ai, bi, 0);
              return;
            }
          }
        }
      }
    } catch (e) {
      if (!silent) $('#lib').innerHTML = '<div class="empty">Não foi possível carregar a biblioteca. ' + h(e.message) + '</div>';
    }
  }

  function primeFirstTrack(ai, bi, ti) {
    const ar = LIB.artists[ai], al = ar.albums[bi], tr = al.tracks[ti];
    const albumParam = al.loose ? '' : al.name;
    const dispTitle = (tr.meta && tr.meta.title) ? tr.meta.title : title(tr.name);
    const dispArtist = (tr.meta && tr.meta.artist) ? tr.meta.artist : ar.name;
    $('#p-t').textContent = dispTitle;
    $('#p-a').textContent = dispArtist + (al.loose ? '' : ' · ' + al.name);
    setNowPlayingCover(ar.name, albumParam, tr.name);
    updateProgressUI(26, 135); // estado visual inicial igual ao preview até dar play
  }

  function render() {
    if (!LIB) return;
    const st = LIB.stats;
    $('#s-art').textContent = st.artists;
    $('#s-alb').textContent = st.albums;
    $('#s-trk').textContent = st.tracks;
    const q = $('#q').value.trim().toLowerCase();

    if (curFilter === 'liked' || curFilter === 'downloads') {
      renderFlatTracks(q, curFilter === 'liked');
      return;
    }

    let html = '<div class="m-list">';
    let count = 0;

    LIB.artists.forEach((ar, ai) => {
      const arHit = ar.name.toLowerCase().includes(q);
      const albs = ar.albums.map((al, bi) => ({ al, bi })).filter(({ al }) => !q || arHit ||
        al.name.toLowerCase().includes(q) || al.tracks.some(t =>
          t.name.toLowerCase().includes(q) ||
          (t.meta && t.meta.title && t.meta.title.toLowerCase().includes(q)) ||
          (t.meta && t.meta.artist && t.meta.artist.toLowerCase().includes(q))
        ));
      if (!albs.length) return;

      if (curFilter === 'playlists') {
        html += '<div style="font-size:12px;font-weight:700;color:var(--mut);text-transform:uppercase;letter-spacing:.8px;margin:8px 2px 2px">' +
          h(ar.name) + ' · ' + albs.length + ' álbum(ns)</div>';
      }

      albs.forEach(({ al, bi }) => {
        count++;
        const isOpen = openAlbums.has(albumKey(ar.name, al.name));
        const albumParam = al.loose ? '' : al.name;
        const firstTrack = al.tracks[0];
        const coverImg = firstTrack
          ? '<img src="/api/cover?artist=' + encodeURIComponent(ar.name) + '&album=' + encodeURIComponent(albumParam) + '&file=' + encodeURIComponent(firstTrack.name) + '&v=' + coverVer + '" alt="" loading="lazy" onerror="this.remove()">'
          : '';
        const metaSample = firstTrack && firstTrack.meta ? firstTrack.meta : null;
        const yearBadge = metaSample && metaSample.year ? '  •  ' + h(metaSample.year) : '';
        const songWord = al.tracks.length === 1 ? '1 Song' : al.tracks.length + ' Songs';

        html += '<div class="m-card album' + (isOpen ? ' open' : '') + '" data-a="' + ai + '" data-b="' + bi + '">' +
          '<div class="m-row ahead">' +
            '<div class="m-thumb" style="background:' + grad(ar.name + al.name) + '">💿' + coverImg + '</div>' +
            '<div class="m-info">' +
              '<b>' + h(al.name) + '</b>' +
              '<span>By ' + h(ar.name) + '  •  ' + songWord + yearBadge + '</span>' +
            '</div>' +
            '<div class="m-actions">' +
              (al.tracks.length ? '<button type="button" class="row-icon-btn album-edit" data-a="' + ai + '" data-b="' + bi + '" title="Editar álbum em lote">✎</button>' : '') +
              '<button type="button" class="play-dot album-play" data-a="' + ai + '" data-b="' + bi + '" title="Reproduzir álbum">' + PLAY_SVG + '</button>' +
            '</div>' +
          '</div>' +
          '<div class="tracks">' +
            (al.tracks.length ? (
              '<div class="album-bar"><span>' + al.tracks.length + ' faixa(s)</span>' +
              '<button type="button" class="btn-edit album-edit" data-a="' + ai + '" data-b="' + bi + '">✏️ Editar álbum</button></div>' +
              al.tracks.map((t, ti) => {
                const tm = t.meta || {};
                const dispNum = tm.track ? h(tm.track.split('/')[0]) : (ti + 1);
                const dispTitle = tm.title ? h(tm.title) : h(title(t.name));
                const dispSub = tm.artist && tm.artist !== ar.name ? '<small>' + h(tm.artist) + '</small>' : '';
                return '<div class="track" data-t="' + ti + '">' +
                  '<span class="n">' + dispNum + '</span>' +
                  '<span class="t">' + dispTitle + dispSub + '</span>' +
                  '<span class="ext">' + h(extOf(t.name)) + '</span>' +
                  '<span class="s">' + fmt(t.size) + '</span>' +
                  '<button type="button" class="btn-edit track-edit" data-a="' + ai + '" data-b="' + bi + '" data-t="' + ti + '" title="Editar metadados da faixa">✏️</button>' +
                '</div>';
              }).join('')
            ) : '<div class="empty" style="padding:14px">Álbum vazio</div>') +
          '</div>' +
        '</div>';
      });
    });

    html += '</div>';
    $('#lib').innerHTML = count ? html : (LIB.artists.length
      ? '<div class="empty">Nada encontrado para "' + h(q) + '".</div>'
      : '<div class="empty">Sua biblioteca está vazia.<br><br>Toque na pílula <b>+ Upload</b> acima para enviar músicas.</div>');
    markPlaying();
  }

  function renderFlatTracks(q, onlyLiked) {
    const items = [];
    LIB.artists.forEach((ar, ai) => {
      ar.albums.forEach((al, bi) => {
        const albumParam = al.loose ? '' : al.name;
        al.tracks.forEach((t, ti) => {
          const liked = isTrackLiked(ar.name, albumParam, t.name);
          if (onlyLiked && !liked) return;
          const tm = t.meta || {};
          const dispTitle = tm.title || title(t.name);
          const dispArtist = tm.artist || ar.name;
          if (q && !dispTitle.toLowerCase().includes(q) && !dispArtist.toLowerCase().includes(q) && !al.name.toLowerCase().includes(q)) return;
          items.push({ ai, bi, ti, ar, al, t, albumParam, dispTitle, dispArtist });
        });
      });
    });

    if (!items.length) {
      $('#lib').innerHTML = onlyLiked
        ? '<div class="empty">Nenhuma música curtida ainda.<br><br>Toque no coração <b>♡</b> na tela <i>Now Playing</i> para favoritar suas faixas preferidas.</div>'
        : '<div class="empty">Nenhuma faixa encontrada.</div>';
      return;
    }

    let html = '<div class="m-list">';
    items.forEach(it => {
      const coverImg = '<img src="/api/cover?artist=' + encodeURIComponent(it.ar.name) + '&album=' + encodeURIComponent(it.albumParam) + '&file=' + encodeURIComponent(it.t.name) + '&v=' + coverVer + '" alt="" loading="lazy" onerror="this.remove()">';
      const streamUrl = '/api/stream?artist=' + encodeURIComponent(it.ar.name) + '&album=' + encodeURIComponent(it.albumParam) + '&file=' + encodeURIComponent(it.t.name);
      html += '<div class="m-card flat-track" data-a="' + it.ai + '" data-b="' + it.bi + '" data-t="' + it.ti + '">' +
        '<div class="m-row">' +
          '<div class="m-thumb" style="background:' + grad(it.ar.name + it.al.name) + '">🎵' + coverImg + '</div>' +
          '<div class="m-info">' +
            '<b>' + h(it.dispTitle) + '</b>' +
            '<span>By ' + h(it.dispArtist) + '  •  ' + h(it.al.name) + ' (' + fmt(it.t.size) + ')</span>' +
          '</div>' +
          '<div class="m-actions">' +
            (!onlyLiked ? '<a class="row-icon-btn" href="' + streamUrl + '" download="' + h(it.t.name.split('/').pop()) + '" title="Baixar arquivo" onclick="event.stopPropagation()">⬇</a>' : '') +
            '<button type="button" class="row-icon-btn track-edit" data-a="' + it.ai + '" data-b="' + it.bi + '" data-t="' + it.ti + '" title="Editar metadados">✎</button>' +
            '<button type="button" class="play-dot flat-play" data-a="' + it.ai + '" data-b="' + it.bi + '" data-t="' + it.ti + '" title="Reproduzir">' + PLAY_SVG + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    });
    html += '</div>';
    $('#lib').innerHTML = html;
    markPlaying();
  }

  $('#lib').addEventListener('click', e => {
    const trEdit = e.target.closest('.track-edit');
    if (trEdit) {
      e.stopPropagation();
      openTrackModal(+trEdit.dataset.a, +trEdit.dataset.b, +trEdit.dataset.t);
      return;
    }
    const alEdit = e.target.closest('.album-edit');
    if (alEdit) {
      e.stopPropagation();
      openAlbumModal(+alEdit.dataset.a, +alEdit.dataset.b);
      return;
    }
    const alPlay = e.target.closest('.album-play');
    if (alPlay) {
      e.stopPropagation();
      const ai = +alPlay.dataset.a, bi = +alPlay.dataset.b;
      const ar = LIB.artists[ai], al = ar.albums[bi];
      if (!al.tracks.length) return;
      if (qi >= 0 && queue[qi] && queue[qi].artist === ar.name && queue[qi].albumLabel === al.name) {
        togglePlayPause();
      } else {
        playAlbum(ai, bi, 0);
      }
      return;
    }
    const flatCard = e.target.closest('.flat-track');
    if (flatCard) {
      const ai = +flatCard.dataset.a, bi = +flatCard.dataset.b, ti = +flatCard.dataset.t;
      playAlbum(ai, bi, ti);
      return;
    }
    const card = e.target.closest('.album');
    if (!card) return;
    const tr = e.target.closest('.track');
    if (tr) {
      playAlbum(+card.dataset.a, +card.dataset.b, +tr.dataset.t);
      return;
    }
    if (card.classList.contains('open') && !e.target.closest('.ahead')) return;
    const ar = LIB.artists[+card.dataset.a], al = ar.albums[+card.dataset.b];
    const key = albumKey(ar.name, al.name);
    const nowOpen = card.classList.toggle('open');
    if (nowOpen) openAlbums.add(key); else openAlbums.delete(key);
  });

  let qt;
  $('#q').oninput = () => { clearTimeout(qt); qt = setTimeout(() => LIB && render(), 150); };
  $('#reload').onclick = () => { navMenu.classList.remove('on'); loadLib(false); };

  // ---- Player & Now Playing Screen ----
  const audio = $('#audio');

  function setNowPlayingCover(arName, albumParam, fileName) {
    const covUrl = '/api/cover?artist=' + encodeURIComponent(arName) + '&album=' + encodeURIComponent(albumParam) + '&file=' + encodeURIComponent(fileName) + '&v=' + coverVer;
    const npCov = $('#np-cover');
    const ambImg = $('#np-ambient-img');
    npCov.style.background = grad(arName + albumParam);
    npCov.innerHTML = '🎵<img src="' + covUrl + '" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" onload="this.parentElement.setAttribute(\'data-has\',1)" onerror="this.remove()">';
    ambImg.style.backgroundImage = 'url("' + covUrl + '")';
  }

  function parseLyrics(rawText, fallbackTitle, fallbackArtist, fallbackAlbum) {
    if (!rawText || !String(rawText).trim()) {
      return [
        { time: null, text: fallbackAlbum ? ('Álbum · ' + fallbackAlbum) : 'Whispers in the midnight breeze,' },
        { time: null, text: fallbackTitle || 'Carrying dreams across the seas,' },
        { time: null, text: fallbackArtist ? ('Por ' + fallbackArtist + ' · Toque para editar letra') : 'I close my eyes, let go, and drift away.' }
      ];
    }
    const rawLines = String(rawText).split(/\r?\n/);
    const parsed = [];
    const lrcRe = /^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\](.*)$/;
    for (const ln of rawLines) {
      const m = ln.match(lrcRe);
      if (m) {
        const mins = parseInt(m[1], 10);
        const secs = parseInt(m[2], 10);
        const ms = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) : 0;
        const txt = m[4].trim();
        if (txt) parsed.push({ time: mins * 60 + secs + ms / 1000, text: txt });
      } else {
        const txt = ln.trim();
        if (txt) parsed.push({ time: null, text: txt });
      }
    }
    return parsed.length ? parsed : [
      { time: null, text: fallbackAlbum || '' },
      { time: null, text: fallbackTitle || '' },
      { time: null, text: fallbackArtist || '' }
    ];
  }

  function updateLyricsSpotlight(curSec, durSec) {
    if (!curLyrics || !curLyrics.length) return;
    let activeIdx = 1;
    const hasTimestamps = curLyrics.some(l => l.time !== null);
    if (hasTimestamps) {
      activeIdx = 0;
      for (let i = 0; i < curLyrics.length; i++) {
        if (curLyrics[i].time !== null && curSec >= curLyrics[i].time) activeIdx = i;
      }
    } else if (curLyrics.length <= 3) {
      $('#ly-0').textContent = curLyrics[0] ? curLyrics[0].text : '';
      $('#ly-1').textContent = curLyrics[1] ? curLyrics[1].text : (curLyrics[0] ? curLyrics[0].text : '');
      $('#ly-2').textContent = curLyrics[2] ? curLyrics[2].text : '';
      return;
    } else if (durSec > 0) {
      const ratio = Math.min(0.999, Math.max(0, curSec / durSec));
      activeIdx = Math.floor(ratio * curLyrics.length);
    }
    $('#ly-0').textContent = activeIdx > 0 ? curLyrics[activeIdx - 1].text : '♪';
    $('#ly-1').textContent = curLyrics[activeIdx] ? curLyrics[activeIdx].text : '';
    $('#ly-2').textContent = (activeIdx + 1 < curLyrics.length) ? curLyrics[activeIdx + 1].text : '♪';
  }

  // Geometria do arco circular em #np-ring-svg (centro 133,133; raio 113; ângulo inicial 118° varrendo 304° no sentido horário)
  const ARC_CX = 133, ARC_CY = 133, ARC_R = 113, ARC_START = 118, ARC_SWEEP = 304;
  function degToXY(deg) {
    const rad = (deg * Math.PI) / 180;
    return { x: ARC_CX + ARC_R * Math.cos(rad), y: ARC_CY + ARC_R * Math.sin(rad) };
  }
  function updateCircularArc(pct) {
    const clamped = Math.max(0, Math.min(1, pct || 0));
    const endDeg = ARC_START + clamped * ARC_SWEEP;
    const p0 = degToXY(ARC_START);
    const p1 = degToXY(endDeg);
    const dot = $('#np-arc-dot');
    dot.setAttribute('cx', p1.x.toFixed(2));
    dot.setAttribute('cy', p1.y.toFixed(2));
    if (clamped <= 0.002) {
      $('#np-arc').setAttribute('d', '');
      return;
    }
    const largeArc = (endDeg - ARC_START) > 180 ? 1 : 0;
    const d = 'M ' + p0.x.toFixed(2) + ' ' + p0.y.toFixed(2) +
      ' A ' + ARC_R + ' ' + ARC_R + ' 0 ' + largeArc + ' 1 ' + p1.x.toFixed(2) + ' ' + p1.y.toFixed(2);
    $('#np-arc').setAttribute('d', d);
  }

  function updateProgressUI(curSec, durSec) {
    const c = isFinite(curSec) ? curSec : 0;
    const d = (isFinite(durSec) && durSec > 0) ? durSec : 0;
    const pct = d > 0 ? Math.min(1, Math.max(0, c / d)) : 0;
    $('#np-bar-fill').style.width = (pct * 100).toFixed(2) + '%';
    $('#np-t-cur').textContent = fmtTime(c);
    $('#np-t-rem').textContent = '-' + fmtTime(Math.max(0, d - c));
    $('#np-rt-cur').textContent = fmtTime(c);
    $('#np-rt-dur').textContent = fmtTime(d);
    updateCircularArc(pct);
    updateLyricsSpotlight(c, d);
  }

  function updatePlayButtonsUI() {
    const isPlaying = !audio.paused && !!audio.src;
    $('#p-play').innerHTML = isPlaying ? PAUSE_SVG : PLAY_SVG;
    $('#mp-play').innerHTML = isPlaying ? PAUSE_SVG : PLAY_SVG;
    markPlaying();
  }

  function updateLikeButton() {
    const btn = $('#np-like');
    const svg = $('#np-like-svg');
    if (qi < 0 || !queue[qi]) {
      btn.classList.remove('liked');
      svg.setAttribute('fill', 'none');
      return;
    }
    const t = queue[qi];
    const liked = isTrackLiked(t.artist, t.album, t.file);
    btn.classList.toggle('liked', liked);
    svg.setAttribute('fill', liked ? 'currentColor' : 'none');
  }

  $('#np-like').onclick = () => {
    if (qi < 0 || !queue[qi]) return;
    const t = queue[qi];
    toggleTrackLike(t.artist, t.album, t.file);
  };

  function playAlbum(ai, bi, ti) {
    const ar = LIB.artists[ai], al = ar.albums[bi];
    queue = al.tracks.map((t, idx) => ({
      ai,
      bi,
      ti: idx,
      artist: ar.name,
      album: al.loose ? '' : al.name,
      albumLabel: al.name,
      file: t.name,
      displayTitle: (t.meta && t.meta.title) ? t.meta.title : title(t.name),
      displayArtist: (t.meta && t.meta.artist) ? t.meta.artist : ar.name,
      lyrics: (t.meta && t.meta.lyrics) ? t.meta.lyrics : ''
    }));
    playAt(ti);
  }

  async function playAt(i) {
    if (i < 0 || i >= queue.length) return;
    qi = i;
    const t = queue[i];
    audio.src = '/api/stream?artist=' + encodeURIComponent(t.artist) + '&album=' + encodeURIComponent(t.album) + '&file=' + encodeURIComponent(t.file);
    audio.play().catch(() => {});
    $('#p-t').textContent = t.displayTitle || title(t.file);
    $('#p-a').textContent = (t.displayArtist || t.artist) + (t.album ? ' × ' + t.album : '');
    setNowPlayingCover(t.artist, t.album, t.file);
    curLyrics = parseLyrics(t.lyrics, t.displayTitle, t.displayArtist || t.artist, t.albumLabel);
    updateProgressUI(0, 0);
    updateLikeButton();
    updatePlayButtonsUI();
    document.title = '▶ ' + (t.displayTitle || title(t.file)) + ' · My Music';

    // Busca metadados completos (título, artista, letra) em background para enriquecer o Now Playing
    try {
      const res = await api('/api/metadata?artist=' + encodeURIComponent(t.artist) + '&album=' + encodeURIComponent(t.album) + '&file=' + encodeURIComponent(t.file));
      if (qi === i && res && res.metadata) {
        const m = res.metadata;
        t.displayTitle = m.title || t.displayTitle;
        t.displayArtist = m.artist || t.displayArtist;
        t.lyrics = m.lyrics || '';
        if (LIB && LIB.artists[t.ai] && LIB.artists[t.ai].albums[t.bi] && LIB.artists[t.ai].albums[t.bi].tracks[t.ti]) {
          LIB.artists[t.ai].albums[t.bi].tracks[t.ti].meta = m;
        }
        $('#p-t').textContent = t.displayTitle;
        $('#p-a').textContent = t.displayArtist + (m.album ? ' × ' + m.album : (t.album ? ' × ' + t.album : ''));
        curLyrics = parseLyrics(t.lyrics, t.displayTitle, t.displayArtist, m.album || t.albumLabel);
        updateLyricsSpotlight(audio.currentTime || 0, audio.duration || 0);
      }
    } catch {}
  }

  function togglePlayPause() {
    if (!audio.src) {
      if (LIB && LIB.artists.length) {
        for (let ai = 0; ai < LIB.artists.length; ai++) {
          for (let bi = 0; bi < LIB.artists[ai].albums.length; bi++) {
            if (LIB.artists[ai].albums[bi].tracks.length) {
              playAlbum(ai, bi, 0);
              return;
            }
          }
        }
      }
      return;
    }
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  }

  function playNext() {
    if (!queue.length) return;
    if (shuffleOn && queue.length > 1) {
      let nextIdx = qi;
      while (nextIdx === qi) nextIdx = Math.floor(Math.random() * queue.length);
      playAt(nextIdx);
    } else {
      playAt(qi + 1);
    }
  }

  function markPlaying() {
    document.querySelectorAll('.track.playing').forEach(x => x.classList.remove('playing'));
    document.querySelectorAll('.play-dot').forEach(b => {
      b.classList.remove('playing');
      b.innerHTML = PLAY_SVG;
    });
    if (qi < 0 || !LIB || !queue[qi]) return;
    const t = queue[qi];
    const isPlaying = !audio.paused;

    document.querySelectorAll('.album').forEach(card => {
      const ar = LIB.artists[+card.dataset.a], al = ar.albums[+card.dataset.b];
      if (!ar || !al || ar.name !== t.artist || al.name !== t.albumLabel) return;
      const alBtn = card.querySelector('.album-play');
      if (alBtn) {
        alBtn.classList.add('playing');
        alBtn.innerHTML = isPlaying ? PAUSE_SVG : PLAY_SVG;
      }
      const i = al.tracks.findIndex(x => x.name === t.file);
      const el = card.querySelector('.track[data-t="' + i + '"]');
      if (el) el.classList.add('playing');
    });

    document.querySelectorAll('.flat-track').forEach(card => {
      const ar = LIB.artists[+card.dataset.a], al = ar.albums[+card.dataset.b];
      if (!ar || !al) return;
      const tr = al.tracks[+card.dataset.t];
      if (ar.name === t.artist && al.name === t.albumLabel && tr && tr.name === t.file) {
        const btn = card.querySelector('.flat-play');
        if (btn) {
          btn.classList.add('playing');
          btn.innerHTML = isPlaying ? PAUSE_SVG : PLAY_SVG;
        }
      }
    });
  }

  audio.ontimeupdate = () => updateProgressUI(audio.currentTime, audio.duration);
  audio.onloadedmetadata = () => updateProgressUI(audio.currentTime, audio.duration);
  audio.onplay = () => updatePlayButtonsUI();
  audio.onpause = () => updatePlayButtonsUI();
  audio.onended = () => playNext();
  audio.onerror = () => { if (audio.src) $('#p-a').textContent = 'Não foi possível reproduzir este arquivo neste navegador.'; };

  $('#p-play').onclick = togglePlayPause;
  $('#mp-play').onclick = togglePlayPause;
  $('#p-next').onclick = playNext;
  $('#p-prev').onclick = () => audio.currentTime > 3 ? (audio.currentTime = 0) : playAt(qi - 1);
  $('#mp-prev').onclick = () => audio.currentTime > 3 ? (audio.currentTime = 0) : playAt(qi - 1);

  function toggleShuffle() {
    shuffleOn = !shuffleOn;
    $('#p-shuf').classList.toggle('on', shuffleOn);
    $('#mp-shuf').classList.toggle('on', shuffleOn);
    showToast(shuffleOn ? '🔀 Modo aleatório ativado' : '➡️ Reprodução em ordem');
  }
  $('#p-shuf').onclick = toggleShuffle;
  $('#mp-shuf').onclick = toggleShuffle;

  function openCurrentTrackMetadata() {
    if (qi >= 0 && queue[qi]) {
      openTrackModal(queue[qi].ai, queue[qi].bi, queue[qi].ti);
    } else if (LIB && LIB.artists.length && LIB.artists[0].albums.length && LIB.artists[0].albums[0].tracks.length) {
      openTrackModal(0, 0, 0);
    } else {
      showToast('Selecione uma música primeiro.', true);
    }
  }
  $('#p-meta-btn').onclick = openCurrentTrackMetadata;
  $('#np-lyrics').onclick = openCurrentTrackMetadata;

  // Seek na barra linear
  function seekLinear(e) {
    if (!audio.duration || !isFinite(audio.duration)) return;
    const rect = $('#np-bar-hit').getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = pct * audio.duration;
    updateProgressUI(audio.currentTime, audio.duration);
  }
  let draggingBar = false;
  $('#np-bar-hit').addEventListener('pointerdown', e => {
    draggingBar = true;
    seekLinear(e);
  });
  window.addEventListener('pointermove', e => { if (draggingBar) seekLinear(e); });
  window.addEventListener('pointerup', () => { draggingBar = false; });

  // Seek no anel circular SVG
  $('#np-ring-svg').addEventListener('click', e => {
    if (!audio.duration || !isFinite(audio.duration)) return;
    const rect = $('#np-ring-svg').getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let deg = Math.atan2(e.clientY - cy, e.clientX - cx) * (180 / Math.PI);
    if (deg < 0) deg += 360;
    let rel = deg - ARC_START;
    if (rel < 0) rel += 360;
    const pct = Math.max(0, Math.min(1, rel / ARC_SWEEP));
    audio.currentTime = pct * audio.duration;
    updateProgressUI(audio.currentTime, audio.duration);
  });

  // Estado inicial do arco
  updateCircularArc(0.2);

  // ---- Modais de Edição de Metadados (Faixa e Álbum) ----
  let curTrackCtx = null;
  let curTrackCoverFile = null;
  let curTrackBlobUrl = null;
  let curAlbumCtx = null;
  let curAlbumCoverFile = null;
  let curAlbumBlobUrl = null;
  let isSavingMeta = false;

  function showModalError(id, msg) {
    const el = $('#' + id);
    if (!msg) { el.className = 'msg'; el.innerHTML = ''; return; }
    el.className = 'msg bad';
    el.innerHTML = '❌ ' + h(msg);
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function closeModal(modalId) {
    if (isSavingMeta) return;
    $('#' + modalId).classList.remove('on');
  }

  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.onclick = () => closeModal(btn.dataset.close);
  });
  ['m-track', 'm-album'].forEach(id => {
    const backdrop = $('#' + id);
    backdrop.addEventListener('mousedown', e => {
      if (e.target === backdrop) closeModal(id);
    });
  });
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !isSavingMeta) {
      if ($('#m-track').classList.contains('on')) closeModal('m-track');
      if ($('#m-album').classList.contains('on')) closeModal('m-album');
    }
  });

  function validateCoverFile(file, errId) {
    if (!file) return false;
    const ext = '.' + extOf(file.name);
    const mime = (file.type || '').toLowerCase();
    if (!['.jpg', '.jpeg', '.png'].includes(ext) && !['image/jpeg', 'image/png'].includes(mime)) {
      showModalError(errId, 'Formato de capa inválido. Selecione uma imagem JPG ou PNG.');
      return false;
    }
    if (file.size > window.MAX_COVER) {
      showModalError(errId, 'A imagem selecionada possui ' + fmt(file.size) + ' e excede o limite de 10 MB.');
      return false;
    }
    showModalError(errId, '');
    return true;
  }

  function renderTrackCoverPreview() {
    const box = $('#mt-cov-preview');
    const st = $('#mt-cov-status');
    const rst = $('#mt-cov-reset');
    if (curTrackBlobUrl) { URL.revokeObjectURL(curTrackBlobUrl); curTrackBlobUrl = null; }
    if (curTrackCoverFile) {
      curTrackBlobUrl = URL.createObjectURL(curTrackCoverFile);
      box.innerHTML = '<img src="' + curTrackBlobUrl + '" alt="Nova capa">';
      st.textContent = 'Nova capa selecionada: ' + curTrackCoverFile.name + ' (' + fmt(curTrackCoverFile.size) + ')';
      rst.classList.remove('hidden');
    } else if (curTrackCtx && curTrackCtx.hasCover) {
      box.innerHTML = '<img src="' + curTrackCtx.coverUrl + '" alt="Capa atual">';
      st.textContent = 'Capa atual embutida no arquivo · Máx. 10 MB (JPG/PNG)';
      rst.classList.add('hidden');
    } else {
      box.innerHTML = '🎵';
      st.textContent = 'Nenhuma capa embutida · Envie JPG ou PNG (máx. 10 MB)';
      rst.classList.add('hidden');
    }
  }

  $('#mt-cov-btn').onclick = () => $('#mt-cov-input').click();
  $('#mt-cov-input').onchange = e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f || !validateCoverFile(f, 'mt-err')) return;
    curTrackCoverFile = f;
    renderTrackCoverPreview();
  };
  $('#mt-cov-reset').onclick = () => {
    curTrackCoverFile = null;
    renderTrackCoverPreview();
  };

  async function openTrackModal(ai, bi, ti) {
    const ar = LIB.artists[ai], al = ar.albums[bi], tr = al.tracks[ti];
    const albumParam = al.loose ? '' : al.name;
    curTrackCoverFile = null;
    curTrackCtx = {
      artist: ar.name,
      album: albumParam,
      albumLabel: al.name,
      file: tr.name,
      hasCover: false,
      coverUrl: '/api/cover?artist=' + encodeURIComponent(ar.name) + '&album=' + encodeURIComponent(albumParam) + '&file=' + encodeURIComponent(tr.name) + '&v=' + Date.now()
    };

    showModalError('mt-err', '');
    $('#mt-sub').textContent = ar.name + ' / ' + al.name + ' / ' + tr.name;
    $('#f-track').reset();
    $('#mt-cov-preview').innerHTML = '<div class="spinner"></div>';
    $('#mt-cov-status').textContent = 'Carregando metadados atuais do arquivo...';
    $('#mt-cov-reset').classList.add('hidden');
    $('#mt-save').disabled = true;
    $('#mt-save').textContent = 'Carregando...';
    $('#m-track').classList.add('on');

    try {
      const res = await api('/api/metadata?artist=' + encodeURIComponent(ar.name) + '&album=' + encodeURIComponent(albumParam) + '&file=' + encodeURIComponent(tr.name));
      const m = res.metadata || {};
      curTrackCtx.hasCover = !!m.hasCover;
      $('#mt-f-title').value = m.title || title(tr.name);
      $('#mt-f-artist').value = m.artist || ar.name;
      $('#mt-f-album').value = m.album || (al.loose ? '' : al.name);
      $('#mt-f-albumartist').value = m.albumartist || ar.name;
      $('#mt-f-year').value = m.year || '';
      $('#mt-f-genre').value = m.genre || '';
      $('#mt-f-track').value = m.track || '';
      $('#mt-f-disc').value = m.disc || '';
      $('#mt-f-composer').value = m.composer || '';
      $('#mt-f-bpm').value = m.bpm || '';
      $('#mt-f-comment').value = m.comment || '';
      $('#mt-f-compilation').checked = !!m.compilation;
      $('#mt-f-lyrics').value = m.lyrics || '';
      renderTrackCoverPreview();
      $('#mt-save').disabled = false;
      $('#mt-save').textContent = 'Salvar';
    } catch (e) {
      showModalError('mt-err', 'Não foi possível ler os metadados: ' + e.message);
      $('#mt-cov-preview').innerHTML = '🎵';
      $('#mt-save').disabled = false;
      $('#mt-save').textContent = 'Salvar';
    }
  }

  $('#mt-save').onclick = async () => {
    if (!curTrackCtx || isSavingMeta) return;
    showModalError('mt-err', '');

    const yearVal = $('#mt-f-year').value.trim();
    if (yearVal && (!/^\d{4}$/.test(yearVal) || +yearVal < 1000 || +yearVal > 2999)) {
      return showModalError('mt-err', 'Informe um ano válido com 4 dígitos (ex: 2024).');
    }
    const bpmVal = $('#mt-f-bpm').value.trim();
    if (bpmVal && (!/^\d{1,3}(\.\d{1,2})?$/.test(bpmVal) || +bpmVal < 1 || +bpmVal > 999)) {
      return showModalError('mt-err', 'Informe um BPM numérico válido entre 1 e 999.');
    }
    const trackVal = $('#mt-f-track').value.trim();
    if (trackVal && !/^\d{1,4}(\/\d{1,4})?$/.test(trackVal)) {
      return showModalError('mt-err', 'Nº da faixa inválido. Use apenas números (ex: 1 ou 1/12).');
    }
    const discVal = $('#mt-f-disc').value.trim();
    if (discVal && !/^\d{1,4}(\/\d{1,4})?$/.test(discVal)) {
      return showModalError('mt-err', 'Nº do disco inválido. Use apenas números (ex: 1 ou 1/2).');
    }

    const fd = new FormData();
    fd.append('srcArtist', curTrackCtx.artist);
    fd.append('srcAlbum', curTrackCtx.album);
    fd.append('file', curTrackCtx.file);
    fd.append('title', $('#mt-f-title').value.trim());
    fd.append('artist', $('#mt-f-artist').value.trim());
    fd.append('album', $('#mt-f-album').value.trim());
    fd.append('albumartist', $('#mt-f-albumartist').value.trim());
    fd.append('year', yearVal);
    fd.append('genre', $('#mt-f-genre').value.trim());
    fd.append('track', trackVal);
    fd.append('disc', discVal);
    fd.append('composer', $('#mt-f-composer').value.trim());
    fd.append('bpm', bpmVal);
    fd.append('comment', $('#mt-f-comment').value.trim());
    fd.append('compilation', $('#mt-f-compilation').checked ? '1' : '0');
    fd.append('lyrics', $('#mt-f-lyrics').value);
    if (curTrackCoverFile) fd.append('cover', curTrackCoverFile, curTrackCoverFile.name);

    isSavingMeta = true;
    $('#mt-save').disabled = true;
    $('#mt-cancel').disabled = true;
    $('#mt-save').textContent = 'Salvando...';

    try {
      const url = '/api/metadata?artist=' + encodeURIComponent(curTrackCtx.artist) +
        '&album=' + encodeURIComponent(curTrackCtx.album) +
        '&file=' + encodeURIComponent(curTrackCtx.file);
      const res = await api(url, { method: 'POST', body: fd });
      isSavingMeta = false;
      $('#mt-save').disabled = false;
      $('#mt-cancel').disabled = false;
      $('#mt-save').textContent = 'Salvar';
      closeModal('m-track');
      showToast('✅ Metadados salvos com sucesso em <b>' + h(curTrackCtx.file) + '</b>!');
      coverVer = Date.now();
      if (qi >= 0 && queue[qi] && queue[qi].artist === curTrackCtx.artist && queue[qi].album === curTrackCtx.album && queue[qi].file === curTrackCtx.file) {
        const m = res.metadata || {};
        queue[qi].displayTitle = m.title || title(curTrackCtx.file);
        queue[qi].displayArtist = m.artist || curTrackCtx.artist;
        queue[qi].lyrics = m.lyrics || '';
        $('#p-t').textContent = queue[qi].displayTitle;
        $('#p-a').textContent = queue[qi].displayArtist + (m.album ? ' × ' + m.album : '');
        setNowPlayingCover(curTrackCtx.artist, curTrackCtx.album, curTrackCtx.file);
        curLyrics = parseLyrics(queue[qi].lyrics, queue[qi].displayTitle, queue[qi].displayArtist, m.album || curTrackCtx.albumLabel);
        updateLyricsSpotlight(audio.currentTime || 0, audio.duration || 0);
      }
      await loadLib(true);
    } catch (e) {
      isSavingMeta = false;
      $('#mt-save').disabled = false;
      $('#mt-cancel').disabled = false;
      $('#mt-save').textContent = 'Salvar';
      showModalError('mt-err', e.message);
    }
  };

  // ---- Modal de Edição em Lote do Álbum ----
  function renderAlbumCoverPreview() {
    const box = $('#ma-cov-preview');
    const st = $('#ma-cov-status');
    const rst = $('#ma-cov-reset');
    if (curAlbumBlobUrl) { URL.revokeObjectURL(curAlbumBlobUrl); curAlbumBlobUrl = null; }
    if (curAlbumCoverFile) {
      curAlbumBlobUrl = URL.createObjectURL(curAlbumCoverFile);
      box.innerHTML = '<img src="' + curAlbumBlobUrl + '" alt="Nova capa do álbum">';
      st.textContent = 'Nova capa selecionada: ' + curAlbumCoverFile.name + ' (' + fmt(curAlbumCoverFile.size) + ')';
      rst.classList.remove('hidden');
    } else if (curAlbumCtx && curAlbumCtx.hasCover) {
      box.innerHTML = '<img src="' + curAlbumCtx.coverUrl + '" alt="Capa atual do álbum">';
      st.textContent = 'Capa atual do álbum · Selecione outra para substituir em todas as faixas';
      rst.classList.add('hidden');
    } else {
      box.innerHTML = '💿';
      st.textContent = 'Se não selecionar nova imagem, a capa atual de cada faixa será mantida.';
      rst.classList.add('hidden');
    }
  }

  $('#ma-cov-btn').onclick = () => $('#ma-cov-input').click();
  $('#ma-cov-input').onchange = e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f || !validateCoverFile(f, 'ma-err')) return;
    curAlbumCoverFile = f;
    renderAlbumCoverPreview();
  };
  $('#ma-cov-reset').onclick = () => {
    curAlbumCoverFile = null;
    renderAlbumCoverPreview();
  };

  async function openAlbumModal(ai, bi) {
    const ar = LIB.artists[ai], al = ar.albums[bi];
    const albumParam = al.loose ? '' : al.name;
    const firstFile = al.tracks[0] ? al.tracks[0].name : '';
    curAlbumCoverFile = null;
    curAlbumCtx = {
      artist: ar.name,
      album: albumParam,
      albumLabel: al.name,
      trackCount: al.tracks.length,
      hasCover: false,
      coverUrl: '/api/cover?artist=' + encodeURIComponent(ar.name) + '&album=' + encodeURIComponent(albumParam) + '&file=' + encodeURIComponent(firstFile) + '&v=' + Date.now()
    };

    showModalError('ma-err', '');
    $('#ma-sub').textContent = ar.name + ' — ' + al.name + ' (' + al.tracks.length + ' faixa(s))';
    $('#f-album').reset();
    $('#ma-prog').classList.remove('on');
    $('#ma-cov-preview').innerHTML = '<div class="spinner"></div>';
    $('#ma-cov-reset').classList.add('hidden');
    $('#ma-save').disabled = true;
    $('#ma-save').textContent = 'Carregando...';
    $('#m-album').classList.add('on');

    try {
      const res = await api('/api/metadata?artist=' + encodeURIComponent(ar.name) + '&album=' + encodeURIComponent(albumParam));
      const m = res.metadata || {};
      curAlbumCtx.hasCover = !!m.hasCover;
      $('#ma-f-albumartist').value = m.albumartist || m.artist || ar.name;
      $('#ma-f-album').value = m.album || (al.loose ? '' : al.name);
      $('#ma-f-year').value = m.year || '';
      $('#ma-f-genre').value = m.genre || '';
      renderAlbumCoverPreview();
    } catch {
      $('#ma-f-albumartist').value = ar.name;
      $('#ma-f-album').value = al.loose ? '' : al.name;
      renderAlbumCoverPreview();
    }
    $('#ma-save').disabled = false;
    $('#ma-save').textContent = 'Salvar em todas as faixas';
  }

  $('#ma-save').onclick = async () => {
    if (!curAlbumCtx || isSavingMeta) return;
    showModalError('ma-err', '');

    const yearVal = $('#ma-f-year').value.trim();
    if (yearVal && (!/^\d{4}$/.test(yearVal) || +yearVal < 1000 || +yearVal > 2999)) {
      return showModalError('ma-err', 'Informe um ano válido com 4 dígitos (ex: 2024).');
    }

    const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const fd = new FormData();
    fd.append('jobId', jobId);
    fd.append('srcArtist', curAlbumCtx.artist);
    fd.append('srcAlbum', curAlbumCtx.album);
    fd.append('albumartist', $('#ma-f-albumartist').value.trim());
    fd.append('album', $('#ma-f-album').value.trim());
    fd.append('year', yearVal);
    fd.append('genre', $('#ma-f-genre').value.trim());
    if (curAlbumCoverFile) fd.append('cover', curAlbumCoverFile, curAlbumCoverFile.name);

    isSavingMeta = true;
    $('#ma-save').disabled = true;
    $('#ma-cancel').disabled = true;
    $('#ma-save').textContent = 'Processando...';
    $('#ma-prog').classList.add('on');
    $('#ma-prog-fill').style.width = '5%';
    $('#ma-prog-pct').textContent = '0%';
    $('#ma-prog-lbl').textContent = 'Aplicando metadados em ' + curAlbumCtx.trackCount + ' faixa(s)...';

    const pollTimer = setInterval(async () => {
      try {
        const p = await api('/api/metadata/progress?jobId=' + encodeURIComponent(jobId));
        if (p && p.total > 0) {
          const pct = Math.min(99, Math.round((p.done / p.total) * 100));
          $('#ma-prog-fill').style.width = Math.max(8, pct) + '%';
          $('#ma-prog-pct').textContent = pct + '%';
          $('#ma-prog-lbl').textContent = 'Processando faixa ' + (Math.min(p.done + 1, p.total)) + ' de ' + p.total + (p.current ? ' (' + p.current + ')' : '') + '...';
        }
      } catch {}
    }, 250);

    try {
      const url = '/api/metadata/album?artist=' + encodeURIComponent(curAlbumCtx.artist) +
        '&album=' + encodeURIComponent(curAlbumCtx.album) +
        '&jobId=' + encodeURIComponent(jobId);
      const res = await api(url, { method: 'POST', body: fd });
      clearInterval(pollTimer);
      $('#ma-prog-fill').style.width = '100%';
      $('#ma-prog-pct').textContent = '100%';
      $('#ma-prog-lbl').textContent = 'Concluído!';
      isSavingMeta = false;
      $('#ma-save').disabled = false;
      $('#ma-cancel').disabled = false;
      $('#ma-save').textContent = 'Salvar em todas as faixas';
      closeModal('m-album');
      coverVer = Date.now();
      showToast('✅ Álbum atualizado! Metadados aplicados em <b>' + res.updated + ' de ' + res.total + '</b> faixa(s).');
      if (qi >= 0 && queue[qi] && queue[qi].artist === curAlbumCtx.artist && queue[qi].album === curAlbumCtx.album) {
        setNowPlayingCover(curAlbumCtx.artist, curAlbumCtx.album, queue[qi].file);
      }
      await loadLib(true);
    } catch (e) {
      clearInterval(pollTimer);
      isSavingMeta = false;
      $('#ma-prog').classList.remove('on');
      $('#ma-save').disabled = false;
      $('#ma-cancel').disabled = false;
      $('#ma-save').textContent = 'Salvar em todas as faixas';
      showModalError('ma-err', e.message);
    }
  };

  // ---- Upload: artista / álbum ----
  let ART = [], aMode = 'sel', bMode = 'sel';
  function setMode(box, m) { box.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.m === m)); }
  function applyModes() {
    if (!ART.length) aMode = 'new';
    setMode($('#am'), aMode);
    $('#a-sel').classList.toggle('hidden', aMode !== 'sel'); $('#a-new').classList.toggle('hidden', aMode !== 'new');
    const albs = aMode === 'sel' ? ((ART.find(a => a.name === $('#a-sel').value) || {}).albums || []) : [];
    if (!albs.length) bMode = 'new';
    $('#bm').querySelector('[data-m=sel]').disabled = !albs.length;
    $('#am').querySelector('[data-m=sel]').disabled = !ART.length;
    setMode($('#bm'), bMode);
    const cur = $('#b-sel').value;
    $('#b-sel').innerHTML = albs.map(b => '<option>' + h(b) + '</option>').join('');
    if (albs.includes(cur)) $('#b-sel').value = cur;
    $('#b-sel').classList.toggle('hidden', bMode !== 'sel'); $('#b-new').classList.toggle('hidden', bMode !== 'new');
  }
  async function loadArtists() {
    try {
      ART = await api('/api/artists');
      const cur = $('#a-sel').value;
      $('#a-sel').innerHTML = ART.map(a => '<option>' + h(a.name) + '</option>').join('');
      if (ART.some(a => a.name === cur)) $('#a-sel').value = cur;
      if (ART.length && aMode === 'new' && !$('#a-new').value) aMode = 'sel';
      applyModes();
    } catch (e) { showMsg('Não foi possível carregar os artistas: ' + e.message, false); }
  }
  $('#am').onclick = e => { const b = e.target.closest('button'); if (!b || b.disabled) return; aMode = b.dataset.m; if (aMode === 'sel') bMode = 'sel'; applyModes(); };
  $('#bm').onclick = e => { const b = e.target.closest('button'); if (!b || b.disabled) return; bMode = b.dataset.m; applyModes(); };
  $('#a-sel').onchange = () => { bMode = 'sel'; applyModes(); };

  // ---- Upload: arquivos ----
  let FILES = [], xhr = null;
  function showMsg(t, ok) { const m = $('#msg'); m.className = 'msg ' + (ok ? 'ok' : 'bad'); m.innerHTML = t; m.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  function hideMsg() { $('#msg').className = 'msg'; }
  function addFiles(list) {
    const bad = [];
    for (const f of list) {
      const ext = '.' + extOf(f.name);
      if (!window.EXTS.includes(ext)) { bad.push(f.name); continue; }
      if (!FILES.some(x => x.name === f.name && x.size === f.size)) FILES.push(f);
    }
    if (bad.length) showMsg('Ignorado(s) por formato não suportado: <b>' + bad.map(h).join(', ') + '</b>', false); else hideMsg();
    renderFiles();
  }
  function renderFiles() {
    const total = FILES.reduce((s, f) => s + f.size, 0);
    $('#files').innerHTML = FILES.map((f, i) => '<div class="file"><span>🎶</span><span class="t">' + h(f.name) +
      '</span><span class="ext">' + fmt(f.size) + '</span><button class="x" data-i="' + i + '" title="Remover">×</button></div>').join('') +
      (FILES.length ? '<div style="color:var(--mut);font-size:12.5px;padding:4px 2px">' + FILES.length + ' arquivo(s) · ' + fmt(total) +
        (total > window.MAX ? ' — <span style="color:var(--err)">excede 1 GB, remova alguns arquivos</span>' : '') + '</div>' : '');
    $('#send').disabled = !FILES.length || total > window.MAX || !!xhr;
  }
  $('#files').onclick = e => { const b = e.target.closest('.x'); if (b && !xhr) { FILES.splice(+b.dataset.i, 1); renderFiles(); } };
  const drop = $('#drop'), fi = $('#fi');
  drop.onclick = () => !xhr && fi.click();
  fi.onchange = () => { addFiles(fi.files); fi.value = ''; };
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => { if (!xhr) addFiles(e.dataTransfer.files); });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());
  $('#clear').onclick = () => { if (!xhr) { FILES = []; renderFiles(); hideMsg(); } };
  $('#cancel').onclick = () => xhr && xhr.abort();

  $('#send').onclick = () => {
    const artist = (aMode === 'sel' ? $('#a-sel').value : $('#a-new').value).trim();
    const album = (bMode === 'sel' ? $('#b-sel').value : $('#b-new').value).trim();
    if (!artist) return showMsg('Informe o nome do <b>artista</b>.', false);
    if (!album) return showMsg('Informe o nome do <b>álbum</b>.', false);
    if (!FILES.length) return showMsg('Selecione ao menos um arquivo.', false);
    hideMsg();
    const fd = new FormData();
    fd.append('artist', artist); fd.append('album', album);
    FILES.forEach(f => fd.append('files', f, f.name));
    xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    $('#prog').style.display = 'block'; $('#fill').style.width = '0%';
    $('#send').disabled = true; $('#cancel').classList.remove('hidden');
    const t0 = Date.now();
    xhr.upload.onprogress = e => {
      if (!e.lengthComputable) return;
      const p = Math.round(e.loaded / e.total * 100);
      const sp = e.loaded / Math.max((Date.now() - t0) / 1000, 0.1);
      $('#fill').style.width = p + '%'; $('#ppct').textContent = p + '%';
      $('#plbl').textContent = p < 100 ? 'Enviando ' + fmt(e.loaded) + ' de ' + fmt(e.total) + ' · ' + fmt(sp) + '/s' : 'Processando no servidor...';
    };
    const done = () => { xhr = null; $('#cancel').classList.add('hidden'); setTimeout(() => $('#prog').style.display = 'none', 1200); renderFiles(); };
    xhr.onload = () => {
      let r = {}; try { r = JSON.parse(xhr.responseText); } catch (e) {}
      if (xhr.status === 401) { location.href = '/login'; return; }
      if (xhr.status >= 200 && xhr.status < 300 && r.ok) {
        showMsg('✅ ' + r.files.length + ' arquivo(s) enviado(s) para <b>' + h(r.artist) + ' / ' + h(r.album) + '</b>.', true);
        FILES = []; $('#a-new').value = ''; $('#b-new').value = '';
        aMode = 'sel'; bMode = 'sel';
        loadArtists().then(() => { $('#a-sel').value = r.artist; applyModes(); $('#b-sel').value = r.album; });
        loadLib(true);
      } else if (xhr.status === 413) showMsg('O envio excede o limite de 1 GB. Envie em partes menores.', false);
      else showMsg('❌ ' + h(r.error || ('Falha no envio (código ' + xhr.status + ').')), false);
      done();
    };
    xhr.onerror = () => { showMsg('❌ Falha de conexão durante o envio. Verifique sua rede e tente novamente.', false); done(); };
    xhr.onabort = () => { showMsg('Envio cancelado.', false); done(); };
    xhr.send(fd);
  };

  loadLib(false);
}

const CLIENT_JS = '(' + clientMain.toString() + ')();';

// ---------- Inicialização ----------
try { fs.mkdirSync(MUSIC_DIR, { recursive: true }); } catch (e) { console.warn('Aviso: não foi possível acessar', MUSIC_DIR, e.message); }
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎵 Servidor de música rodando em http://0.0.0.0:${PORT} (pasta: ${MUSIC_DIR})`);
});
server.requestTimeout = 0;       // uploads grandes não expiram
server.headersTimeout = 120000;
server.timeout = 0;
