/**
 * 연금계좌 ETF 대시보드 — 일일 데이터 수집 스크립트 (v2)
 *
 * GitHub Actions에서 매일 실행되어 두 파일을 만듭니다.
 *   data/market.json    — 시장 지표 (환율·지수·VIX·금·금리·공포탐욕·산업군)
 *   data/portfolio.json — data/tickers.json 에 등록된 보유종목 시세
 *
 * v2 변경점
 *   - 시세 소스를 Yahoo Finance(1차) + Stooq(2차 폴백)로 변경
 *     (Stooq가 GitHub 러너에서 자주 차단되어 실패 13건 발생했던 문제 해결)
 *   - 보유종목 시세 수집 추가 (data/tickers.json → data/portfolio.json)
 *
 * 의존성 없음 (Node 20+ 내장 fetch만 사용)
 * 로컬 실행: node scripts/fetch-data.mjs
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";

const OUT_MARKET = "data/market.json";
const OUT_PORTFOLIO = "data/portfolio.json";
const TICKERS = "data/tickers.json";
const TIMEOUT = 20000;

/* ---------- 공통 ---------- */
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), TIMEOUT);
      const r = await fetch(url, {
        signal: c.signal,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; etf-season-bot/2.0)" },
      });
      clearTimeout(t);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.text();
    } catch (e) {
      console.warn(`  재시도 ${i + 1}/${tries} — ${url.slice(0, 70)} — ${e.message}`);
      await sleep(1500 * (i + 1));
    }
  }
  return null;
}
const getJson = async (u) => { const t = await get(u); try { return t ? JSON.parse(t) : null; } catch { return null; } };

/* ---------- Yahoo Finance (1차 소스) ---------- */
/** 일봉 시계열: [{d:'YYYY-MM-DD', c:종가}, ...] */
async function yahooDaily(sym, range = "2y") {
  const j = await getJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d`
  );
  const res = j?.chart?.result?.[0];
  if (!res?.timestamp || !res?.indicators?.quote?.[0]?.close) return null;
  const closes = res.indicators.quote[0].close;
  const rows = res.timestamp
    .map((ts, i) => ({ d: iso(new Date(ts * 1000)), c: closes[i] }))
    .filter((x) => x.d && isFinite(x.c) && x.c !== null);
  if (!rows.length) return null;
  rows.meta = res.meta || {};
  return rows;
}

/* ---------- Stooq (2차 폴백) ---------- */
async function stooqDaily(sym, fromDays) {
  const d1 = daysAgo(fromDays).replace(/-/g, "");
  const d2 = iso(new Date()).replace(/-/g, "");
  const t = await get(`https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&d1=${d1}&d2=${d2}&i=d`);
  if (!t || !/^Date/i.test(t.trim())) return null;
  const rows = t.trim().split(/\r?\n/).slice(1)
    .map((l) => { const p = l.split(","); return { d: p[0], c: parseFloat(p[4]) }; })
    .filter((x) => x.d && isFinite(x.c));
  return rows.length > 30 ? rows : null;
}

/** Yahoo 우선, 실패하면 Stooq */
async function daily(yahooSym, stooqSym, fromDays = 500) {
  const y = await yahooDaily(yahooSym, fromDays > 400 ? "2y" : "1y");
  if (y) return y;
  if (stooqSym) {
    console.warn(`  Yahoo 실패 → Stooq 폴백 (${stooqSym})`);
    return await stooqDaily(stooqSym, fromDays);
  }
  return null;
}

/* 시계열 → 현재값 · 52주 고점 · 200일 이동평균 */
function summarize(rows) {
  const last = rows[rows.length - 1];
  return {
    v: last.c, d: last.d,
    high: Math.max(...rows.slice(-260).map((x) => x.c)),
    ma200: avg(rows.slice(-Math.min(200, rows.length)).map((x) => x.c)),
  };
}

/* ---------- 산업군 프록시 (미국 동종 섹터 ETF) ---------- */
const SECTOR_PROXY = {
  semi:   ["SOXX", "soxx.us"], fin:  ["XLF", "xlf.us"], reit: ["XLRE", "xlre.us"],
  bio:    ["XLV", "xlv.us"],   staple: ["XLP", "xlp.us"], energy: ["XLE", "xle.us"],
  util:   ["XLU", "xlu.us"],
};

/* ================= 1. 시장 지표 → market.json ================= */
async function buildMarket() {
  const out = { asOf: iso(new Date()), generatedAt: new Date().toISOString(), sources: {} };
  const fail = [];

  /* 환율 — Frankfurter (ECB) */
  console.log("환율…");
  const fxNow = await getJson("https://api.frankfurter.dev/v1/latest?base=USD&symbols=KRW");
  if (fxNow?.rates?.KRW) { out.usdkrw = { v: fxNow.rates.KRW, d: fxNow.date }; out.sources.fx = "frankfurter"; }
  else fail.push("usdkrw");

  const fxSer = await getJson(`https://api.frankfurter.dev/v1/${daysAgo(1095)}..?base=USD&symbols=KRW`);
  if (fxSer?.rates) {
    out.fxSeries = Object.keys(fxSer.rates).sort()
      .map((k) => ({ d: k, c: fxSer.rates[k].KRW })).filter((x) => isFinite(x.c));
    console.log(`  환율 시계열 ${out.fxSeries.length}일`);
  } else fail.push("fxSeries");

  /* 지수 — Yahoo 우선, Stooq 폴백 */
  for (const [key, ySym, sSym] of [["spx", "^GSPC", "^spx"], ["ndx", "^NDX", "^ndx"], ["kospi", "^KS11", "^kospi"]]) {
    console.log(`${key}…`);
    const h = await daily(ySym, sSym, 500);
    if (h) {
      const s = summarize(h);
      out[key] = { v: s.v, d: s.d };
      out[key + "High"] = s.high;
      out[key + "Ma200"] = s.ma200;
    } else fail.push(key);
    await sleep(300);
  }

  /* VIX · 금 · 미국 10년물 */
  for (const [key, ySym, sSym, lo, hi] of [
    ["vix", "^VIX", "^vix", 5, 100],
    ["gold", "GC=F", "xauusd", 500, 20000],
    ["us10y", "^TNX", "10usy.b", 0.5, 15],
  ]) {
    console.log(`${key}…`);
    const h = await daily(ySym, sSym, 500);
    if (h) {
      const s = summarize(h);
      if (s.v > lo && s.v < hi) {
        out[key] = { v: s.v, d: s.d };
        if (key === "gold") out.goldHigh = s.high;
      } else fail.push(key);
    } else fail.push(key);
    await sleep(300);
  }

  /* CNN 공포탐욕지수 */
  console.log("공포탐욕지수…");
  const fg = await getJson(`https://production.dataviz.cnn.io/index/fearandgreed/graphdata/${daysAgo(10)}`);
  const sc = Number(fg?.fear_and_greed?.score);
  if (isFinite(sc) && sc > 0 && sc <= 100) {
    out.fng = { v: sc, d: String(fg.fear_and_greed.timestamp || "").slice(0, 10) || iso(new Date()) };
  } else fail.push("fng");

  /* 산업군 낙폭 */
  console.log("산업군 프록시…");
  out.sectors = {};
  for (const [id, [ySym, sSym]] of Object.entries(SECTOR_PROXY)) {
    const h = await daily(ySym, sSym, 430);
    if (!h) { fail.push("sector:" + id); continue; }
    const s = summarize(h);
    out.sectors[id] = {
      dd: +(((s.high - s.v) / s.high) * 100).toFixed(2),
      p200: +((s.v / s.ma200 - 1) * 100).toFixed(2),
      d: s.d,
    };
    await sleep(300);
  }

  /* 수동 관리 값 — manual.json 이 있으면 덮어씀 (기준금리, 선행 P/E 등) */
  try {
    const manual = JSON.parse(await readFile("data/manual.json", "utf8"));
    Object.assign(out, manual);
    console.log("  manual.json 반영");
  } catch { /* 없으면 무시 */ }

  out.failed = fail;
  if (fail.length) console.warn("⚠ market 실패 항목:", fail.join(", "));
  return out;
}

