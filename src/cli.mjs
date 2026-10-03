#!/usr/bin/env node
// timecard — command-line interface for timecard-engine.
// Zero dependencies: manual argv parsing, plain-text output, --json everywhere.
//
// Exit codes: 0 = ok, 1 = compute error (bad time value etc.), 2 = usage error.
import {
  computeDayMinutes, computePeriod, parseClockTime, parseDuration, toDecimalHours,
  toHHMM, to12h, formatDuration, minutesToMilitary, militaryToMinutes, militaryFull,
  roundPunch, roundTotal, ROUNDING, salaryToHourly, hourlyToSalary,
  fmtMoney, fmtHours,
} from "./engine.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

class UsageError extends Error {}
class ComputeError extends Error {}

// ---------- tiny argv parser ----------

function parseArgs(argv, spec = {}) {
  const o = { _: [] };
  const repeat = new Set(spec.repeat || []);
  const bool = new Set(spec.bool || []);
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === "--") { o._.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith("-")) { o._.push(a); continue; }
    a = a.replace(/^--?/, "");
    let key = a, val;
    const eq = a.indexOf("=");
    if (eq >= 0) { key = a.slice(0, eq); val = a.slice(eq + 1); }
    else if (!bool.has(key) && i + 1 < argv.length && !argv[i + 1].startsWith("--") && argv[i + 1] !== "--") {
      val = argv[++i];
    } else val = true;
    if (repeat.has(key)) (o[key] ??= []).push(val);
    else o[key] = val;
  }
  return o;
}

const ROUND_ALIASES = {
  "none": ROUNDING.NONE,
  "7min": ROUNDING.MINUTE_7,
  "7-minute": ROUNDING.MINUTE_7,
  "15-down": ROUNDING.TRUNCATE_15,
  "truncate-15": ROUNDING.TRUNCATE_15,
  "hundredths": ROUNDING.HUNDREDTHS,
};

function roundingSettings(o) {
  const raw = o.rounding == null ? null : String(o.rounding);
  if (raw == null) return undefined;
  const mode = ROUND_ALIASES[raw.toLowerCase()];
  if (!mode) {
    throw new UsageError(`unknown --rounding "${raw}" (expected: none, 7min, 15-down, hundredths)`);
  }
  const applyTo = o["apply-to"] == null ? (mode === ROUNDING.NONE ? "none" : "total") : String(o["apply-to"]);
  if (!["punches", "total", "both", "none"].includes(applyTo)) {
    throw new UsageError(`unknown --apply-to "${applyTo}" (expected: punches, total, both)`);
  }
  return { mode, applyTo };
}

// ---------- output helpers ----------

const out = (s) => process.stdout.write(s + "\n");
const json = (v) => out(JSON.stringify(v, null, 2));
function kv(label, value) { out(`  ${label.padEnd(16)}${value}`); }

// ---------- commands: day ----------

function buildDayEntry(o) {
  if (o.in == null || o.out == null) {
    throw new UsageError("day requires --in and --out (e.g. --in 8:30am --out 5:15pm)");
  }
  const entry = { in: String(o.in), out: String(o.out) };
  if (o.break != null) entry.breakMinutes = String(o.break);
  const spans = (o["break-span"] || []).map((s) => {
    const parts = String(s).split(/[-–]/);
    if (parts.length !== 2) throw new UsageError(`--break-span expects "12:00-12:45", got "${s}"`);
    return { start: parts[0], end: parts[1] };
  });
  if (spans.length) entry.breaks = spans;
  if (o.rate != null) entry.rate = o.rate;
  if (o.week7) entry.is7thDay = true;
  return entry;
}

