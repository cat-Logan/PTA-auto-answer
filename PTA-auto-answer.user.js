// ==UserScript==
// @name         PTA Auto Answer
// @namespace    github.com/cat-Logan
// @version      1.0.3
// @description  极简 PTA 自动答题 — DeepSeek AI 驱动，支持判断/单选/多选/填空
// @author       cat-Logan
// @license      MIT
// @match        https://pintia.cn/problem-sets/*/exam/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==

(function () {
    "use strict";

    // ============================================================
    // 存储键
    // ============================================================
    const K = {
        key: "pta_v3_apikey",
        mode: "pta_v3_mode",
    };

    // ============================================================
    // 全局状态
    // ============================================================
    let _active = false;
    let _halt = false;
    let _total = 0;
    let _pass = 0;
    let _fail = 0;

    // ============================================================
    // 获取持久化值
    // ============================================================
    const store = {
        get apiKey() { return GM_getValue(K.key, ""); },
        set apiKey(v) { GM_setValue(K.key, v); },
        get auto() { return GM_getValue(K.mode, "1"); },
        set auto(v) { GM_setValue(K.mode, v); },
    };

    // ============================================================
    // PTA 页面噪音元素（按标签/class 剔除）
    // ============================================================
    const NOISE = new Set([
        "ln", "lnBorder", "ln-border",
        "function_HJSmz", "foldIcon_V3Ad2",
        "cm-gutters", "cm-panels", "cm-announced",
        "language_E7263", "languageName_cZYHa", "toolbar_SkQeK",
        "pc-button", "pc-icon",
        "action_ZO2qN", "cm-panel",
    ]);

    function strip(el) {
        if (!el) return "";
        const dup = el.cloneNode(true);
        // 基于 class 批量删除噪音
        NOISE.forEach(cls => {
            try { dup.querySelectorAll(`.${cls}`).forEach(n => n.remove()); } catch (_) { }
        });
        // span.select-none | button
        dup.querySelectorAll("button, span.select-none, span[class*='rounded-r-sm']").forEach(n => n.remove());
        // img → alt 文本
        dup.querySelectorAll("img").forEach(n => {
            if (n.alt) n.replaceWith(document.createTextNode(`[图:${n.alt}]`));
        });
        // code blocks 保留换行
        dup.querySelectorAll("[data-code], .codeEditor_CHvdZ, .cm-editor").forEach(n => {
            const cm = n.querySelector(".cm-content");
            if (cm) {
                const lines = Array.from(cm.querySelectorAll(".cm-line"), l => l.textContent).join("\n");
                const lang = n.getAttribute("data-lang") || "";
                const pre = document.createElement("pre");
                pre.textContent = `\n\`\`\`${lang}\n${lines}\n\`\`\`\n`;
                n.replaceWith(pre);
            }
        });
        // table
        dup.querySelectorAll("table").forEach(tbl => {
            let txt = "[表]\n";
            tbl.querySelectorAll("tr").forEach(tr => {
                txt += "| " + Array.from(tr.querySelectorAll("td,th"), c => c.textContent.trim()).join(" | ") + " |\n";
            });
            tbl.replaceWith(document.createTextNode(txt));
        });
        // katex
        dup.querySelectorAll(".katex-html").forEach(n => n.remove());
        return (dup.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
    }

    // ============================================================
    // 题型映射
    // ============================================================
    const TYPE_MAP = {
        TRUE_OR_FALSE: "judge",
        MULTIPLE_CHOICE: "single",
        MULTIPLE_CHOICE_MORE_THAN_ONE_ANSWER: "multi",
        FILL_IN_THE_BLANK: "fill",
        FILL_IN_THE_BLANKS: "fill",
        FILL_IN_THE_BLANK_FOR_PROGRAMMING: "fill_prog",
    };

    function detectType() {
        const tab = document.querySelector("a.active-anchor, a.active");
        if (tab && TYPE_MAP[tab.id]) return TYPE_MAP[tab.id];
        if (tab) {
            const t = tab.textContent;
            if (/判断/.test(t)) return "judge";
            if (/多选/.test(t)) return "multi";
            if (/单选/.test(t)) return "single";
            if (/填空/.test(t)) return t.includes("程序") ? "fill_prog" : "fill";
        }
        return "unknown";
    }

    // ============================================================
    // 题目抓取
    // ============================================================
    function gatherQuestions() {
        const blocks = document.querySelectorAll("div.pc-x[id]");
        const qtype = detectType();
        const batch = [];

        blocks.forEach(blk => {
            const dup = blk.cloneNode(true);

            // 切掉选项区 & 题头
            const optZone =
                dup.querySelector("span.flex.flex-wrap[class*='-m-0.5']") ||
                dup.querySelector(".flex.flex-wrap.mt-4") ||
                dup.querySelector(".flex.flex-wrap");
            if (optZone) optZone.remove();

            const hdrZone =
                dup.querySelector(".flex.flex-wrap.gap-2") ||
                dup.querySelector(".flex.flex-wrap.gap-x-5");
            if (hdrZone) hdrZone.remove();

            const stem = strip(dup);
            if (!stem) return;

            // 选项
            const labels = Array.from(blk.querySelectorAll("label"));
            const opts = [];
            const omap = {};

            let fallbackIdx = 0;
            labels.forEach(lbl => {
                const sp = lbl.querySelector("span");
                const mark = sp ? sp.textContent.trim() : "";
                const body = lbl.textContent.trim().replace(mark, "").trim();
                let ch = (mark.match(/[A-Da-d]/i) || [])[0];
                // 判断题等没有字母标记 → 按顺序分配 A/B/C/D
                if (!ch && body) {
                    ch = String.fromCharCode(65 + fallbackIdx);
                }
                if (ch && body) {
                    const c = ch.toUpperCase();
                    opts.push(`${c}. ${body}`);
                    omap[c] = { el: lbl, txt: body, inp: lbl.querySelector("input") };
                    fallbackIdx++;
                }
            });
            opts.sort((a, b) => a.localeCompare(b));

            batch.push({ stem, opts, omap, qtype, block: blk });
        });

        return batch;
    }

    // ============================================================
    // 答案写入
    // ============================================================
    function tapOption(ch, omap) {
        const entry = omap[ch.toUpperCase()];
        if (!entry) return false;
        const { el, inp } = entry;
        if (inp) inp.focus();
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        el.click();
        return true;
    }

    function tapMulti(ans, omap) {
        const want = new Set((ans.toUpperCase().match(/[A-D]/g) || []));
        if (want.size === 0) return false;
        // 先取消已选的
        Object.values(omap).forEach(e => {
            if (e.inp && e.inp.type === "checkbox" && e.inp.checked) e.el.click();
        });
        let ok = true;
        want.forEach(ch => { if (!tapOption(ch, omap)) ok = false; });
        return ok;
    }

    function tapJudge(ans, omap, blk) {
        const yes = /正确|对|√|^T$|True|是|YES/i.test(ans.trim());
        const pat = yes ? /正确|[对√]|True|是|^T$/i : /错误|[错×]|False|否|^F$/i;

        // 1) 先走 omap（有字母标记的选项）
        for (const [k, v] of Object.entries(omap)) {
            if (pat.test(v.txt)) return tapOption(k, omap);
        }

        // 2) 兜底：直接在题目 block 里找匹配的 label
        const labels = (blk || document).querySelectorAll("label");
        for (const lbl of labels) {
            const t = lbl.textContent.trim().toUpperCase();
            if (yes && /正确|[对√]|TRUE|是|YES|^T$/.test(t)) {
                lbl.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
                lbl.click();
                return true;
            }
            if (!yes && /错误|[错×]|FALSE|否|NO|^F$/.test(t)) {
                lbl.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
                lbl.click();
                return true;
            }
        }
        return false;
    }

    function fillGap(ans, blk) {
        // 收集填空位
        const slots = [];
        blk.querySelectorAll("[data-blank-index]").forEach(n => slots.push(n));
        blk.querySelectorAll('.cm-content span[contenteditable="false"]').forEach(n => {
            if (n.querySelector("input,textarea") && !slots.includes(n)) slots.push(n);
        });
        blk.querySelectorAll("input:not([type='radio']):not([type='checkbox']),textarea").forEach(n => {
            if (!slots.some(s => s.contains(n))) slots.push(n);
        });
        if (slots.length === 0) return false;

        // 解析答案
        let parts = [];
        const fm = ans.match(/\[空\d+\]([\s\S]*?)\[\/空\d+\]/g);
        if (fm) {
            parts = fm.map(m => m.replace(/\[空\d+\]/g, "").replace(/\[\/空\d+\]/g, "").trim());
        } else {
            parts = ans.split("|").map(s => s.trim());
            if (parts.length === 1) parts = [ans.trim()];
        }

        let hit = 0;
        const limit = Math.min(parts.length, slots.length);
        for (let i = 0; i < limit; i++) {
            const slot = slots[i];
            const val = parts[i];
            const inp = (slot.tagName === "INPUT" || slot.tagName === "TEXTAREA")
                ? slot : slot.querySelector("input,textarea");
            if (inp) {
                const proto = inp.tagName === "TEXTAREA" ? HTMLTextAreaElement : HTMLInputElement;
                const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value");
                if (setter?.set) setter.set.call(inp, val);
                else inp.value = val;
                inp.dispatchEvent(new Event("input", { bubbles: true }));
                inp.dispatchEvent(new Event("change", { bubbles: true }));
                hit++;
            }
        }
        return hit > 0;
    }

    function applyAnswer(ans, q) {
        if (q.qtype === "single") return tapOption(ans.trim(), q.omap);
        if (q.qtype === "multi") return tapMulti(ans, q.omap);
        if (q.qtype === "judge") return tapJudge(ans, q.omap, q.block);
        if (q.qtype === "fill" || q.qtype === "fill_prog") return fillGap(ans, q.block);
        // fallback
        if (Object.keys(q.omap).length >= 2) {
            const ch = (ans.match(/[A-D]/i) || [])[0];
            return ch ? tapOption(ch, q.omap) : false;
        }
        return fillGap(ans, q.block);
    }

    // ============================================================
    // DeepSeek
    // ============================================================
    const DS_URL = "https://api.deepseek.com/v1/chat/completions";

    const PROMPTS = {
        single: "你是答题机器。只输出正确选项的字母（A/B/C/D），不要任何解释。",
        multi: "你是答题机器。输出所有正确选项的字母连在一起（如ABD），不要任何解释。",
        judge: "你是答题机器。只输出 T（正确）或 F（错误），不要任何解释。",
        fill: "你是答题机器。输出填空答案，多个空用 | 分隔。不要任何解释。",
        fill_prog: "你是答题机器。输出程序填空答案，多个空用 [空1]答案[/空1] 格式。不要任何解释。",
        unknown: "你是答题机器。只输出答案本身，不要解释。",
    };

    function callDS(stem, opts, qtype) {
        if (!store.apiKey) {
            notify("请先设置 API Key", 2);
            return Promise.resolve(null);
        }

        let body = `题:\n${stem}\n\n`;
        if (opts.length) body += `选项:\n${opts.join("\n")}\n\n`;
        body += `类型: ${qtype}`;
        if (qtype === "fill" || qtype === "fill_prog") body += `\n多空用 | 分隔或用 [空N]...[/空N] 格式。`;

        const sys = PROMPTS[qtype] || PROMPTS.unknown;

        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: "POST",
                url: DS_URL,
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${store.apiKey}` },
                data: JSON.stringify({
                    model: "deepseek-chat",
                    messages: [
                        { role: "system", content: sys },
                        { role: "user", content: body },
                    ],
                    temperature: 0,
                    max_tokens: qtype.includes("fill") ? 500 : 100,
                }),
                timeout: 30000,
                onload: r => {
                    try {
                        const d = JSON.parse(r.responseText);
                        if (d?.error) { console.warn(d.error); resolve(null); return; }
                        let txt = (d?.choices?.[0]?.message?.content || "").replace(/\s+/g, " ").trim();
                        txt = txt.replace(/^答案[：:\s]*/i, "").replace(/^【答案】[：:\s]*/i, "");
                        // 格式清洗
                        if (qtype === "single") { const m = txt.match(/[A-D]/i); txt = m ? m[0].toUpperCase() : txt.slice(0, 1).toUpperCase(); }
                        else if (qtype === "multi") { const m = txt.match(/[A-D]/gi); txt = m ? [...new Set(m.map(c => c.toUpperCase()))].sort().join("") : txt.toUpperCase(); }
                        else if (qtype === "judge") { const up = txt.toUpperCase(); txt = /^T|TRUE|正确|对|√/.test(up) ? "T" : /^F|FALSE|错误|错|×/.test(up) ? "F" : up.slice(0, 1); }
                        resolve(txt);
                    } catch (_) { resolve(null); }
                },
                onerror: () => resolve(null),
                ontimeout: () => resolve(null),
            });
        });
    }

    async function askAI(q, tries = 2) {
        for (let i = 0; i <= tries; i++) {
            const ans = await callDS(q.stem, q.opts, q.qtype);
            if (!ans) { if (i < tries) await wait(1000); continue; }
            // 校验
            const ok =
                (q.qtype === "single" && /^[A-D]$/i.test(ans)) ||
                (q.qtype === "multi" && /^[A-D]+$/i.test(ans)) ||
                (q.qtype === "judge" && /^[TF]$/i.test(ans)) ||
                (q.qtype.startsWith("fill") && ans.length <= 1000) ||
                (q.qtype === "unknown" && ans.length <= 500);
            if (ok || i === tries) return ans;
            await wait(600);
        }
        return null;
    }

    // ============================================================
    // 题型切换
    // ============================================================
    const TAB_ORDER = [
        "TRUE_OR_FALSE",
        "MULTIPLE_CHOICE",
        "MULTIPLE_CHOICE_MORE_THAN_ONE_ANSWER",
        "FILL_IN_THE_BLANK",
        "FILL_IN_THE_BLANKS",
        "FILL_IN_THE_BLANK_FOR_PROGRAMMING",
    ];

    async function doSave() {
        // 尝试多种保存按钮
        const tries = [
            () => document.querySelector('button[data-e2e="problem-set-bottom-submit-btn"]'),
            () => Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('保存')),
            () => Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('提交本题作答')),
        ];
        for (const fn of tries) {
            try {
                const btn = fn();
                if (btn && btn.offsetParent) {
                    btn.click();
                    status("💾 保存中...");
                    await wait(2000); // PTA 保存需要时间
                    return true;
                }
            } catch (_) { }
        }
        return false;
    }

    async function nextTab() {
        await doSave();

        const cur = document.querySelector("a.active-anchor, a.active");
        if (!cur) { status("无活跃 Tab"); return "end"; }
        const idx = TAB_ORDER.indexOf(cur.id);
        if (idx < 0) { status(`未知 Tab: ${cur.id}`); return "end"; }
        if (idx >= TAB_ORDER.length - 1) return "end";

        for (let i = idx + 1; i < TAB_ORDER.length; i++) {
            const nxt = document.getElementById(TAB_ORDER[i]);
            if (nxt && nxt.offsetParent) {
                status(`▶ 切换到: ${nxt.textContent.trim().split("\n")[0]}`);
                nxt.click();
                await wait(2500); // 等页面渲染
                return "ok";
            }
        }
        return "end";
    }

    // ============================================================
    // 单题
    // ============================================================
    async function oneQ() {
        const all = gatherQuestions();
        if (!all.length) return status("找不到题目");

        const q = all[0];
        preview(q.stem, q.qtype, "");
        status("AI 思考中...");

        const ans = await askAI(q);
        if (!ans) { status("无答案"); preview(q.stem, q.qtype, "❌"); return null; }

        preview(q.stem, q.qtype, ans);
        status(`答案: ${ans}`);

        if (store.auto === "1") {
            const done = applyAnswer(ans, q);
            notify(done ? `已选 ${ans}` : "手动选一下吧", done ? 0 : 1);
        }
        return ans;
    }

    // ============================================================
    // 暂停等待
    // ============================================================
    async function waitForResume() {
        updateStopBtn("▶ 继续");
        status("⏸ 已暂停");
        while (_halt && _active) await wait(300);
        if (_active) {
            updateStopBtn("⏸ 暂停");
            status("▶ 继续中...");
        }
    }

    // ============================================================
    // 全流程
    // ============================================================
    async function runAll() {
        // 已有任务在跑 → 忽略重复点击
        if (_active) return;
        if (!store.apiKey) { notify("先设 API Key", 2); return; }

        _active = true; _halt = false; _total = 0; _pass = 0; _fail = 0;
        toggleBtn(true);
        updateStopBtn("⏸ 暂停");
        status("运行中...");

        while (_active) {
            const items = gatherQuestions();
            if (!items.length) {
                const nx = await nextTab();
                if (nx === "end") break;
                await wait(1500);
                continue;
            }

            const t = typeLabel(items[0].qtype);
            status(`${t} × ${items.length}`);

            for (let i = 0; i < items.length; i++) {
                // 暂停检测：卡在这里轮询直到用户点继续
                if (_halt) await waitForResume();
                if (!_active) break;

                _total++;
                const q = items[i];
                preview(q.stem, q.qtype, "");
                status(`${t} [${i + 1}/${items.length}]`);

                const ans = await askAI(q);
                if (ans) {
                    _pass++;
                    preview(q.stem, q.qtype, ans);
                    if (store.auto === "1") applyAnswer(ans, q);
                } else {
                    _fail++;
                    preview(q.stem, q.qtype, "❌");
                }
                counter();
                await wait(800 + Math.random() * 600);
            }

            if (!_active) break;
            if (_halt) await waitForResume();
            if (!_active) break;

            const nx = await nextTab();
            if (nx === "end") break;
            await wait(2000);
        }

        _active = false; _halt = false;
        toggleBtn(false);
        updateStopBtn("⏸ 暂停");
        status("完成");
        notify(`${_pass}/${_total}`, _pass === _total ? 0 : 1);
    }

    function togglePause() {
        if (!_active) return;
        _halt = !_halt;
    }

    // ============================================================
    // 迷你 UI
    // ============================================================
    let _panel = null;

    function buildUI() {
        if (_panel) _panel.remove();
        _panel = document.createElement("div");
        _panel.id = "pta3";
        _panel.innerHTML = `
        <div id="p3bar">
          <b>PTA</b>
          <span id="p3ver">v1</span>
          <button id="p3fold">_</button>
        </div>
        <div id="p3gut">
          <div id="p3stat">就绪</div>
          <input id="p3key" type="password" placeholder="DeepSeek API Key" value="${esc(store.apiKey)}">
          <div class="p3r">
            <button id="p3save">保存</button>
            <label class="p3chk"><input id="p3auto" type="checkbox" ${store.auto === "1" ? "checked" : ""}>自动</label>
          </div>
          <div class="p3r p3btns">
            <button id="p3go" class="go">全部答题</button>
            <button id="p3stop" class="stop">停</button>
            <button id="p3once" class="one">单题</button>
          </div>
          <div id="p3q"></div>
          <div id="p3a"></div>
          <div id="p3cnt">0/0</div>
        </div>`;

        // CSS
        const css = document.createElement("style");
        css.textContent = `
#pta3{position:fixed;bottom:16px;right:16px;width:300px;z-index:2147483647;background:#fff;border:1px solid #e5e7eb;border-radius:10px;box-shadow:0 4px 24px rgba(0,0,0,.12);font:12px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;color:#222;}
#p3bar{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#1a1a2e;color:#e0e0ff;border-radius:10px 10px 0 0;cursor:move;user-select:none;}
#p3bar b{font-size:13px;}
#p3ver{font-size:10px;opacity:.5;}
#p3fold{margin-left:auto;background:none;border:none;color:#e0e0ff;width:22px;height:22px;cursor:pointer;font-size:14px;border-radius:4px;}
#p3fold:hover{background:rgba(255,255,255,.1);}
#p3gut{padding:10px 12px 12px;display:flex;flex-direction:column;gap:8px;}
#p3gut.hide{display:none;}
#p3stat{background:#f5f5f5;padding:4px 8px;border-radius:5px;font-size:11px;color:#666;}
#p3key{width:100%;padding:6px 8px;border:1px solid #d4d4d4;border-radius:5px;font-size:11px;outline:none;box-sizing:border-box;}
#p3key:focus{border-color:#4f46e5;box-shadow:0 0 0 2px rgba(79,70,229,.12);}
.p3r{display:flex;align-items:center;gap:8px;}
.p3btns{gap:4px;}
.p3btns button{padding:6px 10px;border:none;border-radius:5px;cursor:pointer;font-size:11px;font-weight:500;}
.p3btns .go{flex:2;background:#059669;color:#fff;}
.p3btns .go:hover{background:#047857;}
.p3btns .stop{flex:1;background:#dc2626;color:#fff;}
.p3btns .stop:hover{background:#b91c1c;}
.p3btns .one{flex:1;background:#6b7280;color:#fff;}
.p3btns .one:hover{background:#4b5563;}
.p3btns button:disabled{opacity:.4;cursor:default;}
#p3save{padding:5px 10px;border:none;border-radius:5px;cursor:pointer;font-size:11px;background:#4f46e5;color:#fff;}
#p3save:hover{background:#4338ca;}
.p3chk{font-size:11px;color:#888;cursor:pointer;display:flex;align-items:center;gap:3px;}
#p3q{font-size:11px;color:#888;word-break:break-word;max-height:80px;overflow-y:auto;}
#p3a{font-size:14px;color:#059669;font-weight:600;word-break:break-word;}
#p3cnt{font-size:10px;color:#bbb;text-align:right;}
.toast3{position:fixed;top:20px;left:50%;transform:translateX(-50%);padding:8px 22px;border-radius:6px;color:#fff;font-size:13px;z-index:2147483647;box-shadow:0 2px 12px rgba(0,0,0,.18);animation:f3 .25s;}
.toast3.ok{background:#059669;}
.toast3.warn{background:#d97706;}
.toast3.err{background:#dc2626;}
@keyframes f3{from{opacity:0;transform:translateX(-50%) translateY(-10px);}to{opacity:1;transform:translateX(-50%) translateY(0);}}
`;
        document.head.appendChild(css);
        document.body.appendChild(_panel);

        // 事件
        let drag = false, dx, dy, dl, dt;
        _panel.querySelector("#p3bar").addEventListener("mousedown", e => {
            if (e.target.tagName === "BUTTON") return;
            drag = true; dx = e.clientX; dy = e.clientY;
            dl = _panel.offsetLeft; dt = _panel.offsetTop;
            _panel.style.transition = "none";
        });
        document.addEventListener("mousemove", e => {
            if (!drag) return;
            _panel.style.left = dl + e.clientX - dx + "px";
            _panel.style.top = dt + e.clientY - dy + "px";
            _panel.style.right = "auto"; _panel.style.bottom = "auto";
        });
        document.addEventListener("mouseup", () => { drag = false; _panel.style.transition = ""; });

        _panel.querySelector("#p3fold").onclick = () => _panel.querySelector("#p3gut").classList.toggle("hide");
        _panel.querySelector("#p3save").onclick = () => {
            store.apiKey = _panel.querySelector("#p3key").value.trim();
            store.auto = _panel.querySelector("#p3auto").checked ? "1" : "0";
            notify("已保存", 0);
        };
        _panel.querySelector("#p3auto").onchange = function () {
            store.auto = this.checked ? "1" : "0";
        };
        _panel.querySelector("#p3go").onclick = runAll;
        _panel.querySelector("#p3stop").onclick = togglePause;
        _panel.querySelector("#p3once").onclick = async () => {
            if (!store.apiKey) { notify("先设 API Key", 2); return; }
            const r = await oneQ();
            if (r) { _total++; _pass++; counter(); }
            else { _total++; _fail++; counter(); }
        };
    }

    // ============================================================
    // 小工具
    // ============================================================
    function notify(msg, lvl) {
        document.querySelectorAll(".toast3").forEach(e => e.remove());
        const e = document.createElement("div");
        e.className = "toast3 " + (lvl === 0 ? "ok" : lvl === 1 ? "warn" : "err");
        e.textContent = msg;
        document.body.appendChild(e);
        setTimeout(() => { e.style.opacity = "0"; e.style.transition = "opacity .3s"; setTimeout(() => e.remove(), 300); }, 2500);
    }

    function status(s) { const el = document.getElementById("p3stat"); if (el) el.textContent = s; }
    function preview(stem, t, ans) {
        const qe = document.getElementById("p3q");
        const ae = document.getElementById("p3a");
        if (qe) qe.textContent = `[${typeLabel(t)}] ${stem.slice(0, 100)}${stem.length > 100 ? "…" : ""}`;
        if (ae) ae.textContent = ans ? `▶ ${ans}` : "";
    }
    function counter() {
        const el = document.getElementById("p3cnt");
        if (el) el.textContent = `${_pass}/${_total}`;
    }
    function toggleBtn(on) {
        ["p3go", "p3once"].forEach(id => { const e = document.getElementById(id); if (e) e.disabled = on; });
        const st = document.getElementById("p3stop");
        if (st) st.disabled = !on;
    }
    function updateStopBtn(label) {
        const st = document.getElementById("p3stop");
        if (st) st.textContent = label;
    }
    function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
    function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
    function typeLabel(t) {
        const m = { single: "单选", multi: "多选", judge: "判断", fill: "填空", fill_prog: "程序填空", unknown: "?" };
        return m[t] || t;
    }

    // ============================================================
    // 启动
    // ============================================================
    function boot() {
        let n = 0;
        (function poll() {
            const ok = document.querySelectorAll("div.pc-x[id]").length > 0 || document.getElementById("exam-app");
            if (ok) {
                buildUI();
                status("就绪 — 点单题试试");
                return;
            }
            if (/\/exam\//.test(location.pathname) && ++n < 40) setTimeout(poll, 500);
            else if (n >= 40) { buildUI(); status("可能不在考试页"); }
        })();
    }

    document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", boot) : boot();
})();
