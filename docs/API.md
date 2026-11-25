# Referensi API

API ini adalah REST API untuk sistem stock opname. Seluruh payload request dan respons memakai JSON, kecuali respons `204 No Content`.

## Konfigurasi cepat

```bash
export BASE_URL="http://localhost:3000"
export EMAIL="manager.jakarta@example.test"
export PASSWORD="password"

# Memerlukan jq untuk mengambil access token dari respons login.
export TOKEN="$(curl -sS -X POST "$BASE_URL/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | jq -r .accessToken)"
```

Dalam environment development yang sudah di-seed, seluruh akun contoh memakai kata sandi `password`. Jangan gunakan kredensial contoh ini di production.

## Konvensi

- **Base URL:** `http://localhost:3000`; seluruh path di bawah sudah mencakup prefix `/api`.
- **Autentikasi:** kecuali login, setiap endpoint memerlukan satu header: `Authorization: Bearer <accessToken>`.
- **Peran:** `MANAGER` dapat membuat mutasi inventori serta memulai/meninjau/menyetujui/menolak sesi. `STAFF` dapat mencadangkan produk, menyimpan draft, dan mengirim hitungan.
- **Kepemilikan toko:** toko ditentukan dari token. Tidak ada `storeId` yang boleh dikirim klien untuk mengakses toko lain.
- **JSON:** endpoint `POST` mengharuskan `Content-Type: application/json`, termasuk endpoint tanpa field body.
- **UUID:** parameter `sessionId`, `productId`, dan `reservationToken` harus UUID.
- **Kuantitas:** `quantity`/`countedQty` adalah string desimal non-negatif, maksimal 11 digit sebelum titik dan 3 digit sesudahnya (contoh: `"12.500"`).

### Format galat

Kegagalan menggunakan format berikut:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request."
  }
}
```

Kode yang mungkin dijumpai: `INVALID_JSON` (400), `VALIDATION_ERROR` (400), `INVALID_TOKEN` (401), `INVALID_CREDENTIALS` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), konflik bisnis (409), dan `INTERNAL_ERROR` (500). Rute yang tidak ada menghasilkan `404 NOT_FOUND`.

---

## Autentikasi

### POST `/api/auth/login`

Login dan memperoleh JWT.

- **Akses:** publik
- **Body:** `email` (email, wajib), `password` (string, wajib)
- **Sukses:** `200 OK` dengan `accessToken`, `expiresIn`, dan `tokenType: "Bearer"`
- **Galat umum:** `400` jika bukan JSON/tidak valid; `401 INVALID_CREDENTIALS` jika kredensial salah.

```bash
curl -sS -X POST "$BASE_URL/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"manager.jakarta@example.test","password":"password"}'
```

### GET `/api/auth/me`

Mengembalikan identitas pengguna yang diautentikasi: `id`, `storeId`, `email`, `name`, dan `role`.

- **Akses:** pengguna terautentikasi
- **Sukses:** `200 OK`

```bash
curl -sS "$BASE_URL/api/auth/me" \
  -H "Authorization: Bearer $TOKEN"
```

### POST `/api/auth/logout`

Mengakhiri sesi pada klien.

- **Akses:** pengguna terautentikasi
- **Sukses:** `204 No Content`
- **Catatan:** token JWT bersifat stateless; token yang sudah diterbitkan tidak direvoke oleh endpoint ini dan tetap berlaku sampai kedaluwarsa.

```bash
curl -i -X POST "$BASE_URL/api/auth/logout" \
  -H "Authorization: Bearer $TOKEN"
```

---

## Katalog dan inventori

### GET `/api/products`

Mencantumkan produk aktif yang tersedia untuk pengguna pada toko tersebut.

- **Akses:** pengguna terautentikasi
- **Sukses:** `200 OK` dengan array produk aktif

```bash
curl -sS "$BASE_URL/api/products" \
  -H "Authorization: Bearer $TOKEN"
