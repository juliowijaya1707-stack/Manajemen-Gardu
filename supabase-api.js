// ============================================================
//  PLN UP3 JAYAPURA — Supabase API Layer
//  File: supabase-api.js
//
//  Menggantikan semua panggilan AppScript (apiGet/API_URL)
//  dengan query langsung ke Supabase REST API.
//
//  CARA PAKAI: include sebelum </body> di index.html
//  <script src="supabase-api.js"></script>
// ============================================================

// ── KONFIGURASI — GANTI INI ─────────────────────────────────
var SUPABASE_URL  = 'https://lrjpdcyyaxcfdpzxygrj.supabase.co';   // ← ganti
var SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxyanBkY3l5YXhjZmRwenh5Z3JqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg1NDI4MzcsImV4cCI6MjA5NDExODgzN30.BgplnVYogpr5qRQ2pITNLuC4iw7AzuR_rikuxSM7Dxo';          // ← ganti anon key

// ── SHA-256 helper (sama dengan AppScript hashPassword) ──────
async function sha256(str) {
  var buf = await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(String(str)));
  return Array.from(new Uint8Array(buf))
    .map(function(b){ return ('0'+b.toString(16)).slice(-2); }).join('');
}

// ── Supabase REST helper ─────────────────────────────────────
function sbFetch(path, opts) {
  opts = opts || {};
  var headers = Object.assign({
    'apikey':        SUPABASE_ANON,
    'Authorization': 'Bearer ' + SUPABASE_ANON,
    'Content-Type':  'application/json',
    'Prefer':        opts.prefer || ''
  }, opts.headers || {});
  return fetch(SUPABASE_URL + path, {
    method:  opts.method  || 'GET',
    headers: headers,
    body:    opts.body    || undefined,
    signal:  opts.signal  || undefined
  });
}

// ── RPC helper (panggil stored function Supabase) ────────────
function sbRpc(funcName, params, signal) {
  return sbFetch('/rest/v1/rpc/' + funcName, {
    method: 'POST',
    body:   JSON.stringify(params || {}),
    signal: signal
  });
}

// ── apiCall: pengganti apiGet() — async wrapper ──────────────
// Dipanggil dari fungsi-fungsi di index.html via apiGet()
function apiCall(action, params, cb) {
  var controller = new AbortController();
  var done = false;
  var timer = setTimeout(function(){
    if (done) return;
    done = true;
    controller.abort();
    cb({ status:'error', message:'Koneksi timeout. Periksa jaringan lalu coba lagi.' });
  }, 30000);

  function finish(result) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    cb(result);
  }

  _dispatch(action, params, controller.signal)
    .then(finish)
    .catch(function(err){
      if (done) return;
      finish({ status:'error',
        message: err.name === 'AbortError'
          ? 'Koneksi timeout. Periksa jaringan lalu coba lagi.'
          : 'Gagal menghubungi server. (' + err.message + ')' });
    });
}

// ── Router: map action → handler ─────────────────────────────
async function _dispatch(action, p, signal) {
  switch(action) {
    case 'loginUser':        return _login(p, signal);
    case 'verifyToken':      return _verifyToken(p, signal);
    case 'getDaftarGardu':   return _getDaftarGardu(p, signal);
    case 'getDetailLengkap': return _getDetailLengkap(p, signal);
    case 'getDetailGardu':   return _getDetailGardu(p, signal);
    case 'getTrenBeban':     return _getTrenBeban(p, signal);
    case 'getRekap':         return _getRekap(p, signal);
    case 'getGarduKritis':   return _getGarduKritis(p, signal);
    case 'getExportRekap':   return _getExportRekap(p, signal);
    case 'verifyPin':        return _verifyPin(p, signal);
    case 'setPin':           return _setPin(p, signal);
    case 'tambahGardu':      return _tambahGardu(p, signal);
    case 'editGardu':        return _editGardu(p, signal);
    case 'getDaftarUser':    return _getDaftarUser(p, signal);
    case 'hapusUser':        return _hapusUser(p, signal);
    case 'cariGardu':        return _cariGardu(p, signal);
    default: return { status:'error', message:'Action tidak dikenali: '+action };
  }
}

// ── HELPER: ambil user dari session token ────────────────────
async function _getUserFromToken(token) {
  var res = await sbRpc('fn_verify_token', { p_token: token });
  if (!res.ok) return null;
  var data = await res.json();
  if (!data || data.status !== 'ok') return null;
  return data;
}

