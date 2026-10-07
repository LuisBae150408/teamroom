const chromium = require('@sparticuz/chromium').default || require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'OK   ' : 'FALLA') + ' ' + name + (extra ? '  ' + extra : '')); if (!ok) fails++; };
const WHO = { Frontend: 'Frontend', Backend: 'Backend', UX: 'UX_UI', QA: 'QA_Seguridad' };
const readImg = (who) => { try { return JSON.parse(fs.readFileSync(`/tmp/fake/img_${who}.json`, 'utf8')); } catch { return null; } };
const clearImg = () => Object.values(WHO).forEach((w) => { try { fs.unlinkSync(`/tmp/fake/img_${w}.json`); } catch {} });

(async () => {
  const browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: [...chromium.args, '--no-sandbox'], headless: 'shell' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  const netBodies = [];
  await page.setRequestInterception(true);
  page.on('request', (req) => { if (req.url().endsWith('api.php') && req.method() === 'POST') { try { const b = JSON.parse(req.postData()); if (b.action === 'chat') netBodies.push(b); } catch {} } req.continue(); });

  await page.goto('http://127.0.0.1:9002/index.html', { waitUntil: 'networkidle2' });
  await page.type('#login-password', 'pw'); await page.click('#login-submit');
  await page.waitForSelector('#app:not([hidden])');
  const idle = () => page.waitForFunction(() => [...document.querySelectorAll('.column .status')].every((s) => s.dataset.status === 'idle'), { timeout: 60000 });
  const attach = async (path) => { const input = await page.$('#file-input'); await input.uploadFile(path); await page.waitForFunction(() => !document.querySelector('#attachment').hidden || !document.querySelector('#attach-error').hidden, { timeout: 15000 }); await page.waitForFunction(() => !/Preparando/.test(document.querySelector('#attachment-meta').textContent) || !document.querySelector('#attach-error').hidden, { timeout: 15000 }); };
  const chip = () => page.evaluate(() => ({ visible: !document.querySelector('#attachment').hidden, name: document.querySelector('#attachment-name').textContent, meta: document.querySelector('#attachment-meta').textContent, error: document.querySelector('#attach-error').hidden ? '' : document.querySelector('#attach-error').textContent, sendDisabled: document.querySelector('#send-btn').disabled, hint: document.querySelector('#hint').textContent }));
  const parseMeta = (m) => { const r = m.match(/(\d+) × (\d+) px, ([\d.]+) (KB|MB)/); return r ? { w: +r[1], h: +r[2], kb: r[4] === 'MB' ? +r[3] * 1024 : +r[3] } : null; };

  // ── 1) Botón de adjuntar y diagrama grande (3200x2000) → se reduce a 1600
  check('hay botón para adjuntar', !!(await page.$('#attach-btn')));
  await attach('/tmp/imgs/diagrama-grande.png');
  let c = await chip(); let m = parseMeta(c.meta);
  check('diagrama 3200x2000 se reduce a 1600x1000 y sigue siendo ligero', c.visible && m && m.w === 1600 && m.h === 1000 && m.kb < 800, c.meta);
  check('con imagen sola ya se puede enviar (sin texto)', c.sendDisabled === false);
  check('el aviso dice que la verán todos los agentes', c.hint.includes('La imagen la verán los 4 agentes'), c.hint);

  clearImg(); netBodies.length = 0;
  await page.type('#input', 'Analicen este diagrama'); await page.keyboard.press('Enter');
  await idle(); await sleep(300);
  const sent1 = netBodies.filter((b) => b.message === 'Analicen este diagrama');
  check('los 4 agentes reciben la imagen en su petición (mime + base64)', sent1.length === 4 && sent1.every((b) => b.image && b.image.mime_type === 'image/png' && b.image.data.length > 1000), sent1.map((b) => b.image?.mime_type + ':' + (b.image?.data.length / 1024 | 0) + 'KB').join(' '));
  check('el payload usa mime_type y data (base64 puro, sin prefijo data:)', sent1.every((b) => !b.image.data.startsWith('data:') && /^[A-Za-z0-9+/]+=*$/.test(b.image.data.slice(0, 400))));
  const seen = Object.entries(WHO).map(([k, w]) => [k, readImg(w)]);
  check('Gemini (simulado) recibe 1 imagen PNG por agente, ANTES del texto, en el último turno', seen.every(([, r]) => r && r.imgs.length === 1 && r.imgs[0].mime === 'image/png' && r.imgs[0].first_part && r.imgs[0].last_turn && r.imgs[0].bytes > 1000), JSON.stringify(seen.map(([k, r]) => r?.imgs.map((i) => i.bytes))));
  check('el prompt de sistema incluye el aviso de imagen adjunta', seen.every(([, r]) => r?.sys_has_image_note));
  const ui1 = await page.evaluate(() => ({ imgs: document.querySelectorAll('.msg.user .msg-image').length, chipHidden: document.querySelector('#attachment').hidden }));
  check('la burbuja del usuario muestra la miniatura en las 4 columnas y el chip se limpia', ui1.imgs === 4 && ui1.chipHidden);
  await page.screenshot({ path: '/tmp/jt/img-general-dark.png' });

  // ── 2) Seguimiento sin imagen: se reenvía la última imagen del historial
  clearImg(); netBodies.length = 0;
  await page.type('#input', 'y qué opinan del bloque MySQL?'); await page.keyboard.press('Enter');
  await idle(); await sleep(300);
  const sent2 = netBodies.filter((b) => b.message.startsWith('y qué opinan'));
  const histImgs = sent2.map((b) => b.history.filter((h) => h.image).length);
  check('seguimiento: cada agente recibe la imagen anterior dentro del historial (1)', sent2.length === 4 && histImgs.every((n) => n === 1) && sent2.every((b) => !b.image), histImgs.join(','));
  const seen2 = Object.values(WHO).map(readImg);
  check('Gemini ve la imagen en un turno anterior (no en el último) y sin aviso de "nueva imagen"', seen2.every((r) => r && r.imgs.length === 1 && !r.imgs[0].last_turn && !r.sys_has_image_note));

  // ── 3) Foto grande 4000x3000 (9 MB) → recompresión JPEG
  await attach('/tmp/imgs/foto-grande.jpg');
  c = await chip(); m = parseMeta(c.meta);
  check('foto de 9 MB (4000x3000) se reduce a 1600x1200 y baja de 4 MB', m && m.w === 1600 && m.h === 1200 && m.kb < 4096, c.meta);
  // ── 4) Sustituir por una pequeña: pasa sin tocarse; quitar con la ✕
  await attach('/tmp/imgs/pequena.png');
  c = await chip(); m = parseMeta(c.meta);
  check('imagen pequeña se conserva tal cual (320x200)', m && m.w === 320 && m.h === 200, c.meta);
  await page.click('#attachment-remove');
  c = await chip();
  check('la ✕ quita la imagen y deshabilita el envío', !c.visible && c.sendDisabled);

  // ── 5) Formatos: GIF se convierte, PNG transparente se conserva, texto se rechaza
  if (fs.existsSync('/tmp/imgs/formato.gif')) {
    await attach('/tmp/imgs/formato.gif');
    c = await chip();
    check('un GIF (no admitido por Gemini) se convierte y se puede enviar', c.visible && !c.error && c.meta.includes('500 × 300'), c.meta + ' ' + c.error);
    await page.click('#attachment-remove');
  }
  await attach('/tmp/imgs/nota.txt');
  c = await chip();
  check('un archivo que no es imagen se rechaza con mensaje claro', !c.visible && /no es una imagen/i.test(c.error), c.error);

  // ── 6) Imagen sin texto + mención: solo Backend recibe la imagen, los demás ceden sin verla
  await attach('/tmp/imgs/transparente.png');
  clearImg(); netBodies.length = 0;
  await page.type('#input', '@Backend mira esto'); await page.keyboard.press('Enter');
  await idle(); await sleep(300);
  const seen3 = Object.fromEntries(Object.entries(WHO).map(([k, w]) => [k, readImg(w)?.imgs.length]));
  check('con @Backend: Backend recibe la imagen; quien cede el turno no la recibe (ahorra tokens)', seen3.Backend === 1 && seen3.Frontend === 0 && seen3.UX === 0 && seen3.QA === 0, JSON.stringify(seen3));
  check('el PNG transparente sigue siendo PNG', netBodies.every((b) => b.image?.mime_type === 'image/png'));

  // ── 7) Solo imagen, sin texto
  await attach('/tmp/imgs/pequena.png');
  clearImg(); netBodies.length = 0;
  await page.keyboard.press('Enter'); // el foco sigue en el botón/entrada; enviamos por el formulario
  await page.evaluate(() => document.querySelector('#composer').requestSubmit());
  await idle(); await sleep(300);
  const sent4 = netBodies.filter((b) => b.message === '');
  const seen4 = Object.values(WHO).map(readImg);
  check('imagen sin texto: los 4 agentes la reciben y responden', sent4.length === 4 && seen4.every((r) => r?.imgs.length === 1));
  check('en pantalla la burbuja solo muestra la imagen', await page.evaluate(() => [...document.querySelectorAll('.msg.user')].pop().querySelector('.md') === null));

  // ── 8) Pegar una captura (Ctrl+V) y arrastrar y soltar
  await page.evaluate(async () => {
    const blob = await (await fetch('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FAAhKDveksOjmAAAAAElFTkSuQmCC')).blob();
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => !document.querySelector('#attachment').hidden && !/Preparando/.test(document.querySelector('#attachment-meta').textContent), { timeout: 10000 });
  c = await chip();
  check('pegar una captura del portapapeles la adjunta ("captura")', c.visible && c.name === 'captura' && c.meta.includes('10 × 10'), c.name + ' / ' + c.meta);
  await page.click('#attachment-remove');

  const dropRes = await page.evaluate(async () => {
    const blob = await (await fetch('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FAAhKDveksOjmAAAAAElFTkSuQmCC')).blob();
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'arrastrada.png', { type: 'image/png' }));
    document.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    const hintShown = !document.querySelector('#drop-hint').hidden;
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return { hintShown, hintAfter: !document.querySelector('#drop-hint').hidden };
  });
  await page.waitForFunction(() => !document.querySelector('#attachment').hidden && !/Preparando/.test(document.querySelector('#attachment-meta').textContent), { timeout: 10000 });
  c = await chip();
  check('arrastrar: aparece el aviso, se oculta al soltar y la imagen queda adjunta', dropRes.hintShown && !dropRes.hintAfter && c.name === 'arrastrada.png', JSON.stringify(dropRes) + ' ' + c.name);
  await page.click('#attachment-remove');

  // ── 9) Recargar: las miniaturas persisten; la imagen completa NO (no se reenvía)
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#app:not([hidden])');
  const afterReload = await page.evaluate(() => ({ thumbs: document.querySelectorAll('.msg.user .msg-image').length, stored: JSON.stringify(localStorage).length, chatHasData: Object.keys(localStorage).filter((k) => k.startsWith('sala:v1:chat:')).some((k) => localStorage.getItem(k).includes('"data"')) }));
  check('tras recargar siguen las miniaturas en el historial', afterReload.thumbs >= 8, 'miniaturas: ' + afterReload.thumbs);
  check('el historial guardado NO contiene base64 de imágenes completas', !afterReload.chatHasData, 'localStorage total ≈ ' + (afterReload.stored / 1024 | 0) + ' KB');
  clearImg(); netBodies.length = 0;
  await page.type('#input', 'sigamos hablando'); await page.keyboard.press('Enter');
  await idle(); await sleep(300);
  check('tras recargar no se reenvían imágenes antiguas (ya no están en memoria)', netBodies.filter((b) => b.message === 'sigamos hablando').every((b) => !b.image && b.history.every((h) => !h.image)));

  // ── 10) Sala de Juicio con imagen: la ven los 4 (Defensa, Acusación, Perito y Juez)
  await page.select('#template-select', 'juicio');
  await attach('/tmp/imgs/diagrama-grande.png');
  netBodies.length = 0;
  await page.type('#input', 'Juzguen esta arquitectura'); await page.keyboard.press('Enter');
  await idle(); await sleep(300);
  const j = netBodies.filter((b) => b.message === 'Juzguen esta arquitectura');
  check('Juicio: los 4 agentes (defensa, acusacion, perito, juez) reciben la imagen', j.length === 4 && j.every((b) => b.template === 'juicio' && b.image) && j.map((b) => b.agent).join(',') === 'defensa,acusacion,perito,juez', j.map((b) => b.agent).join(','));
  await page.screenshot({ path: '/tmp/jt/img-juicio-dark.png' });

  // tema claro con imagen
  await page.evaluate(() => document.querySelector('#theme-btn').click());
  await sleep(400);
  await page.screenshot({ path: '/tmp/jt/img-juicio-light.png' });
  const fit = await page.evaluate(() => ({ docH: document.documentElement.scrollHeight, innerH: innerHeight }));
  check('la pantalla sigue cabiendo completa', fit.docH === fit.innerH, JSON.stringify(fit));
  console.log(fails ? `\n${fails} FALLAS` : '\nTODO OK');
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message.slice(0, 500)); process.exit(2); });