function cmdDay(o) {
  const entry = buildDayEntry(o);
  const settings = {};
  const rounding = roundingSettings(o);
  if (rounding) settings.rounding = rounding;
  if (o.jurisdiction != null) settings.jurisdiction = String(o.jurisdiction);
  const r = computeDayMinutes(entry, settings);
  if (!r.ok) {
    throw new ComputeError(`cannot parse times: in="${entry.in}" out="${entry.out}" — try "8:30am", "17:15", "0830" or "24:00" for end of day`);
  }
  const rate = o.rate != null ? Number(String(o.rate).replace(/[$,]/g, "")) : null;
  if (o.json) {
    json({
      in: to12h(r.tIn), out: to12h(r.tOut),
      spanMinutes: r.span, breakMinutes: r.breakMin,
      workedMinutes: r.worked, workedHours: Math.round((r.worked / 60) * 100) / 100,
      ...(rate != null ? { rate, pay: Math.round(((r.worked / 60) * rate) * 100) / 100 } : {}),
      ...(r.rounded !== r.worked ? { roundedMinutes: r.rounded, roundedHours: Math.round((r.rounded / 60) * 100) / 100 } : {}),
    });
    return 0;
  }
  out(`Day summary`);
  kv("Clock in", to12h(r.tIn));
  kv("Clock out", to12h(r.tOut));
  kv("Shift span", formatDuration(r.span));
  kv("Break", formatDuration(r.breakMin));
  kv("Worked", `${fmtHours(r.worked / 60)} h  (${formatDuration(r.worked)})`);
  if (r.rounded !== r.worked) kv("Rounded", `${fmtHours(r.rounded / 60)} h  (${formatDuration(r.rounded)})`);
  if (rate != null) kv("Pay", `${fmtMoney(rate)}/h × ${fmtHours(r.worked / 60)} h = ${fmtMoney((r.worked / 60) * rate)}  (straight time; overtime is a period-level concept — use \`timecard period\`)`);
  return 0;
}

// ---------- commands: period ----------

function parsePeriodLines(text) {
  const days = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(",").map((p) => p.trim());
    if (parts[0].toLowerCase() === "in") continue; // header row
    if (parts.length < 2) throw new ComputeError(`period line needs at least "in,out": "${line}"`);
    const day = { in: parts[0], out: parts[1] };
    if (parts[2] != null && parts[2] !== "") day.breakMinutes = parts[2];
    if (parts[3] != null && parts[3] !== "") day.rate = parts[3];
    days.push(day);
  }
  return days;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function cmdPeriodHelp() {
  return `period — compute a full pay period

Usage:
  timecard period <file> [options]      # JSON or line-format file
  cat sheet.txt | timecard period [options]

Line format (one day per line, # comments allowed):
  in,out[,break][,rate]
  9:00,18:00,60
  8:30am,5:15pm,45m,22.50

JSON format:
  { "days": [ { "in": "8:00", "out": "18:15", "breakMinutes": "0" }, ... ],
    "settings": { "hourlyRate": 20, "jurisdiction": "ca" } }
  See examples/timesheet.json for every accepted field.

Options:
  --rate DOLLARS        default hourly rate (day-level "rate" wins)
  --period NAME         weekly | biweekly | semi-monthly | monthly
  --jurisdiction J      flsa (default) | ca
  --rounding MODE       none | 7min | 15-down | hundredths
  --apply-to TARGET     punches | total | both   (default: total)
  --weekly-threshold H  weekly OT threshold (default 40)
  --json                machine-readable output`;
}