// ── LOGIN ────────────────────────────────────────────────────
async function _login(p, signal) {
  var pwHash = await sha256(String(p.password || '').trim());
  var res = await sbRpc('fn_login', {
    p_username:      String(p.username || '').trim(),
    p_password_hash: pwHash
  }, signal);
  if (!res.ok) return { status:'error', message:'Server error '+res.status };
  var data = await res.json();
  if (!data || data.status !== 'ok') return { status:'error', message: data.message || 'Login gagal.' };
  return {
    status: 'ok',
    token:  data.token,
    user:   {
      username: data.user.username,
      nama:     data.user.nama,
      role:     data.user.role,
      ulp:      data.user.ulp || ''
    }
  };
}

// ── VERIFY TOKEN ─────────────────────────────────────────────
async function _verifyToken(p, signal) {
  var data = await _getUserFromToken(p.token);
  if (!data) return { status:'error', message:'Sesi tidak valid.' };
  return { status:'ok', user: data };
}

// ── DAFTAR GARDU (dengan info inspeksi terakhir) ─────────────
async function _getDaftarGardu(p, signal) {
  // Gunakan view v_gardu_lengkap — sudah include last inspeksi
  var url = '/rest/v1/v_gardu_lengkap?select=*&order=no_gardu.asc';
  if (p && p.ulp) url += '&ulp=eq.' + encodeURIComponent(p.ulp);
  var res = await sbFetch(url, { signal: signal });
  if (!res.ok) return { status:'error', message:'Gagal memuat daftar gardu ('+res.status+')' };
  var rows = await res.json();

  var data = rows.map(function(g){
    return {
      'NO_GARDU':            g.no_gardu || '',
      'ULP':                 g.ulp      || '',
      'UNITUP':              g.unitup   || '',
      'PENYULANG':           g.penyulang|| '',
      'ALAMAT':              g.alamat   || '',
      'KAPASITAS_KVA':       g.kapasitas_kva || '',
      'TIPE':                g.tipe     || '',
      'STATUS_OPERASIONAL':  g.status_operasional || '',
      'STATUS_KEPEMILIKAN':  g.status_kepemilikan || '',
      '_lastInspeksi':       g.last_inspeksi_tgl  || '',
      '_lastPetugas':        g.last_inspeksi_petugas || '',
      '_lastBeban':          g.last_prosen != null ? String(g.last_prosen) : '',
      '_totalInspeksi':      g.total_inspeksi || 0,
      'LATITUDE':            g.latitude  || '',
      'LONGITUDE':           g.longitude || '',
      'KETERANGAN':          g.keterangan|| ''
    };
  });

  return { status:'ok', data: data, _generatedAt: new Date().toLocaleTimeString('id-ID') };
}

// ── DETAIL GARDU + RIWAYAT INSPEKSI ─────────────────────────
async function _getDetailLengkap(p, signal) {
  var noGardu = (p.noGardu || '').trim().toUpperCase();

  // Ambil data gardu
  var resG = await sbFetch('/rest/v1/gardu?no_gardu=eq.' + encodeURIComponent(noGardu) + '&limit=1', { signal: signal });
  if (!resG.ok) return { status:'error', message:'Gagal memuat data gardu.' };
  var garduArr = await resG.json();
  if (!garduArr || !garduArr.length) return { status:'error', message:'Gardu tidak ditemukan: '+noGardu };
  var g = garduArr[0];

  // Ambil riwayat inspeksi (20 terbaru)
  var resI = await sbFetch(
    '/rest/v1/inspeksi?no_gardu=eq.' + encodeURIComponent(noGardu) +
    '&order=tgl_ukur.desc,jam_ukur.desc&limit=20',
    { signal: signal }
  );
  var riwayatRaw = resI.ok ? await resI.json() : [];

  // Map gardu ke format lama (kompatibel dengan renderDetailGardu)
  var garduData = _mapGarduRow(g);

  // Map riwayat ke format lama
  var riwayat = riwayatRaw.map(function(r){ return _mapInspeksiRow(r); });

  return { status:'ok', data: garduData, riwayat: riwayat };
}

