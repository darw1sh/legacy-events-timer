let DAILY_SCHEDULE = [];
let renderedNextEvents = [];
let renderedScheduleRows = [];

const state = {
  dayOffset: 0,
  compact: false,
  filter: "all",
  notifyLeadMin: 3,
  voiceEnabled: true,
  bgAudioEnabled: false,
  voicedEvents: new Set(),
  alertedKeys: new Set(),
  lastTickMs: null
};

const refs = {
  localClock: document.getElementById("localClock"),
  serverClock: document.getElementById("serverClock"),
  dayLabel: document.getElementById("dayLabel"),
  dayDate: document.getElementById("dayDate"),
  nextEvents: document.getElementById("nextEvents"),
  scheduleList: document.getElementById("scheduleList"),
  compactToggle: document.getElementById("compactToggle"),
  voiceToggle: document.getElementById("voiceToggle"),
  testVoice: document.getElementById("testVoice"),
  voiceEventList: document.getElementById("voiceEventList"),
  categoryFilter: document.getElementById("categoryFilter"),
  notifyLeadMinutes: document.getElementById("notifyLeadMinutes"),
  prevDay: document.getElementById("prevDay"),
  nextDay: document.getElementById("nextDay"),
  jumpToday: document.getElementById("jumpToday"),
  enableAudioBtn: document.getElementById("enableAudioBtn")
};

// LocalStorage helpers for persisting user preferences
const storage = {
  VOICE_KEY: "eventTimers_voiceEnabled",
  BG_AUDIO_KEY: "eventTimers_bgAudioEnabled",
  
  saveVoicePreference(enabled) {
    try {
      localStorage.setItem(this.VOICE_KEY, JSON.stringify(enabled));
    } catch (e) {
      console.warn("Failed to save voice preference", e);
    }
  },
  
  loadVoicePreference() {
    try {
      const saved = localStorage.getItem(this.VOICE_KEY);
      return saved !== null ? JSON.parse(saved) : true;
    } catch (e) {
      console.warn("Failed to load voice preference", e);
      return true;
    }
  },
  
  saveBgAudioPreference(enabled) {
    try {
      localStorage.setItem(this.BG_AUDIO_KEY, JSON.stringify(enabled));
    } catch (e) {
      console.warn("Failed to save bg audio preference", e);
    }
  },
  
  loadBgAudioPreference() {
    try {
      const saved = localStorage.getItem(this.BG_AUDIO_KEY);
      return saved !== null ? JSON.parse(saved) : false;
    } catch (e) {
      console.warn("Failed to load bg audio preference", e);
      return false;
    }
  }
};


// Background audio keeper: creates a very-low-volume oscillator to keep
// the audio system active so timers/tts continue when page is backgrounded
const bgAudio = {
  ctx: null,
  osc: null,
  gain: null,
  started: false,
  start() {
    try {
      if (this.started) return;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0.00001;
      this.osc = this.ctx.createOscillator();
      this.osc.type = "sine";
      this.osc.frequency.value = 440;
      this.osc.connect(this.gain);
      this.gain.connect(this.ctx.destination);
      this.osc.start();
      this.started = true;
    } catch (e) {
      console.warn("bgAudio start failed", e);
    }
  },
  resume() {
    try {
      if (this.ctx && this.ctx.state === "suspended") {
        this.ctx.resume();
      }
    } catch (e) {
      console.warn("bgAudio resume failed", e);
    }
  }
};

// Ensure background audio is unlocked from a user gesture. Safe to call repeatedly.
function ensureBackgroundAudioUnlocked() {
  try {
    if (!bgAudio.started) {
      bgAudio.start();
    } else {
      bgAudio.resume();
    }
  } catch (e) {
    console.warn("ensureBackgroundAudioUnlocked error", e);
  }
}

function buildFilterOptions() {
  refs.categoryFilter.innerHTML = '<option value="all">All events</option>';
  const categories = [...new Set(DAILY_SCHEDULE.map((event) => event.category))].sort();
  for (const category of categories) {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category.replace(/-/g, " ");
    refs.categoryFilter.appendChild(option);
  }
}

function buildVoiceEventChecklist() {
  const names = [...new Set(DAILY_SCHEDULE.map((event) => event.name))].sort((a, b) =>
    a.localeCompare(b)
  );

  if (!state.voicedEvents.size) {
    state.voicedEvents = new Set(names);
  }

  refs.voiceEventList.innerHTML = "";

  for (const name of names) {
    const label = document.createElement("label");
    label.className = "checkbox-wrap voice-event-item";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = state.voicedEvents.has(name);
    input.dataset.eventName = name;

    input.addEventListener("change", (event) => {
      if (event.target.checked) {
        state.voicedEvents.add(name);
      } else {
        state.voicedEvents.delete(name);
      }
    });

    const span = document.createElement("span");
    span.textContent = name;

    label.appendChild(input);
    label.appendChild(span);
    refs.voiceEventList.appendChild(label);
  }
}

