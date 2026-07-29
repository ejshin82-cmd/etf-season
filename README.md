# 연금계좌 ETF 대시보드 — 데이터 파이프라인

브라우저가 매번 외부 API를 직접 호출하는 대신, **GitHub이 매일 대신 받아서 JSON 파일 하나로 만들어 두는** 구조입니다.

## 왜 이렇게 하나

지금 대시보드는 열 때마다 Stooq·Frankfurter·CNN을 브라우저에서 직접 부릅니다. 이 방식의 문제는:

- **CORS** — 브라우저는 다른 도메인 호출을 기본적으로 막습니다. 그래서 공개 프록시(corsproxy.io 등)를 경유하는데, 이 프록시들은 무료 서비스라 언제든 느려지거나 죽습니다.
- **속도** — 열 때마다 10곳 넘게 호출하니 몇 초씩 걸립니다.
- **일관성** — 볼 때마다 값이 미묘하게 달라집니다.

파이프라인을 쓰면 **파일 하나만 읽으므로** 이 세 가지가 한 번에 해결됩니다. 서버도, 구독료도 필요 없습니다. GitHub 공개 저장소는 Actions가 무료입니다.

## 설치 (10분)

### 1. 저장소 만들기

GitHub에서 새 저장소를 만듭니다. 이름은 아무거나 (예: `etf-season`). **Public**으로 만들어야 Actions가 무료이고 Pages도 됩니다.

### 2. 파일 올리기

이 폴더의 내용을 그대로 저장소에 넣습니다.

```
.github/workflows/daily.yml     ← 매일 실행 설정
scripts/fetch-data.mjs          ← 데이터 수집 스크립트
data/                           ← 결과가 여기 쌓입니다
pension-etf-season.html         ← 대시보드 (같이 넣으면 Pages로 바로 볼 수 있음)
```

### 3. Actions 쓰기 권한 켜기

저장소 → **Settings → Actions → General → Workflow permissions** 에서
**Read and write permissions** 를 선택하고 저장합니다. (봇이 결과를 커밋해야 하므로 필요합니다.)

### 4. 한 번 수동 실행

저장소 → **Actions** 탭 → 왼쪽에서 `매일 시장 데이터 수집` → **Run workflow** 를 누릅니다.
1~2분 뒤 `data/market.json` 이 생기면 성공입니다.

### 5-A. Cloudflare Pages를 쓰는 경우 (권장)

Cloudflare Pages를 GitHub에 연결하면 **대시보드와 데이터를 한 도메인에서** 서빙하고,
봇이 데이터를 커밋할 때마다 자동으로 재배포됩니다. 이 경우 **GitHub Pages는 켤 필요가 없습니다.**

> ⚠️ **이미 「직접 업로드(Direct Upload)」로 만든 프로젝트는 Git 연동으로 바꿀 수 없습니다.**
> 새 프로젝트를 Git 연동으로 만들고, 기존 것은 나중에 지우세요.

1. `pension-etf-season.html` 의 **파일명을 `index.html` 로 바꿔서** 저장소 루트에 둡니다.
   (루트 주소만으로 열리게 하려면 필요합니다.)
2. Cloudflare 대시보드 → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**
3. GitHub 로그인 → **Install & Authorize** (저장소를 전부 줄 필요 없이 *Only select repositories* 로 이 저장소만 선택 가능)
4. 저장소 선택 → **Begin setup**
5. 빌드 설정 — 이 프로젝트는 빌드가 필요 없습니다.
   - **Framework preset**: `None`
   - **Build command**: **비워두기**
   - **Build output directory**: `/`
6. **Save and Deploy**. 1분 뒤 `프로젝트이름.pages.dev` 가 열립니다.

이후 GitHub에 커밋이 올라갈 때마다(=봇이 매일 데이터를 갱신할 때마다) Cloudflare가 자동으로 다시 배포합니다.

### 5-B. GitHub Pages를 쓰는 경우

