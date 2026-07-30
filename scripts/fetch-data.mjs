/**
 * 연금계좌 ETF 대시보드 — 일일 데이터 수집 스크립트
 *
 * GitHub Actions에서 매일 실행되어 data/market.json 을 만듭니다.
 * 브라우저가 아니라 GitHub 서버에서 돌기 때문에 CORS도, 프록시도 필요 없습니다.
 *
 * [2026-07 변경] Stooq가 GitHub Actions의 데이터센터 IP를 차단합니다
 * (quote 엔드포인트는 404, daily 엔드포인트는 CSV 대신 오류 페이지 반환).
 * 그래서 주 데이터 소스를 야후 파이낸스로 바꾸고 Stooq는 예비로만 남겼습니다.
 * 코스피는 국내 소스(네이버)가 당일 종가를 가장 빨리 주므로 최우선입니다.
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

async function get(url, tries = 2, quiet = false) {
  for (let i = 0; i < tries; i++) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), TIMEOUT);
      const r = await fetch(url, {
        signal: c.signal,
        headers: {
          // 기본 UA로는 거절하는 곳이 있어 일반 브라우저처럼 보낸다
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
          "Accept": "*/*",
        },
      });
      clearTimeout(t);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.text();
    } catch (e) {
      if (!quiet) console.warn(`    재시도 ${i + 1}/${tries} — ${url.slice(0, 55)} — ${e.message}`);
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    }
  }
  return null;
}
const getJson = async (u, t = 2) => { const x = await get(u, t); try { return x ? JSON.parse(x) : null; } catch { return null; } };

/* 시계열 → 현재값 · 52주 고점 · 200일 이동평균 */
function summarize(rows) {
  const last = rows[rows.length - 1];
  return {
    v: last.c, d: last.d,
    high: Math.max(...rows.slice(-260).map((x) => x.c)),
    ma200: avg(rows.slice(-200).map((x) => x.c)),
  };
}

/* ---------- 데이터 소스 ---------- */

