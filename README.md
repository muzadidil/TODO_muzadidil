# TaskFlow — TODO App

Aplikasi manajemen tugas berbasis web, disusun per proyek, dengan sub-tugas bertingkat, pelacakan progres otomatis, dan export laporan PDF profesional. Data tersimpan real-time di Firebase Firestore.

🔗 Live: [todo.zasha.online](https://todo.zasha.online)

## Fitur

- **Gerbang password** — halaman `gate.html` meminta password sebelum masuk ke aplikasi (proteksi sisi klien, session-based).
- **Manajemen proyek**
  - Buat/hapus proyek dari sidebar.
  - Filter tugas per proyek, per "Semua Proyek", atau "Tanpa Proyek".
  - Setiap proyek menampilkan persentase progresnya langsung di sidebar.
- **Sub-tugas bertingkat tanpa batas**
  - Setiap tugas bisa punya sub-tugas.
  - Setiap sub-tugas bisa punya sub-tugas lagi di dalamnya (nested), sedalam apa pun.
- **Progres otomatis**
  - Setiap tugas utama menampilkan bar + persentase progres berdasarkan sub-tugas yang selesai (dihitung dari seluruh level nested).
  - Statistik atas (Total, Belum Selesai, Selesai, Progress) dan progress card di sidebar mengikuti rata-rata persentase ini.
- **Master Proyek (template)** — tombol **Master** menyimpan template tahapan pekerjaan (mis. *Laravel 12*: MVC, Building, Migrasi, Testing, Deploy, Domain) lengkap dengan rincian bertingkat, harga, dan deskripsi.
  - **Gunakan** master → setiap tahapan menjadi tugas dan rinciannya menjadi sub-tugas, di proyek yang sudah ada atau proyek baru.
  - **Jadikan master dari proyek** → struktur proyek yang sedang aktif disalin menjadi master baru.
- **Rincian harga (Rupiah)** — harga bisa diisi di tugas maupun sub-tugas (lewat tombol ubah). Jika rincian di bawahnya diberi harga, harga induk otomatis = jumlah rinciannya (tidak dobel hitung). Nilai proyek tampil di judul proyek.
- **Deskripsi** — tombol deskripsi (ikon garis) di setiap tugas & sub-tugas untuk penjelasan panjang; deskripsi panjang diringkas 3 baris dan bisa dibuka penuh.
- **Kategori & prioritas** — Kerja / Pribadi / Belajar / Bug, dan Tinggi / Sedang / Rendah. Kategori **Bug** dipakai untuk pencatatan bug — tetap berupa tugas biasa (todo) sehingga otomatis ikut terhitung di statistik, progres, dan export PDF.
- **Deadline & link opsional** per tugas maupun per sub-tugas, dengan badge status (normal / mendekati deadline / terlambat).
- **Pencarian, filter, dan pengurutan** — cari berdasarkan teks, filter berdasarkan status/kategori/prioritas, urutkan berdasarkan terbaru/terlama/prioritas/tenggat waktu.
- **Filter navigasi cepat** — Semua Tugas, Hari Ini, Belum Selesai, Selesai, Terlambat.
- **Export laporan PDF profesional**
  - Klik tombol **Export PDF** → muncul pilihan:
    1. **Seluruh Proyek** — satu laporan berisi semua proyek, dikelompokkan per proyek beserta persentase masing-masing.
    2. **Per Proyek** — pilih satu proyek tertentu dari dropdown untuk dilaporkan terpisah.
  - Isi laporan: header dengan nama proyek & tanggal, bar progres keseluruhan, ringkasan jumlah tugas (Total/Selesai/Proses/Belum Mulai), serta tabel detail tugas (kategori, prioritas, deadline, status, persentase) termasuk sub-tugasnya.
- **Laporan WhatsApp untuk klien** — tombol **WA** menyalin laporan resmi: judul proyek & tahapan **tebal**, rincian normal, rincian di bawahnya *miring*, pekerjaan selesai ~dicoret~, istilah asing (*deploy*, *testing*, *dashboard*, ...) otomatis *miring*, plus ikon status (✅ 🔄 ⏳), bar progres, dan ringkasan. Opsional: sertakan rincian harga dan/atau deskripsi.
  - Kata asing yang belum dikenali bisa dimiringkan manual dengan menulis `_kata_` pada teks tugas.
- **Tema terang-sedang** — palet warna gelap yang nyaman dibaca (bukan hitam pekat), dengan aksen biru periwinkle.
- **Real-time sync** — semua perubahan (tugas, sub-tugas, proyek) langsung tersimpan dan tersinkron via Firestore `onSnapshot`, tanpa perlu refresh.

## Struktur Proyek

```
├── index.html          # Halaman utama aplikasi (dashboard tugas)
├── gate.html            # Halaman gerbang password sebelum masuk aplikasi
├── app.js                # Seluruh logika aplikasi (state, render, CRUD, export PDF)
├── firebase-config.js    # Konfigurasi & inisialisasi Firebase
├── style.css             # Seluruh styling aplikasi
└── CNAME                 # Konfigurasi custom domain (todo.zasha.online)
```

## Cara Menjalankan

Aplikasi ini murni HTML/CSS/JS (tanpa build step) dan memakai Firebase Firestore sebagai backend, jadi cukup dibuka lewat web server statis:

```bash
# contoh dengan XAMPP: taruh folder ini di htdocs, lalu akses via
http://localhost/TODO_muzadidil/gate.html
```

Password default gerbang ada di `gate.html` (variabel `PASSWORD`).

## Firebase

Project Firestore: **todo-muza** (lihat `firebase-config.js`).

Collection yang digunakan:

| Collection  | Deskripsi                                   |
|-------------|----------------------------------------------|
| `tasks`     | Seluruh tugas utama beserta sub-tugas (nested tree di field `subtasks`), kategori, prioritas, deadline, link, `price`, `description`, status selesai, dan `projectId`. |
| `projects`  | Daftar proyek (`name`, `createdAt`).          |
| `masters`   | Master Proyek (`name`, `stages`: tree `{ text, price, description, children }`). |

### Firestore Rules

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /tasks/{taskId} {
      allow read, write: if true;
    }
    match /projects/{projectId} {
      allow read, write: if true;
    }
    match /masters/{masterId} {
      allow read, write: if true;
    }
  }
}
```

> ⚠️ Rules ini bersifat terbuka penuh (tanpa autentikasi) — konsisten dengan proteksi sisi klien di `gate.html`. Cukup untuk kebutuhan internal/personal saat ini, namun bukan konfigurasi yang disarankan untuk data sensitif multi-pengguna publik.

## Teknologi

- Vanilla JavaScript (ES Modules), tanpa framework/bundler.
- [Firebase Firestore](https://firebase.google.com/docs/firestore) — database real-time.
- [jsPDF](https://github.com/parallax/jsPDF) + [jsPDF-AutoTable](https://github.com/simonbengtsson/jsPDF-AutoTable) (via CDN) — generator laporan PDF.

## Deployment

Static hosting apa pun bisa dipakai (GitHub Pages, dsb.), sudah dikonfigurasi dengan custom domain via file `CNAME` → `todo.zasha.online`.
