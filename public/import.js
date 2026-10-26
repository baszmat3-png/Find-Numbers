/* استيراد جهات الاتصال من ملفات VCF / Excel / CSV مع التعرف التلقائي على الحقول.
   يعمل بالكامل في المتصفح، ثم تُرسل النتيجة النهائية إلى الخادم. */
(function (w) {
  'use strict';

  var COUNTRIES = [['964','🇮🇶','العراق'],['966','🇸🇦','السعودية'],['971','🇦🇪','الإمارات'],['965','🇰🇼','الكويت'],['974','🇶🇦','قطر'],['973','🇧🇭','البحرين'],['968','🇴🇲','عُمان'],['962','🇯🇴','الأردن'],['963','🇸🇾','سوريا'],['961','🇱🇧','لبنان'],['970','🇵🇸','فلسطين'],['20','🇪🇬','مصر'],['967','🇾🇪','اليمن'],['218','🇱🇾','ليبيا'],['249','🇸🇩','السودان'],['216','🇹🇳','تونس'],['213','🇩🇿','الجزائر'],['212','🇲🇦','المغرب'],['90','🇹🇷','تركيا'],['98','🇮🇷','إيران'],['44','🇬🇧','بريطانيا'],['1','🇺🇸','أمريكا']];

  function fillCountries(sel) {
    sel.textContent = '';
    COUNTRIES.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c[0];
      o.textContent = c[1] + ' ' + c[2] + ' (+' + c[0] + ')';
      sel.appendChild(o);
    });
    sel.value = '964';
  }

  /* ---------- أدوات ---------- */
  function latin(s) {
    return String(s == null ? '' : s)
      .replace(/[٠-٩]/g, function (d) { return String.fromCharCode(d.charCodeAt(0) - 1632); })
      .replace(/[۰-۹]/g, function (d) { return String.fromCharCode(d.charCodeAt(0) - 1776); });
  }
  function digits(s) { return latin(s).replace(/\D/g, ''); }
  function phoneLike(s) { var n = digits(s).length; return n >= 7 && n <= 15; }
  function hasLetters(s) { return /[A-Za-z\u0600-\u06FF]/.test(s); }
  function norm(s) {
    return latin(s).toLowerCase().replace(/[\u064B-\u065F\u0670\u0640]/g, '')
      .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/\s+/g, ' ').trim();
  }
  function cellStr(v) {
    if (v == null) return '';
    if (typeof v === 'number') return String(v);
    return String(v).trim();
  }

  // أول رقم هاتف داخل الخلية (قد تحتوي أكثر من رقم)
  function firstPhone(cell) {
    var parts = cellStr(cell).split(/[;,\n\r\/|]|:::/);
    for (var i = 0; i < parts.length; i++) {
      if (phoneLike(parts[i])) return parts[i].trim();
    }
    return '';
  }

  // تحويل أي رقم إلى الصيغة الدولية +XXXXXXXX
  function toIntl(raw, cc) {
    var t = latin(raw).trim();
    var d = t.replace(/\D/g, '');
    var out;
    if (!d) return '';
    if (/^\s*\+/.test(t)) out = d;
    else if (d.indexOf('00') === 0) out = d.slice(2);
    else if (d.charAt(0) === '0') out = cc + d.replace(/^0+/, '');
    else if (d.indexOf(cc) === 0 && d.length >= cc.length + 9) out = d;
    else out = cc + d;
    return /^[1-9]\d{7,14}$/.test(out) ? '+' + out : '';
  }

  /* ---------- جداول Excel / CSV ---------- */
  var K = {
    name:  ['الاسم الكامل','الاسم','اسم','name','full name','fullname','display name','contact','جهه الاتصال','شخص'],
    first: ['الاسم الاول','الاول','first','given'],
    last:  ['العائله','الاخير','last','family','surname','لقب','الكنيه'],
    phone: ['رقم الهاتف','رقم الجوال','رقم','هاتف','جوال','موبايل','محمول','تلفون','تليفون','واتس','phone','mobile','tel','cell','whatsapp','number','gsm'],
    role:  ['المنصب','منصب','الوظيفه','وظيفه','المسمي','مسمي','title','position','job','role','designation','occupation','صفه','رتبه']
  };
  var NOT_PHONE = ['هويه','id','بطاقه','تسلسل','serial','عنوان','address'];
  Object.keys(K).forEach(function (k) { K[k] = K[k].map(norm); });

  function score(h, keys) {
    var hn = norm(h), best = 0;
    if (!hn) return 0;
    keys.forEach(function (k) {
      if (hn === k) best = Math.max(best, 3);
      else if (hn.indexOf(k) > -1) best = Math.max(best, 1);
    });
    return best;
  }
  function headerScores(h) {
    var s = { name: score(h, K.name), first: score(h, K.first), last: score(h, K.last), phone: score(h, K.phone), role: score(h, K.role) };
    var hn = norm(h);
    if (NOT_PHONE.some(function (x) { return hn.indexOf(x) > -1; })) s.phone = 0;
    if (s.first || s.last) s.name = 0;       // «الاسم الأول» ليس عمود الاسم الكامل
    return s;
  }

  function tableToRows(table) {
    var rows = table.map(function (r) { return r.map(cellStr); })
      .filter(function (r) { return r.some(function (c) { return c !== ''; }); });
    if (!rows.length) throw new Error('الملف فارغ');
    if (rows.length > 20000) rows = rows.slice(0, 20000);
    var ncol = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0);

    // البحث عن صف العناوين ضمن أول 5 صفوف
    var hdr = -1, hs = [], r, c, tmp, any;
    for (r = 0; r < Math.min(5, rows.length) && hdr < 0; r++) {
      tmp = []; any = 0;
      for (c = 0; c < ncol; c++) {
        var s = headerScores(rows[r][c] || '');
        tmp.push(s);
        if (s.name || s.first || s.last || s.phone || s.role) any++;
      }
      if (any) { hdr = r; hs = tmp; }
    }
    var start = hdr + 1;
    var data = rows.slice(start);
    if (!data.length) throw new Error('لا توجد بيانات تحت صف العناوين');

    // إحصاءات المحتوى لكل عمود
    var st = [];
    for (c = 0; c < ncol; c++) {
      var n = 0, ph = 0, al = 0;
      data.forEach(function (row) {
        var v = row[c] || '';
        if (!v) return;
        n++;
        if (firstPhone(v) && !hasLetters(v)) ph++;
        else if (hasLetters(v)) al++;
      });
      st.push({ n: n, ph: n ? ph / n : 0, al: n ? al / n : 0 });
    }

    function pick(field, minRatio, key) {
      var best = -1, bs = 0;
      for (var i = 0; i < ncol; i++) {
        var sc = hs[i] ? hs[i][field] : 0;
        if (sc && st[i][key] >= minRatio && sc > bs) { best = i; bs = sc; }
      }
      return best;
    }
    var phoneCol = pick('phone', 0.5, 'ph');
    if (phoneCol < 0) {                       // التعرف من المحتوى
      var bp = 0;
      for (c = 0; c < ncol; c++) if (st[c].ph >= 0.5 && st[c].ph > bp) { phoneCol = c; bp = st[c].ph; }
    }
    if (phoneCol < 0) throw new Error('لم أجد عمود أرقام الهواتف في الملف');

    var nameCol = pick('name', 0.3, 'al'), firstCol = pick('first', 0.3, 'al'), lastCol = pick('last', 0.3, 'al');
    var roleCol = pick('role', 0.3, 'al');
    if (nameCol < 0 && firstCol < 0 && lastCol < 0) {
      for (c = 0; c < ncol; c++) {            // أول عمود نصي
        if (c !== phoneCol && c !== roleCol && st[c].al >= 0.5) { nameCol = c; break; }
      }
    }
    if (nameCol < 0 && firstCol < 0 && lastCol < 0) throw new Error('لم أجد عمود الأسماء في الملف');
    if (hdr < 0 && roleCol < 0) {              // بدون عناوين: العمود النصي التالي هو المنصب
      for (c = 0; c < ncol; c++) {
        if (c !== phoneCol && c !== nameCol && st[c].al >= 0.5) { roleCol = c; break; }
      }
    }

    var out = [], skipped = 0;
    data.forEach(function (row) {
      var name = nameCol >= 0 ? row[nameCol] : [row[firstCol] || '', row[lastCol] || ''].join(' ').trim();
      if (nameCol < 0 && firstCol >= 0 && lastCol >= 0) name = ((row[firstCol] || '') + ' ' + (row[lastCol] || '')).trim();
      var phone = firstPhone(row[phoneCol] || '');
      if (!name || !hasLetters(name) || !phone) { skipped++; return; }
      out.push({ name: name.replace(/\s+/g, ' '), role: roleCol >= 0 ? (row[roleCol] || '') : '', phone: phone });
    });
    return { rows: out, skipped: skipped, total: data.length };
  }

  /* ---------- VCF ---------- */
  function qp(s) {
    s = s.replace(/%/g, '%25').replace(/=([0-9A-Fa-f]{2})/g, '%$1');
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }
  function unesc(s) { return String(s).replace(/\\n/gi, ' ').replace(/\\([,;\\:])/g, '$1'); }

  function fromVcf(text) {
    var raw = text.replace(/\r\n?/g, '\n').split('\n'), lines = [], i, ln;
    for (i = 0; i < raw.length; i++) {
      ln = raw[i];
      if (/ENCODING=QUOTED-PRINTABLE/i.test(ln)) {
        while (ln.slice(-1) === '=' && i + 1 < raw.length) ln = ln.slice(0, -1) + raw[++i];
      }
      if (lines.length && /^[ \t]/.test(ln)) lines[lines.length - 1] += ln.slice(1);
      else lines.push(ln);
    }
    var cards = [], cur = null;
    lines.forEach(function (l) {
      if (/^BEGIN:VCARD/i.test(l)) { cur = { tel: [] }; return; }
      if (/^END:VCARD/i.test(l)) { if (cur) cards.push(cur); cur = null; return; }
      if (!cur) return;
      var idx = l.indexOf(':');
      if (idx < 1) return;
      var left = l.slice(0, idx), val = l.slice(idx + 1);
      var prop = left.split(';')[0].toUpperCase().replace(/^.*\./, '');
      if (/ENCODING=QUOTED-PRINTABLE/i.test(left)) val = qp(val);
      if (prop === 'FN') cur.fn = unesc(val).trim();
      else if (prop === 'N') { var p = val.split(';').map(unesc); cur.n = [p[1], p[2], p[0]].filter(Boolean).join(' ').trim(); }
      else if (prop === 'TEL') cur.tel.push(unesc(val).replace(/^tel:/i, ''));
      else if (prop === 'TITLE') cur.title = unesc(val).trim();
      else if (prop === 'ROLE') cur.role = unesc(val).trim();
      else if (prop === 'ORG') cur.org = val.split(';').map(unesc).filter(Boolean).join(' - ');
    });
    if (!cards.length) throw new Error('الملف لا يحتوي جهات اتصال (VCF)');
    var out = [], skipped = 0;
    cards.forEach(function (c) {
      var name = (c.fn || c.n || c.org || '').trim();
      var phone = '';
      for (var j = 0; j < c.tel.length; j++) if (phoneLike(c.tel[j])) { phone = c.tel[j]; break; }
      if (!name || !phone) { skipped++; return; }
      out.push({ name: name, role: c.title || c.role || c.org || '', phone: phone });
    });
    return { rows: out, skipped: skipped, total: cards.length };
  }

  /* ---------- قراءة الملفات ---------- */
  function readText(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(String(fr.result).replace(/^\ufeff/, '')); };
      fr.onerror = function () { rej(new Error('تعذّرت قراءة الملف')); };
      fr.readAsText(file, 'UTF-8');
    });
  }
  function readBuf(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(new Error('تعذّرت قراءة الملف')); };
      fr.readAsArrayBuffer(file);
    });
  }
  function loadXlsx() {
    return new Promise(function (res, rej) {
      if (w.XLSX) return res();
      var s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload = function () { res(); };
      s.onerror = function () { rej(new Error('تعذّر تحميل مكتبة Excel، تحقق من الاتصال بالإنترنت')); };
      document.head.appendChild(s);
    });
  }
  function fromWorkbook(wb) {
    var firstErr = null;
    for (var i = 0; i < wb.SheetNames.length; i++) {
      var ws = wb.Sheets[wb.SheetNames[i]];
      var table = w.XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
      try { return tableToRows(table); } catch (e) { firstErr = firstErr || e; }
    }
    throw firstErr || new Error('الملف فارغ');
  }

  function parseFile(file) {
    if (!file) return Promise.reject(new Error('لم يتم اختيار ملف'));
    if (file.size > 5 * 1024 * 1024) return Promise.reject(new Error('حجم الملف كبير (الحد الأقصى 5 ميغابايت)'));
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext === 'vcf' || ext === 'vcs' || ext === 'vcard') {
      return readText(file).then(fromVcf);
    }
    if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
      return Promise.all([readText(file), loadXlsx()]).then(function (a) {
        if (/BEGIN:VCARD/i.test(a[0])) return fromVcf(a[0]);
        return fromWorkbook(w.XLSX.read(a[0], { type: 'string' }));
      });
    }
    if (['xlsx', 'xls', 'xlsm', 'xlsb', 'ods'].indexOf(ext) > -1) {
      return Promise.all([readBuf(file), loadXlsx()]).then(function (a) {
        return fromWorkbook(w.XLSX.read(a[0], { type: 'array' }));
      });
    }
    return Promise.reject(new Error('نوع الملف غير مدعوم، استخدم Excel أو CSV أو VCF'));
  }

  // تطبيق رمز البلد وإزالة التكرار داخل الملف
  function finalize(rows, cc) {
    var list = [], seen = {}, invalid = 0, dup = 0;
    rows.forEach(function (r) {
      var p = toIntl(r.phone, cc);
      if (!p) { invalid++; return; }
      if (seen[p]) { dup++; return; }
      seen[p] = 1;
      list.push({ name: r.name, role: r.role || '', phone: p });
    });
    return { list: list, invalid: invalid, dup: dup };
  }

  function upload(url, contacts, headers) {
    var h = { 'Content-Type': 'application/json' };
    if (headers) Object.keys(headers).forEach(function (k) { h[k] = headers[k]; });
    return fetch(url, { method: 'POST', headers: h, body: JSON.stringify({ contacts: contacts }) }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || 'تعذّر الاستيراد');
        return j;
      });
    });
  }

  w.ContactImport = { fillCountries: fillCountries, parseFile: parseFile, finalize: finalize, upload: upload, toIntl: toIntl };
})(window);
