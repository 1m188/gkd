package main

import (
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"os"
)

// 负载格式魔数，用于标识这是 gkd 工具写入的数据
const payloadMagic = 0x01

// HiddenPayload 表示从图片中解出的隐藏负载信息。
type HiddenPayload struct {
	IsFile  bool   // true 表示文件，false 表示文本
	Ext     string // 文件扩展名（不含点），文本时为空
	Content []byte // 原始内容数据
}

// BuildPayload 根据类型、扩展名和原始内容构建待隐藏的二进制负载。
//
// 负载格式（所有字段均为大端序）：
//
//	字节 0:     魔数 (0x01)
//	字节 1:     类型标记 (0=文本, 1=文件)
//	字节 2-3:   扩展名长度（16位无符号整数）
//	字节 4-...: 扩展名字符串（UTF-8）
//	后续字节:   原始内容数据
func BuildPayload(isFile bool, ext string, content []byte) []byte {
	extBytes := []byte(ext)
	extLen := uint16(len(extBytes))

	// 总长度: 魔数(1) + 类型(1) + 扩展名长度(2) + 扩展名 + 内容
	totalLen := 1 + 1 + 2 + len(extBytes) + len(content)
	payload := make([]byte, totalLen)

	// 魔数
	payload[0] = payloadMagic

	// 类型标记
	if isFile {
		payload[1] = 1
	} else {
		payload[1] = 0
	}

	// 扩展名长度
	binary.BigEndian.PutUint16(payload[2:4], extLen)

	// 扩展名
	copy(payload[4:4+extLen], extBytes)

	// 原始内容
	copy(payload[4+extLen:], content)

	return payload
}

// ParsePayload 从二进制数据中解析出隐藏负载。
// 返回 HiddenPayload 结构体，包含类型、扩展名和原始内容。
func ParsePayload(data []byte) (*HiddenPayload, error) {
	if len(data) < 4 {
		return nil, fmt.Errorf("负载数据太短，无法解析")
	}

	// 验证魔数
	if data[0] != payloadMagic {
		return nil, fmt.Errorf("无效的负载魔数: 期望 0x%02X，实际 0x%02X", payloadMagic, data[0])
	}

	// 类型标记
	isFile := data[1] == 1

	// 扩展名长度
	extLen := binary.BigEndian.Uint16(data[2:4])

	// 边界检查
	if 4+int(extLen) > len(data) {
		return nil, fmt.Errorf("负载数据不完整：扩展名长度 %d 超出数据范围", extLen)
	}

	// 扩展名
	ext := string(data[4 : 4+extLen])

	// 原始内容
	content := data[4+extLen:]

	return &HiddenPayload{
		IsFile:  isFile,
		Ext:     ext,
		Content: content,
	}, nil
}

// detectImageFormat 检测图片文件的格式类型。
// 通过读取文件头部的魔数来判断是 PNG 还是 JPEG 格式。
func detectImageFormat(raw []byte) (string, error) {
	if len(raw) < 8 {
		return "", fmt.Errorf("文件太小，不是有效的图片格式")
	}

	// PNG 文件头: 8 字节签名 89 50 4E 47 0D 0A 1A 0A
	pngSig := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}
	if len(raw) >= 8 && string(raw[:8]) == string(pngSig) {
		return "png", nil
	}

	// JPEG 文件头: SOI 标记 0xFF 0xD8
	if len(raw) >= 2 && raw[0] == 0xFF && raw[1] == 0xD8 {
		return "jpeg", nil
	}

	return "", fmt.Errorf("无法识别的图片格式（仅支持 PNG 和 JPEG）")
}

