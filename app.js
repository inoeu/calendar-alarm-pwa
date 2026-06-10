'use strict';

const SCOPES = 'https://www.googleapis.com/auth/calendar.readonly';
const STORAGE_KEY_TOKEN = 'gcal_alarm_token';
const ALARM_OFFSETS = [15, 5];
const CAL_COLORS = ['#039BE5','#33B679','#D50000','#F6BF26','#F4511E','#0B8043','#8E24AA','#616161'];

let accessToken = null;
let activeAlarms = {};
let eventsCache = [];
let tickInterval = null;

// ── Bootstrap ────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
  // Inject client_id from config.js into the GIS element
  const onload = document.getElementById('g_id_onload');
  if (onload && typeof GOOGLE_CLIENT_ID !== 'undefined') {
    onload.dataset.client_id = GOOGLE_CLIENT_ID;
  }

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
});

// ── Google Sign-In callback (GIS One Tap / button) ────────────────────────────

window.onGoogleSignIn = function(response) {
  // response.credential is a JWT id_token — decode to get user info
  const payload = parseJwt(response.credential);
  const name = payload.name || '';
  const picture = payload.picture || '';

  // Exchange id_token for an access token via token client
  waitForGSI(() => {
    const tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPES,
      callback: (tokenResp) => {
        if (tokenResp.error) {
          alert('ログインに失敗しました: ' + tokenResp.error);
          return;
        }
        accessToken = tokenResp.access_token;
        const expiresIn = parseInt(tokenResp.expires_in || 3600, 10);
        localStorage.setItem(STORAGE_KEY_TOKEN, JSON.stringify({
          access_token: accessToken,
          expires_at: Date.now() + expiresIn * 1000,
          name,
          picture
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
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
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
  if (avatarEl && picture) {
    avatarEl.src = picture;
    avatarEl.classList.remove('hidden');
  }
}

// ── Header actions ─────────────────────────────────────────────────────────────

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

// ── Calendar API ──────────────────────────────────────────────────────────────

async function loadEvents() {
  if (!accessToken) return;
  const container = document.getElementById('events-container');
  container.innerHTML = '<div class="loading">読み込み中…</div>';

  try {
    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() + 3);

    const calListRes = await gcalFetch(
      'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=50'
    );
    const cals = (calListRes.items || []).filter(c => c.selected !== false);

    const allEvents = [];
    await Promise.all(cals.map(async (cal, idx) => {
      try {
        const res = await gcalFetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events` +
          `?timeMin=${now.toISOString()}&timeMax=${end.toISOString()}` +
          `&singleEvents=true&orderBy=startTime&maxResults=50`
        );
        (res.items || []).forEach(e => {
          e._calColor = cal.backgroundColor || CAL_COLORS[idx % CAL_COLORS.length];
          allEvents.push(e);
        });
      } catch (_) {}
    }));

    allEvents.sort((a, b) => {
      const ta = parseEventStart(a);
      const tb = parseEventStart(b);
      return (ta ? ta.getTime() : 0) - (tb ? tb.getTime() : 0);
    });

    eventsCache = allEvents;
    renderEvents(allEvents);
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
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    const err = new Error(`API error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderEvents(events) {
  const container = document.getElementById('events-container');
  const timeEvents = events.filter(e => parseEventStart(e));

  if (!timeEvents.length) {
    container.innerHTML = '<div class="empty-state">今後3日間の予定はありません 🎉</div>';
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
    fragments.push(buildEventCard(event, start, now));
  });

  container.innerHTML = '';
  fragments.forEach(f => container.appendChild(f));
}

function buildEventCard(event, start, now) {
  const id = event.id;
  const title = event.summary || '（タイトルなし）';
  const color = event._calColor || '#007AFF';
  const minutesUntil = (start - now) / 60000;

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
  info.innerHTML = `<div class="event-title">${escHtml(title)}</div><div class="event-time">${formatTime(start)}</div>`;

  const alarmArea = document.createElement('div');
  alarmArea.className = 'event-alarm-area';
  alarmArea.dataset.id = id;
  alarmArea.dataset.start = start.getTime();
  alarmArea.dataset.title = title;
  refreshAlarmAreaContent(alarmArea, id, start, now);

  card.appendChild(dot);
  card.appendChild(info);
  card.appendChild(alarmArea);
  return card;
}

function refreshAlarmAreaContent(area, eventId, start, now) {
  const minutesUntil = (start - now) / 60000;
  area.innerHTML = '';

  if (minutesUntil < 0) {
    area.innerHTML = '<span class="ended-label">終了</span>';
    return;
  }

  ALARM_OFFSETS.forEach(offset => {
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
        refreshAlarmAreaContent(area, eventId, start, new Date());
        renderAlarmBar();
      });
      area.appendChild(btn);
    } else {
      const btn = document.createElement('button');
      btn.className = 'alarm-btn alarm-btn-set';
      btn.textContent = `${offset}分前`;
      btn.addEventListener('click', () => {
        setAlarm(eventId, offset, start, area.dataset.title);
        refreshAlarmAreaContent(area, eventId, start, new Date());
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
  if (activeAlarms[key]) {
    clearTimeout(activeAlarms[key].timeoutId);
    delete activeAlarms[key];
  }
}

function cancelAllAlarms() {
  Object.keys(activeAlarms).forEach(cancelAlarm);
}

function fireAlarm(title, startTime, key) {
  delete activeAlarms[key];
  playAlarmSound();
  if (navigator.vibrate) navigator.vibrate([300, 100, 300, 100, 300]);
  if (Notification.permission === 'granted') {
    new Notification('⏰ ' + title, {
      body: `${formatTime(startTime)} 開始`,
      icon: 'icon-192.png',
      tag: key,
      renotify: true
    });
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
  if (count === 0) {
    bar.classList.add('hidden');
  } else {
    bar.classList.remove('hidden');
    document.getElementById('alarm-bar-text').textContent = `⏰ ${count}件のアラームが設定中`;
  }
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

function stopTick() {
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
}

// ── Notification ──────────────────────────────────────────────────────────────

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

// ── Audio ─────────────────────────────────────────────────────────────────────

let audioCtx = null;
let alarmNodes = [];

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
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = i === 2 ? 880 : 660;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.4, now + offset);
    gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.15);
    osc.start(now + offset);
    osc.stop(now + offset + 0.15);
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseEventStart(event) {
  const s = event?.start;
  if (!s || !s.dateTime) return null;
  try { return new Date(s.dateTime); } catch (_) { return null; }
}

function formatTime(dt) {
  return dt.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

function formatDateLabel(dt) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const d = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  const diff = Math.round((d - today) / 86400000);
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  const base = `${dt.getMonth() + 1}月${dt.getDate()}日（${weekdays[dt.getDay()]}）`;
  if (diff === 0) return `今日 · ${base}`;
  if (diff === 1) return `明日 · ${base}`;
  if (diff === 2) return `明後日 · ${base}`;
  return base;
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
