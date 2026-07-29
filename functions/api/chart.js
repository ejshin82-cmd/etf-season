/**
 * /api/chart?symbol=005930.KS — 야후 파이낸스 일봉 시세 프록시 (Cloudflare Pages Function)
 * 최근 1년 일봉(OHLCV)을 간단한 JSON으로 돌려준다. 30분 캐시.
 */
const HEAD = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "cache-control": "public, max-age=1800",
};
const err = (msg, code = 400) => new Response(JSON.stringify({ error: msg }), { status: code, headers: HEAD });

export async function onRequestGet({ request }) {
  const symbol = new URL(request.url).searchParams.get("symbol")?.trim().toUpperCase();
  if (!symbol || !/^[A-Z0-9.^=\-]{1,15}$/.test(symbol)) return err("symbol 형식이 올바르지 않아요");

  // Cloudflare 엣지 캐시 (30분)
  const cache = caches.default;
  const cacheKey = new Request(`https://cache.local/chart/${symbol}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`,
      { headers: { "User-Agent": "Mozilla/5.0 (etf-season chart)" } }
    );
    if (!r.ok) throw new Error("upstream " + r.status);
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    const q = res?.indicators?.quote?.[0];
    if (!res?.timestamp || !q?.close) return err("해당 심볼의 시세를 찾지 못했어요", 404);

    const series = [];
    for (let i = 0; i < res.timestamp.length; i++) {
      const c = q.close[i];
      if (c == null || !isFinite(c)) continue;
      const pick = (arr) => (arr?.[i] != null && isFinite(arr[i]) ? arr[i] : c);
      series.push({
        d: new Date(res.timestamp[i] * 1000).toISOString().slice(0, 10),
        o: +pick(q.open).toFixed(4),
        h: +pick(q.high).toFixed(4),
        l: +pick(q.low).toFixed(4),
        c: +c.toFixed(4),
        v: q.volume?.[i] != null ? Math.round(q.volume[i]) : 0,
      });
    }
    if (series.length < 30) return err("데이터가 부족한 종목이에요 (상장 초기 등)", 422);

    const body = JSON.stringify({
      symbol,
      name: res.meta?.shortName || res.meta?.longName || symbol,
      currency: res.meta?.currency || "KRW",
      series,
    });
    const resp = new Response(body, { headers: HEAD });
    await cache.put(cacheKey, resp.clone());
    return resp;
  } catch (e) {
    return err("시세 서버 응답 없음 — 잠시 후 다시 시도해주세요", 502);
  }
}
