const BETPAWA_MARKETS = (market, pick) => {
  const p = (pick || '').toLowerCase().trim();
  const m = (market || '').toLowerCase();
  if (['1','home','home win'].includes(p)) return '1';
  if (['x','draw'].includes(p)) return 'X';
  if (['2','away','away win'].includes(p)) return '2';
  if (['1x','home or draw','home/draw'].includes(p)) return 'DC 1X';
  if (['x2','draw or away','draw/away'].includes(p)) return 'DC X2';
  if (['12','home or away','home/away'].includes(p)) return 'DC 12';
  if (p.includes('gg') || p === 'yes' || p.includes('both teams')) return 'GG';
  if (p.includes('ng') || p === 'no' || p.includes('no goal')) return 'NG';
  const ov = p.match(/over\s*([\d.]+)/) || m.match(/over\s*([\d.]+)/);
  if (ov) return 'Over ' + ov[1];
  const un = p.match(/under\s*([\d.]+)/) || m.match(/under\s*([\d.]+)/);
  if (un) return 'Under ' + un[1];
  if (m.includes('ht') || m.includes('half')) {
    if (p.includes('home') || p === '1') return 'HT 1';
    if (p.includes('draw') || p === 'x') return 'HT X';
    if (p.includes('away') || p === '2') return 'HT 2';
  }
  return pick;
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json'
};

async function fetchBetway(code) {
  const endpoints = [
    `https://sports.betway.com.ng/api/Sportsbook/GetSharedBet?reference=${code}`,
    `https://sports.betway.com.ng/api/v2/bets/share/${code}`,
    `https://www.betway.com.ng/api/bets/share?code=${code}`
  ];

  for (const ep of endpoints) {
    try {
      const res = await fetch(ep, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 11; SM-G991B) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
          'Accept': 'application/json, */*',
          'Referer': 'https://sports.betway.com.ng/',
          'Origin': 'https://sports.betway.com.ng'
        }
      });

      const text = await res.text();
      console.log(`[${ep}] status=${res.status} body=${text.slice(0, 300)}`);

      if (res.status !== 200) continue;

      const d = JSON.parse(text);

      // Try known response shapes
      const bets =
        d?.bets ||
        d?.selections ||
        d?.data?.bets ||
        d?.data?.selections ||
        d?.result?.bets ||
        [];

      if (bets.length > 0) {
        return {
          selections: bets.map(b => ({
            match: b.eventName || `${b.home || b.homeTeam || ''} vs ${b.away || b.awayTeam || ''}`,
            pick: b.selectionName || b.outcomeName || b.outcome || '',
            betpawaPick: BETPAWA_MARKETS(b.marketName || b.betType || '', b.selectionName || b.outcome || ''),
            odds: parseFloat(b.price || b.odds || 1),
            startTime: b.startTime || b.eventDate || ''
          })),
          totalOdds: parseFloat(d?.totalOdds || d?.data?.totalOdds || 0)
        };
      }

      // Log full structure for debugging
      console.log(`Full response: ${text.slice(0, 1000)}`);
    } catch(e) {
      console.log(`Endpoint ${ep} failed: ${e.message}`);
    }
  }

  throw new Error('No selections found. Check Worker logs for response structure.');
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: CORS });
    }

    if (url.pathname === '/ping') {
      return new Response(JSON.stringify({ ok: true, msg: 'CF Worker running', cf: request.cf?.colo }), { headers: CORS });
    }

    if (url.pathname === '/debug') {
      const code = url.searchParams.get('code');
      if (!code) return new Response(JSON.stringify({ error: 'Missing code' }), { headers: CORS });
      const res = await fetch(`https://sports.betway.com.ng/api/Sportsbook/GetSharedBet?reference=${code.toUpperCase()}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 11) Chrome/120.0.0.0 Mobile Safari/537.36',
          'Accept': 'application/json',
          'Referer': 'https://sports.betway.com.ng/'
        }
      });
      const body = await res.text();
      return new Response(JSON.stringify({ status: res.status, cf_colo: request.cf?.colo, body: body.slice(0, 2000) }), { headers: CORS });
    }

    if (url.pathname === '/convert') {
      const code = url.searchParams.get('code');
      const platform = url.searchParams.get('platform');
      if (!code || !platform) {
        return new Response(JSON.stringify({ error: 'Missing: code, platform' }), { status: 400, headers: CORS });
      }
      try {
        const result = await fetchBetway(code.toUpperCase());
        const totalOdds = result.totalOdds > 0
          ? result.totalOdds
          : parseFloat(result.selections.reduce((a, s) => a * s.odds, 1).toFixed(2));
        return new Response(JSON.stringify({ ok: true, code, platform, selections: result.selections, totalOdds }), { headers: CORS });
      } catch(e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: CORS });
      }
    }

    return new Response(JSON.stringify({ error: 'Use /convert?platform=betway&code=XXX' }), { status: 404, headers: CORS });
  }
};
