/*!
 * error-monitor.js — 页面运行日志 / 报错可视化面板（移动端友好）
 *
 * 用法：在页面 <head> 的最前面、其它 <script> 之前引入：
 *   <script src="error-monitor.js" data-expect="WasmMediaEncoder,JSZip"></script>
 *
 * data-expect（可选）：逗号分隔的全局变量名（例如 CDN 库）。页面 load 之后如果
 *   其中某个仍未定义，面板会自动给出“依赖没加载成功”的提示，
 *   用来快速定位断网 / CDN 被拦截 / 文件名写错这类问题。
 *
 * 会捕获：
 *   1. window error 事件 —— 运行时错误 + 脚本/样式/图片等资源加载失败
 *   2. unhandledrejection —— 没有 catch 的 Promise 错误（async 函数最常见）
 *   3. console.error / warn / info / log / debug 的全部输出
 *   4. new Worker(...) 之后 worker 内部的 error / messageerror
 *
 * 界面：右下角悬浮小胶囊显示“错误 / 警告”数量，点它展开完整日志面板；
 *       出现错误时底部会弹出一条提示。移动端浏览器没有控制台也能看到问题。
 *
 * 记录只保存在本机：错误与警告会临时写入 sessionStorage（刷新后仍能看一次），
 * 普通日志只留在内存里。清空按钮会一并删除缓存。
 */