```

### GET `/api/inventory`

Mengembalikan saldo inventori toko pengguna saat ini.

- **Akses:** pengguna terautentikasi
- **Sukses:** `200 OK` dengan array saldo produk toko

```bash
curl -sS "$BASE_URL/api/inventory" \
  -H "Authorization: Bearer $TOKEN"
```

### POST `/api/inventory/opening-balance`

Mencatat saldo awal produk.

- **Akses:** `MANAGER`
- **Sukses:** `201 Created` dengan mutasi inventori yang dibuat
- **Body:** lihat [body mutasi inventori](#body-mutasi-inventori); `referenceType` harus `OPENING_BALANCE`.

```bash
curl -sS -X POST "$BASE_URL/api/inventory/opening-balance" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"productId":"11111111-1111-1111-1111-111111111111","quantity":"100","referenceType":"OPENING_BALANCE","referenceId":"opening-2025-01","idempotencyKey":"opening-2025-01-product-1"}'
```

### POST `/api/inventory/receipts`

Mencatat barang masuk.

- **Akses:** `MANAGER`
- **Sukses:** `201 Created` dengan mutasi inventori yang dibuat
- **Body:** lihat [body mutasi inventori](#body-mutasi-inventori); `referenceType` harus `GOODS_RECEIPT`.

```bash
curl -sS -X POST "$BASE_URL/api/inventory/receipts" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"productId":"11111111-1111-1111-1111-111111111111","quantity":"25","referenceType":"GOODS_RECEIPT","referenceId":"gr-2025-001","idempotencyKey":"gr-2025-001-product-1"}'
```

### POST `/api/inventory/stock-outs`

Mencatat barang keluar.

- **Akses:** `MANAGER`
- **Sukses:** `201 Created` dengan mutasi inventori yang dibuat
- **Body:** lihat [body mutasi inventori](#body-mutasi-inventori); `referenceType` harus `STOCK_OUT`.

```bash
curl -sS -X POST "$BASE_URL/api/inventory/stock-outs" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"productId":"11111111-1111-1111-1111-111111111111","quantity":"5","referenceType":"STOCK_OUT","referenceId":"so-2025-001","idempotencyKey":"so-2025-001-product-1"}'
```

#### Body mutasi inventori

| Field | Tipe | Keterangan |
| --- | --- | --- |
| `productId` | UUID | Produk yang dimutasi. |
| `quantity` | string desimal | Kuantitas positif atau nol. |
| `referenceType` | string | Nilainya harus cocok dengan endpoint: `OPENING_BALANCE`, `GOODS_RECEIPT`, atau `STOCK_OUT`. |
| `referenceId` | string (1–200) | Referensi dokumen bisnis. |
| `idempotencyKey` | string (1–200) | Kunci unik agar pengiriman ulang yang sama tidak menduplikasi mutasi. |

---

## Stock opname

Tetapkan variabel berikut dari respons endpoint sebelumnya sebelum menjalankan contoh:

```bash
export SESSION_ID="22222222-2222-2222-2222-222222222222"
export PRODUCT_ID="11111111-1111-1111-1111-111111111111"
export RESERVATION_TOKEN="33333333-3333-3333-3333-333333333333"
```

### GET `/api/stock-opname/sessions`

Mencantumkan sesi stock opname pada toko pengguna.

- **Akses:** pengguna terautentikasi
- **Sukses:** `200 OK`

```bash
curl -sS "$BASE_URL/api/stock-opname/sessions" \
  -H "Authorization: Bearer $TOKEN"
```

### GET `/api/stock-opname/sessions/:sessionId`

Mendapatkan detail sebuah sesi milik toko pengguna.

- **Akses:** pengguna terautentikasi
- **Path:** `sessionId` (UUID)
- **Sukses:** `200 OK`; `404` jika sesi tidak ada atau bukan milik toko pengguna.

```bash
curl -sS "$BASE_URL/api/stock-opname/sessions/$SESSION_ID" \
  -H "Authorization: Bearer $TOKEN"
