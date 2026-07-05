const DB_NAME = 'rapid-vocab-db';
const DB_VERSION = 1;
const STORE = 'words';
const SETTINGS_KEY = 'rapid-vocab-settings';
const TODAY_KEY = 'rapid-vocab-today';

const MAX_PHASE = 5;
const PHASE_ONE_GROUP_SIZE = 25;
const LATER_PHASE_GROUP_SIZE = 20;
const CONFIDENCE_WORDS_PER_GROUP = 3;
const ADAPTIVE_PLAN_VERSION = 2;

let db;
let pendingImportRows = [];
let reviewQueue = [];
let currentIndex = 0;
let currentCard = null;
let isRating = false;
let sessionStats = makeBlankSessionStats();
let deferredInstallPrompt = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const views = {
  home: $('#homeView'),
  review: $('#reviewView'),
  upload: $('#uploadView'),
  wordlist: $('#wordlistView'),
};

const defaultSettings = {
  createdAt: new Date().toISOString(),
  adaptivePlan: null,
};

function makeBlankSessionStats() {
  return {
    again: 0,
    hard: 0,
    good: 0,
    easy: 0,
    total: 0,
    introduced: 0,
    phase: 1,
    group: 1,
    groups: 1,
  };
}

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeWord(word) {
  return String(word || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function makeId(word) {
  return normalizeWord(word)
    .replace(/[^a-z0-9\u0980-\u09FF]+/gi, '-')
    .replace(/^-+|-+$/g, '') || crypto.randomUUID();
}

function getSettings() {
  try {
    return { ...defaultSettings, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}) };
  } catch {
    return { ...defaultSettings };
  }
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...getSettings(), ...settings }));
}

function getTodayStats() {
  const blank = { date: todayString(), reviewed: 0, introduced: 0 };
  try {
    const stored = JSON.parse(localStorage.getItem(TODAY_KEY));
    if (!stored || stored.date !== todayString()) return blank;
    return { ...blank, ...stored };
  } catch {
    return blank;
  }
}