// 야후 파이낸스 (주 소스) — 지수·ETF·선물·금리가 모두 같은 형식
async function yahooDaily(sym) {
  const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=2y&interval=1d`);
  const r = j?.chart?.result?.[0];
  const ts = r?.timestamp, cl = r?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(ts) || !Array.isArray(cl)) return null;
  const rows = ts.map((t, i) => ({ d: new Date(t * 1000).toISOString().slice(0, 10), c: cl[i] }))
                 .filter((x) => Number.isFinite(x.c) && x.c > 0);
  return rows.length > 30 ? rows : null;
}

// Stooq (예비) — 2026-07 현재 GitHub Actions IP에서는 대체로 차단됨
async function stooqDaily(sym) {
  const d1 = daysAgo(500).replace(/-/g, ""), d2 = iso(new Date()).replace(/-/g, "");
  const t = await get(`https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&d1=${d1}&d2=${d2}&i=d`, 1, true);
  if (!t || !/^Date/i.test(t.trim())) return null;
  const rows = t.trim().split(/\r?\n/).slice(1)
    .map((l) => { const p = l.split(","); return { d: p[0], c: parseFloat(p[4]) }; })
    .filter((x) => x.d && Number.isFinite(x.c));
  return rows.length > 30 ? rows : null;
}

// 네이버 금융 (코스피 전용) — 국내 소스라 당일 종가가 가장 빠르다.
// 단일따옴표 JS 배열 형식이라 JSON으로 바꿔 파싱한다.
async function naverKospi() {
  const s = daysAgo(500).replace(/-/g, ""), e = iso(new Date()).replace(/-/g, "");
  const txt = await get(`https://api.finance.naver.com/siseJson.naver?symbol=KOSPI&requestType=1&startTime=${s}&endTime=${e}&timeframe=day`, 2, true);
  if (!txt || !txt.includes("[")) return null;
  let arr;
  try { arr = JSON.parse(txt.replace(/'/g, '"').replace(/,\s*\]/g, "]").trim()); } catch { return null; }
  if (!Array.isArray(arr) || arr.length < 30) return null;
  const rows = arr.slice(1)
    .filter((r) => Array.isArray(r) && /^\d{8}$/.test(String(r[0])))
    .map((r) => ({ d: `${String(r[0]).slice(0, 4)}-${String(r[0]).slice(4, 6)}-${String(r[0]).slice(6, 8)}`, c: +r[4] }))
    .filter((x) => Number.isFinite(x.c) && x.c > 0);
  return rows.length > 30 ? rows : null;
}

/**
 * 여러 소스를 시도해 **가장 최신 날짜**를 가진 결과를 채택한다.
 * 앞 소스가 최근(2일 이내) 데이터를 주면 뒤 소스는 부르지 않는다.
 */
async function bestOf(label, sources) {
  const got = [];
  for (const [name, fn] of sources) {
    try {
      const rows = await fn();
      if (rows) {
        const last = rows[rows.length - 1].d;
        got.push({ name, rows, last });
        console.log(`  ${label} ${name}: 최신 ${last} (${rows.length}일)`);
        if (last >= daysAgo(2)) break;
      } else console.log(`  ${label} ${name}: 실패`);
    } catch (e) { console.log(`  ${label} ${name}: 오류 ${e.message}`); }
  }
  if (!got.length) return null;
  got.sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
  if (got.length > 1) console.log(`  → 채택: ${got[0].name} (${got[0].last})`);
  return { rows: got[0].rows, source: got[0].name };
}

/* 지표별 소스 — [야후 심볼, Stooq 심볼] */
const SERIES = {
  spx:   ["^GSPC", "^spx"],
  ndx:   ["^NDX",  "^ndx"],
  vix:   ["^VIX",  "^vix"],
  us10y: ["^TNX",  "10usy.b"],   // ^TNX = 미국 10년물 수익률(%)
  gold:  ["GC=F",  "xauusd"],    // 금 선물. 현물과 미세한 차이는 있으나 낙폭 판정엔 무방
};

/* 산업군 프록시 (미국 동종 섹터 ETF) */
const SECTOR_PROXY = {
  semi: ["SOXX", "soxx.us"], fin: ["XLF", "xlf.us"], reit: ["XLRE", "xlre.us"],
  bio: ["XLV", "xlv.us"], staple: ["XLP", "xlp.us"], energy: ["XLE", "xle.us"], util: ["XLU", "xlu.us"],
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
      .map((k) => ({ d: k, c: fxSer.rates[k].KRW })).filter((x) => Number.isFinite(x.c));
    console.log(`  환율 시계열 ${out.fxSeries.length}일`);
  } else fail.push("fxSeries");

  /* 코스피 — 네이버 → 야후 → Stooq */
  console.log("코스피…");
  const kos = await bestOf("코스피", [
    ["naver", naverKospi],
    ["yahoo", () => yahooDaily("^KS11")],
    ["stooq", () => stooqDaily("^kospi")],
  ]);
  if (kos) {
    const s = summarize(kos.rows);
    out.kospi = { v: s.v, d: s.d };
    out.kospiHigh = s.high; out.kospiMa200 = s.ma200;
    out.sources.kospi = kos.source;
  } else fail.push("kospi");

  /* 미국 지수·VIX·금리·금 — 야후 → Stooq */
  for (const [key, [ySym, sSym]] of Object.entries(SERIES)) {
    console.log(`${key}…`);
    const r = await bestOf(key, [
      ["yahoo", () => yahooDaily(ySym)],
      ["stooq", () => stooqDaily(sSym)],
    ]);
    if (!r) { fail.push(key); continue; }
    const s = summarize(r.rows);
    out[key] = { v: s.v, d: s.d };
    out.sources[key] = r.source;
    if (key === "spx" || key === "ndx") { out[key + "High"] = s.high; out[key + "Ma200"] = s.ma200; }
    if (key === "gold") out.goldHigh = s.high;
  }

  /* CNN 공포탐욕지수 */
  console.log("공포탐욕지수…");
  const fg = await getJson(`https://production.dataviz.cnn.io/index/fearandgreed/graphdata/${daysAgo(10)}`);
  const sc = Number(fg?.fear_and_greed?.score);
  if (Number.isFinite(sc) && sc > 0 && sc <= 100) {
    out.fng = { v: sc, d: String(fg.fear_and_greed.timestamp || "").slice(0, 10) || iso(new Date()) };
  } else fail.push("fng");

  /* 산업군 낙폭 */
  console.log("산업군 프록시…");
  out.sectors = {};
  for (const [id, [ySym, sSym]] of Object.entries(SECTOR_PROXY)) {
    const r = await bestOf(id, [
      ["yahoo", () => yahooDaily(ySym)],
      ["stooq", () => stooqDaily(sSym)],
    ]);
    if (!r) { fail.push("sector:" + id); continue; }
    const s = summarize(r.rows);
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

  /* 핵심 데이터가 전부 빠졌으면 기존 파일을 덮어쓰지 않는다 */
  if (!out.usdkrw && !out.spx && !out.kospi) {
    console.error("✗ 핵심 데이터를 전부 받지 못했습니다. 기존 파일을 유지합니다.");
    process.exit(1);
  }

  await mkdir("data", { recursive: true });
  await writeFile(OUT, JSON.stringify(out));
  console.log(`✓ ${OUT} 저장 완료 (${(JSON.stringify(out).length / 1024).toFixed(0)}KB, 실패 ${fail.length}건)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
