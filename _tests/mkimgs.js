const sharp = require('sharp');
(async () => {
  // Diagrama grande (3200x2000) con texto y flechas: debe reducirse a 1600 px
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="3200" height="2000" viewBox="0 0 3200 2000">
    <rect width="3200" height="2000" fill="#ffffff"/>
    <g font-family="DejaVu Sans, sans-serif" font-size="70" fill="#1f2937">
      <rect x="200" y="200" width="800" height="300" rx="30" fill="#dbeafe" stroke="#2563eb" stroke-width="8"/><text x="330" y="370">Navegador</text>
      <rect x="1200" y="200" width="800" height="300" rx="30" fill="#fae8ff" stroke="#a21caf" stroke-width="8"/><text x="1330" y="370">API PHP</text>
      <rect x="2200" y="200" width="800" height="300" rx="30" fill="#fef9c3" stroke="#ca8a04" stroke-width="8"/><text x="2330" y="370">Gemini</text>
      <rect x="1200" y="900" width="800" height="300" rx="30" fill="#dcfce7" stroke="#16a34a" stroke-width="8"/><text x="1330" y="1070">MySQL</text>
      <path d="M1000 350H1200M2000 350H2200M1600 500V900" stroke="#374151" stroke-width="10" fill="none"/>
      <text x="200" y="1700" font-size="90" fill="#dc2626">API_KEY=AIza-DEMO-NO-REAL</text>
    </g></svg>`;
  await sharp(Buffer.from(svg)).png().toFile('/tmp/imgs/diagrama-grande.png');
  // Pequeña (no debe tocarse)
  await sharp({ create: { width: 320, height: 200, channels: 3, background: { r: 30, g: 120, b: 220 } } }).png().toFile('/tmp/imgs/pequena.png');
  // Foto grande con ruido (4000x3000): recompresión a JPEG
  await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 120, g: 160, b: 200 }, noise: { type: 'gaussian', mean: 128, sigma: 50 } } }).jpeg({ quality: 92 }).toFile('/tmp/imgs/foto-grande.jpg');
  // PNG transparente (debe conservarse como PNG)
  await sharp({ create: { width: 600, height: 400, channels: 4, background: { r: 255, g: 0, b: 100, alpha: 0.4 } } }).png().toFile('/tmp/imgs/transparente.png');
  // BMP/GIF: formatos que el navegador abre pero Gemini no admite -> se convierten
  await sharp({ create: { width: 500, height: 300, channels: 3, background: { r: 10, g: 200, b: 90 } } }).gif().toFile('/tmp/imgs/formato.gif').catch((e) => console.log('gif no disponible:', e.message));
  require('fs').writeFileSync('/tmp/imgs/nota.txt', 'esto no es una imagen');
  const fs = require('fs');
  for (const f of fs.readdirSync('/tmp/imgs')) console.log(f, (fs.statSync('/tmp/imgs/' + f).size / 1024).toFixed(0) + ' KB');
})();
