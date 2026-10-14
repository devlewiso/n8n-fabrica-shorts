#!/usr/bin/env node
/* Montaje de Shorts (voz + subtítulos quemados). Se ejecuta DENTRO del contenedor de n8n.
 *
 * Mezcla la narración sobre el video (el audio original queda de fondo) y quema
 * subtítulos estilo Shorts/Reels sincronizados con la narración.
 *
 *   node /opt/tools/burn.js <base> <texto-en-base64>
 *
 * Lee   /files/<base>.mp4  y  /files/<base>_narr.wav (o .mp3)
 * Crea  /files/final/<base>_final.mp4
 * Imprime un JSON de una línea con el resumen (o {"ok":false,"error":...}).
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILES = process.env.WWR_DIR || '/files';
const FFMPEG = process.env.WWR_FFMPEG || '/opt/tools/ffmpeg';
const FFPROBE = process.env.WWR_FFPROBE || '/opt/tools/ffprobe';
const FONTS = process.env.WWR_FONTS || '/opt/tools/fonts';
const NARRATION_DELAY = 0.30;      // la voz entra unos instantes después del primer fotograma
const ORIGINAL_AUDIO_GAIN = 0.25;  // el sonido ambiente del video queda de fondo
const MAX_WORDS = 4;               // palabras por subtítulo

const run = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

function probe(file) {
  const j = JSON.parse(run(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', file]));
  const v = j.streams.find(s => s.codec_type === 'video');
  return { w: v ? v.width : 0, h: v ? v.height : 0, dur: parseFloat(j.format.duration), audio: j.streams.some(s => s.codec_type === 'audio') };
}

function captions(text) {
  const chunks = [];
  let cur = [];
  for (const w of text.split(/\s+/).filter(Boolean)) {
    cur.push(w);
    if (cur.length >= MAX_WORDS || /[.!?;:]$/.test(w) || (cur.length >= 2 && w.endsWith(','))) { chunks.push(cur); cur = []; }
  }
  if (cur.length) chunks.push(cur);
  return chunks.map(c => c.join(' '));
}

const assTime = t => {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
};

function buildAss(text, start, span, w, h) {
  const lines = captions(text);
  const weights = lines.map(l => Math.max(l.length, 4));
  const total = weights.reduce((a, b) => a + b, 0);
  let t = start;
  const events = lines.map((line, i) => {
    const d = span * weights[i] / total;
    const clean = line.replace(/\\/g, '').replace(/\{/g, '(').replace(/\}/g, ')');
    const ev = `Dialogue: 0,${assTime(t)},${assTime(t + d)},Cap,,0,0,0,,${clean}`;
    t += d;
    return ev;
  });
  const size = Math.round(h * 0.040), outline = Math.max(3, Math.round(h * 0.004)), marginV = Math.round(h * 0.22);
  const head =
    `[Script Info]\nScriptType: v4.00+\nPlayResX: ${w}\nPlayResY: ${h}\nScaledBorderAndShadow: yes\nWrapStyle: 0\n\n` +
    '[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,' +
    'Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\n' +
    `Style: Cap,Liberation Sans,${size},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,${outline},1,2,40,40,${marginV},1\n\n` +
    '[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n';
  return { ass: head + events.join('\n') + '\n', count: lines.length };
}

function main() {
  const [base, b64] = process.argv.slice(2);
  if (!base || !/^[A-Za-z0-9_\-]+$/.test(base)) throw new Error('nombre base no válido: ' + base);
  const text = Buffer.from(b64 || '', 'base64').toString('utf8').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('falta el texto de la narración');

  const video = path.join(FILES, base + '.mp4');
  const audio = ['.wav', '.mp3', '.m4a'].map(e => path.join(FILES, base + '_narr' + e)).find(f => fs.existsSync(f));
  if (!fs.existsSync(video)) throw new Error('no existe: ' + video);
  if (!audio) throw new Error('no existe la narración: ' + path.join(FILES, base + '_narr.wav'));
  fs.mkdirSync(path.join(FILES, 'final'), { recursive: true });
  const out = path.join(FILES, 'final', base + '_final.mp4');

  const v = probe(video), a = probe(audio);
  const W = Math.max(v.w, 720);                                   // al menos 720 px de ancho
  let H = Math.round(v.h * W / v.w / 2) * 2;
  if (Math.abs(v.w / v.h - 9 / 16) < 0.01) H = Math.round(W * 16 / 9 / 2) * 2;   // 9:16 exacto (720x1280)
  let atempo = 1.0;
  if (a.dur + NARRATION_DELAY > v.dur) atempo = Math.min((a.dur + NARRATION_DELAY) / v.dur, 1.25);  // narración larga: se acelera
  const span = Math.min(a.dur / atempo, v.dur - NARRATION_DELAY - 0.1);

  const { ass, count } = buildAss(text, NARRATION_DELAY, span, W, H);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wwr_'));
  try {
    const assPath = path.join(tmp, 'subs.ass');
    fs.writeFileSync(assPath, ass, 'utf8');
    const d = Math.round(NARRATION_DELAY * 1000);
    const fc = [`[0:v]scale=${W}:${H}:flags=lanczos,setsar=1,subtitles=${assPath}:fontsdir=${FONTS}[v]`];
    const voice = `[1:a]atempo=${atempo.toFixed(4)},adelay=${d}|${d}[n]`;
    if (v.audio) {
      fc.push(voice, `[0:a]volume=${ORIGINAL_AUDIO_GAIN}[b]`, '[b][n]amix=inputs=2:duration=first:normalize=0[a]');
    } else {
      fc.push(voice.replace('[n]', '[a]'));
    }
    run(FFMPEG, ['-y', '-v', 'error', '-i', video, '-i', audio, '-filter_complex', fc.join(';'), '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-t', v.dur.toFixed(3), out]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const o = probe(out);
  return { ok: true, out: 'final/' + base + '_final.mp4', width: o.w, height: o.h, duration: +o.dur.toFixed(2),
    captions: count, atempo: +atempo.toFixed(3), narration_seconds: +a.dur.toFixed(2), size_bytes: fs.statSync(out).size };
}

try {
  console.log(JSON.stringify(main()));
} catch (e) {
  const msg = (e.stderr ? String(e.stderr) : '') || e.message;
  console.log(JSON.stringify({ ok: false, error: msg.trim().slice(-1200) }));
  process.exit(1);
}
