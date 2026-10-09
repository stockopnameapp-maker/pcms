export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new AppError(400, 'VALIDATION_ERROR', msg, details);
export const forbidden = (msg = 'Anda tidak memiliki izin untuk tindakan ini') => new AppError(403, 'PERMISSION_DENIED', msg);
export const notFound = (what = 'Data') => new AppError(404, 'NOT_FOUND', `${what} tidak ditemukan atau di luar cakupan akses Anda`);
export const unauthorized = (msg = 'Sesi tidak valid, silakan login kembali') => new AppError(401, 'UNAUTHENTICATED', msg);
export const conflict = (msg: string) => new AppError(409, 'CONFLICT', msg);

// Human-readable messages for named constraints (fallback: generic message)
const CONSTRAINT_MESSAGES: Record<string, string> = {
  employee_nik_check: 'NIK harus 16 digit angka',
  patient_nik_check: 'NIK harus 16 digit angka',
  family_member_nik_check: 'NIK harus 16 digit angka',
  employee_nik_uq: 'NIK sudah terdaftar untuk karyawan lain',
  employee_tenant_id_employee_no_key: 'Nomor karyawan sudah digunakan',
  employee_check1: 'Karyawan minimal berusia 15 tahun pada tanggal bergabung',
  employee_check: 'Tanggal berakhir tidak boleh sebelum tanggal bergabung',
  employee_bpjs_kesehatan_no_check: 'Nomor BPJS Kesehatan harus 13 digit',
  employee_bpjs_ketenagakerjaan_no_check: 'Nomor BPJS Ketenagakerjaan harus 11 digit',
  org_unit_tenant_id_code_key: 'Kode unit sudah digunakan',
  org_unit_code_check: 'Kode hanya boleh huruf besar, angka, titik, garis bawah atau strip (2–30 karakter)',
  app_user_username_uq: 'Username sudah digunakan',
  app_user_email_uq: 'Email sudah digunakan',
  inventory_stock_qty_on_hand_check: 'Stok tidak mencukupi',
  vital_sign_check: 'Tekanan sistolik harus lebih besar dari diastolik',
  diagnosis_one_primary: 'Encounter ini sudah memiliki diagnosis utama',
  queue_ticket_clinic_id_visit_date_queue_code_key: 'Nomor antrian sudah digunakan, coba lagi',
  sick_leave_check: 'Tanggal akhir harus setelah tanggal mulai (maks. 365 hari)',
  mcu_check: 'MCU yang selesai wajib memiliki tanggal pemeriksaan dan status fit',
  mcu_check1: 'Status FIT WITH RESTRICTION wajib mencantumkan pembatasan',
  health_assessment_check1: 'Status FIT WITH RESTRICTION wajib mencantumkan pembatasan',
  accident_check2: 'Kecelakaan dengan severity di atas MINOR wajib disetujui terlebih dahulu',
  ambulance_vehicle_no_check: 'Format plat nomor tidak valid (contoh: BM 1234 AB)',
  stock_transfer_check: 'Unit asal dan tujuan tidak boleh sama',
  stock_transfer_check1: 'Alasan penolakan wajib diisi',
  inventory_transaction_check1: 'Penyesuaian stok wajib disertai alasan',
  appointment_check: 'Alasan pembatalan wajib diisi',
  break_glass_grant_reason_check: 'Alasan akses darurat minimal 15 karakter',
};

const PG_TRANSLATIONS: [RegExp, string][] = [
  [/new row violates row-level security policy/i, 'Anda tidak memiliki izin untuk menyimpan data pada unit ini'],
  [/permission denied for/i, 'Anda tidak memiliki izin untuk mengakses data ini'],
];

/** Translate PostgreSQL errors into API errors. Database messages from our own RAISEs are kept (they are meant for users). */
export function fromPg(e: any): AppError {
  if (e instanceof AppError) return e;
  const code: string | undefined = e?.code;
  const msg: string = e?.message ?? 'Unexpected error';
  const translated = PG_TRANSLATIONS.find(([re]) => re.test(msg))?.[1];
  const constraintMsg = e?.constraint ? CONSTRAINT_MESSAGES[e.constraint] : undefined;
  switch (code) {
    case '42501': { const err = new AppError(403, 'PERMISSION_DENIED', translated ?? msg); (err as any).cause = e; return err; }
    case '28000': return new AppError(401, 'UNAUTHENTICATED', msg);
    case '23505': return new AppError(409, 'DUPLICATE', constraintMsg ?? `Data duplikat (${e.constraint ?? 'unique'})`, { constraint: e.constraint });
    case '23503': return new AppError(400, 'INVALID_REFERENCE', constraintMsg ?? 'Referensi data tidak valid atau masih digunakan', { constraint: e.constraint });
    case '23514': return new AppError(400, 'VALIDATION_ERROR', constraintMsg ?? (e.constraint ? `Data tidak valid (${e.constraint})` : msg), { constraint: e.constraint });
    case '23502': return new AppError(400, 'REQUIRED', `Kolom ${e.column ?? ''} wajib diisi`.trim(), { column: e.column });
    case '22P02': case '22007': case '22008': case '22003': case '22023': case '22001':
      return new AppError(400, 'INVALID_INPUT', `Format data tidak valid: ${msg}`);
    case 'P0002': return new AppError(404, 'NOT_FOUND', msg);
    case '40001': case '40P01': return new AppError(409, 'RETRY', 'Data sedang diubah pengguna lain, silakan coba lagi');
    default: { const err = new AppError(500, 'INTERNAL', 'Terjadi kesalahan pada server'); (err as any).cause = e; return err; }
  }
}
