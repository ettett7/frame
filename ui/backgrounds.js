// רקעים מובנים להחלפת רקע: מציירים אותם על קנבס רק כשצריך, כך שאין צורך בקבצי תמונה נוספים.
import { BG_SCENES } from './model.js';

export function sceneBlob(id, w = 1080, h = 1920) {
  const sc = BG_SCENES.find((x) => x.id === id) || BG_SCENES[0];
  return new Promise((resolve) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const lin = g.createLinearGradient(0, 0, w * 0.55, h);
    lin.addColorStop(0, sc.from); lin.addColorStop(1, sc.to);
    g.fillStyle = lin; g.fillRect(0, 0, w, h);
    // כתמי אור רכים, כדי שהרקע לא יראה שטוח
    for (const [x, y, r, a] of [[0.22, 0.2, 0.55, 0.22], [0.85, 0.55, 0.5, 0.16], [0.35, 0.92, 0.6, 0.18]]) {
      const rg = g.createRadialGradient(w * x, h * y, 0, w * x, h * y, w * r);
      rg.addColorStop(0, `rgba(255,255,255,${a})`); rg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = rg; g.fillRect(0, 0, w, h);
    }
    c.toBlob((b) => resolve(b), 'image/jpeg', 0.88);
  });
}