// ── DETAIL GARDU SAJA (tanpa riwayat, untuk form edit) ───────
async function _getDetailGardu(p, signal) {
  var noGardu = (p.noGardu || '').trim().toUpperCase();
  var res = await sbFetch('/rest/v1/gardu?no_gardu=eq.' + encodeURIComponent(noGardu) + '&limit=1', { signal: signal });
  if (!res.ok) return { status:'error', message:'Gagal memuat data gardu.' };
  var arr = await res.json();
  if (!arr || !arr.length) return { status:'error', message:'Gardu tidak ditemukan: '+noGardu };
  return { status:'ok', data: _mapGarduRow(arr[0]) };
}

// ── TREN BEBAN ───────────────────────────────────────────────
async function _getTrenBeban(p, signal) {
  var noGardu = (p.noGardu || '').trim().toUpperCase();
  var res = await sbFetch(
    '/rest/v1/inspeksi?no_gardu=eq.' + encodeURIComponent(noGardu) +
    '&select=tgl_ukur,prosen&order=tgl_ukur.asc&limit=100',
    { signal: signal }
  );
  if (!res.ok) return { status:'error', message:'Gagal memuat tren beban.' };
  var rows = await res.json();
  var data = rows
    .filter(function(r){ return r.prosen != null; })
    .map(function(r){ return { tgl: r.tgl_ukur, prosen: parseFloat(r.prosen) }; });
  return { status:'ok', data: data };
}

// ── REKAP DASHBOARD ──────────────────────────────────────────
async function _getRekap(p, signal) {
  var url = '/rest/v1/v_rekap_dashboard?select=*';
  if (p && p.ulp) url += '&ulp=eq.' + encodeURIComponent(p.ulp);
  var res = await sbFetch(url, { signal: signal });
  if (!res.ok) return { status:'error', message:'Gagal memuat rekap.' };
  var rows = await res.json();

  // Agregat semua ULP jadi satu objek
  var totalGardu = 0, aktif = 0, nonAktif = 0, inspeksiBulan = 0, sudahInspeksi = 0;
  var perULP = {};
  var bulanKey = new Date().toISOString().slice(0,7);

  // Hitung sudahInspeksi: gardu yang punya >= 1 inspeksi
  var resInsp = await sbFetch(
    '/rest/v1/inspeksi?select=no_gardu&order=no_gardu.asc',
    { signal: signal }
  );
  var inspRows = resInsp.ok ? await resInsp.json() : [];
  var garduDgInspeksi = new Set(inspRows.map(function(r){ return r.no_gardu; }));

  rows.forEach(function(r){
    totalGardu     += r.total_gardu     || 0;
    aktif          += r.gardu_aktif     || 0;
    nonAktif       += r.gardu_nonaktif  || 0;
    inspeksiBulan  += r.inspeksi_bulan_ini || 0;
    perULP[r.ulp] = {
      total:    r.total_gardu    || 0,
      inspeksi: r.inspeksi_bulan_ini || 0,
      overdue:  r.gardu_overload || 0
    };
  });

  // Hitung overdue: gardu yang last inspeksi > 90 hari atau belum pernah
  var resLastInsp = await sbFetch(
    '/rest/v1/v_gardu_lengkap?select=no_gardu,last_inspeksi_tgl',
    { signal: signal }
  );
  var lastInspRows = resLastInsp.ok ? await resLastInsp.json() : [];
  var overdue90 = 0;
  var now = new Date();
  lastInspRows.forEach(function(r){
    if (!r.last_inspeksi_tgl) { overdue90++; return; }
    var hari = Math.floor((now - new Date(r.last_inspeksi_tgl)) / 86400000);
    if (hari > 90) overdue90++;
  });

  sudahInspeksi = garduDgInspeksi.size;
  var belumInspeksi = totalGardu - sudahInspeksi;

  // Rekap beban
  var resBeban = await sbFetch(
    '/rest/v1/inspeksi?select=no_gardu,prosen&order=no_gardu.asc,tgl_ukur.desc',
    { signal: signal }
  );
  var bebanRows = resBeban.ok ? await resBeban.json() : [];
  var seenBeban = {};
  var bNormal = 0, bLebih = 0, bNoData = 0;
  bebanRows.forEach(function(r){
    if (seenBeban[r.no_gardu]) return;
    seenBeban[r.no_gardu] = true;
    var pb = parseFloat(r.prosen);
    if (isNaN(pb)) bNoData++;
    else if (pb > 80) bLebih++;
    else bNormal++;
  });

  // 10 inspeksi terbaru
  var resTerbaru = await sbFetch(
    '/rest/v1/inspeksi?select=no_gardu,tgl_ukur,jam_ukur,petugas,prosen,penyulang,alamat' +
    '&order=tgl_ukur.desc,jam_ukur.desc&limit=10',
    { signal: signal }
  );
  var terbaruRows = resTerbaru.ok ? await resTerbaru.json() : [];
  var terbaru = terbaruRows.map(function(r){
    return {
      noGardu:  r.no_gardu  || '',
      tanggal:  r.tgl_ukur  || '',
      jam:      r.jam_ukur  || '',
      petugas:  r.petugas   || '',
      prosen:   r.prosen    != null ? parseFloat(r.prosen) : null,
      penyulang:r.penyulang || '',
      alamat:   r.alamat    || ''
    };
  });

  return {
    status: 'ok',
    data: {
      totalGardu:   totalGardu,
      aktif:        aktif,
      nonAktif:     nonAktif,
      sudahInspeksi:sudahInspeksi,
      belumInspeksi:belumInspeksi,
      overdue90:    overdue90,
      bulanIni:     inspeksiBulan,
      perULP:       perULP,
      bebanCount: {
        'Normal (<=80%)':  bNormal,
        'Lebih (>80%)':    bLebih,
        'Tidak Ada Data':  bNoData
      },
      terbaru: terbaru
    }
  };
}

