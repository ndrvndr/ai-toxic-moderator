export default function Home() {
  return (
    <main>
      <header>
        <span className="brand">ATM / MODERATION CONSOLE</span>
        <span className="badge">SIMULASI LOKAL</span>
      </header>
      <section>
        <p className="eyebrow">MILESTONE 01 · FOUNDATION</p>
        <h1>
          Moderasi yang
          <br />
          bisa dijelaskan.
        </h1>
        <p className="intro">
          Fondasi project sudah disiapkan. Pipeline deteksi dan live feed akan dihubungkan pada
          tahap implementasi berikutnya.
        </p>
      </section>
      <div className="grid">
        <article>
          <span>01 / API</span>
          <h2>NestJS</h2>
          <p>Proses API terpisah dengan pemeriksaan liveness dan koneksi database.</p>
        </article>
        <article>
          <span>02 / DATA</span>
          <h2>PostgreSQL</h2>
          <p>Schema berversi untuk pesan, keputusan, evidence, feedback, dan audit.</p>
        </article>
        <article>
          <span>03 / PROCESSING</span>
          <h2>Worker foundation</h2>
          <p>Struktur NestJS dan BullMQ tersedia. Consumer moderasi belum diaktifkan.</p>
        </article>
      </div>
      <aside>
        <strong>Belum ada pesan yang diproses</strong>
        <p>
          Layar ini adalah app shell. Tidak ada koneksi YouTube, prediksi model, atau tindakan
          moderasi nyata.
        </p>
      </aside>
      <footer>Next.js / NestJS / PostgreSQL / Redis</footer>
    </main>
  );
}
