// ============================================================
//  PLN UP3 JAYAPURA — Supabase API Layer  v7
//  File: supabase-api.js
//
//  FIX v7:
//  1. _getGarduKritis: Strategi baru — pakai v_gardu_lengkap
//     (sudah punya last_prosen & last_inspeksi_tgl) → O(1 query).
//     Tidak perlu fetch ribuan baris inspeksi lagi.
//  2. RPC response parser: Supabase wrap JSONB dalam array
//     [{"fn_get_gardu_kritis":{...}}] atau [{...}] — handle semua case.
//  3. _fetchAllInspeksiForKritis: hapus Range header conflict,
//     pakai limit+offset murni, fix kondisi break.
//  4. Timeout: naikkan ke 60 detik untuk operasi besar.
//  5. _verifyPin, _setPin, dll: parse RPC JSONB array dengan benar.
// ============================================================

// ── KONFIGURASI ──────────────────────────────────────────────
var SUPABASE_URL  = 'https://lrjpdcyyaxcfdpzxygrj.supabase.co';
var SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxyanBkY3l5YXhjZmRwenh5Z3JqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg1NDI4MzcsImV4cCI6MjA5NDExODgzN30.BgplnVYogpr5qRQ2pITNLuC4iw7AzuR_rikuxSM7Dxo';

// ── SHA-256 helper ───────────────────────────────────────────
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
    'Content-Type':  'application/json'
  }, opts.headers || {});
  // Hapus Prefer kosong supaya tidak conflict
  if (opts.prefer) headers['Prefer'] = opts.prefer;
  return fetch(SUPABASE_URL + path, {
    method:  opts.method  || 'GET',
    headers: headers,
    body:    opts.body    || undefined,
    signal:  opts.signal  || undefined
  });
}

// ── RPC helper ───────────────────────────────────────────────
function sbRpc(funcName, params, signal) {
  return sbFetch('/rest/v1/rpc/' + funcName, {
    method: 'POST',
    body:   JSON.stringify(params || {}),
    signal: signal
  });
}

// ── RPC JSON parser (handle Supabase JSONB wrapping) ─────────
// Supabase bisa return:
//   Case A (RETURNS JSONB): [{status:'ok',...}]  → ambil [0]
//   Case B (langsung):      {status:'ok',...}    → pakai langsung
//   Case C (scalar):        "ok"                 → bungkus
function parseRpcJson(raw) {
  if (Array.isArray(raw)) {
    var first = raw[0];
    if (first && typeof first === 'object') {
      // Case: [{fn_name: {...}}] — Supabase kadang wrap dalam key fungsi
      var keys = Object.keys(first);
      if (keys.length === 1 && typeof first[keys[0]] === 'object') {
        return first[keys[0]];
      }
      return first;
    }
    return { status:'error', message:'Response tidak valid.' };
  }
  return raw;
}

// ── apiCall wrapper ──────────────────────────────────────────
function apiCall(action, params, cb) {
  var controller = new AbortController();
  var done = false;
  var timer = setTimeout(function(){
    if (done) return;
    done = true;
    controller.abort();
    cb({ status:'error', message:'Koneksi timeout. Periksa jaringan lalu coba lagi.' });
  }, 60000); // 60 detik

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

// ── Router ───────────────────────────────────────────────────
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
    case 'logoutUser':       return _logoutUser(p, signal);
    case 'getRiwayat':       return _getRiwayat(p, signal);
    case 'getRekapGardu':    return _getRekapGardu(p, signal);
    case 'tambahUser':       return _tambahUser(p, signal);
    case 'editUser':         return _editUser(p, signal);
    case 'gantiPassword':    return _gantiPassword(p, signal);
    case 'verifyULPPin':     return _verifyULPPin(p, signal);
    case 'toggleStatus':     return _toggleStatus(p, signal);
    default: return { status:'error', message:'Action tidak dikenali: '+action };
  }
}

// ── HELPER: verify token via RPC ─────────────────────────────
async function _getUserFromToken(token) {
  if (!token) return null;
  try {
    var res = await sbRpc('fn_verify_token', { p_token: token });
    if (!res.ok) return null;
    var raw = await res.json();
    var data = parseRpcJson(raw);
    if (!data || data.status !== 'ok') return null;
    return data;
  } catch(e) {
    console.error('[sbApi] _getUserFromToken error:', e);
    return null;
  }
}