// ── GARDU KRITIS ─────────────────────────────────────────────
async function _getGarduKritis(p, signal) {
  // Beban lebih: ambil last inspeksi per gardu dengan prosen > 80
  var resG = await sbFetch(
    '/rest/v1/v_gardu_lengkap?select=no_gardu,ulp,penyulang,last_prosen,last_inspeksi_tgl' +
    '&last_prosen=gt.80&order=last_prosen.desc&limit=100',
    { signal: signal }
  );
  var bebanLebih = [];
  if (resG.ok) {
    var rows = await resG.json();
    bebanLebih = rows.map(function(r){
      return { noGardu: r.no_gardu, ulp: r.ulp, penyulang: r.penyulang,
               prosen: r.last_prosen, tglUkur: r.last_inspeksi_tgl };
    });
  }

  // Overdue: gardu dengan last inspeksi > 90 hari atau belum pernah
  var resO = await sbFetch(
    '/rest/v1/v_gardu_lengkap?select=no_gardu,ulp,penyulang,last_inspeksi_tgl&order=no_gardu.asc',
    { signal: signal }
  );
  var overdue = [];
  if (resO.ok) {
    var rowsO = await resO.json();
    var now = new Date();
    rowsO.forEach(function(r){
      var hari = r.last_inspeksi_tgl
        ? Math.floor((now - new Date(r.last_inspeksi_tgl)) / 86400000)
        : null;
      if (hari === null || hari > 90) {
        overdue.push({ noGardu: r.no_gardu, ulp: r.ulp, penyulang: r.penyulang,
                       tglUkur: r.last_inspeksi_tgl, hariSejak: hari });
      }
    });
  }

  return { status:'ok', data: { bebanLebih: bebanLebih, overdue: overdue } };
}

// ── EXPORT REKAP ─────────────────────────────────────────────
async function _getExportRekap(p, signal) {
  var url = '/rest/v1/v_gardu_lengkap?select=*&order=ulp.asc,no_gardu.asc';
  if (p && p.ulp) url += '&ulp=eq.' + encodeURIComponent(p.ulp);
  var res = await sbFetch(url, { signal: signal });
  if (!res.ok) return { status:'error', message:'Gagal memuat data export.' };
  var rows = await res.json();
  var now = new Date();

  var data = rows.map(function(g){
    var hari = g.last_inspeksi_tgl
      ? Math.floor((now - new Date(g.last_inspeksi_tgl)) / 86400000)
      : null;
    var ket = !g.last_inspeksi_tgl ? 'BELUM INSPEKSI'
      : hari > 90 ? 'OVERDUE'
      : parseFloat(g.last_prosen) > 80 ? 'BEBAN LEBIH'
      : 'OK';
    return {
      noGardu:    g.no_gardu    || '',
      ulp:        g.ulp         || '',
      unitup:     g.unitup      || '',
      penyulang:  g.penyulang   || '',
      alamat:     g.alamat      || '',
      daya:       g.kapasitas_kva || '',
      tipe:       g.tipe        || '',
      status:     g.status_operasional || '',
      kepemilikan:g.status_kepemilikan || '',
      tglUkur:    g.last_inspeksi_tgl  || '',
      jamUkur:    g.last_inspeksi_jam  || '',
      petugas:    g.last_inspeksi_petugas || '',
      prosen:     g.last_prosen != null ? String(g.last_prosen) : '',
      hariSejak:  hari,
      keterangan: ket
    };
  });
  return { status:'ok', data: data };
}

