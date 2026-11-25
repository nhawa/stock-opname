# Rencana Dokumentasi API

## Cakupan yang terinventarisasi

- Base URL lokal: `http://localhost:3000`
- Format: REST JSON, prefix `/api`
- Autentikasi: `Authorization: Bearer <accessToken>`
- Endpoint yang ditemukan: 17
  - Auth: `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`
  - Inventori: `GET /api/products`, `GET /api/inventory`, serta 3 endpoint mutasi
  - Stock opname: 9 endpoint sesi, penghitungan, dan persetujuan

## Rencana

- [ ] Buat `docs/API.md` sebagai referensi tunggal API.
- [ ] Jelaskan URL dasar, header JSON, Bearer token, peran `MANAGER`/`STAFF`, aturan lintas toko, dan format galat.
- [ ] Dokumentasikan semua 17 endpoint menurut domain, lengkap dengan otorisasi, parameter, body, kode status, dan contoh respons bila tersedia dari implementasi.
- [ ] Tambahkan contoh `curl` siap salin untuk setiap endpoint, termasuk alur autentikasi dan penggunaan variabel shell (`BASE_URL`, `TOKEN`, `SESSION_ID`, `PRODUCT_ID`).
- [ ] Verifikasi semua path, method, role, skema request, dan status respons terhadap implementasi serta test integrasi.

## Keputusan dokumentasi

- Request body tanpa properti yang diperlukan akan ditampilkan sebagai `{}` namun contoh `curl` tetap mengirim `Content-Type: application/json` karena handler mewajibkan JSON.
- Contoh akan menggunakan UUID placeholder agar tidak memasukkan data sensitif atau kredensial produksi.
- Dokumentasi akan membedakan akses umum terautentikasi dari endpoint khusus `MANAGER` atau `STAFF`.
