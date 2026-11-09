// Generates the HyperFrames animatic for the Ahzab reel.
import fs from "node:fs";
import path from "node:path";

const OUT = process.argv[2];
const W = 1080, H = 1920;

const FONTS = `
@font-face{font-family:"AhzKufi";src:url("assets/fonts/kufi.woff2") format("woff2");font-weight:100 900;}
@font-face{font-family:"AhzAmiri";src:url("assets/fonts/amiri-400.woff2") format("woff2");font-weight:400;}
@font-face{font-family:"AhzAmiri";src:url("assets/fonts/amiri-700.woff2") format("woff2");font-weight:700;}
@font-face{font-family:"AhzQuran";src:url("assets/fonts/amiri-quran.woff2") format("woff2");font-weight:400;}`;

// mood: background + accent per lighting
const MOOD = {
  dusk:  { bg: "#2a1a10", glow: "#b36a2e" },
  dawn:  { bg: "#1c232c", glow: "#6f86a3" },
  grey:  { bg: "#24211d", glow: "#8a7f6c" },
  night: { bg: "#0f1420", glow: "#303e59" },
  sun:   { bg: "#3a2a16", glow: "#e0a65a" },
};

const scenes = [
  { id: "s01", t: 0,  d: 3, chr: "CHR-008", cam: "low_angle", mood: "dusk", img: "rider", push: "fast",
    card: "١٠٬٠٠٠ مقاتل… ولا معركة", cardAt0: true,
    subs: [["عشرةُ آلافِ مقاتلٍ حاصروا المدينةَ ليُنهوا الإسلام…", 0, 3]] },
  { id: "s02", t: 3,  d: 3, chr: "مكان بلا أشخاص", cam: "wide", mood: "dawn", env: "camp",
    card: "رحلوا… بلا معركة",
    subs: [["ورحلوا دون معركةٍ واحدة. كيف؟", 0, 3]] },
  { id: "s03", t: 6,  d: 4, chr: "CHR-027", cam: "extreme_closeup", mood: "grey", img: "poor",
    card: "٣٬٠٠٠ … وخندق",
    subs: [["المسلمون ثلاثةُ آلاف… وسلاحُهم الأول: حُفرة.", 0, 4]] },
  { id: "s04", t: 10, d: 4, chr: "CHR-012", cam: "back", mood: "grey", img: "scout",
    card: "٥ هـ · غزوة الأحزاب",
    subs: [["السنةُ الخامسةُ للهجرة. تحالفت قريشٌ وغطفانُ على المدينة.", 0, 4]] },
  { id: "s05", t: 14, d: 5, chr: "CHR-040", cam: "full_body tracking", mood: "grey", img: "teen",
    card: "البرد · الجوع · الخندق",
    subs: [["في البردِ والجوع حفروا خندقًا، ينقلون الترابَ على أكتافهم.", 0, 5]] },
  { id: "s06", t: 19, d: 4, chr: "CHR-008", cam: "medium_shot", mood: "dusk", img: "riders",
    card: "خندقٌ لم تعرفه العرب",
    subs: [["وصلت الأحزاب… فوجدوا خندقًا لم تعرفه حروبُ العرب.", 0, 4]] },
  { id: "s07", t: 23, d: 5, chr: "CHR-029", cam: "full_body tracking", mood: "night", img: "artisan",
    card: "نقضوا العهد… من الداخل",
    subs: [["ثم جاء الخبرُ الأقسى: بنو قريظة نقضوا العهدَ من الداخل.", 0, 5]] },
  { id: "s08", t: 28, d: 3, chr: "CHR-032 + CHR-038", cam: "right_three_quarter", mood: "night", img: "woman", img2: "boy",
    subs: [["وهنا… وصفَ القرآنُ ما في القلوب:", 0, 3]] },
  { id: "s09", t: 31, d: 6, chr: "CHR-007", cam: "extreme_closeup", mood: "night", img: "eye", verse: true },
  { id: "s10", t: 37, d: 7, chr: "CHR-009", cam: "back · wide", mood: "night", img: "archer", verse: true },
  { id: "s11", t: 44, d: 6, chr: "CHR-007", cam: "high_angle", mood: "night", img: "infantry", verse: true },
  { id: "s12", t: 50, d: 6, chr: "CHR-003", cam: "medium_shot", mood: "night", img: "chr003", wind: true,
    card: "ثم… الريح",
    subs: [["ثم في ليلةٍ باردة… أرسل اللهُ الريح.", 0, 3], ["اقتلعت خيامَهم، وقلبت قدورَهم.", 3, 3]] },
  { id: "s13", t: 56, d: 9, chr: "CHR-008", cam: "back", mood: "dawn", img: "rider", flip: true, verse: true, wind: true },
  { id: "s14", t: 65, d: 6, chr: "مكان بلا أشخاص", cam: "wide · slow push-in", mood: "sun", env: "plain",
    card: "رحلوا بلا معركة", card2: "🔖 احفظ الفيديو",
    subs: [["عشرةُ آلاف… رحلوا بلا معركة.", 0, 3], ["وقال النبيُّ ﷺ: «الآنَ نغزوهم ولا يغزوننا» — صحيح البخاري", 3, 3]] },
];

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function plate(s) {
  const id = s.id;
  if (s.env === "camp") {
    // abandoned camp at dawn: horizon, torn tent shapes, hoofprint dots, blowing scraps
    const scraps = [0, 1, 2, 3, 4, 5].map((i) =>
      `<div id="${id}-scrap${i}" class="scrap" style="top:${380 + i * 70}px;left:${-60 - i * 40}px"></div>`).join("");
    const prints = Array.from({ length: 9 }, (_, i) =>
      `<div class="print" style="left:${470 + i * 18 + (i % 2) * 14}px;top:${620 - i * 22}px"></div>`).join("");
    return `<div id="${id}-plate" class="plate env dawnsky">
      <div class="ground"></div>
      <div class="tent" style="left:110px;top:520px;transform:rotate(-14deg)"></div>
      <div class="tent" style="left:620px;top:560px;transform:rotate(9deg) scale(.8)"></div>
      <div class="pot" style="left:330px;top:640px"></div>
      ${prints}${scraps}
    </div>`;
  }
  if (s.env === "plain") {
    return `<div id="${id}-plate" class="plate env sunsky">
      <div id="${id}-sun" class="sun"></div>
      <div class="ground"></div>
      <div class="trench"></div>
      ${Array.from({ length: 7 }, (_, i) => `<div class="palm" style="left:${40 + i * 120}px;height:${120 + (i % 3) * 30}px"></div>`).join("")}
    </div>`;
  }
  const flip = s.flip ? " flip" : "";
  const short = s.verse ? " short" : "";
  if (s.img2) {
    return `<div id="${id}-plate" class="plate duo">
      <div class="half"><img id="${id}-img" class="kb${flip}" src="assets/img/${s.img}.jpg" alt=""></div>
      <div class="half"><img id="${id}-img2" class="kb" src="assets/img/${s.img2}.jpg" alt=""></div>
    </div>`;
  }
  return `<div id="${id}-plate" class="plate${short}"><img id="${id}-img" class="kb${flip}" src="assets/img/${s.img}.jpg" alt=""></div>`;
}

