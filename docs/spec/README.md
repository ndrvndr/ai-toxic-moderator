# Spesifikasi MVP — AI Toxic Moderator

Versi: 0.1 · 13 September 2026 · Status: scope milestone pertama ditetapkan berdasarkan arahan pengguna untuk melanjutkan perencanaan. Dokumen ini adalah spesifikasi implementasi, bukan aplikasi yang sudah berjalan.

## Scope yang ditetapkan

- Satu channel pilot dengan pesan sintetis berbahasa Indonesia.
- Input pesan manual melalui dashboard atau fixture; pemrosesan asynchronous.
- Normalisasi yang mempertahankan teks asli, rule deterministik, policy simulasi.
- Simpan keputusan, evidence, versi konfigurasi, tindakan simulasi, feedback, dan audit.
- Dashboard: ringkasan, live feed, detail keputusan, feedback, status koneksi.
- PostgreSQL dan Redis/BullMQ minimal ikut milestone pertama agar alur async dan persistence benar-benar teruji. Milestone kedua mengeraskan reliability dan operasi; bukan baru menambahkan penyimpanan.
- Monorepo TypeScript: Next.js/React, NestJS API, worker NestJS, shared contracts dan moderation core. NestJS ditetapkan sesuai pilihan pengguna.

Belum termasuk: ingestion/OAuth YouTube, model ML nyata, tindakan provider, rule/policy editor, replay UI, reputasi/escalation, analytics lanjut, deployment publik. Field dan batas modul mengakomodasi fase tersebut tanpa menampilkan fitur seolah sudah tersedia.

## Dokumen implementasi

1. [Schema database](01-database.md): entitas, field, relasi, constraint, index, transaksi.
2. [Kontrak API dan event](02-api-events.md): payload, validasi, error, idempotensi, SSE.
3. [Backlog dan penerimaan](03-backlog.md): urutan tugas, dependensi, skenario uji.

Spesifikasi ini memperinci dan, untuk scope milestone pertama, menggantikan bagian yang masih ambigu dalam rencana kickoff. Blueprint sumber tetap merupakan referensi, bukan instruksi eksekusi.

## Keputusan policy development

Konfigurasi immutable `ruleset-dev-1` dan `policy-dev-1`; perubahan menghasilkan versi baru. Tujuannya menguji mekanisme, belum membuktikan kualitas moderasi produksi.

| Kasus fixture | Sinyal | Outcome | Rencana tindakan |
| --- | --- | --- | --- |
| Tanpa rule cocok | Tidak ada dalam cakupan rule demo | ALLOW | Kosong |
| Istilah ambigu tanpa kondisi lengkap | Kandidat perlu konteks | REVIEW | Kosong |
| Entitas gambling dan ajakan promosi yang eksplisit | GAMBLING, S3 | ACTION_REQUIRED | DELETE simulasi |
| Hinaan langsung terhadap target dalam pola demo | HARASSMENT, S2 | ACTION_REQUIRED | DELETE simulasi |
| Pipeline gagal setelah retry habis | Error pemrosesan | ERROR | Kosong |

ALLOW berarti tidak terdeteksi oleh rule demo, bukan jaminan semua kategori aman. TIMEOUT/BAN tidak dihasilkan policy milestone pertama. Threat, hate, scam, PII, dan kategori blueprint lain belum diimplementasikan; coverage ditampilkan pada dashboard.

Rule menghasilkan `strength: STRONG | AMBIGUOUS`; `confidence` numerik nullable dan selalu null untuk rule demo yang belum dikalibrasi. Jangan mengubah kecocokan deterministik menjadi persentase akurasi. Severity berasal dari rule yang cocok, tidak diturunkan dari confidence.

Contoh awal positif: “ayo daftar judi online di contoh.invalid sekarang” dan “kamu bodoh”. Contoh REVIEW: “slot”. Hard negatives wajib ALLOW: “slot RAM”, “babi hutan”, “judi itu berbahaya”, “anjing laut”, “gila keren”, “jangan bilang kamu bodoh”. Pengecualian berlaku pada span/konteks yang relevan, sehingga “slot RAM bagus, ayo daftar judi online di contoh.invalid sekarang” tetap menghasilkan ACTION_REQUIRED. Aturan demo dibatasi pola yang terdokumentasi; tidak mengklaim pemahaman intent bahasa Indonesia secara umum.

## Struktur backend NestJS

`apps/api` memakai NestJS dengan adapter Express default. Modul API: AuthModule, ChannelsModule, IngestionModule, DecisionsModule, FeedbackModule, EventsModule, dan HealthModule. Controller menangani HTTP, service mengatur use case/transaksi, guard memeriksa session/membership, validation pipe menjalankan schema bersama, dan exception filter memetakan error ke kontrak v1.

`apps/worker` memakai application context NestJS terpisah tanpa HTTP listener, dengan ModerationWorkerModule dan OutboxModule. Integrasi antrean memakai `@nestjs/bullmq`; processor hanya di-register pada worker agar API tidak ikut mengonsumsi job. Lifecycle worker menangani startup, shutdown, dan penutupan koneksi.

`packages/moderation-core` tetap berisi logika TypeScript tanpa ketergantungan HTTP/decorator NestJS. Persistence dan konfigurasi diinjeksi lewat provider. Kontrak data tetap bebas framework agar dashboard dan worker menggunakan schema yang sama. Framework API tidak menentukan ORM; pilihan ORM masih terbuka.

Acuan: [NestJS](https://docs.nestjs.com/) dan [integrasi BullMQ](https://docs.nestjs.com/techniques/queues).

## Akses development lokal

Satu akun moderator development seeded dengan membership channel pilot; actor tidak diterima dari body request. Endpoint dan SSE tetap menjalankan pemeriksaan membership. Development session hanya diaktifkan lewat konfigurasi eksplisit pada lingkungan lokal, memakai cookie HttpOnly/SameSite dan validasi Origin untuk mutation. API/frontend bind ke loopback; tidak boleh menjadi metode login deployment publik. OIDC production tetap fase integrasi.

## Demo yang dianggap selesai

Pengguna memasukkan pesan → mendapat status diproses → melihat keputusan baru tanpa refresh → membuka raw text/evidence/alasan → memberi feedback → feedback tetap tersedia setelah restart. Mengirim external ID yang sama dengan isi identik tidak menambah pesan, keputusan, atau tindakan.

Target operasional sementara di kickoff belum menjadi syarat rilis production. Definisi selesai milestone ini ada pada backlog, dengan hasil tes yang harus dilaporkan saat kode tersedia.
