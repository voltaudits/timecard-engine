// ============================================================
// timecard-engine — Hours & timesheet calculation engine
// Pure ESM, zero dependencies, isomorphic (Node >= 18 + browsers).
// All money math uses cents-safe rounding at presentation time only.
//
// Rule sources:
//  - FLSA weekly overtime (>40h per workweek, 1.5x): 29 U.S.C. §207(a)(1)
//  - Punch-time rounding applied before pay arithmetic: 29 CFR 785.48(b)
//  - Per-workweek weighted-average regular rate: FLSA §7(e)
//  - California daily OT (>8h = 1.5x, >12h = 2x, 7th consecutive day):
//    CA Labor Code §510 / CA DIR DLSE enforcement policies
//  - 7-minute rounding table (00-07→:00, 08-22→:15, 23-37→:30, 38-52→:45,
//    53-59→+1h): standard nearest-15-minute punch rounding
//  - OBBBA "no tax on overtime" deduction (÷3 rule, caps, MAGI phase-out):
//    per IRS 2025 summaries. Estimates only — not tax or legal advice.
// ============================================================

export const MIN_PER_HOUR = 60;
export const MIN_PER_DAY = 24 * 60;

// ---------- time parsing / formatting ----------

/**
 * Parse a clock time string into minutes since midnight (0..1439).
 * Accepted: "8:30", "8:30am", "8:30 AM", "8a", "12 pm", "20:15", "2015", "8", "24:00"->1440 sentinel.
 * @param {string} raw
 * @param {{meridiem?:'am'|'pm'|null, allow24?:boolean}} [opts]
 * @returns {number|null} minutes, or null if unparseable
 */
export function parseClockTime(raw, opts = {}) {
  if (raw == null) return null;
  let s = String(raw).trim().toLowerCase().replace(/\s+/g, "");
  if (!s) return null;
  let meridiem = opts.meridiem ?? null; // explicit AM/PM from a separate select wins
  const m = s.match(/^(\d{1,2})(?::?(\d{2}))?\s*(am|pm|a|p)$/);
  if (m) {
    meridiem = m[3][0] === "a" ? "am" : "pm";
    s = m[1] + (m[2] ? ":" + m[2] : "");
  }
  let h, min;
  const four = s.match(/^(\d{4})$/);
  const hm = s.match(/^(\d{1,2}):(\d{1,2})$/);
  const hOnly = s.match(/^(\d{1,2})$/);
  if (hm) { h = +hm[1]; min = +hm[2]; }
  else if (four && (opts.allow24 !== false)) { h = +four[1].slice(0, 2); min = +four[1].slice(2); }
  else if (hOnly) { h = +hOnly[1]; min = 0; }
  else return null;
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  // 24:00 is a valid "end of day" sentinel
  if (h === 24 && min === 0) return 24 * 60;
  if (h < 0 || h > 24 || min < 0 || min > 59) return null;
  if (h === 24) return null;
  if (meridiem) {
    if (h < 1 || h > 12) return null;
    h = h % 12;
    if (meridiem === "pm") h += 12;
  }
  return h * 60 + min;
}

