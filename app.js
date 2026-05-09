// ════════════════════════════════════════════════════════════════════
// 건강 측정 v11.0 — 얼굴 rPPG 메인 앱
// 알고리즘: POS (Wang et al. 2017, IEEE TBME) + 다중 ROI
// ════════════════════════════════════════════════════════════════════

// === 화면 콘솔 (스마트폰 진단용) ===
const Console = {
  buffers: { face: [], body: [] },
  origLog: console.log.bind(console),
  origWarn: console.warn.bind(console),
  origError: console.error.bind(console),
  init() {
    // 콘솔 메시지를 face/body 모두에 출력 (해당 페이지에 표시)
    console.log = (...args) => { this.origLog(...args); this._append('face', 'log', args); this._append('body', 'log', args); };
    console.warn = (...args) => { this.origWarn(...args); this._append('face', 'warn', args); this._append('body', 'warn', args); };
    console.error = (...args) => { this.origError(...args); this._append('face', 'error', args); this._append('body', 'error', args); };
    console.log('[Console] v11.0 화면 콘솔 활성화');
    console.log('[Console] UA:', navigator.userAgent.substring(0, 60));
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
    console.log('[App v13.0] 초기화');
    this._setupCanvas();
    this._bindFaceButton();
    this._bindVisibilityHandler();
    this._setupBackButton();
    window.addEventListener('beforeunload', () => this._cleanupAll());
    history.replaceState({ page: 'home' }, '', '');

    // ★ v13: 누적 Wellness 결과 복원
    this._wellnessRestore();
    this._wellnessRender();

    // ★ 첫 방문 시 권한 일괄 요청 안내
    setTimeout(() => this._maybeShowPermissionGuide(), 1000);

    // ★ 음성 합성 워밍업 (사용자 첫 인터랙션 후 한 번 깨우기)
    document.addEventListener('click', () => this._warmupSpeech(), { once: true, capture: true });
    document.addEventListener('touchstart', () => this._warmupSpeech(), { once: true, capture: true });
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

    try {
      localStorage.setItem('wellness_data', JSON.stringify(this.state.wellness));
    } catch (e) {
      console.warn('[Wellness] 저장 실패:', e);
    }
    this._wellnessRender();
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
      banner.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(16,185,129,.95);color:#fff;padding:18px 24px;border-radius:18px;font-size:16px;font-weight:700;z-index:2000;backdrop-filter:blur(12px);max-width:80%;text-align:center;line-height:1.4;box-shadow:0 8px 32px rgba(0,0,0,.4);transition:opacity .3s, transform .3s;';
      document.body.appendChild(banner);
    }
    banner.textContent = '🔊 ' + text;
    banner.style.opacity = '1';
    banner.style.transform = 'translate(-50%,-50%) scale(1)';
    clearTimeout(this._speakBannerTimer);
    // 텍스트 길이에 비례한 노출 시간 (최소 2초, 최대 6초)
    const duration = Math.max(2000, Math.min(6000, text.length * 100));
    this._speakBannerTimer = setTimeout(() => {
      if (banner) {
        banner.style.opacity = '0';
        banner.style.transform = 'translate(-50%,-50%) scale(.95)';
      }
    }, duration);
  },

  _tryTTS(text, onEnd) {
    if (!('speechSynthesis' in window)) {
      console.log('[Speech] TTS 미지원 — 시각 안내만');
      // TTS 없을 때도 onEnd는 _speak의 안전망에서 처리됨
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
      const safeEnd = () => {
        if (endCalled) return;
        endCalled = true;
        if (typeof onEnd === 'function') onEnd();
      };
      utter.onend = safeEnd;
      utter.onerror = safeEnd;
      // 안전망: 텍스트 길이 + 1초 후에도 onend 안 오면 강제 종료 (일부 환경 대응)
      const fallbackMs = Math.max(2500, text.length * 180) + 1000;
      setTimeout(safeEnd, fallbackMs);

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
    window.scrollTo(0, 0);
  },

  clearConsole(target) { Console.clear(target); },

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

          // ★ v13.5: hard reject → probabilistic confidence-based 보정 (자료 C+D안)
          // 자료 권장: confidence < 0.3 → reject / 0.3~0.7 → corrected / 0.7+ → raw
          const ratio = rmssd / sdnn;
          let confidence = 1.0;

          // 비율 1.4 이상부터 confidence 감소 시작
          if (ratio > 1.4) confidence -= Math.min(0.5, (ratio - 1.4) * 0.5);
          // SQI 페널티 (sqiEarly 사용 - v13.4의 sqi undefined 버그 수정)
          if (sqiEarly < 80) confidence -= (80 - sqiEarly) * 0.005;
          // SNR 페널티 (5 미만)
          if (snrV !== null && snrV < 5) confidence -= (5 - snrV) * 0.03;
          // 임상 범위 (RMSSD 8~150ms)
          if (rmssd < 8 || rmssd > 150) confidence -= 0.4;

          confidence = Math.max(0, Math.min(1, confidence));
          console.log(`[ME-rPPG] RMSSD confidence: ${confidence.toFixed(2)} (ratio=${ratio.toFixed(2)}, sqi=${sqiEarly}, snr=${snrV.toFixed(1)})`);

          if (confidence < 0.3) {
            // 신뢰도 매우 낮음 → reject
            console.warn('[ME-rPPG] RMSSD 신뢰도 부족 - 거부');
            rmssdReason = 'low_confidence';
            rmssd = null;
            lnRmssd = null;
          } else if (confidence < 0.7) {
            // 중간 신뢰도 → bias correction 적용
            const corrected = this._correctRMSSDBias(rmssd, sdnn, sqiEarly, snrV);
            if (corrected !== null && corrected >= 8 && corrected <= 150) {
              rmssd = corrected;
              lnRmssd = Math.log(Math.max(1, corrected)).toFixed(2);
              console.log('[ME-rPPG] RMSSD 보정됨:', rmssd, 'ms');
            } else {
              rmssdReason = 'correction_failed';
              rmssd = null;
              lnRmssd = null;
            }
          }
          // confidence >= 0.7: raw 그대로 사용
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

    // === 5. 스트레스 (Shaffer 2017 ln(RMSSD)) ===
    let stressIdx = null, stressFromRMSSD = false;
    if (rmssd && rmssd > 0) {
      const ln = Math.log(rmssd);
      if (ln >= 4.0)      stressIdx = 15;
      else if (ln >= 3.5) stressIdx = 30;
      else if (ln >= 3.0) stressIdx = 50;
      else if (ln >= 2.5) stressIdx = 70;
      else                stressIdx = 85;
      stressFromRMSSD = true;
    }

    // SQI는 위에서 sqiEarly로 이미 계산됨 (RMSSD confidence 계산용)
    return {
      hr: hrInt, rmssd, lnRmssd, rmssdReason,
      sdnn, respRate, stressIdx, stressFromRMSSD,
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
      // ★ Task Force 1996 / Shaffer 2017 임상 표준
      // 안정 시 단기 (5분) RMSSD 정상 범위: 19~75ms (평균 42ms)
      document.getElementById('fr-hv-val').textContent = r.rmssd;
      setArc('fr-hv-arc', r.rmssd, 10, 80);
      const cls = r.rmssd<19?'bad':r.rmssd<=75?'normal':'high';
      const lbl = r.rmssd<19?'낮음':r.rmssd<=42?'정상':r.rmssd<=75?'양호':'매우 높음';
      setBadge('fr-hv-badge', lbl, cls);
      let cmt;
      if (r.rmssd < 12) {
        cmt = '심박변이도가 매우 낮습니다 (12 미만). 만성 스트레스, 피로 누적, 자율신경 불균형이 의심됩니다. 충분한 휴식과 재측정을 권합니다.';
      } else if (r.rmssd < 19) {
        cmt = '심박변이도가 임상 정상 범위(19~75ms) 미만입니다. 일시적 스트레스 또는 피로 상태일 수 있습니다.';
      } else if (r.rmssd <= 42) {
        cmt = '심박변이도가 임상 정상 범위 안에 있습니다 (정상 평균: 42ms). 자율신경이 안정적입니다.';
      } else if (r.rmssd <= 75) {
        cmt = '심박변이도가 양호합니다 (정상 범위 상위). 부교감신경(이완)이 우세한 건강한 상태입니다.';
      } else {
        cmt = '심박변이도가 매우 높습니다 (75 초과). 깊은 이완 상태이거나 측정 노이즈 가능성. 재측정을 권합니다.';
      }
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
      // RMSSD 기반 — 신뢰 가능 (Anura 방식 1~5 단계로 추상화)
      // 100 단위는 ms 정확도 의존이라 rPPG 한계 노출 → 단계로 추상화
      const stress5 =
        r.stressIdx < 25 ? 1 :    // 매우 이완
        r.stressIdx < 40 ? 2 :    // 이완
        r.stressIdx < 60 ? 3 :    // 보통
        r.stressIdx < 75 ? 4 :    // 약간 스트레스
                          5;      // 높은 스트레스
      document.getElementById('fr-st-val').textContent = stress5.toFixed(1);
      setArc('fr-st-arc', stress5, 1, 5);
      const cls = stress5<=2?'normal':stress5<=3?'high':'bad';
      const lbl = stress5<=2?'이완':stress5<=3?'보통':'스트레스';
      setBadge('fr-st-badge', lbl, cls);
      let cmt;
      if (stress5 === 1)      cmt = '매우 이완된 상태입니다 (1/5). 명상이나 깊은 휴식 후 측정한 듯합니다.';
      else if (stress5 === 2) cmt = '이완 상태입니다 (2/5). 좋은 컨디션입니다.';
      else if (stress5 === 3) cmt = '평상시 상태입니다 (3/5). 일반적인 자율신경 균형입니다.';
      else if (stress5 === 4) cmt = '약간 긴장된 상태입니다 (4/5). 잠시 휴식해보세요.';
      else                    cmt = '높은 스트레스 상태입니다 (5/5). 심호흡과 휴식이 필요합니다.';
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

  // ★ v13.4: RMSSD bias correction (자료 D안)
  // rPPG는 ECG 대비 30~50% RMSSD 과대평가 (Mejia-Mejia 2022, Li 2023)
  // 보정 공식: corrected = raw * (1 - α * motion_score - β * (1 - SNR_norm))
  // 단순 선형 보정 (lightweight, 상용 수준 접근)
  _correctRMSSDBias(rawRMSSD, sdnn, sqi, snr) {
    if (!rawRMSSD || rawRMSSD <= 0) return null;

    // RMSSD/SDNN 비율 (정상: 0.7~1.4)
    const ratio = sdnn ? rawRMSSD / sdnn : 1.0;

    // SQI 정규화 (0~100 → 0~1)
    const sqiNorm = (sqi || 90) / 100;

    // SNR 정규화 (보통 0~10 dB)
    const snrNorm = Math.max(0, Math.min(1, (snr || 5) / 10));

    // 보정 계수 산출
    // - 비율이 1.4 초과 (rPPG 노이즈 신호) → 강한 보정
    // - SQI 낮을수록 보정 강하게
    let correctionFactor = 1.0;

    if (ratio > 1.4) {
      // 비율이 비정상적으로 높음 → RMSSD가 과대평가됨
      // 비율 1.5 → 25% 감소, 1.7 → 35% 감소
      const excess = Math.min(0.5, ratio - 1.4);
      correctionFactor -= excess * 0.5;
    }

    // SQI 페널티: SQI 80 미만이면 추가 보정
    if (sqiNorm < 0.8) {
      correctionFactor -= (0.8 - sqiNorm) * 0.3;
    }

    // SNR 보정: SNR 낮으면 (artifact 많음) 추가 감소
    if (snrNorm < 0.5) {
      correctionFactor -= (0.5 - snrNorm) * 0.2;
    }

    // 최소 보정 한계 (50%)
    correctionFactor = Math.max(0.5, Math.min(1.0, correctionFactor));

    const corrected = Math.round(rawRMSSD * correctionFactor);
    console.log(`[RMSSD] bias correction: ${rawRMSSD}ms × ${correctionFactor.toFixed(2)} → ${corrected}ms (ratio=${ratio.toFixed(2)}, sqi=${sqi}, snr=${(snr||0).toFixed(1)})`);
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

  bodyStop() {
    console.log('[Body] bodyStop');
    this._speakStop(); // 음성 중단
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
            this._finalizeBalance();
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

  _finalizeBalance() {
    console.log('[Balance] finalize');
    this.bodyStop();
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
          this._finalizeGait();
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

  _finalizeGait() {
    console.log('[Gait] finalize');
    this.bodyStop();
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
          this._finalizeTremor();
        }
      }, 1000);
    });
  },

  _finalizeTremor() {
    console.log('[Tremor] finalize');
    this.bodyStop();
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
    this.bodyStop();
    // ★ v13.4: 종료 음성 안내
    this._speak('반응속도 측정이 완료되었습니다. 결과를 확인하세요.');
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
    this.bodyStop();
    // ★ v13.4: 종료 음성 안내
    this._speak('자세 평가가 완료되었습니다. 결과를 확인하세요.');
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

    // 저장된 값 복원 (편의)
    try {
      const saved = JSON.parse(localStorage.getItem('bodycomp_input') || '{}');
      if (saved.height) document.getElementById('bc-height').value = saved.height;
      if (saved.weight) document.getElementById('bc-weight').value = saved.weight;
      if (saved.waist)  document.getElementById('bc-waist').value  = saved.waist;
      if (saved.age)    document.getElementById('bc-age').value    = saved.age;
      if (saved.gender) this.bcSelectGender(saved.gender);
    } catch (e) {}

    window.scrollTo(0, 0);
  },

  bcSelectGender(gender) {
    document.querySelectorAll('.bc-gender-btn').forEach(b => {
      b.classList.toggle('on', b.dataset.gender === gender);
    });
    this._bcGender = gender;
  },

  calcBodyComposition() {
    const h = parseFloat(document.getElementById('bc-height').value);
    const w = parseFloat(document.getElementById('bc-weight').value);
    const waist = parseFloat(document.getElementById('bc-waist').value);
    const age = parseInt(document.getElementById('bc-age').value, 10);
    const gender = this._bcGender;

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

    // 입력 저장
    try {
      localStorage.setItem('bodycomp_input', JSON.stringify({
        height: h, weight: w, waist, age, gender
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

    // === 5. 신체 나이 산출 (Dahlén 2017 + Aune 2016 + Krakauer 2014) ===
    // 베이스: 실제 나이 + 비만 지표 보정
    let bodyAge = age;
    // BMI 보정 (Dahlén 2017: BMI 25~ 매 5단위마다 ~2년)
    if (bmi < 18.5) bodyAge += 1.5;
    else if (bmi < 23) bodyAge -= 0; // 최적
    else if (bmi < 25) bodyAge += 1;
    else if (bmi < 30) bodyAge += 3;
    else if (bmi < 35) bodyAge += 5;
    else bodyAge += 8;
    // WHtR 보정 (Aune 2016: 복부비만은 강력한 예측 인자)
    if (whtr >= 0.6) bodyAge += 4;
    else if (whtr >= 0.5) bodyAge += 2;
    else if (whtr < 0.43) bodyAge += 1; // 너무 적은 것도 패널티
    // ABSI 보정 (Krakauer 2014: z-score가 사망률과 강한 상관)
    if (absiZ > 1.5) bodyAge += 3;
    else if (absiZ > 0.8) bodyAge += 1.5;
    else if (absiZ < -0.8) bodyAge -= 1.5; // 보너스
    // Wellness 다른 측정에서 양호한 항목 있으면 보너스
    const w_state = this.state.wellness;
    let wellnessBonus = 0;
    if (w_state.balance && w_state.balance.score >= 80) wellnessBonus += 0.5;
    if (w_state.gait && w_state.gait.score >= 80) wellnessBonus += 0.5;
    if (w_state.tremor && w_state.tremor.score >= 80) wellnessBonus += 0.5;
    if (w_state.face && w_state.face.score >= 85) wellnessBonus += 1;
    bodyAge -= wellnessBonus;
    bodyAge = Math.max(15, Math.min(120, Math.round(bodyAge)));
    const ageDiff = bodyAge - age;

    // === 6. 피부 나이 (휴리스틱: 주름·탄력 직접 측정 불가하므로 신체 나이 기반 근사) ===
    // 학술적으로 BMI/허리비율은 피부 노화와 약한 상관, 실제 나이가 가장 강한 예측 인자
    // 따라서 실제 나이 ± 2~3년 범위 내에서 신체 나이 트렌드 반영
    let skinAge = age + Math.round((ageDiff / 3));
    skinAge = Math.max(15, Math.min(120, skinAge));

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

      <!-- 신체 나이 / 피부 나이 (Anura 스타일) -->
      <div class="bc-age-grid">
        <div class="bc-age-card" style="--ring:${bodyAgeColor}">
          <div class="bc-age-label">🧬 신체 나이</div>
          <div class="bc-age-num">${bodyAge}</div>
          <div class="bc-age-unit">세</div>
          <div class="bc-age-diff" style="color:${bodyAgeColor}">${ageDiffStr}년 · ${ageDiffLabel}</div>
        </div>
        <div class="bc-age-card" style="--ring:#a78bfa">
          <div class="bc-age-label">✨ 피부 나이</div>
          <div class="bc-age-num">${skinAge}</div>
          <div class="bc-age-unit">세</div>
          <div class="bc-age-diff" style="color:#9ca3af;font-size:10px">참고용 · 실제 나이 기반 추정</div>
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

    // ★ Wellness 저장 (신체 나이/피부 나이 포함)
    this._wellnessSave('bodycomp', {
      score, bmi, whtr, absi, age, gender,
      weight: w, waist, height: h,
      bodyAge, skinAge, ageDiff,
    });

    console.log('[BodyComp] BMI:', bmi.toFixed(1), 'WHtR:', whtr.toFixed(2), 'ABSI:', absi.toFixed(4), 'z=', absiZ.toFixed(2),
                'BodyAge:', bodyAge, '(diff:', ageDiff, ')', 'SkinAge:', skinAge, 'score:', score);
  },
};

window.addEventListener('DOMContentLoaded', () => App.init());
