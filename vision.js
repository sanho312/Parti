/* ============================================================
   Parti 도면 이미지 → 벡터 (알고리즘 전용 · AI/API 없음)
   ------------------------------------------------------------
   철학: 손그림 이미지를 LLM 에 통째로 보내지 않는다. 브라우저 안에서 픽셀을 직접 읽어
   선을 뽑고, 결과를 '스케치 스트로크'로 되돌려 준다 → 기존 전처리(prep)·건물화(bimify)
   파이프라인이 그대로 이어받는다. 사용자는 유령선을 보고 탭으로 고칠 수도 있다.

   파이프라인
     ① 다운스케일 → 그레이 → Otsu 이진화 (잉크=어두운 픽셀)
     ② 행/열 런렝스로 수평·수직 선분 추출 (건축 도면은 대부분 직교)
     ③ 같은 선 위 조각 병합 (작은 끊김 이음)
     ④ 평행 쌍(이중선) → 벽 중심선 + 두께 / 굵은 단일선 → 벽
     ⑤ 같은 선 위 벽 사이의 700~1200mm 틈 → 문(호 스트로크로 발행 = 기존 규칙이 door 로 판정)
   한계(정직하게): 사선·곡선 벽은 잡지 않는다(직교 전제). 축척은 알 수 없으므로 기본값으로
   내보내고 건물화 시 '축척 어시스트'가 실제 면적으로 바로잡는다.
   ============================================================ */
window.PARTI_VISION = (() => {
'use strict';

// ---------- 이미지 로드 → 축소 캔버스 ----------
function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('이미지를 읽을 수 없습니다.'));
    im.src = src;
  });
}
function toCanvas(im, maxSide) {
  const k = Math.min(1, maxSide / Math.max(im.width, im.height));
  const w = Math.max(8, Math.round(im.width * k)), h = Math.max(8, Math.round(im.height * k));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(im, 0, 0, w, h);
  return { canvas: c, ctx: g, w, h, k };
}

// ---------- Otsu 이진화 ----------
function binarize(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data;
  const hist = new Uint32Array(256);
  const gray = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
    // 투명 픽셀은 흰 배경으로 (PNG 도면)
    const a = d[i + 3];
    const g2 = a < 40 ? 255 : v;
    gray[p] = g2; hist[g2]++;
  }
  const total = w * h;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; thr = t; }
  }
  thr = Math.min(thr, 210);                       // 아주 옅은 도면 보정
  const bin = new Uint8Array(total);
  for (let p = 0; p < total; p++) bin[p] = gray[p] <= thr ? 1 : 0;
  return bin;
}

// ---------- 런렝스 선분 추출 ----------
// horiz=true: 행마다 잉크 런을 찾고, 세로로 이어지는 같은 구간을 묶어 '두께 있는 수평선'으로
function extractLines(bin, w, h, horiz, minLen) {
  const bands = [];        // {c(중심 좌표), a, b(구간), th(두께)}
  let open = [];           // 진행 중인 밴드
  const N = horiz ? h : w, M = horiz ? w : h;
  const at = (i, j) => horiz ? bin[i * w + j] : bin[j * w + i];
  for (let i = 0; i < N; i++) {
    const runs = [];
    let s = -1;
    for (let j = 0; j < M; j++) {
      if (at(i, j)) { if (s < 0) s = j; }
      else { if (s >= 0 && j - s >= minLen) runs.push([s, j - 1]); s = -1; }
    }
    if (s >= 0 && M - s >= minLen) runs.push([s, M - 1]);
    const next = [];
    for (const [a, b] of runs) {
      // 직전 줄의 밴드와 구간이 크게 겹치면 이어붙인다
      let hit = null;
      for (const o of open) {
        const ov = Math.min(b, o.b) - Math.max(a, o.a);
        if (o.i1 === i - 1 && ov > 0.6 * Math.min(b - a, o.b - o.a)) { hit = o; break; }
      }
      if (hit) { hit.a = Math.min(hit.a, a); hit.b = Math.max(hit.b, b); hit.i1 = i; hit.th++; next.push(hit); }
      else next.push({ i0: i, i1: i, a, b, th: 1 });
    }
    for (const o of open) if (o.i1 !== i) bands.push(o);   // 끊긴 밴드 종료
    open = next;
  }
  for (const o of open) bands.push(o);
  return bands.filter(o => o.b - o.a >= minLen).map(o => ({ c: (o.i0 + o.i1) / 2, a: o.a, b: o.b, th: o.th }));
}

