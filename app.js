/* ==========================================================================
   Team Room — lógica del cliente

   Un mensaje va a todos los agentes de la plantilla activa y cada respuesta
   aparece en la columna de su agente. Reglas de la sala:
   - Contexto cruzado: cada consulta lleva lo que dijeron recientemente los demás.
   - Menciones (@Backend, «Backend, ...»): responde el nombrado; los demás ceden el turno.
   - Emoción: el agente devuelve una emoción y su avatar cambia con un fundido.
   Todo lo que depende de los agentes llega desde api.php, así que otra plantilla
   en config.php o templates/*.json reconstruye la pantalla sola.
   ========================================================================== */

(() => {
  'use strict';

  /* ───────────────────────────── Constantes ───────────────────────────── */

  const API_URL = 'api.php';
  const KEY_UI = 'sala:v2:ui';         // v2: la habitación por defecto pasó a ser «General / Desarrollo»
  const KEY_THUMBS = 'sala:v1:thumbs'; // miniaturas de las imágenes enviadas (localStorage)
  const KEY_PW = 'sala:v1:pw';       // sessionStorage: se borra al cerrar la pestaña
  const KEY_THEME = 'sala:v1:theme'; // "light" | "dark"
  const keyChat = (template, agent) => `sala:v1:chat:${template}:${agent}`;
  const MAX_STORED = 300;
  const DEFAULT_LIMITS = { max_message_chars: 12000, max_history_messages: 40 };
  const DEFAULT_ORCHESTRATION = { mode: 'sequential', peer_messages: 2 };
  const DEFAULT_IMAGES = { types: ['image/png', 'image/jpeg', 'image/webp'], max_bytes: 4 * 1024 * 1024, max_side: 1600 };
  const SOFT_IMAGE_BYTES = 1.5 * 1024 * 1024;    // por encima de esto se recomprime
  const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024; // archivo original
  const REMEMBERED_IMAGES = 6;                    // imágenes completas que se guardan en memoria durante la sesión
  const STATUS_LABEL = { idle: 'Listo', queued: 'En espera', thinking: 'Pensando', error: 'Sin respuesta' };
  const ACCENT_FALLBACK = ['blue', 'magenta', 'yellow', 'green']; // si un agente no define "accent"
  const TABS_MODE = window.matchMedia('(max-width: 719.98px)');
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');

  const $ = (selector, root = document) => root.querySelector(selector);

  /* ─────────────────────────────── Estado ─────────────────────────────── */

  const state = {
    session: 0,
    password: '',
    appName: 'Team Room',
    limits: DEFAULT_LIMITS,
    orchestration: DEFAULT_ORCHESTRATION,
    imageCfg: DEFAULT_IMAGES,
    templates: [],
    templateId: null,
    activeAgentId: null, // solo importa en pantallas estrechas (pestañas)
    chats: new Map(),    // "plantilla:agente" -> mensajes
    queued: new Set(),   // esperando su turno en la ronda
    pending: new Set(),  // esperando respuesta de Gemini
    errors: new Map(),   // "plantilla:agente" -> { message }
    unread: new Map(),   // "plantilla:agente" -> respuestas sin leer (modo pestañas)
    epoch: new Map(),    // se incrementa al limpiar, para descartar respuestas tardías
    images: new Map(),   // id -> { mime, data(base64) } de las últimas imágenes enviadas (solo en memoria)
    attachment: null,    // imagen preparada y lista para enviar con el próximo mensaje
    processing: false,   // preparando una imagen
    processingName: '',
  };

  const key = (t = state.templateId, a) => `${t}:${a}`;
  const templateById = (id) => state.templates.find((t) => t.id === id);
  const template = () => templateById(state.templateId);
  const agentsOf = (t = state.templateId) => templateById(t)?.agents ?? [];
  const agentById = (id) => agentsOf().find((a) => a.id === id);
  const accentOf = (agent, index) => agent.accent || ACCENT_FALLBACK[index % ACCENT_FALLBACK.length];
  const indexOfAgent = (id) => agentsOf().findIndex((a) => a.id === id);

  /* ─────────────────────────── Almacenamiento ─────────────────────────── */

  const Store = {
    read(k, fallback) {
      try {
        const raw = localStorage.getItem(k);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    },
    write(k, value) {
      try {
        localStorage.setItem(k, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },
    remove(k) {
      try { localStorage.removeItem(k); } catch { /* sin acceso a localStorage */ }
    },
  };

  function getChat(t, a) {
    const id = key(t, a);
    if (!state.chats.has(id)) {
      const raw = Store.read(keyChat(t, a), []);
      const valid = Array.isArray(raw)
        ? raw.filter((m) => m && (m.role === 'user' || m.role === 'model') && typeof m.text === 'string')
        : [];
      state.chats.set(id, valid);
    }
    return state.chats.get(id);
  }

  function saveChat(t, a, messages) {
    if (messages.length > MAX_STORED) messages.splice(0, messages.length - MAX_STORED);
    if (!Store.write(keyChat(t, a), messages)) {
      // Cuota llena: descarta lo más antiguo y reintenta una vez.
      messages.splice(0, Math.ceil(messages.length * 0.2));
      Store.write(keyChat(t, a), messages);
    }
  }

  /* ───────────────────────────── Imágenes ───────────────────────────── */

  // Miniaturas persistentes (una por imagen, no una por agente): así el historial recuerda qué se envió
  // sin guardar en localStorage las imágenes completas.
  const Thumbs = {
    cache: null,
    load() {
      if (!this.cache) this.cache = Store.read(KEY_THUMBS, {});
      return this.cache;
    },
    get(id) {
      return this.load()[id] || null;
    },
    save(id, dataUrl) {
      const all = this.load();
      all[id] = dataUrl;
      let ids = Object.keys(all);
      while (ids.length > 40) delete all[ids.shift()];
      if (!Store.write(KEY_THUMBS, all)) {
        ids = Object.keys(all);
        ids.slice(0, Math.ceil(ids.length / 2)).forEach((old) => delete all[old]);
        Store.write(KEY_THUMBS, all);
      }
    },
  };

  const formatBytes = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const newImageId = () => `img_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

  function rememberImage(id, payload) {
    state.images.set(id, payload);
    while (state.images.size > REMEMBERED_IMAGES) state.images.delete(state.images.keys().next().value);
  }

  // Convierte cualquier imagen que el navegador sepa abrir en base64 listo para Gemini:
  // se reduce a `max_side` px y se recomprime solo si hace falta (PNG/JPEG/WebP pequeños pasan tal cual).
  const Images = (() => {
    const loadImage = (file) => new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo abrir esa imagen. Prueba con PNG, JPEG o WebP.')); };
      img.src = url;
    });

    const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

    const blobToBase64 = (blob) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new Error('No se pudo leer la imagen.'));
      reader.readAsDataURL(blob);
    });

    function draw(img, width, height, background) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, width, height); }
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, width, height);
      return canvas;
    }

    async function prepare(file, cfg) {
      if (!file.type.startsWith('image/')) throw new Error('Ese archivo no es una imagen.');
      if (file.size > MAX_INPUT_IMAGE_BYTES) throw new Error('La imagen pesa demasiado (máximo 20 MB).');

      const img = await loadImage(file);
      const { naturalWidth: w, naturalHeight: h } = img;
      if (!w || !h) throw new Error('No se pudo leer el tamaño de la imagen.');

      let scale = Math.min(1, cfg.max_side / Math.max(w, h));
      let width = Math.max(1, Math.round(w * scale));
      let height = Math.max(1, Math.round(h * scale));

      let blob;
      if (cfg.types.includes(file.type) && scale === 1 && file.size <= SOFT_IMAGE_BYTES) {
        blob = file; // ya es válida y ligera: se envía sin tocarla
      } else if (file.type === 'image/jpeg') {
        blob = await toBlob(draw(img, width, height, '#ffffff'), 'image/jpeg', 0.9);
      } else {
        blob = await toBlob(draw(img, width, height), 'image/png'); // capturas y diagramas: sin pérdida
        if (blob && blob.size > SOFT_IMAGE_BYTES) blob = await toBlob(draw(img, width, height, '#ffffff'), 'image/jpeg', 0.88);
      }

      if (blob && blob.size > cfg.max_bytes) { // último intento: más pequeña
        scale *= 0.7;
        width = Math.max(1, Math.round(w * scale));
        height = Math.max(1, Math.round(h * scale));
        blob = await toBlob(draw(img, width, height, '#ffffff'), 'image/jpeg', 0.8);
      }
      if (!blob) throw new Error('No se pudo preparar la imagen.');
      if (blob.size > cfg.max_bytes) throw new Error(`La imagen sigue pesando demasiado (máximo ${formatBytes(cfg.max_bytes)}).`);

      const thumbScale = Math.min(1, 360 / Math.max(width, height));
      const thumb = draw(img, Math.max(1, Math.round(width * thumbScale)), Math.max(1, Math.round(height * thumbScale)), '#ffffff')
        .toDataURL('image/jpeg', 0.72);

      return {
        id: newImageId(),
        mime: blob.type || file.type,
        data: await blobToBase64(blob),
        thumb,
        name: file.name && file.name !== 'image.png' ? file.name : 'captura',
        width,
        height,
        bytes: blob.size,
      };
    }

    return { prepare };
  })();

  /* ─────────────────────────────── Tema ─────────────────────────────── */

  const Theme = {
    current: () => (document.documentElement.classList.contains('light-theme') ? 'light' : 'dark'),
    apply(mode) {
      document.documentElement.classList.toggle('light-theme', mode === 'light');
      $('#theme-color')?.setAttribute('content', mode === 'light' ? '#f8f7f4' : '#131823');
      const next = mode === 'light' ? 'oscuro' : 'claro';
      $('#theme-label').textContent = `Modo ${next}`;
      $('#theme-btn').title = `Cambiar a modo ${next}`;
    },
    toggle() {
      const next = Theme.current() === 'light' ? 'dark' : 'light';
      Theme.apply(next);
      try { localStorage.setItem(KEY_THEME, next); } catch { /* sin acceso a localStorage */ }
    },
  };

  /* ───────────────────────────── Markdown ───────────────────────────── */
  /* <markdown> */
  // Renderizador propio: escapa TODO el HTML antes de formatear, así que la
  // salida del modelo nunca puede inyectar etiquetas ni scripts.

  const Markdown = (() => {
    const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    const esc = (s) => s.replace(/[&<>"']/g, (c) => ESC[c]);

    const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
    const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
    const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
    const QUOTE_RE = /^\s{0,3}>/;
    const LIST_RE = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
    const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

    function inline(raw) {
      const stash = [];
      let s = raw.replace(/`([^`\n]+)`/g, (_, code) => {
        stash.push(code);
        return `\u0000${stash.length - 1}\u0000`;
      });

      s = esc(s);

      // [texto](https://...)
      s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

      // URLs sueltas
      s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, url) => {
        const trail = (url.match(/[.,;:!?]+$/) || [''])[0];
        const clean = trail ? url.slice(0, -trail.length) : url;
        return `${pre}<a href="${clean}" target="_blank" rel="noopener noreferrer">${clean}</a>${trail}`;
      });

      s = s
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>')
        .replace(/~~(.+?)~~/g, '<del>$1</del>');

      return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(stash[Number(i)])}</code>`);
    }

    function codeBlock(code, lang) {
      return `<div class="code"><div class="code-bar"><span class="code-lang">${esc(lang || 'texto')}</span>` +
        `<button type="button" class="code-copy">Copiar</button></div><pre><code>${esc(code)}</code></pre></div>`;
    }

    function splitRow(row) {
      return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    }

    function renderList(items) {
      let html = '';
      const stack = [];
      const open = (item, tag) => {
        const start = item.ordered && item.start !== 1 ? ` start="${item.start}"` : '';
        html += `<${tag}${start}>`;
        stack.push({ indent: item.indent, tag });
      };
      for (const item of items) {
        const tag = item.ordered ? 'ol' : 'ul';
        while (stack.length && item.indent < stack[stack.length - 1].indent) {
          html += `</li></${stack.pop().tag}>`;
        }
        if (!stack.length || item.indent > stack[stack.length - 1].indent) {
          open(item, tag);
        } else if (stack[stack.length - 1].tag !== tag) {
          // Mismo nivel pero cambia el tipo de lista (numerada <-> viñetas)
          html += `</li></${stack.pop().tag}>`;
          open(item, tag);
        } else {
          html += '</li>';
        }
        const task = item.text.match(/^\[( |x|X)\]\s+(.*)$/);
        html += task
          ? `<li><input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''}>${inline(task[2])}`
          : `<li>${inline(item.text)}`;
      }
      while (stack.length) html += `</li></${stack.pop().tag}>`;
      return html;
    }

    function startsBlock(line, next) {
      return FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line) ||
        LIST_RE.test(line) || (line.includes('|') && next !== undefined && TABLE_SEP_RE.test(next));
    }

    function render(src) {
      const lines = String(src).replace(/\u0000/g, '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
      const out = [];
      let i = 0;

      while (i < lines.length) {
        const line = lines[i];

        if (line.trim() === '') { i++; continue; }

        // Bloque de código
        let m = line.match(FENCE_RE);
        if (m) {
          const fence = m[1];
          const buf = [];
          i++;
          while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++]);
          i++; // cierre
          out.push(codeBlock(buf.join('\n'), m[2]));
          continue;
        }

        // Título
        m = line.match(HEADING_RE);
        if (m) { out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue; }

        // Separador
        if (HR_RE.test(line)) { out.push('<hr>'); i++; continue; }

        // Cita
        if (QUOTE_RE.test(line)) {
          const buf = [];
          while (i < lines.length && QUOTE_RE.test(lines[i])) buf.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
          out.push(`<blockquote>${render(buf.join('\n'))}</blockquote>`);
          continue;
        }

        // Tabla
        if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
          const head = splitRow(line);
          const aligns = splitRow(lines[i + 1]).map((c) =>
            c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : '');
          i += 2;
          const rows = [];
          while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
          const cell = (tag, text, n) =>
            `<${tag}${aligns[n] ? ` style="text-align:${aligns[n]}"` : ''}>${inline(text)}</${tag}>`;
          out.push(
            '<div class="table-wrap"><table><thead><tr>' + head.map((c, n) => cell('th', c, n)).join('') +
            '</tr></thead><tbody>' +
            rows.map((r) => '<tr>' + head.map((_, n) => cell('td', r[n] ?? '', n)).join('') + '</tr>').join('') +
            '</tbody></table></div>'
          );
          continue;
        }

        // Lista (con anidación por sangría)
        if (LIST_RE.test(line)) {
          const items = [];
          while (i < lines.length) {
            const l = lines[i];
            const lm = l.match(LIST_RE);
            if (lm) {
              items.push({
                indent: lm[1].length,
                ordered: /\d/.test(lm[2]),
                start: parseInt(lm[2], 10) || 1,
                text: lm[3],
              });
              i++;
            } else if (l.trim() === '') {
              let j = i + 1;
              while (j < lines.length && lines[j].trim() === '') j++;
              if (j < lines.length && LIST_RE.test(lines[j])) { i = j; } else { break; }
            } else if (/^\s+\S/.test(l) && items.length && !FENCE_RE.test(l)) {
              items[items.length - 1].text += ' ' + l.trim();
              i++;
            } else {
              break;
            }
          }
          out.push(renderList(items));
          continue;
        }

        // Párrafo
        const buf = [line];
        i++;
        while (i < lines.length && lines[i].trim() !== '' && !startsBlock(lines[i], lines[i + 1])) buf.push(lines[i++]);
        out.push(`<p>${buf.map(inline).join('<br>')}</p>`);
      }

      return out.join('');
    }

    return { render };
  })();

  const renderMarkdown = Markdown.render;
  /* </markdown> */

  /* ───────────────────────────── Íconos y DOM ───────────────────────────── */

  const ICONS = {
    code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>',
    layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
    server: '<rect x="3" y="4" width="18" height="6" rx="1"/><rect x="3" y="14" width="18" height="6" rx="1"/><path d="M7 7h.01M7 17h.01"/>',
    database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/>',
    cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
    scale: '<path d="M12 3v18M5 21h14M6 7h12"/><path d="m6 7-3 7a3 3 0 0 0 6 0L6 7ZM18 7l-3 7a3 3 0 0 0 6 0l-3-7Z"/>',
    megaphone: '<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1Z"/><path d="M15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12"/>',
    bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3Z"/>',
    pen: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    chart: '<path d="M3 3v18h18M7 15l4-4 3 3 5-6"/>',
    shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z"/>',
    bot: '<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4M9 13h.01M15 13h.01M2 14v2M22 14v2"/>',
  };

  const UI_ICONS = {
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
    check: '<path d="m5 12 5 5 9-10"/>',
  };

  // Insignias de la esquina del avatar: una por situación (sin signos de exclamación).
  const BADGES = {
    wait:     { label: 'Esperando tu mensaje',     paths: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12Z"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/>' },
    queued:   { label: 'En cola, espera su turno', paths: '<path d="M5 22h14M5 2h14M17 22v-4.17a2 2 0 0 0-.59-1.41L12 12l-4.41 4.42A2 2 0 0 0 7 17.83V22M7 2v4.17a2 2 0 0 0 .59 1.41L12 12l4.41-4.42A2 2 0 0 0 17 6.17V2"/>' },
    thinking: { label: 'Pensando la respuesta',    paths: '<path d="M21 12a9 9 0 1 1-6.22-8.56"/>' },
    error:    { label: 'No pudo responder',        paths: '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>' },
    pass:     { label: 'Pasó la palabra',          paths: '<path d="M5 12h14M13 6l6 6-6 6"/>' },
    happy:    { label: 'Contento',                 paths: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8Z"/>' },
    ponder:   { label: 'Dándole vueltas',          paths: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3Z"/>' },
    shock:    { label: 'Sorprendido',              paths: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z"/>' },
    angry:    { label: 'Molesto con la idea',      paths: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5Z"/>' },
  };
  const EMOTION_BADGE = { neutral: 'wait', happy: 'happy', thinking: 'ponder', shock: 'shock', angry: 'angry' };

  function svg(paths) {
    const t = document.createElement('template');
    t.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
    return t.content.firstElementChild;
  }

  // Crea elementos. `html` solo se usa con contenido ya escapado (Markdown).
  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (name === 'class') node.className = value;
      else if (name === 'text') node.textContent = value;
      else if (name === 'html') node.innerHTML = value;
      else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
      else node.setAttribute(name, value === true ? '' : value);
    }
    for (const child of children.flat()) if (child != null) node.append(child);
    return node;
  }

  const fmtTime = (ts) => new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = h('textarea', { style: 'position:fixed;opacity:0;pointer-events:none' });
        ta.value = text;
        document.body.append(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  function confirmDialog(title, text, okLabel) {
    const dialog = $('#dialog');
    $('#dialog-title').textContent = title;
    $('#dialog-text').textContent = text;
    $('#dialog-ok').textContent = okLabel;
    return new Promise((resolve) => {
      dialog.returnValue = '';
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
      dialog.showModal();
    });
  }

  /* ─────────────────────────────── API ─────────────────────────────── */

  class ApiError extends Error {
    constructor(message, status, code) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  const Api = {
    async call(payload) {
      let res;
      try {
        res = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch {
        throw new ApiError('No se pudo conectar con el servidor. Revisa tu conexión.', 0, 'network');
      }
      let data = null;
      try { data = await res.json(); } catch { /* respuesta sin JSON */ }
      if (!res.ok || !data || data.ok !== true) {
        throw new ApiError(data?.message || `El servidor respondió con un error (${res.status}).`, res.status, data?.error);
      }
      return data;
    },
    auth: (password) => Api.call({ action: 'auth', password }),
    route: (params) => Api.call({ action: 'route', password: state.password, ...params }),
    chat: (params) => Api.call({ action: 'chat', password: state.password, ...params }),
  };

  /* ─────────────────────────── Avatares y emociones ─────────────────────────── */

  const preloaded = new Set();

  // Descarga todas las emociones de antemano: así el cambio de imagen es inmediato y no parpadea.
  function preloadAvatars() {
    for (const t of state.templates) {
      for (const a of t.agents) {
        for (const src of Object.values(a.avatar || {})) {
          if (preloaded.has(src)) continue;
          preloaded.add(src);
          const img = new Image();
          img.decoding = 'async';
          img.src = src;
        }
      }
    }
  }

  // Contenedor genérico: .agent-avatar > .agent-avatar__media > (dos <img> | ícono).
  function avatarNode(a, accent, size = '') {
    const media = h('div', { class: 'agent-avatar__media' });
    if (a.avatar?.neutral) {
      media.append(h('div', { class: 'avatar-stage' },
        h('img', { class: 'avatar-img is-current', src: a.avatar.neutral, alt: '', decoding: 'async', draggable: 'false' }),
        h('img', { class: 'avatar-img', alt: '', decoding: 'async', draggable: 'false' })
      ));
    } else if (ICONS[a.icon]) {
      media.append(svg(ICONS[a.icon]));
    } else {
      media.append(document.createTextNode((a.name || '?').slice(0, 2)));
    }
    // Cada agente respira a su propio ritmo (y desfasado) para que no se muevan al unísono.
    let seed = 0;
    for (const ch of a.id) seed = (seed * 31 + ch.charCodeAt(0)) % 997;
    const life = `--life:${(4.4 + (seed % 9) * 0.25).toFixed(2)}s;--life-delay:-${((seed % 50) / 10).toFixed(1)}s`;

    const avatar = h('div', {
      class: `agent-avatar ${size}`.trim(),
      'data-accent': accent,
      'data-status': 'idle',
      'data-emotion': 'neutral',
      'aria-hidden': 'true',
      style: life,
    }, media);
    setBadge(avatar, a, 'wait');
    return avatar;
  }

  // Cambia la insignia de la esquina; al cambiar, la nueva "aparece" con un pequeño rebote.
  function setBadge(avatar, a, kind) {
    if (avatar.dataset.kind === kind) return;
    avatar.dataset.kind = kind;
    avatar.title = `${a.name}: ${BADGES[kind].label}`;
    avatar.querySelector('.agent-avatar__badge')?.remove();
    avatar.append(h('span', { class: 'agent-avatar__badge', 'data-kind': kind },
      h('span', { class: 'badge-face' }, svg(BADGES[kind].paths))));
  }

  // Cambia la emoción con un fundido cruzado entre las dos capas <img>.
  function setEmotion(avatar, a, emotion) {
    if (!a.avatar?.neutral) return;
    const src = a.avatar[emotion] || a.avatar.neutral;
    const current = avatar.querySelector('.avatar-img.is-current');
    if (!current || current.getAttribute('src') === src) return;

    const next = [...avatar.querySelectorAll('.avatar-img')].find((img) => img !== current);
    if (!next) return;
    avatar.dataset.emotion = emotion;
    next.src = src;

    const swap = () => {
      next.classList.add('is-current');
      current.classList.remove('is-current');
    };
    if (typeof next.decode === 'function') next.decode().then(swap, swap);
    else swap();
  }

  function lastModelMessage(t, agentId) {
    const messages = getChat(t, agentId);
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'model') return messages[i];
    }
    return null;
  }

  /* ───────────────────────────── Renderizado ───────────────────────────── */

  const columnsEl = $('#columns');
  const tabsEl = $('#tabs');
  const inputEl = $('#input');
  const sendBtn = $('#send-btn');
  const hintEl = $('#hint');
  const attachEl = $('#attachment');
  const attachThumb = $('#attachment-thumb');
  const attachName = $('#attachment-name');
  const attachMeta = $('#attachment-meta');
  const attachError = $('#attach-error');
  const fileInput = $('#file-input');
  const nodes = new Map(); // agentId -> referencias a la columna y su pestaña

  function statusOf(agentId) {
    const id = key(state.templateId, agentId);
    if (state.pending.has(id)) return 'thinking';
    if (state.queued.has(id)) return 'queued';
    if (state.errors.has(id)) return 'error';
    return 'idle';
  }

  const busyCount = () => agentsOf().filter((a) => {
    const id = key(state.templateId, a.id);
    return state.pending.has(id) || state.queued.has(id);
  }).length;

  function renderTemplateSelect() {
    const select = $('#template-select');
    select.replaceChildren(...state.templates.map((t) => h('option', { value: t.id, text: t.name, title: t.description || '' })));
    select.value = state.templateId;
    select.title = template()?.description || 'Habitación actual';
  }

  // Columnas en el orden de "grid" (cuadrícula 2 x 2); pestañas en el orden de los agentes.
  function renderBoard() {
    const t = template();
    columnsEl.replaceChildren();
    tabsEl.replaceChildren();
    nodes.clear();

    const gridOrder = (t.grid?.length ? t.grid : t.agents.map((a) => a.id)).map(agentById).filter(Boolean);
    const built = new Map();

    t.agents.forEach((a, index) => {
      const accent = accentOf(a, index);

      const statusText = h('span', { text: STATUS_LABEL.idle });
      const status = h('span', { class: 'status', 'data-status': 'idle' }, h('i', { class: 'light', 'aria-hidden': 'true' }), statusText);

      const clearBtn = h('button', {
        class: 'icon-btn',
        type: 'button',
        title: `Limpiar el historial de ${a.name}`,
        'aria-label': `Limpiar el historial de ${a.name}`,
        onclick: () => clearAgents([a]),
      }, svg(UI_ICONS.trash));

      const avatar = avatarNode(a, accent);
      const thread = h('div', {
        class: 'thread',
        role: 'log',
        'aria-live': 'polite',
        'aria-label': `Conversación con ${a.name}`,
        tabindex: '0',
      });

      const column = h('article', { class: 'column', 'data-accent': accent, 'data-status': 'idle' },
        h('header', { class: 'column-head' },
          avatar,
          h('div', { class: 'column-title' }, h('h2', { text: a.name }), h('p', { text: a.role || a.tagline })),
          status,
          clearBtn),
        thread);
      built.set(a.id, column);

      const badge = h('span', { class: 'badge', hidden: true });
      const tabAvatar = avatarNode(a, accent, 'sm');
      const tab = h('button', {
        class: 'tab',
        type: 'button',
        'data-accent': accent,
        'data-status': 'idle',
        onclick: () => setActiveAgent(a.id),
      }, tabAvatar, h('span', { class: 'tab-name', text: a.name }), badge);
      tabsEl.append(tab);

      nodes.set(a.id, { column, thread, avatars: [avatar, tabAvatar], status, statusText, tab, badge, tailKey: '' });
    });

    // Cuadrícula de 2 columnas rellenada por filas: posiciones pares a la izquierda, impares a la derecha.
    gridOrder.forEach((a, position) => {
      const column = built.get(a.id);
      column.dataset.side = position % 2 === 0 ? 'left' : 'right';
      columnsEl.append(column);
    });
  }

  function refreshColumns() {
    const t = state.templateId;
    for (const a of agentsOf()) {
      const n = nodes.get(a.id);
      if (!n) continue;
      const status = statusOf(a.id);
      const unread = state.unread.get(key(t, a.id)) || 0;

      n.column.dataset.status = status;
      n.status.dataset.status = status;
      n.statusText.textContent = STATUS_LABEL[status];
      n.tab.dataset.status = status;
      n.tab.setAttribute('aria-current', String(a.id === state.activeAgentId));
      n.tab.setAttribute('aria-label',
        `${a.name}, ${STATUS_LABEL[status].toLowerCase()}${unread ? `, ${unread} sin leer` : ''}`);
      n.badge.hidden = !unread;
      n.badge.textContent = unread > 9 ? '9+' : String(unread);
      n.column.classList.toggle('is-active', a.id === state.activeAgentId);

      // Avatar: pensando mientras consulta, sorprendido si falla, si no la última emoción devuelta.
      const last = lastModelMessage(t, a.id);
      const emotion = status === 'thinking' ? 'thinking'
        : status === 'error' ? 'shock'
        : status === 'queued' ? 'neutral'
        : last?.emotion || 'neutral';

      // Insignia: refleja el estado y, en reposo, cómo terminó su última respuesta.
      const kind = status === 'thinking' ? 'thinking'
        : status === 'queued' ? 'queued'
        : status === 'error' ? 'error'
        : last?.yield ? 'pass'
        : EMOTION_BADGE[emotion] || 'wait';

      n.avatars.forEach((avatar) => {
        avatar.dataset.status = status;
        setEmotion(avatar, a, emotion);
        setBadge(avatar, a, kind);
      });
    }
  }

  function updateComposer() {
    const waiting = busyCount();
    const agents = agentsOf();
    const hasContent = Boolean(inputEl.value.trim()) || Boolean(state.attachment);
    sendBtn.disabled = waiting > 0 || state.processing || !hasContent;

    if (waiting > 0) {
      hintEl.textContent = `Esperando respuesta de ${waiting} ${waiting === 1 ? 'agente' : 'agentes'}`;
      return;
    }
    if (state.processing) {
      hintEl.textContent = 'Preparando la imagen...';
      return;
    }
    const example = agents.find((a) => /^[\p{L}\p{N}]+$/u.test(a.name)) ?? agents[0];
    const image = state.attachment ? `La imagen la verán los ${agents.length} agentes. ` : '';
    hintEl.textContent = `${image}Enter envía a todo el equipo. Usa @${example?.name ?? 'Agente'} para dirigirte a uno solo. Shift+Enter agrega una línea.`;
  }

  /* ───────────────────────────── Imagen adjunta ───────────────────────────── */

  function showAttachError(message) {
    attachError.textContent = message;
    attachError.hidden = !message;
  }

  function renderAttachment() {
    const att = state.attachment;
    attachEl.hidden = !att && !state.processing;
    attachThumb.hidden = !att;
    if (att) {
      attachThumb.src = att.thumb;
      attachName.textContent = att.name;
      attachMeta.textContent = `${att.width} × ${att.height} px, ${formatBytes(att.bytes)}`;
    } else if (state.processing) {
      attachName.textContent = state.processingName;
      attachMeta.textContent = 'Preparando la imagen...';
    }
  }

  async function attachFile(file) {
    if (!file || state.processing) return;
    showAttachError('');
    state.processing = true;
    state.processingName = file.name || 'imagen';
    state.attachment = null;
    renderAttachment();
    updateComposer();
    try {
      state.attachment = await Images.prepare(file, state.imageCfg);
    } catch (err) {
      showAttachError(err.message || 'No se pudo preparar la imagen.');
    } finally {
      state.processing = false;
      renderAttachment();
      updateComposer();
    }
  }

  function clearAttachment() {
    state.attachment = null;
    showAttachError('');
    renderAttachment();
    updateComposer();
  }

  const firstImage = (files) => [...(files || [])].find((f) => f.type && f.type.startsWith('image/'));

  function imageNode(image) {
    const src = Thumbs.get(image.id);
    return src
      ? h('img', { class: 'msg-image', src, alt: `Imagen adjunta: ${image.name}` })
      : h('p', { class: 'msg-image-missing', text: `Imagen adjunta: ${image.name}` });
  }

  function autosize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 220)}px`;
  }

  function fillComposer(text) {
    inputEl.value = text;
    autosize();
    updateComposer();
    inputEl.focus();
  }

  function emptyNode(a) {
    const ideas = (a.starters || []).slice(0, 3);
    return h('div', { class: 'empty' },
      a.greeting ? h('p', { text: a.greeting }) : null,
      ideas.length ? h('p', { class: 'ideas-label', text: 'Ideas para empezar' }) : null,
      ideas.length
        ? h('ul', { class: 'ideas' }, ideas.map((text) =>
          h('li', {}, h('button', { class: 'idea', type: 'button', text, onclick: () => fillComposer(text) }))))
        : null);
  }

  function messageNode(msg) {
    const ts = msg.ts || Date.now();
    const time = h('time', { class: 'stamp', datetime: new Date(ts).toISOString(), text: fmtTime(ts) });

    if (msg.role === 'user') {
      return h('article', { class: 'msg user' },
        h('div', { class: 'bubble' },
          msg.image ? imageNode(msg.image) : null,
          msg.text ? h('div', { class: 'md', html: renderMarkdown(msg.text) }) : null,
          time));
    }

    const copyBtn = h('button', {
      class: 'icon-btn msg-copy',
      type: 'button',
      title: 'Copiar respuesta',
      'aria-label': 'Copiar respuesta',
    }, svg(UI_ICONS.copy));

    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(msg.text);
      copyBtn.replaceChildren(svg(ok ? UI_ICONS.check : UI_ICONS.copy));
      setTimeout(() => copyBtn.replaceChildren(svg(UI_ICONS.copy)), 1500);
    });

    return h('article', { class: `msg ai${msg.yield ? ' is-yield' : ''}` },
      time, h('div', { class: 'md', html: renderMarkdown(msg.text) }), copyBtn);
  }

  /* ───────── Vida: escritura progresiva, salto del avatar y chispas ───────── */

  // La respuesta ya tiene su tamaño final; el texto aún no escrito se pinta transparente
  // con la CSS Custom Highlight API (::highlight(unrevealed)). Sin soporte, aparece de golpe.
  let unrevealed = null;

  function typewrite(el) {
    const supported = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';
    if (!el || !supported || REDUCED.matches) return;

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const parts = [];
    let total = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeValue.length) { parts.push({ node, start: total }); total += node.nodeValue.length; }
    }
    if (total < 2) return;

    if (!unrevealed) {
      unrevealed = new Highlight();
      CSS.highlights.set('unrevealed', unrevealed);
    }

    const lastNode = parts[parts.length - 1].node;
    const range = document.createRange();
    range.setStart(parts[0].node, 0);
    range.setEnd(lastNode, lastNode.nodeValue.length);
    unrevealed.add(range);

    const duration = Math.min(2600, Math.max(500, total * 4)); // ms: rápido, pero se nota que "escribe"
    const t0 = performance.now();
    let index = 0;

    const step = (now) => {
      const shown = Math.floor(((now - t0) / duration) * total);
      if (shown >= total || !el.isConnected) { unrevealed.delete(range); return; }
      while (index < parts.length - 1 && parts[index + 1].start <= shown) index++;
      range.setStart(parts[index].node, Math.max(0, shown - parts[index].start));
      range.setEnd(lastNode, lastNode.nodeValue.length);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // Reproduce una animación CSS de una sola vez (se puede repetir en cada respuesta).
  function playOnce(el, className, ms) {
    el.classList.remove(className);
    void el.offsetWidth; // reinicia la animación
    el.classList.add(className);
    setTimeout(() => el.classList.remove(className), ms);
  }

  const SPARK_SHAPES = [
    '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8Z"/>', // corazón
    '<path d="M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9L12 2Z"/>',                                                    // chispa
  ];

  // Corazones y chispas que suben desde el avatar cuando el agente responde contento.
  function spawnSparks(avatar) {
    const burst = h('span', { class: 'sparks', 'aria-hidden': 'true' });
    for (let i = 0; i < 6; i++) {
      const spark = h('i', {
        class: 'spark',
        style: [
          `--dx:${Math.round(-26 + Math.random() * 52)}px`,
          `--dy:${-(30 + Math.round(Math.random() * 12))}px`,
          `--size:${13 + Math.round(Math.random() * 6)}px`,
          `--rot:${Math.round(-25 + Math.random() * 50)}deg`,
          `--delay:${Math.round(Math.random() * 240)}ms`,
        ].join(';'),
      }, svg(SPARK_SHAPES[i % SPARK_SHAPES.length]));
      burst.append(spark);
    }
    avatar.append(burst);
    setTimeout(() => burst.remove(), 1600);
  }

  // Cuando llega una respuesta: el avatar da un saltito y, si está contento, salen chispas.
  function reactToReply(agentId, msg) {
    const n = nodes.get(agentId);
    if (!n || REDUCED.matches) return;
    n.avatars.forEach((avatar) => playOnce(avatar, 'is-hopping', 700));
    if (msg.emotion === 'happy' && !msg.yield) spawnSparks(n.avatars[0]);
  }

  // Al llegar una respuesta larga se muestra desde su primera línea; si es corta, queda al final.
  function revealStart(thread, node) {
    const top = node.getBoundingClientRect().top - thread.getBoundingClientRect().top + thread.scrollTop - 12;
    const max = thread.scrollHeight - thread.clientHeight;
    thread.scrollTo({ top: Math.max(0, Math.min(top, max)), behavior: 'smooth' });
  }

  const isNearBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  const scrollToEnd = (el, smooth) => el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });

  // Indicador de "pensando" o mensaje de error al final de la columna.
  function renderTail(agentId) {
    const n = nodes.get(agentId);
    const a = agentById(agentId);
    if (!n || !a) return;

    const id = key(state.templateId, agentId);
    const error = state.errors.get(id);
    const tailKey = state.pending.has(id) ? 'pending' : error && !state.queued.has(id) ? `error:${error.message}` : '';
    if (tailKey === n.tailKey) return;
    n.tailKey = tailKey;

    const stick = isNearBottom(n.thread);
    n.thread.querySelectorAll('.tail').forEach((el) => el.remove());

    if (tailKey === 'pending') {
      n.thread.append(h('div', { class: 'msg ai tail' },
        h('div', { class: 'typing', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
        h('span', { class: 'sr-only', text: `${a.name} está escribiendo` })));
    } else if (tailKey) {
      n.thread.append(h('div', { class: 'msg msg-error tail', role: 'alert' },
        h('p', { text: error.message }),
        h('button', { class: 'btn btn-ghost', type: 'button', text: 'Reintentar', onclick: () => requestReply(state.templateId, agentId) })));
    }
    if (tailKey && stick) scrollToEnd(n.thread, true);
  }

  function renderThread(agentId) {
    const n = nodes.get(agentId);
    const a = agentById(agentId);
    if (!n || !a) return;

    const messages = getChat(state.templateId, agentId);
    n.thread.replaceChildren();
    n.tailKey = '';
    if (messages.length === 0) n.thread.append(emptyNode(a));
    else messages.forEach((m) => n.thread.append(messageNode(m)));
    renderTail(agentId);
    scrollToEnd(n.thread, false);
  }

  function appendMessage(agentId, msg) {
    const n = nodes.get(agentId);
    if (!n) return;
    const stick = isNearBottom(n.thread) || msg.role === 'user';
    n.thread.querySelector('.empty')?.remove();
    n.thread.querySelectorAll('.tail').forEach((el) => el.remove());
    n.tailKey = '';
    const node = messageNode(msg);
    node.classList.add('is-new'); // solo los mensajes que llegan ahora; al recargar el historial no se animan
    n.thread.append(node);
    renderTail(agentId);
    if (msg.role === 'model') {
      typewrite(node.querySelector('.md'));
      reactToReply(agentId, msg);
    }
    if (!stick) return;
    if (msg.role === 'model') revealStart(n.thread, node);
    else scrollToEnd(n.thread, true);
  }

  function refreshUi() {
    if (!state.templateId) return;
    refreshColumns();
    agentsOf().forEach((a) => renderTail(a.id));
    updateComposer();
  }

  /* ───────────────────────────── Acciones ───────────────────────────── */

  function setActiveAgent(agentId) {
    state.activeAgentId = agentId;
    state.unread.delete(key(state.templateId, agentId));
    refreshColumns();
    const n = nodes.get(agentId);
    if (n) scrollToEnd(n.thread, false);
  }

  function setTemplate(templateId) {
    state.templateId = templateId;
    state.activeAgentId = agentsOf()[0]?.id ?? null;
    state.unread.clear();

    renderTemplateSelect();
    renderBoard();
    agentsOf().forEach((a) => renderThread(a.id));
    refreshUi();
    Store.write(KEY_UI, { template: templateId });
  }

  // Lo que dijeron los demás agentes (sus últimas respuestas) para que cada uno se coordine.
  function peersFor(t, agentId) {
    const perAgent = state.orchestration.peer_messages;
    const peers = [];
    for (const other of agentsOf(t)) {
      if (other.id === agentId) continue;
      getChat(t, other.id)
        .filter((m) => m.role === 'model' && !m.yield)
        .slice(-perAgent)
        .forEach((m) => peers.push({ agent: other.id, text: m.text.slice(0, 1500) }));
    }
    return peers;
  }

  // Pregunta al servidor si el usuario se dirigió a algún agente (@Backend, «Backend, ...»).
  async function resolveTargets(t, message) {
    try {
      const res = await Api.route({ template: t, message });
      return Array.isArray(res.targets) ? res.targets : [];
    } catch (err) {
      if (err.status === 401) logout('La contraseña ya no es válida. Vuelve a entrar.');
      return []; // si falla, la ronda sigue como turno abierto; el servidor vuelve a decidir por su cuenta
    }
  }

  // Un mensaje, todos los agentes. Turno abierto: uno tras otro (cada uno ve lo que dijeron los anteriores)
  // o en paralelo según ROOM_MODE. Turno dirigido: en paralelo, porque los demás solo ceden la palabra.
  async function sendMessage(text) {
    const t = state.templateId;
    text = text.trim();
    const attachment = state.attachment;
    if ((!text && !attachment) || state.processing || busyCount() > 0) return;

    const session = state.session;
    const agents = agentsOf(t);
    const ts = Date.now();

    // La imagen completa queda en memoria (para reintentos y seguimiento); en el historial solo va su referencia.
    let imageRef = null;
    if (attachment) {
      imageRef = { id: attachment.id, mime: attachment.mime, name: attachment.name };
      rememberImage(attachment.id, { mime: attachment.mime, data: attachment.data });
      Thumbs.save(attachment.id, attachment.thumb);
    }

    for (const a of agents) {
      const id = key(t, a.id);
      const messages = getChat(t, a.id);
      const msg = { role: 'user', text, ts, ...(imageRef ? { image: imageRef } : {}) };
      messages.push(msg);
      saveChat(t, a.id, messages);
      state.errors.delete(id);
      state.queued.add(id);
      appendMessage(a.id, msg);
    }
    inputEl.value = '';
    autosize();
    clearAttachment();
    refreshUi();

    const targets = text ? await resolveTargets(t, text) : [];
    if (state.session !== session) return;

    // Cada habitación puede fijar su modo (la Sala de Juicio es secuencial: el Juez ve a todos).
    const mode = templateById(t)?.mode || state.orchestration.mode;
    const ids = agents.map((a) => a.id);
    const parallel = mode === 'parallel' || targets.length > 0;

    if (parallel) {
      await Promise.all(ids.map((id) => requestReply(t, id)));
    } else {
      for (const id of ids) {
        if (state.session !== session) break;
        await requestReply(t, id);
      }
    }
  }

  // Envía el último mensaje del usuario de un agente (también sirve para "Reintentar").
  async function requestReply(t, a) {
    const id = key(t, a);
    state.queued.delete(id);
    if (state.pending.has(id)) return;

    const messages = getChat(t, a);
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'user') { refreshUi(); return; }

    const session = state.session;
    const epoch = state.epoch.get(id) ?? 0;
    const stale = () => state.session !== session || (state.epoch.get(id) ?? 0) !== epoch;

    // Imagen del mensaje nuevo (si aún está en memoria) o, si no trae, la última del historial para poder seguir hablando de ella.
    const ownImage = last.image ? state.images.get(last.image.id) : null;
    const past = messages.slice(0, -1).slice(-state.limits.max_history_messages);
    let pastImage = -1;
    if (!ownImage) {
      for (let i = past.length - 1; i >= 0; i--) {
        if (past[i].image && state.images.has(past[i].image.id)) { pastImage = i; break; }
      }
    }
    const history = past.map(({ role, text, image }, i) => {
      const item = { role, text };
      if (i === pastImage) {
        const cached = state.images.get(image.id);
        item.image = { mime_type: cached.mime, data: cached.data };
      }
      return item;
    });

    state.errors.delete(id);
    state.pending.add(id);
    refreshUi();

    try {
      const res = await Api.chat({
        template: t,
        agent: a,
        history,
        peers: peersFor(t, a),
        message: last.text,
        ...(ownImage ? { image: { mime_type: ownImage.mime, data: ownImage.data } } : {}),
      });
      if (stale()) return;

      const reply = { role: 'model', text: res.reply, ts: Date.now(), emotion: res.emotion || 'neutral' };
      if (res.yielded) reply.yield = true;
      messages.push(reply);
      saveChat(t, a, messages);

      if (state.templateId === t) {
        appendMessage(a, reply);
        if (TABS_MODE.matches && state.activeAgentId !== a) state.unread.set(id, (state.unread.get(id) || 0) + 1);
      }
    } catch (err) {
      if (stale()) return;
      if (err.status === 401) {
        logout('La contraseña ya no es válida. Vuelve a entrar.');
        return;
      }
      state.errors.set(id, { message: err.message || 'No se pudo obtener la respuesta.' });
    } finally {
      if (!stale()) state.pending.delete(id);
      refreshUi();
    }
  }

  async function clearAgents(agents) {
    const t = state.templateId;
    const many = agents.length > 1;
    const ok = await confirmDialog(
      many ? '¿Limpiar el historial de todos los agentes?' : `¿Limpiar el historial de ${agents[0].name}?`,
      'Se borran las conversaciones guardadas en este navegador. No se puede deshacer.',
      'Limpiar historial'
    );
    if (!ok) return;

    for (const a of agents) {
      const id = key(t, a.id);
      getChat(t, a.id).length = 0;
      Store.remove(keyChat(t, a.id));
      state.errors.delete(id);
      state.pending.delete(id);
      state.queued.delete(id);
      state.unread.delete(id);
      state.epoch.set(id, (state.epoch.get(id) ?? 0) + 1);
      renderThread(a.id);
    }
    refreshUi();
    inputEl.focus();
  }

  function exportChats() {
    const stamp = (ts) => new Date(ts).toLocaleString('es');
    const lines = [`# ${template().name}`, '', `Exportado el ${stamp(Date.now())}`, ''];
    let total = 0;

    for (const a of agentsOf()) {
      const messages = getChat(state.templateId, a.id);
      if (!messages.length) continue;
      total += messages.length;
      lines.push(`## ${a.name}`, '');
      for (const m of messages) {
        lines.push(`### ${m.role === 'user' ? 'Tú' : a.name} (${stamp(m.ts || Date.now())})`, '');
        if (m.image) lines.push(`_Imagen adjunta: ${m.image.name}_`, '');
        if (m.text) lines.push(m.text, '');
      }
    }
    if (!total) return;

    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' }));
    const link = h('a', { href: url, download: `team-room-${new Date().toISOString().slice(0, 10)}.md` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ───────────────────────────── Sesión ───────────────────────────── */

  function showLogin(message = '') {
    $('#app').hidden = true;
    $('#login').hidden = false;
    document.title = state.appName;
    const error = $('#login-error');
    error.textContent = message;
    error.hidden = !message;
    const pw = $('#login-password');
    pw.value = '';
    pw.focus();
  }

  function logout(message = '') {
    sessionStorage.removeItem(KEY_PW);
    state.session += 1;
    state.password = '';
    state.templateId = null;
    state.activeAgentId = null;
    state.chats.clear();
    state.queued.clear();
    state.pending.clear();
    state.errors.clear();
    state.unread.clear();
    state.images.clear();
    state.attachment = null;
    state.processing = false;
    renderAttachment();
    showAttachError('');
    nodes.clear();
    columnsEl.replaceChildren();
    tabsEl.replaceChildren();
    inputEl.value = '';
    showLogin(message);
  }

  function boot(data) {
    state.session += 1;
    state.appName = data.app_name || state.appName;
    state.limits = { ...DEFAULT_LIMITS, ...(data.limits || {}) };
    state.orchestration = { ...DEFAULT_ORCHESTRATION, ...(data.orchestration || {}) };
    state.imageCfg = { ...DEFAULT_IMAGES, ...(data.images || {}) };
    state.templates = Array.isArray(data.templates) ? data.templates : [];
    if (!state.templates.length) throw new Error('No hay habitaciones de agentes configuradas.');

    const ui = Store.read(KEY_UI, {});
    const exists = (id) => state.templates.some((t) => t.id === id);
    const templateId = exists(ui.template) ? ui.template : exists(data.default_template) ? data.default_template : state.templates[0].id;

    $('#login').hidden = true;
    $('#app').hidden = false;
    document.title = state.appName;
    $('#brand-name').textContent = state.appName;
    inputEl.maxLength = state.limits.max_message_chars;

    preloadAvatars();
    setTemplate(templateId);
    inputEl.focus({ preventScroll: true });
  }

  async function login(password) {
    const data = await Api.auth(password);
    state.password = password;
    sessionStorage.setItem(KEY_PW, password);
    boot(data);
  }

  /* ───────────────────────────── Eventos ───────────────────────────── */

  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = $('#login-password').value;
    if (!password) return;

    const submit = $('#login-submit');
    const error = $('#login-error');
    submit.disabled = true;
    submit.textContent = 'Entrando';
    error.hidden = true;

    try {
      await login(password);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      $('#login-password').select();
    } finally {
      submit.disabled = false;
      submit.textContent = 'Entrar';
    }
  });

  $('#composer').addEventListener('submit', (event) => {
    event.preventDefault();
    sendMessage(inputEl.value);
  });

  inputEl.addEventListener('input', () => { autosize(); updateComposer(); });
  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      if (!sendBtn.disabled) $('#composer').requestSubmit();
    }
  });

  // Botón "Copiar" de los bloques de código (delegado: el contenido se genera dinámicamente).
  columnsEl.addEventListener('click', async (event) => {
    const button = event.target.closest('.code-copy');
    if (!button) return;
    const code = button.closest('.code')?.querySelector('code')?.textContent ?? '';
    const ok = await copyText(code);
    button.textContent = ok ? 'Copiado' : 'No se pudo copiar';
    setTimeout(() => { button.textContent = 'Copiar'; }, 1600);
  });

  $('#template-select').addEventListener('change', (event) => setTemplate(event.target.value));

  // Adjuntar imagen: botón, pegar desde el portapapeles (capturas) y arrastrar y soltar.
  $('#attach-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    attachFile(firstImage(fileInput.files) || fileInput.files[0]);
    fileInput.value = ''; // permite volver a elegir el mismo archivo
  });
  $('#attachment-remove').addEventListener('click', () => { clearAttachment(); inputEl.focus(); });

  document.addEventListener('paste', (event) => {
    if ($('#app').hidden || $('#dialog').open) return;
    const file = firstImage(event.clipboardData?.files);
    if (!file) return; // si no hay imagen, el pegado de texto sigue normal
    event.preventDefault();
    attachFile(file);
    inputEl.focus();
  });

  const dropHint = $('#drop-hint');
  let dragDepth = 0;
  const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
  document.addEventListener('dragenter', (event) => {
    if ($('#app').hidden || !hasFiles(event)) return;
    dragDepth += 1;
    dropHint.hidden = false;
  });
  document.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropHint.hidden = true;
  });
  document.addEventListener('dragover', (event) => { if (hasFiles(event)) event.preventDefault(); });
  document.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    dropHint.hidden = true;
    if ($('#app').hidden) return;
    const file = firstImage(event.dataTransfer.files);
    if (file) attachFile(file);
    else showAttachError('Solo se pueden adjuntar imágenes.');
  });
  $('#theme-btn').addEventListener('click', Theme.toggle);
  $('#clear-all-btn').addEventListener('click', () => clearAgents(agentsOf()));
  $('#export-btn').addEventListener('click', exportChats);
  $('#logout-btn').addEventListener('click', () => logout());

  // Al pasar de pestañas a cuadrícula (o al revés) no dejes contadores obsoletos.
  TABS_MODE.addEventListener('change', () => { if (state.templateId) { state.unread.clear(); refreshColumns(); } });

  /* ───────────────────────────── Arranque ───────────────────────────── */

  Theme.apply(Theme.current());

  const savedPassword = sessionStorage.getItem(KEY_PW);
  if (savedPassword) {
    $('#login').hidden = true;
    login(savedPassword).catch(() => {
      sessionStorage.removeItem(KEY_PW);
      showLogin();
    });
  }
})();
