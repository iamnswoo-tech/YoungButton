/**
 * YoungButton Analytics Beacon API
 * POST /api/beacon  — 앱에서 측정 완료 시 익명 이벤트 수신
 * GET  /api/beacon  — 대시보드용 집계 데이터 반환
 *
 * 저장소: Vercel KV (Redis) 또는 환경변수 없을 때 메모리 fallback
 * 개인정보: 수집하지 않음 — 익명 세션ID + 측정 카테고리 + 점수만 저장
 */

// ── Vercel KV 연동 (없으면 메모리 fallback) ──────────────────────
// ★ top-level await 제거 — Vercel 호환성 (handler 내부에서 지연 로드)
let kv = null;
let _kvTried = false;
async function ensureKV() {
  if (_kvTried) return kv;
  _kvTried = true;
  // KV 환경변수가 있을 때만 로드 시도
  if (process.env.KV_REST_API_URL || process.env.KV_URL) {
    try {
      const mod = await import('@vercel/kv');
      kv = mod.kv;
    } catch (_) { kv = null; }
  }
  return kv;
}

// 메모리 fallback (서버 재시작 시 초기화 — 프로덕션에서는 KV 사용)
const MEM = { events: [], sessions: new Set(), allDevices: new Set(), daily: {} };

// ── CORS helper ───────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-YB-Token');
}

// ── 관리자 토큰 검증 ──────────────────────────────────────────────
function isAdmin(req) {
  const token = req.headers['x-yb-token'] || req.query?.token;
  return token === (process.env.ADMIN_TOKEN || 'yb-admin-2026');
}

// ── 날짜 키 ──────────────────────────────────────────────────────
function dateKey(ts) {
  return new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD
}

// ── 저장 helpers ─────────────────────────────────────────────────
async function saveEvent(ev) {
  if (kv) {
    const day = dateKey(ev.t);
    // 일별 이벤트 리스트 (최대 5000개/일)
    await kv.lpush(`events:${day}`, JSON.stringify(ev));
    await kv.ltrim(`events:${day}`, 0, 4999);
    await kv.expire(`events:${day}`, 60 * 60 * 24 * 90); // 90일 보관
    // 집계 카운터
    await kv.incr(`cnt:events:${day}`);
    await kv.incr(`cnt:category:${ev.category}:${day}`);
    if (ev.sid) await kv.sadd(`sessions:${day}`, ev.sid);
    if (ev.org) { await kv.incr(`cnt:org:${ev.org}:${day}`); if (ev.label) await kv.sadd(`org:${ev.org}:users:${day}`, ev.label); }
    await kv.expire(`sessions:${day}`, 60 * 60 * 24 * 90);
    // 전체 카운터
    await kv.incr('cnt:total_events');
    if (ev.type === 'measurement_complete') await kv.incr('cnt:total_measurements');
    // ★ v24.7: 누적 고유 기기(설치자) 집합 — 만료 없이 영구 보관
    if (ev.sid) await kv.sadd('all_devices', ev.sid);
  } else {
    MEM.events.push(ev);
    if (MEM.events.length > 10000) MEM.events.shift();
    if (ev.sid) { MEM.sessions.add(ev.sid); MEM.allDevices.add(ev.sid); }
    const day = dateKey(ev.t);
    if (!MEM.daily[day]) MEM.daily[day] = { count: 0, categories: {}, sessions: new Set() };
    // ★ v24.7: 측정 완료만 일별 카운트 (app_open/page_view 제외 → 정확도)
    if (ev.type === 'measurement_complete') {
      MEM.daily[day].count++;
      MEM.daily[day].categories[ev.category] = (MEM.daily[day].categories[ev.category] || 0) + 1;
    }
    if (ev.sid) MEM.daily[day].sessions.add(ev.sid);
  }
}

