// בחירת רגעים חכמה בטלפון, בלי מודל שפה.
// נגזר מ־ranking.py במק: יחידות משפט, חלונות מועמדים בגבולות משפט, ציון מלקסיקון, צפיפות, אנרגיית קול ופנים,
// גיוון לאורך הסרטון, וכותרות (hooks) שהן קטעים מילוליים מהתמלול בלבד.
// כל הזמנים בשניות (זמני מקור). הקובץ טהור: אין בו DOM ואין רשת, והוא עובד ב־node וב־Worker.

// ---------------------------------------------------------------------------------------------- קבועים

export const GENRE_CLIP = {
  auto: [18, 55, 0.4], podcast: [25, 60, 0.25], food: [18, 45, 0.45], prank: [12, 40, 0.7], fitness: [20, 50, 0.4],
  tips: [25, 60, 0.2], motivation: [20, 55, 0.3], comedy: [15, 45, 0.6], review: [20, 50, 0.3], vlog: [18, 45, 0.5],
  sports: [12, 40, 0.65],
};
const MIN_FLOOR = 2.0;        // רגע שהציון שלו נמוך מזה לא מוחזר (שקט, מילוי)
const DIVERSITY_PENALTY = 0.5;
const DIVERSITY_SCALE = 75;
const COVERAGE_BONUS = 0.7;
const LONG_SECONDS = 1800;
const PAD_BEFORE = 0.2;
const PAD_AFTER = 0.25;
const MAX_HOOK_WORDS = 7;

// ---------------------------------------------------------------------------------------------- מילונים

const set = (text) => new Set(text.split(/\s+/).filter(Boolean));

const EN_EMOTION = set(`crazy insane unbelievable incredible amazing wow omg god love hate scared afraid terrified cry cried crying shocked
shocking angry furious sick wild nuts mad huge disgusting beautiful dream dreams miracle pain painful heartbreaking proud blessed hell damn
obsessed scary epic legend legendary hilarious funny laughing laughed dead dying awesome fantastic ridiculous terrifying brutal perfect`);
const HE_EMOTION = set(`וואו מטורף מטורפת אלוהים מדהים מדהימה מדהימים מפחיד אוהב אוהבת שונא בוכה בכיתי צחקתי התרגשתי כאב פחד שוק נורא זוועה
מושלם אש כואב גאה מרגש מצחיק מצחיקה מזעזע חלום נס אדיר מגניב פצצה הלם אמאלה אוי איזה בלגן מעולה גדול`);
const EN_BOLD = set(`best worst biggest greatest never always everyone nobody only secret mistake mistakes truth lie lied wrong
hardest fastest craziest ultimate impossible stop must forbidden banned warning`);
const HE_BOLD = set(`הכי ביותר תמיד מעולם לעולם אסור חובה סוד סודות טעות טעויות אמת שקר אזהרה בחיים`);
const EN_OPEN = set(`secret mistake mistakes nobody everyone never stop truth lie wrong why how warning`);
const HE_OPEN = set(`סוד סודות טעות טעויות איש אף כולם לעולם מעולם עצור האמת שקר למה איך אזהרה`);
const EN_QUESTION = set(`who what when where why how is are do does did can could would should will have has isn't aren't don't`);
const HE_QUESTION = set(`מי מה מתי איפה לאן מאיפה למה מדוע איך כמה האם איזה איזו אילו`);
const EN_NUMBER = set(`one two three four five six seven eight nine ten eleven twelve twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion`);
const HE_NUMBER = set(`אחד אחת שניים שתיים שני שתי שלוש שלושה ארבע ארבעה חמש חמישה שש שישה שבע שבעה שמונה תשע תשעה עשר עשרה עשרים שלושים ארבעים חמישים שישים מאה מאות אלף אלפים מיליון`);
const SECOND_PERSON = set(`you your you're you'll you've yours yourself אתה את אתם אתן שלך שלכם לך לכם`);
const FILLER_WORDS = set(`yeah yes yep yup no nope okay ok right um uh umm uhh mm mmm hmm hm huh well so and but like oh ah wow cool sure alright true exactly
thanks thank you mhm yea ha haha lol man bro dude כן לא אוקיי טוב נכון אה אממ וואו יופי בסדר ברור אז רגע`);
const REACTION_ONLY = set(`sick awesome nice cool great amazing crazy insane wild dope sweet fair perfect beautiful incredible impressive huge love thanks thank
appreciate welcome sorry damn jeez whoa really seriously honestly`);
const CONTINUATION = set(`and or because cause cuz which that then also plus nor yet`);
const HE_CONTINUATION = set(`ו כי אבל אז וגם שזה ולכן כאילו`);
const SPOKEN_FILLERS = [/(^|\s)(?:um+|uh+|umm+|uhh+|er+m*)(?=\s|$)/g, /(?:^|\s)(?:like|basically|you know|i mean|kind of|sort of)(?=\s|$)/g,
  /(?:^|\s)(?:כאילו|יעני|נו|בעצם|אתה יודע|אתם יודעים)(?=\s|$)/g];
const STORY = ['so then', 'and then', 'all of a sudden', "couldn't believe", 'could not believe', 'turns out', 'the next thing', 'one day',
  'i remember', 'long story short', "here's the thing", 'the truth is', 'out of nowhere', "didn't expect", 'what happened', 'let me tell you',
  'you know what', 'ואז', 'פתאום', 'לא האמנתי', 'התברר', 'האמת היא', 'יום אחד', 'זכור לי', 'בקיצור', 'תקשיבו', 'תקשיב', 'מה שקרה', 'לא האמנו'];
const CONCLUSION = ["that's why", "that's it", "that's the", 'in the end', 'the point is', 'bottom line', 'the lesson', 'remember', 'trust me', 'worth it',
  'i did it', 'finally', 'and that is', "and that's", 'never again', 'period', 'so yeah', 'ככה', 'בסוף', 'בסופו של דבר', 'בקיצור', 'זה מה ש', 'בגלל זה',
  'זהו', 'וזהו', 'הלקח', 'תזכרו', 'תאמינו לי', 'שווה את זה', 'סוף סוף', 'והנה'];
