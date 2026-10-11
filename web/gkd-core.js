/*!
 * gkd-core.js —— gkd 核心逻辑的纯前端复刻（与 hide.go / decode.go 逐字节一致）
 *
 * 纯字节逻辑，无 DOM 依赖：
 *   - 浏览器中通过全局对象 window.GKDCore 使用
 *   - Node 中通过 require('./gkd-core.js') 使用（便于自动化测试）
 *
 * 复刻范围：
 *   1. 负载格式   —— 对应 hide.go BuildPayload / ParsePayload
 *   2. PNG 隐藏   —— 对应 hide.go encodePNG（IEND 前插入 tEXt 块，CRC32-IEEE）
 *   3. JPEG 隐藏  —— 对应 hide.go encodeJPEG（SOI 后插入 APP1 段）
 *   4. PNG 提取   —— 对应 decode.go decodePNG
 *   5. JPEG 提取  —— 对应 decode.go decodeJPEG
 *   6. 格式检测   —— 对应 hide.go detectImageFormat
 *
 * 与 Go 版的唯一有意差异：encodeJPEG 遇到超出 JPEG 段长度上限（uint16，
 * 65535 字节）的数据时直接报错，而不是像 Go 版那样静默截断长度字段、
 * 写出损坏的图片。
 */
(function (global, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api; // Node / 打包环境
  } else {
    global.GKDCore = api; // 浏览器环境
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // 负载格式魔数，用于标识这是 gkd 工具写入的数据（对应 hide.go payloadMagic）
  var PAYLOAD_MAGIC = 0x01;

  /* ============================ 基础工具 ============================ */

  // 大端序读写（对应 Go encoding/binary 的 BigEndian）
  function readUint16BE(bytes, off) {
    return (bytes[off] << 8) | bytes[off + 1];
  }
  function readUint32BE(bytes, off) {
    return (
      ((bytes[off] << 24) |
        (bytes[off + 1] << 16) |
        (bytes[off + 2] << 8) |
        bytes[off + 3]) >>>
      0
    );
  }
  function writeUint16BE(bytes, off, v) {
    bytes[off] = (v >>> 8) & 0xff;
    bytes[off + 1] = v & 0xff;
  }
  function writeUint32BE(bytes, off, v) {
    bytes[off] = (v >>> 24) & 0xff;
    bytes[off + 1] = (v >>> 16) & 0xff;
    bytes[off + 2] = (v >>> 8) & 0xff;
    bytes[off + 3] = v & 0xff;
  }

  function hexByte(b) {
    return ('0' + (b & 0xff).toString(16)).slice(-2).toUpperCase();
  }

  // 将字符串按 Latin-1/ASCII 逐字符取码点转为字节（仅用于 ASCII 内容：
  // 块类型、关键字 "gkd"、Base64 文本等）
  function asciiBytes(str) {
    var out = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }

  // 将字节按 Latin-1 转回字符串（Base64 是纯 ASCII，无信息损失）
  function latin1Str(bytes) {
    var out = '';
    var CHUNK = 0x8000; // 分块拼接，避免超大数组触发栈溢出
    for (var i = 0; i < bytes.length; i += CHUNK) {
      out += String.fromCharCode.apply(
        null,
        bytes.subarray(i, Math.min(i + CHUNK, bytes.length))
      );
    }
    return out;
  }

  // 拼接多个 Uint8Array 为一个新的 Uint8Array
  function concatBytes(parts) {
    var total = 0;
    var i;
    for (i = 0; i < parts.length; i++) total += parts[i].length;
    var out = new Uint8Array(total);
    var off = 0;
    for (i = 0; i < parts.length; i++) {
      out.set(parts[i], off);
      off += parts[i].length;
    }
    return out;
  }

  // UTF-8 编解码（对应 Go 中 []byte(string) / string([]byte) 的语义）
  function utf8Encode(str) {
    return new TextEncoder().encode(str);
  }
  function utf8Decode(bytes) {
    return new TextDecoder('utf-8').decode(bytes);
  }

  /* ==================== CRC32 (IEEE) ====================
   * 对应 Go hash/crc32.NewIEEE()：多项式 0xEDB88320，
   * 初值与终值取反。用于计算 PNG 块的 CRC 校验。
   */
  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  /* ==================== Base64（标准字母表，严格模式） ====================
   * 对应 Go encoding/base64 StdEncoding：标准字母表 + 填充 '='，
   * 拒绝非法字符与错误长度。
   */
  var B64_CHARS =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var B64_LOOKUP = (function () {
    var t = new Int16Array(256).fill(-1);
    for (var i = 0; i < B64_CHARS.length; i++) {
      t[B64_CHARS.charCodeAt(i)] = i;
    }
    return t;
  })();

  function base64Encode(bytes) {
    var parts = [];
    var n = bytes.length;
    for (var i = 0; i < n; i += 3) {
      var has1 = i + 1 < n;
      var has2 = i + 2 < n;
      var b0 = bytes[i];
      var b1 = has1 ? bytes[i + 1] : 0;
      var b2 = has2 ? bytes[i + 2] : 0;
      var trip = (b0 << 16) | (b1 << 8) | b2;
      parts.push(
        B64_CHARS[(trip >>> 18) & 63] +
          B64_CHARS[(trip >>> 12) & 63] +
          (has1 ? B64_CHARS[(trip >>> 6) & 63] : '=') +
          (has2 ? B64_CHARS[trip & 63] : '=')
      );
    }
    return parts.join('');
  }

  function base64Decode(str) {
    var len = str.length;
    if (len % 4 !== 0) {
      throw new Error('Base64 解码失败: 长度 ' + len + ' 不是 4 的倍数');
    }
    // 只允许 '=' 出现在结尾，最多 2 个（与 StdEncoding 一致）
    var pad = 0;
    if (len > 0 && str.charAt(len - 1) === '=') pad++;
    if (len > 1 && str.charAt(len - 2) === '=') pad++;
    for (var i = 0; i < len - pad; i++) {
      if (B64_LOOKUP[str.charCodeAt(i)] < 0) {
        throw new Error('Base64 解码失败: 含非法字符');
      }
    }
    var outLen = (len / 4) * 3 - pad;
    var out = new Uint8Array(outLen);
    var o = 0;
    for (var j = 0; j < len; j += 4) {
      var c0 = B64_LOOKUP[str.charCodeAt(j)];
      var c1 = B64_LOOKUP[str.charCodeAt(j + 1)];
      var c2 = B64_LOOKUP[str.charCodeAt(j + 2)];
      var c3 = B64_LOOKUP[str.charCodeAt(j + 3)];
      var trip =
        (c0 << 18) | (c1 << 12) | ((c2 < 0 ? 0 : c2) << 6) | (c3 < 0 ? 0 : c3);
      if (o < outLen) out[o++] = (trip >>> 16) & 0xff;
      if (o < outLen) out[o++] = (trip >>> 8) & 0xff;
      if (o < outLen) out[o++] = trip & 0xff;
    }
    return out;
  }

  /* ============================ 负载格式 ============================ */

  // BuildPayload：构建待隐藏的二进制负载（对应 hide.go BuildPayload）。
  // 负载格式（所有字段均为大端序）：
  //   字节 0:     魔数 (0x01)
  //   字节 1:     类型标记 (0=文本, 1=文件)
  //   字节 2-3:   扩展名长度（16 位无符号整数）
  //   字节 4-...: 扩展名字符串（UTF-8）
  //   后续字节:   原始内容数据
  function buildPayload(isFile, ext, content) {
    var extBytes = utf8Encode(String(ext || ''));
    if (extBytes.length > 0xffff) {
      throw new Error('扩展名过长（上限 65535 字节）');
    }
    var totalLen = 4 + extBytes.length + content.length;
    var payload = new Uint8Array(totalLen);
    payload[0] = PAYLOAD_MAGIC;
    payload[1] = isFile ? 1 : 0;
    writeUint16BE(payload, 2, extBytes.length);
    payload.set(extBytes, 4);
    payload.set(content, 4 + extBytes.length);
    return payload;
  }

  // ParsePayload：解析隐藏负载（对应 hide.go ParsePayload）。
  // 返回 { isFile: boolean, ext: string, content: Uint8Array }
  function parsePayload(data) {
    if (!data || data.length < 4) {
      throw new Error('负载数据太短，无法解析');
    }
    if (data[0] !== PAYLOAD_MAGIC) {
      throw new Error(
        '无效的负载魔数: 期望 0x' +
          hexByte(PAYLOAD_MAGIC) +
          '，实际 0x' +
          hexByte(data[0])
      );
    }
    var isFile = data[1] === 1;
    var extLen = readUint16BE(data, 2);
    if (4 + extLen > data.length) {
      throw new Error(
        '负载数据不完整：扩展名长度 ' + extLen + ' 超出数据范围'
      );
    }
    var ext = utf8Decode(data.subarray(4, 4 + extLen));
    var content = data.subarray(4 + extLen);
    return { isFile: isFile, ext: ext, content: content };
  }

  /* ============================ 图片格式 ============================ */

  // detectImageFormat：通过文件头魔数判断 PNG / JPEG（对应 hide.go detectImageFormat）
  var PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  function detectImageFormat(raw) {
    if (!raw || raw.length < 8) {
      throw new Error('文件太小，不是有效的图片格式');
    }
    var isPng = true;
    for (var i = 0; i < 8; i++) {
      if (raw[i] !== PNG_SIG[i]) {
        isPng = false;
        break;
      }
    }
    if (isPng) return 'png';
    // JPEG 文件头: SOI 标记 0xFF 0xD8
    if (raw[0] === 0xff && raw[1] === 0xd8) return 'jpeg';
    throw new Error('无法识别的图片格式（仅支持 PNG 和 JPEG）');
  }

  /* ============================ PNG 隐藏 ============================ */

  // encodePNG：在 IEND 块之前插入关键字为 "gkd" 的 tEXt 块（对应 hide.go encodePNG）。
  // 直接复用原始文件的字节流，不重新编码，图片像素完全不变。
  function encodePNG(raw, data) {
    var sig = raw.subarray(0, 8); // PNG 8 字节签名

    // 解析所有块，找到 IEND 块的位置
    var pos = 8;
    var beforeIEND = []; // IEND 之前的所有块
    var afterIEND = null; // IEND 块及其后续所有内容

    while (pos < raw.length) {
      if (pos + 8 > raw.length) break;
      var length = readUint32BE(raw, pos);
      var chunkType = latin1Str(raw.subarray(pos + 4, pos + 8));
      if (pos + 8 + length + 4 > raw.length) break;
      var chunkEnd = pos + 8 + length + 4;

      if (chunkType === 'IEND') {
        afterIEND = raw.subarray(pos);
        break;
      }
      beforeIEND.push(raw.subarray(pos, chunkEnd));
      pos = chunkEnd;
    }

    // 构建 tEXt 块数据: 关键字 + '\0' + Base64 编码的文本
    var base64Data = base64Encode(data);
    var textData = concatBytes([asciiBytes('gkd\x00'), asciiBytes(base64Data)]);

    // 计算 CRC32: 对块类型 + 块数据进行校验
    var crcValue = crc32(concatBytes([asciiBytes('tEXt'), textData]));

    // 构建完整的 tEXt 块: 长度(4) + 类型(4) + 数据 + CRC(4)
    var textChunk = new Uint8Array(8 + textData.length + 4);
    writeUint32BE(textChunk, 0, textData.length);
    textChunk[4] = 0x74; // 't'
    textChunk[5] = 0x45; // 'E'
    textChunk[6] = 0x58; // 'X'
    textChunk[7] = 0x74; // 't'
    textChunk.set(textData, 8);
    writeUint32BE(textChunk, 8 + textData.length, crcValue);

    // 组装最终结果: 签名 + IEND 之前的块 + tEXt 块 + IEND 及之后的内容
    var parts = [sig].concat(beforeIEND, [textChunk]);
    if (afterIEND) parts.push(afterIEND);
    return concatBytes(parts);
  }

  /* ============================ JPEG 隐藏 ============================ */

  // encodeJPEG：在 SOI 标记之后插入标识为 "gkd" 的 APP1 段（对应 hide.go encodeJPEG）。
  // 与 Go 版的唯一差异：段长度超限时报错而非静默截断。
  function encodeJPEG(raw, data) {
    var soi = raw.subarray(0, 2); // SOI 标记 (0xFF 0xD8)
    var rest = raw.subarray(2); // SOI 之后的剩余数据

    var base64Data = base64Encode(data);
    var appData = concatBytes([asciiBytes('gkd\x00'), asciiBytes(base64Data)]);

    // APP1 段的长度字段包含自身的 2 字节
    var segmentLength = 2 + appData.length;
    if (segmentLength > 0xffff) {
      throw new Error(
        '数据过大：JPEG 单段长度上限为 65535 字节，当前需要 ' +
          segmentLength +
          ' 字节（内容约 ' +
          data.length +
          ' 字节）。请改用 PNG 载体或减小内容。'
      );
    }

    // 构建 APP1 段: 标记(2 字节 0xFF 0xE1) + 长度(2 字节) + 数据
    var app1 = new Uint8Array(4 + appData.length);
    app1[0] = 0xff;
    app1[1] = 0xe1;
    writeUint16BE(app1, 2, segmentLength);
    app1.set(appData, 4);

    // 组装: SOI + APP1 + 其余数据
    return concatBytes([soi, app1, rest]);
  }

  /* ============================ PNG 提取 ============================ */

  // decodePNG：查找关键字为 "gkd" 的 tEXt 块并 Base64 解码（对应 decode.go decodePNG）
  function decodePNG(raw) {
    var pos = 8; // 跳过 8 字节 PNG 签名

    while (pos < raw.length) {
      if (pos + 8 > raw.length) break;
      var length = readUint32BE(raw, pos);
      var chunkType = latin1Str(raw.subarray(pos + 4, pos + 8));
      if (pos + 8 + length + 4 > raw.length) break;
      var chunkData = raw.subarray(pos + 8, pos + 8 + length);
      var chunkEnd = pos + 8 + length + 4;

      // 找到关键字为 "gkd" 的 tEXt 块
      if (chunkType === 'tEXt' && hasGkdPrefix(chunkData)) {
        return base64Decode(latin1Str(chunkData.subarray(4)));
      }

      pos = chunkEnd;
    }

    throw new Error('未在 PNG 图片中找到隐藏数据');
  }

  // 检查块数据是否以 "gkd\x00" 开头
  function hasGkdPrefix(bytes) {
    return (
      bytes.length >= 4 &&
      bytes[0] === 0x67 && // 'g'
      bytes[1] === 0x6b && // 'k'
      bytes[2] === 0x64 && // 'd'
      bytes[3] === 0x00
    );
  }

  /* ============================ JPEG 提取 ============================ */

  // decodeJPEG：查找标识为 "gkd" 的 APP1 段并 Base64 解码（对应 decode.go decodeJPEG）
  function decodeJPEG(raw) {
    if (raw.length < 2 || raw[0] !== 0xff || raw[1] !== 0xd8) {
      throw new Error('不是有效的 JPEG 文件');
    }

    var pos = 2; // 跳过 SOI 标记

    while (pos < raw.length - 1) {
      // 查找下一个标记
      if (raw[pos] !== 0xff) {
        pos++;
        continue;
      }

      // 跳过填充的 0xFF 字节
      while (pos < raw.length - 1 && raw[pos + 1] === 0xff) {
        pos++;
      }

      if (pos + 1 >= raw.length) break;

      var marker = raw[pos + 1];

      // SOI (0xD8) 和 EOI (0xD9) 没有长度字段
      if (marker === 0xd8 || marker === 0xd9) {
        pos += 2;
        continue;
      }

      if (pos + 4 > raw.length) break;

      // 某些标记没有长度字段；压缩数据中的 0xFF 0x00 不是标记
      if (
        (marker >= 0xd0 && marker <= 0xd7) ||
        marker === 0x00
      ) {
        pos += 2;
        continue;
      }

      // 读取段长度
      var segLen = readUint16BE(raw, pos + 2);
      if (segLen < 2) {
        pos += 2;
        continue;
      }

      // 检查段是否足够大
      if (pos + 2 + segLen > raw.length) break;

      var segData = raw.subarray(pos + 4, pos + 2 + segLen);

      if (marker === 0xe1 && hasGkdPrefix(segData)) {
        return base64Decode(latin1Str(segData.subarray(4)));
      }

      pos = pos + 2 + segLen;
    }

    throw new Error('未在 JPEG 图片中找到隐藏数据');
  }

  /* ============================ 对外接口 ============================ */

  // hideDataInImage：将数据隐藏到图片字节中，返回新图片的字节。
  // （对应 hide.go HideDataInImage，但直接操作内存字节而非文件路径）
  function hideDataInImage(rawBytes, data) {
    var format = detectImageFormat(rawBytes);
    return format === 'png' ? encodePNG(rawBytes, data) : encodeJPEG(rawBytes, data);
  }

  // extractDataFromImage：从图片字节中提取并解析隐藏负载。
  // （对应 decode.go ExtractDataFromImage，返回 { isFile, ext, content }）
  function extractDataFromImage(rawBytes) {
    var format = detectImageFormat(rawBytes);
    var decoded = format === 'png' ? decodePNG(rawBytes) : decodeJPEG(rawBytes);
    return parsePayload(decoded);
  }

  return {
    // 主流程
    hideDataInImage: hideDataInImage,
    extractDataFromImage: extractDataFromImage,
    // 负载
    buildPayload: buildPayload,
    parsePayload: parsePayload,
    // 图片格式与编解码（暴露以便测试与复用）
    detectImageFormat: detectImageFormat,
    encodePNG: encodePNG,
    encodeJPEG: encodeJPEG,
    decodePNG: decodePNG,
    decodeJPEG: decodeJPEG,
    // 基础工具
    base64Encode: base64Encode,
    base64Decode: base64Decode,
    crc32: crc32,
    utf8Encode: utf8Encode,
    utf8Decode: utf8Decode,
  };
});
