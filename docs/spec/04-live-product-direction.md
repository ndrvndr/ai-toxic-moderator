# Arah produk: monitoring YouTube otomatis

Keputusan pengguna menggantikan batas simulasi/SSE pada backlog awal untuk target produk akhir. Migration foundation yang sudah diterapkan tetap immutable; perlu migration lanjutan untuk data YouTube dan status tindakan nyata.

## Alur pengguna

Login Google → halaman Live → pilih siaran aktif → Start Monitoring → chat, keputusan, alasan dan status tindakan diperbarui melalui WebSocket → Stop Monitoring atau siaran selesai → History per live stream.

Moderasi otomatis tidak menunggu persetujuan manusia. Kebijakan ditetapkan sebelum mulai monitoring. Flagged adalah hasil pemeriksaan, bukan bukti keberhasilan tindakan. Model tidak langsung memanggil YouTube; policy engine menetapkan tindakan dan executor mencatat respons provider.

## UI Next.js

Gunakan shadcn/ui dengan Tailwind, komponen lokal di `components/ui`, token warna semantik, dan layout konsisten. Halaman: login, Live, History, detail history, pengaturan kebijakan dan koneksi. Hindari angka demo yang tampak seperti data nyata.

Live memuat selector siaran, Start/Stop Monitoring, status koneksi, daftar chat dan ringkasan. Statistik menghitung pesan unik, flagged, alasan per kategori, serta tindakan berhasil/gagal. Pesan mempunyai hasil pemeriksaan terpisah dari action: aman/flagged/error; none/delete/timeout/ban; pending/running/succeeded/failed/blocked/unknown. Status sukses hanya sesudah konfirmasi YouTube.

History tetap ada setelah worker/API restart dan menyimpan alasan, snapshot versi policy/model, timestamp serta hasil tindakan. Hasil meragukan tidak memicu ban permanen. Ambang dan durasi konkret perlu ditetapkan serta diuji pada dataset sebelum enforcement nyata diaktifkan.

## Backend dan data

- NestJS: OAuth, sesi aplikasi, otorisasi channel, API Live/History dan gateway WebSocket.
- Worker NestJS/BullMQ: ingestion, klasifikasi, policy, dan eksekusi tindakan yang dipisah sebagai job.
- PostgreSQL: mapping channel YouTube, live session, pesan unik, keputusan, action attempts, history, statistik dan outbox.
- Redis: antrean dan distribusi event; bukan sumber history utama.
- Adapter YouTube: ambil chat dengan mekanisme resmi yang tersedia, hormati interval/quota, refresh token, delete, temporary ban (timeout), permanent ban.

WebSocket hanya antara backend dan dashboard. Jangan menganggap YouTube mengirim WebSocket ke browser. Sambungan memerlukan session dan Origin valid, otorisasi per channel, cursor replay setelah reconnect, pembatasan buffer, serta pemutusan saat sesi/akses berakhir.

## Urutan implementasi

1. Google OAuth dan daftar siaran milik grant pengguna.
2. Pasang dependensi shadcn, halaman login dan Live dengan empty/error/loading states; koneksi dan pemilihan channel terverifikasi.
3. Migration untuk source YouTube, monitoring lifecycle, chat deduplication dan history; endpoint start/stop idempotent.
4. Ingestion worker dengan recovery, checkpoint, backpressure dan penghentian ketika siaran berakhir.
5. Policy otomatis, alasan klasifikasi, serta executor delete/timeout/ban dengan audit. Timeout provider setelah pengiriman tidak dianggap sukses atau diulang buta; rekonsiliasi status terlebih dahulu.
6. WebSocket dengan replay dan UI statistik/history berdasarkan data tersimpan.
7. Uji end-to-end pada siaran pengujian, scope/permission, quota, reconnect, crash recovery dan akurasi classifier sebelum rilis.

Referensi UI: [instalasi manual shadcn/ui](https://ui.shadcn.com/docs/installation/manual). Referensi tindakan: [YouTube liveChatBans.insert](https://developers.google.com/youtube/v3/live/docs/liveChatBans/insert).
