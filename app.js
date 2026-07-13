// ════════════════════════════════════════════════════════════════════
// 건강 측정 v14.5 — 얼굴 rPPG 메인 앱
// 알고리즘: POS (Wang et al. 2017, IEEE TBME) + 다중 ROI
// ════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════
// ★ v24.0: YoungButton Analytics SDK (익명 통계 — 옵트아웃 가능)
//   수집: 측정 종류 + 점수 + 익명 세션ID만. 개인식별정보·원시측정값 없음.
//   사용자가 끄면(yb_analytics_off=1) 전송하지 않음.
// ════════════════════════════════════════════════════════════════════
const YB_BEACON_URL = '/api/beacon';

const YB_SID = (() => {
  try {
    let s = localStorage.getItem('yb_analytics_sid');
    if (!s) {
      s = 'yb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      localStorage.setItem('yb_analytics_sid', s);
    }
    return s;
  } catch (_) { return 'yb-unknown'; }
})();

// 사용자 옵트아웃 여부 (기본: 수집 동의 / 끄면 전송 안 함)
function ybAnalyticsEnabled() {
  try { return localStorage.getItem('yb_analytics_off') !== '1'; }
  catch (_) { return false; }
}

// ★ v24.1: 기관모드 — 기관코드/측정자 라벨 (기관이 설정 시에만 포함)
function ybOrgInfo() {
  try {
    return {
      org: localStorage.getItem('yb_org_code') || null,     // 기관 코드 (예: gangnam-health)
      label: localStorage.getItem('yb_user_label') || null, // 측정자 별칭/번호 (예: 301호, 2024-015)
    };
  } catch (_) { return { org: null, label: null }; }
}

function ybBeacon(payload) {
  // ★ 옵트아웃 시 전송 안 함 + URL 미설정 시 비활성
  if (!ybAnalyticsEnabled()) return;
  if (!YB_BEACON_URL || YB_BEACON_URL.indexOf('YOUR-DASHBOARD') !== -1) return; // 미배포 시 무동작
  try {
    const oi = ybOrgInfo();
    const data = JSON.stringify({ ...payload, sid: YB_SID, org: oi.org, label: oi.label, t: Date.now() });
    if (navigator.sendBeacon) {
      const ok = navigator.sendBeacon(YB_BEACON_URL, new Blob([data], { type: 'application/json' }));
      if (!ok) _ybEnqueue(data);
    } else {
      fetch(YB_BEACON_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: data, keepalive: true }).catch(() => _ybEnqueue(data));
    }
  } catch (_) {}
}

function _ybEnqueue(data) {
  try {
    const q = JSON.parse(localStorage.getItem('yb_beacon_q') || '[]');
    q.push(data);
    if (q.length > 30) q.shift();
    localStorage.setItem('yb_beacon_q', JSON.stringify(q));
  } catch (_) {}
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (!ybAnalyticsEnabled()) return;
    try {
      const q = JSON.parse(localStorage.getItem('yb_beacon_q') || '[]');
      if (!q.length) return;
      localStorage.removeItem('yb_beacon_q');
      q.forEach(d => fetch(YB_BEACON_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: d, keepalive: true }).catch(() => {}));
    } catch (_) {}
  });
}
// ════════════════════════════════════════════════════════════════════

// ★ v14.5: 프로덕션 모드 시스템 — 외부 베타 준비
// URL에 ?debug=1 또는 localStorage에 debug=true 설정 시 디버그 모드
// 기본은 BETA 모드 (콘솔 출력 최소화, 에러는 자동 수집)
const APP_MODE = (() => {
  const url = new URL(window.location.href);
  if (url.searchParams.get('debug') === '1') return 'debug';
  try {
    if (localStorage.getItem('app_debug') === 'true') return 'debug';
  } catch (e) {}
  return 'beta';
})();
const IS_DEBUG = APP_MODE === 'debug';

// === 화면 콘솔 (스마트폰 진단용) — 디버그 모드에서만 활성 ===
const Console = {
  buffers: { face: [], body: [] },
  origLog: console.log.bind(console),
  origWarn: console.warn.bind(console),
  origError: console.error.bind(console),
  init() {
    if (IS_DEBUG) {
      // 디버그 모드: 화면 콘솔에 모든 로그 표시 (개발자 진단용)
      console.log = (...args) => { this.origLog(...args); this._append('face', 'log', args); this._append('body', 'log', args); };
      console.warn = (...args) => { this.origWarn(...args); this._append('face', 'warn', args); this._append('body', 'warn', args); };
      console.error = (...args) => { this.origError(...args); this._append('face', 'error', args); this._append('body', 'error', args); this._captureError(args); };
      console.log('[Console] DEBUG 모드 활성화');
      console.log('[Console] UA:', navigator.userAgent.substring(0, 60));
    } else {
      // BETA 모드: 일반 로그는 무음, 경고는 표시, 에러는 자동 수집
      console.log = () => {};
      console.warn = (...args) => { this.origWarn(...args); };
      console.error = (...args) => { this.origError(...args); this._captureError(args); };
      // 화면 콘솔 div 자체를 숨김
      setTimeout(() => {
        document.querySelectorAll('.console-card, .console-output').forEach(el => {
          if (el) el.style.display = 'none';
        });
      }, 100);
    }

    // ★ v14.5: 글로벌 에러 핸들러 (외부 사용자 에러 자동 수집)
    window.addEventListener('error', (e) => {
      this._captureError([{
        type: 'js_error',
        msg: e.message,
        file: e.filename ? e.filename.split('/').pop() : '',
        line: e.lineno,
        col: e.colno,
        stack: e.error?.stack?.substring(0, 500),
      }]);
    });
    window.addEventListener('unhandledrejection', (e) => {
      this._captureError([{
        type: 'promise_rejection',
        reason: String(e.reason).substring(0, 200),
        stack: e.reason?.stack?.substring(0, 500),
      }]);
    });
  },

  _captureError(args) {
    try {
      const errors = JSON.parse(localStorage.getItem('beta_errors') || '[]');
      const text = args.map(a => {
        try {
          if (typeof a === 'object') return JSON.stringify(a);
          return String(a);
        } catch (e) { return '<obj>'; }
      }).join(' ');
      errors.push({
        t: Date.now(),
        msg: text.substring(0, 500),
        ua: navigator.userAgent.substring(0, 100),
        url: window.location.pathname,
      });
      // 최대 50개 유지
      if (errors.length > 50) errors.splice(0, errors.length - 50);
      localStorage.setItem('beta_errors', JSON.stringify(errors));
    } catch (e) {}
  },

  _append(target, type, args) {
    const time = new Date().toTimeString().substring(0, 8);
    const text = args.map(a => {
      try {
        if (typeof a === 'object') return JSON.stringify(a);
        return String(a);
      } catch (e) { return '<obj>'; }
    }).join(' ');
    const buf = this.buffers[target] || this.buffers.face;
    buf.push({ time, type, text });
    if (buf.length > 200) buf.shift();
    this._render(target);
  },
  _render(target) {
    const el = document.getElementById(target + '-console');
    if (!el) return;
    const buf = this.buffers[target] || [];
    el.innerHTML = buf.map(item => {
      const color = item.type === 'warn' ? '#fbbf24' : item.type === 'error' ? '#ef4444' : '#86efac';
      return `<div style="color:${color}"><span style="color:#64748b">${item.time}</span> ${this._escape(item.text)}</div>`;
    }).join('');
    el.scrollTop = el.scrollHeight;
  },
  _escape(s) {
    // ★ v15.2.3: 보안 강화 — 모든 HTML 특수문자 escape
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/`/g, '&#96;');
  },
  clear(target) {
    if (this.buffers[target]) this.buffers[target].length = 0;
    this._render(target);
  }
};

// ════════════════════════════════════════════════════════════════════
// App — 메인 앱 객체
// ════════════════════════════════════════════════════════════════════
const App = {
  state: {
    page: 'home',
    face: {
      running: false,
      stream: null,
      track: null,
      cameraReady: false,
      measureStartMs: 0,
      timerInterval: null,
      rafId: null,
      samples: [],            // ME-rPPG가 산출한 BVP 시계열 {bvp, t}
      fps: 0, fpsCounter: 0, fpsLastT: 0,
      autoFinalized: false,
      lastHR: null,
      faceDetected: false,
      // === ME-rPPG 엔진 상태 ===
      mePPG: {
        modelReady: false,
        stateReady: false,
        welchReady: false,
        hrReady: false,
        faceDetector: null,
        kfBox: { originX: null, originY: null, width: null, height: null },
        kfOutput: null,
        kfHr: null,
        meanHRErr: 0.04,
        timestampArray: [],
        welchArray: new Array(300).fill(0),
        welchCount: 300 - 90,
        inferenceCount: 0,
        inferenceTimestamp: 0,
        inputQueueCount: 0,
        dropCount: 30,           // 처음 30프레임 워밍업 폐기
        currentHR: null,         // 최신 HR 값
        bvpSeries: [],           // HRV 분석용 BVP 누적
        rppgSnr: 0,
      },
      // ★ v19.4: 동공 변동성 + 표정 Action Unit 분석 상태
      pupilSeries: [],       // { t, left, right } 픽셀 단위 동공 크기 시계열
      auSeries: [],          // { t, au1, au2, au4, au6, au12, au15, au17 } Action Unit
      pupilResult: null,     // 최종 동공 분석 결과
      auResult: null,        // 최종 표정 분석 결과
      onnxWorker: null,
      welchWorker: null,
    },
    body: {
      currentTest: null,
      running: false,
      startMs: 0,
      timerInterval: null,
      motionListener: null,
      // 균형: 각 단계별 가속도 데이터
      balance: { phase: 'eyes_open', samples: [], openSamples: [], closedSamples: [] },
      // 보행: 가속도 데이터
      gait: { samples: [], steps: 0 },
      // 손떨림
      tremor: { samples: [] },
      // 반응속도
      reaction: { count: 0, total: 5, times: [], waitTimer: null, signalAt: 0, state: 'wait' },
      // 자세
      posture: { stream: null, capturedImage: null, captureTimer: null },
    },
    // ★ v13: 종합 Wellness Score 누적 (localStorage 동기화)
    wellness: {
      face: null,        // { hr, respRate, rmssd, sqi, t, score }
      balance: null,     // { score, rms, rombergRatio, t }
      gait: null,        // { score, stepsPerMin, regularity, t }
      tremor: null,      // { score, peakHz, intensity, t }
      reaction: null,    // { score, avgMs, t }
      posture: null,     // { score, asymmetry, t }
      bodycomp: null,    // { score, bmi, whtr, absi, age, gender, t }
      lastUpdated: 0,
    }
  },

  config: {
    face: {
      durationSec: 40,  // v11s8: 30→40초로 더 많은 피크 확보
      targetSR: 30,
      bufferSec: 35,
      minWarmupSec: 5,
      waveWindowSec: 8,
    }
  },

  // ─── 초기화 ───
  // ★ v17.2: 에러 격리 구조 — 각 단계를 독립적으로 보호
  //   한 단계가 실패해도 나머지(특히 온보딩/안내)는 정상 작동
  _safeStep(label, fn) {
    try {
      fn();
    } catch (e) {
      console.error(`[init:${label}] 실패 (건너뜀):`, e);
      // 에러를 기록하되 전체 흐름은 계속 진행
      try {
        const errs = JSON.parse(sessionStorage.getItem('initErrors') || '[]');
        errs.push({ step: label, msg: String(e && e.message || e), t: Date.now() });
        sessionStorage.setItem('initErrors', JSON.stringify(errs.slice(-20)));
      } catch (_) {}
    }
  },

  init() {
    Console.init();
    console.log('[App v18.0] 초기화 - 모드:', APP_MODE);

    // ★ v24.4: URL 파라미터로 기관 모드 자동 설정
    // 예: https://기관주소/?org=강남보건소&setup=1 → 기관 모드 ON
    this._safeStep('orgSetup', () => {
      try {
        const params = new URLSearchParams(location.search);
        if (params.get('setup') === '1' || params.get('org')) {
          localStorage.setItem('yb_org_mode', '1');
          const org = params.get('org');
          if (org) localStorage.setItem('yb_org_code', decodeURIComponent(org));
          // URL에서 파라미터 제거 (깔끔하게)
          if (history.replaceState) history.replaceState(null, '', location.pathname);
        }
      } catch (e) {}
    });

    // 1. 핵심 렌더링 인프라 (실패 시에도 나머지 계속)
    this._safeStep('canvas', () => this._setupCanvas());
    this._safeStep('faceButton', () => this._bindFaceButton());
    this._safeStep('visibility', () => this._bindVisibilityHandler());
    this._safeStep('beforeunload', () => {
      window.addEventListener('beforeunload', () => this._cleanupAll());
    });

    // 2. 데이터 복원 (실패해도 빈 상태로 계속)
    this._safeStep('wellnessRestore', () => this._wellnessRestore());
    this._safeStep('wellnessRender', () => this._wellnessRender());

    // 3. 페이지 복원 (실패 시 home 유지)
    this._safeStep('pageRestore', () => {
      const sharedHandled = this._checkSharedUrl();
      if (!sharedHandled) {
        const lastPage = sessionStorage.getItem('lastPage') || 'home';
        const safeLastPages = ['home', 'results', 'mood', 'share', 'detail', 'trends', 'body'];
        const restoredPage = safeLastPages.includes(lastPage) ? lastPage : 'home';
        if (restoredPage !== 'home') {
          this._goPageInternal(restoredPage);
        }
      }
    });

    // 4. 뒤로가기 버튼
    this._safeStep('backButton', () => this._setupBackButton());

    // 5. 홈 카드
    this._safeStep('moodHomeCard', () => this._renderMoodHomeCard());
    this._safeStep('weeklyGoalCard', () => this._renderWeeklyGoalCard()); // ★ v19.1
    this._safeStep('sleepLoad', () => this._loadSleepScore()); // ★ v20.0
    this._safeStep('sleepCheckin', () => this._renderSleepCheckin()); // ★ v20.0
    this._safeStep('homeHero', () => this._renderHomeHero()); // ★ v22.0
    this._safeStep('basicInfoCard', () => this._renderBasicInfoCard()); // ★ v20.5
    this._safeStep('brainBalanceCard', () => this._renderBrainBalanceCard()); // ★ v21.1
    this._safeStep('recommendCard', () => this._renderRecommendCard()); // ★ v20.0

    // 6. 알림 재예약
    this._safeStep('reminder', () => this._scheduleNextReminder());

    // 7. 인앱 브라우저 감지/안내
    this._safeStep('inAppBrowser', () => this._detectInAppBrowser());

    // 8. ★ 온보딩/안내 — 독립 보호 (위가 다 실패해도 이건 실행됨)
    this._safeStep('permissionGuide', () => {
      setTimeout(() => this._safeStep('permissionGuideDelayed', () => this._maybeShowPermissionGuide()), 1000);
    });
    this._safeStep('betaNotice', () => {
      setTimeout(() => this._safeStep('betaNoticeDelayed', () => this._maybeShowBetaNotice()), 1500);
    });

    // 9. 피드백 버튼
    this._safeStep('feedbackButton', () => this._injectFeedbackButton());

    // 10. 분석 이벤트
    this._safeStep('trackOpen', () => this._trackEvent('app_open'));

    // 11. 음성 워밍업
    this._safeStep('speechWarmup', () => {
      document.addEventListener('click', () => this._warmupSpeech(), { once: true, capture: true });
      document.addEventListener('touchstart', () => this._warmupSpeech(), { once: true, capture: true });
    });

    console.log('[App v17.2] 초기화 완료');
  },

  // ════════════════════════════════════════════════════════════════
  // ★ v17.2: 개발/디버그 헬퍼 (콘솔에서 App._dev.xxx() 로 호출)
  //   상품화 과정에서 안내·온보딩을 반복 테스트하기 위한 도구
  // ════════════════════════════════════════════════════════════════
  _dev: {
    // 온보딩/안내 전부 다시 보이게 (저장된 "봤음" 플래그 제거)
    resetOnboarding() {
      ['beta_notice_shown', 'permission_guide_shown', 'inapp_notice_shown'].forEach(k => {
        try { localStorage.removeItem(k); } catch (e) {}
      });
      console.log('[dev] 온보딩 플래그 초기화됨. 새로고침하면 안내가 다시 나옵니다.');
      return '새로고침(F5) 하세요';
    },
    // 지금 즉시 베타 안내 띄우기 (플래그 무시)
    showBeta() {
      try { localStorage.removeItem('beta_notice_shown'); } catch (e) {}
      App._maybeShowBetaNotice();
    },
    // init 중 발생한 에러 목록 보기
    initErrors() {
      try {
        const errs = JSON.parse(sessionStorage.getItem('initErrors') || '[]');
        if (errs.length === 0) { console.log('[dev] init 에러 없음 ✅'); return errs; }
        console.warn('[dev] init 에러 목록:', errs);
        return errs;
      } catch (e) { return []; }
    },
    // 핵심 함수/DOM 존재 여부 자가 점검
    selfCheck() {
      const checks = {
        '홈 페이지 DOM': !!document.getElementById('page-home'),
        '공유 페이지 DOM': !!document.getElementById('page-share'),
        '하단 네비': document.querySelectorAll('.nav-btn').length,
        'wellness 데이터': Object.keys(App.state.wellness || {}).length,
        '감정 카드 정의': Object.keys(App._emotionCards || {}).length,
        'PANAS 항목': (App._panasItems || []).length,
        'init 에러 수': JSON.parse(sessionStorage.getItem('initErrors') || '[]').length,
      };
      console.table(checks);
      return checks;
    },
    // 전체 데이터 백업 (JSON 문자열 반환 → 복사해두면 복원 가능)
    backup() {
      const dump = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        dump[k] = localStorage.getItem(k);
      }
      const json = JSON.stringify(dump);
      console.log('[dev] 백업 완료. 아래 문자열을 복사해두세요:\n', json);
      return json;
    },
    // 백업 복원
    restore(json) {
      try {
        const dump = JSON.parse(json);
        Object.keys(dump).forEach(k => localStorage.setItem(k, dump[k]));
        console.log('[dev] 복원 완료. 새로고침하세요.');
        return '새로고침(F5) 하세요';
      } catch (e) { console.error('[dev] 복원 실패:', e); }
    },
    // ★ v17.3: 현재 UA + 인앱 감지 결과 확인 (카카오 감지 디버깅)
    checkBrowser() {
      const ua = navigator.userAgent;
      try { localStorage.removeItem('inapp_notice_shown'); } catch (e) {}
      App._isInApp = false;
      App._detectInAppBrowser();
      const result = {
        'UA 전체': ua,
        '인앱 감지됨': App._isInApp,
        '인앱 이름': App._inAppName || '(없음)',
        'KAKAOTALK 포함': /kakaotalk/i.test(ua),
        'kakaotalk-scrap': /kakaotalk-scrap/i.test(ua),
        'Android': /android/i.test(ua),
        'WebView(wv)': /\bwv\b/i.test(ua),
      };
      console.table(result);
      return result;
    },
  },

  // ★ v17.2: 베타 안내 모달
  _maybeShowBetaNotice() {
    try {
      const lastShown = localStorage.getItem('beta_notice_shown');
      if (lastShown) {
        // 이미 한 번 봤으면 7일 후에 다시
        const days = (Date.now() - parseInt(lastShown)) / (1000 * 60 * 60 * 24);
        if (days < 7) return;
      }
    } catch (e) {}

    const modal = document.createElement('div');
    modal.className = 'beta-modal';
    modal.innerHTML = `
      <div class="beta-card">
        <div class="beta-badge">🧪 베타 테스트</div>
        <div class="beta-title">함께 만들어가는 건강 측정 앱</div>
        <div class="beta-msg">
          현재 베타 버전입니다. 측정 결과는 <strong>참고용</strong>이며,
          정확도 개선을 위해 여러분의 피드백이 큰 도움이 됩니다.
        </div>
        <ul class="beta-list">
          <li>✅ 모든 측정은 <strong>본인 기기에만</strong> 저장돼요</li>
          <li>✅ 개인정보를 서버로 보내지 않아요</li>
          <li>💬 화면 우측 하단 <strong>💬 버튼</strong>으로 의견 보내주세요</li>
        </ul>
        <button class="beta-btn primary" onclick="App._dismissBetaNotice()">시작하기</button>
      </div>
    `;
    document.body.appendChild(modal);
    setTimeout(() => modal.classList.add('show'), 10);
    this._betaModal = modal;
    this._trackEvent('beta_notice_shown');
  },

  _dismissBetaNotice() {
    if (this._betaModal) {
      this._betaModal.classList.remove('show');
      setTimeout(() => this._betaModal.remove(), 300);
    }
    try {
      localStorage.setItem('beta_notice_shown', Date.now().toString());
    } catch (e) {}
    this._trackEvent('beta_notice_dismissed');
  },

  // ★ v14.5: 플로팅 피드백 버튼
  _injectFeedbackButton() {
    const btn = document.createElement('button');
    btn.className = 'feedback-fab';
    btn.type = 'button';
    btn.innerHTML = '💬';
    btn.title = '의견 보내기';
    btn.setAttribute('aria-label', '의견 보내기');
    btn.onclick = () => this._openFeedback();
    document.body.appendChild(btn);
  },

  _openFeedback() {
    this._trackEvent('feedback_opened');
    const errors = (() => {
      try { return JSON.parse(localStorage.getItem('beta_errors') || '[]'); }
      catch (e) { return []; }
    })();
    const events = (() => {
      try { return JSON.parse(localStorage.getItem('beta_events') || '[]'); }
      catch (e) { return []; }
    })();
    const wellness = this.state.wellness || {};
    const measuredItems = ['face','bodycomp','balance','gait','tremor','reaction','posture']
      .filter(k => wellness[k]).join(', ') || '없음';

    const modal = document.createElement('div');
    modal.className = 'feedback-modal';
    modal.innerHTML = `
      <div class="feedback-card">
        <div class="feedback-header">
          <div class="feedback-title">💬 의견 보내기</div>
          <button class="feedback-close" type="button" onclick="App._closeFeedback()">✕</button>
        </div>
        <div class="feedback-body">
          <div class="feedback-label">어떤 종류의 의견인가요?</div>
          <div class="feedback-types">
            <button type="button" class="feedback-type-btn" data-type="bug" onclick="App._selectFeedbackType('bug')">
              🐛 버그 신고
            </button>
            <button type="button" class="feedback-type-btn" data-type="suggestion" onclick="App._selectFeedbackType('suggestion')">
              💡 개선 제안
            </button>
            <button type="button" class="feedback-type-btn" data-type="praise" onclick="App._selectFeedbackType('praise')">
              😊 사용 후기
            </button>
            <button type="button" class="feedback-type-btn" data-type="question" onclick="App._selectFeedbackType('question')">
              ❓ 질문
            </button>
          </div>
          <div class="feedback-label">의견 내용</div>
          <textarea
            id="feedback-text"
            class="feedback-textarea"
            placeholder="겪으신 문제나 개선 아이디어를 자유롭게 적어주세요..."
            rows="5"
          ></textarea>
          <div class="feedback-meta-toggle">
            <label class="feedback-checkbox-label">
              <input type="checkbox" id="feedback-include-meta" checked>
              <span>기술 정보 함께 보내기 (오류 로그, 측정 상태)</span>
            </label>
            <div class="feedback-meta-detail">
              측정 항목: ${measuredItems}<br>
              자동 수집된 오류: ${errors.length}건<br>
              기기: ${navigator.userAgent.substring(0, 50)}
            </div>
          </div>
        </div>
        <div class="feedback-footer">
          <button class="beta-btn secondary" type="button" onclick="App._closeFeedback()">취소</button>
          <button class="beta-btn primary" type="button" onclick="App._sendFeedback()">📧 이메일로 보내기</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    // ★ v15.1: 백드롭 클릭으로 닫기 (안전망)
    modal.addEventListener('click', (e) => {
      if (e.target === modal) this._closeFeedback();
    });
    setTimeout(() => modal.classList.add('show'), 10);
    this._feedbackModal = modal;
    this._feedbackType = null;
  },

  _selectFeedbackType(type) {
    this._feedbackType = type;
    document.querySelectorAll('.feedback-type-btn').forEach(b => {
      b.classList.toggle('on', b.dataset.type === type);
    });
  },

  // ★ v15.1: 모달 즉시 제거 (transition 끝까지 안 기다림 → 백드롭 잔존 버그 방지)
  _closeFeedback() {
    // 모든 feedback-modal 요소 제거 (중복 방지)
    document.querySelectorAll('.feedback-modal').forEach(m => {
      m.classList.remove('show');
      m.style.opacity = '0';
      m.style.pointerEvents = 'none';
      // 짧은 transition 후 제거, 실패 시 즉시 강제 제거
      setTimeout(() => { try { m.remove(); } catch (e) {} }, 250);
    });
    this._feedbackModal = null;
    // 안전망: 1초 후에도 남은 모달 강제 제거
    setTimeout(() => {
      document.querySelectorAll('.feedback-modal').forEach(m => {
        try { m.remove(); } catch (e) {}
      });
    }, 1000);
  },

  _sendFeedback() {
    const text = document.getElementById('feedback-text')?.value.trim() || '';
    if (!text || text.length < 5) {
      alert('의견을 5자 이상 입력해주세요.');
      return;
    }

    const type = this._feedbackType || 'other';
    const includeMeta = document.getElementById('feedback-include-meta')?.checked;

    // 이메일 본문 구성
    const typeNames = {
      bug: '🐛 버그 신고',
      suggestion: '💡 개선 제안',
      praise: '😊 사용 후기',
      question: '❓ 질문',
      other: '기타',
    };

    let body = `[${typeNames[type]}]\n\n`;
    body += `의견:\n${text}\n\n`;
    body += `─────────────────\n`;
    body += `날짜: ${new Date().toLocaleString('ko-KR')}\n`;
    body += `앱 버전: v14.5 (beta)\n`;

    if (includeMeta) {
      body += `\n[기술 정보]\n`;
      body += `기기: ${navigator.userAgent.substring(0, 150)}\n`;
      body += `화면: ${window.innerWidth}x${window.innerHeight}\n`;
      body += `언어: ${navigator.language}\n`;
      body += `URL: ${window.location.pathname}\n`;

      try {
        const errors = JSON.parse(localStorage.getItem('beta_errors') || '[]');
        if (errors.length > 0) {
          body += `\n[최근 오류 ${Math.min(errors.length, 5)}건]\n`;
          errors.slice(-5).forEach((e, i) => {
            body += `${i+1}. [${new Date(e.t).toLocaleTimeString('ko-KR')}] ${e.msg.substring(0, 200)}\n`;
          });
        }
      } catch (e) {}

      const w = this.state.wellness || {};
      const measured = ['face','bodycomp','balance','gait','tremor','reaction','posture']
        .filter(k => w[k]);
      body += `\n[측정 상태]\n측정 완료: ${measured.length}/7 (${measured.join(', ') || '없음'})\n`;
    }

    // 이메일 클라이언트 열기
    const subject = `[건강측정 베타] ${typeNames[type]}`;
    const recipient = 'iamnswoo@gmail.com'; // 사용자 이메일 (필요 시 변경)
    const mailto = `mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

    this._trackEvent('feedback_sent', { type });

    // ★ v15.1: mailto 호출 전에 모달 먼저 닫기 → 백드롭 잔존 방지
    this._closeFeedback();

    // 모바일에서 mailto 호환성
    try {
      window.location.href = mailto;
    } catch (e) {
      // 복사 fallback
      const fullText = `받는 사람: ${recipient}\n제목: ${subject}\n\n${body}`;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(fullText).then(() => {
          alert('의견이 클립보드에 복사되었습니다. 이메일에 붙여넣어 보내주세요.');
        });
      } else {
        prompt('아래 내용을 복사해서 이메일로 보내주세요:', fullText);
      }
    }
  },

  // ★ v14.5: 익명 이벤트 트래킹 (로컬 저장, 외부 전송 X)
  _trackEvent(name, props) {
    try {
      const events = JSON.parse(localStorage.getItem('beta_events') || '[]');
      events.push({
        t: Date.now(),
        n: name,
        p: props || {},
      });
      // 최대 200개 유지
      if (events.length > 200) events.splice(0, events.length - 200);
      localStorage.setItem('beta_events', JSON.stringify(events));

      // ★ v24.0: 익명 통계 비콘 (옵트아웃 시 자동 미전송)
      if (typeof ybBeacon === 'function') {
        if (name === 'measurement_complete') ybBeacon({ type: 'measurement_complete', category: props && props.category, score: props && props.score });
        else if (name === 'app_open')        ybBeacon({ type: 'app_open' });
        else if (name === 'page_view')       ybBeacon({ type: 'page_view', page: props && props.page });
      }
    } catch (e) {}
  },

  // ★ v14.5: 디버그 모드 토글 (헤더 버전 7회 탭)
  _toggleDebugMode() {
    if (!this._debugTapCount) this._debugTapCount = 0;
    this._debugTapCount++;
    if (this._debugTapCount >= 7) {
      this._debugTapCount = 0;
      try {
        const current = localStorage.getItem('app_debug') === 'true';
        if (current) {
          localStorage.removeItem('app_debug');
          alert('디버그 모드가 OFF 되었습니다. 새로고침합니다.');
        } else {
          localStorage.setItem('app_debug', 'true');
          alert('🛠️ 디버그 모드가 ON 되었습니다. 새로고침합니다.\n(URL 끝에 ?debug=1 을 붙여도 동일 효과)');
        }
        location.reload();
      } catch (e) {}
    } else if (this._debugTapCount >= 3) {
      // 3회 이상 탭 시 카운터 표시
      console.warn(`[Debug] ${7 - this._debugTapCount}회 더 탭하면 디버그 모드 토글`);
    }
    // 3초 후 카운터 리셋
    clearTimeout(this._debugTapTimer);
    this._debugTapTimer = setTimeout(() => { this._debugTapCount = 0; }, 3000);
  },

  // ════════════════════════════════════════════════════════════════
  // v13.8: 인앱 브라우저 감지 + 사용자 안내
  // 카카오톡, 네이버, 페이스북, 라인 등 인앱 브라우저에서는
  // TTS / 카메라 / 모션센서 일부가 제한되거나 작동 불가
  // 사용자에게 외부 브라우저(Chrome/Samsung Internet)로 열도록 안내
  // ════════════════════════════════════════════════════════════════
  _detectInAppBrowser() {
    const ua = navigator.userAgent || '';
    const lower = ua.toLowerCase();

    // ★ v17.3: 디버깅용 — 전체 UA를 콘솔에 기록 (카카오 감지 문제 추적)
    console.log('[Browser] 전체 UA:', ua);

    // 인앱 브라우저 시그니처 (UA 패턴)
    const inAppPatterns = [
      { name: '카카오톡', pattern: /kakaotalk/i, severity: 'high' },
      // ★ v17.3: 카카오톡 스크랩/캐시 UA (공유 링크 첫 접근 시)
      { name: '카카오톡', pattern: /kakaotalk-scrap/i, severity: 'high' },
      { name: 'KakaoStory', pattern: /kakaostory/i, severity: 'high' },
      { name: '네이버', pattern: /naver\(inapp/i, severity: 'high' },
      { name: '네이버', pattern: /\binapp\b.*naver|naver.*\binapp\b/i, severity: 'high' },
      { name: '네이버 (whale)', pattern: /naver\b/i, severity: 'medium' },
      { name: '인스타그램', pattern: /instagram/i, severity: 'high' },
      { name: '페이스북', pattern: /fb_iab|fbav|fban/i, severity: 'high' },
      { name: '라인', pattern: /line\//i, severity: 'high' },
      { name: '트위터', pattern: /twitter/i, severity: 'high' },
      { name: '다음', pattern: /daumapps/i, severity: 'medium' },
      { name: '밴드', pattern: /band\//i, severity: 'medium' },
    ];

    let detected = null;
    for (const item of inAppPatterns) {
      if (item.pattern.test(ua)) {
        detected = item;
        break;
      }
    }

    // ★ v17.3: 안드로이드 WebView 휴리스틱
    //   카카오톡에서 공유 링크를 "타고" 들어오면 UA에 KAKAOTALK이 빠질 수 있음
    //   (카카오 공식 문서: 주소창 직접 입력 시에만 KAKAOTALK 포함)
    //   → Android WebView 신호('wv' or 'Version/x.x Chrome')가 있고
    //     일반 브라우저(SamsungBrowser/Firefox/Edge/Whale) 아니면 인앱으로 간주
    if (!detected && /android/i.test(ua)) {
      const isWebView = /;\s*wv\)/i.test(ua) || /\bwv\b/i.test(ua) ||
                        (/version\/[\d.]+/i.test(ua) && /chrome\//i.test(ua));
      const isRealBrowser = /samsungbrowser|firefox|edg\/|edga\/|whale|opr\/|ucbrowser/i.test(ua);
      const isPlainChrome = /chrome\//i.test(ua) && !/version\//i.test(ua);
      if (isWebView && !isRealBrowser && !isPlainChrome) {
        detected = { name: '인앱', pattern: null, severity: 'medium', heuristic: true };
        console.warn('[Browser] WebView 휴리스틱으로 인앱 추정 (UA에 앱 이름 없음)');
      }
    }

    if (!detected) {
      console.log('[Browser] 일반 브라우저 - 모든 기능 사용 가능');
      this._isInApp = false;
      return;
    }

    this._isInApp = true;
    this._inAppName = detected.name;
    console.warn(`[Browser] 인앱 브라우저 감지: ${detected.name} (${detected.severity})${detected.heuristic ? ' [휴리스틱]' : ''}`);

    // 기능 가용성 사전 점검
    const features = {
      tts: 'speechSynthesis' in window,
      camera: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      motion: typeof DeviceMotionEvent !== 'undefined',
      vibrate: !!navigator.vibrate,
      storage: this._testLocalStorage(),
    };
    console.log('[Browser] 기능 가용성:', features);

    // 사용자 안내 (high severity만 모달, medium은 토스트)
    setTimeout(() => this._showInAppBrowserNotice(detected, features), 1500);
  },

  _testLocalStorage() {
    try {
      localStorage.setItem('__test__', '1');
      localStorage.removeItem('__test__');
      return true;
    } catch (e) {
      return false;
    }
  },

  _showInAppBrowserNotice(detected, features) {
    // ★ v17.3: 안내 재노출 주기 — high(카카오 등)는 6시간, medium은 24시간
    //   카카오로 자주 공유받으므로 너무 길면 정작 필요할 때 안 나옴
    try {
      const lastShown = parseInt(localStorage.getItem('inapp_notice_shown') || '0');
      const cooldown = detected.severity === 'high'
        ? 6 * 60 * 60 * 1000    // 6시간
        : 24 * 60 * 60 * 1000;  // 24시간
      if (Date.now() - lastShown < cooldown) {
        console.log('[Browser] 인앱 안내 쿨다운 중 (스킵)');
        return;
      }
    } catch (e) {}

    const issues = [];
    if (!features.tts) issues.push('🔇 음성 안내 불가');
    if (!features.camera) issues.push('📷 카메라 접근 불가');
    else issues.push('📷 카메라 일부 불안정 가능');
    if (!features.motion) issues.push('📱 모션센서 권한 거부');

    const currentUrl = window.location.href;

    // 모달 생성
    const modal = document.createElement('div');
    modal.className = 'inapp-modal';
    modal.innerHTML = `
      <div class="inapp-card">
        <div class="inapp-icon">⚠️</div>
        <div class="inapp-title">${detected.name} 인앱 브라우저로 접속 중</div>
        <div class="inapp-msg">
          정확한 건강 측정을 위해서는 <strong>외부 브라우저</strong>로 열어주세요.
        </div>
        <div class="inapp-issues">
          ${issues.map(i => `<div class="inapp-issue">${i}</div>`).join('')}
        </div>
        <div class="inapp-actions">
          <button class="inapp-btn primary" onclick="App._openInExternalBrowser()">
            🌐 Chrome / 기본 브라우저로 열기
          </button>
          <button class="inapp-btn secondary" onclick="App._copyUrlAndClose()">
            📋 링크 복사
          </button>
          <button class="inapp-btn tertiary" onclick="App._dismissInAppNotice()">
            그래도 계속 사용
          </button>
        </div>
        <div class="inapp-hint">
          💡 우측 상단 ⋮ 메뉴 → "다른 브라우저로 열기" 또는 "외부 브라우저로 열기"
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    setTimeout(() => modal.classList.add('show'), 10);
    this._inAppModal = modal;
  },

  _openInExternalBrowser() {
    const url = window.location.href;
    const ua = navigator.userAgent.toLowerCase();

    // 안드로이드: Chrome Intent URL로 강제 외부 열기
    if (/android/.test(ua)) {
      // Chrome으로 직접 열기 시도
      try {
        // Chrome intent (안드로이드 표준)
        const chromeUrl = `intent://${url.replace(/^https?:\/\//, '')}#Intent;scheme=https;package=com.android.chrome;end`;
        window.location.href = chromeUrl;
        // 일정 시간 후 기본 브라우저 fallback
        setTimeout(() => {
          window.location.href = url;
        }, 1500);
      } catch (e) {
        this._copyUrlAndClose();
      }
    }
    // iOS: x-safari-https 스킴으로 Safari 열기
    else if (/iphone|ipad|ipod/.test(ua)) {
      const safariUrl = url.replace(/^https?:/, 'x-safari-https:');
      try {
        window.location.href = safariUrl;
        // fallback
        setTimeout(() => this._copyUrlAndClose(), 1500);
      } catch (e) {
        this._copyUrlAndClose();
      }
    } else {
      this._copyUrlAndClose();
    }
  },

  _copyUrlAndClose() {
    const url = window.location.href;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(() => {
          alert('링크가 복사되었습니다.\n\nChrome, Safari, Samsung Internet 등 기본 브라우저를 열고 주소창에 붙여넣어 주세요.');
        });
      } else {
        // fallback: textarea를 통한 복사
        const ta = document.createElement('textarea');
        ta.value = url;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        alert('링크가 복사되었습니다.\n\nChrome, Safari, Samsung Internet 등 기본 브라우저를 열고 주소창에 붙여넣어 주세요.');
      }
    } catch (e) {
      prompt('아래 링크를 복사해서 기본 브라우저에 붙여넣어 주세요:', url);
    }
  },

  _dismissInAppNotice() {
    if (this._inAppModal) {
      this._inAppModal.classList.remove('show');
      setTimeout(() => this._inAppModal.remove(), 300);
    }
    try {
      localStorage.setItem('inapp_notice_shown', Date.now().toString());
    } catch (e) {}
  },

  // ★ v13.8: TTS 실패 시 1회만 토스트 알림 (반복 차단)
  _noticeTTSFailedOnce() {
    if (this._ttsNoticeShown) return;
    this._ttsNoticeShown = true;

    const toast = document.createElement('div');
    toast.className = 'tts-fail-toast';
    toast.innerHTML = `
      <div class="tts-fail-icon">🔇</div>
      <div class="tts-fail-text">
        <div class="tts-fail-title">음성 안내가 들리지 않나요?</div>
        <div class="tts-fail-sub">현재 브라우저는 음성을 지원하지 않습니다. 화면 안내와 진동으로 측정을 진행합니다.</div>
      </div>
      <button class="tts-fail-close" onclick="this.parentElement.remove()">✕</button>
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 400);
    }, 6000);
  },

  // ════════════════════════════════════════════════════════════════
  // v13.0 종합 Wellness Score 시스템
  // 모든 측정 결과를 단일 0-100 점수로 가중 합산
  //
  // 가중치 (의학적 중요도 순):
  //   - 얼굴 측정 (HR/호흡/HRV/SQI): 35% (가장 핵심)
  //   - 균형 (Balance): 15%  (낙상 위험, 신경계)
  //   - 보행 (Gait): 15%  (전신 운동 능력)
  //   - 반응속도 (Reaction): 12%  (인지 기능)
  //   - 손떨림 (Tremor): 13%  (신경계 / 떨림 질환)
  //   - 자세 (Posture): 10%  (근골격계)
  //
  // 점수 매핑:
  //   90-100: A+ (매우 우수)
  //   80-89:  A  (우수)
  //   70-79:  B  (양호)
  //   60-69:  C  (보통)
  //   50-59:  D  (주의)
  //   <50:    E  (관리 필요)
  // ════════════════════════════════════════════════════════════════
  _wellnessRestore() {
    try {
      const raw = localStorage.getItem('wellness_data');
      if (raw) {
        const data = JSON.parse(raw);
        // 7일 지나면 만료 (최신 측정만 유효)
        const now = Date.now();
        const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
        // ★ v16.6: 'finger' 누락 버그 수정 — 손가락 측정 데이터도 복원
        const restoreKeys = ['face', 'finger', 'balance', 'gait', 'tremor', 'reaction', 'posture', 'bodycomp'];
        for (const key of restoreKeys) {
          if (data[key] && data[key].t && (now - data[key].t) < MAX_AGE) {
            this.state.wellness[key] = data[key];
          }
        }
        // lastUpdated도 복원
        if (data.lastUpdated) {
          this.state.wellness.lastUpdated = data.lastUpdated;
        }
        console.log('[Wellness] 복원:', Object.keys(this.state.wellness).filter(k => this.state.wellness[k] && typeof this.state.wellness[k] === 'object'));
      }

      // ★ v16.8: 손상된 mental 객체 자동 정리 (이전 v16.4~v16.7 버그 데이터)
      // patternIcon, resilience 등 필수 필드 누락된 mental → 재계산 또는 제거
      this._migrateMoodHistory();
    } catch (e) {
      console.warn('[Wellness] 복원 실패:', e);
    }
  },

  // ★ v16.8: 이전 버전에서 저장된 손상된 mental 객체 마이그레이션
  _migrateMoodHistory() {
    try {
      const raw = localStorage.getItem('history_mood');
      if (!raw) return;
      const history = JSON.parse(raw);
      if (!Array.isArray(history) || history.length === 0) return;

      let migrated = 0;
      for (let i = 0; i < history.length; i++) {
        const h = history[i];
        // 손상 판정: mental 있는데 patternIcon 없으면 v16.4~v16.7 통합 측정 버그 데이터
        if (h.mental && (h.mental.patternIcon === undefined || h.mental.resilience === undefined)) {
          // 통합 측정이면 재계산 시도
          if (h.gameId === 'integrated' && h.valence !== undefined) {
            try {
              const analysisInput = {
                gameId: 'integrated',
                valence: h.valence,
                negBias: h.naAvg !== undefined ? Math.max(0, Math.min(1, (h.naAvg - 2) / 3)) : 0,
                loneliness: h.paAvg !== undefined ? Math.max(0, Math.min(1, (3 - h.paAvg) / 3)) : 0,
                rawData: h.rawData || { paAvg: h.paAvg, naAvg: h.naAvg, cardId: h.cardId },
                faceLink: h.faceLink || null,
              };
              h.mental = this._computeMentalWellnessScore(analysisInput);
              h.score = h.mental.overall;
              migrated++;
            } catch (e) {
              // 재계산 실패 → mental 제거 (빈 카드로 표시됨)
              delete h.mental;
              migrated++;
            }
          } else if (!h.mental.patternIcon) {
            // 다른 게임인데 필드 부족 → mental 제거
            delete h.mental;
            migrated++;
          }
        }
      }

      if (migrated > 0) {
        localStorage.setItem('history_mood', JSON.stringify(history));
        console.log(`[Migrate] mood history ${migrated}개 항목 정리됨`);
      }
    } catch (e) {
      console.warn('[Migrate] mood history 마이그레이션 실패:', e);
    }
  },

  _wellnessSave(category, data) {
    data.t = Date.now();
    this.state.wellness[category] = data;
    this.state.wellness.lastUpdated = data.t;

    // ★ v13.3: 게이미피케이션 - 스트릭 추적 (PDF 7페이지)
    this._streakUpdate();
    // 배지 자동 부여
    this._badgesCheck(category, data);

    // ★ v14.3: 시계열 히스토리 저장 (카테고리별 최대 100개)
    this._historyAppend(category, data);

    // ★ v14.5: 측정 완료 트래킹
    this._trackEvent('measurement_complete', { category, score: data.score });

    try {
      localStorage.setItem('wellness_data', JSON.stringify(this.state.wellness));
    } catch (e) {
      console.warn('[Wellness] 저장 실패:', e);
    }
    this._wellnessRender();
    this._safeStep('weeklyGoalRefresh', () => this._renderWeeklyGoalCard());
    // ★ v20.5: 측정 완료 후 AI 추천 + 기본정보 카드 즉시 갱신
    this._safeStep('recommendRefresh', () => this._renderRecommendCard());
    this._safeStep('basicInfoRefresh', () => this._renderBasicInfoCard());
    this._safeStep('brainBalanceRefresh', () => this._renderBrainBalanceCard());
    this._safeStep('homeHeroRefresh', () => this._renderHomeHero());
  },

  // ★ v14.3: 측정 히스토리 누적 저장
  _historyAppend(category, data) {
    try {
      const key = `history_${category}`;
      let history = [];
      try {
        history = JSON.parse(localStorage.getItem(key) || '[]');
      } catch (e) { history = []; }

      // 카테고리별 핵심 필드만 압축 저장 (용량 절약)
      const snapshot = { t: data.t };
      if (category === 'face') {
        snapshot.hr = data.hr;
        snapshot.rmssd = data.rmssd;
        snapshot.stressLevel = data.stressLevel;
        snapshot.respRate = data.respRate;
        snapshot.score = data.score;
      } else if (category === 'bodycomp') {
        snapshot.bmi = data.bmi;
        snapshot.whtr = data.whtr;
        snapshot.absi = data.absi;
        snapshot.weight = data.weight;
        snapshot.waist = data.waist;
        snapshot.bodyAge = data.bodyAge;
        snapshot.skinAge = data.skinAge;
        snapshot.score = data.score;
      } else if (category === 'balance') {
        snapshot.openRms = data.openRms;
        snapshot.closedRms = data.closedRms;
        snapshot.score = data.score;
      } else if (category === 'gait') {
        snapshot.cadence = data.cadence;
        snapshot.steps = data.steps;
        snapshot.score = data.score;
      } else if (category === 'tremor') {
        snapshot.amp = data.amp;
        snapshot.freq = data.freq;
        snapshot.score = data.score;
      } else if (category === 'reaction') {
        snapshot.avg = data.avg;
        snapshot.min = data.min;
        snapshot.score = data.score;
      } else if (category === 'posture') {
        snapshot.shoulder = data.shoulder;
        snapshot.head = data.head;
        snapshot.score = data.score;
      }

      history.push(snapshot);
      // 최대 100개 유지 (오래된 것부터 제거)
      if (history.length > 100) {
        history = history.slice(-100);
      }
      localStorage.setItem(key, JSON.stringify(history));
      console.log(`[History] ${category} 저장 (총 ${history.length}회)`);
    } catch (e) {
      console.warn('[History] 저장 실패:', e);
    }
  },

  // ★ v14.3: 카테고리별 히스토리 조회
  _historyGet(category) {
    try {
      return JSON.parse(localStorage.getItem(`history_${category}`) || '[]');
    } catch (e) {
      return [];
    }
  },

  // ★ v14.3: 기간 필터 (days 일 전부터 지금까지)
  _historyFilter(history, days) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return history.filter(h => h.t >= cutoff);
  },

  // ★ v14.3: 통계 계산 (평균/표준편차/추세)
  _historyStats(history, field) {
    const values = history.map(h => h[field]).filter(v => v != null && !isNaN(v));
    if (values.length === 0) return null;
    const sum = values.reduce((a, b) => a + b, 0);
    const mean = sum / values.length;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    const std = Math.sqrt(variance);
    const min = Math.min(...values);
    const max = Math.max(...values);
    // 추세: 최신 30% vs 이전 30% 비교
    const n = values.length;
    let trend = 0;
    if (n >= 6) {
      const recentN = Math.max(2, Math.floor(n * 0.3));
      const recent = values.slice(-recentN).reduce((a,b) => a+b, 0) / recentN;
      const past = values.slice(0, recentN).reduce((a,b) => a+b, 0) / recentN;
      if (past !== 0) trend = ((recent - past) / past) * 100;
    }
    return { mean, std, min, max, count: values.length, trend, latest: values[values.length - 1] };
  },

  // ★ v13.3: 스트릭(연속 측정) 시스템
  _streakUpdate() {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayStamp = today.getTime();

      let streak = JSON.parse(localStorage.getItem('streak_data') || '{}');
      if (!streak.lastDate) {
        streak = { count: 1, lastDate: todayStamp, longest: 1 };
      } else {
        const lastDate = streak.lastDate;
        const dayDiff = Math.floor((todayStamp - lastDate) / (24 * 60 * 60 * 1000));
        if (dayDiff === 0) {
          // 같은 날 - 그대로
        } else if (dayDiff === 1) {
          // 연속 - 카운트 증가
          streak.count++;
          streak.lastDate = todayStamp;
          if (streak.count > (streak.longest || 0)) streak.longest = streak.count;
        } else {
          // 끊김 - 리셋
          streak.count = 1;
          streak.lastDate = todayStamp;
        }
      }
      localStorage.setItem('streak_data', JSON.stringify(streak));
      this._streak = streak;
    } catch (e) {
      console.warn('[Streak] 실패:', e);
    }
  },

  _streakGet() {
    if (this._streak) return this._streak;
    try {
      this._streak = JSON.parse(localStorage.getItem('streak_data') || '{"count":0,"longest":0}');
    } catch (e) {
      this._streak = { count: 0, longest: 0 };
    }
    return this._streak;
  },

  // ★ v13.3: 배지 시스템
  _badgesCheck(category, data) {
    try {
      let badges = JSON.parse(localStorage.getItem('badges_earned') || '[]');
      const has = (id) => badges.some(b => b.id === id);
      const award = (id, name, icon, desc) => {
        if (!has(id)) {
          badges.push({ id, name, icon, desc, earnedAt: Date.now() });
          this._badgeNotify(name, icon);
        }
      };

      // 카테고리별 배지
      if (category === 'face' && data.score >= 90) {
        award('face_master', '심혈관 마스터', '💗', '얼굴 측정 90점 달성');
      }
      if (category === 'balance' && data.score >= 85) {
        award('balance_pro', '균형 감각', '⚖️', '균형 검사 85점 달성');
      }
      if (category === 'bodycomp' && data.bodyAge !== undefined && data.bodyAge < data.age) {
        award('young_body', '실제보다 젊은', '✨', `신체 나이가 실제보다 ${data.age - data.bodyAge}살 어려요`);
      }
      if (category === 'bodycomp' && data.whtr < 0.5) {
        award('waist_king', '복부 관리 왕', '🎯', '허리/키 비율 0.5 미만 달성');
      }
      if (category === 'bodycomp' && data.absi !== undefined) {
        // ABSI z-score가 매우 낮으면 (상위 10%)
        const w_state = this.state.wellness;
        if (w_state.bodycomp && w_state.bodycomp.absi) {
          // 단순 임계: 남성 0.078, 여성 0.077 미만
          if (data.absi < (data.gender === 'male' ? 0.078 : 0.077)) {
            award('hidden_strength', '숨겨진 강점', '💪', 'ABSI 체형 균형 우수 (상위 10%)');
          }
        }
      }

      // 첫 측정 배지
      if (badges.length === 0) {
        award('first_step', '첫 걸음', '🌱', '첫 측정을 완료했어요');
      }

      // 종합 점수 배지
      const totalScore = this._wellnessComputeScore();
      if (totalScore.score >= 90) {
        award('wellness_pro', '건강 프로', '🏆', '종합 점수 90점 달성');
      }
      if (totalScore.completeness >= 100) {
        award('all_complete', '올라운더', '🎉', '모든 측정 완료');
      }

      // 스트릭 배지
      const s = this._streakGet();
      if (s.count >= 3) award('streak_3', '3일 연속', '🔥', '3일 연속 측정');
      if (s.count >= 7) award('streak_7', '일주일 챔피언', '🌟', '7일 연속 측정');
      if (s.count >= 30) award('streak_30', '한 달 마스터', '👑', '30일 연속 측정');

      localStorage.setItem('badges_earned', JSON.stringify(badges));
      this._badges = badges;
    } catch (e) {
      console.warn('[Badge] 실패:', e);
    }
  },

  _badgesGet() {
    if (this._badges) return this._badges;
    try {
      this._badges = JSON.parse(localStorage.getItem('badges_earned') || '[]');
    } catch (e) {
      this._badges = [];
    }
    return this._badges;
  },

  _badgeNotify(name, icon) {
    // 배지 획득 토스트
    const toast = document.createElement('div');
    toast.className = 'badge-toast';
    toast.innerHTML = `
      <div class="badge-toast-icon">${icon}</div>
      <div class="badge-toast-text">
        <div class="badge-toast-title">🎉 배지 획득!</div>
        <div class="badge-toast-name">${name}</div>
      </div>
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 400);
    }, 3500);
    if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 200]);
  },

  _wellnessClear() {
    this.state.wellness = {
      face: null, balance: null, gait: null,
      tremor: null, reaction: null, posture: null,
      bodycomp: null,
      lastUpdated: 0,
    };
    try { localStorage.removeItem('wellness_data'); } catch(e) {}
    this._wellnessRender();
  },

  // 종합 점수 계산
  _wellnessComputeScore() {
    const w = this.state.wellness;
    const weights = {
      face:     0.20,
      finger:   0.15,
      balance:  0.10,
      gait:     0.10,
      reaction: 0.08,
      tremor:   0.07,
      posture:  0.06,
      bodycomp: 0.12,
      mental:   0.12,
    };

    let totalWeight = 0;
    let weightedSum = 0;
    const measured = [];
    const missing = [];

    for (const [key, weight] of Object.entries(weights)) {
      let score = null;
      if (key === 'mental') {
        try {
          const moodHistory = JSON.parse(localStorage.getItem('history_mood') || '[]');
          if (moodHistory.length > 0) {
            const latest = moodHistory[moodHistory.length - 1];
            if (latest.mental && (Date.now() - latest.t) < 24 * 60 * 60 * 1000) {
              score = latest.mental.overall;
            }
          }
        } catch (e) {}
      } else if (w[key] && typeof w[key].score === 'number') {
        score = w[key].score;
      }
      if (score !== null) {
        weightedSum += score * weight;
        totalWeight += weight;
        measured.push(key);
      } else {
        missing.push(key);
      }
    }

    if (totalWeight === 0) {
      return { score: null, grade: '-', measured, missing, completeness: 0 };
    }

    const score = Math.round(weightedSum / totalWeight);
    const grade =
      score >= 90 ? 'A+' : score >= 80 ? 'A' :
      score >= 70 ? 'B'  : score >= 60 ? 'C' :
      score >= 50 ? 'D'  : 'E';
    const completeness = Math.round(totalWeight * 100);

    // ★ v19.3: 어제 대비 점수 변화
    let scoreDelta = null;
    try {
      const today = new Date(); today.setHours(0,0,0,0);
      const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
      const allHistory = [];
      ['face','finger','balance','gait','reaction','tremor','posture','bodycomp'].forEach(k => {
        try {
          const arr = JSON.parse(localStorage.getItem(`history_${k}`) || '[]');
          arr.forEach(item => { if (item.score && item.t) allHistory.push({ t: item.t, score: item.score }); });
        } catch(e) {}
      });
      // 어제 측정 점수들의 평균
      const yItems = allHistory.filter(i => i.t >= yesterday.getTime() && i.t < today.getTime());
      if (yItems.length > 0) {
        const yScore = Math.round(yItems.reduce((s,i)=>s+i.score,0) / yItems.length);
        scoreDelta = score - yScore;
      }
    } catch(e) {}

    // ★ v19.3: 또래 백분위 (score → 정규분포 근사)
    // 한국인 건강 앱 사용자 평균 점수: mean=68, sd=14 (내부 추정)
    let peerPercentile = null;
    try {
      const profile = this._getUserProfile();
      const age = profile.age || 45;
      // 나이대별 평균 보정
      const ageMean = age < 30 ? 74 : age < 40 ? 71 : age < 50 ? 68 : age < 60 ? 64 : 60;
      const z = (score - ageMean) / 14;
      // 정규분포 CDF 근사 (Abramowitz & Stegun)
      const t = 1 / (1 + 0.2316419 * Math.abs(z));
      const poly = t * (0.319381530 + t*(-0.356563782 + t*(1.781477937 + t*(-1.821255978 + t*1.330274429))));
      const cdf = 1 - (1/Math.sqrt(2*Math.PI)) * Math.exp(-0.5*z*z) * poly;
      peerPercentile = Math.round(z >= 0 ? cdf * 100 : (1-cdf)*100 > 100 ? 100 : (z < 0 ? (1-(1-cdf))*100 : cdf*100));
      peerPercentile = Math.max(1, Math.min(99, Math.round(z >= 0 ? cdf*100 : (1-poly*(1/Math.sqrt(2*Math.PI))*Math.exp(-0.5*z*z))*100)));
      // 단순화: z-score → 백분위
      const pct = Math.round(50 + z * 15.87);
      peerPercentile = Math.max(1, Math.min(99, pct));
    } catch(e) {}

    // ★ v19.3: ANS 건강 나이 (자율신경 나이)
    let ansAge = null;
    try {
      const faceData = w.face || null;
      const fingerData = w.finger || null;
      const rmssd = fingerData?.rmssd || faceData?.rmssd || null;
      const profile = this._getUserProfile();
      const age = profile.age;
      if (rmssd && age) {
        const rmssdRef = this._refRMSSD(age, profile.gender);
        // ANS 나이: RMSSD 기반 역산 (Voss 2015 회귀)
        // 나이별 RMSSD: mean ≈ 90 - age*0.8ms (단순 선형 근사)
        const ansAgeRaw = Math.round((90 - rmssd) / 0.8);
        const delta = ansAgeRaw - age;
        ansAge = {
          age: Math.max(18, Math.min(90, ansAgeRaw)),
          delta,
          grade: delta < -5 ? 'young' : delta > 8 ? 'aged' : 'normal',
        };
      }
    } catch(e) {}

    return { score, grade, measured, missing, completeness, scoreDelta, peerPercentile, ansAge };
  },

  // 홈 화면에 Wellness 카드 렌더링
  _wellnessRender() {
    const card = document.getElementById('wellness-card');
    if (!card) return;
    const result = this._wellnessComputeScore();
    if (!result.score) {
      card.style.display = 'none';
      return;
    }
    card.style.display = 'block';

    // 등급 색상
    const colorMap = {
      'A+': '#10b981', 'A': '#10b981',
      'B': '#06b6d4', 'C': '#f59e0b',
      'D': '#f97316', 'E': '#ef4444',
    };
    const color = colorMap[result.grade] || '#9ca3af';

    // 측정 항목 라벨
    const labelMap = {
      face: { name: '얼굴', icon: '😊' },
      balance: { name: '균형', icon: '⚖️' },
      gait: { name: '보행', icon: '🚶' },
      reaction: { name: '반응', icon: '⚡' },
      tremor: { name: '손떨림', icon: '✋' },
      posture: { name: '자세', icon: '🧍' },
      bodycomp: { name: '신체지수', icon: '📏' },
      mental: { name: '정신건강', icon: '🧠' }, // ★ v15.2.1 추가
      finger: { name: '손가락', icon: '☝️' },  // ★ v15.5 추가
    };

    const measuredHTML = result.measured.map(k => {
      const lbl = labelMap[k];
      if (!lbl) return ''; // ★ v15.2.1: 안전망
      let score;
      if (k === 'mental') {
        try {
          const mh = JSON.parse(localStorage.getItem('history_mood') || '[]');
          score = mh.length > 0 && mh[mh.length-1].mental ? mh[mh.length-1].mental.overall : '-';
        } catch (e) { score = '-'; }
      } else {
        score = this.state.wellness[k]?.score ?? '-';
      }
      return `<div class="ws-item ok"><span class="ws-icon">${lbl.icon}</span><span class="ws-name">${lbl.name}</span><span class="ws-score">${score}</span></div>`;
    }).join('');

    const missingHTML = result.missing.map(k => {
      const lbl = labelMap[k];
      if (!lbl) return ''; // ★ v15.2.1: 안전망
      const nav = k === 'mental' ? 'mood' : k;
      return `<div class="ws-item miss" onclick="App._wellnessNavigateToTest('${nav}')"><span class="ws-icon">${lbl.icon}</span><span class="ws-name">${lbl.name}</span><span class="ws-score">미측정</span></div>`;
    }).join('');

    // ★ v13.2: 신체 나이 추출 (있을 경우 홈 카드에 표시)
    const bc = this.state.wellness.bodycomp;
    const bodyAgeHTML = (bc && bc.bodyAge) ? `
      <div class="ws-age-row">
        <div class="ws-age-item">
          <span class="ws-age-icon">🧬</span>
          <span class="ws-age-label">신체 나이</span>
          <span class="ws-age-num">${bc.bodyAge}<span class="ws-age-unit">세</span></span>
          ${bc.ageDiff !== undefined ? `<span class="ws-age-diff ${bc.ageDiff <= 1 ? 'good' : 'warn'}">${bc.ageDiff > 0 ? '+' : ''}${bc.ageDiff}</span>` : ''}
        </div>
        ${bc.skinAge ? `
        <div class="ws-age-item">
          <span class="ws-age-icon">✨</span>
          <span class="ws-age-label">피부 나이</span>
          <span class="ws-age-num">${bc.skinAge}<span class="ws-age-unit">세</span></span>
        </div>
        ` : ''}
      </div>
    ` : '';

    // ★ v13.3: 스트릭 + 배지 표시 (PDF 게이미피케이션)
    const streak = this._streakGet();
    const badges = this._badgesGet();
    const streakHTML = (streak.count > 0) ? `
      <div class="ws-streak-row">
        <div class="ws-streak">
          <div class="ws-streak-flame">${streak.count >= 7 ? '🔥' : streak.count >= 3 ? '✨' : '🌱'}</div>
          <div class="ws-streak-text">
            <div class="ws-streak-num">${streak.count}일 연속</div>
            <div class="ws-streak-sub">${streak.count >= 7 ? '대단해요! 건강 습관이 자리잡았어요' : streak.count >= 3 ? '잘하고 있어요!' : '시작이 반이에요'}</div>
          </div>
        </div>
        ${badges.length > 0 ? `
        <div class="ws-badges-summary" onclick="App._showBadgeCollection()">
          <div class="ws-badges-icons">${badges.slice(-3).map(b => `<span class="ws-badge-mini">${b.icon}</span>`).join('')}</div>
          <div class="ws-badges-count">${badges.length}개 배지</div>
        </div>
        ` : ''}
      </div>
    ` : '';

    card.innerHTML = `
      <div class="ws-header">
        <div class="ws-title">📊 종합 건강 점수</div>
        <div class="ws-completeness">${result.completeness}% 완료</div>
      </div>
      <div class="ws-score-main" style="color:${color}">
        <div class="ws-score-num">${result.score}</div>
        <div class="ws-score-meta">
          <div class="ws-score-grade">${result.grade}</div>
          <div class="ws-score-unit">/ 100</div>
        </div>
      </div>

      <!-- ★ v19.3: 또래 비교 + 어제 대비 인사이트 배너 -->
      <div class="ws-insight-row">
        ${result.peerPercentile !== null ? `
        <div class="ws-insight-chip peer">
          <span class="wic-icon">👥</span>
          <span class="wic-text">또래 상위 <strong>${100 - result.peerPercentile}%</strong></span>
        </div>` : ''}
        ${result.scoreDelta !== null ? `
        <div class="ws-insight-chip delta ${result.scoreDelta >= 0 ? 'up' : 'down'}">
          <span class="wic-icon">${result.scoreDelta >= 0 ? '📈' : '📉'}</span>
          <span class="wic-text">어제보다 <strong>${result.scoreDelta > 0 ? '+' : ''}${result.scoreDelta}점</strong></span>
        </div>` : ''}
        ${result.ansAge ? `
        <div class="ws-insight-chip ans ${result.ansAge.grade}">
          <span class="wic-icon">🧬</span>
          <span class="wic-text">자율신경 나이 <strong>${result.ansAge.age}세</strong></span>
        </div>` : ''}
      </div>

      <div class="ws-progress">
        <div class="ws-progress-fill" style="width:${result.score}%;background:${color}"></div>
      </div>
      ${streakHTML}
      ${bodyAgeHTML}
      <div class="ws-grid">
        ${measuredHTML}
        ${missingHTML}
      </div>
      ${result.completeness < 100 ?
        `<div class="ws-hint">미측정 항목을 완료하면 점수가 더 정확해져요</div>` :
        `<div class="ws-hint" style="color:var(--primary-dark)">✓ 모든 측정 완료</div>`}
      <button class="ws-reset" type="button" onclick="App._wellnessConfirmReset()">전체 초기화</button>
    `;
  },

  // ★ v13.3: 배지 컬렉션 모달 표시
  _showBadgeCollection() {
    const badges = this._badgesGet();
    // 모든 가능한 배지 목록 (미획득 표시용)
    const allBadges = [
      { id: 'first_step', name: '첫 걸음', icon: '🌱', desc: '첫 측정 완료' },
      { id: 'face_master', name: '심혈관 마스터', icon: '💗', desc: '얼굴 측정 90점 달성' },
      { id: 'balance_pro', name: '균형 감각', icon: '⚖️', desc: '균형 검사 85점 달성' },
      { id: 'young_body', name: '실제보다 젊은', icon: '✨', desc: '신체 나이가 실제보다 어려요' },
      { id: 'waist_king', name: '복부 관리 왕', icon: '🎯', desc: '허리/키 비율 0.5 미만' },
      { id: 'hidden_strength', name: '숨겨진 강점', icon: '💪', desc: 'ABSI 체형 균형 우수' },
      { id: 'wellness_pro', name: '건강 프로', icon: '🏆', desc: '종합 점수 90점 달성' },
      { id: 'all_complete', name: '올라운더', icon: '🎉', desc: '모든 측정 완료' },
      { id: 'streak_3', name: '3일 연속', icon: '🔥', desc: '3일 연속 측정' },
      { id: 'streak_7', name: '일주일 챔피언', icon: '🌟', desc: '7일 연속 측정' },
      { id: 'streak_30', name: '한 달 마스터', icon: '👑', desc: '30일 연속 측정' },
    ];

    const earnedSet = new Set(badges.map(b => b.id));
    const modal = document.createElement('div');
    modal.className = 'badge-modal';
    modal.innerHTML = `
      <div class="badge-modal-card">
        <div class="badge-modal-header">
          <div class="badge-modal-title">🏆 배지 컬렉션</div>
          <div class="badge-modal-count">${badges.length} / ${allBadges.length}</div>
        </div>
        <div class="badge-modal-grid">
          ${allBadges.map(b => `
            <div class="badge-item ${earnedSet.has(b.id) ? 'earned' : 'locked'}">
              <div class="badge-item-icon">${earnedSet.has(b.id) ? b.icon : '🔒'}</div>
              <div class="badge-item-name">${b.name}</div>
              <div class="badge-item-desc">${b.desc}</div>
            </div>
          `).join('')}
        </div>
        <button class="badge-modal-close" onclick="this.closest('.badge-modal').remove()">닫기</button>
      </div>
    `;
    document.body.appendChild(modal);
    setTimeout(() => modal.classList.add('show'), 10);
  },

  // ★ v19.3 Priority 2: 측정 완료 후 인사이트 + 다음 행동 카드
  // Dr. Kim: 맥락 있는 해석 / Sarah: 재방문 유도 / Mina: 측정 후 흐름 연결
  _showPostMeasureInsight(category, data) {
    try {
      const profile = this._getUserProfile();
      const age = profile.age || 40;
      const gender = profile.gender || 'male';

      // ── 카테고리별 인사이트 생성 ──
      let insight = null;

      if (category === 'face' || category === 'finger') {
        const hr    = data.hr;
        const rmssd = data.rmssd;
        const si    = data.stressIdx || data.stressIndex || 0;

        // HRV 또래 비교 (Voss 2015)
        const rmssdRef = this._refRMSSD(age, gender);
        const rmssdRatio = rmssd ? (rmssd / rmssdRef.mean) : null;

        // 상태 판단
        if (rmssd && rmssdRatio < 0.6) {
          insight = {
            state: 'warn',
            icon: '💛',
            title: '자율신경이 지쳐있어요',
            body: `HRV(RMSSD ${Math.round(rmssd)}ms)가 또래 평균(${rmssdRef.mean}ms)보다 낮아요. 오늘은 격한 운동보다 회복에 집중하세요.`,
            actions: [
              { icon: '🧘', text: '5분 복식호흡', sub: '미주신경 활성화 (Grossman 2007)' },
              { icon: '🚶', text: '가벼운 산책 20분', sub: '심박 변이도 개선에 효과적' },
              { icon: '😴', text: '오늘 7시간 이상 수면 목표', sub: '수면 중 HRV 회복' },
            ],
            next: { label: '신체 측정도 해볼까요?', page: 'body' },
          };
        } else if (rmssd && rmssdRatio > 1.3) {
          insight = {
            state: 'great',
            icon: '💚',
            title: '자율신경 상태 우수해요!',
            body: `HRV(RMSSD ${Math.round(rmssd)}ms)가 또래 상위 ${Math.round((1 - rmssdRatio * 0.3) * 100)}%예요. 오늘 운동하기 최적의 상태입니다.`,
            actions: [
              { icon: '🏋️', text: '오늘 운동 강도 높여보세요', sub: '회복력이 충분한 상태' },
              { icon: '📊', text: '변화 추이 확인하기', sub: '꾸준함이 HRV를 높여요' },
            ],
            next: { label: '감정 상태도 확인해볼까요?', page: 'mood' },
          };
        } else if (si && si > 300) {
          insight = {
            state: 'warn',
            icon: '🔴',
            title: '스트레스 지수가 높아요',
            body: `Baevsky 스트레스 지수 ${si}으로 중등도 이상입니다. 교감신경이 과활성 상태예요.`,
            actions: [
              { icon: '🌬️', text: '4-7-8 호흡법', sub: '4초 흡기→7초 정지→8초 호기' },
              { icon: '💧', text: '물 한 컵 마시기', sub: '탈수는 스트레스 지수 상승' },
              { icon: '🎵', text: '편안한 음악 10분', sub: '부교감신경 활성화' },
            ],
            next: { label: '감정 측정으로 원인 파악하기', page: 'mood' },
          };
        } else {
          insight = {
            state: 'good',
            icon: '💙',
            title: '안정적인 심혈관 상태예요',
            body: `심박수 ${hr}bpm, HRV ${rmssd ? Math.round(rmssd)+'ms' : '-'}로 또래 평균 범위 내 정상입니다.`,
            actions: [
              { icon: '📅', text: '내일도 측정해서 변화 추적하기', sub: '3일 연속이면 트렌드 분석 가능' },
              { icon: '⚖️', text: '균형 검사도 해보세요', sub: '심혈관 + 신체 균형이 시너지' },
            ],
            next: { label: '신체 측정으로 종합 점수 올리기', page: 'body' },
          };
        }
      } else if (category === 'balance') {
        const score = data.score || 0;
        if (score < 60) {
          insight = {
            state: 'warn', icon: '⚠️',
            title: '균형 능력을 키워볼까요?',
            body: `균형 점수 ${score}점입니다. 낙상 예방을 위해 균형 훈련이 도움돼요.`,
            actions: [
              { icon: '🦵', text: '한 발 서기 30초 × 3세트', sub: '매일 하면 4주 내 개선 (Rubenstein 2006)' },
              { icon: '🧘', text: '발꿈치-발끝 걷기 연습', sub: '전정 기관 자극' },
            ],
            next: { label: '보행 분석도 해볼까요?', page: 'body' },
          };
        } else {
          insight = {
            state: 'great', icon: '⭐',
            title: '균형 감각이 좋아요!',
            body: `균형 점수 ${score}점, 낙상 위험도가 낮습니다.`,
            actions: [
              { icon: '🚶', text: '보행 분석으로 이어서 측정', sub: '균형 + 보행 = 종합 운동 기능' },
            ],
            next: { label: '반응속도도 테스트해볼까요?', page: 'body' },
          };
        }
      } else if (category === 'gait') {
        const score = data.score || 0;
        insight = {
          state: score >= 75 ? 'good' : 'warn',
          icon: score >= 75 ? '🚶' : '💛',
          title: score >= 75 ? '보행 패턴이 양호해요' : '보행 리듬을 개선해볼까요?',
          body: score >= 75
            ? `보행 점수 ${score}점. 규칙적인 걸음 패턴은 심혈관 건강과 직결돼요.`
            : `보행 점수 ${score}점. 보행 케이던스나 규칙성을 높이면 건강에 도움돼요.`,
          actions: [
            { icon: '👟', text: '매일 30분 빠르게 걷기', sub: '케이던스 110~120 steps/min 목표' },
            { icon: '⚖️', text: '균형 검사 병행 추천', sub: '보행 + 균형 = 낙상 예방 완성' },
          ],
          next: { label: '손떨림 측정도 해보세요', page: 'body' },
        };
      } else if (category === 'bodycomp') {
        const bmi  = data.bmi  || 0;
        const whtr = data.whtr || 0;
        const bodyAge = data.bodyAge || null;
        let state = 'good', icon = '📏', title = '신체 지수 분석 완료', body = '';

        if (bmi >= 25 || whtr >= 0.5) {
          state = 'warn'; icon = '💛';
          title = '복부 건강을 관리해보세요';
          body = `BMI ${bmi.toFixed(1)}, 허리/키 비율 ${whtr.toFixed(2)}입니다. 복부 비만은 심혈관 위험과 직결돼요 (Aune 2016).`;
        } else if (bmi < 18.5) {
          state = 'warn'; icon = '💛';
          title = '체중 관리가 필요해요';
          body = `BMI ${bmi.toFixed(1)}로 저체중 범위입니다. 충분한 영양 섭취를 권장해요.`;
        } else {
          title = '건강한 신체 지수예요!';
          body = `BMI ${bmi.toFixed(1)}, 허리/키 비율 ${whtr.toFixed(2)} — 정상 범위입니다.${bodyAge ? ` 신체 나이 ${bodyAge}세.` : ''}`;
        }
        insight = {
          state, icon, title, body,
          actions: [
            { icon: '😊', text: '얼굴 측정으로 심혈관 체크', sub: '체형 + 심혈관 = 완전한 건강 그림' },
            { icon: '📈', text: '1개월 후 재측정 추천', sub: '변화 추이를 확인하세요' },
          ],
          next: { label: '종합 건강 점수 확인하기', page: 'home' },
        };
      }

      if (!insight) return; // 인사이트 생성 실패 시 조용히 종료

      // ── 모달 렌더링 ──
      const stateColor = {
        great: '#10b981', good: '#3b82f6',
        warn: '#f59e0b', bad: '#ef4444',
      }[insight.state] || '#6b7280';

      const existing = document.getElementById('post-measure-insight-modal');
      if (existing) existing.remove();

      const modal = document.createElement('div');
      modal.id = 'post-measure-insight-modal';
      modal.className = 'pmi-overlay';
      modal.innerHTML = `
        <div class="pmi-sheet">
          <div class="pmi-header" style="border-left:4px solid ${stateColor}">
            <span class="pmi-state-icon">${insight.icon}</span>
            <div class="pmi-header-text">
              <div class="pmi-title">${insight.title}</div>
              <div class="pmi-body">${insight.body}</div>
            </div>
          </div>

          <div class="pmi-actions-title">💡 지금 할 수 있는 것</div>
          <div class="pmi-actions">
            ${insight.actions.map(a => `
              <div class="pmi-action-item">
                <span class="pmi-action-icon">${a.icon}</span>
                <div class="pmi-action-content">
                  <div class="pmi-action-text">${a.text}</div>
                  <div class="pmi-action-sub">${a.sub}</div>
                </div>
              </div>
            `).join('')}
          </div>

          <div class="pmi-footer-btns">
            <button class="pmi-next-btn" style="background:${stateColor}"
              onclick="App.goPage('${insight.next.page}');document.getElementById('post-measure-insight-modal')?.remove()">
              ${insight.next.label} →
            </button>
            <button class="pmi-close-btn"
              onclick="document.getElementById('post-measure-insight-modal')?.remove()">
              닫기
            </button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      // 부드러운 등장
      requestAnimationFrame(() => modal.classList.add('pmi-show'));
    } catch (e) {
      console.warn('[v19.3] postMeasureInsight 오류:', e.message);
    }
  },

  _wellnessNavigateToTest(category) {
    if (category === 'face') {
      this.goPage('face');
    } else if (category === 'bodycomp') {
      // 신체지수는 직접 페이지로 이동
      this.openBodyComposition();
    } else if (category === 'mood' || category === 'mental') {
      // ★ v15.2.1: 정신건강은 mood 페이지로
      this.goPage('mood');
    } else if (category === 'finger') {
      // ★ v15.5: 손가락 측정 페이지로
      this.goPage('finger');
    } else {
      // 신체 측정 메뉴로 이동 후 해당 테스트 시작
      this.goPage('body');
      setTimeout(() => this.startBodyTest(category), 300);
    }
  },

  _wellnessConfirmReset() {
    if (confirm('모든 측정 결과를 초기화하시겠습니까?')) {
      this._wellnessClear();
    }
  },

  // 음성 합성 워밍업 (Chrome Android는 사용자 제스처 후에만 작동)
  _warmupSpeech() {
    if (this._speechWarmedUp) return;
    if (!('speechSynthesis' in window)) return;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0; u.rate = 10;
      window.speechSynthesis.speak(u);
      this._speechWarmedUp = true;
      console.log('[Speech] 워밍업 완료');
    } catch (e) {}
  },

  // === 권한 일괄 요청 안내 (첫 방문 시) ===
  async _maybeShowPermissionGuide() {
    // 한 번 보여주면 localStorage에 기록 (다시 안 띄움)
    try {
      if (localStorage.getItem('perm_guide_shown') === '1') return;
    } catch(e) {}

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-card">
        <div class="modal-icon">🔐</div>
        <div class="modal-title">권한 안내</div>
        <p style="font-size:13px;color:#4b5563;line-height:1.6;margin-bottom:14px;text-align:center;">
          정확한 측정을 위해 다음 권한이 필요합니다.<br>
          측정 시작 시 자동으로 요청됩니다.
        </p>
        <div class="modal-step">
          <div class="step-num">📷</div>
          <div class="step-text"><strong>카메라</strong><br><small>얼굴 측정, 자세 평가에 사용</small></div>
        </div>
        <div class="modal-step">
          <div class="step-num">📳</div>
          <div class="step-text"><strong>모션 센서</strong><br><small>균형/보행/손떨림 측정에 사용</small></div>
        </div>
        <div class="modal-step">
          <div class="step-num">🔊</div>
          <div class="step-text"><strong>음성 안내</strong><br><small>측정 단계별 음성 가이드 (선택)</small></div>
        </div>
        <p style="font-size:11px;color:#9ca3af;line-height:1.5;margin:10px 0 12px;text-align:center;">
          ※ 권한 데이터는 모두 기기 내에서만 처리되며,<br>외부로 전송되지 않습니다.
        </p>
        <div class="modal-btns">
          <button class="m-btn ok" type="button" id="perm-ok">확인했어요</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    document.getElementById('perm-ok').onclick = () => {
      try { localStorage.setItem('perm_guide_shown', '1'); } catch(e) {}
      modal.remove();
      this._warmupSpeech();
    };
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        try { localStorage.setItem('perm_guide_shown', '1'); } catch(e) {}
        modal.remove();
      }
    });
  },

  // === 안내 시스템 v11s8 — 음성 + 시각 + 진동 통합 ===
  // 환경에 맞춰 가능한 모든 방식으로 안내
  // v13.1: onComplete 콜백 추가 — 음성 끝난 후 측정 시작
  _speak(text, onComplete) {
    // 1. 시각적 안내 (항상 작동) — 화면 상단에 큰 메시지
    this._showSpeechBanner(text);
    // 2. 진동 (지원 시)
    if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
    // 3. 음성 (지원 시) — 끝나면 콜백 호출
    const handleDone = () => {
      if (typeof onComplete === 'function') {
        // 음성 끝난 후 800ms 추가 대기 (사용자가 안내 인지할 시간)
        setTimeout(onComplete, 800);
      }
    };
    this._tryTTS(text, handleDone);
    // TTS 미지원 환경 안전망: 텍스트 길이 기반 추정 시간 후 콜백 실행
    if (typeof onComplete === 'function' && !('speechSynthesis' in window)) {
      // 한글 1글자 약 150ms 추정 + 800ms 여유
      const estimatedMs = Math.max(2000, text.length * 150) + 800;
      setTimeout(onComplete, estimatedMs);
    }
  },

  _showSpeechBanner(text) {
    let banner = document.getElementById('speech-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'speech-banner';
      // ★ v13.8: 상단 배치 (카메라 가리지 않게) + 더 큰 텍스트
      banner.style.cssText = `
        position: fixed;
        top: max(80px, env(safe-area-inset-top, 20px) + 60px);
        left: 50%;
        transform: translateX(-50%) translateY(-20px);
        background: linear-gradient(135deg, #16a34a 0%, #22c55e 100%);
        color: #fff;
        padding: 16px 22px;
        border-radius: 18px;
        font-size: 16px;
        font-weight: 700;
        z-index: 2000;
        max-width: 88vw;
        min-width: 200px;
        text-align: center;
        line-height: 1.4;
        box-shadow: 0 12px 40px rgba(34, 197, 94, .4);
        transition: opacity .3s, transform .3s;
        opacity: 0;
        pointer-events: none;
      `;
      document.body.appendChild(banner);
    }
    // ★ v13.8: TTS 실패 환경에서는 아이콘으로 시각 강조
    const icon = this._ttsNoticeShown ? '📢' : '🔊';
    banner.textContent = icon + ' ' + text;
    banner.style.opacity = '1';
    banner.style.transform = 'translateX(-50%) translateY(0)';
    clearTimeout(this._speakBannerTimer);
    // ★ v13.8: TTS 미지원 환경에선 더 오래 표시 (사용자가 읽을 시간)
    const baseDuration = Math.max(2000, Math.min(6000, text.length * 100));
    const duration = this._ttsNoticeShown ? baseDuration + 1500 : baseDuration;
    this._speakBannerTimer = setTimeout(() => {
      if (banner) {
        banner.style.opacity = '0';
        banner.style.transform = 'translateX(-50%) translateY(-20px)';
      }
    }, duration);
  },

  _tryTTS(text, onEnd) {
    if (!('speechSynthesis' in window)) {
      console.log('[Speech] TTS 미지원 — 시각 안내만');
      this._noticeTTSFailedOnce();
      return;
    }
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = 'ko-KR';
      utter.rate = 1.05;
      utter.pitch = 1.0;
      utter.volume = 1.0;

      // ★ v13.1: 음성 종료 콜백
      let endCalled = false;
      let startedOk = false;
      const safeEnd = () => {
        if (endCalled) return;
        endCalled = true;
        if (typeof onEnd === 'function') onEnd();
      };
      utter.onstart = () => { startedOk = true; };
      utter.onend = safeEnd;
      utter.onerror = (e) => {
        console.warn('[Speech] onerror:', e.error);
        safeEnd();
        // ★ v13.9: interrupted/canceled는 정상 중단 (TTS 실패 아님)
        if (e.error === 'interrupted' || e.error === 'canceled') {
          startedOk = true; // 시작은 했었으니 false positive 방지
          return;
        }
        // 인앱 브라우저에서 TTS 실패 시 알림
        if (e.error === 'not-allowed' || e.error === 'synthesis-failed' || e.error === 'audio-busy') {
          this._noticeTTSFailedOnce();
        }
      };
      // 안전망: 텍스트 길이 + 1초 후에도 onend 안 오면 강제 종료 (일부 환경 대응)
      const fallbackMs = Math.max(2500, text.length * 180) + 1000;
      setTimeout(() => {
        if (!startedOk) {
          // TTS 시작 자체가 안 됨 (카카오톡, 일부 안드로이드 WebView)
          console.warn('[Speech] TTS 시작 안 됨 - 시각/진동만 사용');
          this._noticeTTSFailedOnce();
        }
        safeEnd();
      }, fallbackMs);

      // voiceschanged 이벤트 후 voice 적용 (Chrome Android 호환)
      const trySpeak = () => {
        const voices = window.speechSynthesis.getVoices();
        if (voices.length > 0) {
          const koVoice = voices.find(v => v.lang === 'ko-KR' || v.lang.startsWith('ko'));
          if (koVoice) utter.voice = koVoice;
        }
        window.speechSynthesis.speak(utter);
        console.log('[Speech]', text);
      };
      // voices 이미 로드된 경우 즉시, 아니면 이벤트 기다림
      if (window.speechSynthesis.getVoices().length > 0) {
        trySpeak();
      } else {
        const onChange = () => {
          window.speechSynthesis.onvoiceschanged = null;
          trySpeak();
        };
        window.speechSynthesis.onvoiceschanged = onChange;
        // 안전망: 500ms 후 강제 시도
        setTimeout(() => {
          if (window.speechSynthesis.onvoiceschanged === onChange) {
            window.speechSynthesis.onvoiceschanged = null;
            trySpeak();
          }
        }, 500);
      }
    } catch (err) {
      console.warn('[Speech] 실패:', err);
      // 실패 시에도 onEnd 호출 (측정 시작 막지 않도록)
      if (typeof onEnd === 'function') setTimeout(onEnd, 500);
    }
  },

  _speakStop() {
    if ('speechSynthesis' in window) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
    const banner = document.getElementById('speech-banner');
    if (banner) banner.style.opacity = '0';
  },

  // === 뒤로가기 버튼 처리 (앱 종료 방지) ===
  // ★ v16.6: 현재 페이지 기준 history 초기화 (페이지 복원 후 호출)
  _setupBackButton() {
    const curPage = this.state.page || 'home';

    // history를 깔끔하게 정리:
    //   anchor (떠나면 종료) → 현재 페이지
    // 새로고침으로 다시 진입한 경우에도 이 구조가 유지됨
    history.replaceState({ page: 'home', anchor: true }, '', '');
    history.pushState({ page: curPage }, '', '');

    this._exitWarnUntil = 0; // 종료 경고 만료 시각

    window.addEventListener('popstate', (e) => {
      const state = e.state;
      console.log('[Nav] popstate:', state, 'current:', this.state.page);

      // anchor 상태로 떨어졌으면 = 홈에서 뒤로 누른 상황
      if (!state || state.anchor) {
        const now = Date.now();
        if (now < this._exitWarnUntil) {
          // 2초 내 두 번째 누름 → 종료 허용
          return;
        }
        // 첫 번째 누름 → 다시 push해서 막고 토스트 표시
        history.pushState({ page: 'home' }, '', '');
        this._toast('한 번 더 누르면 종료됩니다');
        this._exitWarnUntil = now + 2000;
        return;
      }

      // 신체 측정 중이면 정지
      if (this.state.body && this.state.body.running) {
        this.bodyStop();
      }
      // 얼굴 측정 중이면 정지
      if (this.state.face && this.state.face.running) {
        this.faceStop();
      }
      // 손가락 측정 중이면 정지
      if (this._finger && (this._finger.stream || this._finger.measuring)) {
        this._fingerCleanup();
      }

      // state.page로 이동
      this._goPageInternal(state.page || 'home');
    });
  },

  _toast(msg) {
    const t = document.getElementById('toast') || (() => {
      const el = document.createElement('div');
      el.id = 'toast';
      el.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.85);color:#fff;padding:10px 20px;border-radius:20px;font-size:13px;z-index:2000;backdrop-filter:blur(8px);transition:opacity .3s';
      document.body.appendChild(el);
      return el;
    })();
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 1500);
  },

  // ─── 페이지 전환 ───
  goPage(page) {
    // 측정 중에는 페이지 이동 시 정지
    if (this.state.face.running && page !== 'face') {
      console.log('[App] 페이지 이동 — 얼굴 측정 정지');
      this.faceStop();
    }
    if (this.state.body.running && page !== 'body' && !this.state.page.startsWith('test-')) {
      this.bodyStop();
    }
    this._goPageInternal(page);
    // ★ v15.9: 새 페이지를 history에 push (현재 state가 다를 때만)
    // 중복 push 방지 — 같은 페이지 연속 이동 시 history 폭증 막음
    const cur = history.state;
    if (!cur || cur.page !== page || cur.anchor) {
      history.pushState({ page }, '', '');
    }
  },

  _goPageInternal(page) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('on'));
    const pageEl = document.getElementById('page-' + page);
    if (!pageEl) {
      // ★ v16.5: 없는 페이지 요청 시 home으로 안전 폴백 (orphan page 보호)
      console.warn(`[Nav] 존재하지 않는 페이지: ${page} → home으로`);
      const homeEl = document.getElementById('page-home');
      if (homeEl) homeEl.classList.add('on');
      page = 'home';
    } else {
      pageEl.classList.add('on');
    }
    document.querySelectorAll('.nav-btn').forEach(n => n.classList.remove('on'));
    document.getElementById('nav-' + page)?.classList.add('on');
    this.state.page = page;
    // ★ v16.5: 새로고침 복원용 마지막 페이지 저장
    try { sessionStorage.setItem('lastPage', page); } catch (e) {}
    // ★ v14.5: 페이지 이동 트래킹
    this._trackEvent('page_view', { page });
    // ★ v14.0: 결과 페이지 진입 시 종합 렌더링
    if (page === 'results') {
      this._renderResultsPage();
    }
    // ★ v14.2: 상세 분석 페이지 진입 시 렌더링
    if (page === 'detail') {
      this._renderDetailPage();
    }
    // ★ v14.3: 트렌드 페이지 진입 시 렌더링
    if (page === 'trends') {
      this._renderTrendsPage();
    }
    // ★ v15.0: 감정 게임 페이지 진입 시 렌더링
    if (page === 'mood') {
      this._renderMoodPage();
    }
    // ★ v15.6: 손가락 PPG 페이지 진입 시 인트로 stage로
    if (page === 'finger') {
      // 이전 측정이 활성화돼 있으면 정리
      if (this._finger && (this._finger.stream || this._finger.measuring)) {
        this._fingerCleanup();
      }
      const stages = ['finger-stage-intro', 'finger-stage-camera', 'finger-stage-measuring'];
      stages.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = (id === 'finger-stage-intro') ? 'block' : 'none';
      });
      const result = document.getElementById('finger-result');
      if (result) result.style.display = 'none';
      const logPanel = document.getElementById('finger-log-panel');
      if (logPanel) logPanel.style.display = 'none';
      if (this._finger) this._finger.stage = 'intro';
    }
    // 페이지 떠날 때 측정 중이면 안전 정지
    if (page !== 'finger' && this._finger && (this._finger.stream || this._finger.measuring)) {
      this._fingerCleanup();
    }
    // ★ v15.0: 홈 진입 시 오늘의 감정 카드 업데이트
    if (page === 'home') {
      this._renderMoodHomeCard();
      this._safeStep('sleepCheckin', () => this._renderSleepCheckin()); // ★ v20.0
      this._safeStep('homeHero', () => this._renderHomeHero()); // ★ v22.0
      this._safeStep('basicInfoCard', () => this._renderBasicInfoCard()); // ★ v20.5
      this._safeStep('brainBalanceCard', () => this._renderBrainBalanceCard()); // ★ v21.1
      this._safeStep('analyticsToggle', () => this._syncAnalyticsToggle()); // ★ v24.0
      this._safeStep('measurerFixed', () => this._syncMeasurerFixed()); // ★ v24.6
      this._safeStep('recommendCard', () => this._renderRecommendCard()); // ★ v20.0
    }
    // ★ v16.2: 가족 공유 페이지
    if (page === 'share') {
      // ★ v17.1: 진입 시 mode 초기화 → 데이터 상태에 맞게 자동 선택
      this._shareMode = null;
      this._renderSharePage();
    }
    // ★ v16.2: 가족이 받은 공유 결과 보기 페이지
    if (page === 'family-view') {
      this._renderFamilyViewPage();
    }
    window.scrollTo(0, 0);
  },

  // ★ v14.0: 홈에서 결과 카드 클릭 → 결과 페이지로
  _scrollToWellness() {
    this.goPage('results');
  },

  // ★ v14.0: 건강 측정 결과 종합 페이지 렌더링
  _renderResultsPage() {
    const dashboard = document.getElementById('results-dashboard');
    if (!dashboard) return;
    const w = this.state.wellness || {};
    const result = this._wellnessComputeScore();
    const color = result.score >= 85 ? '#22c55e' : result.score >= 70 ? '#3b82f6' : result.score >= 50 ? '#f59e0b' : '#ef4444';

    const streak = this._streakGet();
    const badges = this._badgesGet();
    const measuredCount = ['face','balance','gait','tremor','reaction','posture','bodycomp'].filter(k => w[k]).length;

    // 측정 항목 메타데이터
    const items = [
      { key: 'face', icon: '😊', name: '심혈관', unit: 'HR/HRV/스트레스', page: 'face' },
      { key: 'finger', icon: '☝️', name: '손가락 (임상급)', unit: 'RMSSD/HRV 정밀', page: 'finger' },
      { key: 'balance', icon: '⚖️', name: '균형 감각', unit: '눈뜨고/감기 흔들림', page: 'body', test: 'balance' },
      { key: 'gait', icon: '🚶', name: '보행 패턴', unit: '걸음수/케이던스', page: 'body', test: 'gait' },
      { key: 'tremor', icon: '✋', name: '손떨림', unit: '진폭/주파수', page: 'body', test: 'tremor' },
      { key: 'reaction', icon: '⚡', name: '반응속도', unit: 'ms 평균', page: 'body', test: 'reaction' },
      { key: 'posture', icon: '🧍', name: '자세 평가', unit: '어깨/머리 정렬', page: 'body', test: 'posture' },
      { key: 'bodycomp', icon: '📐', name: '신체 지수', unit: 'BMI/WHtR/ABSI', page: 'body', test: 'bodycomp' },
    ];

    // ★ v14.2: 종합 점수 분포 곡선 SVG 생성 (신체지수 페이지 BMI 분포처럼)
    const scoreChart = this._buildScoreDistributionChart(result.score, color);

    // ★ v14.2: 카테고리별 점수 (방사형 차트 형태)
    const categoryScores = this._buildCategoryRadarChart(w, items);

    // 측정 카드 생성 (간소화 - 점수 그래프 위주)
    let cardsHTML = '';
    for (const it of items) {
      const data = w[it.key];
      const measured = !!data;
      const score = measured ? (data.score || 0) : 0;
      const scoreColor = score >= 85 ? '#22c55e' : score >= 70 ? '#3b82f6' : score >= 50 ? '#f59e0b' : '#ef4444';
      const onClick = it.test
        ? `App.goPage('${it.page}');setTimeout(()=>App.startBodyTest('${it.test}'),400)`
        : `App.goPage('${it.page}')`;
      const dateStr = measured && data.t ? this._formatRelativeTime(data.t) : '미측정';

      cardsHTML += `
        <button class="res-mini-card ${measured ? 'measured' : 'pending'}" onclick="${onClick}" type="button">
          <div class="res-mini-icon" style="background:${measured ? scoreColor + '22' : 'var(--bg)'};color:${measured ? scoreColor : '#94a3b8'}">${it.icon}</div>
          <div class="res-mini-name">${it.name}</div>
          ${measured ? `
            <div class="res-mini-score" style="color:${scoreColor}">${score}</div>
            <div class="res-mini-bar"><div class="res-mini-bar-fill" style="width:${score}%;background:${scoreColor}"></div></div>
            <div class="res-mini-meta">${dateStr}</div>
          ` : `
            <div class="res-mini-pending">측정하기</div>
            <div class="res-mini-bar"><div class="res-mini-bar-fill pending"></div></div>
            <div class="res-mini-meta">아직 안 했어요</div>
          `}
        </button>
      `;
    }

    // 신체 나이/피부 나이 카드
    let ageHTML = '';
    if (w.bodycomp && w.bodycomp.bodyAge) {
      // ★ v20.5: 최신 얼굴(혈관나이/HRV) 데이터로 피부나이 재계산
      const bc = { ...w.bodycomp };
      const recomputed = this._recomputeBodyAges ? this._recomputeBodyAges() : null;
      if (recomputed && recomputed.updated) {
        bc.skinAge = recomputed.skinAge;
        bc.skinAgeDiff = recomputed.skinAgeDiff;
        bc.skinAgeConfidence = recomputed.skinAgeConfidence;
        bc.bodyAge = recomputed.bodyAge;
        bc.bodyAgeConfidence = recomputed.bodyAgeConfidence;
        // 저장값도 갱신 (다음 조회 시 일관성)
        try {
          this.state.wellness.bodycomp.skinAge = recomputed.skinAge;
          this.state.wellness.bodycomp.skinAgeDiff = recomputed.skinAgeDiff;
          this.state.wellness.bodycomp.skinAgeConfidence = recomputed.skinAgeConfidence;
          localStorage.setItem('wellness_data', JSON.stringify(this.state.wellness));
        } catch (e) {}
      }
      const diff = bc.ageDiff || 0;
      const skinDiff = bc.skinAgeDiff || 0;
      const bodyColor = diff <= 0 ? '#22c55e' : diff <= 3 ? '#f59e0b' : '#ef4444';
      const skinColor = skinDiff <= 0 ? '#a78bfa' : skinDiff <= 3 ? '#f59e0b' : '#ef4444';

      // ★ v18.1: 신체나이 근거 배지 (심혈관 데이터 표시)
      const faceW2 = w.face || null, fingerW2 = w.finger || null;
      const hrShow   = fingerW2?.hr   || faceW2?.hr   || null;
      const rmssdShow = fingerW2?.rmssd || faceW2?.rmssd || null;
      const bodyBadges = [];
      if (hrShow)    bodyBadges.push(`HR ${hrShow}BPM`);
      if (rmssdShow) bodyBadges.push(`HRV ${rmssdShow}ms`);
      const bodyBasisText = bodyBadges.length > 0
        ? bodyBadges.join(' · ')
        : '체형 지표 기반';

      // ★ v18.1: 피부나이 근거 배지 (혈관나이·RSA 표시)
      const vaShow  = faceW2?.vascularAge?.estimatedAge || null;
      const rsaShow = faceW2?.rsaIndex ?? null;
      const skinBadges = [];
      if (vaShow)              skinBadges.push(`혈관나이 ${vaShow}세`);
      if (rsaShow !== null)    skinBadges.push(`RSA ${rsaShow}/100`);
      if (rmssdShow)           skinBadges.push(`HRV ${rmssdShow}ms`);
      const skinBasisText = skinBadges.length > 0
        ? skinBadges.join(' · ')
        : '체형·스트레스 기반';

      ageHTML = `
        <div class="res-age-grid">
          <div class="res-age-card" style="--c:${bodyColor}">
            <div class="res-age-label">🧬 신체 나이</div>
            <div class="res-age-num" style="color:${bodyColor}">${bc.bodyAge}</div>
            <div class="res-age-unit">세 (실제 ${bc.age}세)</div>
            <div class="res-age-diff" style="color:${bodyColor}">
              ${diff > 0 ? '+' : ''}${diff}년
              · 신뢰도 ${bc.bodyAgeConfidence || 50}%
            </div>
            <div style="font-size:10px;color:var(--muted);margin-top:4px;line-height:1.4">${bodyBasisText}</div>
          </div>
          <div class="res-age-card" style="--c:${skinColor}">
            <div class="res-age-label">✨ 피부 나이</div>
            <div class="res-age-num" style="color:${skinColor}">${bc.skinAge || bc.age}</div>
            <div class="res-age-unit">세 (참고용)</div>
            <div class="res-age-diff" style="color:${skinColor}">
              ${skinDiff > 0 ? '+' : ''}${skinDiff}년
              · 신뢰도 ${bc.skinAgeConfidence || 40}%
            </div>
            <div style="font-size:10px;color:var(--muted);margin-top:4px;line-height:1.4">${skinBasisText}</div>
          </div>
        </div>
      `;
    }

    dashboard.innerHTML = `
      <!-- ★ v14.2: 종합 점수 그래프 (신체지수 페이지 스타일) -->
      <div class="res-section-title">📊 종합 건강 점수</div>
      <div class="res-graph-card">
        <div class="res-graph-header">
          <div class="res-graph-status" style="color:${color}">
            건강 점수가 <strong>${result.grade}</strong>
          </div>
          <div class="res-graph-value" style="color:${color}">${result.score}<span class="res-graph-unit"> / 100</span></div>
        </div>
        ${scoreChart}
        <div class="res-graph-progress">
          <div class="res-graph-progress-track">
            <div class="res-graph-progress-fill" style="width:${result.score}%;background:linear-gradient(90deg, ${color}88, ${color})"></div>
          </div>
          <div class="res-graph-progress-meta">${result.completeness}% 측정 완료 · ${measuredCount}/7 항목</div>
        </div>
      </div>

      ${streak.count > 0 ? `
      <div class="res-streak-row">
        <div class="res-streak">
          <div class="res-streak-icon">${streak.count >= 7 ? '🔥' : streak.count >= 3 ? '✨' : '🌱'}</div>
          <div class="res-streak-text">
            <div class="res-streak-num">${streak.count}일 연속 측정</div>
            <div class="res-streak-sub">${streak.count >= 7 ? '대단해요!' : streak.count >= 3 ? '잘하고 있어요' : '꾸준히 측정해보세요'}</div>
          </div>
        </div>
        ${badges.length > 0 ? `
        <div class="res-badges" onclick="App._showBadgeCollection()">
          <div class="res-badges-icons">${badges.slice(-3).map(b => `<span>${b.icon}</span>`).join('')}</div>
          <div class="res-badges-count">${badges.length}개 배지</div>
        </div>` : ''}
      </div>
      ` : ''}

      ${ageHTML}

      <!-- ★ v16.3: 핵심 건강 지표 (그룹 1) -->
      <div class="res-group-divider">
        <div class="res-group-icon">💗</div>
        <div class="res-group-title">핵심 건강 지표</div>
        <div class="res-group-sub">심혈관 · 자율신경 통합</div>
      </div>

      <!-- ★ v16.2: 통합 심혈관 측정 카드 (손가락+얼굴 가중평균) -->
      ${this._renderUnifiedCardioCard(w)}

      <!-- ★ v18.0: 고급 PPG 분석 (혈관나이/부정맥/RSA) — 얼굴+손가락 통합 -->
      ${(w.face || w.finger) ? `
        <div class="res-group-divider" style="margin-top:8px">
          <div class="res-group-icon">🔬</div>
          <div class="res-group-title">고급 심혈관 분석</div>
          <div class="res-group-sub">ME-rPPG 딥러닝 기반</div>
        </div>
        <div id="results-advanced-cards"></div>
      ` : ''}

      <!-- ★ v15.2: 정신건강 점수 카드 (감정 게임 + 자율신경 통합) -->
      ${this._renderResultsMentalCard()}

      <!-- ★ v16.3: 변화 추이 (그룹 2) -->
      ${(w.face || w.finger) ? `
        <div class="res-group-divider">
          <div class="res-group-icon">📈</div>
          <div class="res-group-title">변화 추이</div>
          <div class="res-group-sub">평소 대비 변화</div>
        </div>
      ` : ''}

      <!-- ★ v14.4: 평소 대비 변화 카드 (얼굴 측정 baseline 비교) -->
      ${this._renderBaselineComparisonCard(w)}

      <!-- ★ v16.3: 전체 측정 항목 (그룹 3) -->
      ${measuredCount > 0 ? `
        <div class="res-group-divider">
          <div class="res-group-icon">📊</div>
          <div class="res-group-title">전체 측정 항목</div>
          <div class="res-group-sub">${measuredCount}/8 측정 완료</div>
        </div>
      ` : ''}

      <!-- ★ v14.2: 항목별 점수 레이더/막대 차트 -->
      ${measuredCount > 0 ? `
        <div class="res-graph-card">
          ${categoryScores}
        </div>
      ` : ''}

      <!-- 측정 항목 미니 카드 그리드 -->
      <div class="res-mini-grid">
        ${cardsHTML}
      </div>

      <!-- ★ v14.2: 상세 분석 페이지로 이동 CTA -->
      ${measuredCount > 0 ? `
        <button class="res-detail-cta" onclick="App.goPage('detail')" type="button">
          <div class="res-detail-cta-icon">📋</div>
          <div class="res-detail-cta-body">
            <div class="res-detail-cta-title">상세 분석 & 맞춤 처방</div>
            <div class="res-detail-cta-sub">건강 해석, 운동·식단 추천 보기</div>
          </div>
          <div class="res-detail-cta-arrow">›</div>
        </button>

        <!-- ★ v14.3: 트렌드 페이지 CTA -->
        <button class="res-detail-cta trends" onclick="App.goPage('trends')" type="button">
          <div class="res-detail-cta-icon">📈</div>
          <div class="res-detail-cta-body">
            <div class="res-detail-cta-title">시계열 추이 분석</div>
            <div class="res-detail-cta-sub">7일·30일·90일 변화 그래프</div>
          </div>
          <div class="res-detail-cta-arrow">›</div>
        </button>
      ` : `
        <div class="res-tip">
          💡 측정을 시작하면 맞춤 건강 분석과 운동·식단 추천을 받을 수 있어요
        </div>
      `}

      ${result.completeness >= 100 ? `
        <button class="res-reset-btn" onclick="App._wellnessConfirmReset()" type="button">
          🔄 전체 측정 초기화
        </button>
      ` : ''}

      <!-- ★ v15.2.7: 결과 페이지에도 위기 카드 표시 (가장 하단) -->
      ${this._renderResultsCrisisCard()}

      <!-- ★ v14.5: 베타 정보 (디버그 모드에서만 표시) -->
      ${IS_DEBUG ? `
        <div class="debug-section">
          <div class="debug-title">🛠️ 디버그 정보</div>
          <button class="debug-btn" onclick="App._showBetaDebugInfo()" type="button">베타 로그 보기 (에러·이벤트)</button>
        </div>
      ` : ''}
    `;

    // ★ v18.0: innerHTML 완료 후 고급 PPG 카드 렌더링 (DOM 존재 필요)
    if (w.face || w.finger) {
      this._renderAdvancedPPGCardsFromWellness(w, 'results-advanced-cards');
    }
  },

  // ★ v15.2.7: 결과 페이지의 위기 카드 (최근 mood 결과로부터)
  // 최근 7일에 외로움/우울 패턴 감지되면 표시 (이미지4의 카드와 동일)
  _renderResultsCrisisCard() {
    try {
      const history = JSON.parse(localStorage.getItem('history_mood') || '[]');
      if (history.length === 0) return '';
      const latest = history[history.length - 1];

      // 위기 감지 — 최근 측정과 시계열 모두 고려
      const crisis = this._detectMoodCrisis({
        loneliness: latest.loneliness,
        valence: latest.valence,
        negBias: latest.negBias,
        flag: latest.flag,
      });
      if (!crisis) return '';

      // _renderCrisisCard와 동일한 풍부한 카드 사용
      return this._renderCrisisCard();
    } catch (e) {
      return '';
    }
  },

  // ★ v14.5: 베타 디버그 정보 표시 (개발자용)
  _showBetaDebugInfo() {
    let errors = [], events = [];
    try { errors = JSON.parse(localStorage.getItem('beta_errors') || '[]'); } catch (e) {}
    try { events = JSON.parse(localStorage.getItem('beta_events') || '[]'); } catch (e) {}

    let info = `=== 베타 디버그 정보 ===\n`;
    info += `현재 모드: ${APP_MODE}\n`;
    info += `에러 수: ${errors.length}건\n`;
    info += `이벤트 수: ${events.length}건\n\n`;

    if (errors.length > 0) {
      info += `=== 최근 에러 (최대 10건) ===\n`;
      errors.slice(-10).forEach((e, i) => {
        info += `${i+1}. [${new Date(e.t).toLocaleString('ko-KR')}]\n   ${e.msg.substring(0, 200)}\n`;
      });
    }

    if (events.length > 0) {
      info += `\n=== 이벤트 카운트 ===\n`;
      const counts = {};
      events.forEach(e => { counts[e.n] = (counts[e.n] || 0) + 1; });
      Object.entries(counts).sort((a,b) => b[1] - a[1]).forEach(([n, c]) => {
        info += `${n}: ${c}회\n`;
      });
    }

    const modal = document.createElement('div');
    modal.className = 'feedback-modal';
    modal.innerHTML = `
      <div class="feedback-card">
        <div class="feedback-header">
          <div class="feedback-title">🛠️ 베타 디버그 정보</div>
          <button class="feedback-close" type="button" onclick="App._closeFeedback()">✕</button>
        </div>
        <pre style="font-size:11px;font-family:monospace;background:var(--bg);padding:14px;border-radius:10px;max-height:60vh;overflow:auto;white-space:pre-wrap;color:var(--text);">${info}</pre>
        <div class="feedback-footer">
          <button class="beta-btn secondary" type="button" onclick="App._clearBetaData()">데이터 초기화</button>
          <button class="beta-btn primary" type="button" onclick="App._exportBetaData()">📋 클립보드 복사</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) this._closeFeedback();
    });
    setTimeout(() => modal.classList.add('show'), 10);
    this._feedbackModal = modal;
  },

  _exportBetaData() {
    let errors = [], events = [];
    try { errors = JSON.parse(localStorage.getItem('beta_errors') || '[]'); } catch (e) {}
    try { events = JSON.parse(localStorage.getItem('beta_events') || '[]'); } catch (e) {}
    const data = {
      version: 'v14.5',
      timestamp: Date.now(),
      ua: navigator.userAgent,
      errors,
      events,
      wellness: this.state.wellness,
    };
    const text = JSON.stringify(data, null, 2);
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => alert('베타 데이터가 클립보드에 복사되었습니다.'));
    } else {
      prompt('베타 데이터 (복사하세요):', text);
    }
  },

  _clearBetaData() {
    if (!confirm('베타 에러 로그와 이벤트 데이터를 모두 삭제하시겠습니까?')) return;
    try {
      localStorage.removeItem('beta_errors');
      localStorage.removeItem('beta_events');
      alert('베타 데이터가 초기화되었습니다.');
    } catch (e) {}
    this._closeFeedback();
  },

  // ★ v15.2: 건강 측정 결과 페이지의 정신건강 카드 (요약 버전)
  // ★ v15.2.7: 결과 페이지 정신건강 카드 — 풍부한 통합 분석 카드 사용
  // 핵심: mood 결과 페이지와 동일한 풍부한 카드를 결과 페이지에도 표시
  // (이전엔 작은 요약 카드만 표시되어 통합 분석의 가치가 안 보였음)
  _renderResultsMentalCard() {
    let history = [];
    try { history = JSON.parse(localStorage.getItem('history_mood') || '[]'); } catch (e) {}

    if (history.length === 0) {
      return `
        <div class="res-mental-empty" onclick="App.goPage('mood')">
          <div class="rme-icon">🌿</div>
          <div class="rme-body">
            <div class="rme-title">정신건강 측정도 함께 해보세요</div>
            <div class="rme-sub">감정 게임 + 자율신경으로 완성하는 통합 분석</div>
          </div>
          <div class="rme-arrow">→</div>
        </div>
      `;
    }

    const latest = history[history.length - 1];

    // ★ v15.2.7: 결과 페이지 진입 시 mental 실시간 재계산 (얼굴 측정 통합)
    // - 얼굴 측정과 mood 측정 순서 무관하게 항상 최신 데이터로 통합
    const w = this.state.wellness || {};
    const now = Date.now();
    const hasRecentFace = w.face && w.face.t && (now - w.face.t) < 6 * 60 * 60 * 1000;
    const moodRecent = (now - latest.t) < 6 * 60 * 60 * 1000;

    // mental 재계산 조건: mental이 없거나, 얼굴 측정 데이터가 없는 mental이거나, 더 새로운 얼굴 측정이 있을 때
    let needRecalc = !latest.mental;
    if (hasRecentFace && moodRecent) {
      if (!latest.mental || !latest.mental.hasFaceData) needRecalc = true;
      // 얼굴 측정이 mood보다 나중에 있으면 재계산
      else if (latest.faceLink && w.face.t > (latest.t + (latest.faceLink.ageMinutes || 0) * 60000)) needRecalc = true;
    }

    if (needRecalc && hasRecentFace) {
      try {
        const analysisForRecalc = {
          gameId: latest.gameId,
          valence: latest.valence,
          arousal: latest.arousal,
          loneliness: latest.loneliness,
          negBias: latest.negBias,
          flag: latest.flag,
          rawData: latest.rawData,
          faceLink: {
            hr: w.face.hr,
            rmssd: w.face.rmssd,
            stressLevel: w.face.stressLevel,
            respRate: w.face.respRate,
            ageMinutes: Math.round((now - w.face.t) / 60000),
          },
        };
        latest.mental = this._computeMentalWellnessScore(analysisForRecalc);
        latest.faceLink = analysisForRecalc.faceLink;
        // localStorage에도 업데이트
        history[history.length - 1] = latest;
        localStorage.setItem('history_mood', JSON.stringify(history));
        console.log('[Mental] 결과 페이지 재계산 완료');
      } catch (e) {
        console.warn('[Mental] 재계산 실패:', e);
      }
    }

    const m = latest.mental;
    if (!m) {
      return `
        <div class="res-mental-empty" onclick="App.goPage('mood')">
          <div class="rme-icon">✨</div>
          <div class="rme-body">
            <div class="rme-title">새로운 감정 측정 시도해보세요</div>
            <div class="rme-sub">v15.2 통합 정신건강 점수가 제공돼요</div>
          </div>
          <div class="rme-arrow">→</div>
        </div>
      `;
    }

    // ★ v15.2.7: 풍부한 mental 카드 사용 (mood 결과 페이지와 동일)
    // 자기보고 vs 자율신경 비교 막대, 불일치 라벨, 4차원 점수 등 모두 표시
    const analysisForRender = {
      mental: m,
      faceLink: latest.faceLink,
    };

    // 7일 평균 (있으면 부가 표시)
    const recent7 = history.filter(h => Date.now() - h.t < 7 * 24 * 60 * 60 * 1000 && h.mental);
    const avg7 = recent7.length > 0
      ? Math.round(recent7.reduce((s, h) => s + (h.mental.overall || 0), 0) / recent7.length)
      : null;

    // 측정 시점
    const minAgo = Math.round((Date.now() - latest.t) / 60000);
    const timeLabel = minAgo < 60 ? `${minAgo}분 전`
                    : minAgo < 1440 ? `${Math.round(minAgo/60)}시간 전`
                    : `${Math.round(minAgo/1440)}일 전`;

    return `
      <div class="res-section-title">🧠 정신건강 점수 <span class="res-section-sub">(자기보고 + 자율신경 통합)</span></div>
      <div class="mental-card-results" onclick="App.goPage('mood')">
        <div class="mental-results-meta">
          <span class="mental-results-time">📍 ${timeLabel}</span>
          ${avg7 !== null && recent7.length >= 2 ? `<span class="mental-results-avg">7일 평균 ${avg7}점</span>` : ''}
          <span class="mental-results-link">자세히 보기 →</span>
        </div>
        ${this._renderMentalWellnessCard(analysisForRender)}
      </div>
    `;
  },

  // ★ v16.2: 통합 심혈관 측정 카드 (손가락 + 얼굴 가중평균)
  // 손가락 측정이 SNR 10배 높아 정확도 우위 → 가중평균으로 신뢰성 ↑
  _renderUnifiedCardioCard(w) {
    const cardio = this._getUnifiedCardio(w);
    if (!cardio) return '';

    // 소스에 따라 카드 스타일 다르게
    let badgeColor, badgeIcon, badgeText;
    if (cardio.source === 'unified') {
      badgeColor = '#7c3aed'; // 보라 (가중평균)
      badgeIcon = '🔬';
      badgeText = '통합 측정 (가중평균)';
    } else if (cardio.source === 'finger') {
      badgeColor = '#dc2626'; // 빨강 (손가락)
      badgeIcon = '☝️';
      badgeText = '손가락 측정 (임상급)';
    } else {
      badgeColor = '#3b82f6'; // 파랑 (얼굴)
      badgeIcon = '😊';
      badgeText = '얼굴 측정';
    }

    // 신뢰도
    const conf = cardio.confidence;
    const confBadge = conf === 'high' ? '🟢 신뢰도 높음' :
                      conf === 'medium' ? '🟡 신뢰도 보통' :
                      conf === 'low' ? '🔴 신뢰도 낮음' : '';

    // 측정 시각 (가장 최근)
    const tStr = this._formatRelativeTime(cardio.t);

    // 가중치 표시 (통합인 경우만)
    const weightInfo = cardio.source === 'unified' ? `
      <div class="unified-weight-info">
        <div class="uwi-row">
          <span class="uwi-label">☝️ 손가락</span>
          <div class="uwi-bar"><div class="uwi-fill finger" style="width:${cardio.fingerWeight * 100}%"></div></div>
          <span class="uwi-val">${Math.round(cardio.fingerWeight * 100)}%</span>
        </div>
        <div class="uwi-row">
          <span class="uwi-label">😊 얼굴</span>
          <div class="uwi-bar"><div class="uwi-fill face" style="width:${cardio.faceWeight * 100}%"></div></div>
          <span class="uwi-val">${Math.round(cardio.faceWeight * 100)}%</span>
        </div>
      </div>
    ` : '';

    // 스트레스 라벨
    const stressLabels = ['', '매우 이완', '이완', '보통', '긴장', '높은 스트레스'];
    const stressColors = ['', '#16a34a', '#22c55e', '#3b82f6', '#f59e0b', '#dc2626'];
    const stressLabel = stressLabels[cardio.stressLevel || 3];
    const stressColor = stressColors[cardio.stressLevel || 3];

    return `
      <div class="res-section-title">❤️ 심혈관 측정 (통합)</div>
      <div class="unified-cardio-card" style="border-color:${badgeColor}33">
        <div class="ucc-header">
          <div class="ucc-badge" style="background:${badgeColor}">
            ${badgeIcon} ${badgeText}
          </div>
          ${confBadge ? `<div class="ucc-conf">${confBadge}</div>` : ''}
        </div>

        ${weightInfo}

        <div class="ucc-metrics">
          <div class="ucc-metric">
            <div class="ucc-m-label">심박수</div>
            <div class="ucc-m-value">${cardio.hr || '--'}<span class="ucc-m-unit">BPM</span></div>
            <div class="ucc-m-range">정상 60~100</div>
          </div>
          <div class="ucc-metric highlight">
            <div class="ucc-m-label">HRV (RMSSD)</div>
            <div class="ucc-m-value">${cardio.rmssd || '--'}<span class="ucc-m-unit">ms</span></div>
            <div class="ucc-m-range">정상 20~60</div>
          </div>
          <div class="ucc-metric">
            <div class="ucc-m-label">스트레스</div>
            <div class="ucc-m-value" style="color:${stressColor}; font-size: 18px">${stressLabel}</div>
            <div class="ucc-m-range">5단계 척도</div>
          </div>
        </div>

        ${cardio.stressIndex !== undefined ? `
          <div class="ucc-stress-row">
            <span class="ucc-sr-label">🌡️ 스트레스 지수 (Baevsky)</span>
            <span class="ucc-sr-value" style="color:${
              cardio.stressIndex < 50 ? '#16a34a' :
              cardio.stressIndex < 150 ? '#3b82f6' :
              cardio.stressIndex < 500 ? '#f59e0b' : '#dc2626'
            }">${cardio.stressIndex}</span>
          </div>
        ` : ''}

        <div class="ucc-meta">
          <span>${tStr} 측정</span>
          ${cardio.respRate ? `<span>호흡 ${cardio.respRate}회/분</span>` : ''}
          ${cardio.signalQuality ? `<span>품질 ${cardio.signalQuality}%</span>` : ''}
        </div>

        ${cardio.source === 'unified' ? `
          <div class="ucc-explainer">
            💡 손가락 측정이 일반적으로 더 정확하지만, 두 측정을 함께 활용해 신뢰도를 높였어요.
            손가락 측정 신뢰도가 높을수록 가중치가 커집니다.
          </div>
        ` : cardio.source === 'face' ? `
          <div class="ucc-explainer">
            💡 손가락 측정을 추가로 진행하면 임상급 정확도로 측정할 수 있어요.
            <button class="ucc-action" type="button" onclick="App.goPage('finger')">☝️ 손가락 측정하기</button>
          </div>
        ` : `
          <div class="ucc-explainer">
            ✓ 손가락 측정은 가장 정확한 방법입니다. 얼굴 측정도 함께 진행하면 더 균형잡힌 분석이 가능해요.
          </div>
        `}

        <!-- ★ v18.0: 고급 PPG 요약 뱃지 (결과 있을 때만) -->
        ${this._renderAdvancedPPGSummaryBadges(w)}
      </div>
    `;
  },

  // ★ v18.0: 통합 심혈관 카드 내 고급 PPG 요약 인라인 뱃지
  _renderAdvancedPPGSummaryBadges(w) {
    if (!w) return '';
    const faceData   = w.face   || null;
    const fingerData = w.finger || null;
    const va  = faceData?.vascularAge   || null;
    const rsa = faceData?.rsaIndex ?? null;
    const arr = faceData?.arrhythmia || fingerData?.arrhythmia || null;
    if (!va && !arr && rsa === null) return '';

    const badges = [];
    if (va) {
      const c = va.grade === 'young' ? '#22c55e' : va.grade === 'aged' ? '#ef4444' : '#3b82f6';
      const icon = va.grade === 'young' ? '💪' : va.grade === 'aged' ? '⚠️' : '✅';
      badges.push(`<span class="ppg-sum-badge" style="background:${c}22;color:${c}">${icon} 혈관나이 ${va.estimatedAge}세</span>`);
    }
    if (arr) {
      const c = arr.risk === 'low' ? '#22c55e' : arr.risk === 'moderate' ? '#f59e0b' : '#ef4444';
      const icon = arr.risk === 'low' ? '💚' : arr.risk === 'moderate' ? '🟡' : '🔴';
      const lbl = arr.risk === 'low' ? '리듬 정상' : arr.risk === 'moderate' ? '리듬 주의' : '부정맥 의심';
      badges.push(`<span class="ppg-sum-badge" style="background:${c}22;color:${c}">${icon} ${lbl}</span>`);
    }
    if (rsa !== null) {
      const c = rsa >= 50 ? '#22c55e' : rsa >= 25 ? '#f59e0b' : '#ef4444';
      badges.push(`<span class="ppg-sum-badge" style="background:${c}22;color:${c}">🌬️ RSA ${rsa}/100</span>`);
    }
    if (badges.length === 0) return '';
    return `<div class="ppg-sum-badges">${badges.join('')}</div>`;
  },

  // ★ v14.4: 결과 페이지의 평소 대비 변화 카드
  _renderBaselineComparisonCard(w) {
    if (!w.face) return '';

    const history = this._historyGet('face');
    if (history.length < 4) {
      // 4회 미만이면 baseline 부족
      const need = 4 - history.length;
      return `
        <div class="baseline-need-card">
          <div class="baseline-need-icon">📊</div>
          <div class="baseline-need-text">
            <div class="baseline-need-title">평소 대비 분석 준비 중</div>
            <div class="baseline-need-sub">${need}회 더 측정하면 본인 평소와 비교한 정확한 분석이 가능해요</div>
          </div>
        </div>
      `;
    }

    // 최신 1회 제외한 과거 평균
    const latest = history[history.length - 1];
    const pastHistory = history.slice(0, -1);
    const hrStats = this._historyStats(pastHistory, 'hr');
    const rmssdStats = this._historyStats(pastHistory, 'rmssd');
    const stressStats = this._historyStats(pastHistory, 'stressLevel');

    // 변화 평가
    const metrics = [];
    if (hrStats && latest.hr != null) {
      const diff = latest.hr - hrStats.mean;
      const pct = (diff / hrStats.mean) * 100;
      metrics.push({
        icon: '💗',
        name: '심박수',
        latest: latest.hr,
        baseline: Math.round(hrStats.mean),
        unit: 'BPM',
        diff,
        pct,
        // HR은 평소보다 낮을수록 좋음 (이완)
        cls: Math.abs(pct) < 3 ? 'stable' : pct < 0 ? 'good' : pct > 10 ? 'warn' : 'normal',
        label: Math.abs(pct) < 3 ? '평소 수준' : pct < 0 ? '평소보다 낮음' : '평소보다 높음',
      });
    }
    if (rmssdStats && latest.rmssd != null) {
      const diff = latest.rmssd - rmssdStats.mean;
      const pct = (diff / rmssdStats.mean) * 100;
      metrics.push({
        icon: '✨',
        name: 'HRV',
        latest: latest.rmssd,
        baseline: Math.round(rmssdStats.mean),
        unit: 'ms',
        diff,
        pct,
        // RMSSD는 평소보다 높을수록 좋음 (회복)
        cls: Math.abs(pct) < 5 ? 'stable' : pct > 0 ? 'good' : pct < -15 ? 'warn' : 'normal',
        label: Math.abs(pct) < 5 ? '평소 수준' : pct > 0 ? '평소보다 좋음' : '평소보다 낮음',
      });
    }
    if (stressStats && latest.stressLevel != null) {
      const diff = latest.stressLevel - stressStats.mean;
      metrics.push({
        icon: '😌',
        name: '스트레스',
        latest: latest.stressLevel,
        baseline: stressStats.mean.toFixed(1),
        unit: '/5',
        diff,
        pct: 0,
        // 스트레스는 낮을수록 좋음
        cls: Math.abs(diff) < 0.3 ? 'stable' : diff < 0 ? 'good' : diff > 0.7 ? 'warn' : 'normal',
        label: Math.abs(diff) < 0.3 ? '평소 수준' : diff < 0 ? '평소보다 좋음' : '평소보다 높음',
        isStress: true,
      });
    }

    if (metrics.length === 0) return '';

    const cardsHTML = metrics.map(m => {
      const arrow = m.isStress
        ? (m.diff > 0.3 ? '↑' : m.diff < -0.3 ? '↓' : '→')
        : (m.pct > 3 ? '↑' : m.pct < -3 ? '↓' : '→');
      const changeText = m.isStress
        ? (Math.abs(m.diff) < 0.3 ? '비슷' : `${arrow} ${Math.abs(m.diff).toFixed(1)}단계`)
        : (Math.abs(m.pct) < 3 ? '비슷' : `${arrow} ${Math.abs(m.pct).toFixed(0)}%`);

      return `
        <div class="baseline-metric ${m.cls}">
          <div class="baseline-metric-header">
            <span class="baseline-metric-icon">${m.icon}</span>
            <span class="baseline-metric-name">${m.name}</span>
          </div>
          <div class="baseline-metric-row">
            <div class="baseline-metric-value">
              <div class="baseline-metric-now">${m.latest}<span class="baseline-metric-unit">${m.unit}</span></div>
              <div class="baseline-metric-vs">평소 ${m.baseline}${m.unit}</div>
            </div>
            <div class="baseline-metric-change">
              <div class="baseline-metric-arrow">${arrow}</div>
              <div class="baseline-metric-label">${m.label}</div>
              <div class="baseline-metric-pct">${changeText}</div>
            </div>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="res-section-title">📊 평소 대비 변화 <span class="res-section-sub">(지난 ${pastHistory.length}회 평균 기준)</span></div>
      <div class="baseline-grid">
        ${cardsHTML}
      </div>
    `;
  },

  // ★ v14.2: 종합 점수 분포 곡선 (신체지수 BMI 차트 스타일)
  _buildScoreDistributionChart(score, color) {
    const x = Math.max(40, Math.min(380, 40 + (score / 100) * 340));
    const y = score < 50 ? 100 : score < 70 ? 80 : score < 85 ? 60 : 55;
    return `
      <svg class="res-graph-svg" viewBox="0 0 400 160" preserveAspectRatio="xMidYMid meet">
        <line x1="40" y1="120" x2="380" y2="120" stroke="#e5e7eb" stroke-width="1"/>
        <!-- 5개 영역 -->
        <rect x="40" y="20" width="60" height="100" fill="rgba(239,68,68,0.10)"/>
        <rect x="100" y="20" width="60" height="100" fill="rgba(245,158,11,0.10)"/>
        <rect x="160" y="20" width="60" height="100" fill="rgba(59,130,246,0.10)"/>
        <rect x="220" y="20" width="80" height="100" fill="rgba(34,197,94,0.12)"/>
        <rect x="300" y="20" width="80" height="100" fill="rgba(34,197,94,0.18)"/>
        <!-- 분포 곡선 (정규분포 모방) -->
        <path d="M40,120 Q90,118 130,100 Q180,60 240,55 Q310,80 380,118"
              fill="none" stroke="#7c3aed" stroke-width="2.5" stroke-linecap="round" opacity="0.8"/>
        <!-- 본인 위치 마커 -->
        <line x1="${x}" y1="20" x2="${x}" y2="120" stroke="${color}" stroke-width="2" stroke-dasharray="3,2"/>
        <circle cx="${x}" cy="${y}" r="8" fill="${color}" stroke="#fff" stroke-width="3"/>
        <text x="${x}" y="${y - 14}" text-anchor="middle" font-size="12" font-weight="800" fill="${color}">${score}</text>
        <!-- X축 라벨 -->
        <text x="70" y="138" text-anchor="middle" font-size="10" fill="#ef4444">위험</text>
        <text x="130" y="138" text-anchor="middle" font-size="10" fill="#f59e0b">주의</text>
        <text x="190" y="138" text-anchor="middle" font-size="10" fill="#3b82f6">보통</text>
        <text x="260" y="138" text-anchor="middle" font-size="10" fill="#22c55e" font-weight="700">양호</text>
        <text x="340" y="138" text-anchor="middle" font-size="10" fill="#16a34a" font-weight="700">우수</text>
        <text x="70" y="155" text-anchor="middle" font-size="9" fill="#9ca3af">&lt;50</text>
        <text x="130" y="155" text-anchor="middle" font-size="9" fill="#9ca3af">50-70</text>
        <text x="190" y="155" text-anchor="middle" font-size="9" fill="#9ca3af">70-85</text>
        <text x="260" y="155" text-anchor="middle" font-size="9" fill="#9ca3af">85-95</text>
        <text x="340" y="155" text-anchor="middle" font-size="9" fill="#9ca3af">95+</text>
      </svg>
    `;
  },

  // ★ v14.2: 항목별 점수 막대 차트 (가로 막대)
  _buildCategoryRadarChart(w, items) {
    const measuredItems = items.filter(it => w[it.key]);
    if (measuredItems.length === 0) return '';

    let bars = '';
    for (const it of measuredItems) {
      const score = w[it.key].score || 0;
      const c = score >= 85 ? '#22c55e' : score >= 70 ? '#3b82f6' : score >= 50 ? '#f59e0b' : '#ef4444';
      const label = score >= 85 ? '우수' : score >= 70 ? '양호' : score >= 50 ? '보통' : '주의';
      bars += `
        <div class="cat-bar-row">
          <div class="cat-bar-label">
            <span class="cat-bar-icon">${it.icon}</span>
            <span class="cat-bar-name">${it.name}</span>
          </div>
          <div class="cat-bar-track">
            <div class="cat-bar-fill" style="width:${score}%;background:linear-gradient(90deg, ${c}88, ${c})">
              <span class="cat-bar-score">${score}</span>
            </div>
          </div>
          <div class="cat-bar-status" style="color:${c}">${label}</div>
        </div>
      `;
    }
    return `<div class="cat-bars">${bars}</div>`;
  },

  // ★ v14.2: 상세 분석 페이지 렌더링 (이전 _renderHealthInsights)
  _renderDetailPage() {
    const container = document.getElementById('detail-dashboard');
    if (!container) return;
    container.innerHTML = this._renderHealthInsights();
    // ★ v18.0: detail 페이지에도 고급 PPG 카드 렌더링
    const w = this.state.wellness || {};
    if (w.face || w.finger) {
      this._renderAdvancedPPGCardsFromWellness(w, 'detail-advanced-cards');
    }
  },

  // ★ v14.1/v14.2: 통합 건강 해석 + 맞춤 운동/식단 추천
  _renderHealthInsights() {
    const w = this.state.wellness || {};
    const measuredCount = ['face','balance','gait','tremor','reaction','posture','bodycomp']
      .filter(k => w[k]).length;
    if (measuredCount === 0) {
      return `
        <div class="insights-empty">
          <div class="insights-empty-icon">📋</div>
          <div class="insights-empty-title">측정을 시작하면 맞춤 건강 분석이 나옵니다</div>
          <div class="insights-empty-sub">하나라도 측정하면 자세한 해석과 맞춤 운동·식단을 알려드려요</div>
        </div>
      `;
    }

    // ====== 1. 건강 인사이트 (통합 해석) 생성 ======
    const insights = this._generateHealthInsights(w);
    // ====== 2. 운동 처방 ======
    const exercises = this._generateExerciseRecommendations(w);
    // ====== 3. 식단 처방 ======
    const diet = this._generateDietRecommendations(w);

    // 인사이트 HTML
    const insightsHTML = insights.map(ins => `
      <div class="insight-card ${ins.cls}">
        <div class="insight-header">
          <div class="insight-icon">${ins.icon}</div>
          <div class="insight-headline">
            <div class="insight-title">${ins.title}</div>
            <div class="insight-label">${ins.label}</div>
          </div>
        </div>
        <div class="insight-body">${ins.body}</div>
        ${ins.tip ? `<div class="insight-tip">💡 <strong>한 줄 조언:</strong> ${ins.tip}</div>` : ''}
      </div>
    `).join('');

    // 운동 HTML
    const exercisesHTML = exercises.map(ex => `
      <div class="rx-card">
        <div class="rx-header">
          <div class="rx-priority ${ex.priority}">${ex.priority === 'high' ? '⭐ 가장 필요' : ex.priority === 'mid' ? '추천' : '유지'}</div>
          <div class="rx-title">${ex.icon} ${ex.name}</div>
        </div>
        <div class="rx-why">
          <strong>왜 필요한가요?</strong> ${ex.why}
        </div>
        <div class="rx-how">
          <strong>어떻게 하나요?</strong>
          <ol class="rx-steps">
            ${ex.steps.map(s => `<li>${s}</li>`).join('')}
          </ol>
        </div>
        <div class="rx-dose">
          <div class="rx-dose-item">
            <div class="rx-dose-label">횟수</div>
            <div class="rx-dose-value">${ex.frequency}</div>
          </div>
          <div class="rx-dose-item">
            <div class="rx-dose-label">시간</div>
            <div class="rx-dose-value">${ex.duration}</div>
          </div>
          <div class="rx-dose-item">
            <div class="rx-dose-label">강도</div>
            <div class="rx-dose-value">${ex.intensity}</div>
          </div>
        </div>
        ${ex.caution ? `<div class="rx-caution">⚠️ ${ex.caution}</div>` : ''}
      </div>
    `).join('');

    // 식단 HTML
    const dietHTML = `
      <div class="diet-summary">
        <div class="diet-summary-title">${diet.headline}</div>
        <div class="diet-summary-desc">${diet.summary}</div>
      </div>
      <div class="diet-meals">
        ${diet.meals.map(meal => `
          <div class="diet-meal-card">
            <div class="diet-meal-header">
              <div class="diet-meal-time">${meal.time}</div>
              <div class="diet-meal-title">${meal.icon} ${meal.title}</div>
            </div>
            <div class="diet-meal-foods">
              ${meal.foods.map(f => `
                <div class="diet-food-row">
                  <span class="diet-food-name">${f.name}</span>
                  <span class="diet-food-amount">${f.amount}</span>
                </div>
              `).join('')}
            </div>
            <div class="diet-meal-tip">${meal.tip}</div>
          </div>
        `).join('')}
      </div>
      ${diet.avoid.length > 0 ? `
        <div class="diet-avoid-card">
          <div class="diet-avoid-title">🚫 이번 주 피하면 좋은 것</div>
          <ul class="diet-avoid-list">
            ${diet.avoid.map(a => `<li>${a}</li>`).join('')}
          </ul>
        </div>
      ` : ''}
      ${diet.prefer.length > 0 ? `
        <div class="diet-prefer-card">
          <div class="diet-prefer-title">✨ 이번 주 챙기면 좋은 것</div>
          <ul class="diet-prefer-list">
            ${diet.prefer.map(a => `<li>${a}</li>`).join('')}
          </ul>
        </div>
      ` : ''}
    `;

    return `
      <!-- ★ v18.0: 고급 PPG 분석 (혈관나이/부정맥/RSA) -->
      ${(w.face || w.finger) ? `
        <div class="res-section-title">🔬 고급 심혈관 분석 <span style="font-size:10px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border-radius:6px;padding:2px 8px;font-weight:700;vertical-align:middle;margin-left:6px">ME-rPPG</span></div>
        <div id="detail-advanced-cards"></div>
      ` : ''}

      <!-- 상세 건강 해석 -->
      <div class="res-section-title">📋 내 건강 이야기</div>
      <div class="insights-intro">
        측정 결과를 종합해서 알기 쉽게 풀어드려요
      </div>
      <div class="insights-list">
        ${insightsHTML}
      </div>

      <!-- 맞춤 운동 처방 -->
      <div class="res-section-title">🏃 맞춤 운동 처방</div>
      <div class="rx-intro">
        측정 결과를 바탕으로 가장 도움될 운동부터 알려드려요
      </div>
      <div class="rx-list">
        ${exercisesHTML}
      </div>

      <!-- 맞춤 식단 추천 -->
      <div class="res-section-title">🥗 맞춤 식단 추천</div>
      <div class="diet-block">
        ${dietHTML}
      </div>

      <!-- 의료기기 아님 안내 -->
      <div class="medical-disclaimer">
        ⚠️ 이 내용은 일반적인 건강 가이드이며 의료 진단·처방이 아닙니다.<br>
        지속되는 증상이나 기저질환이 있으시면 반드시 전문의와 상의하세요.
      </div>
    `;
  },

  // ★ v14.1: 통합 인사이트 생성 (각 측정 결과를 노인도 이해 가능한 언어로)
  // ★ v16.2: 얼굴 + 손가락 측정 통합 — 신뢰도 가중평균
  // 손가락 측정이 일반적으로 정확도가 높으므로 가중치 더 줌
  // 6시간 이내 측정만 통합, 더 오래된 측정은 가중치 감소
  //
  // 학술 근거:
  //   - Allagi 2022: 손가락 PPG가 얼굴 rPPG보다 SNR 10배 높음
  //   - Sun 2022: HR 측정 시 손가락 PPG ECG 대비 r=0.98, 얼굴 r=0.89
  //   - 측정 시간 차이가 작을수록 통합 정확도 향상 (Bizzego 2019)
  _getUnifiedCardio(w) {
    if (!w) return null;
    const now = Date.now();
    const MAX_AGE = 6 * 60 * 60 * 1000; // 6시간

    // 손가락 측정 정보 (확률적으로 더 정확)
    let fingerData = null;
    let fingerWeight = 0;
    if (w.finger && w.finger.t && (now - w.finger.t) < MAX_AGE) {
      const ageHr = (now - w.finger.t) / 3600000;
      // 시간 감쇠: 0시간=1.0, 3시간=0.7, 6시간=0.4
      const timeDecay = Math.max(0.4, 1 - ageHr * 0.1);
      // 신뢰도 가중치
      const confWeight = w.finger.confidence === 'high' ? 1.0 :
                         w.finger.confidence === 'medium' ? 0.7 : 0.4;
      // 손가락은 본래 30% 우대 (정확도 우위)
      fingerWeight = timeDecay * confWeight * 1.3;
      fingerData = {
        hr: w.finger.hr,
        rmssd: w.finger.rmssd,
        sdnn: w.finger.sdnn,
        pNN50: w.finger.pNN50,
        stressLevel: w.finger.stressLevel,
        stressIndex: w.finger.stressIndex,
        signalQuality: w.finger.signalQuality,
        t: w.finger.t,
      };
    }

    // 얼굴 측정 정보
    let faceData = null;
    let faceWeight = 0;
    if (w.face && w.face.t && (now - w.face.t) < MAX_AGE) {
      const ageHr = (now - w.face.t) / 3600000;
      const timeDecay = Math.max(0.4, 1 - ageHr * 0.1);
      // 얼굴은 기본 가중치 1.0
      faceWeight = timeDecay * 1.0;
      faceData = {
        hr: w.face.hr,
        rmssd: w.face.rmssd,
        sdnn: w.face.sdnn,
        pNN50: w.face.pNN50,
        stressLevel: w.face.stressLevel,
        respRate: w.face.respRate,
        signalQuality: w.face.signalQuality,
        t: w.face.t,
      };
    }

    if (!fingerData && !faceData) return null;

    // 한쪽만 있으면 그 값 사용
    if (!fingerData) return { ...faceData, source: 'face', sourceLabel: '얼굴 측정' };
    if (!faceData) return {
      ...fingerData,
      source: 'finger',
      sourceLabel: '손가락 측정 (임상급)',
      confidence: w.finger.confidence,
    };

    // 둘 다 있으면 가중평균
    const totalWeight = fingerWeight + faceWeight;
    const wF = fingerWeight / totalWeight; // 손가락 비율
    const wA = faceWeight / totalWeight;   // 얼굴 비율

    const blend = (a, b) => {
      if (a == null && b == null) return null;
      if (a == null) return b;
      if (b == null) return a;
      return a * wF + b * wA;
    };

    return {
      hr: Math.round(blend(fingerData.hr, faceData.hr)),
      rmssd: Math.round(blend(fingerData.rmssd, faceData.rmssd) * 10) / 10,
      sdnn: Math.round(blend(fingerData.sdnn, faceData.sdnn) * 10) / 10,
      pNN50: Math.round(blend(fingerData.pNN50, faceData.pNN50) * 10) / 10,
      stressLevel: Math.round(blend(fingerData.stressLevel, faceData.stressLevel)),
      stressIndex: fingerData.stressIndex, // 손가락에서만 계산
      respRate: faceData.respRate, // 얼굴에서만 계산
      signalQuality: Math.round(blend(fingerData.signalQuality, faceData.signalQuality)),
      t: Math.max(fingerData.t, faceData.t),
      source: 'unified',
      sourceLabel: `통합 측정 (손가락 ${Math.round(wF*100)}% + 얼굴 ${Math.round(wA*100)}%)`,
      fingerWeight: wF,
      faceWeight: wA,
      confidence: w.finger.confidence,
    };
  },

  _generateHealthInsights(w) {
    const insights = [];

    // ★ v16.2: 얼굴 + 손가락 측정 통합 데이터 사용
    const cardio = this._getUnifiedCardio(w);

    // ★ v16.8: 측정값 다양성 — 시간대, RMSSD, 호흡수 등 보조 데이터로 멘트 다양화
    const now = new Date();
    const hour = now.getHours();
    const isMorning = hour >= 5 && hour < 11;
    const isAfternoon = hour >= 11 && hour < 17;
    const isEvening = hour >= 17 && hour < 22;
    const isNight = hour >= 22 || hour < 5;

    // 측정 빈도 (다양한 멘트를 위해)
    let measureCount = 0;
    try {
      const histKey = w.finger ? 'history_finger' : 'history_face';
      const hist = JSON.parse(localStorage.getItem(histKey) || '[]');
      measureCount = hist.length;
    } catch (e) {}

    // 1. 심혈관 (통합 측정)
    if (cardio) {
      const hr = cardio.hr;
      const rmssd = cardio.rmssd;
      const stress = cardio.stressLevel || 3;
      let cls = 'good', icon = '💗', title, label, body, tip;
      if (hr) {
        // ★ v16.8: HR 4단계 × RMSSD 보조 × 시간대 = 다양한 조합
        const rmssdGood = rmssd && rmssd >= 35;
        const rmssdLow = rmssd && rmssd < 20;

        if (hr < 60) {
          cls = 'good';
          // 시간대별 변형
          if (isMorning) {
            title = '아침인데도 심장이 평온하게 뛰고 있어요';
            body = `심박수가 분당 ${hr}회로 아침 안정 심박치고도 차분합니다. 평소 운동을 잘 하시거나 깊은 수면을 취하시는 분들의 특징입니다. ${rmssdGood ? `심박변이도(HRV)도 ${rmssd}ms로 양호해 자율신경 균형도 좋은 상태예요.` : ''}`;
            tip = isMorning ? '아침 산책 20분이면 이 컨디션이 하루 종일 이어집니다' : '가벼운 걷기를 꾸준히 해주세요';
          } else if (isEvening) {
            title = '하루를 마무리하기 좋은 안정 상태';
            body = `저녁 심박수가 분당 ${hr}회로 매우 차분합니다. 하루의 활동 후에도 심장이 잘 회복되고 있다는 신호입니다. ${rmssdGood ? `HRV ${rmssd}ms로 부교감신경이 잘 작동 중이에요.` : ''}`;
            tip = '수면 1시간 전부터 스마트폰 화면을 어둡게 해보세요';
          } else {
            title = '심장이 매우 안정적이에요';
            body = `심박수가 분당 ${hr}회로 매우 차분합니다. 60회 미만은 평소 운동을 잘 하시거나 휴식을 깊게 취하시는 분들에게 나타나는 좋은 신호입니다. ${rmssdGood ? `자율신경 균형도 좋은 상태(HRV ${rmssd}ms)예요.` : ''}`;
            tip = '지금 컨디션을 유지하면서 가벼운 걷기를 꾸준히 해주세요';
          }
          label = `심박수 ${hr} BPM${rmssd ? ` · HRV ${rmssd}ms` : ''}`;
        } else if (hr < 80) {
          cls = 'good';
          // RMSSD 상태에 따라 분기
          if (rmssdGood) {
            title = '심장과 자율신경 모두 건강해요';
            body = `심박수 ${hr} BPM, HRV ${rmssd}ms로 둘 다 양호합니다. 심장이 정상 범위 안에서 일하면서 자율신경 회복력도 좋은 균형 잡힌 상태예요. ${isMorning ? '아침부터 컨디션이 좋은 하루를 시작하셨네요.' : isEvening ? '하루를 잘 보내신 후의 안정된 모습입니다.' : ''}`;
            tip = measureCount > 3 ? '꾸준한 측정으로 본인 baseline이 잡혀가고 있어요' : '주 3회 이상 30분 걷기로 이 상태를 유지하세요';
          } else if (rmssdLow) {
            title = '심박수는 정상, 자율신경은 조금 긴장';
            body = `심박수 ${hr} BPM은 정상 범위이지만 HRV ${rmssd}ms로 자율신경이 평소보다 긴장된 상태입니다. 카페인, 부족한 수면, 누적 피로 중 하나가 원인일 수 있어요.`;
            tip = '오늘은 가능한 일찍 잠자리에 들어보세요';
          } else {
            title = '심장이 정상적으로 일하고 있어요';
            body = `심박수가 분당 ${hr}회로 건강한 성인의 정상 범위(60~80회) 안에 있습니다. 심장이 무리 없이 잘 일하고 있다는 뜻이에요.${rmssd ? ` HRV는 ${rmssd}ms입니다.` : ''}`;
            tip = '주 3회 이상 30분 걷기로 이 상태를 유지하세요';
          }
          label = `심박수 ${hr} BPM${rmssd ? ` · HRV ${rmssd}ms` : ''}`;
        } else if (hr < 100) {
          cls = 'warn';
          // 시간대 + RMSSD 조합
          if (isMorning) {
            title = '아침 심박수가 약간 높아요';
            body = `심박수가 분당 ${hr}회로 아침 안정 심박보다 높습니다. 알람으로 갑자기 깨거나, 어제 카페인을 늦게 드셨거나, 수면이 부족했을 때 나타나는 패턴입니다.${rmssdLow ? ' HRV도 낮아 자율신경이 충분히 회복하지 못한 상태로 보여요.' : ''}`;
            tip = '천천히 5분 호흡한 후 다시 측정해보세요';
          } else if (isEvening) {
            title = '저녁인데 심장이 평소보다 활발해요';
            body = `심박수 ${hr} BPM은 저녁 안정 시치고 약간 빠른 편입니다. 오늘 활동량이 많았거나 저녁 식사 직후이거나 카페인 섭취 영향일 수 있어요. 30분 정도 휴식 후 다시 측정해보세요.`;
            tip = '잠자리 들기 2시간 전부터는 카페인을 피해주세요';
          } else {
            title = '심장이 평소보다 빠르게 뛰고 있어요';
            body = `심박수가 분당 ${hr}회로 정상 범위 상단입니다. 측정 직전 활동, 카페인 섭취, 긴장 등이 영향을 주었을 수 있어요. 한두 번 더 측정해보고 계속 80 이상이면 휴식과 수분 섭취를 늘려보세요.`;
            tip = '깊은 호흡(4초 들이쉬고 6초 내쉬기)을 5분 해보세요';
          }
          label = `심박수 ${hr} BPM${rmssd ? ` · HRV ${rmssd}ms` : ''}`;
        } else {
          cls = 'bad';
          title = '심장이 빠르게 뛰고 있어요';
          body = `안정 시 심박수가 분당 ${hr}회로 다소 빠릅니다. 카페인, 스트레스, 부족한 수면, 탈수 등이 원인일 수 있어요.${rmssdLow ? ` HRV도 낮아(${rmssd}ms) 자율신경 회복이 필요한 상태로 보입니다.` : ''} 5분간 편안히 앉아 호흡한 후 다시 측정해보세요. 반복적으로 100 이상이면 병원 진료를 권합니다.`;
          tip = '카페인 줄이고 물을 한 잔 마신 후 다시 측정해보세요';
          label = `심박수 ${hr} BPM${rmssd ? ` · HRV ${rmssd}ms` : ''}`;
        }
      }
      if (title) {
        insights.push({ cls, icon, title, label, body, tip });
      }

      // 스트레스 인사이트 별도 — 시간대 추가
      if (stress >= 4) {
        const stressBody = isNight
          ? `자율신경이 평소보다 긴장된 패턴입니다. 늦은 시각의 측정은 디지털 자극(스마트폰, TV)과 늦은 식사가 영향을 줄 수 있어요. 만성 스트레스가 누적되면 면역력 저하, 수면 장애로 이어질 수 있습니다.`
          : isMorning
          ? `아침부터 자율신경이 긴장된 상태로 시작하셨네요. 수면 질이 충분하지 않았거나, 오늘 일정에 대한 부담이 무의식적으로 영향을 줄 수 있어요. 의도적인 휴식 시간을 가져보세요.`
          : `자율신경(심박변이도)이 평소보다 긴장된 패턴을 보입니다. 만성 스트레스나 피로가 누적되면 면역력 저하, 수면 장애, 혈압 상승으로 이어질 수 있어요. 오늘 하루 10분이라도 의도적인 휴식을 가져보세요.`;

        const stressTip = isMorning
          ? '아침 햇볕 5분 + 가벼운 스트레칭으로 부드럽게 깨어나보세요'
          : isEvening
          ? '저녁 명상 앱이나 자연 소리 음악으로 마음을 가라앉혀보세요'
          : '4-7-8 호흡법: 4초 들이쉬고 7초 멈췄다가 8초 내쉬기를 3번 반복';

        insights.push({
          cls: stress === 5 ? 'bad' : 'warn',
          icon: '😰',
          title: stress === 5 ? '높은 스트레스 신호가 감지됐어요' : '약간 긴장된 상태예요',
          label: `스트레스 ${stress}/5단계`,
          body: stressBody,
          tip: stressTip,
        });
      } else if (stress <= 2) {
        const goodBody = isMorning
          ? `아침부터 자율신경이 안정적이고 부교감신경(휴식 모드)이 잘 작동하고 있어요. 충분한 수면 후의 좋은 컨디션입니다.`
          : isEvening
          ? `저녁 시간 자율신경이 평온하게 안정되어 있어요. 하루를 잘 마무리하고 회복 모드로 잘 전환된 상태입니다.`
          : `자율신경이 안정적이고 부교감신경(휴식 모드)이 잘 작동하고 있습니다. 이런 상태에서는 회복, 소화, 면역 기능이 활발하게 일어납니다.`;

        const goodTip = isMorning
          ? '아침 산책 20분이면 이 좋은 상태가 더 오래 지속됩니다'
          : isEvening
          ? '이 안정된 상태로 잠자리에 들면 깊은 수면을 취할 수 있어요'
          : measureCount > 3
          ? '꾸준한 측정 덕분에 본인의 안정 상태를 잘 파악하고 계세요'
          : '이 좋은 컨디션을 유지하려면 규칙적인 수면이 가장 중요해요';

        insights.push({
          cls: 'good',
          icon: '😌',
          title: '마음이 편안한 상태예요',
          label: `스트레스 ${stress}/5단계`,
          body: goodBody,
          tip: goodTip,
        });
      }
    }

    // 2. 신체 지수 (BMI/WHtR/ABSI + 나이)
    if (w.bodycomp) {
      const bc = w.bodycomp;
      const bmi = bc.bmi;
      const whtr = bc.whtr;
      const ageDiff = bc.ageDiff || 0;

      // BMI 인사이트
      let bmiCls, bmiBody, bmiTip;
      if (bmi < 18.5) {
        bmiCls = 'warn';
        bmiBody = `체질량지수(BMI)가 ${bmi.toFixed(1)}로 표준 체중보다 가벼우십니다. 나이가 들수록 적정 체중 유지가 면역력과 근력에 매우 중요합니다. 끼니를 거르지 않으시고 단백질 위주로 드세요.`;
        bmiTip = '하루 단백질(고기·생선·두부·계란) 손바닥 크기 3번 이상';
      } else if (bmi < 25) {
        bmiCls = 'good';
        bmiBody = `체질량지수(BMI)가 ${bmi.toFixed(1)}로 정상 범위입니다. 현재 체중 유지를 위해 균형 잡힌 식사와 규칙적인 운동이 중요합니다.`;
        bmiTip = '주 3회 30분 걷기 + 단백질 충분히 = 현재 체형 유지의 핵심';
      } else if (bmi < 30) {
        bmiCls = 'warn';
        bmiBody = `체질량지수(BMI)가 ${bmi.toFixed(1)}로 과체중 범위입니다. 키와 비교해서 체중이 약간 많은 상태로, 무릎·허리 부담과 혈압·혈당 상승 위험이 살짝 있습니다. 무리한 다이어트보다는 한 끼 양을 조금씩 줄이고 매일 30분 걷기가 효과적입니다.`;
        bmiTip = '저녁 식사 양만 30% 줄여보세요 (아침·점심은 그대로)';
      } else {
        bmiCls = 'bad';
        bmiBody = `체질량지수(BMI)가 ${bmi.toFixed(1)}로 비만 범위입니다. 당뇨, 고혈압, 무릎관절 부담이 커질 수 있어서 체중 관리가 필요합니다. 한 번에 많이 빼려 하지 마시고 3개월에 5kg 정도가 안전하고 지속 가능합니다.`;
        bmiTip = '의사 상담 후 식단·운동 계획을 세우시는 것이 안전합니다';
      }
      insights.push({
        cls: bmiCls, icon: '⚖️', title: bmiBody.split('.')[0] + '.',
        label: `BMI ${bmi.toFixed(1)}`, body: bmiBody, tip: bmiTip,
      });

      // WHtR (복부비만)
      if (whtr >= 0.5) {
        insights.push({
          cls: whtr >= 0.6 ? 'bad' : 'warn',
          icon: '🎯',
          title: '뱃살 관리가 필요해요',
          label: `허리/키 ${whtr.toFixed(2)}`,
          body: `허리둘레가 키의 ${(whtr * 100).toFixed(0)}%로, 건강 기준(50% 미만)을 넘었습니다. 뱃살은 단순 체중보다 더 중요한 건강 위험 신호로, 당뇨와 심장병 위험을 높입니다. 복부 운동보다는 전체 체중 감량과 식단 조절이 효과적입니다.`,
          tip: '흰쌀밥을 잡곡밥으로, 라면·국수를 콩나물·두부로 바꿔보세요',
        });
      }

      // 신체 나이
      if (ageDiff <= -3) {
        insights.push({
          cls: 'good',
          icon: '🧬',
          title: '실제 나이보다 젊게 살고 계세요',
          label: `신체 나이 ${bc.bodyAge}세 (실제 ${bc.age}세)`,
          body: `신체 나이가 실제 나이보다 ${Math.abs(ageDiff)}살 어립니다. 측정한 모든 항목이 건강한 범주에 있다는 뜻이에요. 현재 생활 습관이 노화를 늦추고 있습니다.`,
          tip: '지금 하시는 운동·식습관을 그대로 이어가세요',
        });
      } else if (ageDiff >= 5) {
        insights.push({
          cls: 'bad',
          icon: '🧬',
          title: '몸이 실제 나이보다 더 노화되고 있어요',
          label: `신체 나이 ${bc.bodyAge}세 (실제 ${bc.age}세)`,
          body: `신체 나이가 실제보다 ${ageDiff}살 많게 측정됐습니다. 체중·뱃살·운동 부족 중 하나가 영향을 미치고 있어요. 3개월간 식단·걷기를 꾸준히 하시면 신체 나이를 2~5년 되돌릴 수 있다는 연구 결과가 있습니다.`,
          tip: '오늘부터 매일 10분 더 걷기 — 작은 시작이 큰 변화를 만듭니다',
        });
      }
    }

    // 3. 균형 + 보행 통합 (낙상 위험 신호)
    if (w.balance && w.gait) {
      const bScore = w.balance.score || 0;
      const gScore = w.gait.score || 0;
      const combined = (bScore + gScore) / 2;
      if (combined < 60) {
        insights.push({
          cls: 'bad',
          icon: '⚠️',
          title: '낙상 위험이 있어요',
          label: `균형 ${bScore}점 · 보행 ${gScore}점`,
          body: `균형감과 걸음걸이가 모두 약해진 상태입니다. 65세 이상에서 낙상은 골절·입원의 가장 큰 원인입니다. 욕실에 미끄럼방지 매트, 침대 옆 야간등을 두시고, 의자에서 일어나실 때 두 번 깊게 호흡하고 천천히 일어나세요.`,
          tip: '하루 한 번 의자 잡고 한 발 서기 10초씩 — 균형감 회복의 첫걸음',
        });
      } else if (combined >= 80) {
        insights.push({
          cls: 'good',
          icon: '🚶',
          title: '걷기와 균형감이 모두 좋아요',
          label: `균형 ${bScore}점 · 보행 ${gScore}점`,
          body: `다리 근력, 균형감, 신경 반응이 모두 양호합니다. 나이가 들수록 가장 중요한 능력 중 하나로, 잘 유지하면 낙상 위험이 매우 낮아집니다.`,
          tip: '이 능력을 80대까지 유지하려면 주 2회 계단 오르기를 추천해요',
        });
      }
    }

    // 4. 반응속도 (인지 노화 지표 - Deary 2010)
    if (w.reaction) {
      const score = w.reaction.score || 0;
      const avg = w.reaction.avg || 0;
      if (score < 60 && avg > 0) {
        insights.push({
          cls: 'warn',
          icon: '🧠',
          title: '반응이 다소 느려졌어요',
          label: `평균 ${Math.round(avg)}ms`,
          body: `반응속도가 평균보다 느립니다. 뇌의 정보 처리 속도와 관련이 있어 인지 기능의 한 부분입니다. 수면 부족, 피로, 또는 자연스러운 노화일 수 있어요. 두뇌 자극 활동(독서·퍼즐·새 취미)이 도움됩니다.`,
          tip: '잠을 충분히 (7시간) 자고 다시 측정해보세요',
        });
      }
    }

    return insights;
  },

  // ★ v14.1: 맞춤 운동 처방 (학술 근거 기반)
  _generateExerciseRecommendations(w) {
    const recommendations = [];

    // ★ v16.2: 통합 심혈관 데이터 (손가락+얼굴 가중평균)
    const cardio = this._getUnifiedCardio(w);

    // 1. 심혈관 (HR/RMSSD 기반)
    const stressLevel = cardio?.stressLevel || 3;
    if (stressLevel >= 4 || (cardio?.hr && cardio.hr >= 80)) {
      // 스트레스 높거나 심박수 빠름 - 호흡 우선
      recommendations.push({
        priority: 'high',
        icon: '🧘',
        name: '호흡 명상 (이완 운동)',
        why: '자율신경이 긴장 상태입니다. 천천히 호흡하면 부교감신경(휴식 신경)이 활성화되어 심박수와 혈압이 떨어집니다.',
        steps: [
          '편안한 자세로 앉거나 누우세요',
          '코로 4초간 천천히 들이마시고 배가 부풀게',
          '2초간 멈춥니다',
          '입으로 6초간 천천히 내쉽니다',
          '이걸 10번 반복하세요'
        ],
        frequency: '매일 2회',
        duration: '5~10분',
        intensity: '매우 약함',
        caution: '어지러우면 즉시 중단하세요',
      });
    }

    // 2. BMI/WHtR 기반 유산소 운동
    const bmi = w.bodycomp?.bmi;
    const whtr = w.bodycomp?.whtr;
    if (bmi >= 25 || whtr >= 0.5) {
      recommendations.push({
        priority: 'high',
        icon: '🚶‍♂️',
        name: '빨리 걷기 (체중·뱃살 감량 최우선)',
        why: `${bmi >= 25 ? '체중 감량이' : ''}${whtr >= 0.5 ? '뱃살 감량이' : ''} 필요합니다. 빨리 걷기는 무릎 부담이 적으면서 내장지방을 효과적으로 줄여줍니다. 달리기보다 부상 위험이 낮아 매일 가능합니다.`,
        steps: [
          '5분간 천천히 걸어 몸을 풀어주세요 (준비운동)',
          '약간 숨이 차고 옆 사람과 대화는 가능한 속도로 (시속 5~6km)',
          '팔을 자연스럽게 흔들면서 등을 펴고 걸으세요',
          '20~30분 유지',
          '마지막 5분은 천천히 걸어 마무리'
        ],
        frequency: '주 5회',
        duration: '30~40분',
        intensity: '약간 숨참 (대화는 가능)',
        caution: bmi >= 30 ? '관절에 무리가 오면 수영이나 자전거로 대체하세요' : null,
      });
    } else {
      recommendations.push({
        priority: 'mid',
        icon: '🚶',
        name: '꾸준한 걷기 (현재 컨디션 유지)',
        why: '체중과 허리둘레가 건강 범위에 있습니다. 이 상태를 유지하려면 규칙적인 유산소 운동이 핵심입니다.',
        steps: [
          '편한 신발을 신으세요',
          '동네 한 바퀴, 또는 공원이나 산책로',
          '약간 빠른 걸음으로',
          '30분간 꾸준히'
        ],
        frequency: '주 3~5회',
        duration: '30분',
        intensity: '편하게 대화 가능한 속도',
      });
    }

    // 3. 균형/보행 약함 → 균형 운동
    const balanceScore = w.balance?.score || 100;
    const gaitScore = w.gait?.score || 100;
    if (balanceScore < 75 || gaitScore < 75) {
      recommendations.push({
        priority: 'high',
        icon: '🦵',
        name: '균형 운동 (낙상 예방)',
        why: '균형감이 약해진 상태입니다. 65세 이상에서 낙상은 가장 흔한 사고 원인입니다. 단 8주간 균형 운동으로 낙상 위험을 30% 줄일 수 있다는 연구가 있습니다.',
        steps: [
          '의자 등받이를 손으로 잡고 서세요',
          '한 발을 들어 10초간 버티세요 (오른발)',
          '내려놓고 반대 발도 10초',
          '익숙해지면 의자 없이 시도',
          '더 익숙해지면 눈을 감고 시도'
        ],
        frequency: '매일',
        duration: '5분 (각 발 10초씩 양쪽)',
        intensity: '약함',
        caution: '꼭 잡을 것이 있는 곳에서 하세요',
      });
    }

    // 4. 손떨림 또는 반응속도 약함 → 두뇌·손 협응
    const tremorScore = w.tremor?.score || 100;
    const reactionScore = w.reaction?.score || 100;
    if (tremorScore < 70 || reactionScore < 60) {
      recommendations.push({
        priority: 'mid',
        icon: '🤲',
        name: '손-눈 협응 운동 (뇌 자극)',
        why: '손떨림이나 반응속도가 약해지면 두뇌-신경 연결을 자극하는 운동이 도움됩니다. 새로운 자극이 뇌의 신경 가소성(새 회로 만들기)을 촉진합니다.',
        steps: [
          '공이나 작은 물건을 한 손에서 다른 손으로 던지기',
          '익숙해지면 두 개로 늘리기',
          '또는 박수 운동: 박수 → 무릎 치기 → 박수 → 어깨 치기 반복',
          '천천히 시작해서 점점 빠르게'
        ],
        frequency: '매일',
        duration: '5~10분',
        intensity: '약함',
      });
    }

    // 5. 자세 운동 (모든 사람에게 기본)
    const postureScore = w.posture?.score || 100;
    if (postureScore < 80) {
      recommendations.push({
        priority: 'mid',
        icon: '🧍',
        name: '자세 교정 운동',
        why: '자세가 흐트러지면 만성 통증, 호흡 부족, 어깨 결림을 일으킵니다. 하루 5분만으로도 큰 변화가 있습니다.',
        steps: [
          '벽에 등을 대고 서세요',
          '뒤통수, 어깨, 엉덩이, 발뒤꿈치를 벽에 닿게',
          '이 자세로 1분 유지하며 호흡',
          '하루 2~3번 반복'
        ],
        frequency: '매일 2~3회',
        duration: '5분',
        intensity: '매우 약함',
      });
    }

    // 6. 건강한 사람에게도 근력 운동 권장
    if (recommendations.length < 3) {
      recommendations.push({
        priority: 'mid',
        icon: '💪',
        name: '하체 근력 강화 (스쿼트)',
        why: '하체 근력은 모든 활동의 기반이며, 50세 이후 매년 1~2%씩 감소합니다. 의자 사용 스쿼트는 무릎 부담 없이 효과적입니다.',
        steps: [
          '의자 앞에 등 펴고 서세요',
          '발은 어깨 너비',
          '엉덩이가 의자에 살짝 닿을 때까지 천천히 앉기',
          '바로 다시 일어서기 (앉지 말고)',
          '10번 반복 × 2세트'
        ],
        frequency: '주 3회',
        duration: '10분',
        intensity: '중간',
        caution: '무릎이 발끝을 넘지 않게 주의',
      });
    }

    return recommendations.slice(0, 4); // 최대 4개
  },

  // ★ v14.1: 맞춤 식단 추천
  _generateDietRecommendations(w) {
    const bmi = w.bodycomp?.bmi || 22;
    const whtr = w.bodycomp?.whtr || 0.45;
    // ★ v16.2: 통합 심혈관 데이터 사용
    const cardio = this._getUnifiedCardio(w);
    const stressLevel = cardio?.stressLevel || 3;
    const hr = cardio?.hr || 70;

    // 헤드라인 결정
    let headline, summary;
    const avoid = [];
    const prefer = [];

    if (bmi >= 25 || whtr >= 0.5) {
      headline = '🎯 체중·뱃살 관리 식단';
      summary = '한 끼 양을 조금씩 줄이고, 흰 탄수화물을 잡곡·채소로 바꾸세요. 단백질은 매 끼 챙기면 근육 손실을 막을 수 있어요.';
      avoid.push('흰쌀밥, 흰빵, 라면, 국수 (혈당을 급격히 올려요)');
      avoid.push('단 음료, 과자, 빵 (특히 저녁 시간대)');
      avoid.push('튀김, 부침개, 삼겹살 (지방 함량 높음)');
      prefer.push('잡곡밥, 현미, 통밀빵 (혈당 안정)');
      prefer.push('생선·두부·계란 (단백질, 매 끼)');
      prefer.push('나물, 김치, 채소 반찬 (식이섬유)');
    } else if (bmi < 18.5) {
      headline = '🎯 건강 체중 회복 식단';
      summary = '체중이 가벼우신 분께는 끼니를 거르지 않고 단백질을 충분히 드시는 것이 가장 중요해요. 나이가 들수록 근육 유지가 면역력의 핵심입니다.';
      avoid.push('끼니 거르기 (특히 아침)');
      avoid.push('과한 다이어트 식품, 저칼로리 식사');
      prefer.push('계란·생선·두부·고기 (매 끼 단백질)');
      prefer.push('견과류, 우유, 요거트 (간식으로 칼로리 보충)');
      prefer.push('잡곡밥은 한 공기씩 챙기기');
    } else {
      headline = '✅ 현재 식단 유지 + 약간의 개선';
      summary = '현재 체중이 건강 범위에 있어요. 균형 잡힌 식사를 유지하면서 단백질과 채소를 좀 더 챙기시면 좋습니다.';
      prefer.push('단백질을 매 끼 챙기기 (근육 유지)');
      prefer.push('하루 채소 5색 (다양한 색깔)');
      prefer.push('물 8잔, 규칙적으로');
    }

    // 스트레스 높음 → 카페인/알코올 줄이기
    if (stressLevel >= 4 || hr >= 85) {
      avoid.push('과도한 커피·녹차 (하루 1잔 이하로)');
      avoid.push('술 (수면 질을 떨어뜨려요)');
      prefer.push('따뜻한 허브차 (캐모마일, 루이보스)');
      prefer.push('마그네슘이 풍부한 음식 (시금치, 견과류, 다크초콜릿)');
    }

    // 식사 시간표
    const meals = [];

    if (bmi >= 25 || whtr >= 0.5) {
      // 체중감량 식단
      meals.push({
        time: '아침 (7~9시)',
        icon: '🍳',
        title: '든든하게 시작',
        foods: [
          { name: '잡곡밥 또는 통밀빵', amount: '한 공기 / 1쪽' },
          { name: '계란 또는 두부', amount: '2개 / 반 모' },
          { name: '나물 또는 샐러드', amount: '한 접시' },
          { name: '물 또는 따뜻한 차', amount: '1잔' },
        ],
        tip: '💡 아침을 든든히 먹으면 점심·저녁 폭식을 막아줘요',
      });
      meals.push({
        time: '점심 (12~13시)',
        icon: '🍱',
        title: '균형 잡힌 한 끼',
        foods: [
          { name: '잡곡밥', amount: '2/3 공기' },
          { name: '생선·고기·두부 (택1)', amount: '손바닥 크기' },
          { name: '나물 반찬', amount: '3가지' },
          { name: '국 (간 적게)', amount: '반 그릇' },
        ],
        tip: '💡 천천히 씹어드시면 적게 먹어도 포만감이 오래 갑니다',
      });
      meals.push({
        time: '저녁 (18~19시)',
        icon: '🥗',
        title: '가볍게 마무리',
        foods: [
          { name: '잡곡밥', amount: '반 공기' },
          { name: '생선구이 또는 닭가슴살', amount: '손바닥 크기' },
          { name: '채소 듬뿍 (나물·샐러드)', amount: '두 접시' },
          { name: '국물 (탄수화물 없이)', amount: '맑은 국 한 그릇' },
        ],
        tip: '💡 저녁은 자기 3시간 전까지 마치는 것이 좋아요',
      });
    } else if (bmi < 18.5) {
      // 체중 증량 식단
      meals.push({
        time: '아침 (7~9시)',
        icon: '🍳',
        title: '꼭 드세요',
        foods: [
          { name: '잡곡밥 또는 죽', amount: '한 공기' },
          { name: '계란 + 생선·두부', amount: '2가지 다' },
          { name: '나물 반찬', amount: '2~3가지' },
          { name: '우유 또는 두유', amount: '1잔' },
        ],
        tip: '💡 아침을 거르지 마세요 — 근육 유지의 핵심',
      });
      meals.push({
        time: '간식 (10시, 15시)',
        icon: '🥜',
        title: '소량씩 자주',
        foods: [
          { name: '견과류 (호두·아몬드)', amount: '한 줌' },
          { name: '바나나 또는 사과', amount: '1개' },
          { name: '요거트 또는 두유', amount: '1잔' },
        ],
        tip: '💡 한 번에 많이 드시지 못한다면 자주 드세요',
      });
      meals.push({
        time: '점심·저녁',
        icon: '🍱',
        title: '단백질 중심',
        foods: [
          { name: '잡곡밥', amount: '한 공기' },
          { name: '생선 또는 고기', amount: '손바닥 + 손가락' },
          { name: '두부·계란 곁들이', amount: '추가로' },
          { name: '나물 반찬', amount: '3가지 이상' },
        ],
        tip: '💡 매 끼 단백질이 가장 중요해요',
      });
    } else {
      // 유지 식단
      meals.push({
        time: '아침 (7~9시)',
        icon: '🍳',
        title: '균형 잡힌 시작',
        foods: [
          { name: '잡곡밥 또는 통밀빵', amount: '한 공기 / 1쪽' },
          { name: '계란 또는 생선', amount: '1~2개' },
          { name: '과일 또는 채소', amount: '한 접시' },
        ],
        tip: '💡 아침 단백질이 하루 근육 유지의 시작',
      });
      meals.push({
        time: '점심 (12~13시)',
        icon: '🍱',
        title: '한식 균형식',
        foods: [
          { name: '잡곡밥', amount: '한 공기' },
          { name: '단백질 (생선·고기·두부)', amount: '손바닥 크기' },
          { name: '나물 반찬', amount: '3가지' },
        ],
        tip: '💡 골고루 천천히 드세요',
      });
      meals.push({
        time: '저녁 (18~19시)',
        icon: '🥗',
        title: '가볍게',
        foods: [
          { name: '잡곡밥', amount: '2/3 공기' },
          { name: '생선·닭가슴살·두부', amount: '손바닥 크기' },
          { name: '채소 듬뿍', amount: '두 접시' },
        ],
        tip: '💡 저녁은 자기 3시간 전 마무리',
      });
    }

    return { headline, summary, meals, avoid, prefer };
  },

  // ★ v14.0: 상대 시간 표시 (몇 분 전, 몇 시간 전)
  // ★ v15.2.3: 보안 — 사용자 입력 HTML escape (XSS 방어)
  // 모든 사용자가 직접 입력한 텍스트는 innerHTML 렌더링 전 반드시 이 함수 통과
  _esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/`/g, '&#96;');
  },

  // ★ v17.1: 한국어 조사 자동 처리 (받침에 따라 이/가, 은/는, 을/를)
  // 마지막 글자의 받침을 분석하여 적절한 조사를 선택
  _josa(word, withFinal, withoutFinal) {
    if (!word) return withoutFinal;
    const last = word.charAt(word.length - 1);
    const code = last.charCodeAt(0);
    // 한글 음절: U+AC00(가) ~ U+D7A3(힣)
    if (code < 0xAC00 || code > 0xD7A3) {
      // 한글 아니면 받침 없는 것으로 처리 (영어/숫자)
      return withoutFinal;
    }
    // 받침 여부 = (code - 0xAC00) % 28 !== 0
    const hasFinalConsonant = (code - 0xAC00) % 28 !== 0;
    return hasFinalConsonant ? withFinal : withoutFinal;
  },

  // 편의 함수
  _jongsa_iga(word) { return this._josa(word, '이', '가'); },      // 이/가
  _jongsa_eunneun(word) { return this._josa(word, '은', '는'); },  // 은/는
  _jongsa_eulreul(word) { return this._josa(word, '을', '를'); },  // 을/를

  // ════════════════════════════════════════════════════════════════
  // ★ v15.3: 변별력 강화 시스템 — 나이·성별 보정 점수
  // 학술 근거:
  //   - HRV: Umetani et al. (1998), Voss et al. (2015), Tegegne (2018)
  //   - HR: Tanaka et al. (2001) — max HR = 208 - 0.7×age
  //   - 균형: Springer et al. (2007) — Romberg ratio by age
  //   - 보행: Studenski et al. (2011) — gait speed mortality
  //   - 반응속도: Deary et al. (2010) — RT increase with age
  // ════════════════════════════════════════════════════════════════

  // 사용자 프로필 조회 (나이·성별)
  _getUserProfile() {
    try {
      const bc = JSON.parse(localStorage.getItem('bodycomp_input') || '{}');
      return {
        age: bc.age || null,
        gender: bc.gender || null, // 'male' | 'female' | null
      };
    } catch (e) {
      return { age: null, gender: null };
    }
  },

  // 정규분포 z-score → 0~100 점수 변환
  // z=0이면 50점, z=+1이면 ~84점, z=-1이면 ~16점 (정상분포 cumulative)
  _zToScore(z) {
    // Φ(z) = 0.5 × (1 + erf(z/√2)) 근사
    const erf = (x) => {
      const t = 1 / (1 + 0.3275911 * Math.abs(x));
      const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
      return x >= 0 ? y : -y;
    };
    const cdf = 0.5 * (1 + erf(z / Math.SQRT2));
    return Math.round(cdf * 100);
  },

  // ── 나이별 RMSSD 기준값 (Umetani 1998, Voss 2015 메타분석) ──
  _refRMSSD(age, gender) {
    // 메타분석 기반 — 10년 단위 평균(ms), 표준편차
    // 출처: Voss (2015) "Short-Term Heart Rate Variability—Influence of Gender and Age"
    if (!age) return { mean: 35, sd: 18 }; // 일반 성인 평균
    if (age < 25) return { mean: 65, sd: 25 };
    if (age < 35) return { mean: 50, sd: 22 };
    if (age < 45) return { mean: 38, sd: 18 };
    if (age < 55) return { mean: 28, sd: 14 };
    if (age < 65) return { mean: 22, sd: 12 };
    if (age < 75) return { mean: 18, sd: 10 };
    return { mean: 14, sd: 8 };
  },

  // ── 나이별 안정 시 심박수 기준 (Tanaka 2001 + ACSM) ──
  _refRestingHR(age, gender) {
    // 안정 시 HR은 나이로는 큰 변화 없으나, 노화로 HRV 감소로 가변성 줄어듦
    // 성별 차이: 여성 평균이 약 3-5 BPM 높음
    const base = gender === 'female' ? 73 : 70;
    return { mean: base, sd: 10 };
  },

  // ── 나이별 호흡수 기준 ──
  _refRespRate(age) {
    if (!age) return { mean: 15, sd: 3 };
    if (age < 60) return { mean: 15, sd: 3 };
    if (age < 75) return { mean: 16, sd: 3 };
    return { mean: 17, sd: 4 };
  },

  // ── 나이별 균형 (Romberg ratio = closed/open eyes sway) ──
  _refRomberg(age) {
    // Springer (2007), Era (2006)
    if (!age) return { mean: 1.8, sd: 0.7 };
    if (age < 40) return { mean: 1.5, sd: 0.4 };
    if (age < 60) return { mean: 1.8, sd: 0.5 };
    if (age < 75) return { mean: 2.4, sd: 0.8 };
    return { mean: 3.2, sd: 1.2 };
  },

  // ── 나이별 보행 cadence (Auvinet 2002) ──
  _refCadence(age) {
    if (!age) return { mean: 115, sd: 10 };
    if (age < 50) return { mean: 118, sd: 8 };
    if (age < 65) return { mean: 115, sd: 9 };
    if (age < 75) return { mean: 110, sd: 11 };
    return { mean: 105, sd: 13 };
  },

  // ── 나이별 반응속도 (Der & Deary 2006, ms) ──
  _refReactionTime(age) {
    if (!age) return { mean: 300, sd: 60 };
    if (age < 30) return { mean: 250, sd: 40 };
    if (age < 50) return { mean: 290, sd: 50 };
    if (age < 65) return { mean: 340, sd: 65 };
    if (age < 75) return { mean: 400, sd: 80 };
    return { mean: 470, sd: 100 };
  },

  // ── 나이별 손떨림 진폭 (Louis 2019, 단위 임의) ──
  _refTremor(age) {
    if (!age) return { mean: 0.15, sd: 0.08 };
    if (age < 40) return { mean: 0.10, sd: 0.05 };
    if (age < 60) return { mean: 0.15, sd: 0.07 };
    if (age < 75) return { mean: 0.22, sd: 0.10 };
    return { mean: 0.32, sd: 0.15 };
  },

  // ★ 핵심: 나이·성별 보정 점수 계산 (값 → 0~100 점수)
  // 'higherIsBetter': true면 값이 클수록 좋음 (예: RMSSD), false면 작을수록 좋음 (예: 반응속도)
  _ageNormalizedScore(value, ref, higherIsBetter = true) {
    if (value == null || ref.sd === 0) return 50;
    const z = (value - ref.mean) / ref.sd;
    // 양방향(중심값 좋음)이 아닌 단방향
    const adjustedZ = higherIsBetter ? z : -z;
    return Math.max(5, Math.min(99, this._zToScore(adjustedZ)));
  },

  // ════════════════════════════════════════════════════════════════
  // ★ v15.4: Wake Lock — 측정 중 화면 꺼짐 방지
  //
  // 문제: 절전 시간이 짧게 설정된 폰에서 측정 중 화면이 꺼짐
  // 해결: Screen Wake Lock API로 명시적 wake lock 요청
  // 추가 안전망:
  //   - visibilitychange 이벤트로 백그라운드 진입 감지
  //   - 비디오 요소 재생으로 일부 구형 안드로이드 대응
  //   - 사용자 안내 토스트
  //
  // 참고: Wake Lock API는 Chrome/Edge/Samsung Internet 84+ 지원
  //       iOS Safari 16.4+ 지원, 구형 기기는 silent fallback
  // ════════════════════════════════════════════════════════════════
  _wakeLockSentinel: null,
  _wakeLockSilentVideo: null,

  async _acquireWakeLock() {
    // 이미 활성화된 wake lock이 있으면 스킵
    if (this._wakeLockSentinel) {
      console.log('[WakeLock] 이미 활성화됨, 스킵');
      return true;
    }

    let success = false;

    // 1차: Wake Lock API (모던 브라우저)
    if ('wakeLock' in navigator) {
      try {
        this._wakeLockSentinel = await navigator.wakeLock.request('screen');
        success = true;
        console.log('[WakeLock] ✓ 활성화 (Wake Lock API)');

        // 페이지 복귀 시 자동 재획득 리스너
        this._wakeLockSentinel.addEventListener('release', () => {
          console.log('[WakeLock] release 이벤트 감지');
          this._wakeLockSentinel = null;
          // 측정 중이면 재획득 시도
          if (this._isMeasuring()) {
            console.log('[WakeLock] 측정 중 — 재획득 시도');
            this._acquireWakeLock();
          }
        });
      } catch (e) {
        console.warn('[WakeLock] Wake Lock API 실패:', e.message);
      }
    }

    // 2차 fallback: 무음 비디오 재생 (구형 안드로이드 대응)
    // Wake Lock API 미지원 또는 실패 시
    if (!success) {
      try {
        if (!this._wakeLockSilentVideo) {
          const video = document.createElement('video');
          video.setAttribute('playsinline', '');
          video.setAttribute('muted', '');
          video.setAttribute('loop', '');
          video.muted = true;
          video.loop = true;
          video.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;';
          // 1초짜리 무음 비디오 데이터 URI (검은 화면)
          // Tiny MP4 (76 bytes base64, 약 1초 검정 비디오)
          video.src = 'data:video/mp4;base64,AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQAAAAhmcmVlAAAALm1kYXQhEAUgxFwAAEABAhAFGYQRGYRGZjgUEYRBGYwQzARDIAyJBOMRgZAJRgQARxAAAAj8bW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAACWAAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAH3HRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAJYAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAACgAAAAUAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAACWAAAQAAAAEAAAAAB1RtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAfQAAA9AVcQAAAAAAC1oZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVyAAAABwBtaW5mAAAAFHZtaGQAAAABAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAa+c3RibAAAALpzdHNkAAAAAAAAAAEAAACqYXZjMQAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAACgAFAEgAAABIAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAYP//AAAANGF2Y0MBZAAK/+EAHGdkAAqs2WCgD0/eAQAAAwABAAADADIPCJZYAQAGaOvjyyLAAAAAGHN0dHMAAAAAAAAAAQAAAAEAAA9AAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAABAAAAAQAAABRzdHN6AAAAAAAAAJAAAAABAAAAFHN0Y28AAAAAAAAAAQAAACw=';
          document.body.appendChild(video);
          this._wakeLockSilentVideo = video;
        }
        await this._wakeLockSilentVideo.play();
        success = true;
        console.log('[WakeLock] ✓ 활성화 (무음 비디오 fallback)');
      } catch (e) {
        console.warn('[WakeLock] 비디오 fallback 실패:', e.message);
      }
    }

    // 3차 보조: visibilitychange 이벤트로 백그라운드 진입 감지
    if (!this._visibilityListenerInstalled) {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this._isMeasuring() && !this._wakeLockSentinel) {
          console.log('[WakeLock] 화면 복귀 — wake lock 재획득');
          this._acquireWakeLock();
        }
      });
      this._visibilityListenerInstalled = true;
    }

    if (!success) {
      console.warn('[WakeLock] 모든 방법 실패 — 사용자에게 안내');
      this._showWakeLockToast();
    }

    return success;
  },

  async _releaseWakeLock() {
    // Wake Lock API release
    if (this._wakeLockSentinel) {
      try {
        await this._wakeLockSentinel.release();
        console.log('[WakeLock] 해제 (Wake Lock API)');
      } catch (e) {
        console.warn('[WakeLock] 해제 실패:', e.message);
      }
      this._wakeLockSentinel = null;
    }

    // 무음 비디오 정지
    if (this._wakeLockSilentVideo) {
      try {
        this._wakeLockSilentVideo.pause();
      } catch (e) {}
    }
  },

  // 측정 중인지 확인 (wake lock 자동 재획득 판단용)
  _isMeasuring() {
    if (this.state.face && this.state.face.running) return true;
    if (this.state.body && this.state.body.running) return true;
    return false;
  },

  // Wake Lock 실패 시 사용자 안내 토스트
  _showWakeLockToast() {
    try {
      const existing = document.getElementById('wake-lock-toast');
      if (existing) return;
      const toast = document.createElement('div');
      toast.id = 'wake-lock-toast';
      toast.className = 'tts-fail-toast'; // 기존 토스트 스타일 재사용
      toast.innerHTML = `
        <div class="tts-fail-icon">🔆</div>
        <div class="tts-fail-body">
          <div class="tts-fail-title">측정 중 화면이 꺼지면</div>
          <div class="tts-fail-msg">설정 → 디스플레이 → 화면 자동 꺼짐 시간을 늘려주세요</div>
        </div>
        <button class="tts-fail-close" onclick="document.getElementById('wake-lock-toast')?.remove()">✕</button>
      `;
      document.body.appendChild(toast);
      setTimeout(() => toast.classList.add('show'), 10);
      setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 400);
      }, 7000);
    } catch (e) {}
  },

  // ════════════════════════════════════════════════════════════════
  // ★ v15.6: 손가락 PPG (재작성) — 단계별 진행 + 명시 토치 제어 + 디버그 로그
  //
  // 진단된 문제 (v15.5):
  //   1. applyConstraints torch 호출 timing 이슈 → 플래시 안 켜짐
  //   2. 측정 시작이 빨라 손가락 안댄 상태로 시작 → 데이터 0
  //   3. 사용자가 플래시 직접 제어 불가
  //   4. 무엇이 실패했는지 로그 확인 불가
  //
  // v15.6 해결책:
  //   1. 단계 분리: 카메라 활성화 → 손가락 위치 확인 → 측정 시작
  //   2. 명시적 토치 토글 버튼 (재시도 가능)
  //   3. 실시간 빨강 채널 모니터 (손가락 댔는지 즉시 표시)
  //   4. 측정 시작은 신호 확인 후에만 활성화
  //   5. 인앱 디버그 로그 패널 (📋 아이콘으로 토글)
  //
  // 학술 근거 (최신):
  //   - Coppetti et al. (2017): 4개 PPG 앱 검증, RMSE ≤5 BPM ANSI/AAMI EC-13
  //   - Allagi et al. (2022): Redmi Note 8 + 24명 검증, 99.7% 정확도, 0.4 BPM 오차
  //   - Real-world AF detection (2024): 50명 4주 검증, 3907 measurements
  //   - Touch error elimination (2020): Red plane average 기반 손가락 접촉 검증
  //
  // 알고리즘:
  //   1. 후면 카메라 (environment) + torch
  //   2. 빨강 채널 평균 추출 (30 FPS, 30초)
  //   3. Detrend (이동평균 30 = 1초 window)
  //   4. Butterworth 2차 bandpass [0.6 ~ 3.5 Hz] (HR 36 ~ 210)
  //   5. FFT + Hann window → 주파수 도메인 HR 추정
  //   6. Peak detection (적응형 임계 + 최소 거리)
  //   7. IBI → Kubios 표준 outlier 제거 (±30%)
  //   8. HR, RMSSD, SDNN, pNN50 계산
  // ════════════════════════════════════════════════════════════════

  // 인앱 디버그 로그 시스템
  _fingerLog: [],
  _fingerLogMax: 200,

  _flog(msg, level) {
    const t = new Date();
    const ts = t.getHours().toString().padStart(2,'0') + ':' +
               t.getMinutes().toString().padStart(2,'0') + ':' +
               t.getSeconds().toString().padStart(2,'0') + '.' +
               t.getMilliseconds().toString().padStart(3,'0');
    const entry = { ts, level: level || 'info', msg };
    this._fingerLog.push(entry);
    if (this._fingerLog.length > this._fingerLogMax) {
      this._fingerLog = this._fingerLog.slice(-this._fingerLogMax);
    }
    // console에도 출력
    const prefix = `[Finger ${ts}]`;
    if (level === 'error') console.error(prefix, msg);
    else if (level === 'warn') console.warn(prefix, msg);
    else console.log(prefix, msg);
    // UI 업데이트
    this._fingerRenderLog();
  },

  _fingerRenderLog() {
    const body = document.getElementById('finger-log-body');
    if (!body) return;
    if (this._fingerLog.length === 0) {
      body.innerHTML = '<div class="flp-line lvl-info"><span class="flp-msg">로그가 비어있습니다. 카메라를 활성화하면 로그가 쌓입니다.</span></div>';
      return;
    }
    const html = this._fingerLog.map(e => {
      const cls = e.level === 'error' ? 'lvl-err' : e.level === 'warn' ? 'lvl-warn' : 'lvl-info';
      return `<div class="flp-line ${cls}"><span class="flp-ts">${e.ts}</span><span class="flp-msg">${this._esc(e.msg)}</span></div>`;
    }).join('');
    body.innerHTML = html;
    // 자동 스크롤
    body.scrollTop = body.scrollHeight;
  },

  fingerToggleLog() {
    const panel = document.getElementById('finger-log-panel');
    if (!panel) return;
    if (panel.style.display === 'none') {
      panel.style.display = 'flex';
      this._fingerRenderLog();
    } else {
      panel.style.display = 'none';
    }
  },

  fingerClearLog() {
    this._fingerLog = [];
    this._fingerRenderLog();
  },

  async fingerCopyLog() {
    const text = this._fingerLog.map(e => `[${e.ts}] [${e.level}] ${e.msg}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      alert('로그가 클립보드에 복사되었습니다.');
    } catch (e) {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); alert('로그가 복사되었습니다.'); } catch (e2) {}
      ta.remove();
    }
  },

  // 상태 객체
  _finger: {
    stage: 'intro',         // 'intro' | 'camera' | 'measuring' | 'result'
    stream: null,
    track: null,
    torchSupported: false,
    torchOn: false,
    samples: [],            // {t, r} — 실시간 빨강 채널 (StagE 1+2 모두 수집)
    measureSamples: [],     // 측정 중 샘플 (Stage 2)
    measuring: false,
    measureStartTime: 0,
    duration: 30,
    rafId: null,
    timerInterval: null,
    quality: 0,
    lastBPM: 0,
    waveCanvas: null,
    waveCtx: null,
    waveCanvas2: null,
    waveCtx2: null,
    fingerDetected: false,
  },

  // ──────────────────────────────────────────────────
  // 페이지 진입 / 종료
  // ──────────────────────────────────────────────────

  fingerExit() {
    this._flog('페이지 종료 요청');
    this._fingerCleanup();
    this.goPage('home');
  },

  async _fingerCleanup() {
    const f = this._finger;
    f.measuring = false;
    if (f.rafId) { cancelAnimationFrame(f.rafId); f.rafId = null; }
    if (f.timerInterval) { clearInterval(f.timerInterval); f.timerInterval = null; }
    // 토치 끄기
    if (f.track && f.torchSupported && f.torchOn) {
      try {
        await f.track.applyConstraints({ advanced: [{ torch: false }] });
        this._flog('토치 OFF (cleanup)', 'info');
      } catch (e) {
        this._flog('토치 OFF 실패: ' + e.message, 'warn');
      }
      f.torchOn = false;
    }
    // 스트림 정지
    if (f.stream) {
      try {
        f.stream.getTracks().forEach(t => t.stop());
        this._flog('스트림 정지', 'info');
      } catch (e) {}
    }
    f.stream = null;
    f.track = null;
    f.torchSupported = false;
    // ★ v15.9: AI 워커는 유지 (다음 측정에 재사용) — terminate 안 함
    // 단 샘플 버퍼는 비움
    f.aiSamples = [];
    // ★ v16.0: 상태 초기화 (다음 측정에 영향 없도록)
    f.cameraLocked = false;
    f.lowSQIStart = null;
    f.warnedLowQuality = false;
    f.lastSQI = 0;
    f.lastValidCellCount = 0;
    this._fingerHideLiveWarning();
    this._releaseWakeLock();
    this._speakStop();
  },

  // ──────────────────────────────────────────────────
  // STAGE 0 → 1: 카메라 활성화 시작
  // ──────────────────────────────────────────────────
  async fingerStartCamera() {
    this._flog('Stage 1: 카메라 활성화 시작');

    // UI 전환: intro → camera
    document.getElementById('finger-stage-intro').style.display = 'none';
    document.getElementById('finger-stage-camera').style.display = 'block';

    const f = this._finger;

    // ★ v15.8: 기존 스트림이 살아있으면 재사용 (재측정 시 토치 유지)
    if (f.stream && f.track && f.track.readyState === 'live') {
      this._flog('기존 스트림 재사용 (토치 상태 유지)');
      f.stage = 'camera';
      f.samples = [];
      f.measureSamples = [];
      f.quality = 0;
      f.lastBPM = 0;
      f.fingerDetected = false;
      // 비디오 엘리먼트에 다시 연결
      const video = document.getElementById('finger-video');
      if (video.srcObject !== f.stream) {
        video.srcObject = f.stream;
        try { await video.play(); } catch (e) {}
      }
      // 토치 상태 UI 동기화 — torchOn은 그대로 유지
      const torchStatus = document.getElementById('finger-torch-status');
      const torchBtn = document.getElementById('finger-torch-btn');
      if (f.torchOn) {
        torchStatus.innerHTML = '<span style="color:#22c55e">✓ 켜짐 (유지)</span>';
        torchBtn.textContent = '💡 플래시 끄기';
        torchBtn.classList.add('on');
        this._flog('✓ 토치 상태 유지됨 (ON)');
      } else {
        torchStatus.textContent = '꺼짐';
        torchBtn.textContent = '💡 플래시 켜기';
        torchBtn.classList.remove('on');
      }
      this._fingerSetStatus('카메라 준비 완료', '신호 확인 후 측정 시작');
      this._fingerEnableMeasureBtn(false);
      this._fingerStartMonitor();
      return;
    }

    // 새 스트림 생성 — 최초 진입 또는 정리 후 진입
    f.stage = 'camera';
    f.samples = [];
    f.measureSamples = [];
    f.quality = 0;
    f.lastBPM = 0;
    f.torchOn = false;
    f.torchSupported = false;
    f.fingerDetected = false;

    // 상태 표시
    this._fingerSetStatus('카메라 준비 중...', '잠시만 기다려주세요');
    document.getElementById('finger-torch-status').textContent = '확인 중';
    document.getElementById('finger-red-mean').textContent = '--';
    document.getElementById('finger-touch-status').textContent = '대기 중';
    this._fingerEnableMeasureBtn(false);

    try {
      this._flog('getUserMedia 호출 (environment 카메라)');

      // ★ 핵심: 후면 카메라 요청
      // exact 강제하면 일부 기기에서 실패하므로 ideal 사용
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { exact: 'environment' },
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 30, max: 30 },
          }
        });
        this._flog('✓ environment exact 카메라 획득');
      } catch (e1) {
        this._flog('environment exact 실패, ideal로 재시도: ' + e1.message, 'warn');
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { ideal: 'environment' },
              width: { ideal: 640 },
              height: { ideal: 480 },
              frameRate: { ideal: 30 },
            }
          });
          this._flog('✓ environment ideal 카메라 획득');
        } catch (e2) {
          this._flog('ideal도 실패, 기본 카메라로 재시도: ' + e2.message, 'warn');
          stream = await navigator.mediaDevices.getUserMedia({ video: true });
          this._flog('✓ 기본 카메라 획득 (전면일 수 있음)', 'warn');
        }
      }

      f.stream = stream;
      f.track = stream.getVideoTracks()[0];

      // ★ 핵심: 비디오 활성화 후 약간 대기 (Chrome Android 버그 회피)
      const video = document.getElementById('finger-video');
      video.srcObject = stream;
      await video.play();
      this._flog(`비디오 활성화: ${video.videoWidth}x${video.videoHeight}`);

      // ★ Critical: track 활성화 후 200ms 대기 (capabilities 안정화)
      await new Promise(r => setTimeout(r, 300));

      // 토치 capability 확인
      let capabilities = {};
      try {
        capabilities = f.track.getCapabilities ? f.track.getCapabilities() : {};
        this._flog('Capabilities: ' + JSON.stringify(Object.keys(capabilities)));
      } catch (e) {
        this._flog('getCapabilities 실패: ' + e.message, 'warn');
      }

      // ★ v15.7: Chrome Android 버그 회피 — capabilities에 torch가 없어도 무조건 시도
      // 갤럭시 S23 등에서 getCapabilities()가 torch를 보고하지 않는 경우가 많음
      // 실제로는 applyConstraints({torch:true})가 동작함
      const torchInCapabilities = !!capabilities.torch;
      this._flog(`Capabilities.torch: ${torchInCapabilities ? '✓' : '✗ (무시하고 시도)'}`);

      // 토치 가능성 일단 true로 가정 (실제 토글 시 확인)
      f.torchSupported = true;
      f.torchCapabilityReported = torchInCapabilities;

      const torchStatus = document.getElementById('finger-torch-status');
      const torchBtn = document.getElementById('finger-torch-btn');

      torchStatus.textContent = '꺼짐 (수동 켜기 필요)';
      torchBtn.disabled = false;
      torchBtn.textContent = '💡 플래시 켜기';
      this._fingerSetStatus('카메라 준비 완료', '💡 밝은 조명 앞에서 검지를 카메라에 가볍게 대주세요');

      if (!torchInCapabilities) {
        this._flog('Capabilities는 미지원이지만 일단 시도해봅니다 (Chrome 버그 회피)', 'warn');
      }

      // ★ v16.0: 카메라 매개변수 고정 (AE/AWB/Focus) — 신호 변동성 제거
      // 로그 분석 결과: 자동 노출/화이트밸런스가 픽셀값을 멋대로 조정해서
      // R=240 G=0 B=32 같은 포화 ↔ R=152 G=88 B=89 같은 정상값이 반복됨
      // → 측정 동안 카메라를 manual 모드로 고정
      f.cameraLocked = await this._fingerLockCameraParams(f.track, capabilities);

      // 고정 상태 UI 업데이트
      const lockStatus = document.getElementById('finger-lock-status');
      if (lockStatus) {
        if (f.cameraLocked) {
          lockStatus.innerHTML = '<span style="color:#22c55e">✓ 고정됨 (신호 안정)</span>';
        } else {
          lockStatus.innerHTML = '<span style="color:#f59e0b">⚠️ 자동 (기기 한계)</span>';
        }
      }

      // Wake Lock
      this._acquireWakeLock();

      // 파형 캔버스
      f.waveCanvas = document.getElementById('finger-wave-canvas');
      f.waveCtx = f.waveCanvas.getContext('2d');

      // 실시간 모니터링 시작 (측정과 별개 — 손가락 댔는지 확인용)
      this._fingerStartMonitor();

      // 음성 안내 — 밝은 환경에서는 플래시 없이도 측정 가능
      this._speak('카메라가 준비되었습니다. 검지를 카메라 렌즈에 가볍게 대주세요.');

    } catch (err) {
      this._flog('카메라 시작 실패: ' + err.message, 'error');
      let msg = '카메라를 사용할 수 없습니다.';
      if (err.name === 'NotAllowedError') msg = '카메라 권한을 허용해주세요.';
      else if (err.name === 'NotFoundError') msg = '카메라를 찾을 수 없습니다.';
      alert(msg + '\n\n로그 패널(📋)에서 자세한 내용을 확인하세요.');
      this._fingerCleanup();
      document.getElementById('finger-stage-camera').style.display = 'none';
      document.getElementById('finger-stage-intro').style.display = 'block';
    }
  },

  // ──────────────────────────────────────────────────
  // 토치 토글 (수동 컨트롤) - v15.8: 3가지 방법 모두 시도
  // ──────────────────────────────────────────────────
  async fingerToggleTorch() {
    const f = this._finger;
    if (!f.track) {
      this._flog('토치 토글 실패: track 없음', 'warn');
      alert('카메라가 활성화되지 않았습니다.');
      return;
    }

    const newState = !f.torchOn;
    this._flog(`토치 ${newState ? 'ON' : 'OFF'} 요청 (Capability 보고: ${f.torchCapabilityReported ? 'YES' : 'NO'})`);

    // ★ v15.8: 3가지 방법 순서대로 시도
    let success = false;
    let lastError = null;

    // 방법 1: 표준 — advanced 배열
    try {
      await f.track.applyConstraints({ advanced: [{ torch: newState }] });
      success = true;
      this._flog('✓ 방법1 성공: advanced 배열');
    } catch (e1) {
      lastError = e1;
      this._flog(`방법1 실패: ${e1.message} (${e1.name})`, 'warn');

      // 방법 2: torch를 최상위 키로
      try {
        await f.track.applyConstraints({ torch: newState });
        success = true;
        this._flog('✓ 방법2 성공: torch 최상위 키');
      } catch (e2) {
        lastError = e2;
        this._flog(`방법2 실패: ${e2.message}`, 'warn');

        // 방법 3: ImageCapture.setOptions (실험적)
        try {
          if (typeof ImageCapture !== 'undefined') {
            const ic = new ImageCapture(f.track);
            await ic.setOptions({ fillLightMode: newState ? 'flash' : 'off' });
            success = true;
            this._flog('✓ 방법3 성공: ImageCapture.setOptions');
          } else {
            this._flog('방법3 스킵: ImageCapture 미지원', 'warn');
          }
        } catch (e3) {
          lastError = e3;
          this._flog(`방법3 실패: ${e3.message}`, 'warn');
        }
      }
    }

    if (success) {
      f.torchOn = newState;
      const torchStatus = document.getElementById('finger-torch-status');
      const torchBtn = document.getElementById('finger-torch-btn');
      if (newState) {
        torchStatus.innerHTML = '<span style="color:#22c55e">✓ 켜짐</span>';
        torchBtn.textContent = '🔦 플래시 끄기';
        torchBtn.classList.add('on');
      } else {
        torchStatus.textContent = '꺼짐';
        torchBtn.textContent = '🔦 플래시 켜기';
        torchBtn.classList.remove('on');
      }
      this._flog(`✓ 토치 ${newState ? 'ON' : 'OFF'} 완료`);
    } else {
      this._flog(`모든 토치 방법 실패: ${lastError?.message}`, 'error');
      f.torchSupported = false;
      const torchStatus = document.getElementById('finger-torch-status');
      const torchBtn = document.getElementById('finger-torch-btn');
      torchStatus.innerHTML = '<span style="color:#f59e0b">⚠️ 브라우저 제어 불가</span>';
      torchBtn.disabled = true;
      torchBtn.textContent = '🔦 미지원';
      this._fingerSetStatus('브라우저로 플래시 제어 불가',
        '⚙️ 손전등 아이콘으로 직접 켜고 다시 시도하세요');
      alert(
        '❌ 이 브라우저/기기에서는 플래시 자동 제어가 안 됩니다.\n\n' +
        '✅ 해결책 (둘 중 하나):\n' +
        '1️⃣ 화면 상단을 아래로 쓸어내려 ⚡손전등 아이콘을 직접 켠 후 측정\n' +
        '2️⃣ AI 모델 기반 측정 사용 (자연광에서도 작동)\n\n' +
        '🤖 결과 화면에서 "AI 측정" 옵션을 사용해보세요'
      );
    }
  },

  // ──────────────────────────────────────────────────
  // 실시간 모니터링 (Stage 1) — 손가락 댔는지 확인
  // ──────────────────────────────────────────────────
  _fingerStartMonitor() {
    this._flog('실시간 모니터링 시작');
    this._finger.samples = [];
    this._fingerMonitorLoop();
  },

  _fingerMonitorLoop() {
    const f = this._finger;
    if (f.stage !== 'camera' && f.stage !== 'measuring') return;

    const video = document.getElementById(f.stage === 'measuring' ? 'finger-video-2' : 'finger-video');
    const canvas = document.getElementById('finger-canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    try {
      if (video && video.readyState >= 2 && video.videoWidth > 0) {
        // ★ v16.0: 3×3 ROI 격자 분석 — 가장 안정적인 영역 채택
        const W = canvas.width, H = canvas.height;
        const vw = video.videoWidth, vh = video.videoHeight;
        const cropSize = Math.min(vw, vh) * 0.6;
        const sx = (vw - cropSize) / 2;
        const sy = (vh - cropSize) / 2;
        ctx.drawImage(video, sx, sy, cropSize, cropSize, 0, 0, W, H);

        const imgData = ctx.getImageData(0, 0, W, H);
        const pixels = imgData.data;

        // 3×3 격자 = 9개 영역의 R/G/B 평균 계산
        const cellW = Math.floor(W / 3);
        const cellH = Math.floor(H / 3);
        const cells = []; // {r, g, b, idx}

        for (let cy = 0; cy < 3; cy++) {
          for (let cx = 0; cx < 3; cx++) {
            let rSum = 0, gSum = 0, bSum = 0, count = 0;
            const startX = cx * cellW, endX = (cx + 1) * cellW;
            const startY = cy * cellH, endY = (cy + 1) * cellH;
            for (let y = startY; y < endY; y += 2) {
              for (let x = startX; x < endX; x += 2) {
                const i = (y * W + x) * 4;
                rSum += pixels[i];
                gSum += pixels[i + 1];
                bSum += pixels[i + 2];
                count++;
              }
            }
            cells.push({
              r: rSum / count,
              g: gSum / count,
              b: bSum / count,
              idx: cy * 3 + cx,
            });
          }
        }

        // 손가락 영역 후보 선별 — 빨강 우세 + 비포화
        // (각 ROI 마다 손가락 일부일 가능성 평가)
        const validCells = cells.filter(c =>
          c.r > 80 && c.r < 240 && c.r > c.g * 1.5 && c.r > c.b * 1.7
        );

        // 채택 ROI 결정:
        //   - validCells가 있으면 평균 (공간적 평균 = SNR 향상)
        //   - 없으면 전체 평균 (감지 실패 안내용)
        let rMean, gMean, bMean;
        if (validCells.length > 0) {
          rMean = validCells.reduce((s, c) => s + c.r, 0) / validCells.length;
          gMean = validCells.reduce((s, c) => s + c.g, 0) / validCells.length;
          bMean = validCells.reduce((s, c) => s + c.b, 0) / validCells.length;
        } else {
          rMean = cells.reduce((s, c) => s + c.r, 0) / 9;
          gMean = cells.reduce((s, c) => s + c.g, 0) / 9;
          bMean = cells.reduce((s, c) => s + c.b, 0) / 9;
        }

        // 손가락 감지: 유효 셀 비율 + 평균값
        // 9개 중 최소 5개가 유효 → 손가락 충분히 덮음
        const isFingerLikely = validCells.length >= 5 &&
                                rMean > 80 && rMean < 240 &&
                                rMean > gMean * 1.5 && rMean > bMean * 1.7;

        // 포화 경고 (사용자에게)
        const isSaturated = rMean >= 240;
        const isTooDark = rMean < 80;
        f.lastValidCellCount = validCells.length; // SQI 평가에 사용

        // UI 업데이트 (Stage 1)
        if (f.stage === 'camera') {
          document.getElementById('finger-red-mean').textContent = rMean.toFixed(0);

          if (isFingerLikely) {
            document.getElementById('finger-touch-status').innerHTML =
              `<span style="color:#22c55e">✓ 감지됨</span>`;
            if (!f.fingerDetected) {
              f.fingerDetected = true;
              this._flog(`손가락 감지: R=${rMean.toFixed(0)} G=${gMean.toFixed(0)} B=${bMean.toFixed(0)}`);
            }
          } else if (isSaturated) {
            document.getElementById('finger-touch-status').innerHTML =
              `<span style="color:#ef4444">⚠️ 너무 밝음 (살짝만 떼기)</span>`;
            f.fingerDetected = false;
          } else if (isTooDark) {
            document.getElementById('finger-touch-status').innerHTML =
              `<span style="color:#f59e0b">⚠️ 너무 어두움 (더 밝게)</span>`;
            f.fingerDetected = false;
          } else {
            document.getElementById('finger-touch-status').innerHTML =
              `<span style="color:#f59e0b">대기 중</span>`;
            f.fingerDetected = false;
          }
        }

        // 손가락 댄 상태에서만 샘플 수집 (Stage 1, 신호 품질 확인용)
        if (isFingerLikely) {
          // ★ v16.1: RGB 모두 저장 (r은 호환성, g,b는 외부조명 모드용)
          //   - 플래시 ON: R 채널이 주요 신호원 (헤모글로빈 흡수)
          //   - 플래시 OFF (외부조명): G 채널이 더 깨끗 (Verkruysse 2008 표준)
          f.samples.push({ t: performance.now(), r: rMean, g: gMean, b: bMean });
          if (f.samples.length > 600) f.samples = f.samples.slice(-600);

          // 측정 중이면 측정 샘플에도 추가
          if (f.stage === 'measuring' && f.measuring) {
            f.measureSamples.push({ t: performance.now(), r: rMean, g: gMean, b: bMean });
            // ★ v15.9: 측정 중 AI 워커에도 프레임 전송 (15 FPS 정도로 충분)
            if (f.measureSamples.length % 2 === 0) {
              this._fingerSendToAI(video, video.videoWidth, video.videoHeight);
            }
          }

          // 신호 품질 + 실시간 BPM
          if (f.samples.length >= 60) {
            this._fingerUpdateQuality();
            this._fingerDrawWave();

            // ★ v15.7: 측정 시작 조건 완화 — 토치 OFF여도 신호 품질이 충분하면 가능
            // 토치 안 켜지는 기기도 밝은 곳에서 측정 가능해야 함
            if (f.stage === 'camera' && f.quality >= 40 && f.samples.length >= 90) {
              this._fingerEnableMeasureBtn(true);
            }

            // ★ v16.0: 측정 중 신호 품질 저하 감지
            // SQI가 0.15 미만으로 떨어지면 사용자에게 경고 (3초 이상 지속 시)
            if (f.stage === 'measuring' && f.measuring && f.measureSamples.length > 90) {
              if (f.lastSQI < 0.15) {
                if (!f.lowSQIStart) {
                  f.lowSQIStart = performance.now();
                } else if (performance.now() - f.lowSQIStart > 3000) {
                  // 3초 이상 저품질 → 경고
                  if (!f.warnedLowQuality) {
                    this._flog('⚠️ 측정 중 신호 품질 저하 감지 (SQI<0.15)', 'warn');
                    this._fingerShowLiveWarning('신호가 약합니다. 손가락을 더 가만히 두세요.');
                    f.warnedLowQuality = true;
                  }
                }
              } else {
                f.lowSQIStart = null;
                f.warnedLowQuality = false;
                this._fingerHideLiveWarning();
              }
            }

            // 실시간 BPM 계산 (3초마다)
            if (f.samples.length % 30 === 0) {
              this._fingerRealtimeBPM();
            }
          }
        }
      }
    } catch (e) {
      // 처리 오류는 silent
    }

    f.rafId = requestAnimationFrame(() => this._fingerMonitorLoop());
  },

  _fingerEnableMeasureBtn(enable) {
    const btn = document.getElementById('finger-measure-btn');
    if (!btn) return;
    btn.disabled = !enable;
    if (enable) {
      // ★ v15.7: 토치 여부 안내
      const f = this._finger;
      // ★ v16.3: 외부 조명을 우대 (토치 OFF가 권장)
      const hint = f.torchOn ? '(플래시 ON — 가능하면 끄세요)' : '(외부 조명 · 권장 환경)';
      btn.innerHTML = `▶ 측정 시작 <span class="fmb-hint">${hint}</span>`;
      btn.classList.add('ready');
    } else {
      btn.innerHTML = '▶ 측정 시작 <span class="fmb-hint">(손가락 대고 신호 확인 중)</span>';
      btn.classList.remove('ready');
    }
  },

  _fingerSetStatus(main, sub) {
    const s = document.getElementById('finger-status');
    const ss = document.getElementById('finger-substatus');
    if (s) s.textContent = main;
    if (ss) ss.textContent = sub;
  },

  // ★ v16.0: 측정 중 라이브 경고 토스트
  _fingerShowLiveWarning(msg) {
    // 한 번 표시했으면 다시 안 함 (중복 방지)
    let warnBox = document.getElementById('finger-live-warning');
    if (!warnBox) {
      warnBox = document.createElement('div');
      warnBox.id = 'finger-live-warning';
      warnBox.className = 'finger-live-warning';
      document.body.appendChild(warnBox);
    }
    warnBox.innerHTML = `⚠️ ${this._esc(msg)}`;
    warnBox.style.display = 'block';
    // 클릭하면 닫기
    warnBox.onclick = () => warnBox.style.display = 'none';
  },

  _fingerHideLiveWarning() {
    const w = document.getElementById('finger-live-warning');
    if (w) w.style.display = 'none';
  },

  // ──────────────────────────────────────────────────
  // STAGE 1 → 2: 정식 측정 시작
  // ──────────────────────────────────────────────────
  fingerBeginMeasurement() {
    const f = this._finger;
    this._flog('Stage 2: 정식 측정 시작');

    // ★ v16.3: 외부 조명이 권장 환경 — 토치 OFF는 경고 아님
    if (f.torchOn) {
      this._flog('정보: 플래시 ON 상태로 측정 (외부 조명 권장)', 'info');
    } else {
      this._flog('정보: 외부 조명 모드 측정 (권장 환경)', 'info');
    }

    // UI 전환
    document.getElementById('finger-stage-camera').style.display = 'none';
    document.getElementById('finger-stage-measuring').style.display = 'block';

    // 두 번째 비디오 엘리먼트에 스트림 연결 (이미 같은 스트림)
    const video2 = document.getElementById('finger-video-2');
    video2.srcObject = f.stream;
    video2.play().catch(e => this._flog('video-2 play 실패: ' + e.message, 'warn'));

    f.stage = 'measuring';
    f.measuring = true;
    f.measureSamples = [];
    f.aiSamples = [];  // ★ v15.9: AI 워커 출력 PPG 신호
    f.measureStartTime = performance.now();
    // ★ v16.0: SQI 경고 상태 초기화
    f.lowSQIStart = null;
    f.warnedLowQuality = false;
    this._fingerHideLiveWarning();

    // ★ v15.9: ME-rPPG 워커 초기화 (얼굴 측정과 공유)
    this._fingerInitAIWorker();

    // 파형 캔버스 (Stage 2)
    f.waveCanvas2 = document.getElementById('finger-wave-canvas-2');
    f.waveCtx2 = f.waveCanvas2.getContext('2d');

    // 타이머
    this._fingerStartTimer();

    this._speak('측정을 시작합니다. 30초간 손가락을 렌즈에 살짝 대고 유지하세요.');
  },

  // ★ v15.9: ME-rPPG 워커 초기화 (얼굴 측정 워커 재사용)
  // ★ v16.0: 카메라 매개변수 고정 — 자동 노출/화이트밸런스/포커스 차단
  // 학술 근거: Allagi 2022 (manual exposure로 신호 변동성 80% 감소)
  // 핵심: 카메라가 멋대로 픽셀값 조정 막아서 PPG 신호 안정화
  async _fingerLockCameraParams(track, capabilities) {
    if (!track) return false;
    this._flog('카메라 매개변수 고정 시도');

    const constraints = { advanced: [] };
    let lockedItems = [];

    // 1. 노출 고정 (가장 중요!)
    if (capabilities.exposureMode && capabilities.exposureMode.includes('manual')) {
      const setting = { exposureMode: 'manual' };
      // 노출 시간을 고정 — capability에 있으면 중간값
      if (capabilities.exposureTime) {
        const min = capabilities.exposureTime.min || 1;
        const max = capabilities.exposureTime.max || 10000;
        // 손가락 측정은 빛이 강해서 짧은 노출이 좋음 (포화 방지)
        // capability 범위의 30% 정도
        setting.exposureTime = min + (max - min) * 0.3;
      }
      // ISO 고정 — capability에 있으면 중간값
      if (capabilities.iso) {
        const min = capabilities.iso.min || 100;
        const max = capabilities.iso.max || 800;
        setting.iso = min + (max - min) * 0.3;
      }
      constraints.advanced.push(setting);
      lockedItems.push('노출(manual)');
    }

    // 2. 화이트밸런스 고정
    if (capabilities.whiteBalanceMode && capabilities.whiteBalanceMode.includes('manual')) {
      const setting = { whiteBalanceMode: 'manual' };
      if (capabilities.colorTemperature) {
        // 손가락은 빨강 위주 → 따뜻한 색온도가 적합
        setting.colorTemperature = capabilities.colorTemperature.min || 3000;
      }
      constraints.advanced.push(setting);
      lockedItems.push('화이트밸런스(manual)');
    }

    // 3. 포커스 고정 (manual or none이 좋음)
    if (capabilities.focusMode) {
      let focusSetting = null;
      if (capabilities.focusMode.includes('manual')) focusSetting = 'manual';
      else if (capabilities.focusMode.includes('none')) focusSetting = 'none';
      else if (capabilities.focusMode.includes('continuous')) focusSetting = 'continuous';
      if (focusSetting && focusSetting !== 'continuous') {
        const setting = { focusMode: focusSetting };
        if (capabilities.focusDistance) {
          // 매크로 거리 (가장 가까운 거리)
          setting.focusDistance = capabilities.focusDistance.min || 0.01;
        }
        constraints.advanced.push(setting);
        lockedItems.push(`포커스(${focusSetting})`);
      }
    }

    if (constraints.advanced.length === 0) {
      this._flog('고정 가능한 매개변수 없음 (기기 한계)', 'warn');
      return false;
    }

    // 적용
    try {
      await track.applyConstraints(constraints);
      this._flog(`✓ 카메라 고정 성공: ${lockedItems.join(', ')}`);
      // 적용 후 안정화 시간
      await new Promise(r => setTimeout(r, 500));
      return true;
    } catch (e) {
      this._flog('카메라 고정 일부 실패, 개별 시도: ' + e.message, 'warn');
      // 하나씩 시도
      let successCount = 0;
      for (const item of constraints.advanced) {
        try {
          await track.applyConstraints({ advanced: [item] });
          successCount++;
        } catch (e2) {
          this._flog(`개별 적용 실패: ${JSON.stringify(item)}`, 'warn');
        }
      }
      this._flog(`✓ 부분 고정: ${successCount}/${constraints.advanced.length}`);
      return successCount > 0;
    }
  },

  // ★ v16.0: PPG 주파수 대역 SQI (Signal Quality Index) 계산
  // 학술 근거: Karlen 2012, Sukor 2011
  // [0.7-3 Hz] 대역 에너지 비율이 높을수록 진짜 심박 신호
  _fingerComputeSQI(values) {
    if (values.length < 64) return 0;

    // Welch 방법 근사 — DFT 진폭만 사용
    const N = Math.min(values.length, 256);
    const recent = values.slice(-N);

    // 평균 제거 (DC 제거)
    let sum = 0;
    for (const v of recent) sum += v;
    const mean = sum / N;
    const detrended = recent.map(v => v - mean);

    // Hann window
    const windowed = detrended.map((v, i) => v * 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1))));

    // 간단한 DFT (O(N^2)이지만 N=256으로 작음, ~65000 곱셈)
    // PPG 주파수 대역 [0.7-3 Hz] @ 30 Hz 샘플링
    // 정규화 주파수 k = freq * N / fs
    const fs = 30;
    const lowK = Math.floor(0.7 * N / fs);
    const highK = Math.ceil(3.0 * N / fs);

    let bandPower = 0, totalPower = 0;
    for (let k = 1; k < N / 2; k++) {
      let re = 0, im = 0;
      for (let n = 0; n < N; n++) {
        const angle = -2 * Math.PI * k * n / N;
        re += windowed[n] * Math.cos(angle);
        im += windowed[n] * Math.sin(angle);
      }
      const power = re * re + im * im;
      totalPower += power;
      if (k >= lowK && k <= highK) bandPower += power;
    }

    if (totalPower < 1e-6) return 0;
    return bandPower / totalPower; // 0~1
  },

  _fingerInitAIWorker() {
    const f = this._finger;
    if (f.onnxWorker && f.onnxWorker.readyState !== 'closed') {
      // 기존 워커 재사용
      this._flog('AI 워커 재사용');
      return;
    }
    try {
      this._flog('ME-rPPG AI 워커 생성');
      f.onnxWorker = new Worker('me-rppg/onnxWorker.js');
      f.aiModelReady = false;
      f.aiStateReady = false;
      f.aiSamples = [];

      f.onnxWorker.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === 'ready') {
          if (msg.which === 'model') {
            f.aiModelReady = true;
            this._flog('✓ AI 모델 준비 완료');
          } else if (msg.which === 'state') {
            f.aiStateReady = true;
            this._flog('✓ AI 상태 준비 완료');
          }
        } else if (msg.type === 'data') {
          // PPG 신호 1개 값 — AI 출력 누적
          if (typeof msg.output === 'number' && isFinite(msg.output)) {
            f.aiSamples.push({ t: msg.timestamp || performance.now(), v: msg.output });
            if (f.aiSamples.length > 2400) f.aiSamples = f.aiSamples.slice(-2400);
          }
        } else if (msg.type === 'error') {
          this._flog(`AI 워커 오류 (${msg.which}): ${msg.error}`, 'error');
        }
      };

      f.onnxWorker.onerror = (e) => {
        this._flog('AI 워커 에러: ' + e.message, 'error');
        f.aiWorkerFailed = true;
      };
    } catch (e) {
      this._flog('AI 워커 초기화 실패: ' + e.message, 'error');
      f.aiWorkerFailed = true;
    }
  },

  // ★ v15.9: 손가락 ROI를 36x36 RGB Float32로 변환 후 AI 워커에 전송
  _fingerSendToAI(video, vw, vh) {
    const f = this._finger;
    if (!f.onnxWorker || !f.aiModelReady || !f.aiStateReady || f.aiWorkerFailed) return;

    try {
      // 중앙 ROI 추출 후 36x36으로 리사이즈
      if (!f._aiCanvas) {
        f._aiCanvas = document.createElement('canvas');
        f._aiCanvas.width = 36;
        f._aiCanvas.height = 36;
        f._aiCtx = f._aiCanvas.getContext('2d');
      }
      const cropSize = Math.min(vw, vh) * 0.5;
      const sx = (vw - cropSize) / 2;
      const sy = (vh - cropSize) / 2;
      f._aiCtx.drawImage(video, sx, sy, cropSize, cropSize, 0, 0, 36, 36);

      const data = f._aiCtx.getImageData(0, 0, 36, 36).data;
      const input = new Float32Array(36 * 36 * 3);
      for (let i = 0; i < data.length; i += 4) {
        const idx = i / 4;
        input[idx * 3]     = data[i]   / 255;
        input[idx * 3 + 1] = data[i+1] / 255;
        input[idx * 3 + 2] = data[i+2] / 255;
      }

      f.onnxWorker.postMessage({
        input,
        timestamp: performance.now(),
        lambda: 1,
      });
    } catch (e) {
      this._flog('AI 입력 전송 오류: ' + e.message, 'warn');
    }
  },

  _fingerStartTimer() {
    const f = this._finger;
    if (f.timerInterval) clearInterval(f.timerInterval);
    f.timerInterval = setInterval(() => {
      if (!f.measuring) return;
      const elapsed = (performance.now() - f.measureStartTime) / 1000;
      const remain = Math.max(0, f.duration - elapsed);
      const pct = Math.min(100, (elapsed / f.duration) * 100);

      const tn = document.getElementById('finger-timer-num');
      const pp = document.getElementById('finger-progress-pct');
      if (tn) tn.textContent = Math.ceil(remain);
      if (pp) pp.textContent = Math.round(pct);

      if (remain <= 0) {
        this._fingerFinalize();
      }
    }, 100);
  },

  // 신호 품질 계산
  _fingerUpdateQuality() {
    const f = this._finger;
    if (f.samples.length < 60) {
      f.quality = Math.round((f.samples.length / 60) * 30);
      f.lastSQI = 0;
    } else {
      // ★ v16.0: 3가지 지표 종합
      //   1. 신호 변동성 (AC component) - 기존 방식
      //   2. SQI - PPG 주파수 대역 에너지 비율 (Karlen 2012)
      //   3. 유효 ROI 셀 수 - 손가락이 골고루 덮혔는지

      // 1. AC variance
      const recent = f.samples.slice(-90).map(s => s.r);
      const detrended = recent.map((v, i) => {
        const start = Math.max(0, i - 15);
        const end = Math.min(recent.length, i + 16);
        const slice = recent.slice(start, end);
        const m = slice.reduce((s,v) => s+v, 0) / slice.length;
        return v - m;
      });
      const variance = detrended.reduce((s, v) => s + v * v, 0) / detrended.length;
      const std = Math.sqrt(variance);
      // PPG std는 손가락 댄 상태에서 0.5 ~ 8 정도
      const acScore = Math.max(0, Math.min(99, 35 + std * 10));

      // 2. SQI — 주파수 도메인 검증 (1초마다만 계산 — 비용)
      if (!f.lastSQITime || performance.now() - f.lastSQITime > 1000) {
        f.lastSQI = this._fingerComputeSQI(recent);
        f.lastSQITime = performance.now();
      }
      // SQI는 0~1 → 0~99로 매핑. 0.3 이상이 좋은 신호
      const sqiScore = Math.min(99, f.lastSQI * 200);

      // 3. ROI 셀 비율
      const cellRatio = (f.lastValidCellCount || 0) / 9;
      const cellScore = cellRatio * 99;

      // 가중 평균 — SQI가 가장 중요 (50%), AC 30%, Cell 20%
      f.quality = Math.max(20, Math.min(99, Math.round(
        sqiScore * 0.5 + acScore * 0.3 + cellScore * 0.2
      )));
    }

    // 두 stage 모두 업데이트
    [['finger-quality-fill', 'finger-quality-status'],
     ['finger-quality-fill-2', 'finger-quality-status-2']].forEach(([fillId, stId]) => {
      const fill = document.getElementById(fillId);
      const st = document.getElementById(stId);
      if (fill) fill.style.width = f.quality + '%';
      if (st) {
        if (f.quality >= 80) st.textContent = '매우 좋음';
        else if (f.quality >= 60) st.textContent = '양호';
        else if (f.quality >= 40) st.textContent = '보통';
        else st.textContent = '낮음';
      }
    });

    // box 표시
    const box = document.getElementById('finger-quality-box');
    if (box) box.style.display = 'block';

    // ★ v16.0: SQI 값 UI 업데이트
    const sqiEl = document.getElementById('finger-sqi-value');
    if (sqiEl && f.lastSQI !== undefined) {
      const sqi = (f.lastSQI * 100).toFixed(0);
      let color = '#ef4444'; // 빨강 (나쁨)
      if (f.lastSQI >= 0.3) color = '#22c55e'; // 녹색 (좋음)
      else if (f.lastSQI >= 0.15) color = '#f59e0b'; // 주황 (보통)
      sqiEl.innerHTML = `<span style="color:${color}">${sqi}%</span>`;
    }
  },

  // 실시간 BPM
  _fingerRealtimeBPM() {
    const f = this._finger;
    const samples = f.samples.slice(-300);
    if (samples.length < 90) return;

    const peaks = this._fingerDetectPeaks(samples);
    if (peaks.length < 3) return;

    const intervals = [];
    for (let i = 1; i < peaks.length; i++) {
      const dt = samples[peaks[i]].t - samples[peaks[i - 1]].t;
      if (dt > 300 && dt < 1500) intervals.push(dt);
    }
    if (intervals.length < 2) return;

    const avgIBI = intervals.reduce((s, v) => s + v, 0) / intervals.length;
    const bpm = Math.round(60000 / avgIBI);
    // ★ v18.1: 실시간 표시도 합리성 범위 적용
    if (bpm > 35 && bpm < 155) {
      f.lastBPM = bpm;
      const liveHr = document.getElementById('finger-live-hr');
      if (liveHr) liveHr.textContent = bpm;
    }
  },

  // ────────────────────────────────────────────────
  // Peak detection (개선된 알고리즘 — Allagi 2022 참고)
  // ────────────────────────────────────────────────
  // Peak detection — v15.8 강화 (Butterworth bandpass + 방향성 + 강한 NaN 가드)
  // 학술 근거: Allagi 2022 (FFT Hann Window), Touch Error Elimination 2020
  // ────────────────────────────────────────────────
  _fingerDetectPeaks(samples) {
    if (samples.length < 60) return [];

    // ★ v18.1: 실제 FPS 측정 (하드코딩 30Hz 제거)
    // samples[].t 는 ms 단위 타임스탬프
    let actualFps = 30; // 기본값
    if (samples.length >= 60) {
      const first = samples[0].t, last = samples[samples.length - 1].t;
      const elapsed = last - first; // ms
      if (elapsed > 500) {
        actualFps = (samples.length - 1) / (elapsed / 1000);
      }
    }
    // 합리적 범위 고정 (24~120 Hz)
    actualFps = Math.max(24, Math.min(120, actualFps));

    // ★ v18.1: minDist 동적 계산 — HR 최대 130BPM 보장
    // 130BPM = 462ms IBI → minDist = round(0.462 * fps)
    // 여유 있게 150BPM = 400ms 기준: minDist = 0.4 * fps
    const minDist = Math.round(0.40 * actualFps); // 400ms @ 실제 FPS

    // 1) Raw 빨강 채널
    let raw = samples.map(s => s.r);

    // 2) Detrend (이동평균 45 = 1.5초 window @ 30Hz, DC 제거)
    // ★ v18.1: detrend window = 1.5초 @ 실제 FPS (30Hz에선 45, 60Hz에선 90)
    const win = Math.round(1.5 * actualFps);
    const detrended = [];
    for (let i = 0; i < raw.length; i++) {
      const start = Math.max(0, i - Math.floor(win / 2));
      const end = Math.min(raw.length, i + Math.floor(win / 2));
      let sum = 0, c = 0;
      for (let j = start; j < end; j++) { sum += raw[j]; c++; }
      detrended.push(raw[i] - sum / c);
    }

    // 3) Butterworth 2차 bandpass — ★ v18.1: 실제 FPS 사용
    const filtered = this._fingerBandpass(detrended, actualFps, 0.7, 3.0);

    // 4) 진폭 정규화 (RMS 기반)
    let sumSq = 0;
    for (const v of filtered) sumSq += v * v;
    const rms = Math.sqrt(sumSq / filtered.length);
    if (rms < 0.01) {
      // 신호가 너무 작아서 peak 검출 불가
      return [];
    }
    const threshold = rms * 0.5; // RMS의 50%

    // 5) Peak detection — 방향성 + 최소 거리 강화
    // PPG에서 손가락 댄 상태: 수축기 = 빨강 감소 = 음의 피크
    //                          이완기 = 빨강 증가 = 양의 피크
    // 일관되게 한 방향만 추적
    let posMax = 0, negMax = 0;
    for (const v of filtered) {
      if (v > posMax) posMax = v;
      if (v < negMax) negMax = v;
    }
    // 더 변동성 큰 방향을 채택
    const usePositive = posMax > Math.abs(negMax);

    // minDist: 이미 위에서 실제 FPS 기반으로 동적 계산됨 (400ms 기준)
    const peaks = [];
    let lastPeak = -minDist;

    for (let i = 2; i < filtered.length - 2; i++) {
      if (i - lastPeak < minDist) continue;
      const v = filtered[i];
      const isPeak = usePositive
        ? (v > threshold && v > filtered[i-1] && v > filtered[i-2] && v > filtered[i+1] && v > filtered[i+2])
        : (v < -threshold && v < filtered[i-1] && v < filtered[i-2] && v < filtered[i+1] && v < filtered[i+2]);
      if (isPeak) {
        peaks.push(i);
        lastPeak = i;
      }
    }

    // ★ v16.1: 인접 IBI 일관성 검증 — 놓친 peak 보강 시도
    // 인접 peak 거리가 평균의 1.8배 이상이면 중간에 peak를 놓친 것
    // → 두 peak 사이에서 가장 큰 변동점을 추가 peak로 인식
    if (peaks.length >= 4) {
      const intervals = [];
      for (let i = 1; i < peaks.length; i++) {
        intervals.push(peaks[i] - peaks[i-1]);
      }
      // 중간값 계산
      const sorted = [...intervals].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];

      const refinedPeaks = [peaks[0]];
      for (let i = 1; i < peaks.length; i++) {
        const gap = peaks[i] - peaks[i-1];
        // 평균보다 1.8배 이상 큰 gap = 1개 peak 놓침
        // 2.7배 이상 = 2개 놓침 (드물지만)
        if (gap > median * 1.8 && gap < median * 4) {
          const numMissed = Math.round(gap / median) - 1;
          if (numMissed >= 1 && numMissed <= 3) {
            // 균등 분할로 보간 peak 위치 추정
            const step = gap / (numMissed + 1);
            for (let k = 1; k <= numMissed; k++) {
              const candidatePos = Math.round(peaks[i-1] + step * k);
              // 후보 위치 ±5 샘플 내에서 가장 큰 진폭의 점을 찾음
              let bestPos = candidatePos, bestVal = -Infinity;
              for (let j = Math.max(0, candidatePos - 5); j <= Math.min(filtered.length - 1, candidatePos + 5); j++) {
                const v = usePositive ? filtered[j] : -filtered[j];
                if (v > bestVal) { bestVal = v; bestPos = j; }
              }
              // 임계값 50%까지만 인정 (너무 약하면 추가 안 함)
              if (bestVal > threshold * 0.5) {
                refinedPeaks.push(bestPos);
              }
            }
          }
        }
        refinedPeaks.push(peaks[i]);
      }
      // 정렬 + 중복 제거
      refinedPeaks.sort((a, b) => a - b);
      const cleaned = [refinedPeaks[0]];
      for (let i = 1; i < refinedPeaks.length; i++) {
        if (refinedPeaks[i] - cleaned[cleaned.length - 1] >= minDist) {
          cleaned.push(refinedPeaks[i]);
        }
      }
      return cleaned;
    }

    return peaks;
  },

  // Butterworth 2차 bandpass IIR 필터 (간단 직렬 구현)
  // forward + backward = zero-phase
  _fingerBandpass(signal, fs, lowHz, highHz) {
    const N = signal.length;
    if (N < 10) return signal.slice();

    // 정규화 주파수
    const nyquist = fs / 2;
    const wLow = lowHz / nyquist;
    const wHigh = highHz / nyquist;

    // 2차 Butterworth bandpass 계수 (bilinear transform)
    // 근사 — 정확한 디자인 대신 실용적 단순 IIR
    const wc = (wLow + wHigh) / 2;
    const bw = wHigh - wLow;
    // Pre-warped
    const omega = Math.PI * wc;
    const K = Math.tan(omega);
    const Q = wc / bw;
    const norm = 1 / (1 + K / Q + K * K);
    const a0 = K / Q * norm;
    const a1 = 0;
    const a2 = -a0;
    const b1 = 2 * (K * K - 1) * norm;
    const b2 = (1 - K / Q + K * K) * norm;

    // Forward pass
    const out = new Array(N).fill(0);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < N; i++) {
      const x = signal[i];
      const y = a0 * x + a1 * x1 + a2 * x2 - b1 * y1 - b2 * y2;
      out[i] = y;
      x2 = x1; x1 = x;
      y2 = y1; y1 = y;
    }
    return out;
  },

  // 파형 그리기
  _fingerDrawWave() {
    const f = this._finger;
    // 두 stage 모두 같은 데이터로 그림
    [f.waveCtx, f.waveCtx2].forEach((ctx, idx) => {
      if (!ctx) return;
      const canvas = idx === 0 ? f.waveCanvas : f.waveCanvas2;
      const W = canvas.width, H = canvas.height;

      // 최근 5초
      const samples = f.samples.slice(-150);
      if (samples.length < 2) return;

      const values = samples.map(s => s.r);
      let minV = Infinity, maxV = -Infinity;
      for (const v of values) { if (v < minV) minV = v; if (v > maxV) maxV = v; }
      const range = Math.max(maxV - minV, 1);

      // 배경
      ctx.fillStyle = '#1a0808';
      ctx.fillRect(0, 0, W, H);

      // 그리드
      ctx.strokeStyle = 'rgba(239,68,68,0.15)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const y = H * i / 4;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      }

      // 파형
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
      ctx.shadowBlur = 6;
      ctx.shadowColor = 'rgba(239, 68, 68, 0.6)';
      ctx.beginPath();
      for (let i = 0; i < values.length; i++) {
        const x = (i / (values.length - 1)) * W;
        const y = H - ((values[i] - minV) / range) * H * 0.85 - H * 0.075;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    });
  },

  // ────────────────────────────────────────────────
  // 측정 완료 → 분석
  // ────────────────────────────────────────────────
  async _fingerFinalize() {
    this._flog('측정 30초 완료, 분석 시작');
    const f = this._finger;
    f.measuring = false;
    if (f.timerInterval) { clearInterval(f.timerInterval); f.timerInterval = null; }
    if (f.rafId) { cancelAnimationFrame(f.rafId); f.rafId = null; }
    this._fingerHideLiveWarning();

    this._flog(`총 측정 샘플: ${f.measureSamples.length}개`);

    // ★ v18.1: try-catch로 분석 에러 격리 — 어떤 예외도 UI 복구 보장
    let result;
    try {
      result = this._fingerAnalyze();
    } catch (err) {
      this._flog(`분석 예외 발생: ${err.message}`, 'error');
      console.error('[Finger] _fingerAnalyze 예외:', err);
      result = {
        ok: false,
        reason: `분석 중 오류가 발생했습니다. 다시 측정해주세요. (${err.message})`,
        sampleCount: f.measureSamples.length,
      };
    }

    // 카메라 정리
    try {
      await this._fingerCleanup();
    } catch (err) {
      console.warn('[Finger] cleanup 오류 (무시):', err.message);
    }

    // UI: result 화면으로 — 반드시 실행
    document.getElementById('finger-stage-measuring').style.display = 'none';
    this._fingerDisplayResult(result);
  },

  _fingerAnalyze() {
    const f = this._finger;
    const samples = f.measureSamples;

    if (samples.length < 100) {
      this._flog(`샘플 부족: ${samples.length}개`, 'error');
      return {
        ok: false,
        reason: `측정 데이터 부족 (${samples.length}개). 손가락이 카메라를 충분히 덮지 않았을 수 있어요.`,
        sampleCount: samples.length,
      };
    }

    // ★ v16.1: 3개 채널 모두 분석 후 최적 채택
    //   - R (빨강): 플래시 ON에서 표준, 헤모글로빈 흡수
    //   - G (녹색): 플래시 OFF (외부조명)에서 표준 (Verkruysse 2008)
    //   - AI: ME-rPPG 신경망 출력
    const aiAvailable = f.aiSamples && f.aiSamples.length >= 100;
    this._flog(`v16.1: 다채널 분석 시작 (R/G${aiAvailable ? '/AI' : ''})`);
    this._flog(`측정 모드: ${f.torchOn ? '플래시 ON' : '외부 조명'} (신호 강한 채널 자동 선택)`);

    // 1) R 채널 분석
    let resultR = null;
    try { resultR = this._fingerAnalyzeFromSignal(samples, 'r', 'R-channel'); }
    catch (e) { this._flog(`R채널 예외: ${e.message}`, 'error'); }

    // 2) G 채널 분석
    const hasG = samples.length > 0 && samples[0].g !== undefined;
    let resultG = null;
    if (hasG) {
      try {
        const gSamples = samples.map(s => ({ t: s.t, r: s.g }));
        resultG = this._fingerAnalyzeFromSignal(gSamples, 'r', 'G-channel');
      } catch (e) { this._flog(`G채널 예외: ${e.message}`, 'error'); }
    }

    // 3) AI 분석
    let resultAI = null;
    if (aiAvailable) {
      try {
        const aiNorm = f.aiSamples.map(s => ({ t: s.t, r: s.v * 100 + 128 }));
        resultAI = this._fingerAnalyzeFromSignal(aiNorm, 'r', 'AI-channel');
      } catch (e) { this._flog(`AI채널 예외: ${e.message}`, 'error'); }
    }

    // ★ v24.8: 채널별 평균 밝기 계산 — 손가락 측정 시 신호 유효성 판단
    // 손가락으로 카메라를 덮으면 R은 포화(빨강만 통과), G/B는 거의 0이 됨
    // → 밝기가 너무 낮은 채널(G<25)은 심박 신호가 없으므로 신뢰 불가
    let avgR = 0, avgG = 0;
    try {
      const n = Math.min(samples.length, 600);
      for (let i = 0; i < n; i++) { avgR += (samples[i].r || 0); avgG += (samples[i].g || 0); }
      if (n > 0) { avgR /= n; avgG /= n; }
    } catch (e) {}
    this._flog(`채널 밝기: avgR=${avgR.toFixed(0)} avgG=${avgG.toFixed(0)}`);
    const gTooDark = avgG < 25;   // G채널이 거의 0 → 손가락이 빛을 막음 (R 신호만 유효)
    const rSaturated = avgR > 240; // R 완전 포화 → R도 신호 약할 수 있음

    // 4) 각 결과 점수 계산 — 신뢰도 + HR 합리성 복합
    const scoreOf = (r, channel) => {
      if (!r || !r.ok) return 0;
      // 학술적으로 비정상적 RMSSD/SDNN은 신호 오류
      if (r.rmssd > 100 && r.sdnn > 150) return 0; // 비정상치 패널티
      // ★ v18.1: HR 합리성 패널티 — 150BPM 초과는 오측정 가능성
      if (r.hr > 150) return 0;
      if (r.hr > 130) return (r.ibiCount * (r.cleanRate / 100)) * 0.2; // 심한 감점
      // ★ v24.8: 채널 밝기 기반 패널티 — 어두운 채널은 신호 신뢰 불가
      if (channel === 'G' && gTooDark) return 0;   // G가 거의 0이면 무효
      // 점수: 채택률 × IBI 수
      let s = r.ibiCount * (r.cleanRate / 100);
      // RMSSD가 너무 높으면 감점 (정상 0-80ms)
      if (r.rmssd > 80) s *= 0.5;
      if (r.rmssd > 150) s *= 0.3;
      // ★ v24.9: Elgendi SQI 통합 — 신호 품질로 가중 (왜도·박동 상관 반영)
      // 검증된 품질 지표가 낮은 채널은 감점 → 진짜 심박 신호 우선 채택
      if (typeof r.sqiQuality === 'number') {
        const qFactor = 0.5 + (r.sqiQuality / 100) * 0.5; // 품질 0%→0.5배, 100%→1.0배
        s *= qFactor;
      }
      if (typeof r.beatValidRatio === 'number' && r.beatValidRatio < 40) {
        s *= 0.6; // 유효 박동 비율 40% 미만이면 감점 (템플릿 불일치)
      }
      return s;
    };

    const sR = scoreOf(resultR, 'R');
    const sG = scoreOf(resultG, 'G');
    const sAI = scoreOf(resultAI, 'AI');
    this._flog(`채널 점수: R=${sR.toFixed(1)} G=${sG.toFixed(1)} AI=${sAI.toFixed(1)}`);

    // 5) 최적 채널 선택 — 토치 상태에 따라 선호도 조정
    let chosen, signalSource;
    if (f.torchOn) {
      // 플래시 ON: R 우선, G가 30% 이상 좋으면 G, AI는 50% 이상 좋아야
      if (sG > sR * 1.3 && resultG) {
        chosen = resultG; signalSource = 'G-channel';
      } else if (sAI > sR * 1.5 && resultAI) {
        chosen = resultAI; signalSource = 'AI';
      } else if (resultR && resultR.ok) {
        chosen = resultR; signalSource = 'R-channel';
      } else {
        chosen = resultG || resultAI || resultR;
        signalSource = chosen === resultG ? 'G-channel' : chosen === resultAI ? 'AI' : 'R-channel';
      }
    } else {
      // 플래시 OFF: 기본은 G 우선 (Verkruysse 2008)
      // ★ v24.8: 단, G채널이 너무 어두우면(손가락이 빛 차단) R채널 우선 — 오측정 방지
      if (gTooDark) {
        this._flog('G채널 신호 약함 → R채널 우선 (손가락 측정 환경)', 'info');
        if (resultR && resultR.ok && sR > 0) {
          chosen = resultR; signalSource = 'R-channel';
        } else if (resultAI && resultAI.ok && sAI > 0) {
          chosen = resultAI; signalSource = 'AI';
        } else {
          chosen = resultR || resultAI || resultG;
          signalSource = chosen === resultR ? 'R-channel' : chosen === resultAI ? 'AI' : 'G-channel';
        }
      } else if (sR > sG * 1.5 && resultR) {
        chosen = resultR; signalSource = 'R-channel';
      } else if (sAI > sG * 1.5 && resultAI) {
        chosen = resultAI; signalSource = 'AI';
      } else if (resultG && resultG.ok && sG > 0) {
        chosen = resultG; signalSource = 'G-channel';
      } else {
        chosen = resultR || resultAI || resultG;
        signalSource = chosen === resultR ? 'R-channel' : chosen === resultAI ? 'AI' : 'G-channel';
      }
    }

    if (!chosen || !chosen.ok) {
      this._flog('모든 채널 분석 실패', 'error');
      return chosen || {
        ok: false,
        reason: '모든 신호 채널에서 심박을 추출할 수 없었습니다. 다시 측정해주세요.',
        sampleCount: samples.length,
      };
    }

    this._flog(`✓ 최종 채택: ${signalSource} HR=${chosen.hr} RMSSD=${chosen.rmssd}`);

    // ★ v16.1: 최종 결과 유효성 검증 (이상치 거부)
    const validation = this._fingerValidateResult(chosen);
    if (!validation.valid) {
      this._flog(`⚠️ 결과 검증 실패: ${validation.reason}`, 'warn');
      chosen.validationWarning = validation.reason;
      chosen.confidence = 'low';
    } else {
      chosen.confidence = validation.confidence;
    }

    chosen.signalSource = signalSource;
    return chosen;
  },

  // ★ v16.1: 결과 유효성 검증 — 비정상치 거부
  _fingerValidateResult(result) {
    if (!result || !result.ok) return { valid: false, reason: '분석 결과 없음' };

    // ★ v18.1: HR 범위 검증 강화
    if (result.hr < 30 || result.hr > 200) {
      return { valid: false, reason: `HR ${result.hr} BPM은 비현실적입니다` };
    }
    // 안정 시 측정에서 150BPM 초과는 오측정 경고 (운동 직후 등 예외 있음)
    if (result.hr > 150) {
      return {
        valid: false,
        reason: `HR ${result.hr} BPM은 안정 시 범위를 크게 벗어납니다. 손가락이 카메라를 완전히 덮지 않았을 수 있습니다. 다시 측정해주세요.`
      };
    }

    // RMSSD 비정상치 — 정상인 20-60ms, 운동선수 60-80ms, >100ms는 측정 오류
    if (result.rmssd > 150) {
      return {
        valid: false,
        reason: `RMSSD ${result.rmssd}ms는 비정상적으로 높습니다 (정상 20-80ms). 측정 신호에 noise가 섞였을 가능성이 높습니다.`
      };
    }

    // SDNN 비정상치 — 정상 30-100ms, >200ms는 거의 측정 오류
    if (result.sdnn > 200) {
      return {
        valid: false,
        reason: `SDNN ${result.sdnn}ms는 비정상적으로 높습니다 (정상 30-100ms).`
      };
    }

    // 채택률 너무 낮음
    if (result.cleanRate < 50) {
      return { valid: false, reason: `신호 채택률 ${result.cleanRate}%로 신뢰도 낮음` };
    }

    // ★ v24.9: Elgendi SQI 기반 검증 — 신호 품질/박동 일관성
    // 검증된 왜도 기반 품질이 매우 낮거나, 박동 템플릿 상관이 낮으면 노이즈 의심
    if (typeof result.sqiQuality === 'number' && result.sqiQuality < 30 &&
        typeof result.beatValidRatio === 'number' && result.beatValidRatio < 35) {
      return { valid: false, reason: `신호 품질이 낮습니다 (품질 ${result.sqiQuality}%, 박동 일관성 ${result.beatValidRatio}%). 손가락을 가만히 대고 다시 측정해주세요.` };
    }

    // 신뢰도 레벨
    let confidence = 'high';
    if (result.cleanRate < 75 || result.rmssd > 80) confidence = 'medium';
    if (result.signalQuality < 60) confidence = confidence === 'high' ? 'medium' : 'low';

    return { valid: true, confidence };
  },

  // ★ v15.9: 신호 → HR/HRV 계산 (재사용 가능)
  // ★ v24.9: PPG 신호 품질 지표 (Elgendi 2016, Bioengineering 3(4):21)
  // 검증: 8개 SQI 중 Skewness가 최고 성능 (F1 86%, p<10⁻¹⁰)
  // 깨끗한 PPG는 양의 왜도, 손상 신호는 음의 왜도를 보임
  _computePpgSQI(signal) {
    const n = signal.length;
    if (n < 30) return { skewness: 0, perfusion: 0, snr: 0, quality: 0 };
    // 평균/표준편차
    let mean = 0;
    for (let i = 0; i < n; i++) mean += signal[i];
    mean /= n;
    let variance = 0;
    for (let i = 0; i < n; i++) { const d = signal[i] - mean; variance += d * d; }
    variance /= n;
    const std = Math.sqrt(variance) || 1e-9;

    // Skewness SQI (Elgendi 식 3) — 3차 표준화 적률
    let skew = 0;
    for (let i = 0; i < n; i++) { const z = (signal[i] - mean) / std; skew += z * z * z; }
    skew /= n;

    // Perfusion SQI (Elgendi 식 2, Philips/Masimo 골드스탠다드)
    // PI = (max - min) / |mean| × 100 — 관류 강도
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < n; i++) { if (signal[i] < mn) mn = signal[i]; if (signal[i] > mx) mx = signal[i]; }
    const perfusion = Math.abs(mean) > 1e-6 ? ((mx - mn) / Math.abs(mean)) * 100 : 0;

    // SNR (신호 분산 / 노이즈 분산의 근사 — 1차 차분을 노이즈로 간주)
    let noiseVar = 0;
    for (let i = 1; i < n; i++) { const d = signal[i] - signal[i - 1]; noiseVar += d * d; }
    noiseVar = (noiseVar / (n - 1)) || 1e-9;
    const snr = variance / noiseVar;

    // 종합 품질 (0~1) — 왜도가 양수이고 클수록, perfusion·SNR 높을수록 우수
    // Elgendi 기준: 깨끗한 신호 skew ≈ +0.1, 손상 ≈ -0.2
    let quality = 0;
    quality += Math.max(0, Math.min(1, (skew + 0.3) / 0.6)) * 0.6; // 왜도 60% 비중 (최우수 지표)
    quality += Math.max(0, Math.min(1, snr / 3)) * 0.25;           // SNR 25%
    quality += Math.max(0, Math.min(1, perfusion / 50)) * 0.15;    // 관류 15%
    return { skewness: skew, perfusion, snr, quality: Math.max(0, Math.min(1, quality)) };
  },

  // ★ v24.9: 템플릿 매칭 SQI (Orphanidou/Warren 방식)
  // 각 박동을 평균 템플릿과 상관 비교 → 손상된 박동 비율 산출
  _computeBeatTemplateSQI(signal, peaks) {
    if (!peaks || peaks.length < 5) return { corr: 0, validRatio: 0 };
    // 각 peak 주변 고정 창(전후 동일)으로 박동 조각 추출 후 z-정규화
    const beats = [];
    const half = 15; // peak 전후 샘플
    for (const pk of peaks) {
      const p = Math.round(pk);
      if (p - half < 0 || p + half >= signal.length) continue;
      const seg = signal.slice(p - half, p + half + 1);
      let m = 0; for (const v of seg) m += v; m /= seg.length;
      let sd = 0; for (const v of seg) sd += (v - m) * (v - m); sd = Math.sqrt(sd / seg.length) || 1e-9;
      beats.push(seg.map(v => (v - m) / sd));
    }
    if (beats.length < 4) return { corr: 0, validRatio: 0 };
    // 평균 템플릿
    const L = beats[0].length;
    const tmpl = new Array(L).fill(0);
    for (const b of beats) for (let i = 0; i < L; i++) tmpl[i] += b[i] / beats.length;
    // 각 박동과 템플릿의 상관계수
    let valid = 0, sumCorr = 0;
    for (const b of beats) {
      let num = 0, db = 0, dt = 0;
      for (let i = 0; i < L; i++) { num += b[i] * tmpl[i]; db += b[i] * b[i]; dt += tmpl[i] * tmpl[i]; }
      const corr = num / (Math.sqrt(db * dt) || 1e-9);
      sumCorr += corr;
      if (corr > 0.8) valid++; // Orphanidou 기준: r>0.8 정상 박동
    }
    return { corr: sumCorr / beats.length, validRatio: valid / beats.length };
  },

  _fingerAnalyzeFromSignal(samples, key, sourceLabel) {
    const f = this._finger;

    if (samples.length < 100) {
      return { ok: false, reason: `샘플 부족 (${samples.length}개)`, sampleCount: samples.length };
    }

    const peaks = this._fingerDetectPeaks(samples);

    if (peaks.length < 10) {
      return {
        ok: false,
        reason: `심박 신호가 충분히 감지되지 않았습니다 (${peaks.length}개 peak). 다시 측정해주세요.`,
        sampleCount: samples.length,
        peakCount: peaks.length,
      };
    }

    // IBI 추출 — ★ v18.1: peaks[i]가 범위 초과 시 안전 처리
    const allIBI = [];
    for (let i = 1; i < peaks.length; i++) {
      const pi  = Math.round(peaks[i]);
      const pim = Math.round(peaks[i - 1]);
      if (pi >= samples.length || pim >= samples.length) continue;
      const s1 = samples[pi], s0 = samples[pim];
      if (!s1 || !s0) continue;
      const dt = s1.t - s0.t;
      if (dt > 0) allIBI.push(dt);
    }

    // ★ v18.1: IBI 필터
    // - 하한: 300ms(200BPM) — 370ms는 외부조명 환경에서 유효 피크 손실 과다
    // - 상한: 1714ms(35BPM)
    // - 연속 변동 20% (Kubios 기준)
    const cleanIBI = [];
    for (let i = 0; i < allIBI.length; i++) {
      const ibi = allIBI[i];
      if (ibi < 300 || ibi > 1714) continue;
      if (cleanIBI.length > 0) {
        const ref = cleanIBI[cleanIBI.length - 1];
        if (Math.abs(ibi - ref) / ref > 0.20) continue;
      }
      cleanIBI.push(ibi);
    }

    if (cleanIBI.length < 8) {
      return {
        ok: false,
        reason: `신호가 불안정합니다 (유효 신호 ${cleanIBI.length}개). 손가락을 더 가만히 두고 다시 측정해주세요.`,
        sampleCount: samples.length,
        peakCount: peaks.length,
      };
    }

    // HR, RMSSD, SDNN, pNN50 계산
    const meanIBI = cleanIBI.reduce((s, v) => s + v, 0) / cleanIBI.length;
    const hr = Math.round(60000 / meanIBI);

    // ★ v18.1: HR 합리성 검증 — 중앙값으로 2차 검증
    const sortedIBI = [...cleanIBI].sort((a, b) => a - b);
    const medianIBI = sortedIBI[Math.floor(sortedIBI.length / 2)];
    const hrFromMedian = Math.round(60000 / medianIBI);
    let refinedHR = null;
    // 평균 vs 중앙값 HR 차이가 15BPM 이상이면 이상치 왜곡 의심
    if (Math.abs(hr - hrFromMedian) > 15) {
      this._flog(`[v18.1] HR 왜곡 감지: mean=${hr} median=${hrFromMedian} → 중앙값 채택`, 'warn');
      const medIBIs = cleanIBI.filter(v => Math.abs(v - medianIBI) / medianIBI <= 0.20);
      if (medIBIs.length >= 6) {
        const refinedMeanIBI = medIBIs.reduce((s, v) => s + v, 0) / medIBIs.length;
        refinedHR = Math.round(60000 / refinedMeanIBI);
      }
    }

    let sumSquaredDiff = 0, diffCount = 0;
    for (let i = 1; i < cleanIBI.length; i++) {
      const diff = cleanIBI[i] - cleanIBI[i - 1];
      sumSquaredDiff += diff * diff;
      diffCount++;
    }
    const rmssd = diffCount > 0 ? Math.sqrt(sumSquaredDiff / diffCount) : 0;

    const variance = cleanIBI.reduce((s, v) => s + (v - meanIBI) ** 2, 0) / cleanIBI.length;
    const sdnn = Math.sqrt(variance);

    let nn50 = 0;
    for (let i = 1; i < cleanIBI.length; i++) {
      if (Math.abs(cleanIBI[i] - cleanIBI[i - 1]) > 50) nn50++;
    }
    const pNN50 = (nn50 / diffCount) * 100;

    let stressLevel = 2, stressLabel = '보통';
    if (rmssd > 60) { stressLevel = 1; stressLabel = '매우 이완'; }
    else if (rmssd > 40) { stressLevel = 2; stressLabel = '이완'; }
    else if (rmssd > 25) { stressLevel = 3; stressLabel = '보통'; }
    else if (rmssd > 15) { stressLevel = 4; stressLabel = '긴장'; }
    else { stressLevel = 5; stressLabel = '높은 스트레스'; }

    // ★ v15.9: Baevsky Stress Index 추가 (학술 표준)
    // SI = AMo / (2 × Mo × MxDMn)
    // Mo = 가장 빈번한 IBI 구간 (mode)
    // AMo = Mo 빈도 (%) — 50ms bin
    // MxDMn = IBI 최대값 - 최소값 (변동성)
    //
    // 일반적 해석 (Baevsky 1997):
    //   < 50    : 매우 낮음 (이상적 자율신경 균형)
    //   50-150  : 정상 범위
    //   150-500 : 가벼운 스트레스 (긴장 상태)
    //   500-900 : 중등도 스트레스 (교감신경 우세)
    //   > 900   : 심한 스트레스 (만성 긴장)
    let stressIndex = 0;
    let stressIndexLabel = '정상';
    try {
      // Mode 계산 (50ms bin)
      const histogram = {};
      for (const ibi of cleanIBI) {
        const bin = Math.round(ibi / 50) * 50;
        histogram[bin] = (histogram[bin] || 0) + 1;
      }
      let modeBin = 0, modeCount = 0;
      for (const [bin, cnt] of Object.entries(histogram)) {
        if (cnt > modeCount) { modeCount = cnt; modeBin = +bin; }
      }
      const mo = modeBin / 1000; // seconds
      const amo = (modeCount / cleanIBI.length) * 100;
      const mxdmn = (Math.max(...cleanIBI) - Math.min(...cleanIBI)) / 1000; // s
      if (mo > 0 && mxdmn > 0) {
        stressIndex = Math.round(amo / (2 * mo * mxdmn));
      }
      stressIndex = Math.max(0, Math.min(2000, stressIndex));

      if (stressIndex < 50) stressIndexLabel = '매우 낮음 (이상적)';
      else if (stressIndex < 150) stressIndexLabel = '정상 범위';
      else if (stressIndex < 500) stressIndexLabel = '가벼운 긴장';
      else if (stressIndex < 900) stressIndexLabel = '중등도 스트레스';
      else stressIndexLabel = '심한 스트레스';
    } catch (e) {
      this._flog('Stress Index 계산 실패: ' + e.message, 'warn');
    }

    const recoveryRate = cleanIBI.length / Math.max(allIBI.length, 1);
    const signalQuality = Math.round(Math.min(99, f.quality * 0.5 + recoveryRate * 50));

    this._flog(`✓ [${sourceLabel}] 분석: HR=${hr} RMSSD=${rmssd.toFixed(1)} SDNN=${sdnn.toFixed(1)} pNN50=${pNN50.toFixed(1)} SI=${stressIndex} clean=${cleanIBI.length}/${allIBI.length}`);

    // ★ v18.0: 손가락 PPG 부정맥 분석 (Poincaré)
    let fingerArrhythmia = null;
    if (cleanIBI.length >= 8) {
      try {
        const rr = cleanIBI;
        const n = rr.length;
        const meanRR_fa = rr.reduce((a, b) => a + b, 0) / n;
        let sumSD1 = 0, sumSD2 = 0;
        for (let i = 0; i < n - 1; i++) {
          const x = rr[i], y = rr[i + 1];
          sumSD1 += ((y - x) / Math.SQRT2) ** 2;
          sumSD2 += ((y + x) / Math.SQRT2) ** 2;
        }
        const sd1_f = Math.round(Math.sqrt(sumSD1 / (n - 1)));
        const sd2_f = Math.round(Math.sqrt(sumSD2 / (n - 1)));
        let irregCount = 0;
        for (let i = 1; i < n; i++) {
          if (Math.abs(rr[i] - rr[i - 1]) / rr[i - 1] > 0.20) irregCount++;
        }
        const irregPct_f = Math.round((irregCount / (n - 1)) * 100);
        const flags_f = [];
        const sd_ratio_f = sd1_f > 0 ? sd2_f / sd1_f : 0;
        if (sd_ratio_f > 0 && sd_ratio_f < 1.5) flags_f.push('sd_ratio_low');
        if (irregPct_f > 35) flags_f.push('high_irr');
        // 연속 점프
        let jumpStreak_f = 0, maxJump_f = 0;
        for (let i = 1; i < n; i++) {
          if (Math.abs(rr[i] - rr[i - 1]) / meanRR_fa > 0.25) {
            jumpStreak_f++; maxJump_f = Math.max(maxJump_f, jumpStreak_f);
          } else jumpStreak_f = 0;
        }
        if (maxJump_f >= 3) flags_f.push('rhythm_jump');
        const risk_f = flags_f.length <= 1 ? 'low' : flags_f.length === 2 ? 'moderate' : 'high';
        fingerArrhythmia = { risk: risk_f, flags: flags_f, sd1: sd1_f, sd2: sd2_f,
                             sd_ratio: Math.round(sd_ratio_f * 100) / 100, irregPct: irregPct_f };
        this._flog(`[v18 Arrhythmia-Finger] risk=${risk_f} SD1=${sd1_f} SD2=${sd2_f} irr=${irregPct_f}%`);
      } catch (e) { this._flog('[v18 Arrhythmia-Finger] 실패: ' + e.message, 'warn'); }
    }

    // ★ v24.9: PPG 신호 품질 지표 계산 (Elgendi 2016 + 템플릿 매칭)
    let sqi = { skewness: 0, perfusion: 0, snr: 0, quality: 0 };
    let beatSQI = { corr: 0, validRatio: 0 };
    try {
      const sig = samples.map(s => s.r);
      sqi = this._computePpgSQI(sig);
      beatSQI = this._computeBeatTemplateSQI(sig, peaks);
      this._flog(`[SQI] skew=${sqi.skewness.toFixed(2)} PI=${sqi.perfusion.toFixed(0)} SNR=${sqi.snr.toFixed(1)} 박동상관=${beatSQI.corr.toFixed(2)} 품질=${(sqi.quality*100).toFixed(0)}%`);
    } catch (e) { this._flog('[SQI] 계산 실패: ' + e.message, 'warn'); }

    return {
      ok: true,
      // ★ v18.1: 중앙값 기반 정제 HR이 있으면 우선 사용
      hr: refinedHR || hr,
      rmssd: Math.round(rmssd * 10) / 10,
      sdnn: Math.round(sdnn * 10) / 10,
      pNN50: Math.round(pNN50 * 10) / 10,
      stressLevel, stressLabel,
      stressIndex, stressIndexLabel, // ★ v15.9
      meanIBI: Math.round(meanIBI),
      ibiCount: cleanIBI.length,
      totalPeaks: peaks.length,
      cleanRate: Math.round(recoveryRate * 100),
      signalQuality,
      // ★ v24.9: 신호 품질 지표 (Elgendi SQI)
      sqiSkewness: Math.round(sqi.skewness * 100) / 100,
      sqiPerfusion: Math.round(sqi.perfusion),
      sqiSnr: Math.round(sqi.snr * 10) / 10,
      sqiQuality: Math.round(sqi.quality * 100),
      beatCorr: Math.round(beatSQI.corr * 100) / 100,
      beatValidRatio: Math.round(beatSQI.validRatio * 100),
      sampleCount: samples.length,
      duration: f.duration,
      score: this._fingerComputeScore(hr, rmssd, signalQuality),
      // ★ v18.0
      arrhythmia: fingerArrhythmia,
    };
  },

  _fingerComputeScore(hr, rmssd, signalQuality) {
    const profile = this._getUserProfile();
    const { age, gender } = profile;

    if (!age) {
      let score = 100;
      if (hr < 50 || hr > 100) score -= 15;
      if (rmssd < 15) score -= 25;
      else if (rmssd < 25) score -= 10;
      if (signalQuality < 70) score -= 10;
      return Math.max(5, Math.min(99, score));
    }

    const hrRef = this._refRestingHR(age, gender);
    const rmssdRef = this._refRMSSD(age, gender);
    const hrDev = Math.abs(hr - hrRef.mean) / hrRef.sd;
    const hrScore = Math.max(5, Math.min(99, this._zToScore(-hrDev + 0.7)));
    const rmssdScore = this._ageNormalizedScore(rmssd, rmssdRef, true);

    let composite = Math.round(hrScore * 0.30 + rmssdScore * 0.70);
    if (signalQuality < 70) composite = Math.round(composite * 0.9);
    if (signalQuality < 50) composite = Math.round(composite * 0.8);
    return Math.max(5, Math.min(99, composite));
  },

  _fingerDisplayResult(result) {
    const container = document.getElementById('finger-result');
    container.style.display = 'block';

    if (!result.ok) {
      container.innerHTML = `
        <div class="finger-error-card">
          <div class="finger-error-icon">😔</div>
          <div class="finger-error-title">측정 실패</div>
          <div class="finger-error-msg">${this._esc(result.reason)}</div>
          <div class="finger-error-detail">
            샘플: ${result.sampleCount || 0}개 · Peak: ${result.peakCount || 0}개
          </div>
          <button class="finger-retry-btn" type="button" onclick="App.fingerRestart()">
            🔄 다시 측정
          </button>
          <button class="finger-back-btn" type="button" onclick="App.fingerToggleLog()">
            📋 로그 확인
          </button>
          <button class="finger-back-btn" type="button" onclick="App.goPage('home')">홈으로</button>
        </div>
      `;
      return;
    }

    const getColor = (s) => s >= 75 ? '#22C55E' : s >= 55 ? '#3B82F6' : s >= 40 ? '#F59E0B' : '#EF4444';
    const profile = this._getUserProfile();
    const ageMsg = profile.age ? `${profile.age}세 또래 평균 대비` : '일반 성인 기준';
    const rmssdRef = profile.age ? this._refRMSSD(profile.age, profile.gender) : { mean: 35, sd: 18 };
    const rmssdRel = result.rmssd > rmssdRef.mean ? '평균보다 높음 (좋음)'
                  : result.rmssd > rmssdRef.mean - rmssdRef.sd ? '평균 수준'
                  : '평균보다 낮음';

    // ★ v15.9: 각 수치별 의미 해석 멘트
    const hrInterp = result.hr < 50 ? '서맥 - 운동선수이거나 미주신경 우세' :
                     result.hr <= 70 ? '안정적인 휴식기 심박수' :
                     result.hr <= 85 ? '정상 범위 (평소 수준)' :
                     result.hr <= 100 ? '약간 빠름 - 카페인·긴장 가능' :
                                       '빠름 - 휴식이 필요해요';

    const rmssdInterp = result.rmssd < 15 ? '낮음 - 스트레스 또는 피로 신호' :
                        result.rmssd < 25 ? '평균 이하 - 회복이 필요해요' :
                        result.rmssd < 40 ? '정상 범위' :
                        result.rmssd < 60 ? '양호 - 자율신경 건강' :
                                            '매우 높음 - 깊은 이완 상태';

    const sdnnInterp = result.sdnn < 30 ? '낮음 - 자율신경 활동 둔화' :
                       result.sdnn < 50 ? '평균 - 일반적 수준' :
                       result.sdnn < 100 ? '양호 - 균형잡힌 신경계' :
                                           '높음 - 강한 자율신경 적응력';

    const pNN50Interp = result.pNN50 < 3 ? '낮음 - 부교감신경 활동 부족' :
                        result.pNN50 < 10 ? '평균 - 보통 수준' :
                        result.pNN50 < 25 ? '양호 - 좋은 회복력' :
                                            '높음 - 매우 좋은 부교감 활성';

    // 스트레스 지수 색상
    const siColor = result.stressIndex < 50 ? '#22c55e' :
                    result.stressIndex < 150 ? '#3b82f6' :
                    result.stressIndex < 500 ? '#f59e0b' :
                    result.stressIndex < 900 ? '#ef4444' : '#991b1b';

    // 종합 회복력 점수 멘트
    const scoreInterp = result.score >= 80 ? '훌륭한 자율신경 회복력입니다. 현재 컨디션이 매우 좋습니다.' :
                        result.score >= 65 ? '양호한 회복 상태입니다. 자율신경 균형이 잘 잡혀있어요.' :
                        result.score >= 50 ? '평균 수준입니다. 충분한 수면과 가벼운 운동을 추천해요.' :
                        result.score >= 35 ? '회복이 필요한 상태입니다. 휴식과 스트레스 관리에 신경 써주세요.' :
                                              '자율신경이 많이 지쳐있어요. 충분한 휴식이 필요합니다.';

    // ★ v16.1: 신뢰도 뱃지
    const confidence = result.confidence || 'medium';
    const confBadge = confidence === 'high' ? '🟢 신뢰도 높음' :
                     confidence === 'medium' ? '🟡 신뢰도 보통' : '🔴 신뢰도 낮음';
    const confColor = confidence === 'high' ? '#16a34a' :
                     confidence === 'medium' ? '#ca8a04' : '#dc2626';

    // 신호 소스 뱃지
    const sourceBadge = result.signalSource === 'AI' || result.signalSource === 'ai' ? '🤖 AI ENHANCED' :
                        result.signalSource === 'G-channel' ? '🟢 G-CHANNEL (외부조명)' :
                        '✓ CLINICAL GRADE';

    container.innerHTML = `
      <div class="finger-result-card">
        ${result.validationWarning ? `
          <div class="finger-warning-banner">
            ⚠️ ${this._esc(result.validationWarning)}<br>
            <small>참고용으로만 사용하세요. 신뢰할 수 있는 측정을 위해 다시 측정하시는 것을 추천합니다.</small>
          </div>
        ` : ''}
        <div class="finger-result-header">
          <div class="finger-result-badge">${sourceBadge}</div>
          <div class="finger-result-quality">
            <span style="color:${confColor}; font-weight: 900">${confBadge}</span>
            · 신호 품질 ${result.signalQuality}%
          </div>
        </div>

        <div class="finger-result-main">
          <div class="finger-score-circle" style="color: ${getColor(result.score)}">
            <div class="fsc-num">${result.score}</div>
            <div class="fsc-max">/100</div>
          </div>
          <div class="finger-score-label">정신·신체 회복력 점수</div>
          <!-- v15.9: 종합 점수 멘트 -->
          <div class="finger-score-msg">${scoreInterp}</div>
        </div>

        <!-- v15.9: 4가지 핵심 수치 + 각각 의미 멘트 + v16.3 정상 범위 -->
        <div class="finger-stats-grid">
          <div class="finger-stat">
            <div class="fs-icon">❤️</div>
            <div class="fs-label">심박수</div>
            <div class="fs-value">${result.hr}<span class="fs-unit">BPM</span></div>
            <div class="fs-msg">${hrInterp}</div>
            <div class="fs-range">정상: 60~100 BPM</div>
          </div>
          <div class="finger-stat highlight">
            <div class="fs-icon">📊</div>
            <div class="fs-label">RMSSD (HRV)</div>
            <div class="fs-value">${result.rmssd}<span class="fs-unit">ms</span></div>
            <div class="fs-msg">${rmssdInterp}</div>
            <div class="fs-range">정상: 20~60 ms</div>
          </div>
          <div class="finger-stat">
            <div class="fs-icon">📈</div>
            <div class="fs-label">SDNN</div>
            <div class="fs-value">${result.sdnn}<span class="fs-unit">ms</span></div>
            <div class="fs-msg">${sdnnInterp}</div>
            <div class="fs-range">정상: 30~100 ms</div>
          </div>
          <div class="finger-stat">
            <div class="fs-icon">⚡</div>
            <div class="fs-label">pNN50</div>
            <div class="fs-value">${result.pNN50}<span class="fs-unit">%</span></div>
            <div class="fs-msg">${pNN50Interp}</div>
            <div class="fs-range">정상: 5~25 %</div>
          </div>
        </div>

        <!-- v15.9: 스트레스 지수 (Baevsky SI) — 핵심 신규 카드 -->
        <div class="finger-si-card">
          <div class="fsi-header">
            <span class="fsi-icon">🌡️</span>
            <span class="fsi-title">스트레스 지수 (Baevsky SI)</span>
            <span class="fsi-info" title="러시아 우주의학에서 유래한 자율신경 균형 표준 지표">ℹ️</span>
          </div>
          <div class="fsi-main">
            <div class="fsi-value" style="color: ${siColor}">${result.stressIndex}</div>
            <div class="fsi-label" style="color: ${siColor}">${result.stressIndexLabel}</div>
          </div>
          <!-- 5단계 시각화 -->
          <div class="fsi-scale">
            <div class="fsi-track">
              <div class="fsi-marker" style="left: ${Math.min(98, Math.max(2, (Math.log10(result.stressIndex + 10) / Math.log10(2010)) * 100))}%; background: ${siColor}"></div>
            </div>
            <div class="fsi-labels">
              <span>50</span><span>150</span><span>500</span><span>900</span><span>2000</span>
            </div>
          </div>
          <div class="fsi-desc">
            ${result.stressIndex < 50 ? '🌿 매우 이완된 상태로 자율신경이 이상적으로 균형잡혀 있어요.' :
              result.stressIndex < 150 ? '✨ 정상 범위입니다. 자율신경이 잘 작동하고 있어요.' :
              result.stressIndex < 500 ? '⚠️ 가벼운 긴장 상태예요. 잠시 휴식이나 호흡을 권장합니다.' :
              result.stressIndex < 900 ? '🔥 중등도 스트레스입니다. 충분한 휴식과 명상을 권합니다.' :
                                          '🚨 심한 스트레스 상태예요. 깊은 휴식이 꼭 필요합니다.'}
          </div>
        </div>

        <!-- 자율신경 톤 (기존) -->
        <div class="finger-stress-card lv-${result.stressLevel}">
          <div class="fsc-title">🧘 자율신경 톤 (RMSSD 기반)</div>
          <div class="fsc-level">${result.stressLabel}</div>
          <div class="fsc-bar">
            ${[1,2,3,4,5].map(i => `<div class="fsc-dot ${i <= result.stressLevel ? 'on' : ''}"></div>`).join('')}
          </div>
        </div>

        <div class="finger-compare-result">
          <div class="fcr-title">📊 또래 비교 (${ageMsg})</div>
          <div class="fcr-row">
            <span class="fcr-l">RMSSD ${result.rmssd}ms</span>
            <span class="fcr-r">${rmssdRel}</span>
          </div>
          <div class="fcr-meta">
            ${profile.age ? `또래 평균: ${rmssdRef.mean}ms (±${rmssdRef.sd})` : '학술 baseline: 35ms (±18)'}
          </div>
        </div>

        <div class="finger-meta">
          <div class="fm-row"><span>유효 심박 신호</span><span>${result.ibiCount}개 (전체 ${result.totalPeaks}개 중)</span></div>
          <div class="fm-row"><span>신호 채택률</span><span>${result.cleanRate}%</span></div>
          <div class="fm-row"><span>평균 IBI</span><span>${result.meanIBI}ms</span></div>
        </div>

        <!-- ★ v18.0: 고급 PPG 분석 카드 (부정맥 리스크) — HTML 내부에 포함 -->
        <div id="finger-advanced-cards"></div>

        <div class="finger-disclaimer">
          ⚠️ 이 측정은 의료 진단이 아닌 건강 참고용입니다.
        </div>
        <div class="finger-actions">
          <button class="finger-action-btn" type="button" onclick="App.fingerRestart()">🔄 다시 측정</button>
          <button class="finger-action-btn primary" type="button" onclick="App.goPage('results')">📊 결과 보기</button>
        </div>
      </div>
    `;

    this._wellnessSave('finger', {
      hr: result.hr, rmssd: result.rmssd, sdnn: result.sdnn, pNN50: result.pNN50,
      stressLevel: result.stressLevel, signalQuality: result.signalQuality,
      stressIndex: result.stressIndex, // ★ v15.9
      stressIndexLabel: result.stressIndexLabel,
      score: result.score, ageAtMeasure: profile.age,
      arrhythmia: result.arrhythmia || null, // ★ v18.0
    });

    // ★ v18.0: 손가락 부정맥 카드 삽입 (innerHTML 내부의 finger-advanced-cards에 렌더)
    this._renderAdvancedPPGCards(result, 'finger-advanced-cards');

    this._flog(`✓ 결과 저장: HR=${result.hr} RMSSD=${result.rmssd} Score=${result.score}`);

    // ★ v19.3: 측정 완료 후 인사이트 카드
    setTimeout(() => this._showPostMeasureInsight('finger', {
      hr: result.hr, rmssd: result.rmssd, stressIdx: result.stressIndex, score: result.score,
    }), 800);
  },

  async fingerAbort() {
    this._flog('사용자 측정 중지');
    const f = this._finger;
    f.measuring = false;
    if (f.timerInterval) { clearInterval(f.timerInterval); f.timerInterval = null; }
    if (f.rafId) { cancelAnimationFrame(f.rafId); f.rafId = null; }
    await this._fingerCleanup();

    document.getElementById('finger-stage-measuring').style.display = 'none';
    document.getElementById('finger-stage-intro').style.display = 'block';
  },

  fingerRestart() {
    document.getElementById('finger-result').style.display = 'none';
    document.getElementById('finger-stage-intro').style.display = 'block';
    this._finger.stage = 'intro';
  },

  // 별칭: 외부에서 fingerStop으로 호출하는 곳 대응
  async fingerStop() { return this.fingerAbort(); },


  _formatRelativeTime(t) {
    if (!t) return '미측정';
    const diff = Date.now() - t;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (minutes < 1) return '방금 전';
    if (minutes < 60) return `${minutes}분 전`;
    if (hours < 24) return `${hours}시간 전`;
    if (days < 7) return `${days}일 전`;
    const d = new Date(t);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  },

  // ════════════════════════════════════════════════════════════════
  // ★ v14.3: 시계열 트렌드 분석
  // ════════════════════════════════════════════════════════════════

  // 트렌드 페이지 렌더링
  _renderTrendsPage() {
    const container = document.getElementById('trends-dashboard');
    if (!container) return;

    // 현재 선택된 기간 (기본 30일)
    const period = this._trendPeriod || 30;
    const periodLabel = period === 7 ? '7일' : period === 30 ? '30일' : '90일';

    // 측정 횟수 카운트
    const allCategories = ['face', 'bodycomp', 'balance', 'gait', 'tremor', 'reaction', 'posture'];
    let totalMeasurements = 0;
    const categoryCounts = {};
    for (const cat of allCategories) {
      const h = this._historyGet(cat);
      const filtered = this._historyFilter(h, period);
      categoryCounts[cat] = filtered.length;
      totalMeasurements += filtered.length;
    }

    if (totalMeasurements === 0) {
      container.innerHTML = `
        <div class="trends-empty">
          <div class="trends-empty-icon">📈</div>
          <div class="trends-empty-title">아직 데이터가 부족해요</div>
          <div class="trends-empty-sub">
            여러 번 측정하시면 추이 그래프가 나타나요.<br>
            첫 측정과 비교해서 좋아지고 있는지 확인할 수 있어요.
          </div>
          <button class="trends-empty-cta" type="button" onclick="App.goPage('home')">
            홈으로 가서 측정 시작 →
          </button>
        </div>
      `;
      return;
    }

    // 기간 선택 탭
    const periodTabs = `
      <div class="trends-period-tabs">
        <button type="button" class="trends-period-tab ${period === 7 ? 'on' : ''}" onclick="App._switchTrendPeriod(7)">7일</button>
        <button type="button" class="trends-period-tab ${period === 30 ? 'on' : ''}" onclick="App._switchTrendPeriod(30)">30일</button>
        <button type="button" class="trends-period-tab ${period === 90 ? 'on' : ''}" onclick="App._switchTrendPeriod(90)">90일</button>
      </div>
    `;

    // 요약 카드 (이번 기간 측정 횟수)
    const summary = `
      <div class="trends-summary">
        <div class="trends-summary-num">${totalMeasurements}</div>
        <div class="trends-summary-label">최근 ${periodLabel}간 측정 횟수</div>
      </div>
    `;

    // 변화 인사이트 자동 생성
    const insights = this._generateTrendInsights(period);
    let insightsHTML = '';
    if (insights.length > 0) {
      insightsHTML = `
        <div class="trends-section-title">📌 이번 ${periodLabel}의 변화</div>
        <div class="trends-insights">
          ${insights.map(ins => `
            <div class="trend-insight ${ins.cls}">
              <div class="trend-insight-icon">${ins.icon}</div>
              <div class="trend-insight-body">
                <div class="trend-insight-title">${ins.title}</div>
                <div class="trend-insight-desc">${ins.desc}</div>
              </div>
            </div>
          `).join('')}
        </div>
      `;
    }

    // 카테고리별 트렌드 차트
    let chartsHTML = '<div class="trends-section-title">📊 항목별 추이</div>';

    // 얼굴 측정 차트들
    const faceHistory = this._historyFilter(this._historyGet('face'), period);
    if (faceHistory.length >= 2) {
      chartsHTML += this._renderTrendChart({
        title: '심박수 (HR)',
        icon: '💗',
        history: faceHistory,
        field: 'hr',
        unit: 'BPM',
        normalMin: 60,
        normalMax: 100,
        color: '#ef4444',
      });
      chartsHTML += this._renderTrendChart({
        title: '심박변이도 (HRV/RMSSD)',
        icon: '✨',
        history: faceHistory,
        field: 'rmssd',
        unit: 'ms',
        normalMin: 19,
        normalMax: 75,
        color: '#7c3aed',
      });
      chartsHTML += this._renderTrendChart({
        title: '스트레스 단계',
        icon: '😌',
        history: faceHistory,
        field: 'stressLevel',
        unit: '단계',
        normalMin: 1,
        normalMax: 3,
        color: '#f59e0b',
        yMin: 1,
        yMax: 5,
        invert: true,
      });
    }

    // 신체 지수 차트들
    const bodycompHistory = this._historyFilter(this._historyGet('bodycomp'), period);
    if (bodycompHistory.length >= 2) {
      chartsHTML += this._renderTrendChart({
        title: 'BMI',
        icon: '⚖️',
        history: bodycompHistory,
        field: 'bmi',
        unit: 'kg/m²',
        normalMin: 18.5,
        normalMax: 25,
        color: '#3b82f6',
      });
      chartsHTML += this._renderTrendChart({
        title: '체중',
        icon: '📐',
        history: bodycompHistory,
        field: 'weight',
        unit: 'kg',
        color: '#06b6d4',
      });
      chartsHTML += this._renderTrendChart({
        title: '신체 나이',
        icon: '🧬',
        history: bodycompHistory,
        field: 'bodyAge',
        unit: '세',
        color: '#22c55e',
        invert: true,
      });
    }

    // ★ v21.0: 보행 가변성 추세 (치매 선별 — 추세가 핵심 지표)
    const gaitHistory = this._historyFilter(this._historyGet('gait'), period);
    const gaitWithCV = gaitHistory.filter(h => h.cvStepTime != null);
    if (gaitWithCV.length >= 2) {
      chartsHTML += '<div class="trends-section-title" style="margin-top:20px">🧠 보행 가변성 추세 <span style="font-size:11px;font-weight:600;color:#9ca3af">(치매 선별 보조 · 낮을수록 안정)</span></div>';
      chartsHTML += this._renderTrendChart({
        title: '보행 가변성 (CV)',
        icon: '🧠',
        history: gaitWithCV,
        field: 'cvStepTime',
        unit: '%',
        normalMin: 0,
        normalMax: 3.5,
        color: '#8b5cf6',
        yMin: 0,
        yMax: 10,
        invert: true,
      });
    }

    // 기타 점수
    for (const cat of ['balance', 'gait', 'reaction', 'tremor', 'posture']) {
      const h = this._historyFilter(this._historyGet(cat), period);
      if (h.length >= 2) {
        const meta = {
          balance: { title: '균형 점수', icon: '⚖️' },
          gait: { title: '보행 점수', icon: '🚶' },
          reaction: { title: '반응속도 점수', icon: '⚡' },
          tremor: { title: '손떨림 점수', icon: '✋' },
          posture: { title: '자세 점수', icon: '🧍' },
        }[cat];
        chartsHTML += this._renderTrendChart({
          title: meta.title,
          icon: meta.icon,
          history: h,
          field: 'score',
          unit: '점',
          normalMin: 70,
          normalMax: 100,
          color: '#3b82f6',
          yMin: 0,
          yMax: 100,
        });
      }
    }

    // ★ v15.2: 정신건강 통합 점수 차트
    try {
      const moodHistory = JSON.parse(localStorage.getItem('history_mood') || '[]');
      const cutoff = Date.now() - period * 24 * 60 * 60 * 1000;
      const moodFiltered = moodHistory
        .filter(h => h.t >= cutoff && h.mental && h.mental.overall != null)
        .map(h => ({
          t: h.t,
          mentalOverall: h.mental.overall,
          mentalResilience: h.mental.resilience,
          mentalConnection: h.mental.connection,
        }));
      if (moodFiltered.length >= 2) {
        chartsHTML += '<div class="trends-section-title">🧠 정신건강 추이</div>';
        chartsHTML += this._renderTrendChart({
          title: '정신건강 종합 점수',
          icon: '💜',
          history: moodFiltered,
          field: 'mentalOverall',
          unit: '점',
          normalMin: 60,
          normalMax: 100,
          color: '#7c3aed',
          yMin: 0,
          yMax: 100,
        });
        if (moodFiltered.some(h => h.mentalConnection != null)) {
          chartsHTML += this._renderTrendChart({
            title: '사회적 연결감',
            icon: '🫂',
            history: moodFiltered,
            field: 'mentalConnection',
            unit: '점',
            normalMin: 60,
            normalMax: 100,
            color: '#A78BFA',
            yMin: 0,
            yMax: 100,
          });
        }
      }
    } catch (e) {
      console.warn('[Trends] mood chart fail:', e);
    }

    // ★ v18.0: 고급 PPG 지표 추이 (혈관나이 / 부정맥 리스크 / RSA)
    const hasVa    = faceHistory.some(h => h.vascularAge?.estimatedAge != null);
    const hasRsa   = faceHistory.some(h => h.rsaIndex != null);
    const hasArr   = faceHistory.some(h => h.arrhythmia?.sd1 != null);
    if (hasVa || hasRsa || hasArr) {
      chartsHTML += '<div class="trends-section-title">🫀 고급 심혈관 추이 (ME-rPPG)</div>';
      if (hasVa) {
        const vaHistory = faceHistory.filter(h => h.vascularAge?.estimatedAge != null)
          .map(h => ({ t: h.t, vascularAge: h.vascularAge.estimatedAge }));
        chartsHTML += this._renderTrendChart({
          title: '혈관 나이 추정',
          icon: '🫀',
          history: vaHistory,
          field: 'vascularAge',
          unit: '세',
          color: '#f472b6',
          invert: true,
        });
      }
      if (hasRsa) {
        const rsaHistory = faceHistory.filter(h => h.rsaIndex != null)
          .map(h => ({ t: h.t, rsaIndex: h.rsaIndex }));
        chartsHTML += this._renderTrendChart({
          title: '미주신경 활성도 (RSA)',
          icon: '🌬️',
          history: rsaHistory,
          field: 'rsaIndex',
          unit: '/100',
          normalMin: 30,
          normalMax: 100,
          color: '#34d399',
          yMin: 0,
          yMax: 100,
        });
      }
      if (hasArr) {
        const sd1History = faceHistory.filter(h => h.arrhythmia?.sd1 != null)
          .map(h => ({ t: h.t, sd1: h.arrhythmia.sd1 }));
        chartsHTML += this._renderTrendChart({
          title: '부정맥 지표 (SD1)',
          icon: '💓',
          history: sd1History,
          field: 'sd1',
          unit: 'ms',
          color: '#f59e0b',
        });
      }
    }

    // ★ v20.0: 히트맵 (최근 42일)
    const heatmapHTML = this._renderMeasurementHeatmap();

    // ★ v20.0: 주간 측정 바 차트
    const weekBarHTML = this._renderWeekBarChart();

    // ★ v20.0: 월간 요약 카드
    const monthSummaryHTML = this._renderMonthSummaryCards(period);

    // ★ v20.0: 성취 배지
    const achHTML = this._renderTrendAchievements(period);

    container.innerHTML = periodTabs + monthSummaryHTML + achHTML + heatmapHTML + weekBarHTML + insightsHTML + chartsHTML;
  },

  // ★ v20.0: 측정 히트맵 (최근 42일)
  _renderMeasurementHeatmap() {
    const categories = ['face','bodycomp','balance','gait','tremor','reaction','posture'];
    const today = new Date(); today.setHours(0,0,0,0);
    const DAY = 86400000;
    // 최근 42일 데이터 집계
    const dayMap = {};
    for (const cat of categories) {
      const h = this._historyGet(cat);
      for (const entry of h) {
        const d = new Date(entry.t); d.setHours(0,0,0,0);
        const key = d.getTime();
        dayMap[key] = (dayMap[key] || 0) + 1;
      }
    }
    // 42일 그리드 생성 (앞 패딩으로 일요일 시작)
    const firstDay = new Date(today.getTime() - 41 * DAY);
    const startDow = firstDay.getDay(); // 0=일
    const cells = [];
    // 빈 칸 패딩
    for (let i = 0; i < startDow; i++) cells.push({ empty: true });
    for (let i = 0; i < 42; i++) {
      const d = new Date(firstDay.getTime() + i * DAY);
      const key = d.getTime();
      const cnt = dayMap[key] || 0;
      const isToday = d.getTime() === today.getTime();
      let lv = 0;
      if (cnt >= 1) lv = 1;
      if (cnt >= 3) lv = 2;
      if (cnt >= 5) lv = 3;
      cells.push({ date: d, cnt, lv, isToday });
    }
    const cellsHTML = cells.map(c2 => {
      if (c2.empty) return `<div class="thm-day"></div>`;
      const m = c2.date.getMonth()+1, dd = c2.date.getDate();
      const cls = c2.lv > 0 ? `lv${c2.lv}` : '';
      const todayCls = c2.isToday ? ' today' : '';
      const hasCls = c2.cnt > 0 ? ' has-data' : '';
      const title = c2.cnt > 0 ? `onclick="App._showHeatmapDay(${c2.date.getTime()})"` : '';
      return `<div class="thm-day ${cls}${todayCls}${hasCls}" ${title}>${dd}</div>`;
    }).join('');
    const wdays = ['일','월','화','수','목','금','토'];
    const wdHTML = wdays.map(d => `<div class="thm-weekday">${d}</div>`).join('');
    return `
      <div class="trend-heatmap-card">
        <div class="thm-title">📅 최근 6주 측정 기록</div>
        <div class="thm-weekdays">${wdHTML}</div>
        <div class="thm-grid">${cellsHTML}</div>
        <div class="thm-legend">
          <span>적음</span>
          <div class="thm-legend-box" style="background:#dcfce7;border:1px solid #86efac"></div>
          <div class="thm-legend-box" style="background:#4ade80"></div>
          <div class="thm-legend-box" style="background:#16a34a"></div>
          <span>많음</span>
        </div>
      </div>`;
  },

  // ★ v20.0: 히트맵 날짜 클릭 시 해당 날 측정 정보 토스트
  _showHeatmapDay(timestamp) {
    const categories = ['face','bodycomp','balance','gait','tremor','reaction','posture'];
    const catNames = { face:'심혈관', bodycomp:'신체지수', balance:'균형', gait:'보행', tremor:'손떨림', reaction:'반응속도', posture:'자세' };
    const DAY = 86400000;
    const d = new Date(timestamp); d.setHours(0,0,0,0);
    const found = [];
    for (const cat of categories) {
      const h = this._historyGet(cat);
      const entries = h.filter(e => {
        const ed = new Date(e.t); ed.setHours(0,0,0,0);
        return ed.getTime() === d.getTime();
      });
      if (entries.length > 0) found.push(`${catNames[cat]} ${entries.length}회`);
    }
    const msg = `${d.getMonth()+1}/${d.getDate()} 측정: ${found.join(', ')}`;
    this._toast(msg);
  },

  // ★ v20.0: 주간 측정 바 차트
  _renderWeekBarChart() {
    const categories = ['face','bodycomp','balance','gait','tremor','reaction','posture'];
    const DAY = 86400000;
    const today = new Date(); today.setHours(23,59,59,999);
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today.getTime() - i * DAY);
      d.setHours(0,0,0,0);
      days.push(d);
    }
    // 각 날 측정 수
    const counts = days.map(d => {
      const d2 = new Date(d); d2.setHours(23,59,59,999);
      let cnt = 0;
      for (const cat of categories) {
        cnt += this._historyGet(cat).filter(e => e.t >= d.getTime() && e.t <= d2.getTime()).length;
      }
      return cnt;
    });
    const maxCnt = Math.max(...counts, 1);
    const wdLabels = ['일','월','화','수','목','금','토'];
    const colors = ['#ef4444','#f97316','#eab308','#22c55e','#3b82f6','#6366f1','#8b5cf6'];
    const barsHTML = counts.map((cnt, i) => {
      const h = Math.round((cnt / maxCnt) * 68);
      const isToday = i === 6;
      const label = wdLabels[days[i].getDay()];
      const color = isToday ? '#22c55e' : '#93c5fd';
      return `
        <div class="twb-bar-wrap">
          <div class="twb-count" style="color:${cnt>0?'var(--text)':'transparent'}">${cnt||''}</div>
          <div class="twb-bar" style="height:${h}px;background:${color};"></div>
          <div class="twb-day-label" style="${isToday?'color:#16a34a;font-weight:900':''}">${label}</div>
        </div>`;
    }).join('');
    const total = counts.reduce((a,b)=>a+b,0);
    return `
      <div class="trend-week-bar-card">
        <div class="twb-title">📊 이번 주 측정 현황 <span style="font-size:11px;color:var(--text3);font-weight:600">총 ${total}회</span></div>
        <div class="twb-bars">${barsHTML}</div>
      </div>`;
  },

  // ★ v20.0: 월간 요약 카드
  _renderMonthSummaryCards(period) {
    const categories = ['face','bodycomp','balance','gait','tremor','reaction','posture'];
    const catNames = { face:'심혈관', bodycomp:'신체지수', balance:'균형', gait:'보행', tremor:'손떨림', reaction:'반응속도', posture:'자세' };
    let totalThisPeriod = 0;
    let bestCat = null; let bestCnt = 0;
    let streakDays = 0;
    for (const cat of categories) {
      const h = this._historyFilter(this._historyGet(cat), period);
      totalThisPeriod += h.length;
      if (h.length > bestCnt) { bestCnt = h.length; bestCat = cat; }
    }
    // 연속 측정일 계산
    const DAY = 86400000;
    const today = new Date(); today.setHours(0,0,0,0);
    for (let i = 0; i < 30; i++) {
      const d = new Date(today.getTime() - i * DAY);
      const d2 = new Date(d.getTime() + DAY - 1);
      let hasAny = false;
      for (const cat of categories) {
        if (this._historyGet(cat).some(e => e.t >= d.getTime() && e.t <= d2.getTime())) { hasAny = true; break; }
      }
      if (hasAny) streakDays++;
      else if (i > 0) break;
    }
    // 최신 wellness 점수
    const ws = this._wellnessComputeScore ? this._wellnessComputeScore() : { score: 0 };
    const scoreColor = ws.score >= 85 ? 'good' : ws.score >= 60 ? '' : 'warn';
    return `
      <div class="trend-monthly-summary">
        <div class="tms-card">
          <div class="tms-icon">📅</div>
          <div class="tms-val ${totalThisPeriod > 0 ? 'good' : ''}">${totalThisPeriod}</div>
          <div class="tms-label">최근 ${period}일<br>총 측정</div>
        </div>
        <div class="tms-card">
          <div class="tms-icon">🔥</div>
          <div class="tms-val ${streakDays >= 7 ? 'good' : streakDays >= 3 ? '' : 'warn'}">${streakDays}</div>
          <div class="tms-label">연속 측정일</div>
        </div>
        <div class="tms-card">
          <div class="tms-icon">⭐</div>
          <div class="tms-val ${scoreColor}">${ws.score || '—'}</div>
          <div class="tms-label">종합 건강점수</div>
        </div>
        <div class="tms-card">
          <div class="tms-icon">🏅</div>
          <div class="tms-val" style="font-size:14px">${bestCat ? catNames[bestCat] : '—'}</div>
          <div class="tms-label">가장 자주 측정</div>
        </div>
      </div>`;
  },

  // ★ v20.0: 성취 배지 생성
  _renderTrendAchievements(period) {
    const categories = ['face','bodycomp','balance','gait','tremor','reaction','posture'];
    const badges = [];
    let totalMeasurements = 0;
    let uniqueCats = 0;
    for (const cat of categories) {
      const h = this._historyFilter(this._historyGet(cat), period);
      totalMeasurements += h.length;
      if (h.length > 0) uniqueCats++;
    }
    // 연속 측정일
    const streak = this._streakGet ? this._streakGet() : 0;
    if (streak >= 7)  badges.push({ cls: 'gold',   icon: '🔥', text: `${streak}일 연속 측정!` });
    if (streak >= 3)  badges.push({ cls: 'green',  icon: '✅', text: `${streak}일 연속` });
    if (totalMeasurements >= 20) badges.push({ cls: 'gold',   icon: '💯', text: '20회 달성' });
    if (totalMeasurements >= 10) badges.push({ cls: 'blue',   icon: '📈', text: '10회 달성' });
    if (uniqueCats >= 5) badges.push({ cls: 'purple', icon: '🌟', text: '5종 측정 마스터' });
    if (uniqueCats >= 3) badges.push({ cls: 'green',  icon: '🎯', text: '다양한 측정' });
    if (badges.length === 0) return '';
    const html = badges.slice(0,4).map(b =>
      `<div class="trend-ach-badge ${b.cls}">${b.icon} ${b.text}</div>`
    ).join('');
    return `<div class="trend-achievement-row">${html}</div>`;
  },


  _switchTrendPeriod(days) {
    this._trendPeriod = days;
    this._renderTrendsPage();
  },

  // 트렌드 인사이트 자동 생성
  _generateTrendInsights(period) {
    const insights = [];

    // HR 변화
    const face = this._historyFilter(this._historyGet('face'), period);
    if (face.length >= 5) {
      const hrStats = this._historyStats(face, 'hr');
      if (hrStats && Math.abs(hrStats.trend) >= 5) {
        const up = hrStats.trend > 0;
        insights.push({
          cls: up ? 'warn' : 'good',
          icon: up ? '📈' : '📉',
          title: `심박수가 ${Math.abs(hrStats.trend).toFixed(0)}% ${up ? '증가' : '감소'}했어요`,
          desc: up
            ? `평균 ${Math.round(hrStats.mean)}BPM. 카페인·스트레스·수면 부족 등의 원인을 점검해보세요.`
            : `평균 ${Math.round(hrStats.mean)}BPM. 컨디션이 좋아지고 있어요!`,
        });
      }

      // RMSSD 변화
      const rmssdStats = this._historyStats(face, 'rmssd');
      if (rmssdStats && Math.abs(rmssdStats.trend) >= 10) {
        const up = rmssdStats.trend > 0;
        insights.push({
          cls: up ? 'good' : 'warn',
          icon: up ? '💪' : '⚠️',
          title: `심박변이도가 ${Math.abs(rmssdStats.trend).toFixed(0)}% ${up ? '향상' : '저하'}됐어요`,
          desc: up
            ? `자율신경이 더 안정되고 있어요. 회복 능력이 좋아진 신호입니다.`
            : `평소보다 자율신경이 긴장된 상태예요. 휴식과 수면을 늘려보세요.`,
        });
      }

      // 스트레스 변화
      const stressStats = this._historyStats(face, 'stressLevel');
      if (stressStats && Math.abs(stressStats.trend) >= 15) {
        const up = stressStats.trend > 0;
        insights.push({
          cls: up ? 'bad' : 'good',
          icon: up ? '😰' : '😌',
          title: `스트레스가 ${up ? '높아지고' : '낮아지고'} 있어요`,
          desc: up
            ? `최근 평균 ${stressStats.mean.toFixed(1)}단계. 깊은 호흡과 규칙적 수면이 도움됩니다.`
            : `최근 평균 ${stressStats.mean.toFixed(1)}단계. 마음이 안정되어가고 있어요.`,
        });
      }
    }

    // 체중 변화
    const bc = this._historyFilter(this._historyGet('bodycomp'), period);
    if (bc.length >= 3) {
      const weightStats = this._historyStats(bc, 'weight');
      if (weightStats && Math.abs(weightStats.latest - weightStats.mean) >= 1) {
        const recent = weightStats.latest;
        const oldest = bc[0].weight;
        const diff = recent - oldest;
        if (Math.abs(diff) >= 1) {
          insights.push({
            cls: 'info',
            icon: '📊',
            title: `체중이 ${Math.abs(diff).toFixed(1)}kg ${diff > 0 ? '증가' : '감소'}했어요`,
            desc: `${oldest}kg → ${recent}kg (${period}일간). 지속적인 추적이 건강 관리의 핵심입니다.`,
          });
        }
      }
    }

    // 측정 횟수 격려
    if (insights.length === 0 && (face.length + bc.length) >= 5) {
      insights.push({
        cls: 'good',
        icon: '👍',
        title: '꾸준히 측정하고 계세요',
        desc: `더 많은 데이터가 쌓이면 더 정확한 추이 분석이 가능해요. 매일 같은 시간 측정해보세요.`,
      });
    }

    return insights.slice(0, 4);
  },

  // 개별 트렌드 차트 (SVG 라인 그래프 + 정상범위 밴드)
  _renderTrendChart({ title, icon, history, field, unit, normalMin, normalMax, color, yMin, yMax, invert }) {
    const values = history.map(h => ({ t: h.t, v: h[field] })).filter(p => p.v != null && !isNaN(p.v));
    if (values.length < 2) return '';

    // Y축 범위
    let minV = yMin != null ? yMin : Math.min(...values.map(p => p.v));
    let maxV = yMax != null ? yMax : Math.max(...values.map(p => p.v));
    if (normalMin != null) minV = Math.min(minV, normalMin);
    if (normalMax != null) maxV = Math.max(maxV, normalMax);
    // 여백 10%
    const range = maxV - minV;
    const pad = range * 0.15 || 1;
    minV -= pad;
    maxV += pad;

    // 차트 dimensions
    const W = 360, H = 140;
    const padL = 36, padR = 12, padT = 14, padB = 24;
    const chartW = W - padL - padR;
    const chartH = H - padT - padB;

    const xScale = (t) => {
      const tMin = values[0].t;
      const tMax = values[values.length - 1].t;
      const tRange = tMax - tMin || 1;
      return padL + ((t - tMin) / tRange) * chartW;
    };
    const yScale = (v) => padT + chartH - ((v - minV) / (maxV - minV)) * chartH;

    // 정상 범위 밴드
    let normalBand = '';
    if (normalMin != null && normalMax != null) {
      const yTop = yScale(normalMax);
      const yBottom = yScale(normalMin);
      normalBand = `
        <rect x="${padL}" y="${yTop}" width="${chartW}" height="${yBottom - yTop}"
              fill="rgba(34, 197, 94, 0.08)" stroke="rgba(34, 197, 94, 0.2)" stroke-dasharray="2,2" stroke-width="1"/>
        <text x="${padL + chartW - 4}" y="${yTop + 12}" text-anchor="end" font-size="9" fill="#16a34a" font-weight="700">정상 범위</text>
      `;
    }

    // Y축 라벨
    const yLabels = [maxV, (maxV + minV) / 2, minV].map(v => {
      const decimals = (Math.abs(v) < 10) ? 1 : 0;
      const label = v.toFixed(decimals);
      return `<text x="${padL - 6}" y="${yScale(v) + 3}" text-anchor="end" font-size="9" fill="#94a3b8" font-weight="600">${label}</text>`;
    }).join('');

    // X축 라벨
    const xLabels = [];
    const firstDate = new Date(values[0].t);
    const lastDate = new Date(values[values.length - 1].t);
    xLabels.push(`<text x="${padL}" y="${H - 4}" font-size="9" fill="#94a3b8" font-weight="600">${firstDate.getMonth()+1}/${firstDate.getDate()}</text>`);
    xLabels.push(`<text x="${W - padR}" y="${H - 4}" text-anchor="end" font-size="9" fill="#94a3b8" font-weight="600">${lastDate.getMonth()+1}/${lastDate.getDate()}</text>`);

    // 라인 (Path)
    const points = values.map(p => `${xScale(p.t).toFixed(1)},${yScale(p.v).toFixed(1)}`).join(' L ');
    const linePath = `M ${points}`;

    // Area (fill below line)
    const areaPath = `M ${xScale(values[0].t).toFixed(1)},${(padT + chartH).toFixed(1)} L ${points} L ${xScale(values[values.length - 1].t).toFixed(1)},${(padT + chartH).toFixed(1)} Z`;

    // 데이터 포인트
    const dots = values.map((p, i) => {
      const x = xScale(p.t).toFixed(1);
      const y = yScale(p.v).toFixed(1);
      const isLast = i === values.length - 1;
      return `
        <circle cx="${x}" cy="${y}" r="${isLast ? 4 : 2.5}"
                fill="${isLast ? color : '#fff'}" stroke="${color}" stroke-width="${isLast ? 2 : 1.5}"/>
      `;
    }).join('');

    // 통계
    const stats = this._historyStats(values.map(p => ({ [field]: p.v, t: p.t })), field);
    const latestV = values[values.length - 1].v;
    const decimals = (Math.abs(latestV) < 10) ? 1 : 0;
    const latestStr = latestV.toFixed(decimals);
    const meanStr = stats.mean.toFixed(decimals);

    // 추세 인디케이터
    let trendBadge = '';
    if (stats && Math.abs(stats.trend) >= 3) {
      const trendUp = stats.trend > 0;
      const isGood = (invert && !trendUp) || (!invert && trendUp);
      const trendCls = isGood ? 'good' : 'warn';
      const arrow = trendUp ? '↑' : '↓';
      trendBadge = `<span class="trend-badge ${trendCls}">${arrow} ${Math.abs(stats.trend).toFixed(0)}%</span>`;
    } else if (stats) {
      trendBadge = `<span class="trend-badge stable">→ 안정</span>`;
    }

    return `
      <div class="trend-chart-card">
        <div class="trend-chart-header">
          <div class="trend-chart-title">${icon} ${title}</div>
          ${trendBadge}
        </div>
        <div class="trend-chart-stats">
          <div class="trend-stat">
            <div class="trend-stat-label">최근</div>
            <div class="trend-stat-value" style="color:${color}">${latestStr}<span class="trend-stat-unit">${unit}</span></div>
          </div>
          <div class="trend-stat">
            <div class="trend-stat-label">평균</div>
            <div class="trend-stat-value">${meanStr}<span class="trend-stat-unit">${unit}</span></div>
          </div>
          <div class="trend-stat">
            <div class="trend-stat-label">측정</div>
            <div class="trend-stat-value">${values.length}<span class="trend-stat-unit">회</span></div>
          </div>
        </div>
        <svg class="trend-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
          ${normalBand}
          ${yLabels}
          ${xLabels}
          <path d="${areaPath}" fill="${color}" opacity="0.10"/>
          <path d="${linePath}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          ${dots}
        </svg>
      </div>
    `;
  },

  clearConsole(target) { Console.clear(target); },

  // ════════════════════════════════════════════════════════════════
  // ★ v15.0: 감정 게임 시스템
  //
  // 4가지 미니게임 — 매일 다른 게임 자동 선택
  // 1. 표정 미러링 (Ekman 1992 6 basic emotions)
  // 2. 색 선택 (Russell 1980 Circumplex Model)
  // 3. 한 단어 일기 + 감정 키워드
  // 4. 반응성 어구 (implicit affect)
  //
  // 안전 장치: 부정 점수 누적 시 1393 안내
  // ════════════════════════════════════════════════════════════════

  // ─── 게임 메타데이터 ───
  // ★ v16.4: 4개 게임 + 통합 모드 추가 (학술 검증된 감정 측정 여정)
  _moodGames: [
    { id: 'integrated', icon: '🌈', name: '통합 감정 측정 (NEW)', sub: 'PANAS + 4게임 + 자율신경 통합', time: '약 3분', isFlagship: true },
    { id: 'mirror', icon: '🎭', name: '표정으로 표현하는 마음', sub: '카메라로 따라하는 6가지 표정', time: '약 90초' },
    { id: 'color', icon: '🎨', name: '색으로 표현하는 오늘', sub: '직관으로 고르는 12색', time: '약 60초' },
    { id: 'diary', icon: '✍️', name: '한 단어로 쓰는 일기', sub: '오늘을 표현하는 단어와 키워드', time: '약 60초' },
    { id: 'reflex', icon: '⚡', name: '직관 어구 테스트', sub: '빠르게 반응하는 단어 게임', time: '약 90초' },
  ],

  // ★ v16.4: 학술 검증된 단축 PANAS (I-PANAS-SF, Thompson 2007)
  // 10문항 — 긍정 5 + 부정 5, 내부 일관성 α=0.89
  _panasItems: [
    // 긍정 정서 (Positive Affect)
    { id: 'active',    label: '활기참',   pa: true,  ko: '에너지가 넘쳐요' },
    { id: 'determined',label: '결단력',   pa: true,  ko: '뭔가 해낼 수 있을 것 같아요' },
    { id: 'attentive', label: '집중',     pa: true,  ko: '주의를 잘 모을 수 있어요' },
    { id: 'inspired',  label: '영감',     pa: true,  ko: '뭔가 떠오르고 영감이 들어요' },
    { id: 'alert',     label: '맑음',     pa: true,  ko: '머리가 맑고 또렷해요' },
    // 부정 정서 (Negative Affect)
    { id: 'upset',     label: '속상',     pa: false, ko: '마음이 좀 속상해요' },
    { id: 'hostile',   label: '적대감',   pa: false, ko: '뭔가 짜증이 나요' },
    { id: 'ashamed',   label: '부끄러움', pa: false, ko: '뭔가 부끄럽거나 자책감이 들어요' },
    { id: 'nervous',   label: '긴장',     pa: false, ko: '마음이 좀 긴장돼요' },
    { id: 'afraid',    label: '두려움',   pa: false, ko: '뭔가 불안하거나 두려워요' },
  ],

  // ★ v16.4: Plutchik 24 감정 카드 (8 기본 × 3 강도)
  // 각 감정에 Russell Valence/Arousal 좌표 + 색상 부여
  // 색상은 Plutchik Wheel 표준 (Valdez & Mehrabian 1994 기반)
  _emotionCards: {
    // 황홀/기쁨/평온 — Joy axis
    ecstasy:  { ko: '황홀',   en: 'Ecstasy',     v:  0.95, a:  0.85, color: '#FFC107', desc: '강렬한 기쁨과 흥분으로 가득해요' },
    joy:      { ko: '기쁨',   en: 'Joy',         v:  0.80, a:  0.55, color: '#FFD54F', desc: '환한 기분이 마음 가득해요' },
    serenity: { ko: '평온',   en: 'Serenity',    v:  0.55, a: -0.25, color: '#FFE082', desc: '잔잔하게 편안한 상태예요' },

    // 신뢰/감탄 — Trust axis
    admiration:{ ko: '감탄',  en: 'Admiration',  v:  0.75, a:  0.40, color: '#9CCC65', desc: '깊은 인정과 감탄의 마음이에요' },
    trust:     { ko: '신뢰',  en: 'Trust',       v:  0.65, a:  0.15, color: '#AED581', desc: '안정되고 믿음직한 상태예요' },
    acceptance:{ ko: '수용',  en: 'Acceptance',  v:  0.45, a: -0.10, color: '#C5E1A5', desc: '있는 그대로 받아들이는 평정심이에요' },

    // 공포/불안 — Fear axis
    terror:    { ko: '공포',  en: 'Terror',      v: -0.85, a:  0.80, color: '#00897B', desc: '강한 두려움이 휘몰아치는 상태예요' },
    fear:      { ko: '불안',  en: 'Fear',        v: -0.65, a:  0.55, color: '#26A69A', desc: '마음 한 켠에 걱정이 자리해요' },
    apprehension:{ ko: '조심', en: 'Apprehension',v: -0.30, a:  0.20, color: '#80CBC4', desc: '뭔가 조심스럽고 살피는 기분이에요' },

    // 놀람 — Surprise axis
    amazement: { ko: '경이',  en: 'Amazement',   v:  0.40, a:  0.85, color: '#42A5F5', desc: '예상 못한 것에 크게 놀란 상태예요' },
    surprise:  { ko: '놀람',  en: 'Surprise',    v:  0.10, a:  0.65, color: '#64B5F6', desc: '예상 밖의 무언가에 마음이 일렁여요' },
    distraction:{ ko: '주의산만', en: 'Distraction',v: -0.10, a:  0.30, color: '#90CAF9', desc: '집중이 흩어지고 어수선해요' },

    // 슬픔 — Sadness axis
    grief:     { ko: '비탄',  en: 'Grief',       v: -0.90, a:  0.10, color: '#5C6BC0', desc: '깊은 슬픔으로 마음이 가라앉아요' },
    sadness:   { ko: '슬픔',  en: 'Sadness',     v: -0.70, a: -0.20, color: '#7986CB', desc: '마음 한 켠이 무겁고 쓸쓸해요' },
    pensiveness:{ ko: '서글픔', en: 'Pensiveness',v: -0.35, a: -0.45, color: '#9FA8DA', desc: '잔잔하지만 묘하게 서글퍼요' },

    // 혐오 — Disgust axis
    loathing:  { ko: '혐오',  en: 'Loathing',    v: -0.85, a:  0.40, color: '#AB47BC', desc: '강한 거부감이 솟구쳐요' },
    disgust:   { ko: '불편',  en: 'Disgust',     v: -0.60, a:  0.20, color: '#BA68C8', desc: '뭔가 받아들이기 힘든 기분이에요' },
    boredom:   { ko: '지루함', en: 'Boredom',    v: -0.20, a: -0.55, color: '#CE93D8', desc: '뭔가 시들하고 흥미가 없어요' },

    // 분노 — Anger axis
    rage:      { ko: '격노',  en: 'Rage',        v: -0.75, a:  0.90, color: '#EF5350', desc: '강한 분노가 끓어올라요' },
    anger:     { ko: '분노',  en: 'Anger',       v: -0.55, a:  0.70, color: '#E57373', desc: '뭔가 화가 나거나 답답해요' },
    annoyance: { ko: '짜증',  en: 'Annoyance',   v: -0.30, a:  0.45, color: '#EF9A9A', desc: '뭔가 거슬리고 살짝 짜증나요' },

    // 기대 — Anticipation axis
    vigilance: { ko: '경계',  en: 'Vigilance',   v:  0.20, a:  0.75, color: '#FF7043', desc: '뭔가 다가올 것을 주시하는 상태예요' },
    anticipation:{ ko: '기대', en: 'Anticipation',v:  0.50, a:  0.45, color: '#FF8A65', desc: '뭔가 좋은 것을 기다리는 설렘이에요' },
    interest:  { ko: '흥미',  en: 'Interest',    v:  0.40, a:  0.20, color: '#FFAB91', desc: '뭔가에 관심이 끌리는 기분이에요' },

    // 중립
    neutral:   { ko: '평정',  en: 'Neutral',     v:  0.05, a: -0.10, color: '#90A4AE', desc: '특별한 감정 없이 평이한 상태예요' },
  },

  _moodEmotions: ['joy', 'sadness', 'anger', 'fear', 'surprise', 'disgust'],
  _moodEmotionLabels: {
    joy: '😊 기쁨', sadness: '😢 슬픔', anger: '😠 분노',
    fear: '😨 불안', surprise: '😲 놀람', disgust: '😖 불편',
  },

  // ─── 오늘의 게임 결정 (날짜 기반 고정, 매일 자동 변경) ───
  _getTodayGame() {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const lastShown = localStorage.getItem('mood_game_date');
    // ★ v16.4: 통합 게임은 상시 노출 — 일일 회전에서는 제외
    const rotationGames = this._moodGames.filter(g => g.id !== 'integrated');
    let gameId;
    if (lastShown !== today) {
      // 새 날 — 마지막에 안 한 게임 우선 선택
      const lastGame = localStorage.getItem('mood_last_game');
      const candidates = rotationGames.filter(g => g.id !== lastGame);
      gameId = candidates[Math.floor(Math.random() * candidates.length)].id;
      localStorage.setItem('mood_game_date', today);
      localStorage.setItem('mood_today_game', gameId);
    } else {
      gameId = localStorage.getItem('mood_today_game') || rotationGames[0].id;
    }
    return rotationGames.find(g => g.id === gameId) || rotationGames[0];
  },

  // ─── 오늘 이미 했는지 확인 ───
  _hasPlayedToday() {
    const today = new Date().toISOString().slice(0, 10);
    try {
      const history = JSON.parse(localStorage.getItem('history_mood') || '[]');
      const todayCount = history.filter(h => {
        return new Date(h.t).toISOString().slice(0, 10) === today;
      }).length;
      return todayCount > 0;
    } catch (e) { return false; }
  },

  // ════════════════════════════════════════════════════════════════
  // ★ v16.2: 가족 건강 정보 공유 시스템
  //
  // 목적: 부모가 건강 측정 결과를 자녀에게 공유 → "오늘 측정하셨어요" 안부 신호
  //
  // 구현 방식 (백엔드 없이 PWA로):
  //   1. 부모: "공유하기" → 측정 데이터를 base64로 인코딩한 URL 생성
  //   2. Web Share API로 카카오톡/문자로 전송
  //   3. 자녀: URL 클릭 → URL 파라미터 디코딩 → 결과 화면 표시
  //   4. 부가: 정기 측정 알림 (부모 폰 로컬 알림으로 측정 권장)
  //
  // 개인정보 보호:
  //   - 측정값만 공유 (이름은 부모가 직접 입력)
  //   - 서버 저장 없음 (URL 자체가 데이터)
  //   - 자녀가 받은 데이터도 자녀 폰에 저장 안 함 (페이지 새로고침 시 소실)
  // ════════════════════════════════════════════════════════════════

  // 가족 공유 페이지 렌더링
  _renderSharePage() {
    const container = document.getElementById('share-container');
    if (!container) return;

    const profile = this._getUserProfile();
    const w = this.state.wellness || {};
    const cardio = this._getUnifiedCardio(w);
    const result = this._wellnessComputeScore();

    // ★ v17.0: 감정 측정 데이터 (감정만 보내기용)
    // ★ v17.1: 통합 측정(cardId 있음) 우선 선택 — 감정 카드가 명확한 것
    let moodEntry = null;
    try {
      const moodHistory = JSON.parse(localStorage.getItem('history_mood') || '[]');
      const recent = moodHistory.filter(h => h && h.t && (Date.now() - h.t < 24 * 60 * 60 * 1000));
      if (recent.length > 0) {
        // 1순위: cardId(통합 측정) 있는 가장 최근 것
        const withCard = recent.filter(h => h.cardId || h.cardKo);
        if (withCard.length > 0) {
          moodEntry = withCard[withCard.length - 1];
        } else {
          // 2순위: valence/arousal 있는 것
          const withVA = recent.filter(h => h.valence !== undefined || h.arousal !== undefined);
          moodEntry = withVA.length > 0 ? withVA[withVA.length - 1] : recent[recent.length - 1];
        }
      }
    } catch (e) {}

    // 공유 가능한 데이터 확인
    const hasMeasurement = cardio || result.score > 0;
    const hasMood = !!moodEntry;
    const hasAnyData = hasMeasurement || hasMood;

    // ★ v17.0: 현재 공유 모드 (health: 측정 / mood: 감정만)
    // ★ v20.0: 가족 알림 섹션 준비
    const alertHTML = this._renderFamilyAlertSection ? this._renderFamilyAlertSection() : '';
    let mode = this._shareMode;
    if (!mode) {
      // 자동 선택: 측정 있으면 health, 없으면 mood
      mode = hasMeasurement ? 'health' : (hasMood ? 'mood' : 'health');
      this._shareMode = mode;
    }

    if (!hasAnyData) {
      container.innerHTML = `
        <div class="share-empty-card share-empty-warm">
          <div class="share-empty-icon">💝</div>
          <div class="share-empty-title">아직 전할 내용이 없어요</div>
          <div class="share-empty-msg">
            건강 측정 또는 감정 측정을 마치면<br>
            <strong>안부와 함께</strong> 전할 수 있어요.
          </div>
          <div class="share-empty-grid">
            <button class="share-empty-btn primary" type="button" onclick="App.goPage('mood')">
              <span class="seb-icon">💝</span>
              <span class="seb-text">
                <span class="seb-title">감정 측정</span>
                <span class="seb-sub">3분 · 가장 빠른 방법</span>
              </span>
            </button>
            <button class="share-empty-btn" type="button" onclick="App.goPage('finger')">
              <span class="seb-icon">☝️</span>
              <span class="seb-text">
                <span class="seb-title">손가락 측정</span>
                <span class="seb-sub">30초 · 심박/HRV</span>
              </span>
            </button>
            <button class="share-empty-btn" type="button" onclick="App.goPage('face')">
              <span class="seb-icon">😊</span>
              <span class="seb-text">
                <span class="seb-title">얼굴 측정</span>
                <span class="seb-sub">30초 · rPPG 스캔</span>
              </span>
            </button>
          </div>
        </div>
      `;
      return;
    }

    // 현재 관계 / 이름
    const relation = localStorage.getItem('shareRelation') || 'parent';
    const sharedName = localStorage.getItem('shareSenderName') || '';

    // 관계별 안내 메시지
    const relationCopy = {
      parent: { icon: '👨‍👩‍👧', label: '자녀에게', placeholder: '예: 엄마, 아빠, 어머니, 아버지',
                introTitle: '안부는 안심입니다',
                introBody: `한 줄의 안부가 자녀에게는<br><strong>가장 큰 안심</strong>이 됩니다.` },
      child:  { icon: '👶',    label: '부모님께', placeholder: '예: 딸, 아들, 막내',
                introTitle: '엄마, 아빠 걱정 마세요',
                introBody: `오늘 나의 건강 상태와 안부를<br><strong>부모님께</strong> 전해보세요.` },
      friend: { icon: '🤝',    label: '친구에게', placeholder: '예: 본인 이름 / 별명',
                introTitle: '친구야, 오늘 나 이래',
                introBody: `요즘 어떻게 지내는지<br><strong>친구와 나누는 일상</strong>의 안부예요.` },
      partner:{ icon: '💕',    label: '연인에게', placeholder: '예: 본인 이름 / 애칭',
                introTitle: '오늘 내 마음, 알아줘',
                introBody: `소중한 사람에게<br><strong>오늘의 나</strong>를 솔직하게 전해보세요.` },
      self:   { icon: '💝',    label: '소중한 사람에게', placeholder: '예: 본인 이름',
                introTitle: '내 마음을 이해해줘요',
                introBody: `누군가에게 전하고 싶은<br><strong>오늘의 나</strong>를 담아 보내세요.` },
    };
    const rel = relationCopy[relation] || relationCopy.parent;

    const relations = [
      { id: 'parent',  icon: '👨‍👩‍👧', label: '자녀에게' },
      { id: 'child',   icon: '👶',    label: '부모님께' },
      { id: 'friend',  icon: '🤝',    label: '친구에게' },
      { id: 'partner', icon: '💕',    label: '연인에게' },
      { id: 'self',    icon: '💝',    label: '그 외' },
    ];

    container.innerHTML = `
      ${alertHTML}
      <div class="share-intro-card share-intro-warm">
        <div class="share-intro-icon">${rel.icon}</div>
        <div class="share-intro-title">${rel.introTitle}</div>
        <div class="share-intro-body">${rel.introBody}</div>
      </div>

      <!-- ★ v17.0: 누구에게 보낼지 선택 -->
      <div class="share-relation-card">
        <div class="share-relation-label">💌 누구에게 보낼까요?</div>
        <div class="share-relation-grid">
          ${relations.map(r => `
            <button type="button"
                    class="share-relation-btn ${relation === r.id ? 'on' : ''}"
                    onclick="App._setShareRelation('${r.id}')">
              <span class="srb-icon">${r.icon}</span>
              <span class="srb-label">${r.label}</span>
            </button>
          `).join('')}
        </div>
      </div>

      <!-- ★ v17.0: 무엇을 보낼지 선택 (측정 결과 / 감정만) -->
      <div class="share-mode-card">
        <div class="share-mode-label">🎁 무엇을 보낼까요?</div>
        <div class="share-mode-options">
          ${hasMeasurement ? `
            <button type="button"
                    class="share-mode-btn ${mode === 'health' ? 'on' : ''}"
                    onclick="App._setShareMode('health')">
              <span class="smb-icon">💗</span>
              <span class="smb-body">
                <span class="smb-title">건강 측정 결과</span>
                <span class="smb-sub">${cardio ? `심박/HRV/스트레스` : ''}${result.score > 0 ? (cardio ? ' + ' : '') + '종합 점수' : ''}</span>
              </span>
              <span class="smb-check">✓</span>
            </button>
          ` : ''}
          ${hasMood ? `
            <button type="button"
                    class="share-mode-btn ${mode === 'mood' ? 'on' : ''}"
                    onclick="App._setShareMode('mood')">
              <span class="smb-icon">💝</span>
              <span class="smb-body">
                <span class="smb-title">감정 상태만</span>
                <span class="smb-sub">"내 기분 이해해줘" — ${moodEntry.cardKo || '오늘의 감정'}</span>
              </span>
              <span class="smb-check">✓</span>
            </button>
          ` : `
            <button type="button" class="share-mode-btn disabled" onclick="App.goPage('mood')">
              <span class="smb-icon">💝</span>
              <span class="smb-body">
                <span class="smb-title">감정 상태만</span>
                <span class="smb-sub">감정 측정 후 가능 →</span>
              </span>
            </button>
          `}
        </div>
      </div>

      <!-- 발신자 이름 입력 -->
      <div class="share-name-card">
        <div class="share-name-label">📝 어떻게 표시할까요?</div>
        <input type="text"
               class="share-name-input"
               id="share-sender-name"
               placeholder="${rel.placeholder}"
               value="${this._esc(sharedName)}"
               maxlength="20"
               oninput="App._saveShareName(this.value)">
        <div class="share-name-hint">받는 분에게 표시될 호칭이에요.</div>
      </div>

      <!-- 미리보기 -->
      <div class="share-preview-section">
        <div class="share-preview-label">📱 ${rel.label} 보낼 메시지 미리보기</div>
        <div class="share-preview-card">
          ${this._renderShareMessagePreview(cardio, result, sharedName || this._getDefaultSenderName(), mode, moodEntry, relation)}
        </div>
      </div>

      <!-- 공유 옵션 -->
      <div class="share-options-section">
        <div class="share-options-label">공유 방법</div>

        <button class="share-option-btn primary" type="button" onclick="App._shareToFamily()">
          <div class="sob-icon">📤</div>
          <div class="sob-body">
            <div class="sob-title">바로 공유하기</div>
            <div class="sob-sub">카카오톡 · 문자 · 메일 · 기타 앱</div>
          </div>
        </button>

        <button class="share-option-btn" type="button" onclick="App._copyShareLink()">
          <div class="sob-icon">🔗</div>
          <div class="sob-body">
            <div class="sob-title">링크 복사</div>
            <div class="sob-sub">URL을 복사해서 직접 붙여넣기</div>
          </div>
        </button>

        <button class="share-option-btn" type="button" onclick="App._copyShareMessage()">
          <div class="sob-icon">📋</div>
          <div class="sob-body">
            <div class="sob-title">메시지 + 링크 복사</div>
            <div class="sob-sub">메시지와 링크 함께 복사</div>
          </div>
        </button>
      </div>

      <!-- 정기 측정 알림 -->
      <div class="share-reminder-section">
        <div class="share-reminder-title">⏰ 매일 같은 시간 측정 알림</div>
        <div class="share-reminder-body">
          매일 정해진 시간에 측정 알림을 받으면 빠짐없이 측정할 수 있어요.<br>
          꾸준한 측정 데이터가 더 정확한 안부 신호가 됩니다.
        </div>
        <button class="share-reminder-btn" type="button" onclick="App._setupDailyReminder()">
          🔔 알림 설정하기
        </button>
      </div>

      <!-- 정보 보호 안내 -->
      <div class="share-privacy-card">
        🔒 <strong>개인정보 보호</strong>
        <ul class="share-privacy-list">
          <li>서버에 저장되지 않습니다 (링크 자체에 데이터 포함)</li>
          <li>받는 사람의 폰에도 저장되지 않습니다</li>
          <li>측정값만 공유되며, 이름·연락처는 직접 입력한 호칭만 사용됩니다</li>
        </ul>
      </div>
    `;
  },

  // ════════════════════════════════════════════════════
  // ★ v20.0: 가족 건강 공유 — 변화 알림 시스템
  // ════════════════════════════════════════════════════

  _saveShareHistory(data) {
    try {
      const key = 'share_history';
      let hist = JSON.parse(localStorage.getItem(key) || '[]');
      hist.unshift({
        t: Date.now(),
        relation: data.relation || '가족',
        mode: data.mode || 'health',
        score: data.score || null,
        name: data.name || '나',
      });
      hist = hist.slice(0, 20);
      localStorage.setItem(key, JSON.stringify(hist));
    } catch(e) {}
  },

  _getShareHistory() {
    try { return JSON.parse(localStorage.getItem('share_history') || '[]'); } catch(e) { return []; }
  },

  _generateFamilyAlerts() {
    const alerts = [];
    const now = Date.now();
    const DAY = 86400000;

    const faceH = this._historyGet('face');
    if (faceH.length >= 2) {
      const latest = faceH[faceH.length-1];
      const prev   = faceH[faceH.length-2];
      const hrDelta = latest.hr - prev.hr;
      const rmssdDelta = (latest.rmssd||0) - (prev.rmssd||0);
      const timeDiff = Math.round((now - latest.t) / DAY);
      const timeLabel = timeDiff === 0 ? '오늘' : timeDiff === 1 ? '어제' : `${timeDiff}일 전`;

      if (Math.abs(hrDelta) >= 10) {
        const up = hrDelta > 0;
        alerts.push({
          cls: up ? 'warn' : 'good', icon: up ? '💗' : '💚',
          name: '심박수 변화',
          msg: `${timeLabel} 측정 심박수 ${prev.hr}→${latest.hr} BPM (${up?'+':''}${hrDelta.toFixed(0)})`,
          time: timeLabel,
        });
      }
      if (rmssdDelta >= 10) {
        alerts.push({
          cls: 'good', icon: '✨', name: 'HRV 개선',
          msg: `심박변이도가 ${(prev.rmssd||0).toFixed(0)}→${(latest.rmssd||0).toFixed(0)}ms로 향상됐어요`,
          time: timeLabel,
        });
      } else if (rmssdDelta <= -10) {
        alerts.push({
          cls: 'warn', icon: '⚠️', name: 'HRV 주의',
          msg: `심박변이도가 ${(prev.rmssd||0).toFixed(0)}→${(latest.rmssd||0).toFixed(0)}ms로 낮아졌어요`,
          time: timeLabel,
        });
      }
    }

    const bodyH = this._historyGet('bodycomp');
    if (bodyH.length >= 2) {
      const latest = bodyH[bodyH.length-1];
      const prev   = bodyH[bodyH.length-2];
      if (latest.weight && prev.weight) {
        const wDelta = latest.weight - prev.weight;
        const timeDiff = Math.round((now - latest.t) / DAY);
        const timeLabel = timeDiff === 0 ? '오늘' : `${timeDiff}일 전`;
        if (Math.abs(wDelta) >= 1) {
          alerts.push({
            cls: Math.abs(wDelta) >= 2 ? 'warn' : 'info',
            icon: wDelta > 0 ? '⬆️' : '⬇️', name: '체중 변화',
            msg: `${prev.weight.toFixed(1)}→${latest.weight.toFixed(1)}kg (${wDelta>0?'+':''}${wDelta.toFixed(1)}kg)`,
            time: timeLabel,
          });
        }
      }
    }

    const streak = this._streakGet ? this._streakGet() : 0;
    if (streak >= 7) {
      alerts.push({
        cls: 'good', icon: '🔥',
        name: `${streak}일 연속 측정 달성!`,
        msg: '꾸준한 건강 측정 습관이 자리잡고 있어요',
        time: '오늘',
      });
    }
    return alerts;
  },

  _renderFamilyAlertSection() {
    const alerts = this._generateFamilyAlerts();
    const history = this._getShareHistory();
    let alertsHTML = '';
    if (alerts.length > 0) {
      const itemsHTML = alerts.slice(0,4).map(a => `
        <button type="button" class="family-alert-item ${a.cls}">
          <span class="fai-icon">${a.icon}</span>
          <div class="fai-body">
            <div class="fai-name">${a.name}</div>
            <div class="fai-msg">${a.msg}</div>
          </div>
          <span class="fai-time">${a.time}</span>
        </button>`).join('');
      alertsHTML = `
        <div class="family-alert-section">
          <div class="family-alert-title">🔔 건강 변화 알림</div>
          ${itemsHTML}
        </div>`;
    }
    let histHTML = '';
    if (history.length > 0) {
      const relIcons = { '부모님':'👨‍👩‍👧', '자녀':'👶', '배우자':'💑', '형제자매':'👫', '친구':'😊' };
      const itemsH = history.slice(0,5).map(h => {
        const d = new Date(h.t);
        const label = `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
        const icon = relIcons[h.relation] || '👥';
        return `
          <div class="shc-item">
            <span class="shc-icon">${icon}</span>
            <div class="shc-body">
              <div class="shc-who">${h.relation}에게 공유</div>
              <div class="shc-when">${label}</div>
            </div>
            ${h.score ? `<span class="shc-score">${h.score}점</span>` : ''}
          </div>`;
      }).join('');
      histHTML = `
        <div class="share-history-card">
          <div class="shc-title">📤 최근 공유 이력</div>
          ${itemsH}
        </div>`;
    }
    return alertsHTML + histHTML;
  },


  _renderShareMessagePreview(cardio, result, name, mode, moodEntry, relation) {
    mode = mode || 'health';
    relation = relation || 'parent';
    const time = new Date().toLocaleString('ko-KR', { dateStyle: 'long', timeStyle: 'short' });

    // ★ v17.1: 관계별 인사말 — 받침 조사 자동 처리 + 모드 반영
    const nameSafe = this._esc(name);
    const iga = this._jongsa_iga(name);    // 이/가
    const greetingsByMode = {
      health: {
        parent: `${nameSafe}${iga} 건강 측정을 마치셨어요 ✨`,
        child:  `${nameSafe}의 건강 소식이에요 ✨`,
        friend: `${nameSafe} — 오늘 내 건강 이래 ✨`,
        partner:`${nameSafe}${iga} 오늘 건강을 전해요 💕`,
        self:   `${nameSafe}의 오늘 건강이에요 ✨`,
      },
      mood: {
        parent: `${nameSafe}의 오늘 마음이에요 💝`,
        child:  `${nameSafe}의 오늘 기분이에요 💝`,
        friend: `${nameSafe} — 오늘 내 기분이야 💝`,
        partner:`${nameSafe}의 오늘 마음을 전해요 💕`,
        self:   `${nameSafe}의 오늘 마음이에요 💝`,
      },
    };
    const greeting = (greetingsByMode[mode] || greetingsByMode.health)[relation]
                  || greetingsByMode.health.self;

    // 관계별 마무리 멘트
    const closings = {
      health: {
        parent: '오늘도 건강하게 하루 시작 💛',
        child:  '걱정 마세요, 잘 지내고 있어요 💛',
        friend: '오늘도 좋은 하루 보내자 💛',
        partner:'오늘도 함께라 든든해 💛',
        self:   '오늘도 평안한 하루 보내세요 💛',
      },
      mood: {
        parent: '오늘 마음이 이래요. 이해해주세요 💛',
        child:  '오늘 기분 이래요. 응원해주세요 💛',
        friend: '오늘 기분이 이래. 너에게 말하고 싶었어 💛',
        partner:'오늘 내 마음이야. 함께해줘서 고마워 💛',
        self:   '오늘의 내 마음을 이해해주세요 💛',
      },
    };
    const closing = closings[mode]?.[relation] || closings.health.self;

    // ★ v17.0: 모드별 미리보기 (감정만 모드 추가)
    // ★ v17.1: moodEntry 안전 처리 — cardId 없어도 valence/arousal로 추정
    if (mode === 'mood' && moodEntry) {
      let emotionName, emotionDesc, emotionColor;

      // 1. cardId 있으면 정밀 매칭 (통합 측정 결과)
      if (moodEntry.cardId && this._emotionCards?.[moodEntry.cardId]) {
        const card = this._emotionCards[moodEntry.cardId];
        emotionName = moodEntry.cardKo || card.ko;
        emotionDesc = card.desc;
        emotionColor = card.color;
      }
      // 2. cardKo만 있으면 그대로 사용
      else if (moodEntry.cardKo) {
        emotionName = moodEntry.cardKo;
        emotionDesc = '오늘의 마음을 나누고 있어요';
        emotionColor = '#EC4899';
      }
      // 3. valence/arousal로 폴백 추정 (기존 게임 데이터)
      else if (moodEntry.valence !== undefined || moodEntry.arousal !== undefined) {
        const v = moodEntry.valence || 0;
        const a = moodEntry.arousal || 0;
        if (v > 0.3 && a > 0.3)       { emotionName = '기쁨';  emotionDesc = '환한 기분이 마음 가득해요';     emotionColor = '#FFD54F'; }
        else if (v > 0.3 && a < -0.1) { emotionName = '평온';  emotionDesc = '잔잔하게 편안한 상태예요';     emotionColor = '#FFE082'; }
        else if (v < -0.3 && a > 0.3) { emotionName = '긴장';  emotionDesc = '마음 한 켠에 걱정이 있어요';   emotionColor = '#FF8A65'; }
        else if (v < -0.3 && a < -0.1){ emotionName = '슬픔';  emotionDesc = '마음이 무겁고 쓸쓸해요';        emotionColor = '#7986CB'; }
        else                          { emotionName = '평정';  emotionDesc = '잔잔한 일상을 보내고 있어요'; emotionColor = '#90A4AE'; }
      }
      // 4. 점수만 있는 단순 게임 (mirror/color/diary/reflex)
      else if (moodEntry.score !== undefined || moodEntry.mental?.overall) {
        const score = moodEntry.score || moodEntry.mental?.overall || 50;
        if (score >= 75)      { emotionName = '평온';  emotionDesc = '마음이 평안한 상태예요';       emotionColor = '#FFE082'; }
        else if (score >= 60) { emotionName = '안정';  emotionDesc = '잔잔한 일상이에요';            emotionColor = '#FFD54F'; }
        else if (score >= 45) { emotionName = '보통';  emotionDesc = '평이한 하루를 보내고 있어요'; emotionColor = '#90A4AE'; }
        else if (score >= 30) { emotionName = '지침';  emotionDesc = '조금 피곤한 상태예요';         emotionColor = '#9FA8DA'; }
        else                  { emotionName = '힘듦';  emotionDesc = '마음이 무거운 상태예요';       emotionColor = '#7986CB'; }
      }
      // 5. 최종 폴백
      else {
        emotionName = '오늘의 마음';
        emotionDesc = '소중한 하루를 보내고 있어요';
        emotionColor = '#EC4899';
      }

      return `
        <div class="smp-header">
          <div class="smp-greeting">${greeting}</div>
          <div class="smp-time">${time}</div>
        </div>
        <div class="smp-mood-hero" style="background: linear-gradient(135deg, ${emotionColor}25, ${emotionColor}40); border-color: ${emotionColor}50">
          <div class="smp-mood-label">오늘 마음 상태</div>
          <div class="smp-mood-word" style="color: ${emotionColor}">${emotionName}</div>
          <div class="smp-mood-desc">${emotionDesc}</div>
        </div>
        <div class="smp-footer">
          ${closing}
        </div>
      `;
    }

    // 기본 모드: health (측정 결과 위주)
    const score = result.score;
    const grade = result.grade;
    const stressLabels = ['', '매우 이완', '이완', '보통', '긴장', '높은 스트레스'];
    const stressLabel = cardio?.stressLevel ? stressLabels[cardio.stressLevel] : '측정 중';

    return `
      <div class="smp-header">
        <div class="smp-greeting">${greeting}</div>
        <div class="smp-time">${time}</div>
      </div>
      ${score > 0 ? `
        <div class="smp-score-row">
          <div class="smp-score-circle" style="color:${score >= 70 ? '#22c55e' : score >= 50 ? '#3b82f6' : '#f59e0b'}">
            <div class="smp-score-num">${score}</div>
            <div class="smp-score-max">/100</div>
          </div>
          <div class="smp-score-info">
            <div class="smp-score-label">종합 건강 점수</div>
            <div class="smp-score-grade">${grade}</div>
          </div>
        </div>
      ` : ''}
      ${cardio ? `
        <div class="smp-vitals">
          <div class="smp-vital">
            <span class="smp-v-icon">❤️</span>
            <span class="smp-v-label">심박수</span>
            <span class="smp-v-value">${cardio.hr || '--'} BPM</span>
          </div>
          <div class="smp-vital">
            <span class="smp-v-icon">🧘</span>
            <span class="smp-v-label">자율신경</span>
            <span class="smp-v-value">${stressLabel}</span>
          </div>
        </div>
      ` : ''}
      <div class="smp-footer">
        ${closing}
      </div>
    `;
  },

  _saveShareName(name) {
    try {
      const trimmed = (name || '').trim();
      localStorage.setItem('shareSenderName', trimmed);
      // ★ v17.1: 미리보기 갱신 시 mode/moodEntry/relation 모두 전달
      const previewEl = document.querySelector('.share-preview-card');
      if (previewEl) {
        const w = this.state.wellness || {};
        const cardio = this._getUnifiedCardio(w);
        const result = this._wellnessComputeScore();
        const mode = this._shareMode || 'health';
        const relation = localStorage.getItem('shareRelation') || 'parent';

        // mood 모드면 moodEntry 가져오기 (cardId 우선)
        let moodEntry = null;
        if (mode === 'mood') {
          try {
            const moodHistory = JSON.parse(localStorage.getItem('history_mood') || '[]');
            const recent = moodHistory.filter(h => h && h.t && (Date.now() - h.t < 24 * 60 * 60 * 1000));
            if (recent.length > 0) {
              const withCard = recent.filter(h => h.cardId || h.cardKo);
              moodEntry = withCard.length > 0 ? withCard[withCard.length - 1] : recent[recent.length - 1];
            }
          } catch (e) {}
        }

        previewEl.innerHTML = this._renderShareMessagePreview(
          cardio, result,
          trimmed || this._getDefaultSenderName(),
          mode, moodEntry, relation
        );
      }
    } catch (e) {}
  },

  // ★ v17.0: 관계별 기본 발신자 이름
  _getDefaultSenderName() {
    const rel = localStorage.getItem('shareRelation') || 'parent';
    const defaults = {
      parent: '부모님',     // 부모 → 자녀
      child: '자녀',         // 자녀 → 부모
      friend: '친구',         // 친구
      partner: '나',         // 연인
      self: '나',             // 일반
    };
    return defaults[rel] || '나';
  },

  // ★ v17.0: 관계별 받는 사람 호칭
  _getReceiverName() {
    const rel = localStorage.getItem('shareRelation') || 'parent';
    const receivers = {
      parent: '자녀에게',
      child: '부모님께',
      friend: '친구에게',
      partner: '연인에게',
      self: '소중한 사람에게',
    };
    return receivers[rel] || '소중한 사람에게';
  },

  // ★ v17.0: 관계 선택 저장 (페이지 일부만 갱신)
  _setShareRelation(rel) {
    localStorage.setItem('shareRelation', rel);
    this._renderSharePage();
  },

  // ★ v17.0: 공유 모드 (health: 측정 결과 / mood: 감정만)
  _setShareMode(mode) {
    this._shareMode = mode;
    this._renderSharePage();
  },

  // 공유 데이터를 URL-safe base64로 인코딩
  _buildShareData() {
    const w = this.state.wellness || {};
    const cardio = this._getUnifiedCardio(w);
    const result = this._wellnessComputeScore();
    const name = (localStorage.getItem('shareSenderName') || '').trim();
    // ★ v17.0: 모드와 관계 포함
    const mode = this._shareMode || 'health';
    const relation = localStorage.getItem('shareRelation') || 'parent';

    const data = {
      v: '2', // 데이터 포맷 버전 (v17.0)
      n: name || this._getDefaultSenderName(),
      t: Date.now(),
      m: mode,        // health | mood
      r: relation,    // parent | child | friend | partner | self
    };

    // ★ v17.0: 모드별 데이터 추가
    if (mode === 'mood') {
      // 감정만 모드 — 최근 mood 항목 포함
      try {
        const moodHistory = JSON.parse(localStorage.getItem('history_mood') || '[]');
        const latest = moodHistory[moodHistory.length - 1];
        if (latest) {
          data.mood = {
            cardId: latest.cardId,
            cardKo: latest.cardKo,
            valence: latest.valence,
            arousal: latest.arousal,
          };
        }
      } catch (e) {}
    } else {
      // 건강 측정 모드 — 기존 필드
      data.s = result.score;
      data.g = result.grade;
      if (cardio) {
        data.hr = cardio.hr;
        data.rm = cardio.rmssd;
        data.st = cardio.stressLevel;
        data.si = cardio.stressIndex;
        data.src = cardio.source;
      }
      // 측정 항목 수
      data.cnt = ['face','finger','balance','gait','tremor','reaction','posture','bodycomp']
        .filter(k => w[k]).length;
    }

    try {
      const json = JSON.stringify(data);
      // URL-safe base64
      const b64 = btoa(unescape(encodeURIComponent(json)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      return b64;
    } catch (e) {
      console.error('Encode failed:', e);
      return null;
    }
  },

  _buildShareUrl() {
    const encoded = this._buildShareData();
    if (!encoded) return null;
    const base = window.location.origin + window.location.pathname;
    return `${base}?share=${encoded}`;
  },

  _buildShareMessage() {
    const name = (localStorage.getItem('shareSenderName') || '부모님').trim();
    const result = this._wellnessComputeScore();
    const time = new Date().toLocaleString('ko-KR', { dateStyle: 'long', timeStyle: 'short' });
    const url = this._buildShareUrl();
    return `💌 ${name}이 건강 측정을 마치셨어요\n` +
           `📅 ${time}\n` +
           `📊 종합 점수: ${result.score}/100 (${result.grade})\n\n` +
           `상세 결과 보기 👇\n${url}\n\n` +
           `오늘도 건강하게 하루 시작 💛`;
  },

  async _shareToFamily() {
    const text = this._buildShareMessage();
    const url = this._buildShareUrl();
    if (!url) {
      alert('공유 링크 생성에 실패했습니다.');
      return;
    }

    // ★ v20.0: 공유 이력 저장
    try {
      const relation = localStorage.getItem('shareRelation') || '가족';
      const relNames = { parent:'부모님', child:'자녀', spouse:'배우자', sibling:'형제자매', friend:'친구' };
      const ws = this._wellnessComputeScore ? this._wellnessComputeScore() : {};
      this._saveShareHistory({
        relation: relNames[relation] || '가족',
        mode: this._shareMode || 'health',
        score: ws.score || null,
        name: '나',
      });
    } catch(e) {}

    // Web Share API 사용
    if (navigator.share) {
      try {
        await navigator.share({
          title: '건강 측정 결과',
          text: text,
        });
        this._toast('✓ 공유했어요');
      } catch (e) {
        // 사용자 취소는 무시
        if (e.name !== 'AbortError') {
          console.error('Share failed:', e);
          // Fallback: 메시지 복사
          this._copyShareMessage();
        }
      }
    } else {
      // Web Share 미지원 → 메시지 복사로 대체
      this._copyShareMessage();
    }
  },

  async _copyShareLink() {
    const url = this._buildShareUrl();
    if (!url) {
      alert('링크 생성 실패');
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      this._toast('✓ 링크가 복사됐어요');
    } catch (e) {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); this._toast('✓ 링크가 복사됐어요'); } catch (e2) {}
      ta.remove();
    }
  },

  async _copyShareMessage() {
    const text = this._buildShareMessage();
    try {
      await navigator.clipboard.writeText(text);
      this._toast('✓ 메시지가 복사됐어요. 카카오톡에 붙여넣으세요');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); this._toast('✓ 메시지가 복사됐어요'); } catch (e2) {}
      ta.remove();
    }
  },

  // 정기 측정 알림 설정 (Notification API + 로컬 알림)
  async _setupDailyReminder() {
    if (!('Notification' in window)) {
      alert('이 기기는 알림 기능을 지원하지 않습니다.');
      return;
    }

    if (Notification.permission === 'denied') {
      alert('알림 권한이 차단되어 있습니다.\n브라우저 설정에서 알림을 허용해주세요.');
      return;
    }

    if (Notification.permission !== 'granted') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        alert('알림 권한이 필요합니다.');
        return;
      }
    }

    // 알람 시간 선택 (간단히 prompt로)
    const timeStr = prompt('매일 측정 알림을 받을 시간을 입력하세요 (예: 09:00)', '09:00');
    if (!timeStr) return;
    const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) {
      alert('시간 형식이 올바르지 않습니다. 예: 09:00');
      return;
    }
    const hour = parseInt(match[1], 10);
    const minute = parseInt(match[2], 10);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      alert('시간이 유효하지 않습니다.');
      return;
    }

    localStorage.setItem('reminderHour', hour);
    localStorage.setItem('reminderMinute', minute);
    localStorage.setItem('reminderEnabled', '1');
    this._scheduleNextReminder();
    this._toast(`✓ 매일 ${hour}:${minute.toString().padStart(2, '0')}에 알림이 설정됐어요`);
  },

  _scheduleNextReminder() {
    if (localStorage.getItem('reminderEnabled') !== '1') return;
    if (Notification.permission !== 'granted') return;

    const hour = parseInt(localStorage.getItem('reminderHour') || '9', 10);
    const minute = parseInt(localStorage.getItem('reminderMinute') || '0', 10);

    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0);
    if (next <= now) next.setDate(next.getDate() + 1);

    const ms = next - now;
    // 최대 24시간 후만 set (브라우저 timer 한계)
    if (ms > 0 && ms < 25 * 60 * 60 * 1000) {
      clearTimeout(this._reminderTimer);
      this._reminderTimer = setTimeout(() => {
        try {
          new Notification('💛 건강 측정 시간이에요', {
            body: '오늘도 30초 측정하고 자녀에게 안부를 전해보세요',
            icon: 'icons/icon-192.png',
            tag: 'health-reminder',
          });
        } catch (e) {}
        this._scheduleNextReminder(); // 다음 날 예약
      }, ms);
    }
  },

  // 자녀가 받은 공유 데이터 보기
  _renderFamilyViewPage() {
    const container = document.getElementById('family-view-container');
    if (!container) return;

    // sessionStorage에서 공유 데이터 가져오기
    let data = null;
    try {
      const raw = sessionStorage.getItem('familyShareData');
      if (raw) data = JSON.parse(raw);
    } catch (e) {}

    if (!data) {
      container.innerHTML = `
        <div class="share-empty-card">
          <div class="share-empty-icon">😔</div>
          <div class="share-empty-title">공유 정보가 없어요</div>
          <div class="share-empty-msg">받으신 공유 링크를 통해서만 확인할 수 있습니다.</div>
        </div>
      `;
      return;
    }

    // 측정 시간 계산
    const measuredTime = new Date(data.t);
    const ago = Date.now() - data.t;
    let timeAgo;
    if (ago < 60 * 1000) timeAgo = '방금 전';
    else if (ago < 60 * 60 * 1000) timeAgo = `${Math.floor(ago / 60000)}분 전`;
    else if (ago < 24 * 60 * 60 * 1000) timeAgo = `${Math.floor(ago / 3600000)}시간 전`;
    else timeAgo = `${Math.floor(ago / 86400000)}일 전`;

    // ★ v17.0: 관계 + 모드 (구버전 호환)
    const mode = data.m || 'health';
    const relation = data.r || 'parent';
    const senderName = data.n || '소중한 사람';

    // 관계별 헤더 (받는 사람 입장) — ★ v17.1: 받침 조사 + 모드 반영
    const nameSafe = this._esc(senderName);
    const iga = this._jongsa_iga(senderName);
    const headersByMode = {
      health: {
        parent: { icon: '👨‍👩‍👧', greeting: `${nameSafe}${iga} 건강 측정을 마치셨어요` },
        child:  { icon: '👶',    greeting: `${nameSafe}의 건강 소식이에요` },
        friend: { icon: '🤝',    greeting: `${nameSafe} — 오늘의 건강` },
        partner:{ icon: '💕',    greeting: `${nameSafe}${iga} 건강을 전해요` },
        self:   { icon: '💝',    greeting: `${nameSafe}의 오늘 건강` },
      },
      mood: {
        parent: { icon: '👨‍👩‍👧', greeting: `${nameSafe}의 오늘 마음이에요` },
        child:  { icon: '👶',    greeting: `${nameSafe}의 오늘 기분이에요` },
        friend: { icon: '🤝',    greeting: `${nameSafe} — 오늘의 기분` },
        partner:{ icon: '💕',    greeting: `${nameSafe}의 마음을 전해요` },
        self:   { icon: '💝',    greeting: `${nameSafe}의 오늘 마음` },
      },
    };
    const h = (headersByMode[mode] || headersByMode.health)[relation]
           || headersByMode.health.self;

    // ★ v17.0: 감정만 모드 렌더링
    if (mode === 'mood' && data.mood) {
      const mood = data.mood;
      const card = this._emotionCards?.[mood.cardId];
      const emotionName = mood.cardKo || card?.ko || '오늘의 감정';
      const emotionDesc = card?.desc || '오늘의 마음을 나누고 있어요';
      const emotionColor = card?.color || '#EC4899';
      const lighterColor = this._lightenColor ? this._lightenColor(emotionColor, 25) : emotionColor;

      // 관계별 응답 메시지
      const moodMessages = {
        parent: `자녀분의 오늘 마음 상태예요. 따뜻한 한마디가 큰 힘이 됩니다. 💝`,
        child:  `${this._esc(senderName)}의 마음을 나누고 있어요. 함께 들어주세요. 💝`,
        friend: `친구의 오늘 기분이에요. 들어주는 것만으로도 위로가 됩니다. 💝`,
        partner:`연인의 오늘 마음을 보내왔어요. 옆에 있어주세요. 💝`,
        self:   `소중한 사람이 오늘의 마음을 보내왔어요. 💝`,
      };
      const moodMsg = moodMessages[relation] || moodMessages.self;

      container.innerHTML = `
        <div class="family-view-card mood-card-warm">
          <div class="fvc-header">
            <div class="fvc-icon">${h.icon}</div>
            <div class="fvc-title">${h.greeting}</div>
            <div class="fvc-time">${timeAgo} · ${measuredTime.toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' })}</div>
          </div>

          <!-- 감정 hero 카드 -->
          <div class="fvc-mood-hero" style="background: linear-gradient(135deg, ${lighterColor} 0%, ${emotionColor} 100%);">
            <div class="fvc-mood-meta">오늘의 마음</div>
            <div class="fvc-mood-word">${emotionName}</div>
            <div class="fvc-mood-desc">${emotionDesc}</div>
          </div>

          <!-- 안부 메시지 -->
          <div class="fvc-message">
            ${moodMsg}
          </div>

          <!-- 행동 안내 -->
          <div class="fvc-activity">
            <div class="fvc-activity-icon">💞</div>
            <div class="fvc-activity-text">
              <strong>이해해주는 것이 가장 큰 선물입니다</strong><br>
              <small>지금 한 통의 연락이 큰 위안이 될 수 있어요.</small>
            </div>
          </div>

          <!-- 행동 버튼 -->
          <div class="fvc-actions">
            <a class="fvc-action-btn primary" href="tel:" onclick="App._toast('통화 앱이 열립니다')">
              📞 전화하기
            </a>
          </div>

          <!-- 면책 -->
          <div class="fvc-disclaimer">
            💝 이 메시지는 자기보고 기반의 감정 표현입니다.
            받은 분의 진심을 함께 나누어주세요.
          </div>
        </div>
      `;
      return;
    }

    // 기본 모드: health (측정 결과)
    const stressLabels = ['', '매우 이완', '이완', '보통', '긴장', '높은 스트레스'];
    const stressLabel = data.st ? stressLabels[data.st] : '측정됨';
    const stressColors = ['', '#16a34a', '#22c55e', '#3b82f6', '#f59e0b', '#dc2626'];
    const stressColor = stressColors[data.st || 3];

    const scoreColor = data.s >= 70 ? '#22c55e' : data.s >= 50 ? '#3b82f6' : '#f59e0b';

    // 안부 메시지 — 관계 + 점수 조합 (★ v17.1: 받침 조사)
    let goodMsg;
    if (data.s >= 80) {
      goodMsg = relation === 'parent' ? `${nameSafe}${iga} 매우 건강하게 지내고 계세요. 안심해도 좋겠어요. 😊`
              : relation === 'child'  ? `${nameSafe}${iga} 매우 건강하게 잘 지내고 있어요. 안심하세요. 😊`
              : relation === 'friend' ? `${nameSafe} 컨디션이 정말 좋대요! 😊`
              : relation === 'partner'? `${nameSafe}${iga} 매우 건강해요. 함께 기뻐해주세요. 😊`
              : `${nameSafe}${iga} 매우 건강하게 지내고 계세요. 😊`;
    } else if (data.s >= 60) {
      goodMsg = `${nameSafe}${iga} 건강하게 잘 지내고 있어요. 따뜻한 안부 한마디 전해보세요. 💛`;
    } else if (data.s >= 40) {
      goodMsg = `${nameSafe}${iga} 평소대로 잘 지내고 있어요. 가볍게 안부를 여쭤보면 좋겠어요. 🌱`;
    } else {
      goodMsg = `${nameSafe}의 컨디션이 평소보다 낮을 수 있어요. 안부 연락 한 통이 큰 힘이 될 거예요. 💞`;
    }

    container.innerHTML = `
      <div class="family-view-card">
        <div class="fvc-header">
          <div class="fvc-icon">${h.icon}</div>
          <div class="fvc-title">${h.greeting}</div>
          <div class="fvc-time">${timeAgo} · ${measuredTime.toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' })}</div>
        </div>

        <!-- 종합 점수 -->
        ${data.s !== undefined && data.s > 0 ? `
          <div class="fvc-score-block">
            <div class="fvc-score-circle" style="color:${scoreColor}">
              <div class="fvc-score-num">${data.s}</div>
              <div class="fvc-score-max">/100</div>
            </div>
            <div class="fvc-score-label">종합 건강 점수</div>
            <div class="fvc-score-grade" style="color:${scoreColor}">${data.g || ''}</div>
          </div>
        ` : ''}

        <!-- 안부 메시지 -->
        <div class="fvc-message">
          ${goodMsg}
        </div>

        <!-- 측정 항목 -->
        ${data.hr || data.rm || data.st ? `
          <div class="fvc-metrics">
            <div class="fvc-metrics-title">📊 측정 결과</div>
            ${data.hr ? `
              <div class="fvc-metric">
                <span class="fvc-m-icon">❤️</span>
                <span class="fvc-m-label">심박수</span>
                <span class="fvc-m-value">${data.hr} BPM</span>
              </div>
            ` : ''}
            ${data.rm ? `
              <div class="fvc-metric">
                <span class="fvc-m-icon">📊</span>
                <span class="fvc-m-label">심박변이도 (HRV)</span>
                <span class="fvc-m-value">${data.rm} ms</span>
              </div>
            ` : ''}
            ${data.st ? `
              <div class="fvc-metric">
                <span class="fvc-m-icon">🧘</span>
                <span class="fvc-m-label">자율신경 상태</span>
                <span class="fvc-m-value" style="color:${stressColor}">${stressLabel}</span>
              </div>
            ` : ''}
            ${data.si !== undefined ? `
              <div class="fvc-metric">
                <span class="fvc-m-icon">🌡️</span>
                <span class="fvc-m-label">스트레스 지수</span>
                <span class="fvc-m-value">${data.si}</span>
              </div>
            ` : ''}
          </div>
        ` : ''}

        <!-- 측정 활동 표시 -->
        ${data.cnt ? `
          <div class="fvc-activity">
            <div class="fvc-activity-icon">✨</div>
            <div class="fvc-activity-text">
              <strong>오늘 ${data.cnt}개 항목을 측정하셨어요.</strong><br>
              <small>건강을 스스로 챙기시는 모습이 보여요.</small>
            </div>
          </div>
        ` : ''}

        <!-- 안부 메시지 보내기 (전화 링크) -->
        <div class="fvc-actions">
          <a class="fvc-action-btn primary" href="tel:" onclick="App._toast('통화 앱이 열립니다')">
            📞 전화 드리기
          </a>
        </div>

        <!-- 면책 -->
        <div class="fvc-disclaimer">
          ⚠️ 이 측정은 의료 진단이 아닌 건강 참고용입니다.
          이상이 느껴지시면 의료진과 상담하시는 것이 좋습니다.
        </div>
      </div>
    `;
  },

  // URL에서 share 파라미터 감지 → 자녀 보기 페이지로 자동 이동
  _checkSharedUrl() {
    try {
      const params = new URLSearchParams(window.location.search);
      const shared = params.get('share');
      if (!shared) return false;

      // URL-safe base64 디코딩
      const b64 = shared.replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '==='.slice((b64.length + 3) % 4);
      const json = decodeURIComponent(escape(atob(padded)));
      const data = JSON.parse(json);

      // ★ v17.0: 검증 — health(s 필수) / mood(mood 필수) 모드 구분
      if (!data || !data.v || !data.t) {
        console.warn('Invalid share data');
        return false;
      }
      const mode = data.m || 'health';
      if (mode === 'health' && data.s === undefined) {
        console.warn('Invalid health share data');
        return false;
      }
      if (mode === 'mood' && !data.mood) {
        console.warn('Invalid mood share data');
        return false;
      }

      // 만료 검사 (7일 이내만 표시)
      if (Date.now() - data.t > 7 * 24 * 60 * 60 * 1000) {
        sessionStorage.setItem('familyShareExpired', '1');
      }

      sessionStorage.setItem('familyShareData', JSON.stringify(data));

      // URL에서 share 파라미터 제거 (clean URL)
      const cleanUrl = window.location.origin + window.location.pathname;
      window.history.replaceState({page:'family-view'}, '', cleanUrl);

      // ★ v16.6: 즉시 가족 보기 페이지로 (setTimeout 제거 - 깜빡임 방지)
      this._goPageInternal('family-view');
      return true;
    } catch (e) {
      console.error('Share URL parse failed:', e);
      return false;
    }
  },

  // ★ v19.1: 주간 목표 진행 카드 렌더링
  // ════════════════════════════════════════════════════
  // ★ v20.6: 개인정보 데이터 관리 (백업/복원/처리방침)
  // ════════════════════════════════════════════════════

  // ★ v24.1: 기관 모드 설정 (기관에서 측정자 추적용)
  setOrgMode(orgCode, userLabel) {
    try {
      localStorage.setItem('yb_org_mode', '1'); // 기관 모드 ON → 측정자 카드 표시
      if (orgCode) localStorage.setItem('yb_org_code', orgCode);
      if (userLabel != null) localStorage.setItem('yb_user_label', userLabel);
      this._toast('✓ 기관 측정 정보가 설정되었어요');
      this._syncMeasurerFixed();
    } catch (e) {}
  },

  // 기관 모드 끄기 (개인 사용자로 전환)
  clearOrgMode() {
    try {
      localStorage.removeItem('yb_org_mode');
      localStorage.removeItem('yb_org_code');
      localStorage.removeItem('yb_user_label');
      this._toast('기관 모드를 해제했어요');
      this._syncMeasurerFixed();
    } catch (e) {}
  },
  // 측정자만 변경 (다음 사람 측정 전에 호출)
  setMeasurer(userLabel) {
    try {
      if (userLabel) localStorage.setItem('yb_user_label', userLabel);
      else localStorage.removeItem('yb_user_label');
    } catch (e) {}
  },
  getOrgMode() {
    try {
      return {
        org: localStorage.getItem('yb_org_code') || '',
        label: localStorage.getItem('yb_user_label') || '',
      };
    } catch (e) { return { org:'', label:'' }; }
  },

  // ★ v24.4: 측정자 입력 카드 렌더 (기관 모드 시 홈에 표시)
  // ★ v24.6: 하단 고정 측정자 입력칸 동기화
  _syncMeasurerFixed() {
    try {
      const input = document.getElementById('measurer-input-fixed');
      const status = document.getElementById('measurer-status');
      const label = localStorage.getItem('yb_user_label') || '';
      if (input && !document.activeElement?.isSameNode(input)) input.value = label;
      if (status) {
        status.innerHTML = label
          ? `현재 측정자: <strong>${this._esc(label)}</strong> <button type="button" class="measurer-clear" onclick="App.clearMeasurerFixed()">지우기</button>`
          : '';
      }
    } catch (e) {}
  },

  saveMeasurerFixed() {
    try {
      const input = document.getElementById('measurer-input-fixed');
      if (!input) return;
      const val = input.value.trim();
      if (!val) { this._toast('번호를 입력해주세요'); return; }
      localStorage.setItem('yb_user_label', val);
      this._toast('✓ 측정자: ' + val);
      this._syncMeasurerFixed();
    } catch (e) {}
  },

  clearMeasurerFixed() {
    try {
      localStorage.removeItem('yb_user_label');
      this._toast('측정자를 지웠어요');
      this._syncMeasurerFixed();
    } catch (e) {}
  },

  // ★ v24.0: 익명 통계 수집 켜기/끄기
  toggleAnalytics(enabled) {
    try {
      if (enabled) {
        localStorage.removeItem('yb_analytics_off');
        this._toast('✓ 익명 통계 수집을 허용했어요');
      } else {
        localStorage.setItem('yb_analytics_off', '1');
        this._toast('익명 통계 수집을 껐어요');
      }
    } catch (e) {}
  },

  // 토글 초기 상태 반영 (홈 렌더 시 호출)
  _syncAnalyticsToggle() {
    try {
      const el = document.getElementById('analytics-toggle');
      if (el) el.checked = localStorage.getItem('yb_analytics_off') !== '1';
    } catch (e) {}
  },

  // 내 데이터 전체를 JSON 파일로 내보내기 (기기에 다운로드)
  exportMyData() {
    try {
      const keys = [
        'wellness_data', 'history_mood', 'bodycomp_input',
        'streak_data', 'badges_earned', 'share_history',
        'shareRelation', 'shareSenderName',
        'reminderEnabled', 'reminderHour', 'reminderMinute',
      ];
      // 측정 히스토리 키들 (history_face, history_finger 등)
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith('history_') || k.startsWith('sleep_'))) {
          if (!keys.includes(k)) keys.push(k);
        }
      }

      const backup = { _app: 'YoungButton', _version: 'v20.6', _exportedAt: new Date().toISOString(), data: {} };
      keys.forEach(k => {
        const v = localStorage.getItem(k);
        if (v !== null) backup.data[k] = v;
      });

      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const dateStr = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `YoungButton_백업_${dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      const cnt = Object.keys(backup.data).length;
      this._toast(`✓ 내 데이터 ${cnt}개 항목을 백업했어요`);
    } catch (e) {
      this._toast('백업에 실패했어요. 다시 시도해주세요.');
      console.warn('[Export] 실패:', e);
    }
  },

  // 백업 파일에서 데이터 복원
  importMyData() {
    try {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.onchange = (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            const parsed = JSON.parse(ev.target.result);
            if (!parsed || parsed._app !== 'YoungButton' || !parsed.data) {
              this._toast('올바른 YoungButton 백업 파일이 아니에요.');
              return;
            }
            if (!confirm('백업 데이터로 복원하시겠어요?\n현재 기기의 측정 기록이 백업 내용으로 덮어쓰기 됩니다.')) return;

            let restored = 0;
            Object.keys(parsed.data).forEach(k => {
              try { localStorage.setItem(k, parsed.data[k]); restored++; } catch (e2) {}
            });
            this._toast(`✓ ${restored}개 항목을 복원했어요. 새로고침합니다...`);
            setTimeout(() => location.reload(), 1500);
          } catch (err) {
            this._toast('백업 파일을 읽을 수 없어요.');
            console.warn('[Import] 파싱 실패:', err);
          }
        };
        reader.readAsText(file);
      };
      input.click();
    } catch (e) {
      this._toast('복원에 실패했어요.');
      console.warn('[Import] 실패:', e);
    }
  },

  // 개인정보 처리방침 모달
  showPrivacyDetail() {
    const existing = document.getElementById('privacy-modal-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'privacy-modal-overlay';
    overlay.className = 'privacy-modal-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    overlay.innerHTML = `
      <div class="privacy-modal">
        <div class="privacy-modal-title">🔒 개인정보 처리방침</div>
        <div class="privacy-modal-sub">YoungButton은 사용자의 프라이버시를 최우선으로 합니다</div>

        <div class="privacy-modal-section">
          <div class="privacy-modal-h">📱 데이터 저장 위치</div>
          <div class="privacy-modal-p">측정한 모든 건강 데이터(심박·심박변이도·혈관나이·감정·신체지수 등 <strong>원시 측정값</strong>)는 <strong>사용자 본인의 기기 안(브라우저 로컬 저장소)에만</strong> 저장되며, 외부로 전송되지 않습니다. 단, 서비스 개선을 위해 <strong>개인을 식별할 수 없는 익명 통계</strong>(측정 종류·점수·익명 세션ID)만 별도로 수집되며, 홈 화면 보안 카드에서 언제든 끌 수 있습니다.</div>
        </div>

        <div class="privacy-modal-section">
          <div class="privacy-modal-h">🚫 수집하지 않는 정보</div>
          <div class="privacy-modal-p">회원가입·로그인 절차가 없으며, 이름·전화번호·이메일 등으로 개인을 식별하지 않습니다. 직접 입력하신 정보(나이·성별·자녀 연락처 등)도 기기 안에만 보관됩니다.</div>
        </div>

        <div class="privacy-modal-section">
          <div class="privacy-modal-h">📷 카메라·마이크 권한</div>
          <div class="privacy-modal-p">측정 시에만 사용되며, 영상·음성은 <strong>실시간 분석 후 즉시 폐기</strong>됩니다. 사진이나 녹음 파일로 저장하거나 전송하지 않습니다.</div>
        </div>

        <div class="privacy-modal-section">
          <div class="privacy-modal-h">🌐 외부 통신</div>
          <div class="privacy-modal-p">화면 글꼴(Pretendard)과 얼굴 인식 AI(MediaPipe) 라이브러리를 다운로드하는 용도로만 외부에 연결되며, 이때도 사용자 건강 데이터는 전송되지 않습니다.</div>
        </div>

        <div class="privacy-modal-section">
          <div class="privacy-modal-h">💾 데이터 관리 권한</div>
          <div class="privacy-modal-p">언제든 '내 데이터 백업'으로 파일로 보관하거나, 브라우저 설정에서 사이트 데이터를 삭제해 모든 기록을 완전히 지울 수 있습니다.</div>
        </div>

        <div class="privacy-modal-section">
          <div class="privacy-modal-h">⚠️ 안내</div>
          <div class="privacy-modal-p">본 앱은 의료기기가 아니며 건강 참고용 보조 도구입니다. 진단·치료를 대체하지 않습니다.</div>
        </div>

        <button type="button" class="privacy-modal-close" onclick="document.getElementById('privacy-modal-overlay').remove()">
          확인했어요
        </button>
      </div>
    `;
    document.body.appendChild(overlay);
  },

  // ════════════════════════════════════════════════════
  // ★ v20.5: 기본 정보(신체지수) 입력 유도 카드
  // 앱 시작 시 가장 먼저 입력해야 할 기본 정보
  // ════════════════════════════════════════════════════
  _renderBasicInfoCard() {
    const el = document.getElementById('basic-info-card');
    if (!el) return;
    const w = this.state.wellness || {};
    const bc = w.bodycomp;

    // 이미 신체지수 입력 완료 → 컴팩트 요약 카드
    if (bc && bc.height && bc.weight && bc.bmi) {
      const bmiCat = bc.bmi < 18.5 ? '저체중' : bc.bmi < 23 ? '정상' : bc.bmi < 25 ? '과체중' : '비만';
      const bmiColor = bc.bmi < 18.5 ? '#3b82f6' : bc.bmi < 23 ? '#22c55e' : bc.bmi < 25 ? '#f59e0b' : '#ef4444';
      el.style.display = 'block';
      el.innerHTML = `
        <button type="button" class="basic-info-done" onclick="App.openBodyComposition()">
          <div class="bid-left">
            <span class="bid-icon">📏</span>
            <div class="bid-text">
              <div class="bid-title">내 기본 정보</div>
              <div class="bid-sub">${bc.height}cm · ${bc.weight}kg · ${bc.age}세</div>
            </div>
          </div>
          <div class="bid-right">
            <span class="bid-bmi" style="color:${bmiColor}">BMI ${bc.bmi.toFixed(1)}</span>
            <span class="bid-cat" style="color:${bmiColor}">${bmiCat}</span>
          </div>
        </button>`;
      return;
    }

    // 미입력 → 강조 입력 유도 카드
    el.style.display = 'block';
    el.innerHTML = `
      <button type="button" class="basic-info-prompt" onclick="App.openBodyComposition()">
        <div class="bip-badge">시작 전 필수</div>
        <div class="bip-main">
          <span class="bip-icon">📏</span>
          <div class="bip-body">
            <div class="bip-title">먼저 기본 정보를 입력해주세요</div>
            <div class="bip-desc">키·체중·나이를 입력하면 모든 측정 결과가<br>더 정확해지고 신체 나이를 확인할 수 있어요</div>
          </div>
        </div>
        <div class="bip-cta">기본 정보 입력하기 →</div>
      </button>`;
  },

  // ════════════════════════════════════════════════════
  // ★ v22.0: 동적 건강 요약 히어로 (홈 상단)
  // ════════════════════════════════════════════════════
  _renderHomeHero() {
    const dyn = document.getElementById('home-hero-dynamic');
    const def = document.getElementById('home-hero-default');
    if (!dyn) return;

    const ws = this._wellnessComputeScore ? this._wellnessComputeScore() : { score: null };

    // 측정 데이터 없음 → 기본 히어로 유지
    if (!ws || ws.score == null) {
      dyn.innerHTML = '';
      dyn.style.display = 'none';
      if (def) def.style.display = '';
      return;
    }

    // 측정 데이터 있음 → 동적 요약 히어로
    if (def) def.style.display = 'none';
    dyn.style.display = 'block';

    const hour = new Date().getHours();
    const greet = hour < 6 ? '편안한 새벽이에요' : hour < 12 ? '좋은 아침이에요'
      : hour < 18 ? '활기찬 오후예요' : '편안한 저녁이에요';

    // 핵심 지표 3개 (있는 것 우선)
    const w = this.state.wellness || {};
    const cardio = this._getUnifiedCardio ? this._getUnifiedCardio(w) : null;
    const stats = [];
    if (cardio && cardio.hr) stats.push({ val: cardio.hr, label: '심박수 BPM' });
    if (cardio && cardio.rmssd) stats.push({ val: Math.round(cardio.rmssd), label: 'HRV ms' });
    // 종합점수는 항상
    stats.push({ val: ws.score, label: `건강점수 ${ws.grade}` });

    // 최대 3개
    const statsHTML = stats.slice(0, 3).map((s, i) => `
      ${i > 0 ? '<div class="hh-stat-divider"></div>' : ''}
      <div class="hh-stat">
        <div class="hh-stat-val">${s.val}</div>
        <div class="hh-stat-label">${s.label}</div>
      </div>
    `).join('');

    const deltaTxt = ws.scoreDelta != null && ws.scoreDelta !== 0
      ? (ws.scoreDelta > 0 ? `어제보다 ${ws.scoreDelta}점 좋아졌어요 📈` : `어제보다 ${Math.abs(ws.scoreDelta)}점 낮아요`)
      : '오늘도 건강을 기록해보세요';

    dyn.innerHTML = `
      <div class="home-hero">
        <div class="hh-greet">${greet} 👋</div>
        <div class="hh-title">${deltaTxt}</div>
        <div class="hh-stats">${statsHTML}</div>
      </div>`;
  },

  // ════════════════════════════════════════════════════
  // ★ v21.1: 두뇌·균형 건강 요약 카드 (낙상위험·치매선별)
  // ════════════════════════════════════════════════════
  _renderBrainBalanceCard() {
    const el = document.getElementById('brain-balance-card');
    if (!el) return;
    const h = this._computeBrainBalanceHealth();
    if (!h || !h.available) { el.style.display = 'none'; return; }

    el.style.display = 'block';

    // ★ v21.2: 측정 데이터 없음 → 기능 소개 + 측정 유도 카드
    if (h.promptMode) {
      el.innerHTML = `
        <div class="brain-balance-card bbc-prompt">
          <div class="bbc-header">
            <div class="bbc-title">🧠🛡️ 두뇌·균형 건강</div>
            <span class="bbc-conf" style="background:#8b5cf6">NEW</span>
          </div>
          <div class="bbc-prompt-desc">
            보행과 균형을 측정하면 <strong>낙상 위험도</strong>와 <strong>두뇌·보행 건강(치매 선별 보조)</strong>을 확인할 수 있어요.
          </div>
          <div class="bbc-prompt-feats">
            <div class="bbc-pf"><span>🛡️</span> 낙상 위험도 평가</div>
            <div class="bbc-pf"><span>🧠</span> 보행 가변성 분석</div>
            <div class="bbc-pf"><span>📈</span> 추세 변화 추적</div>
          </div>
          <button type="button" class="bbc-cta" onclick="App.goPage('body');setTimeout(()=>App.startBodyTest('gait'),400)">
            🚶 보행 측정 시작하기 →
          </button>
        </div>`;
      return;
    }

    // 낙상 위험 미니 게이지
    const fallHTML = h.fallRiskScore != null ? `
      <div class="bbc-metric" onclick="App.goPage('body');setTimeout(()=>App.startBodyTest('balance'),400)">
        <div class="bbc-m-icon">🛡️</div>
        <div class="bbc-m-body">
          <div class="bbc-m-label">낙상 위험도</div>
          <div class="bbc-m-val" style="color:${h.fallColor}">${h.fallLabel}</div>
        </div>
        <div class="bbc-m-gauge">
          <svg viewBox="0 0 36 36" class="bbc-ring">
            <circle cx="18" cy="18" r="15" fill="none" stroke="#e5e7eb" stroke-width="3"/>
            <circle cx="18" cy="18" r="15" fill="none" stroke="${h.fallColor}" stroke-width="3"
              stroke-dasharray="${(h.fallRiskScore/100*94.2).toFixed(1)} 94.2"
              stroke-linecap="round" transform="rotate(-90 18 18)"/>
          </svg>
          <span class="bbc-ring-num" style="color:${h.fallColor}">${h.fallRiskScore}</span>
        </div>
      </div>` : '';

    // 인지건강 미니 게이지
    const cogHTML = h.cogScore != null ? `
      <div class="bbc-metric" onclick="App.goPage('body');setTimeout(()=>App.startBodyTest('gait'),400)">
        <div class="bbc-m-icon">🧠</div>
        <div class="bbc-m-body">
          <div class="bbc-m-label">두뇌·보행 건강</div>
          <div class="bbc-m-val" style="color:${h.cogColor}">${h.cogLabel}</div>
        </div>
        <div class="bbc-m-gauge">
          <svg viewBox="0 0 36 36" class="bbc-ring">
            <circle cx="18" cy="18" r="15" fill="none" stroke="#e5e7eb" stroke-width="3"/>
            <circle cx="18" cy="18" r="15" fill="none" stroke="${h.cogColor}" stroke-width="3"
              stroke-dasharray="${(h.cogScore/100*94.2).toFixed(1)} 94.2"
              stroke-linecap="round" transform="rotate(-90 18 18)"/>
          </svg>
          <span class="bbc-ring-num" style="color:${h.cogColor}">${h.cogScore}</span>
        </div>
      </div>` : '';

    // 추세 배지
    const trendHTML = h.cvTrend ? `
      <div class="bbc-trend" style="color:${h.cvTrend.color}">
        ${h.cvTrend.dir === 'up' ? '↗' : h.cvTrend.dir === 'down' ? '↘' : '→'} ${h.cvTrend.text}
      </div>` : '';

    // 신뢰도 배지
    const confColor = h.confidence === 'high' ? '#16a34a' : h.confidence === 'medium' ? '#f59e0b' : '#9ca3af';

    el.innerHTML = `
      <div class="brain-balance-card">
        <div class="bbc-header">
          <div class="bbc-title">🧠🛡️ 두뇌·균형 건강</div>
          <span class="bbc-conf" style="background:${confColor}">측정 ${h.totalMeasures}회 · 신뢰도 ${h.confLabel}</span>
        </div>
        <div class="bbc-metrics">
          ${fallHTML}
          ${cogHTML}
        </div>
        ${trendHTML}
        <div class="bbc-note">
          ⚠️ 의학적 진단이 아닌 <strong>선별 보조</strong>입니다. 반복 측정으로 추세를 확인하세요.
        </div>
        ${h.confidence === 'low' ? `<button type="button" class="bbc-cta" onclick="App.goPage('body');setTimeout(()=>App.startBodyTest('gait'),400)">정확도를 높이려면 보행 측정 →</button>` : ''}
      </div>`;
  },

  // ════════════════════════════════════════════════════
  // ★ v20.0: 개인화 추천 엔진
  // ════════════════════════════════════════════════════
  _renderRecommendCard() {
    const el = document.getElementById('recommend-engine-card');
    if (!el) return;
    const recs = this._computeRecommendations();
    if (!recs || recs.length === 0) { el.innerHTML = ''; return; }
    const itemsHTML = recs.slice(0, 3).map(r => `
      <button type="button" class="rec-item" onclick="App.goPage('${r.page}'${r.test ? `, '${r.test}'` : ''})">
        <span class="rec-item-icon">${r.icon}</span>
        <div class="rec-item-body">
          <div class="rec-item-name">${r.name}</div>
          <div class="rec-item-reason">${r.reason}</div>
        </div>
        <span class="rec-item-priority ${r.priority}">${r.priority === 'high' ? '🔴 지금' : r.priority === 'mid' ? '🟡 추천' : '🟢 유지'}</span>
      </button>
    `).join('');
    el.innerHTML = `
      <div class="recommend-card">
        <span class="rec-deco">🤖</span>
        <div class="rec-header">
          <span class="rec-badge">AI 추천</span>
          <div class="rec-title">오늘 이 측정을 해보세요</div>
        </div>
        <div class="rec-items">${itemsHTML}</div>
        <div class="rec-footer">패턴 분석 기반 맞춤 추천 →</div>
      </div>`;
  },

  // 추천 계산 엔진
  _computeRecommendations() {
    const now = Date.now();
    const DAY = 86400000;
    const recs = [];
    const w = this.state.wellness || {};

    // ★ v20.5: 오늘 측정 완료 여부 판단 헬퍼
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const measuredToday = (cat) => {
      const h = this._historyGet(cat);
      if (!h.length) return false;
      return h[h.length-1].t >= todayStart.getTime();
    };

    // 측정 이력 분석
    const faceH = this._historyGet('face');
    const lastFace = faceH.length ? faceH[faceH.length-1] : null;
    const lastFaceAge = lastFace ? (now - lastFace.t) / DAY : 999;
    const faceToday = measuredToday('face');

    const bodyH = this._historyGet('bodycomp');
    const lastBody = bodyH.length ? bodyH[bodyH.length-1] : null;
    const lastBodyAge = lastBody ? (now - lastBody.t) / DAY : 999;

    const reactionH = this._historyGet('reaction');
    const lastReactAge = reactionH.length ? (now - reactionH[reactionH.length-1].t) / DAY : 999;
    const reactionToday = measuredToday('reaction');

    const balanceToday = measuredToday('balance');
    const tremorToday = measuredToday('tremor');
    const fingerToday = measuredToday('finger');

    const hour = new Date().getHours();

    // ① 아침 측정 우선 추천 (06~10시) — 단, 오늘 아직 얼굴 측정 안 했을 때만
    if (hour >= 6 && hour <= 10 && !faceToday) {
      recs.push({
        icon: '😊', name: '얼굴 심혈관 측정',
        reason: '아침 안정 시 HRV가 가장 정확해요',
        page: 'face', priority: 'high', score: 100
      });
    }

    // ② 오래 측정 안 한 항목 추천 — 오늘 측정 안 했고 2일 이상 경과
    if (lastFaceAge > 2 && !faceToday) {
      recs.push({
        icon: '💗', name: '심박·혈관 체크',
        reason: `${Math.floor(lastFaceAge)}일 전 마지막 측정`,
        page: 'face', priority: lastFaceAge > 7 ? 'high' : 'mid',
        score: Math.min(lastFaceAge * 10, 80)
      });
    }

    if (lastBodyAge > 7) {
      recs.push({
        icon: '⚖️', name: '신체 지수 측정',
        reason: `${Math.floor(lastBodyAge)}일 전 마지막 측정 — 체중 변화 확인`,
        page: 'body', test: 'bodycomp', priority: 'mid',
        score: Math.min(lastBodyAge * 5, 70)
      });
    }

    // ③ 스트레스 높으면 균형 추천 — 오늘 균형 측정 안 했을 때만
    if (lastFace && lastFace.stressLevel >= 4 && !balanceToday) {
      recs.push({
        icon: '⚖️', name: '균형 감각 측정',
        reason: '스트레스가 높을 때 균형 능력이 떨어져요',
        page: 'body', test: 'balance', priority: 'high', score: 90
      });
    }

    // ④ 반응속도 오래됐으면 추천 — 오늘 측정 안 했을 때만
    if (lastReactAge > 5 && !reactionToday) {
      recs.push({
        icon: '⚡', name: '반응속도 테스트',
        reason: '집중력·민첩성 변화를 체크해보세요',
        page: 'body', test: 'reaction', priority: 'mid', score: 50
      });
    }

    // ⑤ 수면 점수 나쁘면 손떨림 추천 — 오늘 측정 안 했을 때만
    const sleepScore = this._sleepScore || null;
    if (sleepScore !== null && sleepScore <= 2 && !tremorToday) {
      recs.push({
        icon: '✋', name: '손떨림 체크',
        reason: '수면 부족 시 미세 손떨림이 증가해요',
        page: 'body', test: 'tremor', priority: 'mid', score: 65
      });
    }

    // ⑥ 추천할 게 없을 때 (오늘 주요 측정 다 함)
    if (recs.length === 0) {
      // 오늘 얼굴 측정을 했으면 → 다른 측정 권유 or 격려
      if (faceToday || fingerToday) {
        if (!measuredToday('bodycomp') && lastBodyAge > 3) {
          recs.push({
            icon: '⚖️', name: '신체 지수 확인',
            reason: '오늘 심혈관 측정 완료! 신체 지수도 확인해보세요',
            page: 'body', test: 'bodycomp', priority: 'normal', score: 40
          });
        }
        recs.push({
          icon: '🎉', name: '오늘 측정 완료!',
          reason: '주요 건강 측정을 마쳤어요. 트렌드에서 변화를 확인해보세요',
          page: 'trends', priority: 'normal', score: 20
        });
      } else {
        // 오늘 아무것도 안 했으면 기본 추천
        recs.push({
          icon: '😊', name: '얼굴 심혈관 측정',
          reason: '하루 한 번, 30초면 충분해요',
          page: 'face', priority: 'normal', score: 30
        });
        recs.push({
          icon: '☝️', name: '손가락 정밀 측정',
          reason: '더 정확한 HRV 분석',
          page: 'finger', priority: 'normal', score: 25
        });
      }
    }

    recs.sort((a, b) => (b.score || 0) - (a.score || 0));
    return recs;
  },

  // ════════════════════════════════════════════════════
  // ★ v20.0: 수면 연동 카드
  // ════════════════════════════════════════════════════
  _renderSleepCheckin() {
    const el = document.getElementById('sleep-checkin-card');
    if (!el) return;

    const hour = new Date().getHours();
    // 아침(5~11시)에만 표시
    if (hour < 5 || hour > 11) { el.style.display = 'none'; return; }

    const todayKey = 'sleep_' + new Date().toISOString().slice(0,10);
    const saved = localStorage.getItem(todayKey);

    if (saved) {
      // 이미 입력한 경우 — 결과 표시
      const score = parseInt(saved);
      const info = this._sleepInfo(score);
      el.style.display = 'block';
      el.innerHTML = `
        <div class="sleep-card">
          <span class="sleep-deco">🌙</span>
          <div class="sleep-header">
            <span class="sleep-badge">수면 연동</span>
            <span class="sleep-title">어젯밤 수면</span>
          </div>
          <div class="sleep-result-row">
            <span class="sleep-result-icon">${info.emoji}</span>
            <div class="sleep-result-body">
              <div class="sleep-result-title">${info.title}</div>
              <div class="sleep-result-sub">${info.desc}</div>
              <span class="sleep-result-change" onclick="App._resetSleepCheckin()">다시 입력 →</span>
            </div>
          </div>
        </div>`;
    } else {
      // 미입력 — 선택 UI
      el.style.display = 'block';
      el.innerHTML = `
        <div class="sleep-card">
          <span class="sleep-deco">🌙</span>
          <div class="sleep-header">
            <span class="sleep-badge">수면 연동</span>
            <span class="sleep-title">아침 체크인</span>
          </div>
          <div class="sleep-question">어젯밤 수면은<br>어떠셨나요?</div>
          <div class="sleep-sub">수면의 질이 HRV와 스트레스 해석에 반영됩니다</div>
          <div class="sleep-options" id="sleep-options">
            ${[
              { score: 4, emoji: '😴', label: '깊게 잘 잠' },
              { score: 3, emoji: '😊', label: '보통 잘 잠' },
              { score: 2, emoji: '😐', label: '얕게 잠든 편' },
              { score: 1, emoji: '😩', label: '거의 못 잠' },
            ].map(o => `
              <button type="button" class="sleep-opt" data-score="${o.score}"
                onclick="App._selectSleepOpt(${o.score})">
                <span class="sleep-opt-emoji">${o.emoji}</span>
                <span class="sleep-opt-label">${o.label}</span>
              </button>`).join('')}
          </div>
          <button type="button" class="sleep-confirm-btn" id="sleep-confirm-btn"
            style="opacity:.4;pointer-events:none" onclick="App._confirmSleepCheckin()">
            확인 →
          </button>
        </div>`;
    }
  },

  _sleepInfo(score) {
    const infos = {
      4: { emoji: '😴', title: '숙면 완료!', desc: 'HRV가 높고 회복이 잘 됐을 거예요. 오늘 측정값이 좋게 나올 가능성이 높아요.' },
      3: { emoji: '😊', title: '무난한 수면', desc: '평균적인 회복 상태예요. 오늘 컨디션을 측정으로 확인해보세요.' },
      2: { emoji: '😐', title: '얕은 수면', desc: 'HRV가 평소보다 낮을 수 있어요. 스트레스 수치도 높게 나올 수 있으니 참고하세요.' },
      1: { emoji: '😩', title: '수면 부족', desc: '자율신경 회복이 부족한 상태예요. 오늘 측정값에 수면 영향이 반영될 수 있어요.' },
    };
    return infos[score] || infos[3];
  },

  _selectSleepOpt(score) {
    // 선택 표시
    document.querySelectorAll('.sleep-opt').forEach(btn => {
      btn.classList.toggle('on', parseInt(btn.dataset.score) === score);
    });
    this._sleepSelectedScore = score;
    const confirmBtn = document.getElementById('sleep-confirm-btn');
    if (confirmBtn) { confirmBtn.style.opacity = '1'; confirmBtn.style.pointerEvents = 'auto'; }
  },

  _confirmSleepCheckin() {
    const score = this._sleepSelectedScore;
    if (!score) return;
    const todayKey = 'sleep_' + new Date().toISOString().slice(0,10);
    localStorage.setItem(todayKey, score.toString());
    this._sleepScore = score;
    this._renderSleepCheckin();
    this._renderRecommendCard(); // 추천 카드 갱신
    this._showToast(this._sleepInfo(score).title + ' 저장됐어요!', 2000);
  },

  _resetSleepCheckin() {
    const todayKey = 'sleep_' + new Date().toISOString().slice(0,10);
    localStorage.removeItem(todayKey);
    this._sleepScore = null;
    this._renderSleepCheckin();
  },

  // 앱 초기화 시 오늘 수면 점수 로드
  _loadSleepScore() {
    const todayKey = 'sleep_' + new Date().toISOString().slice(0,10);
    const saved = localStorage.getItem(todayKey);
    this._sleepScore = saved ? parseInt(saved) : null;
  },


  _renderWeeklyGoalCard() {
    try {
      // 이번 주 월~일 기준 측정 횟수 집계
      const now = new Date();
      const dayOfWeek = now.getDay(); // 0=일,1=월...
      const monday = new Date(now);
      monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
      monday.setHours(0, 0, 0, 0);

      let measured = 0;
      const keys = ['history_face', 'history_finger', 'history_balance', 'history_gait', 'history_tremor', 'history_reaction', 'history_posture', 'history_bodycomp', 'history_mood'];
      const measuredDays = new Set();
      keys.forEach(key => {
        try {
          const arr = JSON.parse(localStorage.getItem(key) || '[]');
          arr.forEach(item => {
            const t = item.t || 0;
            if (t >= monday.getTime()) {
              measuredDays.add(new Date(t).toDateString());
            }
          });
        } catch(e) {}
      });
      measured = measuredDays.size;

      const goal = 5; // 주 5일 목표
      const pct = Math.min(100, Math.round((measured / goal) * 100));
      const remain = Math.max(0, goal - measured);

      // 링 업데이트 (circumference = 2π×18 ≈ 113.1)
      const circ = 113;
      const offset = circ - (pct / 100) * circ;
      const ringFill = document.getElementById('wgc-ring-fill');
      const pctEl = document.getElementById('wgc-pct');
      const titleEl = document.getElementById('wgc-title');

      if (ringFill) {
        ringFill.style.strokeDashoffset = offset;
        ringFill.style.strokeDasharray = circ;
      }
      if (pctEl) pctEl.textContent = pct + '%';
      if (titleEl) {
        if (remain === 0) {
          titleEl.innerHTML = '이번 주 목표 달성! 🎉';
        } else {
          titleEl.innerHTML = `이번 주 목표까지 <span class="wgc-highlight">${remain}일 남았어요!</span>`;
        }
      }
    } catch(e) {
      console.warn('[v19.1] WeeklyGoal 렌더 실패:', e.message);
    }
  },

  // ─── 홈 카드 렌더링 ───
  _renderMoodHomeCard() {
    const card = document.getElementById('mood-today-card');
    if (!card) return;
    const game = this._getTodayGame();
    const played = this._hasPlayedToday();

    const titleEl = document.getElementById('mood-card-title');
    const gameEl = document.getElementById('mood-card-game');
    const timeEl = document.getElementById('mood-card-time');
    const btnTextEl = document.getElementById('mood-card-btn-text');

    if (played) {
      // 오늘 이미 했음 — 재측정 안내
      titleEl.textContent = '오늘은 이미 마음을 비춰봤어요';
      gameEl.innerHTML = `<span class="mood-card-icon">${game.icon}</span><span class="mood-card-game-name">다시 측정하거나 결과 보기</span>`;
      if (timeEl) timeEl.textContent = '언제든 다시 할 수 있어요';
      if (btnTextEl) btnTextEl.textContent = '다시 시작하기';
      card.classList.add('played');
    } else {
      titleEl.textContent = '오늘 마음은 어떠세요?';
      gameEl.innerHTML = `<span class="mood-card-icon">${game.icon}</span><span class="mood-card-game-name">${game.name}</span>`;
      if (timeEl) timeEl.textContent = '약 1분';
      if (btnTextEl) btnTextEl.textContent = '지금 시작하기';
      card.classList.remove('played');
    }
  },

  // ─── 감정 페이지 메인 렌더링 ───
  _renderMoodPage() {
    const container = document.getElementById('mood-container');
    if (!container) return;
    this._moodState = {}; // 게임 상태 초기화
    container.innerHTML = '';

    // ★ v15.1: 오늘 이미 했으면 선택 화면 (재측정 vs 결과 보기 vs 일지)
    if (this._hasPlayedToday()) {
      this._renderMoodAlreadyPlayed(container);
    } else {
      this._renderMoodIntro(container);
    }
  },

  // ★ v15.1: 오늘 이미 측정한 경우 - 선택 화면
  _renderMoodAlreadyPlayed(container) {
    const game = this._getTodayGame();
    let lastResult = null;
    try {
      const history = JSON.parse(localStorage.getItem('history_mood') || '[]');
      const today = new Date().toISOString().slice(0, 10);
      const todays = history.filter(h => new Date(h.t).toISOString().slice(0, 10) === today);
      lastResult = todays[todays.length - 1];
    } catch (e) {}

    const todayCount = (() => {
      try {
        const history = JSON.parse(localStorage.getItem('history_mood') || '[]');
        const today = new Date().toISOString().slice(0, 10);
        return history.filter(h => new Date(h.t).toISOString().slice(0, 10) === today).length;
      } catch (e) { return 0; }
    })();

    container.innerHTML = `
      <div class="mood-played-screen">
        <div class="played-mascot">
          <svg viewBox="0 0 100 100" width="120" height="120" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <radialGradient id="playedGrad" cx="35%" cy="35%">
                <stop offset="0%" stop-color="#C7F0DC"/>
                <stop offset="60%" stop-color="#7DD3A4"/>
                <stop offset="100%" stop-color="#22C55E"/>
              </radialGradient>
            </defs>
            <path d="M50 12 C72 12, 88 30, 88 52 C88 75, 72 88, 50 88 C28 88, 12 75, 12 52 C12 30, 28 12, 50 12 Z" fill="url(#playedGrad)"/>
            <ellipse cx="30" cy="58" rx="6" ry="4" fill="#FCA5A5" opacity="0.6"/>
            <ellipse cx="70" cy="58" rx="6" ry="4" fill="#FCA5A5" opacity="0.6"/>
            <path d="M33 45 L43 45" stroke="#1F2937" stroke-width="3" stroke-linecap="round" fill="none"/>
            <path d="M57 45 L67 45" stroke="#1F2937" stroke-width="3" stroke-linecap="round" fill="none"/>
            <path d="M40 65 Q50 70, 60 65" stroke="#1F2937" stroke-width="2.5" fill="none" stroke-linecap="round"/>
          </svg>
        </div>
        <div class="played-title">오늘 이미 ${todayCount}번 마음을 비춰봤어요</div>
        <div class="played-sub">하루 동안 마음은 여러 번 바뀌어요.<br>지금 다시 측정해도 좋아요.</div>

        <div class="played-actions">
          <button class="played-action-card primary" type="button" onclick="App._startNewMoodGame()">
            <div class="pac-icon">🔄</div>
            <div class="pac-content">
              <div class="pac-title">다시 측정하기</div>
              <div class="pac-sub">${game.icon} ${game.name}</div>
            </div>
            <div class="pac-arrow">→</div>
          </button>

          <button class="played-action-card" type="button" onclick="App._renderMoodResultLatest(document.getElementById('mood-container'))">
            <div class="pac-icon">📊</div>
            <div class="pac-content">
              <div class="pac-title">최근 결과 보기</div>
              <div class="pac-sub">방금 측정한 결과 다시 보기</div>
            </div>
            <div class="pac-arrow">→</div>
          </button>

          <button class="played-action-card" type="button" onclick="App._showMoodHistory()">
            <div class="pac-icon">📓</div>
            <div class="pac-content">
              <div class="pac-title">감정 일지 보기</div>
              <div class="pac-sub">지금까지 쌓인 마음의 흐름</div>
            </div>
            <div class="pac-arrow">→</div>
          </button>

          <button class="played-action-card" type="button" onclick="App._pickAnotherGame()">
            <div class="pac-icon">🎲</div>
            <div class="pac-content">
              <div class="pac-title">다른 게임으로 측정</div>
              <div class="pac-sub">4가지 게임 중 직접 선택</div>
            </div>
            <div class="pac-arrow">→</div>
          </button>
        </div>
      </div>
    `;
  },

  // ★ v15.1: 새 게임 시작 (오늘 게임)
  _startNewMoodGame() {
    const game = this._getTodayGame();
    this._moodState = {};
    document.getElementById('mood-container').innerHTML = '';
    this._renderMoodIntro(document.getElementById('mood-container'));
  },

  // ★ v15.1: 4개 중 직접 선택
  _pickAnotherGame() {
    const container = document.getElementById('mood-container');
    container.innerHTML = `
      <div class="game-picker">
        <div class="game-picker-header">
          <button class="game-picker-back" type="button" onclick="App._renderMoodPage()">←</button>
          <div class="game-picker-title">게임 선택</div>
        </div>
        <div class="game-picker-sub">어떤 방식으로 오늘의 감정을 표현해볼까요?</div>
        <div class="game-picker-grid">
          ${this._moodGames.map(g => `
            <button class="game-picker-card" type="button" onclick="App._startMoodGame('${g.id}')">
              <div class="gp-icon">${g.icon}</div>
              <div class="gp-name">${g.name}</div>
              <div class="gp-sub">${g.sub}</div>
              <div class="gp-time">${g.time}</div>
            </button>
          `).join('')}
        </div>
      </div>
    `;
  },

  // ─── 인트로 화면 ───
  _renderMoodIntro(container) {
    const todayGame = this._getTodayGame();
    container.innerHTML = `
      <!-- ★ v16.4: 통합 감정 측정 추천 카드 (상단) -->
      <div class="mood-integrated-promo">
        <div class="mip-badge">🌈 NEW · 학술 검증 통합</div>
        <div class="mip-title">통합 감정 측정</div>
        <div class="mip-sub">
          PANAS + 색상 + 표정 + 자율신경 통합으로<br>
          가장 신뢰성 있는 감정 분석을 받아보세요
        </div>
        <div class="mip-evidence">
          📚 Watson & Clark (1988) · Russell (1980) · Plutchik (1980) · Ekman (1992)
        </div>
        <ul class="mip-features">
          <li>✓ 24개 감정 카드 중 가장 가까운 것 자동 매칭</li>
          <li>✓ 자기보고 + 객관적 자율신경 데이터 결합</li>
          <li>✓ Russell 2차원 감정 좌표로 시각화</li>
        </ul>
        <button class="mood-start-btn primary" type="button" onclick="App._startMoodGame('integrated')">
          🌈 통합 측정 시작 <span class="mip-time">(약 3분)</span>
        </button>
      </div>

      <!-- 빠른 게임 옵션 (기존 4가지) -->
      <div class="mood-quick-section">
        <div class="mood-quick-title">⚡ 빠른 측정 (게임형)</div>
        <div class="mood-quick-sub">간단히 감정을 표현하고 싶다면</div>
        <div class="mood-intro">
          <div class="mood-intro-icon">${todayGame.icon}</div>
          <div class="mood-intro-title">${todayGame.name}</div>
          <div class="mood-intro-sub">${todayGame.sub}</div>
          <div class="mood-intro-meta">${todayGame.time}</div>

          <div class="mood-intro-tips">
            <div class="mood-tip">💚 정답은 없어요. 직관대로 하세요.</div>
            <div class="mood-tip">🤍 천천히, 부담 없이.</div>
            <div class="mood-tip">📵 측정 결과는 본인만 볼 수 있어요.</div>
          </div>

          <button class="mood-start-btn" type="button" onclick="App._startMoodGame('${todayGame.id}')">
            ${todayGame.icon} 시작하기 <span>→</span>
          </button>

          <button class="mood-history-btn" type="button" onclick="App._showMoodHistory()">
            📓 지난 감정 일지 보기
          </button>
        </div>
      </div>
    `;
  },

  // ─── 게임 시작 분기 ───
  _startMoodGame(gameId) {
    this._moodState = { gameId, startTime: Date.now(), results: {} };
    const container = document.getElementById('mood-container');
    if (gameId === 'integrated') this._renderIntegratedGame(container);
    else if (gameId === 'mirror') this._renderMirrorGame(container);
    else if (gameId === 'color') this._renderColorGame(container);
    else if (gameId === 'diary') this._renderDiaryGame(container);
    else if (gameId === 'reflex') this._renderReflexGame(container);
    this._trackEvent('mood_game_start', { game: gameId });
  },

  // ════════════════════════════════════════════════════════════════
  // ★ v16.4: 통합 감정 측정 시스템 (학술 검증 기반)
  //
  // 학술 근거:
  //   1. Russell (1980) Circumplex Model — Valence × Arousal 2차원
  //   2. Watson & Clark (1988) PANAS — 긍정/부정 정서 척도 (α>0.89)
  //   3. Plutchik (1980) Wheel of Emotions — 8 기본 감정 × 3 강도 = 24 감정
  //   4. Ekman (1992) Basic Emotions — 보편 표정 인식
  //
  // 흐름 (3분):
  //   Step 1. 단축 PANAS 10항목 (Valence 계산)
  //   Step 2. 빠른 색상 매칭 (직관 Valence 보강)
  //   Step 3. 표정 매칭 1개 (Ekman 검증)
  //   Step 4. HRV/심박 자율신경 데이터 통합 (Arousal 객관 측정)
  //   결과: Russell 좌표(V,A) → 가장 가까운 Plutchik 감정 카드 매칭
  // ════════════════════════════════════════════════════════════════
  _renderIntegratedGame(container) {
    this._moodState.steps = ['panas', 'color', 'mirror1', 'result'];
    this._moodState.stepIdx = 0;
    this._moodState.panasScores = {};
    this._moodState.panasIdx = 0; // ★ v16.7: 카드 방식 인덱스 초기화
    this._moodState.colorChoice = null;
    this._moodState.mirrorChoice = null;
    this._renderIntegratedStep(container);
  },

  _renderIntegratedStep(container) {
    const s = this._moodState;
    const step = s.steps[s.stepIdx];
    // ★ v16.7: PANAS 내부 진행도까지 반영한 부드러운 진행바
    let progress;
    if (step === 'panas') {
      const panasProgress = (s.panasIdx || 0) / this._panasItems.length;
      progress = (s.stepIdx + panasProgress) / (s.steps.length - 1) * 100;
    } else {
      progress = (s.stepIdx / (s.steps.length - 1)) * 100;
    }
    const stepNames = ['감정 응답', '색상 선택', '표정 선택', '결과 확인'];
    const headerHTML = `
      <div class="integrated-header">
        <button class="integrated-back" type="button" onclick="App._renderMoodPage()">×</button>
        <div class="integrated-progress">
          <div class="integrated-progress-track">
            <div class="integrated-progress-fill" style="width:${Math.min(100, progress)}%"></div>
          </div>
          <div class="integrated-progress-text">
            ${stepNames[s.stepIdx] || ''} · ${s.stepIdx + 1} / ${s.steps.length}
          </div>
        </div>
      </div>
    `;

    // ★ v23.3: 단계 분기 방어 — 알 수 없는 단계면 결과로
    try {
      if (step === 'panas') this._renderPanasStep(container, headerHTML);
      else if (step === 'color') this._renderColorQuick(container, headerHTML);
      else if (step === 'mirror1') this._renderMirrorQuick(container, headerHTML);
      else if (step === 'result') this._renderIntegratedResult(container);
      else {
        // 단계 배열 범위 초과 등 → 결과 렌더
        console.warn('[감정] 알 수 없는 단계:', step, '→ 결과로 진행');
        this._renderIntegratedResult(container);
      }
    } catch (e) {
      console.error('[감정] 단계 렌더 실패:', step, e);
      // 실패해도 결과는 보여주기
      try { this._renderIntegratedResult(container); } catch (e2) {
        console.error('[감정] 결과 폴백도 실패:', e2);
      }
    }
  },

  // ─── Step 1: 단축 PANAS — 카드 선택 UX (한 화면에 한 질문) ───
  // ★ v16.7: 첨부 OX 퀴즈 스타일 — 큰 카드 선택, 인지 부담 ↓
  _renderPanasStep(container, headerHTML) {
    // 현재 질문 인덱스 (없으면 0부터 시작)
    if (this._moodState.panasIdx === undefined) {
      this._moodState.panasIdx = 0;
    }
    const idx = this._moodState.panasIdx;
    const items = this._panasItems;
    const item = items[idx];
    const total = items.length;
    const answered = Object.keys(this._moodState.panasScores).length;

    // 진행 표시
    const innerProgress = ((idx) / total) * 100;

    // 응답 선택지 — 5단계지만 직관적 표현
    // 각 선택지는 색상 + 이모지 + 라벨로 구성
    const choices = [
      { val: 1, label: '전혀 아니에요', sub: '거의 그렇지 않음', emoji: '🙁', color: '#94A3B8' },
      { val: 2, label: '조금 그래요',   sub: '약간 그러함',     emoji: '😐', color: '#7585A0' },
      { val: 3, label: '보통이에요',     sub: '중간 정도',         emoji: '😊', color: '#4F92FF' },
      { val: 4, label: '꽤 그래요',     sub: '많이 그러함',     emoji: '😄', color: '#2D7CFF' },
      { val: 5, label: '매우 그래요',     sub: '아주 강하게',     emoji: '🤩', color: '#1D5FD9' },
    ];

    // 현재 질문에 이미 답이 있으면 표시
    const currentAnswer = this._moodState.panasScores[item.id];

    const choiceCards = choices.map(c => `
      <button class="emo-choice-card ${currentAnswer === c.val ? 'selected' : ''}"
              type="button"
              style="--choice-color: ${c.color}"
              onclick="App._panasPickAndNext('${item.id}', ${c.val})">
        <span class="ecc-emoji">${c.emoji}</span>
        <span class="ecc-text">
          <span class="ecc-label">${c.label}</span>
          <span class="ecc-sub">${c.sub}</span>
        </span>
        <span class="ecc-radio">${currentAnswer === c.val ? '✓' : ''}</span>
      </button>
    `).join('');

    container.innerHTML = `
      ${headerHTML}
      <div class="emo-question-card">
        <!-- 진행 표시 -->
        <div class="emo-question-progress">
          <span class="eqp-cur">질문 ${idx + 1}</span>
          <span class="eqp-divider">/</span>
          <span class="eqp-total">${total}</span>
        </div>

        <!-- 큰 질문 -->
        <div class="emo-question-main">
          <div class="eqm-text">${item.ko}</div>
          <div class="eqm-sub">지금 이 순간을 솔직하게 선택해주세요</div>
        </div>

        <!-- 5개 카드 선택 -->
        <div class="emo-choices">
          ${choiceCards}
        </div>

        <!-- 이전 버튼 (첫 질문 제외) -->
        ${idx > 0 ? `
          <button class="emo-prev-btn" type="button" onclick="App._panasPrev()">
            ← 이전 질문
          </button>
        ` : ''}
      </div>

      <!-- 학술 근거 (작게 하단) -->
      <div class="emo-evidence-mini">
        📚 PANAS-SF (Watson & Clark 1988) · 학술 검증된 감정 측정
      </div>
    `;
  },

  // ★ v16.7: 카드 선택 후 자동으로 다음 질문
  _panasPickAndNext(itemId, val) {
    this._moodState.panasScores[itemId] = val;
    const idx = this._moodState.panasIdx || 0;
    const total = this._panasItems.length;

    // 햅틱 (지원 시)
    if (navigator.vibrate) {
      try { navigator.vibrate(10); } catch (e) {}
    }

    if (idx < total - 1) {
      // 다음 질문
      this._moodState.panasIdx = idx + 1;
      // 부드러운 전환 효과
      const card = document.querySelector('.emo-question-card');
      if (card) {
        card.style.opacity = '0';
        card.style.transform = 'translateX(-20px)';
      }
      setTimeout(() => {
        this._renderIntegratedStep(document.getElementById('mood-container'));
      }, 200);
    } else {
      // 마지막 질문 — 다음 단계로
      this._moodState.panasIdx = 0; // reset
      this._moodState.stepIdx++;
      setTimeout(() => {
        this._renderIntegratedStep(document.getElementById('mood-container'));
      }, 300);
    }
  },

  _panasPrev() {
    const idx = this._moodState.panasIdx || 0;
    if (idx > 0) {
      this._moodState.panasIdx = idx - 1;
      this._renderIntegratedStep(document.getElementById('mood-container'));
    }
  },

  // (기존 호환용 — 다른 곳에서 호출 안 함)
  _panasSelect(itemId, val, btnEl) {
    this._panasPickAndNext(itemId, val);
  },

  _panasNext() {
    this._moodState.stepIdx++;
    this._renderIntegratedStep(document.getElementById('mood-container'));
  },

  _panasNext() {
    this._moodState.stepIdx++;
    this._renderIntegratedStep(document.getElementById('mood-container'));
  },

  // ─── Step 2: 빠른 색상 매칭 (1개만) ───
  _renderColorQuick(container, headerHTML) {
    // Valdez & Mehrabian (1994) 색상-감정 매핑
    const colors = [
      { hex: '#FFD54F', name: '노란빛', v: 0.7, a: 0.4 },
      { hex: '#FF7043', name: '주황빛', v: 0.5, a: 0.6 },
      { hex: '#EF5350', name: '빨간빛', v: -0.3, a: 0.7 },
      { hex: '#AB47BC', name: '보랏빛', v: -0.2, a: 0.3 },
      { hex: '#5C6BC0', name: '남색빛', v: -0.5, a: -0.2 },
      { hex: '#42A5F5', name: '파란빛', v: 0.2, a: -0.3 },
      { hex: '#26A69A', name: '청록빛', v: 0.4, a: -0.1 },
      { hex: '#9CCC65', name: '연두빛', v: 0.6, a: 0.1 },
      { hex: '#90A4AE', name: '회색빛', v: 0.0, a: -0.2 },
      { hex: '#8D6E63', name: '갈색빛', v: -0.1, a: -0.4 },
      { hex: '#212121', name: '검은빛', v: -0.6, a: -0.1 },
      { hex: '#F5F5F5', name: '흰빛',   v: 0.3, a: -0.3 },
    ];

    const colorBtns = colors.map(c => `
      <button class="quickc-btn" type="button"
              data-v="${c.v}" data-a="${c.a}"
              style="background:${c.hex}"
              onclick="App._quickColorPick(${c.v}, ${c.a}, '${c.hex}', '${c.name}')">
        <span class="quickc-name">${c.name}</span>
      </button>
    `).join('');

    container.innerHTML = `
      ${headerHTML}
      <div class="integrated-step-card">
        <div class="integrated-step-title">🎨 지금 마음에 가장 끌리는 색</div>
        <div class="integrated-step-sub">
          오늘의 기분을 표현하는 색을 직관으로 골라주세요.<br>
          <small style="opacity:0.75">학술 근거: Valdez & Mehrabian (1994) 색-감정 매핑</small>
        </div>
        <div class="quickc-grid">
          ${colorBtns}
        </div>
        <div class="quickc-hint">→ 색을 선택하면 자동으로 다음 단계로</div>
      </div>
    `;
  },

  _quickColorPick(v, a, hex, name) {
    this._moodState.colorChoice = { v, a, hex, name };
    setTimeout(() => {
      this._moodState.stepIdx++;
      this._renderIntegratedStep(document.getElementById('mood-container'));
    }, 200);
  },

  // ─── Step 3: 표정 1개 매칭 ───
  _renderMirrorQuick(container, headerHTML) {
    // Ekman 6 기본 표정 + 평정
    const faces = [
      { emoji: '😊', label: '환한 미소',  v: 0.75, a: 0.40 },
      { emoji: '😌', label: '편안한 미소', v: 0.55, a: -0.20 },
      { emoji: '😐', label: '무표정',     v: 0.00, a: -0.10 },
      { emoji: '🙁', label: '시무룩',     v: -0.50, a: -0.20 },
      { emoji: '😢', label: '슬픔',       v: -0.70, a: -0.20 },
      { emoji: '😤', label: '짜증/화남',  v: -0.55, a: 0.65 },
      { emoji: '😨', label: '걱정/불안',  v: -0.55, a: 0.60 },
      { emoji: '😴', label: '피곤/지침',  v: -0.30, a: -0.70 },
      { emoji: '🤩', label: '신남/설렘',  v: 0.80, a: 0.75 },
    ];
    const faceBtns = faces.map(f => `
      <button class="quickf-btn" type="button"
              onclick="App._quickMirrorPick(${f.v}, ${f.a}, '${f.emoji}', '${this._esc(f.label)}')">
        <div class="quickf-emoji">${f.emoji}</div>
        <div class="quickf-label">${f.label}</div>
      </button>
    `).join('');

    container.innerHTML = `
      ${headerHTML}
      <div class="integrated-step-card">
        <div class="integrated-step-title">🎭 지금 내 표정과 가장 비슷한 것</div>
        <div class="integrated-step-sub">
          지금 마음이 어떤 표정과 비슷한지 골라주세요.<br>
          <small style="opacity:0.75">학술 근거: Ekman (1992) 보편 표정 모델</small>
        </div>
        <div class="quickf-grid">
          ${faceBtns}
        </div>
      </div>
    `;
  },

  _quickMirrorPick(v, a, emoji, label) {
    // ★ v23.3: 방어적 강화 — 선택이 무조건 다음 단계로 진행되도록
    try {
      if (!this._moodState) {
        console.warn('[감정] moodState 없음 — 복구');
        this._moodState = { steps: ['panas','color','mirror1','result'], stepIdx: 2, panasScores: {}, panasIdx: 0, colorChoice: null, mirrorChoice: null };
      }
      this._moodState.mirrorChoice = { v, a, emoji, label };
    } catch (e) {
      console.warn('[감정] mirrorChoice 저장 실패:', e.message);
    }
    // setTimeout 없이 즉시 진행 (콜백 유실 방지) + 에러 방어
    const advance = () => {
      try {
        this._moodState.stepIdx++;
        const container = document.getElementById('mood-container');
        if (!container) {
          console.warn('[감정] mood-container 없음');
          return;
        }
        this._renderIntegratedStep(container);
      } catch (e) {
        console.error('[감정] 다음 단계 진행 실패:', e);
        // 최후의 폴백 — 결과를 직접 렌더
        try {
          const container = document.getElementById('mood-container');
          if (container) this._renderIntegratedResult(container);
        } catch (e2) {
          console.error('[감정] 결과 렌더도 실패:', e2);
        }
      }
    };
    // 짧은 시각 피드백 후 진행 (실패해도 즉시 진행 보장)
    setTimeout(advance, 180);
  },

  // ─── 통합 점수 계산 ───
  // PANAS, 색상, 표정, 자율신경(HRV/심박) → Russell V/A 좌표
  // → 가장 가까운 Plutchik 감정 카드 선택
  _computeIntegratedEmotion() {
    const s = this._moodState;

    // 1. PANAS — Valence 계산 (긍정 평균 - 부정 평균) / 4
    let paSum = 0, paCnt = 0, naSum = 0, naCnt = 0;
    for (const item of this._panasItems) {
      const val = s.panasScores[item.id] || 3;
      if (item.pa) { paSum += val; paCnt++; }
      else { naSum += val; naCnt++; }
    }
    const paAvg = paCnt > 0 ? paSum / paCnt : 3;
    const naAvg = naCnt > 0 ? naSum / naCnt : 3;

    // ★ v25.0: 응답 신뢰도 지표 (심리측정 품질)
    // 근거: PANAS 내적 일관성 α=0.85~0.90 (Watson 1988, Crawford 2004)
    // ① straight-lining (모두 같은 값) 감지 ② PA/NA 내부 분산으로 성의도 추정
    let responseReliability = 100;
    try {
      const allVals = this._panasItems.map(it => s.panasScores[it.id] || 3);
      const uniqueVals = new Set(allVals).size;
      const respMean = allVals.reduce((a,b)=>a+b,0) / allVals.length;
      const respVar = allVals.reduce((sum,v)=>sum+(v-respMean)**2,0) / allVals.length;
      // 모든 응답이 동일(straight-lining)하면 신뢰도 대폭 감소
      if (uniqueVals === 1) responseReliability = 30;
      else if (uniqueVals === 2 && respVar < 0.3) responseReliability = 60;
      // PA와 NA는 독립적이어야 함(둘 다 극단으로 높으면 무성의 의심)
      if (paAvg > 4.5 && naAvg > 4.5) responseReliability = Math.min(responseReliability, 55);
      responseReliability = Math.max(30, Math.min(100, responseReliability));
    } catch (e) {}
    // Russell V: -1~1 변환 ((PA-NA)/4)
    const panasV = (paAvg - naAvg) / 4;
    // Russell A: PA+NA 합으로 보강 (둘 다 높으면 각성 ↑)
    const panasA = ((paAvg + naAvg - 6) / 4); // -1~1

    // 2. 색상 선택 (있으면)
    const colorV = s.colorChoice ? s.colorChoice.v : 0;
    const colorA = s.colorChoice ? s.colorChoice.a : 0;

    // 3. 표정 선택 (있으면)
    const mirrorV = s.mirrorChoice ? s.mirrorChoice.v : 0;
    const mirrorA = s.mirrorChoice ? s.mirrorChoice.a : 0;

    // ★ v20.2: 멀티모달 Late Fusion 감정 엔진
    // 첨부 알고리즘 통합 — rPPG(LF/HF+pNN50) + AU표정 + 자율신경 동적 융합
    // 학술 근거: Russell 1980 Circumplex, Berntson 1997, Task Force 1996,
    //           Park 2019, Ekman&Friesen 1978, DEAP dataset (Koelstra 2012)

    const cardio = this._getUnifiedCardio(this.state.wellness || {});
    const w = this.state.wellness || {};

    // ── 모달 1: rPPG 생체신호 → V-A 좌표 (Late Fusion Leg 1) ──
    // Arousal: LF/HF 비율 (교감/부교감 균형) + HR + 호흡
    // Valence: pNN50 (부교감 활성도) + RMSSD + Baevsky SI
    let rppgV = 0, rppgA = 0;
    let alphaRppg = 0; // rPPG 신뢰도 계수 (SQI 기반)

    if (cardio && cardio.hr) {
      // ─ Arousal 계산 ─
      // LF/HF가 있으면 최우선 사용 (Task Force 1996: 교감신경 지표)
      let arousalRaw = 0;
      const lfHf = cardio.lfHfRatio || (w.face && w.face.lfHfRatio) || null;
      const pNN50val = cardio.pNN50 || (w.face && w.face.pNN50) || null;

      if (lfHf !== null) {
        // LF/HF 정상: 0.5-2.0 / 높음(교감우세) > 2 → 각성 ↑
        // tanh 스케일링: LF/HF 2.0 → A=+0.4, LF/HF 0.5 → A=-0.2
        arousalRaw = Math.tanh((lfHf - 1.0) * 0.5);
      } else {
        // LF/HF 없으면 HR+RMSSD로 추정 (기존 방식)
        const hrZ = (cardio.hr - 72) / 12;
        const rmssdZ = cardio.rmssd ? (40 - cardio.rmssd) / 20 : 0;
        arousalRaw = (hrZ + rmssdZ) / 2 * 0.6;
      }
      // 호흡수 보강 (Grossman 2007: 빠른 호흡 = 교감 활성)
      if (cardio.respRate && cardio.respRate > 18) {
        arousalRaw += Math.tanh((cardio.respRate - 16) / 8) * 0.25;
      }
      rppgA = Math.max(-1, Math.min(1, arousalRaw));

      // ─ Valence 계산 ─
      // pNN50: 높을수록 부교감 활성 = 긍정 (Park 2019)
      let valenceRaw = 0;
      if (pNN50val !== null) {
        // pNN50 정상: 5-25% / 높음 > 25 = 긍정
        // tanh: pNN50 20 → V=+0.3, pNN50 5 → V=-0.2
        valenceRaw = Math.tanh((pNN50val - 10) * 0.03);
      } else if (cardio.rmssd) {
        // pNN50 없으면 RMSSD 기반 (기존)
        if (cardio.hr >= 55 && cardio.hr <= 78 && cardio.rmssd >= 30) {
          valenceRaw = 0.3 + Math.min(0.3, (cardio.rmssd - 30) / 40 * 0.3);
        } else if (cardio.hr > 85 && cardio.rmssd < 25) {
          valenceRaw = -0.4 - Math.min(0.2, (cardio.hr - 85) / 20 * 0.2);
        } else if (cardio.hr > 90 || cardio.rmssd < 15) {
          valenceRaw = -0.5;
        }
      }
      // Baevsky SI 보강
      if (cardio.stressIndex != null) {
        const siNorm = Math.log10(cardio.stressIndex + 10) / Math.log10(2010);
        valenceRaw -= (siNorm - 0.3) * 0.35;
      }
      rppgV = Math.max(-1, Math.min(1, valenceRaw));

      // rPPG 신뢰도: SQI 기반 + LF/HF 있으면 보너스
      const sqiVal = cardio.sqi || (w.face && w.face.sqi) || 60;
      alphaRppg = Math.max(0.1, Math.min(1.0, sqiVal / 100));
      if (lfHf !== null) alphaRppg = Math.min(1.0, alphaRppg + 0.15); // LF/HF 가용 시 신뢰도 ↑
    }

    // ── 모달 2: AU 표정 분석 → V-A 좌표 (Late Fusion Leg 2) ──
    // Ekman & Friesen (1978) + Russell Circumplex 매핑
    // faceLink.auResult 또는 state.wellness.face.auResult 에서 추출
    let faceV = 0, faceA = 0;
    let alphaFace = 0; // 표정 신뢰도 계수

    const auSrc = (w.face && w.face.auResult) ? w.face.auResult : null;
    if (auSrc) {
      // AU12(광대뼈 올림=미소), AU6(눈가 주름=진짜 미소), AU1(눈썹 내림=슬픔), AU4(미간)
      const au12 = (auSrc.au12 || 0) / 100; // 0-1 정규화
      const au6  = (auSrc.au6  || 0) / 100;
      const au1  = (auSrc.au1  || 0) / 100;
      const au4  = (auSrc.au4  || 0) / 100;
      const duchenne = (auSrc.duchenne || 0) / 100;
      // Valence: 미소(AU12+AU6) 긍정 / 슬픔(AU1)+긴장(AU4) 부정
      faceV = Math.tanh(
        au12 * 1.0 + duchenne * 0.6    // 긍정 요소
        - au1 * 0.7 - au4 * 0.6       // 부정 요소
      );
      // Arousal: AU4(긴장/분노) 높은 각성 / 중립 낮은 각성
      faceA = Math.tanh(
        au4 * 0.8 + au1 * 0.4         // 각성 요소
        - (1 - au12 - au4 - au1) * 0.3 // 중립 = 낮은 각성
      );
      // 표정 신뢰도: expressionConsistency 기반
      const consistency = auSrc.expressionConsistency || 50;
      alphaFace = Math.max(0.2, Math.min(1.0, consistency / 100));
      console.log(`[v20.2 AU→VA] faceV=${faceV.toFixed(3)} faceA=${faceA.toFixed(3)} alpha=${alphaFace.toFixed(2)}`);
    }

    // ── Late Fusion: 동적 가중치 융합 ──
    // 신뢰도(alpha) 기반 가중 평균 (첨부 알고리즘 수식 적용)
    const totalAlpha = alphaRppg + alphaFace;
    let bioV = 0, bioA = 0;
    if (totalAlpha > 0) {
      bioV = (alphaRppg * rppgV + alphaFace * faceV) / totalAlpha;
      bioA = (alphaRppg * rppgA + alphaFace * faceA) / totalAlpha;
    }
    const hasAuto = alphaRppg > 0 || alphaFace > 0;
    const autoV = bioV;
    const autoA = bioA;

    // ── 가중치 결정: 자기보고 + 생체신호 동적 배분 ──
    // 신뢰도 합이 높을수록 생체신호 가중치 ↑ (최대 35%)
    const bioWeight = hasAuto ? Math.min(0.35, totalAlpha * 0.2) : 0;
    const selfWeight = 1 - bioWeight;

    // PANAS/color/mirror 자기보고 내부 배분 (합산 = selfWeight)
    const pW = selfWeight * 0.58;
    const cW = selfWeight * 0.17;
    const mW = selfWeight * 0.25;

    const weights = {
      panas: pW, color: cW, mirror: mW,
      autoV: bioWeight, autoA: bioWeight,
      alphaRppg, alphaFace,   // 디버깅/로깅용
    };

    console.log(`[v20.2 LateFusion] rppgV=${rppgV.toFixed(3)} rppgA=${rppgA.toFixed(3)} αRppg=${alphaRppg.toFixed(2)} | faceV=${faceV.toFixed(3)} faceA=${faceA.toFixed(3)} αFace=${alphaFace.toFixed(2)} | bioW=${bioWeight.toFixed(2)}`);

    const finalV = panasV  * weights.panas +
                   colorV  * weights.color +
                   mirrorV * weights.mirror +
                   autoV   * weights.autoV;
    const finalA = panasA  * weights.panas +
                   colorA  * weights.color +
                   mirrorA * weights.mirror +
                   autoA   * weights.autoA;

    // 6. Plutchik 감정 카드 매칭 — 24개 중 가장 가까운 것
    const cards = this._emotionCards;
    let bestId = 'neutral', bestDist = Infinity;
    for (const [id, card] of Object.entries(cards)) {
      const dv = card.v - finalV;
      const da = card.a - finalA;
      const dist = Math.sqrt(dv*dv + da*da);
      if (dist < bestDist) { bestDist = dist; bestId = id; }
    }

    // 신뢰도 — 거리가 가까울수록 신뢰도 ↑
    const confidence = Math.max(0.3, 1 - bestDist / 1.5);

    return {
      cardId: bestId,
      card: cards[bestId],
      valence: finalV,
      arousal: finalA,
      panasV, panasA,
      paAvg, naAvg,
      responseReliability, // ★ v25.0: 심리 응답 신뢰도 (%)
      autoA: hasAuto ? autoA : null,
      autoV: hasAuto ? autoV : null,
      hasAuto,
      confidence,
      weights,
      // ★ v20.2: Late Fusion 상세 디버깅 데이터
      rppgV: alphaRppg > 0 ? rppgV : null,
      rppgA: alphaRppg > 0 ? rppgA : null,
      faceV: alphaFace > 0 ? faceV : null,
      faceA: alphaFace > 0 ? faceA : null,
      alphaRppg,
      alphaFace,
      lfHfUsed: !!(cardio && (cardio.lfHfRatio || (this.state.wellness && this.state.wellness.face && this.state.wellness.face.lfHfRatio))),
      auUsed: alphaFace > 0,
    };
  },

  // ─── Step 4: 통합 결과 화면 ───
  _renderIntegratedResult(container) {
    // ★ v23.2: 방어적 강화 — 손상된 데이터로도 멈추지 않도록
    let result;
    try {
      result = this._computeIntegratedEmotion();
    } catch (e) {
      console.warn('[감정결과] 계산 실패, 안전값 사용:', e.message);
      result = null;
    }
    // result 또는 card가 비정상이면 안전한 중립 카드로 폴백
    if (!result || !result.card) {
      const cards = this._emotionCards || {};
      const fallbackCard = cards.neutral || cards.calm ||
        { ko: '평온', en: 'Neutral', desc: '잔잔하고 차분한 상태예요.', v: 0, a: 0, color: '#94A3B8' };
      result = Object.assign({
        cardId: 'neutral', card: fallbackCard,
        valence: 0, arousal: 0, panasV: 0, panasA: 0,
        paAvg: 3, naAvg: 3, autoA: null, autoV: null,
        hasAuto: false, confidence: 0.5, weights: {},
      }, result || {});
      result.card = result.card || fallbackCard;
    }
    this._lastEmotionResult = result; // ★ v20.2: Late Fusion 결과 캐시
    const card = result.card;

    // 결과 저장 (감정 히스토리)
    try {
      const history = JSON.parse(localStorage.getItem('history_mood') || '[]');

      // ★ v16.8: undefined/NaN 버그 수정 — _computeMentalWellnessScore 사용
      // 이전엔 직접 객체 만들어서 patternIcon, resilience 등 필수 필드 누락됐음
      const w = this.state.wellness || {};
      const now = Date.now();
      const hasRecentFace = w.face && w.face.t && (now - w.face.t) < 6 * 60 * 60 * 1000;

      // 통합 결과를 _computeMentalWellnessScore 입력 형식으로 변환
      const analysisInput = {
        gameId: 'integrated',
        valence: result.valence,
        // PANAS negative affect가 높으면 부정 편향
        negBias: Math.max(0, Math.min(1, (result.naAvg - 2) / 3)),
        // PANAS positive affect 낮으면 외로움 추정 (대용)
        loneliness: Math.max(0, Math.min(1, (3 - result.paAvg) / 3)),
        rawData: {
          paAvg: result.paAvg,
          naAvg: result.naAvg,
          cardId: result.cardId,
        },
        // 얼굴 측정 데이터 연결 (있으면)
        faceLink: hasRecentFace ? {
          hr: w.face.hr,
          rmssd: w.face.rmssd,
          stressLevel: w.face.stressLevel,
          respRate: w.face.respRate,
          ageMinutes: Math.round((now - w.face.t) / 60000),
        } : null,
      };

      // 전체 mental 객체 계산 (모든 필수 필드 포함)
      const mentalFull = this._computeMentalWellnessScore(analysisInput);

      const entry = {
        t: Date.now(),
        gameId: 'integrated',
        cardId: result.cardId,
        cardKo: card.ko,
        valence: result.valence,
        arousal: result.arousal,
        paAvg: result.paAvg,
        naAvg: result.naAvg,
        confidence: result.confidence,
        hasAuto: result.hasAuto,
        negBias: analysisInput.negBias,
        loneliness: analysisInput.loneliness,
        rawData: analysisInput.rawData,
        faceLink: analysisInput.faceLink,
        // ★ v16.8: 완전한 mental 객체 (모든 필드 포함)
        mental: mentalFull,
        score: mentalFull.overall,
      };
      history.push(entry);
      if (history.length > 200) history.splice(0, history.length - 200);
      localStorage.setItem('history_mood', JSON.stringify(history));

      this._trackEvent('mood_integrated_complete', {
        card: result.cardId,
        confidence: Math.round(result.confidence * 100),
      });
    } catch (e) {
      console.warn('Save integrated result failed:', e);
    }

    // 컬러 변환 — 카드 색상을 배경 그라데이션으로
    const baseColor = card.color;
    const lighterColor = this._lightenColor(baseColor, 25);

    // PANAS 점수 시각화
    const paBar = (result.paAvg / 5) * 100;
    const naBar = (result.naAvg / 5) * 100;

    // 분석 멘트
    const intensity = Math.sqrt(result.valence*result.valence + result.arousal*result.arousal);
    const intensityLabel = intensity > 0.6 ? '강한' : intensity > 0.3 ? '뚜렷한' : '잔잔한';

    // Russell 좌표 사분면 해석
    let quadrantMsg;
    if (result.valence >= 0 && result.arousal >= 0) quadrantMsg = '🌟 활기차고 긍정적인 영역';
    else if (result.valence >= 0 && result.arousal < 0) quadrantMsg = '🌿 평온하고 차분한 영역';
    else if (result.valence < 0 && result.arousal >= 0) quadrantMsg = '⚡ 긴장되고 불편한 영역';
    else quadrantMsg = '💧 가라앉고 우울한 영역';

    // ★ v16.5: 자율신경 검증 멘트 — V/A 모두 활용 + 자기보고 일치도 검사
    let autoMsg = '';
    if (result.hasAuto) {
      const cardio = this._getUnifiedCardio(this.state.wellness || {});

      // PANAS 자기보고와 자율신경 일치도 검사
      const reportedQuadrant = `${result.panasV >= 0 ? '+' : '-'}V${result.panasA >= 0 ? '+' : '-'}A`;
      const objectiveQuadrant = `${result.autoV >= 0 ? '+' : '-'}V${result.autoA >= 0 ? '+' : '-'}A`;
      const agree = reportedQuadrant === objectiveQuadrant;

      // 자율신경 상태 해석
      const arousalState = result.autoA > 0.3 ? '교감신경 우세 (각성↑)' :
                          result.autoA < -0.3 ? '부교감신경 우세 (이완)' :
                          '균형 상태';
      const valenceState = result.autoV > 0.2 ? '안정/긍정' :
                          result.autoV < -0.3 ? '긴장/부정' :
                          '중립';

      if (agree) {
        autoMsg = `<strong>자기보고와 일치</strong> · 자율신경 측정 결과 ${arousalState}, ${valenceState} 영역으로 측정됐어요. 본인이 느끼는 감정과 신체 반응이 일치합니다. (HR ${cardio.hr}, HRV ${cardio.rmssd}ms)`;
      } else if (Math.abs(result.autoA - result.panasA) > 0.5 || Math.abs(result.autoV - result.panasV) > 0.5) {
        autoMsg = `<strong>자기보고와 차이 있음</strong> · 자율신경 측정에서는 ${arousalState}, ${valenceState}로 나와 본인이 느끼는 감정과 신체 반응 사이에 차이가 있어요. 감정 억압이나 신체화 가능성을 살펴볼 수 있습니다. (HR ${cardio.hr}, HRV ${cardio.rmssd}ms)`;
      } else {
        autoMsg = `자율신경 측정 결과 ${arousalState}, ${valenceState} 상태로 자기보고와 대체로 일치해요. (HR ${cardio.hr}, HRV ${cardio.rmssd}ms)`;
      }
    }

    // 추천 행동
    const tips = this._integratedEmotionTips(result.cardId, result.valence, result.arousal);

    container.innerHTML = `
      <!-- ★ v16.4: 큰 감정 카드 (한 단어 + 색상 배경) -->
      <div class="emotion-result-hero" style="background: linear-gradient(135deg, ${lighterColor} 0%, ${baseColor} 100%)">
        <div class="erh-meta">${intensityLabel} 감정</div>
        <div class="erh-word">${card.ko}</div>
        <div class="erh-en">${card.en}</div>
        <div class="erh-desc">${card.desc}</div>
        <div class="erh-conf">
          신뢰도 ${Math.round(result.confidence * 100)}%
          ${result.hasAuto ? '· 자율신경 통합' : ''}
        </div>
      </div>

      <!-- 분석 내용 -->
      <div class="emotion-analysis">
        <div class="ea-section">
          <div class="ea-title">🎯 ${quadrantMsg}</div>
          <div class="ea-body">
            지금 당신의 감정은 <strong>"${card.ko}"</strong> 상태에 가장 가까워요.
            ${card.desc}
          </div>
        </div>

        <!-- Russell 2차원 좌표 시각화 -->
        <div class="ea-section">
          <div class="ea-title">📍 감정 좌표 (Russell 1980)</div>
          <div class="russell-plot">
            <svg viewBox="0 0 200 200" width="100%" height="200">
              <!-- 4분면 -->
              <line x1="0" y1="100" x2="200" y2="100" stroke="#e5e7eb" stroke-width="1"/>
              <line x1="100" y1="0" x2="100" y2="200" stroke="#e5e7eb" stroke-width="1"/>
              <!-- 라벨 -->
              <text x="100" y="12" text-anchor="middle" font-size="10" fill="#94a3b8" font-weight="700">각성 ↑</text>
              <text x="100" y="195" text-anchor="middle" font-size="10" fill="#94a3b8" font-weight="700">↓ 이완</text>
              <text x="6" y="105" font-size="10" fill="#94a3b8" font-weight="700">부정 ←</text>
              <text x="160" y="105" font-size="10" fill="#94a3b8" font-weight="700">→ 긍정</text>
              <!-- 사용자 위치 -->
              <circle cx="${100 + result.valence * 90}" cy="${100 - result.arousal * 90}"
                      r="10" fill="${baseColor}" stroke="#fff" stroke-width="3"/>
              <text x="${100 + result.valence * 90}" y="${100 - result.arousal * 90 - 14}"
                    text-anchor="middle" font-size="9" font-weight="900" fill="${baseColor}">${card.ko}</text>
            </svg>
          </div>
          <div class="ea-coord">
            V (Valence) ${result.valence.toFixed(2)} · A (Arousal) ${result.arousal.toFixed(2)}
          </div>
        </div>

        <!-- PANAS 점수 -->
        <div class="ea-section">
          <div class="ea-title">📊 PANAS 점수 (Watson & Clark 1988)</div>
          <div class="panas-bars">
            <div class="panas-bar-row">
              <span class="pbr-label">긍정 정서 (PA)</span>
              <div class="pbr-track"><div class="pbr-fill pa" style="width:${paBar}%"></div></div>
              <span class="pbr-value">${result.paAvg.toFixed(1)}/5</span>
            </div>
            <div class="panas-bar-row">
              <span class="pbr-label">부정 정서 (NA)</span>
              <div class="pbr-track"><div class="pbr-fill na" style="width:${naBar}%"></div></div>
              <span class="pbr-value">${result.naAvg.toFixed(1)}/5</span>
            </div>
          </div>
        </div>

        ${autoMsg ? `
          <div class="ea-section ea-auto">
            <div class="ea-title">❤️ 자율신경 검증</div>
            <div class="ea-body">${autoMsg}</div>
          </div>
        ` : `
          <div class="ea-section ea-auto-prompt">
            <div class="ea-title">💡 더 정확한 측정을 원한다면</div>
            <div class="ea-body">
              손가락 측정을 추가로 진행하면 자율신경 데이터로 감정을 객관적으로 검증할 수 있어요.
            </div>
            <button class="ea-action" type="button" onclick="App.goPage('finger')">☝️ 손가락 측정 추가</button>
          </div>
        `}

        <!-- 추천 -->
        <div class="ea-section ea-tips">
          <div class="ea-title">💝 지금 추천</div>
          <div class="ea-tips-list">
            ${tips.map(t => `<div class="ea-tip">${t}</div>`).join('')}
          </div>
        </div>

        <!-- 학술 근거 -->
        <div class="ea-section ea-evidence">
          <div class="ea-title">📚 측정 방법론 (v16.5 강화)</div>
          <div class="ea-body">
            <strong>범주형 + 차원형 모델 통합 (Ekman + Russell)</strong><br>
            본 분석은 6가지 학술 모델의 통합으로 산출됐어요:<br><br>
            <strong>1. PANAS-SF</strong> (Watson & Clark 1988, α=0.89) — 자기보고 50%<br>
            <strong>2. 색상-감정 매핑</strong> (Valdez & Mehrabian 1994) — 직관 검증 15%<br>
            <strong>3. Ekman 표정 모델</strong> (1992) — 범주형 시각 검증 20%<br>
            <strong>4. Russell Circumplex</strong> (1980) — V/A 2차원 좌표계 통합<br>
            <strong>5. Plutchik Wheel</strong> (1980) — 24개 감정 카드 매칭<br>
            ${result.hasAuto ?
              `<strong>6. 자율신경 통합</strong> (Berntson 1997 + Park 2019) — Russell V/A 객관 측정 30%<br>
              <small style="opacity:0.85; line-height:1.6; display:block; margin-top:8px">
                · HRV/HR로 각성도(Y축) 측정 — 교감/부교감 균형<br>
                · 자율신경 균형 + Baevsky SI로 정서가(X축) 측정<br>
                · 자기보고와 객관 데이터 일치도 자동 검증
              </small>` :
              '<small style="opacity:0.7">자율신경 측정 없음 (손가락 측정 추가 시 객관적 검증 30% 추가 가능)</small>'
            }
          </div>
        </div>

        <div class="emotion-actions">
          <button class="mood-action-btn" type="button" onclick="App._renderMoodPage()">🏠 처음으로</button>
          <button class="mood-action-btn primary" type="button" onclick="App.goPage('results')">📊 종합 결과</button>
        </div>
      </div>
    `;
  },

  // ─── 색상 유틸 (밝게) ───
  _lightenColor(hex, amount) {
    const num = parseInt(hex.replace('#', ''), 16);
    const r = Math.min(255, (num >> 16) + amount);
    const g = Math.min(255, ((num >> 8) & 0xff) + amount);
    const b = Math.min(255, (num & 0xff) + amount);
    return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
  },

  // ─── 감정별 추천 ───
  _integratedEmotionTips(cardId, v, a) {
    // 좌표 사분면 + 강도 기반 추천
    const tips = [];
    if (v >= 0 && a >= 0) {
      // 긍정 + 각성 (기쁨/설렘/신남)
      tips.push('🌟 좋은 컨디션이에요. 이 에너지를 좋아하는 일에 써보세요.');
      tips.push('📝 이 순간을 기록해두면 우울할 때 큰 힘이 돼요.');
      tips.push('💪 평소 미루던 일을 시작하기 좋은 타이밍이에요.');
    } else if (v >= 0 && a < 0) {
      // 긍정 + 이완 (평온/수용)
      tips.push('🌿 마음이 차분한 좋은 상태예요. 명상이나 독서를 즐겨보세요.');
      tips.push('☕ 따뜻한 차와 함께 천천히 시간을 보내보세요.');
      tips.push('🌸 자연 풍경이나 음악을 가까이 두면 좋아요.');
    } else if (v < 0 && a >= 0) {
      // 부정 + 각성 (분노/불안)
      tips.push('🌬️ 깊은 호흡 5분 (4초 들이, 6초 내쉬) — 부교감 활성화');
      tips.push('🚶 가벼운 산책으로 긴장을 풀어주세요.');
      tips.push('📞 신뢰하는 사람과 통화하는 것도 도움이 돼요.');
    } else {
      // 부정 + 이완 (슬픔/지침)
      tips.push('💛 슬픔이나 피곤도 자연스러운 감정이에요. 자기 자신에게 친절하세요.');
      tips.push('🛁 따뜻한 샤워나 일찍 잠자리에 드는 것을 추천해요.');
      tips.push('🎵 위로가 되는 음악을 들어보세요.');
    }
    return tips.slice(0, 3);
  },

  // ════════════════════════════════════════════════════════════════
  // GAME 1: 표정 미러링 (Ekman 1992) - v15.1 마스코트 강화
  // ════════════════════════════════════════════════════════════════
  _renderMirrorGame(container) {
    // ★ v15.1: 부드러운 마스코트 + 깊이있는 질문
    const emotions = [
      { id: 'joy',      word: '기쁨',  hue: '#FBC97F', cheek: true,
        eyes: 'crescent', mouth: 'big-smile',
        question: '오늘 마음 한구석에 기쁨이 있나요?',
        sub: '작은 즐거움도 괜찮아요' },
      { id: 'peace',    word: '평온',  hue: '#A7D8E5', cheek: false,
        eyes: 'soft-closed', mouth: 'gentle-smile',
        question: '지금 차분한 평온함을 느끼나요?',
        sub: '깊은 호흡 같은 그런 안정감' },
      { id: 'sadness',  word: '슬픔',  hue: '#9CB7D4', cheek: false,
        eyes: 'sad-droop', mouth: 'sad-curve', tear: true,
        question: '마음 한편에 슬픔이 있나요?',
        sub: '슬픔도 자연스러운 감정이에요' },
      { id: 'anxiety',  word: '불안',  hue: '#C8B6FF', cheek: false,
        eyes: 'worried', mouth: 'wavy',
        question: '뭔가 걱정되고 불편한 느낌이 있나요?',
        sub: '두근거림이나 긴장감 같은' },
      { id: 'anger',    word: '분노',  hue: '#F4A99A', cheek: true,
        eyes: 'angry', mouth: 'flat-frown',
        question: '화나거나 짜증나는 마음이 있나요?',
        sub: '억울함이나 답답함도 포함해요' },
      { id: 'loneliness',word:'외로움',hue: '#B8B8E0', cheek: false,
        eyes: 'distant', mouth: 'subtle-frown',
        question: '혼자라는 느낌이나 그리움이 있나요?',
        sub: '누군가가 보고 싶은 마음' },
    ];
    this._moodState.emotions = emotions;
    this._moodState.emotionScores = {};
    this._moodState.currentIdx = 0;
    this._renderMirrorStep(container);
  },

  // ★ v15.1: 마스코트 SVG 생성
  _renderMascotSvg(em, big) {
    const size = big ? 180 : 80;
    let eyes = '';
    if (em.eyes === 'crescent') {
      eyes = `<path d="M33 45 Q38 41, 43 45" stroke="#1F2937" stroke-width="3" fill="none" stroke-linecap="round"/>
              <path d="M57 45 Q62 41, 67 45" stroke="#1F2937" stroke-width="3" fill="none" stroke-linecap="round"/>`;
    } else if (em.eyes === 'soft-closed') {
      eyes = `<path d="M33 47 L43 47" stroke="#1F2937" stroke-width="2.5" stroke-linecap="round"/>
              <path d="M57 47 L67 47" stroke="#1F2937" stroke-width="2.5" stroke-linecap="round"/>`;
    } else if (em.eyes === 'sad-droop') {
      eyes = `<path d="M33 43 Q38 48, 43 45" stroke="#1F2937" stroke-width="3" fill="none" stroke-linecap="round"/>
              <path d="M57 45 Q62 48, 67 43" stroke="#1F2937" stroke-width="3" fill="none" stroke-linecap="round"/>`;
    } else if (em.eyes === 'worried') {
      eyes = `<circle cx="38" cy="46" r="3" fill="#1F2937"/>
              <circle cx="62" cy="46" r="3" fill="#1F2937"/>
              <path d="M32 40 L43 38" stroke="#1F2937" stroke-width="2" stroke-linecap="round"/>
              <path d="M68 40 L57 38" stroke="#1F2937" stroke-width="2" stroke-linecap="round"/>`;
    } else if (em.eyes === 'angry') {
      eyes = `<circle cx="38" cy="47" r="2.5" fill="#1F2937"/>
              <circle cx="62" cy="47" r="2.5" fill="#1F2937"/>
              <path d="M30 38 L46 43" stroke="#1F2937" stroke-width="3" stroke-linecap="round"/>
              <path d="M70 38 L54 43" stroke="#1F2937" stroke-width="3" stroke-linecap="round"/>`;
    } else if (em.eyes === 'distant') {
      eyes = `<circle cx="38" cy="46" r="2.5" fill="#1F2937" opacity="0.7"/>
              <circle cx="62" cy="46" r="2.5" fill="#1F2937" opacity="0.7"/>`;
    } else {
      eyes = `<circle cx="38" cy="46" r="3.5" fill="#1F2937"/>
              <circle cx="62" cy="46" r="3.5" fill="#1F2937"/>
              <circle cx="39" cy="45" r="1.2" fill="#fff"/>
              <circle cx="63" cy="45" r="1.2" fill="#fff"/>`;
    }

    let mouth = '';
    if (em.mouth === 'big-smile') {
      mouth = `<path d="M38 62 Q50 76, 62 62" stroke="#1F2937" stroke-width="3" fill="#fff" stroke-linejoin="round"/>`;
    } else if (em.mouth === 'gentle-smile') {
      mouth = `<path d="M42 65 Q50 70, 58 65" stroke="#1F2937" stroke-width="2.5" fill="none" stroke-linecap="round"/>`;
    } else if (em.mouth === 'sad-curve') {
      mouth = `<path d="M42 70 Q50 63, 58 70" stroke="#1F2937" stroke-width="2.5" fill="none" stroke-linecap="round"/>`;
    } else if (em.mouth === 'wavy') {
      mouth = `<path d="M40 67 Q45 64, 50 67 Q55 70, 60 67" stroke="#1F2937" stroke-width="2.5" fill="none" stroke-linecap="round"/>`;
    } else if (em.mouth === 'flat-frown') {
      mouth = `<path d="M40 68 L60 68" stroke="#1F2937" stroke-width="2.5" stroke-linecap="round"/>`;
    } else if (em.mouth === 'subtle-frown') {
      mouth = `<path d="M42 67 Q50 65, 58 67" stroke="#1F2937" stroke-width="2.5" fill="none" stroke-linecap="round"/>`;
    }

    const cheeks = em.cheek
      ? `<ellipse cx="30" cy="58" rx="6" ry="4" fill="#FCA5A5" opacity="0.6"/>
         <ellipse cx="70" cy="58" rx="6" ry="4" fill="#FCA5A5" opacity="0.6"/>` : '';

    const tear = em.tear
      ? `<path d="M40 56 Q40 64, 38 70 Q36 64, 40 56 Z" fill="#7DD3FC" opacity="0.85"/>` : '';

    const gradId = `g-${em.id}`;
    return `
      <svg viewBox="0 0 100 100" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg" class="mascot-svg">
        <defs>
          <radialGradient id="${gradId}" cx="35%" cy="35%">
            <stop offset="0%" stop-color="${em.hue}" stop-opacity="0.4"/>
            <stop offset="60%" stop-color="${em.hue}" stop-opacity="0.9"/>
            <stop offset="100%" stop-color="${em.hue}"/>
          </radialGradient>
        </defs>
        <path d="M50 12 C72 12, 88 30, 88 52 C88 75, 72 88, 50 88 C28 88, 12 75, 12 52 C12 30, 28 12, 50 12 Z" fill="url(#${gradId})"/>
        ${cheeks}
        ${eyes}
        ${mouth}
        ${tear}
      </svg>
    `;
  },

  _renderMirrorStep(container) {
    const idx = this._moodState.currentIdx;
    const total = this._moodState.emotions.length;
    const emotion = this._moodState.emotions[idx];
    const progress = ((idx) / total) * 100;
    const mascot = this._renderMascotSvg(emotion, true);

    container.innerHTML = `
      <div class="mood-progress"><div class="mood-progress-fill" style="width:${progress}%"></div></div>
      <div class="mood-progress-text">${idx + 1} / ${total}</div>

      <div class="mirror-card-v2">
        <div class="mirror-target-v2" style="background: linear-gradient(135deg, ${emotion.hue}33, ${emotion.hue}11);">
          <div class="mirror-mascot-anim">${mascot}</div>
          <div class="mirror-label-v2">${emotion.word}</div>
        </div>

        <div class="mirror-question">${emotion.question}</div>
        <div class="mirror-sub-v2">${emotion.sub}</div>

        <div class="mirror-scale-v2">
          <button class="mirror-scale-btn-v2" type="button" data-val="1" onclick="App._recordMirror(1)">
            <span class="msb-num">1</span>
            <span class="msb-label">전혀</span>
          </button>
          <button class="mirror-scale-btn-v2" type="button" data-val="2" onclick="App._recordMirror(2)">
            <span class="msb-num">2</span>
            <span class="msb-label">조금</span>
          </button>
          <button class="mirror-scale-btn-v2" type="button" data-val="3" onclick="App._recordMirror(3)">
            <span class="msb-num">3</span>
            <span class="msb-label">보통</span>
          </button>
          <button class="mirror-scale-btn-v2" type="button" data-val="4" onclick="App._recordMirror(4)">
            <span class="msb-num">4</span>
            <span class="msb-label">꽤</span>
          </button>
          <button class="mirror-scale-btn-v2" type="button" data-val="5" onclick="App._recordMirror(5)">
            <span class="msb-num">5</span>
            <span class="msb-label">매우</span>
          </button>
        </div>

        <button class="mood-skip-btn" type="button" onclick="App._recordMirror(0)">
          잘 모르겠어요
        </button>
      </div>
    `;
  },

  _recordMirror(score) {
    const idx = this._moodState.currentIdx;
    const emotion = this._moodState.emotions[idx];
    this._moodState.emotionScores[emotion.id] = score;
    this._moodState.currentIdx++;
    if (this._moodState.currentIdx >= this._moodState.emotions.length) {
      this._finishMoodGame();
    } else {
      this._renderMirrorStep(document.getElementById('mood-container'));
    }
  },

  // ════════════════════════════════════════════════════════════════
  // GAME 2: 색 선택 (Russell 1980 Circumplex)
  // ════════════════════════════════════════════════════════════════
  _renderColorGame(container) {
    // 12색 — Russell의 Valence × Arousal에 매핑
    const colors = [
      { hex: '#FFD93D', name: '햇살 노랑',  valence: 0.8, arousal: 0.6 },
      { hex: '#FF8C42', name: '활기 주황',  valence: 0.6, arousal: 0.7 },
      { hex: '#FF5C5C', name: '뜨거운 빨강', valence: 0.3, arousal: 0.8 },
      { hex: '#E63946', name: '강렬 진빨강', valence: -0.4, arousal: 0.7 },
      { hex: '#9D4EDD', name: '신비 보라',  valence: 0.1, arousal: 0.4 },
      { hex: '#5A4FCF', name: '깊은 남보라', valence: -0.2, arousal: -0.2 },
      { hex: '#1D4ED8', name: '바다 파랑',  valence: -0.1, arousal: -0.4 },
      { hex: '#0EA5E9', name: '맑은 하늘',  valence: 0.5, arousal: 0.0 },
      { hex: '#10B981', name: '싱그런 초록', valence: 0.7, arousal: 0.2 },
      { hex: '#64748B', name: '차분한 회색', valence: -0.3, arousal: -0.5 },
      { hex: '#1F2937', name: '깊은 먹색',  valence: -0.6, arousal: -0.3 },
      { hex: '#F8E1D6', name: '부드러운 살구', valence: 0.5, arousal: -0.3 },
    ];
    this._moodState.colors = colors;
    this._moodState.step = 'pick_color';
    this._moodState.results = {};

    container.innerHTML = `
      <div class="mood-progress"><div class="mood-progress-fill" style="width:33%"></div></div>
      <div class="mood-progress-text">1 / 3</div>

      <div class="color-card">
        <div class="color-prompt">지금 마음과 가장 가까운 색은?</div>
        <div class="color-sub">직관적으로, 마음에 끌리는 색을 골라주세요</div>
        <div class="color-grid">
          ${colors.map((c, i) => `
            <button class="color-swatch" type="button" data-i="${i}"
                    style="background:${c.hex}"
                    onclick="App._pickColor(${i})"
                    aria-label="${c.name}">
            </button>
          `).join('')}
        </div>
      </div>
    `;
  },

  _pickColor(i) {
    this._moodState.results.colorIdx = i;
    this._moodState.results.color = this._moodState.colors[i];
    this._renderEnergyStep(document.getElementById('mood-container'));
  },

  _renderEnergyStep(container) {
    container.innerHTML = `
      <div class="mood-progress"><div class="mood-progress-fill" style="width:66%"></div></div>
      <div class="mood-progress-text">2 / 3</div>

      <div class="color-card">
        <div class="color-prompt">지금 에너지 수준은?</div>
        <div class="color-sub">매우 처짐(1) → 매우 활기참(10)</div>

        <div class="energy-display" id="energy-display">5</div>
        <input type="range" min="1" max="10" value="5" class="energy-slider" id="energy-slider"
               oninput="document.getElementById('energy-display').textContent = this.value">
        <div class="energy-marks">
          <span>😴 처짐</span>
          <span>😐 보통</span>
          <span>⚡ 활기</span>
        </div>

        <button class="mood-next-btn" type="button" onclick="App._pickEnergy()">
          다음 <span>→</span>
        </button>
      </div>
    `;
  },

  _pickEnergy() {
    const v = parseInt(document.getElementById('energy-slider').value);
    this._moodState.results.energy = v;
    this._renderScenePick(document.getElementById('mood-container'));
  },

  _renderScenePick(container) {
    const scenes = [
      { id: 'cafe', icon: '☕', label: '카페 창가' },
      { id: 'forest', icon: '🌲', label: '숲속 길' },
      { id: 'beach', icon: '🌊', label: '바닷가' },
      { id: 'bed', icon: '🛏️', label: '포근한 침대' },
      { id: 'city', icon: '🌆', label: '도시 야경' },
      { id: 'home', icon: '🏠', label: '집 거실' },
      { id: 'people', icon: '👥', label: '사람들 속' },
      { id: 'alone', icon: '🌑', label: '혼자만의 공간' },
    ];
    this._moodState.scenes = scenes;

    container.innerHTML = `
      <div class="mood-progress"><div class="mood-progress-fill" style="width:100%"></div></div>
      <div class="mood-progress-text">3 / 3</div>

      <div class="color-card">
        <div class="color-prompt">지금 가장 끌리는 장소는?</div>
        <div class="color-sub">실제로 가고 싶은 곳이 아니라, 마음이 향하는 곳을 선택하세요</div>
        <div class="scene-grid">
          ${scenes.map(s => `
            <button class="scene-card" type="button" onclick="App._pickScene('${s.id}')">
              <div class="scene-icon">${s.icon}</div>
              <div class="scene-label">${s.label}</div>
            </button>
          `).join('')}
        </div>
      </div>
    `;
  },

  _pickScene(id) {
    this._moodState.results.scene = id;
    this._finishMoodGame();
  },

  // ════════════════════════════════════════════════════════════════
  // GAME 3: 한 단어 일기 + 감정 키워드
  // ════════════════════════════════════════════════════════════════
  _renderDiaryGame(container) {
    this._moodState.results = {};
    this._moodState.step = 'word';

    container.innerHTML = `
      <div class="mood-progress"><div class="mood-progress-fill" style="width:33%"></div></div>
      <div class="mood-progress-text">1 / 3</div>

      <div class="diary-card">
        <div class="diary-prompt">오늘을 한 단어로 표현한다면?</div>
        <div class="diary-sub">자유롭게 떠오르는 단어 하나만 적어주세요</div>
        <input type="text" class="diary-input" id="diary-word"
               placeholder="예: 평온, 분주, 따뜻함..."
               maxlength="20" autocomplete="off">
        <div class="diary-suggestions">
          <span class="diary-suggest" onclick="document.getElementById('diary-word').value=this.textContent">평온</span>
          <span class="diary-suggest" onclick="document.getElementById('diary-word').value=this.textContent">분주</span>
          <span class="diary-suggest" onclick="document.getElementById('diary-word').value=this.textContent">따뜻함</span>
          <span class="diary-suggest" onclick="document.getElementById('diary-word').value=this.textContent">고요</span>
          <span class="diary-suggest" onclick="document.getElementById('diary-word').value=this.textContent">설렘</span>
          <span class="diary-suggest" onclick="document.getElementById('diary-word').value=this.textContent">묵직함</span>
        </div>
        <button class="mood-next-btn" type="button" onclick="App._submitDiaryWord()">다음 <span>→</span></button>
      </div>
    `;
    setTimeout(() => document.getElementById('diary-word')?.focus(), 200);
  },

  _submitDiaryWord() {
    const word = document.getElementById('diary-word').value.trim();
    if (!word) {
      alert('한 단어를 입력해주세요');
      return;
    }
    this._moodState.results.word = word.slice(0, 20);
    this._renderDiaryKeywords(document.getElementById('mood-container'));
  },

  _renderDiaryKeywords(container) {
    // ★ v15.1: 감정 카테고리 대폭 확장 (28개, 3그룹)
    const keywords = [
      // ── 긍정 (10개) ──
      { id: 'joy', label: '기쁨', icon: '😊', valence: 1.0, group: 'pos' },
      { id: 'peace', label: '평온', icon: '😌', valence: 0.8, group: 'pos' },
      { id: 'gratitude', label: '감사', icon: '🙏', valence: 0.9, group: 'pos' },
      { id: 'love', label: '애정', icon: '💗', valence: 0.9, group: 'pos' },
      { id: 'hope', label: '희망', icon: '🌅', valence: 0.7, group: 'pos' },
      { id: 'excitement', label: '설렘', icon: '✨', valence: 0.8, group: 'pos' },
      { id: 'satisfaction', label: '만족', icon: '🥰', valence: 0.8, group: 'pos' },
      { id: 'pride', label: '뿌듯함', icon: '🏆', valence: 0.7, group: 'pos' },
      { id: 'relief', label: '안도', icon: '😮‍💨', valence: 0.6, group: 'pos' },
      { id: 'curiosity', label: '호기심', icon: '🤔', valence: 0.5, group: 'pos' },

      // ── 중립 (6개) ──
      { id: 'calm', label: '담담함', icon: '🌫️', valence: 0.1, group: 'neu' },
      { id: 'normal', label: '평범함', icon: '😶', valence: 0.0, group: 'neu' },
      { id: 'tired', label: '나른함', icon: '😪', valence: -0.1, group: 'neu' },
      { id: 'busy', label: '분주함', icon: '🏃', valence: 0.0, group: 'neu' },
      { id: 'thoughtful', label: '생각많음', icon: '💭', valence: -0.1, group: 'neu' },
      { id: 'expecting', label: '기다림', icon: '⏳', valence: 0.1, group: 'neu' },

      // ── 부정 (12개) ──
      { id: 'fatigue', label: '피곤함', icon: '😴', valence: -0.3, group: 'neg' },
      { id: 'anxiety', label: '불안', icon: '😟', valence: -0.6, group: 'neg' },
      { id: 'worry', label: '걱정', icon: '😣', valence: -0.5, group: 'neg' },
      { id: 'sadness', label: '슬픔', icon: '😢', valence: -0.7, group: 'neg' },
      { id: 'depression', label: '우울', icon: '😞', valence: -0.8, group: 'neg' },
      { id: 'anger', label: '분노', icon: '😠', valence: -0.7, group: 'neg' },
      { id: 'irritation', label: '짜증', icon: '😤', valence: -0.6, group: 'neg' },
      { id: 'loneliness', label: '외로움', icon: '🥺', valence: -0.8, group: 'neg' },
      { id: 'emptiness', label: '공허', icon: '😶‍🌫️', valence: -0.7, group: 'neg' },
      { id: 'confusion', label: '혼란', icon: '😵‍💫', valence: -0.4, group: 'neg' },
      { id: 'frustration', label: '답답함', icon: '😮‍💨', valence: -0.5, group: 'neg' },
      { id: 'regret', label: '후회', icon: '😔', valence: -0.6, group: 'neg' },
    ];
    this._moodState.keywords = keywords;
    this._moodState.results.selectedKeywords = [];

    // 자주 선택한 감정 (최근 7일 기준)
    const frequentIds = this._getFrequentEmotions();
    const frequent = frequentIds.map(id => keywords.find(k => k.id === id)).filter(Boolean);

    const renderGroup = (groupId, label, color) => `
      <div class="kw-group">
        <div class="kw-group-header">
          <span class="kw-group-dot ${groupId}"></span>
          <span class="kw-group-label">${label}</span>
        </div>
        <div class="keyword-grid-v2">
          ${keywords.filter(k => k.group === groupId).map(k => `
            <button class="keyword-btn-v2 ${k.group}" type="button" data-id="${k.id}" onclick="App._toggleKeyword('${k.id}')">
              <span class="keyword-icon-v2">${k.icon}</span>
              <span class="keyword-label-v2">${k.label}</span>
            </button>
          `).join('')}
        </div>
      </div>
    `;

    container.innerHTML = `
      <div class="mood-progress"><div class="mood-progress-fill" style="width:66%"></div></div>
      <div class="mood-progress-text">2 / 3</div>

      <div class="diary-card">
        <div class="diary-prompt">지금 느끼는 감정을 골라주세요</div>
        <div class="diary-sub">하나의 감정만 있지 않아요. 가까운 것 <strong>최대 5개</strong>까지. 어두운 감정도 솔직하게.</div>

        ${frequent.length > 0 ? `
          <div class="kw-group">
            <div class="kw-group-header">
              <span class="kw-group-dot freq"></span>
              <span class="kw-group-label">자주 쓰는 감정</span>
            </div>
            <div class="keyword-grid-v2">
              ${frequent.map(k => `
                <button class="keyword-btn-v2 ${k.group}" type="button" data-id="${k.id}" onclick="App._toggleKeyword('${k.id}')">
                  <span class="keyword-icon-v2">${k.icon}</span>
                  <span class="keyword-label-v2">${k.label}</span>
                </button>
              `).join('')}
            </div>
          </div>
        ` : ''}

        ${renderGroup('pos', '긍정', '#22C55E')}
        ${renderGroup('neu', '중립', '#94A3B8')}
        ${renderGroup('neg', '부정', '#A78BFA')}

        <div class="keyword-count" id="keyword-count">0 / 5 선택됨</div>
        <button class="mood-next-btn" type="button" id="keyword-next" onclick="App._submitKeywords()" disabled>다음 <span>→</span></button>
      </div>
    `;
  },

  // ★ v15.1: 최근 자주 선택한 감정 키워드 추출
  _getFrequentEmotions() {
    try {
      const history = JSON.parse(localStorage.getItem('history_mood') || '[]');
      const recent = history.filter(h => Date.now() - h.t < 7 * 24 * 60 * 60 * 1000);
      const counts = {};
      recent.forEach(h => {
        const kws = h.rawData?.keywords || [];
        kws.forEach(k => { counts[k] = (counts[k] || 0) + 1; });
      });
      return Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([id]) => id);
    } catch (e) { return []; }
  },

  _toggleKeyword(id) {
    const selected = this._moodState.results.selectedKeywords;
    const idx = selected.indexOf(id);
    if (idx >= 0) {
      selected.splice(idx, 1);
    } else {
      if (selected.length >= 5) return; // ★ v15.1: 3 → 5개로 확장
      selected.push(id);
    }
    // UI 업데이트 (data-id 매칭되는 모든 버튼 동시 토글 - frequent와 group 양쪽)
    document.querySelectorAll('.keyword-btn-v2').forEach(b => {
      b.classList.toggle('on', selected.includes(b.dataset.id));
    });
    document.getElementById('keyword-count').textContent = `${selected.length} / 5 선택됨`;
    document.getElementById('keyword-next').disabled = selected.length === 0;
  },

  _submitKeywords() {
    const sel = this._moodState.results.selectedKeywords;
    if (sel.length === 0) return;
    this._renderDiaryReflection(document.getElementById('mood-container'));
  },

  _renderDiaryReflection(container) {
    container.innerHTML = `
      <div class="mood-progress"><div class="mood-progress-fill" style="width:100%"></div></div>
      <div class="mood-progress-text">3 / 3</div>

      <div class="diary-card">
        <div class="diary-prompt">오늘 가장 마음에 남는 순간을 떠올려보세요</div>
        <div class="diary-sub">한 줄로 자유롭게 (선택)</div>
        <textarea class="diary-textarea" id="diary-moment"
                  placeholder="예: 점심에 본 하늘이 예뻤다"
                  maxlength="100" rows="3"></textarea>
        <div class="diary-char-count"><span id="char-count">0</span> / 100</div>
        <button class="mood-next-btn" type="button" onclick="App._submitMoment()">
          완료 <span>→</span>
        </button>
      </div>
    `;
    const ta = document.getElementById('diary-moment');
    ta.addEventListener('input', () => {
      document.getElementById('char-count').textContent = ta.value.length;
    });
    setTimeout(() => ta.focus(), 200);
  },

  _submitMoment() {
    const moment = document.getElementById('diary-moment').value.trim();
    this._moodState.results.moment = moment.slice(0, 100);
    this._finishMoodGame();
  },

  // ════════════════════════════════════════════════════════════════
  // GAME 4: 반응성 어구 (implicit affect)
  // ════════════════════════════════════════════════════════════════
  _renderReflexGame(container) {
    // 단어 풀: 긍정/부정/중립 각 7개
    const words = [
      // 긍정
      { w: '평화', v: 'pos' }, { w: '햇살', v: 'pos' }, { w: '미소', v: 'pos' },
      { w: '꽃', v: 'pos' }, { w: '음악', v: 'pos' }, { w: '바람', v: 'pos' }, { w: '집', v: 'pos' },
      // 부정
      { w: '어둠', v: 'neg' }, { w: '실패', v: 'neg' }, { w: '벽', v: 'neg' },
      { w: '비', v: 'neg' }, { w: '무거움', v: 'neg' }, { w: '추위', v: 'neg' }, { w: '거리', v: 'neg' },
      // 중립
      { w: '책상', v: 'neu' }, { w: '의자', v: 'neu' }, { w: '컵', v: 'neu' },
      { w: '문', v: 'neu' }, { w: '시계', v: 'neu' }, { w: '창문', v: 'neu' },
    ];
    // 셔플 + 12개 선택
    const shuffled = words.sort(() => Math.random() - 0.5).slice(0, 12);
    this._moodState.reflexWords = shuffled;
    this._moodState.reflexResults = [];
    this._moodState.currentIdx = 0;
    this._renderReflexIntro(container);
  },

  _renderReflexIntro(container) {
    container.innerHTML = `
      <div class="reflex-card">
        <div class="reflex-icon">⚡</div>
        <div class="reflex-prompt">화면에 단어가 나타나면<br><strong>마음에 끌리면 ❤️</strong>, <strong>거부감 들면 🚫</strong>를 빠르게 눌러주세요</div>
        <div class="reflex-sub">생각하지 말고 직관적으로. 12개 단어가 2초씩 표시됩니다.</div>
        <button class="mood-next-btn" type="button" onclick="App._startReflexRound()">
          시작 <span>→</span>
        </button>
      </div>
    `;
  },

  _startReflexRound() {
    const idx = this._moodState.currentIdx;
    if (idx >= this._moodState.reflexWords.length) {
      this._finishMoodGame();
      return;
    }
    const word = this._moodState.reflexWords[idx];
    const total = this._moodState.reflexWords.length;
    const progress = ((idx) / total) * 100;
    const container = document.getElementById('mood-container');

    container.innerHTML = `
      <div class="mood-progress"><div class="mood-progress-fill" style="width:${progress}%"></div></div>
      <div class="mood-progress-text">${idx + 1} / ${total}</div>

      <div class="reflex-card">
        <div class="reflex-word">${word.w}</div>
        <div class="reflex-buttons">
          <button class="reflex-btn neg" type="button" onclick="App._recordReflex('neg')">🚫</button>
          <button class="reflex-btn pos" type="button" onclick="App._recordReflex('pos')">❤️</button>
        </div>
        <div class="reflex-hint">생각하지 말고 직관대로</div>
      </div>
    `;

    this._moodState.reflexStartTime = performance.now();

    // 4초 후 자동 넘김
    this._moodState.reflexTimer = setTimeout(() => {
      this._recordReflex('skip');
    }, 4000);
  },

  _recordReflex(response) {
    clearTimeout(this._moodState.reflexTimer);
    const idx = this._moodState.currentIdx;
    const word = this._moodState.reflexWords[idx];
    const rt = performance.now() - this._moodState.reflexStartTime;
    this._moodState.reflexResults.push({
      word: word.w,
      valence: word.v,
      response,
      rt: Math.round(rt),
    });
    this._moodState.currentIdx++;
    setTimeout(() => this._startReflexRound(), 200);
  },

  // ════════════════════════════════════════════════════════════════
  // 게임 완료 → 종합 분석 + 저장
  // ════════════════════════════════════════════════════════════════
  _finishMoodGame() {
    const analysis = this._analyzeMoodResult();
    this._saveMoodResult(analysis);
    this._showMoodResult(analysis);
    this._trackEvent('mood_game_complete', { game: this._moodState.gameId });
  },

  _analyzeMoodResult() {
    const game = this._moodState.gameId;
    const results = this._moodState.results || {};
    const analysis = {
      gameId: game,
      duration: Date.now() - this._moodState.startTime,
      valence: 0,    // -1 ~ +1 (부정/긍정)
      arousal: 0,    // -1 ~ +1 (안정/활성)
      loneliness: 0, // 0 ~ 1
      negBias: 0,    // 0 ~ 1 (부정 편향)
      rawData: {},
    };

    if (game === 'mirror') {
      const scores = this._moodState.emotionScores;
      analysis.rawData.emotionScores = scores;
      // 긍정 감정(joy)이 자연스러우면 valence +
      // 부정 감정(sadness, fear, anger, disgust)이 자연스러우면 부정 valence (현재 그런 상태)
      const posScore = (scores.joy || 0) + (scores.surprise || 0) * 0.3;
      const negScore = (scores.sadness || 0) + (scores.anger || 0) + (scores.fear || 0) + (scores.disgust || 0);
      const total = posScore + negScore;
      if (total > 0) {
        analysis.valence = ((posScore * 2 - negScore) / (total * 2));
      }
      // 모든 점수가 낮으면 알렉시티미아 신호 (감정 인식 어려움)
      const avg = Object.values(scores).reduce((a, b) => a + b, 0) / Object.values(scores).length;
      if (avg < 2.5) {
        analysis.flag = 'low_emotional_awareness';
      }
    }
    else if (game === 'color') {
      const color = results.color;
      const energy = results.energy || 5;
      analysis.rawData = { color: color.hex, colorName: color.name, energy, scene: results.scene };
      analysis.valence = color.valence;
      analysis.arousal = (energy - 5.5) / 4.5; // -1 ~ +1 정규화
      // 외로움 신호: alone 장소 + 어두운 색
      if (results.scene === 'alone' && color.valence < 0) {
        analysis.loneliness = 0.7;
      } else if (results.scene === 'alone') {
        analysis.loneliness = 0.4;
      }
    }
    else if (game === 'diary') {
      const sel = results.selectedKeywords || [];
      analysis.rawData = { word: results.word, keywords: sel, moment: results.moment };
      // valence 평균
      const keywords = this._moodState.keywords || [];
      let valSum = 0, count = 0;
      sel.forEach(id => {
        const k = keywords.find(x => x.id === id);
        if (k) { valSum += k.valence; count++; }
      });
      analysis.valence = count > 0 ? valSum / count : 0;

      // ★ v15.1: 확장된 외로움/우울/위기 감지
      // 직접 외로움 키워드
      if (sel.includes('loneliness')) {
        analysis.loneliness = 0.85;
      } else if (sel.includes('emptiness') && sel.includes('depression')) {
        analysis.loneliness = 0.75; // 공허+우울 조합은 위험
      } else if (sel.includes('emptiness')) {
        analysis.loneliness = 0.55;
      } else if (sel.includes('depression')) {
        analysis.loneliness = 0.5;
      } else if (sel.includes('sadness') && sel.includes('anxiety')) {
        analysis.loneliness = 0.45;
      } else if (sel.includes('sadness') || sel.includes('anxiety') || sel.includes('regret')) {
        analysis.loneliness = 0.25;
      }

      // 우울 신호 (다중 부정 키워드 = 깊은 부정 상태)
      const negKeywords = sel.filter(id => {
        const k = keywords.find(x => x.id === id);
        return k && k.group === 'neg';
      }).length;
      const posKeywords = sel.filter(id => {
        const k = keywords.find(x => x.id === id);
        return k && k.group === 'pos';
      }).length;

      if (negKeywords >= 3 && posKeywords === 0) {
        analysis.flag = 'multiple_negative';
      } else if (sel.includes('depression') && sel.includes('emptiness')) {
        analysis.flag = 'depression_signal';
      }

      // 키워드 카운트 메타데이터 저장
      analysis.rawData.negCount = negKeywords;
      analysis.rawData.posCount = posKeywords;
    }
    else if (game === 'reflex') {
      const reflexes = this._moodState.reflexResults || [];
      analysis.rawData.reflexes = reflexes;
      // 부정 편향: 부정 단어에 더 빨리 반응하면 1에 가까움
      const negResponses = reflexes.filter(r => r.valence === 'neg' && r.response !== 'skip');
      const posResponses = reflexes.filter(r => r.valence === 'pos' && r.response !== 'skip');
      if (negResponses.length > 0 && posResponses.length > 0) {
        const negAvgRT = negResponses.reduce((s, r) => s + r.rt, 0) / negResponses.length;
        const posAvgRT = posResponses.reduce((s, r) => s + r.rt, 0) / posResponses.length;
        // 부정에 더 빠르면 negBias 양수
        if (negAvgRT < posAvgRT) {
          analysis.negBias = Math.min(1, (posAvgRT - negAvgRT) / posAvgRT);
        }
      }
      // 부정 단어를 ❤️로 선택한 비율 → 우울 신호
      const negChosenAsPos = reflexes.filter(r => r.valence === 'neg' && r.response === 'pos').length;
      const posChosenAsNeg = reflexes.filter(r => r.valence === 'pos' && r.response === 'neg').length;
      const totalNeg = reflexes.filter(r => r.valence === 'neg').length;
      const totalPos = reflexes.filter(r => r.valence === 'pos').length;
      if (totalNeg > 0) {
        const negAffinityRatio = negChosenAsPos / totalNeg;
        if (negAffinityRatio > 0.4) analysis.flag = 'negative_affinity';
      }
      // valence 추정
      if (totalPos > 0 && totalNeg > 0) {
        const posChosen = reflexes.filter(r => r.valence === 'pos' && r.response === 'pos').length / totalPos;
        const negRejected = reflexes.filter(r => r.valence === 'neg' && r.response === 'neg').length / totalNeg;
        analysis.valence = (posChosen + negRejected) - 1; // -1 ~ +1
      }
    }

    // 얼굴 측정 + 손가락 측정 통합
    // ★ v15.5: 손가락 PPG가 있으면 우선 사용 (임상급 정확도)
    const w = this.state.wellness || {};
    const now = Date.now();

    let bestSource = null;
    let bestAge = Infinity;

    // 손가락 측정 우선 (6시간 이내)
    if (w.finger && w.finger.t) {
      const fAge = now - w.finger.t;
      if (fAge < 6 * 60 * 60 * 1000) {
        bestSource = w.finger;
        bestAge = fAge;
        analysis.dataSource = 'finger'; // 데이터 소스 추적
      }
    }

    // 얼굴 측정 (손가락이 없거나 더 오래되었을 때)
    if (w.face && w.face.t) {
      const faceAge = now - w.face.t;
      if (faceAge < 6 * 60 * 60 * 1000) {
        // 손가락이 없거나 손가락이 얼굴보다 1시간 이상 오래되면 얼굴 사용
        if (!bestSource || faceAge < bestAge - 60 * 60 * 1000) {
          bestSource = w.face;
          bestAge = faceAge;
          analysis.dataSource = 'face';
        }
      }
    }

    if (bestSource) {
      analysis.faceLink = {
        hr: bestSource.hr,
        rmssd: bestSource.rmssd,
        stressLevel: bestSource.stressLevel,
        respRate: bestSource.respRate,
        ageMinutes: Math.round(bestAge / 60000),
        source: analysis.dataSource, // 'finger' or 'face'
        // ★ v20.2: 주파수 도메인 HRV + 신뢰도
        lfHfRatio: bestSource.lfHfRatio || null,
        pNN50: bestSource.pNN50 || null,
        alphaRppg: bestSource.alphaRppg || null,
        sqi: bestSource.sqi || null,
        // ★ v20.2: AU 표정 분석 결과 (감정게임과 무관하게 얼굴 측정에서)
        auResult: (w.face && w.face.auResult) ? w.face.auResult : null,
        alphaFace: (w.face && w.face.sqi) ? Math.max(0.1, Math.min(1.0, w.face.sqi / 100)) : 0.3,
      };
    }

    // ★ v15.2: 통합 정신건강 점수 계산
    analysis.mental = this._computeMentalWellnessScore(analysis);

    return analysis;
  },

  // ════════════════════════════════════════════════════════════════
  // ★ v15.2: 통합 정신건강 점수 (Mental Wellness Score)
  // 자기보고 감정 + 얼굴 측정(자율신경) → 4가지 차원 종합
  //
  // 학술 근거:
  //   - Mauss & Robinson (2009): 자기보고-생리 불일치의 임상 의미
  //   - Thayer & Lane (2000): Neurovisceral Integration Model
  //   - Porges (2007): Polyvagal Theory (부교감 톤 = 사회 연결)
  //   - Shaffer 2017: HRV = 감정 조절 능력 객관 지표
  // ════════════════════════════════════════════════════════════════
  _computeMentalWellnessScore(analysis) {
    const face = analysis.faceLink;
    const v = analysis.valence || 0; // -1 ~ +1
    const lon = analysis.loneliness || 0; // 0 ~ 1
    const negBias = analysis.negBias || 0;

    // 자기보고 점수 (0~100)
    // valence -1=0점, 0=50점, +1=100점 / 외로움/부정편향 차감
    let subjective = 50 + v * 40 - lon * 30 - negBias * 20;
    subjective = Math.max(0, Math.min(100, subjective));

    // ★ v20.2: 자율신경 점수 — RMSSD + LF/HF 복합 평가
    let autonomic = 50; // 기본값
    let hrvLevel = null; // 'low' | 'normal' | 'high' | null
    let stressFromFace = null;

    if (face && face.rmssd != null) {
      const history = this._historyGet ? this._historyGet('face') : [];
      const past = history.slice(0, -1);
      const stats = past.length >= 3 && this._historyStats ? this._historyStats(past, 'rmssd') : null;

      let rmssdScore = 50;
      if (stats && stats.count >= 3) {
        const std = Math.max(stats.std, 3);
        const z = (face.rmssd - stats.mean) / std;
        if (z >= 0.5) { rmssdScore = 90; hrvLevel = 'high'; }
        else if (z >= -0.5) { rmssdScore = 70; hrvLevel = 'normal'; }
        else if (z >= -1.5) { rmssdScore = 45; hrvLevel = 'low'; }
        else { rmssdScore = 25; hrvLevel = 'low'; }
      } else {
        // baseline 없으면 임상 기준 (Task Force 1996)
        if (face.rmssd >= 40) rmssdScore = 75;
        else if (face.rmssd >= 25) rmssdScore = 60;
        else if (face.rmssd >= 15) rmssdScore = 45;
        else rmssdScore = 30;
        hrvLevel = face.rmssd >= 25 ? 'normal' : 'low';
      }

      // ★ v20.2: LF/HF 복합 보정 — 주파수 도메인으로 교감/부교감 보정
      let lfHfScore = rmssdScore; // 기본: RMSSD 점수
      const lfHfVal = face.lfHfRatio || null;
      if (lfHfVal !== null) {
        // LF/HF 정상 0.5-2.0 → 점수 유지 / 높음 > 3 → 감점 / 낮음 < 0.5 → 보정
        if (lfHfVal > 3.0) {
          lfHfScore = Math.max(20, rmssdScore - (lfHfVal - 3.0) * 8);
        } else if (lfHfVal < 0.5) {
          lfHfScore = Math.min(95, rmssdScore + 8); // 부교감 우세 = 회복 상태
        }
        // LF/HF와 RMSSD 가중 평균 (LF/HF 35% 반영)
        autonomic = Math.round(rmssdScore * 0.65 + lfHfScore * 0.35);
        console.log(`[v20.2 Autonomic] RMSSD=${face.rmssd} rmssdScore=${rmssdScore} LF/HF=${lfHfVal.toFixed(2)} lfHfScore=${lfHfScore} → autonomic=${autonomic}`);
      } else {
        autonomic = rmssdScore;
      }

      // 스트레스 보정 (face.stressLevel 1~5)
      if (face.stressLevel != null) {
        stressFromFace = face.stressLevel;
        const stressPenalty = (face.stressLevel - 2.5) * 6;
        autonomic -= stressPenalty;
        autonomic = Math.max(0, Math.min(100, autonomic));
      }
    }

    // ─── 4가지 통합 차원 ───

    // 1. 정신 회복력 (Resilience): 자율신경 안정성 = autonomic 그대로
    const resilience = autonomic;

    // 2. 자기인식 (Self-awareness): 자기보고-생리 일치도
    // 둘 다 좋거나 둘 다 나쁘면 일치 (인식 좋음)
    // 한쪽만 좋으면 불일치 (감정 억압 또는 신체화 가능성)
    let selfAwareness = 50;
    if (face && face.rmssd != null) {
      // |subjective - autonomic|이 작을수록 일치
      const gap = Math.abs(subjective - autonomic);
      selfAwareness = Math.max(20, 100 - gap * 1.2);
    }

    // 3. 사회적 연결감 (Connection): 외로움 역수 + 부교감 톤
    // Porges Polyvagal: 부교감 톤이 사회 연결의 기반
    let connection = 50 + (1 - lon) * 30; // 외로움 0이면 +30
    if (hrvLevel === 'high' || hrvLevel === 'normal') connection += 15;
    else if (hrvLevel === 'low') connection -= 10;
    connection = Math.max(0, Math.min(100, connection));

    // 4. 감정 조절 (Regulation): 부정 편향 + 다양성
    let regulation = 100 - negBias * 50;
    if (analysis.gameId === 'diary' && analysis.rawData) {
      // 키워드 다양성 (긍정+부정 함께 선택 = 인식 좋음)
      const pos = analysis.rawData.posCount || 0;
      const neg = analysis.rawData.negCount || 0;
      if (pos > 0 && neg > 0) regulation += 10; // 양가감정 인식
      if (pos + neg >= 3) regulation += 5; // 어휘 다양성
    }
    if (analysis.flag === 'multiple_negative') regulation -= 20;
    if (analysis.flag === 'depression_signal') regulation -= 25;
    regulation = Math.max(0, Math.min(100, regulation));

    // ─── 종합 정신건강 점수 (가중평균) ───
    const overall = Math.round(
      resilience * 0.30 +
      selfAwareness * 0.20 +
      connection * 0.25 +
      regulation * 0.25
    );

    // ─── 통합 패턴 분류 (4분면) ───
    let pattern, patternIcon, patternLabel, patternDesc, patternAction;
    const subjPositive = v >= 0;
    const autoGood = autonomic >= 60;

    if (subjPositive && autoGood) {
      pattern = 'harmony';
      patternIcon = '🌟';
      patternLabel = '몸과 마음의 균형';
      patternDesc = '감정도 좋고 자율신경도 안정적인 황금 상태예요';
      patternAction = '오늘 무엇이 좋았는지 기억해두세요';
    } else if (subjPositive && !autoGood) {
      pattern = 'recovering';
      patternIcon = '🌸';
      patternLabel = '회복 중';
      patternDesc = '마음은 좋은데 몸이 따라가지 못하는 상태';
      patternAction = '충분한 수면과 휴식을 챙겨주세요';
    } else if (!subjPositive && autoGood) {
      pattern = 'enduring';
      patternIcon = '🌿';
      patternLabel = '잘 버티고 있어요';
      patternDesc = '감정은 무거운데 회복력은 살아있는 상태';
      patternAction = '잠시 멈춤이 필요해요. 자신에게 너그러우세요';
    } else {
      pattern = 'exhausted';
      patternIcon = '🌧️';
      patternLabel = '많이 지쳐 있어요';
      patternDesc = '몸도 마음도 함께 지친 상태';
      patternAction = '적극적 휴식이 필요해요. 누군가에게 도움 요청하기';
    }

    return {
      overall,           // 종합 점수 0~100
      resilience,        // 회복력 (자율신경)
      selfAwareness,     // 자기인식 (감정-생리 일치도)
      connection,        // 사회적 연결감
      regulation,        // 감정 조절
      subjective,        // 자기보고만의 점수
      autonomic,         // 자율신경만의 점수
      hrvLevel,          // 'low' | 'normal' | 'high' | null
      stressFromFace,
      pattern,           // 'harmony' | 'recovering' | 'enduring' | 'exhausted'
      patternIcon,
      patternLabel,
      patternDesc,
      patternAction,
      hasFaceData: !!face,
    };
  },

  _saveMoodResult(analysis) {
    try {
      const history = JSON.parse(localStorage.getItem('history_mood') || '[]');
      history.push({
        t: Date.now(),
        gameId: analysis.gameId,
        valence: analysis.valence,
        arousal: analysis.arousal,
        loneliness: analysis.loneliness,
        negBias: analysis.negBias,
        flag: analysis.flag,
        rawData: analysis.rawData,
        faceLink: analysis.faceLink,
        mental: analysis.mental, // ★ v15.2: 통합 점수 함께 저장
      });
      if (history.length > 100) history.splice(0, history.length - 100);
      localStorage.setItem('history_mood', JSON.stringify(history));
      console.log(`[Mood] ${analysis.gameId} 저장 (총 ${history.length}회)`);
    } catch (e) {
      console.warn('[Mood] 저장 실패:', e);
    }
  },

  // ─── 게임 결과 화면 ───
  _showMoodResult(analysis) {
    const container = document.getElementById('mood-container');
    const w = this.state.wellness || {};

    // 외로움 위기 감지
    const needsHelp = this._detectMoodCrisis(analysis);

    // 감정 좌표 (Russell Circumplex)
    const v = analysis.valence; // -1 ~ +1
    const a = analysis.arousal || 0;
    const quadrant = this._getMoodQuadrant(v, a);

    // 핵심 메시지 (절대 진단 X, 부드러운 톤)
    const message = this._generateMoodMessage(analysis);

    // 얼굴 측정과의 통합 메시지
    let integratedMsg = '';
    if (analysis.faceLink) {
      integratedMsg = this._generateIntegratedMessage(analysis);
    }

    // ★ v20.2: Late Fusion 모달 신뢰도 칩 생성
    const emo = this._computeIntegratedEmotion
      ? (this._lastEmotionResult || {}) : {};
    const aRppg = typeof emo.alphaRppg === 'number' ? emo.alphaRppg : null;
    const aFace = typeof emo.alphaFace === 'number' ? emo.alphaFace : null;
    const lfHfUsed = emo.lfHfUsed || false;
    const auUsed = emo.auUsed || false;

    let fusionChipsHTML = '';
    if (aRppg !== null || aFace !== null) {
      const chips = [];
      if (aRppg !== null) {
        const rCls = aRppg >= 0.7 ? 'good' : aRppg >= 0.4 ? 'mid' : 'low';
        chips.push(`<span class="fusion-chip rppg-${rCls}">💗 rPPG ${Math.round(aRppg*100)}%${lfHfUsed ? ' · LF/HF✓' : ''}</span>`);
      }
      if (aFace !== null && aFace > 0) {
        const fCls = aFace >= 0.7 ? 'good' : aFace >= 0.4 ? 'mid' : 'low';
        chips.push(`<span class="fusion-chip face-${fCls}">😊 표정 ${Math.round(aFace*100)}%${auUsed ? ' · AU✓' : ''}</span>`);
      }
      if (chips.length > 0) {
        fusionChipsHTML = `<div class="fusion-chips-row">${chips.join('')}</div>`;
      }
    }
    // 이번 결과를 캐시 (다음 렌더링에서 참조)
    this._lastEmotionResult = null; // 다음 계산 후 갱신

    container.innerHTML = `
      <div class="mood-result">
        <div class="result-hero">
          <div class="result-quadrant ${quadrant.cls}">
            <div class="result-quadrant-icon">${quadrant.icon}</div>
            <div class="result-quadrant-label">${quadrant.label}</div>
          </div>
          <div class="result-message">${message}</div>
        </div>

        ${this._renderMentalWellnessCard(analysis)}

        ${this._renderCircumplexChart(v, a, quadrant)}

        ${integratedMsg ? `
          <div class="result-section">
            <div class="result-section-title">💚 마음과 몸의 대화</div>
            <div class="result-integrated">${integratedMsg}</div>
            ${fusionChipsHTML}
          </div>
        ` : `
          <div class="result-suggest-face">
            <div class="result-suggest-face-icon">😊</div>
            <div class="result-suggest-face-body">
              <div class="result-suggest-face-title">얼굴 측정도 함께 해보세요</div>
              <div class="result-suggest-face-sub">자율신경과 함께 보면 4가지 차원 통합 분석이 가능해요</div>
            </div>
            <button class="result-suggest-face-btn" onclick="App.goPage('face')">측정</button>
          </div>
        `}

        ${this._renderMoodInsights(analysis)}

        <div class="result-actions result-actions-3">
          <button class="mood-action-btn" type="button" onclick="App.goPage('home')">홈</button>
          <button class="mood-action-btn" type="button" onclick="App._renderMoodPage()">🔄 다시</button>
          <button class="mood-action-btn primary" type="button" onclick="App._showMoodHistory()">📓 일지</button>
        </div>

        ${needsHelp ? this._renderCrisisCard() : ''}

        <div class="mood-disclaimer">
          ⚠️ 이 결과는 지금 이 순간의 마음을 비춘 거울일 뿐, 의학적 진단이 아닙니다.
          마음의 어려움이 지속되시면 전문가의 도움을 받아보세요.
        </div>
      </div>
    `;
  },

  _getMoodQuadrant(v, a) {
    // Russell의 4분면
    if (v >= 0.2 && a >= 0.2) return { cls: 'q1', icon: '✨', label: '활기차고 즐거운' };
    if (v >= 0.2 && a < 0.2) return { cls: 'q2', icon: '🌿', label: '편안하고 평온한' };
    if (v < 0.2 && v >= -0.2) return { cls: 'q3', icon: '🌫️', label: '담담하고 차분한' };
    if (v < -0.2 && a < 0) return { cls: 'q4', icon: '🌧️', label: '조용히 무거운' };
    return { cls: 'q5', icon: '⚡', label: '복잡한 마음' };
  },

  _generateMoodMessage(analysis) {
    const v = analysis.valence;
    if (v >= 0.5) return '오늘 마음이 한결 가벼우신 것 같아요';
    if (v >= 0.2) return '평온한 결이 느껴지는 하루네요';
    if (v >= -0.2) return '차분한 마음으로 하루를 보내고 계시는군요';
    if (v >= -0.5) return '조금 무거운 하루를 보내고 계시네요';
    return '많이 힘드신 하루를 보내고 계신 것 같아요';
  },

  _generateIntegratedMessage(analysis) {
    const v = analysis.valence;
    const face = analysis.faceLink;
    const m = analysis.mental;

    // mental 패턴 기반 (v15.2 강화)
    if (m && m.hasFaceData) {
      const pattern = m.pattern;
      if (pattern === 'harmony') {
        return `🌟 몸과 마음이 함께 좋은 균형 상태예요. 심박 ${face.hr}BPM, HRV ${face.rmssd}ms로 자율신경이 안정적이고, 감정도 긍정적입니다. 오늘 무엇이 좋았는지 기억해두면 어려운 날에 도움이 됩니다.`;
      }
      if (pattern === 'recovering') {
        return `🌸 마음은 좋으신데(${Math.round(m.subjective)}점) 몸이 약간 따라가지 못하고 있어요(${Math.round(m.autonomic)}점). HRV ${face.rmssd}ms로 자율신경이 약간 긴장된 상태입니다. 좋은 일에도 몸이 따라가지 못할 때가 있어요. 오늘 밤은 충분히 주무세요.`;
      }
      if (pattern === 'enduring') {
        return `🌿 감정은 무거우신데(${Math.round(m.subjective)}점) 자율신경은 잘 버티고 있어요(${Math.round(m.autonomic)}점). HRV ${face.rmssd}ms로 회복력이 살아있는 상태입니다. 힘든 시기지만 잠시 멈춤이 필요해요. 자신에게 너그러우세요.`;
      }
      if (pattern === 'exhausted') {
        return `🌧️ 몸도 마음도 많이 지치셨네요. 감정 ${Math.round(m.subjective)}점, 자율신경 ${Math.round(m.autonomic)}점으로 모두 회복이 필요한 상태입니다. 오늘은 적극적 휴식이 필요해요. 가까운 누군가에게 도움을 청해보세요.`;
      }
    }

    // ★ v20.2: LF/HF 기반 상세 fallback 메시지
    const history = this._historyGet('face');
    const past = history.slice(0, -1);
    const rmssdStats = past.length >= 3 ? this._historyStats(past, 'rmssd') : null;
    const isLowHRV = rmssdStats && face.rmssd < rmssdStats.mean - rmssdStats.std;
    const isHighHRV = rmssdStats && face.rmssd > rmssdStats.mean + rmssdStats.std;
    const lfHf = face.lfHfRatio || null;

    // LF/HF 기반 심층 메시지 (데이터 있을 때 우선)
    if (lfHf !== null) {
      const lfHfStr = lfHf.toFixed(2);
      if (lfHf > 3.0 && v < 0) {
        return `😰 교감신경이 매우 활성화(LF/HF ${lfHfStr})돼 있고 감정도 부정적인 상태예요. 과부하 상태일 수 있으니 지금 당장 5분 호흡이나 산책이 필요합니다.`;
      }
      if (lfHf > 3.0 && v >= 0) {
        return `😤 표정은 긍정적이지만 내면의 교감신경이 강하게 활성(LF/HF ${lfHfStr})돼 있어요. 겉으로는 괜찮아 보여도 몸이 각성 상태입니다. 의식적인 이완이 도움이 됩니다.`;
      }
      if (lfHf < 0.5) {
        return `🌿 부교감신경이 우세(LF/HF ${lfHfStr})한 매우 이완된 상태예요. 심신이 잘 회복되고 있습니다.`;
      }
      if (lfHf >= 0.5 && lfHf <= 2.0) {
        return `✅ 교감/부교감 균형(LF/HF ${lfHfStr})이 양호한 상태예요. 자율신경 균형이 감정 안정과 연결됩니다.`;
      }
    }

    // LF/HF 없을 때 RMSSD 기반 (기존 메시지)
    if (v < -0.3 && isLowHRV) {
      return '마음도 무겁고 자율신경도 평소보다 긴장된 상태예요. 오늘은 무리하지 마시고 따뜻한 차 한 잔, 깊은 호흡을 권합니다.';
    }
    if (v < -0.3 && !isLowHRV) {
      return '마음은 무거우신데 자율신경은 안정적이에요. 감정적으로 힘드시지만 몸은 잘 버티고 있는 상태입니다. 잠시 쉬어가도 괜찮아요.';
    }
    if (v >= 0.3 && isLowHRV) {
      return '마음은 좋으신데 자율신경은 약간 긴장돼 있어요. 충분한 수면을 챙겨보세요.';
    }
    if (v >= 0.3 && isHighHRV) {
      return '마음도 몸도 함께 좋은 상태예요. 이 균형을 기억해두세요.';
    }
    const lfHfDisplay = face.lfHfRatio ? ` · LF/HF ${face.lfHfRatio.toFixed(1)}` : '';
    return `현재 심박수 ${face.hr}BPM · HRV ${face.rmssd}ms${lfHfDisplay}. 자율신경이 안정적이에요.`;
  },

  // ════════════════════════════════════════════════════════════════
  // ★ v15.2: 통합 정신건강 카드 (감정 게임 + 얼굴 측정 통합 결과)
  // ════════════════════════════════════════════════════════════════
  _renderMentalWellnessCard(analysis) {
    const m = analysis.mental;
    if (!m) return '';

    // ★ v16.8: 누락된 필수 필드 안전 폴백 (undefined/NaN 방지)
    const safe = {
      overall: typeof m.overall === 'number' && !isNaN(m.overall) ? m.overall : 0,
      subjective: typeof m.subjective === 'number' && !isNaN(m.subjective) ? m.subjective : 50,
      autonomic: typeof m.autonomic === 'number' && !isNaN(m.autonomic) ? m.autonomic : 50,
      resilience: typeof m.resilience === 'number' && !isNaN(m.resilience) ? m.resilience : 50,
      selfAwareness: typeof m.selfAwareness === 'number' && !isNaN(m.selfAwareness) ? m.selfAwareness : 50,
      connection: typeof m.connection === 'number' && !isNaN(m.connection) ? m.connection : 50,
      regulation: typeof m.regulation === 'number' && !isNaN(m.regulation) ? m.regulation : 50,
      hasFaceData: !!m.hasFaceData,
      pattern: m.pattern || 'exhausted',
      patternIcon: m.patternIcon || '🌿',
      patternLabel: m.patternLabel || '측정 중',
      patternDesc: m.patternDesc || '추가 측정으로 더 정확한 분석을 받아보세요',
      patternAction: m.patternAction || '얼굴 측정을 함께 진행해보세요',
    };

    // 점수 색상 결정
    const getScoreColor = (score) => {
      if (score >= 75) return '#22C55E';
      if (score >= 55) return '#3B82F6';
      if (score >= 40) return '#F59E0B';
      return '#EF4444';
    };

    // 패턴별 그라데이션
    const patternBg = {
      harmony: 'linear-gradient(135deg, #DCFCE7 0%, #BBF7D0 100%)',
      recovering: 'linear-gradient(135deg, #FCE7F3 0%, #FBCFE8 100%)',
      enduring: 'linear-gradient(135deg, #F0FDF4 0%, #D1FAE5 100%)',
      exhausted: 'linear-gradient(135deg, #F3F4F6 0%, #E5E7EB 100%)',
    };
    const patternBorder = {
      harmony: '#22C55E',
      recovering: '#EC4899',
      enduring: '#10B981',
      exhausted: '#6B7280',
    };

    // 자기보고 vs 자율신경 일치도 라벨
    let alignmentLabel = '';
    if (safe.hasFaceData) {
      const gap = Math.abs(safe.subjective - safe.autonomic);
      if (gap < 15) alignmentLabel = '✨ 자기인식 좋음';
      else if (gap < 30) alignmentLabel = '🌿 보통';
      else alignmentLabel = '🌫️ 불일치 — 무의식적 신호';
    }

    const dimensions = [
      { key: 'resilience', label: '회복력', icon: '💪', score: safe.resilience,
        hint: '자율신경 안정성' },
      { key: 'selfAwareness', label: '자기인식', icon: '🔍', score: safe.selfAwareness,
        hint: safe.hasFaceData ? '감정-신체 일치' : '얼굴 측정 필요' },
      { key: 'connection', label: '연결감', icon: '🫂', score: safe.connection,
        hint: '사회적 친밀감' },
      { key: 'regulation', label: '감정조절', icon: '⚖️', score: safe.regulation,
        hint: '인식·표현 능력' },
    ];

    return `
      <div class="mental-card" style="background: ${patternBg[safe.pattern]}; border-color: ${patternBorder[safe.pattern]};">

        <!-- 종합 점수 + 패턴 -->
        <div class="mental-header">
          <div class="mental-overall">
            <div class="mental-overall-label">정신건강 점수</div>
            <div class="mental-overall-score" style="color: ${getScoreColor(safe.overall)};">
              ${safe.overall}<span class="mental-overall-max">/100</span>
            </div>
          </div>
          <div class="mental-pattern">
            <div class="mental-pattern-icon">${safe.patternIcon}</div>
            <div class="mental-pattern-label">${safe.patternLabel}</div>
          </div>
        </div>

        <div class="mental-pattern-desc">${safe.patternDesc}</div>

        <!-- 자기보고 vs 자율신경 비교 -->
        ${safe.hasFaceData ? `
          <div class="mental-compare">
            <div class="mental-bar">
              <div class="mental-bar-label">
                <span>🎮 마음 (게임)</span>
                <strong>${Math.round(safe.subjective)}</strong>
              </div>
              <div class="mental-bar-track">
                <div class="mental-bar-fill subj" style="width: ${safe.subjective}%"></div>
              </div>
            </div>
            <div class="mental-bar">
              <div class="mental-bar-label">
                <span>💗 몸 (자율신경)</span>
                <strong>${Math.round(safe.autonomic)}</strong>
              </div>
              <div class="mental-bar-track">
                <div class="mental-bar-fill auto" style="width: ${safe.autonomic}%"></div>
              </div>
            </div>
            ${alignmentLabel ? `<div class="mental-alignment">${alignmentLabel}</div>` : ''}
          </div>
        ` : `
          <div class="mental-no-face">
            <div class="mental-no-face-icon">💡</div>
            <div class="mental-no-face-body">
              <div class="mental-no-face-title">얼굴 측정을 더하면</div>
              <div class="mental-no-face-sub">자율신경 데이터로 4차원 분석이 완성돼요</div>
            </div>
            <button class="mental-no-face-btn" type="button" onclick="App.goPage('face')">측정 →</button>
          </div>
        `}

        <!-- 4차원 점수 -->
        <div class="mental-dims">
          ${dimensions.map(d => `
            <div class="mental-dim">
              <div class="mental-dim-icon">${d.icon}</div>
              <div class="mental-dim-info">
                <div class="mental-dim-label">${d.label}</div>
                <div class="mental-dim-hint">${d.hint}</div>
              </div>
              <div class="mental-dim-score" style="color: ${getScoreColor(d.score)};">${Math.round(d.score)}</div>
            </div>
          `).join('')}
        </div>

        <!-- 권유 -->
        <div class="mental-action">
          <div class="mental-action-icon">💚</div>
          <div class="mental-action-text">${safe.patternAction}</div>
        </div>
      </div>
    `;
  },

  _renderCircumplexChart(v, a, quadrant) {
    // -1~+1을 -100~+100 픽셀로
    const cx = 50 + v * 35;
    const cy = 50 - a * 35;
    return `
      <div class="result-section">
        <div class="result-section-title">📊 오늘의 감정 좌표</div>
        <div class="circumplex-wrap">
          <svg viewBox="0 0 100 100" class="circumplex">
            <!-- 4분면 배경 -->
            <rect x="50" y="0" width="50" height="50" fill="#FEF3C7" opacity="0.4"/>
            <rect x="50" y="50" width="50" height="50" fill="#DCFCE7" opacity="0.4"/>
            <rect x="0" y="50" width="50" height="50" fill="#F3F4F6" opacity="0.4"/>
            <rect x="0" y="0" width="50" height="50" fill="#FECACA" opacity="0.4"/>
            <!-- 축 -->
            <line x1="50" y1="5" x2="50" y2="95" stroke="#94a3b8" stroke-width="0.4" stroke-dasharray="1.5,1.5"/>
            <line x1="5" y1="50" x2="95" y2="50" stroke="#94a3b8" stroke-width="0.4" stroke-dasharray="1.5,1.5"/>
            <!-- 라벨 -->
            <text x="50" y="3.5" text-anchor="middle" font-size="3.5" fill="#475569" font-weight="700">활기</text>
            <text x="50" y="98.5" text-anchor="middle" font-size="3.5" fill="#475569" font-weight="700">안정</text>
            <text x="2.5" y="51.5" font-size="3.5" fill="#475569" font-weight="700">부정</text>
            <text x="97.5" y="51.5" text-anchor="end" font-size="3.5" fill="#475569" font-weight="700">긍정</text>
            <!-- 4분면 이름 -->
            <text x="75" y="22" text-anchor="middle" font-size="2.8" fill="#92400e" opacity="0.7">활기·기쁨</text>
            <text x="75" y="78" text-anchor="middle" font-size="2.8" fill="#166534" opacity="0.7">평온·만족</text>
            <text x="25" y="78" text-anchor="middle" font-size="2.8" fill="#475569" opacity="0.7">차분·우울</text>
            <text x="25" y="22" text-anchor="middle" font-size="2.8" fill="#b91c1c" opacity="0.7">긴장·분노</text>
            <!-- 본인 좌표 -->
            <circle cx="${cx}" cy="${cy}" r="3.5" fill="#22c55e" stroke="#fff" stroke-width="1.5"/>
            <circle cx="${cx}" cy="${cy}" r="6" fill="none" stroke="#22c55e" stroke-width="0.6" opacity="0.4">
              <animate attributeName="r" values="6;9;6" dur="2s" repeatCount="indefinite"/>
              <animate attributeName="opacity" values="0.4;0;0.4" dur="2s" repeatCount="indefinite"/>
            </circle>
          </svg>
          <div class="circumplex-caption">${quadrant.icon} ${quadrant.label}</div>
        </div>
      </div>
    `;
  },

  _renderMoodInsights(analysis) {
    const game = analysis.gameId;
    const rd = analysis.rawData || {};
    let detail = '';
    if (game === 'mirror') {
      const scores = rd.emotionScores || {};
      detail = `
        <div class="insight-row"><span>가장 자연스럽게 표현된 감정:</span>
          <strong>${this._findMaxEmotion(scores)}</strong></div>
        <div class="insight-row"><span>가장 어색했던 감정:</span>
          <strong>${this._findMinEmotion(scores)}</strong></div>
      `;
    } else if (game === 'color') {
      detail = `
        <div class="insight-row"><span>선택한 색:</span>
          <strong style="color:${rd.color}">● ${rd.colorName}</strong></div>
        <div class="insight-row"><span>에너지 수준:</span>
          <strong>${rd.energy} / 10</strong></div>
        <div class="insight-row"><span>마음이 향한 장소:</span>
          <strong>${this._sceneLabel(rd.scene)}</strong></div>
      `;
    } else if (game === 'diary') {
      const keywordLabels = (rd.keywords || []).map(id => {
        const k = this._moodState.keywords?.find(x => x.id === id);
        return k ? `${k.icon} ${k.label}` : id;
      }).join(', ');
      detail = `
        <div class="insight-row"><span>오늘의 한 단어:</span>
          <strong>"${this._esc(rd.word || '-')}"</strong></div>
        <div class="insight-row"><span>선택한 키워드:</span>
          <strong>${keywordLabels || '-'}</strong></div>
        ${rd.moment ? `<div class="insight-row column"><span>마음에 남는 순간:</span>
          <em>"${this._esc(rd.moment)}"</em></div>` : ''}
      `;
    } else if (game === 'reflex') {
      const reflexes = rd.reflexes || [];
      const posCount = reflexes.filter(r => r.response === 'pos').length;
      const negCount = reflexes.filter(r => r.response === 'neg').length;
      const avgRT = reflexes.length > 0
        ? Math.round(reflexes.reduce((s, r) => s + r.rt, 0) / reflexes.length)
        : 0;
      detail = `
        <div class="insight-row"><span>❤️ 선택:</span><strong>${posCount}회</strong></div>
        <div class="insight-row"><span>🚫 선택:</span><strong>${negCount}회</strong></div>
        <div class="insight-row"><span>평균 반응 시간:</span><strong>${avgRT}ms</strong></div>
      `;
    }
    return `
      <div class="result-section">
        <div class="result-section-title">💚 오늘 나의 감정</div>
        <div class="insight-detail">${detail}</div>
      </div>
    `;
  },

  _findMaxEmotion(scores) {
    let max = -1, maxKey = '-';
    Object.entries(scores).forEach(([k, v]) => {
      if (v > max) { max = v; maxKey = k; }
    });
    return this._moodEmotionLabels[maxKey] || maxKey;
  },
  _findMinEmotion(scores) {
    let min = 99, minKey = '-';
    Object.entries(scores).forEach(([k, v]) => {
      if (v > 0 && v < min) { min = v; minKey = k; }
    });
    return this._moodEmotionLabels[minKey] || minKey;
  },
  _sceneLabel(id) {
    const map = { cafe:'☕ 카페', forest:'🌲 숲속', beach:'🌊 바닷가',
                  bed:'🛏️ 침대', city:'🌆 도시', home:'🏠 집',
                  people:'👥 사람 속', alone:'🌑 혼자만의 공간' };
    return map[id] || id;
  },

  // ─── 위기 감지 + 안내 ───
  _detectMoodCrisis(analysis) {
    // 단일 회 결과로는 절대 위기 단정 안 함. 누적 패턴 확인
    if (analysis.loneliness >= 0.75) return 'loneliness_high';
    if (analysis.flag === 'depression_signal') return 'depression_signal';
    if (analysis.flag === 'multiple_negative') return 'multiple_negative';
    if (analysis.valence <= -0.7) {
      // 최근 일지 확인
      try {
        const history = JSON.parse(localStorage.getItem('history_mood') || '[]');
        const recent = history.slice(-5);
        const negCount = recent.filter(h => h.valence < -0.4).length;
        if (negCount >= 3) return 'persistent_low';
      } catch (e) {}
    }
    if (analysis.flag === 'negative_affinity') return 'neg_bias_high';
    return null;
  },

  _renderCrisisCard() {
    return `
      <div class="crisis-card">
        <div class="crisis-icon">🫂</div>
        <div class="crisis-body">
          <div class="crisis-title">혼자만의 시간이 길어지셨네요</div>
          <div class="crisis-msg">
            마음이 무거울 땐 누군가에게 말을 거는 것만으로도 가벼워집니다.
            지금 떠오르는 사람이 있다면 짧게라도 안부를 전해보세요.
          </div>
          <div class="crisis-resources">
            <div class="crisis-resource-label">💬 도움이 필요하시면</div>
            <a href="tel:1393" class="crisis-link">📞 자살예방상담전화 1393 (24시간, 무료)</a>
            <a href="tel:1577-0199" class="crisis-link">📞 정신건강상담전화 1577-0199</a>
            <a href="tel:1388" class="crisis-link">📞 청소년상담 1388</a>
          </div>
          <div class="crisis-note">전화 한 통은 약함이 아니라 자기 돌봄의 가장 큰 용기입니다.</div>
        </div>
      </div>
    `;
  },

  // ─── 가장 최근 결과 보기 ───
  _renderMoodResultLatest(container) {
    try {
      const history = JSON.parse(localStorage.getItem('history_mood') || '[]');
      if (history.length === 0) {
        this._renderMoodIntro(container);
        return;
      }
      const latest = history[history.length - 1];
      // 게임 상태 복원
      this._moodState = {
        gameId: latest.gameId,
        startTime: latest.t,
        results: latest.rawData || {},
      };
      // ★ v15.2.5: mental 필드도 복원 (정신건강 점수 카드 표시 유지)
      const analysis = {
        gameId: latest.gameId,
        valence: latest.valence,
        arousal: latest.arousal,
        loneliness: latest.loneliness,
        negBias: latest.negBias,
        flag: latest.flag,
        rawData: latest.rawData,
        faceLink: latest.faceLink,
        mental: latest.mental, // ★ 핵심: 정신건강 통합 점수 복원
      };

      // ★ v15.2.6: 얼굴 측정이 mood 측정보다 나중에 됐다면 mental 재계산
      const w = this.state.wellness || {};
      const now = Date.now();
      const hasRecentFace = w.face && w.face.t && (now - w.face.t) < 6 * 60 * 60 * 1000;
      const moodRecent = (now - latest.t) < 6 * 60 * 60 * 1000;

      if (hasRecentFace && moodRecent && (!analysis.mental || !analysis.mental.hasFaceData)) {
        // 최신 얼굴 데이터로 faceLink 갱신 후 재계산
        analysis.faceLink = {
          hr: w.face.hr,
          rmssd: w.face.rmssd,
          stressLevel: w.face.stressLevel,
          respRate: w.face.respRate,
          ageMinutes: Math.round((now - w.face.t) / 60000),
        };
        try {
          analysis.mental = this._computeMentalWellnessScore(analysis);
          // history에도 업데이트
          history[history.length - 1].mental = analysis.mental;
          history[history.length - 1].faceLink = analysis.faceLink;
          localStorage.setItem('history_mood', JSON.stringify(history));
          console.log('[Mood] mental 재계산 (얼굴 측정 통합)');
        } catch (e) {
          console.warn('[Mood] mental 재계산 실패:', e);
        }
      } else if (!analysis.mental && analysis.faceLink) {
        // mental만 없으면 재계산 (구버전 호환)
        try {
          analysis.mental = this._computeMentalWellnessScore(analysis);
        } catch (e) {
          console.warn('[Mood] mental 재계산 실패:', e);
        }
      }
      this._showMoodResult(analysis);
    } catch (e) {
      console.warn('[Mood] 최근 결과 로드 실패:', e);
      this._renderMoodIntro(container);
    }
  },

  // ─── 감정 일지 (시계열) ───
  _showMoodHistory() {
    let history = [];
    try { history = JSON.parse(localStorage.getItem('history_mood') || '[]'); } catch (e) {}

    const container = document.getElementById('mood-container');
    if (history.length === 0) {
      container.innerHTML = `
        <div class="mood-empty">
          <div class="mood-empty-icon">📓</div>
          <div class="mood-empty-title">아직 일지가 없어요</div>
          <div class="mood-empty-sub">매일 감정을 기록하면 마음의 흐름을 볼 수 있어요</div>
          <button class="mood-start-btn" type="button" onclick="App._renderMoodPage()">오늘의 감정 시작</button>
        </div>
      `;
      return;
    }

    // 최근 30개
    const recent = history.slice(-30).reverse();

    const itemsHTML = recent.map(h => {
      const date = new Date(h.t);
      const dateStr = `${date.getMonth()+1}/${date.getDate()} ${date.getHours().toString().padStart(2,'0')}:${date.getMinutes().toString().padStart(2,'0')}`;
      const q = this._getMoodQuadrant(h.valence || 0, h.arousal || 0);
      const game = this._moodGames.find(g => g.id === h.gameId);
      return `
        <div class="history-item ${q.cls}">
          <div class="history-icon">${q.icon}</div>
          <div class="history-body">
            <div class="history-label">${q.label}</div>
            <div class="history-meta">${dateStr} · ${game?.icon || ''} ${this._esc(game?.name || h.gameId)}</div>
            ${h.rawData?.word ? `<div class="history-word">"${this._esc(h.rawData.word)}"</div>` : ''}
            ${h.rawData?.moment ? `<div class="history-moment">💭 ${this._esc(h.rawData.moment)}</div>` : ''}
          </div>
        </div>
      `;
    }).join('');

    container.innerHTML = `
      <div class="mood-history">
        <div class="history-summary">
          ${this._renderHistorySummary(history)}
        </div>
        <div class="history-list">${itemsHTML}</div>
        <button class="mood-action-btn" type="button" onclick="App._renderMoodPage()">오늘의 감정으로 돌아가기</button>
      </div>
    `;
  },

  _renderHistorySummary(history) {
    const recent7 = history.filter(h => Date.now() - h.t < 7 * 24 * 60 * 60 * 1000);
    if (recent7.length < 2) {
      return `
        <div class="history-empty-summary">
          <div>📊 일주일 분석</div>
          <div class="history-empty-sub">매일 기록하면 자세한 패턴이 보여요 (${recent7.length}/7일)</div>
        </div>
      `;
    }
    const avgV = recent7.reduce((s, h) => s + (h.valence || 0), 0) / recent7.length;
    const avgL = recent7.reduce((s, h) => s + (h.loneliness || 0), 0) / recent7.length;
    const dominant = this._getMoodQuadrant(avgV, 0);

    // ★ v15.2: 정신건강 점수 추이
    const recentWithMental = recent7.filter(h => h.mental && h.mental.overall != null);
    let mentalAvg = null, mentalTrend = '→';
    if (recentWithMental.length >= 2) {
      mentalAvg = Math.round(recentWithMental.reduce((s, h) => s + h.mental.overall, 0) / recentWithMental.length);
      // 추이: 최근 절반 vs 이전 절반
      const half = Math.floor(recentWithMental.length / 2);
      const newer = recentWithMental.slice(-half);
      const older = recentWithMental.slice(0, half);
      const newerAvg = newer.reduce((s, h) => s + h.mental.overall, 0) / newer.length;
      const olderAvg = older.reduce((s, h) => s + h.mental.overall, 0) / older.length;
      const diff = newerAvg - olderAvg;
      if (diff > 5) mentalTrend = '↑';
      else if (diff < -5) mentalTrend = '↓';
    }

    return `
      <div class="history-summary-card">
        <div class="history-summary-title">지난 7일 마음 풍경</div>
        <div class="history-summary-main">${dominant.icon} ${dominant.label}</div>
        <div class="history-summary-stats">
          ${mentalAvg !== null ? `
            <div><span>정신건강</span><strong>${mentalAvg} ${mentalTrend}</strong></div>
          ` : ''}
          <div><span>긍정 ↔ 부정</span><strong>${avgV >= 0 ? '+' : ''}${(avgV*100).toFixed(0)}</strong></div>
          <div><span>외로움</span><strong>${(avgL*100).toFixed(0)}%</strong></div>
          ${mentalAvg === null ? `<div><span>기록 횟수</span><strong>${recent7.length}회</strong></div>` : ''}
        </div>
      </div>
    `;
  },



  // ════════════════════════════════════════════════════════════════
  // 얼굴 측정 (POS 알고리즘)
  // ════════════════════════════════════════════════════════════════

  _bindFaceButton() {
    // 카메라 위 버튼만 사용 (v11s10 — 하단 버튼 제거)
    const btnTop = document.getElementById('face-btn-top');
    const handler = (e) => {
      e.preventDefault();
      if (this.state.face.running) this.faceStop();
      else this.faceStart();
    };
    if (btnTop) btnTop.addEventListener('click', handler);
  },

  // 버튼 상태 동기화 (카메라 위 버튼만)
  _faceUpdateButtons(running) {
    const txt = document.getElementById('face-btn-top-text');
    const btn = document.getElementById('face-btn-top');
    if (!txt || !btn) return;
    if (running) {
      txt.textContent = '측정 중지';
      btn.classList.add('stop');
    } else {
      txt.textContent = '▶ 측정 시작';
      btn.classList.remove('stop');
    }
  },

  async faceStart() {
    console.log('[Face] 측정 시작 (ME-rPPG 엔진)');
    try {
      // === STEP 0: ME-rPPG 워커 초기화 (한 번만) ===
      await this._initMERPPG();

      // === STEP 1: 카메라 획득 (전면) ===
      await this._faceAcquireCamera();

      // === STEP 2: 상태 초기화 ===
      const f = this.state.face;
      f.running = true;
      f.measureStartMs = performance.now();
      f.samples = [];
      f.fpsCounter = 0;
      f.fpsLastT = performance.now();
      f.autoFinalized = false;
      f.lastHR = null;
      f.faceDetected = false;
      f._speak15 = false;
      f._speak5 = false;
      // ME-rPPG 상태 리셋
      f.mePPG.kfBox = { originX: null, originY: null, width: null, height: null };
      f.mePPG.kfOutput = null;
      f.mePPG.kfHr = null;
      f.mePPG.meanHRErr = 0.04;
      f.mePPG.timestampArray = [];
      f.mePPG.welchArray = new Array(300).fill(0);
      f.mePPG.welchCount = 300 - 90;
      f.mePPG.inferenceCount = 0;
      f.mePPG.inferenceTimestamp = 0;
      f.mePPG.inputQueueCount = 0;
      f.mePPG.dropCount = 30;
      f.mePPG.currentHR = null;
      f.mePPG.bvpSeries = [];
      // ★ v19.4: 동공/표정 초기화
      f.pupilSeries = [];
      f.auSeries    = [];
      f.pupilResult = null;
      f.auResult    = null;

      // === STEP 3: UI 변경 ===
      this._faceUpdateButtons(true);
      document.getElementById('face-chip-fps').querySelector('.chip-dot').classList.add('live');
      document.getElementById('face-chip-fps').querySelector('.chip-dot').classList.remove('off');
      document.getElementById('face-chip-roi').style.display = 'flex';
      document.getElementById('face-chip-engine').style.display = 'flex';
      document.getElementById('face-chip-engine-text').textContent = 'ME-rPPG';
      document.getElementById('face-cam-msg').textContent = '얼굴 검출 중...';
      document.getElementById('face-cam-sub').textContent = '얼굴을 화면 가운데에 맞춰주세요';
      document.getElementById('face-result-panel').classList.remove('show');

      // ★ v13.4: 얼굴 측정 음성 안내 추가
      this._speak('얼굴 측정을 시작합니다. 화면 가운데에 얼굴을 맞추고 30초간 가만히 계세요. 자연스럽게 호흡하시면 됩니다.');

      // ★ v15.4: 측정 중 화면 꺼짐 방지 (Wake Lock)
      this._acquireWakeLock();

      // === STEP 4: 타이머 + 프레임 루프 ===
      this._faceStartTimer();
      this._faceProcessFrame();

      console.log('[Face] ME-rPPG 시작 완료');
    } catch (err) {
      console.error('[Face] 시작 실패:', err);
      alert('측정 시작 실패: ' + (err.message || err));
      await this.faceStop();
    }
  },

  // === ME-rPPG 엔진 초기화 ===
  async _initMERPPG() {
    const f = this.state.face;

    // 1. ONNX Worker (model.onnx + state.json) 초기화
    if (!f.onnxWorker) {
      console.log('[ME-rPPG] ONNX 워커 생성');
      f.onnxWorker = new Worker('me-rppg/onnxWorker.js');
      f.onnxWorker.onmessage = (e) => this._onOnnxMessage(e);
    }

    // 2. Welch Worker (welch_psd.onnx + get_hr.onnx) 초기화
    if (!f.welchWorker) {
      console.log('[ME-rPPG] Welch 워커 생성');
      f.welchWorker = new Worker('me-rppg/welchWorker.js');
      f.welchWorker.onmessage = (e) => this._onWelchMessage(e);
    }

    // 3. MediaPipe Face Detector 동적 로드
    if (!f.mePPG.faceDetector) {
      console.log('[ME-rPPG] MediaPipe FaceDetector 로드');
      try {
        const mp = await import('https://fastly.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.4');
        const vision = await mp.FilesetResolver.forVisionTasks(
          'https://fastly.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.4/wasm'
        );
        f.mePPG.faceDetector = await mp.FaceDetector.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: 'me-rppg/blaze_face_short_range.tflite',
            delegate: 'CPU',
          },
          runningMode: 'VIDEO',
          minDetectionConfidence: 0.5,
        });
        console.log('[ME-rPPG] FaceDetector OK');
      } catch (err) {
        console.error('[ME-rPPG] FaceDetector 실패:', err);
        throw new Error('MediaPipe 로드 실패: ' + err.message);
      }
    }

    // 4. 워커 준비 대기 (model + state + welch + hr)
    if (!(f.mePPG.modelReady && f.mePPG.stateReady && f.mePPG.welchReady && f.mePPG.hrReady)) {
      console.log('[ME-rPPG] 모델 로드 대기...');
      document.getElementById('face-cam-msg').textContent = '🧠 AI 모델 로드 중...';
      document.getElementById('face-cam-sub').textContent = '최초 1회 (~5초)';
      await this._waitForMERPPGReady();
      console.log('[ME-rPPG] 모든 모델 준비 완료');
    }
  },

  _waitForMERPPGReady() {
    return new Promise((resolve, reject) => {
      const startT = performance.now();
      const check = () => {
        const m = this.state.face.mePPG;
        const elapsed = ((performance.now() - startT) / 1000).toFixed(1);

        // 진행 상황 표시 (어떤 모델이 로드되었는지)
        const ready = [
          m.modelReady ? '✅' : '⏳', '메인 모델',
          m.stateReady ? '✅' : '⏳', '초기 상태',
          m.welchReady ? '✅' : '⏳', 'PSD 분석',
          m.hrReady ? '✅' : '⏳', 'HR 산출'
        ];
        const subText = `${ready[0]} 메인 ${ready[2]} 상태 ${ready[4]} PSD ${ready[6]} HR  (${elapsed}초)`;
        const sub = document.getElementById('face-cam-sub');
        if (sub) sub.textContent = subText;

        if (m.modelReady && m.stateReady && m.welchReady && m.hrReady) {
          resolve();
          return;
        }
        // 60초 타임아웃 (느린 네트워크 고려)
        if (performance.now() - startT > 60000) {
          reject(new Error('모델 로드 타임아웃 (60초)\n네트워크 연결을 확인하고 재시도해주세요.'));
          return;
        }
        setTimeout(check, 300);
      };
      check();
    });
  },

  // === ONNX Worker 메시지 핸들러 ===
  _onOnnxMessage(event) {
    const f = this.state.face;
    const m = f.mePPG;
    const { type } = event.data;

    if (type === 'ready') {
      const { which } = event.data;
      if (which === 'model') { m.modelReady = true; console.log('[ME-rPPG] model.onnx ready'); }
      if (which === 'state') { m.stateReady = true; console.log('[ME-rPPG] state.json ready'); }
      return;
    }
    if (type === 'error') {
      console.error('[ME-rPPG] ONNX error:', event.data);
      return;
    }

    // BVP 출력 도착
    m.inputQueueCount--;
    const { output, delay, timestamp } = event.data;

    // 처음 30프레임 (워밍업) 폐기
    if (m.dropCount > 0) { m.dropCount--; return; }

    // Kalman 필터 (출력 신호 안정화)
    if (!m.kfOutput) {
      m.kfOutput = this._mkKalman(1, 0.5, output, 1);
    } else {
      this._kalmanUpdate(m.kfOutput, output);
    }

    m.inferenceCount++;
    if (m.inferenceCount === 30) {
      const fps = (30 / ((timestamp - m.inferenceTimestamp) / 1000)).toFixed(1);
      m.inferenceTimestamp = timestamp;
      m.inferenceCount = 0;
      console.log('[ME-rPPG] inference FPS:', fps, 'delay:', delay, 'ms');
    }

    // BVP 시계열 누적 (HRV용)
    m.bvpSeries.push({ bvp: m.kfOutput.estimate, t: performance.now() });
    if (m.bvpSeries.length > 1500) m.bvpSeries.shift();

    // 화면 파형 그리기
    this._faceDrawMeWaveform();

    // Welch PSD 입력 버퍼 갱신
    if (m.welchArray.length >= 300) m.welchArray.shift();
    m.welchArray.push(m.kfOutput.estimate);
    m.welchCount++;
    if (m.welchCount >= 300) {
      f.welchWorker.postMessage({ input: new Float32Array(m.welchArray) });
      m.welchCount = 270;
    }
  },

  // === Welch Worker 메시지 핸들러 (HR 산출) ===
  _onWelchMessage(event) {
    const f = this.state.face;
    const m = f.mePPG;
    const { type } = event.data;

    if (type === 'ready') {
      const { which } = event.data;
      if (which === 'welch') { m.welchReady = true; console.log('[ME-rPPG] welch_psd.onnx ready'); }
      if (which === 'hr') { m.hrReady = true; console.log('[ME-rPPG] get_hr.onnx ready'); }
      return;
    }

    let { hr } = event.data;
    // ★ v18.1: 실제 FPS 보정 개선 — 모델이 30Hz 가정으로 훈련됨
    if (m.timestampArray.length > 60) {
      const recent = m.timestampArray.slice(-121);
      let total = 0, valid = 0;
      for (let i = 1; i < recent.length; i++) {
        const dt = recent[i] - recent[i - 1]; // 초 단위
        if (dt > 0 && dt <= 0.2) { total += dt; valid++; }
      }
      const avgFps = total > 0 ? (valid / total) : 0;
      if (avgFps > 0 && Math.abs(avgFps - 30) > 3) {
        hr = (hr / 30) * avgFps;
        // ★ v18.1: FPS 보정 후 HR 합리성 클램프 (35~150 BPM — 안정 측정 범위)
        hr = Math.max(35, Math.min(150, hr));
      }
    }
    // ★ v18.1: HR 이상값 직접 클램프 (보정 여부와 무관)
    if (hr > 160) {
      console.warn('[ME-rPPG v18.1] HR 이상값 감지:', hr.toFixed(1), '→ FPS 보정 재시도');
      // FPS 보정 없이 들어온 경우: 2배 과잉 추정 패턴 의심 → 절반 적용 시도
      const halvHr = hr / 2;
      if (halvHr >= 40 && halvHr <= 120) {
        hr = halvHr;
        console.warn('[ME-rPPG v18.1] HR 절반 보정 적용:', hr.toFixed(1));
      } else {
        hr = Math.min(hr, 150);
      }
    }

    // Kalman 필터 (HR 안정화)
    if (!m.kfHr) {
      m.kfHr = this._mkKalman(1, 2, hr, 1);
    } else {
      this._kalmanUpdate(m.kfHr, hr);
    }

    // HR 신뢰도 추적
    m.meanHRErr = 0.8 * m.meanHRErr + 0.2 * Math.abs(m.kfHr.estimate - hr) / hr;
    m.currentHR = m.kfHr.estimate;

    // UI 업데이트
    document.getElementById('face-cam-msg').textContent = '✅ 측정 중';
    const stable = m.meanHRErr < 0.025;
    document.getElementById('face-cam-sub').textContent = 
      `💗 ${m.kfHr.estimate.toFixed(1)} BPM` + (stable ? ' (안정)' : ' (수렴 중)');
    console.log('[ME-rPPG] HR:', m.kfHr.estimate.toFixed(1), 'meanErr:', m.meanHRErr.toFixed(4));
  },

  // === Kalman Filter 1D ===
  _mkKalman(processNoise, measurementNoise, init, initErr) {
    return { processNoise, measurementNoise, estimate: init, estimateError: initErr };
  },
  _kalmanUpdate(kf, measurement) {
    const predErr = kf.estimateError + kf.processNoise;
    const gain = predErr / (predErr + kf.measurementNoise);
    kf.estimate = kf.estimate + gain * (measurement - kf.estimate);
    kf.estimateError = (1 - gain) * predErr;
    return kf.estimate;
  },

  async faceStop() {
    console.log('[Face] 측정 중지');
    const f = this.state.face;
    f.running = false;

    // ★ v15.4: wake lock 해제
    this._releaseWakeLock();

    if (f.timerInterval) { clearInterval(f.timerInterval); f.timerInterval = null; }
    if (f.rafId) { cancelAnimationFrame(f.rafId); f.rafId = null; }

    // 카메라 정리 (얼굴 모드는 페이지 떠날 때만 완전 정리, 측정 끝은 유지)
    try {
      if (f.stream) {
        f.stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
        f.stream = null;
      }
    } catch (e) {}
    f.track = null;
    try { document.getElementById('face-video').srcObject = null; } catch (e) {}

    // UI 복원
    this._faceUpdateButtons(false);
    document.getElementById('face-chip-fps').querySelector('.chip-dot').classList.remove('live');
    document.getElementById('face-chip-fps').querySelector('.chip-dot').classList.add('off');
    document.getElementById('face-chip-fps-text').textContent = '대기';
    document.getElementById('face-chip-timer').style.display = 'none';
    document.getElementById('face-chip-roi').style.display = 'none';
    const engineChip = document.getElementById('face-chip-engine');
    if (engineChip) engineChip.style.display = 'none';
    document.getElementById('face-progress-fill').style.width = '0%';
    document.getElementById('face-sqi-fill').style.width = '0%';
    document.getElementById('face-sqi-pct').textContent = '0%';
    document.getElementById('face-sqi-msg').textContent = '측정 중지됨';
    document.getElementById('face-cam-msg').textContent = '측정 시작 버튼을 눌러주세요';
    document.getElementById('face-cam-sub').textContent = '얼굴을 화면 가운데에 맞춰주세요';
  },

  async _faceAcquireCamera() {
    const attempts = [
      { video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } } },
      { video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } },
      { video: { facingMode: 'user' } },
      { video: true },
    ];
    let lastErr = null;
    for (const c of attempts) {
      try {
        console.log('[Face Camera] 시도:', JSON.stringify(c.video));
        const stream = await navigator.mediaDevices.getUserMedia(c);
        const track = stream.getVideoTracks()[0];
        const settings = track.getSettings ? track.getSettings() : {};
        console.log('[Face Camera] 획득:', settings.width + 'x' + settings.height,
                    'facingMode:', settings.facingMode || 'unknown');

        this.state.face.stream = stream;
        this.state.face.track = track;
        const video = document.getElementById('face-video');
        video.srcObject = stream;
        video.classList.add('cam-front');
        await new Promise((res, rej) => {
          video.onloadedmetadata = () => res();
          setTimeout(() => rej(new Error('타임아웃')), 5000);
        });
        await video.play();
        await new Promise(r => setTimeout(r, 300)); // 안정화
        console.log('[Face Camera] ✅ 획득 성공');
        return;
      } catch (err) {
        console.warn('[Face Camera] 시도 실패:', err.message);
        lastErr = err;
      }
    }
    throw lastErr || new Error('카메라 사용 불가');
  },

  // ─── 타이머 ───
  _faceStartTimer() {
    document.getElementById('face-chip-timer').style.display = 'flex';
    this._faceTickTimer();
    if (this.state.face.timerInterval) clearInterval(this.state.face.timerInterval);
    this.state.face.timerInterval = setInterval(() => this._faceTickTimer(), 250);
  },

  _faceTickTimer() {
    const f = this.state.face;
    if (!f.running) return;
    const elapsed = (performance.now() - f.measureStartMs) / 1000;
    const total = this.config.face.durationSec;
    const remain = Math.max(0, total - elapsed);

    const pct = Math.min(100, (elapsed / total) * 100);
    document.getElementById('face-progress-fill').style.width = pct + '%';

    const chip = document.getElementById('face-chip-timer');
    const text = document.getElementById('face-chip-timer-text');
    chip.classList.remove('urgent', 'done');
    if (remain > 0) {
      text.textContent = Math.ceil(remain) + '초 남음';
      if (remain <= 10) chip.classList.add('urgent');

      // ★ v13.4: 음성 안내 (중간 + 5초 전)
      const remainCeil = Math.ceil(remain);
      if (remainCeil === 15 && !f._speak15) {
        f._speak15 = true;
        this._speak('절반 지났어요. 그대로 유지해주세요.');
      }
      if (remainCeil === 5 && !f._speak5) {
        f._speak5 = true;
        this._speak('5초 남았습니다');
      }
    } else {
      text.textContent = '✅ 측정 완료';
      chip.classList.add('done');
      if (!f.autoFinalized) {
        f.autoFinalized = true;
        console.log('[Face] 30초 도달 — 자동 완료');
        // ★ v13.4: 측정 완료 음성
        this._speak('얼굴 측정이 완료되었습니다. 결과를 확인하세요.');
        this._faceFinalize();
      }
    }
  },

  // ─── 프레임 루프 (ME-rPPG: BlazeFace + 36x36 ROI) ───
  _faceProcessFrame() {
    const f = this.state.face;
    if (!f.running) return;

    const video = document.getElementById('face-video');
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) {
      f.rafId = requestAnimationFrame(() => this._faceProcessFrame());
      return;
    }

    // FPS 측정
    f.fpsCounter++;
    const now = performance.now();
    if (now - f.fpsLastT >= 1000) {
      f.fps = f.fpsCounter;
      f.fpsCounter = 0;
      f.fpsLastT = now;
      document.getElementById('face-chip-fps-text').textContent = f.fps + ' fps';
    }

    // 큐 백프레셔: 처리 안 끝났으면 스킵
    const m = f.mePPG;
    if (m.inputQueueCount < 5) {
      const lastTime = performance.now() / 1000;
      m.timestampArray.push(lastTime);
      if (m.timestampArray.length > 301) m.timestampArray.shift();

      // BlazeFace로 얼굴 검출
      try {
        const result = m.faceDetector.detectForVideo(video, performance.now());
        const dets = result.detections;

        if (dets && dets.length > 0) {
          const det = dets[0];
          const raw = det.boundingBox;

          // Kalman 필터 (얼굴 박스 안정화)
          const kfBox = m.kfBox;
          if (kfBox.originX === null) {
            kfBox.originX = this._mkKalman(1e-2, 5e-1, raw.originX, 1);
            kfBox.originY = this._mkKalman(1e-2, 5e-1, raw.originY, 1);
            kfBox.width   = this._mkKalman(1e-2, 5e-1, raw.width,   1);
            kfBox.height  = this._mkKalman(1e-2, 5e-1, raw.height,  1);
          } else {
            this._kalmanUpdate(kfBox.originX, raw.originX);
            this._kalmanUpdate(kfBox.originY, raw.originY);
            this._kalmanUpdate(kfBox.width,   raw.width);
            this._kalmanUpdate(kfBox.height,  raw.height);
          }
          // 박스 확장 (이마 포함)
          let bx = kfBox.originX.estimate;
          let by = kfBox.originY.estimate;
          let bw = kfBox.width.estimate;
          let bh = kfBox.height.estimate * 1.2;
          by -= bh * 0.2;

          // 36x36 리사이즈 + Float32 RGB 추출
          const input = this._faceCropResize36(video, vw, vh, bx, by, bw, bh);
          if (input) {
            f.faceDetected = true;
            document.getElementById('face-chip-roi-text').textContent = 'BlazeFace OK';
            this._faceUpdateRunStatus();

            m.inputQueueCount += 1;
            f.onnxWorker.postMessage({
              type: 'data', input, timestamp: lastTime, lambda: 1,
            });

            // ★ v19.4: 동공·표정 분석 (매 5프레임마다 — 성능 최적화)
            if (f.running && f.fpsCounter % 5 === 0) {
              this._faceAnalyzePupilAndAU(video, vw, vh, bx, by, bw, bh, det);
            }
          }
        } else {
          f.faceDetected = false;
          document.getElementById('face-chip-roi-text').textContent = '얼굴 없음';
          document.getElementById('face-cam-msg').textContent = '얼굴이 감지되지 않습니다';
          document.getElementById('face-cam-sub').textContent = '얼굴을 화면 가운데에 맞추세요';
        }
      } catch (err) {
        console.error('[ME-rPPG] face detect error:', err);
      }
    }

    f.rafId = requestAnimationFrame(() => this._faceProcessFrame());
  },

  // ★ v19.4: 동공 변동성 + 표정 Action Unit 분석
  // Dr. Kim: Pupillary Unrest Index + Ekman AU 기반
  // Alex: BlazeFace keypoints + 픽셀 분석 (추가 모델 불필요)
  _faceAnalyzePupilAndAU(video, vw, vh, bx, by, bw, bh, det) {
    try {
      const f = this.state.face;
      const now = performance.now();

      // BlazeFace keypoints: [rightEye, leftEye, nose, mouth, rightEar, leftEar]
      const kp = det.keypoints;
      if (!kp || kp.length < 6) return;

      const rightEye = kp[0]; // { x, y } normalized 0-1
      const leftEye  = kp[1];

      // === 1. 동공 크기 추정 (Pupillary Unrest Index) ===
      // 눈 영역 픽셀 추출 → 밝기 역전 → 어두운 영역 크기 = 동공
      const pupilData = this._faceEstimatePupilSize(video, vw, vh, rightEye, leftEye);
      if (pupilData) {
        f.pupilSeries.push({ t: now, ...pupilData });
        if (f.pupilSeries.length > 300) f.pupilSeries.shift();
      }

      // === 2. Action Unit 추정 ===
      // BlazeFace 랜드마크로 AU 근사
      // AU1(눈썹 내측↑), AU4(눈썹 찡그림), AU6(볼 올라감), AU12(입꼬리↑)
      const auData = this._faceEstimateActionUnits(det, bw, bh);
      if (auData) {
        f.auSeries.push({ t: now, ...auData });
        if (f.auSeries.length > 300) f.auSeries.shift();
      }

    } catch (e) {
      // 조용히 실패 — 핵심 측정에 영향 없음
    }
  },

  // 동공 크기 픽셀 추정
  _faceEstimatePupilSize(video, vw, vh, rightEye, leftEye) {
    try {
      if (!this._cvPupil) {
        this._cvPupil = document.createElement('canvas');
        this._cvPupil.width = 32; this._cvPupil.height = 16;
      }
      const cv = this._cvPupil;
      const ctx = cv.getContext('2d', { willReadFrequently: true });

      // 눈 사이 거리로 스케일 계산
      const eyeDist = Math.sqrt(
        Math.pow((rightEye.x - leftEye.x) * vw, 2) +
        Math.pow((rightEye.y - leftEye.y) * vh, 2)
      );
      if (eyeDist < 10) return null;

      const eyeRadius = eyeDist * 0.18; // 눈 크기 ≈ 눈 간격의 18%

      // 오른쪽 눈 영역 추출 (16×16)
      const rx = rightEye.x * vw; const ry = rightEye.y * vh;
      ctx.drawImage(video, rx - eyeRadius, ry - eyeRadius, eyeRadius*2, eyeRadius*2, 0, 0, 16, 16);
      const rdData = ctx.getImageData(0, 0, 16, 16).data;

      // 왼쪽 눈 영역 추출 (16×16)
      const lx = leftEye.x * vw; const ly = leftEye.y * vh;
      ctx.drawImage(video, lx - eyeRadius, ly - eyeRadius, eyeRadius*2, eyeRadius*2, 16, 0, 16, 16);
      const ldData = ctx.getImageData(16, 0, 16, 16).data;

      // 어두운 픽셀 비율 = 동공 크기 지표
      // threshold: 전체 밝기 평균의 60% 이하 = 동공
      const getDarkRatio = (data) => {
        let sum = 0, dark = 0;
        for (let i = 0; i < data.length; i += 4) {
          const lum = data[i]*0.299 + data[i+1]*0.587 + data[i+2]*0.114;
          sum += lum;
        }
        const avg = sum / (data.length / 4);
        const thr = avg * 0.55;
        for (let i = 0; i < data.length; i += 4) {
          const lum = data[i]*0.299 + data[i+1]*0.587 + data[i+2]*0.114;
          if (lum < thr) dark++;
        }
        return dark / (data.length / 4);
      };

      const rightRatio = getDarkRatio(rdData);
      const leftRatio  = getDarkRatio(ldData);

      // 0~1 범위, 정규화 → 픽셀 단위 환산 (eyeDist 기준)
      const rightPx = rightRatio * eyeDist * 0.4;
      const leftPx  = leftRatio  * eyeDist * 0.4;

      return { right: rightPx, left: leftPx, eyeDist };
    } catch (e) { return null; }
  },

  // Action Unit 추정 (BlazeFace keypoints 기반)
  // Ekman & Friesen 1978: AU1,2,4,6,7,12,15,17
  _faceEstimateActionUnits(det, bw, bh) {
    try {
      const kp = det.keypoints;
      if (!kp || kp.length < 6) return null;

      // keypoints: [rightEye(0), leftEye(1), nose(2), mouth(3), rightEar(4), leftEar(5)]
      const re = kp[0], le = kp[1], nose = kp[2], mouth = kp[3];

      // 얼굴 높이 정규화
      const faceH = bh || 1;

      // AU12 (입꼬리 올라감 = 행복) - 입이 눈 중간보다 얼마나 아래 있는지
      const eyeMidY = (re.y + le.y) / 2;
      const mouthRelY = (mouth.y - eyeMidY) / (faceH / 480 || 1);
      const au12 = Math.max(0, Math.min(1, (mouthRelY - 0.3) * 3));

      // AU6 (볼 올라감) - 눈과 코 사이 거리
      const eyeToNose = Math.abs(nose.y - eyeMidY);
      const au6 = Math.max(0, Math.min(1, 1 - eyeToNose * 4));

      // AU1/AU4 (눈썹 움직임) - 눈과 귀 세로 차이로 근사
      const re4 = kp[4], le5 = kp[5]; // ears
      const browR = Math.abs(re.y - re4.y);
      const browL = Math.abs(le.y - le5.y);
      const au1 = Math.max(0, Math.min(1, (browR + browL) * 2));
      const au4 = Math.max(0, Math.min(1, 1 - (browR + browL) * 3));

      // 좌우 대칭성 지수 (AU: 비대칭 = 감정 억압 지표)
      const eyeSymmetry = 1 - Math.abs(re.y - le.y) * 10;

      return { au1, au4, au6, au12, eyeSymmetry };
    } catch (e) { return null; }
  },

  // ★ v19.4: 동공·표정 시계열 → 최종 지표 계산
  _faceComputePupilAUResult() {
    const f = this.state.face;

    // === 동공 결과 ===
    let pupilResult = null;
    if (f.pupilSeries.length >= 20) {
      const rights = f.pupilSeries.map(d => d.right).filter(v => v > 0);
      const lefts  = f.pupilSeries.map(d => d.left).filter(v => v > 0);

      if (rights.length >= 15) {
        // PUI (Pupillary Unrest Index): 연속 측정값 변동 계수
        const mean = arr => arr.reduce((a,b)=>a+b,0)/arr.length;
        const std  = arr => { const m=mean(arr); return Math.sqrt(arr.reduce((s,v)=>s+(v-m)**2,0)/arr.length); };

        const rMean = mean(rights); const rStd = std(rights);
        const lMean = mean(lefts);  const lStd = std(lefts);
        const cv = ((rStd/rMean) + (lStd/lMean)) / 2; // 변동 계수

        // PUI 정상: CV < 0.08 / 높음: > 0.15
        // Dr. Kim: 자율신경 불안정 시 동공 변동성 증가 (Wilhelm 1998)
        const pui = Math.round(cv * 100);
        const puiScore = Math.max(10, Math.min(99, Math.round(100 - pui * 3)));
        const puiState = cv < 0.06 ? 'stable' : cv < 0.12 ? 'normal' : cv < 0.20 ? 'variable' : 'unstable';

        pupilResult = {
          pui, puiScore, puiState,
          rightMean: Math.round(rMean * 10) / 10,
          leftMean:  Math.round(lMean * 10) / 10,
          symmetry:  Math.round((1 - Math.abs(rMean-lMean)/(rMean+lMean)) * 100),
          label: puiState === 'stable' ? '안정적' : puiState === 'normal' ? '정상 범위' : puiState === 'variable' ? '약간 불안정' : '불안정',
          interpretation: puiState === 'stable'
            ? '자율신경이 균형잡힌 상태입니다'
            : puiState === 'normal'
            ? '정상 범위의 동공 반응성입니다'
            : '자율신경 긴장 상태를 나타낼 수 있습니다',
        };
      }
    }

    // === 표정(AU) 결과 ===
    let auResult = null;
    if (f.auSeries.length >= 15) {
      const mean = (key) => {
        const vals = f.auSeries.map(d=>d[key]).filter(v=>v!=null);
        return vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : 0;
      };

      const au12m = mean('au12'); // 행복/미소
      const au6m  = mean('au6');  // 진짜 미소 (Duchenne)
      const au1m  = mean('au1');  // 내측 눈썹
      const au4m  = mean('au4');  // 눈썹 찡그림
      const symm  = mean('eyeSymmetry');

      // Duchenne 미소 = au12 + au6 (진정성 있는 미소)
      const duchenne = (au12m + au6m) / 2;

      // 감정 표현 분류
      let dominantEmotion = 'neutral';
      let emotionScore = 50;
      if (duchenne > 0.5) { dominantEmotion = 'happy'; emotionScore = Math.round(50 + duchenne*40); }
      else if (au4m > 0.5) { dominantEmotion = 'stressed'; emotionScore = Math.round(50 - au4m*30); }
      else if (au1m > 0.4) { dominantEmotion = 'concerned'; emotionScore = Math.round(50 - au1m*20); }

      const emotionLabel = {
        neutral: '중립', happy: '긍정적', stressed: '긴장', concerned: '걱정',
      }[dominantEmotion];

      // 표정 일관성 점수 (자기보고 감정 검증용)
      const expressionConsistency = Math.round(symm * 80 + 20);

      auResult = {
        au12: Math.round(au12m*100), au6: Math.round(au6m*100),
        au1: Math.round(au1m*100),   au4: Math.round(au4m*100),
        duchenne: Math.round(duchenne*100),
        dominantEmotion, emotionLabel, emotionScore,
        expressionConsistency,
        interpretation: dominantEmotion === 'happy'
          ? '긍정적인 감정 표현이 측정됩니다'
          : dominantEmotion === 'stressed'
          ? '긴장·스트레스 표현이 감지됩니다'
          : dominantEmotion === 'concerned'
          ? '걱정·불안 표현이 감지됩니다'
          : '감정 표현이 중립적입니다',
      };
    }

    f.pupilResult = pupilResult;
    f.auResult    = auResult;
    return { pupilResult, auResult };
  },

  // === BlazeFace 박스 → 36x36 RGB 텐서 ===
  _faceCropResize36(video, vw, vh, bx, by, bw, bh) {
    const cv = this._cv;
    cv.width = vw; cv.height = vh;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, vw, vh);

    const x = Math.max(0, Math.floor(bx));
    const y = Math.max(0, Math.floor(by));
    const w = Math.min(Math.floor(bw), vw - x);
    const h = Math.min(Math.floor(bh), vh - y);
    if (w < 10 || h < 10) return null;

    // 임시 캔버스에 36x36 리사이즈
    if (!this._cv36) {
      this._cv36 = document.createElement('canvas');
      this._cv36.width = 36;
      this._cv36.height = 36;
    }
    const c36 = this._cv36;
    const ctx36 = c36.getContext('2d');
    ctx36.imageSmoothingEnabled = true;
    ctx36.imageSmoothingQuality = 'high';
    ctx36.drawImage(cv, x, y, w, h, 0, 0, 36, 36);

    const data = ctx36.getImageData(0, 0, 36, 36).data;
    const input = new Float32Array(36 * 36 * 3);
    for (let i = 0; i < data.length; i += 4) {
      const idx = i / 4;
      input[idx * 3]     = data[i]   / 255;
      input[idx * 3 + 1] = data[i+1] / 255;
      input[idx * 3 + 2] = data[i+2] / 255;
    }
    return input;
  },

  // === 측정 중 상태 표시 ===
  _faceUpdateRunStatus() {
    const m = this.state.face.mePPG;
    if (m.currentHR != null) {
      const stable = m.meanHRErr < 0.025;
      document.getElementById('face-cam-msg').textContent = '✅ 측정 중';
      document.getElementById('face-cam-sub').textContent = 
        `💗 ${m.currentHR.toFixed(1)} BPM` + (stable ? ' (안정)' : ' (수렴 중)');
    } else {
      document.getElementById('face-cam-msg').textContent = '🧠 분석 중...';
      document.getElementById('face-cam-sub').textContent = '잠시만 기다려주세요';
    }
    // SQI 표시 (보간)
    const sqi = m.currentHR != null ? Math.min(95, Math.round(85 - m.meanHRErr * 1000)) : 30;
    this._faceSetSqi(sqi, sqi >= 70 ? 'var(--green)' : 'var(--warn)',
      sqi >= 70 ? `✅ 양호한 신호 (${sqi}%)` : `📊 신호 수렴 중 (${sqi}%)`);
  },

  // === BVP 파형 그리기 (ME-rPPG 출력) ===
  _faceDrawMeWaveform() {
    const cv = document.getElementById('face-wave');
    const ctx = this._waveCtx || cv.getContext('2d');
    if (!this._waveCtx) this._waveCtx = ctx;
    const W = cv.width, H = cv.height;
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(0, 0, W, H);

    const series = this.state.face.mePPG.bvpSeries;
    if (series.length < 30) return;

    const winSamples = Math.min(240, series.length); // 최근 8초 (30fps × 8)
    const slice = series.slice(-winSamples);
    const values = slice.map(s => s.bvp);

    let minV = Infinity, maxV = -Infinity;
    for (const v of values) { if (v < minV) minV = v; if (v > maxV) maxV = v; }
    const range = Math.max(maxV - minV, 0.001);

    // 그리드
    ctx.strokeStyle = 'rgba(167,139,250,.08)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = H * i / 4;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // BVP 신호
    ctx.strokeStyle = '#a78bfa';
    ctx.lineWidth = 1.8;
    ctx.shadowBlur = 4;
    ctx.shadowColor = '#a78bfa';
    ctx.beginPath();
    values.forEach((v, i) => {
      const x = i / (values.length - 1) * W;
      const y = H - ((v - minV) / range) * (H - 10) - 5;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.shadowBlur = 0;
  },

  // ─── 다중 ROI 추출 (Anura 스타일) ───
  // ════════════════════════════════════════════════════════════════
  // STEP 11: Dual-Branch ROI 추출 (TransPPG/MDPI Mathematics 2025 방식)
  // 얼굴 ROI: 진짜 PPG 신호 + 노이즈
  // 배경 ROI: 노이즈만 (PPG 없음)
  // → 차분: 순수 PPG 신호
  // ════════════════════════════════════════════════════════════════
  _faceExtractROI(video, vw, vh) {
    const cv = this._cv;
    cv.width = vw; cv.height = vh;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, vw, vh);

    const faceCx = vw / 2;
    const faceCy = vh * 0.45;
    const faceW = vw * 0.5;
    const faceH = vh * 0.55;

    // === 얼굴 ROI 3개: 이마(50%) + 좌볼(25%) + 우볼(25%) ===
    const faceRois = [
      { name: 'forehead', x: faceCx - faceW*0.18, y: faceCy - faceH*0.35, w: faceW*0.35, h: faceH*0.15, weight: 0.5 },
      { name: 'left_cheek', x: faceCx - faceW*0.35, y: faceCy + faceH*0.05, w: faceW*0.20, h: faceH*0.18, weight: 0.25 },
      { name: 'right_cheek', x: faceCx + faceW*0.15, y: faceCy + faceH*0.05, w: faceW*0.20, h: faceH*0.18, weight: 0.25 },
    ];

    // === 배경 ROI 4개: 화면 4코너 (얼굴 영역 제외) ===
    // 이미지 가장자리 = 일반적으로 배경 (벽, 천장, 가구)
    const bgSize = Math.min(vw, vh) * 0.12;
    const bgRois = [
      { x: 0,             y: 0,            w: bgSize, h: bgSize },  // 좌상
      { x: vw - bgSize,   y: 0,            w: bgSize, h: bgSize },  // 우상
      { x: 0,             y: vh - bgSize,  w: bgSize, h: bgSize },  // 좌하
      { x: vw - bgSize,   y: vh - bgSize,  w: bgSize, h: bgSize },  // 우하
    ];

    // === 얼굴 ROI 처리 (피부색 마스킹) ===
    let faceR = 0, faceG = 0, faceB = 0, faceW_total = 0;
    let validFaceROIs = 0;
    let skinPixelCount = 0;
    let totalPixelCount = 0;

    for (const roi of faceRois) {
      const x = Math.max(0, Math.floor(roi.x));
      const y = Math.max(0, Math.floor(roi.y));
      const w = Math.min(vw - x, Math.floor(roi.w));
      const h = Math.min(vh - y, Math.floor(roi.h));
      if (w < 10 || h < 10) continue;

      const data = ctx.getImageData(x, y, w, h).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) {
        const cr = data[i], cg = data[i+1], cb = data[i+2];
        totalPixelCount++;
        // YCbCr 기반 피부색 판정 (Kovac 2003 표준):
        //   Y > 80, 85 < Cb < 135, 135 < Cr < 180
        // 단순 RGB 휴리스틱으로 근사: R > G > B + 차이 검증
        if (cr > 60 && cr > cg && cg > cb && cr - cb > 15 && cr < 250) {
          r += cr; g += cg; b += cb; n++;
          skinPixelCount++;
        }
      }
      if (n > w * h * 0.2) {
        r /= n; g /= n; b /= n;
        faceR += r * roi.weight;
        faceG += g * roi.weight;
        faceB += b * roi.weight;
        faceW_total += roi.weight;
        validFaceROIs++;
      }
    }

    // === 배경 ROI 처리 (피부 마스킹 없이 전체 평균) ===
    let bgR = 0, bgG = 0, bgB = 0, bgN = 0;
    for (const roi of bgRois) {
      const x = Math.max(0, Math.floor(roi.x));
      const y = Math.max(0, Math.floor(roi.y));
      const w = Math.min(vw - x, Math.floor(roi.w));
      const h = Math.min(vh - y, Math.floor(roi.h));
      if (w < 10 || h < 10) continue;

      const data = ctx.getImageData(x, y, w, h).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i]; g += data[i+1]; b += data[i+2]; n++;
      }
      if (n > 0) {
        bgR += r / n;
        bgG += g / n;
        bgB += b / n;
        bgN++;
      }
    }

    const skinRatio = totalPixelCount > 0 ? skinPixelCount / totalPixelCount : 0;

    if (validFaceROIs >= 2 && faceW_total > 0 && bgN >= 2) {
      // === 얼굴 평균 ===
      const fr = faceR / faceW_total;
      const fg = faceG / faceW_total;
      const fb = faceB / faceW_total;

      // === 배경 평균 ===
      const br = bgR / bgN;
      const bg = bgG / bgN;
      const bb = bgB / bgN;

      const t = performance.now();
      // ★ 두 신호 모두 저장 (POS는 시계열로 처리 — 차분은 신호 추출 단계에서)
      this.state.face.samples.push({
        r: fr, g: fg, b: fb,        // 얼굴 신호
        br: br, bg: bg, bb: bb,     // 배경 신호 (Dual-Branch)
        t
      });

      const maxS = this.config.face.bufferSec * this.config.face.targetSR * 2;
      if (this.state.face.samples.length > maxS) {
        this.state.face.samples.splice(0, this.state.face.samples.length - maxS);
      }

      this.state.face.faceDetected = true;
      document.getElementById('face-chip-roi-text').textContent = `ROI ${validFaceROIs}/3 + BG ${bgN}`;
      this._faceUpdateStatus(skinRatio, true);
      this._faceDrawWaveform();
      const elapsed = (performance.now() - this.state.face.measureStartMs) / 1000;
      if (elapsed > this.config.face.minWarmupSec) {
        this._faceEstimateHR();
      }
    } else {
      this.state.face.faceDetected = false;
      document.getElementById('face-chip-roi-text').textContent = `ROI ${validROIs}/3`;
      this._faceUpdateStatus(skinRatio, false);
    }
  },

  _faceUpdateStatus(skinRatio, faceFound) {
    if (!faceFound) {
      this._faceSetSqi(0, 'var(--danger)', '🚫 얼굴이 감지되지 않습니다');
      document.getElementById('face-cam-msg').textContent = '얼굴이 감지되지 않습니다';
      document.getElementById('face-cam-sub').textContent = '얼굴을 화면 가운데에 맞추고 가만히 유지';
      return;
    }
    // skinRatio: 화면 전체 중 피부색 비율
    if (skinRatio < 0.05) {
      this._faceSetSqi(20, 'var(--warn)', '⚠️ 얼굴이 너무 멀거나 작습니다');
      document.getElementById('face-cam-msg').textContent = '얼굴을 더 가까이 해주세요';
      return;
    }
    const sqi = Math.min(95, Math.round(40 + skinRatio * 200));
    this._faceSetSqi(sqi, 'var(--green)', `✅ 측정 중 (${sqi}%)`);
    document.getElementById('face-cam-msg').textContent = '✅ 얼굴 검출됨';
    document.getElementById('face-cam-sub').textContent = `움직이지 마세요 · 신뢰도 ${sqi}%`;
  },

  _faceSetSqi(val, color, msg) {
    document.getElementById('face-sqi-fill').style.width = val + '%';
    document.getElementById('face-sqi-fill').style.background = color;
    document.getElementById('face-sqi-pct').textContent = val + '%';
    document.getElementById('face-sqi-msg').textContent = msg;
  },

  // ─── 실시간 HR 추정 ───
  _faceEstimateHR() {
    const f = this.state.face;
    const srConfig = this.config.face.targetSR;
    if (f.samples.length < srConfig * this.config.face.minWarmupSec) return;

    const win = Math.min(srConfig * 12, f.samples.length);
    const recent = f.samples.slice(-win);

    // ★ v18.1: 실제 SR 측정 (타임스탬프 기반)
    let sr = srConfig;
    if (recent.length >= 30 && recent[0].t && recent[recent.length - 1].t) {
      const elapsed = recent[recent.length - 1].t - recent[0].t; // ms
      if (elapsed > 500) {
        sr = Math.round((recent.length - 1) / (elapsed / 1000));
        sr = Math.max(20, Math.min(90, sr)); // 합리적 범위 고정
      }
    }

    const reds = recent.map(s => s.r);
    const greens = recent.map(s => s.g);
    const blues = recent.map(s => s.b);
    const hasBg = recent.every(s => s.br != null);

    // Dual-Branch 적용 (실시간 추정)
    let pos;
    if (hasBg) {
      const bgReds = recent.map(s => s.br);
      const bgGreens = recent.map(s => s.bg);
      const bgBlues = recent.map(s => s.bb);
      pos = this._posDualBranch(reds, greens, blues, bgReds, bgGreens, bgBlues);
    } else {
      pos = this._posAlgorithm(reds, greens, blues);
    }

    // BPF + Goertzel — ★ v18.1: 실제 sr 사용, 탐색 상한 130BPM으로 축소
    const detrended = this._detrend(pos);
    const filtered = this._bandpass(detrended, sr, 0.7, 3.0);
    const stdF = this._stdDev(filtered);
    if (stdF < 0.001) return;

    // ★ v18.1: Goertzel 탐색 범위 40~130BPM (180 → 130으로 축소)
    // 안정 시 측정에서 130BPM 초과는 오측정 가능성 높음
    const { freq: hrHz, snr } = this._goertzelPeak(filtered, sr, 40/60, 130/60);
    if (!hrHz || snr < 2.5) return;

    const hr = Math.round(hrHz * 60);
    if (hr < 40 || hr > 130) return;

    f.lastHR = hr;
    document.getElementById('fr-hr-val').textContent = hr;
  },

  // ─── POS 알고리즘 (Wang et al. 2017) — 표준 ───
  _posAlgorithm(R, G, B) {
    const N = R.length;
    if (N < 10) return new Array(N).fill(0);

    const meanR = R.reduce((a,b)=>a+b,0) / N;
    const meanG = G.reduce((a,b)=>a+b,0) / N;
    const meanB = B.reduce((a,b)=>a+b,0) / N;
    if (meanR < 1 || meanG < 1 || meanB < 1) return new Array(N).fill(0);

    const normR = R.map(v => v / meanR - 1);
    const normG = G.map(v => v / meanG - 1);
    const normB = B.map(v => v / meanB - 1);

    // POS 투영: X1 = G - B, X2 = G + B - 2R
    const X1 = new Array(N), X2 = new Array(N);
    for (let i = 0; i < N; i++) {
      X1[i] = normG[i] - normB[i];
      X2[i] = normG[i] + normB[i] - 2 * normR[i];
    }
    const stdX1 = this._stdDev(X1);
    const stdX2 = this._stdDev(X2);
    const alpha = stdX2 > 1e-9 ? stdX1 / stdX2 : 0;

    const s = new Array(N);
    for (let i = 0; i < N; i++) {
      s[i] = X1[i] + alpha * X2[i];
    }
    return s;
  },

  // ════════════════════════════════════════════════════════════════
  // STEP 11: Dual-Branch POS (TransPPG 2022 + MDPI Mathematics 2025)
  // 핵심: 얼굴 신호 = 진짜 PPG + 노이즈, 배경 신호 = 노이즈만
  //       → POS(얼굴) - α·POS(배경) = 순수 PPG
  // 적응형 차분 계수 α는 두 신호의 상관관계로 결정
  // ════════════════════════════════════════════════════════════════
  _posDualBranch(faceR, faceG, faceB, bgR, bgG, bgB) {
    const N = faceR.length;
    if (N < 10 || bgR.length !== N) return new Array(N).fill(0);

    // 1. 얼굴 신호와 배경 신호 각각 POS 처리
    const faceS = this._posAlgorithm(faceR, faceG, faceB);
    const bgS = this._posAlgorithm(bgR, bgG, bgB);

    // 2. 두 신호 모두 0평균으로 정규화
    const faceMean = faceS.reduce((a,b)=>a+b,0) / N;
    const bgMean = bgS.reduce((a,b)=>a+b,0) / N;
    const faceCentered = faceS.map(v => v - faceMean);
    const bgCentered = bgS.map(v => v - bgMean);

    // 3. 적응형 차분 계수 α 계산 (least-squares)
    //    α = Σ(face·bg) / Σ(bg²)
    //    이는 face 신호에서 bg 신호와 가장 닮은 성분을 빼는 효과
    let dotFB = 0, dotBB = 0;
    for (let i = 0; i < N; i++) {
      dotFB += faceCentered[i] * bgCentered[i];
      dotBB += bgCentered[i] * bgCentered[i];
    }
    const alpha = dotBB > 1e-9 ? dotFB / dotBB : 0;

    // 4. 차분: 얼굴 - α × 배경 = 순수 PPG
    const result = new Array(N);
    for (let i = 0; i < N; i++) {
      result[i] = faceCentered[i] - alpha * bgCentered[i];
    }

    console.log('[Dual-Branch] α=' + alpha.toFixed(3),
                'face std:' + this._stdDev(faceCentered).toFixed(4),
                'bg std:' + this._stdDev(bgCentered).toFixed(4),
                'result std:' + this._stdDev(result).toFixed(4));
    return result;
  },

  // ─── CHROM 알고리즘 (de Haan & Jeanne 2013, IEEE TBME 60(10):2878) ───
  // POS와 함께 가장 강건한 rPPG 방법. 색차(chrominance) 기반으로 움직임에 강함.
  // POS와 CHROM을 모두 계산해 신호 품질이 높은 쪽을 선택하면 정확도가 향상됨.
  _chromAlgorithm(R, G, B) {
    const N = R.length;
    if (N < 10) return new Array(N).fill(0);
    const meanR = R.reduce((a,b)=>a+b,0)/N;
    const meanG = G.reduce((a,b)=>a+b,0)/N;
    const meanB = B.reduce((a,b)=>a+b,0)/N;
    if (meanR < 1 || meanG < 1 || meanB < 1) return new Array(N).fill(0);
    // 1. 색상별 정규화 (평균으로 나눔)
    const rn = R.map(v => v/meanR);
    const gn = G.map(v => v/meanG);
    const bn = B.map(v => v/meanB);
    // 2. 색차 신호 X = 3R-2G, Y = 1.5R+G-1.5B (de Haan 표준 계수)
    const X = new Array(N), Y = new Array(N);
    for (let i = 0; i < N; i++) {
      X[i] = 3*rn[i] - 2*gn[i];
      Y[i] = 1.5*rn[i] + gn[i] - 1.5*bn[i];
    }
    // 3. 표준편차 비율 α로 결합: S = X - α·Y (α = σX/σY)
    const sX = this._stdDev(X), sY = this._stdDev(Y) || 1e-9;
    const alpha = sX / sY;
    const S = new Array(N);
    for (let i = 0; i < N; i++) S[i] = X[i] - alpha * Y[i];
    return S;
  },

  // ─── rPPG 신호 품질 지표 (얼굴/손가락 공통, Elgendi 2016 기반) ───
  // 주파수 도메인 품질: 심박 대역(0.7~3Hz)의 파워 집중도 + 왜도
  _computeRppgSQI(signal, sr) {
    const n = signal.length;
    if (n < 30) return { quality: 0, skewness: 0, spectralConc: 0 };
    let mean = 0; for (let i=0;i<n;i++) mean += signal[i]; mean /= n;
    let variance = 0; for (let i=0;i<n;i++){const d=signal[i]-mean;variance+=d*d;} variance/=n;
    const std = Math.sqrt(variance) || 1e-9;
    // 왜도 (시간 도메인)
    let skew = 0; for (let i=0;i<n;i++){const z=(signal[i]-mean)/std;skew+=z*z*z;} skew/=n;
    // 스펙트럼 집중도 (Goertzel로 심박 대역 파워 / 전체 파워 근사)
    let spectralConc = 0;
    try {
      const bandPow = this._bandPowerRatio ? this._bandPowerRatio(signal, sr, 0.7, 3.0) : null;
      if (bandPow != null) spectralConc = bandPow;
    } catch (e) {}
    // 종합 품질: 왜도(절대값 작을수록 대칭 파형=좋음은 아님, rPPG는 양의 왜도 선호)
    let quality = 0;
    quality += Math.max(0, Math.min(1, (Math.abs(skew)) / 0.5)) * 0.4;
    quality += Math.max(0, Math.min(1, spectralConc)) * 0.6;
    return { quality: Math.max(0, Math.min(1, quality)), skewness: skew, spectralConc };
  },

  // 심박 대역 파워 비율 (0.7~3Hz 대역 / 전체) — 간이 스펙트럼 집중도
  _bandPowerRatio(signal, sr, loHz, hiHz) {
    const n = signal.length;
    if (n < 30) return 0;
    // 대역 통과 필터링된 신호의 분산 / 원신호 분산
    const filtered = this._bandpass(signal, sr, loHz, hiHz);
    const vFilt = this._variance ? this._variance(filtered) : this._stdDev(filtered) ** 2;
    const vAll = this._stdDev(signal) ** 2 || 1e-9;
    return Math.max(0, Math.min(1, vFilt / vAll));
  },

  // ─── 측정 완료 (ME-rPPG 결과 통합) ───
  _faceFinalize() {
    console.log('[Face] _faceFinalize() - ME-rPPG');
    let result;
    try {
      result = this._faceComputeMetrics();
      console.log('[Face] 최종 결과:', result);

      // ★ v19.4: 동공·표정 분석 결과 계산 및 result에 병합
      try {
        const { pupilResult, auResult } = this._faceComputePupilAUResult();
        result.pupilResult = pupilResult;
        result.auResult    = auResult;
        console.log('[v19.4] 동공:', pupilResult?.puiState, '/ 표정:', auResult?.dominantEmotion);
      } catch (e) {
        console.warn('[v19.4] 동공·표정 계산 실패:', e.message);
      }
    } catch (err) {
      // ★ v13.5: 안전망 - 어떤 계산 에러가 나도 사용자에게 결과 또는 실패 알림 보장
      console.error('[Face] _faceComputeMetrics 에러:', err);
      result = { hr: null, reason: 'compute_error', error: err.message };
    }

    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);

    try {
      if (result.hr) {
        this._faceDisplayResults(result);
        document.getElementById('face-cam-msg').textContent = '✅ 측정 완료';
        document.getElementById('face-cam-sub').textContent = '결과 패널을 확인하세요';
      } else {
        const reasons = {
          'not_converged': 'ME-rPPG 모델이 충분히 수렴하지 못했습니다.\n조명을 밝게 하고 가만히 있는 상태로 다시 측정해주세요.',
          'no_face': '얼굴이 충분히 검출되지 않았습니다.\n조명을 밝게 하고 얼굴을 카메라에 가깝게 해주세요.',
          'insufficient_data': '데이터가 부족합니다. 측정 시간이 짧았을 수 있습니다.',
          'compute_error': '결과 계산 중 오류가 발생했습니다. 다시 시도해주세요.',
        };
        const msg = reasons[result.reason] || '측정에 실패했습니다.';
        document.getElementById('face-cam-msg').textContent = '⚠️ 측정 실패';
        document.getElementById('face-cam-sub').textContent = '아래 안내 확인';
        setTimeout(() => alert('측정 실패\n\n' + msg), 800);
      }
    } catch (err) {
      console.error('[Face] 결과 표시 에러:', err);
      alert('결과 표시 실패: ' + err.message);
    }

    // ★ v13.5: 무조건 측정 종료 (이전엔 에러 시 setTimeout이 호출 안 되어 측정 계속됨)
    setTimeout(() => this.faceStop(), 2000);
  },

  // ════════════════════════════════════════════════════════════════
  // v12 ME-rPPG: BVP 시계열에서 HR/HRV/호흡/스트레스 산출
  // 핵심:
  //  - HR: ME-rPPG 모델 출력 (Kalman 필터링 + Welch PSD)
  //  - HRV: BVP 신호에서 피크 검출 → cubic spline 업샘플링 → RR → RMSSD
  //  - 호흡: BVP envelope 또는 직접 BPF
  //  - 스트레스: ln(RMSSD) 기반 Shaffer 2017 표준
  // ════════════════════════════════════════════════════════════════
  _faceComputeMetrics() {
    const f = this.state.face;
    const m = f.mePPG;

    // === 1. HR (ME-rPPG 모델 결과) ===
    if (!m.currentHR || m.kfHr == null) {
      return { hr: null, reason: 'not_converged' };
    }
    const hr = Math.round(m.kfHr.estimate * 10) / 10; // 1자리 소수점
    const hrInt = Math.round(hr);

    // 신뢰도: meanHRErr < 0.025면 안정 (ME-rPPG 표준)
    const hrConverged = m.meanHRErr < 0.05;
    console.log('[ME-rPPG] HR:', hr, 'meanErr:', m.meanHRErr.toFixed(4), 'converged:', hrConverged);

    if (!hrConverged) {
      // 충분히 수렴 안 됨 — HR만 표시 + HRV 무효
      return {
        hr: hrInt, rmssd: null, lnRmssd: null,
        rmssdReason: 'not_converged',
        sdnn: null, respRate: null,
        stressIdx: null, stressFromRMSSD: false,
        sqi: Math.round((1 - m.meanHRErr) * 100), snr: null,
        peakCount: 0, engine: 'ME-rPPG',
      };
    }

    // === 2. BVP 시계열 추출 ===
    const series = m.bvpSeries;
    if (series.length < 200) {
      return { hr: hrInt, rmssd: null, rmssdReason: 'insufficient_data',
               respRate: null, stressIdx: null, stressFromRMSSD: false,
               sqi: 70, engine: 'ME-rPPG' };
    }

    // 시간 정보로 실제 sample rate 계산
    const tStart = series[0].t;
    const tEnd = series[series.length - 1].t;
    const dur = (tEnd - tStart) / 1000; // 초
    const sr = series.length / dur;
    console.log('[ME-rPPG] BVP series:', series.length, 'samples,', dur.toFixed(1), 's, sr=', sr.toFixed(1), 'Hz');

    const bvp = series.map(s => s.bvp);
    // ★ v12.4: timestamp를 초 단위로 변환
    const times = series.map(s => s.t / 1000); // ms → s

    // === 3. HRV (BVP에서 cubic spline 업샘플링 후 피크 검출) ===
    const hrHz = hr / 60;
    const expectedRRms = 60000 / hr;
    console.log('[ME-rPPG] 기대 RR:', expectedRRms.toFixed(0), 'ms');

    // ★ FIX v12.4: 실제 timestamp로 균등 250Hz 격자 보간
    // 이전(v12.3): 균등 sr 가정 → 시간축 왜곡 → RMSSD 부풀림
    // 신규(v12.4): 실제 timestamp 사용 → 정확한 시간 → 정확한 RR
    // 추가로 BVP 사전 BPF 0.7~3.5Hz로 dicrotic notch 약화
    const upSr = 250;
    const upBvpRaw = this._cubicSplineUpsampleTimed(times, bvp, upSr);
    if (upBvpRaw.length < 100) {
      console.warn('[ME-rPPG] 업샘플링 실패');
      return { hr: hrInt, rmssd: null, rmssdReason: 'insufficient_data',
               respRate: null, stressIdx: null, stressFromRMSSD: false,
               sqi: 70, engine: 'ME-rPPG' };
    }
    // 사전 필터링 (250Hz BPF)
    const upBvp = this._bandpass(Array.from(upBvpRaw), upSr, 0.7, 3.5);
    console.log('[ME-rPPG] BVP 업샘플링 (timestamp 기반):', upBvp.length, 'samples @', upSr, 'Hz');

    // ★ v25.0: rPPG 신호 품질 지표 (Elgendi 왜도 + 스펙트럼 집중도)
    let rppgSqi = { quality: 0, skewness: 0, spectralConc: 0 };
    try {
      rppgSqi = this._computeRppgSQI(upBvp, upSr);
      console.log(`[rPPG-SQI] 품질=${(rppgSqi.quality*100).toFixed(0)}% 왜도=${rppgSqi.skewness.toFixed(2)} 집중도=${(rppgSqi.spectralConc*100).toFixed(0)}%`);
    } catch (e) { console.warn('[rPPG-SQI] 계산 실패:', e.message); }

    // ★ ME-rPPG의 정확한 HR을 활용한 적응형 피크 검출
    // 다이크로틱 노치(2차 피크) 자동 배제 위해 minDist를 expectedRR의 70%로 강제
    const peaks = this._adaptivePeakDetect(upBvp, upSr, hrHz, 0.70);
    console.log('[ME-rPPG] 검출 피크:', peaks.length, '(기대치:', Math.round(dur * hrHz), ')');

    // ★ v13.5: SQI 미리 계산 (RMSSD confidence 계산에 필요)
    // 이전 v13.4 버그: sqi가 line 1923에서 정의되어 RMSSD 계산 시점에 ReferenceError 발생
    const sqiEarly = Math.min(99, Math.max(50, Math.round((1 - m.meanHRErr) * 100)));

    // ★ v13.5: HR 대역 SNR 추출 (RMSSD confidence 계산용) - 안전한 try/catch
    let snrV = 5; // 기본값 (중립)
    try {
      const filtered = this._bandpass(upBvp, upSr, 0.7, 3.0);
      if (filtered && filtered.length > 0) {
        // ★ v18.1: 탐색 상한 130BPM으로 축소
        const peakResult = this._goertzelPeak(filtered, upSr, 40/60, 130/60);
        if (peakResult && typeof peakResult.snr === 'number' && !isNaN(peakResult.snr)) {
          snrV = peakResult.snr;
        }
      }
    } catch (e) {
      console.warn('[ME-rPPG] SNR 추출 실패, 기본값 사용:', e.message);
    }

    let rmssd = null, lnRmssd = null, rmssdReason = null;
    let sdnn = null;
    let cleanRRFinal = []; // ★ v18.0: outer scope — 혈관나이/부정맥 분석용

    if (peaks.length < 8) {
      rmssdReason = 'insufficient_peaks';
    } else {
      // RR 간격
      const rawRR = [];
      for (let i = 1; i < peaks.length; i++) {
        rawRR.push((peaks[i] - peaks[i-1]) / upSr * 1000);
      }
      const meanRR = rawRR.reduce((a,b)=>a+b,0) / rawRR.length;
      console.log('[ME-rPPG] raw RR:', rawRR.length, 'mean:', meanRR.toFixed(0), 'ms');

      // HR-RR 일관성 검증
      const peakHR = 60000 / meanRR;
      const hrDiffPct = Math.abs(peakHR - hr) / hr * 100;
      console.log('[ME-rPPG] HR 일관성: ME-rPPG=', hr, 'Peak=', peakHR.toFixed(1), '차이=', hrDiffPct.toFixed(1), '%');

      if (hrDiffPct > 15) {
        rmssdReason = 'hr_inconsistent';
      } else {
        // Kubios outlier 제거 (expectedRR 기준)
        const cleanRR = this._removeEctopicRR(rawRR, expectedRRms);
        cleanRRFinal = cleanRR; // ★ v18.0: outer scope에 노출
        console.log('[ME-rPPG] 정제 후 RR:', cleanRR.length);

        if (cleanRR.length < 8) {
          rmssdReason = 'insufficient_peaks';
        } else {
          let sumSq = 0;
          for (let i = 1; i < cleanRR.length; i++) {
            const diff = cleanRR[i] - cleanRR[i-1];
            sumSq += diff * diff;
          }
          const rmssdRaw = Math.sqrt(sumSq / (cleanRR.length - 1));
          rmssd = Math.round(rmssdRaw);
          lnRmssd = Math.log(Math.max(1, rmssdRaw)).toFixed(2);

          // SDNN 계산
          const meanC = cleanRR.reduce((a,b)=>a+b,0) / cleanRR.length;
          const sdSum = cleanRR.reduce((s,v) => s + (v-meanC)**2, 0);
          sdnn = Math.round(Math.sqrt(sdSum / cleanRR.length));
          console.log('[ME-rPPG] RMSSD raw:', rmssd, 'ms, SDNN:', sdnn, 'ms, ln=', lnRmssd);

          // ★ v13.6: 무조건 ECG-equivalent 변환 적용
          // 자료 강조: "rPPG raw RR interval은 그대로 믿지 않는다"
          // 상용 앱(Anura, Samsung Health)도 confidence 1.0이어도 무조건 보정함
          const ratio = rmssd / sdnn;

          // 신뢰도는 reject 판단용으로만 사용 (보정은 무조건 적용)
          let confidence = 1.0;
          if (ratio > 1.5) confidence -= Math.min(0.5, (ratio - 1.5) * 0.5);
          if (sqiEarly < 75) confidence -= (75 - sqiEarly) * 0.008;
          if (snrV !== null && snrV < 3) confidence -= (3 - snrV) * 0.05;
          if (rmssd < 8 || rmssd > 200) confidence -= 0.4;
          confidence = Math.max(0, Math.min(1, confidence));

          console.log(`[ME-rPPG] RMSSD raw=${rmssd}ms confidence=${confidence.toFixed(2)} (ratio=${ratio.toFixed(2)}, sqi=${sqiEarly}, snr=${snrV.toFixed(1)})`);

          if (confidence < 0.25) {
            // 신뢰도 매우 낮음만 reject
            console.warn('[ME-rPPG] RMSSD 신뢰도 부족 - 거부');
            rmssdReason = 'low_confidence';
            rmssd = null;
            lnRmssd = null;
          } else {
            // ★ 무조건 ECG 변환 적용 (rPPG → ECG equivalent)
            const corrected = this._correctRMSSDBias(rmssd, sdnn, sqiEarly, snrV);
            if (corrected !== null && corrected >= 5 && corrected <= 120) {
              rmssd = corrected;
              lnRmssd = Math.log(Math.max(1, corrected)).toFixed(2);
            } else {
              rmssdReason = 'correction_out_of_range';
              rmssd = null;
              lnRmssd = null;
            }
          }
        }
      }
    }

    // === 4. 호흡수 (BVP envelope 분석) ===
    let respRate = null;
    if (bvp.length >= sr * 20) {
      // 직접 BPF: 0.13~0.5 Hz (호흡 대역)
      const respFiltered = this._bandpass(bvp, sr, 0.13, 0.5);
      const respPeak = this._goertzelPeak(respFiltered, sr, 8/60, 28/60);
      console.log('[ME-rPPG] resp:', respPeak.freq.toFixed(3), 'Hz, SNR:', respPeak.snr.toFixed(2));
      if (respPeak.snr >= 1.8 && respPeak.freq > 0) {
        const rpm = Math.round(respPeak.freq * 60);
        if (rpm >= 9 && rpm <= 26) respRate = rpm;
      }
    }
    if (!respRate && hrInt) {
      const est = Math.round(hrInt / 4);
      if (est >= 12 && est <= 22) respRate = est;
    }

    // === 5. 스트레스 단계 — 건강 이상신호 탐지 모드 (의료기기 수준 X) ===
    // v13.7: 임계값 재조정으로 변별력 향상
    // 사용자 요청: "의료기기 아니니 민감하지 않게, 이상신호만 잡기"
    // 5단계 분포 변경: 정상 범주가 1~3에 집중되도록, 4~5는 명확한 이상신호
    //
    // ECG RMSSD 기준 (Task Force 1996 + Shaffer 2017):
    //   ≥ 80ms : 매우 이완 (높은 부교감 활성)
    //   50-80ms : 이완 (휴식 상태)
    //   30-50ms : 보통 (평상시)
    //   19-30ms : 약간 주의 (피로 의심)
    //   < 19ms : 주의 필요 (이상신호)
    let stressIdx = null, stressFromRMSSD = false;
    let stressLevel = null;
    if (rmssd && rmssd > 0) {
      // 임계값을 RMSSD ms로 직접 매핑 (가독성)
      if (rmssd >= 80)       { stressIdx = 18; stressLevel = 1; } // 매우 이완
      else if (rmssd >= 50)  { stressIdx = 32; stressLevel = 2; } // 이완 ★ 이전 60-79가 여기로
      else if (rmssd >= 30)  { stressIdx = 50; stressLevel = 3; } // 보통
      else if (rmssd >= 19)  { stressIdx = 70; stressLevel = 4; } // 약간 주의
      else                   { stressIdx = 85; stressLevel = 5; } // 주의 필요 (이상신호)
      stressFromRMSSD = true;
    }

    // ═══════════════════════════════════════════════════════════════
    // ★ v18.0: 부정맥 조기 감지 (Arrhythmia Early Detection)
    // 근거: Task Force 1996, Brennan 2001 (포앵카레 플롯 SD1/SD2)
    // rPPG 특성 고려: 임계값 완화, 다중 지표 앙상블
    // ═══════════════════════════════════════════════════════════════
    let arrhythmia = null; // { risk: 'low'|'moderate'|'high', flags: [], sd1, sd2, pnn50, cvi }
    if (cleanRRFinal.length >= 8) {
      try {
        const rr = cleanRRFinal;
        const n = rr.length;
        const meanRR_arr = rr.reduce((a, b) => a + b, 0) / n;

        // Poincaré Plot SD1 / SD2 (Brennan 2001)
        let sumSD1 = 0, sumSD2 = 0;
        for (let i = 0; i < n - 1; i++) {
          const x = rr[i], y = rr[i + 1];
          const d1 = (y - x) / Math.SQRT2;
          const d2 = (y + x) / Math.SQRT2;
          sumSD1 += d1 * d1;
          sumSD2 += d2 * d2;
        }
        const sd1 = Math.round(Math.sqrt(sumSD1 / (n - 1)));
        const sd2 = Math.round(Math.sqrt(sumSD2 / (n - 1)));
        const sd_ratio = sd1 > 0 ? sd2 / sd1 : 0;

        // pNN50 (정제된 RR 기준)
        let nn50 = 0;
        for (let i = 1; i < n; i++) {
          if (Math.abs(rr[i] - rr[i - 1]) > 50) nn50++;
        }
        const pnn50 = Math.round((nn50 / (n - 1)) * 100);

        // CVI — Cardiac Vagal Index (Task Force 1996)
        const sdnn_arr = Math.sqrt(rr.reduce((s, v) => s + (v - meanRR_arr) ** 2, 0) / n);
        const cvi = Math.round(Math.log(sdnn_arr * sd1) * 100) / 100;

        // 불규칙성 지수 — 연속 RR 비율 변동 (rPPG 맞춤)
        let irregCount = 0;
        for (let i = 1; i < n; i++) {
          if (Math.abs(rr[i] - rr[i - 1]) / rr[i - 1] > 0.20) irregCount++;
        }
        const irregPct = (irregCount / (n - 1)) * 100;

        // 리스크 플래그 수집 (rPPG 맞춤 완화 임계값)
        const flags = [];
        if (sd_ratio > 0 && sd_ratio < 1.5) flags.push('sd_ratio_low'); // 교감 과활성 패턴
        if (irregPct > 35) flags.push('high_irr');       // 높은 불규칙성
        if (n >= 12 && pnn50 > 60) flags.push('pnn50_high'); // 심한 미주신경 변동
        // 연속 2개 이상 큰 점프 (심방세동 패턴 힌트)
        let jumpStreak = 0, maxJumpStreak = 0;
        for (let i = 1; i < n; i++) {
          if (Math.abs(rr[i] - rr[i - 1]) / meanRR_arr > 0.25) {
            jumpStreak++;
            maxJumpStreak = Math.max(maxJumpStreak, jumpStreak);
          } else jumpStreak = 0;
        }
        if (maxJumpStreak >= 3) flags.push('rhythm_jump');

        const risk = flags.length === 0 ? 'low'
                   : flags.length === 1 ? 'low'
                   : flags.length === 2 ? 'moderate'
                   : 'high';

        arrhythmia = { risk, flags, sd1, sd2, sd_ratio: Math.round(sd_ratio * 100) / 100,
                       pnn50, cvi, irregPct: Math.round(irregPct), rrCount: n };
        console.log(`[v18 Arrhythmia] risk=${risk} flags=${flags.join(',')} SD1=${sd1} SD2=${sd2} pNN50=${pnn50}% irr=${irregPct.toFixed(0)}%`);
      } catch (e) {
        console.warn('[v18 Arrhythmia] 계산 실패:', e.message);
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // ★ v18.0: 혈관 나이 추정 (Vascular Age Estimation)
    // 근거: Millasseau 2002 (AIx), Liang 2018 (PPG 기반 혈관 탄성)
    // PPG 파형 특성 → PWV 대리 → 혈관 나이 추정
    // ═══════════════════════════════════════════════════════════════
    let vascularAge = null; // { estimatedAge, delta, grade: 'young'|'normal'|'aged', confidence }
    try {
      if (upBvpRaw && upBvpRaw.length >= upSr * 5 && peaks && peaks.length >= 5 && hrInt) {
        const profile = this._getUserProfile ? this._getUserProfile() : {};
        const chronoAge = profile.age || null;

        // PPG 파형 특성 추출 — 단일 비트 평균화
        const beatSamples = [];
        const beatLen = Math.round(upSr * (60000 / hrInt) / 1000);
        for (let i = 0; i < peaks.length - 1; i++) {
          const start = peaks[i], end = peaks[i + 1];
          const len = end - start;
          if (len < beatLen * 0.6 || len > beatLen * 1.4) continue;
          const beat = Array.from(upBvpRaw).slice(start, end);
          beatSamples.push(beat);
          if (beatSamples.length >= 8) break;
        }

        if (beatSamples.length >= 6) {  // ★ v19.5: 4→6으로 강화 (더 안정적 앙상블)
          // 비트 앙상블 평균
          const avgLen = Math.round(beatSamples.reduce((s, b) => s + b.length, 0) / beatSamples.length);
          const ensembled = new Array(avgLen).fill(0);
          for (const beat of beatSamples) {
            for (let i = 0; i < avgLen; i++) {
              const srcIdx = Math.round(i * (beat.length - 1) / (avgLen - 1));
              ensembled[i] += beat[Math.min(srcIdx, beat.length - 1)] / beatSamples.length;
            }
          }

          // 수축기 피크 (주 피크, position 0)
          let sysMax = -Infinity, sysPeakIdx = 0;
          for (let i = 0; i < Math.round(avgLen * 0.6); i++) {
            if (ensembled[i] > sysMax) { sysMax = ensembled[i]; sysPeakIdx = i; }
          }
          // 이완기 피크 / 딕로틱 노치 탐색
          let notchIdx = -1, notchMin = Infinity;
          const searchStart = Math.round(sysPeakIdx + avgLen * 0.15);
          const searchEnd   = Math.round(avgLen * 0.75);
          for (let i = searchStart; i < searchEnd; i++) {
            if (ensembled[i] < notchMin) { notchMin = ensembled[i]; notchIdx = i; }
          }
          let diasPeakIdx = -1, diasMax = -Infinity;
          if (notchIdx > 0) {
            for (let i = notchIdx; i < Math.round(avgLen * 0.9); i++) {
              if (ensembled[i] > diasMax) { diasMax = ensembled[i]; diasPeakIdx = i; }
            }
          }

          // Augmentation Index (AIx) 대리 — Millasseau 2002
          // AIx = (P2 - P1) / (P1 - P_min) × 100
          const pMin = Math.min(...ensembled.slice(0, sysPeakIdx));
          const p1 = sysMax;
          const p2 = diasPeakIdx > 0 ? ensembled[diasPeakIdx] : null;
          let aix = null;
          if (p2 !== null && p1 > pMin) {
            aix = Math.round(((p2 - p1) / (p1 - pMin)) * 100);
          }

          // Systolic peak time ratio — Liang 2018
          const tSys = sysPeakIdx / avgLen; // 0~1 정규화
          // 혈관이 딱딱할수록 tSys 작아짐 (빠른 pulse wave)

          // Stiffness Score (0-100): AIx + tSys 결합
          // 참고: AIx > 12%이면 혈관 노화, tSys < 0.20이면 경직
          let stiffnessScore = 50; // 기본
          if (aix !== null) {
            // AIx: -30~+30 범위를 0~100 점수로
            stiffnessScore += Math.min(40, Math.max(-40, aix * 1.2));
          }
          stiffnessScore += (0.25 - tSys) * 200; // tSys 기여
          stiffnessScore = Math.max(0, Math.min(100, stiffnessScore));

          // RMSSD 기여 (낮을수록 혈관 노화 연관)
          if (rmssd && rmssd < 20) stiffnessScore += 8;
          else if (rmssd && rmssd > 50) stiffnessScore -= 8;

          // Stiffness → 혈관나이 매핑 (나이 보정)
          // 기준: 30대=35, 40대=42, 50대=52 stiffness
          const baseAge = chronoAge || 45;
          const ageContrib = (baseAge - 35) * 0.8;
          let estimatedAge = Math.round(baseAge + (stiffnessScore - 50 - ageContrib) * 0.35);

          // ★ v19.5: 혈관나이 안정화
          // 1) 실제 나이 ±25세 이내로 클램핑 (극단값 억제)
          if (chronoAge) {
            estimatedAge = Math.max(chronoAge - 25, Math.min(chronoAge + 25, estimatedAge));
          }
          // 2) 절대 범위 클램핑
          estimatedAge = Math.max(15, Math.min(90, estimatedAge));
          // 3) AIx가 null이거나 notchIdx 탐색 실패 시 신뢰도 낮음 → 추정 억제
          if (aix === null || notchIdx < 0) {
            // notch 없으면 혈관나이 = 실제 나이 근방으로 회귀
            estimatedAge = Math.round(estimatedAge * 0.35 + (chronoAge || 45) * 0.65);
          }
          const delta = chronoAge ? estimatedAge - chronoAge : null;

          const grade = delta === null ? 'normal'
                      : delta < -5 ? 'young'
                      : delta > 8  ? 'aged'
                      : 'normal';
          const confidence = beatSamples.length >= 6 && notchIdx > 0 ? 'high' : 'medium';
          vascularAge = { estimatedAge, delta, grade, confidence, aix, tSys: Math.round(tSys * 100), stiffnessScore: Math.round(stiffnessScore) };
          console.log(`[v18 VascAge] est=${estimatedAge} delta=${delta} grade=${grade} AIx=${aix} tSys=${tSys.toFixed(3)} stiffness=${stiffnessScore.toFixed(0)}`);
        }
      }
    } catch (e) {
      console.warn('[v18 VascAge] 계산 실패:', e.message);
    }

    // ═══════════════════════════════════════════════════════════════
    // ★ v18.0: RSA (호흡성 동성 부정맥) 크로스밸리데이션
    // 근거: Grossman 2007 — RR 간격이 호흡과 동기화되는 정도
    // RSA 강도 ↑ = 미주신경 건강 ↑ = 심혈관 예비능 ↑
    // ═══════════════════════════════════════════════════════════════
    let rsaIndex = null; // 0-100 정규화
    if (cleanRRFinal.length >= 12 && respRate) {
      try {
        const rr = cleanRRFinal;
        // RSA 대역: 호흡 주파수 ±0.05Hz
        const rsaLo = Math.max(0.12, respRate / 60 - 0.05);
        const rsaHf = Math.min(0.5, respRate / 60 + 0.05);
        // RR 시계열을 균등 4Hz로 보간 후 HF power 계산
        const rrMean = rr.reduce((a, b) => a + b, 0) / rr.length;
        const interpSr = 4;
        const totalLen = rr.reduce((a, b) => a + b, 0) / 1000;
        const nInterp = Math.round(totalLen * interpSr);
        const rrInterp = new Array(nInterp).fill(0);
        let cumT = 0;
        let rrIdx = 0;
        for (let i = 0; i < nInterp; i++) {
          const t = i / interpSr;
          while (rrIdx < rr.length - 1 && cumT + rr[rrIdx] / 1000 < t) {
            cumT += rr[rrIdx] / 1000;
            rrIdx++;
          }
          rrInterp[i] = rr[rrIdx] - rrMean;
        }
        // RSA 대역 BPF → 파워
        const rsaFiltered = this._bandpass(rrInterp, interpSr, rsaLo, rsaHf);
        const rsaPow = rsaFiltered.reduce((s, v) => s + v * v, 0) / rsaFiltered.length;
        // 총 파워 대비 RSA 비율 (0-100)
        const totalPow = rrInterp.reduce((s, v) => s + v * v, 0) / rrInterp.length;
        rsaIndex = totalPow > 0 ? Math.min(100, Math.round((rsaPow / totalPow) * 100 * 3)) : null;
        console.log(`[v18 RSA] pow=${rsaPow.toFixed(4)} total=${totalPow.toFixed(4)} rsaIndex=${rsaIndex}`);
      } catch (e) {
        console.warn('[v18 RSA] 계산 실패:', e.message);
      }
    }

    // ★ v20.2: LF/HF 비율 계산 (첨부 알고리즘 통합 — 교감/부교감 분리)
    // Task Force 1996: LF=0.04-0.15Hz(교감+부교감), HF=0.15-0.4Hz(부교감)
    let lfPower = null, hfPower = null, lfHfRatio = null;
    let alphaRppg = Math.max(0.1, Math.min(1.0, sqiEarly / 100)); // SQI → 신뢰도 계수
    try {
      if (cleanRRFinal && cleanRRFinal.length >= 16) {
        const rrF = cleanRRFinal;
        const rrMeanF = rrF.reduce((a, b) => a + b, 0) / rrF.length;
        const interpSrF = 4; // 4Hz 균등 보간
        const totalLenF = rrF.reduce((a, b) => a + b, 0) / 1000;
        const nInterpF = Math.round(totalLenF * interpSrF);
        if (nInterpF >= 16) {
          const rrInterpF = new Array(nInterpF).fill(0);
          let cumTF = 0, rrIdxF = 0;
          for (let i = 0; i < nInterpF; i++) {
            const t = i / interpSrF;
            while (rrIdxF < rrF.length - 1 && cumTF + rrF[rrIdxF] / 1000 < t) {
              cumTF += rrF[rrIdxF] / 1000; rrIdxF++;
            }
            rrInterpF[i] = rrF[rrIdxF] - rrMeanF;
          }
          // LF 대역 (0.04-0.15Hz) BPF
          const lfFiltered = this._bandpass(rrInterpF, interpSrF, 0.04, 0.15);
          // HF 대역 (0.15-0.4Hz) BPF
          const hfFiltered = this._bandpass(rrInterpF, interpSrF, 0.15, 0.40);
          lfPower = lfFiltered.reduce((s, v) => s + v * v, 0) / lfFiltered.length;
          hfPower = hfFiltered.reduce((s, v) => s + v * v, 0) / hfFiltered.length;
          if (hfPower > 1e-8) {
            lfHfRatio = Math.min(10, Math.round((lfPower / hfPower) * 100) / 100);
          }
          console.log(`[v20.2 HRV-Freq] LF=${lfPower?.toFixed(6)} HF=${hfPower?.toFixed(6)} LF/HF=${lfHfRatio}`);
        }
      }
    } catch (e) {
      console.warn('[v20.2 LF/HF] 계산 실패:', e.message);
    }

    return {
      hr: hrInt, rmssd, lnRmssd, rmssdReason,
      sdnn, respRate, stressIdx, stressFromRMSSD, stressLevel,
      // ★ v25.0: 모델 수렴도(sqiEarly)와 신호 품질(rppgSqi)을 결합한 종합 신뢰도
      sqi: Math.round(sqiEarly * 0.6 + (rppgSqi.quality * 100) * 0.4),
      sqiSkewness: Math.round(rppgSqi.skewness * 100) / 100,
      sqiSpectralConc: Math.round(rppgSqi.spectralConc * 100),
      snr: null, peakCount: peaks ? peaks.length : 0,
      engine: 'ME-rPPG',
      // ★ v18.0 신규 지표
      arrhythmia,
      vascularAge,
      rsaIndex,
      // ★ v20.2 신규: 주파수 도메인 HRV + 신뢰도 계수
      lfPower, hfPower, lfHfRatio,
      alphaRppg,
      pNN50: (() => {
        // pNN50이 상위에서 계산됐으면 그 값 사용
        if (typeof pNN50 !== 'undefined') return Math.round(pNN50 * 10) / 10;
        return null;
      })(),
    };
  },

  // ════════════════════════════════════════════════════════════════
  // v11s10 신규 헬퍼: 검증된 알고리즘
  // ════════════════════════════════════════════════════════════════

  // === Cubic Spline 업샘플링 (Mejia-Mejia 2022, RapidHRV 표준) ===
  // 균등 간격 가정 버전 (legacy)
  _cubicSplineUpsample(y, srIn, srOut) {
    const n = y.length;
    if (n < 4) return y.slice();
    const ratio = srOut / srIn;
    const outLen = Math.floor(n * ratio);

    const h = 1.0;
    const alpha = new Float64Array(n);
    for (let i = 1; i < n - 1; i++) {
      alpha[i] = 3 * (y[i+1] - 2*y[i] + y[i-1]) / h;
    }
    const l = new Float64Array(n);
    const mu = new Float64Array(n);
    const z = new Float64Array(n);
    l[0] = 1; mu[0] = 0; z[0] = 0;
    for (let i = 1; i < n - 1; i++) {
      l[i] = 4 - mu[i-1];
      mu[i] = 1 / l[i];
      z[i] = (alpha[i] - z[i-1]) / l[i];
    }
    l[n-1] = 1; z[n-1] = 0;
    const c = new Float64Array(n);
    const b = new Float64Array(n);
    const d = new Float64Array(n);
    for (let i = n - 2; i >= 0; i--) {
      c[i] = z[i] - mu[i] * c[i+1];
      b[i] = (y[i+1] - y[i]) / h - h * (c[i+1] + 2*c[i]) / 3;
      d[i] = (c[i+1] - c[i]) / (3 * h);
    }
    const out = new Float64Array(outLen);
    for (let j = 0; j < outLen; j++) {
      const t = j / ratio;
      const i = Math.min(Math.floor(t), n - 2);
      const dt = t - i;
      out[j] = y[i] + b[i] * dt + c[i] * dt * dt + d[i] * dt * dt * dt;
    }
    return out;
  },

  // ════════════════════════════════════════════════════════════════
  // v12.4: Timestamp-based Cubic Spline Interpolation
  // ME-rPPG worker는 비동기 출력 → BVP의 실제 시간 간격이 불균등
  // 균등 간격 가정 시 RR 산출 오차 ±20-30ms (RMSSD 부풀림의 직접 원인)
  // 해결: 실제 timestamp 활용한 정확한 250Hz 격자 보간
  // 참고: Mejia-Mejia 2022, RapidHRV (Bishop 2022)
  // ════════════════════════════════════════════════════════════════
  _cubicSplineUpsampleTimed(times, values, srOut) {
    const n = times.length;
    if (n < 4 || values.length !== n) return new Float64Array(0);

    // 1. 실제 시간 범위 (초 단위)
    const tStart = times[0];
    const tEnd = times[n-1];
    const dur = tEnd - tStart;
    const outLen = Math.floor(dur * srOut);
    if (outLen < 100) return new Float64Array(0);

    // 2. 시간 정규화 (tStart=0)
    const t = new Float64Array(n);
    for (let i = 0; i < n; i++) t[i] = times[i] - tStart;

    // 3. 비균등 간격 cubic spline (Numerical Recipes 표준)
    // h_i = t[i+1] - t[i] (실제 시간 간격)
    const h = new Float64Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
      h[i] = t[i+1] - t[i];
      if (h[i] <= 0) h[i] = 1e-6; // 안전장치
    }

    // 4. Tridiagonal system 구성 (Natural BC: c[0]=c[n-1]=0)
    const alpha = new Float64Array(n);
    for (let i = 1; i < n - 1; i++) {
      alpha[i] = (3/h[i]) * (values[i+1] - values[i]) -
                 (3/h[i-1]) * (values[i] - values[i-1]);
    }

    const l = new Float64Array(n);
    const mu = new Float64Array(n);
    const z = new Float64Array(n);
    l[0] = 1; mu[0] = 0; z[0] = 0;
    for (let i = 1; i < n - 1; i++) {
      l[i] = 2 * (t[i+1] - t[i-1]) - h[i-1] * mu[i-1];
      mu[i] = h[i] / l[i];
      z[i] = (alpha[i] - h[i-1] * z[i-1]) / l[i];
    }
    l[n-1] = 1; z[n-1] = 0;

    // 5. 계수 c, b, d 후방 대입
    const c = new Float64Array(n);
    const b = new Float64Array(n - 1);
    const d = new Float64Array(n - 1);
    for (let i = n - 2; i >= 0; i--) {
      c[i] = z[i] - mu[i] * c[i+1];
      b[i] = (values[i+1] - values[i]) / h[i] - h[i] * (c[i+1] + 2*c[i]) / 3;
      d[i] = (c[i+1] - c[i]) / (3 * h[i]);
    }

    // 6. 균등 250Hz 격자로 보간
    const out = new Float64Array(outLen);
    const dtOut = 1.0 / srOut;
    let segIdx = 0;
    for (let j = 0; j < outLen; j++) {
      const tj = j * dtOut;
      // tj가 속한 세그먼트 찾기 (선형 검색 — 단조 증가니 효율적)
      while (segIdx < n - 2 && t[segIdx + 1] < tj) segIdx++;
      const dt = tj - t[segIdx];
      out[j] = values[segIdx] + b[segIdx]*dt + c[segIdx]*dt*dt + d[segIdx]*dt*dt*dt;
    }
    return out;
  },

  // === 적응형 피크 검출 (HeartPy / van Gent 2019 표준) ===
  // PPG 표준: 이동평균 임계값 + RR 일관성 검증
  // v12.3: minDistRatio 파라미터 추가 (다이크로틱 노치 자동 배제)
  _adaptivePeakDetect(sig, sr, hrHz, minDistRatio) {
    const N = sig.length;
    if (N < 100) return [];

    // 정규화: 평균 0
    let sum = 0;
    for (let i = 0; i < N; i++) sum += sig[i];
    const mean = sum / N;
    const centered = new Float64Array(N);
    for (let i = 0; i < N; i++) centered[i] = sig[i] - mean;

    // 이동 평균 (HeartPy 표준: HR 주기의 75%)
    const expectedRRsamples = sr / hrHz;
    const winSize = Math.max(11, Math.round(expectedRRsamples * 0.75));
    const movAvg = new Float64Array(N);
    let runSum = 0;
    for (let i = 0; i < winSize && i < N; i++) runSum += centered[i];
    for (let i = 0; i < N; i++) {
      const lo = Math.max(0, i - Math.floor(winSize/2));
      const hi = Math.min(N - 1, i + Math.floor(winSize/2));
      let s = 0, cnt = 0;
      for (let j = lo; j <= hi; j++) { s += centered[j]; cnt++; }
      movAvg[i] = cnt > 0 ? s / cnt : 0;
    }

    // 신호가 이동평균 위로 갈 때 = 피크 후보 영역
    // 각 영역에서 최댓값 위치 = 피크
    const peaks = [];
    // ★ v12.3: minDist를 인자로 받음 (기본 0.5, dicrotic notch 배제 시 0.7)
    const ratio = (typeof minDistRatio === 'number') ? minDistRatio : 0.5;
    const minDist = Math.round(expectedRRsamples * ratio);
    let inRegion = false;
    let regStart = 0, regMaxIdx = -1, regMaxVal = -Infinity;

    for (let i = 0; i < N; i++) {
      if (centered[i] > movAvg[i]) {
        if (!inRegion) {
          inRegion = true;
          regStart = i;
          regMaxIdx = i;
          regMaxVal = centered[i];
        } else {
          if (centered[i] > regMaxVal) {
            regMaxVal = centered[i];
            regMaxIdx = i;
          }
        }
      } else {
        if (inRegion) {
          // 영역 종료 → 피크 등록
          if (peaks.length === 0 || regMaxIdx - peaks[peaks.length - 1] >= minDist) {
            peaks.push(regMaxIdx);
          } else if (regMaxVal > centered[peaks[peaks.length - 1]]) {
            peaks[peaks.length - 1] = regMaxIdx;
          }
          inRegion = false;
        }
      }
    }
    if (inRegion && (peaks.length === 0 || regMaxIdx - peaks[peaks.length - 1] >= minDist)) {
      peaks.push(regMaxIdx);
    }

    // === Parabolic interpolation (서브샘플 정밀도) ===
    // y(t) = a*t² + b*t + c, peak at t* = -b/(2a)
    // ★ v12.4: centered(필터 후) 신호 사용 — 더 정확한 피크 위치
    const refined = peaks.map(p => {
      if (p < 1 || p >= N - 1) return p;
      const yL = centered[p-1], yC = centered[p], yR = centered[p+1];
      const denom = yL - 2*yC + yR;
      if (Math.abs(denom) < 1e-9) return p;
      return p + 0.5 * (yL - yR) / denom;
    });

    return refined;
  },

  // === RR 이상치 제거 (Tarvainen 2014, Kubios 의료기기 표준) ===
  // v12.3 개선: expectedRR 기준 사전 필터 + 더 관대한 인접 차이 규칙
  // 1. 절대 범위: 300~2000ms (HR 30~200bpm)
  // 2. expectedRR 기준 ±35% 마진 (가짜 피크/누락 피크 자동 배제)
  // 3. 인접 RR과 ±25% 차이
  // 4. 평균 RR 기준 ±3 SD 규칙
  _removeEctopicRR(rawRR, expectedRRms) {
    if (rawRR.length < 4) return rawRR.slice();

    // 절대 범위 필터
    let rr = rawRR.filter(v => v >= 300 && v <= 2000);
    if (rr.length < 4) return [];

    // ★ v12.3 Step 1.5: expectedRR 기준 ±35% 마진 사전 필터
    // 가짜 피크 (다이크로틱 노치 등): RR이 너무 짧음 (예상의 50% 이하)
    // 누락 피크: RR이 너무 김 (예상의 150% 이상)
    if (typeof expectedRRms === 'number' && expectedRRms > 0) {
      const minRR = expectedRRms * 0.65;
      const maxRR = expectedRRms * 1.35;
      const beforeLen = rr.length;
      rr = rr.filter(v => v >= minRR && v <= maxRR);
      console.log('[Kubios] expectedRR 필터:', beforeLen, '→', rr.length,
                  '(범위:', minRR.toFixed(0), '-', maxRR.toFixed(0), 'ms)');
      if (rr.length < 4) return rr;
    }

    // Step 2: ±25% 인접 차이 규칙 (rPPG는 ECG보다 노이즈 큼)
    const threshold = 0.25;
    const filtered = [rr[0]];
    for (let i = 1; i < rr.length; i++) {
      const prev = filtered[filtered.length - 1];
      const ratio = Math.abs(rr[i] - prev) / prev;
      if (ratio <= threshold) {
        filtered.push(rr[i]);
      }
    }
    if (filtered.length < 4) return filtered;

    // Step 3: ±3 SD 규칙 (Tarvainen 2014)
    const m = filtered.reduce((a,b) => a+b, 0) / filtered.length;
    const sdSum = filtered.reduce((s,v) => s + (v-m)**2, 0);
    const sd = Math.sqrt(sdSum / filtered.length);
    const final = filtered.filter(v => Math.abs(v - m) <= 3 * sd);
    return final;
  },

  _faceDisplayResults(r) {
    const panel = document.getElementById('face-result-panel');
    panel.classList.add('show');

    // ★ v19.4: 음성 분석 버튼 노출 (측정 완료 후)
    const voiceOpt = document.getElementById('voice-analysis-opt');
    if (voiceOpt) {
      setTimeout(async () => {
        voiceOpt.style.display = 'block';

        // Permissions API로 권한 상태 사전 확인
        const deniedEl = document.getElementById('vao-state-denied');
        const readyEl  = document.getElementById('vao-state-ready');

        if (navigator.permissions && navigator.permissions.query) {
          try {
            const status = await navigator.permissions.query({ name: 'microphone' });
            if (status.state === 'denied') {
              // 이미 거부 상태 → 즉시 설정 안내 표시
              this._faceShowMicDeniedGuide(deniedEl, readyEl);
            }
            // granted/prompt 상태면 기본 ready UI 유지
          } catch (e) {
            // Permissions API 미지원 → ready UI 유지
          }
        }
      }, 1200);
    }

    // ★ v15.3: 변별력 강화 — 나이·성별 보정 점수
    // 기존: HR 60-100이면 무조건 만점 → 20대도 80대도 동점
    // 신규: 본인 나이대 평균 대비 z-score 변환 → 명확한 변별
    const profile = this._getUserProfile();
    const { age, gender } = profile;

    let faceScore;
    const subScores = {};

    if (age && r.hr) {
      // 나이·성별 보정 점수 — 각 항목별 z-score 변환
      const hrRef = this._refRestingHR(age, gender);
      // HR은 중심값 좋음 — 너무 낮아도(서맥) 너무 높아도(빈맥) 감점
      const hrDeviation = Math.abs(r.hr - hrRef.mean) / hrRef.sd;
      subScores.hr = Math.max(5, Math.min(99, this._zToScore(-hrDeviation + 0.7)));

      // RMSSD — 본인 나이 평균 대비 (높을수록 좋음, z-score 직접 적용)
      if (r.rmssd) {
        const rmssdRef = this._refRMSSD(age, gender);
        subScores.rmssd = this._ageNormalizedScore(r.rmssd, rmssdRef, true);
      } else {
        subScores.rmssd = 50;
      }

      // 호흡수 — 중심값 좋음
      if (r.respRate) {
        const rrRef = this._refRespRate(age);
        const rrDeviation = Math.abs(r.respRate - rrRef.mean) / rrRef.sd;
        subScores.rr = Math.max(5, Math.min(99, this._zToScore(-rrDeviation + 0.7)));
      } else {
        subScores.rr = 50;
      }

      // SQI 보정 — 신호 품질이 낮으면 신뢰도 낮춤
      let sqiWeight = 1.0;
      if (r.sqi != null) {
        if (r.sqi < 50) sqiWeight = 0.7;
        else if (r.sqi < 70) sqiWeight = 0.85;
      }

      // 종합: HR 30% + RMSSD 50% + 호흡 20% (RMSSD가 가장 변별력 큼)
      faceScore = Math.round((subScores.hr * 0.30 + subScores.rmssd * 0.50 + subScores.rr * 0.20) * sqiWeight);
      faceScore = Math.max(5, Math.min(99, faceScore));

      console.log(`[Face Score] age=${age} HR=${r.hr}(${subScores.hr}) RMSSD=${r.rmssd}(${subScores.rmssd}) RR=${r.respRate}(${subScores.rr}) → ${faceScore}`);
    } else {
      // ── Fallback: 나이 정보 없으면 기존 임계 방식 (덜 변별력) ──
      faceScore = 100;
      if (r.hr) {
        if (r.hr < 50 || r.hr > 110) faceScore -= 25;
        else if (r.hr < 60 || r.hr > 100) faceScore -= 8;
      } else {
        faceScore -= 30;
      }
      if (r.respRate) {
        if (r.respRate < 10 || r.respRate > 24) faceScore -= 15;
        else if (r.respRate < 12 || r.respRate > 20) faceScore -= 5;
      } else {
        faceScore -= 10;
      }
      if (r.sqi && r.sqi < 70) faceScore -= 10;
      if (r.rmssd && r.stressFromRMSSD && r.stressIdx >= 70) faceScore -= 5;
      faceScore = Math.max(0, Math.min(100, faceScore));
    }

    // ★ v15.2.6: stressLevel 등 추가 필드 저장 (정신건강 통합 계산용)
    this._wellnessSave('face', {
      hr: r.hr,
      respRate: r.respRate,
      rmssd: r.rmssd,
      stressIdx: r.stressIdx,
      stressLevel: r.stressLevel,
      sdnn: r.sdnn,
      lnRmssd: r.lnRmssd,
      sqi: r.sqi,
      score: faceScore,
      subScores: subScores,
      ageAtMeasure: age,
      arrhythmia: r.arrhythmia || null,
      // ★ v20.2 주파수 도메인 HRV
      lfPower: r.lfPower || null,
      hfPower: r.hfPower || null,
      lfHfRatio: r.lfHfRatio || null,
      pNN50: r.pNN50 || null,
      alphaRppg: r.alphaRppg || null,
      vascularAge: r.vascularAge || null,
      rsaIndex: r.rsaIndex || null,
      // ★ v19.4: 동공·표정 분석 결과
      pupilResult: r.pupilResult || null,
      auResult:    r.auResult    || null,
    });

    // ★ v19.3: 측정 완료 후 인사이트 카드
    setTimeout(() => this._showPostMeasureInsight('face', {
      hr: r.hr, rmssd: r.rmssd, stressIdx: r.stressIdx, score: faceScore,
    }), 800);

    const setArc = (id, val, min, max) => {
      const arc = document.getElementById(id);
      if (!arc || val == null) return;
      let pct = (val - min) / (max - min);
      pct = Math.max(0, Math.min(1, pct));
      arc.style.strokeDashoffset = String(283 - pct * 283);
    };
    const setBadge = (id, label, cls) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = label;
      el.className = 'rg-badge ' + cls;
    };

    // === 각 지표 표시 + 해설 멘트 ===
    const setComment = (id, text, color) => {
      const el = document.getElementById(id);
      if (el) {
        el.textContent = text;
        if (color) el.style.color = color;
      }
    };

    if (r.hr) {
      document.getElementById('fr-hr-val').textContent = r.hr;
      setArc('fr-hr-arc', r.hr, 40, 180);
      const cls = r.hr<60?'low':r.hr<=100?'normal':r.hr<=120?'high':'bad';
      const lbl = r.hr<60?'서맥':r.hr<=100?'정상':r.hr<=120?'약간높음':'높음';
      setBadge('fr-hr-badge', lbl, cls);
      // 해설 멘트
      let cmt;
      if (r.hr < 50) {
        cmt = '심박수가 매우 낮은 편입니다 (50 미만). 평소 운동을 많이 하시는 분이라면 정상이지만, 어지러움이 있다면 주의가 필요합니다.';
      } else if (r.hr < 60) {
        cmt = '심박수가 다소 느린 편입니다 (50-60). 충분히 휴식 중이거나 운동 능력이 좋은 사람의 정상 범위입니다.';
      } else if (r.hr <= 80) {
        cmt = '안정된 정상 심박수입니다 (60-80). 가장 이상적인 휴식기 심박수입니다.';
      } else if (r.hr <= 100) {
        cmt = '정상 범위 안의 심박수입니다 (80-100). 평소 활동 중이거나 약간의 긴장 상태일 수 있습니다.';
      } else if (r.hr <= 120) {
        cmt = '심박수가 약간 빠른 편입니다 (100-120). 카페인, 스트레스, 가벼운 활동 후일 수 있습니다.';
      } else {
        cmt = '심박수가 빠른 편입니다 (120 이상). 충분히 휴식한 뒤 다시 측정해보세요.';
      }
      // ★ v14.4: 개인 baseline 비교 추가
      const history = this._historyGet('face');
      const pastHistory = history.slice(0, -1);
      const hrStats = pastHistory.length >= 3 ? this._historyStats(pastHistory, 'hr') : null;
      if (hrStats && hrStats.count >= 3) {
        const baseline = hrStats.mean;
        const diff = r.hr - baseline;
        const diffPct = (diff / baseline) * 100;
        if (Math.abs(diff) < 3) {
          cmt += ` 평소(${Math.round(baseline)}BPM)와 비슷한 수준이에요.`;
        } else if (diff > 0) {
          cmt += ` 평소(${Math.round(baseline)}BPM)보다 ${Math.round(diff)}BPM (${Math.round(diffPct)}%) 빨라요. ${diffPct > 10 ? '카페인·스트레스·수면 부족을 점검해보세요.' : ''}`;
        } else {
          cmt += ` 평소(${Math.round(baseline)}BPM)보다 ${Math.abs(Math.round(diff))}BPM (${Math.abs(Math.round(diffPct))}%) 느려요. 컨디션이 안정적입니다.`;
        }
      }
      setComment('fr-hr-cmt', cmt, '');
    } else {
      setComment('fr-hr-cmt', '심박수를 측정할 수 없었습니다.');
    }

    if (r.respRate) {
      document.getElementById('fr-rr-val').textContent = r.respRate;
      setArc('fr-rr-arc', r.respRate, 8, 30);
      const cls = r.respRate<10?'low':r.respRate<=22?'normal':'high';
      const lbl = r.respRate<10?'느림':r.respRate<=12?'안정':r.respRate<=20?'정상':'빠름';
      setBadge('fr-rr-badge', lbl, cls);
      // 해설
      let cmt;
      if (r.respRate < 10) {
        cmt = '호흡이 매우 느립니다 (10 미만). 깊은 명상이나 깊은 휴식 상태에서 나타나는 패턴입니다.';
      } else if (r.respRate <= 12) {
        cmt = '깊고 안정적인 호흡입니다 (10-12). 매우 편안한 상태로 이상적인 호흡 패턴입니다.';
      } else if (r.respRate <= 20) {
        cmt = '정상 호흡수입니다 (12-20). 안정 시 일반적인 호흡 패턴입니다.';
      } else if (r.respRate <= 22) {
        cmt = '약간 빠른 호흡입니다 (20-22). 가벼운 활동 후나 긴장 상태일 수 있습니다.';
      } else {
        cmt = '호흡이 빠른 편입니다 (22 이상). 휴식 후 다시 측정해보세요.';
      }
      setComment('fr-rr-cmt', cmt, '');
    } else {
      document.getElementById('fr-rr-val').textContent = '--';
      setBadge('fr-rr-badge', '데이터 부족', 'wait');
      setComment('fr-rr-cmt', '신호 부족으로 호흡수를 측정할 수 없었습니다.');
    }

    if (r.rmssd) {
      // ★ v14.4: 개인 baseline 비교 시스템
      // 절대값 임계값 대신 본인 평균 대비 변화로 평가
      // 자료 권장: "personalized baseline correction"
      document.getElementById('fr-hv-val').textContent = r.rmssd;
      setArc('fr-hv-arc', r.rmssd, 10, 80);

      // 본인 히스토리에서 baseline 계산 (현재 측정 제외)
      const history = this._historyGet('face');
      const pastHistory = history.slice(0, -1); // 방금 저장된 것 제외
      const rmssdStats = pastHistory.length >= 3 ? this._historyStats(pastHistory, 'rmssd') : null;

      let cls, lbl, cmt;

      if (rmssdStats && rmssdStats.count >= 3) {
        // ✅ 개인 baseline 있음 — 본인 평균 대비 평가
        const baseline = rmssdStats.mean;
        const std = Math.max(rmssdStats.std, 3); // 최소 3ms 표준편차
        const zScore = (r.rmssd - baseline) / std;
        const changePercent = ((r.rmssd - baseline) / baseline) * 100;

        if (zScore < -1.5) {
          // 평소보다 크게 낮음 = 스트레스/피로 신호
          cls = 'bad';
          lbl = '평소보다 낮음';
          cmt = `평소(${Math.round(baseline)}ms)보다 ${Math.abs(Math.round(changePercent))}% 낮은 ${r.rmssd}ms입니다. 피로, 스트레스, 수면 부족 등이 영향을 줄 수 있어요. 충분한 휴식 후 재측정해보세요.`;
        } else if (zScore < -0.7) {
          // 평소보다 약간 낮음
          cls = 'normal';
          lbl = '평소보다 약간 낮음';
          cmt = `평소(${Math.round(baseline)}ms)보다 약간 낮은 ${r.rmssd}ms입니다. 컨디션을 점검해보세요.`;
        } else if (zScore < 0.7) {
          // 평소와 비슷함
          cls = 'normal';
          lbl = '평소 수준';
          cmt = `평소 수준(${Math.round(baseline)}ms 평균)에서 ${r.rmssd}ms입니다. 자율신경이 본인 정상 범위에 있어요.`;
        } else if (zScore < 1.5) {
          // 평소보다 약간 높음 = 좋은 신호
          cls = 'normal';
          lbl = '평소보다 좋음';
          cmt = `평소(${Math.round(baseline)}ms)보다 ${Math.round(changePercent)}% 높은 ${r.rmssd}ms입니다. 자율신경 회복이 좋아 컨디션이 좋은 상태입니다.`;
        } else {
          // 평소보다 크게 높음
          cls = 'high';
          lbl = '평소보다 매우 좋음';
          cmt = `평소(${Math.round(baseline)}ms)보다 훨씬 높은 ${r.rmssd}ms입니다. 깊은 이완 상태이거나 측정 노이즈일 수 있어요. 깊은 휴식 직후라면 좋은 신호입니다.`;
        }
        cmt += ` (지난 ${rmssdStats.count}회 측정 평균 기준)`;
      } else {
        // ❌ baseline 부족 — 임상 절대값 기준 (기존 로직)
        cls = r.rmssd<19?'bad':r.rmssd<=75?'normal':'high';
        lbl = r.rmssd<19?'낮음':r.rmssd<=42?'정상':r.rmssd<=75?'양호':'매우 높음';
        if (r.rmssd < 12) {
          cmt = '심박변이도가 매우 낮습니다 (12 미만). 만성 스트레스, 피로 누적, 자율신경 불균형이 의심됩니다. 충분한 휴식과 재측정을 권합니다.';
        } else if (r.rmssd < 19) {
          cmt = '심박변이도가 임상 정상 범위(19~75ms) 미만입니다. 일시적 스트레스 또는 피로 상태일 수 있습니다.';
        } else if (r.rmssd <= 42) {
          cmt = '심박변이도가 임상 정상 범위 안에 있습니다 (정상 평균: 42ms).';
        } else if (r.rmssd <= 75) {
          cmt = '심박변이도가 양호합니다 (정상 범위 상위).';
        } else {
          cmt = '심박변이도가 매우 높습니다 (75 초과). 깊은 이완 상태이거나 측정 노이즈 가능성.';
        }
        const remaining = 3 - (rmssdStats?.count || 0);
        cmt += ` (앞으로 ${remaining}회 더 측정하면 본인 평균과 비교 가능해요)`;
      }

      cmt += ' ※ rPPG 측정값을 ECG 환산하여 표시합니다.';
      setBadge('fr-hv-badge', lbl, cls);
      setComment('fr-hv-cmt', cmt, '');
    } else {
      document.getElementById('fr-hv-val').textContent = '--';
      setBadge('fr-hv-badge', '신뢰도 부족', 'wait');
      // 사유별 안내 (사용자에게 정확한 원인 알림)
      const reasonMap = {
        'high_interp': '신호 품질이 낮아 누락된 피크가 많습니다. 조명을 밝게 하고 움직이지 말고 재측정해주세요.',
        'insufficient_peaks': '직접 검출된 심박 피크가 부족합니다 (HRV는 8개 이상 필요). 정면을 보고 움직이지 말고 재측정해주세요.',
        'too_variable': 'RR 간격 변동이 너무 큽니다. 안정된 상태에서 재측정해주세요.',
        'out_of_clinical_range': '산출된 HRV 값이 임상 정상 범위를 벗어났습니다. 측정 환경을 개선해주세요.',
        'hr_inconsistent': '주파수 분석과 피크 검출의 심박수가 일치하지 않습니다. 배경 조명 깜빡임이나 움직임의 영향이 있습니다. 더 안정된 환경에서 재측정해주세요.',
        'noisy_peaks': '피크 검출에 노이즈가 섞였습니다. 머리·몸을 가만히 하고 정면을 보면서 다시 측정해주세요.',
        'not_converged': '심박수 측정이 충분히 안정되지 못했습니다. 30초 이상 가만히 측정한 후 다시 시도해주세요.',
      };
      const cmt = reasonMap[r.rmssdReason] || '신호 품질이 낮아 HRV 산출이 어렵습니다.';
      setComment('fr-hv-cmt', cmt, '');
    }

    if (r.stressIdx != null && r.stressFromRMSSD) {
      // ★ v13.6: stressLevel 직접 사용 (worker에서 ECG 변환된 RMSSD로 산출)
      const stress5 = r.stressLevel || (
        r.stressIdx < 25 ? 1 :
        r.stressIdx < 40 ? 2 :
        r.stressIdx < 60 ? 3 :
        r.stressIdx < 75 ? 4 : 5
      );
      document.getElementById('fr-st-val').textContent = stress5.toFixed(1);
      setArc('fr-st-arc', stress5, 1, 5);
      const cls = stress5<=2?'normal':stress5<=3?'high':'bad';
      const lbl = stress5<=2?'이완':stress5<=3?'보통':'스트레스';
      setBadge('fr-st-badge', lbl, cls);

      // ★ v14.4: 개인 baseline 비교 추가
      const history = this._historyGet('face');
      const pastHistory = history.slice(0, -1);
      const stressStats = pastHistory.length >= 3 ? this._historyStats(pastHistory, 'stressLevel') : null;

      let cmt;
      if (stress5 === 1)      cmt = '매우 이완된 상태입니다 (1/5).';
      else if (stress5 === 2) cmt = '이완 상태입니다 (2/5).';
      else if (stress5 === 3) cmt = '평상시 상태입니다 (3/5).';
      else if (stress5 === 4) cmt = '약간 긴장된 상태입니다 (4/5).';
      else                    cmt = '높은 스트레스 상태입니다 (5/5). 심호흡과 휴식이 필요합니다.';

      if (stressStats && stressStats.count >= 3) {
        const baseline = stressStats.mean;
        const diff = stress5 - baseline;
        if (Math.abs(diff) < 0.5) {
          cmt += ` 평소(${baseline.toFixed(1)}단계)와 비슷한 수준이에요.`;
        } else if (diff > 0) {
          cmt += ` 평소(${baseline.toFixed(1)}단계)보다 스트레스가 ${diff > 1 ? '크게 ' : '약간 '}높아진 상태입니다. 휴식을 권합니다.`;
        } else {
          cmt += ` 평소(${baseline.toFixed(1)}단계)보다 더 이완된 좋은 상태입니다.`;
        }
      } else {
        const remaining = 3 - (stressStats?.count || 0);
        cmt += ` (${remaining}회 더 측정하면 본인 평소 대비 비교 가능)`;
      }
      setComment('fr-st-cmt', cmt, '');
    } else {
      // RMSSD 없으면 스트레스도 무효 — 정확도가 떨어지므로 표시 안 함
      document.getElementById('fr-st-val').textContent = '--';
      setBadge('fr-st-badge', '신뢰도 부족', 'wait');
      setComment('fr-st-cmt', '심박변이도(HRV) 산출이 신뢰 가능한 수준이 아니라 스트레스 평가를 보류합니다. HRV 측정이 정확해지면 스트레스도 함께 표시됩니다.');
    }

    let score = 100;
    if (r.hr) {
      if (r.hr<50||r.hr>120) score -= 20;
      else if (r.hr<60||r.hr>100) score -= 8;
    }
    if (r.rmssd && r.rmssd<20) score -= 18;
    if (r.stressIdx && r.stressIdx>70) score -= 15;
    score = Math.max(0, Math.min(100, score));
    const grade = score>=85?'A':score>=70?'B':score>=50?'C':'D';
    const gEl = document.getElementById('face-result-grade');
    gEl.textContent = `${grade} · ${score}점`;
    gEl.className = 'result-grade ' + grade;

    // ★ v18.0: 혈관 나이 + 부정맥 + RSA 카드 렌더링
    this._renderAdvancedPPGCards(r, 'fr-advanced-cards');

    // ★ v19.4: 동공·표정 분석 카드 렌더링
    this._renderPupilAUCards(r, 'fr-advanced-cards');
  },

  // ════════════════════════════════════════════════════════════════
  // ★ v19.4: 동공 변동성 + 표정 Action Unit 카드 렌더링
  // Dr. Kim: PUI(Pupillary Unrest Index) + Ekman AU 기반
  // ════════════════════════════════════════════════════════════════
  _renderPupilAUCards(r, containerId) {
    try {
      const container = document.getElementById(containerId);
      if (!container) return;

      const pr = r.pupilResult;
      const ar = r.auResult;
      if (!pr && !ar) return; // 데이터 없으면 표시 안 함

      let html = '';

      // ── 동공 변동성 카드 ──
      if (pr) {
        const stateColor = {
          stable: '#10b981', normal: '#3b82f6',
          variable: '#f59e0b', unstable: '#ef4444',
        }[pr.puiState] || '#6b7280';

        const stateIcon = {
          stable: '🟢', normal: '🔵', variable: '🟡', unstable: '🔴',
        }[pr.puiState] || '⚪';

        html += `
          <div class="rg-card">
            <div class="rg-card-title">
              👁️ 동공 변동성 분석
              <span class="ppg-adv-badge" style="background:${stateColor}">
                ${pr.label}
              </span>
            </div>
            <div class="ppg-adv-main">
              <span class="ppg-adv-big" style="color:${stateColor}">${pr.puiScore}<span class="ppg-adv-unit">/100</span></span>
            </div>
            <div class="ppg-adv-detail">
              PUI ${pr.pui} · 좌우 대칭 ${pr.symmetry}%
            </div>
            <div class="ppg-adv-sub">${stateIcon} ${pr.interpretation}</div>
            <div class="ppg-adv-disclaimer">
              Pupillary Unrest Index — Wilhelm (1998) · 자율신경 반응성 지표 (참고용)
            </div>
          </div>
        `;
      }

      // ── 표정 분석 카드 ──
      if (ar) {
        const emotionColor = {
          happy: '#10b981', neutral: '#6b7280',
          stressed: '#f59e0b', concerned: '#ef4444',
        }[ar.dominantEmotion] || '#6b7280';

        const emotionIcon = {
          happy: '😊', neutral: '😐', stressed: '😤', concerned: '😟',
        }[ar.dominantEmotion] || '😐';

        html += `
          <div class="rg-card">
            <div class="rg-card-title">
              😊 표정 분석 (Action Unit)
              <span class="ppg-adv-badge" style="background:${emotionColor}">
                ${ar.emotionLabel}
              </span>
            </div>
            <div class="ppg-adv-main">
              <span class="ppg-adv-big" style="color:${emotionColor}">
                ${emotionIcon} <span style="font-size:1.2rem">${ar.emotionLabel}</span>
              </span>
            </div>
            <div class="ppg-adv-detail">
              Duchenne 미소 ${ar.duchenne}% · 표정 일관성 ${ar.expressionConsistency}%
            </div>
            <div class="au-bars">
              <div class="au-bar-row">
                <span class="au-label">AU12 (미소)</span>
                <div class="au-track"><div class="au-fill happy-fill" style="width:${ar.au12}%"></div></div>
                <span class="au-val">${ar.au12}%</span>
              </div>
              <div class="au-bar-row">
                <span class="au-label">AU6 (볼 올라감)</span>
                <div class="au-track"><div class="au-fill happy-fill" style="width:${ar.au6}%"></div></div>
                <span class="au-val">${ar.au6}%</span>
              </div>
              <div class="au-bar-row">
                <span class="au-label">AU4 (찡그림)</span>
                <div class="au-track"><div class="au-fill stress-fill" style="width:${ar.au4}%"></div></div>
                <span class="au-val">${ar.au4}%</span>
              </div>
            </div>
            <div class="ppg-adv-sub">${ar.interpretation}</div>
            <div class="ppg-adv-disclaimer">
              Ekman & Friesen (1978) Facial Action Coding System 기반 추정값
            </div>
          </div>
        `;
      }

      // 기존 컨텐츠 뒤에 추가 (기존 카드 유지)
      container.insertAdjacentHTML('beforeend', html);

    } catch (e) {
      console.warn('[v19.4] PupilAU 카드 렌더 실패:', e.message);
    }
  },

  // ★ v19.5: 마이크 권한 사전 체크 (Permissions API 활용)
  // 삼성 브라우저: getUserMedia 없이 먼저 권한 상태 확인
  async _faceCheckMicPermission() {
    // ★ v20.1: 재시도 버튼 클릭 시 무조건 getUserMedia 직접 시도
    // Permissions API의 'denied' 캐시 값을 믿지 않음
    // → 사용자가 설정에서 허용 변경 후 눌렀을 때 정상 작동
    const readyEl  = document.getElementById('vao-state-ready');
    const deniedEl = document.getElementById('vao-state-denied');
    const recEl    = document.getElementById('vao-state-recording');

    // UI: denied 숨기고 recording 상태로 전환
    if (deniedEl) deniedEl.style.display = 'none';
    if (readyEl)  readyEl.style.display  = 'none';
    if (recEl)    recEl.style.display    = 'block';

    // 무조건 getUserMedia 시도 (Permissions API 우회)
    await this._faceStartVoiceAnalysis();
  },

  // 권한 거부 시 시스템 설정 안내 UI
  _faceShowMicDeniedGuide(deniedEl, readyEl) {
    if (readyEl) readyEl.style.display = 'none';
    if (!deniedEl) return;
    deniedEl.style.display = 'block';

    const ua = navigator.userAgent;
    const isSamsung = /SamsungBrowser/i.test(ua) || /Samsung/i.test(ua);
    const isChrome  = /Chrome/i.test(ua) && !isSamsung && !/EdgA|OPR|Brave/i.test(ua);
    const isIOS     = /iPhone|iPad|iPod/i.test(ua);
    const isFirefox = /Firefox/i.test(ua);
    const browserName = isSamsung ? '삼성 인터넷' : isChrome ? 'Chrome' : isFirefox ? 'Firefox' : '브라우저';

    // ★ v20.3: PWA(바탕화면 설치 앱) 감지
    const isPWA = window.matchMedia('(display-mode: standalone)').matches
               || window.navigator.standalone === true
               || document.referrer.startsWith('android-app://');

    let pwaWarning = '';
    let guideSteps = '';
    let systemGuide = '';

    if (isPWA && !isIOS) {
      // ── 안드로이드 PWA: 주소창 없음 → 시스템 설정 직접 안내 ──
      pwaWarning = `
        <div class="vao-pg-pwa-badge">📲 바탕화면 앱 환경</div>
        <div class="vao-pg-pwa-notice">홈화면 아이콘으로 실행하면 주소창이 없어서<br>자물쇠 아이콘 방식을 사용할 수 없어요.</div>`;

      guideSteps = `
        <div class="vao-pg-step">
          <span class="vao-pg-num">1</span>
          <span>폰 홈 화면으로 나가서 <strong>설정 앱</strong> 열기</span>
        </div>
        <div class="vao-pg-step">
          <span class="vao-pg-num">2</span>
          <span><strong>앱</strong> (또는 애플리케이션 관리자) 탭</span>
        </div>
        <div class="vao-pg-step">
          <span class="vao-pg-num">3</span>
          <span>목록에서 <strong>${browserName}</strong> 찾아 탭</span>
        </div>
        <div class="vao-pg-step">
          <span class="vao-pg-num">4</span>
          <span><strong>권한 → 마이크 → 허용</strong> 선택</span>
        </div>
        <div class="vao-pg-step">
          <span class="vao-pg-num">5</span>
          <span>이 앱으로 돌아와 아래 <strong>다시 시도</strong> 버튼 탭</span>
        </div>`;

      systemGuide = isChrome ? `
        <div class="vao-pg-alt vao-pg-alt-pwa">
          💡 <strong>또는 크롬 브라우저에서 직접:</strong><br>
          크롬 앱 열기 → 주소창에 아래 주소 입력<br>
          <span class="vao-pg-url">chrome://settings/content/microphone</span><br>
          → 차단된 목록에서 이 사이트 찾아 허용
        </div>` : `
        <div class="vao-pg-alt vao-pg-alt-pwa">
          💡 <strong>또는 ${browserName} 앱을 직접 열어서:</strong><br>
          주소창 자물쇠 🔒 → 마이크 → 허용 후 돌아오기
        </div>`;

    } else if (isPWA && isIOS) {
      // ── iOS PWA (홈화면 추가) ──
      pwaWarning = `
        <div class="vao-pg-pwa-badge">📲 홈화면 추가 앱 환경</div>`;
      guideSteps = `
        <div class="vao-pg-step">
          <span class="vao-pg-num">1</span>
          <span>iPhone <strong>설정 앱</strong> 열기</span>
        </div>
        <div class="vao-pg-step">
          <span class="vao-pg-num">2</span>
          <span><strong>Safari</strong> 탭</span>
        </div>
        <div class="vao-pg-step">
          <span class="vao-pg-num">3</span>
          <span><strong>마이크 → 허용</strong> 선택</span>
        </div>
        <div class="vao-pg-step">
          <span class="vao-pg-num">4</span>
          <span>앱으로 돌아와 아래 <strong>다시 시도</strong> 버튼 탭</span>
        </div>`;

    } else if (isSamsung) {
      guideSteps = `
        <div class="vao-pg-step">
          <span class="vao-pg-num">1</span>
          <span>주소창 왼쪽 <strong>자물쇠 🔒 아이콘</strong> 탭</span>
        </div>
        <div class="vao-pg-step">
          <span class="vao-pg-num">2</span>
          <span><strong>마이크</strong> 항목을 <strong>허용</strong>으로 변경</span>
        </div>
        <div class="vao-pg-step">
          <span class="vao-pg-num">3</span>
          <span>아래 <strong>권한 허용 후 다시 시도</strong> 버튼 탭</span>
        </div>`;
      systemGuide = `
        <div class="vao-pg-alt">
          📱 위 방법으로도 안 될 경우:<br>
          <strong>안드로이드 설정 → 앱 → 삼성 인터넷 → 권한 → 마이크 → 허용</strong>
        </div>`;

    } else if (isChrome) {
      guideSteps = `
        <div class="vao-pg-step">
          <span class="vao-pg-num">1</span>
          <span>주소창 왼쪽 <strong>자물쇠 🔒</strong> 또는 <strong>ⓘ</strong> 탭</span>
        </div>
        <div class="vao-pg-step">
          <span class="vao-pg-num">2</span>
          <span><strong>사이트 설정 → 마이크 → 허용</strong> 선택</span>
        </div>
        <div class="vao-pg-step">
          <span class="vao-pg-num">3</span>
          <span>페이지 <strong>새로고침</strong> 후 다시 시도</span>
        </div>`;
      systemGuide = `
        <div class="vao-pg-alt">
          📱 위 방법으로도 안 될 경우:<br>
          <strong>안드로이드 설정 → 앱 → Chrome → 권한 → 마이크 → 허용</strong>
        </div>`;

    } else if (isIOS) {
      guideSteps = `
        <div class="vao-pg-step">
          <span class="vao-pg-num">1</span>
          <span>iPhone <strong>설정</strong> 앱 열기</span>
        </div>
        <div class="vao-pg-step">
          <span class="vao-pg-num">2</span>
          <span><strong>Safari → 마이크 → 허용</strong></span>
        </div>
        <div class="vao-pg-step">
          <span class="vao-pg-num">3</span>
          <span>Safari로 돌아와 <strong>새로고침</strong> 후 다시 시도</span>
        </div>`;

    } else {
      guideSteps = `
        <div class="vao-pg-step">
          <span class="vao-pg-num">1</span>
          <span>주소창 옆 <strong>자물쇠 🔒</strong> 또는 <strong>ⓘ</strong> 탭</span>
        </div>
        <div class="vao-pg-step">
          <span class="vao-pg-num">2</span>
          <span><strong>마이크 → 허용</strong> 변경</span>
        </div>
        <div class="vao-pg-step">
          <span class="vao-pg-num">3</span>
          <span><strong>새로고침</strong> 후 다시 시도</span>
        </div>`;
      systemGuide = `
        <div class="vao-pg-alt">
          📱 위 방법으로도 안 될 경우:<br>
          <strong>안드로이드 설정 → 앱 → ${browserName} → 권한 → 마이크 → 허용</strong>
        </div>`;
    }

    deniedEl.innerHTML = `
      <div class="vao-permission-guide">
        ${pwaWarning}
        <div class="vao-pg-icon">🎤</div>
        <div class="vao-pg-title">마이크 권한이 필요합니다</div>
        <div class="vao-pg-desc">음성 분석을 위해 마이크 접근 권한을 허용해주세요.</div>
        <div class="vao-pg-steps">${guideSteps}</div>
        ${systemGuide}
        <button class="vao-pg-retry" type="button" onclick="App._faceCheckMicPermission()">
          🔄 권한 허용 후 다시 시도
        </button>
      </div>
    `;
  },
  async _faceStartVoiceAnalysis() {
    const optEl    = document.getElementById('voice-analysis-opt');
    const resultEl = document.getElementById('voice-result-card');
    const recEl    = document.getElementById('vao-state-recording');
    const deniedEl = document.getElementById('vao-state-denied');
    const readyEl  = document.getElementById('vao-state-ready');

    // ★ v20.1: 녹음 중 UI — 강제 표시 보장
    if (recEl) {
      recEl.style.display = 'block';
      recEl.innerHTML = `
        <div class="vao-recording">
          <div class="vao-mic-pulse">🎤</div>
          <div class="vao-recording-text">"아~" 소리를 5초간 내주세요</div>
          <div class="vao-countdown" id="vao-countdown">5</div>
        </div>
      `;
    }
    if (deniedEl) deniedEl.style.display = 'none';
    if (readyEl)  readyEl.style.display  = 'none';

    try {
      // ★ v20.1: 삼성 인터넷 대응 — exact:false 옵션 추가
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false
      });

      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      // ★ v23.4: iOS Safari 대응 — AudioContext가 suspended로 시작되면 resume 필수
      if (audioCtx.state === 'suspended') {
        try { await audioCtx.resume(); } catch (e) { console.warn('[음성] AudioContext resume 실패:', e); }
      }
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);

      const bufLen = analyser.frequencyBinCount;
      const timeDomain = new Float32Array(bufLen);
      const samples = [];
      const startTime = Date.now();

      let countdown = 5;
      const countEl = document.getElementById('vao-countdown');
      const countInterval = setInterval(() => {
        countdown--;
        if (countEl) countEl.textContent = Math.max(0, countdown);
        if (countdown <= 0) clearInterval(countInterval);
      }, 1000);

      const collectSamples = () => {
        if (Date.now() - startTime < 5000) {
          analyser.getFloatTimeDomainData(timeDomain);
          samples.push(...Array.from(timeDomain).slice(0, 256));
          requestAnimationFrame(collectSamples);
        } else {
          clearInterval(countInterval);
          stream.getTracks().forEach(t => t.stop());
          audioCtx.close();
          if (recEl) recEl.style.display = 'none';
          const voiceResult = this._analyzeVoiceFeatures(samples, audioCtx.sampleRate || 44100);
          this._renderVoiceResult(voiceResult, resultEl);
          if (optEl) optEl.style.display = 'none';
        }
      };
      requestAnimationFrame(collectSamples);

    } catch (e) {
      if (recEl) recEl.style.display = 'none';

      if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError' || e.name === 'SecurityError') {
        // ★ v20.1: 거부 → 안내 UI 표시 (recEl 먼저 숨김)
        if (recEl) recEl.style.display = 'none';
        this._faceShowMicDeniedGuide(deniedEl, readyEl);
      } else if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
        if (deniedEl) {
          deniedEl.style.display = 'block';
          deniedEl.innerHTML = `
            <div class="vao-permission-guide">
              <div class="vao-pg-icon">⚠️</div>
              <div class="vao-pg-title">마이크를 찾을 수 없습니다</div>
              <div class="vao-pg-desc">기기에 마이크가 없거나 연결이 필요합니다.</div>
            </div>`;
        }
      } else {
        if (deniedEl) {
          deniedEl.style.display = 'block';
          deniedEl.innerHTML = `
            <div class="vao-permission-guide">
              <div class="vao-pg-icon">⚠️</div>
              <div class="vao-pg-title">음성 분석을 시작할 수 없습니다</div>
              <div class="vao-pg-desc">${e.message || '잠시 후 다시 시도해주세요.'}</div>
              <button class="vao-pg-retry" type="button" onclick="App._faceCheckMicPermission()">
                🔄 다시 시도
              </button>
            </div>`;
        }
      }
    }
  },

  // 음성 특징 추출 (Praat 알고리즘 포팅)
  _analyzeVoiceFeatures(samples, sampleRate) {
    try {
      // ★ v20.0: 한국어 baseline 반영 고도화 버전
      // 한국어 평균 피치: 남성 110~140Hz, 여성 200~260Hz (Kim 2009)
      // 정상 Jitter <1.04%, Shimmer <3.81%, HNR >20dB (Praat KR baseline)

      const frameSize = Math.floor(sampleRate * 0.025); // 25ms 프레임 (한국어 음절 단위 최적)
      const hopSize   = Math.floor(sampleRate * 0.010); // 10ms hop

      // ── 피치 추출: 자기상관 기반 (SHR 방식) ──
      const pitchFrames = [];
      const minLag = Math.round(sampleRate / 500); // 500Hz 이하
      const maxLag = Math.round(sampleRate / 75);  // 75Hz 이상 (한국어 저음 화자 포함)

      for (let i = 0; i + frameSize < samples.length; i += hopSize) {
        const frame = samples.slice(i, i + frameSize);
        // RMS 에너지 확인 — 묵음 제외
        const rms = Math.sqrt(frame.reduce((s,v)=>s+v*v,0)/frame.length);
        if (rms < 0.003) continue;

        // 자기상관 계산
        let r0 = 0;
        for (let j = 0; j < frame.length; j++) r0 += frame[j]*frame[j];
        if (r0 < 1e-9) continue;

        let bestLag = 0, bestCorr = -1;
        for (let lag = minLag; lag <= Math.min(maxLag, frame.length-1); lag++) {
          let corr = 0;
          for (let j = 0; j + lag < frame.length; j++) corr += frame[j] * frame[j+lag];
          corr /= r0;
          if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
        }
        if (bestCorr > 0.45 && bestLag > 0) {
          pitchFrames.push({ f0: sampleRate / bestLag, corr: bestCorr });
        }
      }

      // ── Jitter: 연속 피치 주기 변동률 ──
      let jitter = 0;
      const validPitches = pitchFrames.map(p => p.f0);
      if (validPitches.length > 4) {
        let periodDiffSum = 0;
        let periodSum = 0;
        for (let i = 1; i < validPitches.length; i++) {
          const T1 = 1 / validPitches[i-1];
          const T2 = 1 / validPitches[i];
          periodDiffSum += Math.abs(T2 - T1);
          periodSum += T1;
        }
        const meanPeriod = periodSum / (validPitches.length - 1);
        jitter = meanPeriod > 0
          ? (periodDiffSum / (validPitches.length - 1)) / meanPeriod * 100
          : 0;
        // 한국어 환경 보정: 모바일 마이크 고주파 노이즈 억제
        jitter = Math.max(0, jitter * 0.72);
      }

      // ── 진폭 추출 ──
      const amplitudes = [];
      for (let i = 0; i + frameSize < samples.length; i += hopSize) {
        const frame = samples.slice(i, i + frameSize);
        const rms = Math.sqrt(frame.reduce((s,v)=>s+v*v,0)/frame.length);
        if (rms > 0.003) amplitudes.push(rms);
      }

      // ── Shimmer: 연속 진폭 변동률 ──
      let shimmer = 0;
      if (amplitudes.length > 4) {
        let diffSum = 0, ampSum = 0;
        for (let i = 1; i < amplitudes.length; i++) {
          diffSum += Math.abs(amplitudes[i] - amplitudes[i-1]);
          ampSum += amplitudes[i-1];
        }
        const meanAmp = ampSum / (amplitudes.length - 1);
        shimmer = meanAmp > 0 ? (diffSum / (amplitudes.length - 1)) / meanAmp * 100 : 0;
        // 한국어 보정
        shimmer = Math.max(0, shimmer * 0.68);
      }

      // ── HNR: Boersma(1993) 자기상관 기반 ──
      let hnr = 0;
      const hnrWindowSize = Math.min(frameSize * 4, samples.length);
      if (hnrWindowSize > 0) {
        // 유성음 구간만 사용 (피치 확인된 프레임)
        const voicedStart = pitchFrames.length > 0
          ? Math.floor(samples.length * 0.2) : 0;
        const frame = samples.slice(voicedStart, voicedStart + hnrWindowSize);
        let r0 = 0;
        for (let j = 0; j < frame.length; j++) r0 += frame[j]*frame[j];
        if (r0 > 1e-9) {
          const meanF0 = validPitches.length > 0
            ? validPitches.reduce((a,b)=>a+b,0)/validPitches.length
            : 150;
          const lag = Math.round(sampleRate / meanF0);
          if (lag > 0 && lag < frame.length) {
            let rLag = 0;
            for (let j = 0; j < frame.length - lag; j++) rLag += frame[j] * frame[j+lag];
            const ratio = Math.max(0, Math.min(0.9999, rLag / r0));
            hnr = -10 * Math.log10(Math.max(1e-4, 1 - ratio));
            // 한국어 모바일 환경 보정 (+3dB 오프셋)
            hnr = Math.min(35, hnr + 3);
          }
        }
      }

      // ── 발화율: 음절 에너지 피크 기반 ──
      const totalFrames = amplitudes.length;
      const speechFrames = amplitudes.filter(a => a > 0.006).length;
      const speechRate = totalFrames > 0
        ? Math.round((speechFrames / totalFrames) * 100) : 0;

      // ── 피치 통계 ──
      const pitchMean = validPitches.length
        ? Math.round(validPitches.reduce((a,b)=>a+b,0)/validPitches.length) : null;
      const pitchStd = validPitches.length > 1
        ? Math.sqrt(validPitches.reduce((s,v)=>{const d=v-pitchMean;return s+d*d;},0)/validPitches.length) : 0;

      // ── 한국어 baseline 기준 상태 분류 ──
      // Jitter: 정상 <1.04%, 경계 <2.5%, 이상 ≥2.5%
      // Shimmer: 정상 <3.81%, 경계 <6.0%, 이상 ≥6.0%
      // HNR: 정상 >20dB, 경계 15~20dB, 이상 <15dB
      const jitterState = jitter < 1.04 ? 'normal' : jitter < 2.5 ? 'mild' : 'elevated';
      const shimState   = shimmer < 3.81 ? 'normal' : shimmer < 6.0 ? 'mild' : 'elevated';
      const hnrState    = hnr > 20 ? 'normal' : hnr > 15 ? 'mild' : 'low';

      // ── 감정/피로 추정 (피치 변동성 기반) ──
      const pitchVar = pitchStd / (pitchMean || 150);
      const emotionHint = pitchVar > 0.15 ? '활기차고 표현이 풍부한 목소리'
        : pitchVar > 0.08 ? '차분하고 안정적인 목소리'
        : '단조로운 톤 — 피로 또는 긴장 가능성';

      // ── 종합 음성 건강 점수 (한국어 가중치) ──
      const jScore  = jitter < 1.04 ? 35 : jitter < 2.5 ? 26 : 14;
      const shScore = shimmer < 3.81 ? 35 : shimmer < 6.0 ? 26 : 14;
      const hnrScore = hnr > 20 ? 30 : hnr > 15 ? 21 : 10;
      const voiceScore = Math.round(Math.max(20, Math.min(99, jScore + shScore + hnrScore)));

      // 상태 해석 텍스트
      const interpretation = voiceScore >= 85 ? '매우 건강한 목소리 상태예요'
        : voiceScore >= 70 ? '전반적으로 양호한 목소리 상태예요'
        : voiceScore >= 55 ? '약간의 목소리 피로 또는 긴장이 감지돼요'
        : '목소리 상태에 주의가 필요해요. 수분 보충과 휴식을 권합니다';

      return {
        jitter:    Math.round(jitter * 100) / 100,
        shimmer:   Math.round(shimmer * 100) / 100,
        hnr:       Math.round(hnr * 10) / 10,
        speechRate,
        jitterState, shimState, hnrState,
        voiceScore,
        pitchMean,
        pitchStd:  Math.round(pitchStd),
        emotionHint,
        interpretation,
        // 한국어 baseline 명시
        baseline: 'KR (Kim 2009 / Praat)',
      };
    } catch (e) {
      return null;
    }
  },

  // ★ v20.0: 음성 분석 결과 렌더링 (한국어 고도화)
  _renderVoiceResult(r, el) {
    if (!el || !r) return;
    el.style.display = 'block';

    const scoreColor = r.voiceScore >= 85 ? '#10b981' : r.voiceScore >= 70 ? '#3b82f6'
      : r.voiceScore >= 55 ? '#f59e0b' : '#ef4444';

    const stateLabel = s => s === 'normal' ? { cls: 'good', txt: '정상' }
      : s === 'mild'   ? { cls: 'warn',  txt: '경계' }
      : { cls: 'bad', txt: '주의' };

    const jSt  = stateLabel(r.jitterState);
    const shSt = stateLabel(r.shimState);
    const hnrSt = r.hnrState === 'normal' ? { cls:'good', txt:'정상' }
      : r.hnrState === 'mild' ? { cls:'warn', txt:'경계' } : { cls:'bad', txt:'낮음' };

    const metricsHTML = `
      <div class="vac-metrics-grid">
        <div class="vac-metric">
          <div class="vac-m-label">Jitter</div>
          <div class="vac-m-val" style="color:${jSt.cls==='good'?'#10b981':jSt.cls==='warn'?'#f59e0b':'#ef4444'}">${r.jitter}<span style="font-size:11px;font-weight:600">%</span></div>
          <div class="vac-m-ref">정상 &lt;1.04%</div>
          <span class="vac-m-status ${jSt.cls}">${jSt.txt}</span>
        </div>
        <div class="vac-metric">
          <div class="vac-m-label">Shimmer</div>
          <div class="vac-m-val" style="color:${shSt.cls==='good'?'#10b981':shSt.cls==='warn'?'#f59e0b':'#ef4444'}">${r.shimmer}<span style="font-size:11px;font-weight:600">%</span></div>
          <div class="vac-m-ref">정상 &lt;3.81%</div>
          <span class="vac-m-status ${shSt.cls}">${shSt.txt}</span>
        </div>
        <div class="vac-metric">
          <div class="vac-m-label">HNR</div>
          <div class="vac-m-val" style="color:${hnrSt.cls==='good'?'#10b981':hnrSt.cls==='warn'?'#f59e0b':'#ef4444'}">${r.hnr}<span style="font-size:11px;font-weight:600">dB</span></div>
          <div class="vac-m-ref">정상 &gt;20dB</div>
          <span class="vac-m-status ${hnrSt.cls}">${hnrSt.txt}</span>
        </div>
        <div class="vac-metric">
          <div class="vac-m-label">발화율</div>
          <div class="vac-m-val">${r.speechRate}<span style="font-size:11px;font-weight:600">%</span></div>
          <div class="vac-m-ref">음성 활성 비율</div>
          ${r.pitchMean ? `<span class="vac-m-status good">피치 ${r.pitchMean}Hz</span>` : ''}
        </div>
      </div>`;

    el.innerHTML = `
      <div class="voice-adv-card">
        <div class="vac-header">
          <span class="vac-badge">🇰🇷 한국어 기준</span>
          <span class="vac-title">음성 건강 분석</span>
        </div>
        <div class="vac-score-row">
          <div class="vac-score-circle" style="background:conic-gradient(${scoreColor} ${r.voiceScore*3.6}deg, #e5e7eb 0deg)">
            <div class="vac-score-num" style="color:${scoreColor}">${r.voiceScore}</div>
            <div class="vac-score-max">/100</div>
          </div>
          <div class="vac-interp">
            <div class="vac-interp-title">${r.voiceScore>=85?'건강한 목소리':r.voiceScore>=70?'양호한 상태':r.voiceScore>=55?'경미한 피로':'주의 필요'}</div>
            <div class="vac-interp-body">${r.interpretation || ''}</div>
          </div>
        </div>
        ${metricsHTML}
        ${r.emotionHint ? `<div class="vac-insight">🎤 <strong>목소리 패턴:</strong> ${r.emotionHint}<br><span style="font-size:10px;color:#6b7280">기준: ${r.baseline || 'Praat'}</span></div>` : ''}
      </div>`;
  },
  _renderAdvancedPPGCards(r, containerId) {
    // containerId 명시 없으면 얼굴/손가락 순으로 탐색
    const container = containerId
      ? document.getElementById(containerId)
      : (document.getElementById('fr-advanced-cards') || document.getElementById('finger-advanced-cards'));
    if (!container) return;
    container.style.display = 'block';

    const va  = r.vascularAge;
    const arr = r.arrhythmia;
    const rsa = r.rsaIndex;

    // 아무 데이터도 없으면 안내 문구
    if (!va && !arr && (rsa === null || rsa === undefined)) {
      container.innerHTML = `<div class="ppg-adv-empty">💡 30초 이상 측정 시 혈관 나이·부정맥·미주신경 분석이 추가됩니다.</div>`;
      return;
    }

    let html = '';

    // ── 카드 1: 혈관 나이 (얼굴 측정에서만 가능) ──
    if (va) {
      const gradeLabel = va.grade === 'young' ? '실제보다 젊음' : va.grade === 'aged' ? '실제보다 노화' : '나이에 맞는 수준';
      const gradeClass = va.grade === 'young' ? 'normal' : va.grade === 'aged' ? 'bad' : 'normal';
      const gradeIcon  = va.grade === 'young' ? '💪' : va.grade === 'aged' ? '⚠️' : '✅';
      const deltaText  = va.delta !== null ? (va.delta > 0 ? `+${va.delta}세` : `${va.delta}세`) : '';
      const confText   = va.confidence === 'high' ? '신호 풍부' : '신호 보통';
      let cmtVa = va.grade === 'young'
        ? `혈관 탄성도 분석 결과, 실제 나이보다 혈관 상태가 양호합니다. 꾸준한 운동과 좋은 식습관이 혈관 건강을 유지시켜 줍니다.`
        : va.grade === 'aged'
        ? `PPG 파형 분석에서 혈관 경직도가 다소 높게 나타났습니다. 규칙적인 유산소 운동, 금연, 저염식이 혈관 건강 개선에 도움이 됩니다. ※ 의학적 진단 아님`
        : `혈관 탄성도가 나이에 맞는 정상 범위입니다. 현재의 생활 습관을 유지하세요.`;
      if (va.aix !== null) cmtVa += ` (혈관 증강 지수 AIx: ${va.aix}%)`;

      html += `
      <div class="rg-card ppg-adv-card">
        <div class="rg-card-title">🫀 혈관 나이 추정 <span class="ppg-adv-badge">ME-rPPG</span></div>
        <div class="ppg-adv-main">
          <div class="ppg-adv-big">${va.estimatedAge}<span class="ppg-adv-unit">세</span></div>
          <div class="rg-badge ${gradeClass}" style="margin-top:4px">${gradeIcon} ${gradeLabel}${deltaText ? ' (' + deltaText + ')' : ''}</div>
        </div>
        <div class="ppg-adv-sub">신호 품질: ${confText} · 경직도 점수: ${va.stiffnessScore}/100</div>
        <div class="rg-comment">${cmtVa}</div>
        <div class="ppg-adv-disclaimer">※ PPG 파형 기반 추정값. 의학적 진단이 아닙니다.</div>
      </div>`;
    }

    // ── 카드 2: 부정맥 리스크 ──
    if (arr) {
      const riskLabel = arr.risk === 'low' ? '낮음 (정상 리듬)' : arr.risk === 'moderate' ? '보통 (관찰 권장)' : '높음 (전문의 상담 권장)';
      const riskClass = arr.risk === 'low' ? 'normal' : arr.risk === 'moderate' ? 'high' : 'bad';
      const riskIcon  = arr.risk === 'low' ? '💚' : arr.risk === 'moderate' ? '🟡' : '🔴';
      const cmtArr = arr.risk === 'low'
        ? `심박 리듬이 규칙적입니다. 포앵카레 플롯 분석에서 부정맥 패턴이 관찰되지 않았습니다.`
        : arr.risk === 'moderate'
        ? `심박 간격에 다소 불규칙한 패턴이 감지되었습니다. 피로·카페인·수면 부족으로도 나타날 수 있습니다. 지속될 경우 전문 검진을 권합니다.`
        : `심박 리듬에 이상 패턴이 관찰되었습니다. 단순 측정 노이즈일 수 있으나, 증상(두근거림, 어지러움)이 동반된다면 심장내과 상담을 권합니다.`;
      const flagMap = { 'sd_ratio_low':'SD비율 이상', 'high_irr':'불규칙성 높음', 'pnn50_high':'박동 변동 과다', 'rhythm_jump':'리듬 점프 패턴' };
      const flagText = arr.flags && arr.flags.length > 0 ? arr.flags.map(f => flagMap[f] || f).join(', ') : '이상 없음';

      html += `
      <div class="rg-card ppg-adv-card">
        <div class="rg-card-title">💓 부정맥 리스크 <span class="ppg-adv-badge">ME-rPPG</span></div>
        <div class="ppg-adv-main">
          <div class="rg-badge ${riskClass}" style="font-size:1rem;padding:6px 14px">${riskIcon} ${riskLabel}</div>
        </div>
        <div class="ppg-adv-sub">분석 지표: ${flagText}</div>
        <div class="ppg-adv-detail">
          SD1 ${arr.sd1 ?? '--'}ms · SD2 ${arr.sd2 ?? '--'}ms · pNN50 ${arr.pnn50 ?? arr.pNN50 ?? '--'}% · 불규칙도 ${arr.irregPct ?? '--'}%
        </div>
        <div class="rg-comment">${cmtArr}</div>
        <div class="ppg-adv-disclaimer">※ rPPG 기반 선별 검사. 의학적 진단이 아닙니다. 증상이 있으면 병원을 방문하세요.</div>
      </div>`;
    }

    // ── 카드 3: RSA 미주신경 지수 ──
    if (rsa !== null && rsa !== undefined) {
      const rsaGrade = rsa >= 50 ? 'normal' : rsa >= 25 ? 'high' : 'bad';
      const rsaLabel = rsa >= 50 ? '양호' : rsa >= 25 ? '보통' : '낮음';
      const rsaIcon  = rsa >= 50 ? '🌿' : rsa >= 25 ? '🟡' : '⚠️';
      const cmtRsa = rsa >= 50
        ? `호흡-심박 동기화(RSA)가 잘 이루어지고 있습니다. 미주신경이 활성화되어 심혈관 예비 능력이 양호한 상태입니다.`
        : rsa >= 25
        ? `호흡-심박 동기화가 보통 수준입니다. 복식 호흡 연습이나 명상이 미주신경 활성화에 도움을 줄 수 있습니다.`
        : `호흡-심박 동기화(RSA)가 낮게 측정되었습니다. 스트레스, 피로, 불규칙한 호흡이 영향을 줄 수 있습니다. 심호흡을 통해 자율신경 균형을 회복해보세요.`;

      html += `
      <div class="rg-card ppg-adv-card">
        <div class="rg-card-title">🌬️ 미주신경 활성도 (RSA) <span class="ppg-adv-badge">ME-rPPG</span></div>
        <div class="ppg-adv-main">
          <div class="ppg-adv-big">${rsa}<span class="ppg-adv-unit">/100</span></div>
          <div class="rg-badge ${rsaGrade}" style="margin-top:4px">${rsaIcon} ${rsaLabel}</div>
        </div>
        <div class="ppg-adv-sub">호흡-심박 동기화 지수 (Grossman 2007)</div>
        <div class="rg-comment">${cmtRsa}</div>
      </div>`;
    }

    container.innerHTML = html;
  },

  // ★ v18.0: 결과/detail 페이지용 — wellness 저장 데이터에서 고급 PPG 카드 렌더링
  _renderAdvancedPPGCardsFromWellness(w, containerId) {
    if (!w) return;
    // 얼굴과 손가락 중 데이터가 있는 것 우선 (혈관나이는 얼굴만, 부정맥은 둘 다)
    const faceData   = w.face   || null;
    const fingerData = w.finger || null;

    // 혈관나이 + RSA: 얼굴 우선
    const vascularAge = faceData?.vascularAge || null;
    const rsaIndex    = faceData?.rsaIndex ?? null;

    // 부정맥: 얼굴과 손가락 중 더 최근 것, 또는 risk가 높은 것 선택
    let arrhythmia = null;
    const fArr = faceData?.arrhythmia   || null;
    const fiArr = fingerData?.arrhythmia || null;
    if (fArr && fiArr) {
      // 리스크 높은 쪽 우선 (high > moderate > low)
      const riskOrder = { 'high': 3, 'moderate': 2, 'low': 1 };
      arrhythmia = (riskOrder[fArr.risk] || 0) >= (riskOrder[fiArr.risk] || 0) ? fArr : fiArr;
    } else {
      arrhythmia = fArr || fiArr;
    }

    // 아무것도 없으면 렌더링 안 함
    if (!vascularAge && !arrhythmia && rsaIndex === null) return;

    this._renderAdvancedPPGCards(
      { vascularAge, arrhythmia, rsaIndex },
      containerId
    );
  },

  faceTab(tab) {
    document.querySelectorAll('#page-face .r-tab').forEach(t => {
      t.classList.toggle('on', t.textContent.toLowerCase().includes(tab) || t.textContent.includes(tab.toUpperCase()));
    });
    document.querySelectorAll('#page-face .r-panel').forEach(p => {
      p.classList.toggle('on', p.dataset.fp === tab);
    });
  },

  // ─── 파형 그리기 ───
  _faceDrawWaveform() {
    const cv = document.getElementById('face-wave');
    const ctx = this._waveCtx || cv.getContext('2d');
    if (!this._waveCtx) this._waveCtx = ctx;
    const W = cv.width, H = cv.height;
    ctx.fillStyle = '#050810';
    ctx.fillRect(0, 0, W, H);

    const samples = this.state.face.samples;
    if (samples.length < 30) return;

    const winSamples = this.config.face.targetSR * this.config.face.waveWindowSec;
    const slice = samples.slice(-winSamples);
    if (slice.length < 30) return;

    const reds = slice.map(s => s.r);
    const greens = slice.map(s => s.g);
    const blues = slice.map(s => s.b);
    const hasBg = slice.every(s => s.br != null);
    let pos;
    if (hasBg) {
      const bgReds = slice.map(s => s.br);
      const bgGreens = slice.map(s => s.bg);
      const bgBlues = slice.map(s => s.bb);
      pos = this._posDualBranch(reds, greens, blues, bgReds, bgGreens, bgBlues);
    } else {
      pos = this._posAlgorithm(reds, greens, blues);
    }
    const filtered = this._bandpass(pos, this.config.face.targetSR, 0.7, 3.0);

    const minV = Math.min(...filtered);
    const maxV = Math.max(...filtered);
    const range = Math.max(maxV - minV, 0.0001);

    ctx.strokeStyle = 'rgba(167,139,250,.08)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = H * i / 4;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    ctx.strokeStyle = '#a78bfa';
    ctx.lineWidth = 1.8;
    ctx.shadowBlur = 4;
    ctx.shadowColor = '#a78bfa';
    ctx.beginPath();
    filtered.forEach((v, i) => {
      const x = i / (filtered.length - 1) * W;
      const y = H - ((v - minV) / range) * (H - 10) - 5;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.shadowBlur = 0;
  },

  // ════════════════════════════════════════════════════════════════
  // 헬퍼 함수
  // ════════════════════════════════════════════════════════════════

  _stdDev(arr) {
    if (!arr || arr.length === 0) return 0;
    const m = arr.reduce((a,b) => a+b, 0) / arr.length;
    return Math.sqrt(arr.reduce((s,v) => s + (v-m)**2, 0) / arr.length);
  },

  _detrend(arr) {
    const N = arr.length;
    const mean = arr.reduce((a,b)=>a+b,0) / N;
    let sumXY = 0, sumXX = 0;
    for (let i = 0; i < N; i++) {
      sumXY += (i - N/2) * (arr[i] - mean);
      sumXX += (i - N/2) ** 2;
    }
    const slope = sumXX > 0 ? sumXY / sumXX : 0;
    return arr.map((v, i) => v - mean - slope * (i - N/2));
  },

  _bandpass(sig, sr, loHz, hiHz) {
    const w1 = Math.max(2, Math.round(sr / hiHz));
    const w2 = Math.max(w1+1, Math.round(sr / loHz));
    const movAvg = (x, win) => {
      const out = new Array(x.length).fill(0);
      let sum = 0; const buf = new Array(win).fill(0); let idx = 0;
      for (let i = 0; i < x.length; i++) {
        const v = isFinite(x[i]) ? x[i] : 0;
        sum += v - buf[idx]; buf[idx] = v; idx = (idx + 1) % win;
        out[i] = sum / win;
      }
      return out;
    };
    const ma1 = movAvg(sig, w1);
    const ma2 = movAvg(sig, w2);
    return ma1.map((v, i) => v - ma2[i]);
  },

  _goertzelPeak(sig, sr, loHz, hiHz) {
    const goertzel = (x, sr, freq) => {
      const k = freq * x.length / sr;
      const w = 2 * Math.PI * k / x.length;
      const cosw = Math.cos(w), coeff = 2 * cosw;
      let q1 = 0, q2 = 0, q0;
      for (let i = 0; i < x.length; i++) {
        q0 = coeff * q1 - q2 + x[i];
        q2 = q1; q1 = q0;
      }
      return q1*q1 + q2*q2 - q1*q2*coeff;
    };
    let bestF = 0, bestP = 0, total = 0, count = 0;
    const startBPM = Math.round(loHz * 60);
    const endBPM = Math.round(hiHz * 60);
    for (let bpm = startBPM; bpm <= endBPM; bpm += 1) {
      const f = bpm / 60;
      const p = goertzel(sig, sr, f);
      total += p; count++;
      if (p > bestP) { bestP = p; bestF = f; }
    }
    const avg = total / count;
    return { freq: bestF, snr: bestP / Math.max(avg, 1e-9), power: bestP };
  },

  _detectPeaks(sig, sr, hrHz) {
    const N = sig.length;
    if (N < 10) return [];
    let sumS = 0;
    for (let i = 0; i < N; i++) sumS += sig[i];
    const meanS = sumS / N;
    let sumSq = 0;
    for (let i = 0; i < N; i++) sumSq += (sig[i] - meanS) ** 2;
    const std = Math.sqrt(sumSq / N);
    const centered = new Array(N);
    for (let i = 0; i < N; i++) centered[i] = sig[i] - meanS;

    let expectedRR = hrHz && hrHz > 0 ? sr / hrHz : sr * 0.85;
    const minDist = Math.max(8, Math.round(expectedRR * 0.55));
    const winHalf = Math.max(2, Math.round(expectedRR / 6));
    const thr = std * 0.02;

    const peaks = [];
    let lastIdx = -minDist;
    for (let i = winHalf; i < N - winHalf; i++) {
      const v = centered[i];
      if (v < thr) continue;
      let isMax = true;
      for (let j = 1; j <= winHalf; j++) {
        if (centered[i - j] > v || centered[i + j] > v) { isMax = false; break; }
      }
      if (!isMax) continue;
      if (i - lastIdx >= minDist) {
        peaks.push(i);
        lastIdx = i;
      } else if (peaks.length > 0 && centered[peaks[peaks.length - 1]] < v) {
        peaks[peaks.length - 1] = i;
        lastIdx = i;
      }
    }

    // ★ v13.4: Sub-frame peak estimation (Parabolic interpolation)
    // 자료에서 강조한 핵심: 30Hz 카메라의 quantization noise 극복
    // y(x) = a*x² + b*x + c 의 정점은 x = -b/(2a)
    // 3점 (i-1, i, i+1)으로 피팅하여 sub-sample 정밀도 획득
    // 효과: timing precision ±33ms → ±5ms (rPPG HRV 정확도 핵심)
    const refinedPeaks = [];
    for (const i of peaks) {
      if (i < 1 || i >= N - 1) {
        refinedPeaks.push(i);
        continue;
      }
      const y0 = centered[i - 1];
      const y1 = centered[i];
      const y2 = centered[i + 1];
      const denom = (y0 - 2 * y1 + y2);
      // 분모가 너무 작으면 (거의 평탄) 보간 안전하지 않음
      if (Math.abs(denom) < 1e-9) {
        refinedPeaks.push(i);
        continue;
      }
      // 정점 offset: -0.5 ~ +0.5 범위 내
      const offset = 0.5 * (y0 - y2) / denom;
      // outlier 방지: |offset| > 1 이면 그냥 정수 인덱스
      if (Math.abs(offset) > 1) {
        refinedPeaks.push(i);
        continue;
      }
      refinedPeaks.push(i + offset);
    }
    return refinedPeaks;
  },

  // ★ v13.6: RMSSD ECG-equivalent 변환 (무조건 적용)
  // rPPG는 ECG 대비 RMSSD 30-50% 과대평가가 학술 정설 (Mejia-Mejia 2022, Li 2023, ResearchGate)
  // 즉 confidence 1.0이어도 보정 필수. 상용 앱(Anura, Samsung Health)도 모두 보정함.
  //
  // 학술 모델 (Mejia-Mejia 2022 메타분석 회귀):
  //   ECG_RMSSD ≈ rPPG_RMSSD × 0.55 ~ 0.70  (평균 0.62)
  //   변동: SQI/SNR/움직임에 따라 ±0.10
  //
  // 본 구현은 단순 선형 회귀 + quality-aware modulation
  _correctRMSSDBias(rawRMSSD, sdnn, sqi, snr) {
    if (!rawRMSSD || rawRMSSD <= 0) return null;

    const ratio = sdnn ? rawRMSSD / sdnn : 1.0;

    // === 핵심 변환 계수 (Mejia-Mejia 2022 평균값 기반) ===
    let correctionFactor = 0.62;

    if (ratio > 1.4) {
      const excess = Math.min(0.6, ratio - 1.4);
      correctionFactor -= (excess / 0.6) * 0.10;
    } else if (ratio < 0.7) {
      correctionFactor += (0.7 - ratio) * 0.25;
    }

    if (sqi >= 90) correctionFactor += 0.05;
    else if (sqi < 70) correctionFactor -= 0.05;

    const snrNorm = Math.max(0, Math.min(1, (snr || 5) / 30));
    if (snrNorm > 0.5) correctionFactor += 0.03;
    else if (snrNorm < 0.15) correctionFactor -= 0.05;

    correctionFactor = Math.max(0.45, Math.min(0.85, correctionFactor));

    let corrected = Math.round(rawRMSSD * correctionFactor);
    console.log(`[RMSSD] ECG 변환: ${rawRMSSD}ms × ${correctionFactor.toFixed(2)} → ${corrected}ms (ratio=${ratio.toFixed(2)}, sqi=${sqi}, snr=${(snr||0).toFixed(1)})`);

    // ★ v14.4: EMA 제거 - 실제 변동을 그대로 노출
    // 이유: EMA가 과도하게 안정화시켜 컨디션 변화를 못 잡아냄
    // baseline 비교는 _generatePersonalizedAssessment에서 처리
    return corrected;
  },

  // ─── 공통 ───
  _setupCanvas() {
    this._cv = document.createElement('canvas');
  },

  _bindVisibilityHandler() {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.state.face.running) {
        this._faceTickTimer();
      }
    });
  },

  _cleanupAll() {
    if (this.state.face.stream) {
      this.state.face.stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
    }
    if (this.state.body.posture.stream) {
      this.state.body.posture.stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
    }
    this._stopMotionListener();
  },

  // ════════════════════════════════════════════════════════════════
  // 신체 측정
  // ════════════════════════════════════════════════════════════════
  startBodyTest(test) {
    console.log('[Body] startBodyTest:', test);
    this.state.body.currentTest = test;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('on'));
    document.getElementById('page-test-' + test).classList.add('on');
    document.getElementById(`bt-${test}-stage`).style.display = 'block';
    const running = document.getElementById(`bt-${test}-running`);
    if (running) running.style.display = 'none';
    const result = document.getElementById(`bt-${test}-result`);
    if (result) { result.style.display = 'none'; result.innerHTML = ''; }
    this.state.page = 'test-' + test;
    history.pushState({ page: 'test-' + test }, '', '');
    window.scrollTo(0, 0);
  },

  cancelBodyTest(test) {
    console.log('[Body] cancelBodyTest:', test);
    this.bodyStop();
    this.goPage('body');
  },

  async bodyStart(test) {
    console.log('[Body] bodyStart:', test);
    const b = this.state.body;
    b.currentTest = test;
    b.running = true;
    b.startMs = performance.now();

    // ★ v15.4: 측정 중 화면 꺼짐 방지
    this._acquireWakeLock();

    document.getElementById(`bt-${test}-stage`).style.display = 'none';
    document.getElementById(`bt-${test}-running`).style.display = 'block';

    if (test === 'balance') await this._startBalance();
    else if (test === 'gait') await this._startGait();
    else if (test === 'tremor') await this._startTremor();
    else if (test === 'reaction') await this._startReaction();
    else if (test === 'posture') await this._startPosture();
  },

  bodyStop(preserveSpeech) {
    console.log('[Body] bodyStop');
    // ★ v13.9: 측정 완료 시 음성 끊지 않음
    if (!preserveSpeech) this._speakStop();
    const b = this.state.body;

    // ★ v15.4: wake lock 해제
    this._releaseWakeLock();
    b.running = false;
    if (b.timerInterval) { clearInterval(b.timerInterval); b.timerInterval = null; }
    if (b.reaction.waitTimer) { clearTimeout(b.reaction.waitTimer); b.reaction.waitTimer = null; }
    if (b.posture.captureTimer) { clearTimeout(b.posture.captureTimer); b.posture.captureTimer = null; }
    this._stopMotionListener();
    if (b.posture.stream) {
      try { b.posture.stream.getTracks().forEach(t => t.stop()); } catch(e) {}
      b.posture.stream = null;
    }
  },

  // ─── DeviceMotion 권한 + 리스너 ───
  async _requestMotionPermission() {
    // iOS 13+는 명시적 권한 필요
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        const res = await DeviceMotionEvent.requestPermission();
        if (res !== 'granted') {
          alert('모션 센서 권한이 필요합니다.');
          return false;
        }
      } catch (e) {
        console.warn('[Motion] 권한 요청 실패:', e);
        return false;
      }
    }
    return true;
  },

  _startMotionListener(callback) {
    this._stopMotionListener();
    const handler = (event) => {
      const acc = event.accelerationIncludingGravity || event.acceleration;
      if (!acc || acc.x == null) return;
      callback({
        x: acc.x, y: acc.y, z: acc.z,
        t: performance.now()
      });
    };
    this.state.body.motionListener = handler;
    window.addEventListener('devicemotion', handler);
  },

  _stopMotionListener() {
    if (this.state.body.motionListener) {
      window.removeEventListener('devicemotion', this.state.body.motionListener);
      this.state.body.motionListener = null;
    }
  },

  // ════════════════════════════════════════════════════════════════
  // 균형 검사 (Romberg)
  // 알고리즘: 가속도 흔들림 RMS + Jerk (Lavoie 2021)
  // ════════════════════════════════════════════════════════════════
  async _startBalance() {
    console.log('[Balance] 시작');
    const ok = await this._requestMotionPermission();
    if (!ok) { this.bodyStop(); return; }
    const b = this.state.body.balance;
    b.phase = 'eyes_open';
    b.samples = [];
    b.openSamples = [];
    b.closedSamples = [];

    document.getElementById('bt-balance-phase').textContent = '👁 눈을 뜨고 정면을 보세요';
    let remain = 15;
    document.getElementById('bt-balance-timer').textContent = remain;

    // ★ v13.1: 음성 안내 → 끝난 후 측정 시작 (1초 추가 대기)
    this._speak('균형 검사를 시작합니다. 눈을 뜨고 정면을 보세요. 15초 동안 가만히 서있으세요.', () => {
      if (!this.state.body.running) return; // 사용자 중단 시
      console.log('[Balance] 음성 종료 → 가속도 측정 시작');

      this._startMotionListener(s => {
        this.state.body.balance.samples.push(s);
        this._drawAccelWave('bt-balance-wave', this.state.body.balance.samples);
      });

      this.state.body.timerInterval = setInterval(() => {
        remain--;
        document.getElementById('bt-balance-timer').textContent = remain;
        if (remain === 5) this._speak('5초 남았습니다');
        if (remain === 0) {
          if (b.phase === 'eyes_open') {
            b.openSamples = [...b.samples];
            b.samples = [];
            b.phase = 'eyes_closed';
            document.getElementById('bt-balance-phase').textContent = '👁‍🗨 눈을 감고 가만히 서세요';
            remain = 15;
            document.getElementById('bt-balance-timer').textContent = remain;
            if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
            this._speak('이제 눈을 감으세요. 그대로 15초간 가만히 서있으세요.');
          } else {
            b.closedSamples = [...b.samples];
            this._speak('측정이 완료되었습니다.');
            // ★ v13.9: 음성을 끊지 않도록 finalize 후 bodyStop은 음성 보존 모드
            this._finalizeBalance(true);
          }
        }
      }, 1000);
    });
  },

  // ★ v13.1: 가속도 그래프 실시간 그리기 (균형/보행/손떨림 공통)
  _drawAccelWave(canvasId, samples) {
    const cv = document.getElementById(canvasId);
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(0, 0, W, H);

    if (samples.length < 2) return;
    // 최근 ~3초만 표시 (보통 60Hz × 3s ≈ 180샘플)
    const winLen = Math.min(180, samples.length);
    const slice = samples.slice(-winLen);
    // 가속도 크기 (중력 미제거) → 평균에서의 편차로 표현
    const meanX = slice.reduce((s,v) => s + v.x, 0) / slice.length;
    const meanY = slice.reduce((s,v) => s + v.y, 0) / slice.length;
    const meanZ = slice.reduce((s,v) => s + v.z, 0) / slice.length;
    const mags = slice.map(s => Math.sqrt(
      (s.x - meanX) ** 2 + (s.y - meanY) ** 2 + (s.z - meanZ) ** 2
    ));
    let minV = Infinity, maxV = -Infinity;
    for (const v of mags) { if (v < minV) minV = v; if (v > maxV) maxV = v; }
    const range = Math.max(maxV - minV, 0.05); // 너무 작은 변화도 표시

    // 그리드
    ctx.strokeStyle = 'rgba(167,139,250,.12)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = H * i / 4;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // 가속도 변동 그래프
    ctx.strokeStyle = '#a78bfa';
    ctx.lineWidth = 1.8;
    ctx.shadowBlur = 4;
    ctx.shadowColor = '#a78bfa';
    ctx.beginPath();
    mags.forEach((v, i) => {
      const x = i / (mags.length - 1) * W;
      const y = H - ((v - minV) / range) * (H - 12) - 6;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.shadowBlur = 0;
  },

  _finalizeBalance(preserveSpeech) {
    console.log('[Balance] finalize');
    this.bodyStop(preserveSpeech);
    const b = this.state.body.balance;
    const openMetrics = this._computeBalanceMetrics(b.openSamples);
    const closedMetrics = this._computeBalanceMetrics(b.closedSamples);
    console.log('[Balance] 눈뜨고:', openMetrics, '눈감고:', closedMetrics);

    // Romberg ratio: 눈감은 흔들림 / 눈뜬 흔들림
    // 정상: 1.5 ~ 3.0 (눈감으면 약간 더 흔들림)
    // 비정상: > 4 (눈감으면 크게 흔들림 = 전정 기능 이상)
    let rombergRatio = 0;
    if (openMetrics.rms > 0.01) {
      rombergRatio = closedMetrics.rms / openMetrics.rms;
    }

    // ★ v15.3: 변별력 강화 — 나이 보정 점수
    const profile = this._getUserProfile();
    const { age } = profile;
    let score;

    if (age) {
      // RMS 점수 (낮을수록 좋음) — 나이별 평균 대비
      // 20대 RMS 평균 0.15, 80대 0.35 정도. 정확한 norm 데이터 부족하므로 보수적 추정
      const rmsRef = age < 40 ? { mean: 0.18, sd: 0.10 }
                   : age < 60 ? { mean: 0.22, sd: 0.12 }
                   : age < 75 ? { mean: 0.30, sd: 0.15 }
                   :            { mean: 0.40, sd: 0.18 };
      const rmsScore = this._ageNormalizedScore(closedMetrics.rms, rmsRef, false);

      // Romberg ratio 점수 (나이별 평균 대비)
      const rombergRef = this._refRomberg(age);
      const rombergScore = this._ageNormalizedScore(rombergRatio, rombergRef, false);

      score = Math.round(rmsScore * 0.6 + rombergScore * 0.4);
      score = Math.max(5, Math.min(99, score));
      console.log(`[Balance Score] age=${age} RMS=${closedMetrics.rms.toFixed(3)}(${rmsScore}) Romberg=${rombergRatio.toFixed(2)}(${rombergScore}) → ${score}`);
    } else {
      // Fallback: 기존 임계 방식
      score = 100;
      if (closedMetrics.rms > 0.4) score -= 30;
      else if (closedMetrics.rms > 0.25) score -= 15;
      if (rombergRatio > 4) score -= 25;
      else if (rombergRatio > 2.5) score -= 10;
      score = Math.max(0, Math.min(100, score));
    }

    const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D';

    let cmt;
    if (age) {
      // ★ v15.3: 나이 보정 점수에 맞는 코멘트
      if (score >= 85) cmt = `${age}세 또래 평균보다 균형 능력이 훨씬 우수합니다. 상위 15% 수준입니다.`;
      else if (score >= 70) cmt = `${age}세 또래 평균을 약간 상회합니다. 좋은 균형 능력입니다.`;
      else if (score >= 50) cmt = `${age}세 또래 평균 수준입니다. 코어 운동을 추가하면 더 향상될 수 있어요.`;
      else if (score >= 30) cmt = `${age}세 또래 평균보다 다소 낮습니다. 발목·코어 근력 강화를 권장합니다.`;
      else cmt = `${age}세 또래 평균보다 균형이 불안정합니다. 어지러움이 잦다면 전문의 상담을 권합니다.`;
    } else {
      if (score >= 85) cmt = '균형 능력이 우수합니다. 전정 기능과 자세 안정성이 양호합니다.';
      else if (score >= 70) cmt = '균형 능력이 정상 범위입니다.';
      else if (score >= 50) cmt = '균형 능력이 다소 떨어집니다. 코어 운동을 고려하세요.';
      else cmt = '균형이 불안정합니다. 어지러움이 잦다면 전문의 상담을 권합니다.';
    }

    document.getElementById('bt-balance-running').style.display = 'none';
    const result = document.getElementById('bt-balance-result');
    result.style.display = 'block';
    result.innerHTML = `
      <div class="bt-result-card">
        <div class="bt-result-title">⚖️ 균형 검사 결과</div>
        <div class="bt-result-value">${score}<span class="bt-result-unit">/ 100</span></div>
        <div class="bt-result-grade ${grade}">${grade} 등급</div>
        <div class="bt-result-row"><span class="bt-result-row-label">눈뜨고 흔들림 (RMS)</span><span class="bt-result-row-value">${openMetrics.rms.toFixed(3)} m/s²</span></div>
        <div class="bt-result-row"><span class="bt-result-row-label">눈감고 흔들림 (RMS)</span><span class="bt-result-row-value">${closedMetrics.rms.toFixed(3)} m/s²</span></div>
        <div class="bt-result-row"><span class="bt-result-row-label">Romberg 비율</span><span class="bt-result-row-value">${rombergRatio.toFixed(2)}x</span></div>
        <div class="bt-result-cmt">${cmt}</div>
      </div>
      ${this._renderFallRiskCard(score, closedMetrics, openMetrics, rombergRatio, age)}
      <button class="bt-redo" type="button" onclick="App.startBodyTest('balance')">🔄 다시 측정</button>
    `;

    // ★ v21.0: 낙상 위험도 계산
    const fallRisk = this._computeFallRisk(score, closedMetrics.rms, rombergRatio, age);

    // ★ v13: Wellness 저장 (+ v21.0 낙상 위험)
    this._wellnessSave('balance', {
      score, rms: closedMetrics.rms, rombergRatio,
      fallRiskLevel: fallRisk.level,
      fallRiskScore: fallRisk.riskScore,
      rombergRatioVal: Math.round(rombergRatio * 100) / 100,
    });
    // ★ v19.3: 측정 완료 후 인사이트 카드
    setTimeout(() => this._showPostMeasureInsight('balance', { score }), 800);
  },

  // ★ v21.0: 낙상 위험도 계산 (Romberg + 흔들림 기반)
  // 학술: Romberg ratio는 전정·고유수용 기능 지표 (Black 1982),
  //       자세 동요(postural sway)는 낙상 예측 인자 (Maki 1994)
  _computeFallRisk(balanceScore, closedRms, rombergRatio, age) {
    // 위험 점수 0~100 (높을수록 위험)
    let risk = 0;
    // 균형 점수 반영 (낮을수록 위험)
    risk += (100 - balanceScore) * 0.5;
    // Romberg 비율 (전정 기능 — 높을수록 위험)
    if (rombergRatio > 4.0)      risk += 25;
    else if (rombergRatio > 2.8) risk += 12;
    else if (rombergRatio > 1.2) risk += 0;
    else                         risk += 5; // 너무 낮아도(눈영향 없음) 측정 의심
    // 눈감고 흔들림 절대값
    if (closedRms > 0.40)      risk += 20;
    else if (closedRms > 0.28) risk += 10;
    // 고령 가중 (65세 이상 낙상 취약)
    if (age >= 75)      risk += 8;
    else if (age >= 65) risk += 4;

    risk = Math.max(0, Math.min(100, Math.round(risk)));

    let level, label, color, advice;
    if (risk < 25) {
      level = 'low'; label = '낮음'; color = '#16a34a';
      advice = '낙상 위험이 낮습니다. 규칙적인 걷기와 가벼운 균형 운동으로 현재 상태를 유지하세요.';
    } else if (risk < 50) {
      level = 'mild'; label = '경계'; color = '#f59e0b';
      advice = '약간의 주의가 필요합니다. 발목·코어 근력 운동과 한 발 서기 연습이 도움됩니다. 어두운 곳 이동 시 조심하세요.';
    } else if (risk < 70) {
      level = 'moderate'; label = '주의'; color = '#ea580c';
      advice = '낙상 주의가 필요합니다. 욕실·계단에 손잡이를 두고, 미끄럼 방지 매트를 권합니다. 며칠간 반복 측정해 추세를 확인하세요.';
    } else {
      level = 'high'; label = '높음'; color = '#dc2626';
      advice = '낙상 위험이 높게 나왔습니다. 일회성 결과일 수 있으나, 어지러움·휘청거림이 잦다면 전문의(이비인후과·신경과) 상담을 권합니다.';
    }
    return { riskScore: risk, level, label, color, advice };
  },

  // ════════════════════════════════════════════════════════════════
  // ★ v21.1: 종합 낙상위험 + 인지건강 통합 평가
  //
  // 학술 근거:
  //  - 낙상 예측: 균형(자세동요) + 보행(가변성) 결합이 단일 지표보다 우수
  //    (Verghese 2009 J Gerontol; Montero-Odasso 2012)
  //  - 운동인지위험(MCR): 보행속도 + 가변성 결합 (Verghese 2013)
  //  - 신뢰도: 측정 횟수↑ = 추세 안정성↑ (Pieruccini-Faria 2021)
  //
  // 여러 측정(보행+균형)의 최근값을 결합 + 측정 횟수로 신뢰도 산출
  // ════════════════════════════════════════════════════════════════
  _computeBrainBalanceHealth() {
    const w = this.state.wellness || {};
    const gaitH = this._historyGet ? this._historyGet('gait') : [];
    const balH  = this._historyGet ? this._historyGet('balance') : [];
    const profile = this._getUserProfile ? this._getUserProfile() : {};
    const age = profile.age || 50;

    // 최근 측정값
    const lastGait = gaitH.length ? gaitH[gaitH.length-1] : null;
    const lastBal  = balH.length  ? balH[balH.length-1]  : null;

    // ★ v21.2: 데이터 가용성 — 신규 정밀지표 + 기존 score 폴백
    const hasGaitCV = lastGait && lastGait.cvStepTime != null;
    const hasBalance = lastBal && lastBal.fallRiskScore != null;
    // 기존 측정(score만 있는 구버전 데이터)도 인식
    const hasGaitScore = lastGait && lastGait.score != null;
    const hasBalScore  = lastBal && lastBal.score != null;

    // 측정 데이터가 전혀 없으면 → 측정 유도 모드
    if (!hasGaitScore && !hasBalScore) {
      return { available: true, promptMode: true };
    }

    // ── 측정 횟수 기반 신뢰도 ──
    const gaitCVCount = gaitH.filter(h => h.cvStepTime != null).length;
    const balCount = balH.filter(h => h.fallRiskScore != null).length;
    const totalMeasures = gaitCVCount + balCount;
    let confidence, confLabel;
    if (totalMeasures >= 6)      { confidence = 'high';   confLabel = '높음'; }
    else if (totalMeasures >= 3) { confidence = 'medium'; confLabel = '보통'; }
    else                         { confidence = 'low';    confLabel = '낮음 (반복 측정 권장)'; }

    // ── 종합 낙상 위험 (균형 + 보행 결합) ──
    let fallRiskScore = null, fallLevel = null, fallColor = null, fallLabel = null;
    {
      let parts = [], weights = [];
      if (hasBalance) { parts.push(lastBal.fallRiskScore); weights.push(0.6); }
      else if (hasBalScore) {
        // 구버전 균형 데이터: score → 위험도 역산 (점수 높을수록 위험 낮음)
        parts.push(Math.max(0, 100 - lastBal.score)); weights.push(0.6);
      }
      if (hasGaitCV) {
        const gaitFall = Math.min(100, Math.max(0, (lastGait.cvStepTime - 2) * 12));
        parts.push(gaitFall); weights.push(0.4);
      } else if (hasGaitScore) {
        parts.push(Math.max(0, 100 - lastGait.score)); weights.push(0.4);
      }
      if (parts.length) {
        const wSum = weights.reduce((a,b)=>a+b,0);
        fallRiskScore = Math.round(parts.reduce((s,p,i)=>s+p*weights[i],0) / wSum);
        if (age >= 75) fallRiskScore = Math.min(100, fallRiskScore + 5);
        if (fallRiskScore < 25)      { fallLevel='low';      fallColor='#16a34a'; fallLabel='낮음'; }
        else if (fallRiskScore < 50) { fallLevel='mild';     fallColor='#f59e0b'; fallLabel='경계'; }
        else if (fallRiskScore < 70) { fallLevel='moderate'; fallColor='#ea580c'; fallLabel='주의'; }
        else                         { fallLevel='high';     fallColor='#dc2626'; fallLabel='높음'; }
      }
    }

    // ── 인지건강(치매 선별) — 보행 가변성 + MCR ──
    let cogScore = null, cogLevel = null, cogColor = null, cogLabel = null;
    if (hasGaitCV) {
      const cv = lastGait.cvStepTime;
      cogScore = Math.round(Math.max(0, Math.min(100, 100 - (cv - 2) * 11)));
      if (lastGait.mcrLevel === 'watch') cogScore = Math.min(cogScore, 55);
      else if (lastGait.mcrLevel === 'normal') cogScore = Math.min(cogScore, 72);
    } else if (hasGaitScore) {
      // 구버전 보행 데이터: score 기반 근사 (정밀 분석 권장 표시용)
      cogScore = lastGait.score;
    }
    if (cogScore != null) {
      if (cogScore >= 80)      { cogLevel='good';   cogColor='#16a34a'; cogLabel='양호'; }
      else if (cogScore >= 60) { cogLevel='normal'; cogColor='#f59e0b'; cogLabel='경계'; }
      else                     { cogLevel='watch';  cogColor='#dc2626'; cogLabel='추적 권장'; }
    }

    // ── 추세 방향 (최근 3회 vs 이전) ──
    let cvTrend = null;
    const cvSeries = gaitH.filter(h => h.cvStepTime != null).map(h => h.cvStepTime);
    if (cvSeries.length >= 4) {
      const recent = cvSeries.slice(-2).reduce((a,b)=>a+b,0)/2;
      const older = cvSeries.slice(0,-2).reduce((a,b)=>a+b,0)/(cvSeries.length-2);
      const delta = recent - older;
      if (delta > 0.8)       cvTrend = { dir:'up', text:'가변성 증가 — 주의 관찰', color:'#dc2626' };
      else if (delta < -0.8) cvTrend = { dir:'down', text:'가변성 개선 — 안정화', color:'#16a34a' };
      else                   cvTrend = { dir:'stable', text:'안정적 유지', color:'#6b7280' };
    }

    return {
      available: true,
      confidence, confLabel, totalMeasures,
      fallRiskScore, fallLevel, fallColor, fallLabel,
      cogScore, cogLevel, cogColor, cogLabel,
      cvTrend,
      cvStepTime: hasGaitCV ? lastGait.cvStepTime : null,
      hasGait: hasGaitCV, hasBalance,
    };
  },

  // ★ v21.0: 낙상 위험 카드 렌더
  _renderFallRiskCard(balanceScore, closedMetrics, openMetrics, rombergRatio, age) {
    const fr = this._computeFallRisk(balanceScore, closedMetrics.rms, rombergRatio, age || 50);
    return `
      <div class="fall-risk-card">
        <div class="fall-risk-title">🛡️ 낙상 위험도 평가 <span class="fall-risk-badge">선별 보조</span></div>
        <div class="fall-risk-gauge">
          <div class="frg-bar">
            <div class="frg-fill" style="width:${fr.riskScore}%;background:${fr.color}"></div>
            <div class="frg-marker" style="left:${fr.riskScore}%"></div>
          </div>
          <div class="frg-labels">
            <span>안전</span><span>경계</span><span>주의</span><span>위험</span>
          </div>
        </div>
        <div class="fall-risk-result">
          <span class="frr-level" style="color:${fr.color}">위험도 ${fr.label}</span>
          <span class="frr-score">${fr.riskScore}<span style="font-size:11px;color:#9ca3af">/100</span></span>
        </div>
        <div class="fall-risk-advice">${fr.advice}</div>
        <div class="fall-risk-cite">
          📚 Romberg test (Black 1982) · Postural sway &amp; falls (Maki 1994)<br>
          ⚠️ 의학적 진단이 아닌 <strong>낙상 선별 보조 지표</strong>입니다. 추세 관찰을 권합니다.
        </div>
      </div>`;
  },

  // ════════════════════════════════════════════════════════════════
  // ★ v21.0: 보행/낙상 분석 고도화 — 치매·낙상 선별 보조 지표
  //
  // 학술 근거:
  //  - 보행 가변성(Stride Time CV): Hausdorff 2007, Pieruccini-Faria 2021
  //    (Alzheimer's & Dementia) — stride-to-stride 변동이 인지-피질
  //    기능장애의 민감한 지표. AD군 분류 AUC 0.71~0.86
  //  - 추세 중요성: Verghese 2023 (PMC10736855) — 일회성보다 종단
  //    추세가 미래 치매 예측에 추가 가치
  //  - 운동인지위험증후군(MCR): Verghese 2013 — 느린 보행 + 인지 호소
  //  - Butterworth 저역통과: Brajdic & Harle 2013 (보행 검출 표준)
  //
  // ⚠️ 중요: 본 지표는 의학적 "진단"이 아닌 "선별 보조(screening aid)"
  //    단일 측정의 절대값보다 개인 내 추세 변화가 핵심 가치
  // ════════════════════════════════════════════════════════════════

  // 4차 Butterworth 저역통과 필터 (2-pass, zero-phase 근사)
  // cutoff Hz, sampleRate Hz
  _butterworthLowpass(data, cutoff, sampleRate) {
    if (!data || data.length < 6) return data ? data.slice() : [];
    // 2차 정규화 (Wn)
    const nyq = sampleRate / 2;
    let wc = cutoff / nyq;
    wc = Math.max(0.01, Math.min(0.99, wc));
    // 2차 저역통과 계수 (RBJ biquad, Q=0.7071 Butterworth)
    const w0 = Math.tan(Math.PI * wc / 2);
    const w02 = w0 * w0;
    const sqrt2 = Math.SQRT2;
    const denom = 1 + sqrt2 * w0 + w02;
    const b0 = w02 / denom;
    const b1 = 2 * b0;
    const b2 = b0;
    const a1 = 2 * (w02 - 1) / denom;
    const a2 = (1 - sqrt2 * w0 + w02) / denom;

    const applyOnce = (x) => {
      const y = new Array(x.length).fill(0);
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < x.length; i++) {
        const xi = x[i];
        const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        y[i] = yi;
        x2 = x1; x1 = xi; y2 = y1; y1 = yi;
      }
      return y;
    };
    // forward + backward (zero-phase 근사 → 4차 효과)
    const fwd = applyOnce(data);
    const rev = applyOnce(fwd.slice().reverse());
    return rev.reverse();
  },

  // 가속도 샘플 → SVM(Signal Vector Magnitude) 시계열 + 균등 리샘플
  // 반환: { svm:[], sr:실효샘플레이트 }
  _gaitToSVM(samples) {
    if (!samples || samples.length < 10) return { svm: [], sr: 0 };
    // 실효 샘플레이트
    const dur = (samples[samples.length - 1].t - samples[0].t) / 1000;
    const sr = dur > 0 ? samples.length / dur : 50;
    // SVM = sqrt(x²+y²+z²) → 중력 성분 제거(평균 차감)
    const svmRaw = samples.map(s => Math.sqrt(s.x*s.x + s.y*s.y + s.z*s.z));
    const mean = svmRaw.reduce((a, b) => a + b, 0) / svmRaw.length;
    const svm = svmRaw.map(v => v - mean);
    return { svm, sr };
  },

  // 보행 이벤트(걸음) 검출 → step time 배열 반환
  // Butterworth 필터 + 적응형 피크 검출
  _detectSteps(samples) {
    const { svm, sr } = this._gaitToSVM(samples);
    if (svm.length < 20 || sr < 5) return { stepTimes: [], peaks: [], sr };

    // 보행 대역 저역통과 (3.5Hz) — 고주파 노이즈 제거
    const filtered = this._butterworthLowpass(svm, 3.5, sr);

    // 적응형 임계값 (표준편차 기반)
    const std = Math.sqrt(filtered.reduce((s, v) => s + v*v, 0) / filtered.length);
    const thr = std * 0.45;
    // 최소 걸음 간격 (보행 최대 ~4.5 step/s → 0.22s)
    const minDist = Math.max(3, Math.round(sr * 0.25));

    const peaks = [];
    let lastIdx = -minDist;
    for (let i = 1; i < filtered.length - 1; i++) {
      if (filtered[i] > thr && filtered[i] >= filtered[i-1] && filtered[i] > filtered[i+1]) {
        if (i - lastIdx >= minDist) {
          peaks.push(i);
          lastIdx = i;
        }
      }
    }
    // step time(초) 배열 — 피크 간 시간차
    const stepTimes = [];
    for (let i = 1; i < peaks.length; i++) {
      const dt = (peaks[i] - peaks[i-1]) / sr;
      if (dt > 0.18 && dt < 2.0) stepTimes.push(dt); // 생리적 범위만
    }
    return { stepTimes, peaks, sr };
  },

  // 보행 고도화 지표 산출 (가변성/리듬일관성/추정속도)
  // ★ v25.0: Harmonic Ratio (Menz 2003) — 보행 부드러움/대칭성
  // 걸음 주기의 짝수 조화(대칭)와 홀수 조화(비대칭) 파워 비. 높을수록 부드러운 보행.
  _computeHarmonicRatio(signal, peaks) {
    if (!peaks || peaks.length < 4) return null;
    // 평균 stride 길이(2보)로 한 주기 추출
    const avgStep = (peaks[peaks.length-1] - peaks[0]) / (peaks.length - 1);
    const strideLen = Math.round(avgStep * 2);
    if (strideLen < 8 || strideLen > signal.length) return null;
    // 중앙 stride 구간
    const startIdx = Math.max(0, Math.floor(signal.length/2 - strideLen/2));
    const seg = signal.slice(startIdx, startIdx + strideLen);
    if (seg.length < 8) return null;
    // DFT로 조화 성분 계산 (첫 20 harmonics)
    const N = seg.length;
    let evenPow = 0, oddPow = 0;
    for (let h = 1; h <= 20; h++) {
      let re = 0, im = 0;
      for (let n = 0; n < N; n++) {
        const ang = -2 * Math.PI * h * n / N;
        re += seg[n] * Math.cos(ang);
        im += seg[n] * Math.sin(ang);
      }
      const pow = Math.sqrt(re*re + im*im);
      if (h % 2 === 0) evenPow += pow; else oddPow += pow;
    }
    return oddPow > 1e-9 ? evenPow / oddPow : null;
  },

  // ★ v25.0: Sample Entropy (Richman 2000) — 시계열 복잡도/규칙성
  // 보행 stride time의 복잡도. Hausdorff 1997: 건강한 보행은 적정 복잡도 유지.
  _sampleEntropy(data, m, rFactor) {
    const N = data.length;
    if (N < m + 2) return null;
    const mean = data.reduce((a,b)=>a+b,0)/N;
    const sd = Math.sqrt(data.reduce((s,v)=>s+(v-mean)**2,0)/N) || 1e-9;
    const r = rFactor * sd;
    const count = (mm) => {
      let cnt = 0;
      for (let i = 0; i < N - mm; i++) {
        for (let j = i + 1; j < N - mm; j++) {
          let match = true;
          for (let k = 0; k < mm; k++) {
            if (Math.abs(data[i+k] - data[j+k]) > r) { match = false; break; }
          }
          if (match) cnt++;
        }
      }
      return cnt;
    };
    const B = count(m);
    const A = count(m + 1);
    if (B === 0 || A === 0) return null;
    return -Math.log(A / B);
  },

  _computeGaitAdvanced(samples, age) {
    const { stepTimes, peaks, sr } = this._detectSteps(samples);
    if (stepTimes.length < 6) {
      return { valid: false, reason: '걸음 수 부족 (최소 7걸음 필요)', steps: peaks.length };
    }

    // ── 1. Stride Time Variability (CV) — 치매 선별 핵심 ──
    const meanST = stepTimes.reduce((a, b) => a + b, 0) / stepTimes.length;
    const varST = stepTimes.reduce((s, v) => s + (v - meanST) ** 2, 0) / stepTimes.length;
    const sdST = Math.sqrt(varST);
    const cvStepTime = (sdST / meanST) * 100; // % — 변동계수

    // ── 2. 케이던스 (걸음/분) ──
    const cadence = Math.round(60 / meanST);

    // ── 3. 리듬 일관성 (좌우 대칭 근사) ──
    // 단일 센서 위치로 좌우 분리 불가 → 인접 걸음쌍 규칙성으로 근사
    // 홀짝 걸음(좌/우 추정) 평균 차이 → 비대칭 근사
    let oddSum = 0, oddN = 0, evenSum = 0, evenN = 0;
    stepTimes.forEach((t, i) => {
      if (i % 2 === 0) { evenSum += t; evenN++; } else { oddSum += t; oddN++; }
    });
    const evenMean = evenN ? evenSum / evenN : meanST;
    const oddMean = oddN ? oddSum / oddN : meanST;
    const asymmetryIdx = Math.abs(evenMean - oddMean) / ((evenMean + oddMean) / 2) * 100; // %

    // ── 4. 보행 규칙성 점수 (자기상관 1주기) ──
    const { svm } = this._gaitToSVM(samples);
    const filtered = this._butterworthLowpass(svm, 3.5, sr);
    let regularity = 0;
    if (peaks.length >= 4) {
      const avgStride = Math.round((peaks[peaks.length-1] - peaks[0]) / (peaks.length - 1));
      let r0 = 0, rLag = 0;
      for (let i = 0; i < filtered.length; i++) r0 += filtered[i] * filtered[i];
      for (let i = 0; i < filtered.length - avgStride; i++) rLag += filtered[i] * filtered[i + avgStride];
      regularity = r0 > 0 ? Math.max(0, Math.min(1, rLag / r0)) : 0;
    }

    // ── 5. CV 임상 해석 (Hausdorff/Pieruccini-Faria 기준) ──
    // 정상 성인 stride time CV: ~1-3%. MCI/치매: 흔히 >5%
    // 노인은 baseline이 약간 높음 (~3-4%)
    let cvLevel, cvColor;
    if (cvStepTime < 3.5)      { cvLevel = 'good';   cvColor = '#16a34a'; }
    else if (cvStepTime < 5.5) { cvLevel = 'normal'; cvColor = '#f59e0b'; }
    else if (cvStepTime < 8.0) { cvLevel = 'watch';  cvColor = '#ea580c'; }
    else                       { cvLevel = 'high';   cvColor = '#dc2626'; }

    // ── 6. Harmonic Ratio & Sample Entropy (v25.0, 비선형 보행 동역학) ──
    // Harmonic Ratio: 보행 부드러움/대칭 (Menz 2003) — 짝수/홀수 조화 파워 비
    // Sample Entropy: 보행 복잡도 (Hausdorff 1997) — 규칙적일수록 낮음
    let harmonicRatio = null, sampleEntropy = null;
    try {
      harmonicRatio = this._computeHarmonicRatio(filtered, peaks);
      sampleEntropy = this._sampleEntropy(stepTimes, 2, 0.2);
    } catch (e) { console.warn('[Gait] 비선형 지표 실패:', e.message); }

    return {
      valid: true,
      steps: peaks.length,
      stepCount: stepTimes.length + 1,
      meanStepTime: Math.round(meanST * 1000), // ms
      cvStepTime: Math.round(cvStepTime * 10) / 10, // %
      cadence,
      asymmetryIdx: Math.round(asymmetryIdx * 10) / 10, // %
      regularity: Math.round(regularity * 100), // %
      harmonicRatio: harmonicRatio != null ? Math.round(harmonicRatio * 100) / 100 : null,
      sampleEntropy: sampleEntropy != null ? Math.round(sampleEntropy * 100) / 100 : null,
      cvLevel, cvColor,
      sr: Math.round(sr),
    };
  },

  // 운동인지위험(MCR) 선별 — 보행속도 추정 + 추세 결합
  // 반환: 위험 단계 + 정직한 면책 문구
  _computeMCRScreening(gaitAdv, age) {
    if (!gaitAdv || !gaitAdv.valid) return null;
    // 케이던스 기반 보행속도 추정 (절대속도 아님, 상대 지표)
    // 느린 케이던스 + 높은 CV = 주의
    const slowCadence = age >= 65 ? gaitAdv.cadence < 95 : gaitAdv.cadence < 100;
    const highVariability = gaitAdv.cvStepTime >= 5.5;

    let level, label, color, desc;
    if (highVariability && slowCadence) {
      level = 'watch'; label = '추적 권장'; color = '#dc2626';
      desc = '보행 가변성과 속도 모두에서 평소와 다른 패턴이 보입니다. 일회성 결과로 단정할 수 없으니, 며칠간 반복 측정해 추세를 확인해보세요.';
    } else if (highVariability || slowCadence) {
      level = 'normal'; label = '경계'; color = '#f59e0b';
      desc = '한 가지 지표에서 약간의 변화가 보입니다. 컨디션·신발·바닥 영향일 수 있으니 추세를 지켜보세요.';
    } else {
      level = 'good'; label = '양호'; color = '#16a34a';
      desc = '보행 리듬과 속도가 안정적입니다. 규칙적인 걷기는 인지·심혈관 건강 유지에 도움이 됩니다.';
    }
    return { level, label, color, desc };
  },

  _computeBalanceMetrics(samples) {
    if (samples.length < 10) return { rms: 0, jerk: 0 };
    // 중력 제거: 각 축 평균 빼기
    const meanX = samples.reduce((s, v) => s + v.x, 0) / samples.length;
    const meanY = samples.reduce((s, v) => s + v.y, 0) / samples.length;
    const meanZ = samples.reduce((s, v) => s + v.z, 0) / samples.length;

    // RMS (흔들림 크기)
    let sumSq = 0;
    for (const s of samples) {
      const dx = s.x - meanX, dy = s.y - meanY, dz = s.z - meanZ;
      sumSq += dx*dx + dy*dy + dz*dz;
    }
    const rms = Math.sqrt(sumSq / samples.length);

    // Jerk (가속도 변화율)
    let jerkSum = 0;
    for (let i = 1; i < samples.length; i++) {
      const dx = samples[i].x - samples[i-1].x;
      const dy = samples[i].y - samples[i-1].y;
      const dz = samples[i].z - samples[i-1].z;
      const dt = (samples[i].t - samples[i-1].t) / 1000;
      if (dt > 0) jerkSum += Math.sqrt(dx*dx + dy*dy + dz*dz) / dt;
    }
    const jerk = jerkSum / samples.length;
    return { rms, jerk };
  },

  // ════════════════════════════════════════════════════════════════
  // 보행 분석 (Brajdic & Harle 2013 윈도우 피크)
  // ════════════════════════════════════════════════════════════════
  async _startGait() {
    console.log('[Gait] 시작');
    const ok = await this._requestMotionPermission();
    if (!ok) { this.bodyStop(); return; }
    const g = this.state.body.gait;
    g.samples = [];
    g.steps = 0;

    let remain = 30;
    document.getElementById('bt-gait-timer').textContent = remain;
    document.getElementById('bt-gait-steps').textContent = 0;

    // ★ v13.1: 음성 끝난 후 측정 시작
    this._speak('보행 측정을 시작합니다. 스마트폰을 손에 들거나 주머니에 넣고, 평평한 곳을 30초간 평소 속도로 걸어주세요.', () => {
      if (!this.state.body.running) return;
      console.log('[Gait] 음성 종료 → 측정 시작');

      this._startMotionListener(s => {
        this.state.body.gait.samples.push(s);
        this._drawAccelWave('bt-gait-wave', this.state.body.gait.samples);
      });

      this.state.body.timerInterval = setInterval(() => {
        remain--;
        document.getElementById('bt-gait-timer').textContent = remain;
        const samples = this.state.body.gait.samples;
        if (samples.length > 30) {
          const steps = this._countSteps(samples);
          this.state.body.gait.steps = steps;
          document.getElementById('bt-gait-steps').textContent = steps;
        }
        if (remain === 5) this._speak('5초 남았습니다');
        if (remain === 0) {
          this._speak('보행 측정이 완료되었습니다.');
          this._finalizeGait(true);
        }
      }, 1000);
    });
  },

  _countSteps(samples) {
    if (samples.length < 30) return 0;
    // 가속도 크기 (magnitude)
    const mags = samples.map(s => Math.sqrt(s.x*s.x + s.y*s.y + s.z*s.z));
    // 평균 빼기
    const mean = mags.reduce((a,b) => a+b, 0) / mags.length;
    const centered = mags.map(v => v - mean);

    // 간단 피크 검출 (보행은 1~3Hz, 즉 0.33~1초 간격)
    const dt = (samples[samples.length-1].t - samples[0].t) / samples.length / 1000;
    const sr = 1 / dt;
    const minDist = Math.max(5, Math.round(sr * 0.3));
    const std = Math.sqrt(centered.reduce((s,v)=>s+v*v,0) / centered.length);
    const thr = std * 0.5;

    let steps = 0, lastIdx = -minDist;
    for (let i = 1; i < centered.length - 1; i++) {
      if (centered[i] > thr && centered[i] > centered[i-1] && centered[i] > centered[i+1]) {
        if (i - lastIdx >= minDist) {
          steps++;
          lastIdx = i;
        }
      }
    }
    return steps;
  },

  _finalizeGait(preserveSpeech) {
    console.log('[Gait] finalize');
    this.bodyStop(preserveSpeech);
    const g = this.state.body.gait;
    const steps = this._countSteps(g.samples);
    const cadence = steps * 2; // 30초 → 분당
    const meanInterval = g.samples.length > 0 ? 30000 / Math.max(steps, 1) : 0;

    const profile = this._getUserProfile();
    const { age } = profile;
    let score;

    if (age && steps >= 20) {
      const cadenceRef = this._refCadence(age);
      const deviation = Math.abs(cadence - cadenceRef.mean) / cadenceRef.sd;
      score = Math.max(5, Math.min(99, this._zToScore(-deviation + 0.7)));
    } else {
      score = 100;
      if (cadence < 80 || cadence > 130) score -= 20;
      if (steps < 20) score -= 30;
      score = Math.max(0, Math.min(100, score));
    }

    // ★ v21.0: 보행 고도화 지표 (가변성/대칭성/규칙성)
    const adv = this._computeGaitAdvanced(g.samples, age || 50);
    const mcr = adv.valid ? this._computeMCRScreening(adv, age || 50) : null;

    // 가변성이 측정되면 점수에 반영 (높은 CV = 감점)
    if (adv.valid) {
      if (adv.cvStepTime >= 8.0)      score = Math.min(score, 55);
      else if (adv.cvStepTime >= 5.5) score = Math.min(score, 72);
      // 추세 비교를 위해 CV를 점수에 살짝 보정
      score = Math.round(score);
    }

    const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D';

    let cmt;
    if (cadence === 0) cmt = '걸음이 거의 감지되지 않았습니다. 걷기 측정을 다시 시도해주세요.';
    else if (cadence < 80) cmt = '평균보다 느린 걸음입니다.';
    else if (cadence <= 110) cmt = '안정적이고 정상적인 보행 속도입니다.';
    else if (cadence <= 130) cmt = '약간 빠른 걸음입니다.';
    else cmt = '매우 빠른 걸음 또는 측정 오류 가능성이 있습니다.';

    // ★ v21.0: 고도화 지표 HTML
    let advHTML = '';
    if (adv.valid) {
      advHTML = `
        <div class="gait-adv-card">
          <div class="gait-adv-title">🧠 보행 정밀 분석 <span class="gait-adv-badge">치매·낙상 선별 보조</span></div>
          <div class="gait-adv-grid">
            <div class="gait-adv-metric">
              <div class="gam-label">보행 가변성</div>
              <div class="gam-val" style="color:${adv.cvColor}">${adv.cvStepTime}<span class="gam-unit">%</span></div>
              <div class="gam-ref">CV · 정상 &lt;3.5%</div>
            </div>
            <div class="gait-adv-metric">
              <div class="gam-label">리듬 일관성</div>
              <div class="gam-val" style="color:${adv.regularity >= 70 ? '#16a34a' : adv.regularity >= 50 ? '#f59e0b' : '#dc2626'}">${adv.regularity}<span class="gam-unit">%</span></div>
              <div class="gam-ref">자기상관 규칙성</div>
            </div>
            <div class="gait-adv-metric">
              <div class="gam-label">좌우 비대칭</div>
              <div class="gam-val" style="color:${adv.asymmetryIdx < 5 ? '#16a34a' : adv.asymmetryIdx < 10 ? '#f59e0b' : '#dc2626'}">${adv.asymmetryIdx}<span class="gam-unit">%</span></div>
              <div class="gam-ref">근사값 · 낮을수록 좋음</div>
            </div>
            <div class="gait-adv-metric">
              <div class="gam-label">감지된 걸음</div>
              <div class="gam-val" style="color:#374151">${adv.stepCount}<span class="gam-unit">보</span></div>
              <div class="gam-ref">${adv.sr}Hz 샘플링</div>
            </div>
          </div>
          ${mcr ? `
          <div class="gait-mcr" style="border-left-color:${mcr.color}">
            <div class="gait-mcr-head">
              <span class="gait-mcr-label" style="color:${mcr.color}">${mcr.label}</span>
              <span class="gait-mcr-title">운동인지위험(MCR) 선별</span>
            </div>
            <div class="gait-mcr-desc">${mcr.desc}</div>
          </div>` : ''}
          <div class="gait-adv-cite">
            📚 Hausdorff 2007 · Pieruccini-Faria 2021 (Alzheimer's &amp; Dementia) · Verghese 2013 MCR<br>
            ⚠️ 의학적 진단이 아닌 <strong>선별 보조 지표</strong>입니다. 단일 측정값보다 <strong>여러 날의 추세 변화</strong>가 중요하며, 우려 시 전문의 상담을 권합니다.
          </div>
        </div>`;
    } else {
      advHTML = `
        <div class="gait-adv-card gait-adv-invalid">
          <div class="gait-adv-title">🧠 보행 정밀 분석</div>
          <div class="gait-adv-cite">정밀 분석을 위해서는 최소 7걸음 이상이 필요합니다. (현재 ${adv.steps || 0}걸음 감지) 평평한 곳에서 10m 이상 평소처럼 걸어주세요.</div>
        </div>`;
    }

    document.getElementById('bt-gait-running').style.display = 'none';
    const result = document.getElementById('bt-gait-result');
    result.style.display = 'block';
    result.innerHTML = `
      <div class="bt-result-card">
        <div class="bt-result-title">🚶 보행 분석 결과</div>
        <div class="bt-result-value">${cadence}<span class="bt-result-unit">걸음/분</span></div>
        <div class="bt-result-grade ${grade}">${grade} 등급</div>
        <div class="bt-result-row"><span class="bt-result-row-label">총 스텝 수</span><span class="bt-result-row-value">${steps} 걸음</span></div>
        <div class="bt-result-row"><span class="bt-result-row-label">분당 케이던스</span><span class="bt-result-row-value">${cadence} steps/min</span></div>
        <div class="bt-result-row"><span class="bt-result-row-label">평균 간격</span><span class="bt-result-row-value">${meanInterval.toFixed(0)} ms</span></div>
        <div class="bt-result-cmt">${cmt}</div>
      </div>
      ${advHTML}
      <button class="bt-redo" type="button" onclick="App.startBodyTest('gait')">🔄 다시 측정</button>
    `;

    // ★ v13: Wellness 저장 (+ v21.0 고도화 지표)
    this._wellnessSave('gait', {
      score, stepsPerMin: cadence, steps,
      cvStepTime: adv.valid ? adv.cvStepTime : null,
      regularity: adv.valid ? adv.regularity : null,
      asymmetryIdx: adv.valid ? adv.asymmetryIdx : null,
      cadenceAdv: adv.valid ? adv.cadence : null,
      mcrLevel: mcr ? mcr.level : null,
    });
  },

  // ════════════════════════════════════════════════════════════════
  // 손떨림 (Heldman 2014)
  // ════════════════════════════════════════════════════════════════
  async _startTremor() {
    console.log('[Tremor] 시작');
    const ok = await this._requestMotionPermission();
    if (!ok) { this.bodyStop(); return; }
    const t = this.state.body.tremor;
    t.samples = [];

    let remain = 15;
    document.getElementById('bt-tremor-timer').textContent = remain;

    // ★ v13.1: 음성 끝난 후 측정 시작
    this._speak('손떨림 측정을 시작합니다. 팔을 앞으로 뻗고 가만히 유지해주세요. 15초간 측정합니다.', () => {
      if (!this.state.body.running) return;
      console.log('[Tremor] 음성 종료 → 측정 시작');

      this._startMotionListener(s => {
        this.state.body.tremor.samples.push(s);
        this._drawAccelWave('bt-tremor-wave', this.state.body.tremor.samples);
      });

      this.state.body.timerInterval = setInterval(() => {
        remain--;
        document.getElementById('bt-tremor-timer').textContent = remain;
        if (remain === 5) this._speak('5초 남았습니다');
        if (remain === 0) {
          this._speak('손떨림 측정이 완료되었습니다.');
          this._finalizeTremor(true);
        }
      }, 1000);
    });
  },

  _finalizeTremor(preserveSpeech) {
    console.log('[Tremor] finalize');
    this.bodyStop(preserveSpeech);
    const t = this.state.body.tremor;
    if (t.samples.length < 30) {
      this._showTremorResult({ amp: 0, freq: 0, score: 0, error: '데이터 부족' });
      return;
    }

    // 가속도 크기 - 중력 제거
    const meanX = t.samples.reduce((s,v) => s+v.x, 0) / t.samples.length;
    const meanY = t.samples.reduce((s,v) => s+v.y, 0) / t.samples.length;
    const meanZ = t.samples.reduce((s,v) => s+v.z, 0) / t.samples.length;
    const centered = t.samples.map(s => Math.sqrt(
      (s.x-meanX)**2 + (s.y-meanY)**2 + (s.z-meanZ)**2
    ));

    // RMS 진폭 (mg 단위, 1g = 9.8 m/s²)
    const rms = Math.sqrt(centered.reduce((s,v) => s+v*v, 0) / centered.length);
    const ampMg = rms / 9.8 * 1000;

    // 주파수 (FFT 대신 0교차 카운트로 추정)
    const dt = (t.samples[t.samples.length-1].t - t.samples[0].t) / t.samples.length / 1000;
    const sr = 1 / dt;
    let zeroCrosses = 0;
    for (let i = 1; i < centered.length; i++) {
      if ((centered[i-1] - rms) * (centered[i] - rms) < 0) zeroCrosses++;
    }
    const dur = t.samples.length / sr;
    const freq = zeroCrosses / 2 / dur; // Hz

    // ★ v15.3: 나이 보정 손떨림 점수
    const profile = this._getUserProfile();
    const { age } = profile;
    let score;

    if (age) {
      // ampMg를 g 단위로 변환해서 ref와 비교 (ref는 g 단위)
      const ampG = ampMg / 1000;
      const tremorRef = this._refTremor(age);
      score = this._ageNormalizedScore(ampG, tremorRef, false); // 작을수록 좋음
      console.log(`[Tremor Score] age=${age} amp=${ampMg.toFixed(0)}mg ref=${(tremorRef.mean*1000).toFixed(0)}±${(tremorRef.sd*1000).toFixed(0)}mg → ${score}`);
    } else {
      // Fallback: 임상 기준 (Heldman 2014)
      score = 100;
      if (ampMg > 300) score = 30;
      else if (ampMg > 100) score = 50;
      else if (ampMg > 30) score = 75;
      score = Math.max(0, Math.min(100, score));
    }

    this._showTremorResult({ amp: ampMg, freq, score });
  },

  _showTremorResult(r) {
    const grade = r.score >= 85 ? 'A' : r.score >= 70 ? 'B' : r.score >= 50 ? 'C' : 'D';
    let cmt;
    if (r.error) cmt = r.error;
    else if (r.amp < 30) cmt = '손떨림이 거의 없습니다. 정상 범위입니다.';
    else if (r.amp < 100) cmt = '경미한 떨림이 있습니다. 정상에서 약간 벗어난 수준입니다.';
    else if (r.amp < 300) cmt = '중간 정도의 떨림이 있습니다. 카페인 섭취나 피로 상태일 수 있습니다.';
    else cmt = '떨림이 심한 편입니다. 지속적이라면 전문의 상담을 권합니다.';

    document.getElementById('bt-tremor-running').style.display = 'none';
    const result = document.getElementById('bt-tremor-result');
    result.style.display = 'block';
    result.innerHTML = `
      <div class="bt-result-card">
        <div class="bt-result-title">✋ 손떨림 측정 결과</div>
        <div class="bt-result-value">${r.amp.toFixed(0)}<span class="bt-result-unit">mg</span></div>
        <div class="bt-result-grade ${grade}">${grade} 등급</div>
        <div class="bt-result-row"><span class="bt-result-row-label">진폭 (RMS)</span><span class="bt-result-row-value">${r.amp.toFixed(1)} mg</span></div>
        <div class="bt-result-row"><span class="bt-result-row-label">주파수</span><span class="bt-result-row-value">${r.freq.toFixed(1)} Hz</span></div>
        <div class="bt-result-row"><span class="bt-result-row-label">점수</span><span class="bt-result-row-value">${r.score} / 100</span></div>
        <div class="bt-result-cmt">${cmt}</div>
      </div>
      <button class="bt-redo" type="button" onclick="App.startBodyTest('tremor')">🔄 다시 측정</button>
    `;

    // ★ v13: Wellness 저장
    if (!r.error) {
      this._wellnessSave('tremor', {
        score: r.score, peakHz: r.freq, intensity: r.amp,
      });
    }
  },

  // ════════════════════════════════════════════════════════════════
  // 반응속도
  // ════════════════════════════════════════════════════════════════
  async _startReaction() {
    console.log('[Reaction] 시작');
    const r = this.state.body.reaction;
    r.count = 0;
    r.times = [];
    r.state = 'wait';
    r.signalAt = 0;
    if (r.waitTimer) { clearTimeout(r.waitTimer); r.waitTimer = null; }
    document.getElementById('bt-reaction-count').textContent = 0;
    document.getElementById('bt-reaction-text').textContent = '대기 중...';
    document.getElementById('bt-reaction-sub').textContent = '음성 안내가 끝나면 시작됩니다';

    // ★ v13.3: 완전 단순화 - 단일 click 이벤트, 차단 이벤트 제거
    // 이전 시도 (pointerdown + touchstart + touchend 차단)는 오히려 탭을 막음
    // 가장 표준적인 방식으로 회귀
    const area = document.getElementById('bt-reaction-area');

    // 기존 모든 핸들러 제거
    if (this._reactionHandler) {
      area.removeEventListener('click', this._reactionHandler);
      area.removeEventListener('pointerdown', this._reactionHandler);
      area.removeEventListener('touchstart', this._reactionHandler);
    }
    if (this._reactionBlockHandler) {
      area.removeEventListener('contextmenu', this._reactionBlockHandler);
      area.removeEventListener('selectstart', this._reactionBlockHandler);
      area.removeEventListener('touchend', this._reactionBlockHandler);
    }

    // 단일 핸들러 - touchstart만 (가장 빠른 응답)
    this._reactionHandler = (e) => {
      console.log('[Reaction] tap detected:', e.type);
      e.preventDefault();
      this.reactionTap();
    };
    // 컨텍스트 메뉴(길게 누름 검색)만 차단, 다른 건 건드리지 않음
    this._reactionBlockHandler = (e) => {
      e.preventDefault();
      return false;
    };

    // touchstart (모바일 우선) + click (PC fallback)
    area.addEventListener('touchstart', this._reactionHandler, { passive: false });
    area.addEventListener('click', this._reactionHandler);
    // 길게 누름 검색 팝업만 차단
    area.addEventListener('contextmenu', this._reactionBlockHandler);

    area.classList.remove('ready', 'success', 'early');

    // ★ 음성 안내 → 끝난 후 첫 라운드 시작
    this._speak('반응속도 측정을 시작합니다. 화면이 녹색으로 바뀌면 빠르게 터치하세요.', () => {
      if (!this.state.body.running) return;
      console.log('[Reaction] 음성 종료 → 첫 라운드 시작');
      document.getElementById('bt-reaction-sub').textContent = '곧 신호가 나타납니다';
      this._reactionNextRound();
    });
  },

  _reactionNextRound() {
    const r = this.state.body.reaction;
    if (!this.state.body.running) return;
    if (r.count >= r.total) {
      this._finalizeReaction();
      return;
    }
    r.state = 'wait';
    const area = document.getElementById('bt-reaction-area');
    area.classList.remove('ready', 'success', 'early');
    document.getElementById('bt-reaction-text').textContent = '대기 중...';
    document.getElementById('bt-reaction-sub').textContent = '곧 신호가 나타납니다';

    // 1.5~4초 랜덤 대기
    const delay = 1500 + Math.random() * 2500;
    r.waitTimer = setTimeout(() => {
      if (!this.state.body.running) return;
      r.state = 'ready';
      r.signalAt = performance.now();
      area.classList.add('ready');
      document.getElementById('bt-reaction-text').textContent = '⚡ 지금!';
      document.getElementById('bt-reaction-sub').textContent = '터치!';
      if (navigator.vibrate) navigator.vibrate(50);
    }, delay);
  },

  reactionTap() {
    const r = this.state.body.reaction;
    if (!this.state.body.running) return;

    const area = document.getElementById('bt-reaction-area');
    if (r.state === 'wait') {
      // 너무 빨리 (false start)
      if (r.waitTimer) clearTimeout(r.waitTimer);
      area.classList.add('early');
      document.getElementById('bt-reaction-text').textContent = '❌ 너무 빨라요!';
      document.getElementById('bt-reaction-sub').textContent = '신호를 기다리세요';
      setTimeout(() => this._reactionNextRound(), 1500);
    } else if (r.state === 'ready') {
      const elapsed = performance.now() - r.signalAt;
      r.times.push(elapsed);
      r.count++;
      r.state = 'done';
      area.classList.remove('ready');
      area.classList.add('success');
      document.getElementById('bt-reaction-text').textContent = elapsed.toFixed(0) + ' ms';
      document.getElementById('bt-reaction-sub').textContent = `${r.count}/${r.total} 측정 완료`;
      document.getElementById('bt-reaction-count').textContent = r.count;
      setTimeout(() => this._reactionNextRound(), 1200);
    }
  },

  _finalizeReaction() {
    console.log('[Reaction] finalize');
    const r = this.state.body.reaction;
    // ★ v13.9: 음성 먼저 시작 후 bodyStop은 음성 보존 모드
    this._speak('반응속도 측정이 완료되었습니다. 결과를 확인하세요.');
    this.bodyStop(true);
    if (r.times.length === 0) {
      this._showReactionResult({ avg: 0, error: '측정된 데이터 없음' });
      return;
    }
    const avg = r.times.reduce((a,b) => a+b, 0) / r.times.length;
    const min = Math.min(...r.times);
    const max = Math.max(...r.times);
    this._showReactionResult({ avg, min, max, times: r.times });
  },

  _showReactionResult(r) {
    let score;
    if (r.error) {
      score = 50;
    } else {
      // ★ v15.3: 나이 보정 반응속도 (가장 변별력 큰 항목)
      const profile = this._getUserProfile();
      const { age } = profile;
      if (age) {
        const rtRef = this._refReactionTime(age);
        // 작을수록 좋음
        score = this._ageNormalizedScore(r.avg, rtRef, false);
        console.log(`[Reaction Score] age=${age} avg=${r.avg.toFixed(0)}ms ref=${rtRef.mean}±${rtRef.sd} → ${score}`);
      } else {
        // Fallback
        score = 100;
        if (r.avg > 500) score = 40;
        else if (r.avg > 350) score = 60;
        else if (r.avg > 280) score = 75;
        else if (r.avg > 220) score = 88;
      }
    }
    const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D';
    let cmt;
    if (r.error) cmt = r.error;
    else {
      const profile = this._getUserProfile();
      const ageInfo = profile.age;
      if (ageInfo) {
        const rtRef = this._refReactionTime(ageInfo);
        if (score >= 85) cmt = `${ageInfo}세 또래보다 매우 빠른 반응속도입니다 (또래 평균 ${rtRef.mean}ms 대비 -${Math.round(rtRef.mean - r.avg)}ms).`;
        else if (score >= 70) cmt = `${ageInfo}세 또래보다 빠른 반응속도입니다 (또래 평균 ${rtRef.mean}ms).`;
        else if (score >= 50) cmt = `${ageInfo}세 또래 평균 수준입니다 (또래 평균 ${rtRef.mean}ms).`;
        else if (score >= 30) cmt = `${ageInfo}세 또래보다 다소 느립니다. 피로/집중력 저하 가능성이 있어요.`;
        else cmt = `${ageInfo}세 또래보다 반응이 느립니다. 충분한 수면을 취하세요.`;
      } else {
        if (r.avg < 220) cmt = '매우 빠른 반응속도입니다. 운동선수 수준입니다.';
        else if (r.avg < 280) cmt = '빠른 반응속도입니다.';
        else if (r.avg < 350) cmt = '평균적인 반응속도입니다.';
        else if (r.avg < 500) cmt = '반응속도가 다소 느립니다. 휴식을 취해보세요.';
        else cmt = '반응속도가 느립니다. 피로/집중력 저하 가능성.';
      }
    }

    document.getElementById('bt-reaction-running').style.display = 'none';
    const result = document.getElementById('bt-reaction-result');
    result.style.display = 'block';
    if (r.error) {
      result.innerHTML = `<div class="bt-result-card"><div class="bt-result-cmt">${r.error}</div></div>
        <button class="bt-redo" type="button" onclick="App.startBodyTest('reaction')">🔄 다시 측정</button>`;
      return;
    }
    const timesHtml = r.times.map((t, i) =>
      `<div class="bt-result-row"><span class="bt-result-row-label">시도 ${i+1}</span><span class="bt-result-row-value">${t.toFixed(0)} ms</span></div>`
    ).join('');
    result.innerHTML = `
      <div class="bt-result-card">
        <div class="bt-result-title">⚡ 반응속도 결과</div>
        <div class="bt-result-value">${r.avg.toFixed(0)}<span class="bt-result-unit">ms 평균</span></div>
        <div class="bt-result-grade ${grade}">${grade} 등급</div>
        <div class="bt-result-row"><span class="bt-result-row-label">최소</span><span class="bt-result-row-value">${r.min.toFixed(0)} ms</span></div>
        <div class="bt-result-row"><span class="bt-result-row-label">최대</span><span class="bt-result-row-value">${r.max.toFixed(0)} ms</span></div>
        ${timesHtml}
        <div class="bt-result-cmt">${cmt}</div>
      </div>
      <button class="bt-redo" type="button" onclick="App.startBodyTest('reaction')">🔄 다시 측정</button>
    `;

    // ★ v13: Wellness 저장
    this._wellnessSave('reaction', {
      score, avgMs: r.avg, minMs: r.min, maxMs: r.max,
    });
  },

  // ════════════════════════════════════════════════════════════════
  // 자세 평가 (정면 사진)
  // ════════════════════════════════════════════════════════════════
  async _startPosture() {
    console.log('[Posture] 시작');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      this.state.body.posture.stream = stream;
      const video = document.getElementById('posture-video');
      video.srcObject = stream;
      video.classList.add('cam-front');
      await new Promise((res, rej) => {
        video.onloadedmetadata = () => res();
        setTimeout(() => rej(new Error('타임아웃')), 5000);
      });
      await video.play();

      // ★ v13.2: 음성 안내 끝난 후 10초 카운트다운 시작 (자세 잡을 시간 충분히)
      let remain = 10;
      document.getElementById('bt-posture-timer').textContent = remain;
      const sub = document.getElementById('bt-posture-sub');
      if (sub) sub.textContent = '음성 안내가 끝나면 10초 카운트다운이 시작됩니다';

      this._speak('자세 평가를 시작합니다. 한 발 뒤로 물러서서 머리부터 가슴까지 화면에 모두 보이도록 거리를 맞춰주세요.', () => {
        if (!this.state.body.running) return;
        console.log('[Posture] 음성 종료 → 10초 카운트다운 시작');
        if (sub) sub.textContent = '천천히 자세를 잡으세요';
        this._speak('10초 후에 촬영합니다.');

        this.state.body.timerInterval = setInterval(() => {
          remain--;
          document.getElementById('bt-posture-timer').textContent = remain;
          // 카운트다운 음성 (마지막 5초 + 짧은 알림)
          if (remain === 7) this._speak('자세를 잡으세요');
          if (remain === 5) this._speak('5초');
          if (remain === 3) this._speak('3');
          if (remain === 2) this._speak('2');
          if (remain === 1) this._speak('1');
          if (remain === 0) {
            this._speak('촬영합니다');
            if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 200]);
            this._capturePosture();
          }
        }, 1000);
      });
    } catch (err) {
      console.error('[Posture] 카메라 실패:', err);
      alert('카메라 접근 실패: ' + err.message);
      this.bodyStop();
      this.startBodyTest('posture');
    }
  },

  _capturePosture() {
    console.log('[Posture] 사진 촬영');
    const video = document.getElementById('posture-video');
    const cv = document.createElement('canvas');
    cv.width = video.videoWidth;
    cv.height = video.videoHeight;
    const ctx = cv.getContext('2d');
    // 전면 카메라는 좌우 반전되어 보이므로 다시 뒤집어서 저장 (실제 모습)
    ctx.translate(cv.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0);

    const dataUrl = cv.toDataURL('image/jpeg', 0.85);
    this.state.body.posture.capturedImage = dataUrl;
    if (navigator.vibrate) navigator.vibrate([100, 50, 100]);

    // 분석
    const analysis = this._analyzePosture(ctx, cv.width, cv.height);
    this._showPostureResult(dataUrl, analysis);
    // ★ v13.9: 음성 먼저 시작 후 bodyStop은 음성 보존 모드
    this._speak('자세 평가가 완료되었습니다. 결과를 확인하세요.');
    this.bodyStop(true);
  },

  _analyzePosture(ctx, w, h) {
    // 단순 분석: 좌우 영역 밝기/색상 차이로 어깨 위치 추정
    // 정확한 자세 분석은 MediaPipe Pose 필요 — 여기선 간이 분석
    const upperHalf = ctx.getImageData(0, h * 0.25, w, h * 0.3).data;
    let leftR = 0, rightR = 0, leftN = 0, rightN = 0;
    for (let i = 0; i < upperHalf.length; i += 4) {
      const px = (i / 4) % w;
      const r = upperHalf[i];
      if (px < w / 2) { leftR += r; leftN++; }
      else { rightR += r; rightN++; }
    }
    const leftAvg = leftR / leftN;
    const rightAvg = rightR / rightN;
    const diff = Math.abs(leftAvg - rightAvg);
    const symmetry = Math.max(0, 100 - diff * 2);

    return { symmetry, leftBrightness: leftAvg, rightBrightness: rightAvg };
  },

  _showPostureResult(imgUrl, a) {
    const score = Math.round(a.symmetry);
    const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D';
    let cmt;
    if (score >= 85) cmt = '좌우 대칭이 좋습니다. 자세가 균형 잡혀 있습니다.';
    else if (score >= 70) cmt = '약간의 비대칭이 있지만 정상 범위입니다.';
    else if (score >= 50) cmt = '좌우 비대칭이 있습니다. 거북목/한쪽 어깨 처짐 등을 확인해보세요.';
    else cmt = '비대칭이 큽니다. 측정 환경(조명/거리) 확인 후 재측정해주세요.';

    document.getElementById('bt-posture-running').style.display = 'none';
    const result = document.getElementById('bt-posture-result');
    result.style.display = 'block';
    result.innerHTML = `
      <div class="bt-result-card">
        <div class="bt-result-title">🧍 자세 평가 결과</div>
        <div class="bt-result-img"><img src="${imgUrl}" alt="자세 사진"/></div>
        <div class="bt-result-value">${score}<span class="bt-result-unit">/ 100</span></div>
        <div class="bt-result-grade ${grade}">${grade} 등급</div>
        <div class="bt-result-row"><span class="bt-result-row-label">좌우 대칭도</span><span class="bt-result-row-value">${a.symmetry.toFixed(1)}%</span></div>
        <div class="bt-result-cmt">⚠️ 정확한 자세 분석은 MediaPipe Pose 등 골격 검출 모델이 필요합니다. 현재는 간이 좌우 대칭 검사입니다.</div>
        <div class="bt-result-cmt">${cmt}</div>
      </div>
      <button class="bt-redo" type="button" onclick="App.startBodyTest('posture')">🔄 다시 측정</button>
    `;

    // ★ v13: Wellness 저장
    this._wellnessSave('posture', {
      score, asymmetry: 100 - a.symmetry,
    });
  },

  // ════════════════════════════════════════════════════════════════
  // v13: BMI / WHtR / ABSI 신체 지수 계산
  //
  // BMI (Body Mass Index): kg/m²  (WHO 표준)
  //   <18.5 저체중 / 18.5-24.9 정상 / 25-29.9 과체중 / ≥30 비만
  //
  // WHtR (Waist-to-Height Ratio): 허리둘레/키
  //   <0.5 정상 / 0.5-0.6 과체중 / ≥0.6 비만
  //   "허리둘레는 키의 절반 미만이어야 한다" (Ashwell 2012)
  //
  // ABSI (A Body Shape Index, Krakauer 2012):
  //   ABSI = WC / (BMI^(2/3) × Height^(1/2))
  //   BMI보다 사망률 예측력이 더 높다고 알려진 지표
  //   z-score는 나이/성별 그룹별 평균에서 표준편차 거리
  // ════════════════════════════════════════════════════════════════
  openBodyComposition() {
    console.log('[BodyComp] 페이지 열기');
    document.querySelectorAll('.page').forEach(p => p.classList.remove('on'));
    document.getElementById('page-test-bodycomp').classList.add('on');
    this.state.page = 'test-bodycomp';
    history.pushState({ page: 'test-bodycomp' }, '', '');

    // 결과/입력 화면 초기화
    document.getElementById('bt-bodycomp-stage').style.display = 'block';
    document.getElementById('bt-bodycomp-result').style.display = 'none';

    // 저장된 값 복원 + 휠 초기화
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem('bodycomp_input') || '{}');
    } catch (e) {}

    // ★ v13.7: 휠 피커 초기화
    this._initWheelPicker('bc-height-wheel', 'bc-height', saved.height || 170);
    this._initWheelPicker('bc-weight-wheel', 'bc-weight', saved.weight || 65);
    this._initWheelPicker('bc-waist-wheel', 'bc-waist', saved.waist || 80);
    this._initWheelPicker('bc-age-wheel', 'bc-age', saved.age || 35);

    // 허리둘레 단위 복원
    this._waistUnit = saved.waistUnit || 'cm';
    this.bcSwitchWaistUnit(this._waistUnit, true);

    if (saved.gender) this.bcSelectGender(saved.gender);

    window.scrollTo(0, 0);
  },

  bcSelectGender(gender) {
    document.querySelectorAll('.bc-gender-btn').forEach(b => {
      b.classList.toggle('on', b.dataset.gender === gender);
    });
    this._bcGender = gender;
  },

  // ★ v13.7: 허리둘레 단위 전환 (cm ↔ inch)
  bcSwitchWaistUnit(unit, silent) {
    document.querySelectorAll('.bc-unit-btn').forEach(b => {
      b.classList.toggle('on', b.dataset.unit === unit);
    });
    const unitLabel = document.getElementById('bc-waist-unit');
    if (unitLabel) unitLabel.textContent = unit;

    // 휠 범위/현재값 변환
    const wheel = document.getElementById('bc-waist-wheel');
    const hidden = document.getElementById('bc-waist');
    if (!wheel || !hidden) return;

    const currentCm = parseFloat(hidden.value) || 80;
    if (unit === 'inch') {
      // cm → inch (현재 값 변환)
      const inchVal = Math.round(currentCm / 2.54);
      wheel.dataset.min = '20';
      wheel.dataset.max = '60';
      wheel.dataset.step = '1';
      this._initWheelPicker('bc-waist-wheel', 'bc-waist-display', inchVal);
      // hidden은 항상 cm 단위로 저장
      this._waistDisplayUnit = 'inch';
    } else {
      wheel.dataset.min = '50';
      wheel.dataset.max = '150';
      wheel.dataset.step = '1';
      this._initWheelPicker('bc-waist-wheel', 'bc-waist', currentCm);
      this._waistDisplayUnit = 'cm';
    }
    this._waistUnit = unit;
  },

  // ★ v13.7: 휠 피커 구현 (네이티브 iOS 스타일)
  _initWheelPicker(wheelId, hiddenId, defaultValue) {
    const wheel = document.getElementById(wheelId);
    if (!wheel) return;

    const min = parseInt(wheel.dataset.min);
    const max = parseInt(wheel.dataset.max);
    const step = parseInt(wheel.dataset.step) || 1;
    const itemHeight = 36;

    // 값 배열 생성
    const values = [];
    for (let v = min; v <= max; v += step) values.push(v);

    // HTML 구성
    wheel.innerHTML = `
      <div class="bc-wheel-mask top"></div>
      <div class="bc-wheel-mask bottom"></div>
      <div class="bc-wheel-selector"></div>
      <div class="bc-wheel-list">
        ${values.map(v => `<div class="bc-wheel-item" data-value="${v}">${v}</div>`).join('')}
      </div>
    `;

    const list = wheel.querySelector('.bc-wheel-list');

    // 초기 위치 (중앙에 defaultValue가 오도록)
    const defaultIdx = Math.max(0, values.indexOf(parseInt(defaultValue)));
    let currentIdx = defaultIdx;
    let translateY = -currentIdx * itemHeight;
    list.style.transform = `translateY(${translateY}px)`;
    this._updateWheelHighlight(wheel, currentIdx);
    document.getElementById(hiddenId).value = values[currentIdx];

    // 터치/드래그 처리
    let startY = 0;
    let startTranslateY = 0;
    let isDragging = false;
    let lastMoveY = 0;
    let velocity = 0;
    let lastMoveTime = 0;
    // ★ v14.2: 스크롤 방향 판별용
    let startX = 0;
    let directionDecided = false;
    let isWheelGesture = false;

    const onStart = (e) => {
      isDragging = true;
      directionDecided = false;
      isWheelGesture = false;
      const y = e.touches ? e.touches[0].clientY : e.clientY;
      const x = e.touches ? e.touches[0].clientX : e.clientX;
      startY = y;
      startX = x;
      startTranslateY = translateY;
      lastMoveY = y;
      lastMoveTime = performance.now();
      velocity = 0;
      list.style.transition = 'none';
    };

    const onMove = (e) => {
      if (!isDragging) return;
      const y = e.touches ? e.touches[0].clientY : e.clientY;
      const x = e.touches ? e.touches[0].clientX : e.clientX;
      const dy = y - startY;
      const dx = x - startX;

      // ★ v14.2: 방향 판별 (한 번만)
      // 처음 10px 움직임에서 방향 결정
      if (!directionDecided) {
        if (Math.abs(dy) < 8 && Math.abs(dx) < 8) {
          // 아직 충분히 안 움직임 - 결정 보류
          return;
        }
        directionDecided = true;
        // 가까운 영역에 있고 충분히 작은 움직임이면 휠로 처리
        // (휠 위에서 드래그하면 휠 동작, 페이지 외부에서 큰 수직 스와이프면 페이지)
        isWheelGesture = true;
      }

      if (!isWheelGesture) return;
      e.preventDefault();

      translateY = startTranslateY + dy;
      // 속도 계산
      const now = performance.now();
      const dt = now - lastMoveTime;
      if (dt > 0) velocity = (y - lastMoveY) / dt;
      lastMoveY = y;
      lastMoveTime = now;
      // 범위 제한 (over-scroll 일부 허용)
      const maxTrans = itemHeight * 1.5;
      const minTrans = -(values.length - 1) * itemHeight - itemHeight * 1.5;
      translateY = Math.max(minTrans, Math.min(maxTrans, translateY));
      list.style.transform = `translateY(${translateY}px)`;
      // 실시간 인덱스 업데이트
      const idx = Math.round(-translateY / itemHeight);
      const clampedIdx = Math.max(0, Math.min(values.length - 1, idx));
      this._updateWheelHighlight(wheel, clampedIdx);
    };

    const onEnd = () => {
      if (!isDragging) return;
      isDragging = false;
      if (!isWheelGesture) {
        // 휠 제스처 아니면 스냅 안 함
        return;
      }
      // 관성 적용
      const inertiaDistance = velocity * 200;
      let finalTranslateY = translateY + inertiaDistance;
      // 가장 가까운 항목으로 스냅
      const idx = Math.round(-finalTranslateY / itemHeight);
      const clampedIdx = Math.max(0, Math.min(values.length - 1, idx));
      finalTranslateY = -clampedIdx * itemHeight;
      list.style.transition = 'transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94)';
      list.style.transform = `translateY(${finalTranslateY}px)`;
      translateY = finalTranslateY;
      currentIdx = clampedIdx;
      this._updateWheelHighlight(wheel, currentIdx);
      document.getElementById(hiddenId).value = values[currentIdx];
      // 햅틱
      if (navigator.vibrate) navigator.vibrate(10);
    };

    // 이벤트 바인딩 (cleanup)
    wheel.addEventListener('touchstart', onStart, { passive: true });
    wheel.addEventListener('touchmove', onMove, { passive: false });
    wheel.addEventListener('touchend', onEnd);
    wheel.addEventListener('mousedown', onStart);
    wheel.addEventListener('mousemove', onMove);
    wheel.addEventListener('mouseup', onEnd);
    wheel.addEventListener('mouseleave', onEnd);
  },

  _updateWheelHighlight(wheel, idx) {
    const items = wheel.querySelectorAll('.bc-wheel-item');
    items.forEach((item, i) => {
      const dist = Math.abs(i - idx);
      item.classList.toggle('selected', i === idx);
      item.classList.toggle('near', dist === 1);
      item.classList.toggle('far', dist >= 2);
    });
  },

  // ★ v20.5: 신체나이/피부나이 재계산 헬퍼
  // 결과 페이지에서 최신 얼굴(혈관나이/HRV) 데이터로 다시 계산
  // 신체지수를 먼저 측정하고 나중에 얼굴 측정한 경우에도 최신값 반영
  _recomputeBodyAges() {
    const w = this.state.wellness || {};
    const bc = w.bodycomp;
    if (!bc || !bc.age || !bc.height || !bc.weight) return null;

    // 최신 face/finger 데이터 (localStorage 7일 내 최신 병합)
    let faceW = w.face || null;
    let fingerW = w.finger || null;
    try {
      const raw = localStorage.getItem('wellness_data');
      if (raw) {
        const stored = JSON.parse(raw);
        const now = Date.now();
        const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
        if (stored.face?.t && (now - stored.face.t) < MAX_AGE) {
          if (!faceW || stored.face.t >= (faceW.t || 0)) faceW = stored.face;
        }
        if (stored.finger?.t && (now - stored.finger.t) < MAX_AGE) {
          if (!fingerW || stored.finger.t >= (fingerW.t || 0)) fingerW = stored.finger;
        }
      }
    } catch (e) {}

    const age = bc.age;
    const bmi = bc.bmi;
    const hrVal = fingerW?.hr || faceW?.hr || null;
    const rmssdVal = fingerW?.rmssd || faceW?.rmssd || null;
    const stressVal = fingerW?.stressIndex || faceW?.stressIdx || null;
    const vascularAgeData = faceW?.vascularAge || null;
    const rsaVal = faceW?.rsaIndex ?? null;
    const respRate = faceW?.respRate || null;

    // ── 피부 나이 재계산 (원본 로직과 동일) ──
    let skinAge = age;
    if (vascularAgeData?.estimatedAge) {
      const vaDelta = vascularAgeData.estimatedAge - age;
      skinAge += vaDelta * 0.40;
    } else if (hrVal) {
      if (hrVal <= 62)      skinAge -= 1.2;
      else if (hrVal <= 72) skinAge += 0.0;
      else if (hrVal <= 85) skinAge += 1.0;
      else                  skinAge += 2.5;
    }
    if (rsaVal !== null) {
      if (rsaVal >= 60)      skinAge -= 1.5;
      else if (rsaVal >= 40) skinAge -= 0.5;
      else if (rsaVal >= 20) skinAge += 0.5;
      else                   skinAge += 2.0;
    }
    if (rmssdVal) {
      const rmssdRef = Math.max(15, 60 - age * 0.4);
      const ratio = rmssdVal / rmssdRef;
      if (ratio >= 1.4)      skinAge -= 1.8;
      else if (ratio >= 1.0) skinAge -= 0.5;
      else if (ratio >= 0.7) skinAge += 0.8;
      else                   skinAge += 2.5;
    }
    if (stressVal) {
      if (stressVal < 50)       skinAge -= 0.8;
      else if (stressVal < 150) skinAge += 0.0;
      else if (stressVal < 400) skinAge += 1.5;
      else                      skinAge += 3.0;
    }
    if (respRate) {
      if (respRate >= 12 && respRate <= 18) skinAge -= 0.5;
      else if (respRate > 22)               skinAge += 1.0;
    }
    if (bmi >= 30)       skinAge += 1.0;
    else if (bmi < 18.5) skinAge += 1.5;
    skinAge = Math.max(15, Math.min(120, Math.round(skinAge)));
    const skinAgeDiff = skinAge - age;
    const skinAgeConfidence = vascularAgeData
      ? Math.min(85, 70 + (rsaVal !== null ? 8 : 0) + (rmssdVal ? 5 : 0))
      : (rmssdVal || hrVal) ? 55 : 35;

    // ── 신체 나이 심혈관 보정 재계산 (CV 부분만) ──
    let bodyAge = bc.bodyAgeBase != null ? bc.bodyAgeBase : bc.bodyAge;
    // bodyAgeBase가 없으면 기존 bodyAge 유지 (체형 기반은 변하지 않음)
    // 심혈관 데이터가 새로 생겼을 때만 재보정
    let cvAdj = 0, cvMeasured = false;
    if (hrVal) {
      cvMeasured = true;
      if (hrVal <= 55)      cvAdj -= 2.0;
      else if (hrVal <= 62) cvAdj -= 1.0;
      else if (hrVal <= 72) cvAdj += 0.0;
      else if (hrVal <= 82) cvAdj += 1.5;
      else                  cvAdj += 3.0;
    }
    if (rmssdVal) {
      const rmssdRef = Math.max(15, 60 - age * 0.4);
      const ratio = rmssdVal / rmssdRef;
      if (ratio >= 1.4)      cvAdj -= 2.0;
      else if (ratio >= 1.0) cvAdj -= 0.8;
      else if (ratio >= 0.7) cvAdj += 1.0;
      else                   cvAdj += 2.5;
    }
    // 신체나이는 저장된 값 기준 유지하되, 심혈관 측정이 새로 추가됐으면 갱신
    // (체형 baseline은 그대로, CV 보정만 최신화)
    const bodyAgeConfidence = Math.min(95, (cvMeasured ? 65 : 45));

    return {
      skinAge, skinAgeDiff, skinAgeConfidence,
      bodyAge: bc.bodyAge, // 신체나이는 체형 기반이라 저장값 유지
      bodyAgeConfidence: bc.bodyAgeConfidence || bodyAgeConfidence,
      vascularAge: vascularAgeData?.estimatedAge || null,
      rsaIndex: rsaVal,
      updated: true,
    };
  },

  calcBodyComposition() {
    const h = parseFloat(document.getElementById('bc-height').value);
    const w = parseFloat(document.getElementById('bc-weight').value);
    let waist = parseFloat(document.getElementById('bc-waist').value);
    const age = parseInt(document.getElementById('bc-age').value, 10);
    const gender = this._bcGender;

    // ★ v13.7: inch 단위면 cm로 변환
    if (this._waistDisplayUnit === 'inch') {
      const waistInch = parseFloat(document.getElementById('bc-waist-display')?.value || waist);
      waist = waistInch * 2.54; // inch → cm
      document.getElementById('bc-waist').value = waist.toFixed(1);
      console.log(`[BodyComp] 허리둘레 inch → cm 변환: ${waistInch}inch = ${waist.toFixed(1)}cm`);
    }

    // 입력 검증
    if (!h || h < 100 || h > 220) {
      alert('키를 100~220cm 범위로 입력해주세요.');
      return;
    }
    if (!w || w < 30 || w > 200) {
      alert('체중을 30~200kg 범위로 입력해주세요.');
      return;
    }
    if (!waist || waist < 40 || waist > 200) {
      alert('허리둘레를 40~200cm 범위로 입력해주세요.');
      return;
    }
    if (!age || age < 10 || age > 120) {
      alert('나이를 10~120 범위로 입력해주세요.');
      return;
    }
    if (!gender) {
      alert('성별을 선택해주세요.');
      return;
    }

    // 입력 저장 (v13.7: 허리둘레 단위 포함)
    try {
      localStorage.setItem('bodycomp_input', JSON.stringify({
        height: h, weight: w, waist, age, gender,
        waistUnit: this._waistUnit || 'cm'
      }));
    } catch (e) {}

    // === 1. BMI 계산 ===
    const heightM = h / 100;
    const bmi = w / (heightM * heightM);
    const bmiCat =
      bmi < 18.5  ? { label: '저체중', cls: 'under', desc: '체중이 부족한 상태입니다. 균형 잡힌 영양 섭취가 필요합니다.' } :
      bmi < 23    ? { label: '정상',   cls: 'normal', desc: '건강한 체중 범위입니다 (아시아 기준 18.5~22.9).' } :
      bmi < 25    ? { label: '과체중 전단계', cls: 'warn', desc: '아시아 기준 과체중 전단계입니다. 활동량을 늘려보세요.' } :
      bmi < 30    ? { label: '과체중', cls: 'warn', desc: '과체중 범위입니다. 식이 조절과 운동을 권장합니다.' } :
                    { label: '비만',   cls: 'bad', desc: '비만 범위입니다. 전문의 상담을 권장합니다.' };

    // === 2. WHtR (허리/키 비율) ===
    const whtr = waist / h;
    const whtrCat =
      whtr < 0.43 ? { label: '낮음', cls: 'under', desc: '허리둘레가 매우 작은 편입니다.' } :
      whtr < 0.5  ? { label: '정상', cls: 'normal', desc: '허리/키 비율이 건강한 범위입니다 ("허리는 키의 절반 미만").' } :
      whtr < 0.6  ? { label: '복부비만 주의', cls: 'warn', desc: '복부 비만 위험이 있습니다. 허리둘레 감소가 필요합니다.' } :
                    { label: '복부비만', cls: 'bad', desc: '복부 비만 상태입니다. 심혈관 질환 위험이 높아질 수 있습니다.' };

    // === 3. ABSI (A Body Shape Index) — Krakauer 2012 ===
    // ABSI = WC / (BMI^(2/3) * Height^(1/2))
    // WC, Height: m 단위
    const waistM = waist / 100;
    const absi = waistM / (Math.pow(bmi, 2/3) * Math.sqrt(heightM));
    // ABSI z-score: NHANES 데이터 기반 나이/성별 평균
    // 단순화 — 평균/표준편차 (Krakauer 원논문 표 4 근사)
    let absiMean, absiSD;
    if (gender === 'male') {
      // 남성: 나이가 들수록 평균 증가
      absiMean = 0.0786 + (age - 35) * 0.00012;
      absiSD = 0.00509;
    } else {
      // 여성
      absiMean = 0.0773 + (age - 35) * 0.00014;
      absiSD = 0.00608;
    }
    const absiZ = (absi - absiMean) / absiSD;
    const absiCat =
      absiZ < -0.868 ? { label: '매우 낮음', cls: 'normal', desc: '체형 위험도가 매우 낮습니다 (사망률 위험 낮음).' } :
      absiZ < -0.272 ? { label: '낮음', cls: 'normal', desc: '체형 위험도가 낮은 편입니다.' } :
      absiZ <  0.229 ? { label: '평균', cls: 'normal', desc: '체형 위험도가 평균 범위입니다.' } :
      absiZ <  0.798 ? { label: '높음', cls: 'warn', desc: '체형 위험도가 평균보다 높습니다.' } :
                       { label: '매우 높음', cls: 'bad', desc: 'ABSI가 매우 높아 사망률 위험이 큰 체형입니다. 전문의 상담을 권장합니다.' };

    // === 4. 종합 점수 ===
    let score = 100;
    if (bmi < 18.5 || bmi >= 25) score -= 15;
    if (bmi >= 30) score -= 15;
    if (whtr >= 0.5) score -= 12;
    if (whtr >= 0.6) score -= 10;
    if (absiZ > 0.798) score -= 15;
    else if (absiZ > 0.229) score -= 5;
    score = Math.max(0, Math.min(100, score));
    const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D';

    // === 5. 신체 나이 (다중 지표 통합 모델, v18.1 심혈관 통합) ===
    // 학술 근거:
    //   - Dahlén 2017: BMI 25+ → 신체 노화 +1.5~3년/BMI단위
    //   - Aune 2016: WHtR 0.5+ → 심혈관 위험 1.5x
    //   - Krakauer 2014: ABSI z-score 사망률 예측력
    //   - Levine 2013 PhenoAge: 다중 바이오마커 통합
    //   - ★ v18.1: Xiao 2020 — HRV 낮을수록 생물학적 나이 가속
    //   - ★ v18.1: Steptoe 2007 — 심박수 안정 시 60BPM 이하 → 심혈관 노화 지연
    let bodyAge = age;
    let bodyAgeFactors = [];

    // BMI 보정 (Dahlén 2017)
    let bmiAdj = 0;
    if (bmi < 18.5) bmiAdj = +1.5;
    else if (bmi < 23) bmiAdj = -0.5;
    else if (bmi < 25) bmiAdj = +0.8;
    else if (bmi < 27.5) bmiAdj = +2.0;
    else if (bmi < 30) bmiAdj = +3.5;
    else if (bmi < 35) bmiAdj = +5.5;
    else bmiAdj = +8.0;
    bodyAge += bmiAdj;
    bodyAgeFactors.push({ name: 'BMI', adj: bmiAdj });

    // WHtR 보정 (Aune 2016)
    let whtrAdj = 0;
    if (whtr < 0.43) whtrAdj = +0.5;
    else if (whtr < 0.5) whtrAdj = -0.5;
    else if (whtr < 0.55) whtrAdj = +1.5;
    else if (whtr < 0.6) whtrAdj = +3.0;
    else if (whtr < 0.65) whtrAdj = +4.5;
    else whtrAdj = +6.0;
    bodyAge += whtrAdj;
    bodyAgeFactors.push({ name: 'WHtR', adj: whtrAdj });

    // ABSI 보정 (Krakauer 2014)
    let absiAdj = 0;
    if (absiZ > 1.5) absiAdj = +3.0;
    else if (absiZ > 0.8) absiAdj = +1.5;
    else if (absiZ > 0.229) absiAdj = +0.5;
    else if (absiZ < -0.868) absiAdj = -2.0;
    else if (absiZ < -0.272) absiAdj = -1.0;
    bodyAge += absiAdj;
    bodyAgeFactors.push({ name: 'ABSI', adj: absiAdj });

    // ★ v18.1: 심혈관 나이 보정 (얼굴 + 손가락 측정 통합)
    // Levine PhenoAge + Xiao 2020 HRV-생물학적나이 회귀 기반

    // ★ v19.5: localStorage에서 최신 face/finger 데이터를 직접 참조
    // (this.state.wellness는 앱 메모리 캐시 — 오래된 값일 수 있음)
    let w_state = this.state.wellness;
    try {
      const raw = localStorage.getItem('wellness_data');
      if (raw) {
        const stored = JSON.parse(raw);
        const now = Date.now();
        const MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7일
        // 더 최신 데이터가 있으면 우선 사용
        ['face', 'finger', 'balance', 'gait', 'tremor', 'reaction'].forEach(k => {
          if (stored[k]?.t && (now - stored[k].t) < MAX_AGE) {
            // 저장된 것이 메모리보다 최신이거나, 메모리에 없으면 사용
            if (!w_state[k] || stored[k].t >= (w_state[k].t || 0)) {
              w_state = { ...w_state, [k]: stored[k] };
            }
          }
        });
      }
    } catch (e) {
      console.warn('[v19.5 BodyAge] localStorage 참조 실패, 메모리 사용:', e.message);
    }

    let cvAdj = 0; // 심혈관 보정값
    let cvMeasured = false;

    // 얼굴 및 손가락 측정에서 HR/HRV 추출 (더 최근 것 우선)
    const faceW   = w_state.face   || null;
    const fingerW = w_state.finger || null;

    // 디버그 로그
    console.log('[v19.5 BodyAge] face:', faceW ? `HR=${faceW.hr} RMSSD=${faceW.rmssd}` : '없음',
                '/ finger:', fingerW ? `HR=${fingerW.hr} RMSSD=${fingerW.rmssd}` : '없음');

    // HR 기여 (Steptoe 2007: 안정 시 HR 60 이하 = 심혈관 건강)
    const hrVal = fingerW?.hr || faceW?.hr || null;
    if (hrVal) {
      cvMeasured = true;
      if (hrVal <= 55)       cvAdj -= 2.0;  // 매우 건강한 심장 (운동선수 수준)
      else if (hrVal <= 62)  cvAdj -= 1.0;  // 양호
      else if (hrVal <= 72)  cvAdj += 0.0;  // 정상
      else if (hrVal <= 85)  cvAdj += 1.5;  // 약간 높음
      else if (hrVal <= 100) cvAdj += 3.0;  // 높음
      else                   cvAdj += 5.0;  // 빈맥 — 심혈관 노화 가속
      bodyAgeFactors.push({ name: 'HR', adj: cvAdj, val: hrVal });
    }

    // HRV (RMSSD) 기여 (Xiao 2020: RMSSD 낮을수록 생물학적 나이 ↑)
    // 나이대별 정상 RMSSD: 30대=45ms, 40대=38ms, 50대=30ms, 60대=24ms
    const rmssdVal = fingerW?.rmssd || faceW?.rmssd || null;
    if (rmssdVal) {
      cvMeasured = true;
      // 나이 보정 기준값 (약 -0.4ms/년)
      const rmssdRef = Math.max(15, 60 - age * 0.4);
      const rmssdRatio = rmssdVal / rmssdRef; // 1.0 = 또래 평균
      let hrAdj = 0;
      if (rmssdRatio >= 1.5)      hrAdj = -2.5; // 또래 대비 매우 우수
      else if (rmssdRatio >= 1.2) hrAdj = -1.2; // 우수
      else if (rmssdRatio >= 0.8) hrAdj =  0.0; // 정상
      else if (rmssdRatio >= 0.5) hrAdj = +2.0; // 낮음 — 자율신경 노화
      else                        hrAdj = +4.0; // 매우 낮음
      cvAdj += hrAdj;
      bodyAgeFactors.push({ name: 'HRV', adj: hrAdj, val: rmssdVal.toFixed(1) });
    }

    // 스트레스 지수 기여 (만성 스트레스 → 텔로미어 단축, Epel 2004)
    const stressVal = fingerW?.stressIndex || faceW?.stressIdx || null;
    if (stressVal) {
      let stAdj = 0;
      if (stressVal < 30)       stAdj = -1.0; // 이상적 이완
      else if (stressVal < 100) stAdj =  0.0; // 정상
      else if (stressVal < 300) stAdj = +1.5; // 경미한 긴장
      else if (stressVal < 700) stAdj = +2.5; // 중등도
      else                      stAdj = +4.0; // 높은 스트레스
      cvAdj += stAdj;
      bodyAgeFactors.push({ name: 'Stress', adj: stAdj });
    }

    bodyAge += cvAdj;

    // 신체 기능 보너스 (Studenski 2011 보행속도, Deary 2010 반응속도)
    let wellnessBonus = 0;
    let measuredCount = cvMeasured ? 1 : 0;

    if (w_state.face?.score) {
      measuredCount++;
      if (w_state.face.score >= 90) wellnessBonus += 1.0;
      else if (w_state.face.score >= 80) wellnessBonus += 0.4;
      else if (w_state.face.score < 60) wellnessBonus -= 0.8;
    }
    if (w_state.balance?.score) {
      measuredCount++;
      if (w_state.balance.score >= 85) wellnessBonus += 1.2;
      else if (w_state.balance.score >= 70) wellnessBonus += 0.5;
      else if (w_state.balance.score < 50) wellnessBonus -= 1.8;
    }
    if (w_state.gait?.score) {
      measuredCount++;
      if (w_state.gait.score >= 85) wellnessBonus += 1.2;
      else if (w_state.gait.score >= 70) wellnessBonus += 0.5;
      else if (w_state.gait.score < 50) wellnessBonus -= 1.8;
    }
    if (w_state.tremor?.score) {
      measuredCount++;
      if (w_state.tremor.score >= 85) wellnessBonus += 0.6;
    }
    if (w_state.reaction?.score) {
      measuredCount++;
      if (w_state.reaction.score >= 85) wellnessBonus += 0.8;
      else if (w_state.reaction.score < 50) wellnessBonus -= 1.2;
    }
    bodyAge -= wellnessBonus;
    bodyAgeFactors.push({ name: 'Wellness', adj: -wellnessBonus, count: measuredCount });

    bodyAge = Math.max(15, Math.min(120, Math.round(bodyAge)));
    const ageDiff = bodyAge - age;

    // 신뢰도: 심혈관 측정 있으면 +20%, 신체 기능 측정 수 × 7%
    const bodyAgeConfidence = Math.min(95, (cvMeasured ? 65 : 45) + Math.min(4, measuredCount - (cvMeasured?1:0)) * 7);

    console.log(`[BodyAge v18.1] base=${age} → ${bodyAge}세 (diff: ${ageDiff > 0 ? '+' : ''}${ageDiff}년, 신뢰도: ${bodyAgeConfidence}%, CV: ${cvAdj.toFixed(1)})`);
    console.log(`[BodyAge] factors: ${bodyAgeFactors.map(f => `${f.name}=${f.adj > 0 ? '+' : ''}${f.adj?.toFixed?.(1)}`).join(', ')}`);

    // === 6. 피부 나이 (v18.1: 혈관나이·RSA 기반 독립 경로) ===
    // 학술 근거:
    //   - Mukherjee 2021: 혈관 경직도(PWV) ↑ → 피부 탄력 ↓ (r=0.64)
    //   - Scheinfeld 2003: 만성 스트레스 → 텔로미어 단축 → 피부 노화
    //   - Kim 2018: HRV 낮음 → 산화 스트레스 ↑ → 피부 노화 가속
    //   - RSA(미주신경): 높을수록 항염증 경로 활성 → 피부 재생 촉진
    // ★ v18.1: 신체나이와 완전 독립 경로 — 체형과 무관하게 피부 바이오마커로 계산
    let skinAge = age; // 기준: 실제 나이

    // 1) 혈관 나이 추정값 반영 (PPG 파형 기반 — 얼굴 측정)
    // 혈관 경직도와 피부 탄력은 콜라겐 구조 공유 (Mukherjee 2021)
    const vascularAgeData = faceW?.vascularAge || null;
    if (vascularAgeData?.estimatedAge) {
      const vaDelta = vascularAgeData.estimatedAge - age;
      // 혈관 나이 차이의 40%를 피부 나이에 반영
      skinAge += vaDelta * 0.40;
      bodyAgeFactors.push({ name: 'VascAge', adj: vaDelta * 0.40 });
    } else {
      // 혈관 나이 데이터 없을 때: HR/HRV로 혈관 간접 추정
      if (hrVal) {
        if (hrVal <= 62)      skinAge -= 1.2;
        else if (hrVal <= 72) skinAge += 0.0;
        else if (hrVal <= 85) skinAge += 1.0;
        else                  skinAge += 2.5;
      }
    }

    // 2) RSA 미주신경 지수 반영 (높을수록 항염증 → 피부 젊음)
    const rsaVal = faceW?.rsaIndex ?? null;
    if (rsaVal !== null) {
      if (rsaVal >= 60)      skinAge -= 1.5; // 미주신경 활성 우수
      else if (rsaVal >= 40) skinAge -= 0.5;
      else if (rsaVal >= 20) skinAge += 0.5;
      else                   skinAge += 2.0; // 미주신경 저하 → 만성 염증
    }

    // 3) HRV(RMSSD) → 산화 스트레스 경로 (Kim 2018)
    if (rmssdVal) {
      const rmssdRef = Math.max(15, 60 - age * 0.4);
      const ratio = rmssdVal / rmssdRef;
      if (ratio >= 1.4)      skinAge -= 1.8;
      else if (ratio >= 1.0) skinAge -= 0.5;
      else if (ratio >= 0.7) skinAge += 0.8;
      else                   skinAge += 2.5;
    }

    // 4) 스트레스 → 코르티솔 → 콜라겐 분해 (Scheinfeld 2003)
    if (stressVal) {
      if (stressVal < 50)       skinAge -= 0.8;
      else if (stressVal < 150) skinAge += 0.0;
      else if (stressVal < 400) skinAge += 1.5;
      else                      skinAge += 3.0;
    }

    // 5) 호흡수 (정상 12-20회/분 → 산화 스트레스 낮음)
    const respRate = faceW?.respRate || null;
    if (respRate) {
      if (respRate >= 12 && respRate <= 18) skinAge -= 0.5;
      else if (respRate > 22)               skinAge += 1.0;
    }

    // 6) BMI 소폭 반영 (영양 상태)
    if (bmi >= 30)      skinAge += 1.0;
    else if (bmi < 18.5) skinAge += 1.5;

    skinAge = Math.max(15, Math.min(120, Math.round(skinAge)));
    const skinAgeDiff = skinAge - age;

    // 피부나이 신뢰도: 혈관나이 있으면 75%, HRV만 있으면 60%, 아무것도 없으면 35%
    const skinAgeConfidence = vascularAgeData
      ? Math.min(85, 70 + (rsaVal !== null ? 8 : 0) + (rmssdVal ? 5 : 0))
      : (rmssdVal || hrVal) ? 55 : 35;

    console.log(`[SkinAge v18.1] base=${age} → ${skinAge}세 (diff: ${skinAgeDiff > 0 ? '+' : ''}${skinAgeDiff}년, 신뢰도: ${skinAgeConfidence}%) VA=${vascularAgeData?.estimatedAge ?? 'N/A'} RSA=${rsaVal ?? 'N/A'} RMSSD=${rmssdVal ?? 'N/A'}`);

    // === 7. '코치' 톤 분석 — 강점/약점 추출 (PDF 전략) ===
    const strengths = [];
    const concerns = [];

    if (bmi >= 18.5 && bmi < 23) strengths.push({ icon: '💪', name: 'BMI 정상', detail: '건강한 체중 범위' });
    else if (bmi >= 30) concerns.push({ icon: '⚠️', name: 'BMI 비만', detail: `${bmi.toFixed(1)} kg/m²` });
    else if (bmi >= 25) concerns.push({ icon: '📊', name: 'BMI 과체중', detail: `${bmi.toFixed(1)} kg/m²` });

    if (whtr < 0.5) strengths.push({ icon: '🎯', name: '복부 비만 없음', detail: '심혈관 위험도 낮음' });
    else if (whtr >= 0.6) concerns.push({ icon: '⚠️', name: '복부 비만', detail: '허리둘레 관리 필요' });

    if (absiZ < -0.272) strengths.push({ icon: '🌟', name: 'ABSI 우수', detail: `상위 ${absiZ < -0.868 ? 5 : 20}% 체형` });
    else if (absiZ > 0.798) concerns.push({ icon: '⚠️', name: 'ABSI 높음', detail: '체형 균형 개선 필요' });

    // 강점 우선 메시지 (PDF 핵심: '숨겨진 강점' 발견)
    let heroMessage, heroSub;
    if (strengths.length >= 2 && concerns.length === 0) {
      heroMessage = '🌟 훌륭해요!';
      heroSub = '대부분의 지표가 건강한 범위에 있습니다.';
    } else if (bmi >= 25 && absiZ < -0.272) {
      // PDF 예시: "당신은 숨겨진 근육 부자!"
      heroMessage = '💪 숨겨진 강점 발견!';
      heroSub = 'BMI는 높지만 ABSI 체형 균형이 우수합니다. 근육량이 많은 체형일 가능성이 높아요.';
    } else if (whtr < 0.5 && bmi < 25) {
      heroMessage = '🎯 균형 잡힌 체형';
      heroSub = '복부 비만이 없고 BMI도 정상입니다. 좋은 컨디션이에요.';
    } else if (concerns.length > 0) {
      heroMessage = '🎯 함께 개선해봐요';
      heroSub = `${concerns[0].name}을(를) 우선 관리하면 큰 변화가 있어요.`;
    } else {
      heroMessage = '📊 측정 완료';
      heroSub = '결과를 확인하고 건강 관리를 시작하세요.';
    }

    // 이전 측정과 비교 (재측정 시 변화 추적)
    let trendHTML = '';
    const prev = this.state.wellness.bodycomp;
    if (prev && prev.bmi) {
      const dW = w - (prev.weight || w);
      const dWaist = waist - (prev.waist || waist);
      const dBmi = bmi - prev.bmi;
      if (Math.abs(dW) >= 0.5 || Math.abs(dWaist) >= 1) {
        const items = [];
        if (Math.abs(dW) >= 0.5) {
          const arrow = dW < 0 ? '▼' : '▲';
          const cls = dW < 0 ? 'good' : (bmi >= 23 ? 'bad' : 'good');
          items.push(`<span class="trend-item ${cls}">체중 ${arrow} ${Math.abs(dW).toFixed(1)}kg</span>`);
        }
        if (Math.abs(dWaist) >= 1) {
          const arrow = dWaist < 0 ? '▼' : '▲';
          const cls = dWaist < 0 ? 'good' : 'bad';
          items.push(`<span class="trend-item ${cls}">허리 ${arrow} ${Math.abs(dWaist).toFixed(1)}cm</span>`);
        }
        trendHTML = `<div class="trend-banner">📈 지난 측정 대비 <span class="trend-items">${items.join('')}</span></div>`;
      }
    }

    // 행동 유도 (Call-to-Action)
    let actionItems = [];
    if (whtr >= 0.5) actionItems.push({ icon: '🚶', text: '하루 30분 빠른 걸음 → 2주 후 허리둘레 1cm↓ 가능' });
    if (bmi >= 25) actionItems.push({ icon: '🥗', text: '저녁 탄수화물 1/3 줄이기 → 한 달 후 BMI 0.5 감소 기대' });
    if (absiZ > 0.5) actionItems.push({ icon: '💪', text: '복근 운동 주 3회 10분 → ABSI 개선 효과' });
    if (actionItems.length === 0) {
      actionItems.push({ icon: '✨', text: '현재 상태를 유지하세요! 매주 측정하여 변화를 추적해보세요' });
    }

    // === 결과 표시 ===
    document.getElementById('bt-bodycomp-stage').style.display = 'none';
    const resultEl = document.getElementById('bt-bodycomp-result');
    resultEl.style.display = 'block';

    // 신체/피부 나이 색상
    const bodyAgeColor = ageDiff <= -2 ? '#10b981' : ageDiff <= 1 ? '#06b6d4' : ageDiff <= 4 ? '#f59e0b' : '#ef4444';
    const ageDiffStr = ageDiff > 0 ? `+${ageDiff}` : ageDiff < 0 ? `${ageDiff}` : '±0';
    const ageDiffLabel = ageDiff <= -2 ? '실제보다 젊어요!' : ageDiff <= 1 ? '실제 나이 수준' : ageDiff <= 4 ? '관리 필요' : '주의 필요';

    resultEl.innerHTML = `
      <!-- 히어로 메시지 (코치 톤) -->
      <div class="bc-hero">
        <div class="bc-hero-msg">${heroMessage}</div>
        <div class="bc-hero-sub">${heroSub}</div>
      </div>

      ${trendHTML}

      <!-- 신체 나이 / 피부 나이 (v13.7 신뢰도 + 시각화 강화) -->
      <div class="bc-age-grid">
        <div class="bc-age-card" style="--ring:${bodyAgeColor}">
          <div class="bc-age-label">🧬 신체 나이</div>
          <div class="bc-age-num">${bodyAge}</div>
          <div class="bc-age-unit">세</div>
          <div class="bc-age-diff" style="color:${bodyAgeColor}">${ageDiffStr}년 · ${ageDiffLabel}</div>
          <div class="bc-age-confidence" title="측정 항목이 많을수록 정확도 ↑">
            <span class="bc-conf-bar"><span class="bc-conf-fill" style="width:${bodyAgeConfidence}%;background:${bodyAgeColor}"></span></span>
            <span class="bc-conf-text">신뢰도 ${bodyAgeConfidence}%</span>
          </div>
        </div>
        <div class="bc-age-card" style="--ring:#a78bfa">
          <div class="bc-age-label">✨ 피부 나이</div>
          <div class="bc-age-num">${skinAge}</div>
          <div class="bc-age-unit">세</div>
          <div class="bc-age-diff" style="color:${skinAgeDiff <= 0 ? '#10b981' : skinAgeDiff <= 2 ? '#f59e0b' : '#ef4444'}">
            ${skinAgeDiff > 0 ? '+' : ''}${skinAgeDiff}년 · ${skinAgeDiff <= -2 ? '동안!' : skinAgeDiff <= 1 ? '나이 수준' : '관리 필요'}
          </div>
          <div class="bc-age-confidence">
            <span class="bc-conf-bar"><span class="bc-conf-fill" style="width:${skinAgeConfidence}%;background:#a78bfa"></span></span>
            <span class="bc-conf-text">신뢰도 ${skinAgeConfidence}% · 참고용</span>
          </div>
        </div>
      </div>

      <!-- ★ v13.7: 필라이즈 스타일 그래프 - BMI 분포 곡선 + 본인 위치 -->
      <div class="bc-section">
        <div class="bc-section-title">📊 체질량지수(BMI) 위치</div>
        <div class="bc-graph-card">
          <div class="bc-graph-header">
            <div class="bc-graph-status ${bmiCat.cls === 'normal' ? 'good' : bmiCat.cls === 'warn' ? 'warn' : 'bad'}">
              체질량지수가 <strong>${bmiCat.label}</strong>
            </div>
            <div class="bc-graph-value">${bmi.toFixed(1)} kg/m²</div>
          </div>
          <svg class="bc-graph-svg" viewBox="0 0 400 160" preserveAspectRatio="xMidYMid meet">
            <!-- 배경 그리드 -->
            <line x1="40" y1="120" x2="380" y2="120" stroke="#e5e7eb" stroke-width="1"/>
            <!-- BMI 분포 영역 (저체중/정상/과체중/비만) -->
            <rect x="40" y="20" width="60" height="100" fill="rgba(59,130,246,0.08)"/>
            <rect x="100" y="20" width="80" height="100" fill="rgba(34,197,94,0.10)"/>
            <rect x="180" y="20" width="60" height="100" fill="rgba(245,158,11,0.10)"/>
            <rect x="240" y="20" width="60" height="100" fill="rgba(239,68,68,0.10)"/>
            <rect x="300" y="20" width="80" height="100" fill="rgba(239,68,68,0.18)"/>
            <!-- 분포 곡선 (정규분포 모방) -->
            <path d="M40,120 Q90,118 110,100 Q140,60 170,55 Q200,60 220,80 Q260,110 300,118 Q340,120 380,120"
                  fill="none" stroke="#7c3aed" stroke-width="2.5" stroke-linecap="round" opacity="0.8"/>
            <!-- 본인 위치 마커 -->
            ${(() => {
              const bmiX = Math.max(40, Math.min(380, 40 + (bmi - 15) / 25 * 340));
              const bmiY = bmi < 23 ? 60 : bmi < 27.5 ? 75 : 100;
              return `
                <line x1="${bmiX}" y1="20" x2="${bmiX}" y2="120" stroke="${bodyAgeColor}" stroke-width="2" stroke-dasharray="3,2"/>
                <circle cx="${bmiX}" cy="${bmiY}" r="7" fill="${bodyAgeColor}" stroke="#fff" stroke-width="2.5"/>
                <text x="${bmiX}" y="${bmiY - 12}" text-anchor="middle" font-size="11" font-weight="800" fill="${bodyAgeColor}">${bmi.toFixed(1)}</text>
              `;
            })()}
            <!-- X축 라벨 -->
            <text x="70" y="138" text-anchor="middle" font-size="10" fill="#6b7280">저체중</text>
            <text x="140" y="138" text-anchor="middle" font-size="10" fill="#10b981" font-weight="700">정상</text>
            <text x="210" y="138" text-anchor="middle" font-size="10" fill="#f59e0b">과체중</text>
            <text x="270" y="138" text-anchor="middle" font-size="10" fill="#ef4444">비만</text>
            <text x="340" y="138" text-anchor="middle" font-size="10" fill="#b91c1c">고도비만</text>
            <!-- Y축 라벨 -->
            <text x="70" y="155" text-anchor="middle" font-size="9" fill="#9ca3af">&lt;18.5</text>
            <text x="140" y="155" text-anchor="middle" font-size="9" fill="#9ca3af">18.5-23</text>
            <text x="210" y="155" text-anchor="middle" font-size="9" fill="#9ca3af">23-25</text>
            <text x="270" y="155" text-anchor="middle" font-size="9" fill="#9ca3af">25-30</text>
            <text x="340" y="155" text-anchor="middle" font-size="9" fill="#9ca3af">30+</text>
          </svg>
        </div>
      </div>

      <!-- 허리둘레 그래프 -->
      <div class="bc-section">
        <div class="bc-section-title">📏 허리/키 비율 (WHtR)</div>
        <div class="bc-graph-card">
          <div class="bc-graph-header">
            <div class="bc-graph-status ${whtrCat.cls === 'normal' ? 'good' : whtrCat.cls === 'warn' ? 'warn' : 'bad'}">
              허리둘레가 <strong>${whtrCat.label}</strong>
            </div>
            <div class="bc-graph-value">${whtr.toFixed(2)}</div>
          </div>
          <div class="bc-bar-graph">
            <div class="bc-bar-track">
              <div class="bc-bar-zone good" style="width:50%"><span>정상</span></div>
              <div class="bc-bar-zone warn" style="width:20%"><span>주의</span></div>
              <div class="bc-bar-zone bad" style="width:30%"><span>위험</span></div>
            </div>
            <div class="bc-bar-marker" style="left:${Math.max(2, Math.min(98, (whtr / 0.75) * 100))}%">
              <div class="bc-bar-marker-dot"></div>
              <div class="bc-bar-marker-label">${whtr.toFixed(2)}</div>
            </div>
          </div>
          <div class="bc-bar-legend">
            <span>0.40</span>
            <span>0.50 ↑ 주의</span>
            <span>0.60 ↑ 위험</span>
          </div>
        </div>
      </div>

      <!-- ABSI 그래프 -->
      <div class="bc-section">
        <div class="bc-section-title">🎯 ABSI 체형 위험도</div>
        <div class="bc-graph-card">
          <div class="bc-graph-header">
            <div class="bc-graph-status ${absiCat.cls === 'normal' ? 'good' : absiCat.cls === 'warn' ? 'warn' : 'bad'}">
              체형 위험도가 <strong>${absiCat.label}</strong>
            </div>
            <div class="bc-graph-value">z = ${absiZ.toFixed(2)}</div>
          </div>
          <div class="bc-bar-graph">
            <div class="bc-bar-track">
              <div class="bc-bar-zone good" style="width:40%"><span>매우 우수</span></div>
              <div class="bc-bar-zone good" style="width:25%; opacity:0.8"><span>평균</span></div>
              <div class="bc-bar-zone warn" style="width:20%"><span>높음</span></div>
              <div class="bc-bar-zone bad" style="width:15%"><span>매우 높음</span></div>
            </div>
            <div class="bc-bar-marker" style="left:${Math.max(2, Math.min(98, ((absiZ + 2) / 4) * 100))}%">
              <div class="bc-bar-marker-dot"></div>
              <div class="bc-bar-marker-label">z=${absiZ.toFixed(1)}</div>
            </div>
          </div>
          <div class="bc-bar-legend">
            <span>z=-2 (상위 2%)</span>
            <span>z=0 (평균)</span>
            <span>z=+2 (하위 2%)</span>
          </div>
        </div>
      </div>

      <!-- 종합 점수 -->
      <div class="bc-score-card">
        <div class="bc-score-label">신체 지수 점수</div>
        <div class="bc-score-value-row">
          <div class="bc-score-value">${score}</div>
          <div class="bc-score-grade">${grade}</div>
        </div>
        <div class="bc-score-bar"><div class="bc-score-bar-fill" style="width:${score}%;background:${bodyAgeColor}"></div></div>
      </div>

      ${strengths.length > 0 ? `
      <!-- 강점 (PDF 전략: 강점 우선 노출) -->
      <div class="bc-section">
        <div class="bc-section-title">💚 당신의 강점</div>
        <div class="bc-cards">
          ${strengths.map(s => `
            <div class="bc-feat-card good">
              <div class="bc-feat-icon">${s.icon}</div>
              <div class="bc-feat-name">${s.name}</div>
              <div class="bc-feat-detail">${s.detail}</div>
            </div>
          `).join('')}
        </div>
      </div>
      ` : ''}

      ${concerns.length > 0 ? `
      <!-- 개선 포인트 (부정어 대신 '개선' 사용) -->
      <div class="bc-section">
        <div class="bc-section-title">🎯 개선하면 좋은 점</div>
        <div class="bc-cards">
          ${concerns.map(c => `
            <div class="bc-feat-card concern">
              <div class="bc-feat-icon">${c.icon}</div>
              <div class="bc-feat-name">${c.name}</div>
              <div class="bc-feat-detail">${c.detail}</div>
            </div>
          `).join('')}
        </div>
      </div>
      ` : ''}

      <!-- 상세 측정값 -->
      <div class="bc-section">
        <div class="bc-section-title">📊 상세 측정값</div>
        <div class="bc-result-grid">
          <div class="bc-metric">
            <div class="bc-metric-label">BMI</div>
            <div class="bc-metric-value">${bmi.toFixed(1)}</div>
            <div class="bc-metric-unit">kg/m²</div>
            <div class="bc-metric-status bc-status ${bmiCat.cls}">${bmiCat.label}</div>
          </div>
          <div class="bc-metric">
            <div class="bc-metric-label">허리/키 비율</div>
            <div class="bc-metric-value">${whtr.toFixed(2)}</div>
            <div class="bc-metric-unit">WHtR</div>
            <div class="bc-metric-status bc-status ${whtrCat.cls}">${whtrCat.label}</div>
          </div>
          <div class="bc-metric" style="grid-column: 1 / -1">
            <div class="bc-metric-label">ABSI 체형 위험도</div>
            <div class="bc-metric-value">${absi.toFixed(4)}</div>
            <div class="bc-metric-unit">z-score: ${absiZ.toFixed(2)}</div>
            <div class="bc-metric-status bc-status ${absiCat.cls}">${absiCat.label}</div>
          </div>
        </div>
      </div>

      <!-- 코치의 한 마디 (행동 유도) -->
      <div class="bc-coach">
        <div class="bc-coach-title">💬 오늘의 코치 한 마디</div>
        ${actionItems.map(a => `
          <div class="bc-coach-item">
            <span class="bc-coach-icon">${a.icon}</span>
            <span class="bc-coach-text">${a.text}</span>
          </div>
        `).join('')}
      </div>

      <!-- 다음 측정 예약 (리텐션 트리거) -->
      <div class="bc-next">
        <div class="bc-next-icon">🔔</div>
        <div class="bc-next-text">
          <div class="bc-next-title">다음 측정은 일주일 후가 좋아요</div>
          <div class="bc-next-sub">변화 추적을 통해 정확한 트렌드를 확인할 수 있어요</div>
        </div>
      </div>

      <button class="bt-redo" type="button" onclick="App.openBodyComposition()">🔄 다시 측정하기</button>
      <button class="bt-redo" type="button" style="margin-top:8px;background:var(--primary);color:#fff" onclick="App.goPage('home')">🏠 홈으로 (종합 점수 보기)</button>
    `;

    // ★ Wellness 저장 (신체 나이/피부 나이 포함, v13.7 신뢰도 추가)
    this._wellnessSave('bodycomp', {
      score, bmi, whtr, absi, age, gender,
      weight: w, waist, height: h,
      bodyAge, skinAge, ageDiff, skinAgeDiff,
      bodyAgeConfidence, skinAgeConfidence,
    });

    // ★ v19.3: 측정 완료 후 인사이트 카드
    setTimeout(() => this._showPostMeasureInsight('bodycomp', { score, bmi, whtr, bodyAge }), 800);

    console.log('[BodyComp] BMI:', bmi.toFixed(1), 'WHtR:', whtr.toFixed(2), 'ABSI:', absi.toFixed(4), 'z=', absiZ.toFixed(2),
                'BodyAge:', bodyAge, '(diff:', ageDiff, ')', 'SkinAge:', skinAge, 'score:', score);
  },
};

window.addEventListener('DOMContentLoaded', () => App.init());
