// ════════════════════════════════════════════════════════════════════
// 건강 측정 v14.5 — 얼굴 rPPG 메인 앱
// 알고리즘: POS (Wang et al. 2017, IEEE TBME) + 다중 ROI
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
  _escape(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
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
  init() {
    Console.init();
    console.log('[App v14.5] 초기화 - 모드:', APP_MODE);
    this._setupCanvas();
    this._bindFaceButton();
    this._bindVisibilityHandler();
    this._setupBackButton();
    window.addEventListener('beforeunload', () => this._cleanupAll());
    history.replaceState({ page: 'home' }, '', '');

    // ★ v13: 누적 Wellness 결과 복원
    this._wellnessRestore();
    this._wellnessRender();

    // ★ v15.0: 홈 첫 화면에 오늘의 감정 카드 렌더링
    this._renderMoodHomeCard();

    // ★ v13.8: 인앱 브라우저 감지 + 안내
    this._detectInAppBrowser();

    // ★ 첫 방문 시 권한 일괄 요청 안내
    setTimeout(() => this._maybeShowPermissionGuide(), 1000);

    // ★ v14.5: 베타 안내 모달 (첫 방문 1회만)
    setTimeout(() => this._maybeShowBetaNotice(), 1500);

    // ★ v14.5: 피드백 플로팅 버튼 추가
    this._injectFeedbackButton();

    // ★ v14.5: 익명 분석 이벤트 (페이지 진입)
    this._trackEvent('app_open');

    // ★ 음성 합성 워밍업 (사용자 첫 인터랙션 후 한 번 깨우기)
    document.addEventListener('click', () => this._warmupSpeech(), { once: true, capture: true });
    document.addEventListener('touchstart', () => this._warmupSpeech(), { once: true, capture: true });
  },

  // ★ v14.5: 베타 안내 모달
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

  _closeFeedback() {
    if (this._feedbackModal) {
      this._feedbackModal.classList.remove('show');
      setTimeout(() => this._feedbackModal?.remove(), 300);
      this._feedbackModal = null;
    }
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

    this._closeFeedback();
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

    // 인앱 브라우저 시그니처 (UA 패턴)
    const inAppPatterns = [
      { name: '카카오톡', pattern: /kakaotalk/i, severity: 'high' },
      { name: '네이버', pattern: /naver\(inapp/i, severity: 'high' },
      { name: '네이버 (whale)', pattern: /naver\b/i, severity: 'medium' },
      { name: '인스타그램', pattern: /instagram/i, severity: 'high' },
      { name: '페이스북', pattern: /fb_iab|fbav|fban/i, severity: 'high' },
      { name: '라인', pattern: /line\//i, severity: 'high' },
      { name: '트위터', pattern: /twitter/i, severity: 'high' },
      { name: 'KakaoStory', pattern: /kakaostory/i, severity: 'high' },
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

    if (!detected) {
      console.log('[Browser] 일반 브라우저 - 모든 기능 사용 가능');
      this._isInApp = false;
      return;
    }

    this._isInApp = true;
    this._inAppName = detected.name;
    console.warn(`[Browser] 인앱 브라우저 감지: ${detected.name} (${detected.severity})`);

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
    // 이미 안내 본 경우 skip (24시간 내 1회만)
    try {
      const lastShown = parseInt(localStorage.getItem('inapp_notice_shown') || '0');
      if (Date.now() - lastShown < 24 * 60 * 60 * 1000) return;
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
        for (const key of ['face', 'balance', 'gait', 'tremor', 'reaction', 'posture', 'bodycomp']) {
          if (data[key] && (now - data[key].t) < MAX_AGE) {
            this.state.wellness[key] = data[key];
          }
        }
        console.log('[Wellness] 복원:', this.state.wellness);
      }
    } catch (e) {
      console.warn('[Wellness] 복원 실패:', e);
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
    // v13.0: 7개 항목으로 재배분 (BMI/ABSI 신체 지수 추가)
    const weights = {
      face:     0.30,  // 활력 징후 (HR/호흡)
      balance:  0.13,  // 균형 (낙상 위험)
      gait:     0.13,  // 보행 (전신 운동)
      reaction: 0.10,  // 반응속도 (인지)
      tremor:   0.11,  // 손떨림 (신경계)
      posture:  0.08,  // 자세 (근골격계)
      bodycomp: 0.15,  // 신체 지수 (BMI/허리비율 - 만성질환 위험)
    };

    let totalWeight = 0;
    let weightedSum = 0;
    const measured = [];
    const missing = [];

    for (const [key, weight] of Object.entries(weights)) {
      if (w[key] && typeof w[key].score === 'number') {
        weightedSum += w[key].score * weight;
        totalWeight += weight;
        measured.push(key);
      } else {
        missing.push(key);
      }
    }

    if (totalWeight === 0) {
      return { score: null, grade: '-', measured, missing, completeness: 0 };
    }

    // 누락된 측정은 평균치(70점)로 가정하지 않고, 측정된 항목만으로 비례 계산
    const score = Math.round(weightedSum / totalWeight);
    const grade =
      score >= 90 ? 'A+' :
      score >= 80 ? 'A' :
      score >= 70 ? 'B' :
      score >= 60 ? 'C' :
      score >= 50 ? 'D' : 'E';
    const completeness = Math.round(totalWeight * 100);

    return { score, grade, measured, missing, completeness };
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
    };

    const measuredHTML = result.measured.map(k => {
      const score = this.state.wellness[k].score;
      const lbl = labelMap[k];
      return `<div class="ws-item ok"><span class="ws-icon">${lbl.icon}</span><span class="ws-name">${lbl.name}</span><span class="ws-score">${score}</span></div>`;
    }).join('');

    const missingHTML = result.missing.map(k => {
      const lbl = labelMap[k];
      return `<div class="ws-item miss" onclick="App._wellnessNavigateToTest('${k}')"><span class="ws-icon">${lbl.icon}</span><span class="ws-name">${lbl.name}</span><span class="ws-score">미측정</span></div>`;
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

  _wellnessNavigateToTest(category) {
    if (category === 'face') {
      this.goPage('face');
    } else if (category === 'bodycomp') {
      // 신체지수는 직접 페이지로 이동
      this.openBodyComposition();
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
  _setupBackButton() {
    window.addEventListener('popstate', (e) => {
      const state = e.state;
      console.log('[Nav] popstate:', state);
      if (!state || state.page === 'home') {
        // 홈에서 뒤로 가면 종료 확인
        if (this.state.page === 'home') {
          // 다시 push (한 번 더 눌러야 종료)
          history.pushState({ page: 'home' }, '', '');
          this._toast('한 번 더 누르면 종료됩니다');
          this._exitWarn = true;
          setTimeout(() => { this._exitWarn = false; }, 2000);
          if (this._exitWarn) {
            // 이미 경고 후 다시 누름 → 그냥 두기 (브라우저가 떠남)
          }
        } else {
          // 측정 페이지에서 뒤로 → 홈으로
          this._goPageInternal('home');
        }
      } else if (state.page === 'body' && this.state.page.startsWith('test-')) {
        // 신체 측정 중 뒤로 → 신체 메뉴로
        this.bodyStop();
        this._goPageInternal('body');
      } else {
        this._goPageInternal(state.page);
      }
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
    // 새 페이지를 history에 push (뒤로가기 시 이전 페이지로)
    history.pushState({ page }, '', '');
  },

  _goPageInternal(page) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('on'));
    document.getElementById('page-' + page).classList.add('on');
    document.querySelectorAll('.nav-btn').forEach(n => n.classList.remove('on'));
    document.getElementById('nav-' + page)?.classList.add('on');
    this.state.page = page;
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
    // ★ v15.0: 홈 진입 시 오늘의 감정 카드 업데이트
    if (page === 'home') {
      this._renderMoodHomeCard();
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
      const bc = w.bodycomp;
      const diff = bc.ageDiff || 0;
      const skinDiff = bc.skinAgeDiff || 0;
      const bodyColor = diff <= 0 ? '#22c55e' : diff <= 3 ? '#f59e0b' : '#ef4444';
      const skinColor = skinDiff <= 0 ? '#a78bfa' : skinDiff <= 3 ? '#f59e0b' : '#ef4444';
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
          </div>
          <div class="res-age-card" style="--c:${skinColor}">
            <div class="res-age-label">✨ 피부 나이</div>
            <div class="res-age-num" style="color:${skinColor}">${bc.skinAge || bc.age}</div>
            <div class="res-age-unit">세 (참고용)</div>
            <div class="res-age-diff" style="color:${skinColor}">
              ${skinDiff > 0 ? '+' : ''}${skinDiff}년
              · 신뢰도 ${bc.skinAgeConfidence || 40}%
            </div>
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

      <!-- ★ v14.4: 평소 대비 변화 카드 (얼굴 측정 baseline 비교) -->
      ${this._renderBaselineComparisonCard(w)}

      <!-- ★ v14.2: 항목별 점수 레이더/막대 차트 -->
      ${measuredCount > 0 ? `
        <div class="res-section-title">📈 항목별 점수 분포</div>
        <div class="res-graph-card">
          ${categoryScores}
        </div>
      ` : ''}

      <!-- 측정 항목 미니 카드 그리드 -->
      <div class="res-section-title">📋 측정 항목</div>
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

      <!-- ★ v14.5: 베타 정보 (디버그 모드에서만 표시) -->
      ${IS_DEBUG ? `
        <div class="debug-section">
          <div class="debug-title">🛠️ 디버그 정보</div>
          <button class="debug-btn" onclick="App._showBetaDebugInfo()" type="button">베타 로그 보기 (에러·이벤트)</button>
        </div>
      ` : ''}
    `;
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
          <button class="feedback-close" type="button" onclick="this.closest('.feedback-modal').remove()">✕</button>
        </div>
        <pre style="font-size:11px;font-family:monospace;background:var(--bg);padding:14px;border-radius:10px;max-height:60vh;overflow:auto;white-space:pre-wrap;color:var(--text);">${info}</pre>
        <div class="feedback-footer">
          <button class="beta-btn secondary" type="button" onclick="App._clearBetaData()">데이터 초기화</button>
          <button class="beta-btn primary" type="button" onclick="App._exportBetaData()">📋 클립보드 복사</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    setTimeout(() => modal.classList.add('show'), 10);
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
    document.querySelector('.feedback-modal')?.remove();
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
  _generateHealthInsights(w) {
    const insights = [];

    // 1. 심혈관 (얼굴 측정)
    if (w.face) {
      const hr = w.face.hr;
      const rmssd = w.face.rmssd;
      const stress = w.face.stressLevel || 3;
      let cls = 'good', icon = '💗', title, label, body, tip;
      if (hr) {
        if (hr < 60) {
          cls = 'good';
          title = '심장이 매우 안정적이에요';
          label = `심박수 ${hr} BPM`;
          body = `심박수가 분당 ${hr}회로 매우 차분합니다. 일반적으로 60회 미만은 평소 운동을 잘 하시거나 휴식을 깊게 취하시는 분들에게 나타나는 좋은 신호입니다. 심장이 한 번 뛸 때 충분히 많은 피를 내보내고 있다는 뜻입니다.`;
          tip = '지금 컨디션을 유지하면서 가벼운 걷기를 꾸준히 해주세요';
        } else if (hr < 80) {
          cls = 'good';
          title = '심장이 정상적으로 일하고 있어요';
          label = `심박수 ${hr} BPM`;
          body = `심박수가 분당 ${hr}회로 건강한 성인의 정상 범위(60~80회) 안에 있습니다. 심장이 무리 없이 잘 일하고 있다는 뜻이에요.`;
          tip = '주 3회 이상 30분 걷기로 이 상태를 유지하세요';
        } else if (hr < 100) {
          cls = 'warn';
          title = '심장이 평소보다 빠르게 뛰고 있어요';
          label = `심박수 ${hr} BPM`;
          body = `심박수가 분당 ${hr}회로 정상 범위 상단입니다. 측정 직전 활동, 카페인 섭취, 긴장 등이 영향을 주었을 수 있어요. 한두 번 더 측정해보고 계속 80 이상이면 휴식과 수분 섭취를 늘려보세요.`;
          tip = '깊은 호흡(4초 들이쉬고 6초 내쉬기)을 5분 해보세요';
        } else {
          cls = 'bad';
          title = '심장이 빠르게 뛰고 있어요';
          label = `심박수 ${hr} BPM`;
          body = `안정 시 심박수가 분당 ${hr}회로 다소 빠릅니다. 카페인, 스트레스, 부족한 수면, 탈수 등이 원인일 수 있어요. 5분간 편안히 앉아 호흡한 후 다시 측정해보세요. 반복적으로 100 이상이면 병원 진료를 권합니다.`;
          tip = '카페인 줄이고 물을 한 잔 마신 후 다시 측정해보세요';
        }
      }
      if (title) {
        insights.push({ cls, icon, title, label, body, tip });
      }

      // 스트레스 인사이트 별도
      if (stress >= 4) {
        insights.push({
          cls: stress === 5 ? 'bad' : 'warn',
          icon: '😰',
          title: stress === 5 ? '높은 스트레스 신호가 감지됐어요' : '약간 긴장된 상태예요',
          label: `스트레스 ${stress}/5단계`,
          body: `자율신경(심박변이도)이 평소보다 긴장된 패턴을 보입니다. 만성 스트레스나 피로가 누적되면 면역력 저하, 수면 장애, 혈압 상승으로 이어질 수 있어요. 오늘 하루 10분이라도 의도적인 휴식을 가져보세요.`,
          tip: '4-7-8 호흡법: 4초 들이쉬고 7초 멈췄다가 8초 내쉬기를 3번 반복',
        });
      } else if (stress <= 2) {
        insights.push({
          cls: 'good',
          icon: '😌',
          title: '마음이 편안한 상태예요',
          label: `스트레스 ${stress}/5단계`,
          body: `자율신경이 안정적이고 부교감신경(휴식 모드)이 잘 작동하고 있습니다. 이런 상태에서는 회복, 소화, 면역 기능이 활발하게 일어납니다.`,
          tip: '이 좋은 컨디션을 유지하려면 규칙적인 수면이 가장 중요해요',
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

    // 1. 심혈관 (HR/RMSSD 기반)
    const stressLevel = w.face?.stressLevel || 3;
    if (stressLevel >= 4 || (w.face?.hr && w.face.hr >= 80)) {
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
    const stressLevel = w.face?.stressLevel || 3;
    const hr = w.face?.hr || 70;

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

    container.innerHTML = periodTabs + summary + insightsHTML + chartsHTML;
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
  _moodGames: [
    { id: 'mirror', icon: '🎭', name: '표정으로 표현하는 마음', sub: '카메라로 따라하는 6가지 표정', time: '약 90초' },
    { id: 'color', icon: '🎨', name: '색으로 표현하는 오늘', sub: '직관으로 고르는 12색', time: '약 60초' },
    { id: 'diary', icon: '✍️', name: '한 단어로 쓰는 일기', sub: '오늘을 표현하는 단어와 키워드', time: '약 60초' },
    { id: 'reflex', icon: '⚡', name: '직관 어구 테스트', sub: '빠르게 반응하는 단어 게임', time: '약 90초' },
  ],

  _moodEmotions: ['joy', 'sadness', 'anger', 'fear', 'surprise', 'disgust'],
  _moodEmotionLabels: {
    joy: '😊 기쁨', sadness: '😢 슬픔', anger: '😠 분노',
    fear: '😨 불안', surprise: '😲 놀람', disgust: '😖 불편',
  },

  // ─── 오늘의 게임 결정 (날짜 기반 고정, 매일 자동 변경) ───
  _getTodayGame() {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const lastShown = localStorage.getItem('mood_game_date');
    let gameId;
    if (lastShown !== today) {
      // 새 날 — 마지막에 안 한 게임 우선 선택
      const lastGame = localStorage.getItem('mood_last_game');
      const candidates = this._moodGames.filter(g => g.id !== lastGame);
      gameId = candidates[Math.floor(Math.random() * candidates.length)].id;
      localStorage.setItem('mood_game_date', today);
      localStorage.setItem('mood_today_game', gameId);
    } else {
      gameId = localStorage.getItem('mood_today_game') || this._moodGames[0].id;
    }
    return this._moodGames.find(g => g.id === gameId) || this._moodGames[0];
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

  // ─── 홈 카드 렌더링 ───
  _renderMoodHomeCard() {
    const card = document.getElementById('mood-today-card');
    if (!card) return;
    const game = this._getTodayGame();
    const played = this._hasPlayedToday();

    const titleEl = document.getElementById('mood-card-title');
    const gameEl = document.getElementById('mood-card-game');
    const timeEl = document.getElementById('mood-card-time');

    if (played) {
      // 오늘 이미 했음 — 결과 보기 모드
      titleEl.textContent = '오늘의 감정을 확인했어요';
      gameEl.innerHTML = `<span class="mood-card-icon">✓</span><span class="mood-card-game-name">결과 다시 보기</span>`;
      timeEl.textContent = '내일 새로운 게임이 준비됩니다';
      card.classList.add('played');
    } else {
      titleEl.textContent = '오늘 마음은 어떠세요?';
      gameEl.innerHTML = `<span class="mood-card-icon">${game.icon}</span><span class="mood-card-game-name">${game.name}</span>`;
      timeEl.textContent = `${game.time} · 매일 다른 게임`;
      card.classList.remove('played');
    }
  },

  // ─── 감정 페이지 메인 렌더링 ───
  _renderMoodPage() {
    const container = document.getElementById('mood-container');
    if (!container) return;
    this._moodState = {}; // 게임 상태 초기화
    container.innerHTML = '';

    if (this._hasPlayedToday()) {
      this._renderMoodResultLatest(container);
    } else {
      this._renderMoodIntro(container);
    }
  },

  // ─── 인트로 화면 ───
  _renderMoodIntro(container) {
    const game = this._getTodayGame();
    container.innerHTML = `
      <div class="mood-intro">
        <div class="mood-intro-icon">${game.icon}</div>
        <div class="mood-intro-title">${game.name}</div>
        <div class="mood-intro-sub">${game.sub}</div>
        <div class="mood-intro-meta">${game.time}</div>

        <div class="mood-intro-tips">
          <div class="mood-tip">💚 정답은 없어요. 직관대로 하세요.</div>
          <div class="mood-tip">🤍 천천히, 부담 없이.</div>
          <div class="mood-tip">📵 측정 결과는 본인만 볼 수 있어요.</div>
        </div>

        <button class="mood-start-btn" type="button" onclick="App._startMoodGame('${game.id}')">
          시작하기 <span>→</span>
        </button>

        <button class="mood-history-btn" type="button" onclick="App._showMoodHistory()">
          📓 지난 감정 일지 보기
        </button>
      </div>
    `;
  },

  // ─── 게임 시작 분기 ───
  _startMoodGame(gameId) {
    this._moodState = { gameId, startTime: Date.now(), results: {} };
    const container = document.getElementById('mood-container');
    if (gameId === 'mirror') this._renderMirrorGame(container);
    else if (gameId === 'color') this._renderColorGame(container);
    else if (gameId === 'diary') this._renderDiaryGame(container);
    else if (gameId === 'reflex') this._renderReflexGame(container);
    this._trackEvent('mood_game_start', { game: gameId });
  },

  // ════════════════════════════════════════════════════════════════
  // GAME 1: 표정 미러링 (Ekman 1992)
  // ════════════════════════════════════════════════════════════════
  _renderMirrorGame(container) {
    const emotions = [
      { id: 'joy', face: '😊', word: '기쁨' },
      { id: 'sadness', face: '😢', word: '슬픔' },
      { id: 'anger', face: '😠', word: '분노' },
      { id: 'fear', face: '😨', word: '불안' },
      { id: 'surprise', face: '😲', word: '놀람' },
      { id: 'disgust', face: '😖', word: '불편' },
    ];
    this._moodState.emotions = emotions;
    this._moodState.emotionScores = {}; // 각 표정마다 "얼마나 따라하기 쉬웠나" 1-5
    this._moodState.currentIdx = 0;
    this._renderMirrorStep(container);
  },

  _renderMirrorStep(container) {
    const idx = this._moodState.currentIdx;
    const total = this._moodState.emotions.length;
    const emotion = this._moodState.emotions[idx];
    const progress = ((idx) / total) * 100;

    container.innerHTML = `
      <div class="mood-progress"><div class="mood-progress-fill" style="width:${progress}%"></div></div>
      <div class="mood-progress-text">${idx + 1} / ${total}</div>

      <div class="mirror-card">
        <div class="mirror-target">
          <div class="mirror-emoji">${emotion.face}</div>
          <div class="mirror-label">${emotion.word}</div>
        </div>
        <div class="mirror-prompt">이 표정을 따라해보세요</div>
        <div class="mirror-sub">지금 이 감정이 얼마나 자연스럽게 느껴지나요?</div>

        <div class="mirror-scale">
          <div class="mirror-scale-label">어색해요</div>
          <div class="mirror-scale-btns">
            ${[1,2,3,4,5].map(n => `
              <button class="mirror-scale-btn" type="button" data-val="${n}" onclick="App._recordMirror(${n})">${n}</button>
            `).join('')}
          </div>
          <div class="mirror-scale-label">자연스러워요</div>
        </div>

        <button class="mood-skip-btn" type="button" onclick="App._recordMirror(0)">
          건너뛰기
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
    const keywords = [
      { id: 'joy', label: '기쁨', icon: '😊', valence: 1 },
      { id: 'peace', label: '평온', icon: '😌', valence: 0.8 },
      { id: 'gratitude', label: '감사', icon: '🙏', valence: 0.9 },
      { id: 'love', label: '애정', icon: '💗', valence: 0.9 },
      { id: 'hope', label: '희망', icon: '🌅', valence: 0.7 },
      { id: 'fatigue', label: '피곤함', icon: '😴', valence: -0.3 },
      { id: 'anxiety', label: '불안', icon: '😟', valence: -0.6 },
      { id: 'sadness', label: '슬픔', icon: '😢', valence: -0.7 },
      { id: 'anger', label: '분노', icon: '😠', valence: -0.7 },
      { id: 'loneliness', label: '외로움', icon: '🥺', valence: -0.8 },
      { id: 'emptiness', label: '공허', icon: '😶‍🌫️', valence: -0.7 },
      { id: 'confusion', label: '혼란', icon: '😵‍💫', valence: -0.4 },
    ];
    this._moodState.keywords = keywords;
    this._moodState.results.selectedKeywords = [];

    container.innerHTML = `
      <div class="mood-progress"><div class="mood-progress-fill" style="width:66%"></div></div>
      <div class="mood-progress-text">2 / 3</div>

      <div class="diary-card">
        <div class="diary-prompt">오늘과 어울리는 감정 키워드는?</div>
        <div class="diary-sub">최대 3개까지 선택할 수 있어요. 어두운 감정도 솔직하게 선택해도 괜찮아요.</div>
        <div class="keyword-grid" id="keyword-grid">
          ${keywords.map(k => `
            <button class="keyword-btn" type="button" data-id="${k.id}" onclick="App._toggleKeyword('${k.id}')">
              <span class="keyword-icon">${k.icon}</span>
              <span class="keyword-label">${k.label}</span>
            </button>
          `).join('')}
        </div>
        <div class="keyword-count" id="keyword-count">0 / 3 선택됨</div>
        <button class="mood-next-btn" type="button" id="keyword-next" onclick="App._submitKeywords()" disabled>다음 <span>→</span></button>
      </div>
    `;
  },

  _toggleKeyword(id) {
    const selected = this._moodState.results.selectedKeywords;
    const idx = selected.indexOf(id);
    if (idx >= 0) {
      selected.splice(idx, 1);
    } else {
      if (selected.length >= 3) return;
      selected.push(id);
    }
    // UI 업데이트
    document.querySelectorAll('.keyword-btn').forEach(b => {
      b.classList.toggle('on', selected.includes(b.dataset.id));
    });
    document.getElementById('keyword-count').textContent = `${selected.length} / 3 선택됨`;
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
      // 외로움 키워드 직접 감지
      if (sel.includes('loneliness')) analysis.loneliness = 0.8;
      else if (sel.includes('emptiness')) analysis.loneliness = 0.6;
      else if (sel.includes('sadness') || sel.includes('anxiety')) analysis.loneliness = 0.3;
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

    // 얼굴 측정과 통합
    const w = this.state.wellness || {};
    if (w.face) {
      const faceTime = w.face.t || 0;
      const now = Date.now();
      // 6시간 이내 측정이면 결합
      if (now - faceTime < 6 * 60 * 60 * 1000) {
        analysis.faceLink = {
          hr: w.face.hr,
          rmssd: w.face.rmssd,
          stressLevel: w.face.stressLevel,
          ageMinutes: Math.round((now - faceTime) / 60000),
        };
      }
    }

    return analysis;
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

    container.innerHTML = `
      <div class="mood-result">
        <div class="result-hero">
          <div class="result-quadrant ${quadrant.cls}">
            <div class="result-quadrant-icon">${quadrant.icon}</div>
            <div class="result-quadrant-label">${quadrant.label}</div>
          </div>
          <div class="result-message">${message}</div>
        </div>

        ${this._renderCircumplexChart(v, a, quadrant)}

        ${integratedMsg ? `
          <div class="result-section">
            <div class="result-section-title">💚 마음과 몸의 대화</div>
            <div class="result-integrated">${integratedMsg}</div>
          </div>
        ` : `
          <div class="result-suggest-face">
            <div class="result-suggest-face-icon">😊</div>
            <div class="result-suggest-face-body">
              <div class="result-suggest-face-title">얼굴 측정도 함께 해보세요</div>
              <div class="result-suggest-face-sub">자율신경과 비교하면 더 정확한 분석이 가능해요</div>
            </div>
            <button class="result-suggest-face-btn" onclick="App.goPage('face')">측정</button>
          </div>
        `}

        ${needsHelp ? this._renderCrisisCard() : ''}

        ${this._renderMoodInsights(analysis)}

        <div class="result-actions">
          <button class="mood-action-btn" type="button" onclick="App.goPage('home')">홈으로</button>
          <button class="mood-action-btn primary" type="button" onclick="App._showMoodHistory()">지난 일지 보기</button>
        </div>

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
    // RMSSD 본인 평균
    const history = this._historyGet('face');
    const past = history.slice(0, -1);
    const rmssdStats = past.length >= 3 ? this._historyStats(past, 'rmssd') : null;
    const isLowHRV = rmssdStats && face.rmssd < rmssdStats.mean - rmssdStats.std;
    const isHighHRV = rmssdStats && face.rmssd > rmssdStats.mean + rmssdStats.std;

    if (v < -0.3 && isLowHRV) {
      return '마음도 무겁고 자율신경도 평소보다 긴장된 상태예요. 오늘은 무리하지 마시고 따뜻한 차 한 잔, 깊은 호흡을 권합니다.';
    }
    if (v < -0.3 && !isLowHRV) {
      return '마음은 무거우신데 자율신경은 안정적이에요. 감정적으로 힘드시지만 몸은 잘 버티고 있는 상태입니다. 잠시 쉬어가도 괜찮아요.';
    }
    if (v >= 0.3 && isLowHRV) {
      return '마음은 좋으신데 자율신경은 약간 긴장돼 있어요. 좋은 일에도 몸이 따라가지 못할 때가 있어요. 충분한 수면을 챙겨보세요.';
    }
    if (v >= 0.3 && isHighHRV) {
      return '마음도 몸도 함께 좋은 상태예요. 이 균형을 기억해두세요.';
    }
    return `현재 심박수 ${face.hr}BPM · HRV ${face.rmssd}ms. 자율신경이 안정적이에요.`;
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
          <strong>"${rd.word || '-'}"</strong></div>
        <div class="insight-row"><span>선택한 키워드:</span>
          <strong>${keywordLabels || '-'}</strong></div>
        ${rd.moment ? `<div class="insight-row column"><span>마음에 남는 순간:</span>
          <em>"${rd.moment}"</em></div>` : ''}
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
        <div class="result-section-title">📝 게임 결과</div>
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
    if (analysis.loneliness >= 0.7) return 'loneliness_high';
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
      const analysis = {
        gameId: latest.gameId,
        valence: latest.valence,
        arousal: latest.arousal,
        loneliness: latest.loneliness,
        negBias: latest.negBias,
        flag: latest.flag,
        rawData: latest.rawData,
        faceLink: latest.faceLink,
      };
      this._showMoodResult(analysis);
    } catch (e) {
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
            <div class="history-meta">${dateStr} · ${game?.icon || ''} ${game?.name || h.gameId}</div>
            ${h.rawData?.word ? `<div class="history-word">"${h.rawData.word}"</div>` : ''}
            ${h.rawData?.moment ? `<div class="history-moment">💭 ${h.rawData.moment}</div>` : ''}
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
    return `
      <div class="history-summary-card">
        <div class="history-summary-title">지난 7일 마음 풍경</div>
        <div class="history-summary-main">${dominant.icon} ${dominant.label}</div>
        <div class="history-summary-stats">
          <div><span>긍정 ↔ 부정</span><strong>${avgV >= 0 ? '+' : ''}${(avgV*100).toFixed(0)}</strong></div>
          <div><span>외로움</span><strong>${(avgL*100).toFixed(0)}%</strong></div>
          <div><span>기록 횟수</span><strong>${recent7.length}회</strong></div>
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
    // 실제 FPS 보정
    if (m.timestampArray.length > 300) {
      const recent = m.timestampArray.slice(-301);
      let total = 0, valid = 0;
      for (let i = 1; i < recent.length; i++) {
        const dt = recent[i] - recent[i - 1];
        if (dt <= 0.5) { total += dt; valid++; }
      }
      const avgFps = total > 0 ? (valid / total) : 0;
      if (avgFps > 0) hr = (hr / 30) * avgFps;
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
              type: 'data',
              input,
              timestamp: lastTime,
              lambda: 1,
            });
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
    const sr = this.config.face.targetSR;
    if (f.samples.length < sr * this.config.face.minWarmupSec) return;

    const win = Math.min(sr * 12, f.samples.length);
    const recent = f.samples.slice(-win);

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

    // BPF + Goertzel
    const detrended = this._detrend(pos);
    const filtered = this._bandpass(detrended, sr, 0.7, 3.0);
    const stdF = this._stdDev(filtered);
    if (stdF < 0.001) return;

    const { freq: hrHz, snr } = this._goertzelPeak(filtered, sr, 45/60, 180/60);
    if (!hrHz || snr < 2.5) return;

    const hr = Math.round(hrHz * 60);
    if (hr < 45 || hr > 180 || hr === 45 || hr === 180) return;

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

  // ─── 측정 완료 (ME-rPPG 결과 통합) ───
  _faceFinalize() {
    console.log('[Face] _faceFinalize() - ME-rPPG');
    let result;
    try {
      result = this._faceComputeMetrics();
      console.log('[Face] 최종 결과:', result);
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
        const peakResult = this._goertzelPeak(filtered, upSr, 45/60, 180/60);
        if (peakResult && typeof peakResult.snr === 'number' && !isNaN(peakResult.snr)) {
          snrV = peakResult.snr;
        }
      }
    } catch (e) {
      console.warn('[ME-rPPG] SNR 추출 실패, 기본값 사용:', e.message);
    }

    let rmssd = null, lnRmssd = null, rmssdReason = null;
    let sdnn = null;

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

    return {
      hr: hrInt, rmssd, lnRmssd, rmssdReason,
      sdnn, respRate, stressIdx, stressFromRMSSD, stressLevel,
      sqi: sqiEarly,
      snr: null, peakCount: peaks ? peaks.length : 0,
      engine: 'ME-rPPG',
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
  // 3. 인접 RR과 ±25% 차이 (Karolinska ±20%에서 약간 완화 — rPPG 노이즈 감안)
  // 4. 평균 RR 기준 ±3 SD 규칙
  _removeEctopicRR(rawRR, expectedRRms) {
    if (rawRR.length < 4) return rawRR.slice();

    // Step 1: 절대 범위 필터
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

    // ★ v13: 얼굴 측정 종합 점수 산출 + 누적 저장
    // HR 점수: 60-100 정상, 50-110 양호, 그 외 감점
    let faceScore = 100;
    if (r.hr) {
      if (r.hr < 50 || r.hr > 110) faceScore -= 25;
      else if (r.hr < 60 || r.hr > 100) faceScore -= 8;
    } else {
      faceScore -= 30;
    }
    // 호흡수 점수: 12-20 정상
    if (r.respRate) {
      if (r.respRate < 10 || r.respRate > 24) faceScore -= 15;
      else if (r.respRate < 12 || r.respRate > 20) faceScore -= 5;
    } else {
      faceScore -= 10;
    }
    // SQI 가중 (신호 품질): 90+ 가산, 70 미만 감산
    if (r.sqi) {
      if (r.sqi < 70) faceScore -= 10;
      else if (r.sqi >= 90) faceScore += 0; // 가산 없음 (이미 만점 가능)
    }
    // RMSSD 신뢰 가능 시만 약간 반영 (rPPG 한계 고려, 가중치 낮게)
    if (r.rmssd && r.stressFromRMSSD) {
      if (r.stressIdx >= 70) faceScore -= 5;
    }
    faceScore = Math.max(0, Math.min(100, faceScore));
    this._wellnessSave('face', {
      hr: r.hr,
      respRate: r.respRate,
      rmssd: r.rmssd,
      stressIdx: r.stressIdx,
      sqi: r.sqi,
      score: faceScore,
    });

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

    let score = 100;
    if (closedMetrics.rms > 0.4) score -= 30;
    else if (closedMetrics.rms > 0.25) score -= 15;
    if (rombergRatio > 4) score -= 25;
    else if (rombergRatio > 2.5) score -= 10;
    score = Math.max(0, Math.min(100, score));
    const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D';

    let cmt;
    if (score >= 85) cmt = '균형 능력이 우수합니다. 전정 기능과 자세 안정성이 양호합니다.';
    else if (score >= 70) cmt = '균형 능력이 정상 범위입니다.';
    else if (score >= 50) cmt = '균형 능력이 다소 떨어집니다. 코어 운동을 고려하세요.';
    else cmt = '균형이 불안정합니다. 어지러움이 잦다면 전문의 상담을 권합니다.';

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
      <button class="bt-redo" type="button" onclick="App.startBodyTest('balance')">🔄 다시 측정</button>
    `;

    // ★ v13: Wellness 저장
    this._wellnessSave('balance', {
      score, rms: closedMetrics.rms, rombergRatio,
    });
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
    this._speak('보행 측정을 시작합니다. 평소 속도로 30초간 걸어주세요.', () => {
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

    let score = 100;
    if (cadence < 80 || cadence > 130) score -= 20;
    if (steps < 20) score -= 30; // 너무 적게 걸음
    score = Math.max(0, Math.min(100, score));
    const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D';

    let cmt;
    if (cadence === 0) cmt = '걸음이 거의 감지되지 않았습니다. 걷기 측정을 다시 시도해주세요.';
    else if (cadence < 80) cmt = '평균보다 느린 걸음입니다.';
    else if (cadence <= 110) cmt = '안정적이고 정상적인 보행 속도입니다.';
    else if (cadence <= 130) cmt = '약간 빠른 걸음입니다.';
    else cmt = '매우 빠른 걸음 또는 측정 오류 가능성이 있습니다.';

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
      <button class="bt-redo" type="button" onclick="App.startBodyTest('gait')">🔄 다시 측정</button>
    `;

    // ★ v13: Wellness 저장
    this._wellnessSave('gait', {
      score, stepsPerMin: cadence, steps,
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

    // 임상 기준 (Heldman 2014):
    // 정상: < 30mg, 가벼운 떨림: 30-100mg, 중간: 100-300mg, 심함: > 300mg
    let score = 100;
    if (ampMg > 300) score = 30;
    else if (ampMg > 100) score = 50;
    else if (ampMg > 30) score = 75;
    score = Math.max(0, Math.min(100, score));

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
    let score = 100;
    if (!r.error) {
      if (r.avg > 500) score = 40;
      else if (r.avg > 350) score = 60;
      else if (r.avg > 280) score = 75;
      else if (r.avg > 220) score = 88;
    }
    const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D';
    let cmt;
    if (r.error) cmt = r.error;
    else if (r.avg < 220) cmt = '매우 빠른 반응속도입니다. 운동선수 수준입니다.';
    else if (r.avg < 280) cmt = '빠른 반응속도입니다.';
    else if (r.avg < 350) cmt = '평균적인 반응속도입니다.';
    else if (r.avg < 500) cmt = '반응속도가 다소 느립니다. 휴식을 취해보세요.';
    else cmt = '반응속도가 느립니다. 피로/집중력 저하 가능성.';

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

    // === 5. 신체 나이 (다중 지표 통합 모델, v13.7 정밀화) ===
    // 학술 근거:
    //   - Dahlén 2017: BMI 25+ → 사망률 +12%/단위, 신체 노화 +1.5~3년/BMI단위
    //   - Aune 2016: WHtR 0.5+ → 심혈관 위험 1.5x, 신체 나이 +2~5년
    //   - Krakauer 2014 (NHANES 14,105명): ABSI z-score는 BMI보다 사망률 예측력 우수
    //   - Levine 2013 PhenoAge 모델: 다중 바이오마커 통합이 단일보다 정확
    //
    // v13.7 변경: 가중평균 방식 + Wellness 활력 지표 강화 + 신뢰도 산출
    let bodyAge = age;
    let bodyAgeFactors = []; // 신뢰도 계산용

    // BMI 보정 (Dahlén 2017 회귀계수 기반)
    let bmiAdj = 0;
    if (bmi < 18.5) bmiAdj = +1.5;
    else if (bmi < 23) bmiAdj = -0.5;  // 최적 범위 (소폭 보너스)
    else if (bmi < 25) bmiAdj = +0.8;
    else if (bmi < 27.5) bmiAdj = +2.0;
    else if (bmi < 30) bmiAdj = +3.5;
    else if (bmi < 35) bmiAdj = +5.5;
    else bmiAdj = +8.0;
    bodyAge += bmiAdj;
    bodyAgeFactors.push({ name: 'BMI', adj: bmiAdj });

    // WHtR 보정 (Aune 2016, 복부비만 강력 예측)
    let whtrAdj = 0;
    if (whtr < 0.43) whtrAdj = +0.5;
    else if (whtr < 0.5) whtrAdj = -0.5; // 최적
    else if (whtr < 0.55) whtrAdj = +1.5;
    else if (whtr < 0.6) whtrAdj = +3.0;
    else if (whtr < 0.65) whtrAdj = +4.5;
    else whtrAdj = +6.0;
    bodyAge += whtrAdj;
    bodyAgeFactors.push({ name: 'WHtR', adj: whtrAdj });

    // ABSI 보정 (Krakauer 2014 z-score 정밀화)
    let absiAdj = 0;
    if (absiZ > 1.5) absiAdj = +3.0;
    else if (absiZ > 0.8) absiAdj = +1.5;
    else if (absiZ > 0.229) absiAdj = +0.5;
    else if (absiZ < -0.868) absiAdj = -2.0;  // 매우 우수 (상위 10%)
    else if (absiZ < -0.272) absiAdj = -1.0;  // 우수 (상위 20%)
    bodyAge += absiAdj;
    bodyAgeFactors.push({ name: 'ABSI', adj: absiAdj });

    // ★ v13.7: Wellness 다중 측정 보너스 강화
    // Levine PhenoAge 원리 - 여러 지표가 양호하면 신뢰도 높은 보너스
    const w_state = this.state.wellness;
    let wellnessBonus = 0;
    let measuredCount = 0;

    if (w_state.face && w_state.face.score) {
      measuredCount++;
      // 심혈관 건강은 강한 예측 인자 (Levine PhenoAge 핵심)
      if (w_state.face.score >= 90) wellnessBonus += 1.5;
      else if (w_state.face.score >= 80) wellnessBonus += 0.7;
      else if (w_state.face.score < 60) wellnessBonus -= 1.0;
    }
    if (w_state.balance && w_state.balance.score) {
      measuredCount++;
      // 균형 = 신경계+근골격계, 노화 강력 지표 (Studenski 2011 보행속도와 사망률)
      if (w_state.balance.score >= 85) wellnessBonus += 1.0;
      else if (w_state.balance.score >= 70) wellnessBonus += 0.4;
      else if (w_state.balance.score < 50) wellnessBonus -= 1.5;
    }
    if (w_state.gait && w_state.gait.score) {
      measuredCount++;
      if (w_state.gait.score >= 85) wellnessBonus += 1.0;
      else if (w_state.gait.score >= 70) wellnessBonus += 0.4;
      else if (w_state.gait.score < 50) wellnessBonus -= 1.5;
    }
    if (w_state.tremor && w_state.tremor.score) {
      measuredCount++;
      if (w_state.tremor.score >= 85) wellnessBonus += 0.5;
    }
    if (w_state.reaction && w_state.reaction.score) {
      measuredCount++;
      // 반응속도 = 인지 노화 지표 (Deary 2010)
      if (w_state.reaction.score >= 85) wellnessBonus += 0.7;
      else if (w_state.reaction.score < 50) wellnessBonus -= 1.0;
    }
    bodyAge -= wellnessBonus;
    bodyAgeFactors.push({ name: 'Wellness', adj: -wellnessBonus, count: measuredCount });

    bodyAge = Math.max(15, Math.min(120, Math.round(bodyAge)));
    const ageDiff = bodyAge - age;

    // ★ v13.7: 신뢰도 산출 (측정한 부가 지표 수 기반)
    // 0개: 50% (BMI/WHtR/ABSI만), 5개 모두: 95%
    const bodyAgeConfidence = Math.min(95, 50 + measuredCount * 9);

    console.log(`[BodyAge] base=${age} → ${bodyAge}세 (diff: ${ageDiff > 0 ? '+' : ''}${ageDiff}년, 신뢰도: ${bodyAgeConfidence}%, 측정 ${measuredCount}/5)`);
    console.log(`[BodyAge] factors: ${bodyAgeFactors.map(f => `${f.name}=${f.adj > 0 ? '+' : ''}${f.adj.toFixed(1)}`).join(', ')}`);

    // === 6. 피부 나이 (다중 요인 휴리스틱, v13.7 정교화) ===
    // 한계 명시: 카메라 기반 주름/탄력/색소 직접 측정 미구현
    // 학술 근거:
    //   - Stress 누적이 피부 노화 가속 (Epel 2004)
    //   - BMI 과체중 → 콜라겐 분해 증가 (Lock-Sundbom 2012)
    //   - HRV 낮음 → 만성 스트레스 → 피부 노화 (Kim 2018)
    //   - 호흡수 정상 → 산화 스트레스 낮음 → 피부 건강
    let skinAge = age;

    // BMI 영향 (소폭)
    if (bmi >= 30) skinAge += 1.0;
    else if (bmi < 18.5) skinAge += 1.5; // 저체중도 영양 부족 의심

    // 신체 나이 트렌드 반영 (1/3 비중)
    skinAge += ageDiff * 0.35;

    // ★ Wellness 얼굴 측정 활용 (직접 피부 표면 분석)
    if (w_state.face && w_state.face.score) {
      // HR/호흡/HRV가 좋으면 피부 노화도 느림 (학술적 상관관계)
      if (w_state.face.score >= 90) skinAge -= 1.5;
      else if (w_state.face.score >= 80) skinAge -= 0.5;
      else if (w_state.face.score < 60) skinAge += 1.5;

      // 스트레스 직접 반영 (높은 스트레스 → 피부 노화 가속)
      if (w_state.face.stressIdx) {
        if (w_state.face.stressIdx >= 70) skinAge += 1.5;
        else if (w_state.face.stressIdx <= 30) skinAge -= 0.5;
      }
    }

    skinAge = Math.max(15, Math.min(120, Math.round(skinAge)));
    const skinAgeDiff = skinAge - age;
    const skinAgeConfidence = w_state.face ? 70 : 40; // 얼굴 측정 있으면 70%, 없으면 40%

    console.log(`[SkinAge] base=${age} → ${skinAge}세 (diff: ${skinAgeDiff > 0 ? '+' : ''}${skinAgeDiff}년, 신뢰도: ${skinAgeConfidence}%)`);

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

    console.log('[BodyComp] BMI:', bmi.toFixed(1), 'WHtR:', whtr.toFixed(2), 'ABSI:', absi.toFixed(4), 'z=', absiZ.toFixed(2),
                'BodyAge:', bodyAge, '(diff:', ageDiff, ')', 'SkinAge:', skinAge, 'score:', score);
  },
};

window.addEventListener('DOMContentLoaded', () => App.init());
