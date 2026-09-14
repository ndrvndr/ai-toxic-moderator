# Backlog milestone pertama

Pembaruan 14 September 2026: fondasi M1-01–03 tersedia; M1-04 backend session development, guard membership, Origin dan provisioning role runtime sudah diimplementasikan pada branch `feat/dev-session-access`. Lihat `docs/dev-session-access.md` dan `docs/verification.md` untuk langkah penggunaan, hasil pengujian, serta batasan. M1-05 dan seterusnya belum dimulai.

## Urutan pekerjaan

| ID | Pekerjaan / hasil | Dependensi | Kriteria penerimaan |
| --- | --- | --- | --- |
| M1-01 | Scaffold monorepo: dashboard Next.js, API NestJS/Express, worker NestJS application context; packages/contracts, moderation-core, persistence, config, provider-adapters | — | TypeScript strict, lockfile, script dev/build/check; API dan worker boot terpisah; processor @nestjs/bullmq hanya aktif di worker; fresh install dan build berhasil pada runtime yang didokumentasikan |
| M1-02 | Runtime schemas dan fixtures request/response/event | M1-01 | Field salah, unknown field, span invalid, status tak dikenal, dan field conditional feedback ditolak; fixture valid diterima |
| M1-03 | Migration PostgreSQL, seed satu channel/session/run/bundle/account | M1-02 | Migration dari DB kosong, seed idempotent; cross-channel FK dan duplicate constraints diuji; aturan session/run konsisten |
| M1-04 | Development session, membership, Origin check, pembatasan local binding | M1-03 | Actor tidak bisa disisipkan client; channel lain ditolak; sesi development tidak dapat aktif pada konfigurasi public/production |
| M1-05 | Ingestion API + task + transactional outbox | M1-04 | POST 202; duplicate identik satu row/task, duplicate beda isi 409; raw text identik byte-for-byte setelah decode JSON/encode UTF-8 |
| M1-06 | Text processor, evidence mapping, rule demo + policy immutable | M1-02 | Semua fixture di bawah lolos; policy memberi action hanya pada strong matches; confidence null; versi pinned |
| M1-07 | Outbox dispatcher, BullMQ worker, persistence decision/action simulasi/audit | M1-03,05,06 | Event → decision; retry paralel tetap satu hasil; tidak ada provider/network enforcement; rollback transaksi tidak meninggalkan action tanpa decision |
| M1-08 | Feed/detail/task API dan SSE persisted | M1-07 | Pagination deterministik, filter aktif, snapshot watermark dan resume tidak kehilangan event; akses tiap resource terverifikasi |
| M1-09 | App shell, form pesan, feed, detail dan ringkasan hasil tampil | M1-08 | Input → status task → decision tanpa refresh; detail mempertahankan raw text; empty/loading/error/offline serta label SIMULATION jelas |
| M1-10 | Feedback API + audit + UI | M1-04,08,09 | Submit/retry idempotent, koreksi tersimpan terpisah dari decision, cache direfresh saat feedback event |
| M1-11 | Retry terminal failure, reconciler, graceful shutdown, readiness dan log | M1-07,08 | Worker/Redis restart tidak membuat duplikat; terminal failure tampil ERROR; task tersangkut dapat dipulihkan |
| M1-12 | E2E, integration failure checks, a11y inti, README demo | M1-09,10,11 | Semua acceptance gate di bawah lulus; perintah setup/test/demo tervalidasi dari kondisi bersih |

Tidak menetapkan durasi kalender tanpa mengetahui kapasitas pengembang dan lingkungan. Pecah sesi kerja menurut hasil yang dapat diuji: foundation (01–04), pipeline (05–07), dashboard (08–10), verification (11–12).

## Fixture regresi minimum

Expected ini merupakan spesifikasi rule demo, bukan label training model atau klaim classifier umum.

