'use strict';

const SCOPES = 'https://www.googleapis.com/auth/calendar.readonly';
const STORAGE_KEY_TOKEN = 'gcal_alarm_token';
const STORAGE_KEY_GEMINI = 'gcal_gemini_key';
const STORAGE_KEY_AI_AUTO = 'gcal_ai_auto';
const ALARM_OFFSETS = [15, 5];
const CAL_COLORS = ['#039BE5','#33B679','#D50000','#F6BF26','#F4511E','#0B8043','#8E24AA','#616161'];
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

let accessToken = null;
let activeAlarms = {};
let eventsCache = [];
let tickInterval = null;

// ── Bootstrap ─────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
  // 設定の復元
  const geminiKey = localStorage.getItem(STORAGE_KEY_GEMINI);
  if (geminiKey) document.getElementById('gemini-key-input').value = geminiKey;
  document.getElementById('ai-auto-analyze').checked =
    localStorage.getItem(STORAGE_KEY_AI_AUTO) === 'true';

  const stored = localStorage.getItem(STORAGE_KEY_TOKEN);
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (parsed.expires_at && Date.now() < parsed.expires_at) {
        accessToken = parsed.access_token;
        setUserInfo(parsed.name, parsed.picture);
        showScreen('main');
        loadEvents();
        startTick();
        return;
      }
    } catch (_) {}
  }

  showScreen('login');
  // GISライブラリが読み込まれたらSignInボタンを描画
  waitForGSI(initGoogleSignInButton);
});

function initGoogleSignInButton() {
  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: onGoogleSignIn,
    auto_select: false
  });
  google.accounts.id.renderButton(
    document.getElementById('google-signin-btn'),
    { type: 'standard', size: 'large', theme: 'outline',
      text: 'signin_with', shape: 'pill', locale: 'ja', width: 280 }
  );
}

// ── Google Sign-In ────────────────────────────────────────────────────────────

window.onGoogleSignIn = function(response) {
  const payload = parseJwt(response.credential);
  const name = payload.name || '';
  const picture = payload.picture || '';

  waitForGSI(() => {
    const tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPES,
      callback: (tokenResp) => {
        if (tokenResp.error) { alert('ログインに失敗しました: ' + tokenResp.error); return; }
        accessToken = tokenResp.access_token;
        const expiresIn = parseInt(tokenResp.expires_in || 3600, 10);
        localStorage.setItem(STORAGE_KEY_TOKEN, JSON.stringify({
          access_token: accessToken,
          expires_at: Date.now() + expiresIn * 1000,
          name, picture
        }));
        setUserInfo(name, picture);
        showScreen('main');
        loadEvents();
        startTick();
      }
    });
    tokenClient.requestAccessToken({ prompt: '' });
  });
};

function waitForGSI(cb, attempts = 0) {
  if (window.google?.accounts?.oauth2) { cb(); return; }
  if (attempts > 60) return;
  setTimeout(() => waitForGSI(cb, attempts + 1), 300);
}

function parseJwt(token) {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(base64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
    );
    return JSON.parse(json);
  } catch (_) { return {}; }
}

