/* ════════════════════════════════════════════════════════════════
   Studios IA — noyau commun (API Agnès)
   Clés multiples · régulation par minute · reprises automatiques ·
   arrêt propre · lecteur de film · narration · stockage local.
   Chargé par chaque studio : <script src="commun/agnes.js"></script>
   ════════════════════════════════════════════════════════════════ */
(function () {
'use strict';

const API = 'https://apihub.agnes-ai.com/v1';
const POLL = 'https://apihub.agnes-ai.com/agnesapi';
const LS_KEYS = 'studios_ia_keys';
const LS_CFG = 'studios_ia_cfg';

// Requêtes par minute et par clé, selon l'abonnement Agnès
const TIERS = {
  free: { label: 'Gratuit', img: 10, vid: 1, txt: 10 },
  ent:  { label: 'Entreprise', img: 40, vid: 2, txt: 20 },
  plan: { label: 'Plan illimité', img: 100, vid: 5, txt: 120 }
};
const DEFAULT_CFG = {
  tier: 'free',
  txt: 'agnes-3.0-flash',
  txtFallback: 'agnes-2.5-flash',
  img: 'agnes-image-2.5-flash',
  imgFallback: 'agnes-image-2.1-flash',
  vid: 'agnes-video-2.5-flash',
  videoInFlight: 2
};

/* ─── Utilitaires ─────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Guillemets typographiques, tirets longs, espaces insécables : l'API les gère mal
const san = t => String(t ?? '')
  .replace(/[‘’‛′ʼ]/g, "'").replace(/[“”‟″«»]/g, '"')
  .replace(/–/g, '-').replace(/—/g, '--').replace(/…/g, '...')
  .replace(/[​-‍﻿]/g, '').replace(/[  ]/g, ' ').trim();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const fmtTime = ms => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + String(s % 60).padStart(2, '0'); };

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
};

class StopError extends Error { constructor() { super('Arrêt demandé'); this.name = 'StopError'; this.stop = true; } }
const isStop = e => !!(e && (e.stop || e.name === 'StopError'));

/* ─── Contrôle d'exécution (Démarrer / Arrêter) ───────────────── */
let ctrl = new AbortController();
const run = {
  active: false,
  begin() { ctrl = new AbortController(); this.active = true; wake.on(); return ctrl.signal; },
  end() { this.active = false; wake.off(); },
  stop() { ctrl.abort(); log('warn', 'Arrêt demandé'); },
  get signal() { return ctrl.signal; },
  check() { if (ctrl.signal.aborted) throw new StopError(); }
};
function sleep(ms) {
  return new Promise((res, rej) => {
    if (ctrl.signal.aborted) return rej(new StopError());
    const sig = ctrl.signal;
    const t = setTimeout(() => { sig.removeEventListener('abort', on); res(); }, ms);
    function on() { clearTimeout(t); rej(new StopError()); }
    sig.addEventListener('abort', on, { once: true });
  });
}

/* ─── Configuration et clés ───────────────────────────────────── */
let cfg = Object.assign({}, DEFAULT_CFG, store.get(LS_CFG, {}));
let keys = [];
let factor = 1;            // ralentit tout le monde après des 429
let videoCooldownUntil = 0; // file vidéo Agnès saturée

function parseKeys(raw) {
  const seen = new Set();
  return String(raw || '').split(/[\s,;]+/).map(s => s.trim())
    .filter(k => k.length > 12 && !k.startsWith('#') && !seen.has(k) && seen.add(k));
}
function loadKeys() {
  const list = parseKeys(store.get(LS_KEYS, ''));
  keys = list.map(k => keys.find(o => o.k === k) || { k, next: { img: 0, vid: 0, txt: 0 }, cool: 0, bad: 0, off: false, used: { img: 0, vid: 0, txt: 0 } });
  renderKeyBadge();
}
function saveKeys(raw) { store.set(LS_KEYS, parseKeys(raw).join('\n')); loadKeys(); }
function saveCfg(c) { cfg = Object.assign({}, DEFAULT_CFG, c); store.set(LS_CFG, cfg); }
const liveKeys = () => keys.filter(k => !k.off);
function resetKeys() { factor = 1; keys.forEach(k => { k.off = false; k.bad = 0; k.cool = 0; }); }

// Réserve un créneau sur la clé la plus disponible pour ce type d'appel
async function slot(kind) {
  for (;;) {
    run.check();
    const live = liveKeys();
    if (!live.length) throw Object.assign(new Error(keys.length ? 'Toutes les clés ont été refusées (401/403). Vérifiez-les.' : 'Ajoutez au moins une clé API (bouton « Clés »).'), { fatal: true });
    const rpm = (TIERS[cfg.tier] || TIERS.free)[kind] || 10;
    const gap = 60000 / rpm * 1.1 * factor;
    const now = Date.now();
    let best = null, bt = Infinity;
    for (const o of live) { const t = Math.max(o.next[kind], o.cool, now); if (t < bt) { bt = t; best = o; } }
    best.next[kind] = bt + gap;
    if (bt > now) await sleep(bt - now);
    if (best.cool > Date.now() || best.off) continue;
    return best;
  }
}

/* ─── Requête HTTP robuste ────────────────────────────────────── */
async function fetchT(url, opts, timeoutMs) {
  const t = new AbortController();
  const onStop = () => t.abort();
  ctrl.signal.addEventListener('abort', onStop, { once: true });
  const timer = setTimeout(() => t.abort(), timeoutMs);
  try { return await fetch(url, Object.assign({}, opts, { signal: t.signal })); }
  catch (e) {
    if (ctrl.signal.aborted) throw new StopError();
    if (e.name === 'AbortError') throw new Error('délai dépassé (' + Math.round(timeoutMs / 1000) + ' s)');
    throw new Error('réseau : ' + e.message);
  } finally { clearTimeout(timer); ctrl.signal.removeEventListener('abort', onStop); }
}

async function post(kind, path, body, opt) {
  opt = opt || {};
  const tries = opt.tries || 5, timeout = opt.timeout || 120000;
  let lastErr = null;
  for (let a = 0, hard = 0; a < tries && hard < 40; hard++) {
    run.check();
    if (kind === 'vid' && Date.now() < videoCooldownUntil) { await sleep(videoCooldownUntil - Date.now()); continue; }
    const key = opt.key || await slot(kind);
    key.used[kind]++;
    let r;
    try {
      r = await fetchT(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key.k }, body: JSON.stringify(body) }, timeout);
    } catch (e) {
      if (isStop(e)) throw e;
      lastErr = e; a++; log('warn', kind + ' : ' + e.message + ' — nouvel essai');
      await sleep(1500 * a); continue;
    }
    if (r.ok) { key.bad = 0; factor = Math.max(1, factor * 0.95); renderKeyBadge(); return { data: await r.json(), key }; }
    const txt = (await r.text().catch(() => '')).slice(0, 300);
    const tag = kind + ' · clé …' + key.k.slice(-4) + ' · HTTP ' + r.status;
    if (r.status === 429) {
      key.cool = Date.now() + (parseInt(r.headers.get('Retry-After'), 10) || 25) * 1000;
      factor = Math.min(4, factor * 1.3);
      log('warn', tag + ' (quota) — pause de la clé');
      if (opt.key) await sleep(25000);
      continue; // un 429 ne compte pas comme un échec
    }
    if (r.status === 503 && /queue|full|busy/i.test(txt)) {
      videoCooldownUntil = Date.now() + 45000 + Math.random() * 25000;
      log('warn', 'File vidéo Agnès saturée — pause ' + Math.round((videoCooldownUntil - Date.now()) / 1000) + ' s');
      continue;
    }
    if ([401, 402, 403].includes(r.status)) {
      if (++key.bad >= 2) { key.off = true; log('err', 'Clé …' + key.k.slice(-4) + ' désactivée (' + r.status + ')'); }
      renderKeyBadge();
      lastErr = new Error(tag + ' ' + txt); a++;
      if (opt.key) throw lastErr;
      continue;
    }
    if (r.status >= 500 || r.status === 408) { lastErr = new Error(tag + ' ' + txt); a++; log('warn', tag + ' — nouvel essai'); await sleep(2000 * Math.pow(1.6, a)); continue; }
    // 400, 404, 422… : la requête elle-même est invalide, inutile de réessayer
    throw Object.assign(new Error(tag + ' ' + txt), { status: r.status, badRequest: true });
  }
  throw lastErr || new Error(kind + ' : échec après ' + tries + ' essais');
}