```

### POST `/api/stock-opname/sessions`

Memulai sesi stock opname baru.

- **Akses:** `MANAGER`
- **Body:** objek JSON kosong (`{}`)
- **Sukses:** `201 Created` dengan sesi baru
- **Konflik:** `409` bila terdapat sesi aktif yang tidak dapat berjalan bersamaan.

```bash
curl -sS -X POST "$BASE_URL/api/stock-opname/sessions" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{}'
```

### POST `/api/stock-opname/sessions/:sessionId/counts/reservations`

Mencadangkan sebuah produk untuk dihitung oleh staf.

- **Akses:** `STAFF`
- **Path:** `sessionId` (UUID)
- **Body:** `productId` (UUID)
- **Sukses:** `201 Created` dengan data reservasi
- **Konflik:** `409` bila produk telah memiliki reservasi aktif.

```bash
curl -sS -X POST "$BASE_URL/api/stock-opname/sessions/$SESSION_ID/counts/reservations" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"productId\":\"$PRODUCT_ID\"}"
```

### POST `/api/stock-opname/sessions/:sessionId/counts/draft`

Menyimpan draft hitungan staf. Setiap produk hanya boleh muncul satu kali dalam satu request.

- **Akses:** `STAFF`
- **Path:** `sessionId` (UUID)
- **Body:** `counts`, array 1–25 item berisi `productId`, `reservationToken`, `draftVersion`, dan `countedQty`.
- **Sukses:** `200 OK`

```bash
curl -sS -X POST "$BASE_URL/api/stock-opname/sessions/$SESSION_ID/counts/draft" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"counts\":[{\"productId\":\"$PRODUCT_ID\",\"reservationToken\":\"$RESERVATION_TOKEN\",\"draftVersion\":\"1\",\"countedQty\":\"42\"}]}"
```

### GET `/api/stock-opname/sessions/:sessionId/review`

Mengambil data review sesi untuk keputusan manajer.

- **Akses:** `MANAGER`
- **Path:** `sessionId` (UUID)
- **Sukses:** `200 OK`

```bash
curl -sS "$BASE_URL/api/stock-opname/sessions/$SESSION_ID/review" \
  -H "Authorization: Bearer $TOKEN"
```

### POST `/api/stock-opname/sessions/:sessionId/approve`

Menyetujui sesi stock opname dan membuat penyesuaian inventori secara atomik.

- **Akses:** `MANAGER`
- **Path:** `sessionId` (UUID)
- **Body:** objek JSON kosong (`{}`)
- **Sukses:** `200 OK`

```bash
curl -sS -X POST "$BASE_URL/api/stock-opname/sessions/$SESSION_ID/approve" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{}'
```

### POST `/api/stock-opname/sessions/:sessionId/reject`

Menolak sesi dan mencatat alasan penolakan.

- **Akses:** `MANAGER`
- **Path:** `sessionId` (UUID)
- **Body:** `reason` (string 1–1000 karakter)
- **Sukses:** `200 OK`

```bash
curl -sS -X POST "$BASE_URL/api/stock-opname/sessions/$SESSION_ID/reject" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"reason":"Perlu penghitungan ulang."}'
```

### POST `/api/stock-opname/sessions/:sessionId/submit`

Mengirim hitungan staf untuk sesi tersebut.

- **Akses:** `STAFF`
- **Path:** `sessionId` (UUID)
- **Body:** objek JSON kosong (`{}`)
- **Sukses:** `200 OK`

```bash
curl -sS -X POST "$BASE_URL/api/stock-opname/sessions/$SESSION_ID/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{}'
```

## Alur `curl` ringkas

1. Login sebagai `MANAGER`, buat sesi, dan simpan `id` responsnya ke `SESSION_ID`.
2. Login sebagai `STAFF`, reserve produk, lalu simpan `reservationToken` ke `RESERVATION_TOKEN`.
3. Dengan token `STAFF`, simpan draft lalu submit sesi.
4. Login kembali sebagai `MANAGER`, review lalu approve atau reject sesi.

Reservasi hitungan kedaluwarsa setelah sepuluh menit. Mutasi inventori untuk produk dengan reservasi aktif diblokir sampai reservasi tidak lagi aktif.
