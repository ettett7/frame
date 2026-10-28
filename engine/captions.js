// FRAME לטלפון: כתוביות מונפשות על Canvas 2D (סוכן 5).
// מעביר את מה שנבנה ב־captions_v2.py (מנוע הכתוביות במק) לגרסה קלה ומהירה לדפדפן של הטלפון:
// אותן קבוצות, אותו חיתוך שורות, אותה בחירת מילות מפתח ואותו מראה, אבל כל מילה מצוירת מ־sprite מוכן (OffscreenCanvas),
// כך שציור פריים הוא כמה קריאות drawImage בלבד.
//
// הממשק (ראו mobile/CONTRACT.md):
//   const prepared = prepareCaptions(spec);   // סינכרוני; מתחיל לטעון את הגופנים ומחזיר מיד
//   await prepared.ready;                     // חובה לפני הציור הראשון: גופנים + פריסה + sprites של הקבוצות הראשונות (drawCaptions לא מצייר דבר לפני כן)
//   await prepared.warm(t0, t1);              // אופציונלי: בונה מראש sprites של טווח זמן (שניות פלט), כך שאין שום בנייה בזמן ציור (לייצוא או לניגון חלק)
//   drawCaptions(ctx, tOut, prepared);        // מצייר פריים אחד על קנבס בגודל הפלט (spec.width x spec.height), בזמן פלט בשניות; מחזיר true אם צויר משהו
//   prepared.dispose();                       // משחרר זיכרון (sprites)
//   STYLES / styleList()                      // הסגנונות עם שמות בעברית (STYLES[id].name); STYLE_IDS = רשימת המזהים
//   pickKeywords(words, lang)                 // אינדקסים של מילות מפתח, אותה לוגיקה כמו במק; spec.keywords יכול להיות רשימה, או true לבחירה אוטומטית
//   loadFonts()                               // טעינת Heebo ו־Rubik מ־engine/fonts (נקרא אוטומטית מ־prepareCaptions)
//
// spec = CaptionSpec: {width, height, fps, duration, words:[{text,start,end}] (זמני פלט), style, hook:{text,seconds}|null, emoji, keywords, safeZone:{top,bottom,left,right}|null, direction, splits:[{start,end}]}
// הציור כולו בפיקסלים של spec.width x spec.height. אם הקנבס בגודל אחר, צריך להכין את ה־spec בגודל הקנבס (הפריסה מתאימה את עצמה).
// ES module בלי תלות חיצונית. כל הפונקציות הטהורות (קבוצות, שורות, מילות מפתח, תזמון, RTL) עובדות גם ב־node.

export const VERSION = 1;

// Data tables generated from captions_v2.py (the Mac renderer) so both engines pick the same words.
const STOP = new Set(["a", "about", "after", "all", "also", "an", "and", "any", "are", "as", "at", "be", "because", "been", "before", "being", "but", "by", "can", "could", "did", "do", "does", "don't", "each", "every", "for", "from", "had", "has", "have", "he", "her", "here", "his", "how", "i", "i'd", "i'll", "i'm", "i've", "if", "in", "into", "is", "it", "it's", "its", "just", "more", "most", "my", "no", "not", "of", "on", "or", "our", "over", "really", "she", "since", "so", "some", "than", "that", "the", "their", "then", "there", "these", "they", "this", "those", "to", "too", "under", "very", "was", "we", "were", "what", "when", "where", "which", "while", "who", "why", "will", "with", "would", "you", "your", "אבל", "או", "אז", "איך", "אין", "אל", "אלה", "אלו", "אם", "אנחנו", "אני", "את", "גם", "הוא", "הזאת", "הזה", "היא", "היה", "היו", "הם", "הן", "זה", "זו", "יש", "כבר", "כי", "כך", "ככה", "כל", "כמו", "לא", "להיות", "למה", "מאוד", "מה", "מי", "עוד", "על", "עם", "פה", "רק", "של", "שם"]);
const MONEY = new Set(["billion", "bucks", "dollar", "dollars", "free", "million", "percent", "thousand", "אחוז", "אחוזים", "אלף", "דולר", "דולרים", "חינם", "מיליארד", "מיליון", "שקל", "שקלים"]);
const STRONG_EN = new Set(["afraid", "always", "amazing", "awesome", "banned", "beautiful", "best", "biggest", "billion", "brilliant", "broke", "brutal", "champion", "champions", "crazy", "dangerous", "dead", "disaster", "epic", "everyone", "fake", "fear", "finally", "forever", "free", "genius", "greatest", "guaranteed", "hate", "huge", "hundred", "illegal", "impossible", "incredible", "insane", "instantly", "killed", "legendary", "lie", "lies", "lost", "love", "massive", "million", "miracle", "never", "nobody", "perfect", "proof", "rich", "secret", "secrets", "shocking", "stupid", "suddenly", "terrifying", "thousand", "truth", "unbelievable", "unbelievably", "victory", "winner", "won", "worst"]);
const STRONG_HE = new Set(["אגדי", "אדיר", "אדירה", "אהבה", "אהבתי", "אחד", "איום", "אלוף", "אלף", "אמת", "אסון", "אסור", "אסורה", "אף", "גאון", "הוכחה", "הכי", "הפסדנו", "הרג", "חינם", "יפה", "ישראל", "כולם", "לנצח", "מאה", "מדהים", "מובטח", "מזויף", "מטורף", "מטורפים", "מטורפת", "מיליארד", "מיליון", "מנצח", "מסוכן", "מפחיד", "מפחידה", "מת", "נורא", "ניצחון", "ניצחנו", "נס", "סוד", "סודות", "סוף", "פחד", "פעם", "פתאום", "שנאה", "שקר", "תמיד"]);
const EMOTION_EN = new Set(["believe", "how", "listen", "look", "no", "omg", "remember", "stop", "trust", "wait", "what", "why", "wow", "yes"]);
const EMOTION_HE = new Set(["איך", "וואו", "חכו", "למה", "מה", "תאמינו", "תזכרו", "תעצרו", "תקשיבו", "תראו"]);
const NUM_WORDS = new Set(["billion", "eight", "eighty", "eleven", "fifty", "first", "five", "forty", "four", "hundred", "million", "nine", "ninety", "one", "second", "seven", "seventy", "six", "sixty", "ten", "third", "thirty", "thousand", "three", "trillion", "twelve", "twenty", "two", "אחד", "אחת", "אלף", "ארבע", "ארבעה", "ארבעים", "חמישה", "חמישים", "חמש", "מאה", "עשר", "עשרה", "עשרים", "שבע", "שבעה", "שישה", "שלוש", "שלושה", "שלושים", "שמונה", "שניים", "שש", "שתיים", "תשע", "תשעה"]);
const EMOJI_DATA = `💰 money cash dollar rich salary paid pay millionaire billion million wealth profit income כסף מזומן דולר עשיר משכורת מיליונר מיליון מיליארד עושר הכנסה רווח שקל
🤑 expensive greedy luxury יקר חמדן יוקרה
❤️ love loved heart romance lover wedding married אהבה אוהב אהוב לב רומנטי חתונה נשוי אהבתי
😍 beautiful gorgeous pretty cute stunning יפה מהמם חמוד יפהפה
🔥 fire hot lit burning flame fiery אש חם בוער להבה לוהט
🤯 crazy insane unbelievable wow mindblowing shocking wild מטורף משוגע וואו מטורפים בלתי שוגע מדהים
😂 laugh funny lol hilarious joke comedy haha laughing צוחק מצחיק צחוק בדיחה קומדיה חחח
🏆 win won winner champion trophy victory champions title ניצחון נצחון מנצח אלוף גביע תואר זוכה
🥇 gold ראשון זהב
🏅 medal olympic olympics מדליה אולימפי אולימפיאדה
⚽ goal soccer striker penalty גול כדורגל חלוץ פנדל
⚾ baseball pitch pitcher homerun batter innings בייסבול הטלה מגיש
🏀 basketball dunk nba כדורסל סל
🏈 touchdown nfl quarterback
🎾 tennis טניס
⛳ golf גולף
🥊 fight boxing punch boxer קרב אגרוף מתאגרף
🏎️ race racing speedway מירוץ מרוץ מרוצים
🚗 car cars drive driving driver vehicle truck מכונית רכב נהיגה נוהג משאית
✈️ plane flight fly flying airport travel trip airline מטוס טיסה טס שדה נסיעה טיול
🚀 rocket launch startup spacex space טיל שיגור סטארטאפ חלל
🌍 world earth global planet עולם כדור
🏖️ beach vacation holiday island חוף חופשה נופש אי
🌊 ocean sea wave waves surf ים גל גלים גלישה
⛰️ mountain hike hiking climb climbing הר טיפוס טיול
🌲 forest tree trees nature יער עץ עצים טבע
🌸 flower flowers spring פרח פרחים אביב
☀️ sun sunny summer שמש שמשי קיץ
🌧️ rain rainy storm גשם סערה
❄️ snow winter cold שלג חורף
🥶 freezing frozen קפוא קר
🌙 night moon midnight לילה ירח חצות
🌅 morning sunrise dawn בוקר זריחה שחר
🍔 food burger eat eating hungry dinner lunch meal אוכל המבורגר לאכול אוכלים רעב ארוחה צהריים
🍕 pizza פיצה
☕ coffee cafe espresso קפה אספרסו
🍺 beer pub בירה פאב
🍷 wine יין
🎂 birthday cake עוגה
🎁 gift present giveaway מתנה מתנות
🎉 party celebrate celebration congrats congratulations hooray מסיבה חגיגה לחגוג
🥳 festival carnival פסטיבל
⏰ time clock hour hours deadline late זמן שעון שעה שעות דדליין מאוחר
🤔 think thinking thought wonder maybe perhaps חושב לחשוב מחשבה תוהה
💡 idea ideas inspiration insight רעיון רעיונות השראה תובנה
😱 shock shocked scream scary terrifying horror afraid fear הלם מזועזע צעקה מפחיד מפחידה אימה פחד
😢 sad cry crying tears depressed lonely עצוב בוכה בכי דמעות בדידות
💔 heartbreak breakup broken divorce שבור פרידה גירושין
😡 angry mad furious rage anger כועס זועם כעס
😴 sleep tired sleepy bed exhausted ישן עייף שינה מיטה
🤢 disgusting nausea חולה מגעיל בחילה
🙏 god pray prayer please thanks thank grateful blessed אלוהים תפילה מתפלל בבקשה תודה מודה ברוך
📱 phone iphone smartphone mobile android app טלפון אייפון סלולרי אפליקציה נייד
💻 computer laptop code coding programming developer software מחשב לפטופ קוד תכנות מפתח תוכנה
🎮 gaming gamer videogame playstation xbox גיימר גיימינג פלייסטיישן
🎬 movie film cinema director actor סרט קולנוע במאי שחקן
🎵 music song sing singer album שיר מוזיקה שר זמר אלבום
🎤 mic microphone concert rapper rap מיקרופון קונצרט ראפר ראפ הופעה
🎧 headphones podcast listen אוזניות פודקאסט מקשיב
🎸 guitar band גיטרה להקה רוק
🎹 piano פסנתר
🎓 school college university graduate student degree class בית ספר לימודים אוניברסיטה בוגר סטודנט תואר כיתה
📚 book books study read reading library ספר ספרים ללמוד קורא קריאה ספרייה לימוד
✏️ write writing pencil homework כותב כתיבה עיפרון
💪 gym strong strength muscle muscles workout train training fitness exercise כושר חזק כוח שריר שרירים אימון מתאמן להתאמן
🏋️ lift lifting weights bodybuilding הרמת משקולות
🏃 run running runner marathon jog ריצה רץ רצים מרתון
🚴 bike cycling bicycle אופניים רוכב
🏊 swim swimming pool שחייה שוחה בריכה
🏠 home house apartment rent mortgage בית דירה שכירות משכנתא
🏢 company building headquarters corporation חברה בניין משרד תאגיד
💼 job work business office boss career interview עבודה עסק עסקים בוס קריירה ראיון עבודה
🤝 deal partner partnership agreement handshake contract עסקה שותף שותפות הסכם חוזה
🛒 buy shopping store shop purchase sell קניות קונה חנות מכירה למכור
🏷️ price sale discount cheap deal מחיר הנחה מבצע זול
💳 card credit bank payment כרטיס אשראי בנק תשלום
🪙 bitcoin crypto coin blockchain ביטקוין קריפטו מטבע בלוקצ'יין
📈 grow growth increase rising sales צמיחה לצמוח עלייה מכירות ירידה
📉 loss decline fall crash drop הפסד ירידה נפילה קריסה
📊 data stats statistics analytics chart numbers נתונים סטטיסטיקה אנליטיקס גרף מספרים
🎯 target aim focus bullseye מטרה כיוון מיקוד
⭐ star stars favorite כוכב כוכבים אהוב
🌟 amazing awesome fantastic incredible brilliant מדהים מצוין פנטסטי נהדר
👑 king queen royal crown boss מלך מלכה מלכותי כתר
💎 diamond valuable precious gem יהלום יקר ערך אבן
🔑 key keys unlock secret מפתח מפתחות סוד
🤫 secret quiet shh secrets סוד שקט סודות
🔒 lock secure security privacy password נעול אבטחה פרטיות סיסמה
🧠 brain smart genius intelligent clever מוח חכם גאון אינטליגנטי שכל
👀 eyes watch watching צופה תראו עיניים מביט מסתכל
👍 great perfect agree נהדר מושלם מסכים
👎 bad terrible awful worst dislike רע נורא איום גרוע הגרוע
✅ correct done confirmed verified הושלם מאושר
❌ wrong incorrect fail failed mistake error טעות כישלון נכשל שגיאה
⚠️ warning danger careful caution risk alert dangerous אזהרה סכנה זהירות סיכון מסוכן
💥 boom explosion explode crash blast bang בום פיצוץ מתפוצץ התרסקות
⚡ fast quick speed power energy electric lightning electricity מהר מהיר מהירות חשמל כוח אנרגיה ברק
🐶 dog puppy dogs כלב גור כלבים
🐱 cat kitten cats חתול חתולה חתולים
🦁 lion lions אריה אריות
🦈 shark sharks כריש כרישים
🐎 horse horses סוס סוסים
🐍 snake snakes נחש נחשים
🐒 monkey ape קוף
🍀 lucky luck fortune מזל בר מזל
🤒 fever flu virus covid חום שפעת וירוס קורונה
🏥 hospital doctor nurse surgery clinic בית חולים רופא אחות ניתוח מרפאה
💊 medicine pill drug pills תרופה גלולה סם תרופות
🧪 test experiment lab chemistry ניסוי מעבדה כימיה בדיקה
🔬 science research scientist microscope מדע מחקר מדען
🔍 search investigate חיפוש מחפש מצא חקירה
📸 photo picture camera selfie תמונה מצלמה סלפי צילום
📞 call calling ringing התקשר שיחה מתקשר
✉️ email mail message inbox מייל הודעה דואר
👶 baby babies child kids תינוק תינוקות ילד ילדים
👪 family parents mom dad mother father משפחה הורים אמא אבא
🙌 friend friends buddy hug חבר חברים חבר'ה חיבוק
😎 cool swag awesome מגניב סווג
😅 awkward nervous sweat מביך לחוץ
🙄 whatever annoying eyeroll מעצבן
🤷 idk dunno whatever
🤦 facepalm stupid idiot dumb טיפש מטומטם
🥵 spicy sweating burning חריף מזיע
🍎 apple fruit healthy fruits תפוח פרי בריא פירות
🥗 salad diet vegan vegetarian סלט דיאטה טבעוני צמחוני
🍫 chocolate candy sweet dessert שוקולד ממתק מתוק קינוח
🍦 icecream גלידה
🛡️ protect protection defense shield defend הגנה מגן להגן
⚔️ war battle army soldier מלחמה קרב צבא חייל
🚨 emergency police alarm siren חירום משטרה אזעקה צופר
🗳️ vote election politics president בחירות הצבעה פוליטיקה נשיא
⚖️ law court lawyer judge justice חוק בית משפט עורך דין שופט צדק
📰 news newspaper headline breaking חדשות עיתון כותרת מבזק
📺 tv television channel stream טלוויזיה ערוץ שידור תוכנית
📹 video youtube vlog recording וידאו יוטיוב ויבלוג הקלטה
🌐 internet online web website אינטרנט אונליין אתר
🔔 notification subscribe bell התראה הרשמה פעמון
🛠️ tool tools fix repair build builder כלי כלים לתקן תיקון בנייה בונה
🧱 brick wall construction לבנה קיר
🏗️ construction crane
🧹 clean cleaning cleanup ניקיון מנקה
🕊️ peace dove שלום יונה
🇮🇱 israel ישראל
🇺🇸 america usa אמריקה
🕯️ memorial candle remember זיכרון נר`;


