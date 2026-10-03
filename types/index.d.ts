// Type definitions for timecard-engine.
// The implementation is plain ESM JavaScript; these hand-written types cover
// the full public surface.

export declare const MIN_PER_HOUR: number; // 60
export declare const MIN_PER_DAY: number; // 1440

// ---------- time parsing / formatting ----------

export interface ParseClockTimeOptions {
  /** explicit AM/PM (e.g. from a separate <select>) wins over inline am/pm */
  meridiem?: "am" | "pm" | null;
  /** accept 4-digit "1730" / "0830" forms (default true) */
  allow24?: boolean;
}

/** Parse "8:30", "8:30am", "8a", "12 pm", "20:15", "2015", "8", "24:00" -> minutes since midnight, or null. */
export declare function parseClockTime(raw: unknown, opts?: ParseClockTimeOptions): number | null;

/** minutes since midnight -> "HH:MM" (24h) */
export declare function toHHMM(mins: number): string;

/** minutes since midnight -> "H:MM AM/PM" */
export declare function to12h(mins: number): string;

/** minutes -> decimal hours, rounded to 2 dp */
export declare function toDecimalHours(mins: number): number;

/** "8:30" | 8.5 (hours) | "45m" | "1.5h" -> minutes, or null */
export declare function parseDuration(raw: unknown): number | null;

/** break deduction: "30"=30min, "1:30"=90, "1.5h"=90, "45m"=45 -> minutes, or null */
export declare function parseBreakMinutes(raw: unknown): number | null;

/** minutes -> "1h 30m" (units customizable, negative-safe) */
export declare function formatDuration(mins: number, hUnit?: string, mUnit?: string): string;

// ---------- military time ----------

export declare function minutesToMilitary(mins: number): string; // e.g. "0830"
export declare function militaryToMinutes(str: unknown): number | null;
export interface MilitaryFull {
  military: string; // "1800"
  hhmm: string;     // "18:00"
  h12: string;      // "6:00 PM"
  spoken: string;
}
export declare function militaryFull(mins: number): MilitaryFull;

// ---------- rounding ----------

export declare const ROUNDING: {
  readonly NONE: "none";
  readonly TRUNCATE_15: "15-down";
  readonly MINUTE_7: "7min";
  readonly HUNDREDTHS: "hundredths";
};
export type RoundingMode = "none" | "15-down" | "7min" | "hundredths";
export type RoundingApplyTo = "punches" | "total" | "both" | "none";

/** Round a punch time (minutes since midnight) by mode. "7min" = nearest 15. */
export declare function roundPunch(mins: number, mode: RoundingMode): number;

/** Round a worked-minutes total to a display/billing value. */
export declare function roundTotal(mins: number, mode: RoundingMode): number;

// ---------- day computation ----------

export interface BreakSpan { start: string; end: string }

export interface DayEntry {
  in?: string | null;
  out?: string | null;
  meridiemIn?: "am" | "pm" | null;
  meridiemOut?: "am" | "pm" | null;
  /** one break span (legacy single-span form) */
  breakStart?: string | null;
  breakEnd?: string | null;
  /** minute deduction: 30 | "45m" | "1:30" | "1.5h" */
  breakMinutes?: number | string | null;
  /** multiple break spans */
  breaks?: BreakSpan[];
  /** day-level hourly rate (string "$22.50" accepted) */
  rate?: number | string | null;
  /** CA 7th-consecutive-day flag */
  is7thDay?: boolean;
  /** force workweek assignment (otherwise contiguous 7-day blocks) */
  weekIndex?: number;
}

export interface DayMinutesResult {
  worked: number;
  rounded: number;
  span: number;
  breakMin: number;
  ok: boolean;
  tIn?: number;
  tOut?: number;
}

export interface RoundingSettings {
  mode: RoundingMode;
  applyTo: RoundingApplyTo;
}

export interface DaySettings {
  rounding?: RoundingSettings;
}

/** Worked minutes for one day entry. Breaks are clamped to the work span; overnight crossovers handled. */
export declare function computeDayMinutes(entry: DayEntry, settings?: DaySettings): DayMinutesResult;

// ---------- period / pay computation ----------

