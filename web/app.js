/*!
 * gkd web —— 页面交互逻辑
 *
 * 依赖同目录的 gkd-core.js（全局对象 GKDCore）提供的纯字节逻辑。
 * 本文件只负责：文件读取、格式校验、预览、错误提示与下载。
 */
(function () {
  'use strict';

  var Core = window.GKDCore;
  var utf8Encoder = new TextEncoder();
  var utf8Decoder = new TextDecoder('utf-8');

  /* ============================ 小工具 ============================ */

  function $(id) {
    return document.getElementById(id);
  }
  function show(el) {
    el.classList.remove('hidden');
  }
  function hideEl(el) {
    el.classList.add('hidden');
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' 字节';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  // 与 Go filepath.Ext + strings.TrimPrefix(".", ...) 对齐的扩展名提取：
  // "photo.png" -> "png"，"archive.tar.gz" -> "gz"，".bashrc" -> "bashrc"，无点 -> ""
  function fileExt(name) {
    var i = name.lastIndexOf('.');
    return i >= 0 ? name.slice(i + 1) : '';
  }

  function baseName(name) {
    var i = name.lastIndexOf('.');
    return i > 0 ? name.slice(0, i) : name;
  }

  function setStatus(el, type, msg) {
    el.textContent = msg;
    el.className = 'status ' + type;
  }
  function clearStatus(el) {
    el.textContent = '';
    el.className = 'status';
  }

  // 读取 File/ArrayBuffer（优先原生 arrayBuffer()，老浏览器回退 FileReader）
  function readArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      if (typeof file.arrayBuffer === 'function') {
        file.arrayBuffer().then(resolve, reject);
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        resolve(reader.result);
      };
      reader.onerror = function () {
        reject(new Error('读取文件失败'));
      };
      reader.readAsArrayBuffer(file);
    });
  }

  // 通用拖放区装配：点击 / 键盘 / 拖拽 均可触发 onFile(File)
  function setupDropzone(zone, input, onFile) {
    zone.addEventListener('click', function () {
      input.click();
    });
    zone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        input.click();
      }
    });
    input.addEventListener('change', function () {
      if (input.files && input.files[0]) onFile(input.files[0]);
      input.value = ''; // 允许重复选择同一个文件
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) {
        e.preventDefault();
        zone.classList.add('drag');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) {
        e.preventDefault();
        zone.classList.remove('drag');
      });
    });
    zone.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) onFile(f);
    });
  }

  // 管理对象 URL：setURL(holder, blob) 返回新 URL 并释放旧的
  function makeURLHolder() {
    return { url: null };
  }
  function setURL(holder, blob) {
    if (holder.url) URL.revokeObjectURL(holder.url);
    holder.url = blob ? URL.createObjectURL(blob) : null;
    return holder.url;
  }
  function dropURL(holder) {
    setURL(holder, null);
  }

  /* ============================ 页签切换 ============================ */

  function switchTab(name) {
    var isHide = name === 'hide';
    var t1 = $('tab-hide');
    var t2 = $('tab-extract');
    t1.classList.toggle('active', isHide);
    t1.setAttribute('aria-selected', String(isHide));
    t2.classList.toggle('active', !isHide);
    t2.setAttribute('aria-selected', String(!isHide));
    $('panel-hide').hidden = !isHide;
    $('panel-extract').hidden = isHide;
  }

  /* ============================ 隐藏内容页 ============================ */

  var hideStatusEl = $('hide-status');
  var hideImgURL = makeURLHolder();
  var hideOutURL = makeURLHolder();

  var hideState = {
    imageFile: null,
    imageBytes: null,
    imageFormat: null, // 'png' | 'jpeg'
    mode: 'text', // 'text' | 'file'
    file: null,
    fileBytes: null,
    fileExt: '',
  };

  function resetHideImage() {
    hideState.imageFile = null;
    hideState.imageBytes = null;
    hideState.imageFormat = null;
    dropURL(hideImgURL);
    $('hide-preview-img').removeAttribute('src');
    hideEl($('hide-image-preview'));
    show($('hide-drop'));
    clearStatus(hideStatusEl);
    hideEl($('hide-result'));
    updateHideHint();
  }

  function onHideImageSelected(file) {
    readArrayBuffer(file).then(
      function (buf) {
        var bytes = new Uint8Array(buf);
        var format;
        try {
          format = Core.detectImageFormat(bytes);
        } catch (err) {
          resetHideImage();
          setStatus(hideStatusEl, 'err', '载入失败：' + err.message);
          return;
        }
        hideState.imageFile = file;
        hideState.imageBytes = bytes;
        hideState.imageFormat = format;

        setURL(hideImgURL, file);
        $('hide-preview-img').src = hideImgURL.url;
        $('hide-image-name').textContent = file.name;
        $('hide-image-meta').textContent =
          (format === 'png' ? 'PNG' : 'JPEG') + ' · ' + formatBytes(bytes.length);

        // 该图片是否已含 gkd 隐藏数据（仅提示，不改变隐藏行为，与 CLI 一致）
        var already = false;
        try {
          Core.extractDataFromImage(bytes);
          already = true;
        } catch (e) {
          already = false;
        }
        $('hide-image-badge').classList.toggle('hidden', !already);

        show($('hide-image-preview'));
        hideEl($('hide-drop'));
        clearStatus(hideStatusEl);
        hideEl($('hide-result'));
        updateHideHint();
      },
      function (err) {
        setStatus(hideStatusEl, 'err', '读取文件失败：' + ((err && err.message) || err));
      }
    );
  }

  function setMode(mode) {
    hideState.mode = mode;
    var isText = mode === 'text';
    $('mode-text').classList.toggle('active', isText);
    $('mode-text').setAttribute('aria-pressed', String(isText));
    $('mode-file').classList.toggle('active', !isText);
    $('mode-file').setAttribute('aria-pressed', String(!isText));
    $('text-block').classList.toggle('hidden', !isText);
    $('file-block').classList.toggle('hidden', isText);
    updateHideHint();
  }

  function resetHideFile() {
    hideState.file = null;
    hideState.fileBytes = null;
    hideState.fileExt = '';
    hideEl($('file-info'));
    show($('file-drop'));
    updateHideHint();
  }

  function onHideFileSelected(file) {
    readArrayBuffer(file).then(
      function (buf) {
        hideState.file = file;
        hideState.fileBytes = new Uint8Array(buf);
        hideState.fileExt = fileExt(file.name);
        $('file-chip-name').textContent = file.name;
        $('file-chip-size').textContent =
          formatBytes(hideState.fileBytes.length) +
          (hideState.fileExt ? ' · .' + hideState.fileExt : ' · 无扩展名');
        show($('file-info'));
        hideEl($('file-drop'));
        clearStatus(hideStatusEl);
        updateHideHint();
      },
      function (err) {
        setStatus(hideStatusEl, 'err', '读取文件失败：' + ((err && err.message) || err));
      }
    );
  }

  // JPEG 载体容量预估：APP1 段长度为 uint16（上限 65535 字节），
  // 超出时提前提示，实际写入仍由核心逻辑兜底报错。
  function updateHideHint() {
    var hintEl = $('hide-hint');
    hintEl.classList.remove('warn');
    if (!hideState.imageBytes || hideState.imageFormat !== 'jpeg') {
      hintEl.textContent = '';
      return;
    }
    var contentLen =
      hideState.mode === 'file'
        ? hideState.fileBytes
          ? hideState.fileBytes.length
          : -1
        : utf8Encoder.encode($('hide-text').value).length;
    if (contentLen < 0) {
      hintEl.textContent = '';
      return;
    }
    var extLen = utf8Encoder.encode(hideState.mode === 'file' ? hideState.fileExt : '').length;
    var payloadLen = 4 + extLen + contentLen;
    var segLen = 2 + 4 + 4 * Math.ceil(payloadLen / 3); // 段长(2) + "gkd\0"(4) + Base64
    if (segLen > 0xffff) {
      hintEl.textContent =
        '⚠ JPEG 载体容量不足：当前内容约需 ' + formatBytes(segLen) +
        ' 的段空间，超过 JPEG 单段上限 65535 字节，请改用 PNG 载体或减小内容。';
      hintEl.classList.add('warn');
    } else {
      hintEl.textContent = '';
    }
  }

  function doHide() {
    try {
      if (!hideState.imageBytes) {
        throw new Error('请先选择一张 PNG 或 JPEG 图片作为载体');
      }
      var isFile = hideState.mode === 'file';
      var content;
      var ext = '';
      if (isFile) {
        if (!hideState.fileBytes) throw new Error('请选择要隐藏的文件');
        content = hideState.fileBytes;
        ext = hideState.fileExt;
      } else {
        content = utf8Encoder.encode($('hide-text').value);
        if (content.length === 0) throw new Error('请输入要隐藏的文本内容');
      }

      var payload = Core.buildPayload(isFile, ext, content);
      var out = Core.hideDataInImage(hideState.imageBytes, payload);

      var isPng = hideState.imageFormat === 'png';
      var outName =
        baseName(hideState.imageFile.name) + '-gkd.' + (isPng ? 'png' : 'jpg');

      setURL(hideOutURL, new Blob([out], { type: isPng ? 'image/png' : 'image/jpeg' }));
      $('hide-result-img').src = hideOutURL.url;
      $('hide-result-name').textContent = outName;
      $('hide-result-meta').textContent =
        '原图 ' + formatBytes(hideState.imageBytes.length) +
        ' → 输出 ' + formatBytes(out.length) +
        '（隐藏负载 ' + formatBytes(payload.length) + '）';
      var dl = $('hide-download');
      dl.href = hideOutURL.url;
      dl.setAttribute('download', outName);
      show($('hide-result'));
      setStatus(hideStatusEl, 'ok', '完成！数据已写入图片元数据，可预览并下载输出图片。');
    } catch (err) {
      hideEl($('hide-result'));
      setStatus(hideStatusEl, 'err', err.message);
    }
  }

  /* ============================ 提取内容页 ============================ */

  var extractStatusEl = $('extract-status');
  var extractImgURL = makeURLHolder();
  var extractFileURL = makeURLHolder();
  var extractTextURL = makeURLHolder();

  var extractState = {
    imageFile: null,
    imageBytes: null,
    imageFormat: null,
  };

  function resetExtractImage() {
    extractState.imageFile = null;
    extractState.imageBytes = null;
    extractState.imageFormat = null;
    dropURL(extractImgURL);
    $('extract-preview-img').removeAttribute('src');
    hideEl($('extract-image-preview'));
    show($('extract-drop'));
    clearStatus(extractStatusEl);
    hideEl($('extract-result'));
    $('extract-text').value = '';
  }

  function resetExtractResult() {
    hideEl($('extract-result'));
    $('extract-text').value = '';
  }

  function onExtractImageSelected(file) {
    readArrayBuffer(file).then(
      function (buf) {
        var bytes = new Uint8Array(buf);
        var format;
        try {
          format = Core.detectImageFormat(bytes);
        } catch (err) {
          resetExtractImage();
          setStatus(extractStatusEl, 'err', '载入失败：' + err.message);
          return;
        }
        extractState.imageFile = file;
        extractState.imageBytes = bytes;
        extractState.imageFormat = format;

        setURL(extractImgURL, file);
        $('extract-preview-img').src = extractImgURL.url;
        $('extract-image-name').textContent = file.name;
        $('extract-image-meta').textContent =
          (format === 'png' ? 'PNG' : 'JPEG') + ' · ' + formatBytes(bytes.length);
        show($('extract-image-preview'));
        hideEl($('extract-drop'));

        runExtract(); // 选图后自动尝试提取
      },
      function (err) {
        setStatus(extractStatusEl, 'err', '读取文件失败：' + ((err && err.message) || err));
      }
    );
  }

  function runExtract() {
    resetExtractResult();
    try {
      if (!extractState.imageBytes) {
        throw new Error('请先选择一张图片');
      }
      var payload = Core.extractDataFromImage(extractState.imageBytes);

      $('extract-type-badge').textContent = payload.isFile ? '文件' : '文本';
      $('extract-meta').textContent =
        '负载 ' + formatBytes(payload.content.length) +
        (payload.isFile
          ? payload.ext
            ? ' · 扩展名 .' + payload.ext
            : ' · 无扩展名'
          : '');

      if (payload.isFile) {
        var fname = 'output.' + (payload.ext || 'bin');
        setURL(
          extractFileURL,
          new Blob([payload.content], { type: 'application/octet-stream' })
        );
        var dl = $('extract-file-download');
        dl.href = extractFileURL.url;
        dl.setAttribute('download', fname);
        dl.textContent = '下载 ' + fname;
        show($('extract-file-block'));
        hideEl($('extract-text-block'));
        setStatus(extractStatusEl, 'ok', '提取成功！从图片中恢复了文件。');
      } else {
        $('extract-text').value = utf8Decoder.decode(payload.content);
        setURL(
          extractTextURL,
          new Blob([payload.content], { type: 'text/plain;charset=utf-8' })
        );
        $('extract-text-download').href = extractTextURL.url;
        show($('extract-text-block'));
        hideEl($('extract-file-block'));
        setStatus(extractStatusEl, 'ok', '提取成功！从图片中恢复了文本。');
      }
      show($('extract-result'));
    } catch (err) {
      setStatus(extractStatusEl, 'err', err.message);
    }
  }

  var copyTimer = null;

  function legacyCopy(ta) {
    ta.focus();
    ta.select();
    try {
      return document.execCommand('copy');
    } catch (e) {
      return false;
    }
  }

  function doCopy() {
    var ta = $('extract-text');
    var btn = $('btn-copy');
    function ok() {
      btn.textContent = '✓ 已复制';
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(function () {
        btn.textContent = '复制文本';
      }, 1600);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(ta.value).then(ok, function () {
        if (legacyCopy(ta)) ok();
      });
    } else if (legacyCopy(ta)) {
      ok();
    }
  }

  /* ============================ 初始化 ============================ */

  function init() {
    $('tab-hide').addEventListener('click', function () {
      switchTab('hide');
    });
    $('tab-extract').addEventListener('click', function () {
      switchTab('extract');
    });

    // 隐藏页
    setupDropzone($('hide-drop'), $('hide-image-input'), onHideImageSelected);
    $('hide-image-clear').addEventListener('click', resetHideImage);
    $('mode-text').addEventListener('click', function () {
      setMode('text');
    });
    $('mode-file').addEventListener('click', function () {
      setMode('file');
    });
    $('hide-text').addEventListener('input', function () {
      $('text-size').textContent =
        utf8Encoder.encode(this.value).length + ' 字节';
      updateHideHint();
    });
    setupDropzone($('file-drop'), $('hide-file-input'), onHideFileSelected);
    $('file-clear').addEventListener('click', resetHideFile);
    $('btn-hide').addEventListener('click', doHide);

    // 提取页
    setupDropzone($('extract-drop'), $('extract-image-input'), onExtractImageSelected);
    $('extract-image-clear').addEventListener('click', resetExtractImage);
    $('btn-extract').addEventListener('click', runExtract);
    $('btn-copy').addEventListener('click', doCopy);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
