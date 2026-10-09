// Business dates are in the plantation's timezone (WIB by default).
export const TZ = process.env.APP_TIMEZONE || 'Asia/Jakarta';
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

export const today = () => fmt.format(new Date());
export const addDays = (d: string, n: number) => new Date(new Date(d + 'T00:00:00Z').getTime() + n * 86400_000).toISOString().slice(0, 10);

/** Accepts ISO timestamps or 'YYYY-MM-DDTHH:mm' (interpreted in business timezone). */
export function toTimestamp(v: string): string {
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(v)) return v;
  const offset = TZ === 'Asia/Makassar' ? '+08:00' : TZ === 'Asia/Jayapura' ? '+09:00' : '+07:00';
  return (v.length === 16 ? v + ':00' : v) + offset;
}