(function () {
  'use strict';

  if (window.__errorMonitorInstalled) { return; }
  window.__errorMonitorInstalled = true;

  var VERSION = '1.0.0';
  var NL = String.fromCharCode(10);
  var MAX_ENTRIES = 300;      // 内存中最多保留的记录条数
  var STORE_KEY = '__emx_logs_v1';
  var STORE_MAX = 40;         // sessionStorage 最多保留条数
  var STORE_TTL = 10 * 60 * 1000;
  var SHORT_LEN = 400;        // 列表里单条消息最长显示字符数
  var LONG_LEN = 3000;        // 详情（堆栈）最长字符数

  /* ------------------------------------------------------------------ */
  /* 配置：读取本脚本标签上的 data-* 属性                                */
  /* ------------------------------------------------------------------ */

  var selfScript = document.currentScript;
  if (!selfScript) {
    try {
      var allScripts = document.getElementsByTagName('script');
      for (var si = allScripts.length - 1; si >= 0; si--) {
        var src = allScripts[si].src || '';
        if (src.indexOf('error-monitor.js') !== -1) { selfScript = allScripts[si]; break; }
      }
    } catch (e) { selfScript = null; }
  }

  function attr(name) {
    try { return selfScript ? selfScript.getAttribute('data-' + name) : null; } catch (e) { return null; }
  }

  function trimStr(s) {
    if (typeof s !== 'string') { return ''; }
    var a = 0;
    var b = s.length;
    while (a < b) {
      var c = s.charCodeAt(a);
      if (c === 32 || c === 9 || c === 10 || c === 13) { a++; } else { break; }
    }
    while (b > a) {
      var d = s.charCodeAt(b - 1);
      if (d === 32 || d === 9 || d === 10 || d === 13) { b--; } else { break; }
    }
    return s.slice(a, b);
  }

  function isIdentifier(s) {
    if (!s || !s.length) { return false; }
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      var ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || (i > 0 && c >= 48 && c <= 57);
      if (!ok) { return false; }
    }
    return true;
  }

  var expectNames = [];
  var rawExpect = attr('expect');
  if (rawExpect) {
    var parts = rawExpect.split(',');
    for (var pi = 0; pi < parts.length; pi++) {
      var nm = trimStr(parts[pi]);
      if (nm && isIdentifier(nm)) { expectNames.push(nm); }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 工具函数                                                            */
  /* ------------------------------------------------------------------ */

  function isErrObj(v) {
    if (!v || typeof v !== 'object') { return false; }
    try { if (v instanceof Error) { return true; } } catch (e) { }
    return typeof v.message === 'string' && typeof v.stack === 'string';
  }

  function toText(v, max) {
    var s;
    try {
      if (v === null) { s = 'null'; }
      else if (v === undefined) { s = 'undefined'; }
      else if (typeof v === 'string') { s = v; }
      else if (isErrObj(v)) { s = (v.message || String(v)) + (v.stack ? NL + v.stack : ''); }
      else if (typeof v === 'object') {
        try { s = JSON.stringify(v); } catch (e) { s = Object.prototype.toString.call(v); }
        if (s === undefined) { s = String(v); }
      } else { s = String(v); }
    } catch (e) {
      try { s = String(v); } catch (e2) { s = '[无法显示的日志内容]'; }
    }
    if (typeof s !== 'string') { s = String(s); }
    if (max && s.length > max) { s = s.slice(0, max) + ' …(已截断)'; }
    return s;
  }

  function firstLine(s) {
    if (typeof s !== 'string') { s = toText(s, SHORT_LEN); }
    var i = s.indexOf(NL);
    if (i !== -1) { s = s.slice(0, i); }
    if (s.length > 120) { s = s.slice(0, 120) + '…'; }
    return s;
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function timeStr(t) {
    try {
      var d = new Date(t);
      return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    } catch (e) { return '--:--:--'; }
  }

  function dateTimeStr(t) {
    try {
      var d = new Date(t);
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + timeStr(t);
    } catch (e) { return timeStr(t); }
  }

  function fileNameOf(url) {
    try {
      var u = String(url || '');
      u = u.split('#')[0].split('?')[0];
      var seg = u.split('/');
      var last = seg[seg.length - 1];
      return last || u || '(未知地址)';
    } catch (e) { return '(未知地址)'; }
  }

  function isExternal(url) {
    return /^https?:/i.test(String(url || ''));
  }

  function globalExists(name) {
    try {
      return eval('typeof ' + name) !== 'undefined';
    } catch (e) { }
    try { return typeof window[name] !== 'undefined'; } catch (e2) { return false; }
  }

  var LEVEL_LABEL = { error: '错误', warn: '警告', log: '日志' };

  // 第一次出现 error 时自动把面板展开一次：手机上没有控制台，光靠小胶囊不够保险
  // （比如胶囊被页面某个东西盖住、或者用户根本没注意到）。data-autoopen="0" 可关掉。
  var autoOpenDisabled = attr('autoopen') === '0';
  var autoOpenDone = false;

  function maybeAutoOpen() {
    if (autoOpenDone || autoOpenDisabled || isOpen) { return; }
    autoOpenDone = true;
    setTimeout(function () { openPanel(); }, 60);
  }

  /* ------------------------------------------------------------------ */
  /* 记录存储                                                            */
  /* ------------------------------------------------------------------ */

  var entries = [];
  var seq = 0;
  var counts = { error: 0, warn: 0, log: 0 };
  var dropped = 0;
  var restoredCount = 0;

  function bumpCount(level, delta) {
    if (level === 'error') { counts.error += delta; }
    else if (level === 'warn') { counts.warn += delta; }
    else { counts.log += delta; }
  }

  function add(level, msg, detail) {
    try {
      msg = toText(msg, SHORT_LEN);
      detail = detail ? toText(detail, LONG_LEN) : '';
      var now = Date.now();

      var last = entries[entries.length - 1];
      if (last && !last.restored && last.level === level && last.msg === msg && (now - last.t) < 4000) {
        last.count++;
        last.t = now;
        updateUI(level !== 'log', level);
        return last;
      }

      var entry = { id: ++seq, t: now, level: level, msg: msg, detail: detail, count: 1, restored: false, open: false };
      entries.push(entry);
      bumpCount(level, 1);

      while (entries.length > MAX_ENTRIES) {
        var gone = entries.shift();
        bumpCount(gone.level, -1);
        dropped++;
      }

      if (level === 'error') { maybeAutoOpen(); }
      persist();
      updateUI(level !== 'log', level);
      return entry;
    } catch (e) {
      return null;
    }
  }

  function clearAll() {
    entries = [];
    counts = { error: 0, warn: 0, log: 0 };
    dropped = 0;
    restoredCount = 0;
    try { sessionStorage.removeItem(STORE_KEY); } catch (e) { }
    renderList();
    updateBadge();
    updateHeadSub();
  }

  /* ------------------------------------------------------------------ */
  /* 刷新后仍能看到上一次的错误 / 警告                                    */
  /* ------------------------------------------------------------------ */

  function persist() {
    try {
      var fresh = [];
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].level !== 'log' && !entries[i].restored) { fresh.push(entries[i]); }
      }
      fresh = fresh.slice(-STORE_MAX);
      var data = [];
      for (var j = 0; j < fresh.length; j++) {
        data.push({ t: fresh[j].t, level: fresh[j].level, msg: fresh[j].msg, detail: fresh[j].detail, count: fresh[j].count });
      }
      sessionStorage.setItem(STORE_KEY, JSON.stringify(data));
    } catch (e) { }
  }

  function restore() {
    try {
      var raw = sessionStorage.getItem(STORE_KEY);
      if (!raw) { return; }
      sessionStorage.removeItem(STORE_KEY);
      var list = JSON.parse(raw);
      if (!list || !list.length) { return; }
      var cutoff = Date.now() - STORE_TTL;
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (!e || !e.t || e.t < cutoff) { continue; }
        var level = e.level === 'warn' ? 'warn' : 'error';
        entries.push({
          id: ++seq, t: e.t, level: level, msg: toText(e.msg, SHORT_LEN),
          detail: toText(e.detail || '', LONG_LEN), count: e.count || 1,
          restored: true, open: false
        });
        bumpCount(level, 1);
        restoredCount++;
      }
    } catch (e) { }
  }

  /* ------------------------------------------------------------------ */
  /* 捕获 1：运行时错误 + 资源加载失败                                    */
  /* ------------------------------------------------------------------ */

  window.addEventListener('error', function (ev) {
    try {
      var target = ev.target;
      if (target && target !== window && target.tagName) {
        var tag = String(target.tagName).toLowerCase();
        if (tag === 'script' || tag === 'link' || tag === 'img' || tag === 'audio' || tag === 'video' || tag === 'source' || tag === 'iframe') {
          var url = target.src || target.href || '';
          var name = fileNameOf(url);
          var hint = '资源没加载成功，常见原因：文件不在同一目录 / 文件名大小写不一致 / 网络不可用。';
          if (isExternal(url)) { hint = '这是外部 CDN 资源（需要联网）。常见原因：断网、CDN 被运营商或浏览器拦截、unpkg 访问不了。'; }
          add('error', '资源加载失败：' + name + '（' + tag + '）', '地址：' + (url || '(空)') + NL + NL + hint);
          return;
        }
      }

      var err = ev.error;
      var msg = ev.message || (err && err.message) || '未知错误';
      var detail = '';
      if (err && err.stack) { detail = err.stack; }
      if (!detail) {
        detail = '位置：' + (ev.filename || '(未知文件)') + ' 第 ' + (ev.lineno || 0) + ' 行 第 ' + (ev.colno || 0) + ' 列';
      }
      add('error', msg, detail);
    } catch (e) { }
  }, true);

  /* ------------------------------------------------------------------ */
  /* 捕获 2：没有 catch 的 Promise / async 错误                           */
  /* ------------------------------------------------------------------ */

  window.addEventListener('unhandledrejection', function (ev) {
    try {
      var r = ev.reason;
      if (isErrObj(r)) {
        add('error', '未处理的 Promise 错误：' + (r.message || String(r)), r.stack || '');
      } else {
        add('error', '未处理的 Promise 拒绝：' + toText(r, SHORT_LEN), '这个 Promise 没有写 catch，值不是 Error 对象，通常需要检查调用链。');
      }
    } catch (e) { }
  });

  /* ------------------------------------------------------------------ */
  /* 捕获 3：console.*                                                    */
  /* ------------------------------------------------------------------ */

  (function hookConsole() {
    try {
      var levels = ['error', 'warn', 'info', 'log', 'debug'];
      for (var i = 0; i < levels.length; i++) {
        (function (level) {
          var orig = console[level];
          if (typeof orig !== 'function' || orig.__emxWrapped) { return; }
          var wrapped = function () {
            try {
              var args = Array.prototype.slice.call(arguments);
              var text = '';
              var detail = '';
              for (var k = 0; k < args.length; k++) {
                if (k) { text += ' '; }
                text += toText(args[k], SHORT_LEN);
                if (!detail && isErrObj(args[k]) && args[k].stack) { detail = args[k].stack; }
              }
              if (level === 'error') { add('error', 'console.error：' + text, detail); }
              else if (level === 'warn') { add('warn', 'console.warn：' + text, detail); }
              else { add('log', 'console.' + level + '：' + text, detail); }
            } catch (e) { }
            try { return orig.apply(console, args); } catch (e2) { }
          };
          wrapped.__emxWrapped = true;
          console[level] = wrapped;
        })(levels[i]);
      }
    } catch (e) { }
  })();

  /* ------------------------------------------------------------------ */
  /* 捕获 4：Worker（音频处理跑在 audio-worker.js 里）                     */
  /* ------------------------------------------------------------------ */

  (function hookWorker() {
    try {
      var NativeWorker = window.Worker;
      if (typeof NativeWorker !== 'function') { return; }
      if (NativeWorker.__emxWrapped) { return; }
      var Wrapped = function (url, options) {
        var worker = new NativeWorker(url, options);
        try {
          var label = fileNameOf(url);
          worker.addEventListener('error', function (e) {
            var m = (e && e.message) ? e.message : '脚本加载失败或执行出错';
            add('error', 'Worker 出错（' + label + '）：' + m,
              'Worker 文件：' + String(url) + NL + '位置：第 ' + ((e && e.lineno) || 0) + ' 行 第 ' + ((e && e.colno) || 0) + ' 列' + NL + NL +
              '常见原因：worker 脚本路径不对、worker 内部 importScripts 的文件缺失、worker 里抛出了未捕获的异常。');
          });
          worker.addEventListener('messageerror', function () {
            add('warn', 'Worker 消息无法反序列化（' + label + '）', 'postMessage 传递的数据里含无法结构化克隆的内容。');
          });
        } catch (e) { }
        return worker;
      };
      Wrapped.prototype = NativeWorker.prototype;
      Wrapped.__emxWrapped = true;
      window.Worker = Wrapped;
    } catch (e) { }
  })();

  /* ------------------------------------------------------------------ */
  /* 捕获 5：页面加载完成后检查 data-expect 里的依赖                       */
  /* ------------------------------------------------------------------ */

  function checkExpect() {
    for (var i = 0; i < expectNames.length; i++) {
      var name = expectNames[i];
      if (!globalExists(name)) {
        add('error', '缺少依赖：' + name + ' 没有加载成功',
          '页面需要全局变量 ' + name + '，但它现在是 undefined。' + NL + NL +
          '常见原因：' + NL +
          '1. 断网或 CDN（如 unpkg.com）打不开；' + NL +
          '2. 浏览器插件 / 运营商拦截了外部脚本；' + NL +
          '3. 脚本文件名写错或文件不在同一目录。');
      }
    }
    // 顺带记录直接加载失败的 <script>，即使没被 error 事件捕获到
    try {
      var scripts = document.getElementsByTagName('script');
      for (var s = 0; s < scripts.length; s++) {
        var el = scripts[s];
        if (el.src && !el.getAttribute('data-emx-ok') && el.readyState === undefined) { /* 仅占位 */ }
      }
    } catch (e) { }
  }

  /* ------------------------------------------------------------------ */
  /* 捕获 6：主线程卡顿检测                                               */
  /* 页面被同步重计算占死时（例如在主线程上跑音频变速），页面上所有点击都   */
  /* 只能排队，日志胶囊点了也没反应。用心跳把“卡了多久”记下来，事后能看出  */
  /* 原因，也知道当时为什么点不动。                                        */
  /* ------------------------------------------------------------------ */

  var HEARTBEAT_MS = 500;
  var BUSY_MIN_MS = 1500;
  var lastBeat = 0;
  var busyWatchStarted = false;

  function heartbeat() {
    try {
      var now = Date.now();
      var gap = now - lastBeat;
      lastBeat = now;
      if (document.hidden) { return; }
      if (gap >= BUSY_MIN_MS) {
        add('warn', '【卡顿】页面主线程被占用约 ' + (gap / 1000).toFixed(1) + ' 秒',
          '这段时间页面无法响应点击：日志胶囊点了没反应、进度动画会停住，点击要排队到主线程空下来才处理。' + NL + NL +
          '常见原因：某段很重的计算直接跑在主线程上（例如没有放进 Worker 的音频变速）。' + NL +
          '处理办法：把它移进 Web Worker（本项目已有 audio-worker.js），或者分片处理、中间用 await 让出主线程。');
      }
    } catch (e) { }
  }

  function startBusyWatch() {
    if (busyWatchStarted) { return; }
    busyWatchStarted = true;
    lastBeat = Date.now();
    try { setInterval(heartbeat, HEARTBEAT_MS); } catch (e) { }
    try {
      document.addEventListener('visibilitychange', function () { lastBeat = Date.now(); });
    } catch (e) { }
  }

  /* ------------------------------------------------------------------ */
  /* 捕获 7：主动 API + 启动信息                                          */
  /* ------------------------------------------------------------------ */

  window.ErrorMonitor = {
    version: VERSION,
    level: function () { return counts.error > 0 ? 'error' : (counts.warn > 0 ? 'warn' : 'ok'); },
    entries: function () { return entries.slice(); },
    counts: function () { return { error: counts.error, warn: counts.warn, log: counts.log }; },
    add: function (msg, detail) { return add('log', msg, detail); },
    info: function (msg, detail) { return add('log', msg, detail); },
    warn: function (msg, detail) { return add('warn', msg, detail); },
    error: function (msg, detail) { return add('error', msg, detail); },
    clear: clearAll,
    open: openPanel,
    close: closePanel,
    toggle: togglePanel
  };

  /* ------------------------------------------------------------------ */
  /* 界面                                                                */
  /* ------------------------------------------------------------------ */

  var ui = null;
  var stateClass = 'emx-ok';
  var isOpen = false;
  var filter = 'all';
  var toastTimer = null;
  var pendingToast = null;
  var rafPending = false;

  var CSS = [
    '#emx-badge{position:fixed!important;right:14px;bottom:14px;bottom:calc(14px + env(safe-area-inset-bottom));z-index:2147483647!important;display:flex!important;align-items:center;gap:6px;min-height:44px;padding:0 16px;border:0;border-radius:22px;cursor:pointer;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:13px;font-weight:600;line-height:1;color:#fff;background:#374151;box-shadow:0 6px 18px rgba(0,0,0,.32);opacity:.86;transition:opacity .2s ease,transform .2s ease,background .2s ease;-webkit-tap-highlight-color:transparent;touch-action:manipulation;user-select:none}',
    '#emx-badge:hover,#emx-badge:active{opacity:1;transform:translateY(-1px)}',
    '#emx-badge.emx-ok{background:#374151}',
    '#emx-badge.emx-warn{background:#b45309}',
    '#emx-badge.emx-error{background:#c0392b}',
    '#emx-badge.emx-pulse{animation:emx-pulse .6s ease 2}',
    '@keyframes emx-pulse{0%{transform:scale(1)}50%{transform:scale(1.14)}100%{transform:scale(1)}}',
    '#emx-toast{position:fixed!important;left:12px;right:12px;bottom:74px;bottom:calc(74px + env(safe-area-inset-bottom));z-index:2147483646!important;display:none;align-items:flex-start;gap:8px;padding:12px 14px;border-radius:12px;border-left:4px solid #c0392b;background:rgba(17,24,39,.96);color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:13px;line-height:1.45;box-shadow:0 10px 30px rgba(0,0,0,.4);cursor:pointer;-webkit-tap-highlight-color:transparent}',
    '#emx-toast.emx-show{display:flex!important}',
    '#emx-toast .emx-toast-msg{flex:1;word-break:break-word;max-height:5.6em;overflow:hidden}',
    '#emx-toast .emx-toast-more{flex:0 0 auto;color:#fca5a5;font-weight:600}',
    '#emx-panel{position:fixed!important;left:0;right:0;top:0;bottom:0;z-index:2147483647!important;display:none;align-items:flex-end;justify-content:center;background:rgba(15,23,42,.55)}',
    '#emx-panel.emx-show{display:flex!important}',
    '#emx-sheet{display:flex;flex-direction:column;width:100%;max-width:760px;max-height:88vh;background:#fff;color:#111827;border-radius:16px 16px 0 0;box-shadow:0 -8px 40px rgba(0,0,0,.4);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;overflow:hidden}',
    '#emx-head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid #e5e7eb;background:#f9fafb}',
    '#emx-head-title{flex:1;font-size:15px;font-weight:700;color:#111827}',
    '#emx-head-sub{display:block;margin-top:4px;font-size:11px;font-weight:500;color:#6b7280;word-break:break-all}',
    '#emx-close{flex:0 0 auto;width:40px;height:40px;border:0;border-radius:50%;background:#e5e7eb;color:#374151;font-size:17px;line-height:1;cursor:pointer;-webkit-tap-highlight-color:transparent}',
    '#emx-filters{display:flex;gap:8px;padding:10px 12px;border-bottom:1px solid #eef2f7;overflow-x:auto;-webkit-overflow-scrolling:touch}',
    '#emx-filters .emx-chip{flex:0 0 auto;min-height:34px;padding:0 12px;border:1px solid #d1d5db;border-radius:17px;background:#fff;color:#374151;font-size:12px;font-weight:600;cursor:pointer;-webkit-tap-highlight-color:transparent;white-space:nowrap}',
    '#emx-filters .emx-chip.emx-active{background:#1f2937;border-color:#1f2937;color:#fff}',
    '#emx-filters .emx-chip b{font-weight:700}',
    '#emx-list{flex:1;min-height:120px;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:8px 12px 4px;background:#fff}',
    '#emx-empty{padding:28px 12px;text-align:center;color:#9ca3af;font-size:13px;line-height:1.7}',
    '.emx-item{margin-bottom:8px;padding:9px 10px;border-radius:10px;border-left:4px solid #9ca3af;background:#f8fafc}',
    '.emx-item.emx-error{border-left-color:#c0392b;background:#fef2f2}',
    '.emx-item.emx-warn{border-left-color:#d97706;background:#fffbeb}',
    '.emx-item.emx-log{border-left-color:#94a3b8;background:#f8fafc}',
    '.emx-item.emx-clickable{cursor:pointer}',
    '.emx-item-top{display:flex;align-items:center;gap:8px;margin-bottom:5px;font-size:11px;color:#6b7280}',
    '.emx-item-tag{font-weight:700;letter-spacing:.5px}',
    '.emx-item.emx-error .emx-item-tag{color:#b91c1c}',
    '.emx-item.emx-warn .emx-item-tag{color:#b45309}',
    '.emx-item.emx-log .emx-item-tag{color:#64748b}',
    '.emx-item-count{margin-left:auto;flex:0 0 auto;padding:1px 7px;border-radius:9px;background:#e5e7eb;color:#374151;font-weight:700}',
    '.emx-item-restored{flex:0 0 auto;padding:1px 6px;border-radius:8px;background:#e0e7ff;color:#3730a3;font-weight:600}',
    '.emx-item-msg{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:12px;line-height:1.55;color:#111827;white-space:pre-wrap;word-break:break-word}',
    '.emx-item-detail{display:none;margin:8px 0 0;padding:8px;border-radius:8px;background:#111827;color:#e5e7eb;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto}',
    '.emx-item.emx-open .emx-item-detail{display:block}',
    '.emx-item-hint{margin-top:6px;font-size:11px;color:#6b7280}',
    '#emx-foot{display:flex;align-items:center;gap:8px;padding:10px 12px;padding-bottom:calc(10px + env(safe-area-inset-bottom));border-top:1px solid #e5e7eb;background:#f9fafb}',
    '#emx-foot .emx-btn{flex:0 0 auto;min-height:42px;padding:0 16px;border:1px solid #d1d5db;border-radius:10px;background:#fff;color:#111827;font-size:13px;font-weight:600;cursor:pointer;-webkit-tap-highlight-color:transparent}',
    '#emx-foot .emx-btn.emx-primary{background:#1f2937;border-color:#1f2937;color:#fff}',
    '#emx-foot .emx-note{flex:1;font-size:11px;color:#6b7280;line-height:1.4;text-align:right}'
  ].join(NL);

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined && text !== null) { node.textContent = text; }
    return node;
  }

  function mountPoint() {
    // 优先挂 <html>：它在解析一开始就存在，不用等 body（页面卡在外部 CDN 脚本上时也能立刻看到胶囊），
    // 同时处于页面所有层叠上下文之外，不怕被页面的遮罩或 transform 压住。
    try { if (document.documentElement) { return document.documentElement; } } catch (e) { }
    try { if (document.body) { return document.body; } } catch (e) { }
    return null;
  }

  function ensureUI() {
    if (ui) { return; }
    var root = mountPoint();
    if (!root) {
      if (!ensureUI.bound) {
        ensureUI.bound = true;
        document.addEventListener('DOMContentLoaded', function () { ensureUI(); });
      }
      return;
    }

    try {
      var style = document.createElement('style');
      style.setAttribute('data-emx', 'style');
      style.appendChild(document.createTextNode(CSS));
      (document.head || document.body || root).appendChild(style);

      var badge = el('button', 'emx-ok');
      badge.id = 'emx-badge';
      badge.type = 'button';
      badge.setAttribute('aria-label', '查看页面运行日志');

      var toast = el('div', '');
      toast.id = 'emx-toast';
      toast.setAttribute('role', 'alert');
      var toastIcon = el('span', 'emx-toast-icon', '✕');
      var toastMsg = el('span', 'emx-toast-msg', '');
      var toastMore = el('span', 'emx-toast-more', '查看 ›');
      toast.appendChild(toastIcon);
      toast.appendChild(toastMsg);
      toast.appendChild(toastMore);

      var panel = el('div', '');
      panel.id = 'emx-panel';
      var sheet = el('div', '');
      sheet.id = 'emx-sheet';
      sheet.setAttribute('role', 'dialog');
      sheet.setAttribute('aria-modal', 'true');
      sheet.setAttribute('aria-label', '页面运行日志');

      var head = el('div', '');
      head.id = 'emx-head';
      var titleWrap = el('div', '');
      titleWrap.id = 'emx-head-title';
      titleWrap.appendChild(document.createTextNode('运行日志'));
      var sub = el('span', '', '');
      sub.id = 'emx-head-sub';
      titleWrap.appendChild(sub);
      var closeBtn = el('button', '', '✕');
      closeBtn.id = 'emx-close';
      closeBtn.type = 'button';
      closeBtn.setAttribute('aria-label', '关闭');
      head.appendChild(titleWrap);
      head.appendChild(closeBtn);

      var filters = el('div', '');
      filters.id = 'emx-filters';
      var chipDefs = [['all', '全部'], ['error', '错误'], ['warn', '警告'], ['log', '日志']];
      var chipEls = {};
      for (var i = 0; i < chipDefs.length; i++) {
        var chip = el('button', 'emx-chip');
        chip.type = 'button';
        chip.setAttribute('data-filter', chipDefs[i][0]);
        chip.appendChild(document.createTextNode(chipDefs[i][1] + ' '));
        var num = el('b', '', '0');
        chip.appendChild(num);
        chipEls[chipDefs[i][0]] = num;
        filters.appendChild(chip);
      }

      var list = el('div', '');
      list.id = 'emx-list';

      var foot = el('div', '');
      foot.id = 'emx-foot';
      var copyBtn = el('button', 'emx-btn emx-primary', '复制全部');
      copyBtn.type = 'button';
      var clearBtn = el('button', 'emx-btn', '清空');
      clearBtn.type = 'button';
      var note = el('span', 'emx-note', '点单条可展开堆栈');
      foot.appendChild(copyBtn);
      foot.appendChild(clearBtn);
      foot.appendChild(note);

      sheet.appendChild(head);
      sheet.appendChild(filters);
      sheet.appendChild(list);
      sheet.appendChild(foot);
      panel.appendChild(sheet);

      root.appendChild(badge);
      root.appendChild(toast);
      root.appendChild(panel);

      ui = {
        badge: badge, toast: toast, toastMsg: toastMsg, panel: panel, sheet: sheet,
        sub: sub, list: list, chips: chipEls, copyBtn: copyBtn, clearBtn: clearBtn, note: note
      };

      var openNow = function (e) {
        try { if (e && e.stopPropagation) { e.stopPropagation(); } } catch (er) { }
        openPanel();
      };
      badge.addEventListener('click', openNow);
      // 手指一按下就开（capture 阶段），比 click 早，也不容易被页面自己的处理器吞掉。
      // 这里不调用 preventDefault，避免干扰浏览器对 click 的派发。
      if (window.PointerEvent) {
        badge.addEventListener('pointerdown', openNow, true);
      } else {
        badge.addEventListener('touchstart', openNow, true);
        badge.addEventListener('mousedown', openNow, true);
      }

      // 兜底：如果胶囊被别的元素盖住、或者事件被谁中途接管，只要按下的位置落在胶囊矩形内，
      // 也能在 document 的 capture 阶段（比页面自己的处理器更早）把面板打开。
      var HIT_PAD = 12;
      var lastHitOpen = 0;
      function inBadgeRect(x, y) {
        try {
          if (!ui || !ui.badge || !ui.badge.getBoundingClientRect) { return false; }
          var r = ui.badge.getBoundingClientRect();
          if (!r || (!r.width && !r.height)) { return false; }
          return x >= r.left - HIT_PAD && x <= r.right + HIT_PAD && y >= r.top - HIT_PAD && y <= r.bottom + HIT_PAD;
        } catch (er) { return false; }
      }
      function docTap(e) {
        try {
          if (isOpen || !e) { return; }
          var x;
          var y;
          if (e.touches && e.touches.length) { x = e.touches[0].clientX; y = e.touches[0].clientY; }
          else if (e.changedTouches && e.changedTouches.length) { x = e.changedTouches[0].clientX; y = e.changedTouches[0].clientY; }
          else { x = e.clientX; y = e.clientY; }
          if (typeof x !== 'number' || typeof y !== 'number') { return; }
          if (!inBadgeRect(x, y)) { return; }
          var now = Date.now();
          if (now - lastHitOpen < 400) { return; }
          lastHitOpen = now;
          if (e.stopPropagation) { e.stopPropagation(); }
          openPanel();
        } catch (er) { }
      }
      document.addEventListener('pointerdown', docTap, true);
      document.addEventListener('touchstart', docTap, true);
      document.addEventListener('mousedown', docTap, true);
      toast.addEventListener('click', function () { hideToast(); openPanel(); });
      closeBtn.addEventListener('click', function (e) { e.preventDefault(); closePanel(); });
      panel.addEventListener('click', function (e) { if (e.target === panel) { closePanel(); } });

      filters.addEventListener('click', function (e) {
        var t = e.target;
        while (t && t !== filters && !(t.getAttribute && t.getAttribute('data-filter'))) { t = t.parentNode; }
        if (!t || t === filters) { return; }
        setFilter(t.getAttribute('data-filter'));
      });

      list.addEventListener('click', function (e) {
        var t = e.target;
        while (t && t !== list && !(t.getAttribute && t.getAttribute('data-id'))) { t = t.parentNode; }
        if (!t || t === list || !t.getAttribute) { return; }
        var id = t.getAttribute('data-id');
        for (var k = 0; k < entries.length; k++) {
          if (String(entries[k].id) === String(id)) {
            if (!entries[k].detail) { return; }
            entries[k].open = !entries[k].open;
            if (entries[k].open) { t.className += ' emx-open'; }
            else { t.className = t.className.split('emx-open').join('').replace(/[ ]+/g, ' '); }
            return;
          }
        }
      });

      copyBtn.addEventListener('click', copyAll);
      clearBtn.addEventListener('click', function () { clearAll(); flashNote('已清空'); });

      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && isOpen) { closePanel(); }
      });

      updateBadge();
      updateHeadSub();
      renderList();
      if (pendingToast) { var p = pendingToast; pendingToast = null; showToast(p); }
    } catch (e) { }
  }

  function setFilter(next) {
    filter = next || 'all';
    if (!ui) { return; }
    var keys = ['all', 'error', 'warn', 'log'];
    for (var i = 0; i < keys.length; i++) {
      var btn = ui.chips[keys[i]].parentNode;
      var active = keys[i] === filter;
      if (active) { btn.className = 'emx-chip emx-active'; }
      else { btn.className = 'emx-chip'; }
    }
    renderList();
  }

  function updateBadge() {
    if (!ui) { return; }
    var e = counts.error;
    var w = counts.warn;
    var cls = 'emx-ok';
    var text = '✓ 日志';
    if (e > 0) {
      cls = 'emx-error';
      text = '✕ ' + e + ' 错误';
      if (w > 0) { text += ' · ' + w + ' 警告'; }
    } else if (w > 0) {
      cls = 'emx-warn';
      text = '! ' + w + ' 警告';
    }
    stateClass = cls;
    ui.badge.className = cls;
    ui.badge.textContent = text;
    if (dropped) { text += '（更早的记录已省略）'; }
    ui.badge.setAttribute('aria-label', '运行日志：' + e + ' 个错误，' + w + ' 个警告。点击查看。');
  }

  function updateHeadSub() {
    if (!ui) { return; }
    var s = '错误 ' + counts.error + ' · 警告 ' + counts.warn + ' · 日志 ' + counts.log;
    if (restoredCount) { s += ' · 含上次会话 ' + restoredCount + ' 条'; }
    if (dropped) { s += ' · 已省略更早的 ' + dropped + ' 条'; }
    ui.sub.textContent = s;
  }

  function updateChips() {
    if (!ui) { return; }
    ui.chips.all.textContent = entries.length;
    ui.chips.error.textContent = counts.error;
    ui.chips.warn.textContent = counts.warn;
    ui.chips.log.textContent = counts.log;
  }

  function renderList() {
    if (!ui || !ui.list) { return; }
    var list = ui.list;
    while (list.firstChild) { list.removeChild(list.firstChild); }
    updateChips();

    var shown = [];
    for (var i = 0; i < entries.length; i++) {
      if (filter === 'all' || entries[i].level === filter) { shown.push(entries[i]); }
    }

    if (!shown.length) {
      var empty = el('div', '', entries.length
        ? '当前筛选下没有记录。'
        : '暂时没有错误或警告。页面运行正常。' + NL + NL + '（出现问题时这里会自动记录报错原因、位置和调用堆栈）');
      empty.id = 'emx-empty';
      list.appendChild(empty);
      return;
    }

    var frag = null;
    try { if (document.createDocumentFragment) { frag = document.createDocumentFragment(); } } catch (e) { frag = null; }
    var host = frag || list;
    for (var j = 0; j < shown.length; j++) {
      var en = shown[j];
      var item = el('div', 'emx-item emx-' + en.level + (en.detail ? ' emx-clickable' : '') + (en.open ? ' emx-open' : ''));
      item.setAttribute('data-id', String(en.id));

      var top = el('div', 'emx-item-top');
      top.appendChild(el('span', 'emx-item-tag', LEVEL_LABEL[en.level] || en.level));
      top.appendChild(el('span', 'emx-item-time', dateTimeStr(en.t)));
      if (en.restored) { top.appendChild(el('span', 'emx-item-restored', '上次会话')); }
      if (en.count > 1) { top.appendChild(el('span', 'emx-item-count', '×' + en.count)); }
      item.appendChild(top);

      item.appendChild(el('p', 'emx-item-msg', en.msg));
      if (en.detail) {
        item.appendChild(el('pre', 'emx-item-detail', en.detail));
        item.appendChild(el('div', 'emx-item-hint', '点击展开 / 收起详情'));
      }
      host.appendChild(item);
    }
    if (frag) { list.appendChild(frag); }
    try { list.scrollTop = list.scrollHeight; } catch (e) { }
  }

  function showToast(entry) {
    if (!ui || !entry) { return; }
    ui.toastMsg.textContent = firstLine(entry.msg);
    ui.toast.className = 'emx-show';
    if (toastTimer) { clearTimeout(toastTimer); }
    toastTimer = setTimeout(hideToast, 8000);
  }

  function hideToast() {
    if (!ui) { return; }
    ui.toast.className = '';
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  }

  function flashNote(text) {
    if (!ui) { return; }
    var old = '点单条可展开堆栈';
    ui.note.textContent = text;
    setTimeout(function () { if (ui) { ui.note.textContent = old; } }, 1800);
  }

  function openPanel() {
    ensureUI();
    if (!ui) { return; }
    isOpen = true;
    hideToast();
    ui.panel.className = 'emx-show';
    updateHeadSub();
    renderList();
    try { if (document.body) { document.body.style.overflow = 'hidden'; } } catch (e) { }
  }

  function closePanel() {
    isOpen = false;
    if (!ui) { return; }
    ui.panel.className = '';
    try { if (document.body) { document.body.style.overflow = ''; } } catch (e) { }
  }

  function togglePanel() { if (isOpen) { closePanel(); } else { openPanel(); } }

  function copyAll() {
    var lines = [];
    lines.push('页面：' + (document.title || '(无标题)'));
    lines.push('地址：' + String(location.href || ''));
    lines.push('时间：' + dateTimeStr(Date.now()));
    try { lines.push('浏览器：' + navigator.userAgent); } catch (e) { }
    lines.push('汇总：错误 ' + counts.error + '，警告 ' + counts.warn + '，日志 ' + counts.log);
    lines.push('----------------------------------------');
    var list = entries;
    if (!list.length) { lines.push('(没有记录)'); }
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      lines.push('[' + dateTimeStr(e.t) + '][' + (LEVEL_LABEL[e.level] || e.level) + ']' + (e.count > 1 ? ' x' + e.count : '') + ' ' + e.msg);
      if (e.detail) {
        var dl = String(e.detail).split(NL);
        for (var d = 0; d < dl.length; d++) { lines.push('    ' + dl[d]); }
      }
    }
    var text = lines.join(NL);

    var ok = function () { flashNote('已复制到剪贴板'); };
    var bad = function () { flashNote('复制失败，请长按选中'); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(ok, function () { if (legacyCopy(text)) { ok(); } else { bad(); } });
        return;
      }
    } catch (e) { }
    if (legacyCopy(text)) { ok(); } else { bad(); }
  }

  function legacyCopy(text) {
    try {
      if (!document.body) { return false; }
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  function updateUI(flash, level) {
    ensureUI();
    if (!ui) { return; }
    if (level === 'error') { pendingToast = entries[entries.length - 1]; }

    if (rafPending) { return; }
    rafPending = true;
    var run = function () {
      rafPending = false;
      try {
        updateBadge();
        updateHeadSub();
        if (isOpen) { renderList(); }
        if (flash && ui.badge) {
          ui.badge.className = stateClass + ' emx-pulse';
          try { void ui.badge.offsetWidth; } catch (e) { }
          setTimeout(function () { if (ui && ui.badge) { ui.badge.className = stateClass; } }, 1250);
        }
        if (pendingToast) { var t = pendingToast; pendingToast = null; showToast(t); }
      } catch (e) { }
    };
    try {
      if (window.requestAnimationFrame) { window.requestAnimationFrame(run); }
      else { setTimeout(run, 16); }
    } catch (e) { setTimeout(run, 16); }
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */

  restore();
  add('log', '运行日志监控已启动' + (expectNames.length ? '，将检查依赖：' + expectNames.join('、') : ''),
    '页面：' + (document.title || '(无标题)') + NL + '这次会话中，页面里的报错、警告和 console 输出都会记录在这里，手机上没有控制台也能看。');

  ensureUI();

  // 应急入口：地址末尾加 #emlogs（或 ?emlogs）打开页面后直接展开日志面板
  try {
    if (String(location.href || '').indexOf('emlogs') !== -1) {
      setTimeout(function () { openPanel(); }, 0);
    }
  } catch (e) { }

  function onReady() {
    startBusyWatch();
    setTimeout(checkExpect, 300);
  }

  if (document.readyState === 'complete') { setTimeout(onReady, 0); }
  else { window.addEventListener('load', onReady); }
})();
