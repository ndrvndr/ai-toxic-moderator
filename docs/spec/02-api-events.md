# Kontrak API dan event v1

Status: spesifikasi wire contract MVP. Saat coding, kontrak ini diterjemahkan menjadi runtime schemas dan OpenAPI, dengan tests yang memeriksa payload API/worker terhadap schema yang sama. Belum ada endpoint aktif.

Implementasi server menggunakan NestJS: controller untuk endpoint, guard untuk session/membership, pipe untuk runtime validation, dan exception filter untuk bentuk error di bawah. Processor @nestjs/bullmq memvalidasi envelope secara eksplisit menggunakan shared schema; pipe HTTP tidak otomatis berlaku pada queue. SSE harus tetap memenuhi kontrak cursor, error sebelum stream dibuka, dan cleanup saat disconnect.

## Aturan bersama

- Prefix `/v1`; JSON UTF-8; waktu ISO 8601 UTC; ID internal UUID.
- Request object menolak field tak dikenal. Batas body 16 KiB. raw_text 1–2.000 Unicode code points dan tidak boleh whitespace-only. external ID 1–128 karakter; display name 1–100; notes maksimal 2.000. Server tidak memangkas/mengubah raw_text yang lolos validasi.
- Semua route channel memerlukan development session dan membership. Tidak ada session → 401; bukan member channel → 403; resource tidak berada di channel yang sudah diizinkan → 404. SSE memeriksa akses pada connect dan secara berkala; pencabutan akses menutup koneksi.
- State mutation memvalidasi Origin terhadap origin dashboard yang dikonfigurasi; CORS tidak wildcard dengan credentials. UI merender message/evidence sebagai teks, bukan HTML.
- Respons membawa `X-Request-Id` (UUID trace server). Error: `{ "error": { "code": "VALIDATION_ERROR", "message": "...", "field_errors": [], "trace_id": "uuid" } }`. field_errors berisi `{field, code}`. Jangan mengirim stack trace atau kredensial.
- Status: 400 JSON/cursor invalid; 401 unauthenticated; 403 forbidden; 404 resource missing; 409 idempotency/session conflict; 413 body terlalu besar; 422 field invalid; 429 rate limit; 503 dependency tidak siap. Error 429 menyertakan Retry-After.

## Resource dan endpoint

| Method/path | Request / query | Respons |
| --- | --- | --- |
| GET `/v1/me` | Session cookie | 200 account + channel memberships |
| GET `/v1/channels/:channel_id/sessions` | limit 1–100 default 20, cursor opsional | 200 items + next_cursor; session memiliki primary_run_id |
| POST `/v1/channels/:channel_id/sessions/:session_id/messages` | Pesan sintetis di bawah | 202 message_id, task_id, status, decision_id nullable, duplicate |
| GET `/v1/channels/:channel_id/tasks/:task_id` | — | 200 status QUEUED/RUNNING/COMPLETED/FAILED, decision_id nullable, last_error_code nullable |
| GET `/v1/channels/:channel_id/decisions` | session_id opsional, outcome opsional, limit 1–100 default 50, cursor opsional | 200 items (DecisionSummary), next_cursor nullable, watermark |
| GET `/v1/channels/:channel_id/decisions/:decision_id` | — | 200 DecisionDetail |
| POST `/v1/channels/:channel_id/decisions/:decision_id/feedback` | Idempotency-Key UUID header + feedback | 201 feedback; retry identik 200 existing |
| GET `/v1/channels/:channel_id/events` | Last-Event-ID header atau after query | 200 text/event-stream |
| GET `/health/live` | — | 200 process alive |
| GET `/health/ready` | — | 200 dependencies ready atau 503; tanpa rahasia/detail jaringan |

Session/channel/account serta bundle dibuat oleh seed development. Tidak ada endpoint publik untuk seed. Status worker, umur task tertua, dan jumlah task gagal diperiksa lewat health internal/CLI development pada milestone ini.

Ringkasan dashboard dihitung dari daftar decision yang sedang dimuat dan harus berlabel “Pada hasil yang ditampilkan”; belum ada agregasi seluruh channel. Filter minimum adalah session dan outcome. Search, kategori, dan analitik global masuk backlog berikutnya.

### Input message

```json
{
  "external_message_id": "fixture-001",
  "author_external_id": "viewer-01",
  "author_display_name": "Penonton demo",
  "raw_text": "ayo daftar judi online di contoh.invalid sekarang",
  "published_at": "2026-09-13T10:00:00.000Z"
}
```