/* ─── JSON tolérant (réponses IA imparfaites) ─────────────────── */
function parseJSON(text) {
  if (!text) return null;
  if (typeof text === 'object') return text;
  let c = String(text).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fm = c.match(/```(?:json)?\s*([\s\S]*?)```/); if (fm) c = fm[1].trim();
  const a = c.search(/[\[{]/); if (a < 0) return null;
  const close = c[a] === '[' ? ']' : '}';
  c = c.slice(a, c.lastIndexOf(close) + 1);
  try { return JSON.parse(c); } catch (e) {}
  // Répare : retours à la ligne dans les chaînes, virgules finales
  let out = '', inS = false, escp = false;
  for (const ch of c) {
    if (escp) { out += ch; escp = false; continue; }
    if (ch === '\\') { out += ch; escp = true; continue; }
    if (ch === '"') { inS = !inS; out += ch; continue; }
    if (inS && ch.charCodeAt(0) < 32) { out += ch === '\n' ? '\\n' : ch === '\t' ? '\\t' : ''; continue; }
    out += ch;
  }
  out = out.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(out); } catch (e) { return null; }
}

/* ─── Texte et vision ─────────────────────────────────────────── */
async function chat(o) {
  const imgs = [].concat(o.images || []).filter(Boolean);
  const content = imgs.length ? [{ type: 'text', text: o.user }].concat(imgs.map(u => ({ type: 'image_url', image_url: { url: u } }))) : o.user;
  const models = [...new Set([cfg.txt, cfg.txtFallback].filter(Boolean))];
  let lastErr;
  for (const model of models) {
    // 1er essai avec les options avancées, 2e sans (si le modèle les refuse)
    for (const lean of [false, true]) {
      const body = { model, messages: [{ role: 'system', content: o.system || 'Tu es un assistant utile.' }, { role: 'user', content }], temperature: o.temp ?? 0.7, max_tokens: o.max || 4000 };
      if (!lean) { body.chat_template_kwargs = { enable_thinking: false }; if (o.json) body.response_format = { type: 'json_object' }; }
      try {
        const { data } = await post('txt', '/chat/completions', body, { timeout: o.timeout || 180000, tries: 3 });
        const m = data.choices && data.choices[0] && data.choices[0].message;
        const t = m && (m.content || m.reasoning_content);
        if (t) return String(t).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        lastErr = new Error('réponse texte vide');
        break;
      } catch (e) {
        if (isStop(e) || e.fatal) throw e;
        lastErr = e;
        if (!e.badRequest) break;
      }
    }
    log('warn', 'Modèle texte ' + model + ' indisponible : ' + (lastErr && lastErr.message));
  }
  throw lastErr || new Error('IA texte indisponible');
}
async function chatJSON(o) {
  for (let a = 0; a < 2; a++) {
    const t = await chat(Object.assign({}, o, { json: true, user: a ? o.user + '\n\nIMPORTANT : réponds UNIQUEMENT par un JSON valide, sans texte autour.' : o.user }));
    const j = parseJSON(t);
    if (j) return j;
    log('warn', 'JSON illisible — nouvelle demande');
  }
  throw new Error('L\'IA n\'a pas renvoyé de JSON valide');
}

/* ─── Images ──────────────────────────────────────────────────── */
async function image(prompt, o) {
  o = o || {};
  const refs = [].concat(o.refs || []).filter(Boolean).slice(0, 4);
  const models = [...new Set([cfg.img, cfg.imgFallback].filter(Boolean))];
  let lastErr;
  for (const model of models) {
    const body = { model, prompt: san(prompt).slice(0, 3800), n: 1, size: o.size || '1K', ratio: o.ratio || '9:16', extra_body: { response_format: 'url' } };
    if (refs.length) body.extra_body.image = refs;
    try {
      const { data } = await post('img', '/images/generations', body, { timeout: 180000, tries: o.tries || 4 });
      const it = data.data && data.data[0];
      if (it && it.url) return it.url;
      if (it && it.b64_json) return 'data:image/png;base64,' + it.b64_json;
      lastErr = new Error('aucune image renvoyée');
    } catch (e) {
      if (isStop(e) || e.fatal) throw e;
      lastErr = e;
      if (!e.badRequest) throw e;
    }
  }
  throw lastErr;
}

/* ─── Vidéos ──────────────────────────────────────────────────── */
let videoRunning = 0;
const isLegacyVideo = m => /v2\.0|v1/.test(m);
function videoBody(prompt, o) {
  const model = o.model || cfg.vid;
  const secs = Math.max(2, Math.min(10, o.seconds || 6));
  if (isLegacyVideo(model)) {
    const b = { model, prompt: san(prompt), num_frames: secs * 24 + 1, frame_rate: 24 };
    if (o.first) b.image = o.first;
    return b;
  }
  const b = { model, prompt: san(prompt), seconds: String(secs), size: o.size || '720P', aspect_ratio: o.ratio || '9:16', n: 1 };
  if (o.first && o.last) Object.assign(b, { mode: 'keyframe', first_frame: o.first, last_frame: o.last });
  else if (o.first) b.first_frame = o.first;
  else if (o.refs && o.refs.length) Object.assign(b, { mode: 'reference', images: o.refs.slice(0, 5) });
  return b;
}
function innerVideoId(c) { // id composite « video_<base64> » → id interne
  if (typeof c !== 'string' || !c.startsWith('video_')) return null;
  let b = c.slice(6).replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  try { const m = atob(b).match(/video_id:([^;]+)/); return m ? m[1].trim() : null; } catch (e) { return null; }
}
async function pollVideo(id, key, model, onProgress) {
  const ids = [id]; const inner = innerVideoId(id); if (inner && inner !== id) ids.push(inner);
  const end = Date.now() + 25 * 60000;
  let iv = 4000, miss = 0, n = 0;
  await sleep(8000);
  while (Date.now() < end) {
    const vid = ids[n++ % ids.length];
    let r;
    try { r = await fetchT(POLL + '?video_id=' + encodeURIComponent(vid) + '&model_name=' + encodeURIComponent(model), { headers: { Authorization: 'Bearer ' + key.k } }, 30000); }
    catch (e) { if (isStop(e)) throw e; await sleep(iv); continue; }
    if (r.status === 429) { iv = Math.min(15000, iv * 1.5); await sleep(iv); continue; }
    if (r.status === 404 || r.status === 400) { if (++miss > 20) throw new Error('vidéo introuvable côté Agnès'); await sleep(iv); continue; }
    if (r.status === 401 || r.status === 403) throw new Error('clé refusée pendant le suivi');
    if (!r.ok) { await sleep(iv); continue; }
    const d = await r.json().catch(() => ({}));
    const st = String(d.status || (d.metadata && d.metadata.status) || '').toLowerCase();
    if (onProgress) onProgress(d.progress != null ? d.progress + ' %' : (st || 'en cours'));
    if (['completed', 'succeeded', 'success', 'done'].includes(st)) {
      const u = d.url || (d.metadata && d.metadata.url) || (d.output && d.output.url) || (d.data && d.data.url) || d.video_url;
      if (u) return u;
      throw new Error('vidéo terminée sans adresse');
    }
    if (['failed', 'error', 'cancelled', 'canceled'].includes(st)) throw Object.assign(new Error((d.error && d.error.message) || d.message || 'génération échouée'), { failed: true });
    iv = Math.min(10000, iv + 1000);
    await sleep(iv);
  }
  throw new Error('délai maximal de 25 min dépassé');
}
// Crée la vidéo puis attend le résultat. Réessaie si Agnès échoue.
async function video(prompt, o) {
  o = o || {};
  const max = Math.max(1, cfg.videoInFlight | 0);
  while (videoRunning >= max) await sleep(700);
  videoRunning++;
  try {
    let lastErr;
    for (let a = 1; a <= (o.attempts || 3); a++) {
      try {
        const body = videoBody(prompt, o);
        if (o.onProgress) o.onProgress(a > 1 ? 'essai ' + a : 'envoi');
        const { data, key } = await post('vid', '/videos', body, { timeout: 120000, tries: 6 });
        const id = data.video_id || data.id || data.task_id;
        if (!id) throw new Error('aucun identifiant vidéo renvoyé');
        return await pollVideo(id, key, body.model, o.onProgress);
      } catch (e) {
        if (isStop(e) || e.fatal) throw e;
        lastErr = e;
        log('warn', 'Vidéo essai ' + a + ' : ' + e.message);
        if (e.badRequest && o.first && /image|frame|url/i.test(e.message)) o = Object.assign({}, o, { first: null, last: null }); // image refusée → texte seul
        await sleep(3000 + Math.random() * 3000);
      }
    }
    throw lastErr;
  } finally { videoRunning--; }
}

/* ─── File de travail parallèle ───────────────────────────────── */
// Exécute fn sur chaque élément avec une limite de parallélisme ; une erreur n'arrête pas les autres.
async function pool(items, limit, fn) {
  const res = new Array(items.length); let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { res[idx] = { ok: true, value: await fn(items[idx], idx) }; }
      catch (e) { if (isStop(e) || e.fatal) throw e; res[idx] = { ok: false, error: e }; }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return res;
}
const imgLimit = () => Math.max(2, liveKeys().length * Math.ceil((TIERS[cfg.tier] || TIERS.free).img / 5));

/* ─── Actualités (France) ─────────────────────────────────────── */
const NEWS_TOPICS = { une: '', monde: 'WORLD', business: 'BUSINESS', tech: 'TECHNOLOGY', science: 'SCIENCE', sport: 'SPORTS', sante: 'HEALTH', culture: 'ENTERTAINMENT', france: 'NATION' };
const cleanTitle = t => { const d = document.createElement('textarea'); d.innerHTML = String(t || '').replace(/<[^>]+>/g, ''); return d.value.replace(/\s+-\s+[^-]{2,40}$/, '').trim(); };
async function news(topic, max) {
  max = max || 20;
  const tp = NEWS_TOPICS[topic] || '';
  const rss = tp ? 'https://news.google.com/rss/headlines/section/topic/' + tp + '?hl=fr&gl=FR&ceid=FR:fr' : 'https://news.google.com/rss?hl=fr&gl=FR&ceid=FR:fr';
  let items = [];
  try {
    const r = await fetchT('https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(rss), {}, 15000);
    const j = await r.json();
    items = (j.items || []).map(x => ({ title: cleanTitle(x.title), desc: cleanTitle(x.description).slice(0, 240) }));
  } catch (e) { if (isStop(e)) throw e; log('warn', 'rss2json : ' + e.message); }
  if (items.length < 5) {
    for (const px of ['https://api.allorigins.win/raw?url=', 'https://api.codetabs.com/v1/proxy/?quest=']) {
      try {
        const r = await fetchT(px + encodeURIComponent(rss), {}, 15000);
        const x = new DOMParser().parseFromString(await r.text(), 'text/xml');
        items = [...x.querySelectorAll('item')].map(i => ({ title: cleanTitle(i.querySelector('title')?.textContent), desc: '' }));
        if (items.length) break;
      } catch (e) { if (isStop(e)) throw e; log('warn', 'proxy actualités : ' + e.message); }
    }
  }
  const seen = new Set();
  return items.filter(i => i.title.length > 15 && !seen.has(i.title) && seen.add(i.title)).slice(0, max);
}

/* ─── Fichiers et images ──────────────────────────────────────── */
function fileToRef(file, maxSide) {
  maxSide = maxSide || 1280;
  return new Promise((res, rej) => {
    if (!file || !/^image\//.test(file.type)) return rej(new Error('Ce fichier n\'est pas une image'));
    const fr = new FileReader();
    fr.onerror = () => rej(new Error('Lecture du fichier impossible'));
    fr.onload = () => {
      const im = new Image();
      im.onerror = () => rej(new Error('Image illisible'));
      im.onload = () => {
        const s = Math.min(1, maxSide / Math.max(im.width, im.height));
        const c = document.createElement('canvas');
        c.width = Math.round(im.width * s); c.height = Math.round(im.height * s);
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(im, 0, 0, c.width, c.height);
        res(c.toDataURL('image/jpeg', 0.88));
      };
      im.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}
// Zone de dépôt d'images : cliquer, glisser-déposer ou coller
function dropzone(el, onFiles, multiple) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = !!multiple; inp.hidden = true;
  el.appendChild(inp);
  const take = async files => {
    const list = [...files].filter(f => /^image\//.test(f.type)).slice(0, multiple ? 12 : 1);
    if (!list.length) return toast('Choisissez une image', 'err');
    try { onFiles(await Promise.all(list.map(f => fileToRef(f)))); } catch (e) { toast(e.message, 'err'); }
  };
  el.addEventListener('click', e => { if (e.target.closest('button')) return; inp.click(); });
  inp.addEventListener('change', () => { take(inp.files); inp.value = ''; });
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drag'); });
  el.addEventListener('dragleave', () => el.classList.remove('drag'));
  el.addEventListener('drop', e => { e.preventDefault(); el.classList.remove('drag'); take(e.dataTransfer.files); });
  document.addEventListener('paste', e => { if (el.offsetParent && e.clipboardData && e.clipboardData.files.length) take(e.clipboardData.files); });
}
async function download(url, name) {
  try {
    const r = await fetch(url); if (!r.ok) throw new Error();
    const u = URL.createObjectURL(await r.blob());
    const a = Object.assign(document.createElement('a'), { href: u, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 4000);
  } catch (e) { window.open(url, '_blank', 'noopener'); }
}
async function downloadAll(list) { // [{url,name}]
  for (const it of list) { await download(it.url, it.name); await new Promise(r => setTimeout(r, 450)); }
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copié'); }
  catch (e) { const t = Object.assign(document.createElement('textarea'), { value: text }); document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); toast('Copié'); }
}

/* ─── Écran allumé pendant les longues générations ────────────── */
const wake = {
  lock: null,
  async on() { try { if (navigator.wakeLock && !this.lock) { this.lock = await navigator.wakeLock.request('screen'); this.lock.addEventListener('release', () => { this.lock = null; }); } } catch (e) {} },
  async off() { try { if (this.lock) await this.lock.release(); } catch (e) {} this.lock = null; }
};
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && run.active) wake.on(); });

/* ─── Narration française (voix du navigateur) ────────────────── */
function speak(text, rate) {
  return new Promise(res => {
    if (!('speechSynthesis' in window) || !text) return res();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'fr-FR'; u.rate = rate || 1;
    const v = speechSynthesis.getVoices().find(x => /^fr/i.test(x.lang));
    if (v) u.voice = v;
    const t = setTimeout(res, 2000 + text.length * 120);
    u.onend = u.onerror = () => { clearTimeout(t); res(); };
    speechSynthesis.speak(u);
  });
}
if ('speechSynthesis' in window) speechSynthesis.getVoices();

/* ─── Lecteur de film (enchaîne les clips) ────────────────────── */
let player = null;
function playFilm(clips, opt) {
  opt = opt || {};
  clips = (clips || []).filter(c => c && c.url);
  if (!clips.length) return toast('Aucune vidéo prête', 'err');
  if (!player) {
    player = document.createElement('div');
    player.className = 'ag-player';
    player.innerHTML = '<div class="ag-player-box"><video playsinline></video><video class="pre" muted preload="auto"></video>'
      + '<div class="ag-sub"></div><div class="ag-player-bar"><button data-a="prev" class="btn ghost">⏮</button><span class="ag-count"></span>'
      + '<button data-a="next" class="btn ghost">⏭</button><label class="ag-narr"><input type="checkbox"> Narration</label>'
      + '<button data-a="close" class="btn">✕ Fermer</button></div></div>';
    document.body.appendChild(player);
    player.addEventListener('click', e => { const a = e.target.closest('[data-a]'); if (a) player.go(a.dataset.a); else if (e.target === player) player.go('close'); });
    document.addEventListener('keydown', e => { if (player.classList.contains('on') && e.key === 'Escape') player.go('close'); });
  }
  const v = player.querySelector('video'), pre = player.querySelector('.pre'), sub = player.querySelector('.ag-sub'), cnt = player.querySelector('.ag-count'), narr = player.querySelector('.ag-narr input');
  narr.checked = opt.narrate !== false && clips.some(c => c.text);
  narr.parentElement.hidden = !clips.some(c => c.text);
  let i = 0;
  const show = () => {
    const c = clips[i];
    v.src = c.url; v.play().catch(() => {});
    sub.textContent = c.text || ''; sub.hidden = !c.text;
    cnt.textContent = (i + 1) + ' / ' + clips.length + (c.title ? ' · ' + c.title : '');
    if (clips[i + 1]) pre.src = clips[i + 1].url; // préchargement du clip suivant
    if (narr.checked && c.text) speak(c.text);
  };
  v.onended = () => { if (i < clips.length - 1) { i++; show(); } else player.go('close'); };
  v.onerror = () => { if (i < clips.length - 1) { i++; show(); } };
  player.go = a => {
    if (a === 'next' && i < clips.length - 1) { i++; show(); }
    else if (a === 'prev' && i > 0) { i--; show(); }
    else if (a === 'close') { v.pause(); v.removeAttribute('src'); pre.removeAttribute('src'); if ('speechSynthesis' in window) speechSynthesis.cancel(); player.classList.remove('on'); }
  };
  player.classList.add('on');
  show();
}

/* ─── Stockage IndexedDB (sessions volumineuses) ──────────────── */
const db = (() => {
  let p = null;
  // Certains navigateurs bloquent IndexedDB en file:// ou en navigation privée : on abandonne après 4 s
  const open = () => p || (p = new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('stockage local indisponible')), 4000);
    try {
      const r = indexedDB.open('studios_ia', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { clearTimeout(t); res(r.result); };
      r.onerror = () => { clearTimeout(t); rej(r.error); };
    } catch (e) { clearTimeout(t); rej(e); }
  }));
  const tx = async (mode, fn) => { const d = await open(); return new Promise((res, rej) => { const t = d.transaction('kv', mode); const q = fn(t.objectStore('kv')); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }); };
  return {
    get: k => tx('readonly', s => s.get(k)).catch(() => undefined),
    set: (k, v) => tx('readwrite', s => s.put(v, k)),
    del: k => tx('readwrite', s => s.delete(k)),
    keys: async prefix => ((await tx('readonly', s => s.getAllKeys()).catch(() => [])) || []).filter(k => String(k).startsWith(prefix || ''))
  };
})();

