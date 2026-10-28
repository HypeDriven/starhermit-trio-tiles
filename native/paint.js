/**
 * The carved-tile painters of the browser build's js/render/materials.js,
 * unchanged (symbol hues and the Okabe–Ito palettes, the twelve glyphs, the
 * corner notches, the rounded-rect path): native/render.ts paints them on
 * OffscreenCanvas (starhermit:canvas) into the tile face and bump textures.
 */
// Per-symbol hues chosen for perceptual separation after ACES tone mapping.
const SYMBOL_COLORS_DEFAULT = {
  leaf: '#3e7a46',
  drop: '#3a6ea8',
  moon: '#7a6ac8',
  sun: '#c8862a',
  bloom: '#c85a8a',
  peak: '#6a7a8a',
  wave: '#3a9a9a',
  fan: '#c85a4a',
  stone: '#8a7a5a',
  crane: '#b04a3a',
  koi: '#d07a3a',
  lantern: '#a84a6a',
};

// Okabe–Ito derived variants for common color-vision deficiencies.
const SYMBOL_COLORS_CB = {
  deuteranopia: {
    leaf: '#0072b2', drop: '#56b4e9', moon: '#cc79a7', sun: '#e69f00', bloom: '#f0e442',
    peak: '#999999', wave: '#009e73', fan: '#d55e00', stone: '#7a6a4a', crane: '#882255',
    koi: '#44aa99', lantern: '#aa4499',
  },
  protanopia: {
    leaf: '#0072b2', drop: '#56b4e9', moon: '#cc79a7', sun: '#e69f00', bloom: '#f0e442',
    peak: '#999999', wave: '#009e73', fan: '#d55e00', stone: '#7a6a4a', crane: '#332288',
    koi: '#44aa99', lantern: '#aa4499',
  },
  tritanopia: {
    leaf: '#009e73', drop: '#0072b2', moon: '#cc79a7', sun: '#e69f00', bloom: '#f0e442',
    peak: '#999999', wave: '#44aa99', fan: '#d55e00', stone: '#7a6a4a', crane: '#882255',
    koi: '#ddcc77', lantern: '#aa4499',
  },
};

export function symbolColor(symId, palette = 'default') {
  const table = palette === 'default' ? SYMBOL_COLORS_DEFAULT : SYMBOL_COLORS_CB[palette] ?? SYMBOL_COLORS_DEFAULT;
  return table[symId] ?? '#666666';
}