function setVoiceChecklistEnabled(enabled) {
  const inputs = refs.voiceEventList.querySelectorAll('input[type="checkbox"]');
  inputs.forEach((input) => {
    input.disabled = !enabled;
  });
}

// Convert a Date object (in local time) to server time (UTC+2)
function toServerTime(localDate) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Etc/GMT-2"
  });
  const parts = formatter.formatToParts(localDate);
  const obj = {};
  for (const { type, value } of parts) {
    if (type !== "literal") {
      obj[type] = value;
    }
  }
  const serverDate = new Date(
    `${obj.year}-${obj.month}-${obj.day}T${obj.hour}:${obj.minute}:${obj.second}Z`
  );
  return serverDate;
}

// Get current time in server timezone
function getServerNow() {
  return toServerTime(new Date());
}

// Get today's date in server timezone
function getServerBaseDate() {
  const serverNow = getServerNow();
  const baseDate = new Date(serverNow);
  baseDate.setUTCHours(0, 0, 0, 0);
  const copy = new Date(baseDate);
  copy.setUTCDate(copy.getUTCDate() + state.dayOffset);
  return copy;
}

// Parse time on a UTC date (for server timezone calculations)
function parseTimeUTC(baseDate, hhmm) {
  const [hours, minutes] = hhmm.split(":").map(Number);
  const date = new Date(baseDate);
  date.setUTCHours(hours, minutes, 0, 0);
  return date;
}

// Flatten events using UTC dates (server timezone)
function flattenEventsUTC(baseDate) {
  const rows = DAILY_SCHEDULE.map((entry) => {
    const start = parseTimeUTC(baseDate, entry.time);
    const durationMin = Number(entry.durationMin) || 20;
    const end = new Date(start.getTime() + durationMin * 60000);
    return {
      name: entry.name,
      category: entry.category || "general",
      start,
      end,
      durationMin,
      hhmm: entry.time
    };
  });

  rows.sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));
  return rows;
}

function getBaseDate() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const copy = new Date(today);
  copy.setDate(copy.getDate() + state.dayOffset);
  return copy;
}

function parseTime(baseDate, hhmm) {
  const [hours, minutes] = hhmm.split(":").map(Number);
  const date = new Date(baseDate);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

function flattenEvents(baseDate) {
  const rows = DAILY_SCHEDULE.map((entry) => {
    const start = parseTime(baseDate, entry.time);
    const durationMin = Number(entry.durationMin) || 20;
    const end = new Date(start.getTime() + durationMin * 60000);
    return {
      name: entry.name,
      category: entry.category || "general",
      start,
      end,
      durationMin,
      hhmm: entry.time
    };
  });

  rows.sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));
  return rows;
}

function eventKey(event) {
  return `${event.name}|${event.category}|${event.start.getTime()}`;
}

function humanDuration(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;

  if (days > 0) {
    return `${days}d ${hours}h ${mins}m`;
  }
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  if (mins > 0) {
    return `${mins}m ${secs}s`;
  }
  return `${secs}s`;
}

function findNextEvents(now, limit = 6) {
  const todayBase = new Date(now);
  todayBase.setUTCHours(0, 0, 0, 0);
  const tomorrowBase = new Date(todayBase);
  tomorrowBase.setUTCDate(tomorrowBase.getUTCDate() + 1);

  const merged = flattenEventsUTC(todayBase).concat(flattenEventsUTC(tomorrowBase));
  return merged.filter((event) => event.start >= now && eventMatchesFilter(event)).slice(0, limit);
}

function eventMatchesFilter(event) {
  return state.filter === "all" || event.category === state.filter;
}

function formatClock(date, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone
  }).format(date);
}

function formatDay(date) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(date);
}

function renderHeader(now) {
  const base = getServerBaseDate();
  const baseDate = new Date(base);
  baseDate.setUTCHours(0, 0, 0, 0);
  refs.dayDate.textContent = formatDay(baseDate);

  if (state.dayOffset === 0) {
    refs.dayLabel.textContent = "Today";
  } else if (state.dayOffset > 0) {
    refs.dayLabel.textContent = `+${state.dayOffset} day`;
  } else {
    refs.dayLabel.textContent = `${state.dayOffset} day`;
  }

  refs.localClock.textContent = formatClock(now, Intl.DateTimeFormat().resolvedOptions().timeZone);
  refs.serverClock.textContent = formatClock(now, "Etc/GMT-2");
}

