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
const clientCalls = [];
w.fetch = (url, opts) => { try { const b = JSON.parse(opts.body); if (b.action === 'chat') clientCalls.push({ agent: b.agent, msg: b.message, t: Date.now() }); } catch (e) {} return fetch('http://127.0.0.1:9002/' + url, opts); };   // backend PHP real
w.eval(appJs);

const $ = (s) => w.document.querySelector(s), $$ = (s) => [...w.document.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'OK   ' : 'FALLA') + ' ' + name + (extra ? '  ' + extra : '')); if (!ok) fails++; };
const send = async (text) => { const i = $('#input'); i.value = text; i.dispatchEvent(new w.Event('input')); $('#composer').dispatchEvent(new w.Event('submit', { cancelable: true })); };
const waitIdle = async (max = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < max) { await sleep(60); if (!$$('.status').some(s => s.dataset.status !== 'idle') && !$('#send-btn').disabled === false) {} if ($$('.status').every(s => s.dataset.status === 'idle')) return true; } return false; };
const log = () => fs.readFileSync('/tmp/fake/log.txt', 'utf8').trim().split('\n').filter(Boolean).map(l => { const m = l.match(/^(START|END) (.+) ([\d.]+)$/); return { k: m[1], who: m[2], t: +m[3] }; });
const colBy = (name) => $$('.column').find(c => c.querySelector('h2').textContent === name);
const replyText = (name) => [...colBy(name).querySelectorAll('.msg.ai:not(.tail) .md')].map(e => e.textContent);
const currentAvatar = (name) => colBy(name).querySelector('.avatar-img.is-current').getAttribute('src');