// ── VERIFY PIN ───────────────────────────────────────────────
async function _verifyPin(p, signal) {
  // Verifikasi PIN user: cek pin_hash di tabel users
  var pinHash = await sha256(String(p.pin || '').trim());
  var session = await _getUserFromToken(p.token);
  if (!session) return { status:'error', message:'Sesi tidak valid.' };

  var res = await sbFetch(
    '/rest/v1/users?username=eq.' + encodeURIComponent(session.username) +
    '&pin_hash=eq.' + encodeURIComponent(pinHash) + '&select=id&limit=1',
    { signal: signal }
  );
  if (!res.ok) return { status:'error', message:'Gagal verifikasi PIN.' };
  var arr = await res.json();
  if (!arr || !arr.length) return { status:'error', message:'PIN salah.' };
  return { status:'ok', message:'PIN benar.' };
}

// ── SET PIN ──────────────────────────────────────────────────
async function _setPin(p, signal) {
  var session = await _getUserFromToken(p.token);
  if (!session) return { status:'error', message:'Sesi tidak valid.' };

  // Verifikasi password dulu
  var pwHash = await sha256(String(p.password || '').trim());
  var resUser = await sbFetch(
    '/rest/v1/users?username=eq.' + encodeURIComponent(session.username) +
    '&password_hash=eq.' + encodeURIComponent(pwHash) + '&select=id&limit=1',
    { signal: signal }
  );
  if (!resUser.ok) return { status:'error', message:'Gagal verifikasi password.' };
  var userArr = await resUser.json();
  if (!userArr || !userArr.length) return { status:'error', message:'Password salah.' };

  var pinHash = await sha256(String(p.pinBaru || '').trim());
  var resPatch = await sbFetch(
    '/rest/v1/users?username=eq.' + encodeURIComponent(session.username),
    {
      method: 'PATCH',
      body:   JSON.stringify({ pin_hash: pinHash }),
      headers:{ 'Prefer':'return=minimal' },
      signal: signal
    }
  );
  if (!resPatch.ok) return { status:'error', message:'Gagal menyimpan PIN baru.' };
  return { status:'ok', message:'PIN berhasil disimpan.' };
}

// ── TAMBAH GARDU ─────────────────────────────────────────────
async function _tambahGardu(p, signal) {
  var session = await _getUserFromToken(p.token);
  if (!session) return { status:'error', message:'Sesi tidak valid.' };
  if (session.role !== 'admin' && session.role !== 'superadmin')
    return { status:'error', message:'Akses ditolak.' };

  // Verifikasi PIN
  var pinHash = await sha256(String(p.pin || '').trim());
  var resPin = await sbFetch(
    '/rest/v1/users?username=eq.' + encodeURIComponent(session.username) +
    '&pin_hash=eq.' + encodeURIComponent(pinHash) + '&select=id&limit=1',
    { signal: signal }
  );
  if (!resPin.ok) return { status:'error', message:'Gagal verifikasi PIN.' };
  var pinArr = await resPin.json();
  if (!pinArr || !pinArr.length) return { status:'error', message:'PIN salah. Operasi dibatalkan.' };

  // Cek apakah no_gardu sudah ada
  var resCek = await sbFetch('/rest/v1/gardu?no_gardu=eq.'+encodeURIComponent(p.noGardu)+'&select=id&limit=1', { signal:signal });
  var cekArr = resCek.ok ? await resCek.json() : [];
  if (cekArr && cekArr.length) return { status:'error', message:'NO GARDU '+p.noGardu+' sudah ada.' };

  var ulpEnum = 'ULP ' + (p.ulp||'').replace(/^ULP\s*/i,'').trim().toUpperCase();
  var body = {
    no_gardu:            (p.noGardu||'').trim().toUpperCase(),
    ulp:                 ulpEnum,
    unitup:              p.unitup || null,
    penyulang:           p.penyulang || null,
    alamat:              p.alamat || null,
    kapasitas_kva:       p.daya ? parseFloat(p.daya) : null,
    tipe:                (p.tipe||'PORTAL').toUpperCase(),
    status_kepemilikan:  (p.kepemilikan||'PLN').toUpperCase(),
    status_operasional:  (p.statusOp||'AKTIF').toUpperCase(),
    merek_trafo:         p.merek || null,
    latitude:            p.lat || null,
    longitude:           p.lng || null,
    keterangan:          p.keterangan || null
  };

  var res = await sbFetch('/rest/v1/gardu', {
    method: 'POST', body: JSON.stringify(body),
    headers:{ 'Prefer':'return=minimal' }, signal: signal
  });
  if (!res.ok) {
    var errText = await res.text();
    return { status:'error', message:'Gagal menambahkan gardu. '+errText };
  }

  // Log audit
  await sbFetch('/rest/v1/log_audit', {
    method:'POST',
    body: JSON.stringify({ action:'TAMBAH_GARDU', username: session.username,
      role: session.role, ulp: session.ulp || '', detail: 'Tambah gardu: '+p.noGardu, status:'OK' }),
    headers:{ 'Prefer':'return=minimal' }
  });

  return { status:'ok', message:'Gardu '+p.noGardu+' berhasil ditambahkan.' };
}