const STYLE_DATA = {
 "bold": {
  "name": "נועז",
  "nameEn": "Bold",
  "blurb": "לבן עם קו מתאר שחור, והמילה הפעילה צהובה וקופצת",
  "preview": {
   "text": "WOW",
   "fill": "#FFFFFF",
   "accent": "#FFE14D",
   "stroke": "#000000"
  },
  "cfg": {
   "fam": "Rubik",
   "w": 900,
   "size": 88,
   "sw": 10,
   "case": "upper",
   "maxc": 16,
   "maxn": 3,
   "lines": 2,
   "brk": 1,
   "kind": "pop",
   "acc": "#FFE14D",
   "emph": "#4DF08A",
   "sh": [
    [
     2,
     0,
     3,
     0.55
    ],
    [
     9,
     0,
     9,
     0.55
    ]
   ],
   "wf": 0.8,
   "sp": 0.4,
   "vc": 0.35,
   "lh": 1.12,
   "pop": [
    1.07,
    1.18,
    1.12,
    1.06
   ],
   "pmaxc": 30,
   "pmaxn": 6,
   "kw": "#FF8A00",
   "fitsId": "FITS"
  },
  "hook": {
   "fam": "Rubik",
   "w": 800,
   "size": 56,
   "min": 44,
   "fill": "#FFFFFF",
   "ink": "#101010",
   "accent": "#FFE14D",
   "border": null,
   "upper": true,
   "tilt": -1.3,
   "px": 0.6,
   "py": 0.38,
   "r": 0.5
  }
 },
 "clean": {
  "name": "נקי",
  "nameEn": "Clean",
  "blurb": "טקסט לבן מודגש, מילים שנאמרו בולטות ושאר המילים עמומות",
  "preview": {
   "text": "Clean",
   "fill": "#FFFFFF",
   "accent": "#FFE066",
   "stroke": null
  },
  "cfg": {
   "fam": "Heebo",
   "w": 700,
   "size": 70,
   "sw": 0,
   "case": null,
   "maxc": 36,
   "maxn": 7,
   "lines": 2,
   "brk": 2,
   "kind": "karaoke",
   "acc": "#FFE066",
   "emph": null,
   "sh": [
    [
     2,
     0,
     3,
     0.6
    ],
    [
     10,
     0,
     8,
     0.62
    ]
   ],
   "wf": 0.78,
   "sp": 0.27,
   "vc": 0.3,
   "lh": 1.22,
   "dim": 0.62,
   "pmaxc": 42,
   "pmaxn": 8,
   "kw": "#FFB347",
   "fitsId": "FITS2"
  },
  "hook": {
   "fam": "Heebo",
   "w": 700,
   "size": 54,
   "min": 44,
   "fill": "rgba(12,14,18,0.698)",
   "ink": "#FFFFFF",
   "accent": null,
   "border": "rgba(255,255,255,0.180)",
   "upper": false,
   "tilt": 0,
   "px": 0.7,
   "py": 0.42,
   "r": 0.62
  }
 },
 "punch": {
  "name": "פאנץ׳",
  "nameEn": "Punch",
  "blurb": "כמו הנועז, עם מילה פעילה בצבע ליים",
  "preview": {
   "text": "PUNCH",
   "fill": "#FFFFFF",
   "accent": "#D3F895",
   "stroke": "#000000"
  },
  "cfg": {
   "fam": "Rubik",
   "w": 900,
   "size": 88,
   "sw": 10,
   "case": "upper",
   "maxc": 16,
   "maxn": 3,
   "lines": 2,
   "brk": 1,
   "kind": "pop",
   "acc": "#D3F895",
   "emph": null,
   "sh": [
    [
     2,
     0,
     3,
     0.55
    ],
    [
     9,
     0,
     9,
     0.55
    ]
   ],
   "wf": 0.8,
   "sp": 0.4,
   "vc": 0.35,
   "lh": 1.12,
   "pop": [
    1.08,
    1.2,
    1.13,
    1.06
   ],
   "pmaxc": 30,
   "pmaxn": 6,
   "kw": "#7CF5FF",
   "fitsId": "FITS"
  },
  "hook": {
   "fam": "Rubik",
   "w": 800,
   "size": 56,
   "min": 44,
   "fill": "#D3F895",
   "ink": "#0C1A00",
   "accent": "#101010",
   "border": null,
   "upper": true,
   "tilt": -1.3,
   "px": 0.6,
   "py": 0.38,
   "r": 0.5
  }
 },
 "neon": {
  "name": "ניאון",
  "nameEn": "Neon",
  "blurb": "המילה הפעילה זוהרת בהילה כחולה",
  "preview": {
   "text": "NEON",
   "fill": "#E9FEFF",
   "accent": "#39F3FF",
   "stroke": "#0A1030"
  },
  "cfg": {
   "fam": "Rubik",
   "w": 800,
   "size": 84,
   "sw": 7,
   "sfill": "#0A1030",
   "case": "upper",
   "maxc": 16,
   "maxn": 3,
   "lines": 2,
   "brk": 1,
   "kind": "neon",
   "acc": "#39F3FF",
   "emph": null,
   "sh": [
    [
     3,
     0,
     4,
     0.6
    ],
    [
     10,
     0,
     10,
     0.5
    ]
   ],
   "wf": 0.8,
   "sp": 0.4,
   "vc": 0.35,
   "lh": 1.12,
   "pop": [
    1.05,
    1.13,
    1.08,
    1.04
   ],
   "pmaxc": 30,
   "pmaxn": 6,
   "kw": "#FF4DD2",
   "fitsId": "FITS"
  },
  "hook": {
   "fam": "Rubik",
   "w": 800,
   "size": 56,
   "min": 44,
   "fill": "#070A1C",
   "ink": "#FFFFFF",
   "accent": null,
   "border": "#39F3FF",
   "glow": "#39F3FF",
   "upper": true,
   "tilt": 0,
   "px": 0.62,
   "py": 0.4,
   "r": 0.45
  }
 },
 "box": {
  "name": "קופסה",
  "nameEn": "Box",
  "blurb": "המילה הפעילה יושבת על קופסה סגולה",
  "preview": {
   "text": "BOX",
   "fill": "#FFFFFF",
   "accent": "#7C5CFF",
   "stroke": "#000000"
  },
  "cfg": {
   "fam": "Rubik",
   "w": 800,
   "size": 82,
   "sw": 7,
   "sfill": "#000000",
   "case": "upper",
   "maxc": 16,
   "maxn": 3,
   "lines": 2,
   "brk": 1,
   "kind": "box",
   "acc": "#7C5CFF",
   "emph": null,
   "sh": [
    [
     2,
     0,
     3,
     0.5
    ],
    [
     8,
     0,
     8,
     0.5
    ]
   ],
   "wf": 0.8,
   "sp": 0.46,
   "vc": 0.35,
   "lh": 1.3,
   "pop": [
    0.9,
    1.14,
    1.07,
    1.03
   ],
   "pmaxc": 30,
   "pmaxn": 6,
   "kw": "#FFD23F",
   "fitsId": "FITS"
  },
  "hook": {
   "fam": "Rubik",
   "w": 800,
   "size": 56,
   "min": 44,
   "fill": "#7C5CFF",
   "ink": "#FFFFFF",
   "accent": "#241466",
   "border": null,
   "upper": true,
   "tilt": -1.2,
   "px": 0.6,
   "py": 0.38,
   "r": 0.5
  }
 },
 "minimal": {
  "name": "מינימלי",
  "nameEn": "Minimal",
  "blurb": "טקסט קטן ועדין שמופיע ונעלם בלי אנימציה",
  "preview": {
   "text": "Minimal",
   "fill": "#FFFFFF",
   "accent": "#FFE9A0",
   "stroke": null
  },
  "cfg": {
   "fam": "Heebo",
   "w": 500,
   "size": 58,
   "sw": 0,
   "case": null,
   "maxc": 40,
   "maxn": 8,
   "lines": 2,
   "brk": 2,
   "kind": "fade",
   "acc": "#FFE9A0",
   "emph": null,
   "sh": [
    [
     3,
     0,
     2,
     0.5
    ],
    [
     9,
     0,
     5,
     0.6
    ]
   ],
   "wf": 0.78,
   "sp": 0.27,
   "vc": 0.3,
   "lh": 1.25,
   "pmaxc": 46,
   "pmaxn": 9,
   "kw": "#FFB347",
   "fitsId": "FITS2"
  },
  "hook": {
   "fam": "Heebo",
   "w": 600,
   "size": 52,
   "min": 44,
   "fill": null,
   "ink": "#FFFFFF",
   "accent": null,
   "border": null,
   "upper": false,
   "tilt": 0,
   "px": 0.2,
   "py": 0.2,
   "r": 0.3,
   "plain": true,
   "lh": 1.2
  }
 },
 "hype": {
  "name": "היפ",
  "nameEn": "Hype",
  "blurb": "מילה אחת ענקית בכל פעם, קפיצה וצבע מתחלף",
  "preview": {
   "text": "HYPE",
   "fill": "#FFE14D",
   "accent": "#FF4DB8",
   "stroke": "#000000"
  },
  "cfg": {
   "fam": "Rubik",
   "w": 900,
   "size": 150,
   "sw": 14,
   "case": "upper",
   "maxc": 18,
   "maxn": 1,
   "lines": 1,
   "brk": 1,
   "kind": "hype",
   "acc": "#FFE14D",
   "emph": null,
   "sh": [
    [
     2,
     0,
     3,
     0.6
    ],
    [
     11,
     0,
     11,
     0.6
    ]
   ],
   "wf": 0.9,
   "sp": 0.4,
   "vc": 0.35,
   "lh": 1.1,
   "pop": [
    0.72,
    1.32,
    1.1,
    0.96,
    1.0
   ],
   "pmaxc": 26,
   "pmaxn": 5,
   "dy": -0.055,
   "kw": "#FF4D4D",
   "fitsId": "FITS"
  },
  "hook": {
   "fam": "Rubik",
   "w": 800,
   "size": 56,
   "min": 44,
   "fill": "#FFE14D",
   "ink": "#101010",
   "accent": "#FF4DB8",
   "border": null,
   "upper": true,
   "tilt": -2.2,
   "px": 0.6,
   "py": 0.38,
   "r": 0.5
  }
 },
 "karaoke": {
  "name": "קריוקי",
  "nameEn": "Karaoke",
  "blurb": "צבע שמתמלא על המילה בזמן שהיא נאמרת",
  "preview": {
   "text": "Karaoke",
   "fill": "#4DF0FF",
   "accent": "#4DF0FF",
   "stroke": "#10123A"
  },
  "cfg": {
   "fam": "Rubik",
   "w": 800,
   "size": 76,
   "sw": 9,
   "sfill": "#10123A",
   "case": null,
   "maxc": 26,
   "maxn": 5,
   "lines": 2,
   "brk": 2,
   "kind": "kfill",
   "acc": "#4DF0FF",
   "emph": null,
   "sh": [
    [
     2,
     0,
     3,
     0.6
    ],
    [
     8,
     0,
     8,
     0.55
    ]
   ],
   "wf": 0.82,
   "sp": 0.34,
   "vc": 0.33,
   "lh": 1.2,
   "pmaxc": 34,
   "pmaxn": 7,
   "kw": "#FF6AD5",
   "fitsId": "FITS2"
  },
  "hook": {
   "fam": "Rubik",
   "w": 800,
   "size": 56,
   "min": 44,
   "fill": "#10123A",
   "ink": "#FFFFFF",
   "accent": null,
   "border": "#4DF0FF",
   "glow": "#4DF0FF",
   "upper": true,
   "tilt": 0,
   "px": 0.62,
   "py": 0.4,
   "r": 0.45
  }
 },
 "outline": {
  "name": "קו מתאר",
  "nameEn": "Outline",
  "blurb": "קו מתאר עבה בלי רקע ועם צל ארוך",
  "preview": {
   "text": "OUTLINE",
   "fill": "#FFFFFF",
   "accent": "#FFE14D",
   "stroke": "#1B1146"
  },
  "cfg": {
   "fam": "Heebo",
   "w": 900,
   "size": 88,
   "sw": 15,
   "sfill": "#1B1146",
   "case": "upper",
   "maxc": 16,
   "maxn": 3,
   "lines": 2,
   "brk": 1,
   "kind": "pop",
   "acc": "#FFE14D",
   "emph": null,
   "sh": [
    [
     1.5,
     0,
     2,
     0.5
    ]
   ],
   "ext": [
    1,
    1,
    26
   ],
   "wf": 0.8,
   "sp": 0.4,
   "vc": 0.35,
   "lh": 1.16,
   "pop": [
    1.05,
    1.15,
    1.09,
    1.04
   ],
   "pmaxc": 30,
   "pmaxn": 6,
   "kw": "#7CF5FF",
   "fitsId": "FITS"
  },
  "hook": {
   "fam": "Rubik",
   "w": 800,
   "size": 56,
   "min": 44,
   "fill": "#FFFFFF",
   "ink": "#1B1146",
   "accent": "#1B1146",
   "border": null,
   "upper": true,
   "tilt": -1.0,
   "px": 0.6,
   "py": 0.38,
   "r": 0.5
  }
 },
 "typewriter": {
  "name": "מכונת כתיבה",
  "nameEn": "Typewriter",
  "blurb": "האותיות מוקלדות אחת אחרי השנייה, בעדינות",
  "preview": {
   "text": "Typing",
   "fill": "#FFFFFF",
   "accent": "#FFE066",
   "stroke": null
  },
  "cfg": {
   "fam": "Heebo",
   "w": 600,
   "size": 66,
   "sw": 0,
   "case": null,
   "maxc": 34,
   "maxn": 6,
   "lines": 2,
   "brk": 2,
   "kind": "type",
   "acc": "#FFE066",
   "emph": null,
   "sh": [
    [
     2,
     0,
     3,
     0.55
    ],
    [
     9,
     0,
     7,
     0.55
    ]
   ],
   "wf": 0.78,
   "sp": 0.27,
   "vc": 0.3,
   "lh": 1.24,
   "pmaxc": 42,
   "pmaxn": 8,
   "kw": "#FFB347",
   "fitsId": "FITS2"
  },
  "hook": {
   "fam": "Heebo",
   "w": 700,
   "size": 54,
   "min": 44,
   "fill": "rgba(12,14,18,0.698)",
   "ink": "#FFFFFF",
   "accent": null,
   "border": "rgba(255,255,255,0.180)",
   "upper": false,
   "tilt": 0,
   "px": 0.7,
   "py": 0.42,
   "r": 0.62
  }
 }
};
const FITS = [[1, 1], [0.94, 1], [0.88, 1], [0.82, 1], [1, 2], [0.9, 2], [0.8, 2], [0.7, 2], [0.74, 1], [0.66, 1], [0.58, 1]];
const FITS2 = [[1, 1], [1, 2], [0.92, 2], [0.84, 2], [0.76, 2], [0.68, 2]];