function scene(s) {
  const id = s.id, m = MOOD[s.mood];
  const subs = (s.subs || []).map(([txt, st, du], i) =>
    `<p id="${id}-sub${i}" class="clip sub" dir="rtl" data-start="${st}" data-duration="${du}">${txt}</p>`).join("\n    ");
  const card = s.card ? `<div id="${id}-card" class="clip card" dir="rtl" data-start="0" data-duration="${s.d}"><span id="${id}-cardtxt">${s.card}</span></div>` : "";
  const card2 = s.card2 ? `<div id="${id}-card2" class="clip card2" dir="rtl" data-start="3" data-duration="3"><span id="${id}-card2txt">${s.card2}</span></div>` : "";
  const streaks = s.wind ? Array.from({ length: 10 }, (_, i) =>
    `<div id="${id}-wind${i}" class="streak" style="top:${300 + i * 72}px;width:${160 + (i * 53) % 220}px"></div>`).join("") : "";

  let js = "";
  if (s.img) {
    const from = s.push === "fast" ? 1.0 : 1.02;
    const to = s.push === "fast" ? 1.16 : 1.12;
    const dur = s.push === "fast" ? 1.2 : s.d;
    const flip = s.flip ? -1 : 1;
    js += `tl.fromTo("#${id}-img",{scaleX:${from * flip},scaleY:${from}},{scaleX:${to * flip},scaleY:${to},duration:${dur},ease:"${s.push === "fast" ? "power3.out" : "none"}"},0);\n`;
    if (s.img2) js += `tl.fromTo("#${id}-img2",{scale:1.02},{scale:1.12,duration:${s.d},ease:"none"},0);\n`;
  }
  if (s.env === "camp") {
    for (let i = 0; i < 6; i++) js += `tl.fromTo("#${id}-scrap${i}",{x:0,rotation:0},{x:${1150 + i * 60},rotation:${180 + i * 40},duration:${2.2 + (i % 3) * 0.3},ease:"none"},${(i * 0.13).toFixed(2)});\n`;
  }
  if (s.env === "plain") {
    js += `tl.fromTo("#${id}-plate",{scale:1},{scale:1.08,duration:${s.d},ease:"none"},0);\n`;
    js += `tl.fromTo("#${id}-sun",{y:60},{y:0,duration:${s.d},ease:"sine.out"},0);\n`;
  }
  if (s.wind) {
    for (let i = 0; i < 10; i++) js += `tl.fromTo("#${id}-wind${i}",{x:-400,opacity:0},{x:1300,opacity:0.7,duration:${0.9 + (i % 4) * 0.25},ease:"none",repeat:${Math.ceil(s.d / 0.9)}},${(i * 0.17).toFixed(2)});\n`;
  }
  if (s.card && !s.cardAt0) js += `tl.fromTo("#${id}-cardtxt",{opacity:0,y:24},{opacity:1,y:0,duration:0.35,ease:"power3.out"},0.15);\n`;
  if (s.card2) js += `tl.fromTo("#${id}-card2txt",{opacity:0,scale:0.9},{opacity:1,scale:1,duration:0.35,ease:"back.out(2)"},0.1);\n`;

  return `<template>
  <style>
    ${FONTS}
    #root{position:absolute;inset:0;background:${m.bg};overflow:hidden;}
    #root .clip{position:absolute;}
    #root .label{position:absolute;top:184px;left:90px;right:90px;display:flex;justify-content:space-between;align-items:center;font-family:"AhzKufi";font-size:28px;color:#e5d1ad;opacity:.85;letter-spacing:.02em;}
    #root .label b{font-weight:700;color:${m.glow === "#303e59" ? "#9fb2d6" : m.glow};}
    #root .tag{position:absolute;top:268px;right:108px;z-index:6;font-family:"AhzKufi";font-size:28px;color:#fff4dd;background:#32271ecc;padding:2px 16px 6px;border-radius:30px;}
    #root .plate{position:absolute;left:90px;top:250px;width:900px;height:760px;overflow:hidden;border:2px solid #e5d1ad40;border-radius:8px;background:#e5d1ad;box-shadow:0 0 120px ${m.glow}55;}
    #root .plate img{width:100%;height:100%;object-fit:cover;display:block;}
    #root .duo{display:flex;}
    #root .plate.short{height:640px;}
    #root .half{width:50%;height:100%;overflow:hidden;}
    #root .card{z-index:5;left:60px;right:60px;top:1040px;text-align:center;}
    #root .card span{display:inline-block;font-family:"AhzKufi";font-weight:900;font-size:64px;line-height:1.2;white-space:nowrap;color:#fff4dd;background:#32271ecc;padding:6px 34px 14px;border-radius:10px;}
    #root .card2{left:60px;right:60px;top:880px;text-align:center;}
    #root .card2 span{display:inline-block;font-family:"AhzKufi";font-weight:700;font-size:52px;color:#32271e;background:#e5d1ad;padding:4px 30px 10px;border-radius:40px;}
    #root .sub{z-index:5;left:80px;right:80px;top:1170px;text-align:center;font-family:"AhzAmiri";font-weight:700;font-size:54px;line-height:1.45;color:#fff;text-shadow:0 3px 14px #000;}
    #root .env{background:none;}
    #root .dawnsky{background:linear-gradient(#5d6f88 0%,#a7a9a6 58%,#3b3429 58%,#2a241c 100%);}
    #root .sunsky{transform-origin:50% 100%;background:linear-gradient(#d98c3f 0%,#f2c27a 55%,#4a3a25 55%,#2f2618 100%);}
    #root .ground{position:absolute;left:0;right:0;top:58%;bottom:0;}
    #root .tent{position:absolute;width:220px;height:120px;background:#e5d1ad;clip-path:polygon(0 100%,45% 0,62% 30%,100% 100%,70% 80%,40% 100%);opacity:.8;}
    #root .pot{position:absolute;width:70px;height:46px;border-radius:0 0 40px 40px;background:#1b1610;transform:rotate(100deg);}
    #root .print{position:absolute;width:12px;height:16px;border-radius:50%;background:#1b1610;opacity:.7;}
    #root .scrap{position:absolute;width:40px;height:16px;background:#e5d1ad;opacity:.75;}
    #root .sun{position:absolute;left:390px;top:300px;width:120px;height:120px;border-radius:50%;background:#fff1c9;box-shadow:0 0 120px 40px #ffd28a;}
    #root .trench{position:absolute;left:-20px;right:-20px;top:66%;height:70px;background:#1b1610;border-top:6px solid #6b5536;transform:skewY(-3deg);}
    #root .palm{position:absolute;bottom:44%;width:10px;background:#2f2618;}
    #root .streak{position:absolute;z-index:4;left:0;height:3px;border-radius:3px;background:linear-gradient(90deg,transparent,#e5d1adcc,transparent);opacity:0;}
  </style>
  <div id="root" data-composition-id="${id}" data-width="${W}" data-height="${H}">
    <div class="label"><span><b>${id.toUpperCase()}</b> · ${s.chr} · ${s.cam} · ${fmt(s.t)}–${fmt(s.t + s.d)}</span></div>
    <div class="tag">صورة مؤقتة</div>
    ${plate(s)}
    ${streaks}
    ${card}
    ${card2}
    ${subs}
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    ${js}
    window.__timelines["${id}"] = tl;
  </script>
</template>
`;
}