| ID | Pesan / kondisi | Hasil yang diharapkan |
| --- | --- | --- |
| F01 | slot RAM | ALLOW, action kosong |
| F02 | babi hutan | ALLOW |
| F03 | judi itu berbahaya | ALLOW |
| F04 | anjing laut | ALLOW |
| F05 | gila keren | ALLOW |
| F06 | ayo daftar judi online di contoh.invalid sekarang | ACTION_REQUIRED, GAMBLING, S3, DELETE/SIMULATED |
| F07 | kamu bodoh | ACTION_REQUIRED, HARASSMENT, S2, DELETE/SIMULATED |
| F08 | slot | REVIEW, action kosong |
| F09 | jangan bilang kamu bodoh | ALLOW; pengecualian span/konteks |
| F10 | slot RAM bagus, ayo daftar judi online di contoh.invalid sekarang | ACTION_REQUIRED; pengecualian benign tidak membatalkan evidence lain |
| F11 | AYO  DAFTAR JUDI ONLINE di contoh.invalid SEKARANG | Hasil F06 setelah normalisasi; raw tetap utuh |
| F12 | 😀 kamu bodoh | Hasil F07; span UTF-16 benar setelah emoji |
| F13 | ｋａｍｕ bodoh | Hasil F07 setelah NFKC; raw span benar atau eksplisit UNAVAILABLE |
| F14 | ulangi F06 dengan external ID dan payload sama | message/task/decision/action count tidak bertambah |
| F15 | ulangi external ID F06 dengan raw text berbeda | HTTP 409; pesan asli tidak berubah |
| F16 | whitespace-only atau >2.000 code points | HTTP 422, tidak ada message/outbox |
| F17 | error pemrosesan deterministik setelah retry habis (fault injection test) | Task FAILED, decision ERROR, tidak ada action |

Sebelum implementasi rule, tulis definisi token/phrase dan batas konteks untuk F06–F13 dalam konfigurasi seed. Jangan membangun pengecualian dengan hardcode seluruh kalimat fixture. Tambahkan variasi positif dan negatif yang independen dari pola contoh untuk menguji generalisasi terbatas.

## Acceptance gate demo

1. Menjalankan setup terdokumentasi pada database kosong menghasilkan channel/session pilot serta rule/policy version yang diketahui.
2. Input F06 menghasilkan satu keputusan yang dapat dibuka dengan message, evidence, reason, versi, dan badge tindakan SIMULATED.
3. Feedback false positive muncul pada detail tanpa mengubah keputusan asli. Setelah restart API/worker/database, keputusan dan feedback tetap tersedia dari volume development.
4. Duplicate POST dan duplicate queue delivery tidak menambah keputusan atau tindakan.
5. Stop Redis setelah commit ingestion: task/outbox tetap tersimpan; setelah Redis kembali, pesan selesai diproses satu kali secara efektif.
6. Crash worker sebelum commit lalu restart: tidak ada partial decision/action; pemrosesan ulang selesai.
7. Putus SSE, buat beberapa keputusan, reconnect: semua keputusan akhirnya terlihat tanpa duplikasi. Uji juga cursor reset, concurrent commit, dan filter/pagination.
8. Session tak sah/channel lain ditolak oleh API dan SSE. Origin mutation yang tidak diizinkan ditolak. Payload HTML tampil sebagai teks.
9. Keyboard dapat mengisi pesan, memilih feed item, membuka/menutup detail dan memberi feedback; fokus kembali ke pemicu panel; status tidak mengandalkan warna.
10. Semua F01–F17 dan variasinya lulus. README membedakan kategori yang tersedia, belum didukung, dan keterbatasan rule demo.

## Artefak yang harus dihasilkan saat coding

- Repository dan lockfile; migration/seed; `.env.example` tanpa rahasia.
- Runtime schema/OpenAPI; fixture corpus; konfigurasi rule/policy versioned.
- Unit test untuk domain berisiko, integration tests persistence/queue/akses, E2E alur utama.
- README dengan setup, menjalankan proses, menjalankan tests, cara demo, troubleshoot Redis/worker, dan reset development eksplisit.
- Laporan hasil: tests yang dijalankan, pass/fail, kegagalan tersisa, serta keterbatasan. Belum ada angka performa/akurasi yang boleh diklaim sebelum pengukuran.

## Setelah milestone pertama

M2: hardening recovery/backpressure/metrics dan schema untuk replay. M3: dataset/evaluasi serta pemilihan model Indonesia. M4: OIDC, OAuth YouTube dan ingestion shadow. M5: kebijakan aksi yang disetujui, guard/executor provider, rekonsiliasi UNKNOWN. Jangan membuka fitur provider hanya dengan mengganti flag simulator.
