package main

import (
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"os"
	"strings"
)

// decodePNG 从 PNG 图片的 tEXt 注释块中提取隐藏的数据。
// 查找关键字为 "gkd" 的 tEXt 块，读取其文本内容并 Base64 解码。
func decodePNG(raw []byte) ([]byte, error) {
	pos := 8 // 跳过 8 字节 PNG 签名

	for pos < len(raw) {
		if pos+8 > len(raw) {
			break
		}
		length := binary.BigEndian.Uint32(raw[pos : pos+4])
		chunkType := string(raw[pos+4 : pos+8])

		if pos+8+int(length)+4 > len(raw) {
			break
		}

		chunkData := raw[pos+8 : pos+8+int(length)]
		chunkEnd := pos + 8 + int(length) + 4

		// 找到关键字为 "gkd" 的 tEXt 块
		if chunkType == "tEXt" {
			text := string(chunkData)
			if strings.HasPrefix(text, "gkd\x00") {
				// 提取 Base64 编码的数据
				base64Data := text[len("gkd\x00"):]
				decoded, err := base64.StdEncoding.DecodeString(base64Data)
				if err != nil {
					return nil, fmt.Errorf("Base64 解码失败: %w", err)
				}
				return decoded, nil
			}
		}

		pos = chunkEnd
	}

	return nil, fmt.Errorf("未在 PNG 图片中找到隐藏数据")
}

// decodeJPEG 从 JPEG 图片的 APP1 应用数据段中提取隐藏的数据。
// 查找标识为 "gkd" 的 APP1 段（0xFF 0xE1），读取其数据并 Base64 解码。
func decodeJPEG(raw []byte) ([]byte, error) {
	if len(raw) < 2 || raw[0] != 0xFF || raw[1] != 0xD8 {
		return nil, fmt.Errorf("不是有效的 JPEG 文件")
	}

	pos := 2 // 跳过 SOI 标记

	for pos < len(raw)-1 {
		// 查找下一个标记
		if raw[pos] != 0xFF {
			pos++
			continue
		}

		// 跳过填充的 0xFF 字节
		for pos < len(raw)-1 && raw[pos+1] == 0xFF {
			pos++
		}

		if pos+1 >= len(raw) {
			break
		}

		marker := raw[pos+1]

		// SOI (0xD8) 和 EOI (0xD9) 没有长度字段
		if marker == 0xD8 || marker == 0xD9 {
			pos += 2
			continue
		}

		// 某些标记没有长度字段
		if pos+4 > len(raw) {
			break
		}
		if marker == 0xD0 || marker == 0xD1 || marker == 0xD2 || marker == 0xD3 ||
			marker == 0xD4 || marker == 0xD5 || marker == 0xD6 || marker == 0xD7 ||
			marker == 0x00 { // 压缩数据中有可能出现 0xFF 0x00 的组合，不是标记
			pos += 2
			continue
		}

		// 读取段长度
		segLen := binary.BigEndian.Uint16(raw[pos+2 : pos+4])
		if segLen < 2 {
			pos += 2
			continue
		}

		// 检查段是否足够大
		if pos+2+int(segLen) > len(raw) {
			break
		}

		segData := raw[pos+4 : pos+2+int(segLen)]

		if marker == 0xE1 {
			// 检查是否以 "gkd\x00" 开头
			appData := string(segData)
			if strings.HasPrefix(appData, "gkd\x00") {
				// 提取 Base64 编码的数据
				base64Data := appData[len("gkd\x00"):]
				decoded, err := base64.StdEncoding.DecodeString(base64Data)
				if err != nil {
					return nil, fmt.Errorf("Base64 解码失败: %w", err)
				}
				return decoded, nil
			}
		}

		pos = pos + 2 + int(segLen)
	}

	return nil, fmt.Errorf("未在 JPEG 图片中找到隐藏数据")
}

// ExtractDataFromImage 从指定的图片文件中提取隐藏的数据。
//
// 支持 PNG 和 JPEG 两种图片格式：
//   - PNG: 从关键字为 "gkd" 的 tEXt 注释块中提取并 Base64 解码
//   - JPEG: 从标识为 "gkd" 的 APP1 应用数据段中提取并 Base64 解码
//
// 提取出的原始数据会通过 ParsePayload 解析为 HiddenPayload 结构体，
// 其中包含隐藏内容的类型（文本/文件）、扩展名和原始数据。
//
// 参数:
//   - imagePath: 包含隐藏数据的图片文件路径
//
// 返回值:
//   - *HiddenPayload: 解析后的隐藏负载信息
//   - error: 如果提取过程中发生错误则返回错误信息，否则返回 nil
func ExtractDataFromImage(imagePath string) (*HiddenPayload, error) {
	// 读取图片文件
	raw, err := os.ReadFile(imagePath)
	if err != nil {
		return nil, fmt.Errorf("读取图片文件失败: %w", err)
	}

	// 检测图片格式
	format, err := detectImageFormat(raw)
	if err != nil {
		return nil, err
	}

	// 根据格式调用对应的解码函数，获取原始数据
	var decodedData []byte
	switch format {
	case "png":
		decodedData, err = decodePNG(raw)
		if err != nil {
			return nil, err
		}
	case "jpeg":
		decodedData, err = decodeJPEG(raw)
		if err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("不支持的图片格式: %s", format)
	}

	// 解析负载
	payload, err := ParsePayload(decodedData)
	if err != nil {
		return nil, fmt.Errorf("解析负载失败: %w", err)
	}

	return payload, nil
}