// ── EDIT GARDU ───────────────────────────────────────────────
async function _editGardu(p, signal) {
  var session = await _getUserFromToken(p.token);
  if (!session) return { status:'error', message:'Sesi tidak valid.' };
  if (session.role !== 'admin' && session.role !== 'superadmin')
    return { status:'error', message:'Akses ditolak.' };

  // Verifikasi PIN
  var pinHash = await sha256(String(p.pin || '').trim());
  var resPin = await sbFetch(
    '/rest/v1/users?username=eq.' + encodeURIComponent(session.username) +
    '&pin_hash=eq.' + encodeURIComponent(pinHash) + '&select=id&limit=1',
    { signal: signal }
  );
  if (!resPin.ok) return { status:'error', message:'Gagal verifikasi PIN.' };
  var pinArr = await resPin.json();
  if (!pinArr || !pinArr.length) return { status:'error', message:'PIN salah. Operasi dibatalkan.' };

  // AdminUlp: hanya bisa edit gardu ULP sendiri
  if (session.role === 'admin') {
    var resChk = await sbFetch('/rest/v1/gardu?no_gardu=eq.'+encodeURIComponent(p.noGarduLama)+'&select=ulp&limit=1', {signal:signal});
    var chkArr = resChk.ok ? await resChk.json() : [];
    if (chkArr && chkArr.length) {
      var garduUlp = (chkArr[0].ulp||'').toUpperCase();
      var sessionUlp = ('ULP '+(session.ulp||'').replace(/^ULP\s*/i,'').trim()).toUpperCase();
      if (garduUlp !== sessionUlp) return { status:'error', message:'Akses ditolak: gardu ini bukan milik '+session.ulp };
    }
  }

  var ulpEnum = 'ULP ' + (p.ulp||'').replace(/^ULP\s*/i,'').trim().toUpperCase();
  var body = {
    ulp:                ulpEnum,
    unitup:             p.unitup || null,
    penyulang:          p.penyulang || null,
    alamat:             p.alamat || null,
    kapasitas_kva:      p.daya ? parseFloat(p.daya) : null,
    tipe:               (p.tipe||'PORTAL').toUpperCase(),
    status_kepemilikan: (p.kepemilikan||'PLN').toUpperCase(),
    status_operasional: (p.status||'AKTIF').toUpperCase(),
    merek_trafo:        p.merek || null,
    latitude:           p.lat || null,
    longitude:          p.lng || null,
    keterangan:         p.keterangan || null
  };

  // Jika ada perubahan no_gardu
  if (p.noGarduBaru && p.noGarduBaru !== p.noGarduLama) {
    body.no_gardu = p.noGarduBaru.toUpperCase();
  }

  var res = await sbFetch('/rest/v1/gardu?no_gardu=eq.'+encodeURIComponent(p.noGarduLama), {
    method:'PATCH', body: JSON.stringify(body),
    headers:{ 'Prefer':'return=minimal' }, signal:signal
  });
  if (!res.ok) {
    var errText = await res.text();
    return { status:'error', message:'Gagal menyimpan perubahan. '+errText };
  }

  await sbFetch('/rest/v1/log_audit', {
    method:'POST',
    body: JSON.stringify({ action:'EDIT_GARDU', username:session.username,
      role:session.role, ulp:session.ulp||'', detail:'Edit gardu: '+p.noGarduLama, status:'OK' }),
    headers:{ 'Prefer':'return=minimal' }
  });

  return { status:'ok', message:'Gardu '+p.noGarduLama+' berhasil diperbarui.' };
}

