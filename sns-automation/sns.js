#!/usr/bin/env node
// SNS 수익화 자동화 관리 도구 (Node.js 기본 모듈만 사용)
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const file = (...p) => path.join(ROOT, ...p);
const readJson = (p) => JSON.parse(fs.readFileSync(file(p), "utf8"));
const writeJson = (p, data) => fs.writeFileSync(file(p), JSON.stringify(data, null, 2) + "\n");

const pipelines = readJson("config/pipelines.json");
const subs = readJson("config/subscriptions.json");

function kstNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}
function kstDate(d = kstNow()) {
  return d.toISOString().slice(0, 10);
}
function isoWeek(d = kstNow()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
function slugify(s) {
  return s.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 40);
}
const won = (n) => Math.round(n).toLocaleString("ko-KR") + "원";
const channelName = (id) => (pipelines.channels[id] || { name: id }).name;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
// id 전체 또는 겹치지 않는 앞부분으로 찾기
function findById(rows, id, label) {
  const exact = rows.find((r) => r.id === id);
  if (exact) return exact;
  const hits = rows.filter((r) => r.id.startsWith(id));
  if (hits.length > 1) fail(`${label} id가 여러 개와 겹칩니다. 더 길게 입력하세요:\n  ${hits.map((r) => r.id).join("\n  ")}`);
  return hits[0] || fail(`${label}을(를) 찾을 수 없습니다: ${id}`);
}

// ── cost: 구독료 합계, 겹치는 구독, 손익분기 ─────────────────────
function cost() {
  const rate = subs.usdToKrw;
  const total = subs.items.reduce((s, i) => s + i.monthlyUsd, 0);
  console.log("\n[월 구독료]");
  for (const i of subs.items) {
    const flag = i.verified ? "" : " (금액 확인 필요)";
    console.log(`  ${i.name.padEnd(22)} $${String(i.monthlyUsd).padStart(4)}  ${won(i.monthlyUsd * rate)}${flag}`);
  }
  console.log(`  ${"합계".padEnd(22)} $${String(total).padStart(4)}  ${won(total * rate)}  (환율 ${rate})`);

  const seen = new Set();
  const overlaps = subs.items.filter((i) => i.overlapsWith && !seen.has(i.id) && seen.add(i.overlapsWith));
  if (overlaps.length) {
    console.log("\n[역할이 겹치는 구독]");
    for (const i of overlaps) {
      const o = subs.items.find((x) => x.id === i.overlapsWith);
      console.log(`  ${i.name} ↔ ${o.name}: 하나로 줄이면 월 최대 ${won(Math.min(i.monthlyUsd, o.monthlyUsd) * rate)} 절약`);
    }
  }
  for (const i of subs.items.filter((x) => x.note)) console.log(`  · ${i.name}: ${i.note}`);

  const month = kstDate().slice(0, 7);
  const income = readJson("data/income.json").filter((r) => r.month === month);
  const earned = income.reduce((s, r) => s + r.amountKrw, 0);
  const need = total * rate;
  console.log(`\n[${month} 손익]`);
  console.log(`  수익 ${won(earned)} / 구독료 ${won(need)} → ${earned >= need ? "흑자 " + won(earned - need) : "손익분기까지 " + won(need - earned)}`);
  const bySource = {};
  for (const r of income) bySource[r.source] = (bySource[r.source] || 0) + r.amountKrw;
  for (const [k, v] of Object.entries(bySource)) console.log(`    ${k}: ${won(v)}`);
  console.log("");
}

// ── income: 수익 기록 ───────────────────────────────────────────
function income(source, amount, month = kstDate().slice(0, 7)) {
  if (!source || !amount || isNaN(Number(amount))) fail('사용법: node sns.js income <출처> <금액(원)> [YYYY-MM]\n예: node sns.js income 쿠팡파트너스 32000');
  const rows = readJson("data/income.json");
  rows.push({ month, source, amountKrw: Number(amount), recordedAt: kstDate() });
  writeJson("data/income.json", rows);
  console.log(`기록 완료: ${month} ${source} ${won(Number(amount))}`);
}