function renderNextEvents(now, force = false) {
  const serverNow = getServerNow();
  const next = findNextEvents(serverNow, 6);
  const nextKey = next.map(eventKey).join("||");
  const renderedKey = renderedNextEvents.map(eventKey).join("||");

  if (force || nextKey !== renderedKey) {
    refs.nextEvents.innerHTML = "";

    for (const event of next) {
      const card = document.createElement("article");
      card.className = "timer-card";
      card.innerHTML = `
      <h4>${event.name}</h4>
      <p class="timer-meta">${event.category.replace(/-/g, " ")} • starts at ${event.hhmm}</p>
      <p class="timer-count"></p>
    `;

      refs.nextEvents.appendChild(card);
    }
  }

  renderedNextEvents = next;
  const cards = refs.nextEvents.querySelectorAll(".timer-card");
  renderedNextEvents.forEach((event, idx) => {
    const countEl = cards[idx]?.querySelector(".timer-count");
    if (countEl) {
      countEl.textContent = `In ${humanDuration(event.start - serverNow)}`;
    }
  });
}

function renderSchedule(now, force = false) {
  const base = getServerBaseDate();
  const rows = flattenEventsUTC(base).filter(eventMatchesFilter);
  const rowsKey = rows.map(eventKey).join("||");
  const renderedKey = renderedScheduleRows.map(eventKey).join("||");

  refs.scheduleList.classList.toggle("compact", state.compact);

  if (force || rowsKey !== renderedKey) {
    refs.scheduleList.innerHTML = "";
    for (const row of rows) {
      const li = document.createElement("li");
      li.className = "schedule-item";
      li.innerHTML = `
      <span class="time">${row.hhmm}</span>
      <span class="name">${row.name}<span class="meta">${row.category.replace(/-/g, " ")}</span></span>
      <span class="count"></span>
    `;
      refs.scheduleList.appendChild(li);
    }
  }

  renderedScheduleRows = rows;
  const rowEls = refs.scheduleList.querySelectorAll(".schedule-item");
  const serverNow = getServerNow();
  renderedScheduleRows.forEach((row, idx) => {
    const li = rowEls[idx];
    if (!li) {
      return;
    }

    const isTodayView = state.dayOffset === 0;
    const isLive = isTodayView && serverNow >= row.start && serverNow < row.end;
    li.classList.toggle("live", isLive);

    let statusText = "Passed";
    if (isLive) {
      statusText = `Live (${humanDuration(row.end - serverNow)} left)`;
    } else if (row.start >= serverNow || state.dayOffset !== 0) {
      statusText = `In ${humanDuration(row.start - serverNow)}`;
    }

    const countEl = li.querySelector(".count");
    if (countEl) {
      countEl.textContent = statusText;
    }
  });
}