const PROMO = ['subscribe', 'giveaway', 'gift card', 'sponsor', 'link in', 'description below', 'comment below', 'promo code', 'discount code', 'use code',
  'like this video', 'hit the bell', 'thanks for watching', 'הירשמו', 'תירשמו', 'קוד קופון', 'קוד הנחה', 'בתיאור', 'הגרלה', 'לייק ותגובה'];
const GENRE_WORDS = {
  tips: ['first', 'second', 'third', 'step', 'tip', 'rule', 'טיפ', 'שלב', 'ראשית', 'שנית', 'כלל'],
  fitness: ['reps', 'sets', 'squat', 'push', 'pain', 'form', 'חזרות', 'סטים', 'סקוואט', 'כאב', 'טכניקה'],
  food: ['delicious', 'tasty', 'bite', 'crispy', 'juicy', 'sauce', 'ten', 'טעים', 'ביס', 'פריך', 'עסיסי', 'רוטב', 'מושלם'],
  review: ['verdict', 'rating', 'recommend', 'worth', 'חוות', 'דירוג', 'ממליץ', 'שווה'],
  motivation: ['dream', 'believe', 'never give', 'discipline', 'חלום', 'מאמין', 'משמעת', 'אל תוותר', 'תתמידו'],
  comedy: ['funny', 'joke', 'laugh', 'hilarious', 'מצחיק', 'בדיחה', 'צוחק', 'הצחיק'],
  prank: ['scared', 'scream', 'prank', 'reaction', 'נבהל', 'צעק', 'מתיחה', 'תגובה'],
  sports: ['goal', 'score', 'won', 'win', 'game', 'play', 'שער', 'ניצחון', 'משחק', 'ניצחנו'],
};
const TRAIL_STOP = set(`a an the of to for and or but with in on at by your you my that which who when where as is are was were i it has have had can will would be been not so if then than into from about their our his her its this these those there של את על עם אל כי אם ש ה ו כמו מה`);
const WEAK_OPENERS = set(`i we he she they so then well honestly basically actually just really very`);
const ABBREV = set(`mr mrs ms dr prof vs st mt sr inc gen sgt jr`);
const HE_PREFIX = 'והבלמכש';

// ---------------------------------------------------------------------------------------------- כלים כלליים

const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const round = (x, d = 3) => { const k = 10 ** d; return Math.round(x * k) / k; };
const isHebrewChar = (c) => c >= '֐' && c <= '׿';

