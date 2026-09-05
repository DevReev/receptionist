/** ISO-local wall-time helpers. Page slot ints stay internal to the driver. */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLOT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:00)?$/;

export function isDateOnly(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isSlotStart(value: string): boolean {
  if (!SLOT_RE.test(value)) return false;
  const normalized = normalizeSlotStart(value);
  const [datePart, timePart] = normalized.split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi] = timePart.split(':').map(Number);
  if (h > 23 || mi > 59) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === mo - 1 &&
    dt.getUTCDate() === d &&
    dt.getUTCHours() === h &&
    dt.getUTCMinutes() === mi
  );
}

/** Accept `YYYY-MM-DDTHH:mm` or `...:00`; always return `YYYY-MM-DDTHH:mm:00`. */
export function normalizeSlotStart(value: string): string {
  return SLOT_RE.test(value) && value.length === 16 ? `${value}:00` : value;
}

/** Current wall time in `timeZone` as `YYYY-MM-DDTHH:mm:00` (lexicographically comparable). */
export function nowLocalISO(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}

/** Whole-day difference between two `YYYY-MM-DD` dates (to - from). */
export function dateWindowDays(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const fromMs = Date.UTC(fy, fm - 1, fd);
  const toMs = Date.UTC(ty, tm - 1, td);
  return Math.round((toMs - fromMs) / 86_400_000);
}

/** Every `YYYY-MM-DD` in [from, to], inclusive. */
export function eachDateOnly(from: string, to: string): string[] {
  const out: string[] = [];
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  let cur = Date.UTC(fy, fm - 1, fd);
  const end = Date.UTC(ty, tm - 1, td);
  while (cur <= end) {
    out.push(new Date(cur).toISOString().slice(0, 10));
    cur += 86_400_000;
  }
  return out;
}

/** Page-local slot int (`YYYYMMDDHHMM`) <-> ISO local. Internal to the driver boundary. */
export function slotIntToISO(slotInt: string): string {
  const y = slotInt.slice(0, 4);
  const mo = slotInt.slice(4, 6);
  const d = slotInt.slice(6, 8);
  const h = slotInt.slice(8, 10);
  const mi = slotInt.slice(10, 12);
  return `${y}-${mo}-${d}T${h}:${mi}:00`;
}

export function isoToSlotInt(iso: string): string {
  const n = normalizeSlotStart(iso);
  return n.replaceAll(/\D/g, '').slice(0, 12);
}
