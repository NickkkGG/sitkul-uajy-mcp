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
| `get_assignment_details` | Membuka satu tugas untuk membaca instruksi, deadline, dan status submission. |
| `list_assignment_attachments` | Mendaftar file lampiran pada deskripsi sebuah tugas. |
| `list_materials` | Menampilkan file, resource Moodle, dan URL materi eksternal (misalnya Canva); URL eksternal menyertakan `targetUrl` bila dapat diresolusikan. |
| `download_material` | Mengunduh file/resource Moodle ke folder `downloads`. Link eksternal perlu dibuka di penyedianya dan dapat meminta login. |
| `canva_connection_status` | Memeriksa apakah OAuth Canva sudah dikonfigurasi dan terhubung di komputer MCP. |
| `connect_canva` | Memulai login OAuth Canva satu kali; tidak pernah menyimpan password Canva. |
| `download_canva_material` | Mengekspor `targetUrl` Canva dari `list_materials` menjadi PDF/PPTX dan mengunduhnya. |
| `submit_assignment_file` | Mengumpulkan file lokal ke tugas Moodle. Wajib `confirm_submit: true`. |
| `submit_assignment_text` | Mengumpulkan teks atau tautan, misalnya link Google Colab. Wajib `confirm_submit: true`. |

`download_material` tidak menimpa file yang sudah ada. Ubah `SITKUL_DOWNLOAD_DIR` bila ingin memakai folder lain.

## Menghubungkan Canva untuk materi link

Materi berbentuk Canva tidak dapat diunduh langsung dari Moodle. Agar `download_canva_material` otomatis, buat aplikasi pribadi di [Canva Developers](https://www.canva.com/developers/), aktifkan OAuth untuk penggunaan **Outside Canva**, lalu daftarkan redirect URL persis seperti ini:

```
http://127.0.0.1:3434/canva/oauth/callback
```

Aktifkan scope `design:content:read` dan `design:meta:read`. Salin Client ID dan Client Secret ke `.env` lokal, lalu buat satu encryption key:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Set key tersebut ke `CANVA_TOKEN_ENCRYPTION_KEY`, jalankan MCP, lalu panggil `connect_canva`. Buka `authorizationUrl` yang dikembalikan, login sendiri, dan setujui akses. Token akses dan refresh token disimpan terenkripsi di `%LOCALAPPDATA%\SitkulUajyMcp\canva-oauth.enc`; token, key, Client Secret, dan `.env` tidak boleh di-commit.

Setelah statusnya `connected: true`, alurnya:

1. Panggil `list_materials`.
2. Ambil `targetUrl` dari materi dengan `kind: "link"`.
3. Panggil `download_canva_material` dengan URL tersebut dan `format: "pdf"` (atau `pptx` bila perlu diedit).

Canva menentukan apakah desain yang dibagikan boleh diekspor. Jika dosen mematikan izin unduh atau akun Canva Anda tidak memiliki akses desain, tool akan mengembalikan kegagalan tanpa mencoba bypass pembatasan tersebut.

## Performa

Pengukuran read-only pada 22 September 2026 untuk membuka detail satu assignment UAJY:

- Sesi baru (login + request pertama): **667 ms**.
- Sesi Moodle yang sudah aktif: **175 ms**.

Pengumpulan teks memerlukan satu request untuk membuka form dan satu request untuk menyimpan. Jadi pada sesi hangat, batas bawah jaringan kira-kira 350 ms; untuk penggunaan nyata, siapkan sekitar 1–3 detik karena pemrosesan Moodle dan kondisi jaringan. Upload file menambahkan waktu transfer file: ukuran file dibagi kecepatan upload internet, ditambah waktu request Moodle tersebut.

Server menyimpan cookie sesi hanya di memori selama proses hidup agar request berikutnya tidak login ulang. Pengukuran tidak menjalankan submission sungguhan karena submit akan mengubah timestamp tugas.

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
