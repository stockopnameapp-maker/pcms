# macOS DMG

`Palmora-Health-<versi>.dmg` (±8 MB) berisi `Palmora Health.app` universal (Apple Silicon + Intel). Saat pertama dibuka, launcher mengunduh Node.js 22 (nodejs.org) dan PostgreSQL 16 + contrib (paket npm `@embedded-postgres`) untuk arsitektur Mac tersebut, memverifikasi SHA-256 yang tertanam di launcher, lalu menyimpannya di `~/Library/Application Support/Palmora Health/runtime`.

- `Palmora-Health.sh` — launcher (menjadi `Contents/MacOS/PalmoraHealth`; memindahkan data versi lama `~/Library/Application Support/PCMS` secara otomatis): membuat database lokal di `~/Library/Application Support/Palmora Health`,
  membuat kunci rahasia sekali, memuat data demo saat pertama dibuka, menjalankan server di http://localhost:8765.
- `build-app.sh` — merakit `Palmora Health.app` (berjalan di Linux/macOS; butuh internet ke nodejs.org dan npm).
- DMG dibuat dengan `mkfs.hfsplus` + `hfsplus addall -s clone_link` + `dmg build` dari mozilla/libdmg-hfsplus
  (di macOS cukup `hdiutil create -volname "Palmora Health" -srcfolder <folder> -format UDZO Palmora-Health.dmg`).

Aplikasi belum ditandatangani/notarisasi Apple. Pengguna menyetujuinya sekali lewat Pengaturan Sistem → Privasi & Keamanan →
"Tetap Buka" (tanpa Terminal). Launcher lalu menyalin file program ke `~/Library/Application Support/Palmora Health/app` dan menghapus
tanda karantina pada salinan itu, sehingga modul native di dalamnya tidak memicu peringatan lagi. Untuk distribusi luas:
tanda tangani dengan Developer ID dan notarisasi, maka langkah persetujuan pun hilang.