// ---------- קבועים (כמו במק) ----------
const GAP = 0.35, HOLD = 0.30, MAXWORD = 1.2;
const IN_A = [0.2, 0.5, 0.8, 1, 1, 1], IN_S = [0.80, 0.92, 1.04, 1.07, 1.03, 1.0];
const OUT_A = [0.86, 0.71, 0.57, 0.43, 0.29, 0.14], OUT_S = [0.99, 0.98, 0.97, 0.96, 0.95, 0.94];
const EMO = [[0.45, 0.30, 0.5], [1.18, -0.14, 1], [1.28, -0.20, 1], [0.96, 0.05, 1], [1.06, -0.03, 1], [1.0, 0, 1]];
const EMOJI_GAP = 2.5;
const SPLIT_SC = 0.88;
const HYPE_COLS = ['#FFE14D', '#FFFFFF', '#4DF0FF', '#FF4DB8', '#9DFF4D'];
const KWPOP = [1.0, 1.14, 1.08, 1.04, 1.0];
const KW_SCALE = 1.15, TYPE_FRAMES = 7;
const BASE_FPS = 30; // כל טבלאות האנימציה מוגדרות לפי 30 פריימים לשנייה, ומתאימות את עצמן ל־fps של הקליפ

export const STYLES = {};
for (const id of Object.keys(STYLE_DATA)) {
  const d = STYLE_DATA[id];
  const cfg = Object.assign({}, d.cfg);
  cfg.fits = cfg.fitsId === 'FITS2' ? FITS2 : FITS;
  STYLES[id] = Object.assign({ id, name: d.name, nameEn: d.nameEn, blurb: d.blurb, preview: d.preview, hook: d.hook }, cfg);
}
export const STYLE_IDS = Object.keys(STYLES);
/** רשימת הסגנונות לממשק: [{id, name (עברית), nameEn, blurb, preview}] */
export function styleList() {
  return STYLE_IDS.map((id) => ({ id, name: STYLES[id].name, nameEn: STYLES[id].nameEn, blurb: STYLES[id].blurb, preview: STYLES[id].preview }));
}

// ---------- טקסט ----------
const HEB = /[֐-׿יִ-ﭏ]/;
const RTLCH = /[֐-׿؀-ۿיִ-﷿ﹰ-﻿]/g;
const LATIN = /[A-Za-z]/g;
const FIN = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
const num = (x) => { const v = Number(x); return Number.isFinite(v) ? v : 0; };
const qf = (t, fps) => Math.floor(t * fps + 0.5);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const cpLen = (s) => Array.from(s).length;

export const hasHebrew = (t) => HEB.test(t);

/** 'rtl' כשיש יותר תווי עברית/ערבית מאותיות לטיניות */
export function detectDirection(text) {
  const s = String(text || '');
  const rt = (s.match(RTLCH) || []).length;
  const la = (s.match(LATIN) || []).length;
  return rt > la ? 'rtl' : 'ltr';
}

function stripChars(s, set) {
  let a = 0, b = s.length;
  while (a < b && set.indexOf(s[a]) >= 0) a++;
  while (b > a && set.indexOf(s[b - 1]) >= 0) b--;
  return s.slice(a, b);
}

const QUOTES = '"“”«»()[]{}';
const CEN_RE = /^(\p{L}{0,3})([*•]{2,})(\p{L}{0,4})([.,;:!?…]*)$/u;

