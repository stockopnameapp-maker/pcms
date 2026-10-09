const TZ = 'Asia/Jakarta';
export const fmtNum = (v: any, d = 0) => (v === null || v === undefined || v === '' ? '–' : Number(v).toLocaleString('id-ID', { maximumFractionDigits: d }));
export const fmtMoney = (v: any) => (v === null || v === undefined ? '–' : 'Rp ' + Math.round(Number(v)).toLocaleString('id-ID'));
export const fmtMoneyShort = (v: any) => {
  const n = Number(v ?? 0);
  if (Math.abs(n) >= 1e9) return 'Rp ' + (n / 1e9).toLocaleString('id-ID', { maximumFractionDigits: 2 }) + ' M';
  if (Math.abs(n) >= 1e6) return 'Rp ' + (n / 1e6).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + ' jt';
  return fmtMoney(n);
};
export const fmtDate = (v: any) => (v ? new Date(String(v).length === 10 ? v + 'T00:00:00' : v).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', timeZone: String(v).length === 10 ? undefined : TZ }) : '–');
export const fmtDateTime = (v: any) => (v ? new Date(v).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: TZ }) : '–');
export const fmtTime = (v: any) => (v ? new Date(v).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: TZ }) : '–');
export const fmtRelative = (v: any) => {
  if (!v) return '';
  const s = (Date.now() - new Date(v).getTime()) / 1000;
  if (s < 60) return 'baru saja';
  if (s < 3600) return `${Math.floor(s / 60)} mnt lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} hari lalu`;
  return fmtDate(v);
};
export const todayISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
export const shiftDate = (d: string, days: number) => new Date(new Date(d + 'T00:00:00Z').getTime() + days * 86400000).toISOString().slice(0, 10);

// Readable Indonesian labels for enum values (falls back to humanised value)
const LABELS: Record<string, string> = {
  CLINIC_OPERATIONAL: 'Operasional klinik', EQUIPMENT: 'Alat medis', MEDICINE: 'Obat', AMBULANCE: 'Ambulans', REFERRAL: 'Rujukan', HOSPITAL: 'Rumah sakit', LAB: 'Laboratorium', MCU: 'Medical check up',
  GROUP: 'Grup', REGION: 'Region', ESTATE: 'Kebun', MILL: 'Pabrik (PKS)', DIVISION: 'Divisi', AFDELING: 'Afdeling', CLINIC: 'Klinik', WAREHOUSE: 'Gudang', DEPARTMENT: 'Departemen',
  EMPLOYEE: 'Karyawan', FAMILY: 'Keluarga', CHILD: 'Anak', SPOUSE: 'Pasangan', VISITOR: 'Tamu', CONTRACTOR: 'Kontraktor',
  COMPANY: 'Perusahaan', BPJS: 'BPJS', INSURANCE: 'Asuransi', SELF: 'Pribadi',
  ACTIVE: 'Aktif', INACTIVE: 'Nonaktif', OPEN: 'Buka', CLOSED: 'Tutup', EMERGENCY_ONLY: 'Darurat saja', WAITING: 'Menunggu', TRIAGE: 'Triase', WAITING_DOCTOR: 'Menunggu dokter',
  IN_CONSULTATION: 'Konsultasi', PHARMACY: 'Farmasi', COMPLETED: 'Selesai', CANCELLED: 'Batal', SIGNED: 'Ditandatangani', NORMAL: 'Normal', PRIORITY: 'Prioritas', EMERGENCY: 'Darurat',
  SUBMITTED: 'Diajukan', DISPENSED: 'Diserahkan', PARTIALLY_DISPENSED: 'Sebagian', IN_PREPARATION: 'Disiapkan', DRAFT: 'Draf', REQUESTED: 'Diminta', APPROVED: 'Disetujui',
  REJECTED: 'Ditolak', IN_TRANSIT: 'Dikirim', RECEIVED: 'Diterima', PARTIALLY_RECEIVED: 'Diterima sebagian', COUNTING: 'Penghitungan', POSTED: 'Diposting',
  PLANNED: 'Direncanakan', SCHEDULED: 'Terjadwal', IN_PROGRESS: 'Berlangsung', AWAITING_RESULT: 'Menunggu hasil', NO_SHOW: 'Tidak hadir',
  FIT: 'Fit', FIT_WITH_RESTRICTION: 'Fit dgn pembatasan', TEMPORARILY_UNFIT: 'Unfit sementara', UNFIT: 'Unfit', NOT_ASSESSED: 'Belum dinilai',
  REPORTED: 'Dilaporkan', FIRST_AID: 'P3K', MEDICAL_TREATMENT: 'Penanganan medis', INVESTIGATION: 'Investigasi', PENDING_APPROVAL: 'Menunggu persetujuan',
  FOLLOW_UP: 'Tindak lanjut', RETURN_TO_WORK: 'Kembali bekerja', ISSUED: 'Diterbitkan', AT_HOSPITAL: 'Di RS', IN_TREATMENT: 'Dirawat', INPATIENT: 'Rawat inap',
  RETURNED: 'Kembali ke klinik', ACKNOWLEDGED: 'Ditindaklanjuti', RESOLVED: 'Selesai', DISMISSED: 'Diabaikan', EXTENDED: 'Diperpanjang', REVOKED: 'Dicabut',
  AVAILABLE: 'Tersedia', ON_TRIP: 'Bertugas', MAINTENANCE: 'Perawatan', OUT_OF_SERVICE: 'Tidak beroperasi', DISPATCHED: 'Dikirim', EN_ROUTE: 'Menuju lokasi',
  ON_SCENE: 'Di lokasi', TRANSPORTING: 'Membawa pasien', ARRIVED: 'Tiba', BOOKED: 'Dipesan', CONFIRMED: 'Dikonfirmasi', CHECKED_IN: 'Check-in',
  ORDERED: 'Dipesan', COLLECTED: 'Sampel diambil', RESULTED: 'Ada hasil', VERIFIED: 'Terverifikasi', ADMITTED: 'Dirawat', DISCHARGED: 'Pulang',
  UP_TO_DATE: 'Tepat waktu', DUE_SOON: 'Segera jatuh tempo', OVERDUE: 'Terlambat', NEVER_EXAMINED: 'Belum pernah MCU', LOCKED: 'Terkunci', DISABLED: 'Nonaktif',
  MINOR: 'Ringan', MODERATE: 'Sedang', SERIOUS: 'Berat', MAJOR: 'Mayor', FATAL: 'Fatal', LOW: 'Rendah', MEDIUM: 'Sedang', HIGH: 'Tinggi', CRITICAL: 'Kritis', VERY_HIGH: 'Sangat tinggi',
  ROUTINE: 'Rutin', URGENT: 'Mendesak', STAT: 'Segera', M: 'Laki-laki', F: 'Perempuan', HIGH_RISK: 'Risiko tinggi',
};
export const label = (v: any) => (v === null || v === undefined || v === '' ? '–' : LABELS[v] ?? String(v).replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()));

