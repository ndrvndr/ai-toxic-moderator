# Google OAuth dan daftar live stream

Implementasi ini menambahkan login Google dan pembacaan daftar siaran milik pengguna. Monitoring, pengambilan chat, WebSocket, classifier, dan enforcement belum diaktifkan oleh fitur ini.

## Setup lokal

1. Di Google Cloud, aktifkan YouTube Data API v3 dan siapkan OAuth consent screen. Untuk aplikasi Testing, daftarkan akun Google penguji.
2. Gunakan OAuth client bertipe Web application. Daftarkan authorized redirect URI persis `http://127.0.0.1:3001/v1/auth/google/callback`.
3. Isi `.env` lokal dengan client ID dan client secret yang sudah dirotasi. Jangan masukkan token atau secret ke `NEXT_PUBLIC_*`, Git, atau log.
4. Buat `TOKEN_ENCRYPTION_KEY` dengan `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Simpan hasilnya di `.env`; pertahankan key ini agar token tersimpan tetap dapat dibaca setelah restart.
5. Set `GOOGLE_AUTH_ENABLED=true`, `DEV_AUTH_ENABLED=false`, dan `GOOGLE_REDIRECT_URI` seperti di atas. Dashboard dan API harus menggunakan hostname yang sama; jangan mencampur `localhost` dengan `127.0.0.1`.
6. Jalankan PostgreSQL, `npm run build:core`, `npm run db:migrate`, dan `npm run db:runtime` jika memakai role runtime. Migration 003 diperlukan meskipun Google auth dinonaktifkan karena session guard memakai kolom provider.
7. Jalankan API dan dashboard. Buka `http://127.0.0.1:3001/v1/auth/google` untuk memulai consent. Setelah berhasil, callback mengarahkan ke `/?auth=connected` di app shell yang tersedia. Parameter ini hanya status navigasi; autentikasi tetap diperiksa melalui session cookie. Halaman login dan `/live` masih menunggu implementasi frontend shadcn; arahkan callback ke `/live` ketika halaman tersebut tersedia.

Tidak ada perubahan otomatis pada `.env` pengguna. Secret yang pernah dibagikan tidak disalin ke repository.

## Endpoint

| Endpoint                       | Perilaku                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| GET `/v1/auth/providers`       | Status ketersediaan login Google tanpa kredensial                                        |
| GET `/v1/auth/google`          | Membuat state dan browser binding, lalu redirect ke Google                               |
| GET `/v1/auth/google/callback` | Memvalidasi callback sekali pakai, menyimpan grant, membuat session cookie               |
| GET `/v1/me`                   | Akun aplikasi dari session cookie                                                        |
| POST `/v1/auth/logout`         | Menghapus sesi aplikasi; body `{}` dan Origin dashboard wajib                            |
| GET `/v1/youtube/broadcasts`   | Siaran live milik grant Google akun yang login; token diperbarui jika hampir kedaluwarsa |

Daftar siaran saat ini memeriksa halaman pertama (maksimal 50 resource) dan mengembalikan `truncated=true` bila ada halaman berikutnya. Client harus menampilkan keterbatasan ini, bukan menyimpulkan tidak ada live stream ketika hasil terpotong. Mapping channel internal dan pagination penuh menjadi bagian integrasi monitoring berikutnya.

## Keamanan dan batas operasional

- Authorization code ditukar hanya di NestJS dengan PKCE S256. State dan cookie browser acak harus cocok, berumur maksimal 10 menit, dan dikonsumsi atomik di PostgreSQL.
- Identitas berdasarkan `sub` dari endpoint Google UserInfo menggunakan access token hasil pertukaran code, bukan email atau account ID kiriman frontend.
- Token dienkripsi dengan AES-256-GCM; authenticated context mengikat token ke akun dan jenis token. Database hanya menyimpan ciphertext dan hash session token.
- Refresh token dipertahankan bila respons Google tidak mengirim pengganti. Refresh bersamaan diserialisasi per akun. Kegagalan grant meminta reconnect, tidak membuka akses development.
- Scope: `openid`, `profile`, dan `youtube.force-ssl` untuk kebutuhan moderasi YouTube yang telah dipilih. Tidak ada tindakan delete/timeout/ban dari endpoint fitur ini.
- API tetap loopback HTTP development. Cookie callback memakai SameSite=Lax; cookie sesi tetap HttpOnly/SameSite=Strict. Produksi memerlukan HTTPS, cookie Secure, revisi host policy, rate limits, serta kebijakan retensi dan pencabutan akses.
- Logout mengakhiri sesi aplikasi, tidak mencabut consent Google. Endpoint disconnect/revoke dan penghapusan grant masih perlu ditambahkan sebelum rilis.
- Tidak ada Google account yang dihubungkan otomatis ke channel development yang di-seed.

## Verifikasi

`npm run typecheck` dan `npm run test:google` memeriksa source checkout secara langsung. Tes Google memakai transport HTTP palsu, tidak mengirim kredensial ke Google. Pengujian PostgreSQL nyata, callback browser, refresh setelah restart, dan akun Google penguji tetap diperlukan sebelum fitur dinyatakan siap digunakan.

Referensi: [OAuth web server Google](https://developers.google.com/identity/protocols/oauth2/web-server), [scope dan refresh token](https://developers.google.com/identity/protocols/oauth2), [liveBroadcasts.list](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/list).
