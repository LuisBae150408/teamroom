const chromium = require('@sparticuz/chromium').default || require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const [out, W, H, theme, mid] = [process.argv[2], +process.argv[3], +process.argv[4], process.argv[5], process.argv[6] === 'mid'];
(async () => {
  const browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: [...chromium.args, '--no-sandbox'], headless: 'shell' });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  await page.evaluateOnNewDocument((t) => { try { localStorage.setItem('sala:v1:theme', t); } catch (e) {} }, theme);
  await page.goto('http://127.0.0.1:9002/index.html', { waitUntil: 'networkidle2' });
  await page.type('#login-password', 'pw'); await page.click('#login-submit');
  await page.waitForSelector('#app:not([hidden])');
  const idle = () => page.waitForFunction(() => [...document.querySelectorAll('.column .status')].every(s => s.dataset.status === 'idle'), { timeout: 60000 });
  await page.type('#input', 'Holaaaa muchachos, cómo están??'); await page.keyboard.press('Enter'); await idle();
  await page.type('#input', '@backend estás listo?'); await page.keyboard.press('Enter'); await idle();
  if (mid) { await page.type('#input', 'Vamos con el proyecto'); await page.keyboard.press('Enter'); await new Promise(r => setTimeout(r, 420)); }
  else await new Promise(r => setTimeout(r, 600));
  if (H < 500) {}
  const m = await page.evaluate(() => ({ innerH: innerHeight, docH: document.documentElement.scrollHeight, docW: document.documentElement.scrollWidth, innerW: innerWidth, composerBottom: Math.round(document.querySelector('.composer').getBoundingClientRect().bottom) }));
  console.log(out, JSON.stringify(m));
  await page.screenshot({ path: `/tmp/jt/${out}.png` });
  await browser.close();
})().catch(e => { console.error('ERR', e.message.slice(0, 400)); process.exit(1); });
