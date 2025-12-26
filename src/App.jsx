import React, { useEffect, useMemo, useRef, useState } from "react";

// Onitama (base game) – implementation web (hotseat + IA)
// Règles (résumé):
// - Plateau 5x5. Chaque joueur: 1 Maître (M) + 4 Élèves (E).
// - 5 cartes Mouvement tirées au hasard parmi 16: 2 pour chaque joueur + 1 carte "neutre".
// - À ton tour: (1) choisis une de tes 2 cartes, (2) bouge 1 de tes pièces selon la carte,
//   capture si tu atterris sur une pièce adverse, (3) échange: ta carte jouée devient la carte neutre
//   (retournée pour l'adversaire), et tu récupères l'ancienne carte neutre.
// - Victoire: capturer le Maître adverse (Way of the Stone) OU amener ton Maître sur l'"arch" adverse (Way of the Stream).
//
// Mouvement des cartes (base 16) : offsets (dx, dy) vus depuis le joueur "Sud" (Player 0).
// dy>0 = vers le Nord (vers l'adversaire). Pour Player 1 on inverse dy.

const CARD_DEFS = {
  Tiger: { stamp: "blue", moves: [[0, 2], [0, -1]] },
  Dragon: { stamp: "red", moves: [[-2, 1], [-1, -1], [1, -1], [2, 1]] },
  Frog: { stamp: "red", moves: [[-2, 0], [-1, 1], [1, -1]] },
  Rabbit: { stamp: "blue", moves: [[2, 0], [1, 1], [-1, -1]] },
  Crab: { stamp: "blue", moves: [[-2, 0], [0, 1], [2, 0]] },
  Elephant: { stamp: "red", moves: [[-1, 0], [-1, 1], [1, 0], [1, 1]] },
  Goose: { stamp: "blue", moves: [[-1, 0], [-1, 1], [1, 0], [1, -1]] },
  Rooster: { stamp: "red", moves: [[-1, 0], [-1, -1], [1, 0], [1, 1]] },
  Monkey: { stamp: "blue", moves: [[-1, 1], [-1, -1], [1, 1], [1, -1]] },
  Mantis: { stamp: "red", moves: [[-1, 1], [0, -1], [1, 1]] },
  Horse: { stamp: "red", moves: [[-1, 0], [0, 1], [0, -1]] },
  Ox: { stamp: "blue", moves: [[1, 0], [0, 1], [0, -1]] },
  Crane: { stamp: "blue", moves: [[0, 1], [-1, -1], [1, -1]] },
  Boar: { stamp: "red", moves: [[-1, 0], [0, 1], [1, 0]] },
  Eel: { stamp: "blue", moves: [[-1, 1], [1, 0], [-1, -1]] },
  Cobra: { stamp: "red", moves: [[1, 1], [-1, 0], [1, -1]] },
};

const ALL_CARDS = Object.keys(CARD_DEFS);

// ---------- Helpers ----------

function shuffle(arr, rng = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function deepCopy(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function keyOfState(s) {
  // Compact-ish key for transposition table
  let b = "";
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      const p = s.board[y][x];
      b += p ? `${p.owner}${p.type}` : ".";
    }
  }
  const c = `${s.hands[0][0]}|${s.hands[0][1]}|${s.mid}|${s.hands[1][0]}|${s.hands[1][1]}|t${s.turn}`;
  return b + "#" + c;
}

function initialBoard() {
  const empty = Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => null));
  const placeRow = (owner, y) => {
    empty[y][0] = { owner, type: "S" };
    empty[y][1] = { owner, type: "S" };
    empty[y][2] = { owner, type: "M" };
    empty[y][3] = { owner, type: "S" };
    empty[y][4] = { owner, type: "S" };
  };
  placeRow(0, 4);
  placeRow(1, 0);
  return empty;
}

function findMaster(board, owner) {
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      const p = board[y][x];
      if (p && p.owner === owner && p.type === "M") return { x, y };
    }
  }
  return null;
}

function countPieces(board) {
  let p0S = 0,
    p0M = 0,
    p1S = 0,
    p1M = 0;
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      const p = board[y][x];
      if (!p) continue;
      if (p.owner === 0) {
        if (p.type === "S") p0S++;
        else p0M++;
      } else {
        if (p.type === "S") p1S++;
        else p1M++;
      }
    }
  }
  return { p0S, p0M, p1S, p1M };
}

function isTerminal(s) {
  const m0 = findMaster(s.board, 0);
  const m1 = findMaster(s.board, 1);
  if (!m0) return { done: true, winner: 1, reason: "Way of the Stone" };
  if (!m1) return { done: true, winner: 0, reason: "Way of the Stone" };
  if (m0.x === 2 && m0.y === 0) return { done: true, winner: 0, reason: "Way of the Stream" };
  if (m1.x === 2 && m1.y === 4) return { done: true, winner: 1, reason: "Way of the Stream" };
  return { done: false };
}

