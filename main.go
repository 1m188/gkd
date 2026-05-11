package main

import (
	"flag"
	"fmt"
	"os"
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
	fmt.Println("  gkd hide  -i <图片路径> -f <文件路径> [-o <输出路径>]   将文件隐藏到图片中")
	fmt.Println("  gkd hide  -i <图片路径> -t <文本内容> [-o <输出路径>]   将文本隐藏到图片中")
	fmt.Println("  gkd decode -i <图片路径>                                从图片中提取隐藏信息")
	fmt.Println("  gkd help                                                显示此帮助信息")
	fmt.Println()
	fmt.Println("选项:")
	fmt.Println("  -i    目标图片路径（必需）")
	fmt.Println("  -f    待隐藏的文件路径（与 -t 二选一）")
	fmt.Println("  -t    待隐藏的文本内容（与 -f 二选一）")
	fmt.Println("  -o    输出图片路径（可选，默认为 output.png）")
}

func handleHide(args []string) {
	hideFlags := flag.NewFlagSet("hide", flag.ExitOnError)
	imagePath := hideFlags.String("i", "", "目标图片路径（必需）")
	filePath := hideFlags.String("f", "", "待隐藏的文件路径")
	textContent := hideFlags.String("t", "", "待隐藏的文本内容")
	outputPath := hideFlags.String("o", "output.png", "输出图片路径")

	hideFlags.Parse(args)

	// 验证必需参数
	if *imagePath == "" {
		fmt.Fprintln(os.Stderr, "错误: 必须指定图片路径 (-i)")
		os.Exit(1)
	}

	if *filePath == "" && *textContent == "" {
		fmt.Fprintln(os.Stderr, "错误: 必须指定待隐藏的文件路径 (-f) 或文本内容 (-t)")
		os.Exit(1)
	}

	if *filePath != "" && *textContent != "" {
		fmt.Fprintln(os.Stderr, "错误: -f 和 -t 不能同时指定")
		os.Exit(1)
	}

	// 读取待隐藏数据
	var data []byte
	if *filePath != "" {
		var err error
		data, err = os.ReadFile(*filePath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "错误: 无法读取文件 %s: %v\n", *filePath, err)
			os.Exit(1)
		}
		fmt.Printf("已读取文件: %s (%d 字节)\n", *filePath, len(data))
	} else {
		data = []byte(*textContent)
		fmt.Printf("已获取文本内容 (%d 字节)\n", len(data))
	}

	// 调用隐藏函数
	err := HideDataInImage(*imagePath, data, *outputPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "错误: 隐藏数据失败: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("成功! 数据已隐藏到图片: %s\n", *outputPath)
}

func handleDecode(args []string) {
	decodeFlags := flag.NewFlagSet("decode", flag.ExitOnError)
	imagePath := decodeFlags.String("i", "", "目标图片路径（必需）")

	decodeFlags.Parse(args)

	// 验证必需参数
	if *imagePath == "" {
		fmt.Fprintln(os.Stderr, "错误: 必须指定图片路径 (-i)")
		os.Exit(1)
	}

	// 调用解码函数
	data, err := ExtractDataFromImage(*imagePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "错误: 提取数据失败: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("成功! 从图片中提取了 %d 字节数据\n", len(data))
	fmt.Println("提取的数据:")
	os.Stdout.Write(data)
	fmt.Println()
}