/* ─── Interface commune : en-tête, clés, journal, notifications ─ */
let logBox = null, logCount = 0;
function log(type, msg) {
  if (type === 'err') console.warn('[studio]', msg);
  if (!logBox) return;
  const d = document.createElement('div');
  d.className = 'l-' + type;
  d.textContent = new Date().toLocaleTimeString('fr-FR') + '  ' + msg;
  logBox.appendChild(d);
  if (++logCount > 400) { logBox.firstChild.remove(); logCount--; }
  logBox.scrollTop = logBox.scrollHeight;
  const last = $('ag-log-last'); if (last) last.textContent = msg;
}
let toastT = null;
function toast(msg, type) {
  let t = $('ag-toast');
  if (!t) { t = document.createElement('div'); t.id = 'ag-toast'; document.body.appendChild(t); }
  t.textContent = msg; t.className = 'on ' + (type || '');
  clearTimeout(toastT); toastT = setTimeout(() => { t.className = ''; }, 3500);
}
function renderKeyBadge() {
  const b = $('ag-keys-btn'); if (!b) return;
  const live = liveKeys().length;
  b.textContent = '🔑 ' + (keys.length ? live + '/' + keys.length + ' clé' + (keys.length > 1 ? 's' : '') : 'Ajouter une clé');
  b.classList.toggle('warn', !live);
}
function openKeys() {
  const m = $('ag-keys');
  $('ag-k-list').value = keys.map(k => k.k).join('\n');
  $('ag-k-tier').value = cfg.tier;
  $('ag-k-txt').value = cfg.txt; $('ag-k-img').value = cfg.img; $('ag-k-vid').value = cfg.vid;
  $('ag-k-inflight').value = cfg.videoInFlight;
  $('ag-k-test').textContent = '';
  m.showModal();
}
async function testKeys() {
  const list = parseKeys($('ag-k-list').value), out = $('ag-k-test');
  if (!list.length) { out.textContent = 'Aucune clé saisie.'; return; }
  out.textContent = 'Test en cours…';
  const lines = await Promise.all(list.map(async k => {
    try { const r = await fetch(API + '/models', { headers: { Authorization: 'Bearer ' + k } }); return '…' + k.slice(-4) + ' : ' + (r.ok ? '✓ valide' : '✗ HTTP ' + r.status); }
    catch (e) { return '…' + k.slice(-4) + ' : ✗ réseau'; }
  }));
  out.textContent = lines.join('   ');
}
function shell(o) {
  document.title = o.title + ' · Studios IA';
  const head = document.createElement('header');
  head.className = 'ag-head';
  head.innerHTML = '<a class="ag-home" href="index.html" title="Tous les studios">◂ Studios</a>'
    + '<div class="ag-title"><span class="ag-ico">' + esc(o.icon || '🎬') + '</span><div><h1>' + esc(o.title) + '</h1><p>' + esc(o.subtitle || '') + '</p></div></div>'
    + '<button class="btn ghost" id="ag-keys-btn"></button>';
  document.body.prepend(head);
  const dlg = document.createElement('dialog');
  dlg.id = 'ag-keys'; dlg.className = 'ag-modal';
  dlg.innerHTML = '<form method="dialog"><h2>Clés API Agnès</h2>'
    + '<p class="hint">Une clé par ligne (format <code>sk-…</code>). Elles sont enregistrées dans ce navigateur uniquement et partagées par tous les studios. Plusieurs clés = génération plus rapide.</p>'
    + '<textarea id="ag-k-list" rows="5" spellcheck="false" placeholder="sk-..."></textarea>'
    + '<div class="row2"><label>Abonnement<select id="ag-k-tier">' + Object.entries(TIERS).map(([k, t]) => '<option value="' + k + '">' + t.label + ' (' + t.img + ' img/min, ' + t.vid + ' vidéo/min)</option>').join('') + '</select></label>'
    + '<label>Vidéos en parallèle<input id="ag-k-inflight" type="number" min="1" max="10"></label></div>'
    + '<details><summary>Modèles (avancé)</summary><div class="row3"><label>Texte<input id="ag-k-txt"></label><label>Image<input id="ag-k-img"></label><label>Vidéo<input id="ag-k-vid"></label></div>'
    + '<p class="hint">agnes-video-v2.0 utilise l\'ancien format (images/s) ; les modèles 2.5 utilisent la durée en secondes.</p></details>'
    + '<p id="ag-k-test" class="hint mono"></p>'
    + '<div class="actions"><button type="button" class="btn ghost" id="ag-k-testbtn">Tester</button><a class="btn ghost" href="https://platform.agnes-ai.com" target="_blank" rel="noopener">Obtenir une clé</a><span class="grow"></span><button value="cancel" class="btn ghost">Annuler</button><button value="ok" class="btn primary" id="ag-k-save">Enregistrer</button></div></form>';
  document.body.appendChild(dlg);
  const logw = document.createElement('section');
  logw.className = 'ag-log';
  logw.innerHTML = '<button class="ag-log-head" type="button"><b>Journal</b><span id="ag-log-last">prêt</span><span class="ag-log-tog">▴</span></button><div class="ag-log-body" id="ag-log-body"></div>';
  document.body.appendChild(logw);
  logBox = $('ag-log-body');
  logw.querySelector('.ag-log-head').onclick = () => logw.classList.toggle('open');
  $('ag-keys-btn').onclick = openKeys;
  $('ag-k-testbtn').onclick = testKeys;
  $('ag-k-save').onclick = () => {
    saveKeys($('ag-k-list').value);
    saveCfg({ tier: $('ag-k-tier').value, txt: $('ag-k-txt').value.trim() || DEFAULT_CFG.txt, img: $('ag-k-img').value.trim() || DEFAULT_CFG.img, vid: $('ag-k-vid').value.trim() || DEFAULT_CFG.vid, videoInFlight: Math.max(1, Math.min(10, +$('ag-k-inflight').value || 2)) });
    toast(keys.length ? keys.length + ' clé(s) enregistrée(s)' : 'Aucune clé valide', keys.length ? '' : 'err');
  };
  loadKeys();
  if (!keys.length) setTimeout(openKeys, 300);
}
// Vérifie qu'une clé existe avant de lancer ; ouvre la fenêtre sinon
function needKeys() { if (keys.length) return true; openKeys(); toast('Ajoutez d\'abord une clé API', 'err'); return false; }
// Lance une génération : une seule à la fois, arrêt propre, erreurs affichées.
// busy(true|false) met à jour les boutons de la page.
async function job(fn, busy) {
  if (run.active) { toast('Une génération est déjà en cours'); return false; }
  if (!needKeys()) return false;
  run.begin(); resetKeys();
  if (busy) busy(true);
  const t0 = Date.now();
  try { await fn(); log('ok', 'Terminé en ' + fmtTime(Date.now() - t0)); return true; }
  catch (e) {
    if (isStop(e)) { toast('Génération arrêtée'); }
    else { log('err', e.message); toast(e.message, 'err'); }
    return false;
  } finally { run.end(); if (busy) busy(false); }
}