function legalMovesForCard(s, owner, cardName) {
  const def = CARD_DEFS[cardName];
  const moves = [];
  const dir = owner === 0 ? 1 : -1; // flip dy for player 1

  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      const p = s.board[y][x];
      if (!p || p.owner !== owner) continue;
      for (const [dx, dyBase] of def.moves) {
        const dy = dyBase * dir;
        const nx = x + dx;
        const ny = y - dy; // dy>0 means "north" => y decreases
        if (nx < 0 || nx > 4 || ny < 0 || ny > 4) continue;
        const target = s.board[ny][nx];
        if (target && target.owner === owner) continue;
        moves.push({ from: { x, y }, to: { x: nx, y: ny }, card: cardName });
      }
    }
  }
  return moves;
}

function allLegalMoves(s, owner = s.turn) {
  const hand = s.hands[owner];
  const m = [...legalMovesForCard(s, owner, hand[0]), ...legalMovesForCard(s, owner, hand[1])];
  if (m.length === 0) {
    return [
      { pass: true, card: hand[0] },
      { pass: true, card: hand[1] },
    ];
  }
  return m;
}

function applyMove(s, move) {
  const ns = deepCopy(s);
  const owner = ns.turn;
  const used = move.card;

  if (!move.pass) {
    const { from, to } = move;
    const piece = ns.board[from.y][from.x];
    if (!piece || piece.owner !== owner) return null;
    const target = ns.board[to.y][to.x];
    if (target && target.owner === owner) return null;
    ns.board[from.y][from.x] = null;
    ns.board[to.y][to.x] = piece;
  }

  const mid = ns.mid;
  const h = ns.hands[owner];
  const idx = h[0] === used ? 0 : h[1] === used ? 1 : -1;
  if (idx === -1) return null;
  h[idx] = mid;
  ns.mid = used;

  ns.turn = 1 - owner;
  ns.ply += 1;
  return ns;
}

// ---------- AI (minimax + alpha-beta + iterative deepening + TT) ----------

function canCaptureMaster(s, attacker) {
  const defender = 1 - attacker;
  const master = findMaster(s.board, defender);
  if (!master) return true;
  const moves = allLegalMoves(s, attacker).filter((m) => !m.pass);
  return moves.some((m) => m.to.x === master.x && m.to.y === master.y);
}

function evaluate(s, pov /* 0 or 1 */, cfg) {
  const term = isTerminal(s);
  if (term.done) {
    if (term.winner === pov) return 1e9;
    return -1e9;
  }

  const counts = countPieces(s.board);
  const mat0 = counts.p0S * 120 + counts.p0M * 20000;
  const mat1 = counts.p1S * 120 + counts.p1M * 20000;

  const m0 = findMaster(s.board, 0);
  const m1 = findMaster(s.board, 1);
  const d0 = m0 ? Math.abs(m0.x - 2) + Math.abs(m0.y - 0) : 99;
  const d1 = m1 ? Math.abs(m1.x - 2) + Math.abs(m1.y - 4) : 99;

  const w = cfg?.weights || {};
  const mobW = w.mobility ?? 70;
  const centerW = w.center ?? 8;
  const advanceW = w.advance ?? 6;
  const safetyW = w.safety ?? 1200;
  const tempoW = w.tempo ?? 18;
  const archW = w.arch ?? 150;

  const mob0 = cfg?.useMobility ? allLegalMoves(s, 0).filter((m) => !m.pass).length : 0;
  const mob1 = cfg?.useMobility ? allLegalMoves(s, 1).filter((m) => !m.pass).length : 0;

  const centerScore = (owner) => {
    if (!cfg?.useCenter) return 0;
    let sc = 0;
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const p = s.board[y][x];
        if (!p || p.owner !== owner) continue;
        const dist = Math.abs(x - 2) + Math.abs(y - 2);
        sc += (p.type === "M" ? 14 : 6) * (4 - dist);
      }
    }
    return sc;
  };

  const advanceScore = (owner) => {
    if (!cfg?.useAdvancement) return 0;
    let sc = 0;
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const p = s.board[y][x];
        if (!p || p.owner !== owner || p.type !== "S") continue;
        sc += owner === 0 ? 4 - y : y;
      }
    }
    return sc;
  };

  const safetyScore = (owner) => {
    if (!cfg?.useMasterSafety) return 0;
    const opp = 1 - owner;
    let sc = 0;
    if (canCaptureMaster(s, owner)) sc += 1;
    if (canCaptureMaster(s, opp)) sc -= 1;
    return sc;
  };

  const tempoScore = cfg?.useTempo ? (s.turn === 0 ? tempoW : -tempoW) : 0;

  const scoreFor0 =
    mat0 -
    mat1 +
    mobW * (mob0 - mob1) +
    archW * (d1 - d0) +
    centerW * (centerScore(0) - centerScore(1)) +
    advanceW * (advanceScore(0) - advanceScore(1)) +
    safetyW * (safetyScore(0) - safetyScore(1)) +
    tempoScore;
  return pov === 0 ? scoreFor0 : -scoreFor0;
}

