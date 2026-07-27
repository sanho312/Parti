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
  const lowThr0 = maxH * 0.15;
  let xa = 0, xb = w - 1;
  while (xa < w - 1 && prof[xa] < lowThr0) xa++;
  while (xb > xa && prof[xb] < lowThr0) xb--;

  // ── 측면(奧行き面) 검출 → 깊이 ──
  // ★첫 시도(채움률)는 앞면과 측면을 구분하지 않아 잡음만 쟀다. 투시에서 깊이가 화면에
  //   드러나는 것은 오직 '측면의 폭'이다. 측면은 앞면과 밝기가 다르므로(음영·해칭)
  //   실루엣 '내부' 밝기의 단차로 경계를 찾는다.
  //   ★잉크 마스크로 재면 안 된다 — 흰 앞면은 잉크가 아니라서 열 평균이 성립하지 않는다(실측).
  //   ★검출을 '동 세기'보다 먼저 한다 — 안 그러면 측면이 별개 봉우리로 잡혀 동 수가 는다(실측).
  let depthRatio = null, depthConf = 0, sideL = 0, sideR = 0, dbgSide = null;
  {
    const colM = new Float32Array(w), colC = new Float32Array(w);
    for (let x = xa; x <= xb; x++) {
      if (prof[x] < lowThr0) continue;
      const y0s = Math.max(0, Math.round(baseY - prof[x]));
      for (let y = y0s; y <= Math.min(h - 1, baseY); y++) {
        const p = y * w + x;
        if (blueA[p] || greenA[p]) continue;         // 유리·조경은 재료가 달라 제외
        // ★종이(배경)를 빼야 한다 — prof 는 평활화돼 건물 밖으로 번지므로, 안 빼면
        //   끝단 열이 종이 밝기로 잡혀 측면 런이 즉시 끊긴다(실측: sideR 이 0).
        if (Math.abs(lum[p] - mode) <= 6) continue;
        colM[x] += lum[p]; colC[x]++;
      }
    }
    const valid = [];
    for (let x = xa; x <= xb; x++) if (colC[x] > maxH * 0.12) valid.push(x);
    if (valid.length > 24) {
      const mean = (x) => colM[x] / colC[x];
      const sorted = valid.map(mean).sort((p, q) => p - q);
      const med = sorted[sorted.length >> 1];
      const devs = valid.map(x => Math.abs(mean(x) - med)).sort((p, q) => p - q);
      const devHi = devs[Math.floor(devs.length * 0.92)];
      dbgSide = { valid: valid.length, med: +med.toFixed(1), devHi: +devHi.toFixed(1) };
      // ★상대 임계만 쓰면 측면이 없을 때 devHi 가 잡음 수준으로 내려앉아 아무 열이나
      //   '측면'이 된다(실측: 측면 0인데 깊이 0.47). 절대 대비 하한(18)을 함께 건다.
      if (devHi > 14) {
        const isSide = (x) => Math.abs(mean(x) - med) >= Math.max(18, devHi * 0.5);
        for (let k = valid.length - 1; k >= 0 && isSide(valid[k]); k--) sideR++;
        for (let k = 0; k < valid.length && isSide(valid[k]); k++) sideL++;
        if (sideL === valid.length) { sideL = 0; sideR = 0; }   // 전부 '측면'이면 판정 무의미
      }
    }
  }
  // 측면 구간을 뺀 '앞면만'의 구간에서 동을 센다
  const fa = Math.min(xb, xa + sideL), fb = Math.max(fa, xb - sideR);
  const profF = new Float32Array(w);
  for (let x = fa; x <= fb; x++) profF[x] = prof[x];
  let peaks = prominentPeaks(profF, Math.max(6, Math.round(w / 22)), Math.max(3, maxH * 0.055));
  // ── ★엔투라지(수목·인물)를 동으로 세지 않는다 ──
  // 실제 스케치에는 나무와 사람이 거의 항상 들어간다. 나뭇잎은 초록이라 bldg 에서 빠지지만
  // '줄기'와 사람은 잉크로 남아 실루엣에 가느다란 뾰족탑을 만들고, 봉우리 검출이 그걸
  // 동으로 센다(실측: 3동 그림의 봉우리 5개 중 2개가 나무·사람 — 몇 동을 그리든 5동이 나왔다).
  // ★가르는 기준은 높이가 아니라 '제 높이 절반에서의 폭'이다.
  //   높이로 거르면 낮은 부속동이 같이 날아가고, 전역 임계로 거르면 붙어 있는 동들이
  //   한 덩어리로 이어져 무의미해진다. 자기 봉우리 높이의 절반에서 재면 척도에 무관하다.
  //   (붙어 있는 박공은 처마가 이미 절반보다 높아 무리 전체가 한 런이 된다 → 넉넉히 통과)
  if (peaks.length > 1) {
    const minRun = Math.max(4, (xb - xa) * 0.04);
    peaks = peaks.filter(p => {
      // ★'제 높이의 절반'이 아니라 '제 돌출의 절반'에서 잰다. 둔덕·지붕 위에 얹힌 나무는
      //   절대 높이의 절반이 밑동보다 훨씬 아래라 런이 지형 전체로 번져 폭 검사가 통과된다.
      //   안부에서 절반만 올라온 높이에서 재면 나무는 제 수관 폭(20~40px)으로 줄어든다.
      //   지면에서 솟은 진짜 매스는 안부가 0 이라 half = 높이/2 로 수렴 = 예전과 같다.
      const half = profF[p.i] - p.prom * 0.5;
      let a2 = p.i, b2 = p.i;
      while (a2 > 0 && profF[a2 - 1] >= half) a2--;
      while (b2 < w - 1 && profF[b2 + 1] >= half) b2++;
      return (b2 - a2) >= minRun;
      // ★'봉우리 꼭대기가 초록이면 나무'로 한 번 더 거르는 것은 되돌렸다.
      //   스케치에서 나무는 건물 '앞에' 겹쳐 그려지는 일이 흔해서(수관이 지붕 봉우리와
      //   13px 거리) 창을 아무리 좁혀도 진짜 지붕까지 함께 지웠다 — 실측 3동이 1동이 됐다.
      //   색으로 거르려면 픽셀이 아니라 '연결 성분' 단위로 나무를 통째로 떼어내야 한다.
    });
    if (!peaks.length) peaks = prominentPeaks(profF, Math.max(6, Math.round(w / 22)), Math.max(3, maxH * 0.055));
  }
  const promAvg = peaks.length ? peaks.reduce((a, p) => a + p.prom, 0) / peaks.length : 0;
  const greenR = green / total, blueR = blue / total;

  // ── 동별 폭·높이와 인접 여부 ──
  // 한 덩어리에 같은 크기를 쓰면 스케치와 전혀 다른 그림이 된다(실사용 보고).
  // 봉우리 사이의 골로 동 경계를 나눠 폭 비율을, 봉우리 높이로 높이 비율을 얻는다.
  const lowThr = lowThr0;
  const valleys = [];
  for (let i = 1; i < peaks.length; i++) {
    let vi = peaks[i - 1].i, vv = Infinity;
    for (let x = peaks[i - 1].i; x <= peaks[i].i; x++) if (prof[x] < vv) { vv = prof[x]; vi = x; }
    valleys.push({ i: vi, v: vv, lo: Math.min(peaks[i - 1].v, peaks[i].v) });
  }
  let bounds = [fa].concat(valleys.map(v => v.i), [fb]);
  const spanW = Math.max(1, fb - fa);
  let massList = peaks.map((p, i) => ({
    wFrac: Math.max(0.02, (bounds[i + 1] - bounds[i]) / spanW),
    hFrac: maxH > 0 ? +(p.v / maxH).toFixed(3) : 1,
  }));
  // ── 유리면 군집으로 동 수 보정 ──
  // ★투시에서 겹친 동은 지붕 봉우리가 실루엣에 묻혀 하나 덜 세어진다(실사용: 5동→4동).
  //   유리 전면은 동마다 뚜렷한 파란 군집을 만드니, 군집이 더 많으면 그쪽을 믿는다.
  // ★'전면 유리'만 동의 근거가 된다. 파랗게 칠한 '창'까지 동으로 세면 창 2개짜리 3동이
  //   5동이 된다(창 위치 판독을 붙이고 실측).
  //   ★가르는 기준은 폭이 아니라 '높이'다 — 폭으로 걸렀더니 붙어 있는 평지붕 상자 4동이
  //     한 덩어리(peaks 1개)로 잡혀 문턱이 실루엣 전체 폭 기준이 되고, 멀쩡한 유리면 4개가
  //     통째로 탈락했다(4동 → 1동). 전면 유리는 층 높이를 거의 다 덮고, 창은 일부만 덮는다.
  const blueBands = bandsOf(colBlue, 0.22).filter(b2 => {
    if (b2[1] - b2[0] < w * 0.025) return false;
    let y0b = h, y1b = -1, hLocB = 0;
    for (let x = Math.max(0, b2[0]); x <= Math.min(w - 1, b2[1]); x++) {
      if (prof[x] > hLocB) hLocB = prof[x];
      for (let y = 0; y < h; y++) if (blueA[y * w + x]) { if (y < y0b) y0b = y; if (y > y1b) y1b = y; }
    }
    return y1b > y0b && hLocB > 0 && (y1b - y0b) >= hLocB * 0.45;
  });
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
  // ※동별(棟別) 깊이는 여기서 내지 않는다 — 두 번 실험해 둘 다 불가로 결론.
  //   ① 실루엣 봉우리 높이: 깊이가 깊을수록 용마루가 뒤·위로 물러나 높아진다. 그러나
  //      '경사만 다르게' 그린 대조군의 패턴이 거의 같았다(깊이만: .805/.846/.887/.930/.933,
  //      경사만: .768/.806/.845/.903/1.00) → 단일 뷰에서 깊이와 물매는 분리되지 않는다.
  //   ② 지붕면의 가로 폭: 깊이에만 반응하는 좋은 신호지만, 붙어 있는 동은 다음 동이
  //      앞을 가려 끝 동 말고는 측정 자체가 불가능하다.
  //   → 무리 전체 깊이(아래)만 내고, 동별 차이는 사용자가 문장으로 지정하게 한다.
  // 측면 폭 → 깊이 배수. 투시각을 모르므로 2점 투시 30~45° 관용값(깊이/측면폭 ≈ 1.6)을 쓴다.
  // 값이 없으면(음영이 없거나 측면이 안 보이면) null — 잘못된 값을 내보내지 않는다.
  {
    const side = Math.max(sideL, sideR);
    const oneFront = spanW / Math.max(1, masses);
    if (side >= Math.max(6, oneFront * 0.1) && oneFront > 4) {
      depthRatio = +Math.max(0.4, Math.min(3.0, (side / oneFront) * 1.6)).toFixed(2);
      depthConf = +Math.min(1, side / oneFront).toFixed(2);
    }
  }
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
  // ── 어느 값을 믿을 것인가 ──
  // ★붙어 있는 동은 자기 좌·우 모서리를 이웃에 가려 못 보여준다. 그 상태에서 창까지 그려져
  //   있으면 측정 창 안에서 '벽 대신 창틀'을 모서리로 잡아 값이 통째로 튄다
  //   (실측: -0.25 로 그린 그림에서 동별 -0.656/-0.667/-0.296, 무리 평균 -0.54.
  //    같은 그림에서 창만 지우면 -0.25/-0.25/-0.247 로 정확했다).
  //   예전에는 '무리 값이 더 클 때만' 믿었는데, 이 오염은 값을 부풀리는 쪽이라 그 조건이
  //   거꾸로 작동해 오염된 값이 이겼다. 바깥 실루엣은 아무것도 가리지 않으므로 항상 옳다.
  //   ※'붙어 있을 때만' 무리 값을 쓰는 것으로 먼저 고쳤으나, 떨어진 동에서도 기울기 0.25
  //     이상이면 같은 오염이 났다(창 위치 오차 0.15). 가림이 아니라 '창' 자체가 원인이므로
  //     동별 측정은 조건 없이 버린다. 잃는 것은 '동마다 다른 기울기'인데, 그건 애초에
  //     신뢰성 있게 잰 적이 없다(깊이 때와 같은 결론).
  if (clusterLean != null) {
    for (const mm of massList) mm.lean = +clusterLean.toFixed(3);
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

  // ── ★창 판독만 2배 해상도로 ──
  // 전체 분석은 maxSide(기본 700)로 한다 — 동 수·기울기·깊이의 임계가 그 크기에 맞춰
  // 실측으로 조정돼 있어서 건드리면 전부 다시 맞춰야 한다. 창 판독만 떼어 원본에서
  // 한 번 더 크게 그려 읽는다. 사진 속 창은 20~70px 이라 표시(멀리언·개폐 사선)가
  // 뭉개지는데, 2배면 40~140px 이 되어 판정 가능 구간으로 들어온다.
  let Ww = w, Wh = h, WK = 1, Wbldg = bldg, WblueA = blueA, Wprof = prof, WbaseY = baseY;
  if (im.width > w * 1.4 || im.height > h * 1.4) {
    try {
      const c2 = toCanvas(im, Math.min(1600, (o.maxSide || 700) * 2));
      if (c2.w > w * 1.2) {
        const d2 = c2.ctx.getImageData(0, 0, c2.w, c2.h).data;
        const n2 = c2.w * c2.h;
        const b2 = new Uint8Array(n2), q2 = new Uint8Array(n2);
        for (let i2 = 0, p2 = 0; i2 < d2.length; i2 += 4, p2++) {
          const r2 = d2[i2], g3 = d2[i2 + 1], l2 = d2[i2 + 2];
          const L2 = (r2 * 299 + g3 * 587 + l2 * 114) / 1000;
          const isG2 = g3 > r2 + 12 && g3 > l2 + 12;
          const isB2 = l2 > r2 + 12 && l2 > g3 + 4;
          if (isB2) q2[p2] = 1;
          if (!isG2 && (L2 < inkThr || isB2)) b2[p2] = 1;   // 임계는 같은 사진이므로 그대로
        }
        WK = c2.w / w; Ww = c2.w; Wh = c2.h; Wbldg = b2; WblueA = q2;
        WbaseY = Math.round(baseY * WK);
        Wprof = new Float32Array(Ww);
        for (let x2 = 0; x2 < Ww; x2++)
          Wprof[x2] = prof[Math.min(w - 1, Math.round(x2 / WK))] * WK;
      }
    } catch (e) { /* 고해상도 실패는 치명적이지 않다 — 기본 공간으로 읽는다 */ }
  }


  // ── ★창 위치 판독 ──
  // 지금까지 창은 '균일 격자'로 만들었다(비유리 스케치는 아예 0개였다). 그림에 창이
  // 그려져 있으면 그 자리에 뚫는 게 맞다. 투시 스케치에서 창이 화면에 남기는 자국은 둘이다.
  //   ① 닫힌 사각형으로 그린 창 → 앞면 흰 바탕 안에 '갇힌 흰 구멍'이 생긴다
  //   ② 색(파랑)으로 칠한 창   → 파란 덩어리가 생긴다
  // 둘 다 연결 성분으로 잡고, 앞면 대비 크기·비례로 거른다.
  // ※전면 통유리는 파란 덩어리가 앞면만큼 커져 자동 탈락한다 → 기존 커튼월 규칙 유지.
  // ── 밑변 구간 재기 ──
  // ★바닥선 '위' 행을 훑으면 안 된다 — 거기엔 세로 벽선 몇 개뿐이라 좌우 끝이 같은 점이
  //   되고 폭이 0 이 된다(실측: 기울인 그림에서 3동 중 2동이 통째로 버려졌다).
  //   건물 밑단은 그림에 '가로선'으로 그려져 있으므로, 바닥선 근처에서 잉크가 가장 많은
  //   행을 골라 그 행의 연속 구간을 쓴다. 이 값은 기울기와 무관한 실측값이다.
  //   ※무리 전체(whole=true)는 틈을 건너 좌·우 끝을 쓰고, 동 하나는 '가장 긴 연속 구간'을
  //     쓴다. 끝에서 끝으로 재면 기울어 다가온 이웃의 밑단까지 삼켜 창이 밀린다
  //     (실측: 떨어진 동 + 기울기 0.25 이상에서 u 오차 0.15).
  const baseSpan = (a4, b4, whole) => {
    let bestY = -1, bestN = -1;
    for (let dy = -2; dy <= 2; dy++) {
      const y = WbaseY + dy; if (y < 0 || y >= Wh) continue;
      let n = 0;
      for (let x = a4; x <= b4; x++) if (Wbldg[y * Ww + x]) n++;
      if (n > bestN) { bestN = n; bestY = y; }
    }
    if (bestY < 0 || bestN <= 0) return null;
    if (whole) {
      let p0 = -1, p1 = -1;
      for (let x = a4; x <= b4; x++) if (Wbldg[bestY * Ww + x]) { if (p0 < 0) p0 = x; p1 = x; }
      return [p0, p1];
    }
    let s0 = -1, bs = -1, be = -1, gapRun = 0;
    for (let x = a4; x <= b4 + 1; x++) {
      const on = x <= b4 && !!Wbldg[bestY * Ww + x];
      if (on) { if (s0 < 0) s0 = x; gapRun = 0; }
      else if (s0 >= 0) {
        gapRun++;
        if (gapRun > 3 || x > b4) {                 // 3px 이하 끊김은 손그림 붓 끊김으로 본다
          const e0 = x - gapRun;
          if (e0 - s0 > be - bs) { bs = s0; be = e0; }
          s0 = -1; gapRun = 0;
        }
      }
    }
    return bs >= 0 ? [bs, be] : null;
  };
  const clB = baseSpan(0, Ww - 1, true) || [fa * WK, fb * WK];
  const winsOf = (x0, x1, eh) => {
    const wd = x1 - x0 + 1, ht = Math.round(eh);
    if (wd < 12 || ht < 12) return null;
    const y0 = Math.max(0, Math.round(WbaseY - eh)), y1 = Math.min(Wh - 1, Math.round(WbaseY));
    const rw = wd, rh = y1 - y0 + 1;
    if (rh < 12) return null;
    // 앞면 안쪽 = 실루엣 내부. 밖은 아예 후보에서 뺀다(하늘의 흰 바탕이 섞이면 전부 망가진다).
    const inside = new Uint8Array(rw * rh);
    let faceA = 0;
    for (let x = x0; x <= x1; x++) {
      const top = Math.max(y0, Math.round(WbaseY - Wprof[x]));
      for (let y = Math.max(y0, top); y <= y1; y++) { inside[(y - y0) * rw + (x - x0)] = 1; faceA++; }
    }
    if (faceA < 200) return null;
    const st = new Int32Array(rw * rh);
    // 성분 수집기 — mask 가 1 인 연결 덩어리의 bbox 를 모은다
    const comps = (mask, dropBorder) => {
      const seen = new Uint8Array(rw * rh), out = [];
      for (let p = 0; p < mask.length; p++) {
        if (!mask[p] || seen[p]) continue;
        let t = 0, area = 0, bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9, touch = false;
        st[t++] = p; seen[p] = 1;
        while (t) {
          const q = st[--t], qx = q % rw, qy = (q / rw) | 0;
          area++;
          if (qx < bx0) bx0 = qx; if (qx > bx1) bx1 = qx;
          if (qy < by0) by0 = qy; if (qy > by1) by1 = qy;
          if (qx === 0 || qx === rw - 1 || qy === 0 || qy === rh - 1) touch = true;
          if (qx > 0 && mask[q - 1] && !seen[q - 1]) { seen[q - 1] = 1; st[t++] = q - 1; }
          if (qx < rw - 1 && mask[q + 1] && !seen[q + 1]) { seen[q + 1] = 1; st[t++] = q + 1; }
          if (qy > 0 && mask[q - rw] && !seen[q - rw]) { seen[q - rw] = 1; st[t++] = q - rw; }
          if (qy < rh - 1 && mask[q + rw] && !seen[q + rw]) { seen[q + rw] = 1; st[t++] = q + rw; }
        }
        if (dropBorder && touch) continue;
        out.push({ area, bx0, by0, bx1, by1 });
      }
      return out;
    };
    // ① 갇힌 흰 구멍 — 앞면 안쪽에서 잉크·색이 아닌 곳. 실루엣 경계에 닿는 덩어리(=바탕벽)는 뺀다.
    const white = new Uint8Array(rw * rh);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const p = (y - y0) * rw + (x - x0);
      if (inside[p] && !Wbldg[y * Ww + x]) white[p] = 1;
    }
    // ② 색칠한 창
    const blue = new Uint8Array(rw * rh);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const p = (y - y0) * rw + (x - x0);
      if (inside[p] && WblueA[y * Ww + x]) blue[p] = 1;
    }
    const cand = comps(white, true).map(c => (c.src = 'hole', c))
      .concat(comps(blue, false).map(c => (c.src = 'fill', c)));
    // ── 후보 거르기 ──
    // ★이 단계는 '조각'도 통과시킨다. 모양(가로세로비·사각형다움) 판정은 묶은 뒤로 미룬다.
    //   여기서 모양까지 걸렀더니, X 표시가 만든 삼각형이나 커튼선이 만든 얇은 조각이 개별
    //   탈락해 창이 통째로 사라졌다(실측: X 표현·커튼 표현 창에서 검출 0개).
    const wins = [];
    for (const c of cand) {
      const bw = c.bx1 - c.bx0 + 1, bh = c.by1 - c.by0 + 1;
      if (bw < 3 || bh < 3) continue;
      const ar = c.area / faceA;
      // 상한은 넉넉히 — 앞면의 1/4을 차지하는 큰 창은 흔하다. 전면 통유리(0.8+)만 걸러내면 된다.
      if (ar < 0.0006 || ar > 0.30) continue;              // 너무 작으면 잡티, 크면 벽·전면유리
      if (c.area / (bw * bh) < 0.35) continue;             // 속이 빈 획 조각만 배제
      // ★갇힌 흰 구멍은 창틀 '안쪽'이다 — 선 두께만큼 실제 창보다 작다(실측 12% 과소).
      //   구멍 경계에서 바깥으로 잉크가 이어지는 두께를 국소로 재서 되돌린다.
      //   (해칭·인접선을 타고 번지지 않게 변 길이의 25% 로 상한)
      let ex0 = c.bx0, ex1 = c.bx1, ey0 = c.by0, ey1 = c.by1;
      if (c.src === 'hole') {
        const inkAt = (px, py) => (px >= 0 && px < rw && py >= 0 && py < rh) &&
          !!Wbldg[(py + y0) * w + (px + x0)];
        const cap = (v2, lim) => Math.min(v2, Math.max(1, Math.round(lim * 0.25)));
        const ym = (c.by0 + c.by1) >> 1, xm = (c.bx0 + c.bx1) >> 1;
        let t2 = 0; while (inkAt(c.bx0 - 1 - t2, ym) && t2 < bw) t2++; ex0 -= cap(t2, bw);
        t2 = 0; while (inkAt(c.bx1 + 1 + t2, ym) && t2 < bw) t2++; ex1 += cap(t2, bw);
        t2 = 0; while (inkAt(xm, c.by0 - 1 - t2) && t2 < bh) t2++; ey0 -= cap(t2, bh);
        t2 = 0; while (inkAt(xm, c.by1 + 1 + t2) && t2 < bh) t2++; ey1 += cap(t2, bh);
      }
      wins.push({ cx: (ex0 + ex1) / 2, cy: (ey0 + ey1) / 2, bw: ex1 - ex0 + 1, bh: ey1 - ey0 + 1,
        area: c.area,
        // ★사각형다움 — 선 두께를 되살리기 '전' 상자로 잰다. 진짜 유리칸은 1.0 에 가깝고,
        //   비스듬한 선(유리 반사 표현)이 갈라 놓은 조각은 삼각형이라 0.5 언저리다.
        fill: c.area / (bw * bh) });
    }
    // ★'2개 이상'을 요구했더니 큰 창 하나짜리 동이 통째로 버려졌다(실측: 3동 중 1동 누락).
    //   창을 못 읽으면 균일 격자로 후퇴할 뿐이라 놓치는 쪽이 손해가 크다 — 1개도 받는다.
    if (wins.length < 1 || wins.length > 160) return null;
    const keep = wins;
    // ── ★유리 칸을 하나의 창으로 묶는다 ──
    // 창에 표시(중간 멀리언·창살)를 그리면 칸마다 '갇힌 흰 구멍'이 하나씩 생겨 창 하나가
    // 여러 개로 세어진다(실측: 격자창 1개→9개, 미닫이 1개→2개, 오르내리 1개→2개).
    // 칸들이 '얇은 선 하나를 사이에 두고 변을 맞대면' 같은 창이다. 묶고 나면 칸의 배열
    // (cols×rows)이 그대로 창 종류의 근거가 된다 — 버그 수정과 종류 판독이 같은 작업이다.
    const par = keep.map((_, i2) => i2);
    const find = (i2) => { while (par[i2] !== i2) { par[i2] = par[par[i2]]; i2 = par[i2]; } return i2; };
    const box = (c) => [c.cx - c.bw / 2, c.cy - c.bh / 2, c.cx + c.bw / 2, c.cy + c.bh / 2];
    for (let i2 = 0; i2 < keep.length; i2++) for (let j2 = i2 + 1; j2 < keep.length; j2++) {
      const A = box(keep[i2]), B = box(keep[j2]);
      const mnW = Math.min(keep[i2].bw, keep[j2].bw), mnH = Math.min(keep[i2].bh, keep[j2].bh);
      // 멀리언 허용 두께 — 칸 크기에 비해 얇아야 한다. 창끼리의 간격은 보통 이보다 훨씬 넓다.
      const MUL = Math.max(3, Math.min(mnW, mnH) * 0.45);
      const sameRow = Math.abs(A[1] - B[1]) <= mnH * 0.3 && Math.abs(A[3] - B[3]) <= mnH * 0.3;
      const sameCol = Math.abs(A[0] - B[0]) <= mnW * 0.3 && Math.abs(A[2] - B[2]) <= mnW * 0.3;
      const gapX = A[0] < B[0] ? B[0] - A[2] : A[0] - B[2];
      const gapY = A[1] < B[1] ? B[1] - A[3] : A[1] - B[3];
      // ★많이 겹치면 같은 창의 조각이다 — ①흰 구멍과 ②색칠을 둘 다 잡은 경우,
      //   그리고 X 표시가 만든 삼각형들처럼 서로 파고든 조각들이 여기에 해당한다.
      //   예전엔 겹치는 후보를 '버렸는데', 그러면 X 창이 삼각형 하나 크기로 줄어든다.
      const ovX = Math.min(A[2], B[2]) - Math.max(A[0], B[0]);
      const ovY = Math.min(A[3], B[3]) - Math.max(A[1], B[1]);
      const ovA = (ovX > 0 && ovY > 0) ? ovX * ovY : 0;
      const heavy = ovA >= Math.min((A[2] - A[0]) * (A[3] - A[1]), (B[2] - B[0]) * (B[3] - B[1])) * 0.4;
      // 선 두께를 되살리며 칸끼리 겹칠 수 있으므로 음수 간격도 멀리언 두께까지 허용한다.
      if (heavy || (sameRow && gapX >= -MUL && gapX <= MUL) || (sameCol && gapY >= -MUL && gapY <= MUL)) {
        const ra = find(i2), rb = find(j2); if (ra !== rb) par[rb] = ra;
      }
    }
    // ── ★칸 안의 개폐 표시(사선) 재기 ──
    // 여닫이·들창·하부회전은 칸을 나누지 않는다 — 대신 칸 안에 점선 삼각형을 그린다.
    // 꼭짓점(apex)이 어디냐가 종류를 가른다. 후보 도형마다 '잉크가 그 선들에 얼마나
    // 가까이 놓였나'를 재서 가장 잘 설명하는 것을 고른다. 점선이라 잉크가 끊겨 있어도
    // 거리 기반 점수는 흔들리지 않는다.
    const MARKS = {
      apexL: [[1, 0, 0, 0.5], [1, 1, 0, 0.5]],       // 꼭짓점이 왼쪽
      apexR: [[0, 0, 1, 0.5], [0, 1, 1, 0.5]],
      apexT: [[0, 1, 0.5, 0], [1, 1, 0.5, 0]],       // 꼭짓점이 위
      apexB: [[0, 0, 0.5, 1], [1, 0, 0.5, 1]],
      cross: [[0, 0, 1, 1], [1, 0, 0, 1]],           // X — 두 대각선
    };
    const segDist = (px, py, a, b, c2, d2) => {
      const vx = c2 - a, vy = d2 - b, L2 = vx * vx + vy * vy;
      let t3 = L2 > 0 ? ((px - a) * vx + (py - b) * vy) / L2 : 0;
      t3 = Math.max(0, Math.min(1, t3));
      const dx2 = px - (a + vx * t3), dy2 = py - (b + vy * t3);
      return Math.hypot(dx2, dy2);
    };
    // 칸 안(테두리 제외)의 잉크로 표시를 판정한다. 근거가 약하면 null.
    const markOf = (bx0, by0, bx1, by1) => {
      const iw = bx1 - bx0 + 1, ih = by1 - by0 + 1;
      if (iw < 14 || ih < 14) return null;               // 이 크기 밑에선 사선이 분해되지 않는다
      const mx = Math.max(2, Math.round(iw * 0.16)), my = Math.max(2, Math.round(ih * 0.16));
      const ax0 = bx0 + mx, ay0 = by0 + my, ax1 = bx1 - mx, ay1 = by1 - my;
      const aw = ax1 - ax0, ah = ay1 - ay0;
      if (aw < 8 || ah < 8) return null;
      // ★잉크는 '테두리를 뺀 안쪽'에서 모으되, 좌표는 '칸 전체' 기준으로 정규화한다.
      //   안쪽 상자로 정규화하면 칸 전체를 가로지르는 사선이 후보 도형과 어긋나 전부
      //   unknown 이 된다(실측: 여닫이·들창·하부회전 4종 모두 판정 실패).
      const fw2 = Math.max(1, bx1 - bx0), fh2 = Math.max(1, by1 - by0);
      const pts = [];
      let tot = 0;
      for (let y = ay0; y <= ay1; y++) for (let x = ax0; x <= ax1; x++) {
        tot++;
        if (Wbldg[(y + y0) * Ww + (x + x0)]) pts.push([(x - bx0) / fw2, (y - by0) / fh2]);
      }
      void aw; void ah;
      if (!tot) return null;
      const ratio = pts.length / tot;
      if (ratio < 0.012) return { kind: 'none', ratio: +ratio.toFixed(4) };   // 아무 표시 없음
      if (ratio > 0.5) return null;                       // 통째로 칠해진 칸 — 표시가 아니다
      const TOL = 0.09;                                   // 정규화 좌표 기준 허용 거리
      const scores = [];
      for (const k of Object.keys(MARKS)) {
        // ① 설명률 — 칸 안의 잉크가 그 도형 위에 놓였는가
        let near = 0, sum = 0;
        for (const p of pts) {
          let d3 = 1e9;
          for (const sg of MARKS[k]) d3 = Math.min(d3, segDist(p[0], p[1], sg[0], sg[1], sg[2], sg[3]));
          sum += d3; if (d3 <= TOL) near++;
        }
        // ② ★두 팔이 '모두' 그려져 있는가 — 개폐 표시는 선 하나가 아니라 V(또는 X)다.
        //    이 검사가 없으면 유리 반사선 하나가 들창(apexT)으로 읽힌다(실측).
        //    선을 따라 표본점을 찍고, 그 근처에 잉크가 있는 비율을 팔마다 따로 잰다.
        let armMin = 1;
        for (const sg of MARKS[k]) {
          const N = 24;
          let hitN = 0;
          for (let t4 = 0; t4 <= N; t4++) {
            const f2 = t4 / N;
            const qx = sg[0] + (sg[2] - sg[0]) * f2, qy = sg[1] + (sg[3] - sg[1]) * f2;
            let ok2 = false;
            for (const p of pts) if (Math.abs(p[0] - qx) <= TOL && Math.abs(p[1] - qy) <= TOL) { ok2 = true; break; }
            if (ok2) hitN++;
          }
          armMin = Math.min(armMin, hitN / (N + 1));
        }
        scores.push({ k, hit: near / pts.length, arm: armMin, avg: sum / pts.length });
      }
      scores.sort((a2, b2) => (b2.hit + b2.arm) - (a2.hit + a2.arm) || a2.avg - b2.avg);
      const best = scores[0], second = scores[1];
      // 근거 게이트 — 잉크가 그 도형으로 설명되고(hit), 두 팔이 모두 실제로 그려져 있고(arm),
      // 2등과 뚜렷이 차이나야 채택한다. 하나라도 모자라면 '모른다'로 물러난다.
      if (best.hit < 0.75 || best.arm < 0.55
          || (best.hit + best.arm) - (second.hit + second.arm) < 0.15)
        return { kind: 'unknown', ratio: +ratio.toFixed(4) };
      return { kind: best.k, ratio: +ratio.toFixed(4), hit: +best.hit.toFixed(2),
        arm: +best.arm.toFixed(2), margin: +((best.hit + best.arm) - (second.hit + second.arm)).toFixed(2) };
    };
    const grp = new Map();
    keep.forEach((c, i2) => { const r2 = find(i2); if (!grp.has(r2)) grp.set(r2, []); grp.get(r2).push(c); });
    const merged = [];
    for (const panes of grp.values()) {
      let bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;
      panes.forEach(c => { const B = box(c);
        if (B[0] < bx0) bx0 = B[0]; if (B[1] < by0) by0 = B[1];
        if (B[2] > bx1) bx1 = B[2]; if (B[3] > by1) by1 = B[3]; });
      // ── 묶은 '창' 단위로 모양을 판정한다 ──
      const mW = bx1 - bx0 + 1, mH = by1 - by0 + 1;
      const aspM = mW / mH;
      if (aspM < 0.18 || aspM > 5.5) continue;             // 선 조각이 뭉친 것 배제
      const arM = (mW * mH) / faceA;
      if (arM < 0.0015 || arM > 0.35) continue;
      // 조각들이 그 사각형을 실제로 채워야 창이다 (흩어진 잡티가 우연히 뭉친 것 배제)
      if (panes.reduce((a2, c) => a2 + c.area, 0) / (mW * mH) < 0.5) continue;
      const nClust = (vals, tol) => { const sv = vals.slice().sort((a, b) => a - b);
        let n2 = 1; for (let k = 1; k < sv.length; k++) if (sv[k] - sv[k - 1] > tol) n2++; return n2; };
      // ★칸 배열은 '직사각형 조각'으로만 센다.
      //   비스듬한 선이 만든 삼각형 조각까지 칸으로 세면 유리 반사선 한 줄이 미닫이(2x1)로,
      //   X 표시가 격자(3x3)로 읽힌다(실측). 멀리언·창살은 축에 맞는 직선이므로 칸은 사각형이다.
      const rect = panes.filter(c => c.fill >= 0.72);
      const div = rect.length >= 2;
      const cols = div ? nClust(rect.map(c => c.cx), Math.max(4, (bx1 - bx0) * 0.12)) : 1;
      const rows = div ? nClust(rect.map(c => c.cy), Math.max(4, (by1 - by0) * 0.12)) : 1;
      merged.push({
        cx: x0 + (bx0 + bx1) / 2, cy: y0 + (by0 + by1) / 2,
        bw: bx1 - bx0 + 1, bh: by1 - by0 + 1,
        cols, rows, panes: div ? rect.length : 1,
        // 칸이 안 나뉘었을 때만 안쪽 사선을 본다 (나뉘었으면 배열 자체가 근거다)
        mark: (cols === 1 && rows === 1)
          ? markOf(Math.round(bx0), Math.round(by0), Math.round(bx1), Math.round(by1)) : null,
      });
    }
    if (!merged.length || merged.length > 40) return null;
    // 픽셀 좌표 그대로 돌려준다 — 정규화(기울기 되돌리기 포함)는 호출부 한 곳에서 한다.
    return merged;
  };
  // ── ★면의 재료 판독 ──
  // Parti 는 이미 재질 프리셋 15종(벽돌·목재·콘크리트·회벽·금속·유리…)을 갖고 있고,
  // 엔티티에 e.mat 을 달면 3D 색이 즉시 그 재질을 따라간다. 판독은 '앞면의 대표색'을
  // 프리셋 계열로 되돌리는 문제가 된다.
  // ★핵심 게이트 — '칠하지 않은 종이'와 '흰 벽'은 그림에서 같은 색이다. 구분할 수 없으므로
  //   종이색과 가까운 면은 재료를 내지 않는다(회벽은 원리적으로 판독 불가 — 기본값으로 둔다).
  //   창 종류 때와 같은 원칙이다: 안 그린 것을 읽은 것처럼 내보내면 거짓말이 된다.
  const rgb2hsl = (r2, g2, b2) => {
    r2 /= 255; g2 /= 255; b2 /= 255;
    const mx = Math.max(r2, g2, b2), mn = Math.min(r2, g2, b2), L2 = (mx + mn) / 2;
    let S2 = 0, H2 = 0;
    if (mx !== mn) {
      const dd = mx - mn;
      S2 = L2 > 0.5 ? dd / (2 - mx - mn) : dd / (mx + mn);
      H2 = mx === r2 ? ((g2 - b2) / dd + (g2 < b2 ? 6 : 0)) : mx === g2 ? ((b2 - r2) / dd + 2) : ((r2 - g2) / dd + 4);
      H2 *= 60;
    }
    return [H2, S2 * 100, L2 * 100];
  };
  // 종이색 — 건물 밖(실루엣 위쪽 하늘 자리)의 대표색. 채색 여부의 기준자다.
  const paperHSL = (() => {
    const hs = [], ss = [], ls = [];
    for (let x = xa; x <= xb; x += 2) {
      const topY = Math.max(0, Math.round(baseY - prof[x]) - 6);
      for (let y = Math.max(by0, topY - 30); y < topY; y += 2) {
        const p2 = y * w + x;
        if (bldg[p2] || greenA[p2]) continue;
        const i2 = p2 * 4;
        const v = rgb2hsl(d[i2], d[i2 + 1], d[i2 + 2]);
        hs.push(v[0]); ss.push(v[1]); ls.push(v[2]);
      }
    }
    const med = (a) => { if (!a.length) return null; a.sort((p2, q2) => p2 - q2); return a[a.length >> 1]; };
    return hs.length >= 40 ? [med(hs), med(ss), med(ls)] : null;
  })();
  // 색상 계열 → 재질 프리셋. ★순서가 중요하다 — 금속은 '차가운 회색'이라 무채색 분기가
  //   먼저 걸리면 회벽이 된다(실측). 겹치는 프리셋(콘크리트↔석재, 금속↔스테인리스,
  //   회벽↔페인트↔대리석)은 대표 하나로 합친다 — 색만으로는 원리적으로 못 가른다.
  const matOfHSL = (H2, S2, L2) => {
    if (H2 >= 175 && H2 <= 255) {
      if (S2 >= 25 && L2 >= 60) return 'glass';
      if (S2 >= 4) return 'metal';
    }
    if (S2 < 12) return L2 >= 74 ? null : 'concrete';    // 밝은 무채색 = 종이와 구분 불가
    if (H2 < 22 && S2 >= 25) return 'brick';
    if (H2 >= 22 && H2 <= 50) return S2 >= 32 ? 'wood' : (L2 >= 70 ? null : 'concrete');
    // ★초록은 파사드 재료로 판정하지 않는다 — 이 판독기에서 초록은 '조경'이고, 건물 발치의
    //   잔디가 면 통계에 섞이면 벽이 잔디가 된다. 초록 건물보다 잘못 읽을 위험이 훨씬 크다.
    return null;
  };
  // ── ★질감 패턴으로 재료 읽기 ──
  // 색을 안 칠한 연필 스케치는 색 판독이 물러난다. 그때 남는 단서가 '무늬'다.
  // 앞서 한 번 실패하고 되돌렸다. 그때 배운 두 가지를 이번엔 처음부터 적용한다:
  //   ① 자기유사도(reg)만 보면 안 된다 — 평평하거나 잡음인 프로파일이 '어떤 주기로도'
  //      0.9 이상을 낸다(실측: 가로줄만 그렸는데 세로도 0.96 → 전부 격자로 읽혔다).
  //      주기 p 의 유사도에서 어긋난 주기(1.5p·0.6p)의 유사도를 빼야 진짜 주기만 남는다.
  //   ② mm 척도를 '층수×층고'로 잡으면 안 된다 — 층수 추정이 1을 2로 읽는 순간 벽돌 켜
  //      75mm 가 138mm(사이딩)로 바뀐다. 이미 정확히 검출하는 '창 높이'를 자로 쓴다.
  const faceTex = (x0, x1, eh, mmPerPx, wins) => {
    const y0 = Math.max(0, Math.round(baseY - eh)), y1 = Math.min(h - 1, Math.round(baseY));
    const W2 = x1 - x0 + 1, H2 = y1 - y0 + 1;
    if (W2 < 30 || H2 < 30 || !(mmPerPx > 0)) return null;
    const blocked = (x, y) => (wins || []).some(q =>
      x > q.cx - q.bw / 2 - 2 && x < q.cx + q.bw / 2 + 2 &&
      y > q.cy - q.bh / 2 - 2 && y < q.cy + q.bh / 2 + 2);
    const row = new Float32Array(H2), col = new Float32Array(W2);
    const rowN = new Float32Array(H2), colN = new Float32Array(W2);
    let ink = 0, tot = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const top = Math.max(y0, Math.round(baseY - prof[x]));
      if (y < top || blocked(x, y)) continue;
      tot++; rowN[y - y0]++; colN[x - x0]++;
      if (bldg[y * w + x]) { ink++; row[y - y0]++; col[x - x0]++; }
    }
    if (tot < 2000) return null;
    // 면적당 잉크로 정규화 — 날것의 개수를 쓰면 박공 실루엣 모양이 무늬로 둔갑한다
    for (let i2 = 0; i2 < H2; i2++) row[i2] = rowN[i2] > 4 ? row[i2] / rowN[i2] : 0;
    for (let i2 = 0; i2 < W2; i2++) col[i2] = colN[i2] > 4 ? col[i2] / colN[i2] : 0;
    const dens = ink / tot;
    if (dens < 0.02 || dens > 0.6) return null;
    const reg = (arr, p) => {
      if (!(p > 2) || p >= arr.length) return 0;
      let s2 = 0, c2 = 0;
      for (let i2 = 0; i2 + p < arr.length; i2++) { s2 += Math.min(arr[i2], arr[i2 + p]); c2 += Math.max(arr[i2], arr[i2 + p]); }
      return c2 > 0 ? s2 / c2 : 0;
    };
    // ★상대 자기상관 — 어긋난 주기보다 얼마나 더 닮았는가. 잡음은 어디서나 같아 0 이 된다.
    const relReg = (arr, p) => {
      if (!(p > 2)) return 0;
      const off = Math.max(reg(arr, Math.round(p * 1.5)), reg(arr, Math.max(3, Math.round(p * 0.6))));
      return reg(arr, p) - off;
    };
    const fund = (arr, p) => {                      // 배음 보정 — 자기상관은 배수에 걸리기 쉽다
      let q = p;
      for (let k = 0; k < 3 && q >= 6; k++) {
        const half = Math.round(q / 2);
        if (half >= 3 && relReg(arr, half) >= relReg(arr, q) * 0.9) q = half; else break;
      }
      return q;
    };
    const ph = fund(row, periodOf(row, 3, H2 / 3));
    const pv = fund(col, periodOf(col, 3, W2 / 3));
    const rh = relReg(row, ph), rv = relReg(col, pv);
    const mmH = ph > 0 ? ph * mmPerPx : 0, mmV = pv > 0 ? pv * mmPerPx : 0;
    const TH = 0.14;                                 // 상대 자기상관 문턱
    if (rh >= TH && rh > rv + 0.06) {
      if (mmH >= 50 && mmH <= 120) return { mat: 'brick', conf: 0.55, note: '켜 ' + Math.round(mmH) + 'mm' };
      if (mmH > 120 && mmH <= 340) return { mat: 'wood', conf: 0.5, note: '사이딩 ' + Math.round(mmH) + 'mm' };
      return null;                                   // 주기는 있는데 치수가 재료답지 않다
    }
    // ※무늬로 내는 재료는 벽돌 켜와 목재 사이딩 둘뿐이다.
    //   · 콘크리트 점묘: '주기가 없다'로 판정해야 하는데, 너무 고운 줄무늬(켜가 2px)도
    //     주기를 못 찾아 똑같이 보인다 — 실측에서 벽돌이 콘크리트로 둔갑했다. 대비로
    //     가르려 했으나 그 크기에선 안티에일리어싱으로 대비마저 뭉개져 척도에 따라
    //     오락가락했다(S1 미검출, S2·S3 절반). 뺀다.
    //   · 타일 격자: 두 축 모두에서 상대 자기상관을 안정적으로 얻지 못했다. 뺀다.
    //   확신 없는 재료를 내보내느니 안 내보낸다 — 색 판독이 기본값으로 남는다.
    return null;
  };
  const faceMat = (x0, x1, eh) => {
    if (!paperHSL) return null;
    const y0 = Math.max(0, Math.round(baseY - eh)), y1 = Math.min(h - 1, Math.round(baseY));
    const hs = [], ss = [], ls = [];
    for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++) {
      const top = Math.max(y0, Math.round(baseY - prof[x]));
      for (let y = top; y <= y1; y++) {
        const p2 = y * w + x;
        const i2 = p2 * 4;
        const v = rgb2hsl(d[i2], d[i2 + 1], d[i2 + 2]);
        if (v[2] < 22 || v[2] > 96) continue;            // 잉크·창(흰 구멍) 제외
        hs.push(v[0]); ss.push(v[1]); ls.push(v[2]);
      }
    }
    if (hs.length < 300) return null;
    const med = (a) => { a.sort((p2, q2) => p2 - q2); return a[a.length >> 1]; };
    const H2 = med(hs), S2 = med(ss), L2 = med(ls);
    // 종이와 얼마나 다른가 — 가까우면 '안 칠했다'로 본다
    const dh = Math.min(Math.abs(H2 - paperHSL[0]), 360 - Math.abs(H2 - paperHSL[0])) / 180;
    const dist = Math.hypot(dh * 100 * (Math.min(S2, paperHSL[1]) / 40), S2 - paperHSL[1], L2 - paperHSL[2]);
    if (dist < 14) return null;                          // 종이와 사실상 같은 색
    const k = matOfHSL(H2, S2, L2);
    if (!k) return null;
    // 확신도 — 종이에서 멀수록, 채도가 뚜렷할수록 믿는다
    const conf = Math.max(0.3, Math.min(0.9, dist / 60 + Math.min(S2, 50) / 120));
    return { mat: k, conf: +conf.toFixed(2), hsl: [Math.round(H2), Math.round(S2), Math.round(L2)] };
  };

  // ── ★칸 배열·개폐 표시 → 창 종류 ──
  // 값은 cad.js 의 OPENING_TYPES.window 카탈로그를 그대로 쓴다
  // (fix 붙박이 · wswing 여닫이 · wslide 미서기 · hung 오르내리 · shutter · mesh).
  // ★확신도를 함께 낸다. 손그림은 개폐 방식을 아예 안 그리는 경우가 더 많아서
  //   '분할선이 없다'는 붙박이의 증거가 아니라 '안 그렸다'의 증거다. 그걸 붙박이로
  //   자신 있게 내보내면 거짓말이 된다 — conf 0.15 로 낸다.
  // ※들창(위 경첩)·하부회전(아래 경첩)은 카탈로그에 없고, 손그림 해상도에서 상/하 구분이
  //   불안정하다는 판단이라 여닫이(wswing)로 합친다.
  // ※경첩 좌/우는 재긴 하지만 내보내지 않는다 — 꼭짓점이 경첩쪽인지 손잡이쪽인지가
  //   사람마다 반대라 규약을 단정할 수 없다.
  const kindOf = (cols, rows, mark) => {
    if (cols >= 2 && rows >= 2) return ['fix', 0.5];        // 격자(다중 유리) — 붙박이로 본다
    if (cols === 2 && rows === 1) return ['wslide', 0.6];   // 2짝 — 미서기/프렌치/2분할 붙박이가 겹친다
    if (rows === 2 && cols === 1) return ['hung', 0.6];
    if (cols >= 3 || rows >= 3) return ['fix', 0.4];        // 여러 칸 — 창살 붙박이 쪽
    if (mark === 'apexL' || mark === 'apexR' || mark === 'apexT' || mark === 'apexB')
      return ['wswing', 0.8];
    if (mark === 'cross') return ['fix', 0.5];
    if (mark === 'none') return ['fix', 0.15];              // 표시가 없다 = 안 그렸다
    return ['fix', 0];                                      // 모른다
  };
  // 같은 근거를 문 카탈로그로도 매핑한다 — 밑변에 닿은 개구부는 문이 되기 때문이다.
  // (OPENING_TYPES.door: swing 여닫이 · dswing 쌍여닫이 · slide 미서기 · pocket 미닫이
  //  · fold 접이 · dact 자재 · rev 회전)
  // ★창과 같은 모호함이 있다 — '세로 2분할'은 쌍여닫이문일 수도 미서기문일 수도 있다.
  //   출입구는 쌍여닫이가 더 흔하다는 판단으로 그쪽을 택하되 확신도를 낮게 둔다.
  //   회전문(원)·자재문은 사각형 판독으로 잡을 수 없어 대상에서 뺀다.
  const doorKindOf = (cols, rows, mark) => {
    if (cols >= 3 && rows === 1) return ['fold', 0.4];       // 좁은 칸이 여럿 = 접이문
    if (cols === 2 && rows === 1) return ['dswing', 0.5];
    if (mark === 'apexL' || mark === 'apexR' || mark === 'apexT' || mark === 'apexB')
      return ['swing', 0.8];
    return ['swing', 0.15];                                  // 기본값 — 확신하지 않는다
  };
  for (let i = 0; i < massList.length; i++) {
    const rawL = Math.max(0, Math.round(bounds[i] * WK)), rawR = Math.min(Ww - 1, Math.round(bounds[i + 1] * WK));
    let x0 = rawL, x1 = rawR;
    // ★매스 경계는 '골의 한가운데'다 — 떨어져 있는 동에서는 틈의 절반이 매스 구간에 끼어
    //   창이 왼쪽으로 밀린다(실측 u 오차 0.12). 실루엣이 실제로 서 있는 구간으로 좁힌다.
    {
      let hl = 0;
      for (let x = x0; x <= x1; x++) if (Wprof[x] > hl) hl = Wprof[x];
      const thr2 = hl * 0.35;
      let a2 = x0, b2 = x1;
      while (a2 < x1 && Wprof[a2] <= thr2) a2++;
      while (b2 > a2 && Wprof[b2] <= thr2) b2--;
      if (b2 - a2 > 8) { x0 = a2; x1 = b2; }
    }
    const wd = Math.max(1, x1 - x0);
    // ★처마 높이 — 창 높이의 기준자다. 두 번 틀렸으니 근거를 남긴다.
    //   ① 층수 추정이 쓰는 '8% 안쪽' 값을 그대로 쓰면 박공 경사만큼 높게 잡혀 v 가 눌린다
    //      (실측 0.55 → 0.517).
    //   ② 그렇다고 매스 안 최솟값을 쓰면 안 된다 — 실루엣 프로파일은 평활화돼 있어서
    //      바깥 가장자리에서 반쯤 꺼진다. 끝 동이 71px(실제 150)로 잡혀 판독 영역이
    //      아래 절반만 남고 창이 통째로 잘렸다(실측: 3동 중 2동 누락).
    //   → 이웃 박공과 만나는 '골'이 곧 처마선이다. 그 값을 쓰고, 떨어져 있어 골이 바닥까지
    //     내려가면(틈) 국소 최댓값의 35% 문턱으로 걸러 ①로 후퇴한다.
    let hLoc = 0;
    for (let x = x0; x <= x1; x++) if (Wprof[x] > hLoc) hLoc = Wprof[x];
    const e0 = Wprof[Math.max(0, Math.round(x0 + wd * 0.08))];
    const e1 = Wprof[Math.min(Ww - 1, Math.round(x1 - wd * 0.08))];
    const vly = [];
    if (i > 0) vly.push(Wprof[Math.max(0, Math.round(bounds[i] * WK))]);
    if (i < massList.length - 1) vly.push(Wprof[Math.min(Ww - 1, Math.round(bounds[i + 1] * WK))]);
    const vOk = vly.filter(v2 => v2 > hLoc * 0.35);
    const eh = vOk.length ? Math.min.apply(null, vOk) : Math.max(e0, e1);
    if (eh < 10) continue;
    // 재료는 기본 공간(색)에서 읽는다 — 색은 해상도를 타지 않는다.
    const fm = faceMat(Math.round(x0 / WK), Math.round(x1 / WK), eh / WK);
    if (fm) { massList[i].mat = fm.mat; massList[i].matConf = fm.conf; massList[i].matHSL = fm.hsl; }
    const ws = winsOf(x0, x1, eh);
    // ★색으로 못 읽었을 때만 무늬로 읽는다 — 칠했다는 건 의도이므로 색이 더 확실하다.
    //   자(尺)는 '창 높이'다. 실제 창은 1200~1800mm 라 ±25% 안에 들고, 층수 추정처럼
    //   2배로 틀리지 않는다. 창을 못 찾았으면 무늬 판독을 하지 않는다 — 자가 없으면
    //   주기를 재도 의미가 없다.
    if (!fm && ws && ws.length) {
      const hs2 = ws.map(q => q.bh / WK).sort((a2, b2) => a2 - b2);
      const winPx = hs2[hs2.length >> 1];
      if (winPx > 6) {
        const ft = faceTex(Math.round(x0 / WK), Math.round(x1 / WK), eh / WK, 1400 / winPx,
          ws.map(q => ({ cx: q.cx / WK, cy: q.cy / WK, bw: q.bw / WK, bh: q.bh / WK })));
        if (ft) { massList[i].mat = ft.mat; massList[i].matConf = ft.conf; massList[i].matTex = ft.note; }
      }
    }
    if (!ws) continue;
    // ── 밑변 좌표계로 옮겨 정규화 ──
    // ★매스 경계(bounds)는 '지붕 골'에서 잰 값이라 기울기만큼 옆으로 밀려 있다. 그대로 쓰면
    //   기울어진 그림에서 창이 통째로 어긋난다(실측 u 오차 0.18). 골은 처마 높이에서 났으니
    //   ln*eh 만큼 되돌리면 밑변에서의 경계가 된다. 양 끝동의 바깥 경계는 되돌릴 필요 없이
    //   바닥 근처 행을 직접 훑어 잰다(부호별 경우 나누기가 필요 없어진다).
    // ★동별 기울기가 아니라 '무리 전체' 기울기를 쓴다. 붙어 있는 동은 이웃에 가려 자기
    //   모서리를 온전히 못 보여줘서 동별 값이 제각각이다(실측 -0.15 그림에서
    //   -0.08 / -0.49 / +0.06 — 부호까지 틀린다). 바깥 실루엣에서 잰 무리 값은 오차 1도 안쪽이고,
    //   골(경계)을 밀어낸 것도 그림 전체의 전단이므로 기준자로 옳다.
    const ln = leanAvg || 0;
    const shift = ln * eh;
    // 이 매스가 바닥에서 실제로 서 있는 구간. 이웃과 붙어 있으면 바닥이 끝까지 차 있으므로
    // (경계를 못 잰다) 골 위치를 ln*eh 만큼 되돌려 쓴다. 떨어져 있으면 잰 값이 곧 답이다.
    const bs = baseSpan(rawL, rawR) || [rawL, rawR];
    const left = (i === 0) ? clB[0]
      : (bs[0] > rawL + 1 ? bs[0] : Math.round(bounds[i] * WK) - shift);
    const right = (i === massList.length - 1) ? clB[1]
      : (bs[1] < rawR - 1 ? bs[1] : Math.round(bounds[i + 1] * WK) - shift);
    const bwB = right - left;
    if (bwB < 8) continue;
    massList[i].wins = ws.map(q => {
      const bx = q.cx - ln * (WbaseY - q.cy);            // 창 중심을 밑변 높이로 되돌린다
      return {
        u: +Math.min(0.97, Math.max(0.03, (bx - left) / bwB)).toFixed(3),
        v: +Math.min(0.97, Math.max(0.03, (WbaseY - q.cy) / eh)).toFixed(3),
        wFrac: +Math.min(0.6, Math.max(0.03, q.bw / bwB)).toFixed(3),
        hFrac: +Math.min(0.8, Math.max(0.04, q.bh / eh)).toFixed(3),
        cols: q.cols, rows: q.rows, panes: q.panes, mark: q.mark ? q.mark.kind : null,
        kind: kindOf(q.cols, q.rows, q.mark ? q.mark.kind : null)[0],
        kindConf: kindOf(q.cols, q.rows, q.mark ? q.mark.kind : null)[1],
        dkind: doorKindOf(q.cols, q.rows, q.mark ? q.mark.kind : null)[0],
        dkindConf: doorKindOf(q.cols, q.rows, q.mark ? q.mark.kind : null)[1],
      };
    }).sort((a, b) => (a.v - b.v) || (a.u - b.u));
  }

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

  // ── 링(중정) 배치의 동 수: '윤곽을 채운 뒤 연결 성분'으로 센다 ──
  // ★가로 투영(실루엣)은 마당 앞·뒤 동이 같은 열에 겹쳐 하나로 뭉친다(5동이 4동).
  //   각도 히스토그램도 시도했으나 동이 각도상 가까우면 붙거나 갈라져 못 쓴다(1/5 정확).
  //   해법: 테두리에서 배경을 흘려 채워(flood fill) 닿지 않는 곳 = '닫힌 윤곽 안'.
  //   그러면 흰 내부까지 포함한 실루엣이 되고, 떨어진 동은 각각 하나의 덩어리가 된다.
  let ringMasses = 0;
  if (enclosed) {
    const sw = Math.max(8, w >> 1), sh2 = Math.max(8, h >> 1);
    const ink = new Uint8Array(sw * sh2);
    for (let y = by0; y <= by1; y++) { const yy = (y >> 1) * sw;
      for (let x = 0; x < w; x++) if (bldg[y * w + x]) ink[yy + (x >> 1)] = 1; }
    // 배경 흘려 채우기 — 테두리에서 시작, 잉크는 통과 못 한다
    const out2 = new Uint8Array(sw * sh2), st2 = new Int32Array(sw * sh2);
    let top2 = 0;
    for (let x = 0; x < sw; x++) { for (const y of [0, sh2 - 1]) { const p = y * sw + x;
      if (!ink[p] && !out2[p]) { out2[p] = 1; st2[top2++] = p; } } }
    for (let y = 0; y < sh2; y++) { for (const x of [0, sw - 1]) { const p = y * sw + x;
      if (!ink[p] && !out2[p]) { out2[p] = 1; st2[top2++] = p; } } }
    while (top2) {
      const q = st2[--top2], qx = q % sw, qy = (q / sw) | 0;
      if (qx > 0 && !ink[q - 1] && !out2[q - 1]) { out2[q - 1] = 1; st2[top2++] = q - 1; }
      if (qx < sw - 1 && !ink[q + 1] && !out2[q + 1]) { out2[q + 1] = 1; st2[top2++] = q + 1; }
      if (qy > 0 && !ink[q - sw] && !out2[q - sw]) { out2[q - sw] = 1; st2[top2++] = q - sw; }
      if (qy < sh2 - 1 && !ink[q + sw] && !out2[q + sw]) { out2[q + sw] = 1; st2[top2++] = q + sw; }
    }
    const solid = new Uint8Array(sw * sh2);
    for (let p = 0; p < solid.length; p++) solid[p] = (ink[p] || !out2[p]) ? 1 : 0;
    // 연결 성분 — 면적이 충분한 덩어리만
    const seen2 = new Uint8Array(sw * sh2);
    const minA2 = sw * sh2 * 0.006;
    let cnt2 = 0;
    for (let p = 0; p < solid.length; p++) {
      if (!solid[p] || seen2[p]) continue;
      let t3 = 0, area2 = 0; st2[t3++] = p; seen2[p] = 1;
      while (t3) {
        const q = st2[--t3]; area2++;
        const qx = q % sw, qy = (q / sw) | 0;
        if (qx > 0 && solid[q - 1] && !seen2[q - 1]) { seen2[q - 1] = 1; st2[t3++] = q - 1; }
        if (qx < sw - 1 && solid[q + 1] && !seen2[q + 1]) { seen2[q + 1] = 1; st2[t3++] = q + 1; }
        if (qy > 0 && solid[q - sw] && !seen2[q - sw]) { seen2[q - sw] = 1; st2[t3++] = q - sw; }
        if (qy < sh2 - 1 && solid[q + sw] && !seen2[q + sw]) { seen2[q + sw] = 1; st2[t3++] = q + sw; }
      }
      if (area2 >= minA2) cnt2++;
    }
    if (cnt2 >= 2 && cnt2 <= 12) ringMasses = cnt2;
  }

  // 링 배치면 각도 계수를 믿는다 — 실루엣은 앞뒤 겹침 때문에 항상 적게 센다
  let masses2 = masses, massList2 = massList;
  if (ringMasses && ringMasses !== masses) {
    const per = 1 / ringMasses;
    massList2 = Array.from({ length: ringMasses }, () => ({ wFrac: per, hFrac: 1, lean: +leanAvg.toFixed(3) }));
    masses2 = ringMasses;
  }
  // ── ★기권(abstain) 신호 ──
  // 이 판독기는 지금까지 어떤 그림에도 확신에 찬 값을 냈다. 대지·조경 투시를 넣어도
  // "3층 박공 7동이 마당을 두른 단지"라고 답한다 — 유보하는 말이 하나도 없다.
  // ★고칠 것은 임계가 아니라 '출력 계약'이다. 값은 그대로 내되, 스스로 이미 알고 있는
  //   '범위 밖' 신호를 버리지 않고 함께 낸다. 아래 셋은 전부 이미 계산해 둔 값이다.
  const why = [];
  // ① 클램프에 물린 값 = 알고리즘이 스스로 "범위 밖"이라고 말한 것
  const rawFloors = Math.round(eaveRatio / 0.42);
  if (rawFloors > 3) why.push('층수 추정이 범위를 크게 벗어남 (' + rawFloors + '층 → 3층으로 자름)');
  if (clusterLean != null && Math.abs(clusterLean) >= 0.9) why.push('기울기가 상한(42°)에 물림');
  // ② 하늘 여백이 없다 — 건물 스케치는 위에 빈 곳이 있다. 지형·전개도는 종이를 꽉 채운다.
  if (maxH > 0 && maxH / h > 0.9) why.push('그림이 위아래로 꽉 참 (하늘 여백이 없다)');
  // ③ 지면선을 못 찾았다 — baseY 는 '건물 밑단'이 아니라 '맨 아래 잉크 행'으로 후퇴한다.
  //    진짜 지면선이라면 그 행 근처에 폭의 상당 부분을 잇는 가로 잉크가 있어야 한다.
  {
    let run = 0, best = 0;
    for (let y = Math.max(0, baseY - 2); y <= Math.min(h - 1, baseY + 2); y++) {
      run = 0;
      for (let x = 0; x < w; x++) { if (bldg[y * w + x]) { run++; if (run > best) best = run; } else run = 0; }
    }
    if (best < w * 0.18) why.push('지면선을 찾지 못함 (바닥에 이어지는 가로선이 없다)');
  }
  // ④ 마당으로 읽은 초록이 화면 위쪽에 있다 = 중정이 아니라 원경 수목일 수 있다
  if (hasCourt && gcy < h * 0.4) why.push('마당으로 읽은 초록이 화면 위쪽에 있음 (원경 수목일 수 있다)');
  // ⑤ 읽은 것을 버리고 균등 매스로 갈아치웠다
  if (ringMasses && ringMasses !== masses) why.push('링 배치로 판정해 그림에서 읽은 폭·창·재료를 버림');
  // 신뢰도 — 근거 하나당 0.22 씩 깎는다. 두 개면 이미 절반 아래다.
  const conf = +Math.max(0, Math.min(1, 1 - why.length * 0.22)).toFixed(2);
  return {
    masses: masses2, massList: massList2, attached, floors, lean: +leanAvg.toFixed(3), depthRatio, depthConf,
    // 고원 비율이 크면 평지붕. 뾰족한 봉우리라야 박공이다.
    roof: (plateau < 0.42 && maxH > 0 && promAvg / maxH > 0.08) ? 'gable' : 'flat',
    // 앞마당이면 '부채꼴로 늘어서고 마당은 그 앞' — 마당을 빙 두르는 링이 아니다.
    arrange: courtFront ? 'arc' : enclosed ? 'circle' : 'row',
    glass: blueR > 0.008,
    peaks: peaks.map(p => Math.round(p.i)),
    conf, why,               // ★기권 신호 — 값은 내되 확신은 따로 밝힌다

    meta: { w, h, maxH: Math.round(maxH), promAvg: +promAvg.toFixed(1), inkThr,
      greenRatio: +greenR.toFixed(3), blueRatio: +blueR.toFixed(3),
      courtyard: hasCourt, courtFront, enclosed, ringMasses, attached, bTop, bBot, baseY,
      plateau: +plateau.toFixed(2), eaveRatio: +eaveRatio.toFixed(2), comps,
      blocks: blocks.length, block: [by0, by1], blockDbg, sideL, sideR, dbgSide, xa, xb, fa, fb, gcy: Math.round(gcy) },
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
