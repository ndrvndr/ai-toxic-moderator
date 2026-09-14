# AI Toxic Moderator

Backend Google OAuth dan endpoint daftar live stream tersedia sebagai implementasi awal; lihat [setup Google OAuth](docs/google-oauth.md). Fitur ini belum diverifikasi dengan Google/PostgreSQL nyata. Arah produk terbaru adalah [monitoring otomatis dengan shadcn dan WebSocket](docs/spec/04-live-product-direction.md); bagian milestone di bawah mendokumentasikan fondasi sebelumnya.

Monorepo moderasi YouTube Live Chat Indonesia. Fondasi M1-01–03 dan backend session development M1-04 tersedia. Login/logout lokal, `/v1/me`, dan daftar session channel sudah diimplementasikan. Pipeline deteksi, ingestion pesan, SSE feed, feedback endpoint, model AI, dan koneksi YouTube belum tersedia.

Untuk mengaktifkan serta mencoba fitur akses, lihat [session development](docs/dev-session-access.md). `.env` pengguna tidak diubah otomatis; login memerlukan `DEV_AUTH_ENABLED=true`.

## Stack

Next.js 16.3.5 + React; NestJS 12.0.1 dengan Express; worker NestJS terpisah dengan @nestjs/bullmq; TypeScript strict; PostgreSQL; Redis/BullMQ; Zod untuk runtime contracts. Persistence menggunakan `pg` dan SQL migrations secara eksplisit. ORM belum diperlukan pada fondasi ini. Versi resolusi seluruh dependensi disimpan dalam package-lock.json.

## Prasyarat

- Node.js 22.12+ pada lini 22, atau Node.js 24+; diuji dengan Node 22.20.0 dan npm 10.9.3.
- Docker Desktop dalam keadaan running, dengan Linux containers, untuk compose lokal.
- Port localhost 3000 (dashboard), 3001 (API), 55432 (PostgreSQL), 56379 (Redis) tersedia.

## Setup

Jalankan dari direktori yang berisi README ini:

```powershell
npm ci
Copy-Item .env.example .env
docker compose up -d
npm run build:core
npm run db:migrate
npm run db:seed
npm run build
npm test
```

Jika `.env` sudah ada, sesuaikan isinya tanpa menimpa konfigurasi Anda. Kredensial compose adalah kredensial development lokal; proses aplikasi dibatasi loopback dan menolak mode production.

Dalam terminal terpisah:

```powershell
npm run dev:api
```

```powershell
npm run dev:dashboard
```

Dashboard: http://127.0.0.1:3000. API: http://127.0.0.1:3001/health/live dan /health/ready. Ready memeriksa schema foundation dan dashboard_sessions; bukan kesiapan pipeline moderasi.

```powershell
npm run dev:worker
```

Worker menginisialisasi application context NestJS lalu keluar dengan sukses. Ia belum memiliki processor dan tidak mengambil job. `WORKER_ENABLED=true` hanya mendaftarkan koneksi/queue BullMQ untuk fondasi; bukan mengaktifkan moderasi. Ini disengaja sampai transaksi pipeline di M1-07 tersedia.

## Pengujian

```powershell
npm run check
npm test
$env:TEST_DATABASE_URL = 'postgresql://moderator:local_demo_only@127.0.0.1:55432/moderator'
npm run test:db
npm run test:auth
```

Test database membuat schema unik `test_<uuid>` lalu menghapus schema itu saja; jangan arahkan ke database produksi. Test memeriksa migration/seed idempotent, deduplikasi, isolasi channel/session, riwayat immutable, feedback conditional, status simulasi, dan rollback transaksi.

Tests memakai opsi Node `--experimental-test-isolation=none` untuk menghindari batasan child-process IPC pada runner Windows. Next build memakai worker threads dan pemeriksaan TypeScript melalui API compiler; type checking tetap dijalankan. Database integration test tetap menggunakan PostgreSQL nyata.

## Struktur

```text
apps/dashboard      Next.js app shell berbahasa Indonesia
apps/api            NestJS auth, guard akses, daftar session channel, health
apps/worker         NestJS application context dan registrasi BullMQ
packages/contracts  Zod schemas dan tipe bersama API/queue
packages/config     Validasi environment development
packages/persistence SQL migration + pg transaction helper
packages/moderation-core  Interface detection untuk M1-06
packages/provider-adapters Interface executor simulasi
scripts             Build, migration runner, seed
tests               Contract/config dan database integration
docs                Spesifikasi dan laporan verifikasi
```

## Keputusan implementasi fondasi

- Migrasi checksum-protected dengan transaksi dan advisory lock. Perubahan schema berikutnya memakai file migration baru.
- Seed berulang tidak menimpa bundle immutable. Bundle `foundation-0` memiliki rule kosong dan policy disabled; ini tidak boleh dipakai seolah rule demo telah dibuat.
- Unique constraints dan composite FK menjaga channel/session/run dan deduplikasi.
- Raw message, bundle, keputusan, feedback, dan audit menolak UPDATE. `db:runtime` menyediakan role API dengan hak akses terbatas; lihat panduan session development. Akun compose tetap akun development/migration sampai DATABASE_URL diarahkan ke role runtime.
- Schema hanya mengizinkan tindakan DELETE berstatus SIMULATED. Invariant lintas tabel (outcome vs jumlah tindakan, task final vs decision, bundle vs version snapshot) diterapkan melalui service transaksi pada M1-07; schema foundation belum menggantikan validasi service tersebut.
- `multer` dioverride ke 2.3.0 untuk memperbaiki advisory pada dependensi transitif platform-express. Tidak ada upload endpoint. Tinjau kembali override saat memperbarui NestJS.
- Ports Docker hanya dibuka pada localhost. Jangan expose fondasi ini ke internet.

## Berikutnya

M1-04 backend session, guard membership, Origin, dan provisioning runtime role sudah diimplementasikan. Berikutnya M1-05–07: ingestion, rule/policy demo, outbox dispatcher, dan worker transactional. Dashboard live serta feedback dihubungkan setelah jalur data tersebut tersedia.

Lihat [hasil verifikasi](docs/verification.md) dan [backlog](docs/spec/03-backlog.md). Angka akurasi/performa moderasi belum diukur karena classifier belum diimplementasikan.