/** minutes since midnight -> "HH:MM" (24h) */
export function toHHMM(mins) {
  const m = ((Math.round(mins) % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** minutes since midnight -> "H:MM AM/PM" */
export function to12h(mins) {
  const m = ((Math.round(mins) % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY;
  const h24 = Math.floor(m / 60), mm = m % 60;
  const suffix = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${suffix}`;
}

/** minutes -> decimal hours, rounded to 2 dp */
export function toDecimalHours(mins) {
  return Math.round((mins / 60) * 100) / 100;
}

/** "8:30" | 8.5 (hours) | "8h 30m" style duration -> minutes */
export function parseDuration(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  let m = s.match(/^(\d+)\s*(?::|h)?\s*(\d+)?\s*(m)?$/);
  if (m && (m[2] !== undefined || /^(\d+)\s*(m)$/.test(s) || s.includes(":"))) {
    if (/^(\d+)\s*m$/.test(s)) return +RegExp.$1; // "45m"
    if (s.includes(":")) return +m[1] * 60 + +(m[2] || 0); // "8:30"
    if (m[2] !== undefined && m[3]) return +m[1] * 60 + +m[2]; // "8h 30m" written "8 30 m"
    if (m[2] !== undefined) return +m[1] * 60 + +m[2];
    return null;
  }
  const h = s.match(/^(\d+(?:\.\d+)?)\s*h$/);
  if (h) return Math.round(+h[1] * 60);
  const dec = s.match(/^(\d+(?:\.\d+)?)$/);
  if (dec) return Math.round(+dec[1] * 60); // bare number = hours (duration fields)
  return null;
}

/** Break-deduction parsing: bare number = MINUTES ("30"->30m, "90"->1h30m); "1:30"=h:mm; "1.5h"; "45m". */
export function parseBreakMinutes(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (s.includes(":")) { const parts = s.split(":"); return +parts[0] * 60 + (+(parts[1] || 0)); }
  const hm = s.match(/^(\d+(?:\.\d+)?)\s*h$/); if (hm) return Math.round(+hm[1] * 60);
  const mm = s.match(/^(\d+(?:\.\d+)?)\s*m$/); if (mm) return Math.round(+mm[1]);
  const dec = s.match(/^(\d+(?:\.\d+)?)$/); if (dec) return Math.round(+dec[1]);
  return null;
}

export function formatDuration(mins, hUnit = "h", mUnit = "m") {
  const sign = mins < 0 ? "-" : "";
  const a = Math.abs(Math.round(mins));
  return `${sign}${Math.floor(a / 60)}${hUnit} ${String(a % 60).padStart(2, "0")}${mUnit}`;
}

// ---------- military time ----------

export function minutesToMilitary(mins) {
  const m = ((Math.round(mins) % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}${String(m % 60).padStart(2, "0")}`;
}

export function militaryToMinutes(str) {
  const s = String(str).replace(/\D/g, "");
  if (!s) return null;
  if (s.length === 4) return parseClockTime(s.slice(0, 2) + ":" + s.slice(2));
  if (s.length <= 2) return parseClockTime(s, { allow24: true });
  return null;
}

export function militaryFull(mins) {
  const m = ((Math.round(mins) % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY;
  const h = Math.floor(m / 60), mm = m % 60;
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return {
    military: minutesToMilitary(m),
    hhmm: toHHMM(m),
    h12: `${h12}:${String(mm).padStart(2, "0")} ${suffix}`,
    spoken: `${h12} hundred ${mm === 0 ? "hours" : "and " + mm + " minutes"}`,
  };
}

// ---------- rounding ----------

export const ROUNDING = { NONE: "none", TRUNCATE_15: "15-down", MINUTE_7: "7min", HUNDREDTHS: "hundredths" };

/** Round minutes-since-midnight (a punch) by mode. 7-min rule = nearest 15. */
export function roundPunch(mins, mode) {
  if (mode !== ROUNDING.MINUTE_7 && mode !== ROUNDING.TRUNCATE_15) return mins;
  const m = ((Math.round(mins) % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY;
  const block = Math.floor(m / 15);
  const rem = m % 15;
  let out = block * 15;
  if (mode === ROUNDING.MINUTE_7 && rem > 7) out += 15; // 00-07 down, 08-14 up
  return out % MIN_PER_DAY;
}

/** Round a worked-minutes total to a display/billing value. */
export function roundTotal(mins, mode) {
  switch (mode) {
    case ROUNDING.TRUNCATE_15: {
      const neg = mins < 0; const a = Math.abs(mins);
      const r = Math.floor(a / 15) * 15;
      return neg ? -r : r;
    }
    case ROUNDING.MINUTE_7: {
      const neg = mins < 0; const a = Math.abs(mins);
      const block = Math.floor(a / 15), rem = a % 15;
      let r = block * 15 + (rem > 7 ? 15 : 0);
      return neg ? -r : r;
    }
    case ROUNDING.HUNDREDTHS: {
      const neg = mins < 0; const a = Math.abs(mins);
      const r = Math.round((a / 60) * 100) * 0.6; // hours 2dp back to minutes (0.6 min = 0.01h)
      return neg ? -r : r;
    }
    default:
      return mins;
  }
}

// ---------- day computation ----------

/**
 * Worked minutes for one day entry.
 * entry: { in: string, out: string, meridiemIn?, meridiemOut?, breakStart?, breakEnd?, breakMinutes?: number|string, rate?: number }
 * Break spans outside the work span are ignored (clamped); minute deductions always subtract.
 * Crossover: out <= in (+ no explicit meridiem flip evidence) => assume overnight (+24h).
 * A day explicitly marked not worked (in empty) returns 0.
 */
export function computeDayMinutes(entry, settings = {}) {
  let tIn = parseClockTime(entry.in, { meridiem: entry.meridiemIn ?? null });
  let tOut = parseClockTime(entry.out, { meridiem: entry.meridiemOut ?? null });
  if (tIn == null || tOut == null) return { worked: 0, span: 0, breakMin: 0, ok: false };
  const roundMode = settings.rounding?.mode ?? ROUNDING.NONE;
  const applyTo = settings.rounding?.applyTo ?? "none";
  // punch-time rounding (7-minute rule / 15-min truncation) applies to clock in/out
  // and break punches before any arithmetic (29 CFR 785.48(b))
  const punchRound = (roundMode === ROUNDING.MINUTE_7 || roundMode === ROUNDING.TRUNCATE_15) && ["punches", "both"].includes(applyTo);
  if (punchRound) { tIn = roundPunch(tIn, roundMode); tOut = roundPunch(tOut, roundMode); }
  let span = tOut - tIn;
  if (span <= 0) span += MIN_PER_DAY; // overnight shift; equal in/out treated as full 24h is unsafe -> 0
  if (tIn === tOut) span = 0;
  const workSpan = span;
  let breakMin = 0;
  // multiple span breaks: entry.breaks = [{start,end}, ...] (legacy breakStart/breakEnd = one span)
  const spans = Array.isArray(entry.breaks) ? entry.breaks.slice()
    : (entry.breakStart != null && String(entry.breakStart).trim() !== "" && entry.breakEnd != null && String(entry.breakEnd).trim() !== "")
      ? [{ start: entry.breakStart, end: entry.breakEnd }] : [];
  for (const seg of spans) {
    if (seg == null || seg.start == null || seg.end == null) continue;
    if (String(seg.start).trim() === "" || String(seg.end).trim() === "") continue;
    let bIn = parseClockTime(seg.start);
    let bOut = parseClockTime(seg.end);
    if (bIn == null || bOut == null) continue;
    if (punchRound) { bIn = roundPunch(bIn, roundMode); bOut = roundPunch(bOut, roundMode); }
    let bs = bIn, be = bOut;
    if (be <= bs) be += MIN_PER_DAY; // break crossing midnight
    // shift break into same day-frame as the work span
    while (bs < tIn) { bs += MIN_PER_DAY; be += MIN_PER_DAY; }
    const s0 = tIn, e0 = tIn + workSpan;
    const overlap = Math.max(0, Math.min(be, e0) - Math.max(bs, s0));
    breakMin += overlap;
  }
  if (entry.breakMinutes != null && String(entry.breakMinutes).trim() !== "") {
    const bm = parseBreakMinutes(entry.breakMinutes);
    if (bm != null) breakMin += bm;
  }
  let worked = span - breakMin;
  if (worked < 0) worked = 0;
  let roundedWorked = worked;
  if (roundMode === ROUNDING.HUNDREDTHS) {
    roundedWorked = roundTotal(worked, roundMode);
  } else if (applyTo === "total" || applyTo === "both") {
    roundedWorked = roundTotal(worked, roundMode);
  }
  return { worked, rounded: roundedWorked, span, breakMin, ok: true, tIn, tOut };
}

// ---------- overtime split ----------

/**
 * Split one day's worked minutes into regular / 1.5x / 2x buckets.
 * FLSA mode: only weekly threshold applies (handled in computePeriod); per-day splits are all regular.
 * CA mode: >8h -> 1.5x (up to 12h), >12h -> 2x; 7th consecutive day: first 8h at 1.5x, beyond 8h at 2x.
 */
export function splitDayCA(workedMin, is7thDay = false) {
  const h = workedMin / 60;
  let reg = 0, ot = 0, dt = 0;
  if (is7thDay) {
    if (h <= 8) ot = h;
    else { ot = 8; dt = h - 8; }
  } else {
    if (h <= 8) reg = h;
    else if (h <= 12) { reg = 8; ot = h - 8; }
    else { reg = 8; ot = 4; dt = h - 12; }
  }
  return { reg, ot, dt };
}

// ---------- period / pay computation ----------

export const PERIODS = { WEEKLY: "weekly", BIWEEKLY: "biweekly", SEMIMONTHLY: "semi-monthly", MONTHLY: "monthly" };

/**
 * Compute a full timesheet period.
 * days: [{ in, out, meridiemIn?, meridiemOut?, breakStart?, breakEnd?, breakMinutes?, rate?, is7thDay? , weekIndex? }]
 * settings: {
 *   period: 'weekly'|'biweekly'|'semi-monthly'|'monthly',
 *   hourlyRate: number,            // default rate when day.rate missing
 *   otMultiplier: number = 1.5, dtMultiplier: number = 2,
 *   weeklyOtThreshold: number = 40,   // hours per workweek (FLSA default 40)
 *   dailyOtThreshold: number|null = null,   // hours/day before OT (e.g. 8 for CA) - non-CA optional
 *   dailyDtThreshold: number|null = null,   // hours/day before DT
 *   jurisdiction: 'flsa'|'ca',
 *   rounding: { mode, applyTo },
 *   tips: number = 0,              // displayed separately, never merged into regular rate
 * }
 * Weeks are contiguous 7-day blocks from the first day (workweek = the employer's
 * fixed 7-day period; biweekly = 2 workweeks -> overtime per EACH week per FLSA §207(a)(1)).
 */
export function computePeriod(days, settings = {}) {
  const rate = num(settings.hourlyRate, 0);
  const otMult = num(settings.otMultiplier, 1.5);
  const dtMult = num(settings.dtMultiplier, 2);
  const weeklyTh = num(settings.weeklyOtThreshold, 40);
  const dailyOtTh = settings.dailyOtThreshold == null ? null : num(settings.dailyOtThreshold, null);
  const dailyDtTh = settings.dailyDtThreshold == null ? null : num(settings.dailyDtThreshold, null);
  const isCA = settings.jurisdiction === "ca";
  const roundMode = settings.rounding?.mode ?? ROUNDING.NONE;

  const dayResults = days.map((d, i) => {
    const r = computeDayMinutes(d, settings);
    const usedMin = (roundMode === ROUNDING.HUNDREDTHS || ["total", "both"].includes(settings.rounding?.applyTo ?? "none"))
      ? r.rounded : r.worked;
    let hours = usedMin / 60;
    if (roundMode === ROUNDING.NONE || !settings.rounding?.applyTo || settings.rounding.applyTo === "none") {
      if (roundMode === ROUNDING.TRUNCATE_15 || roundMode === ROUNDING.MINUTE_7) {
        // mode set but applyTo defaults: apply to totals (simple, matches Redcort-style expectations)
        hours = roundTotal(usedMin, roundMode) / 60;
      }
    }
    const dayRate = d.rate != null && String(d.rate).trim() !== "" ? num(d.rate, rate) : rate;
    return { index: i, minutes: usedMin, hours: round2(hours), dayRate, ok: r.ok, breakMin: r.breakMin };
  });

  // group into workweeks: explicit day.weekIndex wins (partial weeks / non-7-row sheets),
  // otherwise contiguous 7-day blocks
  const weeks = [];
  dayResults.forEach((dr, i) => {
    const wi = days[i].weekIndex != null ? days[i].weekIndex : Math.floor(i / 7);
    if (wi < 0) return;
    (weeks[wi] ??= { hours: 0, days: [], payStraight: 0 });
    weeks[wi].hours += dr.hours;
    weeks[wi].days.push(dr);
    weeks[wi].payStraight += dr.hours * dr.dayRate;
  });
  const weekList = weeks.filter(Boolean);

  let totalHours = 0, totalStraight = 0, regH = 0, otH = 0, dtH = 0;
  let otPaySum = 0, dtPaySum = 0;
  const weekSummaries = weekList.map((w) => {
    const wHours = round2(w.hours);
    const weekOT = Math.max(0, wHours - weeklyTh); // FLSA weekly OT hours
    let wkReg = wHours - weekOT, wkOt = weekOT, wkDt = 0;
    // daily splits (CA rules or custom daily thresholds), then weekly extra on hours not already OT
    if (isCA || dailyOtTh != null) {
      wkReg = 0; wkOt = 0; wkDt = 0;
      let paidOT = 0;
      w.days.forEach((dr) => {
        if (isCA) {
          const s = splitDayCA(dr.minutes, days[dr.index].is7thDay === true);
          wkReg += s.reg; wkOt += s.ot; wkDt += s.dt;
          paidOT += s.ot + s.dt;
        } else if (dailyOtTh != null) {
          const h = dr.minutes / 60;
          const regPart = Math.min(h, dailyOtTh);
          let otPart = Math.max(0, h - dailyOtTh);
          let dtPart = 0;
          if (dailyDtTh != null) { dtPart = Math.max(0, otPart - (dailyDtTh - dailyOtTh)); otPart -= dtPart; }
          wkReg += regPart; wkOt += otPart; wkDt += dtPart;
          paidOT += otPart + dtPart;
        } else { wkReg += dr.hours; }
      });
      // weekly OT on top: hours over the weekly threshold not already paid at OT rates.
      // Applies to CA (DLSE method) AND to custom daily thresholds — FLSA §207(a)(1)
      // requires weekly OT even when a daily rule is also in force.
      const extra = Math.max(0, wHours - weeklyTh - paidOT);
      if (extra > 0) wkOt += extra, wkReg -= extra;
    }
    // Per-workweek weighted-average regular rate (FLSA §7(e): the regular rate is
    // determined for each workweek, never averaged across the pay period).
    const weekRate = wHours > 0 ? w.payStraight / wHours : 0;
    otPaySum += wkOt * otMult * weekRate;   // full 1.5x compensation for this week's OT hours
    dtPaySum += wkDt * dtMult * weekRate;   // full 2x compensation for this week's DT hours
    totalHours += wHours; totalStraight += w.payStraight;
    regH += round2(wkReg); otH += round2(wkOt); dtH += round2(wkDt);
    return { hours: wHours, reg: round2(wkReg), ot: round2(wkOt), dt: round2(wkDt) };
  });

  const regularRate = totalHours > 0 ? totalStraight / totalHours : 0;
  const otPay = otPaySum;
  const dtPay = dtPaySum;
  const otPremium = otH * (otMult - 1) * regularRate + dtH * (dtMult - 1) * regularRate;
  const basePay = totalStraight;              // all hours at straight rates first
  const gross = basePay + otPremium;

  return {
    days: dayResults,
    weeks: weekSummaries,
    totalMinutes: Math.round(totalHours * 60),
    totalHours: round2(totalHours),
    regHours: round2(regH),
    otHours: round2(otH),
    dtHours: round2(dtH),
    regularRate: round2(regularRate),
    basePay: money(basePay),
    otPay: money(otPay),
    dtPay: money(dtPay),
    grossPay: money(gross),
    tips: num(settings.tips, 0),
  };
}

// ---------- OBBBA no-tax-on-overtime estimator (ESTIMATES ONLY) ----------

/**
 * OBBBA "no tax on overtime" deduction estimate.
 * Method (per IRS summaries gathered in data/serp.md, 2025-09):
 *  - qualified OT compensation = time-and-a-half overtime pay; deduction = that pay / 3
 *    (removes the extra half-time + underlying straight-time portion attributable to OT)
 *  - cap: $12,500 single / $25,000 married filing jointly
 *  - phase-out: reduced when MAGI exceeds $150,000 (single) / $300,000 (MFJ), gone at +$30k? -> we WARN only, do not model
 * Returns { deduction, capped, cap, phaseOutWarning }.
 */
export function obbbaDeduction(qualifiedOtPay, filingStatus = "single", magi = 0) {
  const otPay = Math.max(0, num(qualifiedOtPay, 0));
  const cap = filingStatus === "mfj" ? 25000 : 12500;
  const raw = otPay / 3;
  const deduction = Math.min(raw, cap);
  const phaseThreshold = filingStatus === "mfj" ? 300000 : 150000;
  return {
    deduction: money(deduction),
    rawDeduction: money(raw),
    capped: raw > cap,
    cap,
    phaseOutWarning: magi > phaseThreshold,
    phaseThreshold,
  };
}

export function bracketTax(taxable, brackets) {
  // brackets: [{ upTo: number|null, rate: number }] ascending marginal rates
  let tax = 0, last = 0;
  for (const b of brackets) {
    if (taxable <= last) break;
    const top = b.upTo == null ? Infinity : b.upTo;
    tax += (Math.min(taxable, top) - last) * b.rate;
    last = top;
    if (taxable <= top) break;
  }
  return tax;
}

// ---------- misc wage helpers ----------

export function salaryToHourly(salary, hoursPerWeek = 40, weeksPerYear = 52) {
  const s = num(salary, 0), h = num(hoursPerWeek, 40), w = num(weeksPerYear, 52);
  return { hourly: money(s / (h * w)), weekly: money(s / w), monthly: money(s / 12), biweekly: money(s / w / 2) };
}

export function hourlyToSalary(hourly, hoursPerWeek = 40, weeksPerYear = 52) {
  const r = num(hourly, 0), h = num(hoursPerWeek, 40), w = num(weeksPerYear, 52);
  return { annual: money(r * h * w), monthly: money((r * h * w) / 12), weekly: money(r * h), biweekly: money(r * h * 2) };
}

/** time-and-a-half / double-time / custom multiplier pay for given hours+rate */
export function multiplierPay(hours, rate, multiplier = 1.5) {
  return money(num(hours, 0) * num(rate, 0) * num(multiplier, 1.5));
}

/** weighted average OT demo (acceptance case 8 semantics) */
export function weightedOvertime(ratesHours, otHours, multiplier = 1.5) {
  // ratesHours: [{rate, hours}]
  const totalH = ratesHours.reduce((a, r) => a + num(r.hours, 0), 0);
  const straight = ratesHours.reduce((a, r) => a + num(r.hours, 0) * num(r.rate, 0), 0);
  const regularRate = totalH > 0 ? straight / totalH : 0;
  return {
    totalHours: round2(totalH),
    straightPay: money(straight),
    regularRate: round2(regularRate),
    otHours: num(otHours, 0),
    otCompensation: money(num(otHours, 0) * multiplier * regularRate), // full 1.5x pay for OT hours
    otPremiumOnly: money(num(otHours, 0) * (multiplier - 1) * regularRate),
    grossTotal: money(straight + num(otHours, 0) * (multiplier - 1) * regularRate),
  };
}

// ---------- helpers ----------

export function num(v, dflt = 0) {
  if (v == null || v === "") return dflt;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : dflt;
}
export function round2(n) { return Math.round(n * 100) / 100; }
export function money(n) { return Math.round((num(n) + Number.EPSILON) * 100) / 100; }
export function fmtMoney(n, currency = "$") {
  const v = money(n);
  return `${v < 0 ? "-" : ""}${currency}${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
export function fmtHours(h) { return h.toFixed(2); }
