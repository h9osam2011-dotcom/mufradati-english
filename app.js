const DATA_KEY = 'mufradati-english-v1';
const EXPECTED_WORDS = 400;
const PHASES = ['writing', 'pronunciation', 'sentence'];
const PHASE_LABELS = { writing: 'الكتابة', pronunciation: 'النطق', sentence: 'تكوين الجمل' };
const app = document.getElementById('app');
const toast = document.getElementById('toast');
const nav = document.getElementById('main-nav');
let words = [];
let state;
let page = 'home';
let pageSize = 30;
let listPage = 1;
let listFilters = { q: '', saved: 'all', week: 'all', month: 'all', sort: 'source' };
let errorFilter = 'all';
let toastTimer;
let recognition = null;

const freshProgress = () => ({
  studyDate: null, week: null, month: null, mastered: false, status: 'unreviewed', reviewedAt: null,
  reviewCount: 0, stageStats: Object.fromEntries(PHASES.map(k => [k, { attempts: 0, correct: 0, wrong: 0, skipped: 0 }])), practice: {}
});
const freshState = () => ({
  schemaVersion: 1, startedAt: null, updatedAt: null, settings: { successThreshold: 80 },
  progress: {}, dailySessions: {}, activeDailyDate: null, activeReview: null, attempts: [], errors: {}, log: []
});
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayString = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dateLabel = value => value ? new Date(`${value}T12:00:00`).toLocaleDateString('ar', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
const uid = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const normalize = value => String(value ?? '').trim().toLocaleLowerCase('en-US');
const progressFor = id => state.progress[id] || (state.progress[id] = freshProgress());
const wordById = id => words.find(word => word.id === id);
const wordStatusLabel = p => p.mastered ? 'حفظتها' : p.status === 'learning' ? 'أتدرّب عليها' : 'لم أراجعها بعد';
const formatDateTime = value => value ? new Date(value).toLocaleString('ar', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

function setSaveStatus(ok, message) {
  const el = document.getElementById('save-status');
  if (!el) return;
  el.classList.toggle('unsaved', !ok);
  el.lastElementChild.textContent = message || (ok ? 'محفوظ على هذا الجهاز' : 'تعذّر الحفظ');
}

function saveState() {
  state.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(DATA_KEY, JSON.stringify(state));
    setSaveStatus(true);
  } catch (error) {
    setSaveStatus(false, 'تعذّر الحفظ؛ مساحة المتصفح ممتلئة');
    showToast('لم يتم حفظ التغيير. صدّر نسخة احتياطية وأفرغ مساحة المتصفح.');
    console.error('Local save failed', error);
  }
}

function appendLog(type, text, wordId = null, meta = {}) {
  state.log.unshift({ id: uid('log'), at: new Date().toISOString(), type, text, wordId, meta });
  if (state.log.length > 3000) state.log.length = 3000;
}

function loadState() {
  state = freshState();
  try {
    const raw = localStorage.getItem(DATA_KEY);
    if (raw) {
      const loaded = JSON.parse(raw);
      if (loaded && typeof loaded === 'object') state = { ...freshState(), ...loaded, settings: { ...freshState().settings, ...(loaded.settings || {}) } };
    }
  } catch (error) {
    console.error('Saved progress could not be read', error);
    showToast('تعذر قراءة التقدم السابق؛ لم يتم استبدال بيانات التخزين.');
  }
  state.progress ||= {};
  state.dailySessions ||= {};
  state.attempts ||= [];
  state.errors ||= {};
  state.log ||= [];
  for (const word of words) state.progress[word.id] = { ...freshProgress(), ...(state.progress[word.id] || {}) };
  for (const p of Object.values(state.progress)) {
    p.stageStats ||= {};
    for (const phase of PHASES) p.stageStats[phase] = { attempts: 0, correct: 0, wrong: 0, skipped: 0, ...(p.stageStats[phase] || {}) };
    p.practice ||= {};
  }
}

function dateDiffDays(start, end) {
  if (!start || !end) return 0;
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  return Math.max(0, Math.floor((b - a) / 86400000));
}

function assignStudy(id, date = todayString()) {
  const p = progressFor(id);
  if (p.studyDate) return false;
  if (!state.startedAt || date < state.startedAt) state.startedAt = date;
  p.studyDate = date;
  const elapsed = dateDiffDays(state.startedAt, date);
  p.week = Math.floor(elapsed / 7) + 1;
  p.month = Math.floor(elapsed / 28) + 1;
  p.updatedAt = new Date().toISOString();
  appendLog('study', `بدأت دراسة كلمة ${wordById(id)?.english || ''}`, id, { date, week: p.week, month: p.month });
  return true;
}

function setMastered(id, value) {
  const p = progressFor(id);
  const next = Boolean(value);
  if (next && !p.studyDate) assignStudy(id);
  p.mastered = next;
  p.status = next ? 'mastered' : 'learning';
  p.reviewedAt = todayString();
  p.reviewCount = (p.reviewCount || 0) + 1;
  p.updatedAt = new Date().toISOString();
  markDailyReviewed(id);
  appendLog(next ? 'mastered' : 'unmastered', next ? 'علّمت الكلمة على أنها محفوظة' : 'ألغيت علامة الحفظ', id);
  saveState();
}

function ensureDailySession(date = todayString()) {
  if (state.dailySessions[date]) return state.dailySessions[date];
  const reserved = new Set(Object.entries(state.dailySessions).filter(([sessionDate]) => sessionDate !== date).flatMap(([, session]) => session.wordIds || []));
  const newIds = words.filter(word => {
    const p = progressFor(word.id);
    return !p.studyDate && !p.mastered && !reserved.has(word.id);
  }).slice(0, 5).map(word => word.id);
  const session = { id: `daily-${date}`, date, wordIds: newIds, reviewedIds: [], currentIndex: 0, completed: newIds.length === 0, createdAt: new Date().toISOString() };
  state.dailySessions[date] = session;
  saveState();
  return session;
}

function activeDailySession() {
  const date = state.activeDailyDate || todayString();
  state.activeDailyDate = date;
  return ensureDailySession(date);
}

function markDailyReviewed(id) {
  const session = state.dailySessions[state.activeDailyDate || todayString()];
  if (!session || !session.wordIds.includes(id)) return;
  session.reviewedIds ||= [];
  if (!session.reviewedIds.includes(id)) session.reviewedIds.push(id);
}

function studyStats() {
  const studied = words.filter(w => progressFor(w.id).studyDate).length;
  const mastered = words.filter(w => progressFor(w.id).mastered).length;
  const today = todayString();
  const todayLearned = words.filter(w => progressFor(w.id).studyDate === today).length;
  return { studied, mastered, remaining: words.length - mastered, percentage: words.length ? Math.round(mastered / words.length * 100) : 0, todayLearned };
}

function addError(id, type, answer, correction, source = 'practice') {
  const key = `${id}:${type}`;
  const error = state.errors[key] || { id: key, wordId: id, type, occurrences: [], reviewed: false };
  error.occurrences.push({ id: uid('failure'), answer: String(answer ?? ''), correction: String(correction ?? ''), at: new Date().toISOString(), source });
  error.reviewed = false;
  state.errors[key] = error;
}

function recordPractice(id, phase, result, answer, correction, errorAfter = true) {
  const p = progressFor(id);
  const stat = p.stageStats[phase];
  stat.attempts += 1;
  if (result === 'correct') stat.correct += 1;
  if (result === 'wrong') stat.wrong += 1;
  if (result === 'skipped') stat.skipped += 1;
  if (result !== 'skipped' && !p.mastered) p.status = 'learning';
  if (result === 'wrong' && errorAfter) addError(id, phase, answer, correction, 'daily-practice');
  p.reviewedAt = todayString();
  p.reviewCount = (p.reviewCount || 0) + 1;
  p.updatedAt = new Date().toISOString();
  if (result !== 'skipped') markDailyReviewed(id);
  appendLog('practice', `تدريب ${PHASE_LABELS[phase]}: ${result === 'correct' ? 'صحيح' : result === 'wrong' ? 'يحتاج إلى مراجعة' : 'تم التخطي'}`, id, { phase, result, answer });
  saveState();
}

function dayWords(session, modeReview = false) {
  if (modeReview) return words.filter(w => progressFor(w.id).studyDate && !session?.wordIds?.includes(w.id));
  return (session?.wordIds || []).map(wordById).filter(Boolean);
}

function speakWord(word) {
  if (!('speechSynthesis' in window)) return showToast('النطق الصوتي غير مدعوم في هذا المتصفح.');
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(word.english);
  utterance.lang = 'en-US';
  utterance.rate = 0.86;
  const voice = window.speechSynthesis.getVoices().find(v => /^en(-|_)/i.test(v.lang) && /US|UK|English/i.test(`${v.lang} ${v.name}`));
  if (voice) utterance.voice = voice;
  window.speechSynthesis.speak(utterance);
}

function speechSupport() { return window.SpeechRecognition || window.webkitSpeechRecognition || null; }

function startRecognition(onResult, onError) {
  const API = speechSupport();
  if (!API) {
    onError?.('التعرّف على الكلام غير مدعوم هنا. استخدم «تخطي»؛ لم نسجّل خطأ نطق.');
    return null;
  }
  try {
    const recognitionInstance = new API();
    recognition = recognitionInstance;
    recognitionInstance.lang = 'en-US';
    recognitionInstance.continuous = false;
    recognitionInstance.interimResults = false;
    recognitionInstance.maxAlternatives = 1;
    recognitionInstance.onresult = event => onResult(event.results?.[0]?.[0]?.transcript || '');
    recognitionInstance.onerror = event => onError?.(event.error === 'not-allowed' ? 'لم يُسمح باستخدام الميكروفون. يمكنك التخطي دون تسجيل خطأ.' : `تعذّر التعرف على الكلام (${event.error || 'خطأ غير معروف'}). يمكنك إعادة المحاولة أو التخطي.`);
    recognitionInstance.onend = () => { if (recognition === recognitionInstance) recognition = null; };
    recognitionInstance.start();
    return recognitionInstance;
  } catch (error) {
    onError?.('تعذّر بدء الميكروفون. أعد المحاولة أو تخطَّ السؤال.');
    return null;
  }
}

function navigate(next) {
  page = next;
  nav.classList.remove('open');
  document.getElementById('menu-toggle').setAttribute('aria-expanded', 'false');
  render();
  app.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function statCard(label, value, foot = '') {
  return `<div class="stat-card"><span class="stat-label">${label}</span><div class="stat-value">${value}</div>${foot ? `<div class="stat-foot">${foot}</div>` : ''}</div>`;
}

function renderHome() {
  const stats = studyStats();
  const last = [...state.attempts].filter(a => a.status === 'complete').sort((a, b) => (b.finishedAt || '').localeCompare(a.finishedAt || ''))[0];
  const reviewWords = words.filter(w => !progressFor(w.id).mastered && (progressFor(w.id).studyDate || Object.keys(state.errors).some(key => key.startsWith(`${w.id}:`)))).slice(0, 8);
  const recentDaySession = state.dailySessions[todayString()];
  const dailyReviewed = recentDaySession ? (recentDaySession.reviewedIds || []).length : 0;
  const discrepancy = words.length !== EXPECTED_WORDS ? `<div class="notice"><span>⚠</span><div><strong>تنبيه الاستيراد:</strong> المتوقع ${EXPECTED_WORDS} كلمة، لكن الملف يحتوي على <strong>${words.length}</strong> سجلًا. احتفظنا بكل السجلات وبترتيبها؛ لم نحذف أي كلمة.</div></div>` : '';
  return `${discrepancy}<section class="hero">
    <div class="welcome-card"><div class="eyebrow">مسار تعلمك الشخصي</div><h1>كل يوم كلمة، وكل كلمة خطوة للأمام.</h1><p>تعلّم خمس كلمات جديدة في اليوم، تدرب على تذكّرها ونطقها واستخدامها، وارجع إلى تقدمك واختباراتك وقتما تشاء.</p><div class="actions"><button class="btn btn-primary" data-action="go-daily">ابدأ كلمات اليوم</button><button class="btn btn-plain" data-action="go-words">تصفّح جميع الكلمات</button></div></div>
    <div class="panel daily-mini"><div><div class="eyebrow">إنجاز اليوم</div><div class="daily-number">${dailyReviewed} / ${recentDaySession?.wordIds.length || Math.min(5, words.filter(w => !progressFor(w.id).studyDate && !progressFor(w.id).mastered).length)}</div><p class="muted" style="font-size:11px;margin:4px 0">كلمات راجعتها من جلسة اليوم</p><div class="progress-track"><div class="progress-fill" style="width:${recentDaySession?.wordIds.length ? Math.min(100, dailyReviewed / recentDaySession.wordIds.length * 100) : 0}%"></div></div></div><button class="btn btn-secondary" data-action="go-daily">متابعة الجلسة</button></div>
  </section>
  <section class="grid stats-grid">${statCard('إجمالي كلمات الملف', words.length, words.length !== EXPECTED_WORDS ? `العدد المتوقع ${EXPECTED_WORDS}` : '')}${statCard('كلمات حفظتها', stats.mastered)}${statCard('لم تحفظها بعد', stats.remaining)}${statCard('نسبة الحفظ', `${stats.percentage}%`, `<div class="progress-track" style="margin-top:8px"><div class="progress-fill" style="width:${stats.percentage}%"></div></div>`)}${statCard('كلمات بدأت دراستها اليوم', stats.todayLearned)}</section>
  <section class="grid home-lower"><div class="panel"><div class="panel-heading"><div><h2>تحتاج إلى مراجعة</h2><p>كلمات لم تعلّمها كمحفوظة بعد أو ظهرت في قائمة الأخطاء.</p></div><button class="btn btn-plain btn-small" data-action="go-errors">قائمة الأخطاء</button></div><div class="review-list">${reviewWords.length ? reviewWords.map(w => miniWord(w)).join('') : `<div class="empty-state">لا توجد كلمات معلّمة للمراجعة بعد. ابدأ جلسة جديدة عند جاهزيتك.</div>`}</div></div>
  <div class="panel"><div class="panel-heading"><div><h2>آخر اختبار</h2><p>تُحفظ كل محاولة حتى عند إعادة الاختبار.</p></div><button class="btn btn-plain btn-small" data-action="go-quizzes">الاختبارات</button></div>${last ? `<div class="badge">${esc(last.title)}</div><h3 style="margin-top:14px">${attemptOverall(last)}% نتيجة عامة</h3><p class="muted" style="font-size:11px">${last.wordIds.length} كلمة · ${formatDateTime(last.finishedAt)}</p><button class="btn btn-secondary btn-small" data-action="show-result" data-id="${esc(last.id)}">عرض النتيجة</button>` : `<div class="empty-state">لم تُجرَ اختبارات بعد. يمكنك مراجعة الكلمات في أي وقت.</div>`}<div style="height:1px;background:var(--line);margin:20px 0"></div><div class="compact-list"><button class="btn btn-plain" data-action="go-quizzes">الاختبارات الأسبوعية والشهرية والنهائية</button><button class="btn btn-plain" data-action="go-log">سجل التعلم</button></div></div></section>`;
}

function miniWord(word) {
  const p = progressFor(word.id);
  return `<div class="mini-word"><button class="check-toggle" title="${p.mastered ? 'إلغاء الحفظ' : 'تعليم كمحفوظة'}" data-action="toggle-mastered" data-id="${esc(word.id)}">${p.mastered ? '☑' : '○'}</button><div class="mini-meta"><div class="mini-en">${esc(word.english)}</div><div class="mini-ar">${esc(word.meaning)}</div></div><button class="icon-btn" aria-label="سماع النطق" data-action="speak" data-id="${esc(word.id)}">◖♪</button></div>`;
}

function renderDaily() {
  const session = activeDailySession();
  const reviewMode = Boolean(state.activeReview?.active);
  const oldWords = dayWords(session, true);
  const currentIds = reviewMode ? (state.activeReview?.wordIds || oldWords.map(w => w.id)) : session.wordIds;
  const currentIndex = reviewMode ? (state.activeReview?.currentIndex || 0) : session.currentIndex;
  const currentWord = wordById(currentIds[currentIndex]);
  const reviewed = (session.reviewedIds || []).length;
  const mastered = session.wordIds.filter(id => progressFor(id).mastered).length;
  const history = Object.values(state.dailySessions).sort((a, b) => b.date.localeCompare(a.date));
  const historyList = history.length ? `<details class="session-history-box"><summary>جلسات الأيام السابقة (${history.length})</summary><div class="session-history">${history.map(item => `<button class="session-history-button ${item.date === session.date ? 'active' : ''}" data-action="daily-select-session" data-date="${esc(item.date)}"><span>${dateLabel(item.date)}</span><small>${(item.reviewedIds || []).length} / ${item.wordIds.length} كلمة تمت مراجعتها</small></button>`).join('')}</div></details>` : '';
  const sidebar = `<aside class="panel daily-sidebar"><div><div class="eyebrow">${reviewMode ? 'مراجعة سابقة' : session.date === todayString() ? 'جلسة اليوم' : 'جلسة سابقة'}</div><div class="count">${reviewMode ? currentIds.length : `${reviewed} / ${session.wordIds.length}`}</div><p class="muted" style="font-size:10px;margin:3px 0">${reviewMode ? 'كلمة في قائمة المراجعة' : `${mastered} كلمة محفوظة`}</p></div><div><span class="badge">${dateLabel(session.date)}</span><div class="progress-track" style="margin-top:12px"><div class="progress-fill" style="width:${session.wordIds.length ? reviewed / session.wordIds.length * 100 : 0}%"></div></div></div><div class="step-list"><button class="step-pill ${!reviewMode && session.date === todayString() ? 'active' : ''}" data-action="daily-new-mode">كلمات اليوم</button><button class="step-pill ${reviewMode ? 'active' : ''}" data-action="daily-review-mode">مراجعة كلمات تعلّمتها (${oldWords.length})</button></div>${historyList}<div class="muted" style="font-size:10px;line-height:1.7">تُسجّل الكلمة ضمن مجموعتها عند عرضها في الجلسة. الحفظ اختيار مستقل ولا يحدث بمجرد الفتح أو الاستماع.</div></aside>`;
  if (!currentWord) return `<div class="page-heading"><div><div class="eyebrow">التعلّم اليومي</div><h1>كلمات اليوم</h1></div></div><div class="daily-layout">${sidebar}<section class="panel lesson-card"><div class="empty-state">${reviewMode ? 'لا توجد كلمات سابقة للمراجعة حاليًا.' : words.some(w => !progressFor(w.id).studyDate && !progressFor(w.id).mastered) ? 'لا توجد كلمات جديدة في خطة هذه الجلسة. افتح جلسة يوم سابق لمتابعة الكلمات التي بقيت فيها.' : 'أنهيت دراسة كل الكلمات الجديدة المتاحة من الملف. يمكنك مراجعة الكلمات السابقة متى شئت.'}</div><div class="actions" style="justify-content:center"><button class="btn btn-primary" data-action="daily-review-mode">مراجعة كلمات تعلّمتها</button><button class="btn btn-plain" data-action="go-home">العودة إلى الرئيسية</button></div></section></div>`;
  if (assignStudy(currentWord.id, todayString())) saveState();
  const p = progressFor(currentWord.id);
  const practice = p.practice || (p.practice = {});
  const recall = practice.recall || {};
  const cloze = practice.cloze || {};
  const speech = { tries: 0, feedback: '', done: false, ...(practice.dailySpeech || {}) };
  const exampleBlank = esc(currentWord.example).replace(new RegExp(`\\b${escapeRegExp(currentWord.english)}\\b`, 'i'), '<span class="example-missing">____</span>');
  const exampleForCloze = currentWord.example.replace(new RegExp(`\\b${escapeRegExp(currentWord.english)}\\b`, 'i'), '____');
  const progressDots = currentIds.map((id, i) => `<button class="step-pill ${i === currentIndex ? 'active' : ''}" data-action="daily-jump" data-index="${i}" style="flex:0 0 auto">${i + 1}</button>`).join('');
  const englishDisplay = recall.started && !recall.checked ? '••••••' : esc(currentWord.english);
  const lesson = `<section class="panel lesson-card"><div class="lesson-top"><span class="lesson-number">${reviewMode ? 'مراجعة' : 'الكلمة'} ${currentIndex + 1} من ${currentIds.length}</span><span class="tag ${p.mastered ? 'green' : p.status === 'learning' ? 'amber' : ''}">${esc(wordStatusLabel(p))}</span></div><div class="english-word">${englishDisplay}</div><div class="meaning">${esc(currentWord.meaning)}</div><div class="actions"><button class="btn btn-secondary" data-action="daily-speak" data-id="${esc(currentWord.id)}">◖♪ استمع للنطق الإنجليزي</button><span class="pronunciation-hint">لا يحتوي الملف على كتابة صوتية؛ يمكنك الاستماع للنطق.</span></div><div class="example-box"><div class="example-en">${esc(currentWord.example)}</div><div class="example-ar">ترجمة المثال غير موجودة في الملف المصدر.</div></div>
    <div class="lesson-sections"><div class="exercise-box"><h3>اختبر ذاكرتي</h3><p>${recall.checked ? (recall.correct ? 'إجابتك صحيحة.' : `الإجابة الصحيحة: ${esc(currentWord.english)}`) : recall.started ? `المعنى: ${esc(currentWord.meaning)} — اكتب الكلمة الإنجليزية من الذاكرة.` : 'أخفِ الكلمة الإنجليزية وحاول كتابتها من معناها.'}</p>${recall.started ? `<form data-form="daily-recall" data-id="${esc(currentWord.id)}"><div class="exercise-row"><input class="field" dir="ltr" name="answer" autocomplete="off" placeholder="Type the English word" value="${esc(recall.draft || '')}" ${recall.checked ? 'disabled' : ''} required><button class="btn btn-primary" ${recall.checked ? 'disabled' : ''}>تحقّق</button></div></form>` : `<button class="btn btn-plain btn-small" data-action="recall-start" data-id="${esc(currentWord.id)}">اختبر ذاكرتي</button>`}<div class="feedback ${recall.checked ? (recall.correct ? 'good' : 'bad') : ''}">${recall.checked ? (recall.correct ? 'أحسنت، تذكّرت الكلمة.' : `الإجابة الصحيحة: <span class="ltr">${esc(currentWord.english)}</span>`) : ''}</div></div>
    <div class="exercise-box"><h3>تدرّب على المثال</h3><p class="ltr">${exampleBlank}</p><p>اكتب الكلمة الناقصة في المثال.</p>${cloze.checked ? `<div class="feedback ${cloze.correct ? 'good' : 'bad'}">${cloze.correct ? 'صحيح، أكملت المثال.' : `الكلمة الصحيحة: ${esc(currentWord.english)}`}</div>` : `<form data-form="daily-cloze" data-id="${esc(currentWord.id)}"><div class="exercise-row"><input class="field" dir="ltr" name="answer" autocomplete="off" placeholder="كلمة واحدة" value="${esc(cloze.draft || '')}" required><button class="btn btn-primary">تحقّق</button></div></form>`}<div class="muted" style="font-size:9px;margin-top:6px">${esc(exampleForCloze)}</div></div>
    <div class="exercise-box"><h3>تدرّب على النطق</h3><p>سماع النموذج متاح. يمكنك نطق الكلمة للميكروفون إذا دعم متصفحك التعرف على الكلام.</p><div class="actions"><button class="btn btn-secondary btn-small" data-action="daily-speech" data-id="${esc(currentWord.id)}" ${speech.done || speech.tries >= 4 ? 'disabled' : ''}>🎙️ ابدأ النطق (${Math.max(0, 4 - speech.tries)} محاولات)</button><button class="btn btn-plain btn-small" data-action="daily-speech-skip" data-id="${esc(currentWord.id)}" ${speech.done ? 'disabled' : ''}>تخطي</button></div><div class="feedback ${speech.done ? 'good' : speech.tries >= 4 ? 'bad' : ''}">${esc(speech.feedback || (speech.tries ? `المحاولات: ${speech.tries} من 4` : 'لا تُحفظ أي تسجيلات صوتية.'))}</div></div>
    <div class="exercise-box"><h3>حالة الكلمة</h3><p>اختر الحالة بنفسك؛ فتح الكلمة لا يجعلها محفوظة.</p><div class="status-choices"><button class="status-choice ${p.status === 'unreviewed' && !p.mastered ? 'selected' : ''}" data-action="set-status" data-id="${esc(currentWord.id)}" data-status="unreviewed">لم أراجعها بعد</button><button class="status-choice ${p.status === 'learning' && !p.mastered ? 'selected' : ''}" data-action="set-status" data-id="${esc(currentWord.id)}" data-status="learning">أتدرّب عليها</button><button class="status-choice ${p.mastered ? 'selected' : ''}" data-action="set-status" data-id="${esc(currentWord.id)}" data-status="mastered">حفظتها</button></div></div></div>
    <div class="lesson-footer"><button class="btn btn-plain" data-action="daily-prev" ${currentIndex <= 0 ? 'disabled' : ''}>الكلمة السابقة</button><div class="actions">${progressDots}</div><button class="btn btn-primary" data-action="daily-next">${currentIndex >= currentIds.length - 1 ? (reviewMode ? 'إنهاء المراجعة' : 'إنهاء كلمات اليوم') : 'الكلمة التالية'}</button></div></section>`;
  return `<div class="page-heading"><div><div class="eyebrow">مساحة التعلّم</div><h1>كلمات اليوم</h1><p>خمس كلمات جديدة كحد أقصى، مع تدريبات قصيرة وحفظ تلقائي.</p></div><button class="btn btn-plain" data-action="go-home">العودة إلى الرئيسية</button></div><div class="daily-layout">${sidebar}${lesson}</div>`;
}

function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function groupsFor(filter) {
  const vals = [...new Set(words.map(w => progressFor(w.id)[filter]).filter(Number.isFinite))].sort((a, b) => a - b);
  return vals;
}

function filteredWords() {
  const q = listFilters.q.trim().toLocaleLowerCase();
  return words.filter(w => {
    const p = progressFor(w.id);
    if (q && !w.english.toLocaleLowerCase().includes(q) && !w.meaning.toLocaleLowerCase().includes(q)) return false;
    if (listFilters.saved === 'saved' && !p.mastered) return false;
    if (listFilters.saved === 'unsaved' && p.mastered) return false;
    if (listFilters.week !== 'all' && String(p.week || '') !== listFilters.week) return false;
    if (listFilters.month !== 'all' && String(p.month || '') !== listFilters.month) return false;
    return true;
  }).sort((a, b) => listFilters.sort === 'study' ? (progressFor(a.id).studyDate || '9999').localeCompare(progressFor(b.id).studyDate || '9999') : a.order - b.order);
}

function renderWords() {
  const filtered = filteredWords();
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  listPage = Math.min(listPage, pages);
  const slice = filtered.slice((listPage - 1) * pageSize, listPage * pageSize);
  const weekOptions = groupsFor('week').map(n => `<option value="${n}" ${listFilters.week === String(n) ? 'selected' : ''}>الأسبوع ${n}</option>`).join('');
  const monthOptions = groupsFor('month').map(n => `<option value="${n}" ${listFilters.month === String(n) ? 'selected' : ''}>الشهر ${n}</option>`).join('');
  return `<div class="page-heading"><div><div class="eyebrow">قائمة المفردات</div><h1>جميع الكلمات</h1><p>ترتيب الملف محفوظ، وعلامة الحفظ لا تمسح نتائج الاختبارات.</p></div><div class="badge">${words.length} كلمة</div></div><section class="panel"><div class="list-toolbar"><input class="field search-field" data-filter="q" placeholder="ابحث بالإنجليزية أو العربية" value="${esc(listFilters.q)}"><select class="field" data-filter="saved"><option value="all">كل الحالات</option><option value="saved" ${listFilters.saved === 'saved' ? 'selected' : ''}>محفوظة</option><option value="unsaved" ${listFilters.saved === 'unsaved' ? 'selected' : ''}>غير محفوظة</option></select><select class="field" data-filter="week"><option value="all">كل الأسابيع</option>${weekOptions}</select><select class="field" data-filter="month"><option value="all">كل الأشهر</option>${monthOptions}</select><select class="field" data-filter="sort"><option value="source">ترتيب الملف</option><option value="study" ${listFilters.sort === 'study' ? 'selected' : ''}>تاريخ الدراسة</option></select></div><div class="word-list">${slice.map(wordRow).join('') || `<div class="empty-state">لا توجد كلمات تطابق البحث أو المرشحات.</div>`}</div><div class="pagination"><span>${filtered.length ? `${(listPage - 1) * pageSize + 1}–${Math.min(listPage * pageSize, filtered.length)} من ${filtered.length}` : '0 نتيجة'}</span><div class="actions"><button class="btn btn-plain btn-small" data-action="list-prev" ${listPage <= 1 ? 'disabled' : ''}>السابق</button><span>${listPage} / ${pages}</span><button class="btn btn-plain btn-small" data-action="list-next" ${listPage >= pages ? 'disabled' : ''}>التالي</button></div></div></section>`;
}

function wordRow(word) {
  const p = progressFor(word.id);
  return `<div class="word-row"><div class="word-order">${word.order}</div><div class="word-en">${esc(word.english)}<div class="word-status" style="margin-top:5px"><span class="tag ${p.mastered ? 'green' : ''}">${esc(wordStatusLabel(p))}</span></div></div><div class="word-ar">${esc(word.meaning)}${p.studyDate ? `<div class="muted" style="font-size:9px;margin-top:4px">دُرست ${dateLabel(p.studyDate)} · أ${p.week} / ش${p.month}</div>` : ''}</div><div class="word-actions"><button class="icon-btn" title="سماع النطق" data-action="speak" data-id="${esc(word.id)}">◖♪</button><button class="icon-btn" title="التفاصيل" data-action="word-details" data-id="${esc(word.id)}">⋯</button><button class="check-toggle" title="${p.mastered ? 'إلغاء الحفظ' : 'تعليم كمحفوظة'}" data-action="toggle-mastered" data-id="${esc(word.id)}">${p.mastered ? '☑' : '○'}</button></div></div>`;
}

function renderQuizzes() {
  if (activeAttempt()) return renderActiveQuiz();
  const start = state.startedAt;
  const elapsed = start ? dateDiffDays(start, todayString()) : 0;
  const currentWeek = Math.floor(elapsed / 7) + 1;
  const currentMonth = Math.floor(elapsed / 28) + 1;
  const weekGroups = groupsFor('week');
  const monthGroups = groupsFor('month');
  const cards = [];
  const weekReadyAt = (n) => Boolean(start && n <= Math.floor(elapsed / 7));
  const monthReadyAt = (n) => Boolean(start && n <= Math.floor(elapsed / 28));
  cards.push(quizCard(`اختبار الأسبوع ${currentWeek}`, 'الأسبوع الحالي', currentWeek, weekReadyAt(currentWeek), weekGroups.includes(currentWeek), 'weekly'));
  for (const n of weekGroups.filter(n => n < currentWeek).reverse()) cards.push(quizCard(`اختبار الأسبوع ${n}`, 'مراجعة أسبوع سابق', n, weekReadyAt(n), true, 'weekly'));
  if (monthGroups.includes(currentMonth) || start) cards.push(quizCard(`اختبار الشهر ${currentMonth}`, 'يشمل كلمات الأسابيع الأربعة للدورة', currentMonth, monthReadyAt(currentMonth), monthGroups.includes(currentMonth), 'monthly'));
  for (const n of monthGroups.filter(n => n < currentMonth).reverse()) cards.push(quizCard(`اختبار الشهر ${n}`, 'مراجعة دورة سابقة', n, monthReadyAt(n), true, 'monthly'));
  const allStudied = words.every(w => Boolean(progressFor(w.id).studyDate));
  const studiedIds = words.filter(w => progressFor(w.id).studyDate).map(w => w.id);
  cards.push(`<article class="quiz-card ${allStudied ? '' : 'locked'}"><span class="tag ${allStudied ? 'green' : 'amber'}">${allStudied ? 'متاح' : 'مقفل حتى دراسة الجميع'}</span><h3>اختبار النجاح النهائي</h3><p>اختبار مستقل لكل ${words.length} كلمة، بمراحل الكتابة والنطق وتكوين الجمل.</p><div class="quiz-count">${studiedIds.length} / ${words.length}</div><button class="btn ${allStudied ? 'btn-primary' : 'btn-plain'}" data-action="start-final" ${allStudied ? '' : 'disabled'}>ابدأ الاختبار النهائي</button></article>`);
  const history = [...state.attempts].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 12);
  return `<div class="page-heading"><div><div class="eyebrow">قياس التقدم</div><h1>الاختبارات</h1><p>كل محاولة مستقلة؛ ومجموعات الأسئلة تقتصر على الكلمات التي دُرست ضمن المجموعة.</p></div><div class="badge">نسبة النجاح المطلوبة: ${Number(state.settings.successThreshold) || 80}%</div></div><div class="notice info"><span>ⓘ</span><div>تُفتح الاختبارات الأسبوعية بعد مرور أسبوع من بداية الدراسة، والشهرية بعد أربعة أسابيع. لا يشترط حفظ الكلمة؛ يكفي أن تكون قد دُرست بالفعل.</div></div><section class="grid quiz-grid">${cards.join('')}</section><section class="panel"><div class="panel-heading"><div><h2>سجل المحاولات</h2><p>لا تُحذف المحاولات السابقة عند إعادة أي اختبار.</p></div></div>${history.length ? `<div class="timeline">${history.map(a => `<div class="timeline-item"><div class="timeline-date">${dateLabel((a.createdAt || '').slice(0, 10))}</div><div><strong>${esc(a.title)}</strong><div class="muted" style="font-size:10px">${a.wordIds.length} كلمة · ${a.status === 'complete' ? `${attemptOverall(a)}%` : 'غير مكتمل'}</div></div><button class="btn btn-plain btn-small" data-action="${a.status === 'complete' ? 'show-result' : 'resume-attempt'}" data-id="${esc(a.id)}">${a.status === 'complete' ? 'النتيجة' : 'متابعة'}</button></div>`).join('')}</div>` : `<div class="empty-state">لا توجد محاولات حتى الآن.</div>`}</section>`;
}

function quizCard(title, subtitle, group, ready, hasWords, kind) {
  const ids = words.filter(w => progressFor(w.id)[kind === 'weekly' ? 'week' : 'month'] === group && progressFor(w.id).studyDate).map(w => w.id);
  const canStart = ready && hasWords && ids.length > 0;
  const note = !hasWords ? 'لا توجد كلمات دُرست في هذه المجموعة بعد.' : !ready ? (kind === 'weekly' ? 'يتاح بعد انقضاء الأسبوع.' : 'يتاح بعد انقضاء أربعة أسابيع.') : `${ids.length} كلمة دُرست في هذه المجموعة.`;
  return `<article class="quiz-card ${canStart ? '' : 'locked'}"><span class="tag ${canStart ? 'green' : 'amber'}">${canStart ? 'متاح' : 'قريبًا'}</span><h3>${esc(title)}</h3><p>${esc(subtitle)} · ${esc(note)}</p><div class="quiz-count">${ids.length}</div><button class="btn ${canStart ? 'btn-primary' : 'btn-plain'}" data-action="start-group-quiz" data-kind="${kind}" data-group="${group}" ${canStart ? '' : 'disabled'}>ابدأ الاختبار</button></article>`;
}

function activeAttempt() { return state.attempts.find(a => a.id === state.activeAttemptId && a.status === 'inProgress') || null; }

function startAttempt(kind, title, ids) {
  if (!ids.length) return showToast('لا توجد كلمات في هذا الاختبار بعد.');
  const attempt = { id: uid('attempt'), kind, title, wordIds: [...ids], phase: 'writing', index: 0, status: 'inProgress', answers: { writing: {}, pronunciation: {}, sentence: {} }, drafts: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  state.attempts.unshift(attempt);
  state.activeAttemptId = attempt.id;
  page = 'quizzes';
  appendLog('quiz-start', `بدأت ${title}`, null, { attemptId: attempt.id, count: ids.length });
  saveState();
  render();
}

function renderActiveQuiz() {
  const attempt = activeAttempt();
  if (!attempt) return '';
  const phase = attempt.phase;
  const word = wordById(attempt.wordIds[attempt.index]);
  const saved = attempt.answers[phase][word.id];
  const progressCount = PHASES.indexOf(phase) * attempt.wordIds.length + attempt.index + (saved ? 1 : 0);
  const allSteps = attempt.wordIds.length * PHASES.length;
  const progress = Math.round(progressCount / allSteps * 100);
  const stageNames = PHASES.map((p, i) => `<span class="tag ${PHASES.indexOf(phase) >= i ? 'green' : ''}">${i + 1}. ${PHASE_LABELS[p]}</span>`).join(' ');
  let content = '';
  if (phase === 'writing') content = `<div class="quiz-prompt">${esc(word.meaning)}</div><p class="quiz-hint">اكتب الكلمة الإنجليزية. لا نتجاهل إلا المسافات في طرفي الإجابة؛ الإملاء يجب أن يطابق.</p><form data-form="quiz-writing"><input class="field quiz-answer" dir="ltr" name="answer" placeholder="اكتب الكلمة هنا" autocomplete="off" value="${esc(saved?.answer ?? attempt.drafts[`${phase}:${word.id}`] ?? '')}" ${saved ? 'disabled' : ''} required><button class="btn btn-primary" style="margin-top:12px" ${saved ? 'disabled' : ''}>تحقّق من الإجابة</button></form>${saved ? `<div class="quiz-feedback ${saved.status === 'correct' ? 'good' : 'bad'}">${saved.status === 'correct' ? 'إجابة صحيحة.' : `إجابة غير صحيحة. الإجابة: <span class="ltr">${esc(word.english)}</span>`}</div>` : ''}`;
  if (phase === 'pronunciation') {
    const speech = saved || attempt.drafts[`speech:${word.id}`] || { tries: 0, history: [] };
    content = `<div class="quiz-prompt ltr">${esc(word.english)}</div><p class="quiz-hint">استمع إلى النموذج، ثم استخدم الميكروفون. التعرف الصوتي يعتمد على دعم المتصفح وجودة الميكروفون، وليس تقييمًا دقيقًا للنطق. لا تُخزّن تسجيلات صوتية.</p><div class="actions"><button class="btn btn-secondary" data-action="quiz-speak" data-id="${esc(word.id)}">◖♪ اسمع النموذج</button><button class="btn btn-primary" data-action="quiz-recognize" data-id="${esc(word.id)}" ${saved ? 'disabled' : ''}>🎙️ ابدأ النطق (${Math.max(0, 4 - (speech.tries || 0))} محاولات متبقية)</button><button class="btn btn-plain quiz-skip" data-action="quiz-skip" ${saved ? 'disabled' : ''}>تخطّي</button></div><div class="feedback ${speech.status === 'correct' ? 'good' : speech.status === 'wrong' ? 'bad' : ''}">${esc(speech.feedback || '')}</div>${saved ? `<div class="quiz-feedback ${saved.status === 'correct' ? 'good' : saved.status === 'skipped' ? '' : 'bad'}">${saved.status === 'correct' ? `تعرّف المتصفح على: ${esc(saved.answer)}` : saved.status === 'skipped' ? 'تم التخطي، ولم يُسجّل خطأ نطق.' : `لم يتعرّف على الكلمة بعد أربع محاولات. كانت آخر نتيجة: ${esc(saved.answer || 'غير متاح')}`}</div>` : `<p class="muted" style="font-size:10px">المحاولات: ${speech.tries || 0} / 4${speech.history?.length ? ` · آخر تعرّف: ${esc(speech.history[speech.history.length - 1])}` : ''}</p>`}`;
  }
  if (phase === 'sentence') content = `<div class="quiz-prompt"><span class="ltr">${esc(word.english)}</span> · ${esc(word.meaning)}</div><p class="quiz-hint">اكتب جملة إنجليزية تستخدم الكلمة. الفحص المحلي محدود: يتحقق من ظهور الكلمة ككلمة مستقلة ووجود ثلاث كلمات على الأقل، ولا يقيّم القواعد أو المعنى.</p><form data-form="quiz-sentence"><textarea class="field field-area quiz-answer" dir="ltr" name="answer" placeholder="Write a sentence with ${esc(word.english)}" ${saved ? 'disabled' : ''} required>${esc(saved?.answer ?? attempt.drafts[`${phase}:${word.id}`] ?? '')}</textarea><button class="btn btn-primary" style="margin-top:12px" ${saved ? 'disabled' : ''}>تحقّق من الجملة</button></form>${saved ? `<div class="quiz-feedback ${saved.status === 'correct' ? 'good' : 'bad'}">${saved.status === 'correct' ? 'استخدمت الكلمة وكتبت ثلاث كلمات على الأقل. المثال للمقارنة:' : 'لم يكتمل الفحص المحدود. تأكد من استخدام الكلمة ككلمة مستقلة وكتابة ثلاث كلمات على الأقل.'}<div class="ltr" style="margin-top:8px">${esc(word.example)}</div><div class="muted" style="margin-top:5px">ترجمة المثال غير متوفرة في الملف المصدر.</div></div>` : ''}`;
  return `<div class="quiz-active"><div class="page-heading"><div><div class="eyebrow">${esc(attempt.title)}</div><h1>${PHASE_LABELS[phase]}</h1><p>${stageNames}</p></div><button class="btn btn-plain" data-action="quiz-leave">حفظ والعودة للاختبارات</button></div><div class="quiz-progress-head"><span>الكلمة ${attempt.index + 1} من ${attempt.wordIds.length}</span><span>المرحلة ${PHASES.indexOf(phase) + 1} من 3</span></div><div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div><section class="panel quiz-question"><span class="badge">${phase === 'writing' ? 'المعنى بالعربية' : phase === 'pronunciation' ? 'تدريب نطق' : 'استخدام في جملة'}</span>${content}${saved ? `<div class="actions" style="justify-content:flex-end;margin-top:19px"><button class="btn btn-primary" data-action="quiz-next">${attempt.index === attempt.wordIds.length - 1 && phase === 'sentence' ? 'إنهاء الاختبار' : 'السؤال التالي'}</button></div>` : ''}</section><p class="muted" style="font-size:10px;text-align:center">تُحفظ إجاباتك بعد كل سؤال. يمكنك الرجوع إلى هذه المحاولة من سجل الاختبارات.</p></div>`;
}

function quizCardData(attempt) {
  const stageSummary = {};
  for (const phase of PHASES) {
    const records = attempt.answers[phase] || {};
    const vals = attempt.wordIds.map(id => records[id]).filter(Boolean);
    stageSummary[phase] = { correct: vals.filter(v => v.status === 'correct').length, wrong: vals.filter(v => v.status === 'wrong').length, skipped: vals.filter(v => v.status === 'skipped').length, total: attempt.wordIds.length };
  }
  const mastered = attempt.wordIds.filter(id => PHASES.every(phase => attempt.answers[phase][id]?.status === 'correct'));
  const needsReview = attempt.wordIds.filter(id => PHASES.some(phase => ['wrong', 'skipped'].includes(attempt.answers[phase][id]?.status)));
  return { stageSummary, mastered, needsReview };
}

function stagePercent(s) { const answered = s.total - s.skipped; return answered ? Math.round(s.correct / answered * 100) : null; }
function attemptOverall(attempt) {
  const { stageSummary } = quizCardData(attempt);
  const values = PHASES.map(p => stagePercent(stageSummary[p])).filter(v => v !== null);
  return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
}

function renderResult(attempt) {
  const { stageSummary, mastered, needsReview } = quizCardData(attempt);
  const skipped = PHASES.reduce((sum, phase) => sum + stageSummary[phase].skipped, 0);
  const overall = attemptOverall(attempt);
  const stats = PHASES.map(phase => {
    const s = stageSummary[phase];
    return `<div class="result-card"><span class="stat-label">${PHASE_LABELS[phase]}</span><strong>${stagePercent(s) === null ? '—' : `${stagePercent(s)}%`}</strong><p>صحيح ${s.correct} · أخطاء ${s.wrong} · متخطى ${s.skipped}</p></div>`;
  }).join('');
  const wordsDisplay = (ids, empty) => ids.length ? `<div class="compact-list">${ids.map(id => { const w = wordById(id); return `<div class="mini-word"><div class="mini-meta"><div class="mini-en">${esc(w.english)}</div><div class="mini-ar">${esc(w.meaning)}</div></div><button class="icon-btn" data-action="speak" data-id="${esc(id)}">◖♪</button></div>`; }).join('')}</div>` : `<div class="empty-state">${empty}</div>`;
  const finalPass = attempt.kind === 'final' ? `<div class="notice ${overall >= Number(state.settings.successThreshold || 80) ? 'info' : ''}"><span>${overall >= Number(state.settings.successThreshold || 80) ? '✓' : 'ⓘ'}</span><div>النتيجة العامة <strong>${overall}%</strong> · المطلوب <strong>${Number(state.settings.successThreshold || 80)}%</strong> · ${overall >= Number(state.settings.successThreshold || 80) ? 'حققت النسبة المطلوبة.' : 'لم تصل إلى النسبة المطلوبة في هذه المحاولة.'}</div></div>` : '';
  return `<div class="page-heading"><div><div class="eyebrow">اكتملت المحاولة</div><h1>نتيجة الاختبار</h1><p>${esc(attempt.title)} · ${attempt.wordIds.length} كلمة · ${formatDateTime(attempt.finishedAt)}</p></div><button class="btn btn-primary" data-action="go-quizzes">العودة إلى الاختبارات</button></div>${finalPass}<div class="panel"><div class="panel-heading"><div><h2>${esc(attempt.title)}</h2><p>${mastered.length} كلمة أتقنتها في المراحل الثلاث، و${needsReview.length} تحتاج إلى مراجعة. المتخطى لا يحتسب خطأً.</p></div><div class="quiz-count">${overall}%</div></div><div class="grid results-grid">${stats}</div><div class="notice info"><span>ⓘ</span><div>النتيجة العامة متوسط نسب المراحل التي جرى تقييمها؛ النسبة لكل مرحلة تستثني المتخطى. إجمالي الأسئلة المتخطاة: <strong>${skipped}</strong>، ولا تُحتسب صحيحة أو خاطئة.</div></div><div class="grid home-lower"><div><h3>أتقنتها في المراحل الثلاث</h3>${wordsDisplay(mastered, 'لا توجد كلمة اجتازت المراحل الثلاث كلها في هذه المحاولة.')}</div><div><h3>تحتاج إلى مراجعة أو تم تخطيها</h3>${wordsDisplay(needsReview, 'لا توجد أخطاء أو أسئلة متخطاة في هذه المحاولة.')}</div></div><div class="actions" style="margin-top:20px"><button class="btn btn-secondary" data-action="retry-attempt-errors" data-id="${esc(attempt.id)}" ${needsReview.length ? '' : 'disabled'}>إعادة اختبار الكلمات المحتاجة للمراجعة</button>${attempt.kind === 'final' ? `<button class="btn btn-plain" data-action="retry-final">إعادة الاختبار النهائي كاملًا</button>` : ''}</div></div>`;
}

function renderErrors() {
  const labels = { writing: 'أخطاء الكتابة', pronunciation: 'أخطاء النطق', sentence: 'أخطاء تكوين الجمل' };
  const items = Object.values(state.errors).filter(e => errorFilter === 'all' || e.type === errorFilter).sort((a, b) => (b.occurrences.at(-1)?.at || '').localeCompare(a.occurrences.at(-1)?.at || ''));
  return `<div class="page-heading"><div><div class="eyebrow">مراجعة ذكية</div><h1>قائمة الأخطاء</h1><p>السؤال المتخطى لا يضاف إلى هنا، وسجل الخطأ لا يُحذف عند النجاح لاحقًا.</p></div><button class="btn btn-secondary" data-action="retry-all-errors" ${items.length ? '' : 'disabled'}>إعادة اختبار الأخطاء الظاهرة</button></div><div class="errors-tabs"><button class="tab-button ${errorFilter === 'all' ? 'active' : ''}" data-action="error-filter" data-filter="all">كل الأنواع (${Object.keys(state.errors).length})</button>${PHASES.map(type => `<button class="tab-button ${errorFilter === type ? 'active' : ''}" data-action="error-filter" data-filter="${type}">${labels[type]} (${Object.values(state.errors).filter(e => e.type === type).length})</button>`).join('')}</div><section class="error-list">${items.length ? items.map(errorItem).join('') : `<div class="panel empty-state">لا توجد أخطاء مسجلة في هذا القسم.</div>`}</section>`;
}

function errorItem(error) {
  const word = wordById(error.wordId);
  const last = error.occurrences.at(-1);
  return `<article class="error-card"><div><div class="word-en">${esc(word?.english || 'كلمة غير موجودة')}</div><div class="answer-line">${esc(word?.meaning || '')}</div></div><div><div class="answer-line">النوع: ${PHASE_LABELS[error.type]} · ${error.occurrences.length} مرة</div><div class="answer-line">إجابتك: <span class="ltr">${esc(last?.answer || '—')}</span></div><div class="answer-line">التصحيح: <span class="ltr">${esc(last?.correction || '—')}</span></div></div><div><span class="tag ${error.reviewed ? 'green' : 'amber'}">${error.reviewed ? 'تمت المراجعة' : 'تحتاج مراجعة'}</span><div class="answer-line">${formatDateTime(last?.at)}</div></div><div class="actions"><button class="btn btn-plain btn-small" data-action="toggle-error-reviewed" data-id="${esc(error.id)}">${error.reviewed ? 'إلغاء المراجعة' : 'تمت المراجعة'}</button><button class="btn btn-secondary btn-small" data-action="retry-error" data-id="${esc(error.id)}">أعد الاختبار</button></div></article>`;
}

function renderLog() {
  const events = state.log.slice(0, 200);
  return `<div class="page-heading"><div><div class="eyebrow">تاريخ التعلم</div><h1>سجل التعلم</h1><p>تسلسل زمني للدراسة والمراجعات والاختبارات.</p></div><div class="badge">${state.log.length} حدث محفوظ</div></div><section class="panel">${events.length ? `<div class="timeline">${events.map(event => { const w = event.wordId ? wordById(event.wordId) : null; return `<div class="timeline-item"><div class="timeline-date">${formatDateTime(event.at)}</div><div>${esc(event.text)}${w ? ` <span class="tag">${esc(w.english)}</span>` : ''}</div><div>${event.meta?.week ? `<span class="tag">الأسبوع ${event.meta.week} · الشهر ${event.meta.month}</span>` : event.meta?.count ? `<span class="tag">${event.meta.count} كلمة</span>` : ''}</div></div>`; }).join('')}</div>` : `<div class="empty-state">سيظهر هنا سجل تعلمك بعد بدء الدراسة.</div>`}</section>`;
}

function renderSettings() {
  return `<div class="page-heading"><div><div class="eyebrow">بياناتك وإعداداتك</div><h1>النسخ الاحتياطي والإعدادات</h1><p>التقدم محفوظ محليًا في هذا المتصفح.</p></div></div><div class="notice"><span>ⓘ</span><div>لا توجد مزامنة سحابية في هذه النسخة. يمكنك العودة على الجهاز والمتصفح نفسيهما. حذف بيانات المتصفح قد يمسح التقدم؛ نزّل نسخة احتياطية بانتظام. التصدير والاستيراد لا يرسلان بياناتك إلى أي خادم.</div></div><div class="panel"><div class="setting-row"><div><strong>نسبة النجاح المطلوبة للاختبار النهائي</strong><p>تُستخدم لعرض حالة اجتياز المحاولة النهائية.</p></div><form data-form="threshold"><div class="exercise-row"><input class="field" type="number" min="1" max="100" name="threshold" value="${Number(state.settings.successThreshold) || 80}"><span>%</span><button class="btn btn-secondary btn-small">حفظ</button></div></form></div><div class="setting-row"><div><strong>تصدير نسخة احتياطية</strong><p>تتضمن التقدم والجلسات والاختبارات والأخطاء والسجل.</p></div><button class="btn btn-primary" data-action="export-backup">تنزيل النسخة الاحتياطية</button></div><div class="setting-row"><div><strong>استيراد نسخة احتياطية</strong><p>يُدمج الاستيراد مع البيانات الحالية، ولا يحذف السجلات المحلية.</p></div><label class="btn btn-plain upload-label">اختيار ملف JSON<input class="import-file" type="file" accept="application/json,.json" data-action="import-file"></label></div><div class="setting-row"><div><strong>مصدر الكلمات</strong><p>المعنى الأصلي محفوظ مع نسخة منسقة؛ لا يتضمن الملف نطقًا مكتوبًا أو ترجمات للأمثلة.</p></div><span class="badge">${words.length} سجلًا مستوردًا</span></div></div><section class="panel" style="margin-top:18px"><div class="panel-heading"><div><h2>طريقة احتساب المجموعات</h2><p>مجموعات ثابتة حسب تاريخ بدء دراسة كل كلمة.</p></div></div><p class="muted" style="font-size:12px">تبدأ الدورة من تاريخ أول جلسة فعلية. كل 7 أيام تقويمية تكوّن أسبوعًا، وكل 28 يومًا تكوّن شهرًا تعليميًا من أربعة أسابيع. الكلمة تُسند إلى مجموعتها عند بدء دراستها، ولا تنتقل لاحقًا. الأيام الفائتة لا تُسجّل كدراسة ولا تُنشئ كلمات يومية بأثر رجعي.</p><p class="muted" style="font-size:12px">المتصفح يحفظ الإجابات والاختبارات أثناء العمل. تتيح إعادة فتح محاولة غير مكتملة من صفحة الاختبارات.</p></section>`;
}

function render() {
  document.querySelectorAll('.nav-link').forEach(el => el.classList.toggle('active', el.dataset.page === page));
  const renderers = { home: renderHome, daily: renderDaily, words: renderWords, quizzes: renderQuizzes, errors: renderErrors, log: renderLog, settings: renderSettings };
  app.innerHTML = (renderers[page] || renderHome)();
}

function toggleMastered(id) {
  const p = progressFor(id);
  setMastered(id, !p.mastered);
  render();
  if (document.getElementById('modal-root').innerHTML) showWordDetails(id);
}

function setWordStatus(id, status) {
  const p = progressFor(id);
  if (status === 'mastered') return setMastered(id, true), render();
  p.mastered = false;
  p.status = status;
  if (status === 'learning' && !p.studyDate) assignStudy(id);
  if (status === 'unreviewed') p.reviewedAt = null;
  else {
    p.reviewedAt = todayString();
    p.reviewCount = (p.reviewCount || 0) + 1;
    markDailyReviewed(id);
  }
  p.updatedAt = new Date().toISOString();
  appendLog('status', `حالة الكلمة: ${wordStatusLabel(p)}`, id);
  saveState();
  render();
}

function setDailyMode(reviewMode) {
  if (!reviewMode) state.activeDailyDate = todayString();
  const session = activeDailySession();
  if (reviewMode) {
    const ids = words.filter(w => progressFor(w.id).studyDate && !session.wordIds.includes(w.id)).map(w => w.id);
    state.activeReview = { active: true, wordIds: ids, currentIndex: 0 };
  } else state.activeReview = null;
  saveState();
  render();
}

function currentDailyContext() {
  const session = activeDailySession();
  const reviewMode = Boolean(state.activeReview?.active);
  const ids = reviewMode ? state.activeReview.wordIds : session.wordIds;
  const index = reviewMode ? (state.activeReview.currentIndex || 0) : session.currentIndex;
  return { session, reviewMode, ids, index, id: ids[index] };
}

function dailyNext(delta) {
  const { session, reviewMode, ids, index } = currentDailyContext();
  if (index + delta < 0) return;
  if (index + delta >= ids.length) {
    if (!reviewMode) {
      session.completed = true;
      appendLog('daily-complete', 'أنهيت كلمات اليوم', null, { date: session.date, count: session.wordIds.length });
    }
    state.activeReview = reviewMode ? null : state.activeReview;
    saveState();
    showToast(reviewMode ? 'انتهت مراجعة الكلمات السابقة.' : 'أحسنت! أنهيت جلسة اليوم.');
    navigate(reviewMode ? 'daily' : 'home');
    return;
  }
  if (reviewMode) state.activeReview.currentIndex = index + delta;
  else session.currentIndex = index + delta;
  saveState();
  render();
}

function updateQuizProgress(attempt, wordId, phase, result, answer, correction) {
  const p = progressFor(wordId);
  const stat = p.stageStats[phase];
  if (phase === 'pronunciation' && Number.isFinite(result?.tries)) stat.attempts += result.tries;
  else stat.attempts += 1;
  if (result.status === 'correct') stat.correct += 1;
  if (result.status === 'wrong') {
    stat.wrong += 1;
    addError(wordId, phase, answer, correction, 'quiz');
  }
  if (result.status === 'skipped') stat.skipped += 1;
  if (result.status !== 'skipped' && !p.mastered) p.status = 'learning';
  p.reviewedAt = todayString();
  p.reviewCount = (p.reviewCount || 0) + 1;
  p.updatedAt = new Date().toISOString();
  appendLog('quiz-answer', `اختبار ${PHASE_LABELS[phase]}: ${result.status === 'correct' ? 'صحيح' : result.status === 'wrong' ? 'خطأ' : 'تم التخطي'}`, wordId, { attemptId: attempt.id, phase, status: result.status });
}

function submitWriting(form) {
  const attempt = activeAttempt();
  const word = wordById(attempt.wordIds[attempt.index]);
  const answer = new FormData(form).get('answer') || '';
  const correct = normalize(answer) === normalize(word.english);
  const result = { status: correct ? 'correct' : 'wrong', answer, at: new Date().toISOString() };
  attempt.answers.writing[word.id] = result;
  updateQuizProgress(attempt, word.id, 'writing', result, answer, word.english);
  attempt.updatedAt = new Date().toISOString();
  saveState();
  render();
}

function submitSentence(form) {
  const attempt = activeAttempt();
  const word = wordById(attempt.wordIds[attempt.index]);
  const answer = new FormData(form).get('answer') || '';
  const tokens = answer.trim().split(/\s+/).filter(Boolean);
  const containsWord = new RegExp(`\\b${escapeRegExp(word.english)}\\b`, 'i').test(answer);
  const correct = containsWord && tokens.length >= 3;
  const result = { status: correct ? 'correct' : 'wrong', answer, at: new Date().toISOString() };
  attempt.answers.sentence[word.id] = result;
  updateQuizProgress(attempt, word.id, 'sentence', result, answer, word.example);
  attempt.updatedAt = new Date().toISOString();
  saveState();
  render();
}

function quizSpeech() {
  const attempt = activeAttempt();
  const word = wordById(attempt.wordIds[attempt.index]);
  const draftKey = `speech:${word.id}`;
  const speech = attempt.drafts[draftKey] || (attempt.drafts[draftKey] = { tries: 0, history: [] });
  const target = word.english;
  startRecognition(transcript => {
    speech.tries += 1;
    speech.history.push(transcript);
    const correct = normalize(transcript) === normalize(target);
    if (correct) {
      const result = { status: 'correct', answer: transcript, tries: speech.tries, at: new Date().toISOString() };
      attempt.answers.pronunciation[word.id] = result;
      updateQuizProgress(attempt, word.id, 'pronunciation', result, transcript, target);
      speech.feedback = `تعرّف المتصفح على الكلمة بعد ${speech.tries} محاولة.`;
    } else if (speech.tries >= 4) {
      const result = { status: 'wrong', answer: transcript, tries: speech.tries, at: new Date().toISOString() };
      attempt.answers.pronunciation[word.id] = result;
      updateQuizProgress(attempt, word.id, 'pronunciation', result, transcript, target);
      speech.feedback = 'اكتملت أربع محاولات. سُجّل خطأ نطق للمراجعة.';
    } else speech.feedback = `لم يتعرّف المتصفح على الكلمة. بقيت ${4 - speech.tries} محاولات.`;
    attempt.updatedAt = new Date().toISOString();
    saveState();
    render();
  }, message => {
    speech.feedback = message;
    saveState();
    render();
  });
}

function dailySpeech(id) {
  const p = progressFor(id);
  const speech = p.practice.dailySpeech || (p.practice.dailySpeech = { tries: 0, feedback: '', done: false });
  if (speech.tries >= 4 || speech.done) return;
  startRecognition(transcript => {
    speech.tries += 1;
    const w = wordById(id);
    if (normalize(transcript) === normalize(w.english)) {
      speech.done = true;
      speech.feedback = 'تعرّف المتصفح على الكلمة. هذا فحص آلي محدود، وليس تقييمًا دقيقًا لجودة النطق.';
      recordPractice(id, 'pronunciation', 'correct', transcript, w.english, false);
    } else if (speech.tries >= 4) {
      speech.feedback = `لم يتعرّف المتصفح على الكلمة بعد أربع محاولات. آخر تعرّف: ${transcript || 'غير واضح'}.`;
      recordPractice(id, 'pronunciation', 'wrong', transcript, w.english, true);
    } else speech.feedback = `تعرّف المتصفح على «${transcript || 'غير واضح'}». بقيت ${4 - speech.tries} محاولات.`;
    saveState();
    render();
  }, message => { speech.feedback = message; saveState(); render(); });
}

function finishQuizStep() {
  const attempt = activeAttempt();
  if (!attempt) return;
  if (attempt.index < attempt.wordIds.length - 1) attempt.index += 1;
  else {
    const phaseIndex = PHASES.indexOf(attempt.phase);
    if (phaseIndex < PHASES.length - 1) { attempt.phase = PHASES[phaseIndex + 1]; attempt.index = 0; }
    else {
      attempt.status = 'complete';
      attempt.finishedAt = new Date().toISOString();
      appendLog('quiz-finish', `اكتملت ${attempt.title}`, null, { attemptId: attempt.id, overall: attemptOverall(attempt) });
      state.activeAttemptId = null;
      saveState();
      page = 'result';
      renderResultPage = attempt.id;
      render();
      return;
    }
  }
  attempt.updatedAt = new Date().toISOString();
  saveState();
  render();
}

let renderResultPage = null;
function showResult(id) {
  const attempt = state.attempts.find(a => a.id === id);
  if (!attempt || attempt.status !== 'complete') return showToast('لم تكتمل هذه المحاولة بعد.');
  renderResultPage = id;
  page = 'result';
  render();
}

function makeResultHtml() {
  const attempt = state.attempts.find(a => a.id === renderResultPage);
  return attempt ? renderResult(attempt) : renderQuizzes();
}

function renderPage() {
  if (page === 'result') app.innerHTML = makeResultHtml();
  else render();
}

function showWordDetails(id) {
  const word = wordById(id);
  if (!word) return;
  const p = progressFor(id);
  const stats = PHASES.map(phase => `<div class="result-card"><span class="stat-label">${PHASE_LABELS[phase]}</span><strong>${p.stageStats[phase].correct}</strong><p>صحيح ${p.stageStats[phase].correct} · أخطاء ${p.stageStats[phase].wrong} · متخطى ${p.stageStats[phase].skipped}</p></div>`).join('');
  document.getElementById('modal-root').innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" aria-label="تفاصيل الكلمة" data-modal><div class="modal-head"><div><span class="badge">الكلمة ${word.order} من الملف · الرقم الأصلي ${word.sourceNumber}</span><button class="modal-close" data-action="close-modal" aria-label="إغلاق">×</button></div></div><div class="english-word">${esc(word.english)}</div><div class="meaning">${esc(word.meaning)}</div><div class="actions"><button class="btn btn-secondary" data-action="speak" data-id="${esc(id)}">◖♪ استمع للنطق</button><span class="pronunciation-hint">لا تتوفر طريقة نطق مكتوبة في الملف.</span></div><div class="example-box"><div class="example-en">${esc(word.example)}</div><div class="example-ar">ترجمة المثال غير متوفرة في الملف.</div></div><div class="grid results-grid">${stats}</div><p class="muted" style="font-size:11px">الحالة: ${esc(wordStatusLabel(p))} · تاريخ الدراسة: ${dateLabel(p.studyDate)} · الأسبوع ${p.week || '—'} · الشهر ${p.month || '—'}</p><div class="actions"><button class="btn ${p.mastered ? 'btn-plain' : 'btn-primary'}" data-action="toggle-mastered" data-id="${esc(id)}">${p.mastered ? 'إلغاء الحفظ' : 'علّمها محفوظة'}</button></div></section></div>`;
}

function exportBackup() {
  const backup = { app: 'mufradati-english', backupVersion: 1, exportedAt: new Date().toISOString(), wordsCount: words.length, state };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mufradati-backup-${todayString()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('تم تنزيل النسخة الاحتياطية.');
}

function mergeBackup(incoming) {
  const other = incoming?.state;
  if (incoming?.app !== 'mufradati-english' || !other || !other.progress || !Array.isArray(other.attempts)) throw new Error('صيغة النسخة الاحتياطية غير معروفة.');
  const combined = typeof structuredClone === 'function' ? structuredClone(state) : JSON.parse(JSON.stringify(state));
  if (other.startedAt && (!combined.startedAt || other.startedAt < combined.startedAt)) combined.startedAt = other.startedAt;
  combined.settings = { ...combined.settings, ...(other.settings || {}) };
  for (const [id, p] of Object.entries(other.progress || {})) {
    if (!wordById(id)) continue;
    const current = combined.progress[id] || freshProgress();
    if (!current.updatedAt || (p.updatedAt || '') > (current.updatedAt || '')) combined.progress[id] = { ...freshProgress(), ...p };
    else {
      current.mastered ||= Boolean(p.mastered);
      if (!current.studyDate || (p.studyDate && p.studyDate < current.studyDate)) {
        current.studyDate = p.studyDate; current.week = p.week; current.month = p.month;
      }
      current.reviewCount = Math.max(current.reviewCount || 0, p.reviewCount || 0);
    }
  }
  const mergeById = (left, right) => {
    const itemKey = item => item.id || `${item.at || ''}|${item.answer || ''}|${item.correction || ''}`;
    const map = new Map(left.map(item => [itemKey(item), item]));
    for (const item of right) {
      const key = itemKey(item);
      const current = map.get(key);
      const stamp = value => value.updatedAt || value.finishedAt || value.at || '';
      if (!current || stamp(item) > stamp(current)) map.set(key, item);
    }
    return [...map.values()];
  };
  combined.attempts = mergeById(combined.attempts, other.attempts || []);
  combined.log = mergeById(combined.log, other.log || []);
  for (const [date, incomingSession] of Object.entries(other.dailySessions || {})) {
    const current = combined.dailySessions[date];
    if (!current) combined.dailySessions[date] = incomingSession;
    else {
      const ids = [...new Set([...(current.wordIds || []), ...(incomingSession.wordIds || [])])].slice(0, 5);
      combined.dailySessions[date] = {
        ...incomingSession, ...current,
        wordIds: ids,
        reviewedIds: [...new Set([...(current.reviewedIds || []), ...(incomingSession.reviewedIds || [])])],
        currentIndex: Math.max(current.currentIndex || 0, incomingSession.currentIndex || 0),
        completed: Boolean(current.completed || incomingSession.completed)
      };
    }
  }
  if (!combined.activeDailyDate && other.activeDailyDate) combined.activeDailyDate = other.activeDailyDate;
  if (other.activeReview && (!combined.activeReview || (other.activeReview.currentIndex || 0) > (combined.activeReview.currentIndex || 0))) combined.activeReview = other.activeReview;
  for (const [key, incomingError] of Object.entries(other.errors || {})) {
    if (!combined.errors[key]) combined.errors[key] = incomingError;
    else {
      const currentError = combined.errors[key];
      const occurrences = mergeById(currentError.occurrences || [], incomingError.occurrences || []).sort((a, b) => (a.at || '').localeCompare(b.at || ''));
      const reviewedAt = [currentError.reviewedAt, incomingError.reviewedAt].filter(Boolean).sort().at(-1) || null;
      combined.errors[key] = { ...incomingError, ...currentError, occurrences, reviewedAt, reviewed: Boolean(reviewedAt && reviewedAt >= (occurrences.at(-1)?.at || '')) };
    }
  }
  return combined;
}

async function importBackup(file) {
  try {
    const incoming = JSON.parse(await file.text());
    state = mergeBackup(incoming);
    for (const word of words) state.progress[word.id] = { ...freshProgress(), ...(state.progress[word.id] || {}) };
    saveState();
    showToast('تم دمج النسخة الاحتياطية مع البيانات الحالية.');
    render();
  } catch (error) {
    showToast(`تعذر استيراد الملف: ${error.message}`);
  }
}

function handleAction(button) {
  const action = button.dataset.action;
  const id = button.dataset.id;
  if (action === 'go-daily') return navigate('daily');
  if (action === 'go-home') return navigate('home');
  if (action === 'go-words') return navigate('words');
  if (action === 'go-quizzes') return navigate('quizzes');
  if (action === 'go-errors') return navigate('errors');
  if (action === 'go-log') return navigate('log');
  if (action === 'toggle-mastered') return toggleMastered(id);
  if (action === 'speak' || action === 'daily-speak' || action === 'quiz-speak') return speakWord(wordById(id));
  if (action === 'word-details') return showWordDetails(id);
  if (action === 'close-modal') { if (button.closest('[data-modal]') && button.dataset.action === 'close-modal' && button.tagName !== 'BUTTON') return; document.getElementById('modal-root').innerHTML = ''; return; }
  if (action === 'daily-new-mode') return setDailyMode(false);
  if (action === 'daily-review-mode') return setDailyMode(true);
  if (action === 'daily-select-session') {
    state.activeDailyDate = button.dataset.date;
    state.activeReview = null;
    ensureDailySession(state.activeDailyDate);
    saveState();
    render();
    return;
  }
  if (action === 'daily-next') return dailyNext(1);
  if (action === 'daily-prev') return dailyNext(-1);
  if (action === 'daily-jump') {
    const { session, reviewMode } = currentDailyContext();
    if (reviewMode) state.activeReview.currentIndex = Number(button.dataset.index); else session.currentIndex = Number(button.dataset.index);
    saveState(); render(); return;
  }
  if (action === 'recall-start') { const p = progressFor(id); p.practice.recall ||= {}; p.practice.recall.started = true; saveState(); render(); return; }
  if (action === 'set-status') return setWordStatus(id, button.dataset.status);
  if (action === 'daily-speech') return dailySpeech(id);
  if (action === 'daily-speech-skip') { const p = progressFor(id); p.practice.dailySpeech = { tries: 0, ...(p.practice.dailySpeech || {}), feedback: 'تم التخطي، ولم نسجّل خطأ نطق.', done: true }; recordPractice(id, 'pronunciation', 'skipped', '', wordById(id).english, false); render(); return; }
  if (action === 'list-prev') { listPage = Math.max(1, listPage - 1); return render(); }
  if (action === 'list-next') { listPage += 1; return render(); }
  if (action === 'error-filter') { errorFilter = button.dataset.filter; return render(); }
  if (action === 'toggle-error-reviewed') {
    const error = state.errors[id]; if (error) { error.reviewed = !error.reviewed; error.reviewedAt = error.reviewed ? new Date().toISOString() : null; saveState(); render(); }
    return;
  }
  if (action === 'retry-error') { const error = state.errors[id]; if (error) startAttempt('errors', `مراجعة ${PHASE_LABELS[error.type]} · ${wordById(error.wordId).english}`, [error.wordId]); return; }
  if (action === 'retry-all-errors') { const ids = [...new Set(Object.values(state.errors).filter(e => errorFilter === 'all' || e.type === errorFilter).map(e => e.wordId))]; return startAttempt('errors', 'إعادة اختبار الكلمات في قائمة الأخطاء', ids); }
  if (action === 'retry-attempt-errors') { const attempt = state.attempts.find(a => a.id === id); if (attempt) { const failed = quizCardData(attempt).needsReview; return startAttempt('errors', `مراجعة أخطاء ${attempt.title}`, failed); } }
  if (action === 'start-final') { const ids = words.filter(w => progressFor(w.id).studyDate).map(w => w.id); return startAttempt('final', 'اختبار النجاح النهائي', ids); }
  if (action === 'retry-final') { const ids = words.filter(w => progressFor(w.id).studyDate).map(w => w.id); return startAttempt('final', 'اختبار النجاح النهائي · محاولة جديدة', ids); }
  if (action === 'start-group-quiz') {
    const kind = button.dataset.kind; const group = Number(button.dataset.group); const field = kind === 'weekly' ? 'week' : 'month';
    const ids = words.filter(w => progressFor(w.id)[field] === group && progressFor(w.id).studyDate).map(w => w.id);
    return startAttempt(kind, `${kind === 'weekly' ? 'اختبار الأسبوع' : 'اختبار الشهر'} ${group}`, ids);
  }
  if (action === 'quiz-writing-next') return finishQuizStep();
  if (action === 'quiz-next') return finishQuizStep();
  if (action === 'quiz-skip') {
    const attempt = activeAttempt(); const word = wordById(attempt.wordIds[attempt.index]);
    const result = { status: 'skipped', answer: '', tries: attempt.drafts[`speech:${word.id}`]?.tries || 0, at: new Date().toISOString() };
    attempt.answers.pronunciation[word.id] = result; updateQuizProgress(attempt, word.id, 'pronunciation', result, '', word.english); saveState(); render(); return;
  }
  if (action === 'quiz-recognize') return quizSpeech();
  if (action === 'resume-attempt') { state.activeAttemptId = id; saveState(); page = 'quizzes'; render(); return; }
  if (action === 'quiz-leave') { state.activeAttemptId = null; saveState(); return navigate('quizzes'); }
  if (action === 'show-result') return showResult(id);
  if (action === 'export-backup') return exportBackup();
}

app.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (button) handleAction(button);
});

document.querySelectorAll('.nav-link').forEach(button => button.addEventListener('click', () => navigate(button.dataset.page)));
document.getElementById('modal-root').addEventListener('click', event => {
  const actionButton = event.target.closest('button[data-action]');
  if (actionButton) return handleAction(actionButton);
  if (event.target.classList.contains('modal-backdrop')) document.getElementById('modal-root').innerHTML = '';
});
document.getElementById('menu-toggle').addEventListener('click', event => {
  const open = nav.classList.toggle('open');
  event.currentTarget.setAttribute('aria-expanded', String(open));
});

app.addEventListener('submit', event => {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  if (form.dataset.form === 'daily-recall') {
    const id = form.dataset.id; const word = wordById(id); const answer = new FormData(form).get('answer') || '';
    const p = progressFor(id); const recall = p.practice.recall || (p.practice.recall = {});
    const correct = normalize(answer) === normalize(word.english);
    recall.started = true; recall.checked = true; recall.correct = correct; recall.answer = answer; recall.draft = answer;
    recordPractice(id, 'writing', correct ? 'correct' : 'wrong', answer, word.english, true); render();
  }
  if (form.dataset.form === 'daily-cloze') {
    const id = form.dataset.id; const word = wordById(id); const answer = new FormData(form).get('answer') || '';
    const p = progressFor(id); const cloze = p.practice.cloze || (p.practice.cloze = {});
    const correct = normalize(answer) === normalize(word.english);
    cloze.checked = true; cloze.correct = correct; cloze.answer = answer; cloze.draft = answer;
    recordPractice(id, 'sentence', correct ? 'correct' : 'wrong', answer, word.example, true); render();
  }
  if (form.dataset.form === 'quiz-writing') submitWriting(form);
  if (form.dataset.form === 'quiz-sentence') submitSentence(form);
  if (form.dataset.form === 'threshold') {
    const value = Math.max(1, Math.min(100, Number(new FormData(form).get('threshold')) || 80));
    state.settings.successThreshold = value; saveState(); showToast(`حُفظت نسبة النجاح المطلوبة: ${value}%.`); render();
  }
});

app.addEventListener('input', event => {
  const filter = event.target.dataset.filter;
  if (filter) {
    listFilters[filter] = event.target.value;
    if (filter !== 'q') { listPage = 1; render(); }
    else {
      listPage = 1;
      clearTimeout(window.searchTimer);
      window.searchTimer = setTimeout(render, 160);
    }
    return;
  }
  const form = event.target.closest('[data-form]');
  if (!form) return;
  if (form.dataset.form === 'daily-recall' || form.dataset.form === 'daily-cloze') {
    const p = progressFor(form.dataset.id); const key = form.dataset.form === 'daily-recall' ? 'recall' : 'cloze';
    p.practice[key] ||= {}; p.practice[key].draft = event.target.value; saveState();
  }
  if (form.dataset.form === 'quiz-writing' || form.dataset.form === 'quiz-sentence') {
    const attempt = activeAttempt(); if (!attempt) return;
    const word = wordById(attempt.wordIds[attempt.index]); attempt.drafts[`${attempt.phase}:${word.id}`] = event.target.value; saveState();
  }
});

app.addEventListener('change', event => {
  if (event.target.dataset.filter) { listFilters[event.target.dataset.filter] = event.target.value; listPage = 1; render(); }
  if (event.target.matches('[data-action="import-file"]')) {
    const file = event.target.files?.[0]; if (file) importBackup(file);
  }
});

async function init() {
  try {
    const response = await fetch('./words.json');
    if (!response.ok) throw new Error('تعذّر تحميل ملف الكلمات.');
    words = await response.json();
    if (!Array.isArray(words) || !words.length) throw new Error('ملف الكلمات فارغ أو غير صالح.');
    loadState();
    render();
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) navigator.serviceWorker.register('./sw.js').catch(error => console.warn('Offline cache unavailable', error));
    if (words.length !== EXPECTED_WORDS) console.warn(`Expected ${EXPECTED_WORDS} words, imported ${words.length}. All imported records are retained.`);
  } catch (error) {
    app.innerHTML = `<section class="panel"><div class="notice error"><span>!</span><div>${esc(error.message)} شغّل الموقع عبر خادم محلي أو استضافة ثابتة، ولا تفتح ملف HTML مباشرة.</div></div></section>`;
  }
}

// Override the base renderer only while displaying a finished attempt.
const baseRender = render;
render = function () {
  if (page === 'result') {
    document.querySelectorAll('.nav-link').forEach(el => el.classList.toggle('active', el.dataset.page === 'quizzes'));
    app.innerHTML = makeResultHtml();
    return;
  }
  baseRender();
};

init();