**Settings → Pages → Source: Deploy from a branch → main / (root)** 저장.
잠시 뒤 이 주소들이 열립니다.

```
https://<내아이디>.github.io/<저장소이름>/pension-etf-season.html
https://<내아이디>.github.io/<저장소이름>/data/market.json
```

### 6. 대시보드에 연결

`pension-etf-season.html` 을 열어 파일 위쪽의 이 줄을 찾습니다.

```js
const DATA_URL = "";
```

여기에 JSON 주소를 넣고 저장한 뒤 **다시 커밋**합니다.

```js
// Cloudflare Pages를 쓰는 경우
const DATA_URL = "https://프로젝트이름.pages.dev/data/market.json";

// GitHub Pages를 쓰는 경우
const DATA_URL = "https://내아이디.github.io/저장소이름/data/market.json";
```

끝입니다. 이제 대시보드는 화면을 그릴 때 **이 파일 하나만** 읽습니다.
상단 배지에 **「파이프라인 JSON 사용」** 이 뜨면 제대로 연결된 겁니다.

> 예외가 하나 있습니다. **백테스트**는 15년치 과거 시세가 필요한데 이건 매일 담기엔 너무 커서
> JSON에 넣지 않았습니다. 그래서 「▶ 백테스트 돌리기」 버튼을 누를 때만 브라우저가 따로 받아옵니다.
> 버튼을 안 누르면 외부 호출은 0건입니다.

## 실행 시각

`daily.yml` 의 `cron: "30 21 * * 1-5"` 는 **UTC 기준**입니다.
UTC 21:30 = **한국시간 익일 06:30** (미국 장 마감 후, 평일만).

시간을 바꾸려면 한국시간에서 9를 빼세요. 예를 들어 한국시간 08:00에 돌리려면 `0 23 * * 0-4` 입니다.
(날짜를 넘어가므로 요일도 하루씩 당겨야 합니다.)

> GitHub의 예약 실행은 서버가 붐비면 **수십 분 늦게** 시작될 수 있습니다. 정시 보장이 필요한 용도가 아니라면 문제되지 않습니다.

## 수동으로 관리하는 값

기준금리, S&P500 선행 P/E처럼 **무료 API로 안 나오는 값**은 `data/manual.json` 에 적어두면
스크립트가 자동 수집분에 덮어씌웁니다. 분기에 한 번 정도만 손보면 됩니다.

```json
{
  "fedLow": 3.50,
  "fedHigh": 3.75,
  "krBase": { "v": 2.75, "d": "2026-07-16" },
  "us2y":   { "v": 4.37, "d": "2026-07-23" }
}
```

## 잘 안 될 때

| 증상 | 확인할 것 |
|---|---|
| Actions가 실패 (빨간 X) | Actions 탭에서 로그를 열어 `⚠ 실패한 항목` 줄 확인. Stooq가 일시적으로 막으면 다음날 정상화되는 경우가 많습니다 |
| `Permission denied` 커밋 실패 | 3단계(Read and write permissions)를 안 한 경우입니다 |
| 대시보드에 배지가 안 뜸 | `DATA_URL` 오타, 또는 Pages 배포 전. JSON 주소를 브라우저에 직접 붙여넣어 열리는지 확인하세요 |
| 60일간 커밋이 없으면 | GitHub이 예약 실행을 자동 중지합니다. Actions 탭에서 다시 켜면 됩니다 |

## 실패해도 안전한 이유

- 핵심 데이터(환율·S&P500)를 **둘 다** 못 받으면 스크립트가 종료 코드 1로 죽고, 기존 `market.json` 을 덮어쓰지 않습니다. 어제 데이터가 그대로 남습니다.
- 일부 항목만 실패하면 그 항목만 빠진 채 저장되고, `failed` 배열에 기록됩니다.
- 대시보드는 `DATA_URL` 호출이 실패하면 **기존 방식(브라우저 직접 호출)으로 자동 폴백**합니다. 파이프라인이 죽어도 대시보드는 계속 돕니다.
