const http = require('http');
const https = require('https');
const zlib = require('zlib');
const url = require('url');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 4000;

function fetchUrl(targetUrl, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(targetUrl);
    const options = {
      hostname: parsed.hostname,
      path: parsed.path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 11; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'application/json, text/html, */*',
        'Accept-Language': 'en-NG,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache',
        ...extraHeaders
      }
    };

    const req = https.request(options, res => {
      // Follow redirects (301, 302, 303, 307, 308)
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://${parsed.hostname}${res.headers.location}`;
        console.log(`[redirect] ${res.statusCode} → ${redirectUrl}`);
        return fetchUrl(redirectUrl, extraHeaders).then(resolve).catch(reject);
      }

      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const encoding = res.headers['content-encoding'] || '';

        const decompress = (buf, cb) => {
          if (encoding.includes('br')) {
            zlib.brotliDecompress(buf, cb);
          } else if (encoding.includes('gzip')) {
            zlib.gunzip(buf, cb);
          } else if (encoding.includes('deflate')) {
            zlib.inflate(buf, cb);
          } else {
            cb(null, buf);
          }
        };

        decompress(buf, (err, decompressed) => {
          if (err) {
            // If decompression fails try raw
            resolve({ status: res.statusCode, body: buf.toString('utf8'), headers: res.headers });
          } else {
            resolve({ status: res.statusCode, body: decompressed.toString('utf8'), headers: res.headers });
          }
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout after 15s')); });
    req.end();
  });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function convertToBetPawa(market, pick) {
  const p = (pick || '').toLowerCase().trim();
  const m = (market || '').toLowerCase();
  if (['1','home','home win','1 (home)'].includes(p)) return '1';
  if (['x','draw','x (draw)'].includes(p)) return 'X';
  if (['2','away','away win','2 (away)'].includes(p)) return '2';
  if (['1x','home or draw','home/draw'].includes(p)) return 'DC 1X';
  if (['x2','draw or away','draw/away'].includes(p)) return 'DC X2';
  if (['12','home or away','home/away'].includes(p)) return 'DC 12';
  if (p.includes('gg') || p === 'yes' || p.includes('both teams')) return 'GG';
  if (p.includes('ng') || p === 'no' || p.includes('no goal')) return 'NG';
  const ov = p.match(/over\s*([\d.]+)/) || m.match(/over\s*([\d.]+)/);
  if (ov) return 'Over ' + ov[1];
  const un = p.match(/under\s*([\d.]+)/) || m.match(/under\s*([\d.]+)/);
  if (un) return 'Under ' + un[1];
  if (m.includes('half') || m.includes('ht')) {
    if (p === '1' || p.includes('home')) return 'HT 1';
    if (p === 'x' || p.includes('draw')) return 'HT X';
    if (p === '2' || p.includes('away')) return 'HT 2';
  }
  const ah = (p + m).match(/([+-][\d.]+)/);
  if (m.includes('handicap') && ah) return 'AH ' + ah[1];
  return pick;
}

function mapEvents(events) {
  return events.map(e => ({
    match: `${e.homeTeamName || e.homeName || e.home || ''} vs ${e.awayTeamName || e.awayName || e.away || e.eventName || ''}`.replace(/\s+/g, ' ').trim(),
    pick: e.outcomeName || e.outcome || e.pickName || e.selection || '',
    betpawaPick: convertToBetPawa(e.marketName || e.betTypeName || e.marketType || '', e.outcomeName || e.outcome || e.pickName || ''),
    odds: parseFloat(e.odds || e.price || e.outcomeOdds || 1),
    startTime: e.gameTime || e.startTime || e.matchTime || ''
  }));
}

async function scrapeSportyBet(code) {
  // Priority order based on debug results — booking endpoint returns 200 + gzip
  const endpoints = [
    {
      label: 'booking-api',
      url: `https://www.sportybet.com/api/ng/orders/booking?bookingCode=${code}`,
      headers: { 'Referer': 'https://www.sportybet.com/ng/', 'Origin': 'https://www.sportybet.com' }
    },
    {
      label: 'share-api',
      url: `https://www.sportybet.com/api/ng/orders/share?bookingCode=${code}`,
      headers: { 'Referer': 'https://www.sportybet.com/ng/', 'Origin': 'https://www.sportybet.com' }
    },
    {
      label: 'timor-api',
      url: `https://www.sportybet.com/api/ng/orders/timor/booking?bookingCode=${code}`,
      headers: { 'Referer': 'https://www.sportybet.com/ng/' }
    }
  ];

  for (const ep of endpoints) {
    try {
      console.log(`[SportyBet:${ep.label}] GET ${ep.url}`);
      const r = await fetchUrl(ep.url, ep.headers);
      console.log(`[SportyBet:${ep.label}] status=${r.status} body=${r.body.slice(0, 400)}`);

      if (r.status !== 200) continue;

      let d;
      try { d = JSON.parse(r.body); } catch(e) {
        console.log(`[SportyBet:${ep.label}] not JSON — trying HTML parse`);
        // HTML fallback
        const tryP = s => { try { return JSON.parse(s); } catch(e) { return null; } };
        for (const pat of [/"sportEvents"\s*:\s*(\[[\s\S]*?\])\s*[,}]/, /"betItems"\s*:\s*(\[[\s\S]*?\])\s*[,}]/]) {
          const m = r.body.match(pat);
          if (m) {
            const items = tryP(m[1]);
            if (Array.isArray(items) && items.length > 0) {
              console.log(`[SportyBet:${ep.label}] ✓ HTML parse — ${items.length} events`);
              return { selections: mapEvents(items), totalOdds: 0 };
            }
          }
        }
        continue;
      }

      console.log(`[SportyBet:${ep.label}] JSON keys: ${JSON.stringify(Object.keys(d))}`);

      const events =
        d?.data?.sportEvents ||
        d?.data?.betItems ||
        d?.data?.events ||
        d?.data?.selections ||
        d?.sportEvents ||
        d?.betItems ||
        d?.result?.sportEvents ||
        d?.result?.betItems ||
        d?.result?.events ||
        [];

      if (events.length > 0) {
        const totalOdds = parseFloat(
          d?.data?.totalOdds || d?.data?.odds ||
          d?.totalOdds || d?.result?.totalOdds || 0
        );
        console.log(`[SportyBet:${ep.label}] ✓ ${events.length} events, totalOdds=${totalOdds}`);
        return { selections: mapEvents(events), totalOdds };
      }

      // Log full data structure to help debug
      console.log(`[SportyBet:${ep.label}] no events found. data=${JSON.stringify(d).slice(0, 600)}`);

    } catch(e) {
      console.log(`[SportyBet:${ep.label}] error: ${e.message}`);
    }
  }

  throw new Error('Could not retrieve selections for ' + code + '. Check Render logs for full response.');
}