async function cmdPeriod(o) {
  let text, source;
  if (o._.length) {
    const file = o._[0];
    text = await (await import("node:fs/promises")).readFile(file, "utf8");
    source = file;
  } else if (!process.stdin.isTTY) {
    text = await readStdin();
    source = "stdin";
  } else {
    throw new UsageError("period needs a file argument or stdin input\n\n" + cmdPeriodHelp());
  }
  const trimmed = text.trim();
  if (!trimmed) throw new ComputeError(`${source}: empty input`);
  let days, fileSettings = {};
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) days = parsed;
    else { days = parsed.days ?? []; fileSettings = parsed.settings ?? {}; }
    if (!Array.isArray(days)) throw new ComputeError(`${source}: JSON must be { days: [...], settings: {...} }`);
  } else {
    days = parsePeriodLines(trimmed);
  }
  if (!days.length) throw new ComputeError(`${source}: no day rows found`);

  const settings = { ...fileSettings };
  if (o.rate != null) settings.hourlyRate = o.rate;
  if (o.period != null) settings.period = String(o.period);
  if (o.jurisdiction != null) settings.jurisdiction = String(o.jurisdiction);
  if (o["weekly-threshold"] != null) settings.weeklyOtThreshold = o["weekly-threshold"];
  const rounding = roundingSettings(o);
  if (rounding) settings.rounding = rounding;

  const r = computePeriod(days, settings);
  if (o.json) { json(r); return 0; }

  out(`Timesheet — ${days.length} day${days.length === 1 ? "" : "s"} (${source})`);
  out("");
  out(`  #   In        Out       Break    Hours`);
  r.days.forEach((d, i) => {
    const entry = days[i];
    const tIn = entry.in ? to12h(parseClockTime(entry.in, { meridiem: entry.meridiemIn ?? null }) ?? 0) : "—";
    const tOut = entry.out ? to12h(parseClockTime(entry.out, { meridiem: entry.meridiemOut ?? null }) ?? 0) : "—";
    const brk = d.breakMin ? formatDuration(d.breakMin) : "—";
    out(`  ${String(i + 1).padStart(2)}  ${d.ok ? tIn.padEnd(9) : String(entry.in ?? "—").padEnd(9)} ${d.ok ? tOut.padEnd(9) : String(entry.out ?? "—").padEnd(9)} ${brk.padEnd(8)} ${fmtHours(d.hours)}`);
  });
  out("");
  if (r.weeks.length > 1) {
    r.weeks.forEach((w, i) => {
      out(`  Week ${i + 1}: ${fmtHours(w.hours)} h  (reg ${fmtHours(w.reg)}, OT ${fmtHours(w.ot)}, DT ${fmtHours(w.dt)})`);
    });
    out("");
  }
  out(`  Total   ${fmtHours(r.totalHours)} h`);
  out(`  Regular ${fmtHours(r.regHours)} h   OT ${fmtHours(r.otHours)} h   DT ${fmtHours(r.dtHours)} h`);
  const hasRate = settings.hourlyRate != null || days.some((d) => d.rate != null);
  if (hasRate) {
    out("");
    out(`  Regular rate  ${fmtMoney(r.regularRate)}/h (weighted average)`);
    out(`  Base pay      ${fmtMoney(r.basePay)}`);
    if (r.otPay) out(`  OT premium    ${fmtMoney(r.otPay)}  (${fmtHours(r.otHours)} h at 1.5x)`);
    if (r.dtPay) out(`  DT premium    ${fmtMoney(r.dtPay)}  (${fmtHours(r.dtHours)} h at 2x)`);
    out(`  Gross pay     ${fmtMoney(r.grossPay)}`);
  }
  return 0;
}

// ---------- commands: decimal / military / salary / rounding ----------

function cmdDecimal(o) {
  const vals = o._;
  if (!vals.length) throw new UsageError("decimal needs input values, e.g. timecard decimal 8:30 17:15");
  const results = vals.map((v) => {
    if (o.reverse) {
      const n = Number(String(v).replace(/[$,\s]/g, ""));
      if (!Number.isFinite(n)) throw new ComputeError(`not a decimal-hours value: "${v}"`);
      return toHHMM(Math.round(n * 60));
    }
    const asClock = parseClockTime(v);
    if (asClock != null) return toDecimalHours(asClock);
    const asDur = parseDuration(v);
    if (asDur != null) return toDecimalHours(asDur);
    throw new ComputeError(`cannot interpret "${v}" as a clock time or duration`);
  });
  if (o.json) json({ input: vals, decimalHours: results });
  else out(results.map((n) => (typeof n === "number" ? n.toFixed(2) : n)).join("  "));
  return 0;
}