// ── LOGIN ────────────────────────────────────────────────────
async function _login(p, signal) {
  var pwHash = await sha256(String(p.password || '').trim());
  var res = await sbRpc('fn_login', {
    p_username:      String(p.username || '').trim(),
    p_password_hash: pwHash
  }, signal);
  if (!res.ok) return { status:'error', message:'Server error '+res.status };
  var raw = await res.json();
  var data = parseRpcJson(raw);
  if (!data || data.status !== 'ok')
    return { status:'error', message: (data && data.message) || 'Login gagal.' };
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

// ── DAFTAR GARDU ─────────────────────────────────────────────
async function _getDaftarGardu(p, signal) {
  var url = '/rest/v1/v_gardu_lengkap?select=*&order=no_gardu.asc&limit=5000';
  if (p && p.ulp) url += '&ulp=eq.' + encodeURIComponent(p.ulp);
  var res = await sbFetch(url, { signal: signal });
  if (!res.ok) {
    var errTxt = await res.text().catch(function(){ return res.status; });
    return { status:'error', message:'Gagal memuat daftar gardu ('+res.status+'): '+errTxt };
  }
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
      'MEREK_TRAFO':         g.merek_trafo || '',
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

// ── DETAIL GARDU + RIWAYAT ───────────────────────────────────
async function _getDetailLengkap(p, signal) {
  var noGardu = (p.noGardu || '').trim().toUpperCase();
  var resG = await sbFetch(
    '/rest/v1/gardu?no_gardu=eq.' + encodeURIComponent(noGardu) + '&limit=1',
    { signal: signal }
  );
  if (!resG.ok) return { status:'error', message:'Gagal memuat data gardu.' };
  var garduArr = await resG.json();
  if (!garduArr || !garduArr.length)
    return { status:'error', message:'Gardu tidak ditemukan: '+noGardu };
  var g = garduArr[0];
  var resI = await sbFetch(
    '/rest/v1/inspeksi?no_gardu=eq.' + encodeURIComponent(noGardu) +
    '&order=tgl_ukur.desc,jam_ukur.desc&limit=20',
    { signal: signal }
  );
  var riwayatRaw = resI.ok ? await resI.json() : [];
  return {
    status: 'ok',
    data:    _mapGarduRow(g),
    riwayat: riwayatRaw.map(function(r){ return _mapInspeksiRow(r); })
  };
}

// ── DETAIL GARDU SAJA ────────────────────────────────────────
async function _getDetailGardu(p, signal) {
  var noGardu = (p.noGardu || '').trim().toUpperCase();
  var res = await sbFetch(
    '/rest/v1/gardu?no_gardu=eq.' + encodeURIComponent(noGardu) + '&limit=1',
    { signal: signal }
  );
  if (!res.ok) return { status:'error', message:'Gagal memuat data gardu.' };
  var arr = await res.json();
  if (!arr || !arr.length)
    return { status:'error', message:'Gardu tidak ditemukan: '+noGardu };
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
  var ulpFilter = (p && p.ulp) ? p.ulp : null;
  // Coba RPC dulu
  try {
    var res = await sbRpc('fn_get_rekap', { p_ulp: ulpFilter }, signal);
    if (res.ok) {
      var raw = await res.json();
      var data = parseRpcJson(raw);
      if (data && data.status === 'ok') return data;
    }
  } catch(e) {}
  // Fallback manual
  return _getRekapManual(p, signal);
}

async function _getRekapManual(p, signal) {
  var ulpFilter = (p && p.ulp) ? p.ulp : null;
  var now = new Date();
  var bulanIni = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');

  var vGarduUrl = '/rest/v1/v_gardu_lengkap?select=no_gardu,ulp,status_operasional,last_inspeksi_tgl,last_prosen&limit=10000';
  if (ulpFilter) vGarduUrl += '&ulp=eq.' + encodeURIComponent(ulpFilter);
  var resVGardu = await sbFetch(vGarduUrl, { signal: signal });
  var vGarduRows = resVGardu.ok ? await resVGardu.json() : [];

  var totalGardu = vGarduRows.length;
  var aktif = 0, nonAktif = 0;
  var sudahInspeksi = 0, belumInspeksi = 0, overdue90 = 0;
  var bNormal = 0, bLebih = 0, bNoData = 0;
  var perULP = {};

  vGarduRows.forEach(function(g){
    var ulpKey = g.ulp || 'UNKNOWN';
    if (!perULP[ulpKey]) perULP[ulpKey] = { total:0, inspeksi:0, overdue:0 };
    perULP[ulpKey].total++;

    if ((g.status_operasional||'').toUpperCase() === 'AKTIF') aktif++;
    else nonAktif++;

    if (g.last_inspeksi_tgl) {
      sudahInspeksi++;
      perULP[ulpKey].inspeksi++;
      var hari = Math.floor((now - new Date(g.last_inspeksi_tgl)) / 86400000);
      if (hari > 90) { overdue90++; perULP[ulpKey].overdue++; }
    } else {
      belumInspeksi++;
      overdue90++;
      perULP[ulpKey].overdue++;
    }

    var pb = parseFloat(g.last_prosen);
    if (g.last_prosen == null || isNaN(pb)) bNoData++;
    else if (pb > 80) bLebih++;
    else bNormal++;
  });

  var inspBulanUrl = '/rest/v1/inspeksi?select=no_gardu&tgl_ukur=gte.' + bulanIni + '-01&tgl_ukur=lte.' + bulanIni + '-31&limit=10000';
  var resInspBulan = await sbFetch(inspBulanUrl, { signal: signal });
  var inspBulanRows = resInspBulan.ok ? await resInspBulan.json() : [];
  var inspeksiBulanIni = inspBulanRows.length;
  if (ulpFilter) {
    var garduSet = new Set(vGarduRows.map(function(g){ return g.no_gardu; }));
    inspeksiBulanIni = inspBulanRows.filter(function(r){ return garduSet.has(r.no_gardu); }).length;
  }

  var terbaruUrl = '/rest/v1/inspeksi?select=no_gardu,tgl_ukur,jam_ukur,petugas,prosen,penyulang,alamat&order=tgl_ukur.desc,jam_ukur.desc&limit=50';
  var resTerbaru = await sbFetch(terbaruUrl, { signal: signal });
  var terbaruRows = resTerbaru.ok ? await resTerbaru.json() : [];
  if (ulpFilter) {
    var garduSet2 = new Set(vGarduRows.map(function(g){ return g.no_gardu; }));
    terbaruRows = terbaruRows.filter(function(r){ return garduSet2.has(r.no_gardu); });
  }
  terbaruRows = terbaruRows.slice(0, 10);

  var terbaru = terbaruRows.map(function(r){
    return {
      noGardu:   r.no_gardu  || '',
      tanggal:   r.tgl_ukur  || '',
      jam:       r.jam_ukur  ? String(r.jam_ukur).slice(0,5) : '',
      petugas:   r.petugas   || '',
      prosen:    r.prosen != null ? parseFloat(r.prosen) : null,
      penyulang: r.penyulang || '',
      alamat:    r.alamat    || ''
    };
  });

  return {
    status: 'ok',
    data: {
      totalGardu:    totalGardu,
      aktif:         aktif,
      nonAktif:      nonAktif,
      sudahInspeksi: sudahInspeksi,
      belumInspeksi: belumInspeksi,
      overdue90:     overdue90,
      bulanIni:      inspeksiBulanIni,
      perULP:        perULP,
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
// FIX v7: Strategi utama → query v_gardu_lengkap yang SUDAH punya
// last_prosen & last_inspeksi_tgl. Satu query, selesai. Tidak perlu
// fetch ribuan baris inspeksi lagi. RPC sebagai secondary try.
async function _getGarduKritis(p, signal) {
  var ulpFilter = (p && p.ulp) ? p.ulp : null;

  // ── Strategi 1: RPC fn_get_gardu_kritis (server-side, paling efisien)
  try {
    var rpcRes = await sbRpc('fn_get_gardu_kritis', { p_ulp: ulpFilter || null }, signal);
    if (rpcRes.ok) {
      var rpcRaw = await rpcRes.json();
      var rpcData = parseRpcJson(rpcRaw);
      if (rpcData && rpcData.status === 'ok' && rpcData.data) {
        var bd = rpcData.data.bebanLebih;
        var od = rpcData.data.overdue;
        if ((Array.isArray(bd) || Array.isArray(od)) && (bd.length > 0 || od.length > 0 || rpcData.data._checked)) {
          return { status: 'ok', data: rpcData.data };
        }
        // Kalau keduanya kosong, lanjut ke fallback untuk cross-check
      }
    }
  } catch(e) {
    console.warn('[sbApi] fn_get_gardu_kritis RPC failed:', e.message);
  }

  // ── Strategi 2 (UTAMA BARU): Query v_gardu_lengkap ─────────
  // View ini sudah join ke inspeksi terbaru, satu query cukup.
  try {
    var now = new Date();
    var vUrl = '/rest/v1/v_gardu_lengkap?select=no_gardu,ulp,penyulang,last_inspeksi_tgl,last_prosen,status_operasional&limit=10000';
    if (ulpFilter) vUrl += '&ulp=eq.' + encodeURIComponent(ulpFilter);
    var resV = await sbFetch(vUrl, { signal: signal });
    if (!resV.ok) throw new Error('v_gardu_lengkap HTTP ' + resV.status);
    var vRows = await resV.json();
    if (!Array.isArray(vRows)) throw new Error('Response bukan array');

    var bebanLebih = [];
    var overdue    = [];

    vRows.forEach(function(g){
      var prosen    = g.last_prosen != null ? parseFloat(g.last_prosen) : null;
      var tglUkur   = g.last_inspeksi_tgl || null;
      var hariSejak = tglUkur
        ? Math.floor((now - new Date(tglUkur)) / 86400000)
        : null;

      if (prosen !== null && !isNaN(prosen) && prosen > 80) {
        bebanLebih.push({
          noGardu:   g.no_gardu,
          ulp:       g.ulp,
          penyulang: g.penyulang || '',
          prosen:    prosen,
          tglUkur:   tglUkur || ''
        });
      }

      if (hariSejak === null || hariSejak > 90) {
        overdue.push({
          noGardu:   g.no_gardu,
          ulp:       g.ulp,
          penyulang: g.penyulang || '',
          tglUkur:   tglUkur || '',
          hariSejak: hariSejak
        });
      }
    });

    bebanLebih.sort(function(a, b){ return b.prosen - a.prosen; });
    overdue.sort(function(a, b){
      if (a.hariSejak === null && b.hariSejak !== null) return -1;
      if (a.hariSejak !== null && b.hariSejak === null) return 1;
      if (a.hariSejak === null && b.hariSejak === null) return 0;
      return b.hariSejak - a.hariSejak;
    });

    return {
      status: 'ok',
      data: { bebanLebih: bebanLebih, overdue: overdue }
    };
  } catch(e2) {
    console.warn('[sbApi] v_gardu_lengkap fallback failed:', e2.message);
  }

  // ── Strategi 3: Fallback terakhir — query gardu + inspeksi langsung
  return _getGarduKritisLegacy(ulpFilter, signal);
}

// Legacy fallback: paginate inspeksi (lambat tapi pasti)
async function _getGarduKritisLegacy(ulpFilter, signal) {
  try {
    var now = new Date();
    var garduUrl = '/rest/v1/gardu?select=no_gardu,ulp,penyulang&limit=10000';
    if (ulpFilter) garduUrl += '&ulp=eq.' + encodeURIComponent(ulpFilter);
    var resGardu = await sbFetch(garduUrl, { signal: signal });
    if (!resGardu.ok) return { status:'error', message:'Gagal memuat data gardu.' };
    var garduRows = await resGardu.json();

    // Ambil inspeksi terbaru per gardu: limit ke 1000 baris terbaru
    // (cukup untuk deteksi gardu kritis; kalau ada >1000 gardu & semuanya aktif inspeksi baru)
    var lastInspMap = {};
    var PAGE = 1000;
    var maxPages = 15;
    for (var i = 0; i < maxPages; i++) {
      var offset = i * PAGE;
      var iUrl = '/rest/v1/inspeksi?select=no_gardu,tgl_ukur,prosen'
        + '&order=tgl_ukur.desc'
        + '&limit=' + PAGE + '&offset=' + offset;
      var resI = await sbFetch(iUrl, { signal: signal });
      if (!resI.ok) break;
      var batch = await resI.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      batch.forEach(function(r){
        if (r.no_gardu && !lastInspMap[r.no_gardu]) {
          lastInspMap[r.no_gardu] = { tgl_ukur: r.tgl_ukur, prosen: r.prosen };
        }
      });
      // Cek apakah semua gardu sudah ter-cover
      var coveredAll = garduRows.every(function(g){ return lastInspMap[g.no_gardu]; });
      if (coveredAll || batch.length < PAGE) break;
    }

    var bebanLebih = [];
    var overdue    = [];

    garduRows.forEach(function(g){
      var last      = lastInspMap[g.no_gardu] || null;
      var prosen    = last && last.prosen != null ? parseFloat(last.prosen) : null;
      var tglUkur   = last ? last.tgl_ukur : null;
      var hariSejak = tglUkur
        ? Math.floor((now - new Date(tglUkur)) / 86400000)
        : null;

      if (prosen !== null && !isNaN(prosen) && prosen > 80) {
        bebanLebih.push({ noGardu: g.no_gardu, ulp: g.ulp, penyulang: g.penyulang||'', prosen: prosen, tglUkur: tglUkur||'' });
      }
      if (hariSejak === null || hariSejak > 90) {
        overdue.push({ noGardu: g.no_gardu, ulp: g.ulp, penyulang: g.penyulang||'', tglUkur: tglUkur||'', hariSejak: hariSejak });
      }
    });

    bebanLebih.sort(function(a,b){ return b.prosen - a.prosen; });
    overdue.sort(function(a,b){
      if (a.hariSejak===null&&b.hariSejak!==null) return -1;
      if (a.hariSejak!==null&&b.hariSejak===null) return 1;
      if (a.hariSejak===null&&b.hariSejak===null) return 0;
      return b.hariSejak - a.hariSejak;
    });

    return { status:'ok', data: { bebanLebih: bebanLebih, overdue: overdue } };
  } catch(e) {
    return { status:'error', message:'Gagal memuat data kritis: '+e.message };
  }
}

// ── EXPORT REKAP ─────────────────────────────────────────────
async function _getExportRekap(p, signal) {
  var ulpFilter = (p && p.ulp) ? p.ulp : null;

  // Coba RPC fn_get_export_rekap
  try {
    var rpcRes = await sbRpc('fn_get_export_rekap', { p_ulp: ulpFilter || null }, signal);
    if (rpcRes.ok) {
      var rpcRaw = await rpcRes.json();
      var rpcData = parseRpcJson(rpcRaw);
      if (rpcData && rpcData.status === 'ok' && Array.isArray(rpcData.data) && rpcData.data.length > 0) {
        return { status: 'ok', data: rpcData.data };
      }
    }
  } catch(e) {
    console.warn('[sbApi] fn_get_export_rekap RPC failed:', e.message);
  }

  // Fallback: v_gardu_lengkap + query inspeksi per gardu batch
  var garduUrl = '/rest/v1/v_gardu_lengkap?select=no_gardu,unitup,ulp,penyulang,alamat,kapasitas_kva,tipe,status_operasional,status_kepemilikan,last_inspeksi_tgl,last_inspeksi_jam,last_inspeksi_petugas,last_prosen&order=ulp.asc,no_gardu.asc&limit=10000';
  if (ulpFilter) garduUrl += '&ulp=eq.' + encodeURIComponent(ulpFilter);
  var resGardu = await sbFetch(garduUrl, { signal: signal });
  if (!resGardu.ok) return { status:'error', message:'Gagal memuat data gardu ('+resGardu.status+').' };
  var garduRows = await resGardu.json();
  if (!Array.isArray(garduRows)) return { status:'error', message:'Data gardu tidak valid.' };

  // Untuk export kita juga perlu r_total, s_total, t_total, n_total dari inspeksi terbaru.
  // Ambil via pagination inspeksi (select minimal)
  var lastInspFull = {};
  var PAGE2 = 1000;
  for (var pi = 0; pi < 15; pi++) {
    var iUrl2 = '/rest/v1/inspeksi?select=no_gardu,tgl_ukur,jam_ukur,petugas,prosen,r_total,s_total,t_total,n_total'
      + '&order=tgl_ukur.desc&limit=' + PAGE2 + '&offset=' + (pi * PAGE2);
    var resI2 = await sbFetch(iUrl2, { signal: signal });
    if (!resI2.ok) break;
    var batch2 = await resI2.json();
    if (!Array.isArray(batch2) || batch2.length === 0) break;
    batch2.forEach(function(r){
      if (r.no_gardu && !lastInspFull[r.no_gardu]) lastInspFull[r.no_gardu] = r;
    });
    var coveredExport = garduRows.every(function(g){ return lastInspFull[g.no_gardu]; });
    if (coveredExport || batch2.length < PAGE2) break;
  }

  var now2 = new Date();
  var data = garduRows.map(function(g){
    // Prioritas: gunakan last_* dari view, tapi r/s/t/n dari inspeksi langsung
    var last      = lastInspFull[g.no_gardu] || null;
    var tglUkur   = g.last_inspeksi_tgl || (last ? last.tgl_ukur : '') || '';
    var jamStr    = g.last_inspeksi_jam
      ? String(g.last_inspeksi_jam).slice(0,5)
      : (last && last.jam_ukur ? String(last.jam_ukur).slice(0,5) : '');
    var petugas   = g.last_inspeksi_petugas || (last ? (last.petugas||'') : '');
    var prosen    = g.last_prosen != null ? parseFloat(g.last_prosen)
      : (last && last.prosen != null ? parseFloat(last.prosen) : null);
    var hariSejak = tglUkur ? Math.floor((now2 - new Date(tglUkur)) / 86400000) : null;
    var ket = !tglUkur                    ? 'BELUM INSPEKSI'
      : hariSejak > 90                    ? 'OVERDUE'
      : prosen !== null && prosen > 80    ? 'BEBAN LEBIH'
      : 'OK';
    return {
      noGardu:    g.no_gardu    || '',
      ulp:        g.ulp         || '',
      unitup:     g.unitup      || '',
      penyulang:  g.penyulang   || '',
      alamat:     g.alamat      || '',
      daya:       g.kapasitas_kva != null ? String(g.kapasitas_kva) : '',
      tipe:       g.tipe        || '',
      status:     g.status_operasional || '',
      kepemilikan:g.status_kepemilikan || '',
      tglUkur:    tglUkur,
      jamUkur:    jamStr,
      petugas:    petugas,
      prosen:     prosen !== null ? String(prosen) : '',
      rTotal:     last && last.r_total != null ? String(last.r_total) : '',
      sTotal:     last && last.s_total != null ? String(last.s_total) : '',
      tTotal:     last && last.t_total != null ? String(last.t_total) : '',
      nTotal:     last && last.n_total != null ? String(last.n_total) : '',
      hariSejak:  hariSejak,
      keterangan: ket
    };
  });

  return { status:'ok', data: data };
}

// ── VERIFY PIN ───────────────────────────────────────────────
async function _verifyPin(p, signal) {
  var session = await _getUserFromToken(p.token);
  if (!session) return { status:'error', message:'Sesi tidak valid.' };
  var pinHash = await sha256(String(p.pin || '').trim());
  var res = await sbRpc('fn_verify_pin', {
    p_username: session.username,
    p_pin_hash: pinHash
  }, signal);
  if (!res.ok) return { status:'error', message:'Gagal verifikasi PIN ('+res.status+').' };
  var raw = await res.json();
  var data = parseRpcJson(raw);
  if (!data || data.status !== 'ok')
    return { status:'error', message: (data && data.message) ? data.message : 'PIN salah.' };
  return { status:'ok', message:'PIN benar.' };
}

// ── SET PIN ──────────────────────────────────────────────────
async function _setPin(p, signal) {
  var session = await _getUserFromToken(p.token);
  if (!session) return { status:'error', message:'Sesi tidak valid.' };
  var pwHash  = await sha256(String(p.password || '').trim());
  var pinHash = await sha256(String(p.pinBaru  || '').trim());
  var res = await sbRpc('fn_set_pin_user', {
    p_token:         p.token,
    p_password_hash: pwHash,
    p_pin_hash_baru: pinHash
  }, signal);
  if (!res.ok) return { status:'error', message:'Gagal menyimpan PIN ('+res.status+').' };
  var raw = await res.json();
  var data = parseRpcJson(raw);
  if (!data || data.status !== 'ok')
    return { status:'error', message: (data && data.message) ? data.message : 'Gagal menyimpan PIN.' };
  return { status:'ok', message:'PIN berhasil disimpan.' };
}

// ── TAMBAH GARDU ─────────────────────────────────────────────
async function _tambahGardu(p, signal) {
  var pinHash = await sha256(String(p.pin || '').trim());
  var ulpEnum = 'ULP ' + (p.ulp||'').replace(/^ULP\s*/i,'').trim().toUpperCase();
  var res = await sbRpc('fn_tambah_gardu', {
    p_token:               p.token,
    p_pin_hash:            pinHash,
    p_no_gardu:            (p.noGardu||'').trim().toUpperCase(),
    p_ulp:                 ulpEnum,
    p_unitup:              p.unitup    || null,
    p_penyulang:           p.penyulang || null,
    p_alamat:              p.alamat    || null,
    p_kapasitas_kva:       p.daya      ? parseFloat(p.daya) : null,
    p_tipe:                (p.tipe||'PORTAL').toUpperCase(),
    p_status_kepemilikan:  (p.kepemilikan||'PLN').toUpperCase(),
    p_status_operasional:  (p.statusOp||'AKTIF').toUpperCase(),
    p_merek_trafo:         p.merek     || null,
    p_latitude:            p.lat       ? String(p.lat) : null,
    p_longitude:           p.lng       ? String(p.lng) : null,
    p_keterangan:          p.keterangan|| null
  }, signal);
  if (!res.ok) {
    var errText = await res.text().catch(function(){ return res.status; });
    return { status:'error', message:'Gagal menambahkan gardu ('+res.status+'): '+errText };
  }
  var raw = await res.json();
  var data = parseRpcJson(raw);
  if (!data || data.status !== 'ok')
    return { status:'error', message: (data && data.message) ? data.message : 'Gagal menambahkan gardu.' };
  return { status:'ok', message: data.message };
}

// ── EDIT GARDU ───────────────────────────────────────────────
async function _editGardu(p, signal) {
  var pinHash = await sha256(String(p.pin || '').trim());
  var ulpEnum = p.ulp
    ? 'ULP ' + p.ulp.replace(/^ULP\s*/i,'').trim().toUpperCase()
    : null;
  var noGarduBaru = (p.noGarduBaru || '').trim().toUpperCase();
  var res = await sbRpc('fn_edit_gardu', {
    p_token:               p.token,
    p_pin_hash:            pinHash,
    p_no_gardu_lama:       (p.noGarduLama||'').trim().toUpperCase(),
    p_no_gardu_baru:       noGarduBaru || null,
    p_ulp:                 ulpEnum,
    p_unitup:              p.unitup    || null,
    p_penyulang:           p.penyulang || null,
    p_alamat:              p.alamat    || null,
    p_kapasitas_kva:       p.daya      ? parseFloat(p.daya) : null,
    p_tipe:                p.tipe      ? p.tipe.toUpperCase()          : null,
    p_status_kepemilikan:  p.kepemilikan ? p.kepemilikan.toUpperCase() : null,
    p_status_operasional:  p.status    ? p.status.toUpperCase()        : null,
    p_merek_trafo:         p.merek     || null,
    p_latitude:            p.lat       ? String(p.lat) : null,
    p_longitude:           p.lng       ? String(p.lng) : null,
    p_keterangan:          p.keterangan|| null
  }, signal);
  if (!res.ok) {
    var errText = await res.text().catch(function(){ return res.status; });
    return { status:'error', message:'Gagal menyimpan perubahan ('+res.status+'): '+errText };
  }
  var raw = await res.json();
  var data = parseRpcJson(raw);
  if (!data || data.status !== 'ok')
    return { status:'error', message: (data && data.message) ? data.message : 'Gagal menyimpan perubahan.' };
  return { status:'ok', message: data.message };
}

// ── DAFTAR USER ──────────────────────────────────────────────
async function _getDaftarUser(p, signal) {
  var session = await _getUserFromToken(p.token);
  if (!session || session.role !== 'superadmin')
    return { status:'error', message:'Akses ditolak.' };
  var res = await sbRpc('fn_get_daftar_user', { p_token: p.token }, signal);
  if (!res.ok) return { status:'error', message:'Gagal memuat daftar user.' };
  var raw = await res.json();
  var data = parseRpcJson(raw);
  if (!data || data.status !== 'ok')
    return { status:'error', message: (data && data.message) || 'Gagal.' };
  return { status:'ok', data: data.rows || [] };
}

// ── HAPUS USER ───────────────────────────────────────────────
async function _hapusUser(p, signal) {
  var session = await _getUserFromToken(p.token);
  if (!session || session.role !== 'superadmin')
    return { status:'error', message:'Akses ditolak.' };
  var res = await sbRpc('fn_hapus_user', {
    p_token:    p.token,
    p_username: p.username
  }, signal);
  if (!res.ok) return { status:'error', message:'Gagal menghapus user.' };
  var raw = await res.json();
  var data = parseRpcJson(raw);
  if (!data || data.status !== 'ok')
    return { status:'error', message: (data && data.message) || 'Gagal menghapus.' };
  return { status:'ok', message: data.message };
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

// ── HELPER: Map row gardu ────────────────────────────────────
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

// ── HELPER: Map row inspeksi ─────────────────────────────────
function _mapInspeksiRow(r) {
  var flat = {
    'TGLUKUR':       r.tgl_ukur   || '',
    'JAM UKUR':      r.jam_ukur   ? String(r.jam_ukur).slice(0,5) : '',
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

  var jurusan = [];
  try { jurusan = typeof r.jurusan === 'string' ? JSON.parse(r.jurusan) : (r.jurusan || []); } catch(e){}
  jurusan.forEach(function(j, idx){
    var n = idx + 1;
    flat['JURUSAN '+n]       = j.nama    || '';
    flat['JUR'+n+'_R TOTAL'] = j.r_total  != null ? String(j.r_total)  : '';
    flat['JUR'+n+'_S TOTAL'] = j.s_total  != null ? String(j.s_total)  : '';
    flat['JUR'+n+'_T TOTAL'] = j.t_total  != null ? String(j.t_total)  : '';
    flat['JUR'+n+'_N TOTAL'] = j.n_total  != null ? String(j.n_total)  : '';
    flat['JUR'+n+'_R - N']   = j.v_r_n    != null ? String(j.v_r_n)    : '';
    flat['JUR'+n+'_S - N']   = j.v_s_n    != null ? String(j.v_s_n)    : '';
    flat['JUR'+n+'_T - N']   = j.v_t_n    != null ? String(j.v_t_n)    : '';
    flat['JUR'+n+'_R - s']   = j.v_r_t    != null ? String(j.v_r_t)    : '';
    flat['JUR'+n+'_R - T']   = j.v_r_t    != null ? String(j.v_r_t)    : '';
    flat['JUR'+n+'_S - T']   = j.v_s_t    != null ? String(j.v_s_t)    : '';
    flat['JUR'+n+'_THD-R']   = j.thd_r    != null ? String(j.thd_r)    : '';
    flat['JUR'+n+'_THD-S']   = j.thd_s    != null ? String(j.thd_s)    : '';
    flat['JUR'+n+'_THD-T']   = j.thd_t    != null ? String(j.thd_t)    : '';
    flat['JUR'+n+'_IPEAK-R'] = j.ipeak_r  != null ? String(j.ipeak_r)  : '';
    flat['JUR'+n+'_IPEAK-S'] = j.ipeak_s  != null ? String(j.ipeak_s)  : '';
    flat['JUR'+n+'_IPEAK-T'] = j.ipeak_t  != null ? String(j.ipeak_t)  : '';
    flat['JUR'+n+'_TPF-R']   = j.tpf_r    != null ? String(j.tpf_r)    : '';
    flat['JUR'+n+'_TPF-S']   = j.tpf_s    != null ? String(j.tpf_s)    : '';
    flat['JUR'+n+'_TPF-T']   = j.tpf_t    != null ? String(j.tpf_t)    : '';
  });

  return flat;
}

// ── LOGOUT ───────────────────────────────────────────────────
async function _logoutUser(p, signal) {
  return { status:'ok', message:'Logout berhasil.' };
}

// ── RIWAYAT INSPEKSI ─────────────────────────────────────────
async function _getRiwayat(p, signal) {
  var noGardu = (p.noGardu || '').trim().toUpperCase();
  var res = await sbFetch(
    '/rest/v1/inspeksi?no_gardu=eq.' + encodeURIComponent(noGardu) +
    '&order=tgl_ukur.desc,jam_ukur.desc&limit=50',
    { signal: signal }
  );
  if (!res.ok) return { status:'error', message:'Gagal memuat riwayat inspeksi.' };
  var rows = await res.json();
  return { status:'ok', data: rows.map(_mapInspeksiRow) };
}

// ── REKAP GARDU SEDERHANA ────────────────────────────────────
async function _getRekapGardu(p, signal) {
  var url = '/rest/v1/gardu?select=no_gardu,ulp,unitup,penyulang,status_operasional,status_kepemilikan,tipe,kapasitas_kva&order=ulp.asc,no_gardu.asc';
  if (p && p.ulp) url += '&ulp=eq.' + encodeURIComponent(p.ulp);
  var res = await sbFetch(url, { signal:signal });
  if (!res.ok) return { status:'error', message:'Gagal memuat rekap gardu.' };
  var rows = await res.json();
  return {
    status: 'ok',
    data: rows.map(function(g){
      return {
        noGardu:    g.no_gardu || '',
        ulp:        g.ulp || '',
        unitup:     g.unitup || '',
        penyulang:  g.penyulang || '',
        statusOp:   g.status_operasional || '',
        kepemilikan:g.status_kepemilikan || '',
        tipe:       g.tipe || '',
        daya:       g.kapasitas_kva || ''
      };
    })
  };
}

// ── TAMBAH USER ──────────────────────────────────────────────
async function _tambahUser(p, signal) {
  var session = await _getUserFromToken(p.token);
  if (!session || session.role !== 'superadmin')
    return { status:'error', message:'Akses ditolak.' };
  var pwHash = await sha256(String(p.password || '').trim());
  var res = await sbRpc('fn_tambah_user', {
    p_token:         p.token,
    p_username:      (p.username||'').trim().toLowerCase(),
    p_password_hash: pwHash,
    p_nama:          p.nama || '',
    p_role:          p.role || 'petugas',
    p_ulp:           p.ulp  || null
  }, signal);
  if (!res.ok) { var t=await res.text(); return { status:'error', message:'Gagal tambah user. '+t }; }
  var raw = await res.json();
  var data = parseRpcJson(raw);
  if (!data || data.status !== 'ok')
    return { status:'error', message: (data && data.message) || 'Gagal tambah user.' };
  return { status:'ok', message: data.message };
}

// ── EDIT USER ────────────────────────────────────────────────
async function _editUser(p, signal) {
  var session = await _getUserFromToken(p.token);
  if (!session || session.role !== 'superadmin')
    return { status:'error', message:'Akses ditolak.' };
  var pwHash = (p.password && String(p.password).trim().length >= 4)
    ? await sha256(String(p.password).trim())
    : null;
  var res = await sbRpc('fn_edit_user', {
    p_token:         p.token,
    p_username_lama: p.usernameLama || p.username,
    p_nama:          p.nama || null,
    p_role:          p.role || null,
    p_ulp:           p.ulp !== undefined ? (p.ulp || null) : null,
    p_password_hash: pwHash
  }, signal);
  if (!res.ok) { var t=await res.text(); return { status:'error', message:'Gagal edit user. '+t }; }
  var raw = await res.json();
  var data = parseRpcJson(raw);
  if (!data || data.status !== 'ok')
    return { status:'error', message: (data && data.message) || 'Gagal edit user.' };
  return { status:'ok', message: data.message };
}

// ── GANTI PASSWORD ───────────────────────────────────────────
async function _gantiPassword(p, signal) {
  var oldHash = await sha256(String(p.passwordLama||'').trim());
  var newHash = await sha256(String(p.passwordBaru||'').trim());
  var res = await sbRpc('fn_ganti_password', {
    p_token:              p.token,
    p_password_hash_lama: oldHash,
    p_password_hash_baru: newHash
  }, signal);
  if (!res.ok) return { status:'error', message:'Gagal mengubah password.' };
  var raw = await res.json();
  var data = parseRpcJson(raw);
  if (!data || data.status !== 'ok')
    return { status:'error', message: (data && data.message) || 'Gagal mengubah password.' };
  return { status:'ok', message: data.message };
}

// ── VERIFY ULP PIN ───────────────────────────────────────────
async function _verifyULPPin(p, signal) {
  var pinHash   = await sha256(String(p.pin||'').trim());
  var ulpTarget = (p.ulp||'').trim().toUpperCase();
  var res = await sbRpc('fn_verify_ulp_pin', {
    p_pin_hash:   pinHash,
    p_ulp_target: ulpTarget
  }, signal);
  if (!res.ok) return { status:'error', message:'Gagal verifikasi PIN.' };
  var raw = await res.json();
  var data = parseRpcJson(raw);
  if (!data || data.status !== 'ok')
    return { status:'error', message: (data && data.message) || 'PIN salah.' };
  return { status:'ok', role: data.role, ulp: data.ulp };
}

// ── TOGGLE STATUS GARDU ──────────────────────────────────────
async function _toggleStatus(p, signal) {
  var session = await _getUserFromToken(p.token);
  if (!session) return { status:'error', message:'Sesi tidak valid.' };
  var res = await sbRpc('fn_toggle_status_gardu', {
    p_token:    p.token,
    p_no_gardu: p.noGardu,
    p_status:   (p.status||'AKTIF').toUpperCase()
  }, signal);
  if (!res.ok) return { status:'error', message:'Gagal mengubah status gardu.' };
  var raw = await res.json();
  var data = parseRpcJson(raw);
  if (!data || data.status !== 'ok')
    return { status:'error', message: (data && data.message) || 'Gagal.' };
  return { status:'ok', message: data.message };
}

// ── Override apiGet global ────────────────────────────────────
window.apiGet = function(params, cb) {
  var action = params.action || '';
  var p = Object.assign({}, params);
  delete p.action;
  apiCall(action, p, cb);
};

window._sbApiReady = true;
console.log('[Supabase API v7] Layer aktif. URL:', SUPABASE_URL);
