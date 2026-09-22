# Sitkul UAJY MCP

MCP pribadi untuk mahasiswa UAJY di `https://kuliah.uajy.ac.id`. Server ini masuk ke Moodle menggunakan akun yang ada di komputer pemilik server, lalu menyediakan alat untuk:

- melihat mata kuliah dan tugas;
- mengecek deadline tugas;
- melihat serta mengunduh materi;
- mengumpulkan file ke tugas Moodle.

Server **tidak** memberi akses lebih dari role Moodle Anda. Akun student tidak boleh menambah atau mengubah materi kelas; karena itu tindakan unggah yang tersedia adalah mengumpulkan file ke assignment yang memang terbuka untuk akun tersebut.

## Persiapan

Butuh Node.js 22+.

```powershell
npm install
Copy-Item .env.example .env
```

Isi `.env` dengan akun LMS sendiri. File itu sudah diabaikan Git, jadi jangan pernah mengirim atau commit file tersebut.

```dotenv
SITKUL_USERNAME=your_student_number
SITKUL_PASSWORD=your_password
```

Jalankan pemeriksaan tipe dan build:

```powershell
npm run check
npm run build
```

## Tools yang tersedia

| Tool | Fungsi |
| --- | --- |
| `list_courses` | Menampilkan kelas yang Anda ikuti. |
| `list_assignments` | Menampilkan activity tugas, per kelas atau semua kelas. |
| `list_deadlines` | Membuka setiap halaman tugas dan mengurutkan deadline terdekat. |
| `list_materials` | Menampilkan file materi dari sebuah kelas. |
| `download_material` | Mengunduh URL hasil `list_materials` ke folder `downloads`. |
| `submit_assignment_file` | Mengumpulkan file lokal ke tugas Moodle. Wajib `confirm_submit: true`. |

`download_material` tidak menimpa file yang sudah ada. Ubah `SITKUL_DOWNLOAD_DIR` bila ingin memakai folder lain.

## Menjalankan secara lokal

Untuk klien MCP yang mendukung stdio:

```powershell
npm run dev
```

Konfigurasi contoh:

```json
{
  "mcpServers": {
    "sitkul-uajy": {
      "command": "npm",
      "args": ["run", "dev"],
      "cwd": "C:\\Users\\nickn\\OneDrive\\Documents\\Semester 5\\SITKUL MCP"
    }
  }
}
```

## Memakai di ChatGPT

ChatGPT membutuhkan server MCP yang dapat dijangkau melalui HTTPS. Untuk penggunaan pribadi yang aman, jalankan endpoint lokal lalu hubungkan memakai **Secure MCP Tunnel**—bukan membuka password mahasiswa ke internet.

```powershell
npm run dev:http
```

Endpoint lokalnya adalah `http://127.0.0.1:3000/mcp`. Buat tunnel di OpenAI Platform dan jalankan `tunnel-client` pada komputer yang sama; kemudian di ChatGPT aktifkan Developer Mode, buka Plugins, tambahkan koneksi, dan pilih tunnel tersebut. Panduan resmi: [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels?site_locale=en) dan [connect & test a plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt?site_locale=en).

Jika endpoint ingin dipublikasikan untuk banyak mahasiswa, jangan gunakan `.env` bersama. Server harus ditambah OAuth dan penyimpanan sesi terenkripsi per pengguna terlebih dahulu.

## Batasan yang perlu diuji dengan akun Anda

Portal UAJY memakai Moodle dan tool dibangun untuk alur Moodle standar. Tampilan atau aturan dari dosen dapat berbeda, misalnya tugas tanpa file submission, tugas tertutup, atau batas ukuran file. Setelah menambahkan `.env`, uji `list_courses`, lalu satu tugas dan satu materi yang tidak sensitif sebelum dipakai untuk deadline penting. Selalu verifikasi status dan timestamp pengumpulan akhir di Moodle.
