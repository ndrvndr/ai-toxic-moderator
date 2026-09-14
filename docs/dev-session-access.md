# Session development dan akses channel

Branch: `feat/dev-session-access`. Fitur ini menyediakan autentikasi lokal untuk backend, bukan login production/OIDC. Tidak ada perubahan pada `.env` pengguna secara otomatis.

## Mengaktifkan

Tambahkan atau sesuaikan di `.env`:

```dotenv
DEV_AUTH_ENABLED=true
DEV_ACCOUNT_ID=10000000-0000-4000-8000-000000000001
DASHBOARD_ORIGIN=http://127.0.0.1:3000
SESSION_TTL_SECONDS=3600
```

Kemudian, dari root project:

```powershell
npm run build:core
npm run db:migrate
npm run db:seed
npm run dev:api
```

Migration `002_development_sessions.sql` menambahkan penyimpanan session. Migration lama tidak diubah. Login default menggunakan akun moderator dari seed. `DEV_AUTH_ENABLED` default false; mode production dan origin publik ditolak validasi konfigurasi.

## Mencoba lewat PowerShell

Di terminal lain:

```powershell
$api = 'http://127.0.0.1:3001'
$origin = @{ Origin = 'http://127.0.0.1:3000' }

Invoke-RestMethod "$api/v1/auth/dev-session" -Method Post -Headers $origin -ContentType 'application/json' -Body '{}' -SessionVariable devSession
Invoke-RestMethod "$api/v1/me" -WebSession $devSession
Invoke-RestMethod "$api/v1/channels/20000000-0000-4000-8000-000000000001/sessions" -WebSession $devSession
Invoke-RestMethod "$api/v1/auth/logout" -Method Post -Headers $origin -ContentType 'application/json' -Body '{}' -WebSession $devSession
```

Setelah logout, `/v1/me` dengan cookie lama menghasilkan 401. Di browser nanti gunakan `credentials: 'include'`; gunakan host yang konsisten pada API dan dashboard (misalnya keduanya 127.0.0.1), karena cookie SameSite Strict tidak dikirim antar-site. Dashboard belum memiliki form login pada fitur backend ini.

## Kontrak

| Endpoint                                | Perilaku                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| POST `/v1/auth/dev-session`             | Body `{}`; Origin wajib cocok; 201 `{expires_at}` + cookie; 404 bila fitur disabled                          |
| GET `/v1/me`                            | Session valid wajib; account dari server dan membership terbaru                                              |
| POST `/v1/auth/logout`                  | Body `{}`; session + Origin wajib; 204 dan hapus cookie/session                                              |
| GET `/v1/channels/:channel_id/sessions` | Session + membership OWNER/MODERATOR; pagination limit/cursor; OPERATOR tidak otomatis mendapat akses konten |
| GET `/health/live`                      | Tanpa session, pemeriksaan proses                                                                            |
| GET `/health/ready`                     | Tanpa session, memeriksa schema foundation dan dashboard_sessions; bukan kesiapan pipeline moderasi          |

Endpoint private memakai guard global. Channel routes harus menggunakan nama parameter `channel_id`. Guard Origin berlaku untuk method selain GET/HEAD/OPTIONS. CORS hanya mengizinkan dashboard origin yang ditentukan; Host dan koneksi juga harus loopback. API tidak mempercayai X-Forwarded-Host/IP untuk melewati pembatasan lokal.

Session memakai token acak 256 bit di cookie `atm_dev_session`; database hanya menyimpan SHA-256 token. Cookie HttpOnly, SameSite=Strict, Path=/ dan Max-Age sesuai TTL. Secure belum dipasang karena endpoint development menggunakan HTTP loopback; konfigurasi ini tidak untuk publikasi production. Response autentikasi memakai Cache-Control no-store.

Login ulang mencabut cookie sebelumnya bila diberikan, lalu membuat token baru. Maksimal 10 session per akun; session expired dibersihkan saat login. Session bertahan setelah restart API, tetapi setiap request tetap memeriksa expiry dan membership terbaru. Tidak ada actor/role yang diterima dari body login. Error memakai envelope v1 dan X-Request-Id tanpa raw token atau detail koneksi database.

## Role database API

Untuk memisahkan akun migrasi dari runtime, simpan koneksi administrator lokal sebagai `MIGRATION_DATABASE_URL`. Tambahkan `RUNTIME_DB_ROLE=moderator_api` dan `RUNTIME_DB_PASSWORD` pilihan Anda (minimal 16 karakter), lalu jalankan:

```powershell
npm run db:runtime
```

Setelah berhasil, ganti user/password dalam `DATABASE_URL` menjadi role runtime tersebut. URL-encode password bila berisi karakter khusus. `db:migrate` dan `db:seed` akan memakai `MIGRATION_DATABASE_URL`; API memakai `DATABASE_URL`. Script provisioning memerlukan administrator PostgreSQL yang boleh membuat role dan memberi grant.

Role runtime hanya mendapat SELECT untuk account/channel/membership/session stream/run/config, serta SELECT/INSERT/DELETE pada dashboard_sessions. Role tidak memiliki schema/table dan tidak dapat mengubah membership atau menghapus keputusan/audit. Script hanya mengelola role yang dibuatnya sendiri, menolak role lain yang sudah ada, dan dapat memperbarui password role terkelola. Database pengguna tidak diprovisikan otomatis oleh implementasi fitur ini.

## Verifikasi

```powershell
npm run build
npm test
$env:TEST_DATABASE_URL = 'postgresql://moderator:local_demo_only@127.0.0.1:55432/moderator'
npm run test:db
npm run test:auth
```

Test auth memakai database lokal administratif: membuat schema dan role acak, menjalankan API HTTP dengan role runtime terbatas, lalu membersihkan hanya schema/role milik test. Jangan arahkan test ke production. Laporan aktual tersedia pada `docs/verification.md`.