const T = 256;
/** Draw the carved glyph for a symbol into a 2D context (normalized 0..1 box). */
export function drawSymbolGlyph(ctx, symId, { ink = '#33231a', accent = null, x = 0, y = 0, s = T } = {}) {
  const u = s / 256; // unit
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(u, u);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const col = accent ?? ink;
  ctx.strokeStyle = col;
  ctx.fillStyle = col;
  ctx.lineWidth = 14;

  switch (symId) {
    case 'leaf': {
      ctx.beginPath();
      ctx.moveTo(60, 200);
      ctx.quadraticCurveTo(40, 90, 190, 60);
      ctx.quadraticCurveTo(210, 190, 90, 205);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = ink === col ? '#f3e3c8' : ink;
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.moveTo(70, 190);
      ctx.quadraticCurveTo(120, 130, 180, 75);
      ctx.stroke();
      break;
    }
    case 'drop': {
      ctx.beginPath();
      ctx.moveTo(128, 45);
      ctx.quadraticCurveTo(190, 130, 190, 165);
      ctx.quadraticCurveTo(190, 220, 128, 220);
      ctx.quadraticCurveTo(66, 220, 66, 165);
      ctx.quadraticCurveTo(66, 130, 128, 45);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.ellipse(105, 160, 18, 30, -0.4, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'moon': {
      ctx.beginPath();
      ctx.arc(140, 128, 82, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#f3e3c8';
      ctx.beginPath();
      ctx.arc(168, 108, 70, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(176, 76, 12, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'sun': {
      ctx.beginPath();
      ctx.arc(128, 128, 52, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 16;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
        ctx.beginPath();
        ctx.moveTo(128 + Math.cos(a) * 74, 128 + Math.sin(a) * 74);
        ctx.lineTo(128 + Math.cos(a) * 100, 128 + Math.sin(a) * 100);
        ctx.stroke();
      }
      break;
    }
    case 'bloom': {
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
        ctx.beginPath();
        ctx.ellipse(128 + Math.cos(a) * 52, 128 + Math.sin(a) * 52, 34, 26, a, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#f3e3c8';
      ctx.beginPath();
      ctx.arc(128, 128, 18, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'peak': {
      ctx.beginPath();
      ctx.moveTo(30, 200);
      ctx.lineTo(105, 70);
      ctx.lineTo(150, 160);
      ctx.lineTo(180, 100);
      ctx.lineTo(230, 200);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#f3e3c8';
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(105, 70);
      ctx.lineTo(120, 105);
      ctx.lineTo(96, 118);
      ctx.stroke();
      break;
    }
    case 'wave': {
      ctx.lineWidth = 18;
      for (let r = 0; r < 3; r++) {
        const yy = 85 + r * 45;
        ctx.beginPath();
        ctx.moveTo(35, yy);
        ctx.quadraticCurveTo(75, yy - 34, 115, yy);
        ctx.quadraticCurveTo(155, yy + 34, 195, yy);
        ctx.stroke();
      }
      break;
    }
    case 'fan': {
      ctx.beginPath();
      ctx.moveTo(128, 210);
      ctx.arc(128, 210, 140, -Math.PI * 0.82, -Math.PI * 0.18);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#f3e3c8';
      ctx.lineWidth = 7;
      for (let i = -2; i <= 2; i++) {
        const a = -Math.PI / 2 + i * 0.28;
        ctx.beginPath();
        ctx.moveTo(128, 210);
        ctx.lineTo(128 + Math.cos(a) * 130, 210 + Math.sin(a) * 130);
        ctx.stroke();
      }
      break;
    }
    case 'stone': {
      ctx.beginPath();
      ctx.ellipse(128, 180, 80, 34, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(128, 128, 58, 28, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(128, 86, 36, 22, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'crane': {
      ctx.lineWidth = 16;
      ctx.beginPath();
      ctx.moveTo(45, 170);
      ctx.quadraticCurveTo(90, 110, 128, 150);
      ctx.quadraticCurveTo(166, 110, 211, 170);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(128, 150);
      ctx.quadraticCurveTo(140, 100, 180, 70);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(188, 64, 10, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'koi': {
      ctx.beginPath();
      ctx.ellipse(120, 128, 70, 40, -0.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(180, 100);
      ctx.lineTo(225, 75);
      ctx.lineTo(215, 125);
      ctx.lineTo(225, 175);
      ctx.lineTo(180, 150);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#f3e3c8';
      ctx.beginPath();
      ctx.arc(95, 118, 9, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'lantern': {
      ctx.beginPath();
      ctx.ellipse(128, 135, 62, 75, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#f3e3c8';
      ctx.lineWidth = 7;
      for (const dx of [-30, 0, 30]) {
        ctx.beginPath();
        ctx.moveTo(128 + dx, 65);
        ctx.quadraticCurveTo(128 + dx * 1.35, 135, 128 + dx, 205);
        ctx.stroke();
      }
      ctx.fillStyle = col;
      ctx.fillRect(108, 42, 40, 16);
      ctx.fillRect(108, 200, 40, 16);
      break;
    }
    default: {
      ctx.beginPath();
      ctx.arc(128, 128, 60, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

/** Unique corner-notch pattern per symbol — shape coding independent of hue. */
function drawNotches(ctx, symIndex, color) {
  ctx.fillStyle = color;
  const n = (symIndex % 4) + 1;
  for (let i = 0; i < n; i++) {
    ctx.beginPath();
    ctx.arc(26 + i * 22, 26, 7, 0, Math.PI * 2);
    ctx.fill();
  }
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export { drawNotches, roundRectPath };
