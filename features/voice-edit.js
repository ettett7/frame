// עריכה בקול: האזנה לפקודה (Web Speech API) ופענוח שלה לטווחי חיתוך על התמלול.
// הקובץ טהור (בלי DOM בזמן הטעינה), לכן הוא עובד ב־node, ב־Worker וגם בדפדפן.
// כל הזמנים בשניות, זמני מקור (כמו ב־Transcript ב־CONTRACT.md).
//
// ממשק עיקרי:
//   listen({lang, signal, onInterim, timeoutMs}) -> Promise<string|null>   null = אין Web Speech בדפדפן הזה
//   parseCommand(text, transcript, {duration}) -> {action, ranges, explanationHe, ...} | null
//   applyToPlan(plan, command) -> Plan חדש (חיתוכים ב־segments)
//
// משמעות ה־ranges לפי action (תמיד זמני מקור):
//   'delete' : הטווחים שיימחקו (באמצע הסרטון, או כמה מקומות, למשל מילות מילוי)
//   'trim'   : הטווח שיורד מההתחלה (side:'start') או מהסוף (side:'end')
//   'keep'   : הטווחים היחידים שנשארים
// עיקרון "העוגן נשאר": ב־"עד X" ו־"אחרי X" המילים של X עצמן נשארות בסרטון.
// ב־"מ־A עד B" שני העוגנים נכללים בטווח, כי המשתמש נקב בשניהם.

// ------------------------------------------------------------------------------------------ נרמול טקסט

const MARKS_RE = /[֑-ׇֽֿׁׂׅׄ̀-ͯ]/g;   // ניקוד, טעמים, סימני הטעמה
const FINALS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };

/** ניקוי בסיסי בלי לגעת באותיות סופיות: בלי ניקוד, בלי גרש ומירכאות בתוך מילה, אותיות קטנות. */
function strip(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(MARKS_RE, '')
    .replace(/[\u05F3\u05F4'’‘`´"״“”„«»]/g, '')
    .toLowerCase();
}

/** נרמול למילה אחת או למחרוזת: בלי ניקוד, אותיות סופיות הופכות לרגילות, אותיות קטנות, בלי גרש ומירכאות בתוך מילה. */
export function fold(s) {
  return strip(s).replace(/[ךםןףץ]/g, (c) => FINALS[c]);
}

/** מפרק לאסימונים אחרי נרמול (אותיות ומספרים בלבד). raw:true משאיר את האותיות הסופיות, להצגה למשתמש. */
export function tokenize(s, { raw = false } = {}) {
  const t = strip(String(s ?? '').replace(/[־\-–—_]+/g, ' '));
  return (raw ? t : t.replace(/[ךםןףץ]/g, (c) => FINALS[c])).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

const HEB_RE = /^[א-ת]+$/;
const HEB_PREFIX = new Set(['ו', 'ה', 'ב', 'כ', 'ל', 'מ', 'ש']);

/** גזעים אפשריים של אסימון: האסימון עצמו, ואחריו גרסאות בלי קידומות (ו, ה, ב, כ, ל, מ, ש), עד שלוש. */
export function stems(tok) {
  const out = [tok];
  if (HEB_RE.test(tok)) {
    let cur = tok;
    for (let i = 0; i < 3 && cur.length >= 4 && HEB_PREFIX.has(cur[0]); i++) { cur = cur.slice(1); out.push(cur); }
  } else if (tok.length >= 5) {
    for (const suf of ['ing', 'ed', 'es', 's', 'ly']) {
      if (tok.endsWith(suf) && tok.length - suf.length >= 3) { out.push(tok.slice(0, -suf.length)); break; }
    }
  }
  return out;
}

const skel = (x) => x.replace(/[וי]/g, '');   // שלד עיצורים: מבטל הבדלי כתיב מלא וחסר

function editDistance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > limit) return limit + 1;
    prev = cur;
  }
  return prev[b.length];
}

function pairScore(x, y) {
  if (x === y) return 1;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  if (s.length >= 3 && l.startsWith(s)) {                    // ריבוי, סיומות: בורגר / בורגרים
    const d = l.length - s.length;
    if (d <= (s.length >= 5 ? 3 : s.length === 4 ? 2 : 1)) return 0.82;
  }
  if (s.length >= 3) {
    const kx = skel(x), ky = skel(y);
    if (kx.length >= 3 && kx === ky) return 0.85;           // כתיב מלא מול חסר
  }
  if (s.length >= 4 && Math.abs(x.length - y.length) <= 2) {  // שגיאות זיהוי קטנות
    const lim = s.length >= 8 ? 2 : s.length >= 5 ? 1 : 0;
    if (lim) {
      const d = editDistance(x, y, lim);
      if (d <= lim) return d === 1 ? 0.78 : 0.68;
    }
  }
  return 0;
}

/** דמיון בין שני אסימונים מנורמלים (0..1): קידומות, סיומות, כתיב מלא/חסר ושגיאות קטנות. */
export function matchScore(a, b, sa = stems(a), sb = stems(b)) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  let best = 0;
  for (const x of sa) {
    for (const y of sb) {
      let sc = pairScore(x, y);
      if (sc && (x !== a || y !== b)) sc *= 0.95;            // התאמה אחרי הסרת קידומת: קצת פחות בטוחה
      if (sc > best) best = sc;
    }
  }
  return best;
}

// ------------------------------------------------------------------------------------------ מילונים

const setOf = (arr) => new Set(arr.map(fold));

const V_DEL = setOf(['מחק', 'תמחק', 'מחקי', 'תמחקי', 'מחקו', 'תמחקו', 'למחוק', 'תמחוק', 'ימחק', 'שתמחק', 'מחיקה',
  'הורד', 'תוריד', 'הורידי', 'תורידי', 'הורידו', 'תורידו', 'להוריד', 'הסר', 'תסיר', 'הסירי', 'תסירי', 'הסירו', 'תסירו', 'להסיר',
  'חתוך', 'תחתוך', 'חתכי', 'תחתכי', 'חתכו', 'תחתכו', 'לחתוך', 'הוצא', 'תוציא', 'הוציאי', 'תוציאי', 'להוציא',
  'העף', 'תעיף', 'העיפי', 'תעיפי', 'להעיף', 'קצץ', 'תקצץ', 'לקצץ', 'זרוק', 'תזרוק', 'לזרוק', 'נקה', 'תנקה', 'לנקות',
  'דלג', 'תדלג', 'לדלג', 'תיפטר', 'להיפטר', 'חסל', 'תחסל', 'בלי', 'ללא',
  'delete', 'remove', 'cut', 'drop', 'trim', 'erase', 'skip', 'lose', 'strip', 'without', 'rid', 'cutting', 'deleting', 'removing']);
const V_KEEP = setOf(['השאר', 'תשאיר', 'השארי', 'תשאירי', 'השאירו', 'תשאירו', 'להשאיר', 'שמור', 'תשמור', 'שמרי', 'תשמרי', 'שמרו', 'תשמרו', 'לשמור',
  'keep', 'retain', 'save', 'leave']);
const V_START = setOf(['התחל', 'תתחיל', 'התחילי', 'תתחילי', 'התחילו', 'תתחילו', 'להתחיל', 'יתחיל', 'שיתחיל', 'תפתח', 'start', 'begin']);
const V_END = setOf(['סיים', 'תסיים', 'סיימי', 'תסיימי', 'סיימו', 'תסיימו', 'לסיים', 'יסתיים', 'שיסתיים', 'יסיים', 'שיסיים', 'תגמור', 'גמור', 'ייגמר', 'שייגמר',
  'end', 'finish', 'stop']);

