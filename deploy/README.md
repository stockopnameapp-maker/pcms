# Memasang Palmora Health di VPS

Satu skrip memasang semuanya: PostgreSQL 16, Node.js 22, aplikasi Palmora Health (web + API), layanan systemd,
Caddy (HTTPS otomatis Let's Encrypt), firewall, dan backup harian.

## Kebutuhan

- VPS **Ubuntu 22.04 / 24.04** atau **Debian 12**, akses root (atau sudo).
- Minimal **2 vCPU, 2 GB RAM, 20 GB disk** (skrip menambah swap 2 GB bila RAM < 3 GB).
- Disarankan **domain/subdomain**, misalnya `palmora.perusahaan.co.id`, dengan **record A** mengarah ke IP VPS.
  Tanpa domain aplikasi tetap jalan di `http://IP-VPS`, tetapi tanpa HTTPS — jangan dipakai untuk data pasien asli.

## Langkah

1. Arahkan DNS (di panel domain): record **A** `palmora` → IP VPS. Tunggu beberapa menit.
2. Masuk ke VPS: `ssh root@IP-VPS`
3. Jalankan:

```bash
curl -fsSL https://raw.githubusercontent.com/stockopnameapp-maker/pcms/main/deploy/install.sh -o install.sh
sudo DOMAIN=palmora.perusahaan.co.id EMAIL=it@perusahaan.co.id bash install.sh
```

   Proses 5–10 menit. Di akhir muncul alamat aplikasi.
4. Buka `https://palmora.perusahaan.co.id`, masuk dengan `kas.superadmin` / `Demo@12345`, lalu **ganti password**
   (menu Profil). Ganti juga password akun lain yang akan dipakai, atau nonaktifkan yang tidak dipakai (Admin → Pengguna).
5. Aplikasi Android: isi alamat server `https://palmora.perusahaan.co.id`.

## Setelah terpasang

| Keperluan | Perintah |
|---|---|
| Status / restart | `systemctl status palmora` · `systemctl restart palmora` |
| Log aplikasi | `journalctl -u palmora -f` |
| Memperbarui ke versi terbaru | `sudo bash /opt/palmora/deploy/install.sh` (data dan konfigurasi tetap) |
| Backup manual | `sudo palmora-backup` → `/var/backups/palmora` |
| Pulihkan database | `sudo systemctl stop palmora && sudo -u postgres pg_restore --clean -d pcms /var/backups/palmora/pcms-YYYYMMDD-HHMM.dump && sudo systemctl start palmora` |

**Kunci rahasia** ada di `/opt/palmora/apps/api/.env` (salinan: `/var/backups/palmora/api.env.keep`). Unduh dan simpan
di tempat aman: `FIELD_ENCRYPTION_KEY` dipakai untuk mengenkripsi catatan rahasia dokter, dan tanpa kunci itu catatan
tersebut tidak dapat dibaca lagi. Salin juga folder backup ke luar VPS secara berkala.

## Lokasi

| Apa | Di mana |
|---|---|
| Kode aplikasi | `/opt/palmora` |
| Konfigurasi | `/opt/palmora/apps/api/.env`, `/opt/palmora/packages/db/.env`, `/etc/palmora.conf` |
| File unggahan | `/var/lib/palmora/storage` |
| Backup harian (02.30, 14 hari) | `/var/backups/palmora` |
| Web server | `/etc/caddy/Caddyfile` |

## Masalah umum

- **Sertifikat HTTPS gagal**: pastikan record A sudah mengarah ke IP VPS dan port 80/443 tidak diblokir firewall
  penyedia VPS. Lalu `systemctl reload caddy` dan lihat `journalctl -u caddy -n 50`.
- **Aplikasi tidak menyala**: `journalctl -u palmora -n 100`.
- **Belum pakai domain lalu ingin HTTPS**: arahkan DNS, lalu jalankan ulang
  `sudo DOMAIN=palmora.perusahaan.co.id EMAIL=… bash /opt/palmora/deploy/install.sh`.
