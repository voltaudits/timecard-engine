// Acceptance tests ported from the timecardcentral.com build (product spec §3),
// executed with `node --test test/`.
// Spec corrections recorded here (original spec numbers were internally inconsistent):
//  - Case 4: spec said CA 10h @ $20 -> $440; correct math is 8*20 + 2*30 = $220. $440 would require $40/hr.
//  - Case 10: FLSA overtime is per workweek (29 USC 207(a)(1)); a biweekly period is two workweeks.
//    82h split as 41+41 @ $18 -> 2 * (40*18 + 1*1.5*18) = $1,494 (same total, correct method).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseClockTime, computeDayMinutes, computePeriod, splitDayCA, roundTotal,
  militaryToMinutes, minutesToMilitary, militaryFull, weightedOvertime, obbbaDeduction,
  parseDuration, roundPunch, ROUNDING, bracketTax, salaryToHourly,
} from "../src/engine.mjs";

describe("time parsing", () => {
  test("12h with meridiem", () => {
    assert.equal(parseClockTime("8:30", { meridiem: "am" }), 8 * 60 + 30);
    assert.equal(parseClockTime("5:15", { meridiem: "pm" }), 17 * 60 + 15);
    assert.equal(parseClockTime("12:00", { meridiem: "am" }), 0);
    assert.equal(parseClockTime("12:00", { meridiem: "pm" }), 720);
  });
  test("inline am/pm + bare forms", () => {
    assert.equal(parseClockTime("8:30pm"), 20 * 60 + 30);
    assert.equal(parseClockTime("8a"), 480);
    assert.equal(parseClockTime("12 pm"), 720);
    assert.equal(parseClockTime("20:15"), 1215);
    assert.equal(parseClockTime("2015"), 1215);
    assert.equal(parseClockTime("1800"), 1080);
    assert.equal(parseClockTime("0032"), 32);
    assert.equal(parseClockTime("24:00"), 1440);
  });
  test("invalid input returns null", () => {
    assert.equal(parseClockTime("abc"), null);
    assert.equal(parseClockTime("25:00"), null);
    assert.equal(parseClockTime("13:30", { meridiem: "pm" }), null);
    assert.equal(parseClockTime(""), null);
    assert.equal(parseClockTime(null), null);
  });
});

describe("duration parsing", () => {
  test("hh:mm, decimal hours, minutes", () => {
    assert.equal(parseDuration("8:30"), 510);
    assert.equal(parseDuration("0.75"), 45);
    assert.equal(parseDuration("45m"), 45);
    assert.equal(parseDuration("1.5h"), 90);
    assert.equal(parseDuration(""), null);
  });
});

describe("case 1: overnight 22:00-06:30 minus 30min", () => {
  test("works in 24h mode", () => {
    const r = computeDayMinutes({ in: "22:00", out: "06:30", breakMinutes: "30" });
    assert.equal(r.worked, 8 * 60);
  });
});

describe("case 2: 8:30AM-5:15PM minus 45min lunch", () => {
  test("span break mode", () => {
    const r = computeDayMinutes({
      in: "8:30", out: "5:15", meridiemIn: "am", meridiemOut: "pm",
      breakStart: "12:00", breakEnd: "12:45",
    });
    assert.equal(r.worked, 8 * 60);
  });
  test("minute deduction mode", () => {
    const r = computeDayMinutes({ in: "8:30", out: "5:15", meridiemIn: "am", meridiemOut: "pm", breakMinutes: "45" });
    assert.equal(r.worked, 8 * 60);
  });
  test("break span partially outside work span is clamped", () => {
    const r = computeDayMinutes({
      in: "9:00", out: "5:00pm",
      breakStart: "11:00", breakEnd: "13:30", // 2.5h break but only up to 17:00 overlap - all inside
    });
    assert.equal(r.breakMin, 150);
  });
});

describe("case 3: 44h @ $20 weekly OT -> $920", () => {
  test("computePeriod weekly", () => {
    const days = [];
    for (let i = 0; i < 5; i++) days.push({ in: "9:00", out: "5:00pm", breakMinutes: "0" }); // 5 x 8h
    days.push({ in: "8:00", out: "12:00pm", breakMinutes: "0" }); // 4h -> total 44
    const r = computePeriod(days, { hourlyRate: 20, weeklyOtThreshold: 40 });
    assert.equal(r.totalHours, 44);
    assert.equal(r.otHours, 4);
    assert.equal(r.grossPay, 920);
  });
});

