const { JSDOM } = require('jsdom');
const fs = require('fs');
const dir = '/mnt/user-data/outputs/sala-agentes/';
const html = fs.readFileSync(dir + 'index.html', 'utf8').replace(/<script[^>]*src="app.js"[^>]*><\/script>/, '');
const appJs = fs.readFileSync(dir + 'app.js', 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });
const w = dom.window;
w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
w.Element.prototype.scrollTo = function () {};
w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
const calls = [];
w.fetch = (url, opts) => { try { const b = JSON.parse(opts.body); if (b.action === 'chat') calls.push({ t: b.template, agent: b.agent, msg: b.message, at: Date.now() }); } catch (e) {} return fetch('http://127.0.0.1:9002/' + url, opts); };
w.eval(appJs);
const $ = (s) => w.document.querySelector(s), $$ = (s) => [...w.document.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'OK   ' : 'FALLA') + ' ' + name + (extra ? '  ' + extra : '')); if (!ok) fails++; };
const send = (text) => { const i = $('#input'); i.value = text; i.dispatchEvent(new w.Event('input')); $('#composer').dispatchEvent(new w.Event('submit', { cancelable: true })); };
const idle = async (max = 12000) => { const t0 = Date.now(); while (Date.now() - t0 < max) { await sleep(80); if ($$('.status').every((s) => s.dataset.status === 'idle')) return true; } return false; };
const colBy = (name) => $$('.column').find((c) => c.querySelector('h2').textContent === name);
const lastAi = (name) => [...colBy(name).querySelectorAll('.msg.ai:not(.tail)')].pop();
const log = () => fs.readFileSync('/tmp/fake/log.txt', 'utf8').trim().split('\n').filter(Boolean).map((l) => { const m = l.match(/^(START|END) (.+) ([\d.]+)$/); return { k: m[1], who: m[2], t: +m[3] }; });

