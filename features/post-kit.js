// post-kit.js: חבילת פרסום לקליפ, בלי מודל שפה.
//   makePost(transcript, moment, {lang:'he'|'en', genre, platform:'tiktok'|'reels'|'shorts'|'youtube'}) -> {title, description, hashtags[], cta, ...}
// נגזר מ־localize.py (post_kit, audience_plural, כללי הטקסט בעברית) ומ־thumbnails.py (short_title, highlight_index) בגרסת המק,
// אבל בתבניות חכמות במקום מודל: כל מה שמופיע בכותרת ובתיאור הוא קטע מילולי מהתמלול (מקוצר בהסרות בלבד), ואין בהם עובדה שלא נאמרה.
// הקובץ טהור: אין בו DOM ואין רשת, והוא עובד ב־node וגם בדפדפן וב־Worker.
//
// - כותרת: ה־hook של הרגע, עד 7 מילים, בלי לחתוך באמצע ביטוי.
// - תיאור: משפט או שניים מתוך הרגע, אחרי ניקוי גמגומים ומילות מילוי. משפט בגוף ראשון או שני בא במירכאות, כדי לא לייחס את הדברים למפרסם.
// - האשטגים: 5 עד 8 לפי נושאי הרגע, שמות, מילות מפתח וסוג הקליפ. בלי האשטגים גנריים (fyp, viral וכדומה).
// - קריאה לפעולה: בעברית תמיד בפנייה ברבים.
// החלטה: השפה היא שפת התמלול. בלי מודל אי אפשר לתרגם, ולכן תמלול באנגלית עם lang:'he' נשאר באנגלית (result.lang אומר איזו שפה נבחרה).

// ---------------------------------------------------------------------------------------------- פלטפורמות

/** מגבלות אורך. title/description הם יעדי הקריאות (מה שנראה לפני "עוד"), titleHard/caption הם התקרות של הפלטפורמה. */
export const PLATFORMS = {
  tiktok: { id: 'tiktok', nameHe: 'טיקטוק', title: 60, titleHard: 60, description: 150, hashtags: [5, 6], caption: 2200 },
  reels: { id: 'reels', nameHe: 'רילס', title: 60, titleHard: 60, description: 125, hashtags: [5, 5], caption: 2200 },
  shorts: { id: 'shorts', nameHe: 'שורטס', title: 70, titleHard: 100, description: 220, hashtags: [5, 8], caption: 5000 },
  youtube: { id: 'youtube', nameHe: 'יוטיוב', title: 70, titleHard: 100, description: 300, hashtags: [5, 8], caption: 5000 },
};
export const DEFAULT_PLATFORM = 'reels';
export const MAX_TITLE_WORDS = 7;
export const GENRES = ['auto', 'podcast', 'food', 'prank', 'fitness', 'tips', 'motivation', 'comedy', 'review', 'vlog', 'sports'];

// ---------------------------------------------------------------------------------------------- עזרים כלליים