const N_START = setOf(['התחלה', 'ההתחלה', 'פתיחה', 'הפתיחה', 'הפתיח', 'תחילת', 'התחלת', 'beginning', 'start', 'intro', 'opening', 'begining']);
const N_END = setOf(['סוף', 'הסוף', 'סיום', 'הסיום', 'סופו', 'סוףהסרטון', 'ending', 'end', 'outro', 'finish']);
const N_PART = setOf(['חלק', 'החלק', 'קטע', 'הקטע', 'משפט', 'המשפט', 'פסקה', 'הפסקה', 'סצנה', 'הסצנה', 'רגע', 'הרגע', 'חלקים', 'part', 'section', 'bit', 'segment', 'sentence', 'scene', 'portion', 'moment']);
const N_WORD = setOf(['מילה', 'המילה', 'מילים', 'המילים', 'ביטוי', 'הביטוי', 'word', 'words', 'phrase']);
const N_VIDEO = setOf(['הסרטון', 'סרטון', 'הקליפ', 'קליפ', 'הוידאו', 'וידאו', 'ווידאו', 'הווידאו', 'video', 'clip']);

const M_FROM = setOf(['מ', 'מן', 'from', 'starting', 'since']);
const M_TO = setOf(['עד', 'ועד', 'until', 'till', 'til', 'through', 'thru', 'upto']);
const M_AFTER = setOf(['אחרי', 'לאחר', 'after']);
const M_BEFORE = setOf(['לפני', 'before', 'prior']);
const M_BETWEEN = setOf(['בין', 'between']);
const M_BETWEEN_AND = setOf(['ל', 'ו', 'לבין', 'ובין', 'and', 'to']);
const M_ONWARD = setOf(['ואילך', 'והלאה', 'onward', 'onwards']);
const M_ABOUT = setOf(['על', 'בנושא', 'לגבי', 'אודות', 'בקשר', 'about', 'regarding', 'concerning', 'where', 'when', 'talking', 'talks', 'talk', 'mentions', 'mention',
  'mentioning', 'says', 'saying', 'discusses', 'discussing', 'שמדבר', 'שמדברים', 'שמדברת', 'שאומר', 'שאומרת', 'שאומרים', 'שמזכיר', 'שמזכירה', 'שמזכירים',
  'שבו', 'שבה', 'שמספר', 'שמספרת', 'שעוסק', 'שעוסקת', 'העוסק', 'כשאומר', 'כשאומרים', 'אומר', 'אומרת', 'מדבר', 'מדברת', 'מדברים', 'מספר', 'מספרת']);

const NOISE = setOf(['את', 'אתה', 'אתם', 'אתן', 'זה', 'זאת', 'הזה', 'הזאת', 'הזו', 'רק', 'גם', 'כל', 'הכול', 'הכל', 'מה', 'ש', 'אני', 'רוצה', 'רוצים', 'בבקשה', 'אנא', 'נא', 'תוכל', 'תוכלי',
  'אפשר', 'לי', 'אותי', 'שלי', 'של', 'ה', 'ו', 'ל', 'ב', 'כ', 'הוא', 'היא', 'שהוא', 'שהיא', 'כשהוא', 'כשהיא', 'שאני', 'שאנחנו', 'אז', 'ואז', 'כמו', 'כך', 'אחר', 'כולל', 'בו', 'בה', 'שלו', 'שלה', 'שתמחק', 'שתוריד', 'שתשאיר',
  'the', 'a', 'an', 'of', 'that', 'this', 'please', 'i', 'want', 'you', 'to', 'can', 'could', 'would', 'me', 'my', 'all', 'everything', 'only', 'just', 'and', 'is', 'are', 'be', 'it', 'he', 'she', 'they', 'who',
  'up', 'at', 'on', 'in', 'with', 'out', 'get', 'take', 'for', 'then', 'also', 'every', 'each', 'rest', 'also', 'his', 'her', 'their', 'in', 'off', 'part', 'parts']);

// רעש בקצוות של עוגן (ביטוי שהמשתמש אמר): רק מילות קישור, לא "אני" או "מה" שיכולות להיות חלק מהביטוי
const EDGE_NOISE = setOf(['את', 'ה', 'ו', 'ל', 'ב', 'כ', 'של', 'זה', 'הזה', 'הזאת', 'זאת', 'רק', 'גם', 'כל', 'הכול', 'הכל', 'בבקשה', 'אנא', 'נא', 'כולל', 'ש',
  'the', 'a', 'an', 'of', 'please', 'only', 'just', 'and', 'that', 'this', 'all', 'everything', 'then', 'inclusive']);

// מילות מילוי "ליבה": אממ, אה, um, uh. "אם" (if) לא נכללת, כי נדרשות שתי מ' או ה' אחרי א'.
const FILLER_RE = [
  /^א+ה{1,}$/, /^א{2,}$/, /^א+ה*מ{2,}$/, /^ה+מ{2,}$/, /^א+ה+מ+$/, /^א+מ{2,}ים$/,
  /^u+h+s?$/, /^u+m+s?h*$/, /^e+r+m*s?$/, /^h+m+s?$/, /^a+h{2,}$/, /^m+h*m+$/, /^eh+$/, /^uhm+$/,
];
// מילים שנמחקות רק כשמבקשים אותן בשמן (או "מילות מילוי" כללית רחבה)
const FILLER_EXTRA = setOf(['כאילו', 'יעני', 'יענו', 'נו', 'ככה', 'בעצם', 'like', 'basically', 'actually', 'literally']);
const FILLER_EXTRA_PHRASES = [['אתה', 'יודע'], ['את', 'יודעת'], ['you', 'know']];
const FILLER_WORDS = setOf(['מילות', 'מילים', 'מילת', 'מיותרות', 'מילוי', 'המילוי', 'filler', 'fillers', 'hesitations', 'גמגומים', 'הגמגומים', 'גימגומים', 'tics']);
const SILENCE_WORDS = setOf(['שתיקות', 'שתיקה', 'השתיקות', 'השתיקה', 'הפסקות', 'ההפסקות', 'pauses', 'pause', 'silence', 'silences', 'silent', 'רווחים', 'שקט']);

const ORDINALS = {
  [fold('ראשון')]: 1, [fold('הראשון')]: 1, [fold('ראשונה')]: 1, [fold('הראשונה')]: 1, first: 1,
  [fold('שני')]: 2, [fold('השני')]: 2, [fold('שנייה')]: 2, [fold('השנייה')]: 2, second: 2,
  [fold('שלישי')]: 3, [fold('השלישי')]: 3, [fold('שלישית')]: 3, [fold('השלישית')]: 3, third: 3,
  [fold('אחרון')]: -1, [fold('האחרון')]: -1, [fold('אחרונה')]: -1, [fold('האחרונה')]: -1, last: -1, final: -1,
};
const N_SENTENCE = setOf(['משפט', 'המשפט', 'שורה', 'השורה', 'sentence', 'line']);
const N_SEGMENT = setOf(['קטע', 'הקטע', 'פסקה', 'הפסקה', 'segment', 'paragraph']);

