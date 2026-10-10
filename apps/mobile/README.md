# Palmora Health — aplikasi Android untuk dokter & perawat

Aplikasi Android (Capacitor + React) yang terhubung ke server Palmora Health yang sama dengan aplikasi web.
Semua hak akses, RLS, dan audit trail tetap dijalankan oleh server; aplikasi hanya tampilan.

| Layar | Isi |
|---|---|
| Hubungkan ke server | Alamat server diisi sekali (dicek ke `/healthz`), bisa diganti di menu Akun |
| Masuk | Username + password, kode MFA bila aktif; sesi tersimpan di HP (refresh token berputar) |
| Antrian | Papan antrian klinik hari ini per status, diperbarui tiap 15 detik; ganti klinik bila punya beberapa |
| Registrasi | Cari pasien (nama, No. karyawan, NIK, No. RM) atau **pindai kartu QR dengan kamera**; prioritas, sumber, keluhan |
| Triase | Keluhan, tingkat triase, tanda vital → menunggu dokter |
| Pemeriksaan | SOAP + catatan rahasia, diagnosis ICD-10, resep ke farmasi (dengan peringatan alergi), surat sakit, tanda tangan |
| Pasien | Pencarian / QR → riwayat kunjungan, alergi, MCU terakhir |

Fitur lain (farmasi, MCU, K3, laporan, admin) tetap di aplikasi web.

## Server yang bisa dipakai

- **Server perusahaan** (disarankan): `https://palmora.perusahaan.co.id` atau `http://192.168.x.x:8080` di jaringan kantor.
- **Aplikasi Mac** (demo): menu *Opsi… → Aktifkan akses aplikasi Android (Wi-Fi kantor)*; jendela Palmora Health
  lalu menampilkan alamat seperti `http://192.168.1.20:8765` untuk diisi di HP yang terhubung ke Wi-Fi yang sama.
- **GitHub Codespaces** (uji coba): tab *Ports* → klik kanan port **8080** → *Port Visibility* → **Public**, lalu isi
  alamat `https://…-8080.app.github.dev` di HP.

Server mengizinkan origin WebView Android (`https://localhost`) secara bawaan (CORS), jadi tidak perlu pengaturan tambahan.

## Build APK

Butuh Node 20+, JDK 21, dan Android SDK (platform 35, build-tools 35).

```bash
npm install                                   # dari root repo
cd apps/mobile
echo "sdk.dir=/path/to/android-sdk" > android/local.properties
# tanda tangan rilis (file ini tidak masuk git):
#   android/keystore.properties  →  storeFile=… storePassword=… keyAlias=… keyPassword=…
npm run android:apk                           # → android/app/build/outputs/apk/release/app-release.apk
```

Tanpa `keystore.properties` hasilnya APK rilis yang belum ditandatangani. **Simpan kunci rilis dengan aman**: pembaruan
aplikasi harus ditandatangani dengan kunci yang sama. Pengembangan tampilan: `npm run dev` (browser, port 5174).
