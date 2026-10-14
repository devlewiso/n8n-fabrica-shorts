// Publica un video en TikTok (Content Posting API, Direct Post, FILE_UPLOAD).
// Uso: node /opt/tools/tiktok_post.js <ruta_mp4> <caption_base64>
// Lee /opt/tools/tiktok/app.json y token.json; renueva el access_token si venció.
// Imprime una línea JSON: {"ok":true,"publish_id":...,"status":...,"privacy":...}
const fs = require('fs');

const DIR = process.env.TOOLS_DIR ? process.env.TOOLS_DIR + '/tiktok' : '/opt/tools/tiktok';
const API = 'https://open.tiktokapis.com';
const [file, captionB64] = process.argv.slice(2);

// Siempre sale con código 0 e imprime el JSON: así n8n muestra el motivo real en "Resultado TikTok"
// (con código 1 el nodo Execute Command escondía el mensaje).
const out = o => { console.log(JSON.stringify(o)); process.exit(0); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function token() {
  const app = JSON.parse(fs.readFileSync(`${DIR}/app.json`, 'utf8'));
  let tok = JSON.parse(fs.readFileSync(`${DIR}/token.json`, 'utf8'));
  if (Date.now() / 1000 < tok.obtained_at + tok.expires_in - 300) return tok.access_token;
  const res = await fetch(`${API}/v2/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: app.client_key, client_secret: app.client_secret,
      grant_type: 'refresh_token', refresh_token: tok.refresh_token,
    }),
  });
  const nuevo = await res.json();
  if (!nuevo.access_token) throw new Error('No se pudo renovar el token: ' + JSON.stringify(nuevo));
  tok = { ...nuevo, obtained_at: Math.floor(Date.now() / 1000) };
  fs.writeFileSync(`${DIR}/token.json`, JSON.stringify(tok, null, 2), { mode: 0o600 });
  return tok.access_token;
}

// Errores momentáneos que vale la pena reintentar (red, límite de pedidos, servidor de TikTok).
const TEMPORAL = /rate_limit|too_many|internal_error|timeout|ECONNRESET|ETIMEDOUT|fetch failed|HTTP 5\d\d|spam_risk_too_many/i;

async function api(path, access, body) {
  for (let intento = 1; ; intento++) {
    try {
      const res = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify(body || {}),
      });
      if (res.status >= 500) throw new Error(`${path}: HTTP ${res.status}`);
      const j = await res.json();
      if (j.error && j.error.code !== 'ok') throw new Error(`${path}: ${j.error.code} ${j.error.message}`);
      return j.data;
    } catch (e) {
      if (intento >= 3 || !TEMPORAL.test(String(e.message || e))) throw e;
      await sleep(10000 * intento);
    }
  }
}

(async () => {
  if (!file || !fs.existsSync(file)) throw new Error('No existe el video: ' + file);
  const caption = Buffer.from(captionB64 || '', 'base64').toString('utf8').slice(0, 2200);
  const access = await token();

  // Mientras la app no esté auditada, TikTok solo permite SELF_ONLY (privado).
  const creator = await api('/v2/post/publish/creator_info/query/', access);
  const opciones = creator.privacy_level_options || [];
  const privacy = opciones.includes('PUBLIC_TO_EVERYONE') && process.env.TIKTOK_PUBLIC === '1'
    ? 'PUBLIC_TO_EVERYONE' : (opciones.includes('SELF_ONLY') ? 'SELF_ONLY' : opciones[0]);

  // Chunks: 5-64 MB; un archivo de menos de 64 MB va en un solo chunk.
  const size = fs.statSync(file).size;
  const MB = 1024 * 1024;
  const chunk = size <= 64 * MB ? size : 10 * MB;
  const total = Math.floor(size / chunk);

  const source_info = { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunk, total_chunk_count: total };
  let init, modo = 'direct';
  try {
    init = await api('/v2/post/publish/video/init/', access, {
      post_info: {
        title: caption, privacy_level: privacy,
        disable_duet: false, disable_comment: false, disable_stitch: false,
        is_aigc: true,
      },
      source_info,
    });
  } catch (e) {
    // App sin auditar + cuenta pública: TikTok no deja publicar directo.
    // Plan B: mandarlo como borrador a la bandeja de TikTok (se termina de publicar desde la app).
    if (!String(e.message).includes('unaudited_client')) throw e;
    init = await api('/v2/post/publish/inbox/video/init/', access, { source_info });
    modo = 'draft';
  }

  const fd = fs.openSync(file, 'r');
  for (let i = 0; i < total; i++) {
    const start = i * chunk;
    const end = i === total - 1 ? size - 1 : start + chunk - 1; // el último absorbe el resto
    const buf = Buffer.alloc(end - start + 1);
    fs.readSync(fd, buf, 0, buf.length, start);
    const res = await fetch(init.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(buf.length), 'Content-Range': `bytes ${start}-${end}/${size}` },
      body: buf,
    });
    if (![200, 201, 206].includes(res.status)) throw new Error(`Subida del chunk ${i} falló: HTTP ${res.status} ${await res.text()}`);
  }
  fs.closeSync(fd);

  let status = 'PROCESSING_UPLOAD', data = {};
  for (let i = 0; i < 60 && !['PUBLISH_COMPLETE', 'SEND_TO_USER_INBOX', 'FAILED'].includes(status); i++) {
    await sleep(5000);
    data = await api('/v2/post/publish/status/fetch/', access, { publish_id: init.publish_id });
    status = data.status;
  }
  if (status === 'FAILED') throw new Error('TikTok rechazó el video: ' + (data.fail_reason || 'sin detalle'));
  out({ ok: true, modo, publish_id: init.publish_id, status, privacy: modo === 'draft' ? null : privacy, post_id: (data.publicaly_available_post_id || [])[0] || null });
})().catch(e => out({ ok: false, error: String(e.message || e) }));