const NUM_WORDS = Object.fromEntries(Object.entries({
  אחד: 1, אחת: 1, שניים: 2, שתיים: 2, שנים: 2, שתי: 2, שלוש: 3, שלושה: 3, ארבע: 4, ארבעה: 4, חמש: 5, חמישה: 5, שש: 6, שישה: 6, שבע: 7, שבעה: 7,
  שמונה: 8, תשע: 9, תשעה: 9, עשר: 10, עשרה: 10, עשרים: 20, שלושים: 30, ארבעים: 40, חמישים: 50, שישים: 60,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
}).map(([k, v]) => [fold(k), v]));
const U_SEC = setOf(['שניות', 'שנייה', 'שניה', 'השניות', 'השנייה', 'השניה', 'שנ', 'second', 'seconds', 'sec', 'secs']);
const U_MIN = setOf(['דקות', 'דקה', 'הדקות', 'הדקה', 'minute', 'minutes', 'min', 'mins']);
const W_HEAD = setOf(['הראשונות', 'הראשונים', 'ראשונות', 'ראשונים', 'הראשונה', 'first', 'beginning', 'start', 'intro', 'מההתחלה', 'בהתחלה', 'ההתחלה', 'התחלה', 'מתחילת']);
const W_TAIL = setOf(['האחרונות', 'האחרונים', 'אחרונות', 'אחרונים', 'האחרונה', 'last', 'final', 'end', 'ending', 'outro', 'מהסוף', 'בסוף', 'הסוף', 'סוף', 'מסוף']);
const W_EXCEPT = setOf(['חוץ', 'מלבד', 'except', 'besides']);
const FROM_BLOCK = setOf(['מה', 'מי', 'מדוע', 'מתי', 'מאוד', 'מעט', 'מעל', 'מול', 'מתוך', 'מזה', 'מזל', 'ממש', 'מילה', 'מילים', 'מילות', 'מיותרות', 'מאחורי', 'מקום', 'מתחת', 'מספר', 'מדבר', 'מדברים', 'מדברת']);

// ------------------------------------------------------------------------------------------ מבנה התמלול

const indexCache = new WeakMap();

function pseudoWords(segs) {
  const out = [];
  for (const s of segs) {
    const ws = String(s.text ?? '').split(/\s+/).filter(Boolean);
    if (!ws.length) continue;
    const step = (s.end - s.start) / ws.length;
    ws.forEach((w, i) => out.push({ text: w, start: s.start + i * step, end: s.start + (i + 1) * step }));
  }
  return out;
}

function buildIndex(transcript) {
  const key = transcript || {};
  const hit = indexCache.get(key);
  const nWords = transcript?.words?.length ?? 0, nSegs = transcript?.segments?.length ?? 0;
  const ws = transcript?.words ?? [];
  const sig = `${nSegs}|${ws.map((w) => `${w?.text}@${w?.start}`).join('\u0001')}`;   // תמלול שנערך במקום לא יישאר במטמון
  if (hit && hit.sig === sig) return hit;
  const segs = (Array.isArray(transcript?.segments) ? transcript.segments : [])
    .filter((s) => s && Number.isFinite(s.start) && Number.isFinite(s.end)).slice().sort((a, b) => a.start - b.start);
  let words = (Array.isArray(transcript?.words) ? transcript.words : [])
    .filter((w) => w && Number.isFinite(w.start) && Number.isFinite(w.end) && String(w.text ?? '').trim());
  if (!words.length && segs.length) words = pseudoWords(segs);
  words = words.slice().sort((a, b) => a.start - b.start);
  const toks = words.map((w) => fold(w.text).replace(/[^\p{L}\p{N}]+/gu, ''));
  const keep = toks.map((t) => t.length > 0);
  const W = words.filter((_, i) => keep[i]);
  const T = toks.filter((t) => t.length > 0);
  const S = T.map(stems);
  const sentences = splitSentences(W, segs);
  const sentOf = new Array(W.length);
  sentences.forEach((s, si) => { for (let k = s.i0; k <= s.i1; k++) sentOf[k] = si; });
  const duration = Math.max(0, W.length ? W[W.length - 1].end : 0, segs.length ? segs[segs.length - 1].end : 0);
  const idx = { words: W, toks: T, stems: S, sentences, sentOf, segs, duration, sig };
  indexCache.set(key, idx);
  return idx;
}

