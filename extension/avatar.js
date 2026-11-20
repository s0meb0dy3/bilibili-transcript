const AVATAR_SIZE = 128;

// 无可靠照片时，生成彩色文字或数字头像。
export function initialAvatar(label, seed = label) {
  const colors = ['#5b7cfa', '#7a6ff0', '#e0699a', '#e08b4f', '#4fa97b', '#4f9fd0', '#b06fd0'];
  let hash = 0;
  for (const char of String(seed ?? '')) hash = (hash * 31 + char.codePointAt(0)) % 997;
  const numeric = Number(seed);
  const color = colors[(Number.isInteger(numeric) ? numeric : hash) % colors.length];
  const text = String(label ?? '').trim() || '?';
  const fontSize = text.length >= 3 ? 64 : text.length === 2 ? 88 : 112;
  const center = AVATAR_SIZE / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${AVATAR_SIZE}" height="${AVATAR_SIZE}"><circle cx="${center}" cy="${center}" r="${center}" fill="${color}"/><text x="${center}" y="${center}" dy="0.35em" text-anchor="middle" font-family="PingFang SC,sans-serif" font-size="${fontSize}" fill="#ffffff">${escapeXml(text)}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function escapeXml(text) {
  return text.replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]);
}