// ── new: 본편 콘텐츠 등록 + 파생 작업 자동 생성 ─────────────────
function create(line, title, topic) {
  const p = pipelines.lines[line];
  if (!p || !title) fail(`사용법: node sns.js new <${Object.keys(pipelines.lines).join("|")}> "<제목>"`);
  const rows = readJson("data/contents.json");
  const id = `${kstDate()}-${slugify(title) || "content"}`;
  if (rows.some((r) => r.id === id)) fail(`이미 있는 콘텐츠입니다: ${id}`);
  const tasks = [p.main, ...p.derivatives].map((channel) => ({ channel, status: "todo" }));
  rows.push({ id, line, title, createdAt: kstDate(), week: isoWeek(), tasks });
  writeJson("data/contents.json", rows);

  const dir = file("output", id);
  fs.mkdirSync(dir, { recursive: true });
  const brief = [
    `# ${title}`,
    "",
    `- 라인: ${p.name} (${p.goal})`,
    `- 실행 스킬: /${p.skill}`,
    `- 등록일(KST): ${kstDate()}`,
    ...(topic
      ? [`- 주제 id: ${topic.id}`, `- 기획 근거: ${topic.why || "-"}`, `- 검색어: ${topic.keywords.join(", ") || "-"}`, `- 연결: ${topic.links || "-"}`]
      : []),
    "",
    "## 작업 목록",
    ...tasks.map((t) => `- [ ] ${channelName(t.channel)}`),
    "",
    "## 메타데이터 (스킬이 채움)",
    "- 제목:",
    "- 설명:",
    "- 태그:",
    "- 썸네일 문구:",
    "",
    "## 필수 표기",
    `- ${pipelines.disclosure.ai}`,
    line === "shopping" || line === "blog" ? `- ${pipelines.disclosure.affiliate}` : "",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "brief.md"), brief);
  console.log(`등록 완료: ${id}\n  작업 ${tasks.length}개 생성 → output/${id}/brief.md\n  다음 단계: Claude Code에서 /${p.skill} ${id}`);
  return id;
}

// ── topic: 주제 후보 관리 (PRD 5장) ─────────────────────────────
function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) flags[args[i].slice(2)] = args[++i] ?? "";
    else rest.push(args[i]);
  }
  return { flags, rest };
}
const scoreSum = (t) => (t.score ? t.score.revenue + t.score.ease + t.score.fit : 0);

function topic(sub, ...args) {
  const topics = readJson("data/topics.json");

  if (sub === "add") {
    const { flags, rest } = parseFlags(args);
    const [line, ...titleParts] = rest;
    const title = titleParts.join(" ");
    if (!pipelines.lines[line] || !title)
      fail('사용법: node sns.js topic add <라인> "<제목>" [--why "근거"] [--keywords "a,b"] [--links "연결"] [--score 수익,쉬움,적합]');
    let score;
    if (flags.score) {
      const [revenue, ease, fit] = flags.score.split(",").map(Number);
      if (![revenue, ease, fit].every((n) => n >= 1 && n <= 5)) fail("--score 는 1~5 숫자 3개입니다. 예: --score 4,3,5");
      score = { revenue, ease, fit };
    }
    const id = `t-${kstDate()}-${slugify(title) || "topic"}`;
    if (topics.some((t) => t.id === id)) fail(`이미 있는 주제입니다: ${id}`);
    topics.push({
      id, line, title, status: "proposed", week: isoWeek(), proposedAt: kstDate(),
      why: flags.why || "", keywords: flags.keywords ? flags.keywords.split(",").map((s) => s.trim()) : [],
      links: flags.links || "", score,
    });
    writeJson("data/topics.json", topics);
    return console.log(`후보 추가: ${id}`);
  }

  if (sub === "pick" || sub === "drop") {
    if (!args[0]) fail(`사용법: node sns.js topic ${sub} <id>`);
    const t = findById(topics, args[0], "주제");
    if (t.status !== "proposed") fail(`이미 처리된 주제입니다 (${t.status}): ${t.id}`);
    if (sub === "pick") {
      t.contentId = create(t.line, t.title, t);
    }
    t.status = sub === "pick" ? "used" : "dropped";
    t.decidedAt = kstDate();
    writeJson("data/topics.json", topics);
    return console.log(sub === "pick" ? "주제 → 본편 등록 완료" : `버림: ${t.title}`);
  }

  // list (기본)
  const status = sub === "list" ? args[0] || "proposed" : "proposed";
  const list = topics.filter((t) => status === "all" || t.status === status);
  if (!list.length) return console.log(`${status} 주제가 없습니다. Claude Code에서 /sns-topic-plan 을 실행하세요.`);
  console.log(`\n[주제 ${status}] 점수순`);
  for (const [key, p] of Object.entries(pipelines.lines)) {
    const mine = list.filter((t) => t.line === key).sort((a, b) => scoreSum(b) - scoreSum(a));
    if (!mine.length) continue;
    console.log(`\n  ${p.name}`);
    for (const t of mine) {
      console.log(`    [${scoreSum(t) || "-"}] ${t.title}  (${t.id})`);
      if (t.why) console.log(`         ${t.why}`);
    }
  }
  console.log("\n  승인: node sns.js topic pick <id>   버림: node sns.js topic drop <id>\n");
}