// ── Screens ───────────────────────────────────────────────────────────────────

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${name}`).classList.add('active');
}

function setUserInfo(name, picture) {
  const nameEl = document.getElementById('user-name');
  const avatarEl = document.getElementById('user-avatar');
  if (nameEl) nameEl.textContent = name;
  if (avatarEl && picture) { avatarEl.src = picture; avatarEl.classList.remove('hidden'); }
}

// ── Header actions ────────────────────────────────────────────────────────────

document.getElementById('refresh-btn').addEventListener('click', loadEvents);

document.getElementById('logout-btn').addEventListener('click', () => {
  if (!confirm('ログアウトしますか？\nセットされたアラームもすべてキャンセルされます。')) return;
  cancelAllAlarms();
  accessToken = null;
  localStorage.removeItem(STORAGE_KEY_TOKEN);
  stopTick();
  eventsCache = [];
  if (window.google?.accounts?.id) google.accounts.id.disableAutoSelect();
  showScreen('login');
});

document.getElementById('alarm-bar-cancel').addEventListener('click', () => {
  if (!confirm('すべてのアラームをキャンセルしますか？')) return;
  cancelAllAlarms();
  renderAlarmBar();
  renderEvents(eventsCache);
});

document.getElementById('alarm-dismiss-btn').addEventListener('click', dismissAlarmModal);

// ── Settings ──────────────────────────────────────────────────────────────────

document.getElementById('settings-btn').addEventListener('click', () => {
  document.getElementById('settings-modal').classList.remove('hidden');
});

document.getElementById('settings-backdrop').addEventListener('click', closeSettings);
document.getElementById('settings-cancel-btn').addEventListener('click', closeSettings);

document.getElementById('settings-save-btn').addEventListener('click', () => {
  const key = document.getElementById('gemini-key-input').value.trim();
  const autoAnalyze = document.getElementById('ai-auto-analyze').checked;
  if (key) localStorage.setItem(STORAGE_KEY_GEMINI, key);
  else localStorage.removeItem(STORAGE_KEY_GEMINI);
  localStorage.setItem(STORAGE_KEY_AI_AUTO, autoAnalyze);
  closeSettings();
  showToast('設定を保存しました');
});

function closeSettings() {
  document.getElementById('settings-modal').classList.add('hidden');
}

// ── Briefing ──────────────────────────────────────────────────────────────────

document.getElementById('briefing-btn').addEventListener('click', async () => {
  const key = localStorage.getItem(STORAGE_KEY_GEMINI);
  if (!key) {
    showToast('設定からGemini APIキーを入力してください');
    document.getElementById('settings-modal').classList.remove('hidden');
    return;
  }
  const card = document.getElementById('ai-briefing-card');
  const content = document.getElementById('briefing-content');
  card.classList.remove('hidden');
  content.textContent = '✨ AI分析中…';

  const today = eventsCache.filter(e => {
    const s = parseEventStart(e);
    if (!s) return false;
    const now = new Date();
    return s.toDateString() === now.toDateString();
  });

  if (!today.length) {
    content.textContent = '今日の予定はありません。ゆっくり過ごせますね！';
    return;
  }

  const eventList = today.map(e => {
    const s = parseEventStart(e);
    const time = isAllDayEvent(e) ? '終日' : formatTime(s);
    return `・${time} ${e.summary || ''}`;
  }).join('\n');

  try {
    const result = await callGemini(key, `
あなたはスケジュール管理AIアシスタントです。
以下は今日の予定です。日本語で100〜150字程度のブリーフィングを作成してください。
予定の概要、注意点、移動や準備のアドバイスがあれば含めてください。

今日の予定:
${eventList}

ブリーフィング（本文のみ、見出しなし）:
    `.trim());
    content.textContent = result;
  } catch (e) {
    content.textContent = 'エラー: ' + e.message;
  }
});

document.getElementById('briefing-close').addEventListener('click', () => {
  document.getElementById('ai-briefing-card').classList.add('hidden');
});

// ── AI Analysis ───────────────────────────────────────────────────────────────

async function analyzeEventsWithAI(events) {
  const key = localStorage.getItem(STORAGE_KEY_GEMINI);
  if (!key) return null;

  const upcoming = events.filter(e => {
    const s = parseEventStart(e);
    return s && !isAllDayEvent(e) && s > new Date();
  });
  if (!upcoming.length) return null;

  const eventList = upcoming.map(e => {
    const s = parseEventStart(e);
    return `id:${e.id}|${formatTime(s)} ${e.summary || ''}`;
  }).join('\n');

  const prompt = `
以下の予定リストを分析してください。各予定について：
1. アラームが必要かどうか（true/false）
2. 推奨アラーム時刻（何分前か。例: [30,15,5]）
3. 移動・準備アドバイス（あれば。なければ空文字）

必ずJSONのみで返答。説明文不要。形式:
{"events":[{"id":"...","needsAlarm":true,"minutes":[15,5],"advice":""}]}