export function tokens(text) {
  return (String(text).toLowerCase().match(/[\p{L}\p{N}'’]+/gu) || []).map((t) => t.replace(/[’]/g, "'"));
}
const wordCount = (text) => (String(text).match(/[\p{L}\p{N}'’]+/gu) || []).length;
const hebrewShare = (text) => {
  let letters = 0; let he = 0;
  for (const c of String(text)) {
    if (/\p{L}/u.test(c)) { letters++; if (isHebrewChar(c)) he++; }
  }
  return letters ? he / letters : 0;
};
const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** האם המילה בקבוצה, גם כשיש לה אות שימוש (ו, ה, ב, ל, מ, כ, ש) בעברית. */
function inSet(group, token) {
  if (group.has(token)) return true;
  if (token.length > 2 && HE_PREFIX.includes(token[0]) && isHebrewChar(token[0])) {
    if (group.has(token.slice(1))) return true;
    if (token.length > 3 && HE_PREFIX.includes(token[1]) && group.has(token.slice(2))) return true;
  }
  return false;
}
const countIn = (toks, group) => toks.reduce((n, t) => n + (inSet(group, t) ? 1 : 0), 0);
const containsAny = (text, phrases) => { const low = text.toLowerCase(); return phrases.filter((p) => low.includes(p)).length; };

function percentile(sorted, q) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
}

export function detectLanguage(transcript, fallback = 'en') {
  const code = String(transcript?.language || '').toLowerCase().split('-')[0];
  if (code === 'he' || code === 'iw') return 'he';
  if (code && code !== 'auto') return code;
  const sample = (transcript?.words || []).slice(0, 80).map((w) => w?.text ?? '').join(' ').trim()
    || (transcript?.segments || []).slice(0, 8).map((s) => s?.text ?? '').join(' ');
  if (!sample.trim()) return fallback;
  return hebrewShare(sample) > 0.3 ? 'he' : 'en';
}

// ---------------------------------------------------------------------------------------------- אורך היעד

/** (lo, hi, target) לפי האורך שבחר המשתמש; 'auto' לפי הז'אנר. עד 90 שניות ±20%, מעל זה ±15% (כמו pipeline.length_span). */
export function lengthSpan(length = 'auto', genre = 'auto') {
  if (length === 'auto' || length == null) {
    const [lo, hi] = GENRE_CLIP[genre] || GENRE_CLIP.auto;
    const low = Math.max(15.5, lo); const high = Math.min(60, hi);
    return { lo: low, hi: high, target: (low + high) / 2 };
  }
  const t = Number(length);
  if (!Number.isFinite(t) || t < 10 || t > 900) throw new Error('אורך הקליפ חייב להיות בין 10 ל־900 שניות');
  if (t <= 90) return { lo: Math.max(10, 0.8 * t), hi: 1.2 * t, target: t };
  return { lo: 0.85 * t, hi: 1.15 * t, target: t };
}

// ---------------------------------------------------------------------------------------------- יחידות משפט

const ENDS = /[.!?…]["'”’)\]]*$/;
const endsSentence = (text) => ENDS.test(String(text).trim());
const endsDeclarative = (text) => /[.!…]["'”’)\]]*$/.test(String(text).trim());

function wordEndsSentence(text, following) {
  const t = String(text).trim();
  const core = t.replace(/["'”’)\]]+$/, '');
  if (/[?!]$/.test(core)) return true;
  if (!/[.…]$/.test(core)) return false;
  const base = core.replace(/[.…]+$/, '').toLowerCase();
  if (ABBREV.has(base) || /^[a-z]$/.test(base)) return false;
  if (following && /^[a-z]/.test(following)) return false; // "Jr. in the next year": המשפט נמשך
  return true;
}

/** יחידות משפט מתוך מילים עם זמנים: סימני פיסוק, ובתמלול בלי פיסוק (Whisper) לפי השהיות וסיומי מקטעים. */
/** מסיר מהמילה סימוני דובר (>>) ותוויות כמו [music] או (laughs); מחזיר מחרוזת ריקה אם לא נשאר דבר. */
export function cleanWord(text) {
  return String(text ?? '').replace(/\[[^\]]*\]|\([^)]*\)|^>>+|♪+/gu, '').trim();
}

export function sentenceUnits(transcript) {
  let words = (transcript?.words || []).filter((w) => w && w.end > w.start).map((w) => ({ ...w, text: cleanWord(w.text) })).filter((w) => w.text);
  if (!words.length) words = wordsFromSegments(transcript?.segments || []).map((w) => ({ ...w, text: cleanWord(w.text) })).filter((w) => w.text);
  if (!words.length) return [];
  words = words.slice().sort((a, b) => a.start - b.start);
  const sentenceEnds = words.reduce((n, w, i) => n + (wordEndsSentence(w.text, words[i + 1]?.text) ? 1 : 0), 0);
  const sparse = words.length / Math.max(1, sentenceEnds) > 22;
  const gaps = [];
  for (let i = 1; i < words.length; i++) {
    const g = words[i].start - words[i - 1].end;
    if (g >= 0.12) gaps.push(g);
  }
  gaps.sort((a, b) => a - b);
  const pause = sparse ? clamp(percentile(gaps, 0.7) || 0.35, 0.22, 0.6) : 0.9;
  const segmentEnds = new Set((transcript?.segments || []).map((s) => Math.round(s.end * 20)));
  const units = [];
  let cur = [];
  const close = (closes = true) => {
    if (!cur.length) return;
    const text = cur.map((w) => String(w.text).trim()).join(' ').replace(/\s+([,.;:!?…])/g, '$1');
    units.push({ text, start: cur[0].start, end: cur[cur.length - 1].end, closes, n: cur.length });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const gap = cur.length ? w.start - cur[cur.length - 1].end : 0;
    if (cur.length && (gap > pause || cur.length >= 28 || (sparse && gap >= pause * 0.75 && cur.length >= 6))) close(gap > pause || sparse);
    cur.push(w);
    const last = i === words.length - 1;
    const next = words[i + 1];
    if (wordEndsSentence(w.text, next?.text) || last) close();
    else if (sparse && cur.length >= 5 && segmentEnds.has(Math.round(w.end * 20))) close();
  }
  close();
  return units.filter((u) => u.end > u.start && u.text.trim());
}

function wordsFromSegments(segments) {
  const out = [];
  for (const s of segments) {
    if (!s || !(s.end > s.start)) continue;
    const parts = String(s.text || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    const total = parts.reduce((n, p) => n + p.length + 1, 0);
    let at = s.start;
    for (const p of parts) {
      const d = (s.end - s.start) * ((p.length + 1) / total);
      out.push({ text: p, start: at, end: at + d });
      at += d;
    }
  }
  return out;
}

function fillerOnly(text) {
  const t = tokens(text);
  return !t.length || t.every((x) => FILLER_WORDS.has(x));
}

function startOk(units, a) {
  const u = units[a];
  const t = tokens(u.text);
  if (!t.length || fillerOnly(u.text)) return false;
  const question = u.text.trim().endsWith('?');
  if (t.length < 2 && !question) return false;
  if (t.length <= 3 && !question && t.some((x) => REACTION_ONLY.has(x))) return false;
  if (CONTINUATION.has(t[0]) || (isHebrewChar(t[0][0]) && HE_CONTINUATION.has(t[0]))) return false;
  if (/^oh(?: my)?[.!]?$/i.test(u.text.trim())) return false;
  if (a) {
    const prev = units[a - 1];
    const aligned = prev.closes || u.start - prev.end >= 1.0;
    if (!aligned) return false;
    if (!prev.closes && /^\p{Ll}/u.test(u.text)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------- אודיו

/** מודל אודיו: המעטפת (100 ערכים לשנייה) מצטמצמת למסגרות של חצי שנייה, ומחושבים סטטיסטיקות של המקור. */
export function audioModel(audioInfo) {
  const env = audioInfo?.envelope;
  if (!env || !env.length) return null;
  const perSecond = 100;
  const hop = 0.5;
  const step = perSecond * hop;
  const n = Math.ceil(env.length / step);
  const frames = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let power = 0; let c = 0;
    for (let j = i * step; j < Math.min(env.length, (i + 1) * step); j++) { power += 10 ** (Math.max(env[j], -120) / 10); c++; }
    frames[i] = c ? 10 * Math.log10(Math.max(power / c, 1e-12)) : -120;
  }
  const live = Array.from(frames).filter((v) => v > -70);
  const sorted = (live.length ? live : Array.from(frames)).sort((a, b) => a - b);
  const mean = sorted.reduce((s, v) => s + v, 0) / Math.max(1, sorted.length);
  const std = Math.sqrt(sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, sorted.length));
  const stats = { p50: percentile(sorted, 0.5), p85: percentile(sorted, 0.85), p97: percentile(sorted, 0.97), p995: percentile(sorted, 0.995), std };
  return { frames, hop, stats, loud: Array.isArray(audioInfo.loud) ? audioInfo.loud : [] };
}

/** 0..1: צחוק, צעקות ושיאים בטווח, ביחס לשאר הסרטון (כמו audio_excitement ב־ranking.py). */
export function excitement(model, start, end) {
  if (!model) return null;
  const { frames, hop, stats: s } = model;
  const i0 = Math.max(0, Math.floor(start / hop));
  const i1 = Math.min(frames.length, Math.max(i0 + 1, Math.ceil(end / hop)));
  const n = i1 - i0;
  if (n < 4) return null;
  const seg = Array.from(frames.subarray(i0, i1));
  const spread = Math.max(s.p97 - s.p50, 0.5 * (s.p995 - s.p50), 1); // צעקות וצחוק נדירים עדיין נספרים כשיא
  const top = seg.slice().sort((a, b) => b - a).slice(0, Math.max(1, Math.floor(n / 5)));
  const loud = clamp((top.reduce((x, v) => x + v, 0) / top.length - s.p50) / spread);
  const peaks = clamp(seg.filter((v) => v > s.p85).length / n / 0.35);
  let jumps = 0;
  for (let i = 1; i < n; i++) if (seg[i] - seg[i - 1] >= 6) jumps++;
  const jump = clamp(jumps / Math.max(1, n / 12));
  const mean = seg.reduce((x, v) => x + v, 0) / n;
  const std = Math.sqrt(seg.reduce((x, v) => x + (v - mean) ** 2, 0) / n);
  const variation = clamp(std / Math.max(1.5 * s.std, 1));
  let value = (0.35 * loud + 0.25 * peaks + 0.2 * jump + 0.2 * variation) * clamp(spread / 6, 0.3, 1);
  if (model.loud.length) {
    const inside = model.loud.filter((e) => e.end > start && e.start < end).length;
    value = Math.min(1, value + 0.15 * Math.min(1, inside / 3));
  }
  return round(value);
}

/** זמן השיא (הרגע הקולי ביותר) בטווח, או null. */
export function loudestAt(model, start, end) {
  if (!model) return null;
  const { frames, hop } = model;
  const i0 = Math.max(0, Math.floor(start / hop)); const i1 = Math.min(frames.length, Math.ceil(end / hop));
  let best = -1; let bestV = -Infinity;
  for (let i = i0; i < i1; i++) {
    const v = frames[i] + (i > 0 ? Math.max(0, frames[i] - frames[i - 1]) * 0.5 : 0); // עלייה חדה (צחוק, צעקה) חשובה יותר מעוצמה קבועה
    if (v > bestV) { bestV = v; best = i; }
  }
  return best < 0 ? null : round((best + 0.5) * hop, 2);
}

/** נוכחות פנים (0..1): כמה מהזמן יש פנים על המסך, וכמה הפה זז. */
export function faceScore(faces, start, end) {
  const samples = faces?.samples;
  if (!samples?.length) return null;
  let lo = 0; let hi = samples.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (samples[m].t < start) lo = m + 1; else hi = m; }
  let n = 0; let present = 0; const mouth = [];
  for (let i = lo; i < samples.length && samples[i].t <= end; i++) {
    n++;
    const fs = (samples[i].faces || []).filter((f) => f.w * f.h >= 0.004);
    if (fs.length) { present++; mouth.push(Math.max(...fs.map((f) => Number(f.mouth) || 0))); }
  }
  if (!n) return 0;
  let move = 0;
  if (mouth.length > 3) {
    const m = mouth.reduce((s, v) => s + v, 0) / mouth.length;
    const sd = Math.sqrt(mouth.reduce((s, v) => s + (v - m) ** 2, 0) / mouth.length);
    move = clamp(sd / 0.15);
  }
  return round(0.65 * (present / n) + 0.35 * move);
}

// ---------------------------------------------------------------------------------------------- ניקוד

function densityScore(words, seconds) {
  const rate = words / Math.max(seconds, 1);
  if (rate <= 1) return 0;
  if (rate < 2.2) return (rate - 1) / 1.2;
  if (rate <= 3.8) return 1;
  return clamp(1 - ((rate - 3.8) / 2) * 0.6, 0.4, 1);
}

function repetition(toks) {
  if (toks.length < 12) return 0;
  const grams = new Map();
  for (let i = 0; i + 2 < toks.length; i++) {
    const g = `${toks[i]} ${toks[i + 1]} ${toks[i + 2]}`;
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  let repeated = 0;
  for (const c of grams.values()) if (c > 1) repeated += c - 1;
  return repeated / Math.max(1, toks.length - 2);
}

function openingScore(units, a, lang) {
  const u = units[a];
  const text = u.text.trim();
  const toks = tokens(text);
  const head = toks.slice(0, 12);
  const first = toks[0] || '';
  let s = 0;
  const qWords = lang === 'he' || hebrewShare(text) > 0.3 ? HE_QUESTION : EN_QUESTION;
  if (text.includes('?')) s += 0.5;
  else if (inSet(qWords, first)) s += 0.3;
  if (head.some((t) => /\d/.test(t) || inSet(EN_NUMBER, t) || inSet(HE_NUMBER, t))) s += 0.25;
  if (toks.slice(0, 10).some((t) => inSet(EN_OPEN, t) || inSet(HE_OPEN, t) || inSet(EN_BOLD, t) || inSet(HE_BOLD, t))) s += 0.3;
  if (/!/.test(text) || toks.slice(0, 10).some((t) => inSet(EN_EMOTION, t) || inSet(HE_EMOTION, t))) s += 0.2;
  if (head.some((t) => SECOND_PERSON.has(t))) s += 0.1;
  const next = units[a + 1];
  if (next && s < 0.3 && next.text.includes('?') && next.start - u.end < 1.5) s += 0.15; // פתיחה קצרה שמובילה לשאלה
  return clamp(s);
}

function emotionScore(text, toks, seconds, extra) {
  const emo = countIn(toks, EN_EMOTION) + countIn(toks, HE_EMOTION) + extra;
  const bold = countIn(toks, EN_BOLD) + countIn(toks, HE_BOLD);
  const shouts = (String(text).match(/\b[A-Z]{3,}\b/g) || []).length;
  const bangs = (String(text).match(/!/g) || []).length;
  const per30 = 30 / Math.max(seconds, 10);
  return clamp(0.5 * clamp((emo * per30) / 5) + 0.2 * clamp((bangs * per30) / 4) + 0.15 * clamp((bold * per30) / 4) + 0.15 * clamp((shouts * per30) / 2));
}

function payoffScore(units, a, b, model, duration) {
  const last = units[b];
  const lastTwo = units.slice(Math.max(a, b - 1), b + 1).map((u) => u.text).join(' ');
  const lastToks = tokens(last.text);
  let s = endsDeclarative(last.text) || (last.closes && !last.text.trim().endsWith('?')) ? 0.25 : 0;
  if (containsAny(lastTwo, CONCLUSION)) s += 0.3;
  if (lastToks.length <= 12 && (/!/.test(last.text) || countIn(lastToks, EN_EMOTION) + countIn(lastToks, HE_EMOTION) > 0)) s += 0.25;
  let askedAt = -1;
  for (let i = a; i < b; i++) if (units[i].text.trim().endsWith('?')) { askedAt = i; break; }
  if (askedAt >= 0 && units.slice(askedAt + 1, b + 1).some((u) => wordCount(u.text) >= 8)) s += 0.25;
  const next = units[b + 1];
  const pause = next ? next.start - last.end : 3;
  s += pause >= 1.2 ? 0.2 : pause >= 0.6 ? 0.12 : 0;
  if (model) {
    const after = excitement(model, last.end, Math.min(duration, last.end + 3));
    if (after !== null && after > 0.55) s += 0.12; // צחוק או מחיאות אחרי הסיום
  }
  return clamp(s);
}

function selfContained(units, a) {
  const t = tokens(units[a].text);
  const first = t[0] || '';
  const refs = new Set(['this', 'that', 'it', 'he', 'she', 'they', 'these', 'those', 'also', 'but', 'however', 'זה', 'זאת', 'הוא', 'היא', 'הם', 'אבל']);
  return refs.has(first) ? 0.5 : 1;
}

function storyScore(text) {
  return clamp(containsAny(text, STORY) / 3);
}

function genreWords(text, genre) {
  const list = GENRE_WORDS[genre];
  return list ? Math.min(3, containsAny(text, list)) : 0;
}

/** כל רכיבי הציון של חלון [a..b] של יחידות. מחזיר גם את הרכיבים, לשימוש ב־reason. */
function scoreWindow(ctx, a, b, start, end) {
  const { units, lang, genre, model, faces, duration, audioWeight } = ctx;
  const members = units.slice(a, b + 1);
  const text = members.map((u) => u.text).join(' ');
  const toks = tokens(text);
  const seconds = Math.max(end - start, 1);
  const open = openingScore(units, a, lang);
  const emotion = emotionScore(text, toks, seconds, genreWords(text, genre));
  const payoff = payoffScore(units, a, b, model, duration);
  const density = densityScore(toks.length, seconds);
  const story = storyScore(text);
  const self = selfContained(units, a);
  let content = 0.24 * open + 0.2 * emotion + 0.22 * payoff + 0.12 * density + 0.1 * story + 0.12 * self;
  const fillerHits = SPOKEN_FILLERS.reduce((n, re) => n + (String(text).toLowerCase().match(re) || []).length, 0);
  const penalty = 1 - clamp((fillerHits / Math.max(1, toks.length)) * 3, 0, 0.4) - clamp(repetition(toks) * 1.5, 0, 0.4);
  content *= penalty;
  const promo = containsAny(text, PROMO) > 0;
  if (promo) content *= 0.4;
  const audio = excitement(model, start, end);
  const a2 = audio === null ? 0 : audioWeight;
  let value = (1 - a2) * content + a2 * (audio || 0);
  const face = faceScore(faces, start, end);
  if (face !== null) value = 0.92 * value + 0.08 * face;
  return {
    value, parts: { open, emotion, payoff, density, story, audio, face, penalty, promo, text },
  };
}

const toTen = (value01) => round(clamp(value01 * 1.25, 0, 1) * 10, 1);

// ---------------------------------------------------------------------------------------------- חלונות מועמדים

function familyTargets(span) {
  const lo = span.lo + 0.3; const hi = span.hi - 0.8;
  if (hi - lo < 6) return [[lo, Math.max(hi, lo + 0.5), Math.min(Math.max(span.target, lo), Math.max(hi, lo + 0.5))]];
  const edges = [0, 1, 2, 3].map((i) => lo + ((hi - lo) * i) / 3);
  return [0, 1, 2].map((i) => [edges[i], edges[i + 1], (edges[i] + edges[i + 1]) / 2]);
}

function padded(units, a, b, duration) {
  let start = Math.max(0, units[a].start - PAD_BEFORE);
  if (a) start = Math.max(start, units[a - 1].end);
  let end = Math.min(duration, units[b].end + PAD_AFTER);
  if (b + 1 < units.length) end = Math.min(end, units[b + 1].start);
  return [start, end];
}

function trimTail(units, a, b, minimum) {
  while (b > a && fillerOnly(units[b].text) && units[b - 1].end - units[a].start >= minimum) b--;
  return b;
}

function extendAnswer(units, b, t0, cap) {
  let i = b;
  while (i + 1 < units.length && units[i].text.trim().endsWith('?')) i++;
  while (i + 1 < units.length && !(units[i].closes && !units[i].text.trim().endsWith('?')) && units[i + 1].end - t0 <= cap) i++;
  if (units[i].end - t0 > cap || !(units[i].closes && !units[i].text.trim().endsWith('?'))) return null;
  return i;
}

/** חלונות בגבולות משפט: לכל התחלה אפשרית ולכל משפחת אורך, הסוף הקרוב ביותר לאורך היעד. */
export function candidateWindows(units, duration, span) {
  const found = new Map();
  const n = units.length;
  const families = familyTargets(span);
  const answerCap = span.hi - 3;
  for (let a = 0; a < n; a++) {
    if (!startOk(units, a)) continue;
    const t0 = units[a].start;
    for (const [lo, hi, centre] of families) {
      let best = null;
      for (let b = a; b < n; b++) {
        let d = units[b].end - t0;
        if (d > hi + 12) break;
        if (!units[b].closes) continue;
        let bb = b; let extended = false;
        if (units[b].text.trim().endsWith('?')) {
          bb = extendAnswer(units, b, t0, answerCap);
          if (bb === null) continue;
          extended = true;
        }
        bb = trimTail(units, a, bb, lo);
        if (!(units[bb].closes && !units[bb].text.trim().endsWith('?'))) continue;
        d = units[bb].end - t0;
        if (d < lo || d > hi + (extended ? 8 : 0)) continue;
        const gap = Math.abs(d - centre);
        if (!best || gap < best[0]) best = [gap, bb];
      }
      if (best) found.set(`${a}:${best[1]}`, [a, best[1]]);
    }
  }
  const out = [];
  for (const [a, b] of found.values()) {
    const [start, end] = padded(units, a, b, duration);
    const len = end - start;
    if (len < span.lo - 0.01 || len > span.hi + 0.01) continue;
    const words = units.slice(a, b + 1).reduce((s, u) => s + u.n, 0);
    if (new Set(tokens(units.slice(a, b + 1).map((u) => u.text).join(' '))).size < Math.min(14, Math.floor(words * 0.6))) continue;
    out.push({ a, b, start, end });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- כותרות (hooks)

function naturalCut(core, limit = MAX_HOOK_WORDS) {
  const words = core.split(/\s+/).filter(Boolean);
  if (words.length <= limit) return words.join(' ');
  const weak = (w) => TRAIL_STOP.has(w.toLowerCase().replace(/[,;:]+$/, '')) || CONTINUATION.has(w.toLowerCase()) || WEAK_OPENERS.has(w.toLowerCase());
  for (let n = limit; n > 3; n--) { // סוף המשפט: משפט נגמר איפה שמחשבה נגמרת
    if (!weak(words[words.length - n])) return words.slice(-n).join(' ');
  }
  const clauses = core.split(/[,;:]\s+|\s+(?:and|but|because|ו)\s+/).map((c) => c.trim()).filter((c) => wordCount(c) >= 3 && wordCount(c) <= limit);
  if (clauses.length) return clauses[0];
  const head = words.slice(0, limit);
  while (head.length > 3 && weak(head[head.length - 1])) head.pop();
  return head.join(' ');
}

const HOOK_EDGE_START = set(`so um uh umm like and but yeah yes okay ok well oh then also or because כן אז אה אממ כאילו ו אבל וגם נו טוב`);
const HOOK_EDGE_END = new Set([...TRAIL_STOP, ...set(`so like um uh yeah okay we he she they while if because since אז כאילו נו`)]);

function cleanHook(text) {
  const plain = String(text).replace(/\s+/g, ' ').replace(/^[\s"'“”‘’`«»\-–—:;,.]+/, '').replace(/[\s"'“”‘’`«»\-–—:;,.]+$/, '').trim();
  const low = (w) => w.toLowerCase().replace(/[,;:.!?]+$/g, '');
  const words = [];
  for (const w of plain.split(' ')) { // גמגום: "Who Who Who" ו"their best their best" הופכים למילה או לצמד אחד
    if (words.length && low(words[words.length - 1]) === low(w)) continue;
    words.push(w);
  }
  for (let i = 0; i + 3 < words.length; i++) {
    if (low(words[i]) === low(words[i + 2]) && low(words[i + 1]) === low(words[i + 3])) words.splice(i + 2, 2);
  }
  while (words.length > 3 && HOOK_EDGE_START.has(low(words[0]))) words.shift(); // פתיחה ב"so" או "um" אינה פתיחה
  while (words.length > 3 && (HOOK_EDGE_END.has(low(words[words.length - 1])) || /'(?:re|ll|ve|d|m)$/.test(low(words[words.length - 1]))) && !/[?!]$/.test(words[words.length - 1])) words.pop();
  return words.join(' ').replace(/[\s,;:\-–—]+$/, '');
}

function hookWordsOk(hook, sourceTokens) {
  const ts = tokens(hook);
  if (ts.length < 2 || ts.length > MAX_HOOK_WORDS) return false;
  return ts.every((t) => sourceTokens.has(t));
}

function sentenceStrength(text, lang) {
  const toks = tokens(text);
  const n = Math.max(1, toks.length);
  const emo = countIn(toks, EN_EMOTION) + countIn(toks, HE_EMOTION);
  const bold = countIn(toks, EN_BOLD) + countIn(toks, HE_BOLD) + countIn(toks, EN_OPEN) + countIn(toks, HE_OPEN);
  const nums = toks.filter((t) => /\d/.test(t) || inSet(EN_NUMBER, t) || inSet(HE_NUMBER, t)).length;
  let v = 1.2 * Math.min(emo, 3) + 1.2 * Math.min(bold, 3) + 1.0 * Math.min(nums, 2) + (text.includes('!') ? 0.8 : 0) + (text.includes('?') ? 0.7 : 0);
  v += containsAny(text, STORY) * 0.8;
  if (n < 5) v -= 1.5;
  if (n > 28) v -= 1;
  if (fillerOnly(text)) v -= 5;
  if (containsAny(text, PROMO)) v -= 6;
  return v;
}

const GENERIC_HOOKS = {
  he: [['חכו לזה', 'claim'], ['תראו מה קורה', 'claim'], ['תישארו עד הסוף', 'claim']],
  en: [['Wait for it', 'claim'], ['Watch what happens', 'claim'], ['Stay till the end', 'claim']],
};

/**
 * שלוש גרסאות כותרת מתוך הטקסט של הרגע בלבד: הטוב ביותר, שאלה (שאלה מילולית מהקליפ), וציטוט חזק.
 * כל כותרת היא קטע רצוף של מילים מהתמלול, 2 עד 7 מילים, בלי מילים שלא נאמרו.
 */
export function hooksFor(units, a, b, lang) {
  const members = units.slice(a, b + 1);
  const sourceTokens = new Set(tokens(members.map((u) => u.text).join(' ')));
  const items = members.map((u, i) => ({ i, text: u.text.trim(), strength: sentenceStrength(u.text, lang), question: u.text.trim().endsWith('?') }))
    .filter((x) => wordCount(x.text) >= 3);
  const chosen = [];
  const take = (style, text) => {
    const hook = cleanHook(text);
    if (!hookWordsOk(hook, sourceTokens)) return false;
    if (chosen.some((c) => norm(c.hook) === norm(hook) || overlapRatio(c.hook, hook) >= 0.7)) return false;
    chosen.push({ style, hook });
    return true;
  };
  const byStrength = items.slice().sort((x, y) => y.strength - x.strength || x.i - y.i);
  const cutOf = (item) => {
    const core = item.text.replace(/[?!.…\s]+$/, '');
    const cut = naturalCut(core);
    return cut + (item.question && wordCount(core) <= MAX_HOOK_WORDS ? '?' : '');
  };
  // 1. הטוב ביותר: המשפט החזק ביותר (שאלה שלמה, מספר, קביעה נועזת או רגש)
  for (const item of byStrength) {
    if (item.question && wordCount(item.text) > MAX_HOOK_WORDS) continue;
    if (take(item.question ? 'question' : /\d/.test(item.text) ? 'claim' : 'quote', cutOf(item))) break;
  }
  // 2. שאלה: שאלה מילולית מהקליפ, כשהיא קצרה מספיק כדי להיות שלמה
  if (!chosen.some((c) => c.style === 'question')) {
    for (const item of byStrength.filter((x) => x.question && wordCount(x.text) <= MAX_HOOK_WORDS + 1)) {
      if (take('question', cutOf(item))) break;
    }
  }
  // 3. קביעה (מספר או טענה) וציטוט חזק
  for (const style of ['claim', 'quote']) {
    if (chosen.length >= 3) break;
    if (chosen.some((c) => c.style === style)) continue;
    const pool = byStrength.filter((x) => !x.question);
    const ordered = style === 'claim' ? pool.slice().sort((x, y) => Number(/\d/.test(y.text)) - Number(/\d/.test(x.text)) || y.strength - x.strength) : pool;
    for (const item of ordered) {
      if (take(style, cutOf(item))) break;
    }
  }
  for (const item of byStrength) { // עדיין חסר: כל קטע תקין אחר
    if (chosen.length >= 3) break;
    take('quote', cutOf(item));
  }
  const best = chosen[0];
  return best ? { hook: best.hook, hooks: chosen.slice(0, 3).map((c) => c.hook), hookStyles: chosen.slice(0, 3).map((c) => c.style) } : null;
}

function overlapRatio(x, y) {
  const a = new Set(tokens(x)); const b = new Set(tokens(y));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / Math.min(a.size, b.size);
}

// ---------------------------------------------------------------------------------------------- הסבר בעברית

function reasonHe(parts, audioOnly = false) {
  if (audioOnly) {
    return parts.audio !== null && parts.audio >= 0.5
      ? 'נבחר לפי אנרגיית הקול: שיא חזק של קול (צחוק, צעקות או מוזיקה), עם הכנה לפניו וסיום אחריו.'
      : 'נבחר לפי אנרגיית הקול: הקטע הערני ביותר בסרטון, שאין בו דיבור.';
  }
  const bits = [];
  const text = parts.text || '';
  if (parts.open >= 0.45) {
    bits.push(text.slice(0, 80).includes('?') || /^\s*[^.!]*\?/.test(text) ? 'פתיחה בשאלה' : parts.open >= 0.7 ? 'פתיחה חזקה' : 'פתיחה שמושכת תשומת לב');
  }
  if (parts.emotion >= 0.35) bits.push('רגש חזק');
  if (parts.audio !== null && parts.audio >= 0.5) bits.push('אנרגיית קול גבוהה');
  if (parts.payoff >= 0.5) bits.push('סיום חד');
  if (parts.story >= 0.34) bits.push('סיפור עם התפתחות');
  if (parts.density >= 0.8 && bits.length < 3) bits.push('דיבור רציף וצפוף');
  if (parts.face !== null && parts.face >= 0.6 && bits.length < 3) bits.push('הדובר בפריים');
  const shown = bits.slice(0, 3);
  if (!shown.length) return 'הרגע הרציף והברור ביותר שנמצא בסרטון, בלי נקודת חוזק בולטת.';
  const joined = shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(', ')} ו${shown[shown.length - 1]}`;
  return `נבחר בזכות ${joined}.`;
}

// ---------------------------------------------------------------------------------------------- בחירה

const gapBetween = (x, y) => Math.max(0, Math.max(x.start, y.start) - Math.min(x.end, y.end));

function pickDiverse(scored, count, duration) {
  const chosen = [];
  const used = new Set();
  const slices = duration > LONG_SECONDS ? Math.max(3, Math.min(12, count)) : 0;
  const part = (w) => Math.min(slices - 1, Math.max(0, Math.floor(((w.start + w.end) / 2 / Math.max(duration, 1)) * slices)));
  const remaining = scored.slice().sort((x, y) => y.score - x.score || x.start - y.start);
  while (remaining.length && chosen.length < count) {
    let best = null;
    for (const w of remaining) {
      if (chosen.some((c) => w.start < c.end + 1 && w.end > c.start - 1)) continue;
      const penalty = chosen.reduce((s, c) => s + DIVERSITY_PENALTY * Math.exp(-gapBetween(w, c) / DIVERSITY_SCALE), 0);
      const bonus = slices > 1 && !used.has(part(w)) ? COVERAGE_BONUS : 0;
      const eff = w.score - penalty + bonus;
      if (!best || eff > best[0]) best = [eff, w];
    }
    if (!best) break;
    chosen.push(best[1]);
    if (slices > 1) used.add(part(best[1]));
    remaining.splice(remaining.indexOf(best[1]), 1);
  }
  return chosen;
}

function mergeNear(windows) { // חלונות כמעט זהים: נשאר הטוב יותר (IoU גבוה)
  const kept = [];
  for (const w of windows.slice().sort((x, y) => y.value - x.value)) {
    const dup = kept.some((k) => {
      const inter = Math.max(0, Math.min(k.end, w.end) - Math.max(k.start, w.start));
      return inter / (k.end - k.start + w.end - w.start - inter) >= 0.75;
    });
    if (!dup) kept.push(w);
  }
  return kept;
}

// ---------------------------------------------------------------------------------------------- בלי דיבור

function audioOnlyMoments(model, duration, span, count, lang) {
  if (!model) return [];
  const { frames, hop } = model;
  const len = span.target;
  const smooth = new Float32Array(frames.length);
  for (let i = 0; i < frames.length; i++) {
    let s = 0; let c = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(frames.length - 1, i + 2); j++) { s += frames[j]; c++; }
    smooth[i] = s / c;
  }
  const order = Array.from(smooth.keys()).sort((x, y) => smooth[y] - smooth[x]);
  const peaks = [];
  for (const i of order) {
    const t = (i + 0.5) * hop;
    if (peaks.every((p) => Math.abs(p - t) >= len * 0.8)) peaks.push(t);
    if (peaks.length >= Math.max(count * 4, 12)) break;
  }
  const dur = duration || frames.length * hop;
  const windows = peaks.map((t) => {
    let start = clamp(t - 0.4 * len, 0, Math.max(0, dur - len));
    let end = Math.min(dur, start + len);
    start = snapToQuiet(model, start, 1.5, true);
    end = snapToQuiet(model, end, 1.5, false);
    if (end - start < span.lo) end = Math.min(dur, start + span.lo);
    if (end - start > span.hi) end = start + span.hi;
    const value = excitement(model, start, end);
    return { start: round(start, 2), end: round(end, 2), value: value || 0, peak: round(t, 2) };
  }).filter((w) => w.end - w.start >= Math.min(span.lo, dur) - 0.01);
  const unique = mergeNear(windows);
  const scored = unique.map((w) => ({ start: w.start, end: w.end, score: toTen(w.value), peak: w.peak }));
  return pickDiverse(scored, count, dur).map((w) => {
    const g = (GENERIC_HOOKS[lang] || GENERIC_HOOKS.he).map((x) => x[0]);
    return { start: w.start, end: w.end, score: w.score, hook: g[0], hooks: g.slice(0, 3), reason: reasonHe({ audio: w.score / 10 }, true), peak: w.peak, hookStyles: ['claim', 'claim', 'claim'], audioOnly: true };
  });
}

function snapToQuiet(model, t, radius, forStart) { // חותכים בנקודה השקטה ביותר בקרבת הקצה
  const { frames, hop } = model;
  const i0 = Math.max(0, Math.floor((t - radius) / hop)); const i1 = Math.min(frames.length - 1, Math.ceil((t + radius) / hop));
  let best = Math.round(t / hop); let bestV = Infinity;
  for (let i = i0; i <= i1; i++) {
    if (frames[i] < bestV - 0.5 || (Math.abs(frames[i] - bestV) <= 0.5 && Math.abs(i * hop - t) < Math.abs(best * hop - t))) { bestV = frames[i]; best = i; }
  }
  return forStart ? best * hop : (best + 1) * hop;
}

// ---------------------------------------------------------------------------------------------- הפונקציה הראשית

/**
 * findMoments(transcript, audioInfo, {count, length, genre, faces}) -> [Moment]
 * Moment = { start, end, score 0..10, hook, hooks:[3], reason (עברית), peak?, hookStyles, language }
 * הרגעים ממוינים מהטוב לגרוע, בלי חפיפה, ומפוזרים לאורך הסרטון.
 */
export function findMoments(transcript, audioInfo, options = {}) {
  const { count = 3, length = 'auto', genre = 'auto', faces = null } = options;
  const n = Math.max(1, Math.min(10, Math.floor(Number(count) || 3)));
  const span = lengthSpan(length, GENRE_CLIP[genre] ? genre : 'auto');
  const g = GENRE_CLIP[genre] ? genre : 'auto';
  const model = audioModel(audioInfo);
  const units = sentenceUnits(transcript);
  const lang = detectLanguage(transcript, ['he', 'en'].includes(options.language) ? options.language : 'he');
  const duration = Number(audioInfo?.duration) || (units.length ? units[units.length - 1].end : 0)
    || (model ? model.frames.length * model.hop : 0);
  if (!duration) return [];
  if (!units.length) return audioOnlyMoments(model, duration, span, n, lang);
  const ctx = { units, lang, genre: g, model, faces, duration, audioWeight: GENRE_CLIP[g][2] };
  const windows = candidateWindows(units, duration, span);
  const scored = windows.map((w) => {
    const r = scoreWindow(ctx, w.a, w.b, w.start, w.end);
    return { ...w, ...r };
  });
  const unique = mergeNear(scored);
  const moments = unique.map((w) => ({ start: round(w.start, 3), end: round(w.end, 3), score: toTen(w.value), a: w.a, b: w.b, parts: w.parts }));
  const picked = pickDiverse(moments.filter((m) => m.score >= MIN_FLOOR), n, duration);
  const out = [];
  for (const m of picked) {
    const h = hooksFor(units, m.a, m.b, lang);
    if (!h) continue;
    out.push({
      start: m.start, end: m.end, score: m.score, hook: h.hook, hooks: h.hooks, hookStyles: h.hookStyles,
      reason: reasonHe(m.parts), peak: peakOf(model, units, m), language: lang,
    });
  }
  return out;
}

function peakOf(model, units, m) {
  const t = loudestAt(model, m.start, m.end);
  if (t !== null && excitement(model, m.start, m.end) > 0.4) return t;
  let best = m.a; let bestV = -Infinity;
  for (let i = m.a; i <= m.b; i++) {
    const v = sentenceStrength(units[i].text, 'en');
    if (v > bestV) { bestV = v; best = i; }
  }
  return round(units[best].start, 2);
}
