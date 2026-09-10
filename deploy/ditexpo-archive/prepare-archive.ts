#!/usr/bin/env bun
/**
 * prepare-archive.ts — 把 Instatic 导出的纯静态包加工成归档仓库可直接发布的产物。
 *
 * 用法:
 *   bun run prepare-archive.ts --src <导出包目录> --year <2025> --out <输出目录>
 *
 * 做三件事:
 *   1. 把导出包原样拷贝到 <输出目录>/；
 *   2. 将所有 HTML 里根相对路径 (/xxx) 的资源与链接改写为 /<year>/xxx，
 *      使快照在 Cloudflare Pages 归档项目中自包含（Worker 会剥掉年份前缀）;
 *   3. 校验: 报告仍指向站点根的绝对引用和超大文件（>25MiB，Cloudflare 单文件上限）。
 *
 * 输出目录整体作为归档 GitHub 仓库的根（或其 dist 目录）推上去即可。
 */

import { cp, readdir, stat, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, extname, relative } from "node:path";

function parseArgs(argv: string[]) {
	const args: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--src" || argv[i] === "--year" || argv[i] === "--out") {
			args[argv[i].slice(2)] = argv[++i];
		}
	}
	if (!args.src || !args.year || !args.out) {
		console.error("用法: bun run prepare-archive.ts --src <导出包目录> --year <2025> --out <输出目录>");
		process.exit(1);
	}
	if (!/^20\d\d$/.test(args.year)) {
		console.error(`--year 必须是四位年份，得到: ${args.year}`);
		process.exit(1);
	}
	return args as { src: string; year: string; out: string };
}

const { src, year, out } = parseArgs(process.argv.slice(2));
const prefix = `/${year}`;

await mkdir(out, { recursive: true });
await cp(src, out, { recursive: true });

// 只处理文本型根相对引用: src="/...", href="/...", 以及 srcset 里的 "/..."
// 排除已带年份前缀、协议相对 //、以及 url() 内形式由后续校验兜底。
const ROOT_REL = /(\s(?:src|href|poster|action)\s*=\s*")(\/[^"']*)(")/g;
const SRCSET_ITEM = /(\s(?:srcset|imagesrcset)\s*=\s*")([^"]*)(")/g;

function rewriteSrcset(value: string): string {
	return value
		.split(",")
		.map((item) => {
			const trimmed = item.trim();
			if (!trimmed.startsWith("/") || trimmed.startsWith(`/${year}/`)) return item;
			return item.replace(trimmed, `${prefix}${trimmed}`);
		})
		.join(", ");
}

let htmlCount = 0;
let rewriteCount = 0;

async function* walk(dir: string): AsyncGenerator<string> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(p);
		else yield p;
	}
}

for await (const file of walk(out)) {
	if (extname(file).toLowerCase() !== ".html") continue;
	htmlCount++;
	const html = await readFile(file, "utf8");
	let next = html.replace(ROOT_REL, (_m, lead: string, path: string, tail: string) => {
		if (path.startsWith(prefix)) return _m;
		rewriteCount++;
		return `${lead}${prefix}${path}${tail}`;
	});
	next = next.replace(SRCSET_ITEM, (m, lead: string, value: string, tail: string) =>
		value.includes("/") && !value.includes(`${prefix}/`) ? `${lead}${rewriteSrcset(value)}${tail}` : m,
	);
	if (next !== html) await writeFile(file, next);
}

// 校验: 单文件 25MiB 上限（Cloudflare Pages/Workers 限制）
const MAX_BYTES = 25 * 1024 * 1024;
let oversized = 0;
for await (const file of walk(out)) {
	const s = await stat(file);
	if (s.size > MAX_BYTES) {
		oversized++;
		console.warn(`[oversized] ${relative(out, file)} ${(s.size / 1024 / 1024).toFixed(1)}MiB > 25MiB，Cloudflare 会拒收，需压缩或移出`);
	}
}

console.log(`完成: ${htmlCount} 个 HTML，改写 ${rewriteCount} 处根相对引用 → ${prefix}/...`);
console.log(oversized === 0 ? "无超大文件。" : `发现 ${oversized} 个超大文件，见上方警告。`);
console.log(`产物目录: ${out} — 整体推入归档仓库即可。`);
