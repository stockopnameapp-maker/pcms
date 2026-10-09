# macOS DMG

`PCMS-<versi>.dmg` (±8 MB) berisi `PCMS.app` universal (Apple Silicon + Intel). Saat pertama dibuka, launcher mengunduh Node.js 22 (nodejs.org) dan PostgreSQL 16 + contrib (paket npm `@embedded-postgres`) untuk arsitektur Mac tersebut, memverifikasi SHA-256 yang tertanam di launcher, lalu menyimpannya di `~/Library/Application Support/PCMS/runtime`.

- `PCMS.sh` — launcher (menjadi `Contents/MacOS/PCMS`): membuat database lokal di `~/Library/Application Support/PCMS`,
  membuat kunci rahasia sekali, memuat data demo saat pertama dibuka, menjalankan server di http://localhost:8765.
- `build-app.sh` — merakit `PCMS.app` (berjalan di Linux/macOS; butuh internet ke nodejs.org dan npm).
- DMG dibuat dengan `mkfs.hfsplus` + `hfsplus addall -s clone_link` + `dmg build` dari mozilla/libdmg-hfsplus
  (di macOS cukup `hdiutil create -volname PCMS -srcfolder <folder> -format UDZO PCMS.dmg`).

Aplikasi belum ditandatangani/notarisasi Apple. Pengguna menyetujuinya sekali lewat Pengaturan Sistem → Privasi & Keamanan →
"Tetap Buka" (tanpa Terminal). Launcher lalu menyalin file program ke `~/Library/Application Support/PCMS/app` dan menghapus
tanda karantina pada salinan itu, sehingga modul native di dalamnya tidak memicu peringatan lagi. Untuk distribusi luas:
tanda tangani dengan Developer ID dan notarisasi, maka langkah persetujuan pun hilang.