source ditentukan server SYNTHETIC. published_at wajib valid; fixture boleh historis. received_at ditetapkan server. Session tertutup → 409 SESSION_CLOSED. Identitas deduplikasi mengikuti unique message pada schema. Perbandingan hash meliputi semua field input di atas; published_at dikanonisasi UTC sebelum hash. Duplicate identik selalu 202 dengan `duplicate: true` dan status task terbaru; beda isi → 409 IDEMPOTENCY_CONFLICT.

### DecisionSummary

Fields: `id`, `message_id`, `session_id`, `evaluation_run_id`, `created_at`, `author_display_name`, `raw_text`, `outcome`, `primary_category` nullable, `severity` nullable, `confidence` nullable, `reason`, `mode: SIMULATION`, `actions`.

`actions` adalah array `{id, action_type: DELETE, status: SIMULATED}`; kosong untuk ALLOW/REVIEW/ERROR. UI memisahkan badge kategori, severity, outcome, dan status tindakan. Angka confidence null ditampilkan “Belum dikalibrasi”, bukan 0%.

### DecisionDetail

Memuat semua field summary dan:

- `message`: `{id, external_message_id, author_external_id, raw_text, published_at, received_at}`.
- `reason_code`: enum demo NO_RULE_MATCH, CONTEXT_REQUIRED, GAMBLING_PROMOTION, DIRECT_INSULT, PROCESSING_FAILED.
- `representations`: array `{type, text, processor_version, mapping_quality}`. type MVP RAW/NORMALIZED; mapping_quality EXACT/UNAVAILABLE.
- `signals`: array `{rule_id, rule_version, category, severity, strength, confidence, intent, evidence}`. severity 0–4; strength STRONG/AMBIGUOUS; confidence null untuk demo.
- `evidence`: array di setiap signal, berisi `{representation_type, matched_text, normalized_span, raw_span, mapping_quality}`. Span `{start, end}` memakai offset UTF-16, half-open `[start,end)` agar sama dengan slicing JavaScript. raw_span nullable; jika tidak presisi, null dengan mapping_quality UNAVAILABLE. Tidak boleh menebak posisi.
- `risk_snapshot`: `{content_risk, intent_risk, behavior_risk, context_risk, availability}`. Skor numerik belum dihitung MVP; semua nilai null dan availability NOT_EVALUATED. Rule/policy trace tetap menjelaskan hasil tanpa skor buatan.
- `version_bundle`: `{schema_version: 1, configuration_bundle_id, processor_version, ruleset_version, policy_version, model: {status: DISABLED, version: null}}`.
- `feedback`: array record `{id, label, corrected_category, corrected_outcome, notes, reviewer: {id, display_name}, created_at}`.

Normalisasi MVP: Unicode NFKC → lowercase → whitespace normalization. Span map harus menangani perubahan panjang Unicode; bila tidak tersedia, evidence normalized tetap ditampilkan tanpa raw highlight. Leetspeak, compact candidates, dan bahasa campuran lanjut ditunda.

ERROR menyimpan arrays representations/signals kosong bila pipeline belum menghasilkan snapshot; risk NOT_EVALUATED; reason aman, tanpa stack trace. Versi tetap berasal dari bundle pinned.

### Feedback

```json
{
  "label": "FALSE_POSITIVE",
  "corrected_category": null,
  "corrected_outcome": "ALLOW",
  "notes": "Pesan sedang mengutip contoh, bukan menghina."
}
```

Field label wajib; field lainnya optional/null kecuali conditional validation pada schema database. corrected_category, bila ada, memakai taxonomy blueprint: PROFANITY, HARASSMENT, HATE, THREAT, SEXUAL, GAMBLING, SPAM, SCAM, PII, SELF_HARM_ENCOURAGEMENT, IMPERSONATION, SUSPICIOUS_LINK. UI boleh menerima koreksi kategori yang detektornya belum tersedia tanpa mengklaim kategori itu didukung.

Idempotency key berlaku per channel dan reviewer. Hash meliputi decision_id serta body kanonis, sehingga key yang dipakai untuk decision/body berbeda menghasilkan 409. Feedback append-only; koreksi berikutnya memakai key baru. Feedback tidak mengubah outcome atau tindakan otomatis, dan reviewer diambil dari session.

## Queue contract

