/* =====================================================================
   访古 · 主逻辑
   纯前端，无依赖（除本地 Leaflet），数据存在浏览器 localStorage 里。
   ===================================================================== */

(function () {
  'use strict';

  /* ------------------------------------------------------------------
     1. 常量
     ------------------------------------------------------------------ */

  const KEY = { visits: 'fg_visits_v1', custom: 'fg_custom_v1', prefs: 'fg_prefs_v1', coords: 'fg_coords_v1' };

  const LEVELS = {
    gb:   { short: '国保', full: '全国重点文物保护单位' },
    sb:   { short: '省保', full: '省级文物保护单位' },
    shi:  { short: '市保', full: '市级文物保护单位' },
    xian: { short: '县保', full: '县级文物保护单位' },
    none: { short: '未定级', full: '未定级不可移动文物' }
  };

  const STATUS = {
    open:    '正常开放',
    book:    '需预约',
    closed:  '未开放',
    gone:    '已毁 / 仅存遗址',
    unknown: '情况不详'
  };

  const CATS = ['古建筑', '古遗址', '古墓葬', '石窟寺及石刻', '近现代重要史迹及代表性建筑', '其他'];

  const BASE = {
    amap:  { url: 'https://wprd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&style=7&x={x}&y={y}&z={z}', attr: '© 高德地图', max: 18, sub: '1234' },
    osm:   { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attr: '© OpenStreetMap contributors', max: 19 },
    carto: { url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', attr: '© OpenStreetMap © CARTO', max: 20, sub: 'abcd' },
    esri:  { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', attr: '© Esri', max: 19 }
  };

  /* ------------------------------------------------------------------
     2. 工具函数
     ------------------------------------------------------------------ */

  const $ = (sel) => document.querySelector(sel);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  function today() {
    const d = new Date();
    const p = (n) => (n < 10 ? '0' : '') + n;
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function dist(a, b) {
    const R = 6371000;
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLon = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function fmtDist(m) {
    if (m < 950) return Math.round(m / 10) * 10 + ' m';
    return (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
  }

  function levelOf(s) { return LEVELS[s.level] ? s.level : 'none'; }

  let hintTimer = null;
  function showHint(text, ms) {
    const el = $('#map-hint');
    if (!el) return;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(hintTimer);
    if (ms) hintTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  let toastTimer = null;
  function toast(msg) {
    let el = $('#toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  /* ------------------------------------------------------------------
     3. 状态
     ------------------------------------------------------------------ */

  const state = {
    sites: [],
    visits: readJSON(KEY.visits, {}),
    custom: readJSON(KEY.custom, []),
    coords: readJSON(KEY.coords, {}),
    prefs: Object.assign({ basemap: 'amap', me: null }, readJSON(KEY.prefs, {})),
    filter: { q: '', level: 'all', visit: 'all' },
    view: 'map',
    me: null,
    map: null,
    tile: null,
    pinLayer: null,
    meMarker: null,
    fitted: false,
    tapToLocate: false,
    pickFor: null,
    currentId: null,
    pendingPhoto: null
  };

  state.me = state.prefs.me || null;

  function savePrefs() {
    state.prefs.me = state.me;
    writeJSON(KEY.prefs, state.prefs);
  }

  function allSites() {
    const seed = (window.WENBAO_SEED || []).map((s) => Object.assign({ source: 'seed' }, s));
    const mine = (state.custom || []).map((s) => Object.assign({ source: 'custom' }, s));
    return seed.concat(mine).map((s) => {
      const ov = state.coords[s.id];
      const lat = ov ? Number(ov.lat) : (s.lat == null ? NaN : Number(s.lat));
      const lng = ov ? Number(ov.lng) : (s.lng == null ? NaN : Number(s.lng));
      const geo = isFinite(lat) && isFinite(lng) && !(lat === 0 && lng === 0);
      return Object.assign({}, s, { lat: geo ? lat : null, lng: geo ? lng : null, geo: geo });
    });
  }

  /* 数据里没有坐标时，用现有数据的中心兜底（换城市不用改代码） */
  function seedCenter() {
    const pts = (window.WENBAO_SEED || []).filter((s) => s.lat != null && s.lng != null);
    if (!pts.length) return { lat: 30.25, lng: 120.16 };
    /* 用中位数而不是平均数：不会被几个远郊点把视线拉走 */
    const med = (arr) => {
      const a = arr.slice().sort((x, y) => x - y);
      return a[Math.floor(a.length / 2)];
    };
    return { lat: med(pts.map((s) => Number(s.lat))), lng: med(pts.map((s) => Number(s.lng))) };
  }

  /* ------------------------------------------------------------------
     4. 地图
     ------------------------------------------------------------------ */

  function initMap() {
    if (!window.L) {
      $('#map').innerHTML = '<div class="empty">地图库没能加载。<br>请确认 vendor/leaflet.js 和这个页面在同一个文件夹里。</div>';
      return;
    }

    const c0 = seedCenter();
    state.map = L.map('map', { zoomControl: false, zoomSnap: 0.5, minZoom: 4, maxZoom: 19 }).setView([c0.lat, c0.lng], 11);
    L.control.zoom({ position: 'bottomright' }).addTo(state.map);

    /* 总览缩放下把挨得太近的点合并成带数字的圆，点开再展开。
       插件没加载成功时退回普通图层，不至于白屏。 */
    const clusterOpts = {
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,
      disableClusteringAtZoom: 15,
      maxClusterRadius: 48,
      chunkedLoading: true,
      iconCreateFunction: (cluster) => {
        const n = cluster.getChildCount();
        const size = n < 10 ? 34 : n < 100 ? 40 : 46;
        return L.divIcon({
          html: '<div class="ccluster">' + n + '</div>',
          className: 'ccluster-wrap',
          iconSize: L.point(size, size)
        });
      }
    };
    state.pinLayer = (typeof L.markerClusterGroup === 'function'
      ? L.markerClusterGroup(clusterOpts)
      : L.layerGroup()).addTo(state.map);

    applyBasemap(state.prefs.basemap || 'osm');

    state.map.on('click', (e) => {
      if (state.pickFor) { finishPin(e.latlng); return; }
      if (!state.tapToLocate) return;
      setMe(e.latlng.lat, e.latlng.lng);
      state.tapToLocate = false;
      toast('已把你的位置设在这里（只在本次记录里用作距离参考）');
    });
  }

  function applyBasemap(key) {
    const b = BASE[key] || BASE.osm;
    if (state.tile) state.map.removeLayer(state.tile);
    state.tile = L.tileLayer(b.url, {
      maxZoom: b.max,
      subdomains: b.sub || 'abc',
      attribution: b.attr
    });
    state.tile.addTo(state.map);
    state.tile.bringToBack();

    let errs = 0;
    state.tile.on('tileerror', () => {
      errs += 1;
      if (errs === 3) {
        showHint('底图没加载出来，可能被网络挡住了。到「我的 → 底图」换一个再试。', 9000);
      }
    });
    state.prefs.basemap = BASE[key] ? key : 'amap';
    savePrefs();
    renderPins();
    drawMe();
  }

  function pinIcon(site) {
    const visited = !!state.visits[site.id];
    return L.divIcon({
      className: 'pin-wrap',
      html: '<div class="pin lv-' + levelOf(site) + (visited ? ' is-visited' : '') + '">' +
            (visited ? '✓' : '') + '</div>',
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    });
  }

  function renderPins() {
    if (!state.map) return;
    state.pinLayer.clearLayers();
    state.sites.forEach((s) => {
      if (!s.geo) return;
      const m = L.marker([s.lat, s.lng], { icon: pinIcon(s), title: s.name });
      m.on('click', () => showSite(s.id));
      m.addTo(state.pinLayer);
    });
  }

  function fitToSites() {
    if (!state.map || state.fitted) return;
    /* 数据横跨太远（比如含远郊县）时不做自动缩放，否则会被拉到全省视野 */
    const lats = state.sites.filter((s) => s.geo).map((s) => s.lat);
    const lngs = state.sites.filter((s) => s.geo).map((s) => s.lng);
    if (lats.length < 2) { state.fitted = true; return; }
    const span = Math.max(
      Math.max(...lats) - Math.min(...lats),
      Math.max(...lngs) - Math.min(...lngs)
    );
    if (span > 1.2) { state.fitted = true; return; }
    const pts = state.sites.filter((s) => s.geo).map((s) => [s.lat, s.lng]);
    if (!pts.length) return;
    state.map.fitBounds(L.latLngBounds(pts).pad(0.16), { maxZoom: 13, animate: false });
    state.fitted = true;
  }

  function setMe(lat, lng) {
    state.me = { lat: lat, lng: lng };
    savePrefs();
    drawMe();
    renderList();
  }

  function drawMe() {
    if (!state.map) return;
    if (state.meMarker) { state.map.removeLayer(state.meMarker); state.meMarker = null; }
    if (!state.me) return;
    state.meMarker = L.marker([state.me.lat, state.me.lng], {
      icon: L.divIcon({ className: 'pin-wrap', html: '<div class="me-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
      interactive: false,
      zIndexOffset: 1000
    }).addTo(state.map);
  }

  function locate() {
    if (!navigator.geolocation) {
      toast('这个浏览器不支持定位，请在地图上点一下手动设置位置');
      state.tapToLocate = true;
      return;
    }
    toast('正在定位…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setMe(pos.coords.latitude, pos.coords.longitude);
        state.map.flyTo([state.me.lat, state.me.lng], 14, { duration: 0.7 });
        toast('定位成功，右侧列表已按距离排序');
      },
      () => {
        state.tapToLocate = true;
        toast('拿不到定位（手机浏览器要用 https 才允许定位）。请在地图上点一下，把那里设为你的位置。');
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
  }

  /* ------------------------------------------------------------------
     5. 列表
     ------------------------------------------------------------------ */

  function visibleSites() {
    const q = state.filter.q.trim().toLowerCase();
    const out = state.sites.filter((s) => {
      if (state.filter.level !== 'all' && levelOf(s) !== state.filter.level) return false;
      const visited = !!state.visits[s.id];
      if (state.filter.visit === 'visited' && !visited) return false;
      if (state.filter.visit === 'unvisited' && visited) return false;
      if (!q) return true;
      const hay = [s.name, s.addr, s.era, s.category, s.batch, s.note, s.status]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
    if (state.me) {
      out.sort((a, b) => {
        if (!a.geo && !b.geo) return 0;
        if (!a.geo) return 1;
        if (!b.geo) return -1;
        return dist(state.me, a) - dist(state.me, b);
      });
    }
    return out;
  }

  function renderList() {
    const list = visibleSites();
    const box = $('#list-body');

    const count = $('#list-count');
    if (count) {
      const visited = state.sites.filter((s) => state.visits[s.id]).length;
      count.textContent = '共 ' + state.sites.length + ' 处 · 已到访 ' + visited + ' 处' +
        (state.me ? ' · 按距离排序' : '');
    }

    if (!list.length) {
      box.innerHTML = '<div class="empty">没有匹配的条目。<br>换个关键词，或点右上角 ＋ 自己加一处。</div>';
      return;
    }

    box.innerHTML = list.map((s) => {
      const v = state.visits[s.id];
      const d = (state.me && s.geo) ? dist(state.me, s) : null;
      return '<button class="card" data-id="' + esc(s.id) + '">' +
        '<div class="card-main">' +
          '<div class="card-name">' + esc(s.name) +
            (v ? '<span class="tick">✓</span>' : '') +
          '</div>' +
          '<div class="card-sub">' + esc(s.category || '未分类') + (s.era ? ' · ' + esc(s.era) : '') + '</div>' +
          '<div class="card-meta">' +
            esc(LEVELS[levelOf(s)].short) +
            (s.batch ? ' · ' + esc(s.batch) : '') +
            (s.geo && s.status ? ' · ' + esc(STATUS[s.status] || s.status) : '') +
            (s.geo ? '' : ' · <span class="nogps">坐标待补</span>') +
          '</div>' +
        '</div>' +
        (d != null ? '<span class="distance">' + fmtDist(d) + '</span>' : '') +
        '<span class="chev">›</span>' +
      '</button>';
    }).join('');
  }

  /* ------------------------------------------------------------------
     6. “我的”页
     ------------------------------------------------------------------ */

  function installRowHtml() {
    const standalone = window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true;
    let sub, btn = '';
    if (standalone) {
      sub = '已安装，正在独立窗口运行';
    } else if (state.installEvt) {
      sub = '像 App 一样全屏打开，不带地址栏';
      btn = '<button class="btn slim ghost" style="flex:0 0 76px" data-act="install">安装</button>';
    } else if (!window.isSecureContext) {
      sub = '当前 http 访问，浏览器不允许安装；换成 https 后这里会出现安装按钮';
    } else {
      sub = '浏览器菜单里选「添加到主屏幕」';
    }
    return '<div class="panel-row"><span>添加到手机桌面<span class="sub">' + sub + '</span></span>' + btn + '</div>';
  }

  function renderMe() {
    const total = state.sites.length;
    const visited = state.sites.filter((s) => state.visits[s.id]).length;
    const pct = total ? Math.round((visited / total) * 100) : 0;
    const geoN = state.sites.filter((s) => s.geo).length;

    const byLevel = Object.keys(LEVELS).map((k) => {
      const all = state.sites.filter((s) => levelOf(s) === k);
      const done = all.filter((s) => state.visits[s.id]).length;
      return { k: k, all: all.length, done: done };
    }).filter((r) => r.all > 0);

    const rows = byLevel.map((r) => {
      const p = r.all ? Math.round((r.done / r.all) * 100) : 0;
      return '<div class="level-row">' +
        '<span class="lv-name">' + esc(LEVELS[r.k].short) + '</span>' +
        '<span class="mini"><i style="width:' + p + '%"></i></span>' +
        '<span class="lv-num">' + r.done + ' / ' + r.all + '</span>' +
      '</div>';
    }).join('') || '<div class="empty">还没有数据</div>';

    const notes = Object.keys(state.visits)
      .filter((id) => state.visits[id] && state.visits[id].note)
      .slice(0, 3)
      .map((id) => {
        const s = state.sites.filter((x) => x.id === id)[0];
        if (!s) return '';
        return '<div class="panel-row"><span>' + esc(s.name) +
          '<span class="sub">' + esc(state.visits[id].note.slice(0, 40)) + '</span></span></div>';
      }).join('');

    $('#me-body').innerHTML =
      '<div class="hero">' +
        '<div class="hero-label">我的访古进度</div>' +
        '<div class="hero-num">' + visited + '<small>/ ' + total + ' 处</small></div>' +
        '<div class="bar"><i class="bar-fill" style="width:' + pct + '%"></i></div>' +
        '<div class="hero-foot">已走完 ' + pct + '%　·　还剩 ' + (total - visited) + ' 处没去</div>' +
      '</div>' +

      '<div class="section">' +
        '<h2 class="section-title">分级进度</h2>' + rows +
      '</div>' +

      (notes ? '<div class="section"><h2 class="section-title">最近的记录</h2><div class="panel">' + notes + '</div></div>' : '') +

      '<div class="section">' +
        '<h2 class="section-title">安装</h2>' +
        '<div class="panel">' + installRowHtml() + '</div>' +
      '</div>' +

      '<div class="section">' +
        '<h2 class="section-title">数据</h2>' +
        '<div class="panel">' +
          '<div class="panel-row"><span>导出备份<span class="sub">换成新手机、或清理浏览器前先导出</span></span>' +
            '<button class="btn slim ghost" style="flex:0 0 74px" data-act="export">导出</button></div>' +
          '<div class="panel-row"><span>导入备份</span>' +
            '<button class="btn slim ghost" style="flex:0 0 74px" data-act="import">导入</button></div>' +
          '<div class="panel-row"><span>清空所有记录<span class="sub">只删到访记录和自建条目</span></span>' +
            '<button class="btn slim danger" style="flex:0 0 74px" data-act="clear">清空</button></div>' +
          '<div class="panel-row"><span>底图</span>' +
            '<select class="inline" id="basemap-sel">' +
              '<option value="amap">高德（国内最快）</option>' +
              '<option value="osm">OpenStreetMap</option>' +
              '<option value="carto">CARTO</option>' +
              '<option value="esri">Esri</option>' +
            '</select></div>' +
        '</div>' +
      '</div>' +

      '<div class="section">' +
        '<h2 class="section-title">说明</h2>' +
        '<p class="tips">' +
          '<b>数据存在这台设备的浏览器里</b>，不会上传。换浏览器、清理缓存会丢，请定期“导出备份”。<br>' +
          '共 ' + total + ' 处，其中 ' + geoN + ' 处有坐标、' + (total - geoN) + ' 处待补（到现场用「在地图上定坐标」补）。<br>' +
          '名录来自公开资料（维基百科 CC BY-SA），名称与批次以官方公布为准，坐标请实地核对。<br>' +
          '地图瓦片需要联网；国内如加载慢，在“底图”里换一个。<br>' +
          '其中 ' + (state.custom || []).length + ' 处是你自己添加的。' +
        '</p>' +
      '</div>' +

      '<input type="file" id="import-file" accept="application/json,.json" class="ghost-file">';

    const sel = $('#basemap-sel');
    if (sel) sel.value = state.prefs.basemap || 'amap';
  }

  /* ------------------------------------------------------------------
     7. 详情浮层
     ------------------------------------------------------------------ */

  const sheet = $('#sheet');
  const sheetBody = $('#sheet-body');
  const overlay = $('#overlay');

  function openSheet(html) {
    sheetBody.innerHTML = html;
    sheetBody.scrollTop = 0;
    /* 同步加类，避免连续打开/关闭时被延迟的 rAF 抢先 */
    void sheet.offsetHeight;
    sheet.classList.add('open');
    overlay.classList.add('on');
  }

  function closeSheet() {
    sheet.classList.remove('open');
    overlay.classList.remove('on');
    state.currentId = null;
    state.pendingPhoto = null;
  }

  /* 浮层会盖住下半屏，把选中的点移到上方可见区域 */
  function focusOn(site) {
    if (!state.map) return;
    const size = state.map.getSize();
    /* 至少到 15 级：低于这个级别会被聚合圆吞掉，看不出是哪一个 */
    const z = Math.max(state.map.getZoom(), 15);
    const cur = state.map.latLngToContainerPoint([site.lat, site.lng]);
    const lowEnough = cur.y > size.y * 0.30;
    if (lowEnough || cur.y < 12 || cur.x < 24 || cur.x > size.x - 24) {
      const pt = state.map.project([site.lat, site.lng], z);
      const c = state.map.unproject(L.point(pt.x, pt.y + size.y * 0.28), z);
      state.map.setView(c, z, { animate: true, duration: 0.45 });
    }
  }

  function showSite(id) {
    const s = state.sites.filter((x) => x.id === id)[0];
    if (!s) return;
    state.currentId = id;
    if (s.geo) focusOn(s);
    const v = state.visits[id];
    const lv = levelOf(s);
    const navUrl = 'https://uri.amap.com/marker?position=' + s.lng + ',' + s.lat +
      '&name=' + encodeURIComponent(s.name) + '&coordinate=wgs84';

    openSheet(
      '<div class="sheet-head">' +
        '<div class="sheet-title">' + esc(s.name) + '</div>' +
        '<button class="sheet-close" data-act="close">✕</button>' +
      '</div>' +
      '<div class="badges">' +
        '<span class="badge lv-' + lv + '">' + esc(LEVELS[lv].short) + '</span>' +
        (s.batch ? '<span class="badge">' + esc(s.batch) + (s.year ? ' · ' + esc(s.year) : '') + '</span>' : '') +
        (s.category ? '<span class="badge">' + esc(s.category) + '</span>' : '') +
        (s.source === 'custom' ? '<span class="badge">我添加的</span>' : '') +
      '</div>' +
      '<div class="meta">' +
        '<div class="meta-row"><span class="meta-k">级别</span><span class="meta-v">' + esc(LEVELS[lv].full) + '</span></div>' +
        (s.era ? '<div class="meta-row"><span class="meta-k">年代</span><span class="meta-v">' + esc(s.era) + '</span></div>' : '') +
        (s.addr ? '<div class="meta-row"><span class="meta-k">地址</span><span class="meta-v">' + esc(s.addr) + '</span></div>' : '') +
        (s.status ? '<div class="meta-row"><span class="meta-k">现状</span><span class="meta-v">' +
          '<span class="pill ' + esc(s.status) + '">' + esc(STATUS[s.status] || s.status) + '</span></span></div>' : '') +
        '<div class="meta-row"><span class="meta-k">坐标</span><span class="meta-v">' +
          (s.geo
            ? s.lat.toFixed(5) + ', ' + s.lng.toFixed(5) + ' <a href="#" data-act="copy" style="font-size:12px">复制</a>'
            : '<span style="color:var(--muted)">还没有坐标</span>') +
          '</span></div>' +
      '</div>' +
      (s.note ? '<p class="note">' + esc(s.note) + '</p>' : '') +
      '<div class="visit-box">' + visitBoxHtml(v) + '</div>' +
      '<div class="btn-row">' +
        (s.geo
          ? '<a class="btn ghost" href="' + navUrl + '" target="_blank" rel="noopener">高德导航</a>'
          : '<button class="btn ghost" data-act="pin">在地图上定坐标</button>') +
        '<button class="btn primary" data-act="visit">' + (v ? '编辑到访记录' : '标记为已到访') + '</button>' +
      '</div>' +
      (s.source === 'custom'
        ? '<div class="btn-row" style="margin-top:8px"><button class="btn danger slim" data-act="del-site">删除这一条</button></div>'
        : '')
    );
  }

  function visitBoxHtml(v) {
    if (!v) {
      return '<div class="visit-empty">还没去过。到过之后点下面的按钮记一笔，会记下日期、笔记和照片。</div>';
    }
    return '<div class="visit-head"><span class="dot"></span>已到访</div>' +
      '<div class="visit-date">' + esc(v.date || '') + '</div>' +
      (v.note ? '<div class="visit-note">' + esc(v.note) + '</div>' : '') +
      (v.photo ? '<img class="visit-photo" src="' + esc(v.photo) + '" alt="到访照片">' : '');
  }

  /* 让用户在地图上点一下，为某处补坐标 */
  function startPin(id) {
    const s = state.sites.filter((x) => x.id === id)[0];
    if (!s) return;
    closeSheet();
    switchView('map');
    state.pickFor = id;
    document.body.classList.add('picking');
    showHint('在地图上点一下，把「' + s.name + '」定在那里', 0);
  }

  function finishPin(latlng) {
    const id = state.pickFor;
    const s = state.sites.filter((x) => x.id === id)[0];
    state.coords[id] = { lat: +latlng.lat.toFixed(6), lng: +latlng.lng.toFixed(6) };
    writeJSON(KEY.coords, state.coords);
    state.pickFor = null;
    document.body.classList.remove('picking');
    const hint = $('#map-hint');
    if (hint) hint.classList.remove('show');
    refresh();
    showSite(id);
    if (s) toast('已为「' + s.name + '」记下坐标，记得实地核对');
  }

  function showVisitForm(id) {
    const s = state.sites.filter((x) => x.id === id)[0];
    const v = state.visits[id] || {};
    state.pendingPhoto = v.photo || null;

    openSheet(
      '<div class="sheet-head">' +
        '<div class="sheet-title">记录 · ' + esc(s.name) + '</div>' +
        '<button class="sheet-close" data-act="back-site">✕</button>' +
      '</div>' +
      '<div class="field">' +
        '<label>到访日期</label>' +
        '<input type="date" id="f-date" value="' + esc(v.date || today()) + '">' +
      '</div>' +
      '<div class="field">' +
        '<label>笔记</label>' +
        '<textarea id="f-note" placeholder="看到了什么？能不能进？有没有人管？值不值得再来？">' + esc(v.note || '') + '</textarea>' +
      '</div>' +
      '<div class="field">' +
        '<label>照片（可选，自动压缩后存在本机）</label>' +
        '<input type="file" id="f-photo" accept="image/*" class="ghost-file">' +
        '<button class="file-btn' + (v.photo ? ' has-file' : '') + '" data-act="pick-photo" id="f-pick">' +
          (v.photo ? '已有一张，点此更换' : '＋ 添加照片') + '</button>' +
        '<img class="preview" id="f-preview" src="' + (v.photo ? esc(v.photo) : '') + '"' + (v.photo ? '' : ' hidden') + ' alt="预览">' +
      '</div>' +
      '<div class="btn-row">' +
        '<button class="btn ghost" data-act="back-site">取消</button>' +
        '<button class="btn ok" data-act="save-visit">保存</button>' +
      '</div>' +
      (v.date ? '<div class="btn-row" style="margin-top:8px"><button class="btn danger slim" data-act="del-visit">删除这条记录</button></div>' : '')
    );

    const file = $('#f-photo');
    file.addEventListener('change', async () => {
      const f = file.files && file.files[0];
      if (!f) return;
      try {
        const dataUrl = await compressImage(f, 760, 0.62);
        state.pendingPhoto = dataUrl;
        const prev = $('#f-preview');
        prev.src = dataUrl;
        prev.hidden = false;
        const pick = $('#f-pick');
        pick.classList.add('has-file');
        pick.textContent = '已选择，点此更换';
      } catch (e) {
        toast('照片读取失败，可以只保存文字');
      }
    });
  }

  function compressImage(file, maxSide, quality) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        const scale = Math.min(1, maxSide / Math.max(w, h));
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
      img.src = url;
    });
  }

  function saveVisit(id) {
    const date = ($('#f-date') && $('#f-date').value) || today();
    const note = ($('#f-note') && $('#f-note').value.trim()) || '';
    const rec = { date: date, note: note };
    if (state.pendingPhoto) rec.photo = state.pendingPhoto;

    state.visits[id] = rec;
    const ok = writeJSON(KEY.visits, state.visits);
    if (!ok) {
      toast('存储空间满了：照片没存下，文字记录已保留');
      delete rec.photo;
      state.visits[id] = rec;
      writeJSON(KEY.visits, state.visits);
    }
    state.pendingPhoto = null;
    refresh();
    showSite(id);
    toast('已记录 · ' + date);
  }

  /* ------------------------------------------------------------------
     8. 添加一处（自建条目）
     ------------------------------------------------------------------ */

  function showAddForm() {
    const c = state.map ? state.map.getCenter() : seedCenter();
    state.pendingPhoto = null;

    openSheet(
      '<div class="sheet-head">' +
        '<div class="sheet-title">添加一处</div>' +
        '<button class="sheet-close" data-act="close">✕</button>' +
      '</div>' +
      '<div class="field">' +
        '<label>名称 *</label>' +
        '<input type="text" id="a-name" placeholder="例如：某某村石塔">' +
      '</div>' +
      '<div class="field-row">' +
        '<div class="field"><label>级别</label><select id="a-level">' +
          Object.keys(LEVELS).map((k) => '<option value="' + k + '">' + LEVELS[k].short + '</option>').join('') +
        '</select></div>' +
        '<div class="field"><label>类型</label><select id="a-cat">' +
          CATS.map((c2) => '<option value="' + esc(c2) + '">' + esc(c2) + '</option>').join('') +
        '</select></div>' +
      '</div>' +
      '<div class="field-row">' +
        '<div class="field"><label>批次</label><input type="text" id="a-batch" placeholder="如 第四批"></div>' +
        '<div class="field"><label>年代</label><input type="text" id="a-era" placeholder="如 明"></div>' +
      '</div>' +
      '<div class="field"><label>地址</label><input type="text" id="a-addr" placeholder="到村一级就够"></div>' +
      '<div class="field-row">' +
        '<div class="field"><label>纬度 lat</label><input type="number" id="a-lat" step="0.00001" value="' + c.lat.toFixed(5) + '"></div>' +
        '<div class="field"><label>经度 lng</label><input type="number" id="a-lng" step="0.00001" value="' + c.lng.toFixed(5) + '"></div>' +
      '</div>' +
      '<div class="field"><label>现状</label><select id="a-status">' +
        Object.keys(STATUS).map((k) => '<option value="' + k + '">' + STATUS[k] + '</option>').join('') +
      '</select></div>' +
      '<div class="field"><label>备注</label><textarea id="a-note" placeholder="怎么找到的、能不能进、有什么细节…"></textarea></div>' +
      '<div class="btn-row">' +
        '<button class="btn ghost" data-act="close">取消</button>' +
        '<button class="btn primary" data-act="save-site">保存</button>' +
      '</div>' +
      '<p class="tips" style="margin-top:10px">坐标默认取当前地图中心。更准的做法：用手机相机的定位信息、或在高德长按地点查坐标。</p>'
    );
  }

  function saveNewSite() {
    const name = ($('#a-name').value || '').trim();
    const lat = parseFloat($('#a-lat').value);
    const lng = parseFloat($('#a-lng').value);
    if (!name) { toast('先填个名称'); return; }
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      toast('坐标不对，检查一下纬度和经度');
      return;
    }
    const site = {
      id: 'my-' + Date.now().toString(36),
      name: name,
      level: $('#a-level').value,
      category: $('#a-cat').value,
      batch: ($('#a-batch').value || '').trim(),
      era: ($('#a-era').value || '').trim(),
      addr: ($('#a-addr').value || '').trim(),
      lat: lat,
      lng: lng,
      status: $('#a-status').value,
      note: ($('#a-note').value || '').trim()
    };
    state.custom.push(site);
    writeJSON(KEY.custom, state.custom);
    refresh();
    closeSheet();
    if (state.map) state.map.flyTo([lat, lng], 15, { duration: 0.6 });
    toast('已添加：' + name + '。点击标记可以记到访。');
  }

  /* ------------------------------------------------------------------
     9. 导入导出
     ------------------------------------------------------------------ */

  function exportAll() {
    const payload = {
      app: 'wenbao',
      version: 1,
      exportedAt: new Date().toISOString(),
      visits: state.visits,
      custom: state.custom,
      coords: state.coords
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '访古记录-' + today() + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('已导出，文件在“下载”里');
  }

  function importFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        const visits = data && data.visits && typeof data.visits === 'object' ? data.visits : {};
        const custom = data && Array.isArray(data.custom) ? data.custom : [];
        const coords = data && data.coords && typeof data.coords === 'object' ? data.coords : {};
        const nv = Object.keys(visits).length;
        const nc = Object.keys(coords).length;
        state.coords = Object.assign({}, state.coords, coords);
        writeJSON(KEY.coords, state.coords);
        state.visits = Object.assign({}, state.visits, visits);
        const ids = {};
        state.custom.forEach((s) => { ids[s.id] = 1; });
        custom.forEach((s) => { if (s && s.id && !ids[s.id]) { state.custom.push(s); ids[s.id] = 1; } });
        writeJSON(KEY.visits, state.visits);
        writeJSON(KEY.custom, state.custom);
        refresh();
        toast('已导入 ' + nv + ' 条到访记录、' + custom.length + ' 条自建条目、' + nc + ' 个坐标');
      } catch (e) {
        toast('这个文件读不了，确认是从本应用导出的 JSON');
      }
    };
    reader.readAsText(file);
  }

  /* ------------------------------------------------------------------
     10. 视图切换与事件
     ------------------------------------------------------------------ */

  function switchView(v) {
    state.view = v;
    ['map', 'list', 'me'].forEach((k) => {
      const el = $('#view-' + k);
      if (el) el.hidden = k !== v;
    });
    document.querySelectorAll('.tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.view === v);
    });
    if (v === 'map' && state.map) {
      setTimeout(() => state.map.invalidateSize(), 60);
    }
  }

  function bindEvents() {
    document.querySelectorAll('.tab').forEach((t) => {
      t.addEventListener('click', () => switchView(t.dataset.view));
    });

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      state.installEvt = e;
      if (state.view === 'me') renderMe();
    });
    window.addEventListener('appinstalled', () => {
      state.installEvt = null;
      renderMe();
      toast('已安装到桌面');
    });

    $('#btn-locate').addEventListener('click', locate);
    $('#btn-add').addEventListener('click', showAddForm);
    overlay.addEventListener('click', closeSheet);
    const hintEl = $('#map-hint');
    if (hintEl) hintEl.addEventListener('click', () => hintEl.classList.remove('show'));

    $('#search').addEventListener('input', (e) => {
      state.filter.q = e.target.value;
      renderList();
    });

    // 筛选 chips
    const levels = [['all', '全部']].concat(Object.keys(LEVELS).map((k) => [k, LEVELS[k].short]));
    $('#chips-level').innerHTML = levels.map((p) =>
      '<button class="chip' + (p[0] === 'all' ? ' active' : '') + '" data-level="' + p[0] + '">' + p[1] + '</button>'
    ).join('');

    const visits = [['all', '全部'], ['unvisited', '未到访'], ['visited', '已到访']];
    $('#chips-visit').innerHTML = visits.map((p) =>
      '<button class="chip' + (p[0] === 'all' ? ' active' : '') + '" data-visit="' + p[0] + '">' + p[1] + '</button>'
    ).join('');

    $('#chips-level').addEventListener('click', (e) => {
      const b = e.target.closest('[data-level]');
      if (!b) return;
      state.filter.level = b.dataset.level;
      $('#chips-level').querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === b));
      renderList();
    });

    $('#chips-visit').addEventListener('click', (e) => {
      const b = e.target.closest('[data-visit]');
      if (!b) return;
      state.filter.visit = b.dataset.visit;
      $('#chips-visit').querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === b));
      renderList();
    });

    // 列表点击
    $('#list-body').addEventListener('click', (e) => {
      const card = e.target.closest('[data-id]');
      if (card) showSite(card.dataset.id);
    });

    // 浮层内的动作
    sheetBody.addEventListener('click', (e) => {
      const el = e.target.closest('[data-act]');
      if (!el) return;
      const act = el.dataset.act;
      const id = state.currentId;

      if (act === 'close' || act === 'back-site') {
        if (act === 'back-site' && id) showSite(id); else closeSheet();
        return;
      }
      if (act === 'visit' && id) { showVisitForm(id); return; }
      if (act === 'pin' && id) { startPin(id); return; }
      if (act === 'save-visit' && id) { saveVisit(id); return; }
      if (act === 'pick-photo') { $('#f-photo').click(); return; }
      if (act === 'copy') {
        e.preventDefault();
        const s = state.sites.filter((x) => x.id === id)[0];
        if (!s) return;
        const txt = s.lat.toFixed(6) + ',' + s.lng.toFixed(6);
        if (navigator.clipboard) {
          navigator.clipboard.writeText(txt).then(() => toast('坐标已复制：' + txt), () => toast(txt));
        } else {
          toast(txt);
        }
        return;
      }
      if (act === 'del-visit' && id) {
        if (!confirm('删除这条到访记录？')) return;
        delete state.visits[id];
        writeJSON(KEY.visits, state.visits);
        refresh();
        showSite(id);
        return;
      }
      if (act === 'save-site') { saveNewSite(); return; }
      if (act === 'del-site' && id) {
        if (!confirm('删除这个自建条目？')) return;
        state.custom = state.custom.filter((s) => s.id !== id);
        writeJSON(KEY.custom, state.custom);
        delete state.visits[id];
        writeJSON(KEY.visits, state.visits);
        refresh();
        closeSheet();
        return;
      }
    });

    // “我的”页动作
    $('#view-me').addEventListener('click', (e) => {
      const el = e.target.closest('[data-act]');
      if (!el) return;
      const act = el.dataset.act;
      if (act === 'install' && state.installEvt) {
        state.installEvt.prompt();
        state.installEvt.userChoice.then(() => { state.installEvt = null; renderMe(); });
        return;
      }
      if (act === 'export') exportAll();
      if (act === 'import') { const f = $('#import-file'); if (f) f.click(); }
      if (act === 'clear') {
        if (!confirm('清空所有到访记录和自建条目？建议先导出备份。')) return;
        state.visits = {};
        state.custom = [];
        state.coords = {};
        writeJSON(KEY.visits, {});
        writeJSON(KEY.custom, {});
        writeJSON(KEY.coords, {});
        refresh();
        toast('已清空');
      }
    });

    $('#view-me').addEventListener('change', (e) => {
      if (e.target.id === 'import-file') {
        const f = e.target.files && e.target.files[0];
        if (f) importFile(f);
        e.target.value = '';
      }
      if (e.target.id === 'basemap-sel') {
        applyBasemap(e.target.value);
        toast('底图已切换');
      }
    });
  }

  /* ------------------------------------------------------------------
     11. 启动
     ------------------------------------------------------------------ */

  function refresh() {
    state.sites = allSites();
    renderPins();
    renderList();
    renderMe();
  }

  function boot() {
    try {
      start();
    } catch (err) {
      const box = document.getElementById('map');
      if (box) {
        box.innerHTML = '<div class="empty">启动出错：' + esc(err && err.message ? err.message : err) +
          '<br><br>把这条信息发给我，或刷新页面再试一次。</div>';
      }
      if (window.console) console.error(err);
    }
  }

  function registerSW() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  function start() {
    initMap();
    bindEvents();
    refresh();
    fitToSites();
    drawMe();
    switchView('map');

    registerSW();

    const total = (window.WENBAO_SEED || []).length;
    const withGeo = (window.WENBAO_SEED || []).filter((s) => s.lat != null).length;
    showHint('杭州 ' + total + ' 处 · ' + withGeo + ' 处有坐标 · 点 ◎ 定位自己', 8000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