function cmdMilitary(o) {
  const vals = o._;
  if (!vals.length) throw new UsageError("military needs input values, e.g. timecard military 1800 6:00pm");
  const interpret = (v) => {
    const s = String(v).trim().toLowerCase();
    const digits = s.replace(/\D/g, "");
    // pure 3-4 digit input (no ":" or am/pm) = military; "730" means 0730
    if (!/[:ap]/.test(s)) {
      if (/^\d{4}$/.test(digits)) return militaryToMinutes(digits);
      if (/^\d{3}$/.test(digits)) return militaryToMinutes("0" + digits);
    }
    return parseClockTime(s);
  };
  const results = vals.map((v) => {
    const mins = interpret(v);
    if (mins == null) throw new ComputeError(`cannot interpret "${v}" as military or 12-hour time`);
    const f = militaryFull(mins);
    return { military: f.military, hhmm: f.hhmm, h12: f.h12 };
  });
  if (o.json) json(results);
  else results.forEach((f) => out(`${f.military}  =  ${f.hhmm}  =  ${f.h12}`));
  return 0;
}

function cmdSalary(o) {
  const hours = o.hours != null ? Number(o.hours) : 40;
  const weeks = o.weeks != null ? Number(o.weeks) : 52;
  if (o.annual == null && o.hourly == null) {
    throw new UsageError("salary needs --annual DOLLARS or --hourly RATE");
  }
  const result = o.annual != null
    ? { direction: "salary->hourly", ...salaryToHourly(o.annual, hours, weeks) }
    : { direction: "hourly->salary", ...hourlyToSalary(o.hourly, hours, weeks) };
  if (o.json) { json(result); return 0; }
  out(`Salary conversion (${hours} h/week, ${weeks} weeks/year)`);
  if (o.annual != null) {
    kv("Annual", fmtMoney(o.annual));
    kv("Hourly", fmtMoney(result.hourly));
    kv("Weekly", fmtMoney(result.weekly));
    kv("Biweekly", fmtMoney(result.biweekly));
    kv("Monthly", fmtMoney(result.monthly));
  } else {
    kv("Hourly", fmtMoney(o.hourly));
    kv("Annual", fmtMoney(result.annual));
    kv("Weekly", fmtMoney(result.weekly));
    kv("Biweekly", fmtMoney(result.biweekly));
    kv("Monthly", fmtMoney(result.monthly));
  }
  return 0;
}

function cmdRounding(o) {
  if (o.json) {
    const table = {};
    for (let m = 0; m < 60; m++) table[String(m).padStart(2, "0")] = roundPunch(m, ROUNDING.MINUTE_7) % 60;
    json({ rule: "7-minute (nearest 15)", table });
    return 0;
  }
  out("7-minute rounding (nearest 15 minutes) — punch time -> rounded to");
  const groups = [];
  for (let m = 0; m < 60;) {
    const target = roundPunch(m, ROUNDING.MINUTE_7) % 60;
    let end = m;
    while (end + 1 < 60 && roundPunch(end + 1, ROUNDING.MINUTE_7) % 60 === target) end++;
    groups.push({ from: m, to: end, target });
    m = end + 1;
  }
  for (const g of groups) {
    out(`  :${String(g.from).padStart(2, "0")}${g.from !== g.to ? "-:" + String(g.to).padStart(2, "0") : "      "}  ->  :${String(g.target).padStart(2, "0")}`);
  }
  out("");
  out("Also available: 15-down (truncate to quarter hour), hundredths (2-decimal hours).");
  out("Punch rounding is applied before pay arithmetic per 29 CFR 785.48(b).");
  return 0;
}

// ---------- help / main ----------

