// Renders html/*.html to png/*.png (1600x900 @2x) and reports content that overflows the slide or its panels.
import { readdirSync } from "node:fs";
import { chromium } from "playwright-core";

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
for (const file of readdirSync("html").filter((f) => f.endsWith(".html")).sort()) {
	await page.goto(`file:///slides/html/${file}`);
	await page.evaluate(() => document.fonts.ready);
	const problems = await page.evaluate(() => {
		const out = [];
		for (const el of document.querySelectorAll("body *")) {
			const r = el.getBoundingClientRect();
			if (r.width === 0 && r.height === 0) continue;
			if (r.right > 1601 || r.bottom > 901) out.push(`outside slide: <${el.tagName.toLowerCase()} class="${el.className}"> ${Math.round(r.right)}x${Math.round(r.bottom)}`);
			if ((el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2) && getComputedStyle(el).overflow !== "visible") out.push(`clipped: <${el.tagName.toLowerCase()} class="${el.className}">`);
		}
		const panels = [...document.querySelectorAll(".panel")];
		for (const p of panels) for (const c of p.querySelectorAll("*")) {
			const pr = p.getBoundingClientRect(), cr = c.getBoundingClientRect();
			if (cr.width && (cr.right > pr.right + 1 || cr.bottom > pr.bottom + 1)) { out.push(`overflows panel: <${c.tagName.toLowerCase()}> ${(c.textContent ?? "").slice(0, 40)}`); break; }
		}
		return out.slice(0, 8);
	});
	await page.screenshot({ path: `png/${file.replace(".html", ".png")}` });
	console.log(file, problems.length ? problems.join("\n  ") : "ok");
}
await browser.close();