function saveTodayStats(patch) {
  const stats = { ...getTodayStats(), ...patch };
  localStorage.setItem(TODAY_KEY, JSON.stringify(stats));
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        const store = database.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('word', 'word', { unique: false });
        store.createIndex('normalizedWord', 'normalizedWord', { unique: true });
        store.createIndex('status', 'status', { unique: false });
        store.createIndex('dueAt', 'dueAt', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx(mode = 'readonly') {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function getAllWords() {
  return new Promise((resolve, reject) => {
    const request = tx().getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function getWordByNormalized(normalizedWord) {
  return new Promise((resolve, reject) => {
    const request = tx().index('normalizedWord').get(normalizedWord);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

function putWord(word) {
  return new Promise((resolve, reject) => {
    const request = tx('readwrite').put(word);
    request.onsuccess = () => resolve(word);
    request.onerror = () => reject(request.error);
  });
}

function deleteWord(id) {
  return new Promise((resolve, reject) => {
    const request = tx('readwrite').delete(id);
    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
  });
}

function bulkPut(words) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    words.forEach((word) => store.put(word));
    transaction.oncomplete = () => resolve(words.length);
    transaction.onerror = () => reject(transaction.error);
  });
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(field.trim());
      field = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(field.trim());
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
      field = '';
      continue;
    }

    field += char;
  }

  row.push(field.trim());
  if (row.some((cell) => cell.length > 0)) rows.push(row);
  return rows;
}

function headerKey(header) {
  return String(header || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function getColumnMap(headers) {
  const map = {};
  headers.forEach((header, index) => {
    const key = headerKey(header);
    if (['word', 'term', 'vocab', 'vocabulary'].includes(key)) map.word = index;
    if (['englishmeaning', 'english', 'engmeaning', 'meaning', 'definition'].includes(key)) map.englishMeaning = index;
    if (['banglameaning', 'bengalimeaning', 'bangla', 'bengali', 'bnmeaning'].includes(key)) map.banglaMeaning = index;
    if (['sentence', 'sentences', 'example', 'examples', 'examplesentence'].includes(key)) map.sentence = index;
  });
  return map;
}

function createFreshWord(row, map, now) {
  const word = row[map.word]?.trim();
  if (!word) return null;
  const normalizedWord = normalizeWord(word);
  return {
    id: makeId(word),
    word,
    normalizedWord,
    englishMeaning: row[map.englishMeaning]?.trim() || '',
    banglaMeaning: row[map.banglaMeaning]?.trim() || '',
    sentence: row[map.sentence]?.trim() || '',
    status: 'new',
    createdAt: now,
    dueAt: null,
    lastReviewedAt: null,
    intervalDays: 0,
    repetitions: 0,
    lapses: 0,
    hardCount: 0,
    easyCount: 0,
    reviewCount: 0,
    mastered: false,
    phaseStats: {},
    totalPhaseShows: 0,
    easyFirstGo: false,
    confidenceDowngraded: false,
    currentDifficultyTier: 'Unscreened',
  };
}

function csvRowsToWords(rows) {
  if (!rows.length) return { words: [], error: 'The CSV file is empty.' };
  const map = getColumnMap(rows[0]);
  const required = ['word', 'englishMeaning', 'banglaMeaning', 'sentence'];
  const missing = required.filter((key) => map[key] === undefined);
  if (missing.length) {
    return {
      words: [],
      error: `Missing required column(s): ${missing.join(', ')}. Use word, englishMeaning, banglaMeaning, sentence.`,
    };
  }

  const now = new Date().toISOString();
  const words = rows.slice(1).map((row) => createFreshWord(row, map, now)).filter(Boolean);

  const deduped = [];
  const seen = new Set();
  for (const word of words) {
    if (!seen.has(word.normalizedWord)) {
      deduped.push(word);
      seen.add(word.normalizedWord);
    }
  }

  return { words: deduped, error: null };
}

function escapeHTML(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDateTime(value) {
  if (!value) return 'Not scheduled';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not scheduled';
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function shuffleCopy(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function sampleIds(ids, count, excluded = new Set()) {
  const available = shuffleCopy(ids.filter((id) => !excluded.has(id)));
  return available.slice(0, Math.max(0, count));
}

function uniqueIds(ids) {
  return [...new Set(ids.filter(Boolean))];
}

function getWordMap(words) {
  return new Map(words.map((word) => [word.id, word]));
}

function normalizeAdaptiveWord(word) {
  return {
    ...word,
    id: word.id || makeId(word.word),
    normalizedWord: word.normalizedWord || normalizeWord(word.word),
    phaseStats: word.phaseStats && typeof word.phaseStats === 'object' ? word.phaseStats : {},
    totalPhaseShows: Number(word.totalPhaseShows || 0),
    easyFirstGo: Boolean(word.easyFirstGo),
    confidenceDowngraded: Boolean(word.confidenceDowngraded),
    currentDifficultyTier: word.currentDifficultyTier || 'Unscreened',
    reviewCount: Number(word.reviewCount || 0),
    hardCount: Number(word.hardCount || 0),
    easyCount: Number(word.easyCount || 0),
    lapses: Number(word.lapses || 0),
  };
}

function stripAdaptiveProgress(word) {
  return {
    ...normalizeAdaptiveWord(word),
    status: 'new',
    dueAt: null,
    lastReviewedAt: null,
    intervalDays: 0,
    repetitions: 0,
    lapses: 0,
    hardCount: 0,
    easyCount: 0,
    reviewCount: 0,
    mastered: false,
    phaseStats: {},
    totalPhaseShows: 0,
    easyFirstGo: false,
    confidenceDowngraded: false,
    currentDifficultyTier: 'Unscreened',
  };
}

function getStatsForPhase(word, phase) {
  return (word.phaseStats || {})[String(phase)] || null;
}

function hasCompletedPhase(word, phase) {
  return Boolean(getStatsForPhase(word, phase)?.completed);
}

function completedEasyOnFirstShow(word, phase) {
  const stats = getStatsForPhase(word, phase);
  return Boolean(stats && stats.completed && stats.finalRating === 'easy' && Number(stats.shown || 0) === 1);
}

function phaseShowCount(word, phase) {
  return Number(getStatsForPhase(word, phase)?.shown || 0);
}

function phaseHardAgainCount(word, phase) {
  const stats = getStatsForPhase(word, phase);
  return Number((stats?.again || 0) + (stats?.hard || 0));
}

function hasStruggledAfterPhaseOne(word) {
  const phaseStats = word.phaseStats || {};
  return Object.entries(phaseStats).some(([phase, stats]) => Number(phase) > 1 && Number((stats?.again || 0) + (stats?.hard || 0)) > 0);
}

function isConfidenceWord(word) {
  return Boolean(word.easyFirstGo || completedEasyOnFirstShow(word, 1)) && !word.confidenceDowngraded && !hasStruggledAfterPhaseOne(word);
}

function getDifficultyScore(word, phaseBasis) {
  const stats = getStatsForPhase(word, phaseBasis) || {};
  const shown = Number(stats.shown || 0);
  const hardAgain = Number((stats.again || 0) + (stats.hard || 0));
  const totalHardAgain = Object.values(word.phaseStats || {}).reduce((sum, item) => sum + Number((item?.again || 0) + (item?.hard || 0)), 0);
  return shown * 10 + hardAgain * 8 + totalHardAgain * 2 + Math.random();
}

function getDifficultyTier(word) {
  if (isConfidenceWord(word)) return 'Confidence';

  const completedPhases = Object.keys(word.phaseStats || {})
    .map(Number)
    .filter((phase) => hasCompletedPhase(word, phase))
    .sort((a, b) => b - a);

  if (!completedPhases.length) return 'Unscreened';

  const latest = completedPhases[0];
  const shown = phaseShowCount(word, latest);
  const hardAgain = phaseHardAgainCount(word, latest);

  if (hardAgain >= 3 || shown >= 8) return 'High';
  if (hardAgain >= 1 || shown >= 5) return 'Medium';
  if (shown >= 2) return 'Low';
  if (completedEasyOnFirstShow(word, latest)) return 'Confidence';
  return 'Low';
}

function getLevel(word) {
  const tier = getDifficultyTier(word);
  if (tier === 'Confidence') return 'Confidence';
  if (tier === 'High') return 'High difficulty';
  if (tier === 'Medium') return 'Medium difficulty';
  if (tier === 'Low') return 'Low difficulty';
  return 'Unscreened';
}

function getActiveWordsForPhase(words, phase) {
  if (phase === 1) return [...words];

  const previousPhase = phase - 1;
  return words.filter((word) => {
    if (!hasCompletedPhase(word, previousPhase)) return false;
    const previousStats = getStatsForPhase(word, previousPhase) || {};

    // Confidence/filler words stay outside the pressure pool unless the learner struggled with them.
    if (previousStats.role !== 'active') {
      return Number((previousStats.again || 0) + (previousStats.hard || 0)) > 0;
    }

    // Active words are dropped only when they become Easy on the first show of that phase.
    return !completedEasyOnFirstShow(word, previousPhase);
  });
}

function getConfidenceWords(words) {
  return words.filter(isConfidenceWord);
}

function buildGroupsForPhase(words, phase) {
  const safeWords = words.map(normalizeAdaptiveWord);
  if (!safeWords.length) return [];

  if (phase === 1) {
    return chunkArray(shuffleCopy(safeWords.map((word) => word.id)), PHASE_ONE_GROUP_SIZE).map((ids, index) => ({
      id: `p1-g${index + 1}`,
      phase: 1,
      groupNumber: index + 1,
      activeIds: ids,
      confidenceIds: [],
      fillerIds: [],
      wordIds: ids,
      createdAt: new Date().toISOString(),
    }));
  }

  const activeWords = getActiveWordsForPhase(safeWords, phase);
  if (!activeWords.length) return [];

  const previousPhase = phase - 1;
  const activeIds = [...activeWords]
    .sort((a, b) => getDifficultyScore(b, previousPhase) - getDifficultyScore(a, previousPhase))
    .map((word) => word.id);

  const activeSlots = Math.max(1, LATER_PHASE_GROUP_SIZE - CONFIDENCE_WORDS_PER_GROUP);
  const activeChunks = chunkArray(activeIds, activeSlots);
  const confidenceIds = getConfidenceWords(safeWords).map((word) => word.id);
  const allIds = safeWords.map((word) => word.id);
  const activeIdSet = new Set(activeIds);
  const nonActiveIds = allIds.filter((id) => !activeIdSet.has(id));

  return activeChunks.map((chunk, index) => {
    const excluded = new Set(chunk);
    const confidence = sampleIds(confidenceIds, CONFIDENCE_WORDS_PER_GROUP, excluded);
    confidence.forEach((id) => excluded.add(id));

    const targetSize = safeWords.length >= LATER_PHASE_GROUP_SIZE ? LATER_PHASE_GROUP_SIZE : safeWords.length;
    const fillerNeeded = Math.max(0, targetSize - chunk.length - confidence.length);
    let filler = sampleIds(nonActiveIds, fillerNeeded, excluded);

    if (filler.length < fillerNeeded) {
      const expandedExcluded = new Set([...excluded, ...filler]);
      filler = [...filler, ...sampleIds(allIds, fillerNeeded - filler.length, expandedExcluded)];
    }

    const wordIds = shuffleCopy(uniqueIds([...chunk, ...confidence, ...filler]));

    return {
      id: `p${phase}-g${index + 1}`,
      phase,
      groupNumber: index + 1,
      activeIds: chunk,
      confidenceIds: confidence,
      fillerIds: filler,
      wordIds,
      createdAt: new Date().toISOString(),
    };
  });
}

function makeAdaptivePlan(words, phase = 1) {
  const groups = buildGroupsForPhase(words, phase);
  return {
    version: ADAPTIVE_PLAN_VERSION,
    phase,
    maxPhase: MAX_PHASE,
    groupIndex: 0,
    groups,
    completed: groups.length === 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function getAdaptivePlan() {
  return getSettings().adaptivePlan || null;
}

function saveAdaptivePlan(plan) {
  saveSettings({ adaptivePlan: { ...plan, updatedAt: new Date().toISOString() } });
}

function getCurrentGroup(plan) {
  if (!plan || plan.completed || !Array.isArray(plan.groups)) return null;
  return plan.groups[plan.groupIndex] || null;
}

function roleForWordInGroup(group, wordId) {
  if (!group) return 'active';
  if ((group.activeIds || []).includes(wordId)) return 'active';
  if ((group.confidenceIds || []).includes(wordId)) return 'confidence';
  if ((group.fillerIds || []).includes(wordId)) return 'filler';
  return 'active';
}

function isGroupCompleted(group, wordMap, phase) {
  if (!group || !Array.isArray(group.wordIds) || !group.wordIds.length) return true;
  return group.wordIds.every((id) => {
    const word = wordMap.get(id);
    return !word || hasCompletedPhase(word, phase);
  });
}

function getRemainingInGroup(group, wordMap, phase) {
  if (!group || !Array.isArray(group.wordIds)) return 0;
  return group.wordIds.filter((id) => {
    const word = wordMap.get(id);
    return word && !hasCompletedPhase(word, phase);
  }).length;
}

async function ensureAdaptivePlan(wordsArg = null) {
  const words = (wordsArg || await getAllWords()).map(normalizeAdaptiveWord);
  let plan = getAdaptivePlan();

  if (!words.length) {
    if (plan) saveAdaptivePlan({ ...plan, completed: true, groups: [], groupIndex: 0 });
    return null;
  }

  if (!plan || plan.version !== ADAPTIVE_PLAN_VERSION || !Array.isArray(plan.groups)) {
    plan = makeAdaptivePlan(words, 1);
    saveAdaptivePlan(plan);
  }

  plan = await advancePastCompletedGroups(plan, words);
  return plan;
}

async function advancePastCompletedGroups(planArg = null, wordsArg = null) {
  let plan = planArg || getAdaptivePlan();
  const words = (wordsArg || await getAllWords()).map(normalizeAdaptiveWord);
  const wordMap = getWordMap(words);

  if (!plan || plan.completed) return plan;

  let safety = 0;
  while (plan && !plan.completed && safety < 50) {
    safety += 1;
    const group = getCurrentGroup(plan);

    if (!group) {
      const rebuilt = buildGroupsForPhase(words, plan.phase || 1);
      plan = { ...plan, groups: rebuilt, groupIndex: 0, completed: rebuilt.length === 0 };
      if (plan.completed) break;
    }

    const currentGroup = getCurrentGroup(plan);
    if (!isGroupCompleted(currentGroup, wordMap, plan.phase)) break;

    if (plan.groupIndex < plan.groups.length - 1) {
      plan = { ...plan, groupIndex: plan.groupIndex + 1 };
      continue;
    }

    if (plan.phase >= MAX_PHASE) {
      plan = { ...plan, completed: true };
      break;
    }

    const nextPhase = plan.phase + 1;
    const nextGroups = buildGroupsForPhase(words, nextPhase);
    if (!nextGroups.length) {
      plan = { ...plan, completed: true, phase: nextPhase, groups: [], groupIndex: 0 };
      break;
    }

    plan = {
      ...plan,
      phase: nextPhase,
      groupIndex: 0,
      groups: nextGroups,
      completed: false,
    };
  }

  saveAdaptivePlan(plan);
  return plan;
}

async function resetAdaptiveSystem({ wipeProgress = true } = {}) {
  const words = await getAllWords();
  const prepared = wipeProgress ? words.map(stripAdaptiveProgress) : words.map(normalizeAdaptiveWord);
  if (prepared.length) await bulkPut(prepared);
  const plan = makeAdaptivePlan(prepared, 1);
  saveAdaptivePlan(plan);
  saveTodayStats({ reviewed: 0, introduced: 0 });
  return plan;
}

function makeCardFromWord(word, group, phase) {
  const role = roleForWordInGroup(group, word.id);
  return {
    ...word,
    _reviewPhase: phase,
    _reviewRole: role,
  };
}

function updatePhaseStats(word, rating, phase, role) {
  const now = new Date().toISOString();
  const updated = normalizeAdaptiveWord({ ...word });
  const key = String(phase);
  const existingStats = updated.phaseStats[key] || {
    phase,
    role,
    shown: 0,
    again: 0,
    hard: 0,
    good: 0,
    easy: 0,
    completed: false,
    firstRating: null,
    finalRating: null,
    startedAt: now,
    completedAt: null,
  };

  const stats = {
    ...existingStats,
    phase,
    role: existingStats.role || role,
    shown: Number(existingStats.shown || 0) + 1,
    again: Number(existingStats.again || 0),
    hard: Number(existingStats.hard || 0),
    good: Number(existingStats.good || 0),
    easy: Number(existingStats.easy || 0),
  };

  stats[rating] = Number(stats[rating] || 0) + 1;
  if (!stats.firstRating) stats.firstRating = rating;

  if (rating === 'good' || rating === 'easy') {
    stats.completed = true;
    stats.finalRating = rating;
    stats.completedAt = now;
  } else {
    stats.completed = false;
    stats.finalRating = rating;
    stats.completedAt = null;
  }

  updated.phaseStats = {
    ...updated.phaseStats,
    [key]: stats,
  };

  updated.totalPhaseShows = Number(updated.totalPhaseShows || 0) + 1;
  updated.reviewCount = Number(updated.reviewCount || 0) + 1;
  updated.lastReviewedAt = now;
  updated.status = stats.completed ? 'phase-complete' : 'learning';
  updated.dueAt = null;
  updated.mastered = false;

  if (rating === 'again') {
    updated.lapses = Number(updated.lapses || 0) + 1;
  }
  if (rating === 'hard') {
    updated.hardCount = Number(updated.hardCount || 0) + 1;
  }
  if (rating === 'easy') {
    updated.easyCount = Number(updated.easyCount || 0) + 1;
  }

  if (phase === 1 && rating === 'easy' && stats.shown === 1) {
    updated.easyFirstGo = true;
  }

  if (phase > 1 && (rating === 'again' || rating === 'hard') && updated.easyFirstGo) {
    updated.confidenceDowngraded = true;
  }

  updated.currentDifficultyTier = getDifficultyTier(updated);
  return updated;
}

async function getDashboardStats() {
  const words = (await getAllWords()).map(normalizeAdaptiveWord);
  const plan = await ensureAdaptivePlan(words);
  const today = getTodayStats();
  const wordMap = getWordMap(words);
  const group = getCurrentGroup(plan);
  const confidence = words.filter(isConfidenceWord).length;
  const highDifficulty = words.filter((word) => getDifficultyTier(word) === 'High').length;
  const activePool = plan && !plan.completed ? getActiveWordsForPhase(words, plan.phase).length : 0;
  const remaining = plan && group ? getRemainingInGroup(group, wordMap, plan.phase) : 0;

  return {
    total: words.length,
    plan,
    phase: plan?.phase || 1,
    groupNumber: plan && group ? plan.groupIndex + 1 : 0,
    groupTotal: plan?.groups?.length || 0,
    remaining,
    confidence,
    highDifficulty,
    activePool,
    reviewedToday: today.reviewed,
  };
}

async function renderHome() {
  const stats = await getDashboardStats();
  const plan = stats.plan;
  const phaseText = plan?.completed ? 'Complete' : `Phase ${stats.phase}`;
  const groupText = plan?.completed ? 'Done' : `${stats.groupNumber} / ${stats.groupTotal}`;

  const items = [
    ['Total words', stats.total],
    ['Current phase', phaseText],
    ['Current group', groupText],
    ['Left in group', stats.remaining],
    ['Confidence pool', stats.confidence],
    ['Hardest words', stats.highDifficulty],
  ];

  const grid = $('#statsGrid');
  grid.innerHTML = '';
  const template = $('#statTemplate');
  items.forEach(([label, value]) => {
    const node = template.content.cloneNode(true);
    node.querySelector('.stat-label').textContent = label;
    node.querySelector('.stat-value').textContent = value;
    grid.appendChild(node);
  });

  const status = $('#phaseStatusText');
  if (status) {
    if (!stats.total) {
      status.textContent = 'Upload a CSV to generate Phase 1 groups of 25 words.';
    } else if (plan?.completed) {
      status.textContent = 'Adaptive cycle complete. Restart phases anytime if you want a fresh run.';
    } else if (stats.phase === 1) {
      status.textContent = `Phase 1 uses random groups of 25. Finish every word in Group ${stats.groupNumber} with Good or Easy.`;
    } else {
      status.textContent = `Phase ${stats.phase} uses groups of at least 20, with about 3 confidence words mixed into each group.`;
    }
  }
}

async function buildReviewQueue() {
  const words = (await getAllWords()).map(normalizeAdaptiveWord);
  const plan = await ensureAdaptivePlan(words);
  const wordMap = getWordMap(words);
  const group = getCurrentGroup(plan);

  reviewQueue = [];
  currentIndex = 0;
  currentCard = null;

  if (!plan || plan.completed || !group) {
    sessionStats = makeBlankSessionStats();
    return;
  }

  const unfinished = group.wordIds
    .map((id) => wordMap.get(id))
    .filter((word) => word && !hasCompletedPhase(word, plan.phase))
    .map((word) => makeCardFromWord(word, group, plan.phase));

  reviewQueue = shuffleCopy(unfinished);
  sessionStats = {
    ...makeBlankSessionStats(),
    total: reviewQueue.length,
    introduced: unfinished.filter((word) => phaseShowCount(word, plan.phase) === 0).length,
    phase: plan.phase,
    group: plan.groupIndex + 1,
    groups: plan.groups.length,
  };
}

async function renderCurrentCard() {
  $('#sessionDone').classList.add('hidden');
  $('#reviewCard').classList.remove('hidden');

  if (!reviewQueue.length || currentIndex >= reviewQueue.length) {
    await finishSession();
    return;
  }

  currentCard = reviewQueue[currentIndex];
  const phase = currentCard._reviewPhase || sessionStats.phase;
  const role = currentCard._reviewRole || 'active';
  const roleLabel = role === 'confidence' ? 'Confidence word' : role === 'filler' ? 'Light review' : getLevel(currentCard);

  $('#reviewProgress').textContent = `P${sessionStats.phase} · G${sessionStats.group}/${sessionStats.groups} · ${currentIndex + 1}/${reviewQueue.length}`;
  $('#reviewLabel').textContent = `${roleLabel} · Seen ${phaseShowCount(currentCard, phase)} time(s) this phase`;
  $('#questionWord').textContent = currentCard.word;
  $('#englishMeaning').textContent = currentCard.englishMeaning || '—';
  $('#banglaMeaning').textContent = currentCard.banglaMeaning || '—';
  $('#sentenceText').textContent = currentCard.sentence || '—';
  $('#answerBlock').classList.add('hidden');
  $('#ratingBar').classList.add('hidden');
  $('#showAnswerBtn').classList.remove('hidden');
}

async function finishSession() {
  $('#reviewProgress').textContent = 'Done';
  $('#reviewCard').classList.add('hidden');
  const panel = $('#sessionDone');
  panel.classList.remove('hidden');

  const reviewed = sessionStats.again + sessionStats.hard + sessionStats.good + sessionStats.easy;
  const beforePhase = sessionStats.phase;
  const beforeGroup = sessionStats.group;
  const plan = await advancePastCompletedGroups();

  let title = 'Group complete';
  let message = `Finished Phase ${beforePhase}, Group ${beforeGroup}.`;
  let buttonText = 'Continue';
  let target = 'review';

  if (!reviewed) {
    title = 'No cards ready';
    message = 'Upload a CSV file or restart the adaptive phases.';
    buttonText = 'Upload Words';
    target = 'upload';
  } else if (plan?.completed) {
    title = 'Adaptive cycle complete';
    message = `You finished the active learning cycle through Phase ${Math.min(beforePhase, MAX_PHASE)}. Confidence words remain saved for future restart/review.`;
    buttonText = 'Back to Home';
    target = 'home';
  } else if (plan?.phase !== beforePhase) {
    title = `Phase ${beforePhase} complete`;
    message = `Now starting Phase ${plan.phase}. Groups are rebuilt from recorded difficulty, with confidence words mixed in.`;
  } else {
    message = `Next: Phase ${plan.phase}, Group ${(plan.groupIndex || 0) + 1} of ${plan.groups?.length || 1}.`;
  }

  panel.innerHTML = `
    <h2>${escapeHTML(title)}</h2>
    <p class="muted">${escapeHTML(message)}</p>
    <div class="stats-grid">
      <div class="stat-card"><span class="stat-label">Again</span><strong class="stat-value">${sessionStats.again}</strong></div>
      <div class="stat-card"><span class="stat-label">Hard</span><strong class="stat-value">${sessionStats.hard}</strong></div>
      <div class="stat-card"><span class="stat-label">Good</span><strong class="stat-value">${sessionStats.good}</strong></div>
      <div class="stat-card"><span class="stat-label">Easy</span><strong class="stat-value">${sessionStats.easy}</strong></div>
    </div>
    <button class="primary big" type="button" data-next-target="${target}">${escapeHTML(buttonText)}</button>
  `;

  panel.querySelector('[data-next-target]').addEventListener('click', (event) => {
    const nextTarget = event.currentTarget.getAttribute('data-next-target');
    if (nextTarget === 'review') startReview();
    else navigate(nextTarget);
  });
}

async function startReview() {
  await buildReviewQueue();
  navigate('review', { skipBuild: true });
  if (!reviewQueue.length) {
    $('#reviewProgress').textContent = '0 / 0';
    $('#reviewCard').classList.add('hidden');
    const panel = $('#sessionDone');
    const plan = getAdaptivePlan();
    panel.classList.remove('hidden');
    panel.innerHTML = `
      <h2>${plan?.completed ? 'Adaptive cycle complete' : 'No cards ready'}</h2>
      <p class="muted">${plan?.completed ? 'All active phase groups are complete. You can restart phases from Home if needed.' : 'Upload a CSV file to generate your first random Phase 1 groups.'}</p>
      <button class="primary big" type="button" data-nav="${plan?.completed ? 'home' : 'upload'}">${plan?.completed ? 'Back to Home' : 'Upload Words'}</button>
    `;
    panel.querySelector('[data-nav]').addEventListener('click', (event) => navigate(event.currentTarget.dataset.nav));
    return;
  }
  await renderCurrentCard();
}

function setRatingButtonsDisabled(disabled) {
  $$('.rate').forEach((button) => {
    button.disabled = disabled;
  });
}

async function rateCurrentCard(rating) {
  if (!currentCard || isRating) return;
  isRating = true;
  setRatingButtonsDisabled(true);

  try {
    const phase = currentCard._reviewPhase || sessionStats.phase;
    const role = currentCard._reviewRole || 'active';
    const updated = updatePhaseStats(currentCard, rating, phase, role);
    await putWord(updated);

    sessionStats[rating] += 1;
    const today = getTodayStats();
    saveTodayStats({
      reviewed: today.reviewed + 1,
      introduced: today.introduced + (phaseShowCount(currentCard, phase) === 0 ? 1 : 0),
    });

    if (rating === 'again' || rating === 'hard') {
      reviewQueue.push(makeCardFromWord(updated, getCurrentGroup(getAdaptivePlan()), phase));
    }

    currentIndex += 1;
    await renderCurrentCard();
  } finally {
    setRatingButtonsDisabled(false);
    isRating = false;
  }
}

function showAnswer() {
  if (!currentCard) return;
  $('#answerBlock').classList.remove('hidden');
  $('#ratingBar').classList.remove('hidden');
  $('#showAnswerBtn').classList.add('hidden');
}

async function handleCSVUpload(file) {
  if (!file) return;
  const status = $('#uploadStatus');
  status.textContent = 'Reading file...';
  const text = await file.text();
  const rows = parseCSV(text.replace(/^\uFEFF/, ''));
  const parsed = csvRowsToWords(rows);

  if (parsed.error) {
    pendingImportRows = [];
    $('#previewPanel').classList.add('hidden');
    status.textContent = parsed.error;
    return;
  }

  pendingImportRows = parsed.words;
  status.textContent = `${pendingImportRows.length} valid words found.`;
  renderPreview(pendingImportRows);
}

function renderPreview(words) {
  const previewPanel = $('#previewPanel');
  const previewList = $('#previewList');
  previewPanel.classList.remove('hidden');
  $('#previewSummary').textContent = `${words.length} words ready. Importing starts a fresh adaptive Phase 1 plan.`;
  previewList.innerHTML = '';

  words.slice(0, 8).forEach((word) => {
    const item = document.createElement('div');
    item.className = 'preview-item';
    item.innerHTML = `
      <strong>${escapeHTML(word.word)}</strong>
      <p>${escapeHTML(word.englishMeaning)}</p>
      <p class="bangla">${escapeHTML(word.banglaMeaning)}</p>
    `;
    previewList.appendChild(item);
  });

  if (words.length > 8) {
    const item = document.createElement('div');
    item.className = 'preview-item muted';
    item.textContent = `+${words.length - 8} more words`;
    previewList.appendChild(item);
  }
}

async function importPendingWords() {
  if (!pendingImportRows.length) return;
  $('#importBtn').disabled = true;
  $('#importBtn').textContent = 'Importing...';

  const toInsert = [];
  let skipped = 0;

  for (const word of pendingImportRows) {
    const existing = await getWordByNormalized(word.normalizedWord);
    if (existing) {
      skipped += 1;
      continue;
    }
    toInsert.push(word);
  }

  await bulkPut(toInsert);

  // A CSV import represents a new source list, so the adaptive phase engine restarts cleanly.
  await resetAdaptiveSystem({ wipeProgress: true });

  $('#uploadStatus').textContent = `Imported ${toInsert.length} words. Skipped ${skipped} duplicate(s). Fresh Phase 1 groups generated.`;
  $('#previewPanel').classList.add('hidden');
  $('#csvFileInput').value = '';
  pendingImportRows = [];
  $('#importBtn').disabled = false;
  $('#importBtn').textContent = 'Import Words';
  await renderHome();
}

async function renderWordList() {
  const query = normalizeWord($('#wordSearchInput').value);
  const filter = $('#wordFilterSelect').value;
  const words = (await getAllWords()).map(normalizeAdaptiveWord);
  const plan = await ensureAdaptivePlan(words);
  const group = getCurrentGroup(plan);
  const currentGroupIds = new Set(group?.wordIds || []);

  let filtered = words;
  if (query) {
    filtered = filtered.filter((word) => normalizeWord(`${word.word} ${word.englishMeaning} ${word.banglaMeaning} ${word.sentence}`).includes(query));
  }
  if (filter === 'current') filtered = filtered.filter((word) => currentGroupIds.has(word.id));
  if (filter === 'confidence') filtered = filtered.filter(isConfidenceWord);
  if (filter === 'hard') filtered = filtered.filter((word) => getDifficultyTier(word) === 'High');
  if (filter === 'completed') filtered = filtered.filter((word) => plan && hasCompletedPhase(word, Math.min(plan.phase, MAX_PHASE)));

  filtered.sort((a, b) => a.word.localeCompare(b.word));

  const list = $('#wordList');
  list.innerHTML = '';

  if (!filtered.length) {
    list.innerHTML = '<div class="empty-state">No words found.</div>';
    return;
  }

  filtered.forEach((word) => {
    const item = document.createElement('article');
    const completedPhases = Object.keys(word.phaseStats || {}).filter((phase) => hasCompletedPhase(word, Number(phase))).length;
    const phaseDetails = Object.entries(word.phaseStats || {})
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([phase, stats]) => `P${phase}: ${stats.shown || 0} shown → ${stats.completed ? stats.finalRating : 'open'}`)
      .join(' · ');

    item.className = 'word-item';
    item.innerHTML = `
      <strong>${escapeHTML(word.word)}</strong>
      <p>${escapeHTML(word.englishMeaning)}</p>
      <p class="bangla">${escapeHTML(word.banglaMeaning)}</p>
      <p>${escapeHTML(word.sentence)}</p>
      <div class="word-meta">
        <span>${escapeHTML(getLevel(word))}</span>
        <span>Reviews: ${word.reviewCount || 0}</span>
        <span>Phases done: ${completedPhases}</span>
      </div>
      <p class="muted small-note">${escapeHTML(phaseDetails || 'Not screened yet')}</p>
      <div class="backup-actions" style="margin-top:12px">
        <button class="ghost" type="button" data-delete-id="${escapeHTML(word.id)}">Delete</button>
      </div>
    `;
    list.appendChild(item);
  });

  $$('[data-delete-id]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.getAttribute('data-delete-id');
      const confirmed = confirm('Delete this word from local storage?');
      if (!confirmed) return;
      await deleteWord(id);
      await resetAdaptiveSystem({ wipeProgress: false });
      await renderWordList();
      await renderHome();
    });
  });
}

async function exportBackup() {
  const words = await getAllWords();
  const payload = {
    app: 'Rapid Vocab',
    version: 2,
    exportedAt: new Date().toISOString(),
    settings: getSettings(),
    words,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `rapid-vocab-backup-${todayString()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function importBackup(file) {
  if (!file) return;
  const status = $('#uploadStatus');
  try {
    const payload = JSON.parse(await file.text());
    if (!Array.isArray(payload.words)) throw new Error('Backup file does not contain a words array.');

    const words = payload.words
      .filter((word) => word.word)
      .map((word) => normalizeAdaptiveWord({
        ...word,
        id: word.id || makeId(word.word),
        normalizedWord: word.normalizedWord || normalizeWord(word.word),
      }));

    await bulkPut(words);
    if (payload.settings) saveSettings(payload.settings);
    await ensureAdaptivePlan(words);
    status.textContent = `Backup imported. Restored ${words.length} words.`;
    await renderHome();
  } catch (error) {
    status.textContent = `Could not import backup: ${error.message}`;
  }
}

async function navigate(target, options = {}) {
  if (!views[target]) return;
  Object.entries(views).forEach(([name, view]) => view.classList.toggle('active', name === target));
  $$('.bottom-nav button').forEach((button) => button.classList.toggle('active', button.dataset.nav === target));

  if (target === 'home') await renderHome();
  if (target === 'review' && !options.skipBuild) await startReview();
  if (target === 'wordlist') await renderWordList();
}

function setupEvents() {
  $$('[data-nav]').forEach((button) => {
    button.addEventListener('click', () => navigate(button.dataset.nav));
  });

  $('#startReviewBtn').addEventListener('click', startReview);
  $('#showAnswerBtn').addEventListener('click', showAnswer);

  $$('.rate').forEach((button) => {
    button.addEventListener('click', () => rateCurrentCard(button.dataset.rating));
  });

  $('#csvFileInput').addEventListener('change', (event) => handleCSVUpload(event.target.files[0]));
  $('#importBtn').addEventListener('click', importPendingWords);
  $('#wordSearchInput').addEventListener('input', renderWordList);
  $('#wordFilterSelect').addEventListener('change', renderWordList);
  $('#exportJsonBtn').addEventListener('click', exportBackup);
  $('#jsonImportInput').addEventListener('change', (event) => importBackup(event.target.files[0]));

  const resetPlanBtn = $('#resetPlanBtn');
  if (resetPlanBtn) {
    resetPlanBtn.addEventListener('click', async () => {
      const confirmed = confirm('Restart adaptive phases from Phase 1? This clears phase progress but keeps your words.');
      if (!confirmed) return;
      await resetAdaptiveSystem({ wipeProgress: true });
      await renderHome();
    });
  }

  window.addEventListener('keydown', (event) => {
    if (!views.review.classList.contains('active')) return;
    if (event.target.matches('input, textarea, select')) return;
    if (event.code === 'Space') {
      event.preventDefault();
      if (!$('#showAnswerBtn').classList.contains('hidden')) showAnswer();
    }
    if (!$('#ratingBar').classList.contains('hidden')) {
      const map = { Digit1: 'again', Digit2: 'hard', Digit3: 'good', Digit4: 'easy' };
      if (map[event.code]) rateCurrentCard(map[event.code]);
    }
  });

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    $('#installBtn').classList.remove('hidden');
  });

  $('#installBtn').addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    $('#installBtn').classList.add('hidden');
  });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('./service-worker.js');
  } catch (error) {
    console.warn('Service worker registration failed:', error);
  }
}

async function init() {
  db = await openDb();
  setupEvents();
  await registerServiceWorker();
  await renderHome();
}

init().catch((error) => {
  document.body.innerHTML = `<main style="padding:24px;color:white;font-family:sans-serif"><h1>Could not start Rapid Vocab</h1><p>${escapeHTML(error.message)}</p></main>`;
});