// ---------- 같은 선 위 조각 병합 (작은 끊김 잇기) ----------
function mergeCollinear(lines, cTol, gap) {
  const out = [];
  const used = new Array(lines.length).fill(false);
  const sorted = lines.map((l, i) => ({ ...l, i })).sort((p, q) => p.c - q.c || p.a - q.a);
  for (let i = 0; i < sorted.length; i++) {
    if (used[sorted[i].i]) continue;
    let cur = { ...sorted[i] };
    used[sorted[i].i] = true;
    for (let j = i + 1; j < sorted.length; j++) {
      const s = sorted[j];
      if (used[s.i] || Math.abs(s.c - cur.c) > cTol) continue;
      if (s.a <= cur.b + gap && s.b >= cur.a - gap) {
        cur.a = Math.min(cur.a, s.a); cur.b = Math.max(cur.b, s.b);
        cur.th = Math.max(cur.th, s.th); cur.c = (cur.c + s.c) / 2;
        used[s.i] = true;
      }
    }
    out.push(cur);
  }
  return out;
}

// ---------- 평행 쌍 → 벽 중심선 ----------
function pairWalls(lines, minGap, maxGap) {
  const walls = [], rest = [];
  const used = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (used[i]) continue;
    let best = -1, bestD = Infinity;
    for (let j = i + 1; j < lines.length; j++) {
      if (used[j]) continue;
      const d = Math.abs(lines[j].c - lines[i].c);
      if (d < minGap || d > maxGap) continue;
      const ov = Math.min(lines[i].b, lines[j].b) - Math.max(lines[i].a, lines[j].a);
      const len = Math.min(lines[i].b - lines[i].a, lines[j].b - lines[j].a);
      if (ov < 0.5 * len) continue;                       // 겹침이 적으면 다른 벽
      if (d < bestD) { bestD = d; best = j; }
    }
    if (best >= 0) {
      const A = lines[i], Bb = lines[best];
      used[i] = used[best] = true;
      walls.push({ c: (A.c + Bb.c) / 2, a: Math.max(A.a, Bb.a), b: Math.min(A.b, Bb.b), t: bestD });
    } else rest.push(lines[i]);
  }
  return { walls, rest };
}

