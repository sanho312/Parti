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

  // ── 잉크 설명률(coverage) ──
  // ★"이 이미지가 직교 도면인가"를 전역 통계로 맞히려던 시도가 실물마다 흔들렸다(오분류 2회).
  //   대신 실제로 뽑아 보고 '뽑은 직선들이 잉크를 얼마나 설명하는가'로 판정한다.
  //   진짜 도면이면 잉크 대부분이 축 정렬 선 위에 있고, 손그림 투시는 그렇지 않다.
  const cover = new Uint8Array(w * h);
  const mark = (l, horiz) => {
    const half = Math.max(1, Math.ceil((l.t || l.th || 2) / 2) + 1);
    for (let u = Math.max(0, Math.floor(l.a)); u <= Math.min((horiz ? w : h) - 1, Math.ceil(l.b)); u++)
      for (let v = -half; v <= half; v++) {
        const c2 = Math.round(l.c) + v;
        if (horiz) { if (c2 >= 0 && c2 < h) cover[c2 * w + u] = 1; }
        else { if (c2 >= 0 && c2 < w) cover[u * w + c2] = 1; }
      }
  };
  for (const l of wallsH) mark(l, true);
  for (const l of wallsV) mark(l, false);
  for (const l of thin) mark(l, l.horiz);
  let inkN = 0, inkCov = 0;
  for (let p = 0; p < w * h; p++) if (bin[p]) { inkN++; if (cover[p]) inkCov++; }
  const coverage = inkN ? inkCov / inkN : 0;

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
      // paired = 평행 쌍(이중선)에서 나온 벽 수. 건축 도면은 벽을 두 줄로 그리므로 이 값이
      // 크다. 손그림 투시는 단선이라 거의 0 — '진짜 도면인가'의 가장 확실한 근거.
      paired: Hp.walls.length + Vp.walls.length,
      coverage: +coverage.toFixed(3), inkPx: inkN,
      widthMM: o.widthMM, heightMM: Math.round(h * S) },
  };
}

/* ------------------------------------------------------------
   이미지 종류 판별 — 도면 / 사진(정면) / 손스케치(투시)
   ------------------------------------------------------------
   ★사용자 문장("건물의 도면 만들어줘")의 키워드로 라우팅하면 '건물'이라는 단어 때문에
   도면 이미지가 사진(매싱) 경로로 오판된다. 이미지 픽셀 자체로 판별해야 한다.
   근거: · 도면 = 거의 흰 배경 + 소량의 무채색 선 → 중간톤·채도 낮음
        · 정면 사진 = 중간톤/채도 풍부 + 엣지가 수평·수직 지배적
        · 투시 스케치 = 종이 배경(흰 비율 높음) + '대각선 획'이 많다 — 투시선·지붕 경사가
          죄다 사선이라, 축 정렬이 지배적인 도면·정면 사진과 확실히 갈린다.
          이걸 못 가르면 콘셉트 스케치가 파사드 격자 매싱으로 엉뚱하게 세워진다(실사용 보고).
   ------------------------------------------------------------ */
async function classifyImage(src) {
  const im = await loadImage(src);
  const { ctx, w, h } = toCanvas(im, 400);
  const d = ctx.getImageData(0, 0, w, h).data;
  const total = w * h;
  const gray = new Float32Array(total);
  let mid = 0, ink = 0, white = 0, chroma = 0, satSum = 0, markN = 0, bgSat = 0, bgN = 0;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const a = d[i + 3];
    const r = d[i], g1 = d[i + 1], b = d[i + 2];
    const L = a < 40 ? 255 : (r * 299 + g1 * 587 + b * 114) / 1000;
    const s = a < 40 ? 0 : Math.max(r, g1, b) - Math.min(r, g1, b);
    gray[p] = L;
    if (L >= 70 && L <= 200) mid++;
    if (L < 70) ink++;
    if (L >= 195) { white++; bgSat += s; bgN++; }          // 배경(밝은 면) — 종이는 무채, 하늘은 유채
    if (s >= 40) chroma++;
    if (L < 230) { satSum += s; markN++; }                 // '자국' 픽셀만의 채도 (흰 종이에 희석되지 않게)
  }
  // 엣지 방향 분포 — 세기로 가중해 합산한다.
  // ★'상위 N% 픽셀만 세기'는 쓰면 안 된다: |dx|+|dy| 가 가장 큰 곳은 두 성분이 함께 큰 '모서리'라
  //   깨끗한 직교 도면조차 diag=1.0 이 나온다(실측). 약한 잡음만 걷어내고 세기 가중으로 합산한다.
  let axis = 0, diag = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = y * w + x;
    const dx = Math.abs(gray[p + 1] - gray[p - 1]), dy = Math.abs(gray[p + w] - gray[p - w]);
    const m = dx + dy;
    if (m < 12) continue;                                   // 종이 질감·압축 잡음 제거
    const ang = Math.atan2(dy, dx) * 180 / Math.PI;         // 0=수직 엣지, 90=수평 엣지
    if (ang < 20 || ang > 70) axis += m; else diag += m;
  }
  const edges = axis + diag;
  const midR = mid / total, inkR = ink / total, whiteR = white / total,
    chromaR = chroma / total, satInk = markN ? satSum / markN : 0,
    bgSatAvg = bgN ? bgSat / bgN : 0, diagR = edges ? diag / edges : 0;
  let kind;
  // 도면 = 무채색 자국 + 축 정렬 지배 + 밝은 배경. 유채색이 조금이라도 있으면 도면이 아니다.
  if (chromaR < 0.02 && satInk < 25 && diagR < 0.3 && whiteR > 0.45) kind = 'plan';
  else if (whiteR >= 0.3 && bgSatAvg < 30 && midR <= 0.5) kind = 'sketch';   // 무채색 종이 배경
  else kind = 'photo';
  return { kind, midRatio: +midR.toFixed(3), inkRatio: +inkR.toFixed(3), whiteRatio: +whiteR.toFixed(3),
    chromaRatio: +chromaR.toFixed(3), satInk: +satInk.toFixed(1), bgSat: +bgSatAvg.toFixed(1),
    diagRatio: +diagR.toFixed(3) };
}