// verse overlay, spans 31s–65s in root
const verses = [
  { id: "v10", start: 0, dur: 13, ref: "الأحزاب: ١٠",
    text: "إِذْ جَآءُوكُم مِّن فَوْقِكُمْ وَمِنْ أَسْفَلَ مِنكُمْ وَإِذْ زَاغَتِ ٱلْأَبْصَٰرُ وَبَلَغَتِ ٱلْقُلُوبُ ٱلْحَنَاجِرَ وَتَظُنُّونَ بِٱللَّهِ ٱلظُّنُونَا۠" },
  { id: "v11", start: 13, dur: 6, ref: "الأحزاب: ١١",
    text: "هُنَالِكَ ٱبْتُلِىَ ٱلْمُؤْمِنُونَ وَزُلْزِلُوا۟ زِلْزَالًۭا شَدِيدًۭا" },
  { id: "v25", start: 25, dur: 9, ref: "الأحزاب: ٢٥",
    text: "وَرَدَّ ٱللَّهُ ٱلَّذِينَ كَفَرُوا۟ بِغَيْظِهِمْ لَمْ يَنَالُوا۟ خَيْرًۭا ۚ وَكَفَى ٱللَّهُ ٱلْمُؤْمِنِينَ ٱلْقِتَالَ" },
];
const versesHtml = `<template>
  <style>
    ${FONTS}
    #root{position:absolute;inset:0;}
    #root .clip{position:absolute;left:60px;right:60px;top:920px;}
    #root .box{background:#14100bf0;border:2px solid #b38b52;border-radius:14px;padding:18px 34px 22px;text-align:center;}
    #root .ayah{font-family:"AhzQuran";font-size:50px;line-height:1.75;color:#f4e6c6;}
    #root .ref{margin-top:8px;font-family:"AhzKufi";font-weight:700;font-size:30px;color:#b38b52;}
    #root .rec{font-family:"AhzKufi";font-size:28px;color:#e5d1ad99;margin-bottom:6px;}
  </style>
  <div id="root" data-composition-id="verses" data-width="${W}" data-height="${H}">
    ${verses.map((v) => `<div id="${v.id}" class="clip" dir="rtl" data-start="${v.start}" data-duration="${v.dur}">
      <div id="${v.id}-box" class="box">
        <div class="rec">▶ تلاوة: مشاري العفاسي (تُضاف في المونتاج)</div>
        <div class="ayah">${v.text}</div>
        <div class="ref">${v.ref}</div>
      </div>
    </div>`).join("\n    ")}
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    ${verses.map((v) => `tl.fromTo("#${v.id}-box",{opacity:0,y:30},{opacity:1,y:0,duration:0.6,ease:"power2.out"},${v.start + 0.05});`).join("\n    ")}
    window.__timelines["verses"] = tl;
  </script>
</template>
`;

