/**
 * 연금계좌 ETF 대시보드 — 일일 데이터 수집 스크립트
 *
 * GitHub Actions에서 매일 실행되어 data/market.json 을 만듭니다.
 * 브라우저가 아니라 GitHub 서버에서 돌기 때문에 CORS도, 프록시도 필요 없습니다.
 *
 * 의존성 없음 (Node 20+ 내장 fetch만 사용)
 * 로컬 실행: node scripts/fetch-data.mjs
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";

const OUT = "data/market.json";
const TIMEOUT = 20000;

/* ---------- 공통 ---------- */
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), TIMEOUT);
      const r = await fetch(url, { signal: c.signal, headers: { "User-Agent": "etf-season-bot/1.0" } });
      clearTimeout(t);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.text();
    } catch (e) {
      console.warn(`  재시도 ${i + 1}/${tries} — ${url.slice(0, 60)} — ${e.message}`);
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  return null;
}
const getJson = async (u) => { const t = await get(u); try { return t ? JSON.parse(t) : null; } catch { return null; } };

/* ---------- Stooq ---------- */
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
async function stooqQuote(sym) {
  const t = await get(`https://stooq.com/q/l/?s=${encodeURIComponent(sym)}&f=sd2t2ohlc&h&e=csv`);
  if (!t) return null;
  const r = t.trim().split(/\r?\n/);
  if (r.length < 2) return null;
  const c = r[1].split(",");
  const v = parseFloat(c[6]);
  return isFinite(v) && v !== 0 ? { v, d: c[1] } : null;
}

/* 시계열 → 현재값 · 52주 고점 · 200일 이동평균 */
function summarize(rows) {
  const last = rows[rows.length - 1];
  return {
    v: last.c, d: last.d,
    high: Math.max(...rows.slice(-260).map((x) => x.c)),
    ma200: avg(rows.slice(-200).map((x) => x.c)),
  };
}

/* ---------- 산업군 프록시 (미국 동종 섹터 ETF) ---------- */
const SECTOR_PROXY = {
  semi: "soxx.us", fin: "xlf.us", reit: "xlre.us",
  bio: "xlv.us", staple: "xlp.us", energy: "xle.us", util: "xlu.us",
};

async function main() {
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

  /* 지수 */
  for (const [key, sym] of [["spx", "^spx"], ["ndx", "^ndx"], ["kospi", "^kospi"]]) {
    console.log(`${key}…`);
    const h = await stooqDaily(sym, 500);
    if (h) {
      const s = summarize(h);
      out[key] = { v: s.v, d: s.d };
      out[key + "High"] = s.high;
      out[key + "Ma200"] = s.ma200;
    } else fail.push(key);
  }

  /* VIX · 금 · 미국 10년물 */
  for (const [key, sym, lo, hi] of [["vix", "^vix", 5, 100], ["gold", "xauusd", 500, 20000], ["us10y", "10usy.b", 0.5, 15]]) {
    console.log(`${key}…`);
    const q = await stooqQuote(sym);
    if (q && q.v > lo && q.v < hi) out[key] = q; else fail.push(key);
  }
  if (out.gold) {
    const gh = await stooqDaily("xauusd", 500);
    if (gh) out.goldHigh = summarize(gh).high;
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
  for (const [id, sym] of Object.entries(SECTOR_PROXY)) {
    const h = await stooqDaily(sym, 430);
    if (!h) { fail.push("sector:" + id); continue; }
    const s = summarize(h);
    out.sectors[id] = {
      dd: +(((s.high - s.v) / s.high) * 100).toFixed(2),
      p200: +((s.v / s.ma200 - 1) * 100).toFixed(2),
      d: s.d,
    };
  }

  /* 수동 관리 값 — manual.json 이 있으면 덮어씀 (기준금리, 선행 P/E 등) */
  try {
    const manual = JSON.parse(await readFile("data/manual.json", "utf8"));
    Object.assign(out, manual);
    console.log("  manual.json 반영");
  } catch { /* 없으면 무시 */ }

  out.failed = fail;
  if (fail.length) console.warn("⚠ 실패한 항목:", fail.join(", "));

  /* 필수 항목이 다 빠졌으면 기존 파일을 덮어쓰지 않는다 */
  if (!out.usdkrw && !out.spx) {
    console.error("✗ 핵심 데이터를 전부 받지 못했습니다. 기존 파일을 유지합니다.");
    process.exit(1);
  }

  await mkdir("data", { recursive: true });
  await writeFile(OUT, JSON.stringify(out));
  const kb = (JSON.stringify(out).length / 1024).toFixed(0);
  console.log(`✓ ${OUT} 저장 완료 (${kb}KB, 실패 ${fail.length}건)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
