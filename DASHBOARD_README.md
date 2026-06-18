# YoungButton 관리자 대시보드 — 배포 가이드

## 전체 구조

```
[YoungButton 앱]  →  [비콘 API /api/beacon]  →  [Vercel KV]
                                                      ↓
                                              [대시보드 dashboard.html]
```

---

## 1단계: Vercel에 대시보드 배포

### 1-1. 파일 구조
```
yb-dashboard/
├── api/
│   └── beacon.js        ← 비콘 수신 API (Vercel Serverless Function)
├── admin/
│   └── dashboard.html   ← 관리자 대시보드 UI
├── public/
│   └── analytics-sdk.js ← (참고용) SDK 문서
└── vercel.json          ← Vercel 설정
```

### 1-2. vercel.json 작성
```json
{
  "rewrites": [
    { "source": "/admin", "destination": "/admin/dashboard.html" }
  ],
  "headers": [
    {
      "source": "/api/(.*)",
      "headers": [
        { "key": "Access-Control-Allow-Origin", "value": "*" },
        { "key": "Access-Control-Allow-Methods", "value": "GET, POST, OPTIONS" }
      ]
    }
  ]
}
```

### 1-3. 환경변수 설정 (Vercel 프로젝트 → Settings → Environment Variables)
| 변수명 | 값 | 설명 |
|--------|-----|------|
| `ADMIN_TOKEN` | `yb-admin-2026` | 대시보드 API 접근 토큰 (변경 권장) |
| `KV_URL` | Vercel KV URL | 데이터 저장소 (없으면 메모리 모드) |
| `KV_REST_API_URL` | Vercel KV REST URL | KV REST 접근 |
| `KV_REST_API_TOKEN` | Vercel KV Token | KV 인증 |

### 1-4. Vercel KV 생성 (선택 — 데이터 영구 저장 시 필수)
1. Vercel 프로젝트 → Storage → Create Database → KV
2. 생성된 KV를 프로젝트에 연결
3. 환경변수 자동 설정됨

---

## 2단계: YoungButton 앱 연동

### 2-1. app.js 패치 (APP_PATCH.js 파일 참고)

**① app.js 최상단에 SDK 코드 삽입**
- `APP_PATCH.js`의 `[1]` 코드 블록을 app.js 첫 줄 위에 붙여넣기
- `YB_BEACON_URL`을 실제 배포된 대시보드 URL로 변경

**② _trackEvent 함수 수정 (3줄 추가)**
- `APP_PATCH.js`의 `[2]` 코드 참고
- app.js 약 616번째 줄 `_trackEvent` 함수 내부 끝에 삽입

**③ vercel.json CSP 업데이트**
- `APP_PATCH.js`의 `[3]` 참고
- connect-src에 대시보드 URL 추가

### 2-2. 변경 사항 요약
```diff
// app.js top
+ const YB_BEACON_URL = 'https://YOUR-DASHBOARD.vercel.app/api/beacon';
+ const YB_SID = ...;
+ function ybBeacon(payload) { ... }

// _trackEvent 함수 내부
  localStorage.setItem('beta_events', JSON.stringify(events));
+ if (name === 'measurement_complete') ybBeacon({ type: 'measurement_complete', category: props?.category, score: props?.score });
+ if (name === 'app_open')             ybBeacon({ type: 'app_open' });
+ if (name === 'page_view')            ybBeacon({ type: 'page_view', page: props?.page });
```

---

## 3단계: 대시보드 접속

배포 후 `https://YOUR-DASHBOARD.vercel.app/admin` 접속
- 초기 비밀번호: `youngbutton2026` (설정에서 변경)

---

## 수집 데이터 명세 (개인정보 없음)

| 필드 | 설명 | 예시 |
|------|------|------|
| `type` | 이벤트 종류 | `measurement_complete` |
| `category` | 측정 카테고리 | `face`, `balance`, `mood` |
| `score` | 측정 점수 (0-100) | `78` |
| `sid` | 익명 세션ID | `yb-lp4k2x-a8f2` |
| `t` | 타임스탬프 (ms) | `1718150000000` |
| `ua_short` | 기기 타입 (40자) | `iPhone; CPU iPhone OS 18` |
| `region` | 국가 코드 | `KR` |

**수집하지 않는 정보:** 이름, 전화번호, 위치, 측정 원시값(hr/rmssd 등), IP 주소

---

## B2B 납품 시 활용

### 기관별 전용 URL 발급
```
보건소A: https://app.youngbutton.kr?org=gangnam-gu-health
복지관B: https://app.youngbutton.kr?org=jungrang-welfare
```
- `org` 파라미터를 비콘에 포함시켜 기관별 측정 현황 분리 가능

### 관리자 API
```bash
# 30일 집계 데이터 조회
GET /api/beacon?days=30&token=yb-admin-2026

# 응답
{
  "ok": true,
  "daily": [{ "date": "2026-06-12", "measurements": 142, "users": 89 }, ...],
  "totals": { "measurements": 4230, "sessions": 1820 },
  "categories": { "face": 1840, "balance": 620, "mood": 890, ... }
}
```

---

## 비용 예상 (Vercel 기준)

| 항목 | 무료 티어 | 예상 사용량 |
|------|----------|------------|
| Serverless Function 호출 | 100만회/월 | 측정 100명/일 = 3,000회/월 ✅ |
| KV 읽기/쓰기 | 30만회/월 | 약 10만회/월 ✅ |
| 대역폭 | 100GB/월 | ~1GB/월 ✅ |
| **월 비용** | **$0** | 소규모 무료 운영 가능 |

사용자 1,000명/일 초과 시 Vercel Pro ($20/월) 권장