Envelope `chat.accepted`:

```json
{
  "event_id": "11111111-1111-4111-8111-111111111111",
  "event_type": "chat.accepted",
  "schema_version": 1,
  "channel_id": "22222222-2222-4222-8222-222222222222",
  "session_id": "33333333-3333-4333-8333-333333333333",
  "trace_id": "44444444-4444-4444-8444-444444444444",
  "occurred_at": "2026-09-13T10:00:00.000Z",
  "payload": {
    "message_id": "55555555-5555-4555-8555-555555555555",
    "task_id": "66666666-6666-4666-8666-666666666666",
    "evaluation_run_id": "77777777-7777-4777-8777-777777777777"
  }
}
```

Queue MVP hanya `moderation.process`, job name `chat.accepted`, jobId event_id. Worker memvalidasi schema, mengambil resource database, dan memastikan semua channel/session/run cocok. Raw text tidak disalin ke queue. Action SIMULATED ditulis dalam transaksi decision tanpa action worker; `action.execute` baru diaktifkan ketika fase provider dimulai.

Maksimum 5 attempts total, exponential backoff basis 1 detik dan jitter 0–50%; concurrency awal 2. Nilai berada pada konfigurasi development. Error kontrak permanen tidak diulang; incident tersimpan dengan event ID. Worker log structured: trace_id/message_id/task_id/decision_id, tanpa raw text secara default.

Reconciler memeriksa task nonterminal yang tidak memiliki job aktif/tertunda dan mencoba enqueue ulang dengan identitas task yang sama. Jangan menyimpulkan job hilang hanya dari usia task. Task yang sedang dikerjakan mengikuti mekanisme lock/renewal worker; shutdown berhenti menerima kerja baru dan menunggu pekerjaan aktif secara terbatas. Persistent DB errors tidak boleh diubah menjadi decision palsu yang seolah berhasil disimpan.

## SSE, pagination, dan reconnect

Jenis event MVP: `moderation.created`, `feedback.created`, `resync.required`. Event resource membawa event_id, channel_id, session_id, resource_id, occurred_at dan schema_version. `resource_id` untuk feedback event menunjuk decision yang perlu di-refresh. Body tidak berisi raw chat.

SSE `id` adalah sequence per channel, dikirim sebagai string desimal agar tidak terkena batas presisi integer JavaScript. Event ID UUID berbeda dari cursor sequence.

```text
id: 42
event: moderation.created
data: {"schema_version":1,"event_id":"88888888-8888-4888-8888-888888888888","channel_id":"22222222-2222-4222-8222-222222222222","session_id":"33333333-3333-4333-8333-333333333333","resource_id":"99999999-9999-4999-8999-999999999999","occurred_at":"2026-09-13T10:00:01.000Z"}

```

1. Feed GET membaca rows dan watermark dari snapshot database yang konsisten; urutan created_at DESC lalu id DESC.
2. Client membuka SSE dengan `after=watermark`. Browser reconnect memakai Last-Event-ID; header ini menang atas query after yang lama.
3. Server mengirim event persisted dengan sequence lebih besar secara ascending. Keepalive comment setiap 15 detik; pembacaan DB mengikuti polling ringan yang dibatasi.
4. Client deduplikasi event, invalidate/query cache keputusan dengan filter aktif, dan mencegah fetch yang lama menimpa state baru.
5. Cursor tak berlaku karena reset/retensi → kirim `resync.required`, tutup stream; client ambil snapshot dan cursor baru. Cursor malformed → 400.
6. Reconnect memakai backoff 1–30 detik dengan jitter; reset setelah koneksi stabil. Connection state CONNECTING/LIVE/RECONNECTING/OFFLINE terlihat di UI.
7. Pause menahan insertion tampilan maksimal 200 event references. Overflow memicu refresh snapshot saat resume. Detail yang terbuka dan posisi scroll tidak dipindah otomatis.

REST cursor berupa opaque encoding tuple created_at/id + filter + watermark snapshot, divalidasi server. Pagination membatasi decision pada watermark snapshot tersebut melalui join feed_events `moderation.created` berdasarkan resource_id, sehingga event baru tidak menyusup ke halaman lama. Cursor bukan kredensial akses. `next_cursor: null` berarti halaman terakhir. Filter berubah membuang cursor lama. Pagination sessions menggunakan tuple created_at/id tanpa watermark karena session seeded dan tidak berubah pada MVP.
