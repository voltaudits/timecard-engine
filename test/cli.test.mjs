// CLI integration tests: spawn src/cli.mjs as a child process.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const EXAMPLES = path.dirname(fileURLToPath(new URL("../examples/week.txt", import.meta.url)));

function run(args, input) {
  return spawnSync(process.execPath, [CLI, ...args], { input, encoding: "utf8" });
}

describe("timecard day", () => {
  test("basic day with break and pay", () => {
    const r = run(["day", "--in", "8:30am", "--out", "5:15pm", "--break", "45m", "--rate", "20", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.workedHours, 8);
    assert.equal(j.pay, 160);
    assert.equal(j.in, "8:30 AM");
    assert.equal(j.out, "5:15 PM");
  });
  test("overnight shift", () => {
    const r = run(["day", "--in", "22:00", "--out", "06:30", "--break", "30", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.workedHours, 8);
  });
  test("7-minute rounding applied to total", () => {
    const r = run(["day", "--in", "8:00", "--out", "16:23", "--rounding", "7min", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.roundedHours, 8.5);
  });
  test("break-span repeatable", () => {
    const r = run(["day", "--in", "8:00", "--out", "18:00", "--break-span", "10:00-10:15", "--break-span", "12:00-12:45", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).workedHours, 9);
  });
  test("invalid time -> exit 1 with message", () => {
    const r = run(["day", "--in", "abc", "--out", "5pm"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot parse times/);
  });
  test("missing --out -> usage exit 2", () => {
    const r = run(["day", "--in", "9:00"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /requires --in and --out/);
  });
});

describe("timecard period", () => {
  test("line-format file, 44h week -> $920 (FLSA)", () => {
    const r = run(["period", path.join(EXAMPLES, "week.txt"), "--rate", "20"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Total\s+44\.00 h/);
    assert.match(r.stdout, /Gross pay\s+\$920\.00/);
  });
  test("line format via stdin", () => {
    const r = run(["period", "--rate", "20"], "9:00,18:00,60\n9:00,18:00,60\n8:00,12:00,0\n");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Total\s+20\.00 h/);
  });
  test("JSON with CA jurisdiction -> $220", () => {
    const payload = JSON.stringify({
      days: [{ in: "8:00", out: "18:15", breakMinutes: "15" }],
      settings: { hourlyRate: 20, jurisdiction: "ca" },
    });
    const r = run(["period", "--json"], payload);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.grossPay, 220);
    assert.equal(j.otHours, 2);
  });
  test("JSON array input also accepted", () => {
    const payload = JSON.stringify([{ in: "9:00", out: "17:00" }]);
    const r = run(["period", "--json"], payload);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).totalHours, 8);
  });
});

describe("timecard decimal", () => {
  test("times to decimal hours", () => {
    const r = run(["decimal", "8:30", "17:15"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "8.50  17.25");
  });
  test("duration form", () => {
    const r = run(["decimal", "8h30m"]);
    assert.equal(r.stdout.trim(), "8.50");
  });
  test("reverse: decimal to HH:MM", () => {
    const r = run(["decimal", "--reverse", "8.5", "7.75"]);
    assert.equal(r.stdout.trim(), "08:30  07:45");
  });
});

describe("timecard military", () => {
  test("military input", () => {
    const r = run(["military", "1800"]);
    assert.match(r.stdout, /1800  =  18:00  =  6:00 PM/);
  });
  test("12h input", () => {
    const r = run(["military", "6:00pm"]);
    assert.match(r.stdout, /^1800/);
  });
  test("json output", () => {
    const r = run(["military", "0032", "--json"]);
    const j = JSON.parse(r.stdout);
    assert.equal(j[0].military, "0032");
    assert.equal(j[0].h12, "12:32 AM");
  });
});

describe("timecard salary", () => {
  test("annual to hourly", () => {
    const r = run(["salary", "--annual", "41600", "--json"]);
    assert.equal(JSON.parse(r.stdout).hourly, 20);
  });
  test("hourly to annual", () => {
    const r = run(["salary", "--hourly", "25", "--json"]);
    assert.equal(JSON.parse(r.stdout).annual, 52000);
  });
});

describe("timecard rounding", () => {
  test("table includes 7-minute boundaries", () => {
    const r = run(["rounding"]);
    assert.match(r.stdout, /:00-:07\s+->  :00/);
    assert.match(r.stdout, /:08-:22\s+->  :15/);
    assert.match(r.stdout, /:53-:59\s+->  :00/);
  });
});

describe("timecard meta", () => {
  test("--version", () => {
    const r = run(["--version"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^\d+\.\d+\.\d+/);
  });
  test("unknown command -> exit 2", () => {
    const r = run(["bogus"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown command/);
  });
  test("help exits 0", () => {
    assert.equal(run(["--help"]).status, 0);
    assert.equal(run(["day", "--help"]).status, 0);
    assert.equal(run(["period", "--help"]).status, 0);
  });
});
