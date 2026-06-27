// demo.js — generate a sample sprite sheet on a transparent canvas so users
// can try the splitter instantly without uploading anything.

export function makeDemoSheet() {
  const cols = 4;
  const rows = 3;
  const cell = 128;
  const margin = 16;
  const spacing = 16;
  const W = margin * 2 + cols * cell + (cols - 1) * spacing;
  const H = margin * 2 + rows * cell + (rows - 1) * spacing;

  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');

  const palette = [
    '#ef476f', '#ffd166', '#06d6a0', '#118ab2',
    '#f78c6b', '#c77dff', '#80ed99', '#ff70a6',
    '#4cc9f0', '#fb8500', '#8ecae6', '#e07a5f',
  ];

  let i = 0;
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      const x = margin + col * (cell + spacing);
      const y = margin + r * (cell + spacing);
      const cx = x + cell / 2;
      const cy = y + cell / 2;
      const color = palette[i % palette.length];
      drawShape(ctx, i % 4, cx, cy, cell * 0.36, color);
      i++;
    }
  }
  return c;
}

function drawShape(ctx, kind, cx, cy, r, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 4;
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 4;
  ctx.beginPath();
  if (kind === 0) {
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
  } else if (kind === 1) {
    ctx.rect(cx - r, cy - r, r * 2, r * 2);
  } else if (kind === 2) {
    // triangle
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r, cy + r);
    ctx.lineTo(cx - r, cy + r);
    ctx.closePath();
  } else {
    // star
    const spikes = 5;
    for (let s = 0; s < spikes * 2; s++) {
      const rad = s % 2 === 0 ? r : r * 0.45;
      const a = (Math.PI / spikes) * s - Math.PI / 2;
      const px = cx + Math.cos(a) * rad;
      const py = cy + Math.sin(a) * rad;
      s === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.closePath();
  }
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