予定:
${eventList}
  `.trim();

  try {
    const raw = await callGemini(key, prompt);
    const json = raw.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return null;
    return JSON.parse(json);
  } catch (_) { return null; }
}

async function callGemini(apiKey, prompt) {
  const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 1024 }
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `API error ${res.status}`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ── Calendar API ──────────────────────────────────────────────────────────────

async function loadEvents() {
  if (!accessToken) return;
  const container = document.getElementById('events-container');
  container.innerHTML = '<div class="loading">読み込み中…</div>';

  try {
    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() + 7);

    const calListRes = await gcalFetch(
      'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=50'
    );
    const cals = calListRes.items || [];
    const targets = cals.length > 0 ? cals : [{ id: 'primary', backgroundColor: CAL_COLORS[0] }];

    const errors = [];
    const allEvents = [];
    await Promise.all(targets.map(async (cal, idx) => {
      try {
        const res = await gcalFetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events` +
          `?timeMin=${now.toISOString()}&timeMax=${end.toISOString()}` +
          `&singleEvents=true&orderBy=startTime&maxResults=100`
        );
        (res.items || []).forEach(e => {
          e._calColor = cal.backgroundColor || CAL_COLORS[idx % CAL_COLORS.length];
          allEvents.push(e);
        });
      } catch (e) { errors.push(`${cal.id}: ${e.message}`); }
    }));

    if (allEvents.length === 0 && errors.length > 0) {
      container.innerHTML = `<div class="empty-state">取得エラー:<br>${errors.join('<br>')}</div>`;
      return;
    }

    allEvents.sort((a, b) => {
      const ta = parseEventStart(a);
      const tb = parseEventStart(b);
      return (ta ? ta.getTime() : 0) - (tb ? tb.getTime() : 0);
    });

    eventsCache = allEvents;

    // AI自動分析
    let aiResult = null;
    if (localStorage.getItem(STORAGE_KEY_AI_AUTO) === 'true' && localStorage.getItem(STORAGE_KEY_GEMINI)) {
      container.innerHTML = '<div class="loading">✨ AI分析中…</div>';
      aiResult = await analyzeEventsWithAI(allEvents);
    }

    renderEvents(allEvents, cals.length, aiResult);

    // 自動アラームセット
    cancelAllAlarms(); // 古いアラームをリセット
    let autoCount = 0;
    const now2 = new Date();

    if (aiResult?.events) {
      // AIの判定に従う
      aiResult.events.forEach(ai => {
        if (!ai.needsAlarm) return;
        const event = allEvents.find(e => e.id === ai.id);
        if (!event) return;
        const start = parseEventStart(event);
        if (!start || start <= now2) return;
        const minutes = ai.minutes?.length ? ai.minutes : ALARM_OFFSETS;
        minutes.forEach(m => setAlarm(event.id, m, start, event.summary || ''));
        autoCount++;
      });
    } else {
      // AI無効：全ての時刻付き予定に自動設定
      allEvents.forEach(event => {
        if (isAllDayEvent(event)) return;
        const start = parseEventStart(event);
        if (!start || start <= now2) return;
        ALARM_OFFSETS.forEach(m => setAlarm(event.id, m, start, event.summary || ''));
        autoCount++;
      });
    }

    renderAlarmBar();
    if (autoCount > 0) showToast(`⏰ ${autoCount}件の予定にアラームを自動設定しました`);

  } catch (err) {
    if (err.status === 401) {
      localStorage.removeItem(STORAGE_KEY_TOKEN);
      accessToken = null;
      showScreen('login');
    } else {
      container.innerHTML = `<div class="empty-state">読み込みに失敗しました<br>${err.message || ''}</div>`;
    }
  }
}