export declare const PERIODS: {
  readonly WEEKLY: "weekly";
  readonly BIWEEKLY: "biweekly";
  readonly SEMIMONTHLY: "semi-monthly";
  readonly MONTHLY: "monthly";
};
export type PeriodName = "weekly" | "biweekly" | "semi-monthly" | "monthly";
export type Jurisdiction = "flsa" | "ca";

export interface PeriodSettings {
  period?: PeriodName;
  /** default hourly rate when day.rate missing */
  hourlyRate?: number | string;
  otMultiplier?: number;        // default 1.5
  dtMultiplier?: number;        // default 2
  weeklyOtThreshold?: number;   // default 40 (FLSA)
  dailyOtThreshold?: number | null; // e.g. 8 for CA-style daily OT
  dailyDtThreshold?: number | null;
  jurisdiction?: Jurisdiction;
  rounding?: RoundingSettings;
  /** displayed separately, never merged into the regular rate */
  tips?: number;
}

export interface PeriodDayResult {
  index: number;
  minutes: number;
  hours: number;
  dayRate: number;
  ok: boolean;
  breakMin: number;
}

export interface PeriodWeekResult {
  hours: number;
  reg: number;
  ot: number;
  dt: number;
}

export interface PeriodResult {
  days: PeriodDayResult[];
  weeks: PeriodWeekResult[];
  totalMinutes: number;
  totalHours: number;
  regHours: number;
  otHours: number;
  dtHours: number;
  regularRate: number;
  basePay: number;
  otPay: number;
  dtPay: number;
  grossPay: number;
  tips: number;
}

/**
 * Compute a full timesheet period with FLSA weekly OT (per workweek, never
 * averaged across the period) and optional California / custom daily OT-DT
 * splits, per-workweek weighted-average regular rate (FLSA §7e).
 */
export declare function computePeriod(days: DayEntry[], settings?: PeriodSettings): PeriodResult;

// ---------- overtime split ----------

/** Split one day's worked minutes into regular / 1.5x / 2x hours (CA rules). */
export declare function splitDayCA(workedMin: number, is7thDay?: boolean): { reg: number; ot: number; dt: number };

// ---------- OBBBA estimator ----------

export interface ObbbaResult {
  deduction: number;
  rawDeduction: number;
  capped: boolean;
  cap: number;
  phaseOutWarning: boolean;
  phaseThreshold: number;
}
/** OBBBA "no tax on overtime" deduction estimate (pay/3, capped, MAGI phase-out flagged). Estimates only. */
export declare function obbbaDeduction(qualifiedOtPay: number, filingStatus?: "single" | "mfj", magi?: number): ObbbaResult;

// ---------- tax brackets ----------

export interface TaxBracket { upTo: number | null; rate: number }
/** Ascending marginal-bracket tax. */
export declare function bracketTax(taxable: number, brackets: TaxBracket[]): number;

// ---------- wage helpers ----------

export interface SalaryConversion {
  hourly: number; weekly: number; monthly: number; biweekly: number;
}
export interface HourlyConversion {
  annual: number; monthly: number; weekly: number; biweekly: number;
}
export declare function salaryToHourly(salary: number, hoursPerWeek?: number, weeksPerYear?: number): SalaryConversion;
export declare function hourlyToSalary(hourly: number, hoursPerWeek?: number, weeksPerYear?: number): HourlyConversion;

/** pay for hours × rate × multiplier (time-and-a-half, double time, custom) */
export declare function multiplierPay(hours: number, rate: number, multiplier?: number): number;

export interface RateHours { rate: number; hours: number }
export interface WeightedOvertimeResult {
  totalHours: number;
  straightPay: number;
  regularRate: number;
  otHours: number;
  /** full 1.5x compensation for the OT hours */
  otCompensation: number;
  /** premium-only portion (the extra half) */
  otPremiumOnly: number;
  grossTotal: number;
}
/** FLSA weighted-average regular-rate overtime across multiple rates. */
export declare function weightedOvertime(ratesHours: RateHours[], otHours: number, multiplier?: number): WeightedOvertimeResult;

// ---------- numeric helpers ----------

/** lenient number parse: "$1,234.5" -> 1234.5; falls back to dflt */
export declare function num(v: unknown, dflt?: number): number;
export declare function round2(n: number): number;
export declare function money(n: number): number;
export declare function fmtMoney(n: number, currency?: string): string;
export declare function fmtHours(h: number): string;