// encodePNG 将数据以 Base64 编码后存入 PNG 图片的 tEXt 注释块中。
// 在 IEND 块之前插入一个关键字为 "gkd" 的 tEXt 块，包含编码后的数据。
func encodePNG(raw []byte, data []byte) []byte {
	sig := raw[:8] // PNG 8 字节签名

	// 解析所有块，找到 IEND 块的位置
	pos := 8
	var beforeIEND []byte
	var afterIEND []byte

	for pos < len(raw) {
		if pos+8 > len(raw) {
			break
		}
		length := binary.BigEndian.Uint32(raw[pos : pos+4])
		chunkType := string(raw[pos+4 : pos+8])

		if pos+8+int(length)+4 > len(raw) {
			break
		}

		chunkEnd := pos + 8 + int(length) + 4

		if chunkType == "IEND" {
			// 保存 IEND 块及其后续所有内容
			afterIEND = raw[pos:]
			break
		}

		chunk := raw[pos:chunkEnd]
		beforeIEND = append(beforeIEND, chunk...)
		pos = chunkEnd
	}

	// 构建 tEXt 块数据: 关键字 + '\0' + Base64 编码的文本
	keyword := "gkd"
	base64Data := base64.StdEncoding.EncodeToString(data)
	textData := keyword + "\x00" + base64Data

	// 计算 CRC32: 对块类型 + 块数据进行校验
	crcCalc := crc32.NewIEEE()
	crcCalc.Write([]byte("tEXt"))
	crcCalc.Write([]byte(textData))
	crcValue := crcCalc.Sum32()

	// 构建完整的 tEXt 块
	textChunk := make([]byte, 4+4+len(textData)+4)
	binary.BigEndian.PutUint32(textChunk[0:4], uint32(len(textData))) // 长度
	copy(textChunk[4:8], "tEXt")                                      // 块类型
	copy(textChunk[8:8+len(textData)], textData)                      // 块数据
	binary.BigEndian.PutUint32(textChunk[8+len(textData):], crcValue) // CRC32

	// 组装最终结果: 签名 + IEND之前的块 + tEXt块 + IEND及之后的内容
	var result []byte
	result = append(result, sig...)
	result = append(result, beforeIEND...)
	result = append(result, textChunk...)
	result = append(result, afterIEND...)

	return result
}

// encodeJPEG 将数据以 Base64 编码后存入 JPEG 图片的 APP1 应用数据段中。
// 在 SOI 标记之后立即插入一个标识为 "gkd" 的 APP1 段，包含编码后的数据。
func encodeJPEG(raw []byte, data []byte) []byte {
	soi := raw[:2]  // SOI 标记 (0xFF 0xD8)
	rest := raw[2:] // SOI 之后的剩余数据

	base64Data := base64.StdEncoding.EncodeToString(data)
	identifier := "gkd\x00"
	appData := identifier + base64Data

	// APP1 段的长度字段包含自身的 2 字节
	segmentLength := 2 + len(appData)

	// 构建 APP1 段: 标记(2字节) + 长度(2字节) + 数据
	app1 := make([]byte, 2+2+len(appData))
	app1[0] = 0xFF                                               // 标记前缀
	app1[1] = 0xE1                                               // APP1 标记类型
	binary.BigEndian.PutUint16(app1[2:4], uint16(segmentLength)) // 段长度
	copy(app1[4:], appData)                                      // 段数据（标识 + Base64 数据）

	// 组装: SOI + APP1 + 其余数据
	var result []byte
	result = append(result, soi...)
	result = append(result, app1...)
	result = append(result, rest...)

	return result
}

// HideDataInImage 将数据隐藏到指定的图片文件中，生成新的图片文件。
//
// 支持 PNG 和 JPEG 两种图片格式：
//   - PNG: 将数据以 Base64 编码后存入 tEXt 注释块
//   - JPEG: 将数据以 Base64 编码后存入 APP1 应用数据段
//
// 参数:
//   - imagePath: 目标图片文件的路径
//   - data: 待隐藏的数据字节序列（通常由 BuildPayload 生成）
//   - outputPath: 输出图片文件的路径
//
// 返回值:
//   - error: 如果隐藏过程中发生错误则返回错误信息，否则返回 nil
func HideDataInImage(imagePath string, data []byte, outputPath string) error {
	// 读取原始图片文件
	raw, err := os.ReadFile(imagePath)
	if err != nil {
		return fmt.Errorf("读取图片文件失败: %w", err)
	}

	// 检测图片格式
	format, err := detectImageFormat(raw)
	if err != nil {
		return err
	}

	// 根据格式调用对应的编码函数
	var encoded []byte
	switch format {
	case "png":
		encoded = encodePNG(raw, data)
	case "jpeg":
		encoded = encodeJPEG(raw, data)
	default:
		return fmt.Errorf("不支持的图片格式: %s", format)
	}

	// 写入输出文件
	if err := os.WriteFile(outputPath, encoded, 0644); err != nil {
		return fmt.Errorf("写入输出文件失败: %w", err)
	}

	return nil
}