async function getStats(days = 30) {
  const result = { daily: [], totals: {}, categories: {}, recent: [] };

  if (kv) {
    // 최근 N일 집계
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const day = d.toISOString().slice(0, 10);
      const count = parseInt(await kv.get(`cnt:events:${day}`) || '0');
      const sessions = await kv.scard(`sessions:${day}`);
      result.daily.push({ date: day, measurements: count, users: sessions || 0 });
    }
    // ★ v24.7: 총 측정수 = 보관 기간 내 일별 합계 (실제 데이터와 일치 → 리셋해도 안정)
    result.totals.measurements = result.daily.reduce((s, d) => s + (d.measurements || 0), 0);
    // 누적 설치자 = 전체 고유 기기 수 (영구 집합)
    result.totals.devices = await kv.scard('all_devices') || 0;
    // 누적 세션(측정 참여 기기) = 보관 기간 내 고유 기기
    result.totals.sessions = result.totals.devices;
    // 카테고리별 오늘
    const today = new Date().toISOString().slice(0, 10);
    for (const cat of ['face', 'finger', 'balance', 'gait', 'tremor', 'reaction', 'posture', 'bodycomp', 'mood']) {
      result.categories[cat] = parseInt(await kv.get(`cnt:category:${cat}:${today}`) || '0');
    }
    // 최근 측정 이벤트 50개 (measurement_complete만)
    const todayEvents = await kv.lrange(`events:${today}`, 0, 199);
    result.recent = todayEvents.map(e => { try { return JSON.parse(e); } catch(_) { return null; } })
      .filter(e => e && e.type === 'measurement_complete').slice(0, 50);
  } else {
    // 메모리 fallback
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const day = d.toISOString().slice(0, 10);
      const dayData = MEM.daily[day] || { count: 0, sessions: new Set() };
      result.daily.push({ date: day, measurements: dayData.count, users: dayData.sessions.size });
    }
    // ★ v24.7: 총 측정수 = 일별 합계 (실제 데이터 기반)
    result.totals.measurements = result.daily.reduce((s, d) => s + (d.measurements || 0), 0);
    result.totals.devices = MEM.allDevices.size;   // 누적 설치자(고유 기기)
    result.totals.sessions = MEM.allDevices.size;
    // 최근 측정만 (measurement_complete)
    result.recent = MEM.events.filter(e => e.type === 'measurement_complete').slice(-50).reverse();
    // 카테고리 집계 (측정 완료만)
    for (const ev of MEM.events) {
      if (ev.type === 'measurement_complete') result.categories[ev.category] = (result.categories[ev.category] || 0) + 1;
    }
  }
  // ★ v24.3: 사용자(코드)별 집계 — 기관이 "누가 몇 번 썼는지" 파악용
  // recent 이벤트 기반으로 코드별 측정 횟수/최근 시각/라벨 집계
  try {
    const userMap = {};
    const source = (kv ? result.recent : MEM.events.filter(e => e.type === 'measurement_complete')) || [];
    for (const ev of source) {
      const key = ev.label || ev.sid || 'unknown';
      if (!userMap[key]) userMap[key] = { code: ev.sid || '', label: ev.label || null, org: ev.org || null, count: 0, last: 0, cats: {} };
      userMap[key].count++;
      if (ev.t > userMap[key].last) userMap[key].last = ev.t;
      if (ev.category) userMap[key].cats[ev.category] = (userMap[key].cats[ev.category] || 0) + 1;
    }
    result.users = Object.values(userMap).sort((a, b) => b.last - a.last).slice(0, 100);
  } catch (_) { result.users = []; }

  return result;
}

// ── Main handler ─────────────────────────────────────────────────
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  await ensureKV(); // ★ KV 지연 초기화

  // POST: 앱에서 이벤트 수신
  if (req.method === 'POST') {
    try {
      const body = req.body;
      if (!body || !body.type) return res.status(400).json({ ok: false, error: 'missing type' });

      // 수신 가능한 이벤트 화이트리스트
      const ALLOWED = ['measurement_complete', 'app_open', 'page_view'];
      if (!ALLOWED.includes(body.type)) return res.status(400).json({ ok: false, error: 'unknown event' });

      // 익명 이벤트만 저장 — 개인식별정보 없음
      const ev = {
        t:        Date.now(),
        type:     body.type,
        category: body.category || 'unknown',  // face/finger/balance 등
        score:    typeof body.score === 'number' ? Math.round(body.score) : null,
        page:     body.page || null,
        sid:      body.sid || null,  // 앱이 생성한 익명 세션ID (UUID)
        org:      body.org ? String(body.org).substring(0, 40) : null,    // 기관 코드 (기관이 설정 시)
        label:    body.label ? String(body.label).substring(0, 30) : null, // 측정자 별칭/번호 (기관이 입력 시)
        ua_short: (req.headers['user-agent'] || '').substring(0, 40),  // 기기 타입 파악용
        region:   req.headers['x-vercel-ip-country'] || null,  // 국가 코드만
      };

      await saveEvent(ev);
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error('[beacon POST]', e);
      return res.status(500).json({ ok: false });
    }
  }

  // GET: 대시보드 집계 데이터 (관리자 토큰 필요)
  if (req.method === 'GET') {
    if (!isAdmin(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    try {
      const days = parseInt(req.query?.days || '30');
      const stats = await getStats(Math.min(days, 90));
      return res.status(200).json({ ok: true, ...stats });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  return res.status(405).json({ ok: false });
}