// ── done: 작업 완료 처리 ────────────────────────────────────────
function done(id, channel) {
  const rows = readJson("data/contents.json");
  if (!id) fail("사용법: node sns.js done <id> [채널|all]");
  const row = findById(rows, id, "콘텐츠");
  const targets = channel === "all" ? row.tasks : row.tasks.filter((t) => t.channel === channel);
  if (!targets.length) fail(`작업이 없습니다. 가능한 채널: ${row.tasks.map((t) => t.channel).join(", ")}, all`);
  for (const t of targets) {
    t.status = "done";
    t.doneAt = kstDate();
  }
  writeJson("data/contents.json", rows);
  const left = row.tasks.filter((t) => t.status !== "done").length;
  console.log(`완료: ${row.title} / ${targets.map((t) => channelName(t.channel)).join(", ")} (남은 작업 ${left}개)`);
}

// ── status: 남은 작업 보드 ──────────────────────────────────────
function status() {
  const rows = readJson("data/contents.json");
  const open = rows.filter((r) => r.tasks.some((t) => t.status !== "done"));
  if (!open.length) return console.log("남은 작업이 없습니다. node sns.js plan 으로 이번 주 계획을 확인하세요.");
  const byChannel = {};
  for (const r of open)
    for (const t of r.tasks.filter((t) => t.status !== "done")) (byChannel[t.channel] ||= []).push(r);
  console.log("\n[채널별 남은 작업]");
  for (const [ch, list] of Object.entries(byChannel)) {
    console.log(`\n  ${channelName(ch)} (${list.length}) → /${pipelines.channels[ch].skill}`);
    for (const r of list) console.log(`    - ${r.id}  ${r.title}`);
  }
  console.log("");
}

// ── plan: 이번 주 목표 대비 진행 현황 + 계획 파일 생성 ──────────
function plan() {
  const week = isoWeek();
  const rows = readJson("data/contents.json").filter((r) => r.week === week);
  const lines = [`# ${week} 주간 계획 (생성: ${kstDate()} KST)`, ""];
  const schedule = [
    "| 요일 | 할 일 | 도구 |",
    "|---|---|---|",
    "| 월 | 08:44 루틴이 만든 주제 후보 검토 → `topic pick`으로 본편 등록, 음악 프롬프트·자료 정리 | /sns-topic-plan, Gemini |",
    "| 화 | 음악 플레이리스트 제작 | /sns-music-playlist (Abocado, Suno, Mureka) |",
    "| 수 | 운동 영상 제작 | /sns-workout-video (Higgsfield, Codex) |",
    "| 목 | 쇼핑 쇼츠 제작 | /sns-shopping-shorts (Google Flow) |",
    "| 금 | 블로그 글, 제휴 링크 정리 | /sns-blog-post |",
    "| 매일 | 인스타 → 페이스북 → 스레드 재가공 업로드 | /sns-social-repost |",
    "| 일 | 수익 기록, 구독료 점검, 잘된 콘텐츠 재활용 | `node sns.js income`, `node sns.js cost` |",
  ];
  lines.push("## 본편 목표", "", "| 라인 | 목표 | 등록 | 완료 |", "|---|---|---|---|");
  for (const [key, p] of Object.entries(pipelines.lines)) {
    const mine = rows.filter((r) => r.line === key);
    const finished = mine.filter((r) => r.tasks.every((t) => t.status === "done")).length;
    lines.push(`| ${p.name} | ${p.weeklyTarget} | ${mine.length} | ${finished} |`);
  }
  const proposed = readJson("data/topics.json").filter((t) => t.status === "proposed").length;
  lines.push("", `대기 중인 주제 후보: ${proposed}개 → \`node sns.js topic\`으로 확인, \`topic pick <id>\`로 본편 등록`);
  lines.push("", "## 요일별 루틴", "", ...schedule, "");
  const out = file("plans", `${week}.md`);
  fs.writeFileSync(out, lines.join("\n"));
  console.log(lines.join("\n"));
  console.log(`\n저장: plans/${week}.md`);
}

const [cmd, ...args] = process.argv.slice(2);
const commands = {
  cost,
  income: () => income(...args),
  new: () => create(args[0], args.slice(1).join(" ")),
  done: () => done(args[0], args[1] || "all"),
  status,
  plan,
  topic: () => topic(...args),
};
if (!commands[cmd]) {
  console.log(`SNS 자동화 도구 (흐름은 PRD.md 참고)
  node sns.js topic [list 상태]         주제 후보 보기 (상태: proposed, used, dropped, all)
  node sns.js topic add <라인> "<제목>" --why "근거" --score 4,3,5
  node sns.js topic pick <id>          후보 승인 → 본편 등록
  node sns.js topic drop <id>          후보 버리기
  node sns.js plan                     이번 주 목표·루틴 보기 (plans/에 저장)
  node sns.js new <라인> "<제목>"       본편 등록 + 채널별 파생 작업 자동 생성
                                       라인: ${Object.keys(pipelines.lines).join(", ")}
  node sns.js status                   채널별 남은 작업
  node sns.js done <id> [채널|all]      작업 완료 처리
  node sns.js income <출처> <금액>      수익 기록 (원)
  node sns.js cost                     구독료·손익분기 점검`);
} else {
  commands[cmd]();
}