function speakAlert(event, mode = "lead") {
  if (!("speechSynthesis" in window)) {
    return;
  }

  if (!state.voiceEnabled) {
    return;
  }

  if (!state.voicedEvents.has(event.name)) {
    return;
  }

  const message =
    mode === "start"
      ? `${event.name} is starting now.`
      : `${event.name} starts in ${state.notifyLeadMin} minutes at ${event.hhmm}`;

  const utterance = new SpeechSynthesisUtterance(message);
  utterance.rate = 1;
  utterance.pitch = 1;
  ensureBackgroundAudioUnlocked();
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

function testVoice() {
  if (!state.voiceEnabled) {
    speakText("Voice is off. Turn it on to test the announcement.");
    return;
  }

  const firstVoicedEventName = [...state.voicedEvents][0];
  if (!firstVoicedEventName) {
    speakText("No events are selected for voice.");
    return;
  }

  const sampleEvent = DAILY_SCHEDULE.find((event) => event.name === firstVoicedEventName);
  if (!sampleEvent) {
    speakText("No matching event was found for the voice test.");
    return;
  }

  ensureBackgroundAudioUnlocked();
  speakText(
    `${sampleEvent.name} starts in ${state.notifyLeadMin} minutes at ${sampleEvent.time}. Voice test.`
  );
}

function speakText(message) {
  if (!("speechSynthesis" in window)) {
    return;
  }

  ensureBackgroundAudioUnlocked();
  const utterance = new SpeechSynthesisUtterance(message);
  utterance.rate = 1;
  utterance.pitch = 1;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

function findUpcomingAllEvents(now, limit = 24) {
  const todayBase = new Date(now);
  todayBase.setUTCHours(0, 0, 0, 0);
  const tomorrowBase = new Date(todayBase);
  tomorrowBase.setUTCDate(tomorrowBase.getUTCDate() + 1);

  return flattenEventsUTC(todayBase)
    .concat(flattenEventsUTC(tomorrowBase))
    .filter((event) => event.start >= now)
    .slice(0, limit);
}

function maybeNotify(now) {
  if (state.dayOffset !== 0) {
    state.lastTickMs = now.getTime();
    return;
  }

  if (!state.voiceEnabled) {
    state.lastTickMs = now.getTime();
    return;
  }

  const serverNow = getServerNow();
  const leadWindowMs = state.notifyLeadMin * 60000;
  const lateGraceMs = 15000;
  const previousTickMs = state.lastTickMs ?? serverNow.getTime() - 1100;
  const upcoming = findUpcomingAllEvents(serverNow, 24);

  for (const event of upcoming) {
    const prevUntil = event.start.getTime() - previousTickMs;
    const currentUntil = event.start.getTime() - serverNow.getTime();

    const crossedLeadThreshold =
      prevUntil >= leadWindowMs && currentUntil <= leadWindowMs && currentUntil >= -lateGraceMs;

    if (crossedLeadThreshold) {
      const leadKey = `lead:${event.name}:${event.start.getTime()}:${state.notifyLeadMin}`;
      if (state.alertedKeys.has(leadKey)) {
        continue;
      }
      state.alertedKeys.add(leadKey);

      speakAlert(event, "lead");
    }
  }

  state.lastTickMs = serverNow.getTime();
}

async function loadScheduleJson() {
  try {
    const response = await fetch("schedule.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Could not load schedule.json");
    }
    const data = await response.json();
    if (!Array.isArray(data)) {
      throw new Error("Invalid schedule.json format");
    }
    DAILY_SCHEDULE = data;
  } catch (error) {
    console.error(error);
    refs.nextEvents.innerHTML = "<p class=\"muted\">Could not load schedule.json. Run from a local server and refresh.</p>";
  }
}

function tick(force = false) {
  if (!DAILY_SCHEDULE.length) {
    return;
  }
  const now = new Date();
  renderHeader(now);
  renderNextEvents(now, force);
  renderSchedule(now, force);
  maybeNotify(now);
}

function bindEvents() {
  refs.prevDay.addEventListener("click", () => {
    state.dayOffset -= 1;
    tick(true);
  });

  refs.nextDay.addEventListener("click", () => {
    state.dayOffset += 1;
    tick(true);
  });

  refs.jumpToday.addEventListener("click", () => {
    state.dayOffset = 0;
    tick(true);
  });

  refs.compactToggle.addEventListener("change", (event) => {
    state.compact = event.target.checked;
    tick(true);
  });

  refs.voiceToggle.addEventListener("change", (event) => {
    state.voiceEnabled = event.target.checked;
    setVoiceChecklistEnabled(state.voiceEnabled);
    if (state.voiceEnabled) {
      ensureBackgroundAudioUnlocked();
    }
    storage.saveVoicePreference(state.voiceEnabled);
  });

  refs.testVoice.addEventListener("click", () => {
    testVoice();
  });

  if (refs.enableAudioBtn) {
    refs.enableAudioBtn.addEventListener("click", () => {
      ensureBackgroundAudioUnlocked();
      state.bgAudioEnabled = true;
      try {
        refs.enableAudioBtn.textContent = "Background audio enabled";
        refs.enableAudioBtn.disabled = true;
      } catch (e) {
        // ignore
      }
      storage.saveBgAudioPreference(true);
      // provide audible confirmation
      speakText("Background audio enabled");
    });
  }

  refs.categoryFilter.addEventListener("change", (event) => {
    state.filter = event.target.value;
    tick(true);
  });

  refs.notifyLeadMinutes.addEventListener("change", (event) => {
    state.notifyLeadMin = Number(event.target.value) || 3;
  });
}

async function init() {
  // Load saved preferences
  state.voiceEnabled = storage.loadVoicePreference();
  state.bgAudioEnabled = storage.loadBgAudioPreference();
  
  await loadScheduleJson();
  if (!DAILY_SCHEDULE.length) {
    return;
  }
  buildFilterOptions();
  buildVoiceEventChecklist();
  setVoiceChecklistEnabled(state.voiceEnabled);
  
  // Restore voice toggle state from localStorage
  refs.voiceToggle.checked = state.voiceEnabled;
  
  // Restore background audio button state from localStorage
  if (state.bgAudioEnabled && refs.enableAudioBtn) {
    refs.enableAudioBtn.textContent = "Background audio enabled";
    refs.enableAudioBtn.disabled = true;
    ensureBackgroundAudioUnlocked();
  }
  
  bindEvents();
  tick(true);
  setInterval(() => tick(false), 1000);
}

init();