/** טקסט להצגה ועוצמת מעבר (0 אין, 1 פסיק, 2 סוף משפט) של מילה אחת מהתמלול; null לטקסט שמוסתר (מקפים וסימנים בלבד) */
export function cleanToken(raw, cfg) {
  let t = String(raw).replace(/[‎‏‪-‮⁦-⁩﻿]/g, '').trim().replace(/’/g, "'").replace(/‘/g, "'");
  const cen = CEN_RE.test(stripChars(t.trim(), QUOTES));
  t = stripChars(t, QUOTES + '<>_~`' + (cen ? '' : '*'));
  if (t.length > 1 && t[0] === "'" && (t[t.length - 1] === "'" || !/\p{L}/u.test(t[1]))) {
    t = t[t.length - 1] === "'" ? t.slice(1).replace(/'+$/, '') : t.slice(1);
  }
  const m = t.match(/[.,;:!?…]+$/);
  const tail = m ? m[0] : '';
  const brk = /[.!?…]/.test(tail) ? 2 : tail ? 1 : 0;
  if (/^[-–—]+$/.test(t)) return { t: null, brk: 1 };
  t = t.replace(/^[-–—,.;:…]+(?!\d)/, '');
  if (cfg.case === 'upper') {
    t = t.replace(/[.,;:…]+$/, '');
    t = t.replace(/([?!])[.,;:…]+$/, '$1');
  }
  if (!t || (/^[^\p{L}\p{N}]+$/u.test(t) && !/[$%₪€£#@]/.test(t))) return { t: null, brk };
  if (cfg.case === 'upper') t = t.toUpperCase();
  return { t, brk };
}

/** מילה מודגשת (מספר, כסף, סימן קריאה) */
export function isEmph(t) {
  return /\d|[$%₪€£]/.test(t) || t.endsWith('!') || MONEY.has(t.toLowerCase().replace(/^[!?.,]+|[!?.,]+$/g, ''));
}

/** סדר ציור משמאל לימין של מילים בשורה: בשורה עברית רצפים של לטינית/מספרים שומרים על סדר הקריאה שלהם */
export function visualOrder(texts, rtl) {
  const n = texts.length;
  if (!rtl) return Array.from({ length: n }, (_, i) => i);
  const runs = [];
  for (let i = 0; i < n; i++) {
    const ltr = !hasHebrew(texts[i]);
    if (ltr && runs.length && runs[runs.length - 1][0]) runs[runs.length - 1][1].push(i);
    else runs.push([ltr, [i]]);
  }
  const out = [];
  for (let r = runs.length - 1; r >= 0; r--) out.push(...runs[r][1]);
  return out;
}

// ---------- מילות מפתח ואמוג'י ----------
const normWord = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}_'֐-׿]+/gu, '');

/** אינדקסים של מילים שסומנו כמילות מפתח: מספרים ו/או {start, end, word} (התאמה לפי חפיפת זמן) */
export function keywordIndexes(words, keywords) {
  const out = new Set();
  const ws = words || [];
  for (const k of keywords || []) {
    if (typeof k === 'boolean') continue;
    if (typeof k === 'number') {
      if (Number.isInteger(k) && k >= 0 && k < ws.length) out.add(k);
    } else if (k && typeof k === 'object') {
      const a = num(k.start), b = k.end === undefined ? a : num(k.end);
      const want = k.word ? normWord(k.word) : null;
      ws.forEach((w, i) => {
        if (!w || typeof w !== 'object') return;
        const s = num(w.start), e = num(w.end), mid = (s + e) / 2;
        if ((a - 0.05 <= mid && mid <= b + 0.05 || Math.min(e, b) - Math.max(s, a) >= 0.5 * Math.max(0.02, e - s)) && (want === null || normWord(w.text || '') === want)) out.add(i);
      });
    }
  }
  return out;
}

const EMOJI = new Map();
for (const ln of EMOJI_DATA.trim().split('\n')) {
  const p = ln.trim().split(/\s+/);
  for (const w of p.slice(1)) {
    const k = w.toLowerCase().replace(/[ךםןףץ]/g, (c) => FIN[c]);
    if (!EMOJI.has(k)) EMOJI.set(k, p[0]);
  }
}

/** אמוג'י למילה (התאמה מדויקת, רבים/-ing/-ed, וקידומות וסיומות בעברית), או null */
export function emojiFor(word) {
  const w = String(word).toLowerCase().replace(/[^\p{L}\p{N}_'֐-׿]+/gu, '').replace(/^'+|'+$/g, '').replace(/[ךםןףץ]/g, (c) => FIN[c]);
  if (!w) return null;
  if (EMOJI.has(w)) return EMOJI.get(w);
  const cand = [];
  if (w.endsWith("'s")) cand.push(w.slice(0, -2));
  for (const suf of ['es', 's', 'ing', 'ed', 'ly', 'er', 'ers']) {
    if (w.endsWith(suf) && w.length > suf.length + 2) cand.push(w.slice(0, -suf.length), w.slice(0, -suf.length) + 'e');
  }
  if (hasHebrew(w)) {
    const base = [w];
    for (const p of [1, 2]) {
      if (w.length > p + 2 && Array.from(w.slice(0, p)).every((ch) => 'הובלמשכ'.includes(ch))) base.push(w.slice(p));
    }
    for (const b of base.slice()) {
      for (const suf of ['ים', 'ות', 'ה', 'ת', 'י', 'יה', 'ו']) {
        if (b.endsWith(suf) && b.length > suf.length + 1) base.push(b.slice(0, -suf.length));
      }
    }
    cand.push(...base);
  }
  for (const c of cand) if (EMOJI.has(c)) return EMOJI.get(c);
  return null;
}

/**
 * בחירת מילות מפתח בלי מודל: מספרים וכסף, שמות פרטיים (באנגלית), מילים חזקות ורגשיות (אנגלית ועברית), מילים ארוכות.
 * words = [{text, start, end}] (זמני פלט); מחזיר אינדקסים ממוינים, לכל היותר limitPer10s ל־10 שניות ולעולם לא שתי מילים במרחק קטן מ־1.2 שניות.
 */
export function pickKeywords(words, lang, limitPer10s = 2) {
  const ws = [], orig = [];
  (words || []).forEach((w, i) => { if (w && typeof w === 'object') { ws.push(w); orig.push(i); } });
  if (lang !== 'he' && lang !== 'en') lang = detectDirection(ws.map((w) => String(w.text || '')).join(' ')) === 'rtl' ? 'he' : 'en';
  const strong = lang === 'he' ? STRONG_HE : STRONG_EN;
  const emo = lang === 'he' ? EMOTION_HE : EMOTION_EN;
  const cands = [];
  let sentenceStart = true;
  ws.forEach((w, n) => {
    const raw = String(w.text || '').trim();
    const t = normWord(raw);
    const first = sentenceStart;
    sentenceStart = /[.!?…]$/.test(raw);
    if (!t || (t.length < 3 && !/\d/.test(t))) return;
    let sc = 0;
    if (/\d|[$%₪€£]/.test(raw)) sc += 5;
    if (NUM_WORDS.has(t)) sc += 4;
    if (strong.has(t)) sc += 5;
    if (emo.has(t)) sc += 3;
    if (emojiFor(t)) sc += 2;
    if (lang === 'en') {
      const c0 = raw.charAt(0);
      if (!first && c0 !== c0.toLowerCase() && c0 === c0.toUpperCase() && !["i", "i'm", "i'd", "i'll", "i've"].includes(t) && !STOP.has(t)) sc += 3.5;
      if (t.length >= 8) sc += 1.5;
    } else if (t.length >= 6) sc += 1.5;
    if (raw.endsWith('!')) sc += 1.5;
    if (STOP.has(t)) sc -= 6;
    if (sc >= 3) cands.push([sc, -n, n, num(w.start)]);
  });
  cands.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2] || b[3] - a[3]);
  const picked = [], per = {};
  for (const [, , n, st] of cands) {
    const b = Math.floor(st / 10);
    if ((per[b] || 0) >= Math.max(0, Math.floor(limitPer10s)) || picked.some((p) => Math.abs(st - p[1]) < 1.2)) continue;
    per[b] = (per[b] || 0) + 1;
    picked.push([n, st]);
  }
  return picked.map((p) => orig[p[0]]).sort((a, b) => a - b);
}

/** keywords: true / 'auto' (בחירה אוטומטית), או רשימה (אינדקסים / {start,end,word}) -> קבוצת אינדקסים */
export function resolveKeywords(words, keywords, lang, limitPer10s = 2) {
  if (keywords === true || (typeof keywords === 'string' && keywords.toLowerCase() === 'auto')) return new Set(pickKeywords(words, lang, limitPer10s));
  if (Array.isArray(keywords)) return keywordIndexes(words, keywords);
  return new Set();
}

// ---------- קבוצות ושורות ----------
/** מילים נקיות עם זמני פריים (sf, ef) עולים ממש בתוך הקליפ; kw = קבוצת אינדקסים מקוריים של מילות מפתח */
export function prepWords(words, cfg, fps, duration, kw) {
  const N = Math.max(1, qf(duration, fps));
  const idx = [];
  (words || []).forEach((w, i) => { if (w && typeof w === 'object' && String(w.text == null ? '' : w.text).trim()) idx.push([i, w]); });
  idx.sort((a, b) => num(a[1].start) - num(b[1].start) || num(a[1].end) - num(b[1].end) || a[0] - b[0]);
  const out = [];
  for (const [oi, w] of idx) {
    const ts = num(w.start);
    let te = num(w.end) || ts;
    te = Math.min(Math.max(te, ts + 0.04), ts + MAXWORD);
    const parts = String(w.text).split(/\s+/).filter(Boolean);
    parts.forEach((p, j) => {
      const { t, brk } = cleanToken(p, cfg);
      if (t === null) {
        if (out.length && brk) out[out.length - 1].brk = Math.max(out[out.length - 1].brk, brk);
        return;
      }
      const d = { t, ts: ts + (te - ts) * j / parts.length, te: ts + (te - ts) * (j + 1) / parts.length, brk, emph: !!cfg.emph && isEmph(t), oi };
      if (kw && kw.has(oi)) d.kw = true;
      out.push(d);
    });
  }
  const res = [];
  let prev = -1;
  for (const w of out) {
    const sf = Math.max(qf(w.ts, fps), prev + 1);
    if (sf >= N) break;
    w.sf = sf;
    w.ef = Math.min(N, Math.max(sf + 1, qf(w.te, fps)));
    res.push(w);
    prev = sf;
  }
  return res;
}

/** חלוקה לפחות קבוצות במסגרת מגבלת מילים ותווים, ואז לאיזון הטוב ביותר; לא מסיימים קבוצה במילת קישור */
export function chunkSegment(seg, cfg, maxn, maxc) {
  const n = seg.length;
  maxn = maxn || cfg.maxn;
  maxc = maxc || cfg.maxc;
  const L = seg.map((w) => cpLen(w.t));
  const best = new Array(n + 1).fill(Infinity), prev = new Array(n + 1).fill(0);
  best[0] = 0;
  for (let i = 1; i <= n; i++) {
    let chars = -1;
    for (let j = i - 1; j > Math.max(-1, i - maxn - 1); j--) {
      chars += L[j] + 1;
      if (chars > maxc && i - j > 1) break;
      const end = seg[i - 1];
      let cost = best[j] + 1e6 + chars * chars;
      if (i < n) {
        cost += STOP.has(end.t.toLowerCase().replace(/^[!?.,]+|[!?.,]+$/g, '')) ? 5000 : 0;
        cost -= end.brk === 1 ? 3000 : 0;
      }
      if (cost < best[i]) { best[i] = cost; prev[i] = j; }
    }
  }
  const out = [];
  let i = n;
  while (i > 0) { out.push(seg.slice(prev[i], i)); i = prev[i]; }
  return out.reverse();
}

/** קבוצות כתוביות: כל קבוצה מוצגת מתחילת המילה הראשונה עד סוף האחרונה ועוד החזקה קצרה (לא לתוך הקבוצה הבאה) */
export function makeGroups(words, cfg, fps, duration) {
  const N = Math.max(1, qf(duration, fps));
  const segs = [];
  let cur = [];
  words.forEach((w, i) => {
    cur.push(w);
    const nxt = words[i + 1];
    if (!nxt || w.brk >= cfg.brk || nxt.ts - w.te > GAP) { segs.push(cur); cur = []; }
  });
  const groups = [];
  for (const seg of segs) for (const ch of chunkSegment(seg, cfg)) groups.push({ w: ch });
  const hold = qf(HOLD, fps);
  groups.forEach((g, k) => {
    const nxt = k + 1 < groups.length ? groups[k + 1].w[0].sf : N;
    g.i = k;
    g.sf = g.w[0].sf;
    g.ef = Math.max(g.sf + 1, Math.min(g.w[g.w.length - 1].ef + hold, nxt, N));
  });
  return groups;
}

/** אינדקס המילה הפעילה בפריים f */
export function activeIndex(g, f) {
  let ai = 0;
  for (let i = 0; i < g.w.length; i++) { if (g.w[i].sf <= f) ai = i; else break; }
  return ai;
}

function* combinations(n, k, start = 1) {
  if (k === 0) { yield []; return; }
  for (let i = start; i <= n - k; i++) for (const rest of combinations(n, k - 1, i + 1)) yield [i, ...rest];
}

/** חיתוך רציף של n מילים לשורות שממזער את השורה הרחבה ביותר; width(a, b) = רוחב המילים a..b-1; null אם אין התאמה */
export function splitLines(n, width, maxw, maxlines, kmin = 1) {
  for (let k = Math.min(kmin, n); k <= Math.min(maxlines, n); k++) {
    let best = null;
    for (const cuts of combinations(n, k - 1)) {
      const idx = [0, ...cuts, n];
      const ws = [];
      for (let j = 0; j + 1 < idx.length; j++) ws.push(width(idx[j], idx[j + 1]));
      const mx = Math.max(...ws), sq = ws.reduce((s, w) => s + w * w, 0);
      if (mx <= maxw && (best === null || mx < best[0][0] || (mx === best[0][0] && sq < best[0][1]))) best = [[mx, sq], idx];
    }
    if (best) {
      const out = [];
      for (let j = 0; j + 1 < best[1].length; j++) out.push(Array.from({ length: best[1][j + 1] - best[1][j] }, (_, q) => best[1][j] + q));
      return out;
    }
  }
  return null;
}

/** יחס מסך -> פרמטרים של הפורמט (כמו format_params במק) */
export function formatParams(W, H) {
  const r = H / W;
  let k;
  if (r > 1.6) k = { kind: '9:16', lower: 0.69, top: 0.0625, bottom: 0.18 };
  else if (r > 1.2) k = { kind: '4:5', lower: 0.74, top: 0.05, bottom: 0.06 };
  else if (r > 0.9) k = { kind: '1:1', lower: 0.78, top: 0.05, bottom: 0.06 };
  else k = { kind: '16:9', lower: 0.80, top: 0.06, bottom: 0.06 };
  return Object.assign(k, { sc: Math.min(W, H) / 1080, middle: 0.55, tw: r > 0.9 ? 1.0 : 0.78, hookw: r > 0.9 ? 0.86 : 0.62, land: r <= 0.9 });
}

/** אזור בטוח באחוזים -> מלבן בפיקסלים [x0, y0, x1, y1], או null */
export function safeRect(spec) {
  const z = spec && spec.safeZone;
  if (!z || typeof z !== 'object') return null;
  const W = Math.round(num(spec.width) || 1080), H = Math.round(num(spec.height) || 1920);
  const pc = (k, lim) => Math.max(0, Math.min(lim, num(z[k]))) / 100;
  let t = pc('top', 45), b = pc('bottom', 45), l = pc('left', 40), r = pc('right', 40);
  if (t + b > 0.85) { const s = t + b; t = t * 0.85 / s; b = b * 0.85 / s; }
  if (l + r > 0.8) { const s = l + r; l = l * 0.8 / s; r = r * 0.8 / s; }
  if (!(t || b || l || r)) return null;
  return [Math.round(l * W), Math.round(t * H), Math.round(W - r * W), Math.round(H - b * H)];
}

/** מסך מפוצל -> [[פריים התחלה, פריים סיום)] */
export function splitFrames(spec, fps, N) {
  return (spec.splits || []).filter((s) => s && typeof s === 'object' && num(s.end) > num(s.start))
    .map((s) => [Math.max(0, qf(num(s.start), fps)), Math.min(N, qf(num(s.end), fps))]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/** איפה יושבות הכתוביות בפריים f: 0 המשבצת התחתונה הרגילה, 1 על המפריד, 2 משבצת זמן ה־hook במסך מפוצל (המפריד שייך ל־hook) */
export function capSlot(spl, f, Hf) {
  for (const [a, b] of spl) if (a <= f && f < b) return f < Hf ? 2 : 1;
  return 0;
}

/** אמוג'י לפי מילות מפתח: לכל היותר אחד לקבוצה ואחד כל gap שניות; מופיע כשהמילה נאמרת */
export function assignEmoji(groups, fps, gap = EMOJI_GAP) {
  const out = {};
  let last = -1e9;
  for (const g of groups) {
    const hit = g.w.map((w, wi) => [wi, emojiFor(w.t)]).find((h) => h[1]);
    if (hit && g.w[hit[0]].sf / fps - last >= gap) {
      out[g.i] = { sf: g.w[hit[0]].sf, wi: hit[0], ch: hit[1] };
      last = g.w[hit[0]].sf / fps;
    }
  }
  return out;
}

/** משך הקליפ: spec.duration, ובהיעדרו סוף המילה האחרונה */
export function specDuration(spec) {
  const d = num(spec.duration);
  if (d > 0) return d;
  return Math.max(1, ...((spec.words || []).map((w) => num(w && w.end))));
}

const lerpTab = (tab, x) => {
  if (x <= 0) return tab[0];
  const n = tab.length - 1;
  if (x >= n) return tab[n];
  const i = Math.floor(x), f = x - i;
  return tab[i] + (tab[i + 1] - tab[i]) * f;
};

// ---------- המודל: קבוצות, פריסה, hook (טהור; המדידה מוזרקת, אז זה רץ גם ב־node) ----------
/**
 * בונה את כל מה שלא תלוי בציור: קבוצות, פריסת שורות לכל קבוצה ולכל משבצת (רגילה / מפריד / זמן hook), אזור בטוח, אמוג'י וגיאומטריית ה־hook.
 * measure(text, dir, size, cfg) -> רוחב בפיקסלים של הטקסט בגופן הסגנון בגודל size.
 */
export function buildModel(spec, measure) {
  const W = Math.round(num(spec.width)) || 1080, H = Math.round(num(spec.height)) || 1920;
  const fps = Math.round(num(spec.fps)) || 30;
  const duration = specDuration(spec);
  const style = STYLES[spec.style] ? spec.style : 'bold';
  const cfg = STYLES[style];
  const N = Math.max(1, qf(duration, fps));
  const kw = spec.keywords ? resolveKeywords(spec.words, spec.keywords, spec.lang) : null;
  const groups = makeGroups(prepWords(spec.words, cfg, fps, duration, kw), cfg, fps, duration);
  const hk = spec.hook && typeof spec.hook === 'object' && String(spec.hook.text || '').trim() ? spec.hook : null;
  const Hf = hk ? Math.min(N, qf(num(hk.seconds) || 2.8, fps)) : 0;
  const alltext = groups.map((g) => g.w.map((w) => w.t).join(' ')).join(' ') || (spec.words || []).map((w) => String((w && w.text) || '')).join(' ');
  const dir = spec.direction === 'rtl' || spec.direction === 'ltr' ? spec.direction : detectDirection(alltext);
  const rtl = dir === 'rtl';
  const fm = formatParams(W, H), sc = fm.sc;
  const spl = splitFrames(spec, fps, N);
  const safe = safeRect(spec);
  const [sx0, sy0, sx1, sy1] = safe || [0, 0, W, H];
  const cx = safe ? (sx0 + sx1) / 2 : W / 2;
  const hookwPx = !safe ? fm.hookw * W : Math.min(fm.hookw * W, (sx1 - sx0) * 0.9);
  const emo = spec.emoji ? assignEmoji(groups, fps) : {};
  const hasEmo = Object.keys(emo).length > 0;
  const m = { spec, W, H, fps, N, duration, style, cfg, groups, hk, Hf, dir, rtl, fm, sc, spl, safe, sx0, sy0, sx1, sy1, cx, hookwPx, emo, hasEmo, sizeK: 1, lay: [], used: {} };
  m.cy = H * fm.lower + (cfg.dy ? cfg.dy * H : 0);

  // איזו משבצת מוצגת מתי (לכל קבוצה)
  for (const g of groups) {
    for (let f = g.sf; f < g.ef; f++) {
      const key = g.i * 3 + capSlot(spl, f, Hf);
      const a = m.used[key];
      m.used[key] = a ? [a[0], f] : [f, f];
    }
  }

  const wdirs = (texts) => texts.map((t) => (rtl && hasHebrew(t) ? 'rtl' : 'ltr'));
  const advOf = (t, d, size) => measure(t, d, size, cfg);

  function layoutWords(texts, base, maxw, cy, fits, sfs) {
    const dirs = wdirs(texts);
    let size = 0, lines = null, adv = null;
    for (const [fit, ml] of fits) {
      size = Math.round(base * fit);
      adv = texts.map((t, j) => advOf(t, dirs[j], sfs ? Math.round(size * sfs[j]) : size) + (sfs && sfs[j] > 1 ? 0.1 * size : 0));
      const sp = cfg.sp * size;
      lines = splitLines(texts.length, (a, b) => { let s = 0; for (let q = a; q < b; q++) s += adv[q]; return s + sp * (b - a - 1); }, maxw, ml);
      if (lines) break;
    }
    if (!lines) lines = [texts.map((_, i) => i)];
    const sp = cfg.sp * size;
    const lh = cfg.lh * size;
    const L = lines.length;
    const items = [];
    lines.forEach((ln, j) => {
      const by = cy + (j - (L - 1) / 2) * lh + cfg.vc * size;
      const order = visualOrder(ln.map((i) => texts[i]), rtl);
      let lw = sp * (ln.length - 1);
      for (const i of ln) lw += adv[i];
      let x = cx - lw / 2;
      for (const o of order) {
        const i = ln[o];
        const it = { i, x, adv: adv[i], by };
        if (sfs) it.sf = sfs[i];
        items.push(it);
        x += adv[i] + sp;
      }
    });
    const smax = sfs ? Math.max(...sfs) : 1;
    return { size, items, texts, dirs, lh, L, sp, cy, top: cy - (L - 1) / 2 * lh + cfg.vc * size - 0.78 * size * smax, bot: cy + (L - 1) / 2 * lh + cfg.vc * size + 0.25 * size, lines };
  }

  function layout(g, sp, cy) {
    let maxw = cfg.wf * W * fm.tw;
    const anyKw = g.w.some((w) => w.kw);
    if (safe) {
      const pm = Math.max(...(cfg.pop || [1]), anyKw ? KWPOP[1] * KW_SCALE : 0);
      maxw = Math.min(maxw, ((sx1 - sx0) * 0.90 - 2 * (cfg.sw * sc * m.sizeK + 30 * sc)) / (1 + (pm - 1) * (cfg.maxn === 1 ? 1.04 : 0.5)));
    }
    const sfs = anyKw ? g.w.map((w) => (w.kw ? KW_SCALE : 1.0)) : null;
    const base = Math.round(cfg.size * sc * (sp === 1 ? SPLIT_SC : 1) * m.sizeK);
    return layoutWords(g.w.map((w) => w.t), base, maxw, cy !== undefined ? cy : sp === 1 ? H * 0.5 : m.cy, cfg.fits, sfs);
  }

  const blockExt = (lay) => [lay.top - (hasEmo ? 1.55 * lay.size : 0) - 0.15 * lay.size, lay.bot + cfg.sw * sc * m.sizeK + 0.22 * lay.size];

  function placed(g, sp) {
    let lay = layout(g, sp);
    if (sp === 2) { // ה־hook מוצג מעל מסך מפוצל: הכתוביות במקום הנמוך ביותר בתוך האזור הבטוח
      const hi = safe ? sy1 - 6 * sc : Math.min(Math.trunc(H * (1 - fm.bottom)), H - 0.02 * H);
      lay = layout(g, sp, lay.cy + hi - blockExt(lay)[1]);
    }
    return lay;
  }

  function buildLayouts() {
    m.lay = groups.map((g) => {
      const row = [null, null, null];
      for (let sp = 0; sp < 3; sp++) if (sp === 0 || m.used[g.i * 3 + sp]) row[sp] = placed(g, sp);
      return row;
    });
  }

  function fitSafe() {
    if (!safe || !groups.length) return;
    for (let it = 0; it < 4; it++) {
      const lays = [].concat(...m.lay).filter(Boolean);
      const size = Math.max(...lays.map((l) => l.size));
      const top = Math.min(...lays.map((l) => l.top)) - (hasEmo ? 1.55 * size : 0) - 0.15 * size;
      const bot = Math.max(...lays.map((l) => l.bot)) + cfg.sw * sc * m.sizeK + 0.22 * size;
      const lo = sy0 + 6 * sc, hi = sy1 - 6 * sc;
      if (top >= lo - 0.5 && bot <= hi + 0.5) return;
      const dy = bot > hi ? hi - bot : lo - top;
      if (bot - top > hi - lo || (bot > hi && top + dy < lo)) {
        m.sizeK *= Math.max(0.6, Math.min(0.96, (hi - lo) / (bot - top) * 0.97));
        if (bot - top > hi - lo) m.cy = (lo + hi) / 2;
      } else m.cy += dy;
      buildLayouts();
    }
  }
  buildLayouts();
  fitSafe();

  m.topY = Math.max(Math.trunc(fm.top * H), 0);
  if (safe) m.topY = Math.max(m.topY, sy0 + Math.trunc(8 * sc));
  if (Hf) hookModel(m, measure);
  return m;
}

function hookModel(m, measure) {
  const { cfg, W, H, sc, fm } = m;
  const hs = cfg.hook;
  let text = String(m.hk.text).replace(/\s+/g, ' ').trim();
  if (hs.upper) text = text.toUpperCase();
  const dirn = detectDirection(text);
  const S = 2, k = sc;
  const hcfg = { fam: hs.fam, w: hs.w };
  const maxtw = m.hookwPx - 2 * hs.px * hs.size * k * 0.9;
  const size0 = Math.trunc(hs.size * k);
  const words = text.split(' ');
  const wrap = (wlist, size, maxw, ml) => {
    const lines = splitLines(wlist.length, (a, b) => measure(wlist.slice(a, b).join(' '), dirn, size, hcfg), maxw, ml);
    return lines ? lines.map((ln) => ln.map((i) => wlist[i]).join(' ')) : null;
  };
  const tries = [];
  for (let z = size0; z >= Math.trunc(size0 * 0.8); z -= 2) tries.push([z, 2]);
  for (let z = size0; z >= Math.trunc(hs.min * k); z -= 2) tries.push([z, 3]);
  let size = size0, lines = null;
  for (const [z, ml] of tries) {
    size = z;
    lines = wrap(words, z * S, maxtw * S, ml);
    if (lines) break;
  }
  if (!lines) {
    const w2 = words.slice();
    while (w2.length && !lines) { w2.pop(); lines = wrap((w2.join(' ') + '\u2026').split(' '), size * S, maxtw * S, 3); }
    if (!lines) lines = ['…'];
  }
  let tw = 0;
  for (const l of lines) tw = Math.max(tw, measure(l, dirn, size * S, hcfg));
  const lh = size * S * (hs.lh || 1.12);
  const px = hs.px * size * S, py = hs.py * size * S;
  const cap = (hs.upper ? 0.72 : 0.74) * size * S;
  const desc = (hasHebrew(text) || !hs.upper ? 0.2 : 0.05) * size * S;
  const cw = Math.trunc(tw + 2 * px), ch = Math.trunc((lines.length - 1) * lh + cap + desc + 2 * py);
  const r = Math.trunc(hs.r * Math.min(ch, size * S * 2.0));
  const ang = Math.abs(hs.tilt) * Math.PI / 180;
  const h = (ch * Math.cos(ang) + cw * Math.sin(ang)) / S;
  const w = (cw * Math.cos(ang) + ch * Math.sin(ang)) / S;
  const hook = { text, lines, dirn, size, S, tw, lh, px, py, cap, desc, cw, ch, r, h, w, hs };
  m.hook = hook;

  // מיקום: למעלה, או על המפריד כשיש מסך מפוצל בזמן ה־hook
  let cy = Math.max(0.115 * H, m.topY + 0.0035 * H + h / 2);
  let scale = 1;
  const splitOn = m.spl.some(([a, b]) => a < m.Hf && b > 0);
  if (splitOn) {
    const lo = m.topY, hi = Math.min(m.safe ? m.sy1 - 8 * sc : H, H - 0.01 * H);
    const seam = H / 2 + 0.01 * H;
    for (const f of [1, 0.88, 0.76, 0.64]) {
      const hh = h * f;
      if (hi - lo >= hh) { cy = Math.min(Math.max(seam - hh / 2, lo + hh / 2), hi - hh / 2); scale = f; break; }
    }
  }
  hook.cy = cy;
  hook.scale = scale;
}

/** פריים (מספר שלם) לפי זמן פלט בשניות */
export function frameAt(t, fps) { return Math.floor(t * fps + 1e-6); }

/** אינדקס הקבוצה שמוצגת בפריים f, או -1 (חיפוש בינארי) */
export function groupAt(groups, f) {
  let lo = 0, hi = groups.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, g = groups[mid];
    if (f < g.sf) hi = mid - 1;
    else if (f >= g.ef) lo = mid + 1;
    else return mid;
  }
  return -1;
}

// ---------- Canvas: גופנים, מדידה ו־sprites ----------
const G = globalThis;
const FAMILY = { Rubik: 'FrameRubik', Heebo: 'FrameHeebo' };
const FALLBACK = '"Heebo","Rubik","Arial Hebrew",Arial,sans-serif';
const fontString = (w, size, fam) => `${w} ${size}px "${FAMILY[fam] || fam}",${FALLBACK}`;
const canvasAvailable = () => typeof G.OffscreenCanvas !== 'undefined' || (G.document && typeof G.document.createElement === 'function');

function makeCanvas(w, h) {
  w = Math.max(1, Math.ceil(w));
  h = Math.max(1, Math.ceil(h));
  if (typeof G.OffscreenCanvas !== 'undefined') return new G.OffscreenCanvas(w, h);
  const c = G.document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

let fontsPromise = null;
let fontsOk = false;
let fontsDone = false;

/** טוען את Heebo ו־Rubik (קבצים ב־engine/fonts, דרך FontFace) ומחכה שיסיימו. מחזיר Promise<boolean>; בלי דפדפן מחזיר false */
export function loadFonts(baseUrl) {
  if (fontsPromise) return fontsPromise;
  fontsPromise = (async () => {
    if (typeof G.FontFace === 'undefined') { fontsDone = true; return false; }
    const set = (G.document && G.document.fonts) || G.fonts;
    if (!set) { fontsDone = true; return false; }
    const base = baseUrl || new URL('./fonts/', import.meta.url).href;
    let ok = true;
    await Promise.all([['FrameRubik', 'Rubik.ttf'], ['FrameHeebo', 'Heebo.ttf']].map(async ([fam, file]) => {
      try {
        const face = new G.FontFace(fam, `url(${base}${file})`, { weight: '100 900', display: 'block' });
        await face.load();
        set.add(face);
      } catch (e) { ok = false; }
    }));
    fontsOk = ok;
    fontsDone = true;
    return ok;
  })();
  return fontsPromise;
}

let measureCtx = null;
function createMeasurer() {
  if (!measureCtx) measureCtx = makeCanvas(4, 4).getContext('2d');
  const c = measureCtx, cache = new Map();
  return function measure(text, dir, size, cfg) {
    const key = cfg.fam + cfg.w + '|' + size + '|' + dir + '|' + text;
    let v = cache.get(key);
    if (v === undefined) {
      c.font = fontString(cfg.w, size, cfg.fam);
      c.direction = dir;
      v = c.measureText(text).width;
      cache.set(key, v);
    }
    return v;
  };
}
/** מדידה משוערת בלי קנבס (ל־node): רוחב קבוע לתו */
export const heuristicMeasure = (text, dir, size) => Array.from(String(text)).length * size * 0.58;

function rrect(c, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/** sprite של מילה: צל, קו מתאר וצבע אפויים בתוכו. d = {text, dir, size, col, scol, halo, noShadow, fillOnly} */
function buildSprite(p, d) {
  const m = p.model, cfg = m.cfg, R = p.R;
  const size = d.size, r = Math.max(0.2, size / cfg.size);
  const fpx = size * R;
  const sw = cfg.sw ? Math.round(cfg.sw * size / cfg.size) : 0;
  const swR = sw * R;
  const scol = d.scol || cfg.sfill || '#000000';
  const mc = p.fontCtx;
  mc.font = fontString(cfg.w, fpx, cfg.fam);
  mc.direction = d.dir;
  const tm = mc.measureText(d.text);
  const adv = tm.width;
  const asc = tm.fontBoundingBoxAscent !== undefined ? tm.fontBoundingBoxAscent : fpx * 0.95;
  const desc = tm.fontBoundingBoxDescent !== undefined ? tm.fontBoundingBoxDescent : fpx * 0.25;
  const shadows = d.noShadow || d.fillOnly ? [] : cfg.sh.map(([b, dx, dy, o]) => [b * r * R, Math.trunc(dx * r) * R, Math.trunc(dy * r) * R, o]);
  const ext = !d.noShadow && !d.fillOnly && cfg.ext ? cfg.ext : null;
  let pad = swR + 4 * R;
  if (shadows.length) pad += Math.max(...shadows.map(([b, dx, dy]) => b * 3 + Math.abs(dy) + Math.abs(dx))) + 2;
  if (ext) pad += ext[2] * r * R * Math.max(Math.abs(ext[0]), Math.abs(ext[1])) + 3;
  if (d.halo) pad += 100 * r * R;
  pad = Math.ceil(pad);
  const w = Math.ceil(adv) + 2 * pad, h = Math.ceil(asc + desc) + 2 * pad;
  const ox = pad, oy = pad + asc;
  const cv = makeCanvas(w, h);
  const c = cv.getContext('2d');
  const setup = (x) => { x.font = mc.font; x.direction = d.dir; x.textAlign = 'left'; x.textBaseline = 'alphabetic'; x.lineJoin = 'round'; x.miterLimit = 2; };
  setup(c);
  // קנבס עבודה אחד לכל הצלליות של ה־sprite (במקום הקצאה לכל צללית)
  let scratch = null;
  const silhouette = (color, strokeToo) => {
    if (!scratch) { scratch = p.scratch && p.scratch.width >= w && p.scratch.height >= h ? p.scratch : (p.scratch = makeCanvas(Math.max(w, 64), Math.max(h, 64))); }
    const x = scratch.getContext('2d');
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.clearRect(0, 0, scratch.width, scratch.height);
    setup(x);
    x.fillStyle = color;
    x.strokeStyle = color;
    if (strokeToo && swR) { x.lineWidth = 2 * swR; x.strokeText(d.text, ox, oy); }
    x.fillText(d.text, ox, oy);
    return scratch;
  };
  if (shadows.length || ext) {
    const sil = silhouette(swR ? scol : d.col, true);
    if (shadows.length) {
      // הצללים נאספים בחיבור (כמו add במק), ואז מוחקים את הצללית עצמה: מה שנשאר הוא הצל בלבד, מתחת לאות.
      // צל מטושטש מאוד (b >= 5) מחושב בחצי רזולוציה: הטשטוש חלק ממילא, והעלות יורדת פי 3 עד 4 במילים הגדולות
      const soft = shadows.filter((q) => q[0] >= 5), hard = shadows.filter((q) => q[0] < 5);
      if (soft.length) {
        const hw = Math.ceil(w / 2), hh = Math.ceil(h / 2);
        if (!p.half || p.half.width < hw || p.half.height < hh) p.half = makeCanvas(Math.max(hw, 32), Math.max(hh, 32));
        const hc = p.half.getContext('2d');
        hc.setTransform(1, 0, 0, 1, 0, 0);
        hc.clearRect(0, 0, p.half.width, p.half.height);
        hc.globalCompositeOperation = 'lighter';
        for (const [b, dx, dy, o] of soft) {
          hc.shadowColor = `rgba(0,0,0,${o})`;
          hc.shadowBlur = b;
          hc.shadowOffsetX = dx / 2;
          hc.shadowOffsetY = dy / 2;
          hc.drawImage(sil, 0, 0, w, h, 0, 0, hw, hh);
        }
        hc.shadowColor = 'transparent';
        hc.globalCompositeOperation = 'destination-out'; // בלי צבע הצללית עצמה בתוך הצל המוקטן
        hc.drawImage(sil, 0, 0, w, h, 0, 0, hw, hh);
        hc.globalCompositeOperation = 'source-over';
        c.save();
        c.globalCompositeOperation = 'lighter';
        c.drawImage(p.half, 0, 0, hw, hh, 0, 0, w, h);
        c.restore();
      }
      c.save();
      c.globalCompositeOperation = 'lighter';
      for (const [b, dx, dy, o] of hard) {
        c.shadowColor = `rgba(0,0,0,${o})`;
        c.shadowBlur = 2 * b;
        c.shadowOffsetX = dx;
        c.shadowOffsetY = dy;
        c.drawImage(sil, 0, 0, w, h, 0, 0, w, h);
      }
      c.restore();
      c.save();
      c.globalCompositeOperation = 'destination-out';
      c.drawImage(sil, 0, 0, w, h, 0, 0, w, h);
      c.restore();
    }
    if (ext) {
      const blk = silhouette('#000000', true);
      c.save();
      c.globalAlpha = 0.92;
      const n = Math.trunc(ext[2] * r);
      for (let t = 1; t <= n; t += 2) c.drawImage(blk, 0, 0, w, h, t * ext[0] * R, t * ext[1] * R, w, h);
      c.restore();
    }
  }
  if (d.halo) {
    // זוהר (ניאון): ההילה נאספת בחיבור כמו ב־halo במק; האות עצמה מכוסה אחר כך בקו המתאר ובמילוי
    const g = silhouette(d.halo, false);
    c.save();
    c.globalCompositeOperation = 'lighter';
    for (const [b, gain] of [[4, 3.2], [11, 3.4], [28, 4.2]]) {
      c.shadowColor = d.halo;
      c.shadowBlur = 2 * b * r * R;
      let left = gain;
      while (left > 0.01) { c.globalAlpha = Math.min(1, left); c.drawImage(g, 0, 0, w, h, 0, 0, w, h); left -= 1; }
    }
    c.restore();
  }
  if (!d.fillOnly && swR) {
    c.lineWidth = 2 * swR;
    c.strokeStyle = scol;
    c.strokeText(d.text, ox, oy);
  }
  c.fillStyle = d.col;
  c.fillText(d.text, ox, oy);
  p.px += w * h;
  return { cv, w, h, ox, oy, adv };
}

/** מכריח את הדפדפן לסיים את ציור ה־sprite עכשיו (קנבס 2D דוחה עבודה עד שמשתמשים בתוצאה) */
function syncSprite(p, spr) {
  if (!p.syncCtx) p.syncCtx = makeCanvas(1, 1).getContext('2d', { willReadFrequently: true });
  p.syncCtx.drawImage(spr.cv, 0, 0, 1, 1, 0, 0, 1, 1);
  p.syncCtx.getImageData(0, 0, 1, 1);
}

function getSprite(p, text, dir, size, col, scol, halo, noShadow, fillOnly) {
  const key = (fillOnly ? 'f|' : '') + text + '|' + dir + '|' + size + '|' + col + '|' + (scol || '') + '|' + (halo || '') + (noShadow ? '|n' : '');
  let s = p.sprites.get(key);
  if (s) {
    if (p.sprites.size > 1) { p.sprites.delete(key); p.sprites.set(key, s); }
    return s;
  }
  const tb = p.profile ? G.performance.now() : 0;
  s = buildSprite(p, { text, dir, size, col, scol, halo, noShadow, fillOnly });
  if (p.profile) { p.stats.buildMs += G.performance.now() - tb; p.stats.builds++; }
  s.key = key;
  p.sprites.set(key, s);
  p.built++;
  if (p.px > p.maxPx) {
    for (const k of p.sprites.keys()) {
      if (p.px <= p.maxPx * 0.8 || k === key) break;
      const old = p.sprites.get(k);
      p.px -= old.w * old.h;
      p.sprites.delete(k);
    }
  }
  return s;
}

function boxSprite(p, bw, bh, rad, col) {
  const key = 'box|' + bw + '|' + bh + '|' + rad + '|' + col;
  let s = p.sprites.get(key);
  if (s) return s;
  const mg = 30;
  const cv = makeCanvas(bw + 2 * mg, bh + 2 * mg), c = cv.getContext('2d');
  const BIG = bw + 4 * mg + 200;
  c.save();
  c.shadowColor = 'rgba(0,0,0,0.45)';
  c.shadowBlur = 20;
  c.shadowOffsetX = BIG;
  c.shadowOffsetY = 9;
  c.fillStyle = '#000';
  rrect(c, mg - BIG, mg, bw, bh, rad);
  c.fill();
  c.restore();
  c.fillStyle = col;
  rrect(c, mg, mg, bw, bh, rad);
  c.fill();
  s = { cv, w: bw + 2 * mg, h: bh + 2 * mg, ox: mg, oy: mg };
  p.sprites.set(key, s);
  p.px += s.w * s.h;
  return s;
}

function emojiSprite(p, ch, size) {
  const key = 'emo|' + ch + '|' + size;
  let s = p.sprites.get(key);
  if (s) return s;
  const w = Math.ceil(size * 1.5), h = Math.ceil(size * 1.5);
  const cv = makeCanvas(w, h), c = cv.getContext('2d');
  c.font = `${size}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(ch, w / 2, h / 2 + size * 0.13);
  s = { cv, w, h };
  p.sprites.set(key, s);
  p.px += w * h;
  return s;
}

/** כרטיס ה־hook: מצויר פעם אחת (בהגדלה 2x, מוטה ומוקטן), ובכל פריים רק drawImage עם קנה מידה ושקיפות */
function buildHookCard(p) {
  const m = p.model, hk = m.hook, hs = hk.hs, S = hk.S;
  const mg = 70 * S, cw = hk.cw, ch = hk.ch;
  const W2 = cw + 2 * mg, H2 = ch + 2 * mg;
  const big = makeCanvas(W2, H2), c = big.getContext('2d');
  c.textBaseline = 'alphabetic';
  c.lineJoin = 'round';
  const BIG = W2 + 400;
  const font = fontString(hs.w, hk.size * S, hs.fam);
  if (!hs.plain) {
    c.save(); // צל רך (מצויר מחוץ לקנבס, רק הצל נוחת בפנים)
    c.shadowColor = 'rgba(0,0,0,0.45)';
    c.shadowBlur = 2 * 16 * S;
    c.shadowOffsetX = BIG;
    c.shadowOffsetY = 14 * S;
    c.fillStyle = '#000';
    rrect(c, mg - BIG, mg, cw, ch, hk.r);
    c.fill();
    c.restore();
    if (hs.glow) {
      for (const [b, gain, lw] of [[10, 2, 6], [3, 1, 6]]) {
        c.save();
        c.shadowColor = hs.glow;
        c.shadowBlur = 2 * b * S;
        c.shadowOffsetX = BIG;
        c.strokeStyle = hs.glow;
        c.lineWidth = lw * S;
        for (let q = 0; q < gain; q++) { rrect(c, mg - BIG + (lw * S) / 2, mg + (lw * S) / 2, cw - lw * S, ch - lw * S, hk.r); c.stroke(); }
        c.restore();
      }
    }
    if (hs.accent) { c.fillStyle = hs.accent; rrect(c, mg + 12 * S, mg + 12 * S, cw, ch, hk.r); c.fill(); }
    if (hs.fill) { // כמו במק, הכרטיס מחליף את מה שמתחתיו (גם צל וצבע מבטא) ולא נמרח מעליו, כדי שכרטיס חצי שקוף יראה אותו דבר
      c.save(); c.globalCompositeOperation = 'destination-out'; rrect(c, mg, mg, cw, ch, hk.r); c.fill(); c.restore();
      c.fillStyle = hs.fill; rrect(c, mg, mg, cw, ch, hk.r); c.fill();
    }
    if (hs.border) {
      const lw = (hs.glow ? 6 : 3) * S;
      const ring = () => { c.lineWidth = lw; rrect(c, mg + lw / 2, mg + lw / 2, cw - lw, ch - lw, Math.max(0, hk.r - lw / 2)); c.stroke(); };
      c.save(); c.globalCompositeOperation = 'destination-out'; c.strokeStyle = '#000'; ring(); c.restore();
      c.strokeStyle = hs.border;
      ring();
    }
  }
  c.font = font;
  c.textAlign = 'center';
  c.direction = hk.dirn;
  const y0 = mg + hk.py + hk.cap;
  if (hs.plain) {
    for (const [b, a] of [[3, 0.5], [9, 0.7]]) {
      c.save();
      c.shadowColor = `rgba(0,0,0,${a})`;
      c.shadowBlur = 2 * b * S;
      c.shadowOffsetX = BIG;
      c.shadowOffsetY = 3 * S;
      c.fillStyle = '#000';
      hk.lines.forEach((line, j) => c.fillText(line, mg + cw / 2 - BIG, y0 + j * hk.lh));
      c.restore();
    }
  }
  c.fillStyle = hs.ink;
  hk.lines.forEach((line, j) => c.fillText(line, mg + cw / 2, y0 + j * hk.lh));
  // הטיה וצמצום ל־1x
  const ang = -hs.tilt * Math.PI / 180;
  const fw = Math.ceil((W2 * Math.abs(Math.cos(ang)) + H2 * Math.abs(Math.sin(ang))) / S);
  const fh = Math.ceil((W2 * Math.abs(Math.sin(ang)) + H2 * Math.abs(Math.cos(ang))) / S);
  const cv = makeCanvas(fw, fh), x = cv.getContext('2d');
  x.imageSmoothingEnabled = true;
  x.imageSmoothingQuality = 'high';
  x.translate(fw / 2, fh / 2);
  x.rotate(ang);
  x.drawImage(big, -W2 / (2 * S), -H2 / (2 * S), W2 / S, H2 / S);
  p.px += fw * fh;
  return { cv, w: fw, h: fh, pcx: fw / 2, pcy: fh / 2 };
}

// ---------- מצב כל מילה בכל רגע (כמו wstate במק) ----------
function popAt(tab, kk) { return lerpTab(tab, kk); }

function wordState(m, g, i, ai, kk, ff, out) {
  const cfg = m.cfg, kind = cfg.kind, w = g.w[i];
  const kc = w.kw ? cfg.kw : null;
  out.col = '#FFFFFF'; out.s = 1; out.al = 1; out.rot = 0; out.halo = null; out.box = null; out.scol = null; out.fill = null; out.part = -1; out.caret = null; out.hidden = false;
  const kp = kc && i === ai && (kind === 'karaoke' || kind === 'fade' || kind === 'kfill' || kind === 'type') ? lerpTab(KWPOP, kk) : 1;
  if (kind === 'hype') {
    const cols = HYPE_COLS;
    out.s = popAt(cfg.pop, kk);
    out.col = kc || cols[g.i % cols.length];
    out.rot = g.i % 2 ? -3.0 : 3.0;
    return out;
  }
  if (kind === 'kfill') {
    const fc = kc || cfg.acc;
    if (i < ai) out.col = fc;
    else if (i === ai) {
      const nxt = ai + 1 < g.w.length ? g.w[ai + 1].sf : w.ef;
      out.fill = [clamp((ff + 0.5) / Math.max(1, nxt - w.sf), 0.08, 1), fc];
    }
    out.s = kp;
    return out;
  }
  if (kind === 'type') {
    if (i > ai) { out.hidden = true; return out; }
    out.col = kc || '#FFFFFF';
    if (i === ai) {
      const n = Math.max(1, cpLen(w.t));
      const T = Math.max(1, Math.min(TYPE_FRAMES, (w.ef - w.sf) * BASE_FPS / m.fps));
      const k30 = Math.floor(kk);
      const typed = k30 < T ? Math.min(n, Math.ceil(n * (k30 + 1) / T)) : n;
      if (typed < n) { out.part = typed; out.caret = cfg.acc; }
    }
    out.s = kp;
    return out;
  }
  if (kind === 'karaoke') {
    out.al = i < ai ? 1.0 : i === ai ? lerpTab([0.78, 0.92, 1.0], kk) : cfg.dim;
    out.col = kc || '#FFFFFF';
    out.s = kp;
    return out;
  }
  if (kind === 'fade') { out.col = kc || '#FFFFFF'; out.s = kp; return out; }
  if (i === ai) {
    out.s = popAt(cfg.pop, kk);
    if (kind === 'pop') out.col = kc || (w.emph && cfg.emph ? cfg.emph : cfg.acc);
    else if (kind === 'neon') { out.col = '#E9FEFF'; out.halo = kc || cfg.acc; out.scol = '#08162E'; }
    else { out.col = '#FFFFFF'; out.box = kc || cfg.acc; out.scol = '#2A1A80'; }
    return out;
  }
  out.col = kc || (w.emph && cfg.emph ? cfg.emph : '#FFFFFF');
  return out;
}

// ---------- ציור פריים ----------
const SCRATCH = { st: {}, ops: [] };

function drawGroup(ctx, m, p, gi, f, tOut) {
  const g = m.groups[gi], cfg = m.cfg, kind = cfg.kind;
  const sp = capSlot(m.spl, f, m.Hf);
  const lay = m.lay[gi][sp] || m.lay[gi][0];
  const ai = activeIndex(g, f);
  const w = g.w[ai];
  const fcur = tOut * m.fps;
  const ff = Math.max(0, fcur - w.sf);
  const kk = ff * BASE_FPS / m.fps;
  let galpha = 1;
  if (kind === 'fade') {
    const prv = gi > 0 ? m.groups[gi - 1] : null, nxt = gi + 1 < m.groups.length ? m.groups[gi + 1] : null;
    let q = 4;
    const sc30 = BASE_FPS / m.fps;
    if (!(prv && prv.ef === g.sf)) q = Math.min(q, (fcur - g.sf + 1) * sc30);
    if (!(nxt && nxt.sf === g.ef)) q = Math.min(q, (g.ef - fcur) * sc30);
    galpha = clamp(q / 4, 0, 1);
    if (galpha <= 0) return;
  }
  const st = SCRATCH.st;
  const ops = SCRATCH.ops;
  let n = 0;
  const items = lay.items;
  for (let q = 0; q < items.length; q++) {
    const it = items[q], i = it.i;
    wordState(m, g, i, ai, kk, ff, st);
    if (st.hidden) continue;
    let op = ops[n];
    if (!op) op = ops[n] = {};
    n++;
    op.it = it;
    op.col = st.col; op.s = st.s; op.al = st.al; op.rot = st.rot; op.halo = st.halo; op.box = st.box; op.scol = st.scol; op.fill = st.fill; op.part = st.part; op.caret = st.caret;
    op.sc = st.s * (it.sf || 1);
  }
  // סדר ציור: הקטנים קודם, המילה הגדולה (הפעילה) אחרונה
  for (let a = 1; a < n; a++) { const o = ops[a]; let b = a - 1; while (b >= 0 && ops[b].sc > o.sc) { ops[b + 1] = ops[b]; b--; } ops[b + 1] = o; }
  const rtl = m.rtl, vc = cfg.vc, R = p.R;
  for (let q = 0; q < n; q++) {
    const op = ops[q], it = op.it, i = it.i;
    const sfI = it.sf || 1;
    const base = Math.max(8, Math.round(lay.size * sfI));
    let text = lay.texts[i];
    const dir = lay.dirs[i];
    if (op.part >= 0) text = Array.from(text).slice(0, op.part).join('');
    if (!text) continue;
    const spr = getSprite(p, text, dir, base, op.col, op.scol, op.halo, !!op.box, false);
    const scp = op.s;
    const d = scp / R;
    const wAdv = spr.adv / R;
    const sizeS = base * scp;
    let X = it.x + it.adv / 2 - wAdv * scp / 2;
    const B = it.by + vc * lay.size * (scp - 1);
    if (op.part >= 0) X = rtl && dir === 'rtl' ? it.x + it.adv - wAdv : it.x;
    const x0 = X - spr.ox * d, y0 = B - spr.oy * d, dw = spr.w * d, dh = spr.h * d;
    ctx.globalAlpha = op.al * galpha;
    if (op.box) { // הקופסה נבנית פעם אחת בגודל הבסיס ומוקטנת/מוגדלת עם הקפיצה
      const bw = Math.round((wAdv + 0.56 * base) / 2) * 2, bh = Math.round(1.26 * base / 2) * 2;
      const bs = boxSprite(p, bw, bh, Math.round(0.30 * base), op.box);
      ctx.drawImage(bs.cv, it.x + it.adv / 2 - (bs.ox + bw / 2) * scp, B - 1.0 * sizeS - bs.oy * scp, bs.w * scp, bs.h * scp);
    }
    if (op.rot) {
      ctx.save();
      ctx.translate(x0 + dw / 2, y0 + dh / 2);
      ctx.rotate(-op.rot * Math.PI / 180);
      ctx.drawImage(spr.cv, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
    } else ctx.drawImage(spr.cv, x0, y0, dw, dh);
    if (op.fill) { // קריוקי: המילה הצבועה נחשפת מצד תחילת המילה (מימין במילה עברית)
      const fs = getSprite(p, text, dir, base, op.fill[1], null, null, true, true);
      const frac = op.fill[0], adv = fs.adv;
      const fx0 = X - fs.ox * d, fy0 = B - fs.oy * d, fdh = fs.h * d;
      if (dir === 'rtl') {
        const sx = fs.ox + adv - adv * frac;
        ctx.drawImage(fs.cv, sx, 0, fs.w - sx, fs.h, fx0 + sx * d, fy0, (fs.w - sx) * d, fdh);
      } else {
        const cut = fs.ox + adv * frac;
        ctx.drawImage(fs.cv, 0, 0, cut, fs.h, fx0, fy0, cut * d, fdh);
      }
    }
    if (op.caret) {
      const cw = Math.max(3, Math.trunc(0.07 * sizeS)), ch = Math.trunc(0.86 * sizeS);
      ctx.fillStyle = op.caret;
      ctx.fillRect(rtl && dir === 'rtl' ? X - cw - 3 : X + wAdv * scp + 3, B - 0.8 * sizeS, cw, ch);
    }
  }
  ctx.globalAlpha = galpha;
  const e = m.emo[g.i];
  if (e && f >= e.sf) drawEmoji(ctx, m, p, g, lay, e, f);
  ctx.globalAlpha = 1;
}

function drawEmoji(ctx, m, p, g, lay, e, f) {
  const ph = Math.min(Math.floor((f - e.sf) * BASE_FPS / m.fps), EMO.length - 1);
  const [scl, dy, al] = EMO[ph];
  const size = lay.size * 1.4;
  const sz = Math.max(8, Math.round(size * scl));
  const it = lay.items.find((q) => q.i === e.wi);
  if (!it) return;
  const spr = emojiSprite(p, e.ch, sz);
  const cx = clamp(it.x + it.adv / 2, m.sx0 + size / 2 + 16 * m.sc, m.sx1 - size / 2 - 16 * m.sc);
  const cy = lay.top + 0.02 * size - size / 2 + dy * size;
  ctx.globalAlpha = al;
  ctx.drawImage(spr.cv, cx - spr.w / 2, cy - spr.h / 2);
}

/** שקיפות וקנה מידה של כרטיס ה־hook בזמן tOut (כניסה / מנוחה / יציאה), או null כשהוא לא מוצג */
export function hookPhase(m, tOut) {
  if (!m.Hf) return null;
  const f = frameAt(tOut, m.fps);
  if (f < 0 || f >= m.Hf) return null;
  const k = tOut * BASE_FPS, total = m.Hf / m.fps * BASE_FPS;
  if (k >= total - OUT_A.length) { const q = k - (total - OUT_A.length); return { a: lerpTab(OUT_A, q), s: lerpTab(OUT_S, q), phase: 'out' }; }
  if (k < IN_A.length) return { a: lerpTab(IN_A, k), s: lerpTab(IN_S, k), phase: 'in' };
  return { a: 1, s: 1, phase: 'rest' };
}

function drawHook(ctx, m, p, tOut) {
  const ph = hookPhase(m, tOut);
  if (!ph) return;
  if (!p.hookCard) p.hookCard = buildHookCard(p);
  const card = p.hookCard, hk = m.hook;
  const sc = ph.s * hk.scale;
  let cx = m.cx, cy = hk.cy;
  if (m.safe) { // כרטיס שנכנס בהגדלה לא יוצא מהאזור הבטוח
    const hw = card.w * sc / 2, hh = card.h * sc / 2;
    cx = clamp(cx, Math.min(m.sx0 + hw, m.cx), Math.max(m.sx1 - hw, m.cx));
    cy = clamp(cy, Math.min(m.sy0 + hh, cy), Math.max(m.sy1 - hh, cy));
  }
  ctx.globalAlpha = ph.a;
  ctx.drawImage(card.cv, cx - card.pcx * sc, cy - card.pcy * sc, card.w * sc, card.h * sc);
  ctx.globalAlpha = 1;
}

/**
 * מצב הכתוביות בזמן tOut בלי ציור (לבדיקות ולדף ההדגמה): {f, gi, slot, ai, hook, items:[{i, text, col, s, al, rot, halo, box, fill, part, hidden}]}
 */
export function stateAt(prepared, tOut) {
  const m = prepared.model || prepared;
  const f = frameAt(tOut, m.fps);
  const out = { f, gi: -1, slot: 0, ai: -1, hook: hookPhase(m, tOut), items: [] };
  if (f < 0 || f >= m.N) return out;
  const gi = groupAt(m.groups, f);
  if (gi < 0) return out;
  const g = m.groups[gi];
  out.gi = gi;
  out.slot = capSlot(m.spl, f, m.Hf);
  out.ai = activeIndex(g, f);
  const lay = m.lay[gi][out.slot] || m.lay[gi][0];
  const ff = Math.max(0, tOut * m.fps - g.w[out.ai].sf), kk = ff * BASE_FPS / m.fps;
  const st = {};
  for (const it of lay.items) {
    wordState(m, g, it.i, out.ai, kk, ff, st);
    out.items.push(Object.assign({ i: it.i, text: lay.texts[it.i], x: it.x, adv: it.adv, by: it.by }, st));
  }
  return out;
}

/** בונה מראש sprites של קבוצה (כל מילה במצב רגיל ובמצב פעיל), עד budget sprites; מחזיר את המיקום שהגיע אליו */
function warmGroup(p, gi, pos, budget, deadline, sync) {
  const m = p.model, g = m.groups[gi];
  const lay = m.lay[gi][capSlot(m.spl, g.sf, m.Hf)] || m.lay[gi][0];
  const st = {};
  const total = warmTotal(m, gi, lay);
  while (budget > 0 && pos < total && !(deadline && budget < 99 && G.performance.now() > deadline && p.warmDid)) {
    if (pos < lay.items.length * 2) {
      const it = lay.items[pos >> 1], i = it.i, active = (pos & 1) === 0;
      const ai = active ? i : (i === 0 ? Math.min(1, g.w.length - 1) : 0);
      if (!active && g.w.length === 1) { pos++; continue; } // קבוצה של מילה אחת: המילה תמיד פעילה
      wordState(m, g, i, ai, 0, 0, st);
      if (!st.hidden && st.part < 0 && lay.texts[i]) {
        const base = Math.max(8, Math.round(lay.size * (it.sf || 1)));
        const before = p.built;
        const spr = getSprite(p, lay.texts[i], lay.dirs[i], base, st.col, st.scol, st.halo, !!st.box, false);
        if (sync && p.built !== before) syncSprite(p, spr); // הציור בקנבס נדחה עד לשימוש הראשון, ופה מכריחים אותו כבר בהכנה
        if (st.fill) getSprite(p, lay.texts[i], lay.dirs[i], base, st.fill[1], null, null, true, true);
        if (st.box) boxSprite(p, Math.round((spr.adv / p.R + 0.56 * base) / 2) * 2, Math.round(1.26 * base / 2) * 2, Math.round(0.30 * base), st.box);
        budget--;
        p.warmDid = true;
      }
    } else {
      const e = m.emo[g.i];
      const size = lay.size * 1.4;
      if (e) emojiSprite(p, e.ch, Math.max(8, Math.round(size * EMO[pos - lay.items.length * 2][0])));
      budget--;
      p.warmDid = true;
    }
    pos++;
  }
  return pos;
}
const warmTotal = (m, gi, lay) => lay.items.length * 2 + (m.emo[m.groups[gi].i] ? EMO.length : 0);

/** מחמם את הקבוצה הבאה, sprite או שניים לפריים, כדי שהמעבר לקבוצה חדשה לא יתקע */
function warmNext(p, gi, budget, ms) {
  const m = p.model, ng = gi + 1;
  if (ng >= m.groups.length || p.warmDone >= ng) return;
  if (p.warmGroup !== ng) { p.warmGroup = ng; p.warmPos = 0; }
  p.warmDid = false;
  p.warmPos = warmGroup(p, ng, p.warmPos, budget, G.performance.now() + ms);
  const g = m.groups[ng];
  if (p.warmPos >= warmTotal(m, ng, m.lay[ng][capSlot(m.spl, g.sf, m.Hf)] || m.lay[ng][0])) { p.warmDone = ng; p.warmPos = 0; }
}

/**
 * מצייר את הכתוביות של זמן הפלט tOut (שניות) על ctx. הקנבס אמור להיות בגודל spec.width x spec.height.
 * מחזיר true אם צויר משהו. לפני ש־prepared.ready הסתיים לא מצויר כלום.
 */
export function drawCaptions(ctx, tOut, prepared) {
  const p = prepared;
  const m = p && p.model;
  if (!m || !p.isReady || !p.fontCtx) return false;
  const f = frameAt(tOut, m.fps);
  if (f < 0 || f >= m.N) return false;
  const t0 = p.profile ? G.performance.now() : 0;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.globalCompositeOperation = 'source-over';
  let drew = false;
  if (m.Hf && f < m.Hf) { drawHook(ctx, m, p, tOut); drew = true; }
  const gi = groupAt(m.groups, f);
  if (gi >= 0) {
    drawGroup(ctx, m, p, gi, f, tOut);
    if (m.groups[gi].ef - f < 12) warmNext(p, gi, 4, 3); else warmNext(p, gi, 2, 1.2);
    drew = true;
  }
  ctx.restore();
  if (p.profile) { const dt = G.performance.now() - t0; p.stats.frames++; p.stats.total += dt; if (dt > p.stats.max) p.stats.max = dt; p.stats.samples.push(dt); }
  return drew;
}

/**
 * מכין כתוביות לקליפ. סינכרוני: מתחיל לטעון גופנים ומחזיר מיד אובייקט; prepared.ready (Promise<true>) מסתיים כשהגופנים נטענו והפריסה מוכנה.
 * אפשרויות: {measure} (מדידה מוזרקת, לבדיקות ב־node), {fontBase} (כתובת תיקיית הגופנים), {profile:true} (לאסוף זמני ציור ב־prepared.stats).
 */
export function prepareCaptions(spec, opts = {}) {
  const p = { spec, model: null, isReady: false, ready: null, sprites: new Map(), px: 0, maxPx: 16e6, built: 0, R: 1, hookCard: null, warmDone: -1, warmPos: 0, warmGroup: -1, profile: !!opts.profile, stats: { frames: 0, total: 0, max: 0, samples: [], buildMs: 0, builds: 0 }, fontCtx: null };
  const canvas = canvasAvailable() && !opts.measure;
  const build = () => {
    p.fontCtx = canvas ? makeCanvas(4, 4).getContext('2d') : null;
    p.measure = opts.measure || (canvas ? createMeasurer() : heuristicMeasure);
    p.model = buildModel(spec, p.measure);
    const m = p.model;
    p.R = Math.min(1.15, Math.max(1, ...(m.cfg.pop || [1]), m.groups.some((g) => g.w.some((w) => w.kw)) ? KWPOP[1] : 1));
    if (canvas) { // חימום: הקבוצות הראשונות וכרטיס ה־hook, כדי שהפריים הראשון לא יתקע
      if (m.Hf) p.hookCard = buildHookCard(p);
      if (m.hasEmo) emojiSprite(p, '\u{1F600}', 24); // הציור הראשון של אמוג'י טוען את גופן האמוג'י: לא בזמן ניגון
      for (let gi = 0; gi < Math.min(2, m.groups.length); gi++) warmGroup(p, gi, 0, 1e9, 0, true);
      p.warmDone = Math.min(1, m.groups.length - 1);
    }
    p.isReady = true;
  };
  /** מחמם מראש את הכתוביות של טווח זמן (שניות פלט), קבוצה אחר קבוצה, ומחזיר שליטה לממשק בין קבוצות. לקריאה בזמן בטלה לפני ניגון או ייצוא */
  p.warm = async (t0 = 0, t1 = Infinity) => {
    const m = p.model;
    if (!m || !p.fontCtx) return 0;
    let n = 0;
    for (let gi = 0; gi < m.groups.length; gi++) {
      const g = m.groups[gi];
      if (g.ef / m.fps < t0 || g.sf / m.fps > t1) continue;
      if (p.px > p.maxPx * 0.9) break;
      warmGroup(p, gi, 0, 1e9, 0, true);
      n++;
      await new Promise((r) => setTimeout(r, 0));
    }
    return n;
  };
  p.dispose = () => { p.sprites.clear(); p.px = 0; p.hookCard = null; p.isReady = false; };
  p.info = () => ({ groups: p.model ? p.model.groups.length : 0, sprites: p.sprites.size, megapixels: +(p.px / 1e6).toFixed(2), fontsOk, rtl: p.model ? p.model.rtl : null, style: p.model ? p.model.style : null });
  if (!canvas || fontsLoaded()) {
    build();
    p.ready = Promise.resolve(true);
  } else {
    p.ready = loadFonts(opts.fontBase).then(() => { build(); return true; });
  }
  return p;
}
function fontsLoaded() { return fontsDone; }