const set = (text) => new Set(String(text).split(/\s+/).filter(Boolean));
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const NIQQUD = /[֑-ׇ]/g;
const BIDI = /[​-‏‪-‮⁦-⁩﻿]/g;
const EMOJI = /[\p{Extended_Pictographic}️]/gu;
const HEB = /[֐-׿]/;
const WORD_RE = /[\p{L}\p{N}]+(?:['’"״׳\-־.][\p{L}\p{N}]+)*/gu;
const SENT_END = /[.!?…]+["'”’)\]]*$/;
const CLAUSE_END = /[,;:–—]["'”’)]*$/;
const GERESH = /['’׳]/g;

/** מחרוזת בלי סימני כיוון, ניקוד ואימוג׳י, עם רווחים מנורמלים. */
export function tidy(text) {
  return String(text ?? '').normalize('NFC').replace(BIDI, '').replace(NIQQUD, '').replace(EMOJI, '').replace(/\s+/g, ' ').trim();
}

/** מילות הטקסט באותיות קטנות, בלי פיסוק בקצוות. בלועזית הגרש הפנימי נשמר (it's), בעברית גרש וגרשיים מוסרים. */
export function tokens(text) {
  return (tidy(text).toLowerCase().match(WORD_RE) || []).map((t) => (isHeb(t) ? t.replace(/['’"״׳]/g, '') : t.replace(/’/g, "'")).replace(/[.\-־]+$/, ''));
}

const coreOf = (w) => { const c = String(w).toLowerCase().replace(NIQQUD, '').replace(/’/g, "'").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''); return isHeb(c) ? c.replace(/['"״׳]/g, '') : c; };
const isHeb = (s) => HEB.test(s);

/** he | en | other, לפי חלוקת האותיות. */
export function detectLang(text, hint) {
  const t = String(text || '');
  let he = 0, la = 0, other = 0;
  for (const ch of t) {
    if (ch >= '֐' && ch <= '׿') he++;
    else if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) la++;
    else if (/\p{L}/u.test(ch)) other++;
  }
  const code = String(hint || '').toLowerCase().slice(0, 2);
  if (he + la + other === 0) return code === 'he' || code === 'iw' ? 'he' : code === 'en' ? 'en' : 'en';
  if (he >= la && he >= other) return 'he';
  if (la >= other) return code && code !== 'en' && code !== 'he' && code !== 'iw' ? 'other' : 'en';
  return 'other';
}

function hash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h;
}

// ---------------------------------------------------------------------------------------------- מילונים

const STOP_EN = set(`a about above after again against all almost also although always am an and any are aren't around as at back be because been before being below
between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each even ever every few for from further get gets getting go goes
going gonna got gotta had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is
isn't it it's its itself just let let's like make makes many may maybe me might more most much must my myself no nor not now of off often oh ok okay on once one only or other
ought our ours ourselves out over own really right said same say says see she she'd she'll she's should shouldn't so some something sometimes still such take than that that's
the their theirs them themselves then there there's these they they'd they'll they're they've thing things think this those though through to too under until up us use very
want wants was wasn't we we'd we'll we're we've well were weren't what what's when when's where where's whether which while who who's whom whose why why's will with won't
would wouldn't yeah yes yet you you'd you'll you're you've your yours yourself yourselves kind sort lot lots guys guy dude man bro mhm huh wanna know knew mean means came come
comes went look looking looked looks tell told talk talking talked time times way ways day days year years first last next new good great little big long high real actually
basically literally obviously honestly totally definitely probably pretty quite able anyone anything everyone everything someone nothing nobody everybody anybody somebody
people person got getting thanks thank please sure different another around back kinda sorta alright dang damn heck gosh whoa hey hello bye gotta`);

const STOP_HE = set(`של את על אל עם כי אם או גם לא אבל כמו מן מאת זה זו זאת אלה אלו הוא היא אני אתה אנחנו אתם אתן הם הן כל מה מי איך למה כאן שם עוד כבר רק אז כך ככה יש אין היה היו
היתה הייתה היינו להיות אשר לפי בין לפני אחרי תחת מעל ליד בלי עד אצל מאז לכן כש אולי איזה איזו הזה הזאת האלה אותו אותה אותם אותן אותי אותך הכי מאוד ממש יותר פחות שלי שלך שלו שלה שלנו
שלכם שלהם לי לך לו לה לנו לכם להם לכן בו בה בהם בי בך אליו אליה אלי אלינו עליו עליה עלי עלינו ממנו ממנה ממני ממך איתו איתה איתי איתנו איתם הרבה קצת בכלל פשוט בעצם כאילו נו טוב
אוקיי אוקי כן ברור נכון באמת סתם תמיד אף אחד כלום משהו מישהו כולם כולנו הכול הכל עכשיו היום מחר אתמול שוב פה הנה אפילו אפשר צריך צריכה צריכים רוצה רוצים יכול יכולה יכולים חייב
חייבים אמר אמרה אמרתי אומר אומרת אומרים עשה עושה עושים עשיתי הלך הולך הולכים בא באים בוא בואו ראיתי רואה יודע יודעת יודעים ידעתי חושב חושבת חושבים חשבתי קורה קרה דבר דברים פעם
פעמים זמן שנה שנים יום ימים אחרת אחר אחרים שום איפה מתי כמה האם לאן ואז ואני ואתה וגם בגלל למרות בזמן תודה בבקשה וואלה יאללה אחי אחלה סבבה בנאדם איזשהו כלשהו היינו הייתי ראשון ראשונה ראשונים ראשונות שנייה שניה שלישי שלישית אחרון אחרונה הבא הבאה הבאים כמה עצמו עצמה עצמי`);

/** אותיות שימוש שמותר להדביק למילה: ו, ואז כש/ש/מש/לכש, ואז ב/כ/ל/מ, ואז ה (ולכשבה, כשה, וב, מה...). */
const HE_PREFIX_RE = /^(?:ו)?(?:כש|ש|מש|לכש)?[בכלמ]?(?:ה)?$/;
/** הגזעים האפשריים של מילה אחרי הסרת אותיות שימוש (לפחות minStem אותיות). */
function hePrefixStems(w, minStem) {
  const out = [];
  for (let n = 1; n <= 4 && w.length - n >= minStem; n++) if (HE_PREFIX_RE.test(w.slice(0, n))) out.push(w.slice(n));
  return out;
}

/** מילת יחס, מילת קישור או כינוי עם אות שימוש בצמוד (שזה, כשאתה, ולא): עדיין מילת פונקציה. */
function stopHe(core) {
  return STOP_HE.has(core) || hePrefixStems(core, 2).some((st) => STOP_HE.has(st));
}
const stopEn = (core) => STOP_EN.has(core) || STOP_EN.has(core.replace(/'s$/, ''));
const isStop = (core) => (isHeb(core) ? stopHe(core) : stopEn(core));
/** מילה שאי אפשר לסיים בה: מילת יחס וקישור, או כינוי שפותח פסוקית (שאתם, כשאני) */
const weakEnd = (core) => WEAK_END_EN.has(core) || WEAK_END_HE.has(core) || (isHeb(core) && !STOP_HE.has(core) && ((/^(?:ו)?(?:כש|ש|מש|לכש)./.test(core) && stopHe(core)) || (/^ו./.test(core) && STOP_HE.has(core.slice(1)))));
const PREP_PREFIX = /^[בלמכ][א-ת]{2,5}$/;

const FILLER_TOKEN = set(`um umm uh uhh uhm er erm hmm hm mm mmm mhm ah ahh huh אממ אמ אהה אה אההה המם הממ הה אמממ`);
const REACTION_ONLY = set(`yeah yes yep yup no nope okay ok right sure thanks thank you wow cool nice great awesome amazing true exactly absolutely definitely totally
mhm huh haha lol oh well so and but then now כן לא אוקיי אוקי טוב נכון וואו יופי בסדר ברור אז רגע תודה אחלה סבבה וואלה יאללה נו`);
const PROMO = ['subscribe', 'like and subscribe', 'hit the bell', 'link in', 'link below', 'description below', 'comment below', 'promo code', 'discount code', 'use code',
  'giveaway', 'sponsor', 'thanks for watching', 'see you in the next', 'הירשמו', 'תירשמו', 'קוד קופון', 'קוד הנחה', 'בתיאור', 'הגרלה', 'לייק ותגובה', 'תודה שצפיתם', 'נתראה בסרטון הבא'];
const EMOTION = set(`crazy insane unbelievable incredible amazing wow love hate scared afraid terrified cried crying shocked shocking angry furious wild nuts huge disgusting beautiful
dream dreams miracle pain proud blessed epic legend hilarious funny dead awesome fantastic ridiculous terrifying brutal perfect secret mistake mistakes truth lie wrong worst best
biggest never always nobody everyone stop warning banned מטורף מטורפת מדהים מדהימה מפחיד אוהב שונא בוכה בכיתי צחקתי כאב פחד שוק נורא מושלם אש מרגש מצחיק מזעזע חלום נס אדיר
הכי סוד סודות טעות טעויות אמת שקר אזהרה אסור חובה לעולם מעולם תמיד אף כולם`);
const HYPE = set(`never always secret secrets free worst best biggest craziest crazy insane shocking wild impossible truth real fake finally nobody everyone nothing banned
dangerous epic ultimate perfect huge massive unbelievable incredible amazing wrong mistake mistakes why how stop warning genius legend סוד סודות חינם הכי מטורף מטורפת מדהים
מדהימה שוק הלם אסור אסורה אמת שקר הפתעה לעולם מעולם הכול מסוכן מפתיע ענק אזהרה דחוף גאון אגדה נורא מפחיד מצחיק טעות טעויות איך למה`);
const QUESTION_WORDS = set(`why what how when where who which is are do does did can could would should will have has isn't aren't don't למה מה איך מתי איפה מי כמה האם איזה איזו`);

const ARTICLES = set(`a an the my your his her our their this that these those`);
const NEGATIONS = set(`not no never cannot can't won't don't didn't doesn't isn't wasn't aren't couldn't wouldn't shouldn't nobody nothing לא אל אין בלי אף שום`);
const ABBREV = set(`mr mrs ms dr prof vs st mt sr jr inc gen sgt etc approx no`);

// מילים שמשפט או כותרת לא יכולים להסתיים בהן, ושלא נחתכים אחריהן
const WEAK_END_EN = set(`a an the of to in on at for and or but with from by as is are was were be am do did does has have had will would can could my your his her our their its if
so than then not no just very really also too about into over under after before while when where which what who whom how why been being because until whether nor yet per via like`);
const WEAK_END_HE = set(`של את על אל עם כי אם או גם אבל כמו מן מאת אשר לפי בין לפני אחרי תחת מעל ליד בלי עד אצל מאז לכן כש אולי הכי מאוד ממש יותר פחות כל ו ש ה ב ל כ מ לא אין יש עוד כבר רק אז היא הוא הם הן זה זו זאת אלה אלו אני אתה אנחנו היה היו הייתה`);
const WEAK_START_EN = set(`and or but so then because of to in on at for with from by as than nor yet`);
const WEAK_START_HE = set(`ו אבל כי אז או גם של את על אל עם כמו`);
const UNITS = set(`dollars dollar bucks percent million billion thousand years year days day hours hour minutes minute seconds second weeks week months month times people
reps sets pounds kilos miles שקל שקלים דולר דולרים אחוז אחוזים שנים שנה ימים יום שעות שעה דקות דקה שניות שבועות שבוע חודשים חודש פעמים אנשים אלף מיליון מיליארד חזרות סטים ק"ג קילו`);
const NUMBER_WORDS = set(`one two three four five six seven eight nine ten eleven twelve twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion
אחד אחת שניים שתיים שני שתי שלוש שלושה ארבע ארבעה חמש חמישה שש שישה שבע שבעה שמונה תשע תשעה עשר עשרה עשרים שלושים ארבעים חמישים שישים שבעים שמונים תשעים מאה מאות אלף אלפים מיליון`);
const GLUE = [['new', 'york'], ['los', 'angeles'], ['at', 'least'], ['right', 'now'], ['a', 'lot'], ['how', 'to'], ['so', 'much'], ['all', 'time'], ['kind', 'of'], ['sort', 'of'],
  ['אף', 'אחד'], ['כל', 'כך'], ['כל', 'אחד'], ['שום', 'דבר'], ['עוד', 'פעם'], ['בית', 'ספר'], ['יום', 'הולדת'], ['כדור', 'רגל'], ['כדור', 'סל'], ['סוף', 'סוף'], ['לא', 'ייאמן'],
  ['בכלל', 'לא'], ['הכי', 'טוב'], ['הכי', 'גרוע'], ['אי', 'פעם']];
const FIRST_SECOND_EN = set(`i i'm i've i'd i'll me my mine myself we we're we've we'd we'll our ours us ourselves you your you're you've you'll you'd yours yourself yourselves`);
const FIRST_SECOND_HE = set(`אני אנחנו אתה את אתם אתן שלי שלך שלנו שלכם שלכן לי לך לנו לכם אותי אותך אותנו אתכם אצלי אצלך אצלנו איתי איתך איתנו עליי עליך עלינו ממני ממך אחשוב`);

// ---------------------------------------------------------------------------------------------- נושאים (לקסיקון)
// שורה: סוג | תגית באנגלית | צורות באנגלית | תגית בעברית | צורות בעברית (צורות בלי אותיות שימוש, ההתאמה מסירה אותן).
const TOPIC_TABLE = `
food|burger|burger burgers hamburger hamburgers cheeseburger|בורגר|בורגר בורגרים המבורגר המבורגרים
food|pizza|pizza pizzas|פיצה|פיצה פיצות
food|pasta|pasta spaghetti lasagna|פסטה|פסטה ספגטי לזניה
food|salad|salad salads|סלט|סלט סלטים
food|chicken|chicken wings|עוף|עוף עופות כנפיים
food|steak|steak steaks ribeye|סטייק|סטייק סטייקים אנטריקוט
food|meat|meat beef lamb|בשר|בשר בקר טלה
food|seafood|fish salmon tuna shrimp|דגים|דג דגים סלמון טונה שרימפס
food|sushi|sushi|סושי|סושי
food|hummus|hummus tahini|חומוס|חומוס טחינה
food|shakshuka|shakshuka|שקשוקה|שקשוקה
food|falafel|falafel|פלאפל|פלאפל
food|schnitzel|schnitzel|שניצל|שניצל
food|cake|cake cakes cupcake cupcakes|עוגה|עוגה עוגות
food|cookies|cookie cookies|עוגיות|עוגיה עוגייה עוגיות
food|chocolate|chocolate|שוקולד|שוקולד
food|dessert|dessert desserts|קינוח|קינוח קינוחים
food|icecream|icecream gelato|גלידה|גלידה גלידות
food|coffee|coffee espresso latte cappuccino|קפה|קפה אספרסו לאטה קפוצינו
food|recipe|recipe recipes|מתכון|מתכון מתכונים
food|cooking|cooking cook cooks chef|בישול|בישול מבשל מבשלים שף
food|baking|baking bake baked|אפייה|אפייה אופה אופים
food|restaurant|restaurant restaurants|מסעדה|מסעדה מסעדות
food|vegan|vegan vegetarian|טבעוני|טבעוני טבעונית טבעונים צמחוני
food|sauce|sauce sauces|רוטב|רוטב רטבים
food|bread|bread|לחם|לחם פיתה לחמניה
food|cheese|cheese|גבינה|גבינה גבינות
food|eggs|egg eggs|ביצים|ביצה ביצים
food|fries|fries|ציפס|ציפס
food|sandwich|sandwich sandwiches|סנדוויץ|סנדוויץ כריך כריכים
fitness|workout|workout workouts exercise exercises training|אימון|אימון אימונים להתאמן מתאמן מתאמנים תרגיל תרגילים
fitness|fitness|fitness gym|כושר|כושר
fitness|squat|squat squats|סקוואט|סקוואט סקוואטים
fitness|pushups|pushup pushups|שכיבותסמיכה|שכיבות
fitness|protein|protein|חלבון|חלבון חלבונים
fitness|nutrition|nutrition diet calories|תזונה|תזונה דיאטה קלוריות
fitness|muscle|muscle muscles biceps|שרירים|שריר שרירים
fitness|running|running runner marathon|ריצה|ריצה רץ רצים מרתון
fitness|yoga|yoga|יוגה|יוגה
fitness|pilates|pilates|פילאטיס|פילאטיס
fitness|cardio|cardio|קרדיו|קרדיו
fitness|abs|abs|בטן|בטן
sports|baseball|baseball pitcher pitching mound catcher innings strikeout bullpen|בייסבול|בייסבול
sports|football|football soccer quarterback touchdown|כדורגל|כדורגל כדורגלן כדורגלנים
sports|basketball|basketball|כדורסל|כדורסל
sports|tennis|tennis|טניס|טניס
sports|boxing|boxing|אגרוף|אגרוף
sports|swimming|swimming|שחייה|שחייה
sports|cycling|cycling|אופניים|אופניים
sports|nba|nba|NBA|NBA
sports|ufc|ufc mma|UFC|UFC
sports|tournament|tournament tournaments|טורניר|טורניר טורנירים
sports|league|league|ליגה|ליגה
sports|championship|championship|אליפות|אליפות
sports|stadium|stadium|אצטדיון|אצטדיון איצטדיון
sports|athlete|athlete athletes|ספורטאי|ספורטאי ספורטאים
sports|players|player players coach|שחקנים|שחקן שחקנים מאמן
tips|money|money cash|כסף|כסף
tips|investing|invest investing investment investments stocks|השקעות|השקעה השקעות להשקיע מניות
tips|business|business businesses entrepreneur entrepreneurs customers|עסקים|עסק עסקים יזם יזמים לקוחות
tips|startups|startup startups founder founders|סטארטאפ|סטארטאפ סטארטאפים
tips|marketing|marketing|שיווק|שיווק
tips|productivity|productivity productive|פרודוקטיביות|פרודוקטיביות
tips|habits|habit habits|הרגלים|הרגל הרגלים
tips|sleep|sleep|שינה|שינה
tips|career|career careers|קריירה|קריירה
tips|salary|salary salaries|משכורת|משכורת שכר
tips|savings|saving savings budget|חיסכון|חיסכון תקציב
tips|realestate|mortgage apartment|נדלן|דירה משכנתא
tips|learning|learn learning study studying|למידה|למידה לימודים ללמוד
tips|ai|ai chatgpt|AI|AI
tips|tech|technology software|טכנולוגיה|טכנולוגיה תוכנה
tips|smartphone|iphone android smartphone|סמארטפון|סמארטפון אייפון אנדרואיד
tips|app|app apps|אפליקציה|אפליקציה אפליקציות
motivation|success|success successful|הצלחה|הצלחה מצליח מצליחים
motivation|discipline|discipline|משמעת|משמעת
motivation|mindset|mindset|מיינדסט|מיינדסט
motivation|dreams|dream dreams|חלומות|חלום חלומות
motivation|goals|goals|מטרות|מטרה מטרות יעדים
motivation|growth|growth|צמיחה|צמיחה התפתחות
motivation|failure|failure fail failed|כישלון|כישלון כישלונות
motivation|courage|courage|אומץ|אומץ
motivation|confidence|confidence|ביטחון|ביטחון
motivation|perseverance|perseverance persistence|התמדה|התמדה
prank|prank|prank pranks pranked|מתיחה|מתיחה מתיחות
comedy|humor|funny hilarious joke jokes|הומור|בדיחה בדיחות מצחיק מצחיקה הומור
comedy|standup|standup|סטנדאפ|סטנדאפ
comedy|laughter|laugh laughing laughter|צחוק|צחוק צוחק צוחקים
podcast|podcast|podcast podcasts|פודקאסט|פודקאסט
podcast|conversation|conversation|שיחה|שיחה
review|review|review reviews unboxing|ביקורת|ביקורת סקירה
review|price|price prices|מחיר|מחיר מחירים
vlog|travel|travel trip trips vacation|טיול|טיול טיולים חופשה נסיעה
vlog|hotel|hotel|מלון|מלון
vlog|flight|flight flights airport|טיסה|טיסה טיסות
vlog|beach|beach|חוף|חוף
vlog|israel|israel|ישראל|ישראל
life|family|family|משפחה|משפחה
life|kids|kids children|ילדים|ילד ילדים ילדה
life|baby|baby|תינוק|תינוק תינוקות
life|wedding|wedding|חתונה|חתונה
life|relationship|relationship relationships dating|זוגיות|זוגיות דייט
life|dog|dog dogs puppy|כלב|כלב כלבים גור
life|cat|cat cats|חתול|חתול חתולים
life|music|music song songs singer|מוזיקה|מוזיקה שיר שירים זמר
life|dance|dance dancing|ריקוד|ריקוד לרקוד
life|movie|movie movies film|סרט|סרט סרטים
life|gaming|gaming gamer|גיימינג|גיימינג גיימר
life|fashion|fashion outfit|אופנה|אופנה
life|beauty|makeup skincare|איפור|איפור
life|cars|car cars|רכב|רכב מכונית
life|health|health healthy|בריאות|בריאות בריא
`;

/** @type {Map<string, object>} צורה באנגלית -> נושא */
const TOPICS_EN = new Map();
/** @type {Map<string, object>} צורה בעברית (בלי גרש) -> נושא */
const TOPICS_HE = new Map();
for (const line of TOPIC_TABLE.split('\n')) {
  const parts = line.trim().split('|');
  if (parts.length < 5) continue;
  const [genre, enTag, enForms, heTag, heForms] = parts;
  const topic = {
    genre,
    en: '#' + enTag.toLowerCase(),
    he: '#' + (/^[A-Za-z]/.test(heTag) ? heTag.toLowerCase() : heTag),
  };
  topic.id = enTag;
  for (const f of enForms.split(/\s+/)) if (f) TOPICS_EN.set(f.toLowerCase(), topic);
  for (const f of heForms.split(/\s+/)) if (f) TOPICS_HE.set(f.replace(GERESH, '').toLowerCase(), topic);
}

/** תגיות מילוי לפי סוג, בשתי השפות, מהספציפי לכללי. */
export const GENRE_TAGS = {
  podcast: { he: ['#פודקאסט', '#פודקאסטישראלי', '#שיחה', '#תובנות', '#אנשים', '#השראה'], en: ['#podcast', '#podcastclips', '#conversation', '#insights', '#interview', '#podcastlife'] },
  food: { he: ['#אוכל', '#מתכון', '#טעים', '#אוכלישראלי', '#בישול', '#מתכונים'], en: ['#food', '#foodie', '#recipe', '#cooking', '#tasty', '#homemade'] },
  prank: { he: ['#מתיחה', '#מתיחות', '#צחוק', '#הומור', '#קטעיםמצחיקים', '#תגובות'], en: ['#prank', '#pranks', '#funnyvideos', '#comedy', '#reaction', '#humor'] },
  fitness: { he: ['#כושר', '#אימון', '#חדרכושר', '#בריאות', '#אורחחיים', '#מוטיבציה'], en: ['#fitness', '#workout', '#gym', '#health', '#training', '#fitnessmotivation'] },
  tips: { he: ['#טיפים', '#טיפיםשימושיים', '#תובנות', '#למידה', '#פיתוחאישי', '#ידע'], en: ['#tips', '#lifehacks', '#howto', '#knowledge', '#selfimprovement', '#productivity'] },
  motivation: { he: ['#מוטיבציה', '#השראה', '#פיתוחאישי', '#הצלחה', '#מיינדסט', '#חיובי'], en: ['#motivation', '#inspiration', '#mindset', '#success', '#selfimprovement', '#growth'] },
  comedy: { he: ['#קומדיה', '#הומור', '#מצחיק', '#סטנדאפ', '#צחוק', '#קטעיםמצחיקים'], en: ['#comedy', '#humor', '#funny', '#standup', '#jokes', '#funnyvideos'] },
  review: { he: ['#ביקורת', '#סקירה', '#מוצרים', '#קניות', '#המלצות', '#שווהלקנות'], en: ['#review', '#unboxing', '#productreview', '#honestreview', '#recommendations', '#worthit'] },
  vlog: { he: ['#ולוג', '#יומיום', '#חיים', '#טיול', '#לייפסטייל', '#יוםבחיים'], en: ['#vlog', '#dayinmylife', '#lifestyle', '#travel', '#minivlog', '#everyday'] },
  sports: { he: ['#ספורט', '#ספורטישראלי', '#משחק', '#אלופים', '#אימון', '#תחרות'], en: ['#sports', '#athlete', '#game', '#competition', '#training', '#highlights'] },
  general: { he: ['#סיפור', '#תובנות', '#השראה', '#חיים', '#לייפסטייל', '#תוכן'], en: ['#story', '#storytime', '#insights', '#life', '#lifestyle', '#content'] },
};

/** תגיות שאסור להחזיר: כלליות מדי, בלי קשר לתוכן. */
export const BANNED_TAGS = set(`#fyp #foryou #foryoupage #fypシ #viral #viralvideo #trending #trend #explore #explorepage #follow #followme #like #likes #love #instagood #instagram #tiktok
#reels #reel #instareels #video #videos #shortvideo #shortsvideo #youtubeshorts #fy #foryourpage #parati #ויראלי #טרנד #פורייו #אקספלור #לייק #עקבו #רילס #שורטס #טיקטוק #וידאו`);

const CTA = {
  he: {
    general: ['שלחו למישהו שצריך לשמוע את זה', 'שמרו לכם את זה לפעם הבאה', 'תייגו מישהו שחייב לראות את זה', 'מה דעתכם? כתבו בתגובות', 'אהבתם? שתפו עם חברים', 'עקבו כדי לא לפספס את הבא'],
    tips: ['שמרו את זה לפני שתשכחו', 'שלחו למישהו שצריך את הטיפ הזה', 'שמרו ונסו את זה היום', 'ידעתם? שתפו הלאה'],
    food: ['שלחו למי שרעב עכשיו', 'שמרו את זה לארוחה הבאה', 'תייגו מי שחייב לטעום את זה', 'ניסיתם? ספרו לנו בתגובות'],
    fitness: ['שמרו וצאו להתאמן', 'שלחו למי שמתאמן איתכם', 'תייגו מישהו שצריך את הדחיפה הזאת', 'שמרו את האימון הזה לפעם הבאה'],
    podcast: ['מסכימים? כתבו לנו בתגובות', 'שלחו למישהו שיתעניין בשיחה הזאת', 'עקבו לעוד קטעים מהשיחה', 'מה דעתכם? ספרו לנו בתגובות'],
    prank: ['שלחו למי שצריך לצחוק היום', 'תייגו מי שמגיעה לו מתיחה כזאת', 'מי הבא בתור? כתבו בתגובות', 'שתפו עם מי שצריך צחוק'],
    comedy: ['שלחו למי שצריך לצחוק היום', 'תייגו מישהו שמדבר ככה', 'מצחיק אתכם? שתפו הלאה', 'עקבו לעוד צחוקים'],
    motivation: ['שלחו למי שצריך את זה היום', 'שמרו וחזרו לזה כשקשה', 'תייגו מישהו שצריך את הכוח הזה', 'שתפו עם מי שלא מוותר'],
    sports: ['מי לדעתכם ינצח? כתבו בתגובות', 'תייגו את חברי הקבוצה שלכם', 'שתפו עם מי שאוהב את המשחק', 'עקבו לעוד רגעים כאלה'],
    review: ['ניסיתם? ספרו לנו בתגובות', 'שמרו לפני שאתם קונים', 'שלחו למי ששוקל לקנות', 'שווה או לא שווה? כתבו בתגובות'],
    vlog: ['רוצים עוד? עקבו כדי לא לפספס', 'ספרו לנו בתגובות לאן הייתם נוסעים', 'שלחו למי שהייתם לוקחים איתכם', 'שמרו לטיול הבא'],
    reels: ['שתפו לסטורי אם אהבתם', 'שלחו בהודעה למישהו שצריך את זה'],
    tiktok: ['שלחו למישהו שצריך את זה', 'שמרו ושתפו עם חברים'],
    shorts: ['הירשמו כדי לא לפספס את הבא', 'לייק ומנוי אם אהבתם'],
    youtube: ['הירשמו לערוץ כדי לא לפספס', 'לייק ותגובה אם זה עזר לכם'],
  },
  en: {
    general: ['Send this to someone who needs it', 'Save this for later', 'Tag someone who has to see this', 'What do you think? Tell us in the comments', 'Loved it? Share it with a friend', 'Follow for more'],
    tips: ['Save this before you forget', 'Send this to someone who needs the tip', 'Save it and try it today', 'Share it with someone who will use it'],
    food: ['Send this to someone who is hungry', 'Save this for your next meal', 'Tag someone who has to taste this', 'Tried it? Tell us in the comments'],
    fitness: ['Save this and go train', 'Send this to your workout partner', 'Tag someone who needs this push', 'Save this workout for next time'],
    podcast: ['Agree? Tell us in the comments', 'Send this to someone who will like this conversation', 'Follow for more clips', 'What do you think? Tell us in the comments'],
    prank: ['Send this to someone who needs a laugh', 'Tag someone who deserves this prank', 'Who is next? Tell us in the comments', 'Share it with someone who needs a laugh'],
    comedy: ['Send this to someone who needs a laugh', 'Tag a friend who talks like this', 'Made you laugh? Share it', 'Follow for more laughs'],
    motivation: ['Send this to someone who needs it today', 'Save this for the hard days', 'Tag someone who needs this strength', 'Share it with someone who never quits'],
    sports: ['Who wins? Tell us in the comments', 'Tag your teammates', 'Share it with someone who loves the game', 'Follow for more moments like this'],
    review: ['Tried it? Tell us in the comments', 'Save this before you buy', 'Send this to someone thinking about buying', 'Worth it or not? Tell us in the comments'],
    vlog: ['Want more? Follow so you do not miss it', 'Tell us in the comments where you would go', 'Send this to someone you would take along', 'Save this for your next trip'],
    reels: ['Share it to your story if you liked it', 'Send this in a message to someone who needs it'],
    tiktok: ['Send this to someone who needs it', 'Save it and share it with friends'],
    shorts: ['Subscribe so you do not miss the next one', 'Like and subscribe if you enjoyed it'],
    youtube: ['Subscribe to the channel so you do not miss out', 'Like and comment if this helped you'],
  },
};

// ---------------------------------------------------------------------------------------------- ניקוי דיבור

const SOUND_TAG = /^(?:music|applause|laughter|laughs|laughing|noise|inaudible|crosstalk|silence|singing|cheering|מוזיקה|מחיאות כפיים|צחוק|רעש)$/i;

/** מילה מהתמלול: טקסט נקי, ודגל turn כשהיא פותחת דובר חדש (">>"). מחזיר null למילה שהיא רק סימון. */
function cleanWord(raw) {
  let s = tidy(raw);
  let turn = false;
  if (/^>+/.test(s)) { turn = true; s = s.replace(/^>+\s*/, ''); }
  s = s.replace(/\[[^\]]*\]/g, '').replace(/[♪♫♬]+/g, '');
  s = s.replace(/\(([^)]{1,24})\)/g, (m, inner) => (SOUND_TAG.test(inner.trim()) ? '' : m)).trim();
  if (/^[-–—_*]+$/.test(s)) s = '';
  return { text: s, turn };
}

function wordList(transcript) {
  let list = Array.isArray(transcript?.words) ? transcript.words : [];
  if (!list.length && Array.isArray(transcript?.segments)) {
    list = [];
    for (const seg of transcript.segments) {
      const ws = tidy(seg.text).split(/\s+/).filter(Boolean);
      const a = +seg.start, b = +seg.end;
      if (!ws.length || !Number.isFinite(a) || !Number.isFinite(b)) continue;
      ws.forEach((text, i) => list.push({ text, start: a + ((b - a) * i) / ws.length, end: a + ((b - a) * (i + 1)) / ws.length, seg: true }));
    }
  }
  const out = [];
  let pendingTurn = false;
  for (const w of list) {
    const start = +w.start, end = +w.end;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const { text, turn } = cleanWord(w.text ?? w.word ?? '');
    if (!text) { pendingTurn = pendingTurn || turn; continue; }
    out.push({ text, start, end, turn: turn || pendingTurn });
    pendingTurn = false;
  }
  return out;
}

function segmentIndexer(transcript) {
  const segs = Array.isArray(transcript?.segments) ? transcript.segments.filter((s) => Number.isFinite(+s.start) && Number.isFinite(+s.end)) : [];
  return (t) => { for (let i = 0; i < segs.length; i++) if (t >= +segs[i].start - 0.02 && t <= +segs[i].end + 0.02) return i; return -1; };
}

function isSentenceEnd(text) {
  if (!SENT_END.test(text)) return false;
  const core = text.replace(/[^\p{L}\p{N}.]/gu, '').toLowerCase().replace(/\.+$/, '');
  if (ABBREV.has(core) && /^[A-Za-z]/.test(core)) return false;
  if (/^[A-Z]$/.test(text.replace(/[^A-Za-z.]/g, '').replace(/\.$/, ''))) return false;
  return true;
}

/** @returns {{text:string, words:object[], start:number, end:number}[]} */
function buildSentences(words, transcript) {
  if (!words.length) return [];
  const endings = words.filter((w) => isSentenceEnd(w.text)).length;
  const sparse = endings < Math.max(1, words.length / 45);
  const segOf = sparse ? segmentIndexer(transcript) : null;
  const out = [];
  let cur = [];
  const flush = () => { if (cur.length) out.push(cur); cur = []; };
  for (let i = 0; i < words.length; i++) {
    const w = words[i], prev = words[i - 1];
    if (cur.length) {
      const gap = w.start - prev.end;
      const segBreak = segOf && segOf(w.start) !== segOf(prev.start) && cur.length >= 3;
      if (w.turn || isSentenceEnd(prev.text) || (gap > (sparse ? 0.6 : 1.1) && cur.length >= 3) || segBreak) flush();
      else if (cur.length >= 34 && CLAUSE_END.test(prev.text)) flush();
    }
    cur.push(w);
  }
  flush();
  return out.map((ws) => ({ text: ws.map((w) => w.text).join(' '), words: ws, start: ws[0].start, end: ws[ws.length - 1].end }));
}

const DEDUPE_KEEP = set(`very so no yes really more many much ha הרבה מאוד כן לא`);

/** מסיר גמגומים: "it was it was" -> "it was", "I I think" -> "I think". */
function dedupeStutter(toks) {
  const norm = (t) => coreOf(t);
  let out = toks.slice();
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + 2 * n <= out.length; i++) {
      let same = true;
      for (let k = 0; k < n; k++) if (!norm(out[i + k]) || norm(out[i + k]) !== norm(out[i + n + k])) { same = false; break; }
      if (!same) continue;
      if (n === 1 && DEDUPE_KEEP.has(norm(out[i]))) continue;
      if (n === 1 && /^\d+$/.test(norm(out[i]))) continue;
      // המופע הראשון (הגמגום) יוצא; אם בו פיסוק, הפיסוק עובר לאחרון
      out.splice(i, n);
      i--;
    }
  }
  return out;
}

const LEAD_EN = /^(?:(?:and|so|but|then|now|well|okay|ok|yeah|yes|yep|right|all right|alright|mhm|um|uh|oh|like|honestly|basically|literally|actually|you know|i mean)\b[,]?\s+)+/i;
const LEAD_HE = /^(?:(?:ואז|אז|טוב|נו|אוקיי|אוקי|וואלה|כן|אבל|כי|אה|אממ|בקיצור|תכלס|כאילו|יעני)[,]?\s+)+/;

/** ניקוי משפט מהתמלול: מילות מילוי, גמגומים ופתיחים. רק הסרות, בלי להוסיף מילה. */
function cleanSentence(text, lang) {
  let toks = tidy(text).split(/\s+/).filter(Boolean);
  toks = toks.filter((t) => !FILLER_TOKEN.has(coreOf(t)));
  toks = dedupeStutter(toks);
  let s = toks.join(' ');
  if (lang === 'he') {
    s = s.replace(/,\s*(?:כאילו|בעצם|תכלס|יעני|נו|אתה יודע|אתם יודעים)\s*,/g, ' ');
    s = s.replace(/(^|[.!?]\s+)(?:כאילו|בעצם|תכלס|יעני|אתה יודע|אתם יודעים)\s*,?\s+/g, '$1');
    s = s.replace(LEAD_HE, '');
  } else {
    s = s.replace(/,\s*(?:you know|i mean|like|basically|honestly|literally)\s*,/gi, ' ');
    s = s.replace(/\s+(?:you know|i mean),\s+/gi, ' ');
    s = s.replace(LEAD_EN, '');
  }
  s = s.replace(/^[\s,;:–—\-"'“”]+/, '').replace(/\s+([,.;:!?…])/g, '$1').replace(/([,;:])\1+/g, '$1').replace(/\s+/g, ' ').trim();
  // מירכאות לא מאוזנות
  const q = (s.match(/["“”]/g) || []).length;
  if (q % 2) s = s.replace(/["“”]/g, '');
  return s;
}

/** אות ראשונה גדולה (אנגלית), "i" -> "I", כל־קאפס -> אותיות קטנות, וסימן סיום. */
function polish(text, lang, { end = true } = {}) {
  let s = text.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (lang !== 'he') {
    const letters = s.replace(/[^A-Za-z]/g, '');
    const upper = letters.replace(/[^A-Z]/g, '').length;
    if (letters.length >= 6 && upper / letters.length > 0.7) s = s.toLowerCase();
    s = s.replace(/\bi\b/g, 'I').replace(/\bi(?='(?:m|d|ll|ve)\b)/g, 'I');
    s = s.replace(/^([^\p{L}]*)(\p{Ll})/u, (m, a, b) => a + b.toUpperCase());
    s = s.replace(/([.!?]["'”]?\s+)(\p{Ll})/gu, (m, a, b) => a + b.toUpperCase());
  }
  // פיסוק סופי: פסיק, נקודתיים ודומיהם מוחלפים בנקודה; מילת קישור תלויה נמחקת
  s = s.replace(/[\s,;:–—\-]+$/, '');
  const weak = lang === 'he' ? WEAK_START_HE : WEAK_START_EN;
  let parts = s.split(' ');
  const dangling = (w) => weak.has(coreOf(w)) || /(?:'re|'m|'ll|'ve|'d)$/i.test(coreOf(w)) || weakEnd(coreOf(w));
  while (parts.length > 3 && dangling(parts[parts.length - 1]) && !SENT_END.test(parts[parts.length - 1])) parts.pop();
  s = parts.join(' ').replace(/[\s,;:–—\-]+$/, '');
  if (end && !SENT_END.test(s)) s += '.';
  return s;
}

// ---------------------------------------------------------------------------------------------- ניקוד משפטים ומילים

const contentWords = (text, lang) => tokens(text).filter((t) => t.length >= (isHeb(t) ? 2 : 3) && !isStop(t, lang) && !/^\d+$/.test(t));
const hasNumber = (text) => /\d/.test(text) || tokens(text).some((t) => NUMBER_WORDS.has(t));
const hasPromo = (text) => { const low = text.toLowerCase(); return PROMO.some((p) => low.includes(p)); };

function reactionOnly(text) {
  const toks = tokens(text);
  return !toks.length || toks.every((t) => REACTION_ONLY.has(t) || FILLER_TOKEN.has(t));
}

function mentionsSpeaker(text, lang) {
  const toks = tokens(text);
  if (toks.some((t) => FIRST_SECOND_EN.has(t) || FIRST_SECOND_HE.has(t))) return true;
  return lang === 'he' && toks.some((t) => /^[א-ת]{3,}(?:תי|תם|תן)$/.test(t));
}

function sentenceScore(s, lang, kwWeights) {
  const toks = tokens(s.clean);
  const n = toks.length;
  if (!n) return -9;
  const content = contentWords(s.clean, lang);
  let score = 2 * (content.length / n) + 0.5 * Math.min(1, content.length / 6);
  if (hasNumber(s.clean)) score += 0.4;
  if (toks.some((t) => EMOTION.has(t))) score += 0.35;
  if (kwWeights) { let k = 0; for (const t of new Set(content)) k += kwWeights.get(t) || 0; score += Math.min(0.8, 0.25 * k); }
  if (n >= 6 && n <= 22) score += 0.5; else if (n < 4) score -= 1.2; else if (n > 30) score -= 0.5;
  if (!s.complete) score -= 0.9;
  if (hasPromo(s.clean)) score -= 3;
  if (reactionOnly(s.clean)) score -= 3;
  const fillers = (s.text.match(/\b(?:um+|uh+|like|you know)\b/gi) || []).length;
  score -= 0.25 * fillers;
  return score;
}

// ---------------------------------------------------------------------------------------------- כותרת

/** תקצור כותרת ל־maxWords מילים בלי לחתוך באמצע ביטוי; כשנחתך באמצע משפט נוסף "…". */
export function shortTitle(text, { maxWords = MAX_TITLE_WORDS, maxChars = 60, ellipsis = true, anyStart = false } = {}) {
  let t = tidy(text).replace(/https?:\/\/\S+|www\.\S+/g, ' ').replace(/(^|\s)[#@][^\s#@]+/g, ' ').replace(/\*/g, '');
  t = t.replace(/\.{2,}|…/g, ' … ').replace(/([!?])[!?]+/g, '$1').replace(/\s+/g, ' ').trim();
  t = t.replace(/^[\s"'“”‘’«»„\-–—|/\\()[\]{}<>]+|[\s"'“”‘’«»„\-–—|/\\()[\]{}<>]+$/g, '').replace(/\s+…$/, '');
  t = t.replace(/\s+([,;:.!?])/g, '$1');
  const toks = t.split(' ').filter(Boolean);
  if (!toks.length) return '';
  const fits = (a, b) => b - a <= maxWords && toks.slice(a, b).join(' ').length <= maxChars;
  const finish = (a, b, cut) => {
    let out = toks.slice(a, b).join(' ');
    const last = out;
    out = out.replace(/[\s,;:–—\-.]+$/, '');
    if (cut && ellipsis && !CLAUSE_END.test(toks[b - 1]) && !SENT_END.test(toks[b - 1])) out += '…';
    return out || last;
  };
  const dropWeakTail = (a, b) => { while (b - a > 2 && weakEnd(coreOf(toks[b - 1])) && !SENT_END.test(toks[b - 1])) b--; return b; };
  if (fits(0, toks.length)) {
    const b = dropWeakTail(0, toks.length);
    return finish(0, b, b < toks.length);
  }
  let best = null;
  const n = toks.length;
  for (let i = 0; i < n; i++) {
    const boundary = i === 0 || CLAUSE_END.test(toks[i - 1]) || SENT_END.test(toks[i - 1]);
    if (!boundary && !anyStart) continue;
    // חלון שמתחיל באמצע משפט (לשער בלבד) לא יחתוך שלילה: "I did not like it" לא הופך ל־"like it"
    if (!boundary && (isStop(coreOf(toks[i])) || toks.slice(Math.max(0, i - 4), i).some((t) => NEGATIONS.has(coreOf(t))))) continue;
    for (let j = i + 2; j <= Math.min(n, i + maxWords); j++) {
      if (!fits(i, j)) break;
      const last = toks[j - 1], lc = coreOf(last);
      let s = 0.35 * (j - i);
      if (j === n) s += 1.0;
      else if (CLAUSE_END.test(last) || SENT_END.test(last)) s += 0.9;
      if (weakEnd(lc)) { if (!SENT_END.test(last)) s -= 1.6; }
      if (j < n && PREP_PREFIX.test(lc) && /^ה[א-ת]{2,}/.test(coreOf(toks[j]))) s -= 0.9;
      const first = coreOf(toks[i]);
      if (i > 0 && (WEAK_START_EN.has(first) || WEAK_START_HE.has(first))) s -= 0.8;
      if (j < n && UNITS.has(coreOf(toks[j])) && (/\d/.test(last) || NUMBER_WORDS.has(lc))) s -= 1.5;
      if (j < n && GLUE.some(([a, b]) => lc === a && coreOf(toks[j]) === b)) s -= 1.5;
      if (j < n && /\d/.test(last) && /^[A-Za-z%]/.test(toks[j])) s -= 0.3;
      // חיתוך שמשאיר מילה אחת עד סוף הפסוקית ("in the cold" | "rain,") או שבא אחרי תחילית שם עצם ("the cold") נראה שבור
      if (j < n && (CLAUSE_END.test(toks[j]) || SENT_END.test(toks[j])) && !CLAUSE_END.test(last)) s -= 1.2;
      if (j < n && j - i >= 3 && ARTICLES.has(coreOf(toks[j - 2])) && !CLAUSE_END.test(last)) s -= 0.8;
      let hype = 0, content = 0;
      for (let k = i; k < j; k++) { const c = coreOf(toks[k]); if (HYPE.has(c) || /\d/.test(c)) hype++; if (c && !isStop(c)) content++; }
      s += 0.25 * content + 0.3 * Math.min(2, hype);
      if (i > 0) s -= boundary ? 0.5 : 0.9;
      if (content < 2) s -= 1.2;
      if (!best || s > best.s + 1e-9) best = { s, i, j };
    }
  }
  if (!best) {
    let b = Math.min(n, maxWords);
    while (b > 1 && toks.slice(0, b).join(' ').length > maxChars) b--;
    best = { i: 0, j: b };
  }
  const cutAt = best.j < n;
  let out = finish(best.i, best.j, cutAt);
  if (cutAt && /\?$/.test(toks[n - 1]) === false) out = out.replace(/[?!]$/, (m) => m);
  return out;
}

const SUPERLATIVE = set(`הכי most ever least`);
const HIGHLIGHT_SKIP = set(`הכי מאוד ממש why how איך למה הכל הכול כולם`);
/**
 * המילה שמקבלת צבע הדגשה בכותרת: מספר; אחרת המילה שאחרי "הכי"/"most"; אחרת מילת הייפ; אחרת המילה התוכנית הארוכה ביותר (בתיקו הראשונה).
 * מחזיר אינדקס, או -1 לרשימה ריקה.
 */
export function highlightIndex(words) {
  if (!words || !words.length) return -1;
  const cores = words.map(coreOf);
  const num = (c) => /\d/.test(c) || (NUMBER_WORDS.has(c) && !['אחד', 'אחת', 'one'].includes(c));
  for (let k = words.length - 1; k >= 0; k--) if (num(cores[k])) return k;
  for (let k = 0; k < words.length - 1; k++) if (SUPERLATIVE.has(cores[k]) && cores[k + 1] && !isStop(cores[k + 1])) return k + 1;
  for (let k = words.length - 1; k >= 0; k--) if (HYPE.has(cores[k]) && !HIGHLIGHT_SKIP.has(cores[k])) return k;
  const verbish = (c) => isHeb(c) && /^(?:ש|וש|כש)?[א-ת]{2,}(?:תי|נו|תם|תן)$/.test(c);
  let best = -1, len = 0;
  cores.forEach((c, k) => { if (c && !isStop(c) && !HIGHLIGHT_SKIP.has(c) && !verbish(c) && c.length > len) { len = c.length; best = k; } });
  if (best < 0) cores.forEach((c, k) => { if (c && !isStop(c) && !HIGHLIGHT_SKIP.has(c) && c.length > len) { len = c.length; best = k; } });
  return best >= 0 ? best : words.length - 1;
}

function pickHook(moment, sentences, lang) {
  const raw = [moment?.hook, ...(Array.isArray(moment?.hooks) ? moment.hooks : [])];
  for (const h of raw) {
    if (typeof h !== 'string') continue;
    let c = tidy(h).replace(/\[[^\]]*\]/g, '').replace(/^>+\s*/, '').replace(/\s+/g, ' ').trim();
    c = cleanSentence(c, lang);
    const toks = tokens(c);
    if (toks.length >= 2 && contentWords(c, lang).length >= 1 && !hasPromo(c) && !reactionOnly(c)) return c;
  }
  // אין hook טוב: המשפט החזק ביותר ברגע, מהמחצית הראשונה בעדיפות
  let best = null;
  sentences.forEach((s, i) => {
    const c = s.clean;
    if (tokens(c).length < 3 || hasPromo(c) || reactionOnly(c)) return;
    const n = tokens(c).length;
    const sc = sentenceScore(s, lang) - 0.15 * i - 0.14 * Math.max(0, n - 8) + (n <= 8 ? 0.4 : 0);
    if (!best || sc > best.sc) best = { sc, c };
  });
  return best ? best.c : '';
}

function finalTitle(text, lang, P) {
  let t = shortTitle(text, { maxWords: MAX_TITLE_WORDS, maxChars: P.title });
  if (lang !== 'he') t = polish(t, lang, { end: false }).replace(/[,;:\-–—]+$/, '');
  t = t.replace(/[.,;:]+$/, '');
  return t;
}

// ---------------------------------------------------------------------------------------------- מילות מפתח והאשטגים

function normHe(word) { return word.replace(GERESH, '').toLowerCase(); }

/** נושא מהלקסיקון לטוקן (אנגלית: גם ריבוי; עברית: אחרי הסרת אותיות שימוש), או null. */
function topicOf(token) {
  if (!token) return null;
  if (isHeb(token)) {
    const w = normHe(token);
    if (TOPICS_HE.has(w)) return TOPICS_HE.get(w);
    for (const st of hePrefixStems(w, 3)) if (TOPICS_HE.has(st)) return TOPICS_HE.get(st);
    return null;
  }
  const w = token.toLowerCase().replace(GERESH, '');
  return TOPICS_EN.get(w) || TOPICS_EN.get(w.replace(/s$/, '')) || TOPICS_EN.get(w.replace(/es$/, '')) || TOPICS_EN.get(w.replace(/ing$/, '')) || null;
}

const VERBISH_HE = /(?:תי|תם|תן|נו|ים?תי)$/;
const WEAK_KEYWORDS_EN = set(`doing going thing things think know want make making take taking come coming look looking tell telling talk talking really actually something everything anything
nothing great good best better little right left wrong whole feeling felt feel feels learn learned watch watched watching play playing played never always ever move moved moves step steps
start started starts begin began full entire either neither among along already enough often once twice away stuff while without within around`);

/**
 * מילות מפתח של הטקסט: נושאים מהלקסיקון, שמות פרטיים (אנגלית), ומילים חוזרות.
 * @returns {{topics:{topic:object, weight:number}[], names:string[], words:{word:string, tag:string, count:number}[], weights:Map<string,number>}}
 */
export function keywordsOf(text, _lang, { context = '' } = {}) {
  const sentences = String(text).split(/(?<=[.!?…])\s+/);
  const counts = new Map();   // טוקן -> ספירה
  const topicW = new Map();   // נושא -> משקל
  const names = new Map();    // שם -> ספירה
  const surface = new Map();
  for (const sent of sentences) {
    const clean = tidy(sent);
    const found = [...clean.matchAll(WORD_RE)];
    const raw = found.map((m) => m[0]);
    // פסיק או סימן אחר בין שתי מילים שוברים רצף שם פרטי ("Buford, Georgia" הם שני שמות)
    const gapBefore = found.map((m, k) => (k === 0 ? false : /[,;:.!?—–()"“”]/.test(clean.slice(found[k - 1].index + found[k - 1][0].length, m.index))));
    let run = [];
    const flush = () => { if (run.length) { const nm = run.map((r) => r.toLowerCase()).join(''); names.set(nm, (names.get(nm) || 0) + 1); } run = []; };
    raw.forEach((w, idx) => {
      const core = coreOf(w);
      if (!core) return;
      if (gapBefore[idx]) flush();
      const tp = topicOf(core);
      if (tp) topicW.set(tp, (topicW.get(tp) || 0) + 1);
      if (!isHeb(core) && idx > 0 && /^\p{Lu}/u.test(w) && !/^\p{Lu}+$/u.test(w) && core.length >= 3 && !stopEn(core) && !ABBREV.has(core)) run.push(core);
      else flush();
      if (isStop(core) || core.length < (isHeb(core) ? 3 : 4) || /^\d+$/.test(core)) return;
      counts.set(core, (counts.get(core) || 0) + 1);
      if (!surface.has(core)) surface.set(core, w);
    });
    flush();
  }
  const ctxCounts = new Map();
  for (const t of tokens(context)) if (counts.has(t)) ctxCounts.set(t, (ctxCounts.get(t) || 0) + 1);
  const hebSet = new Set([...counts.keys()].filter(isHeb));
  const words = [];
  for (const [core, count] of counts) {
    if (topicOf(core)) continue;
    const heb = isHeb(core);
    let tag = null;
    if (heb) {
      if (VERBISH_HE.test(core) || core.length > 14) continue;
      const first = core[0];
      const prefixLike = 'וכלמבש'.includes(first);
      // אות הידיעה לא נחתכת בלי הוכחה; אות שימוש אחרת נחתכת רק אם המילה מופיעה גם בלעדיה
      let base = core;
      if (first === 'ה' && core.length >= 5 && hebSet.has(core.slice(1))) base = core.slice(1);
      else if (prefixLike) {
        const bare = [...hebSet].find((o) => o !== core && o.length >= 3 && o.length < core.length && core.endsWith(o) && HE_PREFIX_RE.test(core.slice(0, core.length - o.length)));
        if (bare) base = bare;
        else if (![...hebSet].some((o) => o !== core && o.length > core.length && o.endsWith(core) && HE_PREFIX_RE.test(o.slice(0, o.length - core.length)))) continue;
      }
      if (NUMBER_WORDS.has(base)) continue;
      if (base === core && count < (first === 'ה' ? 3 : 2)) continue;
      tag = '#' + base;
    } else {
      if (WEAK_KEYWORDS_EN.has(core) || core.endsWith('ly') || core.length > 16) continue;
      if (count < 2) continue;
      tag = '#' + core;
    }
    words.push({ word: surface.get(core) || core, tag, count: count + 0.25 * (ctxCounts.get(core) || 0) });
  }
  words.sort((a, b) => b.count - a.count || b.word.length - a.word.length);
  const weights = new Map();
  for (const w of words) weights.set(coreOf(w.word), Math.min(2, w.count / 2));
  for (const t of tokens(text)) if (topicOf(t)) weights.set(t, 1.5);
  const topics = [...topicW].map(([topic, weight]) => ({ topic, weight })).sort((a, b) => b.weight - a.weight || (a.topic.id < b.topic.id ? -1 : 1));
  const nameList = [...names].filter(([n]) => n.length >= 3 && n.length <= 24).sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).map(([n]) => n);
  return { topics, names: nameList, words, weights };
}

/** הסוג שנבחר: מה שהמשתמש ביקש, או הסוג עם רוב הנושאים בטקסט. */
export function resolveGenre(requested, topics) {
  if (requested && requested !== 'auto' && GENRE_TAGS[requested]) return requested;
  const score = {};
  for (const { topic, weight } of topics || []) if (topic.genre !== 'life') score[topic.genre] = (score[topic.genre] || 0) + weight;
  let best = null;
  for (const [g, s] of Object.entries(score)) if (!best || s > best.s) best = { g, s };
  return best && best.s >= 2 ? best.g : 'general';
}

const tagKey = (t) => t.toLowerCase();
const isLatinTag = (t) => !isHeb(t);

function buildHashtags({ kw, genre, lang, platform, P }) {
  const [min, max] = P.hashtags;
  const out = [];
  let relax = false;
  const add = (tag) => {
    if (!tag || tag.length < 3 || tag.length > 30 || /[^#\p{L}\p{N}]/u.test(tag)) return false;
    const key = tagKey(tag);
    if (BANNED_TAGS.has(key) || out.some((o) => tagKey(o) === key)) return false;
    // לא שתי תגיות שאחת מהן קידומת של השנייה (#recipe ו־#recipes, #משחק ו־#המשחק); בהשלמה אחרונה (relax) מתירים קידומת
    const loose = (t) => t.toLowerCase().replace(/^#ה(?=[\u05D0-\u05EA]{3,})/, '#');
    if (!relax && out.some((o) => { const a = loose(o), b = loose(tag); return a === b || (b.length >= 5 && (a.startsWith(b) || b.startsWith(a))); })) return false;
    if (lang === 'he' && isLatinTag(tag) && out.filter(isLatinTag).length >= 2) return false;
    if (lang !== 'he' && isHeb(tag)) return false;
    out.push(tag);
    return true;
  };
  const tagOf = (tp) => (lang === 'he' ? tp.he : tp.en);
  const topicTags = kw.topics.map((t) => tagOf(t.topic));
  const pool = (GENRE_TAGS[genre] || GENRE_TAGS.general)[lang === 'he' ? 'he' : 'en'];
  const general = GENRE_TAGS.general[lang === 'he' ? 'he' : 'en'];
  // סדר: נושאים מהטקסט (הכי ספציפיים), שם פרטי, מילות מפתח חוזרות, ורק אחר כך תגיות הסוג שמשלימות
  for (const t of topicTags) { if (out.length >= Math.max(3, max - 2)) break; add(t); }
  if (kw.names[0]) add('#' + kw.names[0]);
  for (const w of kw.words.slice(0, 2)) { if (out.length >= max - 1) break; add(w.tag); }
  for (const t of topicTags) { if (out.length >= max - 1) break; add(t); }
  let k = 0;
  while (out.length < Math.min(max, 5) && k < pool.length) add(pool[k++]);
  if (platform === 'shorts' && out.length >= 3) out.splice(Math.min(3, out.length), 0, '#shorts');
  else if (platform === 'shorts') out.push('#shorts');
  for (const w of kw.words.slice(2)) { if (out.length >= max) break; add(w.tag); }
  if (kw.names[1]) { if (out.length < max) add('#' + kw.names[1]); }
  while (out.length < max && k < pool.length) add(pool[k++]);
  // השלמה למינימום: קודם הכלליות, ואם עדיין חסר, גם צורות שהן קידומת של תגית שכבר יש
  for (const t of general) { if (out.length >= min) break; add(t); }
  relax = true;
  for (const t of [...pool, ...general]) { if (out.length >= min) break; add(t); }
  // אם יצאנו מעל התקרה (כולל #shorts שהוכנס), חותכים מהסוף ושומרים את #shorts
  while (out.length > max) {
    const idx = out.lastIndexOf('#shorts');
    let drop = out.length - 1;
    if (drop === idx) drop--;
    out.splice(drop, 1);
  }
  return out.slice(0, max);
}

// ---------------------------------------------------------------------------------------------- תיאור

function fitText(text, maxChars, lang) {
  if (text.length <= maxChars) return text;
  // חיתוך בגבול פסוקית (פסיק, נקודתיים, מקף) שמשאיר לפחות ארבע מילים
  const pieces = text.split(/(?<=[,;:–—])\s+/);
  let acc = '';
  for (const p of pieces) {
    const next = acc ? acc + ' ' + p : p;
    if (next.replace(/[,;:–—\s]+$/, '').length + 1 > maxChars) break;
    acc = next;
  }
  if (tokens(acc).length >= 4) return polish(acc.replace(/[,;:–—\s]+$/, ''), lang);
  const cut = text.slice(0, maxChars - 1);
  const toks = cut.split(' ');
  toks.pop();
  while (toks.length > 3 && weakEnd(coreOf(toks[toks.length - 1]))) toks.pop();
  return toks.join(' ').replace(/[,;:–—\s.]+$/, '') + '…';
}

function buildDescription(sentences, titleText, lang, P, kw) {
  const titleStems = new Set(contentWords(titleText, lang).map(stem));
  const cands = [];
  sentences.forEach((s, i) => {
    const toks = tokens(s.clean);
    if (toks.length < 3 || hasPromo(s.clean) || reactionOnly(s.clean) || contentWords(s.clean, lang).length < 2) return;
    const own = contentWords(s.clean, lang).map(stem);
    const overlap = own.length ? own.filter((w) => titleStems.has(w)).length / own.length : 0;
    cands.push({ s, i, overlap, score: sentenceScore(s, lang, kw.weights) - (overlap > 0.7 ? 2.5 : overlap > 0.5 ? 1 : 0) - 0.05 * i });
  });
  if (!cands.length) return '';
  cands.sort((a, b) => b.score - a.score || a.i - b.i);
  const max = P.description;
  const budget = max - 2;       // שני תווים שמורים למירכאות, כשהתיאור כולו בגוף ראשון
  const chosen = [];
  let used = 0;
  for (const c of cands) {
    if (chosen.length >= 2) break;
    const text = polish(c.s.clean, lang);
    const room = chosen.length ? budget - used - 1 : budget;
    if (chosen.length && text.length > room) continue;
    if (!chosen.length || c.score > cands[0].score - 2.2) {
      const fitted = fitText(text, chosen.length ? room : budget, lang);
      if (!tokens(fitted).length) continue;
      chosen.push({ i: c.i, text: fitted });
      used += fitted.length + (chosen.length > 1 ? 1 : 0);
    }
  }
  chosen.sort((a, b) => a.i - b.i);
  let out = chosen.map((c) => c.text).join(' ');
  if (mentionsSpeaker(out, lang)) {
    const inner = out.replace(/["“”]/g, "'");
    out = '"' + (inner.length <= max - 2 ? inner : fitText(inner, max - 2, lang)) + '"';
  }
  return out;
}

const stem = (w) => (isHeb(w) ? w.replace(/(?:ים|ות)$/, '') : w.replace(/(?:ing|ed|es|s|ly)$/, '')).slice(0, 5);

// ---------------------------------------------------------------------------------------------- קריאה לפעולה

function pickCta(genre, lang, platform, seed) {
  const table = CTA[lang === 'he' ? 'he' : 'en'];
  const own = table[genre] || [];
  // הסוג מקבל את רוב המשקל; הפלטפורמה והקריאות הכלליות משלימות, כדי שלא כל הקליפים ישמעו אותו דבר
  const weighted = [...own, ...own, ...(table[platform] || []), ...table.general.slice(0, 3)];
  return weighted[hash(seed) % weighted.length];
}

// ---------------------------------------------------------------------------------------------- הפונקציה הראשית

function momentRange(words, moment) {
  const a = Number(moment?.start), b = Number(moment?.end);
  if (Number.isFinite(a) && Number.isFinite(b) && b > a) return { start: a, end: b };
  if (!words.length) return { start: 0, end: 0 };
  return { start: words[0].start, end: words[words.length - 1].end };
}

/**
 * @param {{language?:string, words?:{text:string,start:number,end:number}[], segments?:{text:string,start:number,end:number}[]}} transcript
 * @param {{start:number,end:number,hook?:string,hooks?:string[]}} moment
 * @param {{lang?:'he'|'en', genre?:string, platform?:'tiktok'|'reels'|'shorts'|'youtube', seed?:string|number}} [opts]
 * @returns {{title:string, description:string, hashtags:string[], cta:string, lang:'he'|'en', genre:string, platform:string, keywords:string[]}}
 */
export function makePost(transcript, moment, opts = {}) {
  const platform = PLATFORMS[opts.platform] ? opts.platform : DEFAULT_PLATFORM;
  const P = PLATFORMS[platform];
  const all = wordList(transcript);
  const range = momentRange(all, moment);
  const near = all.filter((w) => w.end > range.start - 6 && w.start < range.end + 6);
  const sentencesAll = buildSentences(near, transcript);
  const inRange = (w) => { const mid = (w.start + w.end) / 2; return mid >= range.start - 0.05 && mid <= range.end + 0.05; };
  let sentences = sentencesAll.map((s) => {
    const ws = s.words.filter(inRange);
    return { ...s, words: ws, inside: ws.length / s.words.length, complete: ws.length === s.words.length };
  }).filter((s) => s.words.length && s.inside >= 0.5);
  const ctxText = all.map((w) => w.text).join(' ');
  const rawText = sentences.map((s) => s.words.map((w) => w.text).join(' ')).join(' ') || ctxText;
  const textLang = detectLang(rawText || [moment?.hook, ...(moment?.hooks || [])].join(' '), transcript?.language);
  const lang = textLang === 'he' ? 'he' : textLang === 'en' ? 'en' : (opts.lang === 'he' ? 'he' : 'en');
  sentences = sentences.map((s) => {
    const text = s.words.map((w) => w.text).join(' ');
    return { ...s, text, clean: cleanSentence(text, lang) };
  });
  const hook = pickHook(moment, sentences, lang);
  if (!hook && !sentences.length) throw new Error('אין תמלול ליצירת פוסט. בדקו שהתמלול מכיל את הרגע שנבחר.');
  const title = finalTitle(hook || sentences.find((x) => x.clean)?.clean || sentences[0]?.text || '', lang, P);
  if (!title) throw new Error('אין תמלול ליצירת פוסט. בדקו שהתמלול מכיל את הרגע שנבחר.');
  const momentText = sentences.map((s) => s.clean).join(' ') || hook;
  const kw = keywordsOf(momentText, lang, { context: ctxText });
  if (kw.topics.length < 2 && ctxText.length > momentText.length) {
    // רגע קצר: נושאי הסרטון כולו משלימים את התגיות (בעדיפות נמוכה)
    const wide = keywordsOf(ctxText, lang);
    for (const t of wide.topics) if (t.weight >= 4 && !kw.topics.some((x) => x.topic === t.topic)) kw.topics.push({ topic: t.topic, weight: t.weight * 0.25 });
  }
  const genre = resolveGenre(opts.genre, kw.topics);
  let description = buildDescription(sentences, title, lang, P, kw);
  if (!description && hook) description = fitText(polish(hook, lang), P.description, lang);
  const hashtags = buildHashtags({ kw, genre, lang, platform, P });
  const seed = String(opts.seed ?? '') + '|' + platform + '|' + title + '|' + description;
  const cta = pickCta(genre, lang, platform, seed);
  const keywords = [...kw.topics.slice(0, 3).map((t) => (lang === 'he' ? t.topic.he : t.topic.en).slice(1)), ...kw.names.slice(0, 2), ...kw.words.slice(0, 3).map((w) => w.word)];
  return { title, description, hashtags, cta, lang, genre, platform, keywords: [...new Set(keywords)] };
}

// ---------------------------------------------------------------------------------------------- הרכבה ובדיקה

/**
 * הטקסט המוכן להדבקה. בטיקטוק וברילס אין שדה כותרת, אז הכותרת היא השורה הראשונה והכול בשדה אחד;
 * ביוטיוב ובשורטס הכותרת נפרדת והתיאור כולל את הקריאה לפעולה ואת ההאשטגים.
 * @returns {{title:string, body:string}}
 */
export function composeCaption(post, platform = DEFAULT_PLATFORM) {
  const P = PLATFORMS[platform] || PLATFORMS[DEFAULT_PLATFORM];
  const tail = [post.cta, (post.hashtags || []).join(' ')].filter(Boolean).join('\n\n');
  const join = (parts) => parts.filter(Boolean).join('\n\n');
  if (platform === 'tiktok' || platform === 'reels' || !PLATFORMS[platform]) {
    let body = join([post.title, post.description, tail]);
    if (body.length > P.caption) body = join([post.title, tail]);
    return { title: '', body: body.slice(0, P.caption) };
  }
  let body = join([post.description, tail]);
  if (body.length > P.caption) body = tail;
  return { title: post.title.slice(0, P.titleHard), body: body.slice(0, P.caption) };
}

// צורות יחיד של פנייה (זכר ונקבה) שאסור שיופיעו בקריאה לפעולה בעברית
const SINGULAR_HE = /(?:^|\s)(?:אתה|שלך|לך|אליך|איתך|שלח|שלחי|תשלח|תשלחי|שתף|שתפי|תשתף|תשתפי|שמור|שמרי|תשמור|תשמרי|תייג|תייגי|תתייג|תתייגי|הירשם|הירשמי|תירשם|תירשמי|עקוב|עקבי|תעקוב|תעקבי|כתוב|כתבי|תכתוב|תכתבי|ספרי|תספר|תספרי|תגיב|תגיבי|ענית|ראית|ניסית|אהבת|חשבת|ידעת|הצטרף|הצטרפי|בואי|תבוא|תבואי|לחצי)(?=\s|$|[?!.,])/;
// כתיב חסר נפוץ במילים שהתבניות והתגיות משתמשות בהן (הכתיב התקין בסוגריים בתיעוד הבדיקה)
const HASER = ['מוסיקה', 'חסכון', 'אפלקציה', 'איפון', 'תנוק', 'בשול', 'סטק', 'וידיאו', 'מישהוא', 'תיגו', 'שיתפו', 'הרשמו', 'לספספס'];

/**
 * בדיקת תקינות של פוסט שנוצר: אורכים לפי הפלטפורמה, מספר האשטגים, פנייה ברבים וכתיב. מחזיר רשימת בעיות בעברית (ריקה כשהכול תקין).
 */
export function checkPost(post, platform = DEFAULT_PLATFORM) {
  const P = PLATFORMS[platform] || PLATFORMS[DEFAULT_PLATFORM];
  const problems = [];
  if (!post || typeof post !== 'object') return ['הפוסט חסר'];
  const { title = '', description = '', hashtags = [], cta = '' } = post;
  if (!title) problems.push('אין כותרת');
  if (title.length > P.titleHard) problems.push(`הכותרת ארוכה מדי (${title.length} מתוך ${P.titleHard})`);
  else if (title.length > P.title) problems.push(`הכותרת ארוכה מהמומלץ (${title.length} מתוך ${P.title})`);
  if (title.split(/\s+/).filter(Boolean).length > MAX_TITLE_WORDS) problems.push(`בכותרת יותר מ־${MAX_TITLE_WORDS} מילים`);
  if (description.length > P.description) problems.push(`התיאור ארוך מדי (${description.length} מתוך ${P.description})`);
  if (hashtags.length < P.hashtags[0] || hashtags.length > P.hashtags[1]) problems.push(`מספר ההאשטגים (${hashtags.length}) מחוץ לטווח המותר, בין ${P.hashtags[0]} ל־${P.hashtags[1]}`);
  if (new Set(hashtags.map(tagKey)).size !== hashtags.length) problems.push('יש האשטג כפול');
  for (const h of hashtags) {
    if (!/^#[\p{L}\p{N}]{2,29}$/u.test(h)) problems.push(`האשטג לא תקין: ${h}`);
    if (BANNED_TAGS.has(tagKey(h))) problems.push(`האשטג גנרי מדי: ${h}`);
  }
  const caption = composeCaption(post, platform);
  if ((caption.title + caption.body).length > P.caption + P.titleHard) problems.push('הטקסט כולו ארוך מהמותר בפלטפורמה');
  if (isHeb(cta) || post.lang === 'he') {
    if (SINGULAR_HE.test(cta)) problems.push('הקריאה לפעולה בפנייה ליחיד או ליחידה ולא ברבים');
    for (const bad of HASER) if (cta.includes(bad) || hashtags.some((h) => h.includes(bad))) problems.push(`כתיב חסר: ${bad}`);
  }
  if (!cta) problems.push('אין קריאה לפעולה');
  return problems;
}

/** כל טקסטי התבניות בעברית (לבדיקות כתיב ופנייה). */
export function _hebrewTemplates() {
  return { cta: Object.values(CTA.he).flat(), tags: Object.values(GENRE_TAGS).flatMap((g) => g.he), topics: [...new Set([...TOPICS_HE.values()].map((t) => t.he))] };
}
export const _internal = { cleanSentence, polish, buildSentences, wordList, topicOf, fitText, cleanWord, TOPICS_HE, TOPICS_EN, CTA, SINGULAR_HE, HASER, stem, isSentenceEnd, sentenceScore };