/* ------------------------------------------------------------
   콘셉트 스케치 → 구성 판독 (traceConcept)
   ------------------------------------------------------------
   투시 스케치에서 '치수'는 복원할 수 없지만 '구성'은 읽을 수 있다.
     ① 실루엣 상단선의 봉우리 개수 = 동(棟) 수  ← 박공지붕은 뾰족한 봉우리를 만든다
     ② 봉우리의 돌출도(prominence) = 지붕 경사 유무 → 박공 / 평지붕
     ③ 초록 영역 = 조경. 건물 무리의 가운데·아래에 있으면 '중정(원형 배치)'
     ④ 파랑 영역 = 유리면
   치수가 아니라 구성만 뽑으므로 결과는 '추정' — 사용자가 한 문장으로 고칠 수 있게 한다.
   ------------------------------------------------------------ */
// 돌출도 기반 봉우리 — 단순 극대점은 손그림의 떨림마다 잡힌다. 좌우로 자기보다 높은
// 지점까지 내려간 깊이(prominence)가 충분한 것만 진짜 봉우리로 센다.
function prominentPeaks(prof, minSep, minProm) {
  const n = prof.length, cands = [];
  for (let i = 1; i < n - 1; i++) if (prof[i] >= prof[i - 1] && prof[i] > prof[i + 1]) cands.push(i);
  const scored = cands.map(i => {
    let lm = prof[i]; for (let j = i - 1; j >= 0 && prof[j] <= prof[i]; j--) lm = Math.min(lm, prof[j]);
    let rm = prof[i]; for (let j = i + 1; j < n && prof[j] <= prof[i]; j++) rm = Math.min(rm, prof[j]);
    return { i, v: prof[i], prom: prof[i] - Math.max(lm, rm) };
  }).filter(p => p.prom >= minProm).sort((a, b) => b.prom - a.prom);
  const kept = [];
  for (const p of scored) if (!kept.some(k => Math.abs(k.i - p.i) < minSep)) kept.push(p);
  return kept.sort((a, b) => a.i - b.i);
}
async function traceConcept(src, opts) {
  const o = Object.assign({ maxSide: 700 }, opts || {});
  const im = await loadImage(src);
  const { ctx, w, h } = toCanvas(im, o.maxSide);
  const d = ctx.getImageData(0, 0, w, h).data;
  const total = w * h;
  const bldg = new Uint8Array(total);        // 건물 픽셀 (잉크 윤곽 + 유리)
  // 잉크 임계는 밝기 분포에서 정한다 — 고정값(135)은 연한 연필선·어두운 사진에서 다 틀린다.
  // 종이(최빈 밝은 값)보다 확실히 어두운 쪽을 자국으로 본다.
  const lum = new Float32Array(total), lh = new Uint32Array(256);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const L = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    lum[p] = L; lh[L | 0]++;
  }
  let mode = 200, mv = 0;
  for (let v = 0; v < 256; v++) if (lh[v] > mv) { mv = lh[v]; mode = v; }
  const inkThr = Math.max(40, Math.min(200, mode - 28));
  const blueA = new Uint8Array(total), greenA = new Uint8Array(total);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const isGreen = g > r + 12 && g > b + 12;
    const isBlue = b > r + 12 && b > g + 4;
    if (isGreen) greenA[p] = 1;
    if (isBlue) blueA[p] = 1;
    // 건물 = 종이보다 어두운 자국 또는 파란 유리. 초록(조경)은 제외.
    if (!isGreen && (lum[p] < inkThr || isBlue)) bldg[p] = 1;
  }

  // ── ★스케치북 한 페이지에 그림이 여러 장 있으면 한 장만 고른다 ──
  //   실사용 이미지가 '위 투시 + 가운데 입면 + 아래 연필 스터디' 3단 구성이었는데,
  //   페이지 전체를 한 건물로 봐서 층수·지붕형·동 수가 통째로 틀렸다.
  //   빈 줄로 끊기는 덩어리로 나누고, '채색이 가장 많은' 덩어리를 본 그림으로 본다
  //   (연필 스터디는 무채색, 최종안은 색을 칠한다).
  const rowInk = new Float32Array(h), rowG = new Float32Array(h), rowB = new Float32Array(h);
  for (let y = 0; y < h; y++) { let a = 0, g2 = 0, b2 = 0;
    for (let x = 0; x < w; x++) { const p = y * w + x; if (bldg[p]) a++; if (greenA[p]) g2++; if (blueA[p]) b2++; }
    rowInk[y] = a; rowG[y] = g2; rowB[y] = b2; }
  const blocks = [];
  {
    // ★분리 기준은 '잉크'가 아니라 '그림 내용 전체'여야 한다. 초록(마당)은 bldg 에서
    //   제외되므로 잉크만 보면 마당이 어느 블록에도 안 들어가고, 그 그림이 '대지 없는
    //   그림'으로 평가돼 배치 정보를 가진 투시도가 밀려난다(실측: 모든 블록 g=0).
    const thr = w * 0.006, minH = Math.max(12, Math.round(h * 0.08));
    let s = -1, blank = 0;
    for (let y = 0; y < h; y++) {
      if (rowInk[y] + rowG[y] > thr) { if (s < 0) s = y; blank = 0; }
      // ★빈 줄 임계가 작으면 '투시도'와 '그 아래 마당'이 서로 다른 그림으로 쪼개진다(실측).
      //   한 그림과 그 대지는 한 덩어리다 — 페이지 높이의 3.5% 이상 비어야 다른 그림으로 본다.
      else if (s >= 0 && ++blank > Math.max(8, h * 0.035)) {
        if (y - blank - s >= minH) blocks.push([s, y - blank]); s = -1; blank = 0;
      }
    }
    if (s >= 0 && h - s >= minH) blocks.push([s, h - 1]);
    // ★초록만 있는 덩어리는 '그림'이 아니라 그 위 그림의 대지다 — 위 덩어리에 합친다.
    //   (건물과 마당 사이 여백이 넓으면 쪼개져, 마당만 남은 조각을 본 그림으로 골랐다)
    for (let i = blocks.length - 1; i >= 0; i--) {
      let g3 = 0, k3 = 0;
      for (let y = blocks[i][0]; y <= blocks[i][1]; y++) { g3 += rowG[y]; k3 += rowInk[y]; }
      if (g3 > 0 && g3 / (g3 + k3) > 0.6) {
        if (i > 0) { blocks[i - 1][1] = blocks[i][1]; blocks.splice(i, 1); }
        else if (blocks.length > 1) { blocks[1][0] = blocks[0][0]; blocks.splice(0, 1); }
      }
    }
  }
  let by0 = 0, by1 = h - 1, blockDbg = null;
  if (blocks.length > 1) {
    // 초록(대지·마당)을 가장 무겁게 — 배치를 읽을 수 있는 그림이 우리가 원하는 것이다.
    // 그다음 파랑(유리=최종안), 잉크는 보조. 연필 스터디는 무채색이라 자연히 밀린다.
    let best = -1, bestScore = -1;
    blockDbg = [];
    for (let i = 0; i < blocks.length; i++) {
      let gg = 0, bb = 0, ink = 0, gTop = -1, gBot = -1;
      for (let y = blocks[i][0]; y <= blocks[i][1]; y++) {
        gg += rowG[y]; bb += rowB[y]; ink += rowInk[y];
        if (rowG[y] > w * 0.01) { if (gTop < 0) gTop = y; gBot = y; }
      }
      // ★초록을 '개수'로만 보면 입면의 지면선(얇고 긴 띠)이 마당을 이긴다(실측).
      //   마당은 세로로도 퍼진 덩어리다 — 세로 폭이 얇으면 대지선으로 보고 가중치를 낮춘다.
      const site = (gBot - gTop) >= h * 0.02 ? 1 : 0.15;
      const score = gg * 5 * site + bb + ink * 0.25;
      blockDbg.push([blocks[i][0], blocks[i][1], Math.round(gg), Math.round(bb), Math.round(ink), site, Math.round(score)]);
      if (score > bestScore) { bestScore = score; best = i; }
    }
    by0 = blocks[best][0]; by1 = blocks[best][1];
    for (let y = 0; y < h; y++) if (y < by0 || y > by1)
      for (let x = 0; x < w; x++) { const p = y * w + x; bldg[p] = 0; blueA[p] = 0; greenA[p] = 0; }
  }

  let green = 0, blue = 0, gSumX = 0, gSumY = 0, gMinX = w, gMaxX = 0, gMinY = h;
  const colBlue = new Float32Array(w);               // 열별 파란 픽셀 수 — 유리면 군집 검출용
  for (let y = by0; y <= by1; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (greenA[p]) { green++; gSumX += x; gSumY += y;
      if (x < gMinX) gMinX = x; if (x > gMaxX) gMaxX = x; if (y < gMinY) gMinY = y; }
    if (blueA[p]) { blue++; colBlue[x]++; }
  }
  // ★높이의 기준선은 '이미지 바닥'이 아니라 '건물이 앉은 지면선'이어야 한다.
  //   이미지 바닥부터 재면 건물 아래 여백까지 높이에 들어가 층수가 통째로 과대 추정된다(실측).
  let baseY = 0;
  for (let y = by1; y >= by0; y--) { let any = false;
    for (let x = 0; x < w; x += 2) if (bldg[y * w + x]) { any = true; break; }
    if (any) { baseY = y; break; } }
  // 실루엣 상단선 — 열마다 가장 위쪽 건물 픽셀. 없으면 높이 0.
  const raw = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let top = -1;
    for (let y = 0; y < h; y++) if (bldg[y * w + x]) { top = y; break; }
    raw[x] = top < 0 ? 0 : Math.max(0, baseY - top);
  }
  // 이동평균 — 손그림 떨림·해칭 제거
  const k = Math.max(2, Math.round(w / 90)), prof = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let j = -k; j <= k; j++) { const q = x + j; if (q >= 0 && q < w) { s += raw[q]; c++; } }
    prof[x] = s / c;
  }
  let maxH = 0; for (let x = 0; x < w; x++) if (prof[x] > maxH) maxH = prof[x];
  const peaks = prominentPeaks(prof, Math.max(6, Math.round(w / 22)), Math.max(3, maxH * 0.055));
  const promAvg = peaks.length ? peaks.reduce((a, p) => a + p.prom, 0) / peaks.length : 0;
  const greenR = green / total, blueR = blue / total;

  // ── 동별 폭·높이와 인접 여부 ──
  // 한 덩어리에 같은 크기를 쓰면 스케치와 전혀 다른 그림이 된다(실사용 보고).
  // 봉우리 사이의 골로 동 경계를 나눠 폭 비율을, 봉우리 높이로 높이 비율을 얻는다.
  let xa = 0, xb = w - 1;
  const lowThr = maxH * 0.15;
  while (xa < w - 1 && prof[xa] < lowThr) xa++;
  while (xb > xa && prof[xb] < lowThr) xb--;
  const valleys = [];
  for (let i = 1; i < peaks.length; i++) {
    let vi = peaks[i - 1].i, vv = Infinity;
    for (let x = peaks[i - 1].i; x <= peaks[i].i; x++) if (prof[x] < vv) { vv = prof[x]; vi = x; }
    valleys.push({ i: vi, v: vv, lo: Math.min(peaks[i - 1].v, peaks[i].v) });
  }
  let bounds = [xa].concat(valleys.map(v => v.i), [xb]);
  const spanW = Math.max(1, xb - xa);
  let massList = peaks.map((p, i) => ({
    wFrac: Math.max(0.02, (bounds[i + 1] - bounds[i]) / spanW),
    hFrac: maxH > 0 ? +(p.v / maxH).toFixed(3) : 1,
  }));
  // ── 유리면 군집으로 동 수 보정 ──
  // ★투시에서 겹친 동은 지붕 봉우리가 실루엣에 묻혀 하나 덜 세어진다(실사용: 5동→4동).
  //   유리 전면은 동마다 뚜렷한 파란 군집을 만드니, 군집이 더 많으면 그쪽을 믿는다.
  const blueBands = bandsOf(colBlue, 0.22).filter(b2 => b2[1] - b2[0] >= w * 0.025);
  if (blueBands.length > peaks.length && blueBands.length <= 12) {
    bounds = [blueBands[0][0]];
    for (let i = 1; i < blueBands.length; i++) bounds.push(Math.round((blueBands[i - 1][1] + blueBands[i][0]) / 2));
    bounds.push(blueBands[blueBands.length - 1][1]);
    const bw = Math.max(1, bounds[bounds.length - 1] - bounds[0]);
    massList = blueBands.map((b2, i) => {
      let hh = 0;
      for (let x = Math.max(0, bounds[i]); x <= Math.min(w - 1, bounds[i + 1]); x++) if (prof[x] > hh) hh = prof[x];
      return { wFrac: Math.max(0.02, (bounds[i + 1] - bounds[i]) / bw), hFrac: maxH > 0 ? +(hh / maxH).toFixed(3) : 1 };
    });
  }
  // ── 떨어져 있는 동은 '연결 성분'으로 센다 ──
  // ★1차원 실루엣은 링/군집 배치에서 앞뒤로 겹친 동을 하나로 본다(실측: 5동이 4동).
  //   서로 떨어진 덩어리 개수가 실루엣보다 많으면 그쪽이 진실이다.
  //   (붙어 있는 연립은 덩어리가 1개라 이 보정이 발동하지 않는다 — 그때는 실루엣이 옳다)
  let comps = 0;
  {
    const sw = Math.max(8, w >> 1), sh = Math.max(8, h >> 1);
    // ★2×2 블록을 OR 로 모은다. 한 픽셀만 뽑으면 1~2px 얇은 손그림 선이 끊겨
    //   윤곽이 조각나고 덩어리 수가 부풀려진다(실측: 5동이 6동).
    const m = new Uint8Array(sw * sh);
    for (let y = 0; y < h; y++) { const yy = (y >> 1) * sw;
      for (let x = 0; x < w; x++) if (bldg[y * w + x]) m[yy + (x >> 1)] = 1; }
    // 한 번 팽창 — 붓 끊김·해칭 틈을 메워 같은 건물이 갈라지지 않게
    const dl = m.slice();
    for (let y = 1; y < sh - 1; y++) for (let x = 1; x < sw - 1; x++) {
      const p2 = y * sw + x;
      if (m[p2] || m[p2 - 1] || m[p2 + 1] || m[p2 - sw] || m[p2 + sw]) dl[p2] = 1;
    }
    m.set(dl);
    const seen = new Uint8Array(sw * sh), st = new Int32Array(sw * sh);
    const minA = sw * sh * 0.004;
    for (let p = 0; p < m.length; p++) {
      if (!m[p] || seen[p]) continue;
      let top = 0, area = 0; st[top++] = p; seen[p] = 1;
      while (top) {
        const q = st[--top]; area++;
        const qx = q % sw, qy = (q / sw) | 0;
        if (qx > 0 && m[q - 1] && !seen[q - 1]) { seen[q - 1] = 1; st[top++] = q - 1; }
        if (qx < sw - 1 && m[q + 1] && !seen[q + 1]) { seen[q + 1] = 1; st[top++] = q + 1; }
        if (qy > 0 && m[q - sw] && !seen[q - sw]) { seen[q - sw] = 1; st[top++] = q - sw; }
        if (qy < sh - 1 && m[q + sw] && !seen[q + sw]) { seen[q + sw] = 1; st[top++] = q + sw; }
      }
      if (area >= minA) comps++;
    }
  }
  // ※comps 로 동 수를 덮어쓰지 않는다 — 실측 결과 유리면과 윤곽선이 따로 세어져(동당 2개)
  //   오히려 부풀렸다. 진단값으로만 남기고, 동 수는 실루엣 봉우리·유리 군집으로 판단한다.
  const masses = Math.max(1, Math.min(12, massList.length));
  // ── 지붕형: 봉우리가 '뾰족한가(박공)' vs '평평한가(평지붕)' ──
  // ★돌출도만 보면 상자들 사이 단차도 큰 돌출로 잡혀 평지붕이 박공이 된다(실측).
  //   봉우리 근처가 고원(plateau)처럼 평평하면 평지붕이다.
  let plateau = 0;
  for (let i = 0; i < massList.length; i++) {
    const a1 = Math.max(0, Math.round(bounds[i])), b1 = Math.min(w - 1, Math.round(bounds[i + 1]));
    let hm = 0; for (let x = a1; x <= b1; x++) if (prof[x] > hm) hm = prof[x];
    let flatN = 0, tot = 0;
    for (let x = a1; x <= b1; x++) { tot++; if (prof[x] >= hm * 0.93) flatN++; }
    plateau += tot ? flatN / tot : 0;
  }
  plateau /= Math.max(1, massList.length);
  // ── 층수: 지붕이 아니라 '처마 높이 / 폭' 으로 ──
  // 실루엣 전체 높이를 쓰면 급경사 지붕 때문에 1층 파빌리온도 2~3층으로 나온다.
  // 매스 경계(=박공 골)의 높이가 곧 처마 높이다.
  let eaveRatio = 0;
  for (let i = 0; i < massList.length; i++) {
    const wd = Math.max(1, bounds[i + 1] - bounds[i]);
    // ★경계 픽셀을 그대로 읽으면 떨어져 있는 동에서 '틈'을 읽어 처마가 과소평가된다.
    //   매스 안쪽으로 8% 들어간 지점에서 잰다.
    const e0 = prof[Math.max(0, Math.round(bounds[i] + wd * 0.08))];
    const e1 = prof[Math.min(w - 1, Math.round(bounds[i + 1] - wd * 0.08))];
    eaveRatio += Math.max(e0, e1) / wd;
  }
  eaveRatio /= Math.max(1, massList.length);
  const floors = Math.max(1, Math.min(3, Math.round(eaveRatio / 0.42)));

  // ── 기울기(lean) — 매스가 얼마나 기울어 서 있는가 ──
  // 실루엣의 좌·우 경계선을 높이별로 훑어 '올라갈수록 옆으로 밀리는 양'을 최소제곱으로 잰다.
  // 두 경계의 기울기 평균 = 기울임(전단), 차이 = 위로 갈수록 좁아짐(테이퍼).
  // ※손그림 투시는 대개 수직선을 수직으로 유지하므로, 측정된 기울기는 투시 왜곡이 아니라
  //   설계 의도로 본다. 지붕 삼각형에 휘둘리지 않게 처마 높이 아래 구간만 쓴다.
  const fitSlope = (us, vs) => {                    // 최소제곱 기울기 dv/du
    const n2 = us.length; if (n2 < 4) return null;
    let su = 0, sv = 0, suu = 0, suv = 0;
    for (let k = 0; k < n2; k++) { su += us[k]; sv += vs[k]; suu += us[k] * us[k]; suv += us[k] * vs[k]; }
    const den = n2 * suu - su * su;
    return Math.abs(den) < 1e-6 ? null : (n2 * suv - su * sv) / den;
  };
  // 한 매스의 좌·우 경계 기울기 — 창을 기울기만큼 따라 옮기며 잰다(반복 수렴).
  // ★창을 밑변 구간에 고정하면 기울어 나간 모서리가 창 밖에서 잘려 기울기가 절반으로
  //   측정된다(24° 로 그린 그림이 10° 로 나왔다). 창을 함께 기울여야 끝까지 따라간다.
  const measLean = (x0, x1, eh, guess) => {
    if (eh < 6) return null;
    const wd = Math.max(1, x1 - x0);
    let g = guess || 0;
    for (let it = 0; it < 3; it++) {
      const uL = [], vL = [], uR = [], vR = [];
      for (let t2 = 0.2; t2 <= 0.85; t2 += 0.05) {
        const u = eh * t2, y = Math.round(baseY - u);
        if (y < 0 || y >= h) continue;
        const sh = g * u;                            // 이 높이에서 창을 이만큼 옮긴다
        const a1 = Math.max(0, Math.round(x0 + sh - wd * 0.12));
        const b1 = Math.min(w - 1, Math.round(x1 + sh + wd * 0.12));
        let lx = -1, rx = -1;
        for (let x = a1; x <= b1; x++) if (bldg[y * w + x]) { lx = x; break; }
        for (let x = b1; x >= a1; x--) if (bldg[y * w + x]) { rx = x; break; }
        if (lx < 0 || rx < 0 || rx - lx < wd * 0.15) continue;
        if (lx <= a1 || rx >= b1) continue;          // 창 가장자리에 붙었으면 잘린 값 — 버린다
        uL.push(u); vL.push(lx); uR.push(u); vR.push(rx);
      }
      const sl = fitSlope(uL, vL), sr = fitSlope(uR, vR);
      if (sl == null || sr == null) return it ? g : null;
      const ng = (sl + sr) / 2;
      if (Math.abs(ng - g) < 0.01) { g = ng; break; }
      g = ng;
    }
    return Math.max(-0.9, Math.min(0.9, g));
  };
  // ── 무리 전체의 기울기: 바깥 실루엣으로 잰다 ──
  // 붙어 있는 매스는 이웃에 가려 자기 모서리를 못 보지만, 무리의 맨 왼쪽·맨 오른쪽
  // 바깥선은 아무것도 가리지 않는다. 이 값이 크기(각도)의 기준이 된다.
  let clusterLean = null;
  {
    let ehAll = 0;
    for (let i = 0; i < massList.length; i++) {
      const a1 = Math.max(0, Math.round(bounds[i])), b1 = Math.min(w - 1, Math.round(bounds[i + 1]));
      const wd2 = Math.max(1, b1 - a1);
      const e0 = prof[Math.min(w - 1, Math.round(bounds[i] + wd2 * 0.08))];
      const e1 = prof[Math.max(0, Math.round(bounds[i + 1] - wd2 * 0.08))];
      ehAll += Math.max(e0, e1);
    }
    ehAll /= Math.max(1, massList.length);
    if (ehAll >= 6) {
      const uL = [], vL = [], uR = [], vR = [];
      const mg = Math.round(ehAll);                  // 45° 까지 따라갈 여유
      for (let t2 = 0.2; t2 <= 0.85; t2 += 0.04) {
        const u = ehAll * t2, y = Math.round(baseY - u);
        if (y < 0 || y >= h) continue;
        const a1 = Math.max(0, xa - mg), b1 = Math.min(w - 1, xb + mg);
        let lx = -1, rx = -1;
        for (let x = a1; x <= b1; x++) if (bldg[y * w + x]) { lx = x; break; }
        for (let x = b1; x >= a1; x--) if (bldg[y * w + x]) { rx = x; break; }
        if (lx < 0 || rx < 0) continue;
        uL.push(u); vL.push(lx); uR.push(u); vR.push(rx);
      }
      const sl = fitSlope(uL, vL), sr = fitSlope(uR, vR);
      if (sl != null && sr != null) clusterLean = Math.max(-0.9, Math.min(0.9, (sl + sr) / 2));
    }
  }
  // 동별 기울기 — 창을 따라 옮기며 재고, 없으면 무리 값으로 채운다
  let leanAvg = 0, leanN = 0;
  for (let i = 0; i < massList.length; i++) {
    const x0 = Math.max(0, Math.round(bounds[i])), x1 = Math.min(w - 1, Math.round(bounds[i + 1]));
    const wd = Math.max(1, x1 - x0);
    const e0 = prof[Math.min(w - 1, Math.round(bounds[i] + wd * 0.08))];
    const e1 = prof[Math.max(0, Math.round(bounds[i + 1] - wd * 0.08))];
    const eh = Math.max(e0, e1);
    const m = measLean(x0, x1, eh, clusterLean || 0);
    const ln = (m == null) ? (clusterLean || 0) : m;
    massList[i].lean = +ln.toFixed(3);
    leanAvg += ln; leanN++;
  }
  leanAvg = leanN ? leanAvg / leanN : 0;
  // ★크기는 바깥 실루엣(가림 없음)을 믿는다 — 안쪽 동은 이웃에 가려 항상 작게 나온다.
  if (clusterLean != null && Math.abs(clusterLean) > Math.abs(leanAvg)) {
    const k = Math.abs(leanAvg) > 1e-3 ? clusterLean / leanAvg : 1;
    if (isFinite(k) && k > 0) for (const mm of massList)
      mm.lean = +Math.max(-0.9, Math.min(0.9, mm.lean * k)).toFixed(3);
    leanAvg = clusterLean;
  }

  // ── 동별 깊이(depth) ──
  // 투시에서 '깊은 동'은 옆으로 물러나는 지붕면·측벽이 넓게 보인다. 그 넓이를 재려면
  // 매스가 차지한 '면적'과 '앞면 폭'을 비교하면 된다: 같은 폭이라도 깊을수록 화면에서
  // 더 많은 픽셀을 차지한다. area/(width×height) 가 깊이의 대리 지표가 된다.
  // ※투시 각도·시점을 모르므로 절대 깊이는 알 수 없다 — 동 사이 '상대 비율'만 쓴다.
  let dSum = 0, dN = 0;
  for (let i = 0; i < massList.length; i++) {
    const x0 = Math.max(0, Math.round(bounds[i])), x1 = Math.min(w - 1, Math.round(bounds[i + 1]));
    const wd = Math.max(1, x1 - x0);
    let area = 0, hMaxI = 0;
    for (let x = x0; x <= x1; x++) {
      if (prof[x] > hMaxI) hMaxI = prof[x];
      for (let y = Math.max(0, Math.round(baseY - prof[x])); y <= Math.min(h - 1, baseY); y++)
        if (bldg[y * w + x]) area++;
    }
    // 채움률 = 실제 잉크·색 면적 / 실루엣 상자. 깊은 동은 측면이 더 보여 채움률이 높다.
    const fill = area / Math.max(1, wd * hMaxI);
    massList[i].fill = +fill.toFixed(3);
    dSum += fill; dN++;
  }
  void dSum; void dN;
  // ★깊이는 여기서 추정하지 않는다 — 채움률은 깊이를 재지 못한다(실측).
  //   측면이 넓은 동은 그 측면이 '별개 봉우리'로 잡혀 동 수가 늘고, 채움률은 오히려 떨어졌다
  //   (오른쪽을 깊게 그린 시험: 5동→6동, 깊이 배수 1.7 기대 → 0.6 측정).
  //   단일 투시에서 깊이를 알려면 면 분할(앞면/측면 음영 구분)이나 소실점 추정이 필요하다.
  //   fill 은 진단값으로만 남기고, 깊이는 사용자가 문장으로 지정하게 한다("깊이 8,12,20m").
  // 붙어 있는가 — 골이 충분히 높으면 한 덩어리로 이어진 동들이다
  const attachedN = valleys.filter(v => v.lo > 0 && v.v / v.lo >= 0.35).length;
  const attached = valleys.length ? attachedN >= valleys.length / 2 : false;

  // 마당 위치 — 건물이 마당을 '둘러쌌는가(중정)' vs '뒤에만 있는가(앞마당)'
  // ★중심 y 비교만으로는 링 배치가 앞마당으로 오판된다(실측). 마당 x 범위 안에서
  //   마당보다 '아래쪽'에도 건물이 있으면 둘러싼 것 = 중정.
  const gW = gMaxX - gMinX, gcy = green ? gSumY / green : 0;
  let bTop = h, bBot = 0;
  for (let x = xa; x <= xb; x++) if (prof[x] > lowThr) { const ty = baseY - prof[x]; if (ty < bTop) bTop = ty; }
  for (let y = h - 1; y >= 0; y--) { let any = false; for (let x = xa; x <= xb; x += 3) if (bldg[y * w + x]) { any = true; break; } if (any) { bBot = y; break; } }
  const hasCourt = greenR > 0.012 && gW > w * 0.2;
  // ★마당 x 범위 안만 보면 링 배치를 놓친다(아래쪽 동이 좌우로 벌어져 있으면 범위 밖).
  //   화면 전체에서 '마당보다 아래에 있는 건물 픽셀 비율'로 판정한다.
  let below = 0, bAll = 0;
  if (hasCourt) for (let y = 0; y < h; y++) for (let x = 0; x < w; x += 2)
    if (bldg[y * w + x]) { bAll++; if (y > gcy + 8) below++; }
  const enclosed = hasCourt && bAll > 0 && below / bAll > 0.15;   // 마당 아래에도 건물이 상당량
  const courtFront = hasCourt && !enclosed;
  return {
    masses, massList, attached, floors, lean: +leanAvg.toFixed(3),
    // 고원 비율이 크면 평지붕. 뾰족한 봉우리라야 박공이다.
    roof: (plateau < 0.42 && maxH > 0 && promAvg / maxH > 0.08) ? 'gable' : 'flat',
    // 앞마당이면 '부채꼴로 늘어서고 마당은 그 앞' — 마당을 빙 두르는 링이 아니다.
    arrange: courtFront ? 'arc' : enclosed ? 'circle' : 'row',
    glass: blueR > 0.008,
    peaks: peaks.map(p => Math.round(p.i)),
    meta: { w, h, maxH: Math.round(maxH), promAvg: +promAvg.toFixed(1), inkThr,
      greenRatio: +greenR.toFixed(3), blueRatio: +blueR.toFixed(3),
      courtyard: hasCourt, courtFront, enclosed, attached, bTop, bBot, baseY,
      plateau: +plateau.toFixed(2), eaveRatio: +eaveRatio.toFixed(2), comps,
      blocks: blocks.length, block: [by0, by1], blockDbg, gcy: Math.round(gcy) },
  };
}