/* ================= 2. 보유종목 시세 → portfolio.json ================= */
async function buildPortfolio() {
  let list;
  try {
    list = JSON.parse(await readFile(TICKERS, "utf8")).items;
  } catch {
    console.warn("data/tickers.json 없음 — 보유종목 수집 생략");
    return null;
  }

  const out = { asOf: iso(new Date()), generatedAt: new Date().toISOString(), items: [], failed: [] };

  for (const t of list) {
    console.log(`보유종목 ${t.name} (${t.yahoo})…`);
    const h = await yahooDaily(t.yahoo, "1y");
    if (!h || h.length < 2) { out.failed.push(t.name); await sleep(300); continue; }

    const closes = h.map((x) => x.c);
    const last = h[h.length - 1];
    const prev = h[h.length - 2];
    const high52 = Math.max(...closes);
    const low52 = Math.min(...closes);
    const ma200 = avg(closes.slice(-Math.min(200, closes.length)));

    out.items.push({
      name: t.name,
      code: t.code,
      yahoo: t.yahoo,
      currency: t.currency || h.meta?.currency || "KRW",
      yahooName: h.meta?.shortName || h.meta?.longName || null, // 코드-종목명 일치 검증용
      close: last.c, date: last.d,
      prevClose: prev.c,
      chgPct: +(((last.c - prev.c) / prev.c) * 100).toFixed(2),
      high52: +high52.toFixed(4), low52: +low52.toFixed(4),
      offHigh52: +(((high52 - last.c) / high52) * 100).toFixed(2), // 52주 고점 대비 낙폭 %
      vsMa200: +((last.c / ma200 - 1) * 100).toFixed(2),           // 200일선 대비 %
      week1: h.length > 6 ? +(((last.c - h[h.length - 6].c) / h[h.length - 6].c) * 100).toFixed(2) : null,
    });
    await sleep(300); // Yahoo 요청 간격
  }

  if (out.failed.length) console.warn("⚠ portfolio 실패 항목:", out.failed.join(", "));
  return out;
}

/* ================= 메인 ================= */
async function main() {
  const market = await buildMarket();
  const portfolio = await buildPortfolio();

  /* 필수 항목이 다 빠졌으면 기존 파일을 덮어쓰지 않는다 */
  if (!market.usdkrw && !market.spx) {
    console.error("✗ 핵심 시장 데이터를 전부 받지 못했습니다. 기존 파일을 유지합니다.");
    process.exit(1);
  }

  await mkdir("data", { recursive: true });
  await writeFile(OUT_MARKET, JSON.stringify(market));
  console.log(`✓ ${OUT_MARKET} 저장 (실패 ${market.failed.length}건)`);

  if (portfolio) {
    /* 절반 이상 실패하면 기존 portfolio.json 유지 */
    if (portfolio.items.length >= Math.ceil((portfolio.items.length + portfolio.failed.length) / 2)) {
      await writeFile(OUT_PORTFOLIO, JSON.stringify(portfolio));
      console.log(`✓ ${OUT_PORTFOLIO} 저장 (${portfolio.items.length}종목, 실패 ${portfolio.failed.length}건)`);
    } else {
      console.error("✗ 보유종목 절반 이상 수집 실패 — 기존 portfolio.json 유지");
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