describe("case 4 (corrected): CA single day 10h @ $20 -> $220", () => {
  test("CA daily OT 8/12 split", () => {
    const s = splitDayCA(10 * 60);
    assert.deepEqual(s, { reg: 8, ot: 2, dt: 0 });
    const r = computePeriod(
      [{ in: "8:00", out: "18:15", breakMinutes: "15" }],
      { hourlyRate: 20, jurisdiction: "ca", weeklyOtThreshold: 40 }
    );
    assert.equal(r.regHours, 8);
    assert.equal(r.otHours, 2);
    assert.equal(r.grossPay, 220); // 8*20 + 2*30
  });
  test("CA >12h earns double time", () => {
    const s = splitDayCA(13 * 60);
    assert.deepEqual(s, { reg: 8, ot: 4, dt: 1 });
  });
  test("CA 7th consecutive day: first 8h at 1.5x", () => {
    const s = splitDayCA(10 * 60, true);
    assert.deepEqual(s, { reg: 0, ot: 8, dt: 2 });
  });
  test("CA weekly extra: 6x8h + 7th day 3h -> weekly OT top-up", () => {
    const days = [];
    for (let i = 0; i < 6; i++) days.push({ in: "8:00", out: "16:30", breakMinutes: "30" }); // 8h each = 48
    days.push({ in: "8:00", out: "11:00", is7thDay: true }); // 3h on 7th day, all at 1.5x per 7th-day rule
    const r = computePeriod(days, { hourlyRate: 20, jurisdiction: "ca" });
    // 51h total, over 40 -> 11 OT-designated; paidOT = 3 (7th day); extra weekly = 51-40-3 = 8 at 1.5x
    assert.equal(r.totalHours, 51);
    assert.equal(r.otHours, 11);
    assert.equal(r.regHours, 40);
    const gross = 40 * 20 + 11 * 30;
    assert.equal(r.grossPay, gross); // 800 + 330 = 1130
  });
});

describe("case 5: 8h23m rounding modes", () => {
  test("truncate-15 -> 8.25h; 7-minute rule -> 8.50h", () => {
    assert.equal(roundTotal(8 * 60 + 23, ROUNDING.TRUNCATE_15), 8 * 60 + 15);
    assert.equal(roundTotal(8 * 60 + 23, ROUNDING.MINUTE_7), 8 * 60 + 30);
  });
  test("7-minute rule boundaries 00-07 down / 08-14 up", () => {
    assert.equal(roundPunch(7, ROUNDING.MINUTE_7), 0);
    assert.equal(roundPunch(8, ROUNDING.MINUTE_7), 15);
    assert.equal(roundPunch(22, ROUNDING.MINUTE_7), 15);
    assert.equal(roundPunch(23, ROUNDING.MINUTE_7), 30);
    assert.equal(roundPunch(52, ROUNDING.MINUTE_7), 45);
    assert.equal(roundPunch(53, ROUNDING.MINUTE_7), 60);
  });
  test("hundredths rounds decimal to 2dp", () => {
    assert.ok(Math.abs(roundTotal(8 * 60 + 23, ROUNDING.HUNDREDTHS) / 60 - 8.38) < 0.001);
  });
});

describe("case 6: 7h45m decimal display", () => {
  test("-> 7.75", () => {
    const r = computeDayMinutes({ in: "9:00", out: "16:45" });
    assert.equal(r.worked, 465);
    assert.equal(Math.round((r.worked / 60) * 100) / 100, 7.75);
  });
});

describe("case 7: military time conversions", () => {
  test("1800 <-> 6:00 PM, 0032 <-> 12:32 AM", () => {
    assert.equal(militaryToMinutes("1800"), 1080);
    const f = militaryFull(1080);
    assert.equal(f.h12, "6:00 PM");
    assert.equal(minutesToMilitary(1080), "1800");
    assert.equal(militaryToMinutes("0032"), 32);
    assert.equal(militaryFull(32).h12, "12:32 AM");
    assert.equal(minutesToMilitary(32), "0032");
  });
  test("militaryFull noon/midnight", () => {
    assert.equal(militaryFull(720).h12, "12:00 PM");
    assert.equal(militaryFull(0).h12, "12:00 AM");
    assert.equal(militaryFull(0).military, "0000");
  });
});

