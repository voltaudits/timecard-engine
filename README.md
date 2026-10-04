# timecard-engine

[![npm version](https://img.shields.io/npm/v/timecard-engine.svg)](https://www.npmjs.com/package/timecard-engine)
[![CI](https://github.com/voltaudits/timecard-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/voltaudits/timecard-engine/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/timecard-engine.svg)](./LICENSE)

Zero-dependency time card & timesheet calculation engine for JavaScript — the
same engine that powers [timecardcentral.com](https://timecardcentral.com).

- **Worked hours** from punch times, with overnight shifts, multiple break
  spans, and break clamping
- **Rounding**: 7-minute rule (nearest 15), 15-minute truncation, hundredths —
  applied to punches and/or totals
- **Overtime**: FLSA weekly OT (per workweek, weighted-average regular rate)
  and California daily OT/DT (8/12 split, 7th-consecutive-day rules)
- **Gross pay**: per-day rates, weekly weighted regular rate, OT/DT premiums
- **Conversions**: decimal hours ⇄ clock time, 12-hour ⇄ military time,
  salary ⇄ hourly
- **Extras**: OBBBA "no tax on overtime" deduction estimator, marginal bracket
  tax, FLSA weighted-overtime breakdown

Pure ESM, no dependencies, runs on Node ≥ 18 and in browsers. Ships a `timecard` CLI.

```bash
npm install timecard-engine
```

## Library usage

### One day: punches, breaks, rounding

```js
import { computeDayMinutes } from "timecard-engine";

const day = computeDayMinutes({
  in: "8:30am",
  out: "5:15pm",
  breakStart: "12:00",
  breakEnd: "12:45",
});
// => { worked: 480, span: 525, breakMin: 45, ok: true, ... }   8h worked

// overnight shift + minute deduction + 7-minute punch rounding
computeDayMinutes(
  { in: "22:00", out: "06:30", breakMinutes: "30" },
  { rounding: { mode: "7min", applyTo: "punches" } }
);
```

### A full pay period: FLSA overtime and gross pay

```js
import { computePeriod } from "timecard-engine";

const days = [
  { in: "9:00", out: "18:00", breakMinutes: "60" }, // Mon 8h
  { in: "9:00", out: "18:00", breakMinutes: "60" }, // ... 5 x 8h
  { in: "9:00", out: "18:00", breakMinutes: "60" },
  { in: "9:00", out: "18:00", breakMinutes: "60" },
  { in: "9:00", out: "18:00", breakMinutes: "60" },
  { in: "8:00", out: "12:00", breakMinutes: "0" },  // Sat 4h  -> 44h week
];

const r = computePeriod(days, { hourlyRate: 20 });
// r.totalHours = 44   r.otHours = 4
// r.regularRate = 20  r.basePay = 880  r.otPay = 120  r.grossPay = 920
```

FLSA semantics are modeled properly:

- overtime accrues **per workweek** (a biweekly period is two workweeks —
  29 U.S.C. §207(a)(1)), never averaged across the period;
- day-level rates feed a **weighted-average regular rate per workweek**
  (FLSA §7(e));
- punch rounding happens **before** pay arithmetic (29 CFR 785.48(b)).

### California overtime (or custom daily thresholds)

```js
import { computePeriod } from "timecard-engine";

const r = computePeriod(
  [{ in: "8:00", out: "18:15", breakMinutes: "15" }],
  { hourlyRate: 20, jurisdiction: "ca" }
);
// 10h day -> r.regHours 8, r.otHours 2, r.grossPay 220  (8×$20 + 2×$30)
```

CA rules (>8h = 1.5×, >12h = 2×, 7th consecutive day) plus the weekly-OT
top-up on top of daily OT, per DLSE methodology. Non-CA employers can pass
`dailyOtThreshold` / `dailyDtThreshold` instead.

### Conversions & helpers

```js
import {
  toDecimalHours, parseClockTime, militaryFull, salaryToHourly,
  hourlyToSalary, weightedOvertime, obbbaDeduction,
} from "timecard-engine";

toDecimalHours(parseClockTime("7:45"));          // 7.75
militaryFull(parseClockTime("18:00"));           // { military: "1800", hhmm: "18:00", h12: "6:00 PM", ... }
salaryToHourly(52000);                           // { hourly: 25, weekly: 1000, ... }
hourlyToSalary(25);                              // { annual: 52000, ... }
weightedOvertime([{ rate: 20, hours: 30 }, { rate: 25, hours: 15 }], 5);
// { regularRate: 21.67, otCompensation: 162.5, grossTotal: 1029.17, ... }
obbbaDeduction(15000, "single");                 // { deduction: 5000, capped: false, ... }
```

All money-returning functions round to cents; all parsers accept `number`
minutes, `"HH:MM"`, `"H:MM am/pm"`, `"HHMM"`, and lenient money strings like
`"$1,234.50"`.

## CLI

```bash
npm install -g timecard-engine
```

| Command | What it does |
| --- | --- |
| `timecard day` | one work day: punches, breaks, rounding, straight-time pay |
| `timecard period` | a full pay period from a JSON or line-format file / stdin |
| `timecard decimal` | clock times → decimal hours (`--reverse` for the way back) |
| `timecard military` | 12-hour clock ⇄ military time |
| `timecard salary` | annual salary ⇄ hourly wage |
| `timecard rounding` | print the 7-minute rounding table |

Every command takes `--json` for machine-readable output.

```console
$ timecard day --in 8:30am --out 5:15pm --break 45m --rate 20
Day summary
  Clock in        8:30 AM
  Clock out       5:15 PM
  Shift span      8h 45m
  Break           0h 45m
  Worked          8.00 h  (8h 00m)
  Pay             $20.00/h × 8.00 h = $160.00

$ timecard period examples/week.txt --rate 20
Timesheet — 6 days (examples/week.txt)
  ...
  Total   44.00 h
  Regular 40.00 h   OT 4.00 h   DT 0.00 h
  Gross pay     $920.00

$ timecard decimal 8:30 17:15
8.50  17.25

$ timecard military 1800 6:00pm
1800  =  18:00  =  6:00 PM
1800  =  18:00  =  6:00 PM
```

`timecard period` accepts a plain line format — one day per line,
`in,out[,break][,rate]`:

```text
9:00,18:00,60
9:00,18:00,60
8:30am,5:15pm,45m,22.50
```

…or full JSON (`examples/timesheet.json` documents every accepted field):

```json
{
  "days": [{ "in": "8:00", "out": "18:15", "breakMinutes": "0", "rate": 20 }],
  "settings": { "hourlyRate": 20, "jurisdiction": "ca", "period": "weekly" }
}
```

Day fields: `in`, `out`, `meridiemIn`, `meridiemOut`, `breakMinutes`,
`breakStart`/`breakEnd` or `breaks: [{start,end}]`, `rate`, `is7thDay` (CA),
`weekIndex` (force workweek assignment). Settings: `hourlyRate`, `period`
(`weekly`/`biweekly`/`semi-monthly`/`monthly`), `weeklyOtThreshold` (default
40), `dailyOtThreshold`, `dailyDtThreshold`, `jurisdiction` (`flsa`/`ca`),
`otMultiplier` (1.5), `dtMultiplier` (2), `rounding: { mode, applyTo }`, `tips`.

## Rounding modes

| Mode | Punches | Totals | Notes |
| --- | --- | --- | --- |
| `none` | as punched | exact minutes | default |
| `7min` | nearest 15 min (:00–:07 down, :08–:22 → :15, …) | nearest 15 min | the classic "7-minute rule" |
| `15-down` | truncate to quarter hour | truncate | employer-friendly variant |
| `hundredths` | unchanged | 2-decimal hours | e.g. 8h23m → 8.38 h |

`applyTo` controls scope: `punches`, `total`, or `both`. Rounding is applied
to punches before any duration math (29 CFR 785.48(b)); totals-rounding is
applied after.

## Rule provenance

Calculation rules trace to primary sources, not guesswork:

- FLSA weekly overtime — 29 U.S.C. §207(a)(1)
- Per-workweek weighted-average regular rate — FLSA §7(e)
- Punch-time rounding before pay arithmetic — 29 CFR 785.48(b)
- California daily OT/DT and 7th-day rules — CA Labor Code §510, CA DIR DLSE
  enforcement policies
- 7-minute rounding table — standard nearest-15-minute punch rounding
- OBBBA overtime deduction (÷3, caps, MAGI phase-out) — IRS 2025 summaries

**Disclaimer:** estimates for informational use only — not legal, tax, or
payroll advice. Compliance depends on your jurisdiction, agreements, and
facts; consult a professional for decisions that matter.

## Development

```bash
npm test    # 53 tests: acceptance cases + CLI integration, zero dependencies to install
```

## Used in production at

[TimeCard Central](https://timecardcentral.com) — free browser-based time card
calculators (time card, hours, decimal hours, military time, overtime,
timesheet templates).

## License

[MIT](./LICENSE)