// ── DAFTAR USER ──────────────────────────────────────────────
async function _getDaftarUser(p, signal) {
  var session = await _getUserFromToken(p.token);
  if (!session || session.role !== 'superadmin')
    return { status:'error', message:'Akses ditolak.' };
  var res = await sbFetch('/rest/v1/users?select=id,username,nama,role,ulp,aktif,last_login&order=id.asc', { signal:signal });
  if (!res.ok) return { status:'error', message:'Gagal memuat daftar user.' };
  var rows = await res.json();
  return { status:'ok', data: rows };
}

// ── HAPUS USER ───────────────────────────────────────────────
async function _hapusUser(p, signal) {
  var session = await _getUserFromToken(p.token);
  if (!session || session.role !== 'superadmin')
    return { status:'error', message:'Akses ditolak.' };
  var res = await sbFetch('/rest/v1/users?username=eq.'+encodeURIComponent(p.username), {
    method:'DELETE', headers:{'Prefer':'return=minimal'}, signal:signal
  });
  if (!res.ok) return { status:'error', message:'Gagal menghapus user.' };
  return { status:'ok', message:'User '+p.username+' berhasil dihapus.' };
}

// ── CARI GARDU ───────────────────────────────────────────────
async function _cariGardu(p, signal) {
  var kw = (p.keyword||'').trim().toUpperCase();
  var url = '/rest/v1/gardu?or=(no_gardu.ilike.*'+encodeURIComponent(kw)+'*,penyulang.ilike.*'+encodeURIComponent(kw)+'*)&limit=10';
  var res = await sbFetch(url, { signal:signal });
  if (!res.ok) return { status:'error', message:'Gagal mencari gardu.' };
  var rows = await res.json();
  return { status:'ok', data: rows.map(_mapGarduRow) };
}

// ── HELPER: Map row Supabase → format lama AppScript ────────
function _mapGarduRow(g) {
  return {
    'NO_GARDU':           g.no_gardu  || '',
    'ULP':                g.ulp       || '',
    'UNITUP':             g.unitup    || '',
    'PENYULANG':          g.penyulang || '',
    'ALAMAT':             g.alamat    || '',
    'KAPASITAS_KVA':      g.kapasitas_kva != null ? String(g.kapasitas_kva) : '',
    'DAYA_KVA':           g.kapasitas_kva != null ? String(g.kapasitas_kva) : '',
    'TIPE':               g.tipe      || '',
    'MEREK_TRAFO':        g.merek_trafo || '',
    'STATUS_KEPEMILIKAN': g.status_kepemilikan || '',
    'STATUS_OPERASIONAL': g.status_operasional || '',
    'LATITUDE':           g.latitude  || '',
    'LONGITUDE':          g.longitude || '',
    'KETERANGAN':         g.keterangan || ''
  };
}