// ---------- 메인 ----------
// opts: { widthMM (이미지 가로 실제 폭·기본 10000), maxSide, minLenRatio }
async function traceImage(src, opts) {
  const o = Object.assign({ widthMM: 10000, maxSide: 1400 }, opts || {});
  const im = await loadImage(src);
  const { ctx, w, h } = toCanvas(im, o.maxSide);
  const bin = binarize(ctx, w, h);
  const S = o.widthMM / w;                               // px → mm
  const minLen = Math.max(10, Math.round(Math.min(w, h) * 0.035));
  const cTol = 2.5, gapPx = Math.max(3, Math.round(minLen * 0.25));
  const maxWallPx = Math.max(6, Math.round(Math.min(w, h) * 0.05));   // 이보다 벌어지면 벽 쌍이 아님

  const H0 = mergeCollinear(extractLines(bin, w, h, true, minLen), cTol, gapPx);
  const V0 = mergeCollinear(extractLines(bin, w, h, false, minLen), cTol, gapPx);
  const Hp = pairWalls(H0, 2, maxWallPx), Vp = pairWalls(V0, 2, maxWallPx);

  // 벽 후보: 평행 쌍(중심선) + 굵은 단일선
  const thickMin = 3;
  const wallsH = Hp.walls.map(l => ({ ...l, horiz: true }))
    .concat(Hp.rest.filter(l => l.th >= thickMin).map(l => ({ c: l.c, a: l.a, b: l.b, t: l.th, horiz: true })));
  const wallsV = Vp.walls.map(l => ({ ...l, horiz: false }))
    .concat(Vp.rest.filter(l => l.th >= thickMin).map(l => ({ c: l.c, a: l.a, b: l.b, t: l.th, horiz: false })));
  // 얇은 잔선(치수선·가구) — 충분히 긴 것만 참고선으로
  const thin = Hp.rest.filter(l => l.th < thickMin && l.b - l.a >= minLen * 2).map(l => ({ ...l, horiz: true }))
    .concat(Vp.rest.filter(l => l.th < thickMin && l.b - l.a >= minLen * 2).map(l => ({ ...l, horiz: false })));

  // px → 월드(mm). 이미지 y 는 아래로 증가 → 월드는 위로 증가하므로 뒤집는다.
  const P = (x, y) => [Math.round(x * S), Math.round((h - y) * S)];
  const allWalls = wallsH.concat(wallsV);

  // ── 개구부: 같은 선 위 벽 사이의 '문/창 폭' 틈은 벽이 끊긴 게 아니라 '하나의 벽 + 개구부' ──
  // ★두 벽으로 두면 호의 경첩이 벽 끝점에 놓여 호스트 판정(0.02<t<0.98)에서 탈락한다.
  //   건축적으로도 문 있는 벽은 하나 — 틈을 메워 벽을 잇고, 그 자리에 문 호를 발행한다.
  const byLine = new Map();
  for (const wl of allWalls) {
    const k = (wl.horiz ? 'h' : 'v') + Math.round(wl.c / 3);
    if (!byLine.has(k)) byLine.set(k, []);
    byLine.get(k).push(wl);
  }
  const finalWalls = [], openings = [];
  for (const list of byLine.values()) {
    list.sort((p, q) => p.a - q.a);
    let cur = { ...list[0] };
    for (let i = 1; i < list.length; i++) {
      const gapMM = (list[i].a - cur.b) * S;
      if (gapMM >= 600 && gapMM <= 1400) {                       // 문/창 폭 → 잇고 개구부 기록
        openings.push({ horiz: cur.horiz, c: cur.c, at: cur.b, wMM: gapMM });
        cur.b = Math.max(cur.b, list[i].b);
        cur.t = Math.max(cur.t, list[i].t);
      } else { finalWalls.push(cur); cur = { ...list[i] }; }
    }
    finalWalls.push(cur);
  }

  const strokes = [];
  let id = 1;
  const push = (pts, color, hw) => strokes.push({ id: id++, color, hw, layer: '', pts: pts.map(p => [p[0], p[1], 0.6]) });
  for (const wl of finalWalls) {
    const p1 = wl.horiz ? P(wl.a, wl.c) : P(wl.c, wl.a);
    const p2 = wl.horiz ? P(wl.b, wl.c) : P(wl.c, wl.b);
    push([p1, p2], '#e6e1d3', Math.max(2, wl.t * S / 2 / 10));   // 벽 = 밝은 잉크
  }
  for (const l of thin) {
    const p1 = l.horiz ? P(l.a, l.c) : P(l.c, l.a);
    const p2 = l.horiz ? P(l.b, l.c) : P(l.c, l.b);
    push([p1, p2], '#8fa3c8', 2);                               // 참고선 = 푸른 잉크
  }
  // 문 호 — 경첩은 개구 시작 모서리(이제 벽 몸통 위), 반지름 = 개구 폭.
  // 한 끝은 벽을 따라(=문이 닫힌 위치), 다른 끝은 직각(=열린 위치) → 기존 bimify 규칙이 폭·위치를 읽는다.
  for (const op of openings) {
    const hinge = op.horiz ? P(op.at, op.c) : P(op.c, op.at);
    const u = op.horiz ? [1, 0] : [0, -1];                      // 벽 진행 방향(월드)
    const n = op.horiz ? [0, 1] : [1, 0];                       // 열림 방향(월드)
    const arc = [];
    for (let s = 0; s <= 10; s++) {
      const th = (Math.PI / 2) * s / 10;
      arc.push([Math.round(hinge[0] + (u[0] * Math.cos(th) + n[0] * Math.sin(th)) * op.wMM),
                Math.round(hinge[1] + (u[1] * Math.cos(th) + n[1] * Math.sin(th)) * op.wMM)]);
    }
    push(arc, '#e0a33a', 2);                                    // 문 호 = 주황 잉크
  }
  return {
    strokes,
    meta: { imgW: im.width, imgH: im.height, usedW: w, usedH: h, scaleMMperPx: S,
      walls: finalWalls.length, guides: thin.length, doors: openings.length,
      widthMM: o.widthMM, heightMM: Math.round(h * S) },
  };
}

return { traceImage, _internal: { binarize, extractLines, mergeCollinear, pairWalls } };
})();