const MAIN_HELP = `timecard — time card & timesheet calculations (timecard-engine v${version})

Commands:
  day        Compute one work day (hours, breaks, rounding, straight pay)
  period     Compute a full pay period from a JSON/line file or stdin
  decimal    Clock times -> decimal hours (or --reverse for the way back)
  military   12-hour clock <-> military time
  salary     Annual salary <-> hourly wage
  rounding   Show the 7-minute rounding table

Options:
  --json     Machine-readable JSON output
  -h, --help Help for any command
  -v, --version  Print version

Examples:
  timecard day --in 8:30am --out 5:15pm --break 45m --rate 20
  timecard period examples/week.txt --rate 20
  timecard period --jurisdiction ca --json < sheet.json
  timecard decimal 8:30 17:15
  timecard military 1800
  timecard salary --annual 52000

Docs: https://github.com/invoicetariff/timecard-engine
Web calculator: https://timecardcentral.com`;

function helpFor(cmd) {
  if (cmd === "day") {
    return `day — compute one work day

Usage:
  timecard day --in TIME --out TIME [options]

  --in TIME          clock in:  "8:30am", "9:00", "0830", "24:00" = end of day
  --out TIME         clock out (<= in means overnight shift)
  --break DUR        minute deduction: "45m", "1:30", "1.5h", "90"
  --break-span S     break as a span "12:00-12:45" (repeatable)
  --rate DOLLARS     hourly rate for straight-time pay
  --rounding MODE    none | 7min | 15-down | hundredths
  --apply-to TARGET  punches | total | both (default: total)
  --jurisdiction J   flsa | ca
  --week7            treat as 7th consecutive workday (CA rules)
  --json             machine-readable output

Examples:
  timecard day --in 8:30am --out 5:15pm --break 45m --rate 20
  timecard day --in 22:00 --out 06:30 --break 30
  timecard day --in 8:00 --out 18:15 --break 15 --rounding 7min --json`;
  }
  if (cmd === "period") return cmdPeriodHelp();
  if (cmd === "decimal") {
    return `decimal — clock times -> decimal hours

Usage:
  timecard decimal TIME...        # "8:30" -> 8.50, "8h30m" -> 8.50
  timecard decimal --reverse N... # 8.5 -> "08:30"`;
  }
  if (cmd === "military") {
    return `military — 12-hour clock <-> military time

Usage:
  timecard military VALUE...      # 1800 -> "1800 = 18:00 = 6:00 PM"
                                  # 6:00pm -> "1800 = 18:00 = 6:00 PM"`;
  }
  if (cmd === "salary") {
    return `salary — annual salary <-> hourly wage

Usage:
  timecard salary --annual 52000 [--hours 40] [--weeks 52]
  timecard salary --hourly 25 [--hours 40] [--weeks 52]`;
  }
  if (cmd === "rounding") {
    return `rounding — show the 7-minute rounding table

Usage:
  timecard rounding [--json]`;
  }
  return MAIN_HELP;
}

async function main(argv) {
  if (!argv.length || argv[0] === "-h" || argv[0] === "--help") { out(helpFor(argv[1])); return 0; }
  if (argv[0] === "-v" || argv[0] === "--version" || argv[0] === "version") { out(version); return 0; }
  const cmd = argv[0];
  const rest = argv.slice(1);
  if (rest.includes("-h") || rest.includes("--help")) { out(helpFor(cmd)); return 0; }
  switch (cmd) {
    case "day":
      return cmdDay(parseArgs(rest, { repeat: ["break-span"], bool: ["week7", "json"] }));
    case "period":
      return await cmdPeriod(parseArgs(rest, { bool: ["json"] }));
    case "decimal":
      return cmdDecimal(parseArgs(rest, { bool: ["reverse", "json"] }));
    case "military":
      return cmdMilitary(parseArgs(rest, { bool: ["json"] }));
    case "salary":
      return cmdSalary(parseArgs(rest, { bool: ["json"] }));
    case "rounding":
      return cmdRounding(parseArgs(rest, { bool: ["json"] }));
    default:
      throw new UsageError(`unknown command "${cmd}"\n\n` + MAIN_HELP);
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  if (err instanceof UsageError) {
    process.stderr.write(`timecard: ${err.message}\n`);
    process.exitCode = 2;
  } else if (err instanceof ComputeError) {
    process.stderr.write(`timecard: ${err.message}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`timecard: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  }
}