(async () => {
  fs.writeFileSync('/tmp/fake/log.txt', '');
  $('#login-password').value = 'pw';
  $('#login-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
  await sleep(400);

  // ── Selector de habitaciones
  const options = $$('#template-select option').map((o) => o.value + ':' + o.textContent);
  check('selector con 3 habitaciones en orden', options.join('|') === 'general:General / Desarrollo|juicio:Sala de Juicio|dev-web:Desarrollo web (equipo original)', options.join('|'));
  check('la habitación por defecto es General / Desarrollo', $('#template-select').value === 'general');
  check('el selector tiene etiqueta accesible "Habitación actual"', $('#template-select').getAttribute('aria-label') === 'Habitación actual');

  // ── Habitación General: 4 agentes, roles y cuadrícula sin nada fijo
  const names = $$('.column h2').map((h) => h.textContent);
  const roles = Object.fromEntries($$('.column').map((c) => [c.querySelector('h2').textContent, c.querySelector('.column-title p').textContent]));
  check('General: orden de cuadrícula UX/UI, Frontend / QA, Backend', names.join('|') === 'UX / UI|Frontend|QA & Seguridad|Backend', names.join('|'));
  check('General: roles visuales correctos', roles['Frontend'] === 'Frontend Specialist' && roles['Backend'] === 'Backend Specialist' && roles['UX / UI'] === 'UX / UI Designer' && roles['QA & Seguridad'] === 'QA & Security Auditor', JSON.stringify(roles));
  const side = Object.fromEntries($$('.column').map((c) => [c.querySelector('h2').textContent, c.dataset.side]));
  check('General: Frontend y Backend a la derecha', side['Frontend'] === 'right' && side['Backend'] === 'right' && side['UX / UI'] === 'left' && side['QA & Seguridad'] === 'left');
  check('General: avatares con imagen y colores por asiento', $$('.column').every((c) => c.querySelector('.avatar-img.is-current')) && new Set($$('.column').map((c) => c.dataset.accent)).size === 4);

  // ── Ronda abierta en General: secuencial, cada agente recibe SU prompt
  send('Hola equipo');
  await sleep(150);
  await idle();
  const order1 = log().filter((e) => e.k === 'START').map((e) => e.who);
  check('General: orden de intervención Frontend, Backend, UX / UI, QA', order1.join('|') === 'Frontend|Backend|UX / UI|QA & Seguridad', order1.join('|'));
  const sysQa = fs.readFileSync('/tmp/fake/last_QA_Seguridad.txt', 'utf8');
  check('prompt del QA: rol de auditor, personalidad y reglas comunes', sysQa.includes('QA & Security Auditor') && sysQa.includes('paranoico') && sysQa.includes('REGLA DE ORO') && sysQa.includes('75 palabras') && sysQa.includes('IMÁGENES'));
  check('el QA ve a los otros tres en el contexto de la sala', ['Frontend', 'Backend', 'UX / UI'].every((n) => sysQa.split('CONTEXTO DE LA SALA')[1]?.includes('- ' + n + ' (')));
  check('el prompt no contiene marcadores sin resolver', !/\{\{.*?\}\}/.test(sysQa));

  // ── Cambio a la Sala de Juicio
  const sel = $('#template-select'); sel.value = 'juicio'; sel.dispatchEvent(new w.Event('change'));
  const jn = $$('.column h2').map((h) => h.textContent);
  const jr = Object.fromEntries($$('.column').map((c) => [c.querySelector('h2').textContent, c.querySelector('.column-title p').textContent]));
  check('Juicio: cuadrícula Defensa | Acusación / Perito | Juez', jn.join('|') === 'La Defensa|La Acusación|El Perito|El Juez', jn.join('|'));
  check('Juicio: roles visuales', jr['La Defensa'].startsWith('Argumenta a favor') && jr['La Acusación'].startsWith('Abogado del Diablo') && jr['El Perito'].startsWith('Investigador') && jr['El Juez'].startsWith('Evaluador final'), JSON.stringify(jr));
  check('Juicio: Defensa y Acusación enfrentadas (izquierda / derecha)', colBy('La Defensa').dataset.side === 'left' && colBy('La Acusación').dataset.side === 'right' && colBy('El Juez').dataset.side === 'right');
  check('Juicio: empieza vacío (otro historial)', $$('.msg').length === 0 && $$('.empty').length === 4);
  check('el saludo de cada agente es el suyo', colBy('El Juez').querySelector('.empty p').textContent.includes('tribunal') && colBy('La Acusación').querySelector('.empty p').textContent.includes('Ya estoy buscando'));

  fs.writeFileSync('/tmp/fake/log.txt', '');
  send('Quiero dejar mi empleo para hacer freelance');
  await sleep(150);
  await idle();
  const order2 = log().filter((e) => e.k === 'START').map((e) => e.who);
  check('Juicio: habla Defensa, Acusación, Perito y al final el Juez', order2.join('|') === 'La Defensa|La Acusación|El Perito|El Juez', order2.join('|'));
  const sysJuez = fs.readFileSync('/tmp/fake/last_El_Juez.txt', 'utf8');
  const ctx = sysJuez.split('CONTEXTO DE LA SALA')[1] || '';
  check('el Juez recibe su prompt (veredicto) y ve a Defensa, Acusación y Perito', sysJuez.includes('VEREDICTO') && ['La Defensa', 'La Acusación', 'El Perito'].every((n) => ctx.includes('- ' + n + ' (')));
  check('el prompt del Juez menciona la sala de juicio, no la de desarrollo', sysJuez.includes('Sala de Juicio') && !sysJuez.includes('dos programadores'));
  const sysPerito = fs.readFileSync('/tmp/fake/last_El_Perito.txt', 'utf8');
  check('el Perito tiene la regla de no inventar fuentes', sysPerito.includes('nunca inventes cifras') && sysPerito.includes('No tienes acceso a internet'));

  // ── Mención dentro de la Sala de Juicio
  fs.writeFileSync('/tmp/fake/log.txt', '');
  send('@Juez ¿qué opina el tribunal?');
  await sleep(150);
  await idle();
  const y = (n) => lastAi(n).classList.contains('is-yield');
  check('@Juez: el Juez responde y los otros tres ceden el turno', !y('El Juez') && y('La Defensa') && y('La Acusación') && y('El Perito'));
  check('cesión de turno nombra al Juez', /manos de El Juez|palabra al equipo de El Juez/.test(lastAi('La Defensa').textContent), lastAi('La Defensa').textContent.trim());
  const c3 = calls.filter((c) => c.msg === '@Juez ¿qué opina el tribunal?');
  check('mención = 4 consultas en paralelo', c3.length === 4 && Math.max(...c3.map((c) => c.at)) - Math.min(...c3.map((c) => c.at)) < 80);
  const c2 = calls.filter((c) => c.msg === 'Quiero dejar mi empleo para hacer freelance');
  check('ronda abierta de Juicio = secuencial (una tras otra)', c2.length === 4 && c2.every((c, i) => i === 0 || c.at - c2[i - 1].at >= 180), c2.map((c, i) => (i ? c.at - c2[i - 1].at : 0)).join(','));

  // ── Los historiales son independientes por habitación
  sel.value = 'general'; sel.dispatchEvent(new w.Event('change'));
  check('volver a General conserva su conversación', $$('.msg.user').length === 4 && colBy('Backend').querySelectorAll('.msg.user').length === 1);
  sel.value = 'dev-web'; sel.dispatchEvent(new w.Event('change'));
  check('equipo original disponible (Base de datos y Hosting)', $$('.column h2').map((h) => h.textContent).join('|') === 'Base de datos|Frontend|Hosting & DevOps|Backend');
  const stored = Object.keys(w.localStorage).filter((k) => k.startsWith('sala:v1:chat:')).map((k) => k.split(':').slice(3, 5).join('/')).sort();
  check('localStorage separa las habitaciones', stored.includes('general/qa') && stored.includes('juicio/juez') && !stored.some((k) => k.startsWith('dev-web/')), stored.join(' '));
  check('la habitación elegida se recuerda', JSON.parse(w.localStorage.getItem('sala:v2:ui')).template === 'dev-web');
  console.log(fails ? `\n${fails} FALLAS` : '\nTODO OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
