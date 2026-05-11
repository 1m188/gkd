package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	switch os.Args[1] {
	case "hide":
		handleHide(os.Args[2:])
	case "decode":
		handleDecode(os.Args[2:])
	case "help", "-h", "--help":
		printUsage()
	default:
		fmt.Fprintf(os.Stderr, "未知子命令: %s\n\n", os.Args[1])
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Println("gkd - 隐藏文件或信息到图片中")
	fmt.Println()
	fmt.Println("用法:")
	fmt.Println("  gkd hide   -i <图片路径> -c <文件路径/文本内容> [-o <输出路径>]")
	fmt.Println("  gkd decode -i <图片路径> [-o <输出路径>]")
	fmt.Println("  gkd help")
	fmt.Println()
	fmt.Println("选项:")
	fmt.Println("  -i    目标图片路径（必需）")
	fmt.Println("  -c    待隐藏的文件路径或文本内容（必需）")
	fmt.Println("  -o    输出路径（可选）")
	fmt.Println("           hide 默认输出: output.png")
	fmt.Println("           decode 默认输出: output.txt（文本）或 output.<扩展名>（文件）")
}

func handleHide(args []string) {
	hideFlags := flag.NewFlagSet("hide", flag.ExitOnError)
	imagePath := hideFlags.String("i", "", "目标图片路径（必需）")
	content := hideFlags.String("c", "", "待隐藏的文件路径或文本内容（必需）")
	outputPath := hideFlags.String("o", "output.png", "输出图片路径")

	hideFlags.Parse(args)

	// 验证必需参数
	if *imagePath == "" {
		fmt.Fprintln(os.Stderr, "错误: 必须指定图片路径 (-i)")
		os.Exit(1)
	}
	if *content == "" {
		fmt.Fprintln(os.Stderr, "错误: 必须指定待隐藏的内容 (-c)")
		os.Exit(1)
	}

	// 判断 -c 是文件路径还是文本内容
	var payload []byte
	info, err := os.Stat(*content)
	if err == nil && !info.IsDir() {
		// 文件存在且不是目录，按文件处理
		rawData, err := os.ReadFile(*content)
		if err != nil {
			fmt.Fprintf(os.Stderr, "错误: 无法读取文件 %s: %v\n", *content, err)
			os.Exit(1)
		}
		// 提取文件扩展名（不含点）
		ext := strings.TrimPrefix(filepath.Ext(*content), ".")
		payload = BuildPayload(true, ext, rawData)
		fmt.Printf("已读取文件: %s (%d 字节, 类型: %s)\n", *content, len(rawData), ext)
	} else {
		// 文件不存在，按文本处理
		payload = BuildPayload(false, "", []byte(*content))
		fmt.Printf("已获取文本内容 (%d 字节)\n", len(*content))
	}

	// 调用隐藏函数
	err = HideDataInImage(*imagePath, payload, *outputPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "错误: 隐藏数据失败: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("成功! 数据已隐藏到图片: %s\n", *outputPath)
}

func handleDecode(args []string) {
	decodeFlags := flag.NewFlagSet("decode", flag.ExitOnError)
	imagePath := decodeFlags.String("i", "", "目标图片路径（必需）")
	outputPath := decodeFlags.String("o", "", "输出文件路径（可选）")

	decodeFlags.Parse(args)

	// 验证必需参数
	if *imagePath == "" {
		fmt.Fprintln(os.Stderr, "错误: 必须指定图片路径 (-i)")
		os.Exit(1)
	}

	// 调用解码函数
	payload, err := ExtractDataFromImage(*imagePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "错误: 提取数据失败: %v\n", err)
		os.Exit(1)
	}

	// 确定输出路径
	outPath := *outputPath
	if outPath == "" {
		if payload.IsFile {
			outPath = "output." + payload.Ext
		} else {
			outPath = "output.txt"
		}
	}

	// 写入内容到输出文件
	if err := os.WriteFile(outPath, payload.Content, 0644); err != nil {
		fmt.Fprintf(os.Stderr, "错误: 写入输出文件失败: %v\n", err)
		os.Exit(1)
	}

	if payload.IsFile {
		fmt.Printf("成功! 从图片中提取了文件 (%d 字节, 类型: %s)\n", len(payload.Content), payload.Ext)
	} else {
		fmt.Printf("成功! 从图片中提取了文本内容 (%d 字节)\n", len(payload.Content))
	}
	fmt.Printf("内容已写入: %s\n", outPath)
}
