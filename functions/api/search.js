/**
 * /api/search?q=검색어 — 종목 검색 프록시 (Cloudflare Pages Function)
 * 한글 검색어 → 네이버 증권 자동완성 (국내 종목에 강함)
 * 영문·티커 → 야후 파이낸스 검색 (해외 종목)
 */
const HEAD = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "cache-control": "public, max-age=3600",
};
const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" };

/* 응답 어디에 있든 {code, name} 형태의 국내 종목 배열을 찾아낸다 */
function findKrItems(node, out) {
  if (!node || out.length >= 20) return;
  if (Array.isArray(node)) { for (const x of node) findKrItems(x, out); return; }
  if (typeof node === "object") {
    const code = node.code || node.itemCode || node.cd;
    const name = node.name || node.itemName || node.nm;
    if (typeof code === "string" && /^\d{6}$/.test(code) && typeof name === "string") {
      const market = String(node.category || node.typeName || node.marketType || node.market || "");
      out.push({ code, name, market });
    }
    for (const k of Object.keys(node)) findKrItems(node[k], out);
  }
}

async function searchNaver(q) {
  const urls = [
    `https://m.stock.naver.com/front-api/search/autoComplete?query=${encodeURIComponent(q)}&target=stock`,
    `https://ac.stock.naver.com/ac?q=${encodeURIComponent(q)}&target=stock&r_format=json`,
  ];
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { ...UA, Referer: "https://m.stock.naver.com/" } });
      if (!r.ok) continue;
      const j = await r.json();
      const found = [];
      findKrItems(j, found);
      if (found.length) {
        const seen = new Set();
        return found
          .filter((x) => !seen.has(x.code) && seen.add(x.code))
          .slice(0, 8)
          .map((x) => ({
            symbol: x.code + (/KOSDAQ|코스닥/i.test(x.market) ? ".KQ" : ".KS"),
            name: x.name,
            exch: /KOSDAQ|코스닥/i.test(x.market) ? "KOSDAQ" : "KRX",
            type: "KR",
          }));
      }
    } catch { /* 다음 소스 시도 */ }
  }
  return null;
}

async function searchYahoo(q, kr) {
  const extra = kr ? "&lang=ko-KR&region=KR" : "";
  const r = await fetch(
    `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0${extra}`,
    { headers: UA }
  );
  if (!r.ok) throw new Error("upstream " + r.status);
  const j = await r.json();
  return (j.quotes || [])
    .filter((x) => ["EQUITY", "ETF", "MUTUALFUND"].includes(x.quoteType))
    .map((x) => ({
      symbol: x.symbol,
      name: x.longname || x.shortname || x.symbol,
      exch: x.exchDisp || x.exchange || "",
      type: x.quoteType,
    }))
    .slice(0, 8);
}

export async function onRequestGet({ request }) {
  const q = new URL(request.url).searchParams.get("q")?.trim();
  if (!q || q.length > 40) {
    return new Response(JSON.stringify({ error: "q(검색어)가 필요해요" }), { status: 400, headers: HEAD });
  }
  const isKorean = /[가-힣]/.test(q);
  try {
    let results = null;
    if (isKorean) results = await searchNaver(q);          // 한글 → 네이버 우선
    if (!results || !results.length) {
      try { results = await searchYahoo(q, isKorean); } catch { results = results || []; }
    }
    return new Response(JSON.stringify({ q, results: results || [] }), { headers: HEAD });
  } catch (e) {
    return new Response(JSON.stringify({ error: "검색 서버 응답 없음", detail: String(e) }), { status: 502, headers: HEAD });
  }
}