function splitSentences(words, segs) {
  const segIdx = (w) => {
    const mid = (w.start + w.end) / 2;
    for (let i = 0; i < segs.length; i++) if (mid >= segs[i].start - 0.1 && mid <= segs[i].end + 0.1) return i;
    return -1;
  };
  const out = [];
  let i0 = 0;
  for (let k = 0; k < words.length; k++) {
    const w = words[k], nx = words[k + 1];
    const brk = !nx || /[.!?…]["'”’)]*$/.test(String(w.text).trim()) || nx.start - w.end >= 0.9
      || (segs.length > 0 && segIdx(w) !== segIdx(nx)) || k - i0 + 1 >= 40;
    if (brk) {
      out.push({ start: words[i0].start, end: w.end, i0, i1: k, text: words.slice(i0, k + 1).map((x) => x.text).join(' ') });
      i0 = k + 1;
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------ חיפוש בתמלול

/** חיפוש ביטוי (רשימת אסימונים מנורמלים) בתמלול. מחזיר [{i, j, start, end, score}] ממוינים לפי ציון ואז מיקום. */
export function searchPhrase(transcript, termToks, { minScore } = {}) {
  const idx = buildIndex(transcript);
  const n = termToks.length;
  if (!n || !idx.toks.length) return [];
  const tStems = termToks.map(stems);
  const cands = [];
  for (let i = 0; i + n <= idx.toks.length; i++) {
    const sc = [];
    for (let j = 0; j < n; j++) sc.push(matchScore(termToks[j], idx.toks[i + j], tStems[j], idx.stems[i + j]));
    const mean = sc.reduce((a, b) => a + b, 0) / n;
    const weak = sc.filter((s) => s < 0.5).length;
    let ok;
    if (n === 1) ok = sc[0] >= (minScore ?? 0.7);
    else if (n === 2) ok = sc[0] >= 0.7 && sc[1] >= 0.7;
    else ok = mean >= (minScore ?? 0.72) && weak <= Math.floor(n / 4);
    if (ok) cands.push({ i, j: i + n - 1, start: idx.words[i].start, end: idx.words[i + n - 1].end, score: mean });
  }
  cands.sort((a, b) => b.score - a.score || a.start - b.start);
  const kept = [];
  for (const c of cands) if (!kept.some((k) => c.i <= k.j && c.j >= k.i)) kept.push(c);
  return kept;
}

/** חיפוש נושא: איזה "חלק" בתמלול עוסק במילות התוכן. מחזיר אשכולות של משפטים סמוכים, הטוב ראשון. */
export function searchTopic(transcript, termToks) {
  const idx = buildIndex(transcript);
  const terms = termToks.filter((t) => t.length >= 3 || /^\d+$/.test(t));
  if (!terms.length || !idx.toks.length) return [];
  const tStems = terms.map(stems);
  const per = idx.sentences.map(() => ({ terms: new Set(), hits: 0 }));
  terms.forEach((t, ti) => {
    for (let k = 0; k < idx.toks.length; k++) {
      if (matchScore(t, idx.toks[k], tStems[ti], idx.stems[k]) >= 0.7) { const p = per[idx.sentOf[k]]; p.terms.add(ti); p.hits++; }
    }
  });
  const weight = (p) => p.terms.size + 0.25 * (p.hits - p.terms.size);
  const clusters = [];
  let cur = null;
  per.forEach((p, si) => {
    if (!p.hits) return;
    if (cur && si - cur.last <= 2) { cur.last = si; cur.w += weight(p); p.terms.forEach((x) => cur.terms.add(x)); }
    else { cur = { first: si, last: si, w: weight(p), terms: new Set(p.terms) }; clusters.push(cur); }
  });
  const need = Math.ceil(terms.length / 2);
  return clusters.filter((c) => c.terms.size >= need)
    .sort((a, b) => b.w - a.w || a.first - b.first)
    .map((c) => ({ ...c, start: idx.sentences[c.first].start, end: idx.sentences[c.last].end,
      excerpt: idx.sentences.slice(c.first, c.last + 1).map((s) => s.text).join(' ') }));
}

/** האם האסימון (מנורמל) הוא מילת מילוי "ליבה": אממ, אה, um, uh. מתחשב גם בקידומת ("האממ"). */
export function isCoreFiller(tok) {
  return stems(tok).some((x) => FILLER_RE.some((re) => re.test(x)));
}

/**
 * מילות מילוי כטווחים: [{start, end, words}].
 * ברירת מחדל: מילות הליבה. extra:true מוסיף גם "כאילו", "יעני", "you know" ועוד. only:[אסימונים] מוחק רק מילים בשם הזה.
 */
export function findFillers(transcript, { extra = false, only = null } = {}) {
  const idx = buildIndex(transcript);
  const hit = new Set();
  idx.toks.forEach((t, k) => {
    if (only) { if (only.some((o) => matchScore(o, t) >= 0.85)) hit.add(k); }
    else if (isCoreFiller(t) || (extra && FILLER_EXTRA.has(t))) hit.add(k);
  });
  if (extra && !only) {
    for (const ph of FILLER_EXTRA_PHRASES) {
      const toks = ph.map(fold);
      for (let i = 0; i + toks.length <= idx.toks.length; i++) {
        if (toks.every((tk, j) => idx.toks[i + j] === tk)) toks.forEach((_, j) => hit.add(i + j));
      }
    }
  }
  const sorted = [...hit].sort((a, b) => a - b);
  return mergeRanges(sorted.map((k) => ({ start: idx.words[k].start, end: idx.words[k].end })), 0.05)
    .map((r) => ({ ...r, words: sorted.filter((k) => idx.words[k].start >= r.start - 1e-6 && idx.words[k].end <= r.end + 1e-6).map((k) => idx.words[k].text) }));
}

/** שתיקות ארוכות בין מילים: מחזיר את תוך הרווח, ומשאיר שוליים כדי שהחיתוך לא יקטע מילים. */
export function findSilences(transcript, { minGap = 0.8, keepEdge = 0.2 } = {}) {
  const idx = buildIndex(transcript);
  const out = [];
  for (let k = 0; k + 1 < idx.words.length; k++) {
    const gap = idx.words[k + 1].start - idx.words[k].end;
    if (gap >= minGap) out.push({ start: idx.words[k].end + keepEdge, end: idx.words[k + 1].start - keepEdge });
  }
  return out.filter((r) => r.end - r.start > 0.05);
}

// ------------------------------------------------------------------------------------------ טווחים

export function mergeRanges(ranges, gap = 0) {
  const rs = ranges.filter((r) => r && r.end > r.start).map((r) => ({ ...r })).sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of rs) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + gap) last.end = Math.max(last.end, r.end);
    else out.push(r);
  }
  return out;
}

/** משלים טווחים לתחום [a,b]: מה שנשאר כשמוציאים את הטווחים. */
export function invertRanges(ranges, a, b) {
  const out = [];
  let cur = a;
  for (const r of mergeRanges(ranges)) {
    if (r.start > cur) out.push({ start: cur, end: Math.min(r.start, b) });
    cur = Math.max(cur, r.end);
    if (cur >= b) break;
  }
  if (cur < b) out.push({ start: cur, end: b });
  return out.filter((r) => r.end - r.start > 1e-6);
}

/** הטווחים שנשארים בסרטון בעקבות הפקודה (זמני מקור), בתוך תחום [a,b]. */
export function toKeepRanges(command, a = 0, b = Infinity) {
  if (!command || !command.ranges) return [{ start: a, end: b }];
  const rs = mergeRanges(command.ranges.map((r) => ({ start: Math.max(a, r.start), end: Math.min(b, r.end) })));
  return command.action === 'keep' ? rs : invertRanges(rs, a, b);
}

/**
 * מחיל פקודה על Plan קיים ומחזיר Plan חדש: {segments, duration, removed}.
 * delete/trim מוציאים את הטווחים מכל קטע, keep חותך כל קטע לטווחים. זורק Error בעברית אם לא נשאר כלום.
 */
export function applyToPlan(plan, command, { minSegment = 0.08 } = {}) {
  if (!plan || !Array.isArray(plan.segments)) throw new Error('אין תוכנית עריכה להחיל עליה את הפקודה.');
  if (!command || !Array.isArray(command.ranges)) throw new Error('הפקודה לא מכילה טווחים.');
  const keepR = command.action === 'keep' ? mergeRanges(command.ranges) : null;
  const cutR = command.action === 'keep' ? null : mergeRanges(command.ranges);
  const out = [];
  for (const [s0, s1] of plan.segments) {
    const parts = keepR
      ? keepR.map((r) => [Math.max(s0, r.start), Math.min(s1, r.end)])
      : invertRanges(cutR, s0, s1).map((r) => [r.start, r.end]);
    for (const p of parts) if (p[1] - p[0] >= minSegment) out.push(p);
  }
  if (!out.length) throw new Error('הפקודה הייתה מוחקת את כל הסרטון, ולכן לא בוצעה.');
  const before = plan.segments.reduce((a, [s, e]) => a + (e - s), 0);
  const duration = out.reduce((a, [s, e]) => a + (e - s), 0);
  const round = (x) => Math.round(x * 1000) / 1000;
  return {
    segments: out.map(([s, e]) => [round(s), round(e)]),
    duration: round(duration),
    removed: round((plan.removed || 0) + Math.max(0, before - duration)),
  };
}

// ------------------------------------------------------------------------------------------ פענוח פקודה

function extractQuotes(text) {
  const quotes = [];
  const put = (qq) => { quotes.push(qq); return ` QQ${quotes.length - 1}QQ `; };
  let t = String(text ?? '');
  t = t.replace(/[“„«]([^”“»]+)[”“»]/g, (_, qq) => put(qq));
  t = t.replace(/(^|[\s(])([ומהבכלש]{0,2})["״]([^"״]+?)["״](?=$|[\s.,!?;:)])/g, (_, pre, pf, qq) => `${pre} ${pf.split('').join(' ')} ${put(qq)}`);
  t = t.replace(/(^|[\s(])([ומהבכלש]{0,2})['‘’`]([^'‘’`]+?)['’‘`](?=$|[\s.,!?;:)])/g, (_, pre, pf, qq) => `${pre} ${pf.split('').join(' ')} ${put(qq)}`);
  return { plain: t, quotes };
}

/** "1:30" הופך ל־"90 שניות", כדי שמספרי זמן יטופלו כמו כל כמות. */
function preNumbers(text) {
  return text.replace(/(\d{1,2}):(\d{2})(?::(\d{2}))?/g, (_, a, b, c) => {
    const secs = c !== undefined ? (+a) * 3600 + (+b) * 60 + (+c) : (+a) * 60 + (+b);
    return ` ${secs} שניות `;
  });
}

const isQ = (tok) => /^qq\d+qq$/.test(tok);
const qIndex = (tok) => +tok.slice(2, -2);
const isNum = (tok) => /^\d+(\.\d+)?$/.test(tok) || Object.hasOwn(NUM_WORDS, tok);
const numVal = (tok) => (/^\d/.test(tok) ? parseFloat(tok) : NUM_WORDS[tok]);
const vav = (t) => (t.length > 2 && t[0] === 'ו' ? t.slice(1) : t);
const has = (set, t) => set.has(t) || set.has(vav(t));

function detectLang(text) {
  const he = (String(text).match(/[א-ת]/g) || []).length;
  const en = (String(text).match(/[a-zA-Z]/g) || []).length;
  return he >= en ? 'he' : 'en';
}

/** 0:06 או 0:06.5 */
export function fmtTime(t) {
  const x = Math.max(0, Number(t) || 0);
  const tenths = Math.round(x * 10);
  const m = Math.floor(tenths / 600);
  const rest = tenths - m * 600;
  const s = Math.floor(rest / 10);
  const f = rest % 10;
  return `${m}:${String(s).padStart(2, '0')}${f ? `.${f}` : ''}`;
}
const fmtR = (r) => `${fmtTime(r.start)}–${fmtTime(r.end)}`;
const dur = (ranges) => ranges.reduce((a, r) => a + (r.end - r.start), 0);
const secText = (x) => {
  const v = Math.round(x * 10) / 10;
  if (Math.abs(v - 1) < 1e-9) return 'שנייה אחת';
  return `${Number.isInteger(v) ? v : v.toFixed(1)} שניות`;
};
const secHa = (x) => (Math.abs(x - 1) < 1e-9 ? 'השנייה' : `${Number.isInteger(x) ? x : x.toFixed(1)} השניות`);
const qt = (s) => `«${s}»`;
const HEAD_TAIL_SLACK = 0.35;     // שניות: קטע שמתחיל כמעט בהתחלה או נגמר כמעט בסוף נחשב חיתוך מהקצה

/** שלב 1: ניתוח מבני: אסימונים, פועל ופסקאות (clauses) לפי מילות סימון כמו "מ", "עד", "אחרי", "על". */
function analyze(rawText, splitM, idx) {
  const { plain, quotes } = extractQuotes(rawText);
  const prepared = preNumbers(plain).replace(/(^|\s)([ומהבכלש]{1,3})[-־–](?=\S)/g, '$1$2');
  const tokens = tokenize(prepared);
  const disp = new Map();                                  // אסימון מנורמל -> איך נכתב בפועל (להצגה)
  tokenize(prepared, { raw: true }).forEach((r, i) => { if (!disp.has(tokens[i])) disp.set(tokens[i], r); });
  const kinds = { del: false, keep: false, start: false, end: false };
  for (const t of tokens) {
    if (has(V_DEL, t)) kinds.del = true;
    if (has(V_KEEP, t)) kinds.keep = true;
    if (has(V_START, t)) kinds.start = true;
    if (has(V_END, t)) kinds.end = true;
  }
  const hasOnly = tokens.includes('רק') || tokens.includes('only');
  const nounStartEnd = kinds.del || kinds.keep;          // "trim the start": start הוא שם עצם כשיש פועל מחיקה או שמירה
  let verb = null;
  if (kinds.keep) verb = 'keep';
  else if (kinds.del) verb = 'del';
  else if (kinds.start && !nounStartEnd) verb = 'start';
  else if (kinds.end && !nounStartEnd) verb = 'end';
  else if (hasOnly) verb = 'keep';
  if (verb === 'del' && tokens.some((t) => W_EXCEPT.has(t))) verb = 'keep';   // "הכול חוץ מ־X" = להשאיר רק את X
  const isVerb = (t) => has(V_DEL, t) || has(V_KEEP, t) || ((verb === 'start' || verb === 'end') && (has(V_START, t) || has(V_END, t)));

  const clauses = [];
  const lead = [];
  let cur = null;
  let usedSplitM = false;
  const open = (kind, words = []) => { cur = { kind, words }; clauses.push(cur); };
  const inTranscript = (tk) => idx.stems.some((ss) => ss.includes(tk));        // "מסעדה" היא מילה בפני עצמה, לא "מ" + "סעדה"
  const leadIsEmpty = () => lead.every((t) => NOISE.has(t) || N_PART.has(t) || N_VIDEO.has(t));
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (isVerb(tk) || tk === 'החל') continue;
    let kind = null;
    if (has(M_FROM, tk)) kind = 'FROM';
    else if (has(M_TO, tk)) kind = 'TO';
    else if (tk === 'to' && !(cur && cur.kind === 'BTW' && cur.words.length) && (clauses.some((c) => c.kind === 'FROM') || tokens[i - 1] === 'up')) kind = 'TO';
    else if (has(M_AFTER, tk)) kind = 'AFTER';
    else if (has(M_BEFORE, tk)) kind = 'BEFORE';
    else if (has(M_ONWARD, tk)) kind = 'ONWARD';
    else if (has(M_BETWEEN, tk)) kind = 'BTW';
    else if (cur && cur.kind === 'BTW' && cur.words.length && M_BETWEEN_AND.has(tk)) kind = 'BTW2';
    else if (tk === 'ב' && verb === 'end') kind = 'AT';
    else if (has(M_ABOUT, tk)) kind = 'ABOUT';
    else if (tk === 'at' && (verb === 'start' || verb === 'end')) kind = verb === 'start' ? 'FROM' : 'AT';
    else if ((tk === 'with' || tk === 'on') && verb === 'end') kind = 'AT';
    if (kind) {
      if (kind === 'ABOUT' && cur && cur.kind === 'ABOUT') continue;
      open(kind);
      continue;
    }
    // קידומת צמודה: "מבסוף" (מ־בסוף), ובפועל סיום: "תסיים בתודה"
    if (splitM && !cur && verb && verb !== 'end' && /^מ.{2,}$/.test(tk) && !FROM_BLOCK.has(tk) && !isQ(tk) && leadIsEmpty() && !inTranscript(tk)) {
      disp.set(tk.slice(1), (disp.get(tk) ?? tk).slice(1));
      open('FROM', [tk.slice(1)]);
      usedSplitM = true;
      continue;
    }
    if (splitM && cur && cur.kind === 'BTW' && cur.words.length && /^[לו].{2,}$/.test(tk) && !isQ(tk) && !inTranscript(tk)) {   // "בין פיצה לאני חושב"
      disp.set(tk.slice(1), (disp.get(tk) ?? tk).slice(1));
      open('BTW2', [tk.slice(1)]);
      usedSplitM = true;
      continue;
    }
    if (verb === 'end' && !cur && /^ב.{2,}$/.test(tk) && leadIsEmpty()) { disp.set(tk.slice(1), (disp.get(tk) ?? tk).slice(1)); open('AT', [tk.slice(1)]); continue; }
    if (cur) cur.words.push(tk); else lead.push(tk);
  }
  if ((verb === 'start' || verb === 'end') && !clauses.length) {          // "תסיים תודה": העוגן הוא מה שנאמר אחרי הפועל
    const words = lead.filter((t) => !NOISE.has(t) && !N_VIDEO.has(t));
    if (words.length) { clauses.push({ kind: verb === 'start' ? 'FROM' : 'AT', words }); lead.length = 0; }
  }
  return { tokens, quotes, verb, isVerb, clauses, lead, usedSplitM, disp };
}

/**
 * מפענח פקודה (עברית או אנגלית) מול תמלול.
 * מחזיר null כשלא הובנה פקודה כלל. כשהפקודה הובנה אבל לא נמצא מה לחתוך: found:false, ranges:[] והסבר בעברית.
 * שדות נוספים: side ('start'|'end' ב־trim), kind, confidence, matches, ambiguous, excerpt, lang, query.
 * opts.duration = אורך הסרטון (ברירת מחדל: סוף התמלול), משמש ל"עד הסוף".
 */
export function parseCommand(text, transcript, opts = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const idx = buildIndex(transcript);
  const lang = detectLang(raw);
  const T = Number.isFinite(opts.duration) ? opts.duration : idx.duration;
  const fr = analyze(raw, true, idx);
  let res = fr.verb ? resolve(fr, idx, transcript, T, lang) : null;
  if (res && res.found === false && fr.usedSplitM) {          // אולי "מ" היא חלק מהמילה ("מסעדה") ולא "מתוך"
    const fr2 = analyze(raw, false, idx);
    const res2 = fr2.verb ? resolve(fr2, idx, transcript, T, lang) : null;
    if (res2 && res2.found !== false) res = res2;
  }
  return res;
}

function resolve(fr, idx, transcript, T, lang) {
  const { tokens, quotes, verb, isVerb, clauses, lead, disp } = fr;
  const show = (t) => disp.get(t) ?? t;
  const nonVerb = tokens.filter((t) => !isVerb(t));
  const base = { lang, found: true };
  const actionOf = () => (verb === 'keep' ? 'keep' : verb === 'del' ? 'delete' : 'trim');
  const fail = (msg, extra = {}) => ({ ...base, action: actionOf(), ranges: [], found: false, kind: 'unknown', confidence: 0, explanationHe: msg, ...extra });

  // ---- מילות מילוי ושתיקות ----
  const namedExtra = nonVerb.filter((t) => FILLER_EXTRA.has(t));
  const fillerNoun = nonVerb.some((t) => FILLER_WORDS.has(t));
  const fillerWord = nonVerb.some((t) => isCoreFiller(t));
  const noFiller = /\bno\s+(ums?|uhs?|fillers?)\b/i.test(tokens.join(' '));
  if ((verb === 'del' || verb === 'keep') && (fillerWord || fillerNoun || noFiller || namedExtra.length)) {
    if (namedExtra.length && !fillerWord && !fillerNoun) {
      const rs = findFillers(transcript, { only: namedExtra });
      if (!rs.length) return fail(`לא מצאנו את ${namedExtra.map(qt).join(', ')} בתמלול.`, { kind: 'fillers', query: namedExtra.join(' ') });
      return { ...base, action: 'delete', ranges: rs.map(({ start, end }) => ({ start, end })), kind: 'fillers', confidence: 0.9, matches: rs.length,
        explanationHe: `נמחק ${rs.length === 1 ? 'מופע אחד' : `${rs.length} מופעים`} של ${namedExtra.map(qt).join(', ')} (${secText(dur(rs))}).` };
    }
    const wide = nonVerb.some((t) => t === 'מיותרות' || t === 'unnecessary' || t === 'useless');
    const rs = findFillers(transcript, { extra: wide });
    if (!rs.length) return fail('לא מצאנו בתמלול מילות מילוי כמו «אממ» או «אה».', { kind: 'fillers' });
    const sample = [...new Set(rs.flatMap((r) => r.words.map((w) => String(w).replace(/[.,!?…]+$/g, ''))))].slice(0, 3);
    return { ...base, action: 'delete', ranges: rs.map(({ start, end }) => ({ start, end })), kind: 'fillers', confidence: 0.9, matches: rs.length,
      explanationHe: `נמחק ${rs.length === 1 ? 'מילת מילוי אחת' : `${rs.length} מילות מילוי`} (${sample.join(', ')}), בסך ${secText(dur(rs))}.` };
  }
  if (verb === 'del' && nonVerb.some((t) => SILENCE_WORDS.has(t))) {
    const rs = findSilences(transcript);
    if (!rs.length) return fail('לא מצאנו בתמלול שתיקות ארוכות.', { kind: 'silence' });
    return { ...base, action: 'delete', ranges: rs, kind: 'silence', confidence: 0.8, matches: rs.length,
      explanationHe: `נקצר ${rs.length === 1 ? 'שתיקה ארוכה אחת' : `${rs.length} שתיקות ארוכות`}, בסך ${secText(dur(rs))}.` };
  }

  // ---- תוצאה לאזור [start,end] ----
  const clampR = (r) => ({ start: Math.max(0, Math.min(T, r.start)), end: Math.max(0, Math.min(T, r.end)) });
  const regionResult = (region, o = {}) => {
    const rg = clampR(region);
    if (rg.end - rg.start < 0.05) return fail('הטווח שביקשתם ריק.', { kind: o.kind || 'unknown' });
    const headCut = rg.start <= HEAD_TAIL_SLACK && rg.end < T - HEAD_TAIL_SLACK;       // המילה הראשונה בדרך כלל לא מתחילה בדיוק ב־0
    const tailCut = rg.end >= T - HEAD_TAIL_SLACK && rg.start > HEAD_TAIL_SLACK;
    let action, side;
    if (verb === 'keep') action = 'keep';
    else if (verb === 'start') { action = 'trim'; side = 'start'; }
    else if (verb === 'end') { action = 'trim'; side = 'end'; }
    else if (headCut) { action = 'trim'; side = 'start'; }
    else if (tailCut) { action = 'trim'; side = 'end'; }
    else action = 'delete';
    const r = fmtR(rg);
    let msg;
    if (o.message) msg = o.message(action, side, r);
    else if (action === 'keep') msg = `נשאיר רק את הקטע ${o.span || ''} (${r}) ונמחק את השאר.`.replace(/\s+\(/, ' (');
    else if (action === 'trim' && side === 'start') msg = `נוריד את ההתחלה${o.head ? ` ${o.head}` : ''} (${r}).`;
    else if (action === 'trim') msg = `נוריד את הסוף${o.tail ? ` ${o.tail}` : ''} (${r}).`;
    else msg = `נמחק את הקטע ${o.span || ''} (${r}).`.replace(/\s+\(/, ' (');
    return { ...base, action, ranges: [rg], ...(side ? { side } : {}), kind: o.kind || 'range', confidence: o.confidence ?? 1, matches: o.matches ?? 1,
      ambiguous: !!o.ambiguous, ...(o.excerpt ? { excerpt: o.excerpt } : {}), ...(o.query ? { query: o.query } : {}), explanationHe: msg };
  };

  // ---- כמות: "5 השניות הראשונות", "3 שניות מהסוף" ----
  const quantities = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!isNum(tokens[i])) continue;
    const nx = tokens[i + 1] ?? '', pv = tokens[i - 1] ?? '';
    if (U_MIN.has(nx) || U_MIN.has(pv)) quantities.push(numVal(tokens[i]) * 60);
    else if (U_SEC.has(nx) || U_SEC.has(pv)) quantities.push(numVal(tokens[i]));
  }
  const hasHead = nonVerb.some((t) => W_HEAD.has(t));
  const hasTail = nonVerb.some((t) => W_TAIL.has(t));
  const hasBound = tokens.some((t) => has(M_TO, t) || has(M_AFTER, t) || has(M_BEFORE, t));
  if (quantities.length === 1 && hasHead !== hasTail && !hasBound) {
    const v = quantities[0];
    const region = hasHead ? { start: 0, end: v } : { start: T - v, end: T };
    const label = hasHead ? `${secHa(v)} ${v === 1 ? 'הראשונה' : 'הראשונות'}` : `${secHa(v)} ${v === 1 ? 'האחרונה' : 'האחרונות'}`;
    return regionResult(region, { kind: 'time',
      message: (action, side, r) => (action === 'keep' ? `נשאיר רק את ${label} (${r}) ונמחק את השאר.` : `${action === 'trim' || action === 'delete' ? 'נוריד' : 'נמחק'} את ${label} (${r}).`) });
  }

  // ---- סדר: "המשפט הראשון", "הקטע האחרון" ----
  if (!quantities.length) {
    const ord = nonVerb.map((t) => ORDINALS[t]).find((v) => v !== undefined);
    const nounS = nonVerb.some((t) => N_SENTENCE.has(t));
    const nounG = nonVerb.some((t) => N_SEGMENT.has(t));
    if (ord !== undefined && (nounS || nounG) && !clauses.some((c) => c.kind === 'FROM' || c.kind === 'TO' || c.kind === 'AFTER' || c.kind === 'BEFORE')) {
      const list = nounS ? idx.sentences : idx.segs;
      if (list.length) {
        const item = ord === -1 ? list[list.length - 1] : list[ord - 1];
        if (!item) return fail(`אין בתמלול ${nounS ? 'כל כך הרבה משפטים' : 'כל כך הרבה קטעים'}.`, { kind: 'ordinal' });
        const nm = `${nounS ? 'המשפט' : 'הקטע'} ${ord === -1 ? 'האחרון' : ord === 1 ? 'הראשון' : ord === 2 ? 'השני' : 'השלישי'}`;
        return regionResult({ start: item.start, end: item.end }, { kind: 'ordinal', confidence: 0.8, excerpt: item.text,
          message: (action, side, r) => (action === 'keep' ? `נשאיר רק את ${nm} (${r}) ונמחק את השאר.` : `נמחק את ${nm} (${r}).`) });
      }
    }
  }

  // ---- עוגנים: מ / עד / אחרי / לפני / ב ----
  const kindOf = (k) => clauses.find((c) => c.kind === k);
  const cF = kindOf('FROM'), cT = kindOf('TO'), cA = kindOf('AFTER'), cB = kindOf('BEFORE'), cAt = kindOf('AT'), cBt = kindOf('BTW'), cBt2 = kindOf('BTW2');
  if (cF || cT || cA || cB || cAt || cBt) {
    const edge = (ws) => {
      const w = ws.filter((t) => !(N_VIDEO.has(t) && ws.length > 1));
      while (w.length && (EDGE_NOISE.has(w[0]) || ((N_PART.has(w[0]) || N_WORD.has(w[0])) && w.length > 1))) w.shift();
      while (w.length && EDGE_NOISE.has(w[w.length - 1])) w.pop();
      return w;
    };
    const phrasePoint = (toks, label) => {
      const ts = toks.filter(Boolean);
      if (!ts.length) return { kind: 'missing', label };
      const hits = searchPhrase(transcript, ts);
      if (!hits.length) return { kind: 'notfound', label };
      return { kind: 'phrase', start: hits[0].start, end: hits[0].end, score: hits[0].score, matches: hits.length, label: qt(label) };
    };
    const point = (c) => {
      if (!c) return null;
      const quoted = c.words.find(isQ);
      if (quoted) { const s = quotes[qIndex(quoted)]; return phrasePoint(tokenize(s), s.trim()); }
      const ws = edge(c.words);
      const unit = c.words.some((t) => U_MIN.has(t)) ? 60 : 1;
      const num = ws.find(isNum);
      if (num !== undefined) { const t = numVal(num) * unit; return { kind: 'time', start: t, end: t, t, score: 1, matches: 1, label: fmtTime(t) }; }
      const nouns = ws.filter((t) => !NOISE.has(t));
      if (nouns.length === 1 && N_START.has(nouns[0])) return { kind: 'start', start: 0, end: 0, score: 1, matches: 1, label: 'ההתחלה' };
      if (nouns.length === 1 && N_END.has(nouns[0])) return { kind: 'end', start: T, end: T, score: 1, matches: 1, label: 'הסוף' };
      return phrasePoint(ws, ws.map(show).join(' '));
    };
    const P = { F: point(cF), T: point(cT), A: point(cA), B: point(cB), At: point(cAt), Bt: point(cBt), Bt2: point(cBt2) };
    const present = Object.values(P).filter(Boolean);
    const bad = present.find((p) => p.kind === 'notfound');
    if (bad) return fail(`לא מצאנו את ${bad.label.startsWith('«') ? bad.label : qt(bad.label)} בתמלול. אמרו מילים שנאמרו בסרטון, או הקלידו אותן בדיוק.`, { kind: 'phrase', query: bad.label.replace(/[«»]/g, '') });
    if (present.some((p) => p.kind === 'missing')) return fail('לא הבנו איפה לחתוך. למשל: «תוריד את ההתחלה עד אני חושב».');
    const kind = present.some((p) => p.kind === 'time') ? 'time' : 'range';
    const conf = Math.min(...present.map((p) => p.score ?? 1));
    const matches = Math.max(...present.map((p) => p.matches ?? 1));
    const o = { kind, confidence: conf, matches, ambiguous: matches > 1 };
    const fromTxt = (p) => (p.kind === 'start' ? 'מההתחלה' : `מ־${p.label}`);
    const toTxt = (p, incl) => (p.kind === 'end' ? 'עד הסוף' : `עד ${p.label}${incl ? ' כולל' : ''}`);

    if (verb === 'start') {                                  // "תתחיל מ־X": מורידים את ההתחלה
      const p = P.F || P.At || P.A || P.T || P.B;
      const useEnd = p === P.A;
      return regionResult({ start: 0, end: useEnd ? p.end : p.start }, { ...o, head: `${useEnd ? 'עד אחרי' : 'עד'} ${p.label}` });
    }
    if (verb === 'end') {                                    // "תסיים ב־X": מורידים את הסוף
      const p = P.At || P.T || P.A || P.F || P.B;
      const useStart = p === P.F || p === P.B;
      return regionResult({ start: useStart ? p.start : p.end, end: T }, { ...o, tail: `${useStart ? 'החל מ־' : 'אחרי '}${p.label}` });
    }
    let region, span, head, tail;
    if (P.Bt && P.Bt2) {
      region = { start: P.Bt.end, end: P.Bt2.start };
      span = `בין ${P.Bt.label} ל־${P.Bt2.label}`; head = `עד ${P.Bt2.label}`; tail = `אחרי ${P.Bt.label}`;
    } else if (P.Bt) {
      return fail('לא הבנו עד איפה. למשל: «תמחק בין "פיצה" ל"אני חושב"».');
    } else if (P.F && P.T) {
      region = { start: P.F.start, end: P.T.kind === 'end' ? T : P.T.kind === 'time' ? P.T.t : P.T.end };
      span = `${fromTxt(P.F)} ${toTxt(P.T, P.T.kind === 'phrase')}`; head = toTxt(P.T, false); tail = `החל מ־${P.F.label}`;
    } else if (P.F || P.At) {
      const p = P.F || P.At;
      region = { start: p.start, end: T };
      span = `${fromTxt(p)} ועד הסוף`; tail = `החל מ־${p.label}`; head = `עד ${p.label}`;
    } else if (P.A && P.B) {
      region = { start: P.A.end, end: P.B.start };
      span = `בין ${P.A.label} ל־${P.B.label}`; head = `עד ${P.B.label}`; tail = `אחרי ${P.A.label}`;
    } else if (P.T) {
      const p = P.T;
      region = { start: 0, end: verb === 'keep' ? p.end : (p.kind === 'end' ? T : p.kind === 'time' ? p.t : p.start) };
      span = `מההתחלה ${toTxt(p, verb === 'keep' && p.kind === 'phrase')}`; head = `עד ${p.label}`; tail = `אחרי ${p.label}`;
    } else if (P.A) {
      region = { start: P.A.end, end: T };
      span = `אחרי ${P.A.label}`; tail = `אחרי ${P.A.label}`; head = `עד ${P.A.label}`;
    } else {
      region = { start: 0, end: P.B.start };
      span = `לפני ${P.B.label}`; head = `עד ${P.B.label}`; tail = `החל מ־${P.B.label}`;
    }
    return regionResult(region, { ...o, span, head, tail });
  }

  // ---- נושא או ביטוי ----
  const about = kindOf('ABOUT');
  const leadTopic = lead.filter((t) => !isVerb(t));
  const topicTokens = about ? about.words : leadTopic;
  const quotedTok = topicTokens.find(isQ) || leadTopic.find(isQ);
  const partMode = !!about || leadTopic.some((t) => N_PART.has(t));
  const wordMode = nonVerb.some((t) => N_WORD.has(t));
  const everyMode = tokens.some((t) => t === 'כל' || t === 'all' || t === 'every') && wordMode;
  let terms, label;
  if (quotedTok) { const s = quotes[qIndex(quotedTok)]; terms = tokenize(s); label = s.trim(); }
  else {
    terms = topicTokens.filter((t) => !isQ(t) && !NOISE.has(t) && !N_PART.has(t) && !N_VIDEO.has(t) && !N_WORD.has(t) && !M_ABOUT.has(t) && !isVerb(t));
    label = terms.map(show).join(' ');
  }
  if (!terms.length) return null;
  if (!quotedTok && terms.length === 1 && (N_START.has(terms[0]) || N_END.has(terms[0]))) {
    return fail('לא הבנו איפה לחתוך. אמרו עד איזו מילה, למשל «תוריד את ההתחלה עד אני חושב», או כמה שניות.');
  }
  if ((quotedTok && !partMode) || wordMode) {
    const hits = searchPhrase(transcript, terms);
    if (!hits.length) return fail(`לא מצאנו את ${qt(label)} בתמלול. אמרו מילים שנאמרו בסרטון, או הקלידו אותן בדיוק.`, { kind: 'phrase', query: label });
    const chosen = everyMode || (wordMode && !quotedTok) ? hits.slice().sort((a, b) => a.start - b.start) : [hits[0]];
    const rs = mergeRanges(chosen.map((h) => ({ start: h.start, end: h.end })), 0.05);
    const action = verb === 'keep' ? 'keep' : 'delete';
    return { ...base, action, ranges: rs, kind: 'phrase', confidence: chosen[0].score, matches: hits.length, ambiguous: !everyMode && hits.length > 1, query: label,
      explanationHe: action === 'keep' ? `נשאיר רק את ${qt(label)} (${fmtR(rs[0])}) ונמחק את השאר.`
        : `נמחק ${rs.length === 1 ? 'את' : `${rs.length} מופעים של`} ${qt(label)} (${rs.map(fmtR).join(', ')}).` };
  }
  const found = searchTopic(transcript, terms);
  if (!found.length) return fail(`לא מצאנו בתמלול חלק שעוסק ב־${qt(label)}. נסו מילה שנאמרה בסרטון.`, { kind: 'topic', query: label });
  const best = found[0], second = found[1];
  const ambiguous = !!second && second.w >= 0.75 * best.w;
  const rg = { start: best.start, end: best.end };
  const action = verb === 'keep' ? 'keep' : 'delete';
  return { ...base, action, ranges: [rg], kind: 'topic', confidence: Math.min(1, best.w / Math.max(1, terms.length)), matches: found.length, ambiguous,
    excerpt: best.excerpt, query: label,
    explanationHe: `${action === 'keep' ? 'נשאיר רק' : 'נמחק'} את החלק על ${qt(label)} (${fmtR(rg)})${action === 'keep' ? ' ונמחק את השאר' : ''}.${ambiguous ? ' יש עוד מקום דומה בסרטון, בדקו שזה הקטע הנכון.' : ''}` };
}

/** דוגמאות לפקודות (לממשק): הנחיה למשתמש. */
export const EXAMPLES_HE = [
  'תמחק את החלק על הבורגר',
  'תוריד את ההתחלה עד «אני חושב»',
  'תשאיר רק מ«בסוף» ועד הסוף',
  'בלי האממ',
  'תוריד שתיקות',
  'תחתוך את 5 השניות הראשונות',
];

// ------------------------------------------------------------------------------------------ האזנה (Web Speech API)

/** האם הדפדפן תומך בזיהוי דיבור. באייפון: יש webkitSpeechRecognition ב־Safari, אבל לא תמיד ב־PWA מותקן ולא ללא חיבור. */
export function isSpeechSupported() {
  return !!(globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition);
}

function normLang(lang) {
  const l = String(lang || 'he').toLowerCase();
  if (l === 'he' || l === 'iw' || l === 'he-il') return 'he-IL';
  if (l === 'en') return 'en-US';
  return lang;
}

/**
 * מאזין לפקודה אחת ומחזיר את הטקסט. מחזיר null כשאין Web Speech בדפדפן, ומחרוזת ריקה כשלא נשמע דיבור.
 * זורק Error בעברית (אין הרשאה, אין מיקרופון, אין רשת) או AbortError כשבוטל דרך signal.
 * opts: {lang:'he'|'en'|'he-IL'..., signal, onInterim(text), timeoutMs (ברירת מחדל 10000), SpeechRecognition (להזרקה בבדיקות)}
 */
export function listen(opts = {}) {
  const { lang = 'he', signal, onInterim, timeoutMs = 10000 } = opts;
  const SR = 'SpeechRecognition' in opts ? opts.SpeechRecognition : (globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition);   // null מפורש = בלי תמיכה (לבדיקות)
  if (!SR) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let rec;
    try { rec = new SR(); } catch { reject(new Error('לא ניתן להפעיל זיהוי דיבור בדפדפן הזה.')); return; }
    rec.lang = normLang(lang);
    rec.continuous = false;
    rec.interimResults = typeof onInterim === 'function';
    rec.maxAlternatives = 1;
    let done = false, finalText = '', timer = null;
    const end = (fn, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      try { rec.abort?.(); } catch { /* כבר נעצר */ }
      fn(val);
    };
    const onAbort = () => { const e = new Error('ההאזנה בוטלה.'); e.name = 'AbortError'; end(reject, e); };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    rec.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex ?? 0; i < ev.results.length; i++) {
        const r = ev.results[i];
        const txt = r[0]?.transcript ?? '';
        if (r.isFinal) finalText += txt; else interim += txt;
      }
      if (interim && onInterim) { try { onInterim(interim.trim()); } catch { /* מאזין חיצוני */ } }
      if (finalText) end(resolve, finalText.trim());
    };
    rec.onerror = (ev) => {
      const code = ev?.error;
      if (code === 'no-speech') end(resolve, '');
      else if (code === 'aborted') end(resolve, finalText.trim());
      else if (code === 'not-allowed' || code === 'service-not-allowed') end(reject, new Error('אין הרשאה למיקרופון או לזיהוי דיבור. אשרו בהגדרות הדפדפן או הקלידו את הפקודה.'));
      else if (code === 'audio-capture') end(reject, new Error('לא נמצא מיקרופון במכשיר.'));
      else if (code === 'network') end(reject, new Error('זיהוי הדיבור דורש חיבור לאינטרנט. הקלידו את הפקודה במקום.'));
      else if (code === 'language-not-supported') end(reject, new Error('זיהוי הדיבור בעברית לא נתמך בדפדפן הזה. הקלידו את הפקודה.'));
      else end(reject, new Error('זיהוי הדיבור נכשל. נסו שוב או הקלידו את הפקודה.'));
    };
    rec.onend = () => end(resolve, finalText.trim());
    timer = setTimeout(() => end(resolve, finalText.trim()), timeoutMs);
    try { rec.start(); } catch { end(reject, new Error('לא ניתן להתחיל האזנה. ייתכן שהמיקרופון בשימוש.')); }
  });
}