/* ─── Briques d'interface partagées ───────────────────────────── */
// Vignette de résultat : it = {id, label, text, img, video, st:'wait'|'run'|'ok'|'err', msg}
function tile(it, o) {
  o = o || {};
  const st = it.st || 'wait';
  let media;
  if (it.video) media = '<video src="' + esc(it.video) + '" controls playsinline preload="metadata"' + (it.img ? ' poster="' + esc(it.img) + '"' : '') + '></video>';
  else if (it.img) media = '<img src="' + esc(it.img) + '" alt="" loading="lazy">';
  else media = st === 'run' ? '<div class="spin"></div>' : '<div class="ph">' + (st === 'err' ? '✕' : 'en attente') + '</div>';
  const state = st === 'run' && it.msg ? it.msg : st === 'err' ? (it.msg || 'échec') + (o.retry ? ' · ↻' : '') : (st === 'run' && (it.img || it.video) ? '…' : '');
  const tools = (o.tools || []).filter(t => !t.when || t.when(it)).map(t => '<button class="btn small ghost" data-a="' + t.a + '" data-id="' + esc(it.id) + '" title="' + esc(t.title || '') + '">' + t.label + '</button>').join('');
  return '<div class="tile ' + st + (it.sel ? ' sel' : '') + (it.fav ? ' fav' : '') + '" data-id="' + esc(it.id) + '">'
    + '<div class="media ' + (o.ratio === '1:1' ? 'sq' : o.ratio === '16:9' ? 'land' : '') + '">' + media
    + (it.label ? '<span class="badge">' + esc(it.label) + '</span>' : '') + (state ? '<span class="state">' + esc(state) + '</span>' : '') + '</div>'
    + (it.text ? '<div class="body"><p>' + esc(it.text) + '</p></div>' : '')
    + (tools ? '<div class="tools">' + tools + '</div>' : '') + '</div>';
}
// Redessine au plus toutes les 80 ms (setTimeout et non requestAnimationFrame :
// ce dernier est suspendu quand l'onglet est en arrière-plan)
function throttle(fn) { let p = false; return () => { if (p) return; p = true; setTimeout(() => { p = false; fn(); }, 80); }; }
// Pastilles d'étapes : steps(el, ['Analyse','Images'], 1) → 0 fait, 1 en cours
function steps(el, names, cur) {
  el.innerHTML = names.map((n, i) => '<span class="' + (i < cur ? 'done' : i === cur ? 'on' : '') + '">' + (i < cur ? '✓ ' : '') + esc(n) + '</span>').join('');
}
// Boutons-pastilles à choix unique ou multiple
function chips(el, options, o) {
  o = o || {};
  const sel = new Set([].concat(o.value || []));
  el.classList.add('chips');
  el.innerHTML = options.map(x => { const [lab, val] = Array.isArray(x) ? x : [x, x]; return '<button type="button" data-v="' + esc(val) + '" class="' + (sel.has(val) ? 'on' : '') + '">' + esc(lab) + '</button>'; }).join('');
  el.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (!o.multi) el.querySelectorAll('.on').forEach(x => x !== b && x.classList.remove('on'));
    b.classList.toggle('on', o.multi ? !b.classList.contains('on') : true);
    if (o.onChange) o.onChange(chipsValue(el, o.multi));
  };
  return () => chipsValue(el, o.multi);
}
function chipsValue(el, multi) { const v = [...el.querySelectorAll('.on')].map(b => b.dataset.v); return multi ? v : v[0] || ''; }

window.addEventListener('beforeunload', e => { if (run.active) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('storage', e => { if (e.key === LS_KEYS) loadKeys(); if (e.key === LS_CFG) cfg = Object.assign({}, DEFAULT_CFG, store.get(LS_CFG, {})); });

window.AG = {
  $, esc, san, uid, fmtTime, store, sleep, isStop, StopError, run, parseJSON,
  chat, chatJSON, image, video, pool, imgLimit, news,
  fileToRef, dropzone, download, downloadAll, copy, speak, playFilm, db,
  log, toast, shell, needKeys, job, tile, throttle, steps, chips, resetKeys, get cfg() { return cfg; }, get keyCount() { return liveKeys().length; }
};
})();