function orderMoves(moves, s, hintMove) {
  const term = isTerminal(s);
  if (term.done) return moves;
  const opp = 1 - s.turn;
  const oppMaster = findMaster(s.board, opp);
  const hintKey = hintMove ? `${hintMove.from?.x},${hintMove.from?.y}->${hintMove.to?.x},${hintMove.to?.y}:${hintMove.card || ""}:${hintMove.pass ? "p" : ""}` : null;

  const moveKey = (m) => `${m.from?.x},${m.from?.y}->${m.to?.x},${m.to?.y}:${m.card || ""}:${m.pass ? "p" : ""}`;

  const scoreMove = (m) => {
    if (m.pass) return -1e6;
    const piece = s.board[m.from.y][m.from.x];
    const target = s.board[m.to.y][m.to.x];
    let sc = 0;
    if (hintKey && moveKey(m) === hintKey) sc += 5e6;
    if (target) sc += target.type === "M" ? 500000 : 20000;
    if (piece?.type === "M") sc += 2000;
    if (piece?.type === "M") {
      const goalY = piece.owner === 0 ? 0 : 4;
      const goalX = 2;
      const before = Math.abs(m.from.x - goalX) + Math.abs(m.from.y - goalY);
      const after = Math.abs(m.to.x - goalX) + Math.abs(m.to.y - goalY);
      sc += (before - after) * 500;
    }
    if (oppMaster && m.to.x === oppMaster.x && m.to.y === oppMaster.y) sc += 999999;
    return sc;
  };

  return [...moves].sort((a, b) => scoreMove(b) - scoreMove(a));
}