type Tone = 'green' | 'amber' | 'red' | 'blue' | 'gray' | 'orange' | 'gold';
const TONES: Record<string, Tone> = {
  ACTIVE: 'green', OPEN: 'green', COMPLETED: 'green', SIGNED: 'green', DISPENSED: 'green', APPROVED: 'green', RECEIVED: 'green', POSTED: 'green', FIT: 'green',
  CLOSED: 'gray', RETURNED: 'green', ACKNOWLEDGED: 'blue', RESOLVED: 'green', VERIFIED: 'green', AVAILABLE: 'green', CONFIRMED: 'green', UP_TO_DATE: 'green', NORMAL: 'gray', ROUTINE: 'gray', NEGATIVE: 'green',
  WAITING: 'gray', TRIAGE: 'blue', WAITING_DOCTOR: 'amber', IN_CONSULTATION: 'blue', PHARMACY: 'gold', SUBMITTED: 'amber', REQUESTED: 'amber', PLANNED: 'gray', SCHEDULED: 'blue',
  IN_PROGRESS: 'blue', IN_TRANSIT: 'blue', AWAITING_RESULT: 'amber', PENDING_APPROVAL: 'amber', INVESTIGATION: 'blue', FOLLOW_UP: 'blue', ISSUED: 'blue', DUE_SOON: 'amber',
  CANCELLED: 'gray', REJECTED: 'red', NO_SHOW: 'gray', DISMISSED: 'gray', REVOKED: 'red', DRAFT: 'gray', LOCKED: 'red', DISABLED: 'gray', INACTIVE: 'gray',
  FIT_WITH_RESTRICTION: 'amber', TEMPORARILY_UNFIT: 'orange', UNFIT: 'red', OVERDUE: 'red', NEVER_EXAMINED: 'orange', EMERGENCY: 'red', EMERGENCY_ONLY: 'orange', PRIORITY: 'amber',
  MINOR: 'gray', MODERATE: 'amber', SERIOUS: 'orange', MAJOR: 'red', FATAL: 'red', LOW: 'blue', MEDIUM: 'amber', HIGH: 'orange', CRITICAL: 'red', URGENT: 'orange', STAT: 'red',
  REPORTED: 'amber', FIRST_AID: 'amber', MEDICAL_TREATMENT: 'blue', ON_TRIP: 'blue', MAINTENANCE: 'amber', OUT_OF_SERVICE: 'red', ADMITTED: 'blue', INPATIENT: 'blue', AT_HOSPITAL: 'blue',
  IN_TREATMENT: 'blue', RETURN_TO_WORK: 'green', PARTIALLY_DISPENSED: 'amber', PARTIALLY_RECEIVED: 'amber', ABNORMAL: 'orange', HIGH_FLAG: 'orange', POSITIVE: 'red', CRITICAL_HIGH: 'red', CRITICAL_LOW: 'red',
  RED: 'red', YELLOW: 'amber', GREEN: 'green', BLACK: 'gray', DISPATCHED: 'amber', EN_ROUTE: 'blue', TRANSPORTING: 'blue', ARRIVED: 'green', ORDERED: 'amber', COLLECTED: 'blue', RESULTED: 'amber',
};
export const toneOf = (v: any): Tone => TONES[v] ?? 'gray';
export const TONE_CLASS: Record<Tone, string> = {
  green: 'bg-canopy-100 text-canopy-700', amber: 'bg-amber-50 text-amber-800', red: 'bg-red-50 text-red-700', blue: 'bg-sky-50 text-sky-800',
  gray: 'bg-[#EEF1EF] text-bark-700', orange: 'bg-orange-50 text-orange-800', gold: 'bg-kernel-100 text-[#7A5D17]',
};
