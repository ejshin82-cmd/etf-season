/**
 * /api/search?q=검색어 — 야후 파이낸스 종목 검색 프록시 (Cloudflare Pages Function)
 * 사이트 방문자가 종목명·티커로 검색할 수 있게 해준다.
 */
const HEAD = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "cache-control": "public, max-age=3600",
};

export async function onRequestGet({ request }) {
  const q = new URL(request.url).searchParams.get("q")?.trim();
  if (!q || q.length > 40) {
    return new Response(JSON.stringify({ error: "q(검색어)가 필요해요" }), { status: 400, headers: HEAD });
  }
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0`,
      { headers: { "User-Agent": "Mozilla/5.0 (etf-season chart)" } }
    );
    if (!r.ok) throw new Error("upstream " + r.status);
    const j = await r.json();
    const out = (j.quotes || [])
      .filter((x) => ["EQUITY", "ETF", "MUTUALFUND"].includes(x.quoteType))
      .map((x) => ({
        symbol: x.symbol,
        name: x.longname || x.shortname || x.symbol,
        exch: x.exchDisp || x.exchange || "",
        type: x.quoteType,
      }))
      .slice(0, 8);
    return new Response(JSON.stringify({ q, results: out }), { headers: HEAD });
  } catch (e) {
    return new Response(JSON.stringify({ error: "검색 서버 응답 없음", detail: String(e) }), { status: 502, headers: HEAD });
  }
}