function _mapInspeksiRow(r) {
  // Expand JSONB jurusan ke kolom flat (kompatibel dengan renderDetailGardu)
  var flat = {
    'TGLUKUR':       r.tgl_ukur   || '',
    'JAM UKUR':      r.jam_ukur   || '',
    'PETUGAS':       r.petugas    || '',
    'DAYA':          r.daya       != null ? String(r.daya)       : '',
    'FASA':          r.fasa       != null ? String(r.fasa)       : '',
    'DAYA PAKAI':    r.daya_pakai != null ? String(r.daya_pakai) : '',
    'PROSEN':        r.prosen     != null ? String(r.prosen)     : '',
    'TDKSEIMBANG':   r.tdk_seimbang != null ? String(r.tdk_seimbang) : '',
    'TDK SEIMBANG':  r.tdk_seimbang != null ? String(r.tdk_seimbang) : '',
    'R TOTAL':       r.r_total    != null ? String(r.r_total)    : '',
    'S TOTAL':       r.s_total    != null ? String(r.s_total)    : '',
    'T TOTAL':       r.t_total    != null ? String(r.t_total)    : '',
    'N TOTAL':       r.n_total    != null ? String(r.n_total)    : '',
    'R - N':         r.v_r_n      != null ? String(r.v_r_n)      : '',
    'S - N':         r.v_s_n      != null ? String(r.v_s_n)      : '',
    'T - N':         r.v_t_n      != null ? String(r.v_t_n)      : '',
    'R - S':         r.v_r_s      != null ? String(r.v_r_s)      : '',
    'S - T':         r.v_s_t      != null ? String(r.v_s_t)      : '',
    'R - T':         r.v_r_t      != null ? String(r.v_r_t)      : '',
    'THD-R':         r.thd_r      != null ? String(r.thd_r)      : '',
    'THD-S':         r.thd_s      != null ? String(r.thd_s)      : '',
    'THD-T':         r.thd_t      != null ? String(r.thd_t)      : '',
    'IPEAK-R':       r.ipeak_r    != null ? String(r.ipeak_r)    : '',
    'IPEAK-S':       r.ipeak_s    != null ? String(r.ipeak_s)    : '',
    'IPEAK-T':       r.ipeak_t    != null ? String(r.ipeak_t)    : '',
    'TPF-R':         r.tpf_r      != null ? String(r.tpf_r)      : '',
    'TPF-S':         r.tpf_s      != null ? String(r.tpf_s)      : '',
    'TPF-T':         r.tpf_t      != null ? String(r.tpf_t)      : ''
  };

  // Expand JSONB jurusan ke kolom flat
  var jurusan = [];
  try { jurusan = typeof r.jurusan === 'string' ? JSON.parse(r.jurusan) : (r.jurusan || []); } catch(e){}
  jurusan.forEach(function(j, idx){
    var n = idx + 1;
    flat['JURUSAN '+n]           = j.nama     || '';
    flat['JUR'+n+'_R TOTAL']     = j.r_total  != null ? String(j.r_total)  : '';
    flat['JUR'+n+'_S TOTAL']     = j.s_total  != null ? String(j.s_total)  : '';
    flat['JUR'+n+'_T TOTAL']     = j.t_total  != null ? String(j.t_total)  : '';
    flat['JUR'+n+'_N TOTAL']     = j.n_total  != null ? String(j.n_total)  : '';
    flat['JUR'+n+'_R - N']       = j.v_r_n    != null ? String(j.v_r_n)    : '';
    flat['JUR'+n+'_S - N']       = j.v_s_n    != null ? String(j.v_s_n)    : '';
    flat['JUR'+n+'_T - N']       = j.v_t_n    != null ? String(j.v_t_n)    : '';
    flat['JUR'+n+'_R - s']       = j.v_r_t    != null ? String(j.v_r_t)    : '';
    flat['JUR'+n+'_R - T']       = j.v_r_t    != null ? String(j.v_r_t)    : '';
    flat['JUR'+n+'_S - T']       = j.v_s_t    != null ? String(j.v_s_t)    : '';
    flat['JUR'+n+'_THD-R']       = j.thd_r    != null ? String(j.thd_r)    : '';
    flat['JUR'+n+'_THD-S']       = j.thd_s    != null ? String(j.thd_s)    : '';
    flat['JUR'+n+'_THD-T']       = j.thd_t    != null ? String(j.thd_t)    : '';
    flat['JUR'+n+'_IPEAK-R']     = j.ipeak_r  != null ? String(j.ipeak_r)  : '';
    flat['JUR'+n+'_IPEAK-S']     = j.ipeak_s  != null ? String(j.ipeak_s)  : '';
    flat['JUR'+n+'_IPEAK-T']     = j.ipeak_t  != null ? String(j.ipeak_t)  : '';
    flat['JUR'+n+'_TPF-R']       = j.tpf_r    != null ? String(j.tpf_r)    : '';
    flat['JUR'+n+'_TPF-S']       = j.tpf_s    != null ? String(j.tpf_s)    : '';
    flat['JUR'+n+'_TPF-T']       = j.tpf_t    != null ? String(j.tpf_t)    : '';
  });

  return flat;
}

// ── Override apiGet global ────────────────────────────────────
// Patch fungsi apiGet yang dipakai di index.html agar pakai Supabase
window.apiGet = function(params, cb) {
  var action = params.action || '';
  var p = Object.assign({}, params);
  delete p.action;
  apiCall(action, p, cb);
};

console.log('[Supabase API] Layer aktif. URL:', SUPABASE_URL);