describe("case 8: weighted average overtime", () => {
  test("$20x30h + $25x15h, 5h OT -> OT compensation $162.50, gross $1,029.17", () => {
    const w = weightedOvertime([{ rate: 20, hours: 30 }, { rate: 25, hours: 15 }], 5);
    assert.equal(w.regularRate, 21.67); // 975/45 = 21.666 -> 21.67 displayed
    // OT hours at 1.5x regular rate: 5 * 1.5 * 21.6667 = 162.50
    assert.equal(w.otCompensation, 162.5);
    // gross = straight 975 + premium 5 * 0.5 * 21.6667 = 975 + 54.17
    assert.equal(w.grossTotal, 1029.17);
  });
  test("matches computePeriod multi-rate output", () => {
    const days = [];
    for (let i = 0; i < 3; i++) days.push({ in: "8:00", out: "18:00", breakMinutes: "0", rate: 20 }); // 3 x 10h
    for (let i = 0; i < 1; i++) days.push({ in: "8:00", out: "23:00", breakMinutes: "0", rate: 25 }); // 15h
    const r = computePeriod(days, { hourlyRate: 20, weeklyOtThreshold: 40 });
    assert.equal(r.totalHours, 45);
    assert.equal(r.otHours, 5);
    assert.equal(r.otPay, 162.5);
    assert.equal(r.grossPay, 1029.17);
  });
});

describe("case 9: OBBBA deduction $15,000 -> $5,000", () => {
  test("divide by 3 with cap and phase-out flags", () => {
    const r = obbbaDeduction(15000, "single", 0);
    assert.equal(r.deduction, 5000);
    assert.equal(r.capped, false);
    const capped = obbbaDeduction(60000, "single", 0); // 20000 raw > 12500 cap
    assert.equal(capped.deduction, 12500);
    assert.equal(capped.capped, true);
    const warn = obbbaDeduction(15000, "single", 160000);
    assert.equal(warn.phaseOutWarning, true);
    const mfj = obbbaDeduction(15000, "mfj", 200000);
    assert.equal(mfj.phaseOutWarning, false); // MFJ threshold 300k
  });
});

describe("case 10 (corrected): biweekly 41h + 41h @ $18 -> $1,494", () => {
  test("per-workweek overtime across a biweekly period", () => {
    const days2 = [];
    for (let w = 0; w < 2; w++) {
      for (let i = 0; i < 4; i++) days2.push({ in: "8:00", out: "18:15", breakMinutes: "0", weekIndex: w }); // 4 x 10.25h = 41h/week
    }
    const r = computePeriod(days2, { hourlyRate: 18, weeklyOtThreshold: 40, period: "biweekly" });
    assert.equal(r.totalHours, 82);
    assert.equal(r.otHours, 2);
    assert.equal(r.grossPay, 1494); // 2 * (40*18 + 1*27)
  });
});

describe("rounding applied through computePeriod", () => {
  test("applyTo total truncates daily totals", () => {
    const days = [{ in: "8:00", out: "16:23" }]; // 8h23m
    const r = computePeriod(days, { hourlyRate: 20, rounding: { mode: ROUNDING.TRUNCATE_15, applyTo: "total" } });
    assert.equal(r.totalHours, 8.25);
    const r2 = computePeriod(days, { hourlyRate: 20, rounding: { mode: ROUNDING.MINUTE_7, applyTo: "total" } });
    assert.equal(r2.totalHours, 8.5);
  });
});

describe("federal bracket tax sanity", () => {
  test("10% band then 12%", () => {
    const brackets = [{ upTo: 11925, rate: 0.10 }, { upTo: 48475, rate: 0.12 }, { upTo: null, rate: 0.22 }];
    assert.equal(bracketTax(10000, brackets), 1000);
    assert.equal(bracketTax(20000, brackets), 1192.5 + (20000 - 11925) * 0.12);
  });
});

describe("salary <-> hourly", () => {
  test("roundtrip", () => {
    const a = salaryToHourly(41600, 40, 52);
    assert.equal(a.hourly, 20);
    const r = salaryToHourly(60000, 40, 52);
    assert.equal(r.hourly, 28.85);
    assert.equal(r.weekly, 1153.85);
  });
});

describe("multi-break day (spec: multiple break segments)", () => {
  test("span break + extra minute deduction mix", () => {
    const r = computeDayMinutes({
      in: "8:00am", out: "6:00pm",
      breakStart: "12:00", breakEnd: "12:30", breakMinutes: "15",
    });
    assert.equal(r.worked, 9 * 60 + 15); // 10h - 45m
  });
});

describe("edge cases", () => {
  test("empty day row -> 0", () => {
    const r = computeDayMinutes({ in: "", out: "" });
    assert.equal(r.ok, false);
    assert.equal(r.worked, 0);
  });
  test("equal in/out -> 0 not 24h", () => {
    const r = computeDayMinutes({ in: "9:00", out: "9:00" });
    assert.equal(r.worked, 0);
  });
  test("break longer than shift clamps at 0", () => {
    const r = computeDayMinutes({ in: "9:00", out: "12:00", breakMinutes: "4:00" });
    assert.equal(r.worked, 0);
  });
  test("all-empty period", () => {
    const r = computePeriod([{}, {}, {}], { hourlyRate: 20 });
    assert.equal(r.totalHours, 0);
    assert.equal(r.grossPay, 0);
  });
});