fs.mkdirSync(path.join(OUT, "compositions"), { recursive: true });
for (const s of scenes) fs.writeFileSync(path.join(OUT, "compositions", `${s.id}.html`), scene(s));
fs.writeFileSync(path.join(OUT, "compositions", "verses.html"), versesHtml);

const total = 71;
const hosts = scenes.map((s) => `      <div id="${s.id}" data-composition-id="${s.id}" data-composition-src="compositions/${s.id}.html" data-start="${s.t}" data-duration="${s.d}" data-track-index="1" data-track-kind="graphics" data-width="${W}" data-height="${H}"></div>`).join("\n");
const index = `<!doctype html>
<html lang="ar">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <script src="assets/vendor/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: #0f1420; }
      #root { position: relative; width: 100%; height: 100%; }
      #root > div { position: absolute; inset: 0; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${total}" data-width="${W}" data-height="${H}">
${hosts}
      <div id="verses" data-composition-id="verses" data-composition-src="compositions/verses.html" data-start="31" data-duration="34" data-track-index="2" data-track-kind="graphics" data-width="${W}" data-height="${H}" style="z-index:5"></div>
      <audio id="wind" src="assets/audio/wind.m4a" data-start="0" data-duration="${total}" data-track-index="3" data-volume="0.8"></audio>
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>
`;
fs.writeFileSync(path.join(OUT, "index.html"), index);
console.log("wrote", scenes.length, "scenes");
