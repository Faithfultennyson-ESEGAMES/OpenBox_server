(function () {
  const MAX_PLAYER_NAME_LENGTH = 15;
  const params = new URLSearchParams(window.location.search);
  const joinUrl = String(params.get('joinUrl') || '').trim();
  const sessionId = String(params.get('sessionId') || '').trim();
  const playerId = String(params.get('playerId') || '').trim();
  const playerName = normalizePlayerName(params.get('playerName'));
  const wsUrl = String(params.get('ws') || '').trim();
  const joinIntentUrl = deriveJoinIntentUrl(joinUrl, sessionId);
  const isLowEnd = (navigator.hardwareConcurrency || 4) <= 4;

  const els = {
    readyOverlay: document.getElementById('s-ready'),
    readyTitle: document.getElementById('readyTitle'),
    readyCopy: document.getElementById('readyCopy'),
    readyJoined: document.getElementById('readyJoined'),
    readyCount: document.getElementById('readyCount'),
    readyTimer: document.getElementById('readyTimer'),
    readyBtn: document.getElementById('readyBtn'),
    readyHint: document.getElementById('readyHint'),
    playerAv: document.getElementById('playerAv'),
    playerName: document.getElementById('playerName'),
    playerStake: document.getElementById('playerStake'),
    sessionCtrTxt: document.getElementById('sessionCtrTxt'),
    stTitle: document.getElementById('stTitle'),
    stSub: document.getElementById('stSub'),
    gameBadge: document.getElementById('gameBadge'),
    progWrap: document.getElementById('progWrap'),
    progFill: document.getElementById('progFill'),
    progLabel: document.getElementById('progLabel'),
    swapActions: document.getElementById('swapActions'),
    keepBtn: document.getElementById('keepBtn'),
    swapBtn: document.getElementById('swapBtn'),
    btnNote: document.getElementById('btnNote'),
    carouselTrack: document.getElementById('carouselTrack'),
    carouselDots: document.getElementById('carouselDots'),
    carouselVp: document.getElementById('carouselVp'),
    stageGlow: document.getElementById('stageGlow'),
    trackSvg: document.getElementById('trackSvg'),
    trackCalcPath: document.getElementById('trackCalcPath'),
    playerBox: document.getElementById('playerBox'),
    playerNum: document.getElementById('playerNum'),
    ybLabel: document.getElementById('ybLabel'),
    hudRight: document.getElementById('hudRight'),
    arena: document.getElementById('arena'),
    phone: document.getElementById('phone'),
    shellStage: document.getElementById('shellStage'),
    shellFit: document.getElementById('shellFit'),
    trackWrap: document.getElementById('trackWrap'),
    loading: document.getElementById('s-loading'),
    loadingIcon: document.getElementById('ls-icon'),
    loadingTitle: document.getElementById('ls-title'),
    loadingAwait: document.getElementById('ls-await'),
    loadingSegs: document.getElementById('ls-segs'),
    win: document.getElementById('s-win'),
    lose: document.getElementById('s-lose'),
    lb: document.getElementById('s-lb'),
    winAmount: document.getElementById('winAmount'),
    winDetail: document.getElementById('winDetail'),
    loseDetail: document.getElementById('loseDetail'),
    winSecs: document.getElementById('winSecs'),
    loseSecs: document.getElementById('loseSecs'),
    confLayer: document.getElementById('confLayer'),
    lbMeta: document.getElementById('lbMeta'),
    lbList: document.getElementById('lbList'),
    lbPoolVal: document.getElementById('lbPoolVal'),
    lbSession: document.getElementById('lbSession')
  };

  const G_GOLD = 'background:linear-gradient(135deg,var(--gold-bright),var(--gold),var(--gold-mid));-webkit-background-clip:text;-webkit-text-fill-color:transparent;filter:drop-shadow(0 .125rem .5rem rgba(0,0,0,.85));';
  const G_TEAL = 'background:linear-gradient(135deg,var(--teal),var(--teal-mid));-webkit-background-clip:text;-webkit-text-fill-color:transparent;filter:drop-shadow(0 .125rem .5rem rgba(0,0,0,.85));';
  const G_BLUE = 'background:linear-gradient(135deg,var(--blue-dim),#9999cc);-webkit-background-clip:text;-webkit-text-fill-color:transparent;filter:drop-shadow(0 .125rem .5rem rgba(0,0,0,.85));';
  const G_RED = 'background:linear-gradient(135deg,var(--red-bright),#cc2222);-webkit-background-clip:text;-webkit-text-fill-color:transparent;filter:drop-shadow(0 .125rem .5rem rgba(0,0,0,.85));';
  const viewportFit = { scale: 1, rafId: 0 };
  const timerState = { rafId: 0, theme: 'gold', label: 'Swap' };
  const timeouts = [];
  const intervals = [];
  const listeners = {};

  let SESSION = {
    sessionId,
    playerBox: 0,
    totalPlayers: 0,
    containerSize: 0,
    swapWindowSeconds: 10,
    softLockPercent: 0,
    softLockAt: 0,
    swapEndsAt: 0,
    playerName,
    playerInitials: buildInitials(playerName),
    stakeAmount: '',
    rewardPool: 0
  };
  let _pendingRoundResult = null;
  let _hasEnteredSession = false;
  let _readySubmitted = false;
  let _readyDeadline = 0;
  let _readyTicker = null;
  let _socketReconnect = true;
  let _ws = null;
  let _reconnectTimer = null;
  let _joinIntentState = 'idle';
  let _joinIntentRetryTimer = null;
  let _roundSettled = false;
  let _sessionEndedReason = '';
  let swapSecs = 10;
  let swapWindowTotal = 10;
  let swapPhase = 'idle';
  let containers = [];
  let playerContainerIdx = -1;
  let layout = {};
  const requiredElementNames = Object.keys(els);

  const bus = {
    on(event, handler) {
      listeners[event] = listeners[event] || [];
      listeners[event].push(handler);
    },
    off(event, handler) {
      if (!listeners[event]) return;
      if (!handler) {
        delete listeners[event];
        return;
      }
      listeners[event] = listeners[event].filter((fn) => fn !== handler);
    },
    emit(event, payload) {
      (listeners[event] || []).forEach((handler) => handler(payload));
    },
    connect() {
      clearTimeout(_reconnectTimer);
      if (!joinUrl || !sessionId || !playerId || !playerName || !wsUrl) {
        handleFatalError('Missing required launch values.');
        return;
      }
      _ws = new WebSocket(wsUrl);
      _ws.addEventListener('open', () => {
        this.send('hello', { sessionId, playerId, playerName });
      });
      _ws.addEventListener('message', (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch (error) {
          return;
        }
        this.handleMessage(message);
      });
      _ws.addEventListener('close', () => {
        if (_socketReconnect) {
          _reconnectTimer = setTimeout(() => this.connect(), 1200);
        }
      });
      _ws.addEventListener('error', () => {
        setStatus('Connection Error', 'Retrying connection to the game server...', G_RED);
      });
    },
    send(type, payload = {}) {
      if (!_ws || _ws.readyState !== WebSocket.OPEN) return;
      _ws.send(JSON.stringify({ type, ...payload }));
    },
    handleMessage(message) {
      switch (message.type) {
        case 'ping':
          this.send('pong');
          break;
        case 'welcome':
          this.emit('welcome', message);
          break;
        case 'ready_status':
          this.emit('ready_status', message);
          break;
        case 'session_init':
          this.emit('session_init', message);
          break;
        case 'replay_started':
          this.emit('replay_started', message);
          break;
        case 'swap_result':
          this.emit('swap_result', message);
          break;
        case 'softlock':
          this.emit('softlock', message);
          break;
        case 'round_result':
          this.emit('round_result', message);
          break;
        case 'leaderboard_data':
          this.emit('leaderboard_data', message);
          break;
        case 'error':
          this.emit('error', message);
          break;
        default:
          break;
      }
    },
    reset() {}
  };

  function parseSessionId(url) {
    if (!url) return '';
    try {
      const match = new URL(url).pathname.match(/\/session\/([^/]+)/);
      return match ? match[1] : '';
    } catch (error) {
      return '';
    }
  }

  function deriveWsUrl(url) {
    if (url) {
      try {
        const parsed = new URL(url);
        return `${parsed.protocol === 'https:' ? 'wss' : 'ws'}://${parsed.host}`;
      } catch (error) {
        // fall through
      }
    }
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${window.location.host}`;
  }

  function deriveJoinIntentUrl(url, currentSessionId) {
    if (url) {
      try {
        const parsed = new URL(url, window.location.href);
        parsed.search = '';
        parsed.hash = '';
        parsed.pathname = parsed.pathname.replace(/\/join\/?$/, '/join-intent');
        return parsed.toString();
      } catch (error) {
        // fall through
      }
    }

    if (!currentSessionId) return '';
    return `${window.location.origin}/session/${encodeURIComponent(currentSessionId)}/join-intent`;
  }

  function buildInitials(name) {
    return normalizePlayerName(name)
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0].toUpperCase())
      .join('') || 'PL';
  }

  function normalizePlayerName(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').slice(0, MAX_PLAYER_NAME_LENGTH);
  }

  function postBridgeMessage(type, payload = {}) {
    if (window.parent === window) return;
    try {
      window.parent.postMessage({
        source: 'open-box-game',
        type,
        payload
      }, '*');
    } catch (error) {
      // Ignore parent bridge failures.
    }
  }

  function handleSessionEndedNonFatal(reason) {
    _socketReconnect = false;
    clearTimeout(_reconnectTimer);
    clearTimeout(_joinIntentRetryTimer);
    _joinIntentRetryTimer = null;
    _joinIntentState = 'blocked';
    _sessionEndedReason = reason || 'session_ended';
    hideReadyOverlay();
    setActionState('hidden');
    clearTimer();
    clearPill();
    setBadge('b-none', '\u2715 Session Ended');
    setStatus('Session Ended', 'Final leaderboard remains available for review.', G_RED);
    postBridgeMessage('SESSION_ENDED', {
      sessionId: SESSION.sessionId || sessionId,
      reason: _sessionEndedReason
    });
    goTo('s-lb');
  }

  function clearAll() {
    if (timerState.rafId) {
      cancelAnimationFrame(timerState.rafId);
      timerState.rafId = 0;
    }
    while (timeouts.length) clearTimeout(timeouts.pop());
    while (intervals.length) clearInterval(intervals.pop());
  }

  function later(fn, ms) {
    const id = setTimeout(fn, ms);
    timeouts.push(id);
    return id;
  }

  function every(fn, ms) {
    const id = setInterval(fn, ms);
    intervals.push(id);
    return id;
  }

  function setStatus(title, subtitle, titleStyle) {
    els.stTitle.innerHTML = title;
    els.stTitle.style.cssText = titleStyle || G_GOLD;
    els.stSub.innerHTML = subtitle;
  }

  function setBadge(className, text) {
    els.gameBadge.className = `badge ${className}`;
    els.gameBadge.textContent = text;
  }

  function showProg(visible) {
    els.progWrap.style.display = visible ? 'flex' : 'none';
  }

  function setNote(text) {
    els.btnNote.textContent = text;
    els.btnNote.style.display = '';
  }

  function hideOverlays() {
    [els.loading, els.win, els.lose, els.lb].forEach((element) => element.classList.remove('on'));
  }

  function showReadyOverlay() {
    els.readyOverlay.classList.add('on');
    if (_readyTicker) return;
    _readyTicker = setInterval(() => {
      if (!_readyDeadline) return;
      const remaining = Math.max(0, Math.ceil((_readyDeadline - Date.now()) / 1000));
      els.readyTimer.textContent = String(remaining);
    }, 250);
  }

  function hideReadyOverlay() {
    els.readyOverlay.classList.remove('on');
    clearInterval(_readyTicker);
    _readyTicker = null;
  }

  function updateReadyOverlay(status) {
    const joined = Number(status.joinedCount || 0);
    const expected = Number(status.expectedPlayerCount || 0);
    const ready = Number(status.readyCount || 0);
    _readyDeadline = Number(status.readyEndsAt || 0);

    els.readyJoined.textContent = `${joined} / ${expected}`;
    els.readyCount.textContent = String(ready);

    const fullLobby = expected > 0 && joined >= expected;
    const canReady = fullLobby && !_readySubmitted;

    els.readyBtn.disabled = !canReady;
    if (!fullLobby) {
      els.readyTitle.textContent = 'Waiting for Players';
      els.readyCopy.textContent = 'The ready timer starts once every slot in the session has joined.';
      els.readyHint.textContent = 'Waiting for all players to join.';
      els.readyTimer.textContent = '--';
      return;
    }

    els.readyTitle.textContent = 'Ready Check';
    els.readyCopy.textContent = 'Click Ready so the server can release session data to every player.';
    els.readyHint.textContent = _readySubmitted
      ? 'Ready submitted. Waiting for the server to start.'
      : 'Click Ready before the countdown expires.';

    const remaining = _readyDeadline
      ? Math.max(0, Math.ceil((_readyDeadline - Date.now()) / 1000))
      : 0;
    els.readyTimer.textContent = String(remaining);
  }

  function handleFatalError(message) {
    _socketReconnect = false;
    clearTimeout(_reconnectTimer);
    clearTimeout(_joinIntentRetryTimer);
    _joinIntentRetryTimer = null;
    clearAll();
    hideOverlays();
    showReadyOverlay();
    els.readyBtn.disabled = true;
    els.readyTitle.textContent = 'Session Unavailable';
    els.readyCopy.textContent = message;
    els.readyHint.textContent = 'Refresh with a valid join link.';
    els.readyTimer.textContent = '--';
    setStatus('Session Error', message, G_RED);
    console.error('[open-box-multiplayer] fatal:', message);
  }

  function getMissingRequiredElements() {
    return requiredElementNames.filter((name) => !els[name]).sort();
  }

  function getMissingBootstrapFields() {
    const fields = [
      ['joinUrl', joinUrl],
      ['sessionId', sessionId],
      ['playerId', playerId],
      ['playerName', playerName],
      ['ws', wsUrl]
    ];

    return fields
      .filter(([, value]) => !String(value || '').trim())
      .map(([fieldName]) => fieldName);
  }

  function validateRequiredElements() {
    const missing = getMissingRequiredElements();
    if (!missing.length) return true;
    handleFatalError(`Client bootstrap is missing required DOM nodes: ${missing.join(', ')}`);
    return false;
  }

  function validateBootstrapData() {
    const missing = getMissingBootstrapFields();
    if (!missing.length) return true;
    handleFatalError(`Missing required launch values: ${missing.join(', ')}`);
    return false;
  }

  function resetForReplay(payload = {}) {
    clearTimeout(_joinIntentRetryTimer);
    _joinIntentRetryTimer = null;
    clearAll();
    hideOverlays();
    clearTimer();
    clearPill();
    resetSwapRuntime();
    showStageGlow(false);
    showPlayerBox(false);
    hideYBL();
    setActionState('hidden');
    _pendingRoundResult = null;
    _hasEnteredSession = false;
    _readySubmitted = false;
    _readyDeadline = 0;
    _joinIntentState = 'idle';
    _roundSettled = false;
    _sessionEndedReason = '';
    SESSION = {
      ...SESSION,
      sessionId: payload.sessionId || SESSION.sessionId,
      roundId: payload.roundId || null,
      totalPlayers: Number(payload.expectedPlayerCount || SESSION.totalPlayers || 0)
    };
    showReadyOverlay();
    els.readyBtn.disabled = true;
    els.readyTitle.textContent = 'Replay Starting';
    els.readyCopy.textContent = 'Rejoining the next round.';
    els.readyHint.textContent = 'Waiting for players to re-enter the lobby.';
    els.readyTimer.textContent = '--';
    setStatus('Replay Starting', 'Rejoining the next round...', G_GOLD);
  }

  async function submitJoinIntent() {
    if (_joinIntentState === 'pending' || _joinIntentState === 'done') return;

    clearTimeout(_joinIntentRetryTimer);
    _joinIntentRetryTimer = null;
    _joinIntentState = 'pending';
    showReadyOverlay();
    els.readyTitle.textContent = 'Joining Session';
    els.readyCopy.textContent = `Confirming ${playerName} in session ${sessionId}.`;
    els.readyHint.textContent = 'Waiting for the server lobby state.';
    els.readyTimer.textContent = '--';

    try {
      const response = await fetch(joinIntentUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ playerId, playerName })
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        const message = payload.error || `Unable to join session (${response.status})`;
        if (response.status >= 500) {
          throw new Error(message);
        }
        _joinIntentState = 'blocked';
        handleFatalError(message);
        return;
      }

      _joinIntentState = 'done';
      els.readyTitle.textContent = 'Connected';
      els.readyCopy.textContent = `Session ${sessionId} joined as ${playerName}.`;
      els.readyHint.textContent = 'Waiting for the server lobby state.';
      if (payload.joinDeadlineAt) {
        _readyDeadline = Number(payload.joinDeadlineAt || 0);
      }
      postBridgeMessage('SESSION_JOINED', {
        sessionId: SESSION.sessionId || sessionId,
        playerId,
        playerName
      });
    } catch (error) {
      _joinIntentState = 'idle';
      els.readyTitle.textContent = 'Joining Session';
      els.readyCopy.textContent = 'Unable to confirm your session entry. Retrying...';
      els.readyHint.textContent = 'Keeping your connection alive.';
      els.readyTimer.textContent = '--';
      _joinIntentRetryTimer = setTimeout(() => {
        submitJoinIntent().catch((caughtError) => {
          console.error('[open-box-multiplayer] join-intent retry failed:', caughtError);
        });
      }, 1200);
    }
  }

  function scheduleViewportFit() {
    if (viewportFit.rafId) cancelAnimationFrame(viewportFit.rafId);
    viewportFit.rafId = requestAnimationFrame(() => {
      viewportFit.rafId = 0;
      applyViewportFit();
    });
  }

  function applyViewportFit() {
    const vv = window.visualViewport;
    const vw = vv ? vv.width : window.innerWidth;
    const vh = vv ? vv.height : window.innerHeight;
    const stageStyles = getComputedStyle(els.shellStage);
    const padX = parseFloat(stageStyles.paddingLeft) + parseFloat(stageStyles.paddingRight);
    const padY = parseFloat(stageStyles.paddingTop) + parseFloat(stageStyles.paddingBottom);
    const availableWidth = Math.max(0, vw - padX);
    const availableHeight = Math.max(0, vh - padY);
    const deviceWidth = els.phone.offsetWidth || 390;
    const deviceHeight = els.phone.offsetHeight || 760;
    const scale = Math.min(1, availableWidth / deviceWidth, availableHeight / deviceHeight) || 1;
    viewportFit.scale = scale;
    els.shellFit.style.width = `${deviceWidth * scale}px`;
    els.shellFit.style.height = `${deviceHeight * scale}px`;
    els.phone.style.transform = `scale(${scale})`;
  }

  function computeLayout() {
    if (!els.arena || !els.trackWrap || !els.trackSvg || !els.trackCalcPath) {
      throw new Error('Layout bootstrap failed: arena, trackWrap, trackSvg, or trackCalcPath is missing.');
    }
    const arenaWidth = els.arena.offsetWidth / 16;
    const arenaHeight = els.arena.offsetHeight / 16;
    const trackHeight = els.trackSvg.offsetHeight / 16;
    const trackY = (els.arena.offsetHeight - els.trackWrap.offsetHeight) / 16;
    const playerHalfBox = 3;
    const pathLength = els.trackCalcPath.getTotalLength();
    const ptAt = (t) => {
      const point = els.trackCalcPath.getPointAtLength(t * pathLength);
      return {
        l: (point.x * (arenaWidth / 390)) - playerHalfBox,
        t: trackY + (point.y * (trackHeight / 110)) - playerHalfBox
      };
    };
    layout = {
      AW: arenaWidth,
      AH: arenaHeight,
      TH: trackHeight,
      TY: trackY,
      PBH: playerHalfBox,
      stageL: arenaWidth / 2 - playerHalfBox,
      stageT: arenaHeight * 0.28,
      trackRight: ptAt(0.02),
      trackCenter: ptAt(0.5),
      trackLeft: ptAt(0.98),
      trackPt: ptAt
    };
  }

  function snapTo(element, left, top) {
    element.style.left = `${left}rem`;
    element.style.top = `${top}rem`;
    element.style.transform = '';
  }

  function showPlayerBox(visible) {
    els.playerBox.style.opacity = visible ? '1' : '0';
  }

  function showStageGlow(visible) {
    els.stageGlow.classList.toggle('on', visible);
  }

  function setStageGlowPos() {
    els.stageGlow.style.left = `${layout.stageL + layout.PBH}rem`;
    els.stageGlow.style.top = `${layout.stageT + layout.PBH}rem`;
  }

  function showYBL(left, top) {
    els.ybLabel.style.left = `${left + layout.PBH}rem`;
    els.ybLabel.style.top = `${top - 1.125}rem`;
    els.ybLabel.classList.add('on');
  }

  function hideYBL() {
    els.ybLabel.classList.remove('on');
  }

  function resetBoxClasses() {
    els.playerBox.classList.remove('stage-idle', 'waiting', 'locked', 'lock-in', 'no-match-flash', 'shake');
  }

  function setActionState(state) {
    els.keepBtn.className = 'btn-swap btn-keep disabled';
    els.swapBtn.className = 'btn-swap btn-swap-main disabled';
    els.keepBtn.disabled = true;
    els.swapBtn.disabled = true;
    els.keepBtn.onclick = null;
    els.swapBtn.onclick = null;
    els.keepBtn.textContent = 'Keep Box';
    els.swapBtn.innerHTML = 'Swap Box';
    els.keepBtn.style.display = '';
    els.swapBtn.style.display = '';
    els.swapActions.classList.remove('solo');

    if (state === 'both-active') {
      els.keepBtn.className = 'btn-swap btn-keep active';
      els.swapBtn.className = 'btn-swap btn-swap-main active';
      els.keepBtn.disabled = false;
      els.swapBtn.disabled = false;
      els.keepBtn.onclick = onKeepClick;
      els.swapBtn.onclick = onSwapClick;
      return;
    }

    if (state === 'keep-only') {
      els.swapBtn.style.display = 'none';
      els.swapActions.classList.add('solo');
      els.keepBtn.className = 'btn-swap btn-keep disabled';
      els.keepBtn.textContent = '\u{1F512} Box Kept';
      return;
    }

    if (state === 'swap-waiting') {
      els.keepBtn.style.display = 'none';
      els.swapActions.classList.add('solo');
      els.swapBtn.className = 'btn-swap btn-swap-main waiting';
      els.swapBtn.innerHTML = 'Searching<span class="dots"><span></span><span></span><span></span></span>';
      return;
    }

    if (state === 'hidden') {
      els.keepBtn.style.display = 'none';
      els.swapBtn.style.display = 'none';
    }
  }

  function renderTimer(seconds, cls, label) {
    els.hudRight.innerHTML = `<div class="t-wrap"><div class="t-ring"><svg viewBox="0 0 52 52" width="48" height="48"><circle class="t-trk" cx="26" cy="26" r="19"></circle><circle class="t-prg ${cls}" cx="26" cy="26" r="19" id="tRing"></circle></svg><div class="t-num ${cls}" id="tNum">${seconds}</div></div><div class="t-lbl">${label || 'Swap'}</div></div>`;
    timerState.theme = cls || 'gold';
    timerState.label = label || 'Swap';
    syncTimerRing(getCurrentSwapRemainingMs());
  }

  function clearTimer() {
    if (timerState.rafId) {
      cancelAnimationFrame(timerState.rafId);
      timerState.rafId = 0;
    }
    els.hudRight.innerHTML = '<div class="t-ghost"></div>';
  }

  function setTimerTheme(theme, label) {
    timerState.theme = theme || timerState.theme;
    timerState.label = label || timerState.label;
    const ring = document.getElementById('tRing');
    const number = document.getElementById('tNum');
    const timerLabel = els.hudRight.querySelector('.t-lbl');
    if (ring) ring.className = `t-prg ${timerState.theme}`;
    if (number) number.className = `t-num ${timerState.theme}`;
    if (timerLabel) timerLabel.textContent = timerState.label;
  }

  function resetSwapRuntime() {
    swapWindowTotal = Math.max(1, Number(SESSION.swapWindowSeconds) || 10);
    swapSecs = swapWindowTotal;
    swapPhase = 'idle';
  }

  function getCurrentSwapRemainingMs() {
    const endsAt = Number(SESSION.swapEndsAt || 0);
    if (!Number.isFinite(endsAt) || endsAt <= 0) {
      return Math.max(0, swapSecs * 1000);
    }
    return Math.max(0, endsAt - Date.now());
  }

  function getCurrentSwapSeconds() {
    return Math.max(0, Math.ceil(getCurrentSwapRemainingMs() / 1000));
  }

  function syncTimerRing(remainingMs) {
    const currentRemainingMs = typeof remainingMs === 'number' ? Math.max(0, remainingMs) : getCurrentSwapRemainingMs();
    const ring = document.getElementById('tRing');
    const number = document.getElementById('tNum');
    const ratio = currentRemainingMs / Math.max(1, swapWindowTotal * 1000);
    swapSecs = Math.max(0, Math.ceil(currentRemainingMs / 1000));
    if (ring) {
      ring.style.strokeDashoffset = 119.4 * (1 - ratio);
    }
    if (number) {
      number.textContent = String(swapSecs);
    }
    setTimerTheme(timerState.theme, timerState.label);
  }

  function startTimerRenderLoop() {
    if (timerState.rafId) {
      cancelAnimationFrame(timerState.rafId);
      timerState.rafId = 0;
    }
    const tick = () => {
      const remainingMs = getCurrentSwapRemainingMs();
      syncTimerRing(remainingMs);
      if (remainingMs <= 0) {
        timerState.rafId = 0;
        clearAll();
        onSwapTimerEnd();
        return;
      }
      timerState.rafId = requestAnimationFrame(tick);
    };
    tick();
  }

  function startSwapTimer(theme, label, isReset) {
    if (isReset !== false) {
      swapWindowTotal = Math.max(1, Number(SESSION.swapWindowSeconds) || 10);
      swapSecs = Math.max(0, getCurrentSwapSeconds());
    }
    renderTimer(Math.max(0, getCurrentSwapSeconds()), theme || 'gold', label || 'Swap');
    startTimerRenderLoop();
  }

  function showPill(type, title, desc) {
    els.btnNote.style.display = 'none';
    setActionState('hidden');
    const old = document.getElementById('actionPill');
    if (old) old.remove();
    const pill = document.createElement('div');
    const icons = { keep: '\u{1F512}', found: '\u{1F91D}', none: '\u274C' };
    pill.id = 'actionPill';
    pill.className = `r-pill rp-${type}`;
    pill.innerHTML = `<div class="rp-icon">${icons[type] || '\u2756'}</div><div><div class="rp-title">${title}</div><div class="rp-desc">${desc || ''}</div></div>`;
    document.querySelector('.action-bar').appendChild(pill);
  }

  function clearPill() {
    els.btnNote.style.display = '';
    document.getElementById('actionPill')?.remove();
  }

  function buildContainers(total, size) {
    const list = [];
    const labels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (let index = 0; index < total; index += size) {
      const start = index + 1;
      const end = Math.min(index + size, total);
      const boxes = Array.from({ length: end - start + 1 }, (_, boxIndex) => start + boxIndex);
      list.push({
        id: list.length,
        label: labels[list.length] || String(list.length + 1),
        start,
        end,
        boxes,
        count: boxes.length
      });
    }
    return list;
  }

  function findPlayerContainer(list, boxNumber) {
    return list.findIndex((container) => boxNumber >= container.start && boxNumber <= container.end);
  }

  function enterDistribute(session) {
    SESSION = { ...SESSION, ...session };
    _roundSettled = false;
    _sessionEndedReason = '';
    hideReadyOverlay();
    hideOverlays();
    clearAll();
    resetSwapRuntime();
    els.carouselVp.style.opacity = '1';
    els.carouselTrack.style.transform = 'translateX(0)';
    showPlayerBox(false);
    hideYBL();
    clearTimer();
    clearPill();
    showProg(true);
    showStageGlow(false);
    els.playerAv.textContent = SESSION.playerInitials;
    els.playerName.textContent = SESSION.playerName;
    els.playerStake.textContent = `${SESSION.stakeAmount} stake`;
    els.sessionCtrTxt.textContent = `${SESSION.totalPlayers} players \u00B7 ${SESSION.totalPlayers} boxes in session`;
    els.lbSession.innerHTML = `Session ${SESSION.sessionId || '--'}<br>Round Results`;
    setActionState('hidden');
    setBadge('b-dist', '\u{1F4E6} Distributing Boxes');
    setStatus('Delivering to Players', 'Scanning vault for your box\u2026');
    els.progFill.style.width = '0%';
    els.progLabel.textContent = 'Preparing containers\u2026';
    try {
      computeLayout();
    } catch (error) {
      handleFatalError(error.message || String(error));
      return;
    }
    containers = buildContainers(SESSION.totalPlayers, SESSION.containerSize);
    playerContainerIdx = findPlayerContainer(containers, SESSION.playerBox);
    buildCarousel();
    later(() => scrollCarousel(0), 400);
  }

  function buildCarousel() {
    els.carouselTrack.innerHTML = '';
    els.carouselDots.innerHTML = '';
    containers.forEach((container, index) => {
      const card = document.createElement('div');
      card.className = 'ctn-card';
      card.id = `ctn-${index}`;
      card.innerHTML = `<div class="ctn-header"><div><div class="ctn-id">Container ${container.label}</div><div class="ctn-range">${container.start}-${container.end}</div></div><div><div class="ctn-badge">SEALED</div><div class="ctn-count">${container.count} boxes</div></div></div><div class="ctn-grid" id="ctn-grid-${index}"></div>`;
      els.carouselTrack.appendChild(card);
      const dot = document.createElement('div');
      dot.className = 'cdot';
      dot.id = `cdot-${index}`;
      els.carouselDots.appendChild(dot);
    });
    els.carouselDots.classList.remove('off');
    els.carouselDots.classList.add('on');
    hydrateVisibleContainers(0);
  }

  const CARD_WIDTH = 13.625;
  const CARD_GAP = 1;
  const CARD_STEP = CARD_WIDTH + CARD_GAP;
  const VISIBLE_RADIUS = 1;

  function hydrateVisibleContainers(current) {
    containers.forEach((_, index) => {
      const grid = document.getElementById(`ctn-grid-${index}`);
      if (!grid || grid.dataset.mode === 'open') return;
      if (Math.abs(index - current) > VISIBLE_RADIUS) {
        grid.innerHTML = '';
        delete grid.dataset.mode;
        return;
      }
      if (grid.dataset.mode === 'peek') return;
      grid.innerHTML = '';
      containers[index].boxes.forEach((boxNumber) => {
        const box = document.createElement('div');
        box.className = 'ctn-box peek shown';
        box.innerHTML = `<div class="ctn-box-num">${boxNumber}</div>`;
        grid.appendChild(box);
      });
      grid.dataset.mode = 'peek';
    });
  }

  function scrollCarousel(index) {
    els.progFill.style.width = `${((index + 1) / containers.length) * 100}%`;
    els.progLabel.textContent = `Scanning container ${containers[index].label} of ${containers.length}\u2026`;
    const phoneHalfWidth = (els.phone.offsetWidth / 16) / 2;
    const offset = -(index * CARD_STEP) + (phoneHalfWidth - CARD_WIDTH / 2 - 5.375);
    els.carouselTrack.style.transform = `translateX(${offset}rem)`;
    hydrateVisibleContainers(index);

    if (index > 0) {
      document.getElementById(`ctn-${index - 1}`)?.classList.add('passed');
      document.getElementById(`cdot-${index - 1}`)?.classList.remove('active');
    }
    document.getElementById(`cdot-${index}`)?.classList.add('active');

    later(() => {
      if (index === playerContainerIdx) {
        document.getElementById(`ctn-${index}`)?.classList.add('selected');
        document.getElementById(`ctn-${index}`)?.querySelector('.ctn-badge')?.replaceChildren(document.createTextNode('YOUR BOX HERE'));
        els.progLabel.textContent = `Container ${containers[index].label} \u2014 Box ${SESSION.playerBox} found!`;
        later(() => openContainer(index), 600);
      } else if (index + 1 < containers.length) {
        scrollCarousel(index + 1);
      }
    }, index === playerContainerIdx ? 900 : 480);
  }

  function openContainer(containerIndex) {
    const container = containers[containerIndex];
    const grid = document.getElementById(`ctn-grid-${containerIndex}`);
    grid.innerHTML = '';
    grid.dataset.mode = 'open';
    els.progLabel.textContent = `Opening container ${container.label}\u2026`;
    container.boxes.forEach((boxNumber, index) => {
      const box = document.createElement('div');
      box.className = 'ctn-box';
      box.id = `ctnbox-${boxNumber}`;
      if (boxNumber === SESSION.playerBox) box.classList.add('is-player');
      box.innerHTML = `<div class="ctn-box-num">${boxNumber}</div>`;
      grid.appendChild(box);
      later(() => box.classList.add('shown'), index * 55 + 100);
    });
    later(() => {
      els.progLabel.textContent = '\u2713 Your box is ready!';
      later(() => flyBoxFromContainer(), 700);
    }, container.boxes.length * 55 + 250);
  }

  function flyBoxFromContainer() {
    const miniBox = document.getElementById(`ctnbox-${SESSION.playerBox}`);
    if (!miniBox) {
      later(enterSwap, 500);
      return;
    }
    const arenaBox = els.arena.getBoundingClientRect();
    const miniBoxRect = miniBox.getBoundingClientRect();
    const scale = viewportFit.scale || 1;
    const fromLeft = (miniBoxRect.left - arenaBox.left) / (16 * scale);
    const fromTop = (miniBoxRect.top - arenaBox.top) / (16 * scale);
    const fromSize = miniBoxRect.width / (16 * scale);
    miniBox.style.opacity = '0';
    showYBL(fromLeft + fromSize / 2 - layout.PBH, fromTop);
    resetBoxClasses();
    els.playerNum.textContent = SESSION.playerBox;
    snapTo(els.playerBox, layout.stageL, layout.stageT);
    const dx = fromLeft - (layout.PBH - fromSize / 2) - layout.stageL;
    const dy = fromTop - (layout.PBH - fromSize / 2) - layout.stageT;
    const scaleFactor = fromSize / 6;
    els.playerBox.style.transform = `translate(${dx}rem,${dy}rem) scale(${scaleFactor})`;
    els.playerBox.style.transition = 'none';
    showPlayerBox(true);
    later(() => {
      hideYBL();
      els.playerBox.style.transition = 'transform 540ms cubic-bezier(0.45,0,0.55,1)';
      els.playerBox.style.transform = 'translate(0,0) scale(1)';
      later(() => {
        els.playerBox.style.transition = '';
        els.playerBox.style.transform = '';
        els.playerBox.classList.add('stage-idle');
        setStageGlowPos();
        showStageGlow(true);
        showYBL(layout.stageL, layout.stageT);
        later(() => {
          hideYBL();
          els.carouselDots.classList.replace('on', 'off');
          later(() => {
            els.carouselVp.style.opacity = '0';
            later(enterSwap, 350);
          }, 300);
        }, 1000);
      }, 560);
    }, 120);
  }

  function enterSwap() {
    clearAll();
    els.carouselVp.style.opacity = '0';
    showProg(false);
    resetSwapRuntime();
    swapPhase = 'choice';
    resetBoxClasses();
    els.playerNum.textContent = SESSION.playerBox;
    els.playerBox.classList.add('stage-idle');
    setStageGlowPos();
    showStageGlow(true);
    clearPill();
    setBadge('b-swap', '\u26A1 Swap Phase');
    setStatus('Your Box is Ready', 'Keep it \u2014 or risk a swap');
    setActionState('both-active');
    setNote('Choose before time runs out.');
    bus.off('swap_result');
    bus.on('swap_result', onServerSwapResult);
    swapWindowTotal = Math.max(1, Number(SESSION.swapWindowSeconds) || 10);
    swapSecs = Math.max(0, getCurrentSwapSeconds());
    startSwapTimer('gold', 'Swap', false);
  }

  function onKeepClick() {
    if (swapPhase !== 'choice') return;
    swapPhase = 'locked';
    bus.send('keep_box');
    resetBoxClasses();
    els.playerBox.classList.add('lock-in');
    later(() => {
      els.playerBox.classList.remove('lock-in');
      els.playerBox.classList.add('locked', 'stage-idle');
    }, 560);
    setTimerTheme('gold', 'Locked');
    setBadge('b-swap', '\u{1F512} Box Locked');
    setStatus('Box Locked In', 'Your original box is confirmed for this round.');
    setActionState('keep-only');
    setNote('Waiting for round to end\u2026');
  }

  function onSwapClick() {
    if (swapPhase !== 'choice') return;
    swapPhase = 'waiting';
    resetBoxClasses();
    els.playerBox.classList.add('waiting');
    showStageGlow(false);
    setTimerTheme('blue', 'Matching');
    setBadge('b-wait', '\u23F3 Finding Match');
    setStatus('Swap Request Sent', 'Searching for a player<br>willing to swap\u2026', G_BLUE);
    setActionState('swap-waiting');
    setNote('Request active until timer ends');
    bus.send('swap_request', { remainingMs: getCurrentSwapRemainingMs() });
  }

  function onServerSwapResult(data) {
    if (data.outcome === 'found') {
      animateFound(Number(data.partnerBox));
    } else {
      resolveNoMatch(false);
    }
  }

  function applySoftLockState(data = {}) {
    const priorSwapState = String(data.priorSwapState || 'NONE').toUpperCase();
    if (priorSwapState === 'PENDING') {
      if (swapPhase === 'found' || swapPhase === 'no_match') return;
      swapPhase = 'waiting';
      resetBoxClasses();
      els.playerNum.textContent = Number(data.finalBox || SESSION.playerBox);
      SESSION.playerBox = Number(data.finalBox || SESSION.playerBox);
      els.playerBox.classList.add('waiting');
      showStageGlow(false);
      setTimerTheme('blue', 'Matching');
      setBadge('b-wait', '\u23F3 Finding Match');
      setStatus('Softlock Active', 'New actions are closed. Searching final swap matches\u2026', G_BLUE);
      setActionState('swap-waiting');
      setNote('Softlock active. Pending swaps can still resolve.');
      return;
    }
    if (swapPhase === 'found' || swapPhase === 'locked') return;
    swapPhase = 'locked';
    resetBoxClasses();
    els.playerNum.textContent = Number(data.finalBox || SESSION.playerBox);
    SESSION.playerBox = Number(data.finalBox || SESSION.playerBox);
    els.playerBox.classList.add('locked', 'stage-idle');
    setStageGlowPos();
    showStageGlow(true);
    setTimerTheme('gold', 'Locked');
    setBadge('b-swap', '\u{1F512} Box Locked');
    setStatus('Softlock Active', 'The final stretch has started. Your current box is locked in.', G_GOLD);
    setActionState('keep-only');
    setNote('Softlock active until round close.');
  }

  function animateFound(partnerBox) {
    if (swapPhase !== 'waiting') return;
    swapPhase = 'found';
    els.playerBox.classList.remove('waiting');
    els.playerBox.classList.add('shake');
    later(() => {
      els.playerBox.classList.remove('shake');
      showStageGlow(false);
      els.playerBox.style.transition = 'transform 300ms cubic-bezier(0.55,0,1,0.45), opacity 200ms 200ms ease';
      els.playerBox.style.transform = `translateX(${-(layout.PBH * 2 + 1 + layout.stageL + layout.PBH)}rem)`;
      later(() => {
        els.playerBox.style.opacity = '0';
      }, 200);
      later(() => {
        els.playerNum.textContent = partnerBox;
        SESSION.playerBox = partnerBox;
        snapTo(els.playerBox, layout.stageL, layout.stageT);
        els.playerBox.style.opacity = '1';
        els.playerBox.style.transform = '';
        els.playerBox.style.transition = '';
        resetBoxClasses();
        els.playerBox.classList.add('stage-idle');
        setStageGlowPos();
        showStageGlow(true);
        setTimerTheme('gold', 'Locked');
        setBadge('b-found', '\u2713 Swap Complete');
        setStatus('Swap Successful!', `Your new box is <strong style="color:var(--gold-bright);">Box ${partnerBox}</strong>!`, G_TEAL);
        showPill('found', 'Swap Complete', `Box ${partnerBox} locked in. Waiting for round to close.`);
      }, 540);
    }, 580);
  }

  function resolveNoMatch(timerExpired) {
    if (swapPhase !== 'waiting' && swapPhase !== 'no_match') return;
    swapPhase = 'no_match';
    els.playerBox.classList.remove('waiting');
    els.playerBox.classList.add('no-match-flash');
    later(() => {
      els.playerBox.classList.remove('no-match-flash');
      els.playerBox.classList.add('stage-idle');
      setStageGlowPos();
      showStageGlow(true);
      els.playerNum.textContent = SESSION.playerBox;
      setTimerTheme('gold', 'Locked');
      setBadge('b-none', '\u2715 No Match Found');
      setStatus('No Swap Found', 'No player matched your request.<br>Your original box is kept.', G_RED);
      setActionState('keep-only');
      setNote('Waiting for round to end\u2026');
      showPill('none', 'No Match', `Box ${SESSION.playerBox} stays \u2014 your original box is locked in.`);
      if (timerExpired) later(startLoading, 1200);
    }, 1800);
  }

  function onSwapTimerEnd() {
    bus.send('timer_end');
    if (swapPhase === 'choice') {
      swapPhase = 'locked';
      resetBoxClasses();
      els.playerBox.classList.add('lock-in');
      later(() => {
        els.playerBox.classList.remove('lock-in');
        els.playerBox.classList.add('locked', 'stage-idle');
      }, 560);
      later(startLoading, 1200);
      return;
    }
    if (swapPhase === 'waiting') {
      swapPhase = 'no_match';
      resolveNoMatch(true);
      return;
    }
    later(startLoading, 800);
  }

  function startLoading() {
    clearAll();
    hideOverlays();
    _pendingRoundResult = null;
    els.loading.classList.add('on');
    els.loadingSegs.innerHTML = '';
    els.loadingAwait.classList.remove('on');

    const segments = [];
    for (let index = 0; index < 5; index += 1) {
      const segment = document.createElement('div');
      segment.className = 'ls-seg';
      const fill = document.createElement('div');
      fill.className = 'ls-seg-fill';
      segment.appendChild(fill);
      els.loadingSegs.appendChild(segment);
      segments.push(fill);
    }

    const icons = ['\u{1F4E6}', '\u{1F381}', '\u2728', '\u{1F381}', '\u23F3'];
    const titles = ['Opening Boxes', 'Revealing Prizes', 'Checking Winners', 'Calculating Payouts', 'Awaiting Confirmation\u2026'];
    const stepMs = 1400;
    let stepIndex = 0;

    bus.off('round_result');
    bus.on('round_result', onRoundResultReceived);

    function step() {
      if (stepIndex >= segments.length) {
        els.loadingAwait.classList.add('on');
        tryResolveLoading();
        return;
      }
      els.loadingIcon.textContent = icons[stepIndex];
      els.loadingTitle.textContent = titles[stepIndex];
      segments[stepIndex].style.transition = `width ${stepMs}ms ease`;
      segments[stepIndex].style.width = '100%';
      stepIndex += 1;
      later(step, stepMs);
    }

    later(step, 300);
  }

  function onRoundResultReceived(data) {
    _roundSettled = true;
    _sessionEndedReason = '';
    _pendingRoundResult = data;
    postBridgeMessage('REPLAY_WAITING', {
      sessionId: SESSION.sessionId || sessionId,
      result: data.result,
      finalBox: data.finalBox,
      prize: Number(data.prize || 0)
    });
    tryResolveLoading();
  }

  function tryResolveLoading() {
    if (!_pendingRoundResult) return;
    if (!els.loadingAwait.classList.contains('on')) return;
    els.loadingAwait.classList.remove('on');
    later(() => {
      const data = _pendingRoundResult;
      _pendingRoundResult = null;
      bus.off('round_result', onRoundResultReceived);
      goTo(data.result === 'win' ? 's-win' : 's-lose', data);
    }, 400);
  }

  function countdown(target, seconds, done) {
    let remaining = seconds;
    target.textContent = String(remaining);
    every(() => {
      remaining -= 1;
      target.textContent = String(remaining);
      if (remaining <= 0) {
        clearAll();
        done();
      }
    }, 1000);
  }

  function spawnConfetti() {
    els.confLayer.innerHTML = '';
    const count = isLowEnd ? 20 : 35;
    const colors = ['#ffd84d', '#e8b020', '#c9920a', '#ff4455', '#ffffff', '#00ffaa', '#88aaff', '#ffaacc'];
    for (let index = 0; index < count; index += 1) {
      const particle = document.createElement('div');
      particle.className = 'cp';
      const size = `${((5 + Math.random() * 10) / 16).toFixed(3)}rem`;
      particle.style.left = `${(Math.random() * 100).toFixed(1)}%`;
      particle.style.background = colors[Math.floor(Math.random() * colors.length)];
      particle.style.width = size;
      particle.style.height = size;
      particle.style.borderRadius = Math.random() > 0.5 ? '50%' : '.1875rem';
      particle.style.animationDuration = `${(1.4 + Math.random() * 2).toFixed(2)}s`;
      particle.style.animationDelay = `${(Math.random() * 0.9).toFixed(2)}s`;
      els.confLayer.appendChild(particle);
    }
  }

  function enterWin(data) {
    els.winAmount.textContent = data.prize > 0 ? `\u20A6${Number(data.prize).toLocaleString()}` : '\u20A60';
    els.winDetail.textContent = `Box ${data.finalBox} \u00B7 Your prize`;
    spawnConfetti();
    countdown(els.winSecs, 5, () => goTo('s-lb'));
  }

  function enterLose(data) {
    els.loseDetail.textContent = `Box ${data.finalBox} was empty`;
    countdown(els.loseSecs, 5, () => goTo('s-lb'));
  }

  function buildLeaderboard() {
    const handleData = (data) => {
      bus.off('leaderboard_data', handleData);
      els.lbMeta.textContent = `${data.totalPlayers} Players \u00B7 ${_sessionEndedReason ? 'Session Ended' : 'Round Complete'}`;
      els.lbPoolVal.textContent = `\u20A6${Number(data.rewardPool || 0).toLocaleString()}`;
      els.lbSession.innerHTML = `Session ${SESSION.sessionId || '--'}<br>${_sessionEndedReason ? 'Final Leaderboard' : 'Round Results'}`;
      els.lbList.innerHTML = '';
      const sorted = [...data.players].sort((a, b) => (a.win !== b.win ? (a.win ? -1 : 1) : b.prize - a.prize));
      sorted.forEach((player) => {
        const row = document.createElement('div');
        row.className = `lb-row ${player.win ? 'w' : 'l'}${player.you ? ' you' : ''}`;
        const originalWasPrize = data.players.some((entry) => entry.curBox === player.origBox && entry.win);
        const boxHtml = player.swapped
          ? `<div class="lb-boxes"><div class="lb-cbox old${originalWasPrize ? ' was-prize' : ''}"><div class="lb-cbox-num">${player.origBox}</div></div><span class="lb-swap-arrow">&gt;</span><div class="lb-cbox"><div class="lb-cbox-num">${player.curBox}</div></div></div>`
          : `<div class="lb-boxes"><div class="lb-cbox"><div class="lb-cbox-num">${player.curBox}</div></div></div>`;
        row.innerHTML = `<div class="lb-av">${player.init}</div><div class="lb-info"><div class="lb-name-row"><div class="lb-nm">${player.name}</div>${player.you ? '<span class="lb-you-tag">YOU</span>' : ''}</div>${boxHtml}</div><div class="lb-prize">${player.win ? `\u20A6${Number(player.prize).toLocaleString()}` : '--'}</div>`;
        els.lbList.appendChild(row);
      });
    };

    bus.off('leaderboard_data', handleData);
    bus.on('leaderboard_data', handleData);
    bus.send('leaderboard_request');
  }

  function goTo(id, data) {
    clearAll();
    hideOverlays();
    if (id === 's-win') {
      els.win.classList.add('on');
      enterWin(data);
      return;
    }
    if (id === 's-lose') {
      els.lose.classList.add('on');
      enterLose(data);
      return;
    }
    if (id === 's-lb') {
      els.lb.classList.add('on');
      buildLeaderboard();
      return;
    }
    if (id === 's-loading') {
      startLoading();
    }
  }

  window.goTo = goTo;

  bus.on('welcome', (data) => {
    showReadyOverlay();
    els.readyTitle.textContent = 'Connected';
    els.readyCopy.textContent = `Session ${data.sessionId} joined as ${playerName}.`;
    els.playerAv.textContent = buildInitials(playerName);
    els.playerName.textContent = playerName;
    submitJoinIntent().catch((error) => {
      handleFatalError(error.message || 'Unable to register player for the session.');
    });
  });

  bus.on('ready_status', updateReadyOverlay);
  bus.on('replay_started', (payload) => {
    resetForReplay(payload);
    submitJoinIntent().catch((error) => {
      handleFatalError(error.message || 'Unable to rejoin the replay round.');
    });
  });
  bus.on('softlock', applySoftLockState);

  bus.on('session_init', (session) => {
    if (_hasEnteredSession && session.roundId === SESSION.roundId) return;
    _hasEnteredSession = true;
    enterDistribute(session);
  });

  bus.on('error', (message) => {
    if (message.code === 'SESSION_ENDED') {
      if (_roundSettled || _pendingRoundResult || els.win.classList.contains('on') || els.lose.classList.contains('on') || els.lb.classList.contains('on')) {
        handleSessionEndedNonFatal(message.message || message.code);
        return;
      }
      handleFatalError(message.message || message.code);
      return;
    }
    const terminalCodes = new Set([
      'SESSION_NOT_FOUND',
      'SESSION_RUNNING_NO_NEW_JOINS',
      'SESSION_FULL',
      'INVALID_ID_OR_NAME',
      'PLAYER_NOT_REGISTERED'
    ]);
    if (terminalCodes.has(message.code)) {
      handleFatalError(message.message || message.code);
      return;
    }
    if (message.code === 'SOFTLOCK_ACTIVE') {
      applySoftLockState({
        finalBox: SESSION.playerBox,
        priorSwapState: swapPhase === 'waiting' ? 'PENDING' : 'NONE'
      });
      return;
    }
    setStatus('Server Error', message.message || message.code || 'Unknown error', G_RED);
  });

  els.readyBtn.addEventListener('click', () => {
    if (_readySubmitted) return;
    _readySubmitted = true;
    els.readyBtn.disabled = true;
    els.readyHint.textContent = 'Ready submitted. Waiting for the server to start.';
    bus.send('ready_up', { playerId });
  });

  window.addEventListener('load', () => {
    if (!validateRequiredElements()) return;
    if (!validateBootstrapData()) return;
    scheduleViewportFit();
    showReadyOverlay();
    bus.connect();
  }, { once: true });

  window.addEventListener('resize', scheduleViewportFit, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', scheduleViewportFit, { passive: true });
  }
})();