function makeAI() {
  const tt = new Map();

  function captureMoves(s) {
    return allLegalMoves(s, s.turn).filter((m) => !m.pass && s.board[m.to.y][m.to.x]);
  }

  function qSearch(s, alpha, beta, ai, color, cfg, depthLeft, deadlineMs) {
    if (performance.now() > deadlineMs) return { timedOut: true, score: 0 };

    const standPat = color * evaluate(s, ai, cfg);
    if (standPat >= beta) return { timedOut: false, score: standPat };
    if (alpha < standPat) alpha = standPat;
    if (depthLeft <= 0) return { timedOut: false, score: standPat };

    const caps = captureMoves(s);
    if (caps.length === 0) return { timedOut: false, score: standPat };

    const ordered = orderMoves(caps, s);
    let best = standPat;
    for (const m of ordered) {
      const ns = applyMove(s, m);
      if (!ns) continue;
      const child = qSearch(ns, -beta, -alpha, ai, -color, cfg, depthLeft - 1, deadlineMs);
      if (child.timedOut) return { timedOut: true, score: 0 };
      const score = -child.score;
      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    return { timedOut: false, score: best };
  }

  // negamax "coloré": evaluate(s, ai) est du POV de l'IA, et `color` indique à qui est le tour.
  function alphabeta(s, depth, alpha, beta, ai, color, cfg, deadlineMs) {
    if (performance.now() > deadlineMs) return { timedOut: true, score: 0 };

    const term = isTerminal(s);
    if (term.done || depth === 0) {
      if (cfg?.qDepth && depth === 0) {
        return qSearch(s, alpha, beta, ai, color, cfg, cfg.qDepth, deadlineMs);
      }
      return { timedOut: false, score: color * evaluate(s, ai, cfg) };
    }

    const key = keyOfState(s);
    const entry = tt.get(key);
    if (entry && entry.depth >= depth) {
      if (entry.flag === "EXACT") return { timedOut: false, score: entry.score, pv: entry.best };
      if (entry.flag === "LOWER" && entry.score > alpha) alpha = entry.score;
      else if (entry.flag === "UPPER" && entry.score < beta) beta = entry.score;
      if (alpha >= beta) return { timedOut: false, score: entry.score, pv: entry.best };
    }

    const moves0 = allLegalMoves(s, s.turn);
    const moves = orderMoves(moves0, s, entry?.best);

    let bestMove = null;
    let bestScore = -Infinity;
    const alphaOrig = alpha;

    for (const m of moves) {
      const ns = applyMove(s, m);
      if (!ns) continue;
      const child = alphabeta(ns, depth - 1, -beta, -alpha, ai, -color, cfg, deadlineMs);
      if (child.timedOut) return { timedOut: true, score: 0 };
      const score = -child.score;

      if (score > bestScore) {
        bestScore = score;
        bestMove = m;
      }
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }

    let flag = "EXACT";
    if (bestScore <= alphaOrig) flag = "UPPER";
    else if (bestScore >= beta) flag = "LOWER";

    tt.set(key, { depth, score: bestScore, flag, best: bestMove });
    return { timedOut: false, score: bestScore, pv: bestMove };
  }

  function chooseMove(s, opts) {
    const { maxDepth, timeMs, pov: ai, cfg } = opts;
    const start = performance.now();
    const deadline = start + timeMs;

    let best = null;
    let bestScore = -Infinity;
    const rootColor = s.turn === ai ? 1 : -1;
    const window = cfg?.aspirationWindow ?? 120;

    for (let d = 1; d <= maxDepth; d++) {
      let alpha = -Infinity;
      let beta = Infinity;
      if (cfg?.useAspiration && d > 1 && Number.isFinite(bestScore)) {
        alpha = bestScore - window;
        beta = bestScore + window;
      }

      let res = alphabeta(s, d, alpha, beta, ai, rootColor, cfg, deadline);
      if (res.timedOut) break;
      if (cfg?.useAspiration && (res.score <= alpha || res.score >= beta)) {
        res = alphabeta(s, d, -Infinity, Infinity, ai, rootColor, cfg, deadline);
        if (res.timedOut) break;
      }

      best = res.pv;
      bestScore = res.score;
      if (Math.abs(bestScore) > 5e8) break;
    }

    if (!best) {
      const moves = allLegalMoves(s, s.turn);
      best = moves[0];
    }

    return best;
  }

  return { chooseMove };
}

// ---------- UI ----------

const AI_LEVELS = [
  { maxDepth: 1, timeMs: 60 },
  { maxDepth: 2, timeMs: 120 },
  { maxDepth: 3, timeMs: 200 },
  { maxDepth: 4, timeMs: 350 },
  { maxDepth: 5, timeMs: 550 },
  { maxDepth: 6, timeMs: 900 },
  { maxDepth: 7, timeMs: 2500 },
  { maxDepth: 8, timeMs: 10000 },
];

const WOOD = {
  bg: "#2b2115",
  panel: "#3a2c1e",
  panel2: "#2f2419",
  ink: "#efe6d5",
  ink2: "#c9b89a",
  gold: "#d7b46a",
  red: "#b85a55",
  blue: "#4b6f9e",
  shadow: "rgba(0,0,0,0.35)",
};

const PIECE_COLORS = {
  0: {
    student: { base: "#879b2f", highlight: "#9db243", rim: "#4f5a16" },
    master: { base: "#5f7318", highlight: "#748a28", rim: "#38420d" },
  },
  1: {
    student: { base: "#b76f4f", highlight: "#cb8663", rim: "#6f3f2d" },
    master: { base: "#91412c", highlight: "#a6553c", rim: "#5d2417" },
  },
};

function Piece({ p }) {
  const isP0 = p.owner === 0;
  const isM = p.type === "M";
  const palette = PIECE_COLORS[isP0 ? 0 : 1][isM ? "master" : "student"];
  const size = isM ? "90%" : "64%";
  return (
    <div
      className="piece"
      style={{
        "--piece-size": size,
        background: `linear-gradient(180deg, ${palette.highlight}, ${palette.base})`,
        borderColor: palette.rim,
        boxShadow: `0 10px 18px ${WOOD.shadow}, inset 0 1px 2px rgba(255,255,255,0.08)`,
      }}
      title={isM ? "Maître" : "Élève"}
    >
    </div>
  );
}

function Card({ name, active, onClick, ownerPerspective, compact, disabled }) {
  const def = CARD_DEFS[name];
  const stampColor = def.stamp === "red" ? WOOD.red : WOOD.blue;

  // For ownerPerspective=1 (north) we flip dy in the mini diagram.
  const flip = ownerPerspective === 1 ? -1 : 1;

  const squares = useMemo(() => {
    const set = new Set(def.moves.map(([dx, dy]) => `${2 + dx},${2 - dy * flip}`));
    return set;
  }, [name, ownerPerspective]);

  return (
    <button
      className={`card ${active ? "active" : ""} ${compact ? "compact" : ""}`}
      onClick={onClick}
      disabled={disabled}
      style={{
        borderColor: active ? WOOD.gold : "rgba(255,255,255,0.15)",
        boxShadow: active ? `0 10px 18px ${WOOD.shadow}` : `0 8px 14px ${WOOD.shadow}`,
        transform: active ? "translateY(-2px)" : "translateY(0)",
        opacity: disabled ? 0.5 : 1,
      }}
      title={disabled ? "Non disponible" : name}
    >
      <div className="cardHeader">
        <div className="cardName">{name}</div>
      </div>
      <div className="miniGrid">
        {Array.from({ length: 25 }, (_, i) => {
          const x = i % 5;
          const y = Math.floor(i / 5);
          const isCenter = x === 2 && y === 2;
          const isMove = squares.has(`${x},${y}`);
          return <div key={i} className={`miniCell ${isCenter ? "center" : ""} ${isMove ? "move" : ""}`} />;
        })}
      </div>
    </button>
  );
}

function Badge({ children, tone = "neutral" }) {
  const bg = tone === "gold" ? "rgba(215,180,106,0.15)" : tone === "danger" ? "rgba(184,90,85,0.18)" : "rgba(255,255,255,0.08)";
  const bd = tone === "gold" ? "rgba(215,180,106,0.35)" : tone === "danger" ? "rgba(184,90,85,0.35)" : "rgba(255,255,255,0.16)";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        borderRadius: 999,
        background: bg,
        border: `1px solid ${bd}`,
        color: WOOD.ink,
        fontSize: 12,
        lineHeight: 1,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function App() {
  const aiRef = useRef(null);
  if (!aiRef.current) aiRef.current = makeAI();

  const [mode, setMode] = useState("ai"); // "ai" | "hotseat"
  const [aiSide, setAiSide] = useState(1); // AI plays as 1 (north) by default
  const [aiLevel, setAiLevel] = useState(5);

  const levelParams = useMemo(() => {
    const base = AI_LEVELS[aiLevel - 1] || AI_LEVELS[4];
    const qDepth = aiLevel >= 7 ? 3 : aiLevel >= 6 ? 2 : aiLevel >= 5 ? 2 : aiLevel >= 4 ? 1 : 0;
    return {
      ...base,
      cfg: {
        qDepth,
        useAspiration: aiLevel >= 6,
        aspirationWindow: aiLevel >= 7 ? 90 : 120,
        useMobility: aiLevel >= 2,
        useCenter: aiLevel >= 3,
        useAdvancement: aiLevel >= 4,
        useTempo: aiLevel >= 5,
        useMasterSafety: aiLevel >= 6,
        weights: {
          mobility: 70,
          center: 8,
          advance: 6,
          safety: 1200,
          tempo: 18,
          arch: 150,
        },
      },
    };
  }, [aiLevel]);

  const [state, setState] = useState(() => newGame());
  const [selected, setSelected] = useState(null); // {x,y}
  const [selectedCard, setSelectedCard] = useState(null); // card name
  const [highlights, setHighlights] = useState([]); // [{x,y,move}]
  const [message, setMessage] = useState("");

  function newGame() {
    const chosen = shuffle(ALL_CARDS).slice(0, 5);
    const p0 = [chosen[0], chosen[1]];
    const p1 = [chosen[2], chosen[3]];
    const mid = chosen[4];
    const turn = CARD_DEFS[mid].stamp === "blue" ? 0 : 1;
    return { board: initialBoard(), hands: [p0, p1], mid, turn, ply: 0, history: [] };
  }

  function reset() {
    const ng = newGame();
    setState(ng);
    setSelected(null);
    setSelectedCard(null);
    setHighlights([]);
    setMessage("");
  }

  const term = useMemo(() => isTerminal(state), [state]);

  useEffect(() => {
    if (!selected || !selectedCard) {
      setHighlights([]);
      return;
    }
    const owner = state.turn;
    const moves = legalMovesForCard(state, owner, selectedCard)
      .filter((m) => m.from.x === selected.x && m.from.y === selected.y)
      .map((m) => ({ x: m.to.x, y: m.to.y, move: m }));
    setHighlights(moves);
  }, [selected, selectedCard, state]);

  useEffect(() => {
    if (term.done) return;
    if (mode !== "ai") return;
    if (state.turn !== aiSide) return;

    const t = setTimeout(() => {
      const move = aiRef.current.chooseMove(state, { ...levelParams, pov: aiSide });
      if (!move) return;
      setState((prev) => {
        const ns = applyMove(prev, move);
        if (!ns) return prev;
        ns.history = [...(prev.history || []), { move, by: prev.turn }];
        return ns;
      });
      setSelected(null);
      setSelectedCard(null);
      setHighlights([]);
      setMessage("");
    }, 120);

    return () => clearTimeout(t);
  }, [state, mode, aiSide, levelParams, term.done]);

  function clickCell(x, y) {
    if (term.done) return;
    if (mode === "ai" && state.turn === aiSide) return;

    const p = state.board[y][x];

    const hl = highlights.find((h) => h.x === x && h.y === y);
    if (hl) {
      const move = hl.move;
      setState((prev) => {
        const ns = applyMove(prev, move);
        if (!ns) return prev;
        ns.history = [...(prev.history || []), { move, by: prev.turn }];
        return ns;
      });
      setSelected(null);
      setSelectedCard(null);
      setHighlights([]);
      setMessage("");
      return;
    }

    if (p && p.owner === state.turn) {
      setSelected({ x, y });
      setMessage("");
      return;
    }

    setSelected(null);
    setHighlights([]);
  }

  function clickCard(name) {
    if (term.done) return;
    if (mode === "ai" && state.turn === aiSide) return;
    const hand = state.hands[state.turn];
    if (!hand.includes(name)) return;
    setSelectedCard((cur) => (cur === name ? null : name));
    setMessage("");
  }

  function canPass() {
    const moves = allLegalMoves(state, state.turn);
    return moves.length > 0 && moves.every((m) => m.pass);
  }

  function doPass(chosenCard) {
    if (!canPass()) {
      setMessage("Impossible de passer: tu as au moins un coup légal.");
      return;
    }
    if (!state.hands[state.turn].includes(chosenCard)) return;
    const move = { pass: true, card: chosenCard };
    setState((prev) => {
      const ns = applyMove(prev, move);
      if (!ns) return prev;
      ns.history = [...(prev.history || []), { move, by: prev.turn }];
      return ns;
    });
    setSelected(null);
    setSelectedCard(null);
    setHighlights([]);
    setMessage("");
  }

  const turnName = state.turn === 0 ? "Sud" : "Nord";

  return (
    <div className="root">
      <style>{css}</style>

      <div className="wrap">
        {/* HUD top: Left controls + centered neutral card + right status */}
        <div className="hud">
          <div className="hudLeft">
            <div className="hudTitle">Onitama</div>
            <div className="controls">
              <div className="controlGroup">
                <label>Mode</label>
                <select value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="ai">Contre IA</option>
                  <option value="hotseat">2 joueurs (hotseat)</option>
                </select>
              </div>

              <div className="controlGroup">
                <label>IA</label>
                <select value={aiSide} onChange={(e) => setAiSide(parseInt(e.target.value, 10))} disabled={mode !== "ai"}>
                  <option value={1}>IA = Nord</option>
                  <option value={0}>IA = Sud</option>
                </select>
              </div>

              <div className="controlGroup">
                <label>Niveau IA</label>
                <div className="levelRow">
                  <input
                    type="range"
                    min="1"
                    max="8"
                    step="1"
                    value={aiLevel}
                    onChange={(e) => setAiLevel(parseInt(e.target.value, 10))}
                    disabled={mode !== "ai"}
                  />
                  <div className="levelValue">Niveau {aiLevel}</div>
                </div>
              </div>

              <button className="primary" onClick={reset}>
                Nouvelle partie
              </button>
            </div>
          </div>

          <div className="hudMid">
            <Card name={state.mid} ownerPerspective={state.turn} compact disabled />
          </div>

          <div className="hudRight">
            {term.done ? (
              <div className="hudStatus">
                <Badge tone="gold">Fin</Badge>
                <div className="hudStatusText">
                  {term.winner === 0 ? "Sud" : "Nord"} ({term.reason})
                </div>
              </div>
            ) : (
              <div className="hudStatus">
                <Badge tone="gold">Tour</Badge>
                <div className="hudStatusText">
                  {turnName}
                  {mode === "ai" && state.turn === aiSide ? " (IA…)" : ""}
                </div>
              </div>
            )}
            {message && <div className="hudMsg">{message}</div>}
          </div>
        </div>

        <div className="mainRow">
          {/* North player panel */}
          <div className="sidePanel">
            <div className="sideHeader">
              <div className="sideName">Nord</div>
              <div className="sideBadges">
                {mode === "ai" && aiSide === 1 && <Badge tone="gold">IA</Badge>}
                {state.turn === 1 && !term.done && <Badge tone="gold">Joueur</Badge>}
              </div>
            </div>
            <div className="cardsRow">
              {state.hands[1].map((c) => (
                <Card key={c} name={c} ownerPerspective={1} compact disabled={true} />
              ))}
            </div>
          </div>

          {/* Board */}
          <div className="center">
            <div className="board">
              {Array.from({ length: 25 }, (_, i) => {
                const x = i % 5;
                const y = Math.floor(i / 5);
                const p = state.board[y][x];
                const isSelected = selected && selected.x === x && selected.y === y;
                const isHL = highlights.some((h) => h.x === x && h.y === y);
                const isArch = (x === 2 && y === 4) || (x === 2 && y === 0);

                return (
                  <button
                    key={i}
                    className={`cell ${isSelected ? "sel" : ""} ${isHL ? "hl" : ""} ${isArch ? "arch" : ""}`}
                    onClick={() => clickCell(x, y)}
                    title={isArch ? "Temple Arch" : ""}
                  >
                    {isHL && <div className="hlDot" />}
                    {p && <Piece p={p} />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* South player panel */}
          <div className="sidePanel">
            <div className="sideHeader">
              <div className="sideName">Sud</div>
              <div className="sideBadges">
                {mode === "ai" && aiSide === 0 && <Badge tone="gold">IA</Badge>}
                {state.turn === 0 && !term.done && <Badge tone="gold">Joueur</Badge>}
              </div>
            </div>

            <div className="cardsRow">
              {state.hands[0].map((c) => (
                <Card
                  key={c}
                  name={c}
                  ownerPerspective={0}
                  active={selectedCard === c}
                  compact
                  disabled={term.done || (mode === "ai" && state.turn === aiSide) || state.turn !== 0}
                  onClick={() => clickCard(c)}
                />
              ))}
            </div>

            <div className="passRow">
              <button
                className="ghost"
                onClick={() => selectedCard && doPass(selectedCard)}
                disabled={!selectedCard || !canPass() || term.done || (mode === "ai" && state.turn === aiSide)}
                title={canPass() ? "Passer (seulement si aucun coup légal)" : "Tu as un coup légal"}
              >
                Passer avec la carte sélectionnée
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const css = `
  *{box-sizing:border-box}
  html, body, #root { height: 100%; width: 100%; margin: 0; }
  body { background: radial-gradient(1100px 700px at 40% 0%, #4b3a26, ${WOOD.bg}); }
  .root {
    height: 100vh;
    width: 100%;
    overflow: hidden;
    display: flex;
    justify-content: center;
    background: radial-gradient(1100px 700px at 40% 0%, #4b3a26, ${WOOD.bg});
  }

  .wrap{
    width: 100%;
    max-width: 1200px;
    height: 100vh;
    margin:0 auto;
    padding:12px 12px 12px;
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
    color:${WOOD.ink};
    display:flex;
    flex-direction:column;
    gap:10px;
  }

  /* HUD top: 3 columns */
  .hud{
    display:grid;
    grid-template-columns: minmax(280px, 1fr) auto minmax(280px, 1fr);
    align-items:start;
    gap:12px;
  }
  .hudTitle{font-size:32px;font-weight:900;letter-spacing:0.5px;margin-bottom:6px}
  .controls{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
  .controlGroup{display:flex;flex-direction:column;gap:6px}
  label{font-size:11px;color:${WOOD.ink2}}
  select{background:${WOOD.panel};color:${WOOD.ink};border:1px solid rgba(255,255,255,0.15);border-radius:10px;padding:8px 10px;outline:none}
  .levelRow{display:flex;align-items:center;gap:8px}
  .levelRow input[type="range"]{
    width:160px;
    -webkit-appearance:none;
    appearance:none;
    height:8px;
    border-radius:999px;
    background:linear-gradient(180deg, rgba(215,180,106,0.9), rgba(215,180,106,0.6));
    border:1px solid rgba(215,180,106,0.9);
    box-shadow: inset 0 1px 2px rgba(0,0,0,0.25);
  }
  .levelRow input[type="range"]::-webkit-slider-thumb{
    -webkit-appearance:none;
    appearance:none;
    width:16px;
    height:16px;
    border-radius:50%;
    background:linear-gradient(180deg, ${WOOD.red}, #8a3e3a);
    border:1px solid rgba(0,0,0,0.35);
    box-shadow:0 4px 8px ${WOOD.shadow};
  }
  .levelRow input[type="range"]::-moz-range-track{
    height:8px;
    border-radius:999px;
    background:linear-gradient(180deg, rgba(215,180,106,0.9), rgba(215,180,106,0.6));
    border:1px solid rgba(215,180,106,0.9);
    box-shadow: inset 0 1px 2px rgba(0,0,0,0.25);
  }
  .levelRow input[type="range"]::-moz-range-thumb{
    width:16px;
    height:16px;
    border-radius:50%;
    background:linear-gradient(180deg, ${WOOD.red}, #8a3e3a);
    border:1px solid rgba(0,0,0,0.35);
    box-shadow:0 4px 8px ${WOOD.shadow};
  }
  .levelValue{font-size:12px;color:${WOOD.ink2};min-width:70px}
  button.primary{background:linear-gradient(180deg, rgba(215,180,106,0.9), rgba(215,180,106,0.65));color:#1d160e;border:1px solid rgba(215,180,106,0.9);border-radius:12px;padding:10px 12px;font-weight:800;cursor:pointer;box-shadow:0 10px 18px ${WOOD.shadow}}
  button.primary:active{transform:translateY(1px)}

  .hudMid{display:flex;justify-content:center;align-items:flex-start;padding-top:4px}
  .hudRight{display:flex;flex-direction:column;align-items:flex-end;gap:8px}
  .hudStatus{display:flex;align-items:center;gap:10px}
  .hudStatusText{color:${WOOD.ink};font-weight:800}
  .hudMsg{max-width:360px;color:${WOOD.ink2};font-size:12px;text-align:right}

  /* Main row fills remaining height */
  .mainRow{
    flex: 1;
    min-height: 0;
    display:grid;
    grid-template-columns: minmax(260px, 1fr) minmax(420px, 560px) minmax(260px, 1fr);
    gap:12px;
    align-items:stretch;
  }

  @media (max-width:1200px){
    .root{overflow:auto}
    .wrap{height:auto}
    .mainRow{
      flex: 0 0 auto;
      min-height: auto;
      display:flex;
      flex-direction:column;
    }
    .hud{grid-template-columns:1fr}
    .hudRight{align-items:flex-start}
  }

  .sidePanel{
    background:linear-gradient(180deg, ${WOOD.panel}, ${WOOD.panel2});
    border:1px solid rgba(255,255,255,0.12);
    border-radius:18px;
    padding:14px;
    box-shadow:0 18px 32px ${WOOD.shadow};
    height: auto;
    overflow: visible;
  }
  .sideHeader{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
  .sideName{font-weight:900;letter-spacing:0.3px}
  .sideBadges{display:flex;gap:8px;flex-wrap:wrap}

  .cardsRow{display:flex;gap:10px;flex-wrap:wrap}

  .card{width:clamp(120px, 16vw, 176px);background:linear-gradient(180deg, rgba(224,198,154,0.92), rgba(201,173,128,0.82));border:1px solid rgba(255,255,255,0.14);border-radius:16px;padding:10px;cursor:pointer;color:#2b2115;text-align:left}
  .card.compact{width:clamp(112px, 14vw, 160px)}
  .card:disabled{cursor:not-allowed}
  .cardHeader{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
  .cardName{font-weight:900}
  .miniGrid{display:grid;grid-template-columns:repeat(5, 1fr);gap:2px;background:rgba(0,0,0,0.25);padding:2px;border-radius:10px}
  .miniCell{aspect-ratio:1/1;background:rgba(255,255,255,0.08);border-radius:5px}
  .miniCell.center{background:rgba(0,0,0,0.55)}
  .miniCell.move{background:rgba(215,180,106,0.8)}

  .center{min-height:0;display:flex;flex-direction:column}

  /* Board scales with available height (no scroll on 1080p typical) */
  .board{
    margin: 0 auto;
    width: min(100%, 620px, calc(100vh - 220px));
    aspect-ratio: 1 / 1;
    display:grid;
    grid-template-columns:repeat(5, 1fr);
    gap:8px;
    padding:8px;
    background:rgba(0,0,0,0.25);
    border-radius:18px;
    border:1px solid rgba(255,255,255,0.12);
  }

  @media (max-width:700px){
    .wrap{padding:10px}
    .hudTitle{font-size:26px}
    .board{
      width: min(100%, 480px, calc(100vh - 260px));
    }
  }

  @media (max-width:480px){
    .hudTitle{font-size:22px}
    .board{
      width: min(100%, 360px, calc(100vh - 260px));
    }
  }

  .cell{aspect-ratio:1/1;border-radius:16px;border:1px solid rgba(255,255,255,0.14);background:radial-gradient(140% 140% at 50% 45%, rgba(232,213,182,0.1), rgba(0,0,0,0.16));cursor:pointer;position:relative;display:flex;align-items:center;justify-content:center}
  .cell:hover{border-color:rgba(215,180,106,0.45)}
  .cell.arch{border-color:rgba(215,180,106,0.55);box-shadow: inset 0 0 0 2px rgba(215,180,106,0.12)}
  .cell.sel{outline:2px solid rgba(215,180,106,0.85);outline-offset:2px}
  .cell.hl{border-color:rgba(215,180,106,0.75)}
  .hlDot{position:absolute;inset:auto; width:14px;height:14px;border-radius:999px;background:rgba(215,180,106,0.55);box-shadow:0 10px 20px ${WOOD.shadow}}

  .piece{
    width:var(--piece-size, 60%);
    aspect-ratio:1 / 1;
    border-radius:50%;
    border:2px solid;
    display:flex;
    align-items:center;
    justify-content:center;
    box-shadow:0 10px 18px ${WOOD.shadow}, inset 0 2px 4px rgba(255,255,255,0.12);
  }

  .passRow{margin-top:12px;display:flex;justify-content:flex-start}
  button.ghost{width:clamp(112px, 14vw, 160px);background:rgba(255,255,255,0.06);color:${WOOD.ink};border:1px solid rgba(255,255,255,0.14);border-radius:14px;padding:10px 12px;cursor:pointer}
  button.ghost:disabled{opacity:0.45;cursor:not-allowed}
`;

export default App;