async function scrapeBetway(code) {
  const r = await fetchUrl(
    `https://sports.betway.com.ng/api/Sportsbook/GetSharedBet?reference=${code}`,
    { 'Referer': 'https://sports.betway.com.ng/' }
  );
  if (r.status !== 200) throw new Error('Betway HTTP ' + r.status);
  const d = JSON.parse(r.body);
  const bets = d?.bets || d?.selections || d?.items || [];
  if (!bets.length) throw new Error('No selections in Betway response');
  return {
    selections: bets.map(b => ({
      match: b.eventName || `${b.home || ''} vs ${b.away || ''}`,
      pick: b.selectionName || b.outcome || '',
      betpawaPick: convertToBetPawa(b.marketName || '', b.selectionName || ''),
      odds: parseFloat(b.price || b.odds || 1),
      startTime: b.startTime || ''
    })),
    totalOdds: parseFloat(d?.totalOdds || 0)
  };
}

let indexHtml = '';
try {
  indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  console.log('✓ index.html loaded');
} catch(e) { console.log('⚠ index.html not found'); }

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  const { pathname, query } = url.parse(req.url, true);

  if (pathname === '/' || pathname === '/index.html') {
    if (indexHtml) {
      const host = req.headers.host || 'localhost:' + PORT;
      const proto = req.headers['x-forwarded-proto'] || 'http';
      const html = indexHtml.replace('__SERVER_URL__', `${proto}://${host}`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, msg: 'API running. index.html missing.' }));
    }
    return;
  }

  if (pathname === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, msg: 'Running', version: '3.0.0' }));
    return;
  }

  if (pathname !== '/convert') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Use /convert?platform=sportybet&code=XXX' }));
    return;
  }

  const { code, platform } = query;
  if (!code || !platform) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing: code, platform' }));
    return;
  }

  try {
    let result;
    if (platform === 'sportybet') result = await scrapeSportyBet(code.toUpperCase());
    else if (platform === 'betway') result = await scrapeBetway(code.toUpperCase());
    else throw new Error('Unknown platform: ' + platform);

    const totalOdds = result.totalOdds > 0
      ? result.totalOdds
      : parseFloat(result.selections.reduce((a, s) => a * s.odds, 1).toFixed(2));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, code, platform, selections: result.selections, totalOdds }));
  } catch(e) {
    console.error('[ERROR]', e.message);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✓ Bet converter v3 on port ${PORT}`);
});
