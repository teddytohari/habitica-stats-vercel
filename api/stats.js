const { Resvg } = require('@resvg/resvg-js');
const fs = require('fs');
const path = require('path');

function findFont(filename) {
  const candidates = [
    path.join(__dirname, filename),
    path.join(process.cwd(), 'api', filename),
    path.join('/var/task/api', filename),
    path.join('/var/task', filename),
  ];

  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);

      return {
        path: filePath,
        size: stat.size,
      };
    }
  }

  throw new Error(
    `Font tidak ditemukan: ${filename}\n\n` +
    candidates.join('\n')
  );
}

module.exports = async (req, res) => {
  try {
    // ==========================================
    // 1. FIND FONT FILES
    // ==========================================

    const regular = findFont('Roboto-Regular.ttf');
    const bold = findFont('Roboto-Bold.ttf');

    console.log('Roboto Regular:', regular);
    console.log('Roboto Bold:', bold);

    // ==========================================
    // 2. SVG TEST
    // ==========================================

    const svg = `
<svg
  xmlns="http://www.w3.org/2000/svg"
  width="800"
  height="400"
  viewBox="0 0 800 400"
>
  <rect
    x="0"
    y="0"
    width="800"
    height="400"
    fill="#111827"
  />

  <text
    x="40"
    y="80"
    font-family="Roboto"
    font-size="42"
    font-weight="400"
    fill="#ffffff"
  >HELLO ROBOTO</text>

  <text
    x="40"
    y="145"
    font-family="Roboto"
    font-size="42"
    font-weight="700"
    fill="#ffffff"
  >HABITICA STATS</text>

  <text
    x="40"
    y="210"
    font-family="Roboto"
    font-size="28"
    font-weight="400"
    fill="#94a3b8"
  >Regular 400 + Bold 700</text>

  <text
    x="40"
    y="260"
    font-family="Roboto"
    font-size="28"
    font-weight="700"
    fill="#ffffff"
  >FONT RENDER TEST 1234567890</text>

  <text
    x="40"
    y="320"
    font-family="Roboto"
    font-size="24"
    font-weight="400"
    fill="#cbd5e1"
  >Vercel + Resvg + TTF</text>

  <text
    x="40"
    y="365"
    font-family="Roboto"
    font-size="20"
    font-weight="400"
    fill="#64748b"
  >PHASE A.1</text>
</svg>
`;

    // ==========================================
    // 3. RESVG
    // ==========================================

    const resvg = new Resvg(svg, {
      fitTo: {
        mode: 'original',
      },

      font: {
        fontFiles: [
          regular.path,
          bold.path,
        ],

        defaultFontFamily: 'Roboto',
        sansSerifFamily: 'Roboto',

        loadSystemFonts: false,
      },
    });

    // ==========================================
    // 4. RENDER
    // ==========================================

    const pngData = resvg.render();
    const pngBuffer = pngData.asPng();

    // ==========================================
    // 5. RESPONSE
    // ==========================================

    res.setHeader('Content-Type', 'image/png');

    res.setHeader(
      'Cache-Control',
      'no-store, no-cache, must-revalidate, proxy-revalidate'
    );

    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    res.setHeader(
      'X-Debug-Font-Regular-Path',
      regular.path
    );

    res.setHeader(
      'X-Debug-Font-Regular-Size',
      String(regular.size)
    );

    res.setHeader(
      'X-Debug-Font-Bold-Path',
      bold.path
    );

    res.setHeader(
      'X-Debug-Font-Bold-Size',
      String(bold.size)
    );

    res.setHeader(
      'X-Debug-Renderer',
      'resvg-fontFiles'
    );

    res.status(200).send(pngBuffer);

  } catch (error) {

    console.error('PHASE A.1 ERROR:', error);

    res.status(500).json({
      ok: false,
      phase: 'A.1',
      error: error.message,
      stack: error.stack,
    });
  }
};
