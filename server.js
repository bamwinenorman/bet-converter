const http = require('http');
const https = require('https');
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/html, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive',
        ...extraHeaders
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Request timed out')); });
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

async function scrapeSportyBet(code) {
  console.log(`[SportyBet] code: ${code}`);
  try {
    const r = await fetchUrl(`https://www.sportybet.com/api/ng/orders/share?bookingCode=${code}`, {
      'Referer': 'https://www.sportybet.com/ng/',
      'Origin': 'https://www.sportybet.com'
    });
    if (r.status === 200) {
      const d = JSON.parse(r.body);
      const events = d?.data?.sportEvents || d?.data?.betItems || d?.sportEvents || [];
      if (events.length > 0) {
        return {
          selections: events.map(e => ({
            match: `${e.homeTeamName || e.homeName || ''} vs ${e.awayTeamName || e.awayName || e.eventName || ''}`.replace(/\s+/g,' ').trim(),
            pick: e.outcomeName || e.outcome || '',
            betpawaPick: convertToBetPawa(e.marketName || e.betTypeName || '', e.outcomeName || e.outcome || ''),
            odds: parseFloat(e.odds || e.price || 1),
            startTime: e.gameTime || e.startTime || ''
          })),
          totalOdds: parseFloat(d?.data?.totalOdds || 0)
        };
      }
    }
  } catch(e) { console.log(`[SportyBet] API failed: ${e.message}`); }

  try {
    const r = await fetchUrl(`https://www.sportybet.com/ng/share-code?bookingCode=${code}`, {
      'Accept': 'text/html,application/xhtml+xml',
      'Referer': 'https://www.sportybet.com/ng/'
    });
    if (r.status === 200) {
      const tryParse = s => { try { return JSON.parse(s); } catch(e) { return null; } };
      for (const pat of [/"sportEvents"\s*:\s*(\[[\s\S]*?\])\s*[,}]/, /"betItems"\s*:\s*(\[[\s\S]*?\])\s*[,}]/]) {
        const m = r.body.match(pat);
        if (m) {
          const items = tryParse(m[1]);
          if (Array.isArray(items) && items.length > 0) {
            return {
              selections: items.map(e => ({
                match: `${e.homeTeamName || ''} vs ${e.awayTeamName || ''}`.trim(),
                pick: e.outcomeName || e.outcome || '',
                betpawaPick: convertToBetPawa(e.marketName || '', e.outcomeName || ''),
                odds: parseFloat(e.odds || 1),
                startTime: e.gameTime || ''
              })),
              totalOdds: 0
            };
          }
        }
      }
    }
  } catch(e) { console.log(`[SportyBet] HTML failed: ${e.message}`); }

  throw new Error('Could not retrieve selections for code: ' + code);
}

async function scrapeBetway(code) {
  const r = await fetchUrl(`https://sports.betway.com.ng/api/Sportsbook/GetSharedBet?reference=${code}`, {
    'Referer': 'https://sports.betway.com.ng/'
  });
  if (r.status !== 200) throw new Error('Betway returned status ' + r.status);
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

// Read index.html once at startup, replace SERVER_URL placeholder
let indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
// The HTML uses SERVER_URL placeholder — replaced at runtime with actual host
// (handled dynamically per request below)

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const { pathname, query } = url.parse(req.url, true);

  // Serve frontend
  if (pathname === '/' || pathname === '/index.html') {
    const host = req.headers.host || 'localhost:' + PORT;
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const serverUrl = `${proto}://${host}`;
    const html = indexHtml.replace('__SERVER_URL__', serverUrl);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (pathname === '/ping') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, msg: 'Running' }));
    return;
  }

  if (pathname !== '/convert') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Use /convert?platform=sportybet&code=XXX' }));
    return;
  }

  const { code, platform } = query;
  if (!code || !platform) {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(400);
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

    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, code, platform, selections: result.selections, totalOdds }));
  } catch(e) {
    console.error('[ERROR]', e.message);
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✓ Bet converter running → http://localhost:${PORT}`);
});