async function gcalFetch(url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const err = new Error(`API error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderEvents(events, calCount, aiResult) {
  const container = document.getElementById('events-container');
  const timeEvents = events.filter(e => parseEventStart(e) !== null);

  if (!timeEvents.length) {
    const calInfo = calCount !== undefined ? `（カレンダー ${calCount} 件を確認）` : '';
    container.innerHTML = `<div class="empty-state">今後7日間の予定はありません 🎉<br><small style="color:var(--text-sub)">${calInfo}</small></div>`;
    return;
  }

  const now = new Date();
  const fragments = [];
  let lastDateKey = null;

  timeEvents.forEach(event => {
    const start = parseEventStart(event);
    const dateKey = formatDateLabel(start);
    if (dateKey !== lastDateKey) {
      lastDateKey = dateKey;
      const lbl = document.createElement('div');
      lbl.className = 'date-label';
      lbl.textContent = dateKey;
      fragments.push(lbl);
    }
    const aiInfo = aiResult?.events?.find(a => a.id === event.id);
    fragments.push(buildEventCard(event, start, now, aiInfo));
  });

  container.innerHTML = '';
  fragments.forEach(f => container.appendChild(f));
}

function buildEventCard(event, start, now, aiInfo) {
  const id = event.id;
  const title = event.summary || '（タイトルなし）';
  const color = event._calColor || '#007AFF';
  const minutesUntil = (start - now) / 60000;
  const allDay = isAllDayEvent(event);

  const card = document.createElement('div');
  card.className = 'event-card';
  card.dataset.id = id;
  if (minutesUntil < 0) card.classList.add('past');
  else if (minutesUntil <= 30) card.classList.add('soon');

  const dot = document.createElement('div');
  dot.className = 'event-color-dot';
  dot.style.background = color;

  const info = document.createElement('div');
  info.className = 'event-info';
  const timeLabel = allDay ? '終日' : formatTime(start);
  let adviceHtml = '';
  if (aiInfo?.advice) {
    adviceHtml = `<div class="ai-advice">✨ ${escHtml(aiInfo.advice)}</div>`;
  }
  info.innerHTML = `<div class="event-title">${escHtml(title)}</div><div class="event-time">${timeLabel}</div>${adviceHtml}`;

  const alarmArea = document.createElement('div');
  alarmArea.className = 'event-alarm-area';
  alarmArea.dataset.id = id;
  alarmArea.dataset.start = start.getTime();
  alarmArea.dataset.title = title;

  if (allDay) {
    alarmArea.innerHTML = '<span class="ended-label">終日</span>';
  } else if (aiInfo && !aiInfo.needsAlarm) {
    alarmArea.innerHTML = '<span class="ai-skip-label">AI: 不要</span>';
  } else {
    refreshAlarmAreaContent(alarmArea, id, start, now, aiInfo);
  }

  card.appendChild(dot);
  card.appendChild(info);
  card.appendChild(alarmArea);
  return card;
}

function refreshAlarmAreaContent(area, eventId, start, now, aiInfo) {
  const minutesUntil = (start - now) / 60000;
  area.innerHTML = '';

  if (minutesUntil < 0) {
    area.innerHTML = '<span class="ended-label">終了</span>';
    return;
  }

  const offsets = aiInfo?.minutes || ALARM_OFFSETS;

  offsets.forEach(offset => {
    const key = `${eventId}_${offset}`;
    const alarmTime = new Date(start.getTime() - offset * 60000);
    const fireMinutes = (alarmTime - now) / 60000;
    if (fireMinutes < -1) return;

    if (activeAlarms[key]) {
      const remaining = Math.ceil((alarmTime - now) / 60000);
      const countdown = document.createElement('div');
      countdown.className = 'alarm-countdown pulsing';
      countdown.textContent = remaining > 0 ? `⏰ ${remaining}分後` : '⏰ まもなく！';
      area.appendChild(countdown);

      const btn = document.createElement('button');
      btn.className = 'alarm-btn alarm-btn-cancel';
      btn.textContent = `${offset}分前 ✕`;
      btn.addEventListener('click', () => {
        cancelAlarm(key);
        refreshAlarmAreaContent(area, eventId, start, new Date(), aiInfo);
        renderAlarmBar();
      });
      area.appendChild(btn);
    } else {
      const btn = document.createElement('button');
      btn.className = 'alarm-btn alarm-btn-set';
      if (aiInfo?.needsAlarm && (aiInfo.minutes || []).includes(offset)) {
        btn.classList.add('ai-recommended');
      }
      btn.textContent = `${offset}分前`;
      btn.addEventListener('click', () => {
        setAlarm(eventId, offset, start, area.dataset.title);
        refreshAlarmAreaContent(area, eventId, start, new Date(), aiInfo);
        renderAlarmBar();
      });
      area.appendChild(btn);
    }
  });
}

// ── Alarm logic ───────────────────────────────────────────────────────────────

function setAlarm(eventId, offsetMin, startTime, title) {
  const key = `${eventId}_${offsetMin}`;
  if (activeAlarms[key]) return;
  const alarmTime = new Date(startTime.getTime() - offsetMin * 60000);
  const msUntil = alarmTime - Date.now();
  if (msUntil < -60000) return;
  requestNotificationPermission();
  const timeoutId = setTimeout(() => fireAlarm(title, startTime, key), Math.max(msUntil, 0));
  activeAlarms[key] = { timeoutId, title, startTime, offsetMin };
}

function cancelAlarm(key) {
  if (activeAlarms[key]) { clearTimeout(activeAlarms[key].timeoutId); delete activeAlarms[key]; }
}

function cancelAllAlarms() { Object.keys(activeAlarms).forEach(cancelAlarm); }

function fireAlarm(title, startTime, key) {
  delete activeAlarms[key];
  playAlarmSound();
  if (navigator.vibrate) navigator.vibrate([300, 100, 300, 100, 300]);
  if (Notification.permission === 'granted') {
    new Notification('⏰ ' + title, { body: `${formatTime(startTime)} 開始`, icon: 'icon-192.png', tag: key, renotify: true });
  }
  showAlarmModal(title, startTime);
  renderAlarmBar();
  renderEvents(eventsCache);
}

function showAlarmModal(title, startTime) {
  document.getElementById('alarm-modal-title').textContent = title;
  document.getElementById('alarm-modal-time').textContent = `${formatTime(startTime)} 開始`;
  document.getElementById('alarm-modal').classList.remove('hidden');
}

function dismissAlarmModal() {
  document.getElementById('alarm-modal').classList.add('hidden');
  stopAlarmSound();
}

function renderAlarmBar() {
  const count = Object.keys(activeAlarms).length;
  const bar = document.getElementById('alarm-active-bar');
  if (count === 0) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  document.getElementById('alarm-bar-text').textContent = `⏰ ${count}件のアラームが設定中`;
}

// ── Tick ──────────────────────────────────────────────────────────────────────

function startTick() {
  stopTick();
  tickInterval = setInterval(() => {
    const now = new Date();
    document.querySelectorAll('.event-alarm-area').forEach(area => {
      if (!Object.keys(activeAlarms).some(k => k.startsWith(area.dataset.id + '_'))) return;
      refreshAlarmAreaContent(area, area.dataset.id, new Date(parseInt(area.dataset.start)), now);
    });
  }, 15000);
}

function stopTick() { if (tickInterval) { clearInterval(tickInterval); tickInterval = null; } }

// ── Notification ──────────────────────────────────────────────────────────────

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}

// ── Audio ─────────────────────────────────────────────────────────────────────

let audioCtx = null, alarmNodes = [];

function playAlarmSound() {
  stopAlarmSound();
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    playBeepSequence(audioCtx);
  } catch (_) {}
}

function playBeepSequence(ctx, repeat = 0) {
  if (repeat >= 4) return;
  const now = ctx.currentTime;
  [0, 0.18, 0.36].forEach((offset, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = i === 2 ? 880 : 660;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.4, now + offset);
    gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.15);
    osc.start(now + offset); osc.stop(now + offset + 0.15);
    alarmNodes.push(osc);
  });
  setTimeout(() => playBeepSequence(ctx, repeat + 1), 800);
}

function stopAlarmSound() {
  if (audioCtx) {
    alarmNodes.forEach(n => { try { n.stop(); } catch (_) {} });
    alarmNodes = [];
    try { audioCtx.close(); } catch (_) {}
    audioCtx = null;
  }
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function showToast(msg) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseEventStart(event) {
  const s = event?.start;
  if (!s) return null;
  if (s.dateTime) { try { return new Date(s.dateTime); } catch (_) { return null; } }
  if (s.date) { try { return new Date(s.date + 'T00:00:00+09:00'); } catch (_) { return null; } }
  return null;
}

function isAllDayEvent(event) { return !!event?.start?.date && !event?.start?.dateTime; }

function formatTime(dt) { return dt.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }); }

function formatDateLabel(dt) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const d = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  const diff = Math.round((d - today) / 86400000);
  const weekdays = ['日','月','火','水','木','金','土'];
  const base = `${dt.getMonth()+1}月${dt.getDate()}日（${weekdays[dt.getDay()]}）`;
  if (diff === 0) return `今日 · ${base}`;
  if (diff === 1) return `明日 · ${base}`;
  if (diff === 2) return `明後日 · ${base}`;
  return base;
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