(async () => {
  fs.writeFileSync('/tmp/fake/log.txt', '');
  $('#login-password').value = 'pw';
  $('#login-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
  await sleep(300);

  // La habitación por defecto ahora es «General / Desarrollo»: este test cubre el equipo original.
  { const sel0 = $('#template-select'); sel0.value = 'dev-web'; sel0.dispatchEvent(new w.Event('change')); }

  // ── Layout 2x2 y tema por agente
  const order = $$('.column h2').map(h => h.textContent);
  check('cuadrícula: Base de datos, Frontend / Hosting, Backend (por filas)', JSON.stringify(order) === JSON.stringify(['Base de datos', 'Frontend', 'Hosting & DevOps', 'Backend']), JSON.stringify(order));
  const acc = Object.fromEntries($$('.column').map(c => [c.querySelector('h2').textContent, c.dataset.accent]));
  check('colores: frontend azul, backend magenta, bdd amarillo, hosting verde', acc['Frontend'] === 'blue' && acc['Backend'] === 'magenta' && acc['Base de datos'] === 'yellow' && acc['Hosting & DevOps'] === 'green', JSON.stringify(acc));
  check('avatar <img> con contenedor genérico y capa doble', $$('.column .agent-avatar__media > .avatar-stage > img.avatar-img').length === 8);
  check('avatar neutral inicial correcto', currentAvatar('Frontend').endsWith('avatar/frontend/FEneutral.svg') && currentAvatar('Hosting & DevOps').endsWith('avatar/hosting/HOneutral.svg'));
  const side = Object.fromEntries($$('.column').map(c => [c.querySelector('h2').textContent, c.dataset.side]));
  check('lados: izquierda = Base de datos y Hosting; derecha = Frontend y Backend', side['Base de datos'] === 'left' && side['Hosting & DevOps'] === 'left' && side['Frontend'] === 'right' && side['Backend'] === 'right', JSON.stringify(side));
  check('avatares con insignia inicial', $$('.column .agent-avatar__badge').length === 4);
  check('pestañas en orden de agentes', $$('.tab-name').map(t => t.textContent).join('|') === 'Frontend|Backend|Base de datos|Hosting & DevOps');
  check('hint explica @Nombre', $('#hint').textContent.includes('@Frontend'));

  // ── Turno abierto: secuencial + contexto cruzado + emoción
  await send('Hola equipo');
  await sleep(120);
  check('en cola: los que esperan muestran "En espera"', $$('.status').filter(s => s.dataset.status === 'queued').length >= 2);
  const badge = (n) => colBy(n).querySelector('.agent-avatar__badge')?.dataset.kind;
  check('insignias: pensando (Frontend) / en cola (resto)', badge('Frontend') === 'thinking' && badge('Backend') === 'queued' && badge('Hosting & DevOps') === 'queued', [badge('Frontend'), badge('Backend')].join(','));
  check('avatar del que consulta = thinking', currentAvatar('Frontend').endsWith('FEthinking.svg'), currentAvatar('Frontend'));
  await waitIdle(10000);
  const ev = log();
  const startOrder = ev.filter(e => e.k === 'START').map(e => e.who);
  check('orden secuencial Frontend, Backend, Base de datos, Hosting', startOrder.join('|') === 'Frontend|Backend|Base de datos|Hosting & DevOps', startOrder.join('|'));
  const overlap = ev.some((e, i) => e.k === 'START' && ev.slice(0, i).filter(x => x.k === 'START').length - ev.slice(0, i).filter(x => x.k === 'END').length > 0);
  check('sin solapamiento (una llamada tras otra)', !overlap);
  const seen = (n) => (replyText(n)[0].match(/vio: (.*?) ?\| brevedad/) || [, '?'])[1].trim();
  check('Frontend no ve a nadie', seen('Frontend') === '', JSON.stringify(seen('Frontend')));
  check('Backend ve a Frontend', seen('Backend') === 'Frontend', seen('Backend'));
  check('Base de datos ve a Frontend y Backend', seen('Base de datos') === 'Frontend|Backend', seen('Base de datos'));
  check('Hosting ve a los tres', seen('Hosting & DevOps') === 'Frontend|Backend|Base de datos', seen('Hosting & DevOps'));
  check('turno abierto: modo "abierto" y brevedad ~75 palabras en el prompt', replyText('Backend')[0].includes('(abierto)') && replyText('Backend')[0].includes('brevedad75=si'));
  check('insignia en reposo tras responder feliz = happy', ['Frontend','Backend','Base de datos','Hosting & DevOps'].every(n => badge(n) === 'happy'), ['Frontend','Backend','Base de datos','Hosting & DevOps'].map(badge).join(','));
  check('etiqueta [[emocion]] no se muestra', !$$('.md').some(m => m.textContent.includes('[[emocion')));
  check('avatar pasa a happy con la emoción devuelta', currentAvatar('Frontend').endsWith('FEhappy.svg') && currentAvatar('Base de datos').endsWith('DBhappy.svg'));
  check('composer libre otra vez', (() => { const i = $('#input'); i.value = 'x'; i.dispatchEvent(new w.Event('input')); return !$('#send-btn').disabled; })());
  $('#input').value = ''; $('#input').dispatchEvent(new w.Event('input'));

  // ── Emoción "shocked" -> shock (Frontend usa FEshocked.svg)
  fs.writeFileSync('/tmp/fake/log.txt', '');
  await send('Hola, sorpresa');
  await waitIdle(10000);
  check('shocked -> FEshocked.svg (nombre irregular del archivo)', currentAvatar('Frontend').endsWith('FEshocked.svg'), currentAvatar('Frontend'));
  check('shock en Hosting -> HOshock.svg', currentAvatar('Hosting & DevOps').endsWith('HOshock.svg'), currentAvatar('Hosting & DevOps'));

  // ── Turno dirigido: en paralelo; solo Backend responde, los otros ceden
  fs.writeFileSync('/tmp/fake/log.txt', '');
  await send('Backend, dime hola');
  await waitIdle(10000);
  const ev2 = log();
  const starts = ev2.filter(e => e.k === 'START'), ends = ev2.filter(e => e.k === 'END');
  const dirCalls = clientCalls.filter(c => c.msg === 'Backend, dime hola');
  check('dirigido: el cliente lanza las 4 consultas a la vez (paralelo)', dirCalls.length === 4 && Math.max(...dirCalls.map(c => c.t)) - Math.min(...dirCalls.map(c => c.t)) < 60, dirCalls.length + ' consultas, dispersión ' + (Math.max(...dirCalls.map(c => c.t)) - Math.min(...dirCalls.map(c => c.t))) + 'ms');
  const openCalls = clientCalls.filter(c => c.msg === 'Hola equipo');
  check('abierto: el cliente las lanza una tras otra (secuencial)', openCalls.length === 4 && openCalls.every((c, i) => i === 0 || c.t - openCalls[i - 1].t >= 180), openCalls.map((c, i) => i ? c.t - openCalls[i - 1].t : 0).join(','));
  const last = (n) => [...colBy(n).querySelectorAll('.msg.ai:not(.tail)')].pop();
  check('Backend responde a la solicitud', last('Backend').textContent.includes('(dirigido)') && !last('Backend').classList.contains('is-yield'));
  check('Frontend, Base de datos y Hosting ceden el turno', ['Frontend', 'Base de datos', 'Hosting & DevOps'].every(n => last(n).classList.contains('is-yield') && last(n).textContent.includes('Backend')));
  check('insignias tras turno dirigido: pasó la palabra x3, Backend contento', badge('Frontend') === 'pass' && badge('Base de datos') === 'pass' && badge('Hosting & DevOps') === 'pass' && badge('Backend') === 'happy', ['Frontend','Backend','Base de datos','Hosting & DevOps'].map(badge).join(','));
  check('quien cede el turno queda en neutral', currentAvatar('Frontend').endsWith('FEneutral.svg') && currentAvatar('Base de datos').endsWith('DBneutral.svg'));

  // ── Los "cedo el turno" no contaminan el contexto de la siguiente ronda
  fs.writeFileSync('/tmp/fake/log.txt', '');
  await send('Vamos de nuevo, equipo');
  await waitIdle(10000);
  const sys = fs.readFileSync('/tmp/fake/last_Frontend.txt', 'utf8');
  const ctx = sys.split('CONTEXTO DE LA SALA')[1] || '';
  const perPeer = (n) => (ctx.match(new RegExp('^- ' + n.replace(/[&]/g, '\\$&') + ' \\(', 'gm')) || []).length;
  check('contexto cruzado NO incluye las frases de cesión', ctx.length > 0 && !ctx.includes('Dejo esta solicitud en manos') && !ctx.includes('Paso la palabra'));
  check('contexto cruzado: máximo 2 respuestas por agente y ninguna del propio Frontend', perPeer('Backend') === 2 && perPeer('Base de datos') <= 2 && perPeer('Hosting & DevOps') <= 2 && perPeer('Frontend') === 0, [perPeer('Backend'), perPeer('Base de datos'), perPeer('Hosting & DevOps'), perPeer('Frontend')].join(','));

  // ── Menciones con @ y con varios agentes
  fs.writeFileSync('/tmp/fake/log.txt', '');
  await send('@Frontend @bdd coordinen esto');
  await waitIdle(10000);
  const modes = Object.fromEntries(['Frontend', 'Backend', 'Base de datos', 'Hosting & DevOps'].map(n => [n, last(n).classList.contains('is-yield') ? 'cede' : 'responde']));
  check('@Frontend @bdd: responden ambos, ceden Backend y Hosting', modes['Frontend'] === 'responde' && modes['Base de datos'] === 'responde' && modes['Backend'] === 'cede' && modes['Hosting & DevOps'] === 'cede', JSON.stringify(modes));
  check('la cesión nombra a los dos destinatarios', /manos de (Frontend y Base de datos|Base de datos y Frontend)\./.test(last('Backend').textContent), last('Backend').textContent.trim());

  // ── Persistencia con emoción y flag de cesión
  const stored = JSON.parse(w.localStorage.getItem('sala:v1:chat:dev-web:backend'));
  check('localStorage guarda emoción y cesión', stored.some(m => m.emotion === 'happy') && stored.some(m => m.yield === true));

  // ── Tema claro / oscuro
  check('arranca en modo oscuro', !w.document.documentElement.classList.contains('light-theme'));
  $('#theme-btn').click();
  check('botón activa .light-theme y lo recuerda', w.document.documentElement.classList.contains('light-theme') && w.localStorage.getItem('sala:v1:theme') === 'light' && $('#theme-label').textContent === 'Modo oscuro');
  check('theme-color del navegador cambia al claro', $('#theme-color').getAttribute('content') === '#f8f7f4');
  $('#theme-btn').click();
  check('vuelve a oscuro', !w.document.documentElement.classList.contains('light-theme') && $('#theme-label').textContent === 'Modo claro');

  // ── Limpiar y salir
  $$('.column-head .icon-btn')[0].click();
  $('#dialog').returnValue = 'ok'; $('#dialog').dispatchEvent(new w.Event('close'));
  await sleep(30);
  check('limpiar una columna (Base de datos) la deja vacía y con avatar neutral', colBy('Base de datos').querySelectorAll('.msg').length === 0 && currentAvatar('Base de datos').endsWith('DBneutral.svg') && colBy('Backend').querySelectorAll('.msg').length > 0);
  $('#logout-btn').click();
  check('cerrar sesión', $('#app').hidden && !$('#login').hidden);
  console.log(fails ? `\n${fails} FALLAS` : '\nTODO OK');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
