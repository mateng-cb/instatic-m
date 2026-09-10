// ditexpo-archive worker — 年份路径路由。
//
// ditexpo.com/2025/* → 反代到归档 Pages 项目（剥掉年份前缀）；
// 其余路径放行 → ditexpo.com 绑定的当前年度 Pages 项目。
//
// 年度轮换: 只需往 ROUTES 加一行，无需改其他逻辑。

const ROUTES = {
	2025: "dite2025.zkzd.workers.dev",
	// 2026: "dite2026.zkzd.workers.dev", // 2027 上线、当前项目解绑主域后启用
} as const;

const YEAR = /^\/(20\d\d)(\/|$)/;

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const match = url.pathname.match(YEAR);
		const host = match ? ROUTES[match[1] as keyof typeof ROUTES] : undefined;
		if (host) {
			const year = match[1];
			// 裸年份路径 (/2025) 必须归一化到 /2025/ —— 否则浏览器把页面上的
			// 相对引用 ./css/... 解析到主域根上，整页样式丢失。
			if (url.pathname === `/${year}`) {
				return Response.redirect(`${url.origin}/${year}/`, 301);
			}
			const target = new URL(url);
			target.hostname = host;
			target.pathname = url.pathname.replace(YEAR, "/") || "/";
			const res = await fetch(new Request(target, request));
			// 归档端会把 /index.html 规范化 307 到剥掉前缀的路径（根相对或
			// 指向归档主机的绝对 URL），反代后会把用户甩出年份路径 ——
			// 把 Location 加回年份前缀。
			const location = res.headers.get("location");
			if (location) {
				const redirect = new URL(location, target);
				let path: string | null = null;
				if (redirect.origin === target.origin) path = `/${year}${redirect.pathname}${redirect.search}`;
				else if (redirect.origin === url.origin) path = `/${year}${redirect.pathname}${redirect.search}`;
				if (path) {
					const headers = new Headers(res.headers);
					headers.set("location", path);
					return new Response(res.body, { status: res.status, headers });
				}
			}
			return res;
		}
		return fetch(request);
	},
};