/* ------------------------------------------------------------
   건물 사진 → 매스 근사 (traceFacade)
   ------------------------------------------------------------
   단일 사진에서 3D 를 '복원'하는 건 알고리즘만으로 불가능하다. 대신 파사드에서
   가장 확실한 신호인 '창 격자의 주기성'을 읽어 층수·베이수·비례를 얻고, 그것으로
   매스(박스 + 창 개구부)를 세운다. 깊이는 사진에 없는 정보 → 기본값(폭의 0.6배).
     ① 그레이 → 그래디언트(|dx|,|dy|)
     ② 에너지 프로파일로 파사드 영역 추정 (하늘·바닥은 매끈해서 자연 탈락)
     ③ 세로/가로 엣지 프로파일의 피크 → 창틀·층선. 피크 간격의 중앙값 = 주기
     ④ 층수 = 높이/세로주기, 베이수 = 폭/가로주기 → 격자 칸마다 창 사각
   ------------------------------------------------------------ */
function gradients(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data;
  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++)
    gray[p] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = y * w + x;
    gx[p] = Math.abs(gray[p + 1] - gray[p - 1]);
    gy[p] = Math.abs(gray[p + w] - gray[p - w]);
  }
  return { gx, gy, gray };
}
// 프로파일 피크 — 임계 이상 + 최소 간격 비최대 억제
function peaksOf(prof, minGap, relThr) {
  const n = prof.length;
  let mx = 0; for (let i = 0; i < n; i++) if (prof[i] > mx) mx = prof[i];
  if (mx <= 0) return [];
  const thr = mx * (relThr || 0.32);
  const cand = [];
  for (let i = 1; i < n - 1; i++)
    if (prof[i] >= thr && prof[i] >= prof[i - 1] && prof[i] >= prof[i + 1]) cand.push(i);
  cand.sort((a, b) => prof[b] - prof[a]);
  const kept = [];
  for (const c of cand) if (!kept.some(k => Math.abs(k - c) < minGap)) kept.push(c);
  return kept.sort((a, b) => a - b);
}
const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((p, q) => p - q); return s[s.length >> 1]; };
// 기본 주기 — 자기상관. ★피크 간격의 중앙값을 쓰면 창 하나가 좌·우 엣지 2개를 만들어
//   주기가 절반으로 잡힌다(4층이 8층으로). 자기상관은 엣지 개수와 무관하게 반복 간격을 본다.
//   전역 최대는 주기의 배수에 걸릴 수 있으므로 '충분히 큰 첫 극대'를 기본 주기로 택한다.
function periodOf(prof, minLag, maxLag) {
  const n = prof.length;
  if (n < 8) return 0;
  let mean = 0; for (let i = 0; i < n; i++) mean += prof[i];
  mean /= n;
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = prof[i] - mean;
  const lo = Math.max(2, Math.round(minLag)), hi = Math.min(n - 2, Math.round(maxLag));
  if (hi <= lo) return 0;
  const ac = new Float32Array(hi + 1);
  let gmax = 0;
  for (let lag = lo; lag <= hi; lag++) {
    let s = 0, c = 0;
    for (let i = 0; i + lag < n; i++) { s += a[i] * a[i + lag]; c++; }
    ac[lag] = c ? s / c : 0;
    if (ac[lag] > gmax) gmax = ac[lag];
  }
  if (gmax <= 0) return 0;
  for (let lag = lo + 1; lag < hi; lag++)
    if (ac[lag] >= gmax * 0.72 && ac[lag] >= ac[lag - 1] && ac[lag] >= ac[lag + 1]) return lag;
  return 0;
}
// 에너지가 몰린 연속 구간 = 파사드 (하늘·아스팔트는 그래디언트가 낮다)
function span(prof, relThr) {
  const n = prof.length;
  let mx = 0; for (let i = 0; i < n; i++) if (prof[i] > mx) mx = prof[i];
  const thr = mx * (relThr || 0.18);
  let a = 0, b = n - 1;
  while (a < n - 1 && prof[a] < thr) a++;
  while (b > a && prof[b] < thr) b--;
  return [a, b];
}
// 파사드 안에서 '창' 클래스 판별 — Otsu 로 두 무리로 가르고, 면적이 적은 쪽을 창으로 본다
// (창은 보통 벽면보다 좁다. 어두운 유리든 반사로 밝든 이 규칙이 둘 다 잡는다)
function windowMask(gray, w, h, x0, y0, x1, y1) {
  const hist = new Uint32Array(256);
  const total = (x1 - x0 + 1) * (y1 - y0 + 1);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) hist[gray[y * w + x] | 0]++;
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
  let dark = 0; for (let t = 0; t <= thr; t++) dark += hist[t];
  return { thr, darkIsWindow: dark <= total / 2 };
}
// 임계 이상인 연속 구간(밴드) 목록 — 창이 놓인 줄/칸을 그대로 센다
function bandsOf(prof, relThr) {
  const n = prof.length;
  let mx = 0; for (let i = 0; i < n; i++) if (prof[i] > mx) mx = prof[i];
  if (mx <= 0) return [];
  const thr = mx * (relThr || 0.3), minLen = Math.max(2, Math.round(n * 0.02));
  const out = []; let s = -1;
  for (let i = 0; i < n; i++) {
    if (prof[i] >= thr) { if (s < 0) s = i; }
    else { if (s >= 0 && i - s >= minLen) out.push([s, i - 1]); s = -1; }
  }
  if (s >= 0 && n - s >= minLen) out.push([s, n - 1]);
  return out;
}
async function traceFacade(src, opts) {
  const o = Object.assign({ maxSide: 900, floorH: 3000, widthMM: null, depthMM: null }, opts || {});
  const im = await loadImage(src);
  const { ctx, w, h } = toCanvas(im, o.maxSide);
  const { gx, gy, gray } = gradients(ctx, w, h);   // gray = 창 마스크 판별에 쓴다
  // 열/행 에너지 (세로선은 gx 가, 가로선은 gy 가 크다)
  const colV = new Float32Array(w), rowH = new Float32Array(h);
  const colAll = new Float32Array(w), rowAll = new Float32Array(h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    colV[x] += gx[p]; rowH[y] += gy[p];
    colAll[x] += gx[p] + gy[p]; rowAll[y] += gx[p] + gy[p];
  }
  // 파사드 경계 — 임계가 높으면 위·아래 층이 잘려 층수가 모자란다(12층이 10층으로).
  // 낮은 임계로 넓게 잡고, 창 밴드 계수가 실제 층수를 결정하게 둔다.
  const [x0, x1] = span(colAll, 0.08), [y0, y1] = span(rowAll, 0.08);
  const fw = Math.max(8, x1 - x0), fh = Math.max(8, y1 - y0);
  // ── 창을 '덩어리(밴드)'로 직접 센다 ──
  // ★엣지 주기(자기상관)는 창 높이가 층고의 절반일 때 반주기에 갇혀 층수가 2배로 나온다
  //   (실측으로 확인). 창 픽셀 마스크의 연속 구간을 세면 엣지 개수와 무관하게 정확하다.
  const wm = windowMask(gray, w, h, x0, y0, x1, y1);
  const rowW = new Float32Array(fh + 1), colW = new Float32Array(fw + 1);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    // ★히스토그램은 |0 으로 양자화해 임계를 잡았으므로 비교도 같은 양자화로 해야 한다.
    //   실수 그대로 비교하면 창 픽셀(50.7)이 임계(50)를 벗어나 마스크가 통째로 비어버린다.
    const g2 = gray[y * w + x] | 0;
    const isWin = wm.darkIsWindow ? (g2 <= wm.thr) : (g2 > wm.thr);
    if (isWin) { rowW[y - y0]++; colW[x - x0]++; }
  }
  let rb = bandsOf(rowW, 0.3), cb = bandsOf(colW, 0.3);
  const direct = rb.length >= 1 && cb.length >= 1;         // 밴드를 직접 잡았는가(신뢰의 근거)
  // 밴드가 안 잡히면(민무늬 파사드) 엣지 주기로 후퇴
  const cv2 = colV.slice(x0, x1 + 1), rv2 = rowH.slice(y0, y1 + 1);
  if (rb.length < 1) { const p = periodOf(rv2, fh * 0.06, fh / 2) || fh; rb = []; for (let i = 0; i < Math.round(fh / p); i++) rb.push([i * p + p * 0.25, i * p + p * 0.75]); }
  if (cb.length < 1) { const p = periodOf(cv2, fw * 0.06, fw / 2) || fw; cb = []; for (let i = 0; i < Math.round(fw / p); i++) cb.push([i * p + p * 0.25, i * p + p * 0.75]); }
  // 신뢰도 — 밴드 간격이 고르면(진짜 창 격자) 높고, 들쭉날쭉·후퇴 경로면 낮다.
  // 격자가 아닌 이미지(콘셉트 스케치·비정면 사진)에 자신 있게 매스를 세우는 걸 막는 게이트.
  const spacingCV = (bands) => {
    if (bands.length < 2) return 1;
    const cs = bands.map(b2 => (b2[0] + b2[1]) / 2), ds = [];
    for (let i = 1; i < cs.length; i++) ds.push(cs[i] - cs[i - 1]);
    const m = ds.reduce((a2, v) => a2 + v, 0) / ds.length;
    const sd = Math.sqrt(ds.reduce((a2, v) => a2 + (v - m) * (v - m), 0) / ds.length);
    return m > 0 ? sd / m : 1;
  };
  const conf = !direct ? 0.2
    : Math.max(0, Math.min(1, 1 - Math.max(spacingCV(rb), spacingCV(cb)) * 1.6));
  const floors = Math.max(1, Math.min(60, rb.length));
  const bays = Math.max(1, Math.min(30, cb.length));
  const perX = bays > 1 ? fw / bays : fw, perY = floors > 1 ? fh / floors : fh;
  // 창 사각 — 실제 검출된 밴드 위치·크기 그대로. 이미지 위쪽이 최상층이므로 층 번호를 뒤집는다.
  const windows = [];
  for (let ri = 0; ri < rb.length; ri++) for (let ci = 0; ci < cb.length; ci++) {
    const [ra, rbb] = rb[ri], [ca, cbb] = cb[ci];
    windows.push({ floor: rb.length - 1 - ri, bay: ci,
      cx: ((ca + cbb) / 2) / fw, cy: 1 - ((ra + rbb) / 2) / fh,
      wFrac: Math.max(0.02, (cbb - ca) / fw), hFrac: Math.max(0.02, (rbb - ra) / fh) });
  }
  const aspect = fw / fh;
  const heightMM = floors * o.floorH;
  const widthMM = o.widthMM || Math.round(heightMM * aspect / 100) * 100;
  const depthMM = o.depthMM || Math.max(4000, Math.round(widthMM * 0.6 / 100) * 100);
  return { floors, bays, aspect: +aspect.toFixed(2), windows,
    meta: { imgW: im.width, imgH: im.height, facadePx: { x0, y0, x1, y1 }, periodPx: { x: +perX.toFixed(1), y: +perY.toFixed(1) },
      floorH: o.floorH, widthMM, depthMM, heightMM, conf: +conf.toFixed(2) } };
}

return { traceImage, traceFacade, classifyImage, traceConcept, _internal: { binarize, extractLines, mergeCollinear, pairWalls, peaksOf, span, gradients, periodOf, bandsOf, windowMask, prominentPeaks } };
})();
